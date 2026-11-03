//! WeldConnect's integration triggers on the webhook side
//! (integration-webhook-worker's `lib/workflow-events` and the
//! `/integration-webhook/*` routes): an inbound Slack event or slash
//! command, a Twilio SMS or a GitHub issue / pull request event becomes an
//! `integration_event`, and every active workflow with a matching trigger
//! gets a run on `EXECUTE_WORKFLOW` (`matchAndDispatchIntegrationTriggers`).
//!
//! - `POST /integration-webhook/slack`: one app-level URL, the workspace
//!   from the team's `slack_team:` KV entry, signed with
//!   `SLACK_SIGNING_SECRET` (five minutes of clock skew);
//! - `POST /integration-webhook/twilio/:connectionId` and
//!   `/integration-webhook/github/:connectionId`: one URL per connection
//!   (`intconn:` KV entry), signed with the connection's own secret.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::{HeaderMap, StatusCode, Uri};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use weldsuite_core_domain::js::{Js, as_text, js_string};
use weldsuite_db::{Keyring, PgPool};
use weldsuite_ports::BoxFuture;

use crate::{IntegrationsState, PublicCtx};

/// The `EXECUTE_WORKFLOW` binding (`create({ params })`); `Err` is what it
/// threw.
pub trait ExecuteWorkflowRuns: Send + Sync {
    fn create<'a>(&'a self, params: &'a Value) -> BoxFuture<'a, Result<(), String>>;
}

/// A request's own `EXECUTE_WORKFLOW` (conformance: the test's, or none),
/// ahead of the app's.
#[derive(Clone)]
pub struct RequestExecuteWorkflow(pub Option<Arc<dyn ExecuteWorkflowRuns>>);

impl std::fmt::Debug for RequestExecuteWorkflow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestExecuteWorkflow")
    }
}

/// An inbound event: what a trigger matches on and the run receives.
#[derive(Debug, Clone, PartialEq)]
pub struct IntegrationEvent {
    pub provider: &'static str,
    pub event: &'static str,
    pub data: Map<String, Value>,
}

/// `===` between JSON values (`undefined` is `None`).
fn strict_equals(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

fn text_of(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), |v| as_text(&Js::from_jsonb(v)))
}

/// `evalFilters(filters, data)`.
pub fn eval_filters(filters: Option<&Value>, data: &Map<String, Value>) -> bool {
    let Some(Value::Array(filters)) = filters else {
        return true;
    };
    filters.iter().all(|filter| {
        let field = filter
            .get("field")
            .map_or_else(|| "undefined".to_owned(), |f| js_string(&Js::from_jsonb(f)));
        let value = data.get(&field);
        let expected = filter.get("value");
        match filter
            .get("operator")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "eq" | "equals" => strict_equals(value, expected),
            "neq" | "not_equals" => !strict_equals(value, expected),
            "contains" => text_of(value).contains(&text_of(expected)),
            "exists" => !matches!(value, None | Some(Value::Null)),
            "not_exists" => matches!(value, None | Some(Value::Null)),
            _ => true,
        }
    })
}

/// `trigger.x ?? trigger.config?.x`.
fn trigger_field<'a>(trigger: &'a Value, key: &str) -> Option<&'a Value> {
    trigger
        .get(key)
        .filter(|v| !v.is_null())
        .or_else(|| trigger.get("config").and_then(|c| c.get(key)))
        .filter(|v| !v.is_null())
}

/// `integrationTriggerMatches(trigger, provider, event, integrationId, data)`.
fn trigger_matches(
    trigger: &Value,
    provider: &str,
    event: &str,
    integration_id: Option<&str>,
    data: &Map<String, Value>,
) -> bool {
    if trigger.get("type").and_then(Value::as_str) != Some("integration_event")
        || trigger.get("isEnabled") == Some(&Value::Bool(false))
    {
        return false;
    }
    if trigger_field(trigger, "provider").and_then(Value::as_str) != Some(provider)
        || trigger_field(trigger, "event").and_then(Value::as_str) != Some(event)
    {
        return false;
    }
    let pinned =
        trigger_field(trigger, "integrationId").filter(|v| crate::crm::mapper::truthy(Some(v)));
    if let (Some(pinned), Some(id)) = (pinned, integration_id.filter(|i| !i.is_empty()))
        && pinned.as_str() != Some(id)
    {
        return false;
    }
    eval_filters(trigger_field(trigger, "filters"), data)
}

/// One run (`EXECUTE_WORKFLOW.create({ params })`).
async fn dispatch_one(
    runs: &dyn ExecuteWorkflowRuns,
    workspace_id: &str,
    user_id: &str,
    workflow_id: &str,
    trigger_id: Option<&str>,
    integration_id: Option<&str>,
    event: &IntegrationEvent,
) {
    let mut trigger_data = Map::new();
    trigger_data.insert("eventType".to_owned(), json!(event.event));
    trigger_data.insert("provider".to_owned(), json!(event.provider));
    trigger_data.insert("event".to_owned(), json!(event.event));
    if let Some(id) = integration_id {
        trigger_data.insert("integrationId".to_owned(), json!(id));
    }
    trigger_data.insert("data".to_owned(), Value::Object(event.data.clone()));
    let mut params = Map::new();
    params.insert("workspaceId".to_owned(), json!(workspace_id));
    params.insert("userId".to_owned(), json!(user_id));
    params.insert("workflowId".to_owned(), json!(workflow_id));
    if let Some(trigger) = trigger_id.filter(|t| !t.is_empty()) {
        params.insert("triggerId".to_owned(), json!(trigger));
    }
    params.insert("triggerType".to_owned(), json!("integration_event"));
    params.insert("triggerData".to_owned(), Value::Object(trigger_data));
    params.insert("source".to_owned(), json!("integration"));
    match runs.create(&Value::Object(params)).await {
        Ok(()) => tracing::info!(
            "[TriggerMatcher] Dispatched workflow {workflow_id} for {}:{}",
            event.provider,
            event.event
        ),
        Err(error) => {
            tracing::error!("[TriggerMatcher] Failed to dispatch workflow {workflow_id}: {error}");
        }
    }
}

type IndexRow = (String, String, Option<String>, Option<Value>);

/// `matchAndDispatchIntegrationTriggers(...)`: the enabled
/// `integration_event` triggers of active workflows (the trigger index,
/// else the workflows' own triggers), each matching one a run. Without a
/// workspace or the binding nothing happens.
pub async fn match_and_dispatch(
    db: &PgPool,
    runs: Option<&dyn ExecuteWorkflowRuns>,
    workspace_id: &str,
    integration_id: Option<&str>,
    event: &IntegrationEvent,
) -> usize {
    let Some(runs) = runs else {
        return 0;
    };
    if workspace_id.is_empty() {
        return 0;
    }
    let rows: Result<Vec<IndexRow>, sqlx::Error> = sqlx::query_as(
        "select i.workflow_id, i.trigger_id, i.integration_id, i.filters
         from workflow_trigger_index i inner join workflows w on i.workflow_id = w.id
         where i.category = 'integration_event' and i.provider = $1 and i.integration_event = $2
           and i.is_enabled = true and w.status = 'active' and w.deleted_at is null",
    )
    .bind(event.provider)
    .bind(event.event)
    .fetch_all(db)
    .await;
    let mut dispatched = 0;
    match rows {
        Ok(rows) => {
            for (workflow_id, trigger_id, pinned, filters) in rows {
                if let (Some(pinned), Some(id)) = (
                    pinned.filter(|p| !p.is_empty()),
                    integration_id.filter(|i| !i.is_empty()),
                ) && pinned != id
                {
                    continue;
                }
                if !eval_filters(filters.as_ref(), &event.data) {
                    continue;
                }
                dispatch_one(
                    runs,
                    workspace_id,
                    "system",
                    &workflow_id,
                    Some(&trigger_id),
                    integration_id,
                    event,
                )
                .await;
                dispatched += 1;
            }
        }
        Err(error) => {
            tracing::warn!(%error, "[TriggerMatcher] trigger index unavailable, falling back to JSONB scan");
            let workflows: Vec<(String, Option<Value>)> = sqlx::query_as(
                "select id, triggers from workflows where status = 'active' and deleted_at is null",
            )
            .fetch_all(db)
            .await
            .unwrap_or_default();
            for (workflow_id, triggers) in workflows {
                let Some(Value::Array(triggers)) = triggers else {
                    continue;
                };
                for trigger in &triggers {
                    if !trigger_matches(
                        trigger,
                        event.provider,
                        event.event,
                        integration_id,
                        &event.data,
                    ) {
                        continue;
                    }
                    dispatch_one(
                        runs,
                        workspace_id,
                        "system",
                        &workflow_id,
                        trigger.get("id").and_then(Value::as_str),
                        integration_id,
                        event,
                    )
                    .await;
                    dispatched += 1;
                }
            }
        }
    }
    dispatched
}

// ── Signatures and payloads ─────────────────────────────────────────────────

/// The workers' constant-time compare (UTF-16 code units).
fn same(a: &str, b: &str) -> bool {
    let (a, b): (Vec<u16>, Vec<u16>) = (a.encode_utf16().collect(), b.encode_utf16().collect());
    a.len() == b.len() && a.iter().zip(&b).fold(0u16, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn hmac_sha256(secret: &str, data: &[u8]) -> Vec<u8> {
    use hmac::{KeyInit, Mac};
    let mut mac = hmac::Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// `verifySlackSignature(signingSecret, timestamp, rawBody, signature)`.
pub fn verify_slack(
    secret: Option<&str>,
    timestamp: Option<&str>,
    body: &[u8],
    signature: Option<&str>,
    now_seconds: f64,
) -> bool {
    let (Some(secret), Some(timestamp), Some(signature)) = (
        secret.filter(|s| !s.is_empty()),
        timestamp.filter(|t| !t.is_empty()),
        signature.filter(|s| !s.is_empty()),
    ) else {
        return false;
    };
    let Ok(ts) = timestamp.trim().parse::<f64>() else {
        return false;
    };
    if !ts.is_finite() || (now_seconds - ts).abs() > 300.0 {
        return false;
    }
    let mut base = format!("v0:{timestamp}:").into_bytes();
    base.extend_from_slice(body);
    same(
        &format!("v0={}", hex::encode(hmac_sha256(secret, &base))),
        signature,
    )
}

/// `verifyTwilioSignature(authToken, url, params, signature)`: HMAC-SHA1 of
/// the URL and the sorted parameters, base64.
///
/// # Panics
///
/// Never: HMAC takes a key of any length.
pub fn verify_twilio(
    auth_token: Option<&str>,
    url: &str,
    params: &[(String, String)],
    signature: Option<&str>,
) -> bool {
    use base64::Engine as _;
    use hmac::{KeyInit, Mac};
    let (Some(token), Some(signature)) = (
        auth_token.filter(|t| !t.is_empty()),
        signature.filter(|s| !s.is_empty()),
    ) else {
        return false;
    };
    let mut keys: Vec<&(String, String)> = params.iter().collect();
    keys.sort_by(|a, b| {
        a.0.encode_utf16()
            .collect::<Vec<_>>()
            .cmp(&b.0.encode_utf16().collect::<Vec<_>>())
    });
    let mut data = url.to_owned();
    for (key, value) in keys {
        data.push_str(key);
        data.push_str(value);
    }
    let mut mac = hmac::Hmac::<sha1::Sha1>::new_from_slice(token.as_bytes()).expect("any key");
    mac.update(data.as_bytes());
    let expected = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    same(&expected, signature)
}

/// `verifyGithubSignature(secret, rawBody, signature)`.
pub fn verify_github(secret: Option<&str>, body: &[u8], signature: Option<&str>) -> bool {
    let (Some(secret), Some(signature)) = (
        secret.filter(|s| !s.is_empty()),
        signature.filter(|s| !s.is_empty()),
    ) else {
        return false;
    };
    same(
        &format!("sha256={}", hex::encode(hmac_sha256(secret, body))),
        signature,
    )
}

/// `Object.fromEntries(new URLSearchParams(body))`: the last value of a key wins,
/// in the order the keys first appeared.
pub fn form_params(body: &[u8]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (key, value) in form_urlencoded::parse(body) {
        match out.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value.into_owned(),
            None => out.push((key.into_owned(), value.into_owned())),
        }
    }
    out
}

fn param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a String> {
    params.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn put(data: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        data.insert(key.to_owned(), value.clone());
    }
}

/// `parseSlackEventCallback(payload)`: a person's message; the team id.
pub fn parse_slack_event(payload: &Value) -> Option<(String, IntegrationEvent)> {
    if payload.get("type").and_then(Value::as_str) != Some("event_callback") {
        return None;
    }
    let ev = payload
        .get("event")
        .filter(|e| crate::crm::mapper::truthy(Some(e)))?;
    let team = payload
        .get("team_id")
        .filter(|t| !t.is_null())
        .map(|t| js_string(&Js::from_jsonb(t)))
        .unwrap_or_default();
    if team.is_empty() {
        return None;
    }
    let truthy = |key: &str| crate::crm::mapper::truthy(ev.get(key));
    if ev.get("type").and_then(Value::as_str) != Some("message")
        || truthy("bot_id")
        || truthy("subtype")
    {
        return None;
    }
    let mut data = Map::new();
    put(&mut data, "channel", ev.get("channel"));
    put(&mut data, "user", ev.get("user"));
    put(&mut data, "text", ev.get("text"));
    put(&mut data, "ts", ev.get("ts"));
    data.insert("team_id".to_owned(), json!(team));
    Some((
        team,
        IntegrationEvent {
            provider: "slack",
            event: "slack.message",
            data,
        },
    ))
}

/// `parseSlackSlashCommand(form)`.
pub fn parse_slack_command(params: &[(String, String)]) -> Option<(String, IntegrationEvent)> {
    let team = param(params, "team_id").filter(|t| !t.is_empty())?.clone();
    let mut data = Map::new();
    for key in ["command", "text", "user_id", "channel_id"] {
        if let Some(value) = param(params, key) {
            data.insert(key.to_owned(), json!(value));
        }
    }
    data.insert("team_id".to_owned(), json!(team));
    Some((
        team,
        IntegrationEvent {
            provider: "slack",
            event: "slack.slash_command",
            data,
        },
    ))
}

/// `parseTwilioSms(params)`.
pub fn parse_twilio_sms(params: &[(String, String)]) -> Option<IntegrationEvent> {
    let from = param(params, "From").filter(|f| !f.is_empty())?;
    let body = param(params, "Body")?;
    let mut data = Map::new();
    data.insert("from".to_owned(), json!(from));
    if let Some(to) = param(params, "To") {
        data.insert("to".to_owned(), json!(to));
    }
    data.insert("body".to_owned(), json!(body));
    if let Some(sid) = param(params, "MessageSid") {
        data.insert("messageSid".to_owned(), json!(sid));
    }
    Some(IntegrationEvent {
        provider: "twilio",
        event: "twilio.inbound_sms",
        data,
    })
}

/// `parseGithubEvent(eventHeader, payload)`.
pub fn parse_github_event(event_header: &str, payload: &Value) -> Option<IntegrationEvent> {
    let (event, object, fields): (&'static str, &str, &[&str]) = match event_header {
        "issues" => ("github.issue", "issue", &["number", "title", "state"]),
        "pull_request" => (
            "github.pull_request",
            "pull_request",
            &["number", "title", "state", "merged"],
        ),
        _ => return None,
    };
    let mut data = Map::new();
    put(&mut data, "action", payload.get("action"));
    let item = payload.get(object);
    for field in fields {
        put(&mut data, field, item.and_then(|i| i.get(*field)));
    }
    put(
        &mut data,
        "repository",
        payload.get("repository").and_then(|r| r.get("full_name")),
    );
    Some(IntegrationEvent {
        provider: "github",
        event,
        data,
    })
}

// ── Routes ──────────────────────────────────────────────────────────────────

pub(crate) fn router<S>(state: IntegrationsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/integration-webhook/slack", post(slack))
        .route("/integration-webhook/twilio/{connection_id}", post(twilio))
        .route("/integration-webhook/github/{connection_id}", post(github))
        .with_state(state)
}

fn answer(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// `app.onError`: the 500 an uncaught error ends in.
fn on_error(ctx: &PublicCtx, state: &IntegrationsState, message: &str) -> Response {
    let mut body = Map::new();
    body.insert("error".to_owned(), json!("Internal Server Error"));
    if ctx.env(state, "ENVIRONMENT").as_deref() != Some("production") {
        body.insert("message".to_owned(), json!(message));
    }
    answer(StatusCode::INTERNAL_SERVER_ERROR, Value::Object(body))
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// `EXECUTE_WORKFLOW`: the request's (conformance), else the state's.
fn execute_runs(
    ctx: &PublicCtx,
    state: &IntegrationsState,
) -> Option<Arc<dyn ExecuteWorkflowRuns>> {
    match &ctx.execute_workflow {
        Some(runs) => runs.0.clone(),
        None => state.execute_workflow.clone(),
    }
}

/// A KV value read as JSON (`get(key, 'json')`).
async fn kv_json(
    ctx: &PublicCtx,
    state: &IntegrationsState,
    key: &str,
) -> Result<Option<Value>, String> {
    let Some(cache) = ctx.cache(state) else {
        return Ok(None);
    };
    match cache.get_boxed(key).await.map_err(|e| e.to_string())? {
        None => Ok(None),
        Some(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|e| e.to_string()),
    }
}

/// Matching triggers dispatched in the background (`waitUntil`).
fn dispatch_later(
    state: &IntegrationsState,
    runs: Option<Arc<dyn ExecuteWorkflowRuns>>,
    db: PgPool,
    workspace_id: String,
    integration_id: Option<String>,
    event: IntegrationEvent,
) {
    let Some(runs) = runs else {
        return;
    };
    state.events.tracker().spawn(async move {
        match_and_dispatch(
            &db,
            Some(runs.as_ref()),
            &workspace_id,
            integration_id.as_deref(),
            &event,
        )
        .await;
    });
}

async fn slack(
    State(state): State<IntegrationsState>,
    ctx: PublicCtx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    #[allow(clippy::cast_precision_loss)]
    let now = crate::crm::now_millis() as f64 / 1000.0;
    if !verify_slack(
        ctx.env(&state, "SLACK_SIGNING_SECRET").as_deref(),
        header(&headers, "x-slack-request-timestamp"),
        &body,
        header(&headers, "x-slack-signature"),
        now,
    ) {
        return answer(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "invalid signature" }),
        );
    }
    let parsed = if header(&headers, "content-type")
        .unwrap_or_default()
        .contains("application/x-www-form-urlencoded")
    {
        parse_slack_command(&form_params(&body))
    } else {
        let payload: Value = match serde_json::from_slice(&body) {
            Ok(payload) => payload,
            Err(error) => return on_error(&ctx, &state, &error.to_string()),
        };
        if payload.get("type").and_then(Value::as_str) == Some("url_verification") {
            let mut out = Map::new();
            put(&mut out, "challenge", payload.get("challenge"));
            return answer(StatusCode::OK, Value::Object(out));
        }
        parse_slack_event(&payload)
    };
    if let Some((team, event)) = parsed {
        // `dispatchSlackEvent`: the team's workspace, then the triggers.
        let runs = execute_runs(&ctx, &state);
        let mapping = kv_json(&ctx, &state, &format!("slack_team:{team}")).await;
        match mapping {
            Ok(Some(mapping)) if crate::crm::mapper::truthy(Some(&mapping)) => {
                let workspace = text_of(mapping.get("workspaceId"));
                let integration = mapping
                    .get("integrationId")
                    .filter(|v| !v.is_null())
                    .map(|v| text_of(Some(v)));
                match ctx.tenant_db(&state, &workspace).await {
                    Ok(db) => dispatch_later(&state, runs, db, workspace, integration, event),
                    Err(error) => tracing::error!("[slack] dispatch failed: {error}"),
                }
            }
            Ok(_) => tracing::warn!("[slack] no workspace mapping for team {team}"),
            Err(error) => tracing::error!("[slack] dispatch failed: {error}"),
        }
    }
    StatusCode::OK.into_response()
}

/// `loadWorkflowConnection(env, connectionId)`: the workspace, its database
/// and the live `workflow_integrations` row.
async fn load_connection(
    ctx: &PublicCtx,
    state: &IntegrationsState,
    connection_id: &str,
) -> Result<Option<(String, PgPool, Value)>, String> {
    let Some(mapping) = kv_json(ctx, state, &format!("intconn:{connection_id}"))
        .await?
        .filter(|m| crate::crm::mapper::truthy(Some(m)))
    else {
        return Ok(None);
    };
    let workspace = text_of(mapping.get("workspaceId"));
    let db = ctx.tenant_db(state, &workspace).await?;
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from workflow_integrations t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(connection_id)
    .fetch_optional(&db)
    .await
    .map_err(|e| crate::crm::db_message(&e))?;
    Ok(row.map(|row| (workspace, db, row)))
}

/// `decryptConnectionCred(env, integration, field)`.
pub(crate) fn connection_credential(row: &Value, field: &str, keyring: &Keyring) -> Option<String> {
    let raw = row.get("credentials")?.get(field)?;
    if !crate::crm::mapper::truthy(Some(raw)) {
        return None;
    }
    let raw = js_string(&Js::from_jsonb(raw));
    Some(weldsuite_connect_domain::crypto::maybe_decrypt_field(
        &raw, keyring,
    ))
}

pub(crate) fn keyring_of(ctx: &PublicCtx, state: &IntegrationsState) -> Keyring {
    let key = |name: &str| ctx.env(state, name).filter(|v| !v.is_empty());
    Keyring {
        v1: key("DATABASE_ENCRYPTION_KEY"),
        v2: key("DATABASE_ENCRYPTION_KEY_V2"),
    }
}

/// `c.req.url` as the provider called it: the ingress's forwarded scheme and
/// host, else the `Host` header over HTTP.
fn request_url(headers: &HeaderMap, uri: &Uri) -> String {
    let first = |name: &str| {
        header(headers, name)
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let host = first("x-forwarded-host")
        .or_else(|| header(headers, "host"))
        .unwrap_or("localhost");
    let scheme = first("x-forwarded-proto").unwrap_or("http");
    let host = match (scheme, host.rsplit_once(':')) {
        ("http", Some((name, "80"))) | ("https", Some((name, "443"))) => name,
        _ => host,
    };
    let path = uri
        .path_and_query()
        .map_or("/", http::uri::PathAndQuery::as_str);
    format!("{scheme}://{}{path}", host.to_ascii_lowercase())
}

async fn twilio(
    State(state): State<IntegrationsState>,
    ctx: PublicCtx,
    Path(connection_id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (workspace, db, row) = match load_connection(&ctx, &state, &connection_id).await {
        Ok(Some(found)) => found,
        Ok(None) => {
            return answer(
                StatusCode::NOT_FOUND,
                json!({ "error": "unknown connection" }),
            );
        }
        Err(error) => return on_error(&ctx, &state, &error),
    };
    let token = connection_credential(&row, "authToken", &keyring_of(&ctx, &state));
    let params = form_params(&body);
    if !verify_twilio(
        token.as_deref(),
        &request_url(&headers, &uri),
        &params,
        header(&headers, "x-twilio-signature"),
    ) {
        return answer(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "invalid signature" }),
        );
    }
    if let Some(event) = parse_twilio_sms(&params) {
        let integration = row.get("id").and_then(Value::as_str).map(str::to_owned);
        dispatch_later(
            &state,
            execute_runs(&ctx, &state),
            db,
            workspace,
            integration,
            event,
        );
    }
    (
        StatusCode::OK,
        [(http::header::CONTENT_TYPE, "text/xml")],
        r#"<?xml version="1.0" encoding="UTF-8"?><Response></Response>"#,
    )
        .into_response()
}

async fn github(
    State(state): State<IntegrationsState>,
    ctx: PublicCtx,
    Path(connection_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let event_header = header(&headers, "x-github-event")
        .unwrap_or_default()
        .to_owned();
    if event_header == "ping" {
        return answer(StatusCode::OK, json!({ "ok": true }));
    }
    let (workspace, db, row) = match load_connection(&ctx, &state, &connection_id).await {
        Ok(Some(found)) => found,
        Ok(None) => {
            return answer(
                StatusCode::NOT_FOUND,
                json!({ "error": "unknown connection" }),
            );
        }
        Err(error) => return on_error(&ctx, &state, &error),
    };
    let secret = connection_credential(&row, "webhookSecret", &keyring_of(&ctx, &state));
    if !verify_github(
        secret.as_deref(),
        &body,
        header(&headers, "x-hub-signature-256"),
    ) {
        return answer(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "invalid signature" }),
        );
    }
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(error) => return on_error(&ctx, &state, &error.to_string()),
    };
    if let Some(event) = parse_github_event(&event_header, &payload) {
        let integration = row.get("id").and_then(Value::as_str).map(str::to_owned);
        dispatch_later(
            &state,
            execute_runs(&ctx, &state),
            db,
            workspace,
            integration,
            event,
        );
    }
    answer(StatusCode::OK, json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_compare_as_javascript_does() {
        let data = json!({ "text": "deploy now", "n": 2, "flag": null })
            .as_object()
            .cloned()
            .expect("object");
        let filters = json!([
            { "field": "text", "operator": "contains", "value": "deploy" },
            { "field": "n", "operator": "eq", "value": 2.0 },
            { "field": "flag", "operator": "not_exists" },
            { "field": "other", "operator": "weird" },
        ]);
        assert!(eval_filters(Some(&filters), &data));
        assert!(!eval_filters(
            Some(&json!([{ "field": "n", "operator": "eq", "value": "2" }])),
            &data
        ));
        assert!(eval_filters(None, &data));
    }

    #[test]
    fn slack_signatures_are_checked_within_five_minutes() {
        let body = b"payload";
        let sig = format!("v0={}", hex::encode(hmac_sha256("s", b"v0:1000:payload")));
        assert!(verify_slack(
            Some("s"),
            Some("1000"),
            body,
            Some(&sig),
            1100.0
        ));
        assert!(!verify_slack(
            Some("s"),
            Some("1000"),
            body,
            Some(&sig),
            1400.0
        ));
        assert!(!verify_slack(None, Some("1000"), body, Some(&sig), 1100.0));
    }

    #[test]
    fn twilio_signs_the_url_and_sorted_parameters() {
        use base64::Engine as _;
        use hmac::{KeyInit, Mac};
        let params = form_params(b"To=%2B2&From=%2B1&Body=hi");
        let mut mac = hmac::Hmac::<sha1::Sha1>::new_from_slice(b"tok").expect("key");
        mac.update(b"https://x.io/hookBodyhiFrom+1To+2");
        let sig = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        assert!(verify_twilio(
            Some("tok"),
            "https://x.io/hook",
            &params,
            Some(&sig)
        ));
        let event = parse_twilio_sms(&params).expect("sms");
        assert_eq!(
            Value::Object(event.data),
            json!({ "from": "+1", "to": "+2", "body": "hi" })
        );
    }

    #[test]
    fn github_and_slack_events_parse() {
        let issue = parse_github_event(
            "issues",
            &json!({ "action": "opened", "issue": { "number": 3, "title": "Bug" }, "repository": { "full_name": "a/b" } }),
        )
        .expect("issue");
        assert_eq!(
            Value::Object(issue.data),
            json!({ "action": "opened", "number": 3, "title": "Bug", "repository": "a/b" })
        );
        assert!(parse_github_event("push", &json!({})).is_none());
        let (team, message) = parse_slack_event(&json!({
            "type": "event_callback", "team_id": "T1",
            "event": { "type": "message", "channel": "C1", "user": "U1", "text": "hi", "ts": "1.2" }
        }))
        .expect("message");
        assert_eq!(team, "T1");
        assert_eq!(message.event, "slack.message");
        assert!(
            parse_slack_event(&json!({
                "type": "event_callback", "team_id": "T1",
                "event": { "type": "message", "bot_id": "B1" }
            }))
            .is_none()
        );
    }
}
