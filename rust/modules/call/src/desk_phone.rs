//! `/api/desk/phone` (`routes/desk-phone`): the WeldDesk phone channel's
//! voice agents (each kept in sync with a Telnyx AI assistant when Telnyx is
//! configured), the inbound route of each number, and the live transfer of
//! an inbound call. The member's softphone and the call queue are
//! `desk_phone_softphone` and `desk_phone_queue_routes`.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_schema::tenant::{
    desk_phone_routes as routes, desk_voice_agents as agents, helpdesk_departments, voip_calls,
    voip_phone_numbers,
};

use crate::desk_phone_schema::{self as schema, Options};
use crate::js::Ordered;
use crate::telnyx::{AssistantInput, Telnyx, encode_client_state};
use crate::tool_auth::{self, Claims};
use crate::{CallState, Caller, env_value, internal, validate};

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

/// `originForPathFrom(getHelpdeskWorkerUrl(env), path) + path` for a
/// call-api path: a URL Telnyx calls or fetches, on call-api's own host.
fn public_url(environment: Option<&str>, override_url: Option<&str>, path: &str) -> String {
    let base = helpdesk_worker_url(environment, override_url);
    format!("{}{path}", call_api_origin(&base))
}

/// [`public_url`] with the request's `ENVIRONMENT` and `APP_API_PUBLIC_URL`.
pub(crate) fn call_api_url(env: Option<&weldsuite_kit::RequestEnv>, path: &str) -> String {
    public_url(
        env_value(env, "ENVIRONMENT").as_deref(),
        env_value(env, "APP_API_PUBLIC_URL").as_deref(),
        path,
    )
}

/// `lookupCrmUrl(env)`: where Telnyx calls the `lookup_crm` tool.
pub(crate) fn lookup_crm_url(environment: Option<&str>, override_url: Option<&str>) -> String {
    public_url(environment, override_url, LOOKUP_CRM_PATH)
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

/// A row as Drizzle returns it.
fn js(row: Result<Value, serde_json::Error>) -> Value {
    row.unwrap_or_default()
}

/// `toAgentJson(row)`.
fn agent_json(agent: agents::Model) -> Value {
    let row = js(serde_json::to_value(agent));
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

/// `toRouteJson(row)`.
fn route_json(route: routes::Model) -> Value {
    let row = js(serde_json::to_value(route));
    json!({
        "id": row["id"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
        "voipPhoneNumberId": row["voipPhoneNumberId"],
        "action": row["action"],
        "voiceAgentId": row["voiceAgentId"],
        "forwardToE164": row["forwardToE164"],
        "schedule": row["schedule"],
        "options": row["options"],
    })
}

/// `list(c, data, cursorPagination(data.length, false, null))`.
pub(crate) fn whole_list(data: Vec<Value>) -> Response {
    let count = u64::try_from(data.len()).unwrap_or(0);
    List::new(data, Pagination::new(count, false, None)).into_response()
}

/// `GET /api/desk/phone/agents`.
pub(crate) async fn list_agents(caller: Caller) -> Response {
    let found = agents::Entity::find()
        .filter(agents::Column::DeletedAt.is_null())
        .all(&orm(&caller.db))
        .await;
    match found {
        Ok(found) => whole_list(found.into_iter().map(agent_json).collect()),
        Err(error) => internal(&error, "Internal server error"),
    }
}

async fn live_agent(caller: &Caller, id: &str) -> Result<Option<agents::Model>, DbErr> {
    agents::Entity::find()
        .filter(agents::Column::Id.eq(id))
        .filter(agents::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await
}

/// `GET /api/desk/phone/agents/:id`.
pub(crate) async fn agent(caller: Caller, Path(id): Path<String>) -> Response {
    match live_agent(&caller, &id).await {
        Ok(Some(row)) => Data(agent_json(row)).into_response(),
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
    let now = utc_now();
    let inserted = agents::Entity::insert(agents::ActiveModel {
        id: Set(id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        name: Set(data.name.clone().unwrap_or_default()),
        system_prompt: Set(data.system_prompt.clone().unwrap_or_default()),
        greeting: Set(data.greeting.as_set().cloned()),
        telnyx_assistant_id: Set(assistant_id),
        enabled: Set(data.enabled.unwrap_or(true)),
        forward_to_e164: Set(data.forward_to_e164.as_set().cloned()),
        model_: Set(data.model.as_set().cloned()),
        voice: Set(data.voice.as_set().cloned()),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await;
    match inserted {
        Ok(row) => Created(agent_json(row)).into_response(),
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
        Ok(Some(row)) => js(serde_json::to_value(row)),
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
    let updated = agents::Entity::update_many()
        .col_expr(agents::Column::Name, Expr::value(text(&name)))
        .col_expr(
            agents::Column::SystemPrompt,
            Expr::value(text(&system_prompt)),
        )
        .col_expr(agents::Column::Greeting, Expr::value(text(&greeting)))
        .col_expr(agents::Column::Enabled, Expr::value(enabled.as_bool()))
        .col_expr(agents::Column::ForwardToE164, Expr::value(text(&forward)))
        .col_expr(agents::Column::Model, Expr::value(text(&model)))
        .col_expr(agents::Column::Voice, Expr::value(text(&voice)))
        .col_expr(agents::Column::TelnyxAssistantId, Expr::value(assistant_id))
        .col_expr(agents::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(agents::Column::Id.eq(&id))
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| {
            // `returning` read with `fetch_one`: no row is an error.
            rows.into_iter()
                .next()
                .ok_or_else(|| DbErr::RecordNotFound("desk_voice_agents".to_owned()))
        });
    match updated {
        Ok(row) => Data(agent_json(row)).into_response(),
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
    if let Some(assistant) = existing
        .telnyx_assistant_id
        .as_deref()
        .filter(|a| !a.is_empty())
        && telnyx.configured()
        && let Err(error) = telnyx.delete_assistant(assistant).await
    {
        tracing::error!(%error, "[desk-phone] Failed to delete Telnyx assistant (continuing)");
    }
    let now = utc_now();
    if let Err(error) = agents::Entity::update_many()
        .col_expr(agents::Column::DeletedAt, Expr::value(now))
        .col_expr(agents::Column::UpdatedAt, Expr::value(now))
        .col_expr(agents::Column::Enabled, Expr::value(false))
        .filter(agents::Column::Id.eq(&id))
        .exec(&orm(&caller.db))
        .await
    {
        return internal(&error, "Internal server error");
    }
    NoContent.into_response()
}

/// `GET /api/desk/phone/routes`.
pub(crate) async fn list_routes(caller: Caller) -> Response {
    let found = routes::Entity::find().all(&orm(&caller.db)).await;
    match found {
        Ok(found) => whole_list(found.into_iter().map(route_json).collect()),
        Err(error) => internal(&error, "Internal server error"),
    }
}

/// `upsertDeskPhoneRouteSchema`.
struct RouteInput {
    phone_id: String,
    action: String,
    voice_agent_id: Option<String>,
    forward_to_e164: Option<String>,
    /// `None` when left out or null.
    options: Option<Options>,
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
        .choice(fields, "action", Presence::Required, &schema::ROUTE_ACTIONS)
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
    // The options' own refinements (the menu's, its choices') settle
    // after every check of the body, and before the route's.
    let mut deferred = Vec::new();
    let mut options = None;
    let mut options_aborted = false;
    issues.nested(fields, "options", Presence::Nullish, |issues, fields| {
        let (read, aborted) = schema::read_options(issues, fields, &mut deferred);
        options = Some(read);
        options_aborted = aborted;
    });
    // `.superRefine` runs when no field failed its type (or enum) check.
    let aborted = options_aborted || schema::aborted_since(issues, start);
    for issue in deferred {
        issues.push_raw(issue);
    }
    if !aborted {
        let action = action.as_deref().unwrap_or_default();
        // `!data.options?.menu`: an object there got past its type check.
        if action == "menu" && !fields.get("options").is_some_and(|o| o["menu"].is_object()) {
            issues.custom_at(
                &[json!("options"), json!("menu")],
                "options.menu is required for menu routes",
            );
        }
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
        options,
    }
}

/// Whether the phone number exists and is not deleted.
async fn live_phone_number(db: &PgPool, id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = voip_phone_numbers::Entity::find()
        .select_only()
        .column(voip_phone_numbers::Column::Id)
        .filter(voip_phone_numbers::Column::Id.eq(id))
        .filter(voip_phone_numbers::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// Whether the team exists and is not deleted.
async fn live_team(db: &PgPool, id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = helpdesk_departments::Entity::find()
        .select_only()
        .column(helpdesk_departments::Column::Id)
        .filter(helpdesk_departments::Column::Id.eq(id))
        .filter(helpdesk_departments::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// A number's route: the existing one replaced, or a new one.
async fn write_route(
    db: &PgPool,
    data: &RouteInput,
    voice_agent_id: Option<String>,
    forward_to_e164: Option<String>,
    options: Option<Value>,
) -> Result<Response, DbErr> {
    let db = orm(db);
    let existing: Option<String> = routes::Entity::find()
        .select_only()
        .column(routes::Column::Id)
        .filter(routes::Column::VoipPhoneNumberId.eq(&data.phone_id))
        .limit(1)
        .into_tuple()
        .one(&db)
        .await?;
    let now = utc_now();
    if let Some(route_id) = existing {
        let row = routes::Entity::update_many()
            .col_expr(routes::Column::Action, Expr::value(&data.action))
            .col_expr(routes::Column::VoiceAgentId, Expr::value(voice_agent_id))
            .col_expr(routes::Column::ForwardToE164, Expr::value(forward_to_e164))
            .col_expr(routes::Column::Options, Expr::value(options))
            .col_expr(routes::Column::UpdatedAt, Expr::value(now))
            .filter(routes::Column::Id.eq(route_id))
            .exec_with_returning(&db)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| DbErr::RecordNotFound("desk_phone_routes".to_owned()))?;
        return Ok(Data(route_json(row)).into_response());
    }
    let row = routes::Entity::insert(routes::ActiveModel {
        id: Set(weldsuite_kit::generate_id("dpr")),
        created_at: Set(now),
        updated_at: Set(now),
        voip_phone_number_id: Set(data.phone_id.clone()),
        action: Set(data.action.clone()),
        voice_agent_id: Set(voice_agent_id),
        forward_to_e164: Set(forward_to_e164),
        schedule: Set(None),
        options: Set(options),
    })
    .exec_with_returning(&db)
    .await?;
    Ok(Created(route_json(row)).into_response())
}

/// `PUT /api/desk/phone/routes`: a number's inbound route, created or
/// replaced.
pub(crate) async fn upsert_route(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, read_route) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    // The new actions keep their settings in `options`; the old ones keep
    // the columns.
    let classic = matches!(data.action.as_str(), "ai_agent" | "forward" | "hangup");
    let voice_agent_id = data.voice_agent_id.clone().filter(|_| classic);
    let forward_to_e164 = data.forward_to_e164.clone().filter(|_| classic);
    let options = schema::normalize(&data.action, data.options.as_ref());
    let result = async {
        if !live_phone_number(&caller.db, &data.phone_id).await? {
            return Ok(ApiError::not_found("Phone number", Some(&data.phone_id)).into_response());
        }
        if let Some(agent) = voice_agent_id.as_deref().filter(|a| !a.is_empty())
            && live_agent(&caller, agent).await?.is_none()
        {
            return Ok(ApiError::not_found("Voice agent", Some(agent)).into_response());
        }
        // A menu's AI choices need an existing, enabled voice agent.
        for agent in schema::referenced_voice_agent_ids(options.as_ref()) {
            let Some(row) = live_agent(&caller, &agent).await? else {
                return Ok(ApiError::not_found("Voice agent", Some(&agent)).into_response());
            };
            if !row.enabled {
                return Ok(
                    ApiError::bad_request(format!("Voice agent {agent} is disabled"))
                        .into_response(),
                );
            }
        }
        // Teams must exist.
        for team in schema::referenced_team_ids(options.as_ref()) {
            if !live_team(&caller.db, &team).await? {
                return Ok(ApiError::not_found("Team", Some(&team)).into_response());
            }
        }
        write_route(&caller.db, &data, voice_agent_id, forward_to_e164, options).await
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Internal server error"))
}

/// A call to transfer: `(id, providerCallId, toNumber, deskConversationId)`.
type LiveCall = (String, Option<String>, String, Option<String>);

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
    let call: Result<Option<LiveCall>, DbErr> = voip_calls::Entity::find()
        .select_only()
        .columns([
            voip_calls::Column::Id,
            voip_calls::Column::ProviderCallId,
            voip_calls::Column::ToNumber,
            voip_calls::Column::DeskConversationId,
        ])
        .filter(voip_calls::Column::Id.eq(&call_id))
        .limit(1)
        .into_tuple()
        .one(&orm(&caller.db))
        .await;
    let call = match call {
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

/// `lookupCrmUrl(env)` with the request's settings, for the webhook.
pub(crate) fn tool_url_for(env: Option<&weldsuite_kit::RequestEnv>) -> String {
    call_api_url(env, LOOKUP_CRM_PATH)
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
