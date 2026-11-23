//! `/public/webhooks/telnyx` (`routes/webhooks-telnyx`): Telnyx's Call
//! Control and porting webhook, behind its Ed25519 signature
//! (`TELNYX_PUBLIC_KEY`, fail closed), and the AI assistant's `lookup_crm`
//! tool, behind the tool token.
//!
//! - Porting events move the workspace's order (found through the master
//!   porting index); a completed port becomes a live number.
//! - An event of a leg the server dialled to ring an agent's browser (its
//!   client state has `agentLegId` and no `callId`) goes to
//!   `desk_phone_legs`.
//! - An inbound call without client state is routed by the dialled number
//!   (the master registry, then the number's desk route): the caller is
//!   matched in the CRM, the call lands in a WeldDesk phone conversation,
//!   and the route runs (`desk_phone_inbound`): forwarded, answered by a
//!   voice agent, offered to the team, sent to voicemail or a keypad menu,
//!   or hung up. A call a customer's own phone system sends over its trunk
//!   counts whatever its direction says, and a number of a trunk only takes
//!   calls on that trunk's connection (`sip_trunk_inbound`).
//! - Other call events update the call (status, recording, AI summary,
//!   the live transcript), move it through the phone queue (the menu's
//!   choice, the queue's timeout, the voicemail, the caller leaving) and
//!   settle its minutes from the prepaid wallet.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_desk_domain::phone::{IngestPhone, ingest_desk_phone};
use weldsuite_schema::master::telnyx_porting_order_index as porting_index;
use weldsuite_schema::tenant::{
    desk_conversations, desk_messages, desk_phone_routes, notifications, voip_calls,
    voip_phone_numbers as voip_numbers, voip_porting_orders as porting_orders,
};

use crate::credits;
use crate::crm::{self, Hit};
use crate::desk_phone::now_seconds;
use crate::desk_phone_inbound::{
    InboundCall, Route, execute_route, handle_gather_ended, match_caller_safe,
};
use crate::desk_phone_legs::{handle_agent_leg_event, handle_caller_left_queue};
use crate::desk_phone_messages::{self, append, meta};
use crate::desk_phone_queue::{
    CallEventInput, Flow, handle_dequeued, handle_speak_ended, handle_voicemail_saved,
};
use crate::desk_phone_ring::{Phone, ring_waiting_calls};
use crate::js::{self, Ordered};
use crate::registry::{self, Entry, normalize_e164};
use crate::sip_trunk_inbound::{
    Admission, admit_trunk_call, admit_trunk_call_to_hosted_number, is_trunk_call,
    owns_trunk_connection, record_trunk_inbound,
};
use crate::sip_trunk_number::dialed_number_of;
use crate::telnyx::{Telnyx, decode_client_state, encode_client_state, verify_signature};
use crate::tool_auth;
use crate::{CallState, PublicCtx};

fn answer(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// `$n::timestamp` of a `toISOString()` the handler made: the UTC wall
/// clock; `Err` where the cast fails.
fn timestamp_of(iso: &str) -> Result<PrimitiveDateTime, String> {
    OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339)
        .map(utc_timestamp)
        .map_err(|_| format!("invalid input syntax for type timestamp: \"{iso}\""))
}

/// `update voip_porting_orders set … where id = $1`: the columns of `set`
/// on the workspace's port.
async fn update_order(
    db: &PgPool,
    draft_id: &str,
    set: porting_orders::ActiveModel,
) -> Result<(), String> {
    porting_orders::Entity::update_many()
        .set(set)
        .filter(porting_orders::Column::Id.eq(draft_id))
        .exec(&orm(db))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `delete from telnyx_porting_order_index where telnyx_porting_order_id = $1`.
async fn forget_order(master: &PgPool, order_id: &str) -> Result<(), String> {
    porting_index::Entity::delete_many()
        .filter(porting_index::Column::TelnyxPortingOrderId.eq(order_id))
        .exec(&orm(master))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `select to_jsonb(t) from voip_porting_orders t where t.id = $1`.
async fn load_order(db: &PgPool, draft_id: &str) -> Result<Option<porting_orders::Model>, String> {
    porting_orders::Entity::find_by_id(draft_id)
        .one(&orm(db))
        .await
        .map_err(|e| e.to_string())
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
        desk_phone_messages::fanout(self.state, org, conversation, message, created).await;
    }

    /// The phone flows' handle on the workspace `org` and its tenant
    /// database.
    fn phone<'a>(&'a self, db: &'a PgPool, org: &'a str) -> Phone<'a> {
        self.ctx.phone(self.state, &self.telnyx, db, org)
    }

    /// `isTrunkCall(env, payload)`: the call came in on a connection that is
    /// not one of ours.
    fn is_trunk_call(&self, payload: &Value) -> bool {
        is_trunk_call(
            self.ctx.env("TELNYX_CONNECTION_ID").as_deref(),
            self.ctx.env("TELNYX_SIP_CONNECTION_ID").as_deref(),
            payload,
        )
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
            let from: Option<String> = voip_calls::Entity::find_by_id(call)
                .select_only()
                .column(voip_calls::Column::FromNumber)
                .into_tuple()
                .one(&orm(&db))
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
    // A trunk's SIP login is in a customer's hands: a client signed in with
    // it can originate a call that carries any client_state. On an event of a
    // trunk connection, the workspace the state names must own that
    // connection; otherwise the state is made up, and the event is
    // acknowledged and dropped.
    if js::truthy(&workspace) && hook.is_trunk_call(payload) {
        let named = js::string(&workspace);
        let db = hook.tenant(&named).await?;
        if !owns_trunk_connection(&db, payload)
            .await
            .map_err(|e| e.to_string())?
        {
            tracing::warn!(
                event_type,
                "[Telnyx Webhook] event on a trunk connection names a workspace that does not own it, ignoring"
            );
            return Ok(());
        }
    }
    // A leg the server dialled to ring an agent's browser: its own
    // client_state, no callId.
    if let Some(leg_id) = client_state.get("agentLegId").filter(|id| js::truthy(id))
        && js::truthy(&workspace)
    {
        let workspace = js::string(&workspace);
        let db = hook.tenant(&workspace).await?;
        return handle_agent_leg_event(
            &hook.phone(&db, &workspace),
            event_type,
            &js::string(leg_id),
            payload,
        )
        .await;
    }
    let missing = !js::truthy(&call_id) || !js::truthy(&workspace);
    let direction = match &payload["direction"] {
        Value::Null => String::new(),
        other => js::string(other).to_lowercase(),
    };
    // A customer's phone system's call counts whatever its direction says.
    if missing
        && event_type == "call.initiated"
        && (matches!(direction.as_str(), "incoming" | "inbound") || hook.is_trunk_call(payload))
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
    // An outbound call placed from a conversation carries no conversation in
    // its client_state: the row has it.
    let conversation = match client_state
        .get("deskConversationId")
        .filter(|c| js::truthy(c))
    {
        Some(conversation) => Some(js::string(conversation)),
        None => conversation_of_call(&db, &call_id).await?,
    };
    let call = CallEvent {
        hook,
        db,
        event: data,
        payload,
        client_state: &client_state,
        call_id: &call_id,
        workspace: &workspace,
        conversation,
    };
    call.dispatch(event_type).await
}

/// `conversationOfCall(db, callId)`: the conversation on the call's row.
async fn conversation_of_call(db: &PgPool, call_id: &str) -> Result<Option<String>, String> {
    let row: Option<Option<String>> = voip_calls::Entity::find_by_id(call_id)
        .select_only()
        .column(voip_calls::Column::DeskConversationId)
        .into_tuple()
        .one(&orm(db))
        .await
        .map_err(|e| e.to_string())?;
    Ok(row
        .flatten()
        .filter(|conversation| !conversation.is_empty()))
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
    let index: Option<(String, String)> = porting_index::Entity::find()
        .select_only()
        .columns([
            porting_index::Column::ClerkOrgId,
            porting_index::Column::DraftId,
        ])
        .filter(porting_index::Column::TelnyxPortingOrderId.eq(&order_id))
        .into_tuple()
        .one(&orm(&master))
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
            update_order(
                &db,
                &draft_id,
                porting_orders::ActiveModel {
                    status: Set("cancelled".to_owned()),
                    updated_at: Set(utc_now()),
                    ..Default::default()
                },
            )
            .await?;
            forget_order(&master, &order_id).await
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
            let mut set = porting_orders::ActiveModel {
                substatus: Set(match &sub_status {
                    Value::Null => None,
                    other => Some(js::string(other)),
                }),
                updated_at: Set(utc_now()),
                ..Default::default()
            };
            // `coalesce($3::timestamp, actual_foc_at)`.
            if let Some(foc) = foc {
                set.actual_foc_at = Set(Some(timestamp_of(&foc)?));
            }
            if status == "in-process" {
                set.status = Set("in_process".to_owned());
            }
            update_order(&db, &draft_id, set).await
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
    let inserted = notifications::Entity::insert(notifications::ActiveModel {
        id: Set(weldsuite_kit::generate_id("ntf")),
        user_id: Set(notice.user_id.to_owned()),
        title: Set(notice.title.to_owned()),
        body: Set(Some(notice.body)),
        category: Set("system".to_owned()),
        notification_type: Set(notice.notification_type.to_owned()),
        entity_type: Set(Some(notice.entity_type.to_owned())),
        entity_id: Set(Some(notice.entity_id.to_owned())),
        action_url: Set(Some(notice.action_url)),
        icon: Set(Some("phone".to_owned())),
        severity: Set(notice.severity.to_owned()),
        is_read: Set(false),
        delivered_in_app: Set(true),
        delivered_email: Set(false),
        delivered_push: Set(false),
        // A `timestamptz`: `new Date()` to the millisecond.
        created_at: Set(utc_now().assume_utc()),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
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
        return update_order(
            &db,
            draft_id,
            porting_orders::ActiveModel {
                last_error_code: Set(Some("completed_without_number".to_owned())),
                last_error_message: Set(Some(
                    "Telnyx reported completion but returned no phone number".to_owned(),
                )),
                updated_at: Set(utc_now()),
                ..Default::default()
            },
        )
        .await;
    };
    let Some(draft) = load_order(&db, draft_id).await? else {
        return Ok(());
    };
    if draft
        .voip_phone_number_id
        .as_deref()
        .is_some_and(|number| !number.is_empty())
    {
        return Ok(());
    }
    let phone = draft.phone_number.clone();
    let number_id = live_ported_number(hook, &db, &draft, &ported).await?;
    update_order(
        &db,
        draft_id,
        porting_orders::ActiveModel {
            status: Set("completed".to_owned()),
            voip_phone_number_id: Set(Some(number_id.clone())),
            last_error_code: Set(None),
            last_error_message: Set(None),
            updated_at: Set(utc_now()),
            ..Default::default()
        },
    )
    .await?;
    let shown = draft
        .formatted_number
        .as_deref()
        .unwrap_or(&phone)
        .to_owned();
    notify(
        &db,
        Notice {
            user_id: &draft.created_by_user_id,
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
    forget_order(master, order_id).await
}

/// The ported number's row, live: the workspace's own row of the number
/// taken over (or left as it is), or a new one. Answers its id.
async fn live_ported_number(
    hook: &Hook<'_>,
    db: &PgPool,
    draft: &porting_orders::Model,
    ported: &Value,
) -> Result<String, String> {
    let phone = &draft.phone_number;
    // `(id, provider, sip_trunk_id, deleted_at)` of the number's row.
    let existing: Option<(String, String, Option<String>, Option<PrimitiveDateTime>)> =
        voip_numbers::Entity::find()
            .select_only()
            .columns([
                voip_numbers::Column::Id,
                voip_numbers::Column::Provider,
                voip_numbers::Column::SipTrunkId,
                voip_numbers::Column::DeletedAt,
            ])
            .filter(voip_numbers::Column::PhoneNumber.eq(phone))
            .into_tuple()
            .one(&orm(db))
            .await
            .map_err(|e| e.to_string())?;
    let provider_number = ported["id"].as_str().map(str::to_owned);
    let connection = hook.ctx.env("TELNYX_CONNECTION_ID");
    if let Some((id, provider, sip_trunk_id, deleted_at)) = existing {
        // The number was first connected over the customer's own phone
        // system, or was removed: from now on it is a number we host. Left as
        // a trunk's number, every call from the phone network would be refused
        // (only the trunk's connection may call such a number), and no route
        // could repair it.
        if provider == "sip_trunk"
            || sip_trunk_id
                .as_deref()
                .is_some_and(|trunk| !trunk.is_empty())
            || deleted_at.is_some()
        {
            voip_numbers::Entity::update_many()
                .set(voip_numbers::ActiveModel {
                    provider: Set("telnyx".to_owned()),
                    sip_trunk_id: Set(None),
                    deleted_at: Set(None),
                    provider_phone_number_id: Set(provider_number),
                    provider_connection_id: Set(connection),
                    status: Set("active".to_owned()),
                    caller_id_verified_at: Set(None),
                    allow_outbound: Set(Some(true)),
                    updated_at: Set(utc_now()),
                    ..Default::default()
                })
                .filter(voip_numbers::Column::Id.eq(&id))
                .exec(&orm(db))
                .await
                .map_err(|e| e.to_string())?;
        }
        return Ok(id);
    }
    let id = weldsuite_kit::generate_id("vpn");
    let now = utc_now();
    voip_numbers::Entity::insert(voip_numbers::ActiveModel {
        id: Set(id.clone()),
        provider: Set("telnyx".to_owned()),
        phone_number: Set(phone.clone()),
        formatted_number: Set(Some(
            draft
                .formatted_number
                .clone()
                .unwrap_or_else(|| phone.clone()),
        )),
        country_code: Set(draft.country_code.clone()),
        number_type: Set(Some(draft.number_type.clone())),
        provider_phone_number_id: Set(provider_number),
        provider_connection_id: Set(connection),
        status: Set("active".to_owned()),
        is_default: Set(Some(false)),
        allow_inbound: Set(Some(true)),
        allow_outbound: Set(Some(true)),
        enable_recording: Set(Some(true)),
        display_name: Set(draft.business_name.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// `handlePortingException(ctx, message)`.
async fn porting_exception(
    hook: &Hook<'_>,
    org: &str,
    draft_id: &str,
    message: &str,
) -> Result<(), String> {
    let db = hook.tenant(org).await?;
    let Some(draft) = load_order(&db, draft_id).await? else {
        return Ok(());
    };
    update_order(
        &db,
        draft_id,
        porting_orders::ActiveModel {
            status: Set("exception".to_owned()),
            last_error_code: Set(Some("telnyx_exception".to_owned())),
            last_error_message: Set(Some(message.to_owned())),
            updated_at: Set(utc_now()),
            ..Default::default()
        },
    )
    .await?;
    let shown = draft
        .formatted_number
        .as_deref()
        .unwrap_or(&draft.phone_number)
        .to_owned();
    let detail = if message.is_empty() {
        "no detail provided"
    } else {
        message
    };
    let id = draft.id.clone();
    notify(
        &db,
        Notice {
            user_id: &draft.created_by_user_id,
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

/// A number the call came in on: `(id, assignedUserId, allowInbound,
/// enableRecording, sipTrunkId, providerConnectionId)`.
type PhoneRow = (
    String,
    Option<String>,
    Option<bool>,
    Option<bool>,
    Option<String>,
    Option<String>,
);

/// A number's route: `(action, voiceAgentId, forwardToE164, options)`.
type RouteRow = (String, Option<String>, Option<String>, Option<Value>);

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
    // A phone system may dial `sip:<number>@host` or a number without its `+`.
    let trunk_call = hook.is_trunk_call(payload);
    let dialed = |raw: &Value| {
        trunk_call
            .then(|| dialed_number_of(&js::string(raw)))
            .flatten()
    };
    let to_number = dialed(&to_raw).unwrap_or_else(|| normalize_e164(&js::string(&to_raw)));
    let from_number = dialed(&from_raw).unwrap_or_else(|| {
        normalize_e164(&if js::truthy(&from_raw) {
            js::string(&from_raw)
        } else {
            "unknown".to_owned()
        })
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
    let phone: Option<PhoneRow> = voip_numbers::Entity::find()
        .select_only()
        .columns([
            voip_numbers::Column::Id,
            voip_numbers::Column::AssignedUserId,
            voip_numbers::Column::AllowInbound,
            voip_numbers::Column::EnableRecording,
            voip_numbers::Column::SipTrunkId,
            voip_numbers::Column::ProviderConnectionId,
        ])
        .filter(voip_numbers::Column::Id.eq(&number_id))
        .filter(voip_numbers::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&db))
        .await
        .map_err(|e| e.to_string())?;
    let Some((phone_id, assigned, allow_inbound, recording, sip_trunk, phone_connection)) =
        phone.filter(|(_, _, allow, _, _, _)| *allow != Some(false))
    else {
        tracing::warn!(%to_number, "[Telnyx Webhook] Inbound not allowed");
        hook.telnyx
            .hangup(&call_control_id, None)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    };
    let _ = allow_inbound;
    // A number on a customer's own phone system only takes calls over that
    // trunk's connection. A number we host takes a phone system's call only
    // from this workspace's own (or on the number's own connection): another
    // workspace's trunk must not run its calls, and their minutes, into it.
    // A call that is not a trunk call is routed as before.
    let mut trunk_id: Option<String> = None;
    if let Some(sip_trunk) = sip_trunk.as_deref().filter(|trunk| !trunk.is_empty()) {
        match admit_trunk_call(&db, payload, sip_trunk, &to_number)
            .await
            .map_err(|e| e.to_string())?
        {
            Admission::Refused { reason } => {
                tracing::warn!(%reason, "[Telnyx Webhook] Trunk call refused");
                hook.telnyx
                    .hangup(&call_control_id, None)
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
            Admission::Admitted { trunk_id: admitted } => {
                record_trunk_inbound(&db, &admitted)
                    .await
                    .map_err(|e| e.to_string())?;
                trunk_id = Some(admitted);
            }
        }
    } else if trunk_call
        && !admit_trunk_call_to_hosted_number(&db, payload, phone_connection.as_deref())
            .await
            .map_err(|e| e.to_string())?
    {
        tracing::warn!(%to_number, "[Telnyx Webhook] Trunk call refused: the phone system is not this workspace's");
        hook.telnyx
            .hangup(&call_control_id, None)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let route: Option<RouteRow> = desk_phone_routes::Entity::find()
        .select_only()
        .columns([
            desk_phone_routes::Column::Action,
            desk_phone_routes::Column::VoiceAgentId,
            desk_phone_routes::Column::ForwardToE164,
            desk_phone_routes::Column::Options,
        ])
        .filter(desk_phone_routes::Column::VoipPhoneNumberId.eq(&phone_id))
        .into_tuple()
        .one(&orm(&db))
        .await
        .map_err(|e| e.to_string())?;
    let route = route.map(|(action, voice_agent_id, forward_to_e164, options)| Route {
        action,
        voice_agent_id,
        forward_to_e164,
        options,
    });
    let call_id = weldsuite_kit::generate_id("vcall");
    let now = utc_now();
    let caller: crm::Caller = match_caller_safe(&db, &from_number).await;
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
            desk_conversations::Entity::update_many()
                .set(desk_conversations::ActiveModel {
                    contact_id: Set(Some(contact.to_owned())),
                    name: Set(caller
                        .caller_name
                        .clone()
                        .or_else(|| desk.conversation["name"].as_str().map(str::to_owned))),
                    email: Set(caller
                        .email
                        .clone()
                        .or_else(|| desk.conversation["email"].as_str().map(str::to_owned))),
                    updated_at: Set(now),
                    ..Default::default()
                })
                .filter(desk_conversations::Column::Id.eq(&conversation_id))
                .exec(&orm(&db))
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
    // Hub events, then routing and auto-assignment, as the widget and email do.
    crate::desk_routing::announce_call(
        hook.state,
        &db,
        &master,
        &workspace,
        &conversation_id,
        &desk.message,
        desk.created,
    )
    .await;
    let record = recording != Some(false);
    voip_calls::Entity::insert(voip_calls::ActiveModel {
        id: Set(call_id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        user_id: Set(assigned
            .filter(|a| !a.is_empty())
            .unwrap_or_else(|| "system".to_owned())),
        provider: Set("telnyx".to_owned()),
        provider_call_id: Set(Some(call_control_id.clone())),
        provider_session_id: Set(text_of(&payload["call_session_id"])),
        provider_leg_id: Set(text_of(&payload["call_leg_id"])),
        direction: Set("inbound".to_owned()),
        status: Set("initiated".to_owned()),
        from_number: Set(from_number.clone()),
        to_number: Set(to_number.clone()),
        from_number_formatted: Set(Some(from_number.clone())),
        to_number_formatted: Set(Some(to_number.clone())),
        initiated_at: Set(now),
        desk_conversation_id: Set(Some(conversation_id.clone())),
        is_recorded: Set(Some(recording.unwrap_or(true))),
        customer_id: Set(caller.customer_id.clone()),
        contact_id: Set(caller.contact_id.clone()),
        sip_trunk_id: Set(trunk_id),
        ..Default::default()
    })
    .exec_without_returning(&orm(&db))
    .await
    .map_err(|e| e.to_string())?;
    let mut state_json = Ordered::new()
        .with("callId", call_id.as_str())
        .with("workspaceId", workspace.as_str())
        .with("deskConversationId", conversation_id.as_str())
        .with("record", if record { "true" } else { "false" });
    if let Some(agent) = route
        .as_ref()
        .and_then(|route| route.voice_agent_id.as_deref())
        .filter(|a| !a.is_empty())
    {
        state_json = state_json.with("voiceAgentId", agent);
    }
    let inbound = InboundCall {
        flow: Flow {
            phone: hook.phone(&db, &workspace),
            call_id: &call_id,
            call_control_id: &call_control_id,
            conversation_id: Some(&conversation_id),
        },
        client_state: encode_client_state(&state_json),
        to_number: &to_number,
        from_number: &from_number,
        caller,
        record,
    };
    execute_route(&inbound, route.as_ref()).await;
    Ok(())
}

/// `value ?? null` for a text column.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        other => Some(js::string(other)),
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

/// `$n::int` of a whole number of seconds: Postgres refuses one out of
/// range, and the statement with it.
fn int_column(seconds: i64) -> Result<i32, String> {
    i32::try_from(seconds).map_err(|_| "integer out of range".to_owned())
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
            "call.speak.ended" => {
                handle_speak_ended(&self.input()).await;
                Ok(())
            }
            "call.gather.ended" => handle_gather_ended(&self.input()).await,
            "call.dequeued" => handle_dequeued(&self.input()).await,
            // A line of a call's live translation (`desk_phone_translation`):
            // that runs on `@weldsuite/ai`, which this backend does not have,
            // so no call is translated here and the line is dropped.
            "call.transcription" => Ok(()),
            "call.machine.detection.ended" => {
                tracing::info!(call = self.call_id, "[Telnyx Webhook] AMD result");
                Ok(())
            }
            _ => {
                tracing::info!(event_type, "[Telnyx Webhook] Unhandled event");
                Ok(())
            }
        }
    }

    /// `toEventInput(ctx)`: the slice of an event the phone queue flows
    /// read.
    fn input(&self) -> CallEventInput<'_> {
        CallEventInput {
            phone: self.hook.phone(&self.db, self.workspace),
            call_id: self.call_id,
            conversation_id: self.conversation.as_deref(),
            client_state: self.client_state,
            payload: self.payload,
        }
    }

    /// `update voip_calls set … where id = $1`: the columns of `set` on
    /// this call.
    async fn update_call(&self, set: voip_calls::ActiveModel) -> Result<(), String> {
        voip_calls::Entity::update_many()
            .set(set)
            .filter(voip_calls::Column::Id.eq(self.call_id))
            .exec(&orm(&self.db))
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn initiated(&self) -> Result<(), String> {
        // A field the event sent (even `null`) is written; a missing one
        // keeps the column.
        let mut set = voip_calls::ActiveModel {
            status: Set("initiated".to_owned()),
            updated_at: Set(utc_now()),
            ..Default::default()
        };
        if let Some(control) = self.payload.get("call_control_id") {
            set.provider_call_id = Set(text_of(control));
        }
        if let Some(session) = self.payload.get("call_session_id") {
            set.provider_session_id = Set(text_of(session));
        }
        if let Some(leg) = self.payload.get("call_leg_id") {
            set.provider_leg_id = Set(text_of(leg));
        }
        self.update_call(set).await
    }

    async fn answered(&self) -> Result<(), String> {
        let answered_at = timestamp_of(&event_date(&self.event["occurred_at"])?)?;
        self.update_call(voip_calls::ActiveModel {
            status: Set("answered".to_owned()),
            answered_at: Set(Some(answered_at)),
            updated_at: Set(utc_now()),
            ..Default::default()
        })
        .await?;
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
        self.update_call(voip_calls::ActiveModel {
            status: Set(status.to_owned()),
            updated_at: Set(utc_now()),
            ..Default::default()
        })
        .await
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
        let ended_at = timestamp_of(&event_date(&self.event["occurred_at"])?)?;
        let stored_cause = if js::truthy(sip) {
            format!("SIP {} - {cause}", js::string(sip))
        } else {
            cause.clone()
        };
        #[allow(clippy::cast_possible_truncation)]
        let seconds = duration.map(|d| d as i64);
        let mut set = voip_calls::ActiveModel {
            status: Set(status.to_owned()),
            ended_at: Set(Some(ended_at)),
            hangup_cause: Set(Some(stored_cause)),
            hangup_source: Set(Some(source)),
            updated_at: Set(utc_now()),
            ..Default::default()
        };
        if let Some(seconds) = seconds {
            set.duration = Set(Some(int_column(seconds)?));
        }
        self.update_call(set).await?;
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
        // A caller who hangs up while waiting for an agent is abandoned.
        let members_freed = match handle_caller_left_queue(&self.input()).await {
            Ok(freed) => freed,
            Err(error) => {
                tracing::error!(%error, "[Telnyx Webhook] Abandoned-call handling failed");
                false
            }
        };
        // The worker stops and charges a live translation here
        // (`finishCallTranslation`); none can be running on this backend.
        if let Some(seconds) = seconds.filter(|s| *s > 0) {
            self.settle(seconds, &cause).await;
        }
        // Last, when this call is dealt with: the members whose browsers were
        // ringing for the caller who left are offered the oldest waiting
        // caller.
        if members_freed {
            let phone = self.hook.phone(&self.db, self.workspace);
            ring_waiting_calls(&phone, Some(self.call_id)).await;
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
            self.update_call(voip_calls::ActiveModel {
                credits_consumed: Set(Some(i32::try_from(cost).unwrap_or(i32::MAX))),
                credit_transaction_id: Set(Some(transaction)),
                updated_at: Set(utc_now()),
                ..Default::default()
            })
            .await?;
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
        let mut set = voip_calls::ActiveModel {
            is_recorded: Set(Some(true)),
            recording_storage_url: Set(Some(js::string(url))),
            recording_storage_key: Set(key),
            updated_at: Set(utc_now()),
            ..Default::default()
        };
        if let Some(seconds) = seconds {
            set.recording_duration = Set(Some(int_column(seconds)?));
        }
        self.update_call(set).await?;
        // A voicemail is the call's message, not a call recording.
        if self.input().stage() == Some("voicemail") {
            return handle_voicemail_saved(&self.input(), url, seconds).await;
        }
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
        let now = utc_now();
        self.update_call(voip_calls::ActiveModel {
            ai_summary: Set(Some(text)),
            ai_analyzed_at: Set(Some(now)),
            updated_at: Set(now),
            ..Default::default()
        })
        .await?;
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
                    let row = desk_messages::Entity::update_many()
                        .col_expr(desk_messages::Column::Body, Expr::value(&body))
                        .filter(
                            desk_messages::Column::Id
                                .eq(previous["id"].as_str().unwrap_or_default()),
                        )
                        .exec_with_returning(&orm(&self.db))
                        .await
                        .map_err(|e| e.to_string())?
                        .into_iter()
                        .next();
                    if let Some(row) = row {
                        updated.push(serde_json::to_value(row).map_err(|e| e.to_string())?);
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
