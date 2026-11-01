//! `/api/desk/phone` (`routes/desk-phone`): the WeldDesk phone channel's
//! voice agents (each kept in sync with a Telnyx AI assistant when Telnyx is
//! configured), the inbound route of each number, and the live transfer of
//! an inbound call.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};

use crate::js::Ordered;
use crate::telnyx::{AssistantInput, Telnyx, encode_client_state};
use crate::tool_auth::{self, Claims};
use crate::{CallState, Caller, env_value, internal, now, validate};

const LOOKUP_CRM_PATH: &str = "/public/webhooks/telnyx/tools/lookup_crm";

/// `/^\+[1-9]\d{6,14}$/`.
pub(crate) fn is_e164(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('+') else {
        return false;
    };
    (7..=15).contains(&rest.len())
        && rest.bytes().all(|b| b.is_ascii_digit())
        && rest.as_bytes().first().is_some_and(|b| *b != b'0')
}

/// `getHelpdeskWorkerUrl(env)`: `APP_API_PUBLIC_URL`, else app-api's host
/// for the environment.
fn helpdesk_worker_url(environment: Option<&str>, override_url: Option<&str>) -> String {
    if let Some(url) = override_url.filter(|u| !u.is_empty()) {
        return url.strip_suffix('/').unwrap_or(url).to_owned();
    }
    match environment {
        Some("test" | "preview") => "https://app-api-test.weldsuite.org",
        Some("production") => "https://app-api.weldsuite.org",
        _ => "http://localhost:8789",
    }
    .to_owned()
}

/// `^<prefix>(-[a-z0-9]+)?\.(.+)$` on a host: `(suffix, rest)`.
fn split_worker_host<'a>(host: &'a str, prefix: &str) -> Option<(&'a str, &'a str)> {
    let rest = host.strip_prefix(prefix)?;
    let (suffix, rest) = match rest.strip_prefix('-') {
        Some(after) => {
            let end = after
                .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
                .unwrap_or(after.len());
            if end == 0 {
                return None;
            }
            (&rest[..=end], &after[end..])
        }
        None => ("", rest),
    };
    let tail = rest.strip_prefix('.')?;
    (!tail.is_empty()).then_some((suffix, tail))
}

/// `originForPathFrom(requestOrigin, path)` for a call-api path: the
/// app-api origin behind `origin`, then call-api's beside it.
fn call_api_origin(origin: &str) -> String {
    let modules = weldsuite_catalogs::api_modules();
    let dev_port = |id: &str| {
        modules
            .iter()
            .find(|m| m.id == id)
            .map_or(0, |m| m.dev_port)
    };
    // coreOriginFrom
    let core = match url::Url::parse(origin) {
        Err(_) => origin.to_owned(),
        Ok(mut url) => match url.host_str().map(str::to_owned) {
            Some(host) if host == "localhost" || host == "127.0.0.1" => {
                let _ = url.set_port(Some(dev_port("core")));
                url.origin().ascii_serialization()
            }
            Some(host) => modules
                .iter()
                .find_map(|m| split_worker_host(&host, &m.worker))
                .map_or_else(
                    || origin.to_owned(),
                    |(suffix, tail)| {
                        let _ = url.set_host(Some(&format!("app-api{suffix}.{tail}")));
                        url.origin().ascii_serialization()
                    },
                ),
            None => origin.to_owned(),
        },
    };
    // moduleOriginFrom(core, call)
    match url::Url::parse(&core) {
        Err(_) => core,
        Ok(mut url) => match url.host_str().map(str::to_owned) {
            Some(host) if host == "localhost" || host == "127.0.0.1" => {
                let _ = url.set_port(Some(dev_port("call")));
                url.origin().ascii_serialization()
            }
            Some(host) => match split_worker_host(&host, "app-api") {
                Some((suffix, tail)) => {
                    let _ = url.set_host(Some(&format!("call-api{suffix}.{tail}")));
                    url.origin().ascii_serialization()
                }
                None => core,
            },
            None => core,
        },
    }
}

/// `lookupCrmUrl(env)`: where Telnyx calls the `lookup_crm` tool.
pub(crate) fn lookup_crm_url(environment: Option<&str>, override_url: Option<&str>) -> String {
    let base = helpdesk_worker_url(environment, override_url);
    format!("{}{LOOKUP_CRM_PATH}", call_api_origin(&base))
}

/// `lookupCrmWebhookTool({ lookupCrmUrl, toolAuthHeader })`.
pub(crate) fn lookup_crm_tool(url: &str, auth_header: &str) -> Value {
    json!({
        "type": "webhook",
        "webhook": {
            "name": "lookup_crm",
            "description": "Look up customers, contacts, and leads in WeldSuite CRM by name, email, or phone. Use the caller phone number when they have not given another identifier.",
            "url": url,
            "method": "POST",
            "headers": [{ "name": "Authorization", "value": auth_header }],
            "body_parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Name, email, or phone to search. Prefer the caller phone from context when they have not provided another identifier.",
                    },
                },
            },
        },
    })
}

/// The current second (`Math.floor(Date.now() / 1000)`).
pub(crate) fn now_seconds() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// `crmLookupExtraTools(env, { org, aid })`.
fn extra_tools(caller: &Caller, aid: &str) -> Vec<Value> {
    let Some(key) = caller.env("TELNYX_API_KEY") else {
        return Vec::new();
    };
    let token = tool_auth::sign(
        &key,
        &Claims {
            org: caller.clerk_org_id.clone().unwrap_or_default(),
            aid: aid.to_owned(),
            call: None,
            conv: None,
        },
        now_seconds(),
    );
    let url = lookup_crm_url(
        caller.env("ENVIRONMENT").as_deref(),
        caller.env("APP_API_PUBLIC_URL").as_deref(),
    );
    vec![lookup_crm_tool(&url, &format!("Bearer {token}"))]
}

/// `toAgentJson(row)` from a `to_jsonb` row.
fn agent_json(row: &Value) -> Value {
    let row = weldsuite_db::js_row(row.clone());
    json!({
        "id": row["id"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
        "name": row["name"],
        "systemPrompt": row["systemPrompt"],
        "greeting": row["greeting"],
        "telnyxAssistantId": row["telnyxAssistantId"],
        "enabled": row["enabled"],
        "forwardToE164": row["forwardToE164"],
        "model": row["model"],
        "voice": row["voice"],
    })
}

/// `toRouteJson(row)` from a `to_jsonb` row.
fn route_json(row: &Value) -> Value {
    let row = weldsuite_db::js_row(row.clone());
    json!({
        "id": row["id"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
        "voipPhoneNumberId": row["voipPhoneNumberId"],
        "action": row["action"],
        "voiceAgentId": row["voiceAgentId"],
        "forwardToE164": row["forwardToE164"],
        "schedule": row["schedule"],
    })
}

/// `list(c, data, cursorPagination(data.length, false, null))`.
fn whole_list(data: Vec<Value>) -> Response {
    let count = u64::try_from(data.len()).unwrap_or(0);
    List::new(data, Pagination::new(count, false, None)).into_response()
}

/// `GET /api/desk/phone/agents`.
pub(crate) async fn list_agents(caller: Caller) -> Response {
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_voice_agents t where t.deleted_at is null",
    )
    .fetch_all(&caller.db)
    .await;
    match found {
        Ok(found) => whole_list(found.iter().map(agent_json).collect()),
        Err(error) => internal(&error, "Internal server error"),
    }
}

async fn live_agent(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "select to_jsonb(t) from desk_voice_agents t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await
}

/// `GET /api/desk/phone/agents/:id`.
pub(crate) async fn agent(caller: Caller, Path(id): Path<String>) -> Response {
    match live_agent(&caller, &id).await {
        Ok(Some(row)) => Data(agent_json(&row)).into_response(),
        Ok(None) => ApiError::not_found("Voice agent", Some(&id)).into_response(),
        Err(error) => internal(&error, "Internal server error"),
    }
}

/// `createDeskVoiceAgentSchema`, or its `.partial()`.
struct AgentInput {
    name: Option<String>,
    system_prompt: Option<String>,
    greeting: Field<String>,
    enabled: Option<bool>,
    forward_to_e164: Field<String>,
    model: Field<String>,
    voice: Field<String>,
}

fn read_agent(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> AgentInput {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    AgentInput {
        name: issues
            .text(fields, "name", required, Some(1), Some(255))
            .into_option(),
        system_prompt: issues
            .text(fields, "systemPrompt", required, Some(1), None)
            .into_option(),
        greeting: issues.text(fields, "greeting", Presence::Nullish, None, Some(2000)),
        enabled: issues
            .boolean(fields, "enabled", Presence::Optional)
            .into_option(),
        forward_to_e164: issues.pattern(
            fields,
            "forwardToE164",
            Presence::Nullish,
            None,
            None,
            is_e164,
            "Must be E.164",
        ),
        model: issues.text(fields, "model", Presence::Nullish, None, Some(100)),
        voice: issues.text(fields, "voice", Presence::Nullish, None, Some(100)),
    }
}

/// `POST /api/desk/phone/agents`: a voice agent, with its Telnyx AI
/// assistant when Telnyx is configured.
pub(crate) async fn create_agent(
    State(state): State<CallState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        read_agent(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let id = weldsuite_kit::generate_id("dva");
    let telnyx = caller.telnyx(&state);
    let mut assistant_id: Option<String> = None;
    if telnyx.configured() {
        let input = AssistantInput {
            name: data.name.clone().unwrap_or_default(),
            instructions: data.system_prompt.clone().unwrap_or_default(),
            greeting: data.greeting.as_set().cloned(),
            model: data.model.as_set().cloned(),
            voice: data.voice.as_set().cloned(),
            transfer_to_e164: data.forward_to_e164.as_set().cloned(),
            extra_tools: extra_tools(&caller, &id),
        };
        match telnyx.create_assistant(&input).await {
            Ok(created) => assistant_id = Some(created),
            Err(error) => {
                tracing::error!(%error, "[desk-phone] Failed to create Telnyx assistant");
                return ApiError::bad_request("Failed to create Telnyx AI assistant")
                    .into_response();
            }
        }
    }
    let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into desk_voice_agents (id, created_at, updated_at, name, system_prompt, greeting,
             telnyx_assistant_id, enabled, forward_to_e164, model, voice)
         values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, $7, $8, $9, $10)
         returning to_jsonb(desk_voice_agents)",
    )
    .bind(&id)
    .bind(now())
    .bind(&data.name)
    .bind(&data.system_prompt)
    .bind(data.greeting.as_set())
    .bind(&assistant_id)
    .bind(data.enabled.unwrap_or(true))
    .bind(data.forward_to_e164.as_set())
    .bind(data.model.as_set())
    .bind(data.voice.as_set())
    .fetch_one(&caller.db)
    .await;
    match inserted {
        Ok(row) => Created(agent_json(&row)).into_response(),
        Err(error) => internal(&error, "Internal server error"),
    }
}

/// `field !== undefined ? field : existing`.
fn or_existing(field: &Field<String>, existing: &Value) -> Value {
    match field {
        Field::Absent => existing.clone(),
        Field::Null => Value::Null,
        Field::Set(value) => json!(value),
    }
}

/// `PATCH /api/desk/phone/agents/:id`: the agent, and its Telnyx assistant
/// (created when it has none yet).
pub(crate) async fn update_agent(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        read_agent(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let existing = match live_agent(&caller, &id).await {
        Ok(Some(row)) => weldsuite_db::js_row(row),
        Ok(None) => return ApiError::not_found("Voice agent", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Internal server error"),
    };
    let name = data
        .name
        .clone()
        .map_or_else(|| existing["name"].clone(), Value::String);
    let system_prompt = data
        .system_prompt
        .clone()
        .map_or_else(|| existing["systemPrompt"].clone(), Value::String);
    let greeting = or_existing(&data.greeting, &existing["greeting"]);
    let enabled = data
        .enabled
        .map_or_else(|| existing["enabled"].clone(), Value::Bool);
    let forward = or_existing(&data.forward_to_e164, &existing["forwardToE164"]);
    let model = or_existing(&data.model, &existing["model"]);
    let voice = or_existing(&data.voice, &existing["voice"]);
    let text = |value: &Value| value.as_str().map(str::to_owned);

    let telnyx = caller.telnyx(&state);
    let mut assistant_id = text(&existing["telnyxAssistantId"]);
    if telnyx.configured() {
        let input = AssistantInput {
            name: text(&name).unwrap_or_default(),
            instructions: text(&system_prompt).unwrap_or_default(),
            greeting: text(&greeting),
            model: text(&model),
            voice: text(&voice),
            transfer_to_e164: text(&forward),
            extra_tools: extra_tools(&caller, &id),
        };
        let synced = match assistant_id.as_deref().filter(|a| !a.is_empty()) {
            Some(existing_id) => telnyx.update_assistant(existing_id, &input).await,
            None => telnyx
                .create_assistant(&input)
                .await
                .map(|created| assistant_id = Some(created)),
        };
        if let Err(error) = synced {
            tracing::error!(%error, "[desk-phone] Failed to sync Telnyx assistant");
            return ApiError::bad_request("Failed to sync Telnyx AI assistant").into_response();
        }
    }
    let updated: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "update desk_voice_agents set name = $2, system_prompt = $3, greeting = $4, enabled = $5,
             forward_to_e164 = $6, model = $7, voice = $8, telnyx_assistant_id = $9,
             updated_at = $10::timestamp
         where id = $1
         returning to_jsonb(desk_voice_agents)",
    )
    .bind(&id)
    .bind(text(&name))
    .bind(text(&system_prompt))
    .bind(text(&greeting))
    .bind(enabled.as_bool())
    .bind(text(&forward))
    .bind(text(&model))
    .bind(text(&voice))
    .bind(&assistant_id)
    .bind(now())
    .fetch_one(&caller.db)
    .await;
    match updated {
        Ok(row) => Data(agent_json(&row)).into_response(),
        Err(error) => internal(&error, "Internal server error"),
    }
}

/// `DELETE /api/desk/phone/agents/:id`: a soft delete; the Telnyx
/// assistant goes too (best effort).
pub(crate) async fn delete_agent(
    State(state): State<CallState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let existing = match live_agent(&caller, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Voice agent", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Internal server error"),
    };
    let telnyx = caller.telnyx(&state);
    if let Some(assistant) = existing["telnyx_assistant_id"]
        .as_str()
        .filter(|a| !a.is_empty())
        && telnyx.configured()
        && let Err(error) = telnyx.delete_assistant(assistant).await
    {
        tracing::error!(%error, "[desk-phone] Failed to delete Telnyx assistant (continuing)");
    }
    let now = now();
    if let Err(error) = sqlx::query(
        "update desk_voice_agents set deleted_at = $2::timestamp, updated_at = $2::timestamp,
             enabled = false
         where id = $1",
    )
    .bind(&id)
    .bind(&now)
    .execute(&caller.db)
    .await
    {
        return internal(&error, "Internal server error");
    }
    NoContent.into_response()
}

/// `GET /api/desk/phone/routes`.
pub(crate) async fn list_routes(caller: Caller) -> Response {
    let found: Result<Vec<Value>, sqlx::Error> =
        sqlx::query_scalar("select to_jsonb(t) from desk_phone_routes t")
            .fetch_all(&caller.db)
            .await;
    match found {
        Ok(found) => whole_list(found.iter().map(route_json).collect()),
        Err(error) => internal(&error, "Internal server error"),
    }
}

/// `upsertDeskPhoneRouteSchema`.
struct RouteInput {
    phone_id: String,
    action: String,
    voice_agent_id: Option<String>,
    forward_to_e164: Option<String>,
}

fn read_route(issues: &mut Issues, fields: &Map<String, Value>) -> RouteInput {
    let start = issues.count();
    let phone_id = issues
        .text(
            fields,
            "voipPhoneNumberId",
            Presence::Required,
            Some(1),
            None,
        )
        .into_option();
    let action = issues
        .choice(
            fields,
            "action",
            Presence::Required,
            &["ai_agent", "forward", "hangup"],
        )
        .into_option();
    let voice_agent_id = issues
        .text_with(fields, "voiceAgentId", Presence::Nullish, Text::default())
        .into_option();
    // The value Zod hands the refinement: a string that failed its regex
    // is still there.
    let raw_forward = fields
        .get("forwardToE164")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let forward_to_e164 = issues
        .pattern(
            fields,
            "forwardToE164",
            Presence::Nullish,
            None,
            None,
            is_e164,
            "Must be E.164",
        )
        .into_option();
    // `.superRefine` runs when no field failed its type (or enum) check.
    let aborted = issues.issues_since(start).iter().any(|issue| {
        matches!(
            issue["code"].as_str(),
            Some("invalid_type" | "invalid_enum_value")
        )
    });
    if !aborted {
        let action = action.as_deref().unwrap_or_default();
        if action == "ai_agent" && voice_agent_id.as_deref().is_none_or(str::is_empty) {
            issues.custom(
                "voiceAgentId",
                "voiceAgentId is required for ai_agent routes",
            );
        }
        if action == "forward" && raw_forward.as_deref().is_none_or(str::is_empty) {
            issues.custom(
                "forwardToE164",
                "forwardToE164 is required for forward routes",
            );
        }
    }
    RouteInput {
        phone_id: phone_id.unwrap_or_default(),
        action: action.unwrap_or_default(),
        voice_agent_id,
        forward_to_e164,
    }
}

/// `PUT /api/desk/phone/routes`: a number's inbound route, created or
/// replaced.
pub(crate) async fn upsert_route(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, read_route) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let result = async {
        let phone: Option<String> = sqlx::query_scalar(
            "select id from voip_phone_numbers where id = $1 and deleted_at is null limit 1",
        )
        .bind(&data.phone_id)
        .fetch_optional(&caller.db)
        .await?;
        if phone.is_none() {
            return Ok(ApiError::not_found("Phone number", Some(&data.phone_id)).into_response());
        }
        if let Some(agent) = data.voice_agent_id.as_deref().filter(|a| !a.is_empty())
            && live_agent(&caller, agent).await?.is_none()
        {
            return Ok(ApiError::not_found("Voice agent", Some(agent)).into_response());
        }
        let existing: Option<String> = sqlx::query_scalar(
            "select id from desk_phone_routes where voip_phone_number_id = $1 limit 1",
        )
        .bind(&data.phone_id)
        .fetch_optional(&caller.db)
        .await?;
        let now = now();
        if let Some(route_id) = existing {
            let row: Value = sqlx::query_scalar(
                "update desk_phone_routes set action = $2, voice_agent_id = $3, forward_to_e164 = $4,
                     updated_at = $5::timestamp
                 where id = $1 returning to_jsonb(desk_phone_routes)",
            )
            .bind(&route_id)
            .bind(&data.action)
            .bind(&data.voice_agent_id)
            .bind(&data.forward_to_e164)
            .bind(&now)
            .fetch_one(&caller.db)
            .await?;
            return Ok(Data(route_json(&row)).into_response());
        }
        let row: Value = sqlx::query_scalar(
            "insert into desk_phone_routes (id, created_at, updated_at, voip_phone_number_id, action,
                 voice_agent_id, forward_to_e164, schedule)
             values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, null)
             returning to_jsonb(desk_phone_routes)",
        )
        .bind(weldsuite_kit::generate_id("dpr"))
        .bind(&now)
        .bind(&data.phone_id)
        .bind(&data.action)
        .bind(&data.voice_agent_id)
        .bind(&data.forward_to_e164)
        .fetch_one(&caller.db)
        .await?;
        Ok::<_, sqlx::Error>(Created(route_json(&row)).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Internal server error"))
}

/// `POST /api/desk/phone/forward-live { callId, to }`: cold-transfer an
/// active call.
pub(crate) async fn forward_live(
    State(state): State<CallState>,
    caller: Caller,
    body: Bytes,
) -> Response {
    // `await c.req.json().catch(() => ({}))`, whatever the content type.
    let parsed: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    if parsed.is_null() {
        // `null.callId` throws.
        return ApiError::internal().into_response();
    }
    let text = |key: &str| parsed[key].as_str().unwrap_or_default().to_owned();
    let (call_id, to) = (text("callId"), text("to"));
    if call_id.is_empty() || !is_e164(&to) {
        return ApiError::bad_request("callId and E.164 to are required").into_response();
    }
    let telnyx: Telnyx = caller.telnyx(&state);
    if !telnyx.configured() {
        return ApiError::bad_request("Phone service is not activated").into_response();
    }
    let call: Option<(String, Option<String>, String, Option<String>)> = match sqlx::query_as(
        "select id, provider_call_id, to_number, desk_conversation_id from voip_calls
         where id = $1 limit 1",
    )
    .bind(&call_id)
    .fetch_optional(&caller.db)
    .await
    {
        Ok(call) => call,
        Err(error) => return internal(&error, "Internal server error"),
    };
    let Some((id, Some(provider_call_id), to_number, conversation)) =
        call.filter(|(_, provider, _, _)| provider.as_deref().is_some_and(|p| !p.is_empty()))
    else {
        return ApiError::not_found("Call", Some(&call_id)).into_response();
    };
    let mut state_json = Ordered::new().with("callId", id.as_str());
    if let Some(org) = &caller.clerk_org_id {
        state_json = state_json.with("workspaceId", org.as_str());
    }
    if let Some(conversation) = conversation.filter(|c| !c.is_empty()) {
        state_json = state_json.with("deskConversationId", conversation);
    }
    let client_state = encode_client_state(&state_json);
    if let Err(error) = telnyx
        .transfer(
            &provider_call_id,
            &to,
            Some(&client_state),
            Some(&to_number),
        )
        .await
    {
        tracing::error!(%error, "[desk-phone] live transfer failed");
        return ApiError::bad_request("Transfer failed").into_response();
    }
    Data(json!({ "ok": true })).into_response()
}

/// `env_value` for the webhook's tool settings.
pub(crate) fn tool_url_for(env: Option<&weldsuite_kit::RequestEnv>) -> String {
    lookup_crm_url(
        env_value(env, "ENVIRONMENT").as_deref(),
        env_value(env, "APP_API_PUBLIC_URL").as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tool_url_points_at_call_api() {
        assert_eq!(
            lookup_crm_url(Some("test"), None),
            "https://call-api-test.weldsuite.org/public/webhooks/telnyx/tools/lookup_crm"
        );
        assert_eq!(
            lookup_crm_url(Some("production"), None),
            "https://call-api.weldsuite.org/public/webhooks/telnyx/tools/lookup_crm"
        );
        assert_eq!(
            lookup_crm_url(None, None),
            "http://localhost:8812/public/webhooks/telnyx/tools/lookup_crm"
        );
        assert_eq!(
            lookup_crm_url(Some("production"), Some("https://eu.example.com/")),
            "https://eu.example.com/public/webhooks/telnyx/tools/lookup_crm"
        );
        assert_eq!(
            lookup_crm_url(None, Some("https://crm-api-dev.example.org")),
            "https://call-api-dev.example.org/public/webhooks/telnyx/tools/lookup_crm"
        );
        assert!(is_e164("+31201234567"));
        assert!(!is_e164("+0123456789"));
        assert!(!is_e164("+12345"));
    }
}
