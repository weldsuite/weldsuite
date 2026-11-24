//! `/api/panel/heatmaps` (`routes/heatmaps/index.ts`,
//! `services/heatmaps.ts`): the saved page groups and the snapshot a heat
//! layer is drawn on. The heat data is the `heatmap` kind of
//! `POST /api/panel/query`.
//!
//!   GET    /pages                → page groups (?projectId)          (`panel_reports:read`)
//!   POST   /pages                → new page group                     (`panel_reports:create`)
//!   PATCH  /pages/:id            → name, URL pattern                  (`panel_reports:update`)
//!   DELETE /pages/:id            → delete, with its stored snapshots  (`panel_reports:delete`)
//!   GET    /pages/:id/snapshot   → the masked full snapshot, gzip     (`panel_recordings:read`)
//!
//! The snapshot is one masked rrweb full snapshot (gzip of the
//! `FullSnapshot` event) per page group and device class, in the replays
//! bucket. In order: the stored one (`snapshots/<ws>/<project>/<group>/<device>.json.gz`,
//! written by the collector's `/snap`); else the full snapshot of a recent
//! recording that started on a page of the group at that device class
//! (found with the engine, read from the bucket, cut out of its chunk); else
//! a request in the cache (`panel:snapshot-request:<project>`) that
//! `/c/:token` hands to the next consented visitor, and 404
//! `SNAPSHOT_REQUESTED`.

use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderValue, StatusCode, header};
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_HEATMAP_PAGE_CREATED, PANEL_HEATMAP_PAGE_DELETED, PANEL_HEATMAP_PAGE_UPDATED,
};
use weldsuite_db::orm;
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_panel_domain::device_class::{MOBILE_MAX_WIDTH, TABLET_MAX_WIDTH};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::scope::{
    ScopeOptions, events_scope, replay_chunks_table, scope_conds,
};
use weldsuite_panel_domain::query::sql::{LIKE_ESCAPE, like_pattern, lit, ts};
use weldsuite_panel_domain::query::time::resolve_range;
use weldsuite_panel_domain::query::{PanelQueryContext, PanelSqlQuery, Runner};
use weldsuite_panel_domain::schemas::{DatePreset, DateRange};
use weldsuite_ports::{Cache, DynCache, DynFileStore};
use weldsuite_schema::tenant::panel_heatmap_pages as pages;
use weldsuite_zod::{Hook, Keys, S, Z};

use crate::domain::{heatmap_snapshot_key, snapshot_request_key};
use crate::engine::Engine;
use crate::query::QueryDeps;
use crate::recordings::{Bindings, Failure, chunk_key_belongs, iso_of, session_context, text_of};
use crate::saved::js_row;
use crate::{Caller, PanelState, unexpected};

/// How long a snapshot request waits for a visitor on a matching page.
const SNAPSHOT_REQUEST_TTL: Duration = Duration::from_hours(72);
const CANDIDATE_SESSIONS: usize = 30;
/// rrweb's `FullSnapshot` event type.
const FULL_SNAPSHOT: f64 = 2.0;

const PROJECT_ID: Z = Z::Str(&[S::Min(1, None), S::Max(30, None)]);
const PAGE_NAME: Z = Z::Str(&[S::Trim, S::Min(1, None), S::Max(255, None)]);
const URL_PATTERN: Z = Z::Str(&[
    S::Trim,
    S::Min(1, None),
    S::Max(1000, None),
    S::Regex("^/", Some("Start with /")),
]);

/// `z.object({ projectId })`.
const LIST_QUERY: Z = Z::Obj(&[("projectId", PROJECT_ID)], Keys::Strip);

/// `createPanelHeatmapPageSchema`.
const CREATE_PAGE: Z = Z::Obj(
    &[
        ("projectId", PROJECT_ID),
        ("name", PAGE_NAME),
        ("urlPattern", URL_PATTERN),
    ],
    Keys::Strip,
);

/// `.refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })`.
fn refine_something_to_update(value: Option<&Value>, hook: &mut Hook) {
    if value.and_then(Value::as_object).is_some_and(Map::is_empty) {
        hook.fail("Nothing to update");
    }
}

/// `updatePanelHeatmapPageSchema`: the create schema without `projectId`,
/// every field optional, and something to change.
const UPDATE_PAGE: Z = Z::Refine(
    &Z::Obj(
        &[
            ("name", Z::Opt(&PAGE_NAME)),
            ("urlPattern", Z::Opt(&URL_PATTERN)),
        ],
        Keys::Strip,
    ),
    refine_something_to_update,
);

/// `panelSnapshotQuerySchema`.
const SNAPSHOT_QUERY: Z = Z::Obj(
    &[(
        "deviceClass",
        Z::Enum(&["desktop", "tablet", "mobile"], None),
    )],
    Keys::Strip,
);

const DEVICE_CLASSES: [&str; 3] = ["desktop", "tablet", "mobile"];

// ---------------------------------------------------------------------------
// Page groups
// ---------------------------------------------------------------------------

/// `toHeatmapPageDto`.
fn page_dto(row: &Value) -> Value {
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": field("id"),
        "projectId": field("projectId"),
        "name": field("name"),
        "urlPattern": field("urlPattern"),
        "createdByUserId": field("createdByUserId"),
        "createdAt": field("createdAt"),
        "updatedAt": field("updatedAt"),
    })
}

/// `heatmapPageEventData`.
fn event_data(row: &Value) -> Value {
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": field("id"),
        "projectId": field("projectId"),
        "name": field("name"),
        "urlPattern": field("urlPattern"),
    })
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn publish(caller: &Caller, state: &PanelState, event: EventName, row: &Value) {
    caller.publish(state, event, text(row, "id"), &event_data(row));
}

/// The first of `rows` (a `returning` list), as Drizzle returns it.
fn first_row(rows: Vec<pages::Model>) -> Result<Option<Value>, DbErr> {
    rows.into_iter().next().map(js_row).transpose()
}

/// `GET /pages`.
pub(crate) async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let parsed = match weldsuite_zod::query(&LIST_QUERY, raw.as_deref()) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let project_id = parsed.text("projectId").unwrap_or_default();
    let found = pages::Entity::find()
        .filter(pages::Column::ProjectId.eq(project_id))
        .order_by_asc(pages::Column::Name)
        .order_by_asc(pages::Column::Id)
        .all(&orm(&caller.db))
        .await
        .and_then(|found| found.into_iter().map(js_row).collect::<Result<Vec<_>, _>>());
    match found {
        Ok(pages) => {
            let count = pages.len() as u64;
            List::new(
                pages.iter().map(page_dto).collect(),
                Pagination::new(count, false, None),
            )
            .into_response()
        }
        Err(error) => unexpected(&error, "list heatmap pages"),
    }
}

/// `POST /pages`.
pub(crate) async fn create(
    State(state): State<PanelState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let parsed = match weldsuite_zod::json(&CREATE_PAGE, &headers, &body) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let project_id = parsed.text("projectId").unwrap_or_default();
    match crate::projects::live_project(&caller, project_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Project", Some(project_id)).into_response(),
        Err(error) => return unexpected(&error, "project exists"),
    }
    let row = pages::Entity::insert(pages::ActiveModel {
        id: Set(weldsuite_kit::id::generate_id("pnh")),
        project_id: Set(project_id.to_owned()),
        name: Set(parsed.text("name").unwrap_or_default().to_owned()),
        url_pattern: Set(parsed.text("urlPattern").unwrap_or_default().to_owned()),
        created_by_user_id: Set(caller.user_id.clone()),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await
    .and_then(js_row);
    match row {
        Ok(row) => {
            publish(&caller, &state, PANEL_HEATMAP_PAGE_CREATED, &row);
            Created(page_dto(&row)).into_response()
        }
        Err(error) => unexpected(&error, "create heatmap page"),
    }
}

/// `PATCH /pages/:id`.
pub(crate) async fn update(
    State(state): State<PanelState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let parsed = match weldsuite_zod::json(&UPDATE_PAGE, &headers, &body) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let name = parsed.get("name").and_then(Value::as_str);
    let pattern = parsed.get("urlPattern").and_then(Value::as_str);
    let mut update = pages::Entity::update_many();
    if let Some(name) = name {
        update = update.col_expr(pages::Column::Name, Expr::value(name));
    }
    if let Some(pattern) = pattern {
        update = update.col_expr(pages::Column::UrlPattern, Expr::value(pattern));
    }
    let row = update
        .col_expr(pages::Column::UpdatedAt, Expr::current_timestamp())
        .filter(pages::Column::Id.eq(&id))
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(first_row);
    match row {
        Ok(Some(row)) => {
            publish(&caller, &state, PANEL_HEATMAP_PAGE_UPDATED, &row);
            Data(page_dto(&row)).into_response()
        }
        Ok(None) => ApiError::not_found("Heatmap page", Some(&id)).into_response(),
        Err(error) => unexpected(&error, "update heatmap page"),
    }
}

/// `dropSnapshots`: a page group's stored snapshots, and a pending request
/// for it, go with it.
async fn drop_snapshots(
    bucket: Option<&Arc<dyn DynFileStore>>,
    cache: Option<&Arc<dyn DynCache>>,
    workspace_id: &str,
    project_id: &str,
    page_id: &str,
) -> Result<(), weldsuite_ports::PortError> {
    if let Some(bucket) = bucket {
        let keys: Vec<String> = DEVICE_CLASSES
            .iter()
            .map(|device| heatmap_snapshot_key(workspace_id, project_id, page_id, device))
            .collect();
        bucket.delete_many_boxed(&keys).await?;
    }
    let Some(cache) = cache else {
        return Ok(());
    };
    let key = snapshot_request_key(project_id);
    let pending = async {
        let text = cache.get(&key).await?;
        let pending: Option<Value> = text
            .map(|t| serde_json::from_str(&t))
            .transpose()
            .map_err(weldsuite_ports::PortError::Json)?;
        if pending
            .as_ref()
            .and_then(|p| p.get("pageGroupId"))
            .and_then(Value::as_str)
            == Some(page_id)
        {
            cache.delete(&key).await?;
        }
        Ok::<_, weldsuite_ports::PortError>(())
    };
    if let Err(error) = pending.await {
        tracing::warn!(%error, "[panel-api] could not clear a snapshot request");
    }
    Ok(())
}

/// `DELETE /pages/:id`.
pub(crate) async fn remove(
    State(state): State<PanelState>,
    caller: Caller,
    bindings: Bindings,
    Path(id): Path<String>,
) -> Response {
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    let row = pages::Entity::delete_many()
        .filter(pages::Column::Id.eq(&id))
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(first_row);
    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Heatmap page", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "delete heatmap page"),
    };
    let bucket = bindings.replays(&state);
    let cache = caller.cache(&state);
    if let Err(error) = drop_snapshots(
        bucket.as_ref(),
        cache.as_ref(),
        &caller.workspace_id,
        text(&row, "projectId"),
        text(&row, "id"),
    )
    .await
    {
        // The page group is gone; a leftover snapshot object is unreachable
        // (its id is no longer a page group) and ages out with the bucket.
        tracing::error!(%error, "[panel-api] could not delete the snapshots of a removed heatmap page");
    }
    publish(&caller, &state, PANEL_HEATMAP_PAGE_DELETED, &row);
    NoContent.into_response()
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

fn gunzip(bytes: &[u8]) -> Option<String> {
    let mut text = String::new();
    flate2::read::MultiGzDecoder::new(bytes)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

fn gzip(text: &str) -> std::io::Result<Vec<u8>> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(text.as_bytes())?;
    encoder.finish()
}

/// `fullSnapshotFromChunk`: the first `FullSnapshot` event in a chunk's JSON
/// (an array of rrweb events), gzipped the way `/snap` stores one. `None`
/// when there is none. The event is written as the chunk holds it, which is
/// `JSON.stringify`'s own text (the SDK wrote it).
fn full_snapshot_from_chunk(chunk: &[u8]) -> Option<Vec<u8>> {
    let text = gunzip(chunk)?;
    let events: Vec<&RawValue> = serde_json::from_str(&text).ok()?;
    let full = events.into_iter().find(|event| {
        serde_json::from_str::<Value>(event.get()).is_ok_and(|value| {
            value.is_object() && value.get("type").and_then(Value::as_f64) == Some(FULL_SNAPSHOT)
        })
    })?;
    gzip(full.get()).ok()
}

fn device_condition(device_class: &str) -> String {
    match device_class {
        "mobile" => format!("e.viewport_w < {MOBILE_MAX_WIDTH}"),
        "tablet" => {
            format!("(e.viewport_w >= {MOBILE_MAX_WIDTH} AND e.viewport_w < {TABLET_MAX_WIDTH})")
        }
        _ => format!("(e.viewport_w IS NULL OR e.viewport_w >= {TABLET_MAX_WIDTH})"),
    }
}

/// A visit to the page group (`SnapshotCandidate`).
#[derive(Debug, Clone)]
struct Candidate {
    session_id: String,
    visited_at: String,
}

/// A full-snapshot chunk (`FullSnapshotChunk`).
#[derive(Debug, Clone, PartialEq)]
struct SnapshotChunk {
    session_id: String,
    ts_start: String,
    r2_key: String,
}

/// `Date.parse` of an ISO instant; NaN when it is none.
#[allow(
    clippy::cast_precision_loss,
    reason = "a JavaScript time value, exact below 2^53"
)]
fn instant(text: &str) -> f64 {
    js::parse_iso(text).map_or(f64::NAN, |millis| millis as f64)
}

/// `pickSnapshotChunks`: per visit (newest first), the latest full-snapshot
/// chunk that started no later than the visit's first matching page view
/// (plus a few seconds). A session whose snapshots all came after, or that
/// has none, is skipped.
fn pick_snapshot_chunks(candidates: &[Candidate], chunks: &[SnapshotChunk]) -> Vec<SnapshotChunk> {
    const SLACK_MS: f64 = 5000.0;
    let mut picked = Vec::new();
    for candidate in candidates {
        let visited = instant(&candidate.visited_at);
        let mut matching: Vec<&SnapshotChunk> = chunks
            .iter()
            .filter(|chunk| {
                chunk.session_id == candidate.session_id
                    && instant(&chunk.ts_start) <= visited + SLACK_MS
            })
            .collect();
        // `sort((a, b) => Date.parse(b.tsStart) - Date.parse(a.tsStart))`, stable.
        matching.sort_by(|a, b| {
            let difference = instant(&b.ts_start) - instant(&a.ts_start);
            difference
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some(best) = matching.first() {
            picked.push((*best).clone());
        }
    }
    picked
}

/// `findSnapshotChunks`: the sessions that opened a page of the group at
/// that device class lately, newest first, and their full-snapshot chunks.
async fn find_snapshot_chunks(
    engine: &Engine,
    ctx: &PanelQueryContext,
    pattern: &str,
    device_class: &str,
) -> Result<Vec<SnapshotChunk>, Failure> {
    let range = resolve_range(
        &DateRange::Preset {
            preset: DatePreset::Days30,
        },
        "UTC",
        ctx,
    )?;
    let scope = events_scope(ctx, &range, range.bounds(), ScopeOptions::default())?;
    let runner = Runner::new(engine);
    let visit_where = scope.where_sql(&[
        format!("e.name = {}", lit("$pageview")?),
        "e.session_id IS NOT NULL".to_owned(),
        format!("e.path LIKE {}{LIKE_ESCAPE}", like_pattern(pattern)?),
        device_condition(device_class),
    ]);
    let visits = runner
        .run_one(PanelSqlQuery {
            name: "heatmaps.snapshot.visits".to_owned(),
            sql: format!(
                "SELECT e.session_id AS session_id, MIN(e.ts) AS visited_at FROM {} {visit_where} GROUP BY e.session_id ORDER BY MIN(e.ts) DESC LIMIT {CANDIDATE_SESSIONS}",
                scope.from
            ),
            columns: vec!["session_id".to_owned(), "visited_at".to_owned()],
        })
        .await?;
    let mut candidates = Vec::new();
    for row in &visits {
        let candidate = Candidate {
            session_id: text_of(row.get("session_id")),
            visited_at: iso_of(row.get("visited_at"))?,
        };
        if !candidate.session_id.is_empty() && !candidate.visited_at.is_empty() {
            candidates.push(candidate);
        }
    }
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let mut conds = scope_conds(ctx, "")?;
    conds.push(format!("ts_start >= {}", ts(range.floor)));
    conds.push(format!("ts_start <= {}", ts(range.now)));
    conds.push("has_full_snapshot = true".to_owned());
    let ids = candidates
        .iter()
        .map(|c| lit(&c.session_id))
        .collect::<Result<Vec<_>, _>>()?;
    conds.push(format!("session_id IN ({})", ids.join(", ")));
    let rows = runner
        .run_one(PanelSqlQuery {
            name: "heatmaps.snapshot.chunks".to_owned(),
            sql: format!(
                "SELECT session_id, ts_start, r2_key FROM {} WHERE {} ORDER BY ts_start DESC LIMIT {}",
                replay_chunks_table(),
                conds.join(" AND "),
                CANDIDATE_SESSIONS * 20
            ),
            columns: ["session_id", "ts_start", "r2_key"]
                .map(str::to_owned)
                .to_vec(),
        })
        .await?;
    let mut chunks = Vec::new();
    for row in &rows {
        let chunk = SnapshotChunk {
            session_id: text_of(row.get("session_id")),
            ts_start: iso_of(row.get("ts_start"))?,
            r2_key: text_of(row.get("r2_key")),
        };
        if chunk_key_belongs(&chunk.r2_key, &ctx.workspace_id, &ctx.project_id) {
            chunks.push(chunk);
        }
    }
    Ok(pick_snapshot_chunks(&candidates, &chunks))
}

/// `snapshotFromRecording`: a recent recording's full snapshot for the page
/// group, or `None`. Looks at a few chunks, newest first.
async fn snapshot_from_recording(
    deps: &QueryDeps,
    bucket: &dyn DynFileStore,
    project_id: &str,
    pattern: &str,
    device_class: &str,
) -> Result<Option<Vec<u8>>, Failure> {
    let ctx = session_context(deps, project_id, Map::new()).await?;
    let engine = deps.engine()?;
    let chunks = find_snapshot_chunks(&engine, &ctx, pattern, device_class).await?;
    for chunk in chunks.iter().take(5) {
        let Some(object) = bucket.get_boxed(&chunk.r2_key).await? else {
            continue;
        };
        if let Some(snapshot) = full_snapshot_from_chunk(&object.bytes) {
            return Ok(Some(snapshot));
        }
    }
    Ok(None)
}

/// `requestSnapshot`: asks the next consented visitor on a matching page
/// for a snapshot (replaces any pending request of the project).
async fn request_snapshot(
    cache: Option<&Arc<dyn DynCache>>,
    project_id: &str,
    page_id: &str,
    pattern: &str,
    device_class: &str,
) -> Result<(), weldsuite_ports::PortError> {
    let Some(cache) = cache else {
        return Ok(());
    };
    // In `JSON.stringify`'s key order.
    let request = format!(
        "{{\"pageGroupId\":{},\"urlPattern\":{},\"deviceClass\":{}}}",
        Value::String(page_id.to_owned()),
        Value::String(pattern.to_owned()),
        Value::String(device_class.to_owned()),
    );
    cache
        .put(
            &snapshot_request_key(project_id),
            &request,
            Some(SNAPSHOT_REQUEST_TTL),
        )
        .await
}

fn snapshot_response(body: Vec<u8>, source: &'static str) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/gzip"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=300"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-snapshot-source", HeaderValue::from_static(source));
    (StatusCode::OK, headers, Body::from(body)).into_response()
}

fn snapshot_error(code: &str, message: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// `GET /pages/:id/snapshot`.
pub(crate) async fn snapshot(
    State(state): State<PanelState>,
    caller: Caller,
    bindings: Bindings,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let parsed = match weldsuite_zod::query(&SNAPSHOT_QUERY, raw.as_deref()) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let device_class = parsed.text("deviceClass").unwrap_or("desktop").to_owned();
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    let page = pages::Entity::find_by_id(id.as_str())
        .one(&orm(&caller.db))
        .await
        .and_then(|page| page.map(js_row).transpose());
    let page = match page {
        Ok(Some(page)) => page,
        Ok(None) => return ApiError::not_found("Heatmap page", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "get heatmap page"),
    };
    let project_id = text(&page, "projectId").to_owned();
    let page_id = text(&page, "id").to_owned();
    let pattern = text(&page, "urlPattern").to_owned();

    let Some(bucket) = bindings.replays(&state) else {
        return snapshot_error(
            "SNAPSHOT_UNAVAILABLE",
            "Snapshots are not stored in this environment",
        );
    };
    let key = heatmap_snapshot_key(&caller.workspace_id, &project_id, &page_id, &device_class);
    match bucket.get_boxed(&key).await {
        Ok(Some(stored)) => return snapshot_response(stored.bytes, "stored"),
        Ok(None) => {}
        Err(error) => return unexpected(&error, "read a stored snapshot"),
    }

    let deps = QueryDeps::new(&caller, &state);
    match snapshot_from_recording(&deps, bucket.as_ref(), &project_id, &pattern, &device_class)
        .await
    {
        Ok(Some(snapshot)) => return snapshot_response(snapshot, "recording"),
        Ok(None) => {}
        // The engine down or not configured: ask a visitor instead of failing the page.
        Err(error) => tracing::warn!(
            ?error,
            "[panel-api] looking for a recording to take a heatmap snapshot from failed"
        ),
    }

    if let Err(error) = request_snapshot(
        caller.cache(&state).as_ref(),
        &project_id,
        &page_id,
        &pattern,
        &device_class,
    )
    .await
    {
        tracing::warn!(%error, "[panel-api] could not write a snapshot request");
    }
    snapshot_error(
        "SNAPSHOT_REQUESTED",
        "No recording covers this page yet. A snapshot was requested from the next visitor; try again later.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_latest_snapshot_before_each_visit() {
        let candidates = [
            Candidate {
                session_id: "a".into(),
                visited_at: "2026-11-10T10:00:10.000Z".into(),
            },
            Candidate {
                session_id: "b".into(),
                visited_at: "2026-11-09T10:00:00.000Z".into(),
            },
        ];
        let chunk = |session: &str, at: &str| SnapshotChunk {
            session_id: session.into(),
            ts_start: at.into(),
            r2_key: format!("{session}@{at}"),
        };
        let chunks = [
            chunk("a", "2026-11-10T09:00:00.000Z"),
            chunk("a", "2026-11-10T10:00:00.000Z"),
            chunk("a", "2026-11-10T10:05:00.000Z"),
            chunk("b", "2026-11-09T11:00:00.000Z"),
        ];
        let picked = pick_snapshot_chunks(&candidates, &chunks);
        assert_eq!(
            picked.iter().map(|c| c.r2_key.as_str()).collect::<Vec<_>>(),
            ["a@2026-11-10T10:00:00.000Z"]
        );
    }

    #[test]
    fn cuts_the_full_snapshot_out_of_a_chunk() {
        let chunk = gzip(r#"[{"type":4,"data":{"width":1200}},{"type":2,"data":{"node":{"id":1}},"timestamp":1},{"type":3}]"#)
            .expect("gzip");
        let snapshot = full_snapshot_from_chunk(&chunk).expect("a snapshot");
        assert_eq!(
            gunzip(&snapshot).as_deref(),
            Some(r#"{"type":2,"data":{"node":{"id":1}},"timestamp":1}"#)
        );
        assert!(full_snapshot_from_chunk(&gzip(r#"[{"type":3}]"#).expect("gzip")).is_none());
        assert!(full_snapshot_from_chunk(b"not gzip").is_none());
    }
}
