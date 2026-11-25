//! `POST /public/reach/webhooks/mailpool` (`routes/public-webhooks`,
//! `services/mailpool-webhooks.ts`). Mailpool signs each delivery with
//! `X-Signature`, the hex HMAC-SHA256 of `JSON.stringify(<parsed body>)`
//! under the shared secret; the event is routed by its Mailpool id through
//! the master `reach_routes` table to the workspace's tenant database.
//! Events we do not use and ids we do not know are acknowledged with 200.

use std::fmt::Write as _;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use hmac::{KeyInit, Mac};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, REACH_DOMAIN_UPDATED, REACH_MAILBOX_SUSPENDED, REACH_MAILBOX_UPDATED,
};
use weldsuite_db::{MasterDb, Tenant, orm};
use weldsuite_events::{EntityEvent, EventContext, EventSource};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_ports::OutboundHttp;
use weldsuite_reach_domain::credentials::{open, seal};
use weldsuite_reach_domain::mailboxes::without_credentials;
use weldsuite_reach_domain::{ReachResult, iso, text, warmup_pool};
use weldsuite_schema::master::reach_routes;
use weldsuite_schema::tenant::{reach_domains, reach_mailboxes};

use crate::effects::to_ms;
use crate::mailboxes::{
    PoolDeps, patch_mailbox, pause_reasons, register_in_pool, resume_status_for,
};
use crate::mailpool::{Mailpool, imap_credentials_of, smtp_credentials_of};
use crate::{ReachState, db_error, env_value, row_json};

pub(crate) fn router<S>(state: ReachState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/public/reach/webhooks/mailpool", post(mailpool))
        .with_state(state)
}

// ── JSON.stringify(JSON.parse(raw)) ─────────────────────────────────────────

/// A parsed JSON value that keeps the key order (`JSON.parse`'s object).
enum Js {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Js>),
    Object(Vec<(String, Js)>),
}

struct JsVisitor;

impl<'de> Visitor<'de> for JsVisitor {
    type Value = Js;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("JSON")
    }

    fn visit_unit<E>(self) -> Result<Js, E> {
        Ok(Js::Null)
    }

    fn visit_bool<E>(self, v: bool) -> Result<Js, E> {
        Ok(Js::Bool(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Js, E> {
        Ok(Js::Number(v as f64))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Js, E> {
        Ok(Js::Number(v as f64))
    }

    fn visit_f64<E>(self, v: f64) -> Result<Js, E> {
        Ok(Js::Number(v))
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Js, E> {
        Ok(Js::String(v.to_owned()))
    }

    fn visit_string<E>(self, v: String) -> Result<Js, E> {
        Ok(Js::String(v))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Js, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element_seed(JsSeed)? {
            items.push(item);
        }
        Ok(Js::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Js, A::Error> {
        let mut entries: Vec<(String, Js)> = Vec::new();
        while let Some(key) = map.next_key::<String>()? {
            let value = map.next_value_seed(JsSeed)?;
            // A repeated key keeps its first place and its last value.
            match entries.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 = value,
                None => entries.push((key, value)),
            }
        }
        Ok(Js::Object(entries))
    }
}

struct JsSeed;

impl<'de> de::DeserializeSeed<'de> for JsSeed {
    type Value = Js;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Js, D::Error> {
        deserializer.deserialize_any(JsVisitor)
    }
}

fn js_number(n: f64) -> String {
    if !n.is_finite() {
        return "null".to_owned();
    }
    if n.fract() == 0.0 && n.abs() < 1e21 {
        return format!("{n:.0}");
    }
    let text = format!("{n}");
    text
}

fn js_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn stringify(value: &Js, out: &mut String) {
    match value {
        Js::Null => out.push_str("null"),
        Js::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Js::Number(n) => out.push_str(&js_number(*n)),
        Js::String(s) => js_string(out, s),
        Js::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                stringify(item, out);
            }
            out.push(']');
        }
        Js::Object(entries) => {
            out.push('{');
            for (i, (key, item)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_string(out, key);
                out.push(':');
                stringify(item, out);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(JSON.parse(raw))`; `None` when the body is not JSON.
fn canonical(raw: &[u8]) -> Option<String> {
    let mut deserializer = serde_json::Deserializer::from_slice(raw);
    let value = de::DeserializeSeed::deserialize(JsSeed, &mut deserializer).ok()?;
    deserializer.end().ok()?;
    let mut out = String::new();
    stringify(&value, &mut out);
    Some(out)
}

/// `verifyMailpoolSignature(secret, signature, payload)`.
fn verify(secret: &str, signature: Option<&str>, payload: &str) -> bool {
    let Some(signature) = signature.filter(|s| !s.is_empty()) else {
        return false;
    };
    let trimmed = signature.trim();
    let hex_text = match trimmed.get(..7) {
        Some(prefix) if prefix.eq_ignore_ascii_case("sha256=") => &trimmed[7..],
        _ => trimmed,
    };
    if hex_text.is_empty() || hex_text.len() % 2 != 0 {
        return false;
    }
    let Ok(bytes) = hex::decode(hex_text) else {
        return false;
    };
    let Ok(mut mac) = hmac::Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(payload.as_bytes());
    mac.verify_slice(&bytes).is_ok()
}

// ── the delivery ────────────────────────────────────────────────────────────

/// `parseMailpoolWebhook(body)`: (event, data).
fn parse_message(body: &Value) -> Option<(String, Value)> {
    let map = body.as_object()?;
    let event = ["event", "type", "eventType", "name"]
        .iter()
        .find_map(|key| {
            map.get(*key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })?
        .to_owned();
    let data = ["data", "payload", "body", "object"]
        .iter()
        .find_map(|key| map.get(*key).filter(|v| v.is_object()))
        .cloned()
        .unwrap_or_else(|| body.clone());
    Some((event, data))
}

fn mailpool_id_of(data: &Value) -> Option<String> {
    match data.get("id")? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn remote_status_of(data: &Value) -> Option<&'static str> {
    match data
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("active") => Some("active"),
        Some("pending") => Some("pending"),
        Some("inactive") => Some("inactive"),
        _ => None,
    }
}

fn error_of(data: &Value) -> (Option<i64>, Option<String>) {
    let Some(error) = data.get("error").filter(|e| e.is_object()) else {
        return (None, None);
    };
    (
        error.get("code").and_then(Value::as_f64).map(|c| c as i64),
        error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned),
    )
}

/// What one delivery needs.
struct Deps {
    master: PgPool,
    tenant: Option<PgPool>,
    state: ReachState,
    env: Option<RequestEnv>,
    mailpool: Option<Mailpool>,
}

impl Deps {
    async fn open_tenant(&self, clerk_org_id: &str) -> Result<PgPool, String> {
        if let Some(db) = &self.tenant {
            return Ok(db.clone());
        }
        match &self.state.tenants {
            Some(tenants) => tenants(clerk_org_id.to_owned()).await,
            None => Err("no tenant lookup".to_owned()),
        }
    }

    fn env(&self, name: &str) -> Option<String> {
        env_value(self.env.as_ref(), name)
    }

    fn keyring(&self) -> weldsuite_db::Keyring {
        weldsuite_db::Keyring {
            v1: self.env("DATABASE_ENCRYPTION_KEY"),
            v2: self.env("DATABASE_ENCRYPTION_KEY_V2"),
        }
    }

    /// `publishEntityEventRaw({ workspaceId: clerkOrgId, userId: 'mailpool', source: 'system' })`.
    fn emit(&self, clerk_org_id: &str, event: EventName, entity_id: &str, data: Value) {
        let context = EventContext::new(clerk_org_id, "mailpool", EventSource::System);
        self.state
            .events
            .publish(&context, EntityEvent::new(event, entity_id, data));
    }
}

async fn mailpool(
    State(state): State<ReachState>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let env = parts.extensions.get::<RequestEnv>().cloned();
    let Some(secret) = env_value(env.as_ref(), "MAILPOOL_WEBHOOK_SECRET") else {
        return ApiError::unavailable("Mailpool webhooks are not configured.").into_response();
    };
    let Ok(raw) = axum::body::to_bytes(body, 4 * 1024 * 1024).await else {
        return ApiError::bad_request("Body must be JSON.").into_response();
    };
    let raw: Bytes = raw;
    let Some(payload) = canonical(&raw) else {
        return ApiError::bad_request("Body must be JSON.").into_response();
    };
    let signature = headers.get("x-signature").and_then(|v| v.to_str().ok());
    if !verify(&secret, signature, &payload) {
        return ApiError::new(
            http::StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Invalid signature.",
        )
        .into_response();
    }
    let body: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    let Some((event, data)) = parse_message(&body) else {
        return axum::Json(
            json!({ "data": { "handled": false, "reason": "unrecognised_payload" } }),
        )
        .into_response();
    };
    let master = parts
        .extensions
        .get::<MasterDb>()
        .map(|m| m.0.clone())
        .or_else(|| {
            if env.is_some() {
                None
            } else {
                state.master.clone()
            }
        });
    let Some(master) = master else {
        tracing::error!("[reach-webhook] no master database");
        return ApiError::internal().into_response();
    };
    let http = parts
        .extensions
        .get::<OutboundHttp>()
        .cloned()
        .or_else(|| {
            if env.is_some() {
                None
            } else {
                state.http.clone()
            }
        })
        .unwrap_or_else(crate::unreachable_http);
    let mailpool = Mailpool::new(
        env_value(env.as_ref(), "MAILPOOL_API_KEY"),
        env_value(env.as_ref(), "MAILPOOL_API_URL"),
        http,
    );
    let deps = Deps {
        master,
        tenant: parts.extensions.get::<Tenant>().map(|t| t.db.clone()),
        state,
        env,
        mailpool,
    };
    match handle(&deps, &event, &data).await {
        Ok(outcome) => axum::Json(json!({ "data": outcome })).into_response(),
        Err(error) => {
            tracing::error!(%error, "[reach-webhook] failed");
            ApiError::internal().into_response()
        }
    }
}

fn ignored(reason: &str) -> Value {
    json!({ "handled": false, "reason": reason })
}

fn handled(changed: bool) -> Value {
    json!({ "handled": true, "changed": changed })
}

async fn handle(deps: &Deps, event: &str, data: &Value) -> Result<Value, String> {
    let result = match event {
        "mailboxes.created" | "mailboxes.updated" => on_mailbox_updated(deps, data).await,
        "mailboxes.deleted" => on_mailbox_deleted(deps, data).await,
        "domains.registered" | "domains.updated" => on_domain_updated(deps, data).await,
        _ => return Ok(ignored("event_not_used")),
    };
    result.map_err(|error| error.to_string())
}

/// An active route of `kind` for the Mailpool id: (workspace id, clerk org id, tenant entity id).
async fn find_route(
    master: &PgPool,
    kind: &str,
    external_id: &str,
) -> ReachResult<Option<(String, String, String)>> {
    reach_routes::Entity::find()
        .select_only()
        .columns([
            reach_routes::Column::WorkspaceId,
            reach_routes::Column::ClerkOrgId,
            reach_routes::Column::TenantEntityId,
        ])
        .filter(reach_routes::Column::Kind.eq(kind))
        .filter(reach_routes::Column::ExternalId.eq(external_id))
        .filter(reach_routes::Column::Status.eq("active"))
        .into_tuple()
        .one(&orm(master))
        .await
        .map_err(db_error)
}

/// The webhook's columns of the mailbox (`status`, `pausedReason`,
/// `lastError`, the logins, `warmupStartedAt`, `warmupStatus`).
async fn update_mailbox(
    db: &PgPool,
    id: &str,
    patch: Value,
    at: OffsetDateTime,
) -> ReachResult<Option<Value>> {
    let Value::Object(patch) = patch else {
        return Ok(None);
    };
    patch_mailbox(db, id, &patch, at).await
}

async fn load_mailbox(db: &PgPool, id: &str) -> ReachResult<Option<Value>> {
    reach_mailboxes::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await
        .map_err(db_error)?
        .map(row_json)
        .transpose()
}

/// The webhook's clock (`CONFORMANCE_NOW` or now), as `toISOString()` keeps it.
fn webhook_now(deps: &Deps) -> OffsetDateTime {
    to_ms(weldsuite_reach_domain::now_or(
        deps.env.as_ref().and_then(|e| e.get("CONFORMANCE_NOW")),
    ))
}

const CONFIGURATION_ERROR_CODES: &[i64] = &[101, 201, 202, 301];

/// Mailpool is outside the EU (ADR OPS-026). Most of its events only bring
/// WeldSuite's own records in line (a mailbox deleted or gone inactive at
/// Mailpool is paused in the warm-up pool and marked, a domain takes its
/// status): no call to Mailpool and no sending through it, so they run
/// whatever the workspace's switch, as inbound paths do. Only a mailbox
/// reported active goes back to Mailpool (its logins) and into sending
/// through it again: that needs the switch.
fn needs_mailpool_switch(event: &str, data: &Value) -> bool {
    matches!(event, "mailboxes.created" | "mailboxes.updated")
        && remote_status_of(data) == Some("active")
}

/// On the EU edition, whether the workspace has Mailpool switched off; an
/// event that [`needs_mailpool_switch`] is then acknowledged and not acted
/// on. Logged by the check.
async fn mailpool_off(db: &PgPool, clerk_org_id: &str) -> bool {
    !weldsuite_outside_eu::allowed(
        db,
        weldsuite_outside_eu::ServiceId::Mailpool,
        &format!("mailpool webhook {clerk_org_id}"),
    )
    .await
}

async fn on_mailbox_updated(deps: &Deps, data: &Value) -> ReachResult<Value> {
    let Some(mailpool_id) = mailpool_id_of(data) else {
        return Ok(ignored("no_id"));
    };
    let Some((workspace_id, clerk_org_id, entity_id)) =
        find_route(&deps.master, "mailpool_mailbox", &mailpool_id).await?
    else {
        return Ok(ignored("unknown_id"));
    };
    let db = deps
        .open_tenant(&clerk_org_id)
        .await
        .map_err(|e| weldsuite_reach_domain::ReachError::unexpected(&e))?;
    if needs_mailpool_switch("mailboxes.updated", data) && mailpool_off(&db, &clerk_org_id).await {
        return Ok(ignored("outside_eu_off"));
    }
    let Some(mailbox) = load_mailbox(&db, &entity_id)
        .await?
        .filter(|m| !matches!(text(m, "status"), Some("deleting" | "deleted")))
    else {
        return Ok(ignored("mailbox_gone"));
    };
    let at = webhook_now(deps);
    match remote_status_of(data) {
        Some("inactive") => suspend_inactive(deps, &db, &clerk_org_id, &mailbox, data, at).await,
        Some("active") => {
            apply_active(deps, &db, &clerk_org_id, &workspace_id, &mailbox, data, at).await
        }
        _ => Ok(handled(false)),
    }
}

async fn suspend_inactive(
    deps: &Deps,
    db: &PgPool,
    clerk_org_id: &str,
    mailbox: &Value,
    data: &Value,
    at: OffsetDateTime,
) -> ReachResult<Value> {
    let (code, message) = error_of(data);
    let status = if code.is_some_and(|c| CONFIGURATION_ERROR_CODES.contains(&c)) {
        "error"
    } else {
        "suspended"
    };
    let reason = message.unwrap_or_else(|| {
        if status == "error" {
            "The mailbox provider reported a problem with this mailbox.".to_owned()
        } else {
            "Suspended by the mailbox provider.".to_owned()
        }
    });
    if text(mailbox, "status") == Some(status)
        && text(mailbox, "lastError") == Some(reason.as_str())
    {
        return Ok(handled(false));
    }
    let id = text(mailbox, "id").unwrap_or_default();
    warmup_pool::pause(&deps.master, clerk_org_id, id, pause_reasons::SUSPENDED).await?;
    let patch = json!({
        "status": status,
        "pausedReason": if status == "suspended" { Some(reason.as_str()) } else { None },
        "lastError": reason,
    });
    if let Some(updated) = update_mailbox(db, id, patch, at).await? {
        deps.emit(
            clerk_org_id,
            REACH_MAILBOX_SUSPENDED,
            id,
            without_credentials(&updated),
        );
    }
    Ok(handled(true))
}

/// `withLogins(deps, remote)`.
async fn with_logins(deps: &Deps, remote: &Value) -> Value {
    if smtp_credentials_of(remote).is_some() && imap_credentials_of(remote).is_some() {
        return remote.clone();
    }
    let Some(mailpool) = &deps.mailpool else {
        return remote.clone();
    };
    match mailpool
        .get_mailbox(&crate::mailpool::id_text(remote))
        .await
    {
        Ok(found) => found,
        Err(error) => {
            tracing::warn!(
                ?error,
                "[reach-webhook] could not read the mailbox for its logins; the daily pass retries"
            );
            remote.clone()
        }
    }
}

async fn apply_active(
    deps: &Deps,
    db: &PgPool,
    clerk_org_id: &str,
    workspace_id: &str,
    mailbox: &Value,
    data: &Value,
    at: OffsetDateTime,
) -> ReachResult<Value> {
    let id = text(mailbox, "id").unwrap_or_default();
    let status = text(mailbox, "status").unwrap_or_default();
    let pool = PoolDeps {
        db,
        master: &deps.master,
        warmup_key: deps.env("WELDREACH_WARMUP_KEY"),
        clerk_org_id,
        workspace_id,
    };
    let keyring = deps.keyring();
    if status == "provisioning" {
        let remote = with_logins(deps, data).await;
        let smtp = smtp_credentials_of(&remote)
            .or_else(|| open(&keyring, text(mailbox, "smtpCredentials")));
        let imap = imap_credentials_of(&remote)
            .or_else(|| open(&keyring, text(mailbox, "imapCredentials")));
        let (Some(smtp), Some(imap)) = (smtp, imap) else {
            return Ok(handled(false));
        };
        register_in_pool(&pool, mailbox, smtp.clone(), imap.clone(), None).await?;
        let mut patch = json!({
            "status": "warming",
            "warmupStartedAt": text(mailbox, "warmupStartedAt").map_or_else(|| iso(at), str::to_owned),
            "warmupStatus": "waiting",
            "pausedReason": null,
            "lastError": null,
        });
        let seal_with =
            |c| seal(&keyring, c).map_err(|e| weldsuite_reach_domain::ReachError::unexpected(&e));
        if text(mailbox, "smtpCredentials").is_none() {
            patch["smtpCredentials"] = json!(seal_with(&smtp)?);
        }
        if text(mailbox, "imapCredentials").is_none() {
            patch["imapCredentials"] = json!(seal_with(&imap)?);
        }
        let warmed = update_mailbox(db, id, patch, at)
            .await?
            .unwrap_or_else(|| mailbox.clone());
        if text(&warmed, "status") == text(mailbox, "status") {
            return Ok(handled(false));
        }
        deps.emit(
            clerk_org_id,
            REACH_MAILBOX_UPDATED,
            id,
            without_credentials(&warmed),
        );
        return Ok(handled(true));
    }
    if status == "error" && text(mailbox, "pausedReason") == Some("login_failed") {
        return Ok(handled(false));
    }
    if status == "suspended" || status == "error" {
        warmup_pool::resume(&deps.master, clerk_org_id, id).await?;
        let patch = json!({ "status": resume_status_for(mailbox), "pausedReason": null, "lastError": null });
        if let Some(restored) = update_mailbox(db, id, patch, at).await? {
            deps.emit(
                clerk_org_id,
                REACH_MAILBOX_UPDATED,
                id,
                without_credentials(&restored),
            );
        }
        return Ok(handled(true));
    }
    if text(mailbox, "smtpCredentials").is_none() {
        let Some(smtp) = smtp_credentials_of(data) else {
            return Ok(handled(false));
        };
        let imap = imap_credentials_of(data);
        if let Some(imap) = &imap {
            register_in_pool(&pool, mailbox, smtp.clone(), imap.clone(), None).await?;
        }
        let seal_with =
            |c| seal(&keyring, c).map_err(|e| weldsuite_reach_domain::ReachError::unexpected(&e));
        let mut patch = json!({ "smtpCredentials": seal_with(&smtp)? });
        if let Some(imap) = &imap {
            patch["imapCredentials"] = json!(seal_with(imap)?);
        }
        update_mailbox(db, id, patch, at).await?;
        return Ok(handled(true));
    }
    Ok(handled(false))
}

async fn on_mailbox_deleted(deps: &Deps, data: &Value) -> ReachResult<Value> {
    let Some(mailpool_id) = mailpool_id_of(data) else {
        return Ok(ignored("no_id"));
    };
    let Some((_, clerk_org_id, entity_id)) =
        find_route(&deps.master, "mailpool_mailbox", &mailpool_id).await?
    else {
        return Ok(ignored("unknown_id"));
    };
    let db = deps
        .open_tenant(&clerk_org_id)
        .await
        .map_err(|e| weldsuite_reach_domain::ReachError::unexpected(&e))?;
    let Some(mailbox) = load_mailbox(&db, &entity_id)
        .await?
        .filter(|m| !matches!(text(m, "status"), Some("deleting" | "deleted")))
    else {
        return Ok(ignored("mailbox_gone"));
    };
    let at = webhook_now(deps);
    let id = text(&mailbox, "id").unwrap_or_default();
    warmup_pool::pause(&deps.master, &clerk_org_id, id, pause_reasons::SUSPENDED).await?;
    let patch = json!({
        "status": "error",
        "pausedReason": null,
        "lastError": "The mailbox was deleted at the mailbox provider. Delete it here to stop billing.",
    });
    if let Some(updated) = update_mailbox(&db, id, patch, at).await? {
        deps.emit(
            &clerk_org_id,
            REACH_MAILBOX_SUSPENDED,
            id,
            without_credentials(&updated),
        );
    }
    Ok(handled(true))
}

async fn on_domain_updated(deps: &Deps, data: &Value) -> ReachResult<Value> {
    let Some(mailpool_id) = mailpool_id_of(data) else {
        return Ok(ignored("no_id"));
    };
    let Some((_, clerk_org_id, entity_id)) =
        find_route(&deps.master, "mailpool_domain", &mailpool_id).await?
    else {
        return Ok(ignored("unknown_id"));
    };
    let db = deps
        .open_tenant(&clerk_org_id)
        .await
        .map_err(|e| weldsuite_reach_domain::ReachError::unexpected(&e))?;
    let domain = reach_domains::Entity::find_by_id(entity_id.clone())
        .one(&orm(&db))
        .await
        .map_err(db_error)?
        .map(row_json)
        .transpose()?;
    let Some(domain) = domain.filter(|d| text(d, "status") != Some("disconnecting")) else {
        return Ok(ignored("domain_gone"));
    };
    let Some(remote) = remote_status_of(data) else {
        return Ok(handled(false));
    };
    let at = webhook_now(deps);
    let status = match remote {
        "active" => "active",
        "pending" => "connecting",
        _ => "error",
    };
    let last_error = (remote == "inactive").then(|| {
        error_of(data)
            .1
            .unwrap_or_else(|| "The mailbox provider disabled this domain.".to_owned())
    });
    if text(&domain, "status") == Some(status)
        && text(&domain, "lastError").map(str::to_owned) == last_error
    {
        return Ok(handled(false));
    }
    let domain_id = text(&domain, "id").unwrap_or_default().to_owned();
    let updated = reach_domains::Entity::update_many()
        .col_expr(reach_domains::Column::Status, Expr::value(status))
        .col_expr(reach_domains::Column::LastError, Expr::value(last_error))
        .col_expr(reach_domains::Column::UpdatedAt, Expr::value(at))
        .filter(reach_domains::Column::Id.eq(&domain_id))
        .exec_with_returning(&orm(&db))
        .await
        .map_err(db_error)?
        .into_iter()
        .next()
        .map(row_json)
        .transpose()?;
    if let Some(updated) = updated {
        deps.emit(&clerk_org_id, REACH_DOMAIN_UPDATED, &domain_id, updated);
    }
    if status == "error" {
        let live: Vec<String> = reach_mailboxes::Entity::find()
            .select_only()
            .column(reach_mailboxes::Column::Id)
            .filter(reach_mailboxes::Column::DomainId.eq(&domain_id))
            .filter(reach_mailboxes::Column::DeletedAt.is_null())
            .filter(reach_mailboxes::Column::Status.is_in(["warming", "active"]))
            .into_tuple()
            .all(&orm(&db))
            .await
            .map_err(db_error)?;
        for id in live {
            warmup_pool::pause(
                &deps.master,
                &clerk_org_id,
                &id,
                pause_reasons::DOMAIN_ERROR,
            )
            .await?;
            let patch = json!({ "status": "paused", "pausedReason": "domain_error" });
            if let Some(paused) = update_mailbox(&db, &id, patch, at).await? {
                deps.emit(
                    &clerk_org_id,
                    REACH_MAILBOX_UPDATED,
                    &id,
                    without_credentials(&paused),
                );
            }
        }
    } else if status == "active"
        && text(&domain, "status") == Some("error")
        // Resuming the parked mailboxes puts them back into the warm-up pool
        // and sending through Mailpool: that needs the switch (ADR OPS-026);
        // the domain's own status above never does.
        && !mailpool_off(&db, &clerk_org_id).await
    {
        let parked = reach_mailboxes::Entity::find()
            .filter(reach_mailboxes::Column::DomainId.eq(&domain_id))
            .filter(reach_mailboxes::Column::Status.eq("paused"))
            .filter(reach_mailboxes::Column::PausedReason.eq("domain_error"))
            .all(&orm(&db))
            .await
            .map_err(db_error)?
            .into_iter()
            .map(row_json)
            .collect::<ReachResult<Vec<Value>>>()?;
        for mailbox in parked {
            let id = text(&mailbox, "id").unwrap_or_default();
            warmup_pool::resume(&deps.master, &clerk_org_id, id).await?;
            let patch = json!({ "status": resume_status_for(&mailbox), "pausedReason": null });
            if let Some(resumed) = update_mailbox(&db, id, patch, at).await? {
                deps.emit(
                    &clerk_org_id,
                    REACH_MAILBOX_UPDATED,
                    id,
                    without_credentials(&resumed),
                );
            }
        }
    }
    Ok(handled(true))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::needs_mailpool_switch;

    /// ADR OPS-026: an event that only brings WeldSuite's own records in line
    /// runs whatever the workspace's Mailpool switch, so a mailbox deleted or
    /// gone inactive at Mailpool still leaves the cross-workspace warm-up
    /// pool, and a domain still takes its status. Only an active mailbox,
    /// which goes back to Mailpool and into sending, waits for the switch.
    #[test]
    fn only_an_active_mailbox_waits_for_the_mailpool_switch() {
        for (event, status) in [
            ("mailboxes.deleted", "active"),
            ("mailboxes.deleted", "inactive"),
            ("mailboxes.updated", "inactive"),
            ("mailboxes.created", "pending"),
            ("domains.updated", "active"),
            ("domains.registered", "inactive"),
        ] {
            assert!(
                !needs_mailpool_switch(event, &json!({ "status": status })),
                "{event} {status}"
            );
        }
        for event in ["mailboxes.created", "mailboxes.updated"] {
            assert!(
                needs_mailpool_switch(event, &json!({ "status": "ACTIVE" })),
                "{event}"
            );
        }
    }
}
