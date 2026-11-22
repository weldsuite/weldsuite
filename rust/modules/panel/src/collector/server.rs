//! `routes/server.ts`: `POST /v1/track` and `POST /v1/import`, events and
//! profile operations from a customer's server
//! (`@weldsuite/panel-sdk/server`), with a secret key (`Authorization:
//! Bearer wps_<32 hex>`).
//!
//! The key is looked up by the SHA-256 of the secret in the cache
//! (`panel:key:<hash>`, written by panel-api, deleted on revoke); here,
//! where the cache is not durable storage, a record missing from it is read
//! from the master `panel_key_registry` and put back. Unlike the browser
//! routes this one answers after the stream accepted the rows, so a server
//! that is told `accepted: n` can rely on it, and a failing stream is a 503
//! it can retry (the rows carry their `event_id`).
//!
//! A key of a paused project answers like a blocked quota: 200, nothing
//! accepted. Track takes up to 100 events from the last 7 days, import up
//! to 1000 up to five years old; neither takes a time in the future (a
//! minute of clock skew is moved back to now). Events outside the window
//! are counted in `dropped`. Server events get no geo or user-agent
//! enrichment.
//!
//! Profile and group operations go to the project state
//! ([`crate::PanelProjectState`], the `PanelProject` object on Global): the
//! group operations first, before the rows are built (they may give a type
//! its slot, which decides the events' `$group_<type>` properties), the
//! `$identify` links and profile operations after the write, beside the
//! counting. Without the state they are checked and accepted, and the
//! events keep their properties as sent.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use sea_orm::{ColumnTrait, EntityTrait, JoinType, QueryFilter, QuerySelect};
use sha2::{Digest, Sha256};
use weldsuite_db::orm;
use weldsuite_ports::{Cache, PortError};
use weldsuite_schema::master::{panel_key_registry as keys, panel_project_registry as projects};

use super::project::{apply_people, filled, identify, limit_groups, people_object};
use super::proxy::header;
use super::rows::{iso_millis, parse_millis};
use super::url::parse_page_url;
use super::visitor::utc_date;
use super::wire_server::{
    MAX_IMPORT_EVENTS, MAX_TRACK_EVENTS, ServerBatch, ServerEvent, parse_server_batch,
};
use super::{
    CollectorState, Ctx, log_failure_for, quota_state, read_text_limited, reject, went_wrong,
};
use crate::domain::{KeyRecord, key_key};
use crate::js::{Js, stringify};
use crate::project_state::{PanelProjectState, PeopleOp, ProjectRef};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// `TRACK_MAX_AGE_MS`.
const TRACK_MAX_AGE_MS: i64 = 7 * DAY_MS;
/// `IMPORT_MAX_AGE_MS`.
const IMPORT_MAX_AGE_MS: i64 = 5 * 365 * DAY_MS;
/// A clock a little ahead is believed (and moved back to now); further ahead is not.
const MAX_AHEAD_MS: i64 = 60 * 1000;

/// One of the two routes.
#[derive(Debug, Clone, Copy)]
struct Endpoint {
    max_events: usize,
    max_age_ms: i64,
    max_body_bytes: usize,
    what: &'static str,
}

const TRACK: Endpoint = Endpoint {
    max_events: MAX_TRACK_EVENTS,
    max_age_ms: TRACK_MAX_AGE_MS,
    max_body_bytes: 1024 * 1024,
    what: "POST /v1/track",
};

const IMPORT: Endpoint = Endpoint {
    max_events: MAX_IMPORT_EVENTS,
    max_age_ms: IMPORT_MAX_AGE_MS,
    max_body_bytes: 8 * 1024 * 1024,
    what: "POST /v1/import",
};

/// `POST /v1/track`.
pub(super) async fn track(
    State(state): State<CollectorState>,
    ctx: Ctx,
    headers: HeaderMap,
    body: Body,
) -> Response {
    handle(&state, &ctx, &headers, body, TRACK).await
}

/// `POST /v1/import`.
pub(super) async fn import(
    State(state): State<CollectorState>,
    ctx: Ctx,
    headers: HeaderMap,
    body: Body,
) -> Response {
    handle(&state, &ctx, &headers, body, IMPORT).await
}

/// The secret the `Authorization` header carries: `/^Bearer (wps_[0-9a-f]{32})$/`.
fn bearer_secret(headers: &HeaderMap) -> Option<String> {
    let value = header(headers, "authorization")?;
    let secret = value.strip_prefix("Bearer ")?;
    let hex = secret.strip_prefix("wps_")?;
    (hex.len() == 32
        && hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then(|| secret.to_owned())
}

/// The key record the `Authorization` header names; `None` for a missing,
/// malformed, unknown or revoked key. Looked up by the secret's hash, never
/// by the secret.
async fn authenticate(
    ctx: &Ctx,
    state: &CollectorState,
    headers: &HeaderMap,
) -> Result<Option<KeyRecord>, PortError> {
    let Some(secret) = bearer_secret(headers) else {
        return Ok(None);
    };
    let hash = hex::encode(Sha256::digest(secret.as_bytes()));
    let cache = ctx.cache(state);
    if let Some(cache) = &cache
        && let Some(record) = KeyRecord::parse(cache.get(&key_key(&hash)).await?.as_deref())
    {
        return Ok(Some(record));
    }
    let Some(master) = ctx.master(state) else {
        return Ok(None);
    };
    // What panel-api keeps in the cache: active keys of live projects, with
    // the project's status.
    let project = keys::Entity::belongs_to(projects::Entity)
        .from(keys::Column::ProjectId)
        .to(projects::Column::ProjectId)
        .into();
    let row: Option<(String, String, String, String)> = keys::Entity::find()
        .select_only()
        .columns([
            keys::Column::Id,
            keys::Column::WorkspaceId,
            keys::Column::ProjectId,
        ])
        .column(projects::Column::Status)
        .join(JoinType::InnerJoin, project)
        // The join's `p.deleted_at is null`: the same rows in the `where`.
        .filter(projects::Column::DeletedAt.is_null())
        .filter(keys::Column::KeyHash.eq(&hash))
        .filter(keys::Column::RevokedAt.is_null())
        .into_tuple()
        .one(&orm(&master))
        .await
        .map_err(PortError::backend)?;
    let Some((key_id, workspace_id, project_id, status)) = row else {
        return Ok(None);
    };
    let record = KeyRecord {
        key_id,
        workspace_id,
        project_id,
        status: Some(status).filter(|status| status == "active" || status == "paused"),
    };
    // Put back for ten minutes only: a revocation racing the read must not
    // keep a dead key alive.
    if let Some(cache) = &cache
        && let Err(error) = cache
            .put(
                &key_key(&hash),
                &record.to_value().to_string(),
                Some(Duration::from_secs(600)),
            )
            .await
    {
        tracing::warn!(%error, "[panel-ingest] could not cache a key record");
    }
    Ok(Some(record))
}

/// `serverEventTime(ts, receivedAt, maxAgeMs)`: the event time, or `None`
/// when it is outside what the endpoint takes: older than `max_age_ms`, or
/// more than a minute in the future. A time up to a minute ahead is moved
/// back to the receive time ("never in the future").
fn server_event_time(ts: &str, received_at: i64, max_age_ms: i64) -> Option<i64> {
    let at = parse_millis(ts)?;
    (at >= received_at - max_age_ms && at <= received_at + MAX_AHEAD_MS)
        .then_some(at.min(received_at))
}

fn or_null(value: Option<&str>) -> Value {
    match value {
        Some(text) if !text.is_empty() => json!(text),
        _ => Value::Null,
    }
}

/// `serverRow(...)`: no session, no viewport, and no geo or user agent (the
/// request is the customer's server, not their visitor). The caller names
/// the visitor (`distinct_id`).
fn server_row(
    key: &KeyRecord,
    batch: &ServerBatch,
    event: &ServerEvent,
    ts: &str,
    received_iso: &str,
) -> Value {
    let page = event
        .url
        .as_deref()
        .filter(|url| !url.is_empty())
        .and_then(parse_page_url);
    let utm = page.as_ref().map(|page| &page.utm);
    let props = Js::Object(event.props.clone().unwrap_or_default());
    json!({
        "event_id": event.event_id,
        "workspace_id": key.workspace_id,
        "project_id": key.project_id,
        "name": event.name,
        "ts": ts,
        "received_at": received_iso,
        "distinct_id": event.distinct_id,
        "anon_id": event
            .anon_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .unwrap_or(&event.distinct_id),
        "user_id": or_null(event.user_id.as_deref()),
        "session_id": null,
        "cookieless": false,
        "url": page.as_ref().map_or("", |page| page.url.as_str()),
        "host": page.as_ref().map_or("", |page| page.host.as_str()),
        "path": page.as_ref().map_or("", |page| page.path.as_str()),
        "title": or_null(event.title.as_deref()),
        "referrer": null,
        "referrer_host": null,
        "utm_source": utm.and_then(|utm| utm.source.clone()),
        "utm_medium": utm.and_then(|utm| utm.medium.clone()),
        "utm_campaign": utm.and_then(|utm| utm.campaign.clone()),
        "utm_content": utm.and_then(|utm| utm.content.clone()),
        "utm_term": utm.and_then(|utm| utm.term.clone()),
        "country": null,
        "region": null,
        "city": null,
        "device_type": null,
        "browser": null,
        "os": null,
        "viewport_w": null,
        "el_tag": null,
        "el_selector": null,
        "el_text": null,
        "x": null,
        "y": null,
        "rel_x": null,
        "rel_y": null,
        "scroll_depth": null,
        "error_message": null,
        "properties": stringify(&props),
        "lib": "server",
        "lib_version": batch.lib_version,
    })
}

/// `buildServerEventRows(source)`: one row per event inside the time
/// window, and how many fell outside it.
fn build_server_rows(
    key: &KeyRecord,
    batch: &ServerBatch,
    received_at: i64,
    max_age_ms: i64,
) -> (Vec<Value>, usize) {
    let received_iso = iso_millis(received_at);
    let rows: Vec<Value> = batch
        .events
        .iter()
        .filter_map(|event| {
            let at = server_event_time(&event.ts, received_at, max_age_ms)?;
            Some(server_row(
                key,
                batch,
                event,
                &iso_millis(at),
                &received_iso,
            ))
        })
        .collect();
    let dropped = batch.events.len() - rows.len();
    (rows, dropped)
}

/// `applyServerIdentifies(env, project, events, receivedAt, maxAgeMs)`: the
/// `$identify` events of a server batch (`identify()` of the server SDK)
/// link like a browser's, so an erasure finds the anonymous id. An event
/// outside the endpoint's time window was dropped from the rows and links
/// nothing either.
async fn apply_server_identifies(
    state: Option<&Arc<dyn PanelProjectState>>,
    project: ProjectRef<'_>,
    events: &[ServerEvent],
    received_at: i64,
    max_age_ms: i64,
) {
    let identifies: Vec<&ServerEvent> = events
        .iter()
        .filter(|event| {
            event.name == "$identify"
                && filled(event.anon_id.as_deref())
                && filled(event.user_id.as_deref())
        })
        .collect();
    if identifies.is_empty() {
        return;
    }
    let Some(state) = people_object(state) else {
        return;
    };
    for event in identifies {
        let Some(at) = server_event_time(&event.ts, received_at, max_age_ms) else {
            continue;
        };
        identify(
            state,
            project,
            event.anon_id.as_deref().unwrap_or_default(),
            event.user_id.as_deref().unwrap_or_default(),
            at,
        )
        .await;
    }
}

/// `applyServerPeople(env, project, ops)`: the profile operations of a
/// server batch.
async fn apply_server_people(
    state: Option<&Arc<dyn PanelProjectState>>,
    project: ProjectRef<'_>,
    ops: &[PeopleOp],
) {
    if ops.is_empty() {
        return;
    }
    if let Some(state) = people_object(state) {
        apply_people(state, project, ops).await;
    }
}

fn answer(accepted: usize, dropped: usize) -> Response {
    axum::Json(json!({ "accepted": accepted, "dropped": dropped })).into_response()
}

async fn handle(
    state: &CollectorState,
    ctx: &Ctx,
    headers: &HeaderMap,
    body: Body,
    endpoint: Endpoint,
) -> Response {
    let key = match authenticate(ctx, state, headers).await {
        Ok(Some(key)) => key,
        Ok(None) => {
            return reject(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Send a valid secret key as a Bearer token",
            );
        }
        Err(error) => return went_wrong(&error, endpoint.what),
    };

    let Some(text) = read_text_limited(headers, body, endpoint.max_body_bytes).await else {
        return reject(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            &format!("A request is at most {} bytes", endpoint.max_body_bytes),
        );
    };
    let Ok(body) = serde_json::from_str::<Js>(&text) else {
        return reject(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "The body is not valid JSON",
        );
    };
    let mut batch = match parse_server_batch(&body, endpoint.max_events) {
        Ok(batch) => batch,
        Err(message) => return reject(StatusCode::BAD_REQUEST, "invalid_batch", &message),
    };

    let received_at = ctx.now_ms();
    // A paused project takes nothing, from the server side either: panel-api
    // rewrites every key's record with the project's status when it is
    // paused or resumed.
    if key.status.as_deref() == Some("paused") {
        return answer(0, batch.events.len() + batch.dropped);
    }
    // Past the allowance with no wallet to pay for more: accepted from the
    // caller's side, not counted.
    if quota_state(ctx, state, &key.workspace_id).await == "events_blocked" {
        return answer(0, batch.events.len() + batch.dropped);
    }

    // Group operations first (`groupSet()`): they may give a type its slot,
    // which decides the events' `$group_` properties.
    let ports = ctx.ports(state);
    let project = ProjectRef {
        workspace_id: &key.workspace_id,
        project_id: &key.project_id,
    };
    limit_groups(
        ports.project_state.as_ref(),
        project,
        batch
            .events
            .iter_mut()
            .map(|event| &mut event.props)
            .collect(),
        &batch.groups,
        received_at,
        &state.project_caches,
    )
    .await;
    let (rows, outside_window) = build_server_rows(&key, &batch, received_at, endpoint.max_age_ms);

    if !rows.is_empty() {
        let written = match &ports.sink {
            Some(sink) => sink.send(&rows).await,
            None => Err(PortError::backend("no events stream")),
        };
        if let Err(error) = written {
            log_failure_for("Server event write", &key.project_id, &error);
            return reject(
                StatusCode::SERVICE_UNAVAILABLE,
                "write_failed",
                "The events could not be stored, try again",
            );
        }
    }

    let answered = answer(rows.len(), batch.dropped + outside_window);
    let after = Bookkeeping {
        key,
        batch,
        count: rows.len() as u64,
        received_at,
        max_age_ms: endpoint.max_age_ms,
    };
    let cache = ctx.cache(state);
    let seen = Arc::clone(&state.seen);
    state
        .events
        .tracker()
        .spawn(async move { after.run(&ports, cache, &seen).await });
    answered
}

/// What a server batch leaves to do after the answer (`waitUntil`).
struct Bookkeeping {
    key: KeyRecord,
    batch: ServerBatch,
    /// Rows the stream took.
    count: u64,
    received_at: i64,
    max_age_ms: i64,
}

impl Bookkeeping {
    /// The day's count and the install check (when rows were written), the
    /// `$identify` links and the profile operations, side by side; a
    /// failure is logged.
    async fn run(
        &self,
        ports: &super::RequestCollector,
        cache: Option<Arc<dyn weldsuite_ports::DynCache>>,
        seen: &super::SeenThrottle,
    ) {
        let Self {
            key,
            batch,
            count,
            received_at,
            max_age_ms,
        } = self;
        let project = ProjectRef {
            workspace_id: &key.workspace_id,
            project_id: &key.project_id,
        };
        let usage = async {
            match &ports.usage {
                _ if *count == 0 => Ok(()),
                Some(usage) => {
                    usage
                        .add(&key.workspace_id, &utc_date(*received_at), *count)
                        .await
                }
                None => Err(PortError::backend("no usage counter")),
            }
        };
        let stamp = async {
            match &cache {
                _ if *count == 0 => Ok(()),
                Some(cache) => seen.touch(cache, &key.project_id, *received_at).await,
                None => Err(PortError::backend("no cache")),
            }
        };
        let state = ports.project_state.as_ref();
        let (usage, stamp, (), ()) = futures_util::join!(
            usage,
            stamp,
            apply_server_identifies(state, project, &batch.events, *received_at, *max_age_ms),
            apply_server_people(state, project, &batch.people),
        );
        for result in [usage, stamp] {
            if let Err(error) = result {
                log_failure_for("Server bookkeeping", &key.project_id, &error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use http::HeaderValue;

    use super::*;

    #[test]
    fn reads_only_a_bearer_secret_key() {
        let secret = format!("wps_{}", "0123456789abcdef".repeat(2));
        let with = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(
                "authorization",
                HeaderValue::from_str(value).expect("a value"),
            );
            bearer_secret(&headers)
        };
        assert_eq!(with(&format!("Bearer {secret}")), Some(secret.clone()));
        assert_eq!(with(&format!("Basic {secret}")), None);
        assert_eq!(with(&format!("Bearer wpk_{}", "a".repeat(32))), None);
        assert_eq!(with("Bearer wps_short"), None);
        assert_eq!(with(&format!("Bearer {}", secret.to_uppercase())), None);
        assert_eq!(with(&format!("Bearer {secret} ")), None);
        assert_eq!(bearer_secret(&HeaderMap::new()), None);
    }

    #[test]
    fn takes_times_inside_the_window_and_none_from_the_future() {
        let now = parse_millis("2026-10-27T12:00:00.000Z").expect("a time");
        let at = |ts: &str| server_event_time(ts, now, TRACK_MAX_AGE_MS);
        assert_eq!(at("2026-10-27T12:00:30.000Z"), Some(now));
        assert_eq!(at("2026-10-27T12:05:00.000Z"), None);
        assert_eq!(at("2026-10-21T12:00:00.000Z"), Some(now - 6 * DAY_MS));
        assert_eq!(at("2026-10-19T12:00:00.000Z"), None);
        assert_eq!(
            server_event_time("2022-10-27T12:00:00.000Z", now, IMPORT_MAX_AGE_MS),
            Some(now - 4 * 365 * DAY_MS - DAY_MS)
        );
    }

    #[test]
    fn a_server_row_has_no_browser() {
        let key = KeyRecord {
            key_id: "pnk_1".to_owned(),
            workspace_id: "ws_1".to_owned(),
            project_id: "pnp_1".to_owned(),
            status: None,
        };
        let body: Js = serde_json::from_str(
            r#"{"lib":"server","lib_version":"0.1.0","events":[
                {"event_id":"evt-00000001","name":"Order placed","ts":"2026-10-27T11:59:59.000Z","distinct_id":"user-1","props":{"total":12.5,"coupon":null}},
                {"event_id":"evt-00000002","name":"Order placed","ts":"2026-10-27T11:59:59.000Z","distinct_id":"user-1","user_id":"user-1","anon_id":"a-1",
                 "url":"https://shop.example.com/thanks?utm_source=mail&token=secret","title":"Thanks"}]}"#,
        )
        .expect("a body");
        let batch = parse_server_batch(&body, MAX_TRACK_EVENTS).expect("a batch");
        let now = parse_millis("2026-10-27T12:00:00.000Z").expect("a time");
        let (rows, dropped) = build_server_rows(&key, &batch, now, TRACK_MAX_AGE_MS);
        assert_eq!(dropped, 0);
        assert_eq!(rows[0]["anon_id"], "user-1");
        assert_eq!(rows[0]["user_id"], Value::Null);
        assert_eq!(rows[0]["url"], "");
        assert_eq!(rows[0]["properties"], r#"{"total":12.5,"coupon":null}"#);
        assert_eq!(rows[0]["lib"], "server");
        assert_eq!(
            rows[1]["url"],
            "https://shop.example.com/thanks?utm_source=mail"
        );
        assert_eq!(rows[1]["host"], "shop.example.com");
        assert_eq!(rows[1]["utm_source"], "mail");
        assert_eq!(rows[1]["anon_id"], "a-1");
        assert_eq!(rows[1]["title"], "Thanks");
        assert_eq!(rows[1]["country"], Value::Null);
    }
}
