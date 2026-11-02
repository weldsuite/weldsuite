//! `/public/webhooks/telnyx` (`routes/webhooks-telnyx`): Telnyx's Call
//! Control and porting webhook, behind its Ed25519 signature
//! (`TELNYX_PUBLIC_KEY`, fail closed), and the AI assistant's `lookup_crm`
//! tool, behind the tool token.
//!
//! - Porting events move the workspace's order (found through the master
//!   porting index); a completed port becomes a live number.
//! - An inbound call without client state is routed by the dialled number
//!   (the master registry, then the number's desk route): the caller is
//!   matched in the CRM, the call lands in a WeldDesk phone conversation,
//!   and the call is forwarded, answered by a voice agent, or hung up.
//! - Other call events update the call (status, recording, AI summary,
//!   the live transcript) and settle its minutes from the prepaid wallet.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{DESK_CONVERSATION_UPDATED, DESK_MESSAGE_CREATED};
use weldsuite_db::PgPool;
use weldsuite_desk_domain::phone::{IngestPhone, ingest_desk_phone};
use weldsuite_desk_domain::realtime::{conversation_publish, now_ms};
use weldsuite_desk_domain::webchat::{Append, append_desk_message};
use weldsuite_events::{EntityEvent, EventContext, EventSource};

use crate::credits;
use crate::crm::{self, Hit};
use crate::desk_phone::{lookup_crm_tool, now_seconds, tool_url_for};
use crate::js::{self, Ordered};
use crate::registry::{self, Entry, normalize_e164};
use crate::telnyx::{
    AssistantStart, Telnyx, decode_client_state, encode_client_state, transfer_tool,
    verify_signature,
};
use crate::tool_auth::{self, Claims};
use crate::{CallState, PublicCtx, now};

fn answer(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn ok() -> Response {
    answer(StatusCode::OK, json!({ "ok": true }))
}

/// `GET /public/webhooks/telnyx`.
pub(crate) async fn health() -> Response {
    answer(
        StatusCode::OK,
        json!({ "status": "ok", "service": "telnyx-webhook" }),
    )
}

/// Everything a handler here needs: the request's databases and Telnyx.
struct Hook<'a> {
    state: &'a CallState,
    ctx: &'a PublicCtx,
    telnyx: Telnyx,
}

impl Hook<'_> {
    async fn tenant(&self, org: &str) -> Result<PgPool, String> {
        self.ctx.tenant(self.state, org).await
    }

    fn master(&self) -> Option<PgPool> {
        self.ctx.master(self.state)
    }

    /// `fanoutDeskPhoneMessage(…)`: the hub events (as the system), then
    /// the conversation room.
    async fn fanout(&self, org: &str, conversation: &Value, message: &Value, created: bool) {
        let context = EventContext::new(org, "system", EventSource::System);
        let conversation_id = conversation["id"].as_str().unwrap_or_default().to_owned();
        if created {
            let mut data = message.clone();
            data["conversationId"] = json!(conversation_id);
            self.state
                .events
                .publish_and_wait(
                    &context,
                    EntityEvent::new(
                        DESK_MESSAGE_CREATED,
                        message["id"].as_str().unwrap_or_default(),
                        data,
                    ),
                )
                .await;
        }
        self.state
            .events
            .publish_and_wait(
                &context,
                EntityEvent::new(
                    DESK_CONVERSATION_UPDATED,
                    &conversation_id,
                    conversation.clone(),
                ),
            )
            .await;
        let Some(realtime) = &self.state.realtime else {
            return;
        };
        let payload = json!({
            "type": "message",
            "id": message["id"],
            "content": message["body"].as_str().unwrap_or_default(),
            "senderId": message["authorId"].as_str().unwrap_or("system"),
            "senderType": message["authorType"],
            "kind": message["kind"],
            "ts": now_ms(),
        });
        if let Err(error) = realtime
            .publish_boxed(&conversation_publish(&conversation_id, payload))
            .await
        {
            tracing::error!(%error, "[desk-phone] realtime publish failed");
        }
    }
}

/// `appendDeskMessage(db, …)`: `(conversation, message)`.
async fn append(
    db: &PgPool,
    conversation_id: &str,
    kind: &str,
    author_type: &str,
    author_id: Option<&str>,
    body: String,
    metadata: Map<String, Value>,
) -> Result<(Value, Value), String> {
    append_desk_message(
        db,
        Append {
            conversation_id,
            kind,
            author_type,
            author_id,
            body: Some(body),
            attachments: None,
            metadata: Some(metadata),
            assignee_id: None,
        },
    )
    .await
    .map_err(|error| error.to_string())
}

fn meta(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

// ── the tool ────────────────────────────────────────────────────────────────

/// `pickLookupQuery(body)`.
fn pick_query(body: &Value) -> String {
    ["query", "phone", "email", "name"]
        .iter()
        .find_map(|key| body[*key].as_str().filter(|s| !s.is_empty()))
        .unwrap_or_default()
        .to_owned()
}

fn hit_summary(query: &str, hits: &[Hit]) -> String {
    if hits.is_empty() {
        let shown = if query.is_empty() { "unknown" } else { query };
        return format!("CRM lookup for “{shown}” returned no records");
    }
    let list = hits
        .iter()
        .map(|h| format!("{} ({})", h.name, h.kind))
        .collect::<Vec<_>>()
        .join(", ");
    format!("CRM lookup for “{query}”: {list}")
}

/// `POST /public/webhooks/telnyx/tools/:toolName`: the voice agent's
/// `lookup_crm` tool.
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
pub(crate) async fn tool(
    State(state): State<CallState>,
    ctx: PublicCtx,
    Path(tool): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(secret) = ctx.env("TELNYX_API_KEY") else {
        return answer(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": { "code": "NOT_CONFIGURED", "message": "Phone service is not activated" } }),
        );
    };
    let authorization = headers
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let Some(token) = tool_auth::bearer_token(authorization) else {
        return answer(
            StatusCode::UNAUTHORIZED,
            json!({ "error": { "code": "UNAUTHORIZED", "message": "Missing tool token" } }),
        );
    };
    let Some(claims) = tool_auth::verify(&secret, &token, now_seconds()) else {
        return answer(
            StatusCode::UNAUTHORIZED,
            json!({ "error": { "code": "UNAUTHORIZED", "message": "Invalid tool token" } }),
        );
    };
    if tool != "lookup_crm" {
        return answer(
            StatusCode::NOT_FOUND,
            json!({ "error": { "code": "NOT_FOUND", "message": format!("Unknown tool {tool}") } }),
        );
    }
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let parsed = if parsed.is_object() || parsed.is_array() {
        parsed
    } else {
        json!({})
    };
    let raw_query = pick_query(&parsed);
    let hook = Hook {
        state: &state,
        ctx: &ctx,
        telnyx: ctx.telnyx(&state),
    };
    let result = async {
        let db = hook.tenant(&claims.org).await?;
        let mut query = weldsuite_kit::validation::js_trim(&raw_query).to_owned();
        if query.is_empty()
            && let Some(call) = claims.call.as_deref().filter(|c| !c.is_empty())
        {
            let from: Option<String> =
                sqlx::query_scalar("select from_number from voip_calls where id = $1 limit 1")
                    .bind(call)
                    .fetch_optional(&db)
                    .await
                    .map_err(|e| e.to_string())?;
            query = from.unwrap_or_default();
        }
        let hits = if query.is_empty() {
            Vec::new()
        } else {
            crm::lookup(&db, &query, 5)
                .await
                .map_err(|e| e.to_string())?
        };
        let result = crm::for_assistant(&hits);
        if let Some(conversation) = claims.conv.as_deref().filter(|c| !c.is_empty()) {
            let mut metadata = Map::new();
            metadata.insert("event".to_owned(), json!("crm_lookup"));
            metadata.insert("query".to_owned(), json!(query));
            if let Some(call) = &claims.call {
                metadata.insert("callId".to_owned(), json!(call));
            }
            metadata.insert(
                "hits".to_owned(),
                json!(hits.iter().map(|h| h.id.clone()).collect::<Vec<_>>()),
            );
            match append(
                &db,
                conversation,
                "note",
                "bot",
                Some(&claims.aid),
                hit_summary(&query, &hits),
                metadata,
            )
            .await
            {
                Ok((conversation, message)) => {
                    hook.fanout(&claims.org, &conversation, &message, true)
                        .await;
                }
                Err(error) => {
                    tracing::error!(%error, "[Telnyx tool] Failed to append CRM lookup note");
                }
            }
        }
        Ok::<_, String>(result)
    }
    .await;
    let _ = &hook.telnyx;
    match result {
        Ok(result) => answer(StatusCode::OK, result),
        Err(error) => {
            tracing::error!(%error, "[Telnyx tool] lookup_crm failed");
            answer(
                StatusCode::OK,
                json!({ "matched": 0, "results": [], "message": "Lookup failed" }),
            )
        }
    }
}

// ── the webhook ─────────────────────────────────────────────────────────────

/// `POST /public/webhooks/telnyx`.
pub(crate) async fn receive(
    State(state): State<CallState>,
    ctx: PublicCtx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let text = String::from_utf8_lossy(&body);
    let raw = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let valid = match ctx.env("TELNYX_PUBLIC_KEY") {
        None => {
            tracing::error!("[Telnyx Webhook] TELNYX_PUBLIC_KEY not configured");
            false
        }
        Some(key) => verify_signature(
            &key,
            raw,
            header("telnyx-signature-ed25519"),
            header("telnyx-timestamp"),
            now_seconds(),
        ),
    };
    if !valid {
        return answer(
            StatusCode::UNAUTHORIZED,
            json!({ "error": { "code": "INVALID_SIGNATURE", "message": "Invalid signature" } }),
        );
    }
    let Ok(event) = serde_json::from_str::<Value>(raw) else {
        return answer(
            StatusCode::BAD_REQUEST,
            json!({ "error": { "code": "BAD_REQUEST", "message": "Invalid JSON" } }),
        );
    };
    let hook = Hook {
        state: &state,
        ctx: &ctx,
        telnyx: ctx.telnyx(&state),
    };
    match process(&hook, &event).await {
        Ok(()) => ok(),
        Err(error) => {
            tracing::error!(%error, "[Telnyx Webhook] Error processing webhook");
            answer(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Webhook processing failed" }),
            )
        }
    }
}

/// Everything after the signature and the JSON; `Err` where the worker's
/// handler throws (its 500).
async fn process(hook: &Hook<'_>, event: &Value) -> Result<(), String> {
    let data = event
        .get("data")
        .filter(|d| d.is_object())
        .ok_or("event.data is not an object")?;
    let event_type = data["event_type"]
        .as_str()
        .ok_or("event_type is not a string")?;
    let payload = &data["payload"];
    if event_type.starts_with("porting.order.") {
        if let Err(error) = porting_event(hook, payload).await {
            tracing::error!(%error, "[Telnyx Webhook] Porting handler threw");
        }
        return Ok(());
    }
    if payload.is_null() {
        return Err("payload is undefined".to_owned());
    }
    let client_state = decode_client_state(match &payload["client_state"] {
        Value::String(text) => Some(text.as_str()),
        _ => None,
    });
    let call_id = client_state.get("callId").cloned().unwrap_or(Value::Null);
    let workspace = client_state
        .get("workspaceId")
        .cloned()
        .unwrap_or(Value::Null);
    let missing = !js::truthy(&call_id) || !js::truthy(&workspace);
    let direction = match &payload["direction"] {
        Value::Null => String::new(),
        other => js::string(other).to_lowercase(),
    };
    if missing
        && event_type == "call.initiated"
        && matches!(direction.as_str(), "incoming" | "inbound")
    {
        if let Err(error) = inbound(hook, payload).await {
            tracing::error!(%error, "[Telnyx Webhook] Inbound handler threw");
        }
        return Ok(());
    }
    if missing {
        tracing::warn!(
            event_type,
            "[Telnyx Webhook] No callId/workspaceId in client_state"
        );
        return Ok(());
    }
    let call_id = js::string(&call_id);
    let workspace = js::string(&workspace);
    let db = hook.tenant(&workspace).await?;
    let call = CallEvent {
        hook,
        db,
        event: data,
        payload,
        client_state: &client_state,
        call_id: &call_id,
        workspace: &workspace,
        conversation: client_state
            .get("deskConversationId")
            .filter(|c| js::truthy(c))
            .map(js::string),
    };
    call.dispatch(event_type).await
}

// ── porting events ──────────────────────────────────────────────────────────

/// `handlePortingWebhook(env, eventType, payload)`.
async fn porting_event(hook: &Hook<'_>, payload: &Value) -> Result<(), String> {
    if payload.is_null() {
        return Err("Cannot read properties of undefined (reading 'id')".to_owned());
    }
    let order_id = payload["id"].clone();
    if !js::truthy(&order_id) {
        tracing::warn!("[Telnyx Webhook] Porting event without order id");
        return Ok(());
    }
    let order_id = js::string(&order_id);
    let master = hook.master().ok_or("no master database")?;
    let index: Option<(String, String)> = sqlx::query_as(
        "select clerk_org_id, draft_id from telnyx_porting_order_index
         where telnyx_porting_order_id = $1 limit 1",
    )
    .bind(&order_id)
    .fetch_optional(&master)
    .await
    .map_err(|e| e.to_string())?;
    let Some((org, draft_id)) = index else {
        return Ok(());
    };
    let status = payload["status"].as_str().unwrap_or_default();
    let sub_status = payload["sub_status"].clone();
    let messages: Vec<String> = payload["messages"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|m| js::or(&[&m["message"], &m["code"], &json!("")]).clone())
                .filter(js::truthy)
                .map(|m| js::string(&m))
                .collect()
        })
        .unwrap_or_default();
    match status {
        "ported" => porting_completed(hook, &master, &org, &draft_id, &order_id).await,
        "exception" => {
            let joined = messages.join("; ");
            let message = if !joined.is_empty() {
                joined
            } else if js::truthy(&sub_status) {
                js::string(&sub_status)
            } else {
                "Telnyx flagged an exception".to_owned()
            };
            porting_exception(hook, &org, &draft_id, &message).await
        }
        "cancelled" => {
            let db = hook.tenant(&org).await?;
            sqlx::query(
                "update voip_porting_orders set status = 'cancelled', updated_at = $2::timestamp where id = $1",
            )
            .bind(&draft_id)
            .bind(now())
            .execute(&db)
            .await
            .map_err(|e| e.to_string())?;
            sqlx::query(
                "delete from telnyx_porting_order_index where telnyx_porting_order_id = $1",
            )
            .bind(&order_id)
            .execute(&master)
            .await
            .map_err(|e| e.to_string())?;
            Ok(())
        }
        _ => {
            let db = hook.tenant(&org).await?;
            let foc = match &payload["actual_foc_date"] {
                value if js::truthy(value) => Some(
                    weldsuite_kit::validation::js_date_iso(&js::string(value))
                        .ok_or("Invalid time value")?,
                ),
                _ => None,
            };
            sqlx::query(
                "update voip_porting_orders set substatus = $2,
                     actual_foc_at = coalesce($3::timestamp, actual_foc_at),
                     status = case when $4 then 'in_process' else status end,
                     updated_at = $5::timestamp
                 where id = $1",
            )
            .bind(&draft_id)
            .bind(match &sub_status {
                Value::Null => None,
                other => Some(js::string(other)),
            })
            .bind(foc)
            .bind(status == "in-process")
            .bind(now())
            .execute(&db)
            .await
            .map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

/// One in-app notification, best effort (`insertNotification`).
struct Notice<'a> {
    user_id: &'a str,
    title: &'a str,
    body: String,
    entity_type: &'a str,
    entity_id: &'a str,
    action_url: String,
    severity: &'a str,
    notification_type: &'a str,
}

async fn notify(db: &PgPool, notice: Notice<'_>) {
    let inserted = sqlx::query(
        "insert into notifications (id, user_id, title, body, category, notification_type,
             entity_type, entity_id, action_url, icon, severity, is_read, delivered_in_app,
             delivered_email, delivered_push, created_at)
         values ($1, $2, $3, $4, 'system', $5, $6, $7, $8, 'phone', $9, false, true, false, false,
             $10::timestamptz)",
    )
    .bind(weldsuite_kit::generate_id("ntf"))
    .bind(notice.user_id)
    .bind(notice.title)
    .bind(&notice.body)
    .bind(notice.notification_type)
    .bind(notice.entity_type)
    .bind(notice.entity_id)
    .bind(&notice.action_url)
    .bind(notice.severity)
    .bind(now())
    .execute(db)
    .await;
    if let Err(error) = inserted {
        tracing::error!(%error, "[Porting] Failed to insert notification");
    }
}

/// `handlePortingCompleted(ctx)`: the ported number goes live.
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
async fn porting_completed(
    hook: &Hook<'_>,
    master: &PgPool,
    org: &str,
    draft_id: &str,
    order_id: &str,
) -> Result<(), String> {
    let db = hook.tenant(org).await?;
    let order = hook
        .telnyx
        .porting("GET", &format!("/porting_orders/{order_id}"), None, false)
        .await
        .map_err(|e| e.to_string())?
        .json();
    if !order["data"].is_object() {
        return Err("Cannot read properties of undefined (reading 'id')".to_owned());
    }
    let ported = order["data"]["phone_numbers"]
        .as_array()
        .and_then(|list| list.first())
        .cloned();
    let Some(ported) = ported.filter(js::truthy) else {
        sqlx::query(
            "update voip_porting_orders set last_error_code = 'completed_without_number',
                 last_error_message = 'Telnyx reported completion but returned no phone number',
                 updated_at = $2::timestamp
             where id = $1",
        )
        .bind(draft_id)
        .bind(now())
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
        return Ok(());
    };
    let draft: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from voip_porting_orders t where t.id = $1 limit 1")
            .bind(draft_id)
            .fetch_optional(&db)
            .await
            .map_err(|e| e.to_string())?;
    let Some(draft) = draft else {
        return Ok(());
    };
    if js::truthy(&draft["voip_phone_number_id"]) {
        return Ok(());
    }
    let phone = js::string(&draft["phone_number"]);
    let existing: Option<String> =
        sqlx::query_scalar("select id from voip_phone_numbers where phone_number = $1 limit 1")
            .bind(&phone)
            .fetch_optional(&db)
            .await
            .map_err(|e| e.to_string())?;
    let number_id = if let Some(id) = existing {
        id
    } else {
        let id = weldsuite_kit::generate_id("vpn");
        let now = now();
        sqlx::query(
            "insert into voip_phone_numbers (id, provider, phone_number, formatted_number, country_code,
                 number_type, provider_phone_number_id, provider_connection_id, status, is_default,
                 allow_inbound, allow_outbound, enable_recording, display_name, created_at, updated_at)
             values ($1, 'telnyx', $2, $3, $4, $5, $6, $7, 'active', false, true, true, true, $8,
                 $9::timestamp, $9::timestamp)",
        )
        .bind(&id)
        .bind(&phone)
        .bind(draft["formatted_number"].as_str().unwrap_or(&phone))
        .bind(draft["country_code"].as_str())
        .bind(draft["number_type"].as_str().unwrap_or("local"))
        .bind(ported["id"].as_str())
        .bind(hook.ctx.env("TELNYX_CONNECTION_ID"))
        .bind(draft["business_name"].as_str())
        .bind(&now)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
        id
    };
    sqlx::query(
        "update voip_porting_orders set status = 'completed', voip_phone_number_id = $2,
             last_error_code = null, last_error_message = null, updated_at = $3::timestamp
         where id = $1",
    )
    .bind(draft_id)
    .bind(&number_id)
    .bind(now())
    .execute(&db)
    .await
    .map_err(|e| e.to_string())?;
    let shown = draft["formatted_number"]
        .as_str()
        .unwrap_or(&phone)
        .to_owned();
    notify(
        &db,
        Notice {
            user_id: draft["created_by_user_id"].as_str().unwrap_or_default(),
            title: "Your number is now live",
            body: format!("{shown} has been ported into WeldSuite and is ready to use."),
            entity_type: "voip_phone_number",
            entity_id: &number_id,
            action_url: "/settings/apps/phone-numbers".to_owned(),
            severity: "success",
            notification_type: "system_update",
        },
    )
    .await;
    if let Err(error) = registry::upsert(
        Some(master),
        Entry {
            phone_number: &phone,
            clerk_org_id: org,
            voip_phone_number_id: &number_id,
            is_active: true,
        },
    )
    .await
    {
        tracing::error!(%error, "[porting] Failed to register phone for inbound routing");
    }
    sqlx::query("delete from telnyx_porting_order_index where telnyx_porting_order_id = $1")
        .bind(order_id)
        .execute(master)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `handlePortingException(ctx, message)`.
async fn porting_exception(
    hook: &Hook<'_>,
    org: &str,
    draft_id: &str,
    message: &str,
) -> Result<(), String> {
    let db = hook.tenant(org).await?;
    let draft: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from voip_porting_orders t where t.id = $1 limit 1")
            .bind(draft_id)
            .fetch_optional(&db)
            .await
            .map_err(|e| e.to_string())?;
    let Some(draft) = draft else {
        return Ok(());
    };
    sqlx::query(
        "update voip_porting_orders set status = 'exception', last_error_code = 'telnyx_exception',
             last_error_message = $2, updated_at = $3::timestamp
         where id = $1",
    )
    .bind(draft_id)
    .bind(message)
    .bind(now())
    .execute(&db)
    .await
    .map_err(|e| e.to_string())?;
    let shown = draft["formatted_number"]
        .as_str()
        .or_else(|| draft["phone_number"].as_str())
        .unwrap_or_default()
        .to_owned();
    let detail = if message.is_empty() {
        "no detail provided"
    } else {
        message
    };
    let id = js::string(&draft["id"]);
    notify(
        &db,
        Notice {
            user_id: draft["created_by_user_id"].as_str().unwrap_or_default(),
            title: "Port request needs attention",
            body: format!("Telnyx flagged a problem on the port for {shown}: {detail}."),
            entity_type: "voip_porting_order",
            entity_id: &id,
            action_url: format!("/settings/apps/phone-numbers/port/{id}"),
            severity: "warning",
            notification_type: "custom",
        },
    )
    .await;
    Ok(())
}

// ── inbound calls ───────────────────────────────────────────────────────────

/// `callerContextInstructions(args)`.
fn caller_instructions(system_prompt: &str, phone: &str, caller: &crm::Caller) -> String {
    let mut lines = vec![
        weldsuite_kit::validation::js_trim(system_prompt).to_owned(),
        String::new(),
        "## Live call context".to_owned(),
        format!("Caller phone: {phone}"),
    ];
    let present = |value: &Option<String>| {
        value
            .as_deref()
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    if let Some(name) = present(&caller.caller_name) {
        lines.push(format!("Matched name: {name}"));
    }
    if let Some(name) = present(&caller.customer_name) {
        lines.push(format!("Matched customer: {name}"));
    }
    if let Some(id) = present(&caller.contact_id) {
        lines.push(format!("Contact id: {id}"));
    }
    if let Some(id) = present(&caller.customer_id) {
        lines.push(format!("Customer id: {id}"));
    }
    lines.push("Greet the caller by name when a match is present. Use the lookup_crm tool to search CRM if they mention another person or company, or if no match is listed above. Do not invent account details that the tool did not return. If they need a human, transfer them.".to_owned());
    lines.join("\n")
}

/// A number the call came in on: `(id, assignedUserId, allowInbound,
/// enableRecording)`.
type PhoneRow = (String, Option<String>, Option<bool>, Option<bool>);

/// A voice agent: `(id, name, systemPrompt, enabled, telnyxAssistantId,
/// forwardToE164)`.
type AgentRow = (String, String, String, bool, Option<String>, Option<String>);

/// What an inbound call's route works with.
struct Inbound<'a> {
    hook: &'a Hook<'a>,
    db: PgPool,
    call_control_id: String,
    call_id: String,
    workspace: String,
    conversation: String,
    client_state: String,
    to_number: String,
    from_number: String,
    caller: crm::Caller,
    record: bool,
}

/// `handleInboundInitiated(env, payload)`.
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
async fn inbound(hook: &Hook<'_>, payload: &Value) -> Result<(), String> {
    let call_control_id = payload["call_control_id"].clone();
    let to_raw = js::or(&[&payload["to"], &payload["callee"], &json!("")]).clone();
    let from_raw = js::or(&[&payload["from"], &payload["caller_id_number"], &json!("")]).clone();
    if !js::truthy(&call_control_id) || !js::truthy(&to_raw) {
        tracing::warn!("[Telnyx Webhook] Inbound initiated missing call_control_id or to");
        return Ok(());
    }
    let call_control_id = js::string(&call_control_id);
    let to_number = normalize_e164(&js::string(&to_raw));
    let from_number = normalize_e164(&if js::truthy(&from_raw) {
        js::string(&from_raw)
    } else {
        "unknown".to_owned()
    });
    let master = hook.master().ok_or("no master database")?;
    let Some((workspace, number_id)) = registry::lookup(&master, &to_number)
        .await
        .map_err(|e| e.to_string())?
    else {
        tracing::warn!(%to_number, "[Telnyx Webhook] No phone registry entry, hanging up");
        if let Err(error) = hook.telnyx.hangup(&call_control_id, None).await {
            tracing::error!(%error, "[Telnyx Webhook] Hangup after missing registry failed");
        }
        return Ok(());
    };
    let db = hook.tenant(&workspace).await?;
    let phone: Option<PhoneRow> = sqlx::query_as(
        "select id, assigned_user_id, allow_inbound, enable_recording from voip_phone_numbers
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(&number_id)
    .fetch_optional(&db)
    .await
    .map_err(|e| e.to_string())?;
    let Some((phone_id, assigned, allow_inbound, recording)) =
        phone.filter(|(_, _, allow, _)| *allow != Some(false))
    else {
        tracing::warn!(%to_number, "[Telnyx Webhook] Inbound not allowed");
        hook.telnyx
            .hangup(&call_control_id, None)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    };
    let _ = allow_inbound;
    let route: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select action, voice_agent_id, forward_to_e164 from desk_phone_routes
         where voip_phone_number_id = $1 limit 1",
    )
    .bind(&phone_id)
    .fetch_optional(&db)
    .await
    .map_err(|e| e.to_string())?;
    let call_id = weldsuite_kit::generate_id("vcall");
    let now = now();
    let caller = match crm::match_caller(&db, &from_number).await {
        Ok(caller) => caller,
        Err(error) => {
            tracing::error!(%error, "[Telnyx Webhook] CRM caller match failed");
            crm::Caller::default()
        }
    };
    let desk = ingest_desk_phone(
        &db,
        IngestPhone {
            from_number: &from_number,
            to_number: &to_number,
            call_id: &call_id,
            call_control_id: Some(&call_control_id),
            name: caller.caller_name.as_deref(),
            contact_id: caller.contact_id.as_deref(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    let conversation_id = js::string(&desk.conversation["id"]);
    // syncConversationCaller
    if let Some(contact) = caller.contact_id.as_deref() {
        let linked = js::truthy(&desk.conversation["contactId"])
            && desk.conversation["name"].as_str() == caller.caller_name.as_deref();
        if !linked {
            sqlx::query(
                "update desk_conversations set contact_id = $2, name = $3, email = $4,
                     updated_at = $5::timestamp
                 where id = $1",
            )
            .bind(&conversation_id)
            .bind(contact)
            .bind(
                caller
                    .caller_name
                    .clone()
                    .or_else(|| desk.conversation["name"].as_str().map(str::to_owned)),
            )
            .bind(
                caller
                    .email
                    .clone()
                    .or_else(|| desk.conversation["email"].as_str().map(str::to_owned)),
            )
            .bind(&now)
            .execute(&db)
            .await
            .map_err(|e| e.to_string())?;
        }
    }
    // The caller's message may start an SLA clock: tell desk-api's SLA sweep
    // (best effort). The registry has the Clerk org id; the due index is
    // keyed by `workspaces.id`.
    if let Some(at) = desk
        .sla_check_at
        .and_then(weldsuite_desk_domain::sla::instant)
    {
        match crate::credits::resolve_workspace(&master, &workspace).await {
            Ok(Some(workspace_id)) => {
                weldsuite_db::due_index::mark_due(
                    &master,
                    weldsuite_desk_domain::sla::DUE_KIND,
                    &workspace_id,
                    at,
                )
                .await;
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "[Telnyx Webhook] desk SLA due mark failed"),
        }
    }
    let record = recording != Some(false);
    sqlx::query(
        "insert into voip_calls (id, created_at, updated_at, user_id, provider, provider_call_id,
             provider_session_id, provider_leg_id, direction, status, from_number, to_number,
             from_number_formatted, to_number_formatted, initiated_at, desk_conversation_id,
             is_recorded, customer_id, contact_id)
         values ($1, $2::timestamp, $2::timestamp, $3, 'telnyx', $4, $5, $6, 'inbound', 'initiated',
             $7, $8, $7, $8, $2::timestamp, $9, $10, $11, $12)",
    )
    .bind(&call_id)
    .bind(&now)
    .bind(
        assigned
            .filter(|a| !a.is_empty())
            .unwrap_or_else(|| "system".to_owned()),
    )
    .bind(&call_control_id)
    .bind(text_of(&payload["call_session_id"]))
    .bind(text_of(&payload["call_leg_id"]))
    .bind(&from_number)
    .bind(&to_number)
    .bind(&conversation_id)
    .bind(recording.unwrap_or(true))
    .bind(&caller.customer_id)
    .bind(&caller.contact_id)
    .execute(&db)
    .await
    .map_err(|e| e.to_string())?;
    let (action, voice_agent, forward) = route
        .clone()
        .map_or((None, None, None), |(a, v, f)| (Some(a), v, f));
    let mut state_json = Ordered::new()
        .with("callId", call_id.as_str())
        .with("workspaceId", workspace.as_str())
        .with("deskConversationId", conversation_id.as_str())
        .with("record", if record { "true" } else { "false" });
    if let Some(agent) = voice_agent.as_deref().filter(|a| !a.is_empty()) {
        state_json = state_json.with("voiceAgentId", agent);
    }
    let inbound = Inbound {
        hook,
        db,
        call_control_id,
        call_id,
        workspace,
        conversation: conversation_id,
        client_state: encode_client_state(&state_json),
        to_number,
        from_number,
        caller,
        record,
    };
    let action = action.unwrap_or_else(|| "hangup".to_owned());
    let executed = if action == "forward"
        && let Some(forward) = forward.as_deref().filter(|f| !f.is_empty())
    {
        inbound.forward(forward).await
    } else if action == "ai_agent"
        && let Some(agent) = voice_agent.as_deref().filter(|a| !a.is_empty())
    {
        inbound.ai_agent(agent).await
    } else {
        inbound.hangup_without_route().await
    };
    if let Err(error) = executed {
        tracing::error!(%error, "[Telnyx Webhook] Inbound route execution failed");
        let _ = inbound
            .hook
            .telnyx
            .hangup(&inbound.call_control_id, Some(&inbound.client_state))
            .await;
    }
    Ok(())
}

/// `value ?? null` for a text column.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        other => Some(js::string(other)),
    }
}

impl Inbound<'_> {
    /// `forwardInboundCall(ctx, forwardToE164)`.
    async fn forward(&self, to: &str) -> Result<(), String> {
        self.hook
            .telnyx
            .transfer(
                &self.call_control_id,
                to,
                Some(&self.client_state),
                Some(&self.to_number),
            )
            .await
            .map_err(|e| e.to_string())?;
        append(
            &self.db,
            &self.conversation,
            "message",
            "system",
            None,
            format!("Forwarding call to {to}"),
            meta(json!({ "event": "call_forwarded", "forwardToE164": to, "callId": self.call_id })),
        )
        .await?;
        Ok(())
    }

    /// `hangupCallWithoutRoute(ctx)`.
    async fn hangup_without_route(&self) -> Result<(), String> {
        self.hook
            .telnyx
            .hangup(&self.call_control_id, Some(&self.client_state))
            .await
            .map_err(|e| e.to_string())?;
        append(
            &self.db,
            &self.conversation,
            "message",
            "system",
            None,
            "Call ended (no inbound route configured)".to_owned(),
            meta(json!({ "event": "call_hangup_no_route", "callId": self.call_id })),
        )
        .await?;
        Ok(())
    }

    /// `answerWithAiAgent(ctx, voiceAgentId)`.
    #[allow(clippy::too_many_lines)] // the TypeScript function, step by step
    async fn ai_agent(&self, agent_id: &str) -> Result<(), String> {
        let agent: Option<AgentRow> = sqlx::query_as(
            "select id, name, system_prompt, enabled, telnyx_assistant_id, forward_to_e164
             from desk_voice_agents where id = $1 and deleted_at is null limit 1",
        )
        .bind(agent_id)
        .fetch_optional(&self.db)
        .await
        .map_err(|e| e.to_string())?;
        let Some((id, name, system_prompt, _, Some(assistant), forward)) =
            agent.filter(|(_, _, _, enabled, assistant, _)| {
                *enabled && assistant.as_deref().is_some_and(|a| !a.is_empty())
            })
        else {
            tracing::warn!(agent_id, "[Telnyx Webhook] Voice agent unavailable, hangup");
            self.hook
                .telnyx
                .hangup(&self.call_control_id, Some(&self.client_state))
                .await
                .map_err(|e| e.to_string())?;
            return Ok(());
        };
        let tools = self.hook.telnyx.api_key().map(|key| {
            let token = tool_auth::sign(
                key,
                &Claims {
                    org: self.workspace.clone(),
                    aid: id.clone(),
                    call: Some(self.call_id.clone()),
                    conv: Some(self.conversation.clone()),
                },
                now_seconds(),
            );
            let url = tool_url_for(self.hook.ctx.env.as_ref());
            let mut tools = vec![
                json!({ "type": "hangup" }),
                lookup_crm_tool(&url, &format!("Bearer {token}")),
            ];
            if let Some(forward) = forward.as_deref().filter(|f| !f.is_empty()) {
                tools.push(transfer_tool(forward));
            }
            tools
        });
        let mut variables = Map::new();
        variables.insert("caller_phone".to_owned(), json!(self.from_number));
        if let Some(name) = self.caller.caller_name.as_deref().filter(|n| !n.is_empty()) {
            variables.insert("caller_name".to_owned(), json!(name));
        }
        if let Some(name) = self
            .caller
            .customer_name
            .as_deref()
            .filter(|n| !n.is_empty())
        {
            variables.insert("customer_name".to_owned(), json!(name));
        }
        self.hook
            .telnyx
            .answer(&self.call_control_id, Some(&self.client_state))
            .await
            .map_err(|e| e.to_string())?;
        self.hook
            .telnyx
            .ai_assistant_start(
                &self.call_control_id,
                &assistant,
                AssistantStart {
                    client_state: self.client_state.clone(),
                    instructions: caller_instructions(
                        &system_prompt,
                        &self.from_number,
                        &self.caller,
                    ),
                    tools,
                    dynamic_variables: Some(variables),
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        if self.record
            && let Err(error) = self.hook.telnyx.record_start(&self.call_control_id).await
        {
            tracing::error!(%error, "[Telnyx Webhook] record_start failed");
        }
        let body = match self.caller.caller_name.as_deref().filter(|n| !n.is_empty()) {
            Some(matched) => format!("AI agent “{name}” answered the call (matched {matched})"),
            None => format!("AI agent “{name}” answered the call"),
        };
        let (conversation, message) = append(
            &self.db,
            &self.conversation,
            "message",
            "bot",
            Some(&id),
            body,
            meta(json!({
                "event": "ai_answered",
                "voiceAgentId": id,
                "callId": self.call_id,
                "contactId": self.caller.contact_id,
                "customerId": self.caller.customer_id,
            })),
        )
        .await?;
        self.hook
            .fanout(&self.workspace, &conversation, &message, true)
            .await;
        Ok(())
    }
}

// ── call events ─────────────────────────────────────────────────────────────

/// `CallEventContext`.
struct CallEvent<'a> {
    hook: &'a Hook<'a>,
    db: PgPool,
    event: &'a Value,
    payload: &'a Value,
    client_state: &'a Map<String, Value>,
    call_id: &'a str,
    workspace: &'a str,
    conversation: Option<String>,
}

/// `hangup_cause` → the call's final status (`mapHangupCause`).
fn final_status(cause: &str) -> &'static str {
    match cause {
        "originator_cancel" => "canceled",
        "timeout" | "no_user_response" | "no_answer" => "no_answer",
        "busy" | "user_busy" => "busy",
        "call_rejected" | "unallocated_number" => "failed",
        _ => "completed",
    }
}

/// `new Date(value)` of an event field, as Drizzle writes it; `Err` where
/// `toISOString()` throws.
fn event_date(value: &Value) -> Result<String, String> {
    let text = match value {
        Value::Null => return Err("Invalid time value".to_owned()),
        other => js::string(other),
    };
    weldsuite_kit::validation::js_date_iso(&text).ok_or_else(|| "Invalid time value".to_owned())
}

/// Milliseconds since the epoch of a date the event carries.
fn epoch_ms(value: &Value) -> Option<f64> {
    let iso = event_date(value).ok()?;
    let parsed =
        time::OffsetDateTime::parse(&iso, &time::format_description::well_known::Rfc3339).ok()?;
    #[allow(clippy::cast_precision_loss)]
    Some((parsed.unix_timestamp_nanos() / 1_000_000) as f64)
}

impl CallEvent<'_> {
    async fn dispatch(&self, event_type: &str) -> Result<(), String> {
        match event_type {
            "call.initiated" => self.initiated().await,
            "call.answered" => self.answered().await,
            "call.bridged" => self.set_status("bridged").await,
            "call.hangup" => self.hangup().await,
            "call.recording.saved" => self.recording_saved().await,
            "call.ai_gather.message_history_updated" | "call.conversation.ended" => {
                self.transcript().await;
                Ok(())
            }
            "call.conversation_insights.generated" => self.insights().await,
            _ => {
                tracing::info!(event_type, "[Telnyx Webhook] Unhandled event");
                Ok(())
            }
        }
    }

    fn present(&self, key: &str) -> (bool, Option<String>) {
        match self.payload.get(key) {
            None => (false, None),
            Some(value) => (true, text_of(value)),
        }
    }

    async fn initiated(&self) -> Result<(), String> {
        let (has_control, control) = self.present("call_control_id");
        let (has_session, session) = self.present("call_session_id");
        let (has_leg, leg) = self.present("call_leg_id");
        sqlx::query(
            "update voip_calls set
                 provider_call_id = case when $2 then $3 else provider_call_id end,
                 provider_session_id = case when $4 then $5 else provider_session_id end,
                 provider_leg_id = case when $6 then $7 else provider_leg_id end,
                 status = 'initiated', updated_at = $8::timestamp
             where id = $1",
        )
        .bind(self.call_id)
        .bind(has_control)
        .bind(control)
        .bind(has_session)
        .bind(session)
        .bind(has_leg)
        .bind(leg)
        .bind(now())
        .execute(&self.db)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn answered(&self) -> Result<(), String> {
        let answered_at = event_date(&self.event["occurred_at"])?;
        sqlx::query(
            "update voip_calls set status = 'answered', answered_at = $2::timestamp,
                 updated_at = $3::timestamp
             where id = $1",
        )
        .bind(self.call_id)
        .bind(answered_at)
        .bind(now())
        .execute(&self.db)
        .await
        .map_err(|e| e.to_string())?;
        let control = &self.payload["call_control_id"];
        if self.client_state.get("record") == Some(&json!("true"))
            && js::truthy(control)
            && self.hook.telnyx.configured()
            && let Err(error) = self.hook.telnyx.record_start(&js::string(control)).await
        {
            tracing::error!(%error, "[Telnyx Webhook] Recording start error");
        }
        Ok(())
    }

    async fn set_status(&self, status: &str) -> Result<(), String> {
        sqlx::query("update voip_calls set status = $2, updated_at = $3::timestamp where id = $1")
            .bind(self.call_id)
            .bind(status)
            .bind(now())
            .execute(&self.db)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// `appendDeskCallEvent(…)`: a system line on the call's conversation,
    /// best effort, without fan-out.
    async fn desk_event(&self, body: String, metadata: Value) {
        let Some(conversation) = &self.conversation else {
            return;
        };
        let appended = async {
            let db = self.hook.tenant(self.workspace).await?;
            append(
                &db,
                conversation,
                "message",
                "system",
                None,
                body,
                meta(metadata),
            )
            .await
        }
        .await;
        if let Err(error) = appended {
            tracing::error!(%error, "[Telnyx Webhook] Failed to append desk call event");
        }
    }

    async fn hangup(&self) -> Result<(), String> {
        let cause = if js::truthy(&self.payload["hangup_cause"]) {
            js::string(&self.payload["hangup_cause"])
        } else {
            "normal_clearing".to_owned()
        };
        let source = if js::truthy(&self.payload["hangup_source"]) {
            js::string(&self.payload["hangup_source"])
        } else {
            String::new()
        };
        let sip = &self.payload["sip_hangup_cause"];
        let duration: Option<f64> =
            if js::truthy(&self.payload["start_time"]) && js::truthy(&self.payload["end_time"]) {
                match (
                    epoch_ms(&self.payload["start_time"]),
                    epoch_ms(&self.payload["end_time"]),
                ) {
                    (Some(start), Some(end)) => Some(((end - start) / 1000.0 + 0.5).floor()),
                    _ => return Err("duration is NaN".to_owned()),
                }
            } else {
                None
            };
        let status = final_status(&cause);
        let ended_at = event_date(&self.event["occurred_at"])?;
        let stored_cause = if js::truthy(sip) {
            format!("SIP {} - {cause}", js::string(sip))
        } else {
            cause.clone()
        };
        #[allow(clippy::cast_possible_truncation)]
        let seconds = duration.map(|d| d as i64);
        sqlx::query(
            "update voip_calls set status = $2, ended_at = $3::timestamp,
                 duration = case when $4 then $5::int else duration end,
                 hangup_cause = $6, hangup_source = $7, updated_at = $8::timestamp
             where id = $1",
        )
        .bind(self.call_id)
        .bind(status)
        .bind(&ended_at)
        .bind(seconds.is_some())
        .bind(seconds)
        .bind(&stored_cause)
        .bind(&source)
        .bind(now())
        .execute(&self.db)
        .await
        .map_err(|e| e.to_string())?;
        let body = match seconds.filter(|s| *s != 0) {
            Some(seconds) => format!("Call ended ({status}, {seconds}s)"),
            None => format!("Call ended ({status})"),
        };
        let mut metadata =
            json!({ "event": "call_ended", "callId": self.call_id, "hangupCause": cause });
        if let Some(seconds) = seconds {
            metadata["duration"] = json!(seconds);
        }
        self.desk_event(body, metadata).await;
        if let Some(seconds) = seconds.filter(|s| *s > 0) {
            self.settle(seconds, &cause).await;
        }
        Ok(())
    }

    /// `settleCallCredits(ctx, duration, hangupCause)`, best effort.
    async fn settle(&self, seconds: i64, cause: &str) {
        let settled = async {
            let master = self.hook.master().ok_or("no master database")?;
            let Some(workspace) = credits::resolve_workspace(&master, self.workspace)
                .await
                .map_err(|e| e.to_string())?
            else {
                return Ok(());
            };
            let (cost, transaction) = credits::settle_call(
                &master,
                &workspace,
                self.call_id,
                seconds,
                ("hangupCause", json!(cause)),
                None,
            )
            .await?;
            sqlx::query(
                "update voip_calls set credits_consumed = $2, credit_transaction_id = $3,
                     updated_at = $4::timestamp
                 where id = $1",
            )
            .bind(self.call_id)
            .bind(i32::try_from(cost).unwrap_or(i32::MAX))
            .bind(&transaction)
            .bind(now())
            .execute(&self.db)
            .await
            .map_err(|e| e.to_string())?;
            Ok::<_, String>(())
        }
        .await;
        if let Err(error) = settled {
            tracing::error!(%error, "[Telnyx Webhook] credit settlement FAILED (untracked call!)");
        }
    }

    async fn recording_saved(&self) -> Result<(), String> {
        let url = &self.payload["recording_urls"]["mp3"];
        if !js::truthy(url) {
            return Ok(());
        }
        let duration = &self.payload["duration_secs"];
        #[allow(clippy::cast_possible_truncation)]
        let seconds = if js::truthy(duration) {
            let value = duration
                .as_f64()
                .unwrap_or_else(|| weldsuite_kit::validation::js_number(&js::string(duration)));
            Some((value + 0.5).floor() as i64)
        } else {
            None
        };
        let key = if js::truthy(&self.payload["recording_id"]) {
            Some(js::string(&self.payload["recording_id"]))
        } else {
            None
        };
        sqlx::query(
            "update voip_calls set is_recorded = true, recording_storage_url = $2,
                 recording_storage_key = $3,
                 recording_duration = case when $4 then $5::int else recording_duration end,
                 updated_at = $6::timestamp
             where id = $1",
        )
        .bind(self.call_id)
        .bind(js::string(url))
        .bind(key)
        .bind(seconds.is_some())
        .bind(seconds)
        .bind(now())
        .execute(&self.db)
        .await
        .map_err(|e| e.to_string())?;
        self.desk_event(
            "Call recording available".to_owned(),
            json!({ "event": "recording_saved", "callId": self.call_id, "recordingUrl": url }),
        )
        .await;
        Ok(())
    }

    async fn insights(&self) -> Result<(), String> {
        let summary = js::or(&[
            &self.payload["conversation_insights"]["summary"],
            &self.payload["summary"],
            &Value::Null,
        ])
        .clone();
        if !js::truthy(&summary) {
            return Ok(());
        }
        let text = match &summary {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        sqlx::query(
            "update voip_calls set ai_summary = $2, ai_analyzed_at = $3::timestamp,
                 updated_at = $3::timestamp
             where id = $1",
        )
        .bind(self.call_id)
        .bind(&text)
        .bind(now())
        .execute(&self.db)
        .await
        .map_err(|e| e.to_string())?;
        let body = match &summary {
            Value::String(text) => text.clone(),
            _ => "AI call summary generated".to_owned(),
        };
        self.desk_event(
            body,
            json!({ "event": "ai_summary", "callId": self.call_id }),
        )
        .await;
        Ok(())
    }

    /// `handleTranscriptEvent(ctx)`: the AI conversation's turns into the
    /// desk conversation, best effort.
    async fn transcript(&self) {
        let Some(conversation) = self.conversation.clone() else {
            return;
        };
        if let Err(error) = self.sync_transcript(&conversation).await {
            tracing::error!(%error, "[Telnyx Webhook] Live transcript sync failed");
        }
    }

    /// `syncLiveTranscript(args)` with `syncAiTalkTranscript`.
    #[allow(clippy::too_many_lines)] // the TypeScript function, step by step
    async fn sync_transcript(&self, conversation_id: &str) -> Result<(), String> {
        let history = message_history(self.payload);
        if history.is_empty() {
            return Ok(());
        }
        let Some((conversation, messages)) =
            weldsuite_desk_domain::webchat::get(&self.db, conversation_id, true)
                .await
                .map_err(|e| e.to_string())?
        else {
            return Ok(());
        };
        let voice_agent = self
            .client_state
            .get("voiceAgentId")
            .filter(|v| !v.is_null())
            .map(js::string);
        let visitor = conversation["visitorId"].as_str().map(str::to_owned);
        let existing: Vec<(i64, Value)> = messages
            .into_iter()
            .filter_map(|message| {
                let meta = &message["metadata"];
                if meta["event"] != "ai_transcript" || meta["callId"] != self.call_id {
                    return None;
                }
                let index = meta["turnIndex"].as_f64()?;
                #[allow(clippy::cast_possible_truncation)]
                Some((index as i64, message))
            })
            .collect();
        // A later message with the same turn wins, as `Map#set` does.
        let previous = |index: i64| {
            existing
                .iter()
                .rev()
                .find(|(i, _)| *i == index)
                .map(|(_, m)| m)
        };
        let mut appended = Vec::new();
        let mut updated = Vec::new();
        for (index, item) in history.iter().enumerate() {
            let body = turn_content(item);
            if body.is_empty() {
                continue;
            }
            let role = if js::truthy(&item["role"]) {
                js::string(&item["role"])
            } else {
                "assistant".to_owned()
            };
            let index = i64::try_from(index).unwrap_or(i64::MAX);
            match previous(index) {
                None => {
                    let lower = role.to_lowercase();
                    let (author_type, kind) = match lower.as_str() {
                        "user" | "customer" | "caller" => ("visitor", "message"),
                        "tool" | "function" => ("bot", "note"),
                        _ => ("bot", "message"),
                    };
                    let author = if author_type == "visitor" {
                        visitor.clone()
                    } else {
                        voice_agent.clone()
                    };
                    let (_, message) = append(
                        &self.db,
                        conversation_id,
                        kind,
                        author_type,
                        author.as_deref(),
                        body,
                        meta(json!({
                            "event": "ai_transcript",
                            "callId": self.call_id,
                            "turnIndex": index,
                            "role": role,
                        })),
                    )
                    .await?;
                    appended.push(message);
                }
                Some(previous) if previous["body"].as_str() != Some(body.as_str()) => {
                    let row: Option<Value> = sqlx::query_scalar(
                        "update desk_messages set body = $2 where id = $1 returning to_jsonb(desk_messages)",
                    )
                    .bind(previous["id"].as_str().unwrap_or_default())
                    .bind(&body)
                    .fetch_optional(&self.db)
                    .await
                    .map_err(|e| e.to_string())?;
                    if let Some(row) = row {
                        updated.push(weldsuite_desk_domain::webchat::DESK_MESSAGES.js(row));
                    }
                }
                Some(_) => {}
            }
        }
        for message in &appended {
            self.hook
                .fanout(self.workspace, &conversation, message, true)
                .await;
        }
        for message in &updated {
            self.hook
                .fanout(self.workspace, &conversation, message, false)
                .await;
        }
        Ok(())
    }
}

/// `parseMessageHistory(payload)`.
fn message_history(payload: &Value) -> Vec<Value> {
    let raw = ["message_history", "messages", "history"]
        .iter()
        .map(|key| &payload[*key])
        .find(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| {
            if payload["conversation"].is_object() {
                payload["conversation"]["messages"].clone()
            } else {
                Value::Null
            }
        });
    raw.as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| item.is_object() || item.is_array())
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// `turnContent(item)`.
fn turn_content(item: &Value) -> String {
    let content = &item["content"];
    match content {
        Value::String(text) => weldsuite_kit::validation::js_trim(text).to_owned(),
        Value::Array(parts) => {
            let joined = parts
                .iter()
                .map(|part| match part {
                    Value::String(text) => text.clone(),
                    Value::Object(fields) if fields.contains_key("text") => match &fields["text"] {
                        Value::Null => String::new(),
                        text => crate::numbers::as_text(text),
                    },
                    _ => String::new(),
                })
                .collect::<Vec<_>>()
                .join(" ");
            weldsuite_kit::validation::js_trim(&joined).to_owned()
        }
        Value::Object(fields) => {
            if let Some(text) = fields.get("text").and_then(Value::as_str) {
                return weldsuite_kit::validation::js_trim(text).to_owned();
            }
            if let Some(text) = fields.get("transcript").and_then(Value::as_str) {
                return weldsuite_kit::validation::js_trim(text).to_owned();
            }
            String::new()
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_turns_read_like_the_worker() {
        assert_eq!(turn_content(&json!({ "content": "  hi " })), "hi");
        assert_eq!(
            turn_content(&json!({ "content": ["a", { "text": "b" }, 3] })),
            "a b"
        );
        assert_eq!(
            turn_content(&json!({ "content": { "transcript": " t " } })),
            "t"
        );
        assert_eq!(turn_content(&json!({ "role": "user" })), "");
        assert_eq!(
            message_history(
                &json!({ "conversation": { "messages": [{ "role": "user" }, null, 1] } })
            )
            .len(),
            1
        );
        assert_eq!(final_status("user_busy"), "busy");
        assert_eq!(final_status("whatever"), "completed");
    }
}
