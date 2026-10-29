//! `routes/helpdesk-integrations/index.ts`: the WeldDesk Discord and Slack
//! channel integrations at `/api/helpdesk-integrations`, over
//! `helpdesk_channel_integrations` (`@weldsuite/desk-domain/helpdesk-integrations`).
//! Reads take `settings:read`, writes `settings:update`; every handler
//! first needs a workspace (`ORG_REQUIRED`). No entity events, as in
//! TypeScript.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, generate_id, random_string};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::DynCache;

use super::{Ctx, Urls, discord_guild_id, form_encode, js_number, json_object, kv_delete, kv_put, or_value, org_required, providers, sanitized, truthy};
use crate::js::query_param;
use crate::tables::HELPDESK_CHANNEL_INTEGRATIONS as HCI;
use crate::{DeskState, now, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::SETTINGS_READ.to_owned()]);
    let update = || gate.require([perm::SETTINGS_UPDATE.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/token", post(save_token).route_layer(update()))
        .route("/discord/connect", post(discord_connect).route_layer(update()))
        .route("/discord/servers", get(discord_servers).route_layer(read()))
        .route("/discord/settings", get(discord_settings).route_layer(read()))
        .route("/discord/settings", put(update_discord_settings).route_layer(update()))
        .route("/discord/channels", get(discord_channels).route_layer(read()))
        .route("/discord/ticket-panel", post(ticket_panel).route_layer(update()))
        .route("/discord/send", post(discord_send).route_layer(update()))
        .route("/slack/connect", post(slack_connect).route_layer(update()))
        .route("/slack/settings", get(slack_settings).route_layer(read()))
        .route("/slack/settings", put(update_slack_settings).route_layer(update()))
        .route("/slack/channels", get(slack_channels).route_layer(read()))
        .route("/slack/test", post(slack_test).route_layer(read()))
        .route("/{id}/test", post(provider_test).route_layer(read()))
        .route("/{id}/refresh", post(refresh).route_layer(update()))
        .route("/{id}", delete(disconnect).route_layer(update()))
        .route("/{id}", get(by_provider).route_layer(read()))
}

// ── rows ──────────────────────────────────────────────────────────────────────

async fn rows(db: &PgPool, sql: &'static str, bind: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(sql).bind(bind).fetch_all(db).await?;
    Ok(rows.into_iter().map(|row| HCI.js(row)).collect())
}

/// `listIntegrations`: every live one, newest first.
async fn list_all(db: &PgPool) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from helpdesk_channel_integrations t where t.deleted_at is null order by t.created_at desc",
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|row| HCI.js(row)).collect())
}

/// `findIntegrationByProvider`: the first live one (no order, as in TypeScript).
async fn by_provider_row(db: &PgPool, provider: &str) -> Result<Option<Value>, sqlx::Error> {
    Ok(rows(
        db,
        "select to_jsonb(t) from helpdesk_channel_integrations t where t.provider = $1 and t.deleted_at is null limit 1",
        provider,
    )
    .await?
    .into_iter()
    .next())
}

/// `listIntegrationsByProvider`: newest first.
async fn list_by_provider(db: &PgPool, provider: &str) -> Result<Vec<Value>, sqlx::Error> {
    rows(
        db,
        "select to_jsonb(t) from helpdesk_channel_integrations t where t.provider = $1 and t.deleted_at is null order by t.created_at desc",
        provider,
    )
    .await
}

/// `findIntegrationById`.
async fn by_id(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    Ok(rows(
        db,
        "select to_jsonb(t) from helpdesk_channel_integrations t where t.id = $1 and t.deleted_at is null limit 1",
        id,
    )
    .await?
    .into_iter()
    .next())
}

/// `findIntegrationByIdOrProvider`.
async fn by_id_or_provider(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    match by_id(db, id).await? {
        Some(row) => Ok(Some(row)),
        None => by_provider_row(db, id).await,
    }
}

/// `resolveDiscordIntegration(db, integrationId)`.
async fn resolve_discord(db: &PgPool, integration_id: Option<&str>) -> Result<Option<Value>, sqlx::Error> {
    if let Some(id) = integration_id.filter(|id| !id.is_empty()) {
        return Ok(by_id(db, id).await?.filter(|row| row["provider"] == "discord"));
    }
    by_provider_row(db, "discord").await
}

/// `integrationConfig(row)`.
fn config_of(row: &Value) -> Map<String, Value> {
    row["config"].as_object().cloned().unwrap_or_default()
}

fn row_id(row: &Value) -> &str {
    row["id"].as_str().unwrap_or_default()
}

/// `accountInfo?.name || row.name || fallback`.
fn guild_name(row: &Value, fallback: &str) -> Value {
    or_value(&row["accountInfo"]["name"], or_value(&row["name"], json!(fallback)))
}

async fn set_config(db: &PgPool, id: &str, config: &Map<String, Value>) -> Result<(), sqlx::Error> {
    sqlx::query("update helpdesk_channel_integrations set config = $2, updated_at = $3::timestamp where id = $1")
        .bind(id)
        .bind(Value::Object(config.clone()))
        .bind(now())
        .execute(db)
        .await?;
    Ok(())
}

/// `syncDiscordGuildKv`: best effort.
async fn sync_guild(kv: Option<&Arc<dyn DynCache>>, org_id: &str, row: &Value) {
    let Some(guild) = discord_guild_id(row) else {
        return;
    };
    let value = json_object(&[("clerkOrgId", Some(&json!(org_id)))]);
    if let Err(error) = kv_put(kv, &format!("discord_guild:{guild}"), &value, None).await {
        tracing::error!(%error, "[app-api/helpdesk-integrations] Failed to sync discord_guild KV");
    }
}

/// `error.internal(c, message)` with the error logged.
fn internal(scope: &str, error: impl std::fmt::Display, message: Option<&str>) -> Response {
    tracing::error!(%error, "[app-api/helpdesk-integrations] {scope}");
    let error = ApiError::internal();
    match message {
        Some(message) => error.with_message(message).into_response(),
        None => error.into_response(),
    }
}

fn urls(ctx: &Ctx) -> Urls {
    Urls {
        environment: ctx.caller.env("ENVIRONMENT"),
        worker_override: ctx.caller.env("APP_API_PUBLIC_URL"),
        app_override: ctx.caller.env("PUBLIC_APP_URL"),
    }
}

// ── GET / and GET /:provider ──────────────────────────────────────────────────

async fn list(ctx: Ctx) -> Response {
    if ctx.org_id.is_none() {
        return org_required();
    }
    match list_all(&ctx.caller.db).await {
        Ok(rows) => {
            let integrations: Vec<Value> = rows.iter().map(|row| Value::Object(sanitized(row))).collect();
            Data(json!({ "integrations": integrations })).into_response()
        }
        Err(error) => internal("List error", error, None),
    }
}

async fn by_provider(ctx: Ctx, Path(provider): Path<String>) -> Response {
    if ctx.org_id.is_none() {
        return org_required();
    }
    match by_provider_row(&ctx.caller.db, &provider).await {
        Ok(Some(row)) => Data(Value::Object(sanitized(&row))).into_response(),
        Ok(None) => ApiError::not_found("Integration", Some(&provider)).into_response(),
        Err(error) => internal("Get error", error, None),
    }
}

// ── POST /token ───────────────────────────────────────────────────────────────

struct TokenBody {
    provider: String,
    token: String,
    config: Option<Map<String, Value>>,
}

fn token_schema(issues: &mut Issues, body: &Map<String, Value>) -> TokenBody {
    let provider = issues.text(body, "provider", Presence::Required, Some(1), None).into_option();
    let token = issues.text(body, "token", Presence::Required, Some(1), None).into_option();
    let config = issues.nested(body, "config", Presence::Optional, |_, fields| fields.clone()).into_option();
    TokenBody { provider: provider.unwrap_or_default(), token: token.unwrap_or_default(), config }
}

/// `provider.charAt(0).toUpperCase() + provider.slice(1)`.
fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

async fn save_token(ctx: Ctx, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, token_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Internal server error"),
    };
    if ctx.org_id.is_none() {
        return org_required();
    }
    let db = &ctx.caller.db;
    let existing = match by_provider_row(db, &data.provider).await {
        Ok(existing) => existing,
        Err(error) => return internal("Save token error", error, None),
    };
    let now = now();
    if let Some(existing) = existing {
        let config = data.config.map_or_else(|| existing["config"].clone(), Value::Object);
        let updated = sqlx::query(
            "update helpdesk_channel_integrations set access_token = $2, status = 'connected', config = $3,
             updated_at = $4::timestamp, last_sync_at = $4::timestamp, error_message = null where id = $1",
        )
        .bind(row_id(&existing))
        .bind(&data.token)
        .bind(config)
        .bind(&now)
        .execute(db)
        .await;
        if let Err(error) = updated {
            return internal("Save token error", error, None);
        }
        let mut answer = sanitized(&existing);
        answer.insert("status".to_owned(), json!("connected"));
        return Data(Value::Object(answer)).into_response();
    }
    let id = generate_id("chi");
    let inserted = sqlx::query(
        "insert into helpdesk_channel_integrations
           (id, provider, status, name, access_token, config, last_sync_at, created_at, updated_at)
         values ($1, $2, 'connected', $3, $4, $5, $6::timestamp, $6::timestamp, $6::timestamp)",
    )
    .bind(&id)
    .bind(&data.provider)
    .bind(capitalized(&data.provider))
    .bind(&data.token)
    .bind(Value::Object(data.config.unwrap_or_default()))
    .bind(&now)
    .execute(db)
    .await;
    if let Err(error) = inserted {
        return internal("Save token error", error, None);
    }
    Created(json!({ "id": id, "provider": data.provider, "status": "connected" })).into_response()
}

// ── the OAuth starts ──────────────────────────────────────────────────────────

/// `crypto.randomUUID()`.
fn random_uuid() -> String {
    let hex = random_string(32, "0123456789abcdef");
    let variant = ["8", "9", "a", "b"][usize::from(hex.as_bytes()[16] % 4)];
    format!("{}-{}-4{}-{variant}{}-{}", &hex[..8], &hex[8..12], &hex[13..16], &hex[17..20], &hex[20..32])
}

/// `beginOAuth`: a one-time state nonce in KV, carrying the caller's origin.
async fn begin_oauth(ctx: &Ctx, state: &DeskState, headers: &HeaderMap, provider: &str, org_id: &str) -> Result<String, String> {
    let nonce = random_uuid();
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).filter(|v| !v.is_empty());
    let caller_origin = header("origin").map_or_else(
        || {
            header("referer").map_or_else(String::new, |referer| match referer.rfind('/') {
                Some(at) => referer[..at].to_owned(),
                None => referer.to_owned(),
            })
        },
        str::to_owned,
    );
    let value = json_object(&[
        ("orgId", Some(&json!(org_id))),
        ("userId", Some(&json!(ctx.caller.user_id))),
        ("callerOrigin", Some(&json!(caller_origin))),
    ]);
    kv_put(ctx.kv(state).as_ref(), &format!("{provider}_oauth_state:{nonce}"), &value, Some(300)).await?;
    Ok(nonce)
}

async fn discord_connect(State(state): State<DeskState>, ctx: Ctx, headers: HeaderMap) -> Response {
    let Some(org_id) = ctx.org_id.clone() else {
        return org_required();
    };
    let Some(client_id) = ctx.caller.env("DISCORD_CLIENT_ID").filter(|c| !c.is_empty()) else {
        return ApiError::internal().with_message("Discord client ID not configured").into_response();
    };
    match begin_oauth(&ctx, &state, &headers, "discord", &org_id).await {
        Ok(nonce) => {
            let params = form_encode(&[
                ("client_id", &client_id),
                ("redirect_uri", &urls(&ctx).redirect_uri("discord")),
                ("response_type", "code"),
                ("scope", "identify bot guilds"),
                ("permissions", "360844446720"),
                ("state", &nonce),
            ]);
            Data(json!({ "authUrl": format!("https://discord.com/oauth2/authorize?{params}") })).into_response()
        }
        Err(error) => internal("Discord connect error", error, None),
    }
}

async fn slack_connect(State(state): State<DeskState>, ctx: Ctx, headers: HeaderMap) -> Response {
    let Some(org_id) = ctx.org_id.clone() else {
        return org_required();
    };
    let Some(client_id) = ctx.caller.env("SLACK_CLIENT_ID").filter(|c| !c.is_empty()) else {
        return ApiError::internal().with_message("Slack client ID not configured").into_response();
    };
    match begin_oauth(&ctx, &state, &headers, "slack", &org_id).await {
        Ok(nonce) => {
            let params = form_encode(&[
                ("client_id", &client_id),
                ("redirect_uri", &urls(&ctx).redirect_uri("slack")),
                (
                    "scope",
                    "channels:history,channels:read,chat:write,im:history,im:read,im:write,users:read,users:read.email",
                ),
                ("state", &nonce),
            ]);
            Data(json!({ "authUrl": format!("https://slack.com/oauth/v2/authorize?{params}") })).into_response()
        }
        Err(error) => internal("Slack connect error", error, None),
    }
}

// ── Discord ───────────────────────────────────────────────────────────────────

async fn discord_servers(State(state): State<DeskState>, ctx: Ctx) -> Response {
    let Some(org_id) = ctx.org_id.clone() else {
        return org_required();
    };
    let rows = match list_by_provider(&ctx.caller.db, "discord").await {
        Ok(rows) => rows,
        Err(error) => return internal("List Discord servers error", error, None),
    };
    let kv = ctx.kv(&state);
    for row in &rows {
        sync_guild(kv.as_ref(), &org_id, row).await;
    }
    let servers: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut safe = sanitized(row);
            safe.insert("guildId".to_owned(), discord_guild_id(row).map_or(Value::Null, Value::String));
            safe.insert("guildName".to_owned(), guild_name(row, "Discord Server"));
            Value::Object(safe)
        })
        .collect();
    Data(json!({ "servers": servers })).into_response()
}

/// `projectDiscordSettings(config)`.
fn discord_view(config: &Map<String, Value>) -> Map<String, Value> {
    let get = |key: &str| config.get(key).cloned().unwrap_or(Value::Null);
    let nullish = |key: &str, fallback: bool| {
        let value = get(key);
        if value.is_null() { json!(fallback) } else { value }
    };
    let mut view = Map::new();
    view.insert("supportChannels".to_owned(), or_value(&get("supportChannels"), json!([])));
    view.insert("processDirectMessages".to_owned(), nullish("processDirectMessages", false));
    view.insert("ignoreBots".to_owned(), nullish("ignoreBots", true));
    for key in ["supportPrefix", "autoReplyMessage", "botDisplayName", "botAvatarUrl"] {
        view.insert(key.to_owned(), or_value(&get(key), json!("")));
    }
    view.insert("ticketPanel".to_owned(), or_value(&get("ticketPanel"), Value::Null));
    view
}

async fn discord_settings(State(state): State<DeskState>, ctx: Ctx, RawQuery(query): RawQuery) -> Response {
    let Some(org_id) = ctx.org_id.clone() else {
        return org_required();
    };
    let integration_id = query_param(query.as_deref(), "integrationId");
    let integration = match resolve_discord(&ctx.caller.db, integration_id.as_deref()).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Discord integration", None).into_response(),
        Err(error) => return internal("Get Discord settings error", error, None),
    };
    sync_guild(ctx.kv(&state).as_ref(), &org_id, &integration).await;
    let mut view = discord_view(&config_of(&integration));
    view.insert("integrationId".to_owned(), integration["id"].clone());
    view.insert("guildId".to_owned(), discord_guild_id(&integration).map_or(Value::Null, Value::String));
    view.insert("guildName".to_owned(), guild_name(&integration, "Discord Server"));
    Data(Value::Object(view)).into_response()
}

fn support_channel(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let before = issues.count();
    let channel_id = issues.text(fields, "channelId", Presence::Required, None, None);
    let channel_name = issues.text(fields, "channelName", Presence::Optional, None, None);
    let enabled = issues.boolean(fields, "enabled", Presence::Required);
    if issues.count() > before {
        return None;
    }
    let mut out = Map::new();
    out.insert("channelId".to_owned(), json!(channel_id.into_option()));
    if let Some(name) = channel_name.into_option() {
        out.insert("channelName".to_owned(), json!(name));
    }
    out.insert("enabled".to_owned(), json!(enabled.into_option()));
    Some(Value::Object(out))
}

/// The ticket panel's fields after `channelId` (and `channelName`), with
/// their defaults; `button_style` keeps the number as sent.
fn panel_fields(issues: &mut Issues, fields: &Map<String, Value>, out: &mut Map<String, Value>) {
    let text = |issues: &mut Issues, key: &str, max: Option<usize>, default: &str| {
        issues
            .text(fields, key, Presence::Optional, None, max)
            .into_option()
            .unwrap_or_else(|| default.to_owned())
    };
    let title = text(issues, "embedTitle", Some(256), "Support Tickets");
    let description = text(issues, "embedDescription", Some(4096), "Click the button below to open a support ticket.");
    let color = text(issues, "embedColor", None, "#5865F2");
    let button = text(issues, "buttonText", Some(80), "Open a Ticket");
    let style = issues
        .number(fields, "buttonStyle", Presence::Optional, Number { min: Some(1.0), max: Some(4.0), ..Number::default() })
        .into_option()
        .map_or(json!(1), js_number);
    out.insert("embedTitle".to_owned(), json!(title));
    out.insert("embedDescription".to_owned(), json!(description));
    out.insert("embedColor".to_owned(), json!(color));
    out.insert("buttonText".to_owned(), json!(button));
    out.insert("buttonStyle".to_owned(), style);
}

fn ticket_panel_schema(issues: &mut Issues, fields: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let channel_id = issues.text(fields, "channelId", Presence::Required, None, None);
    out.insert("channelId".to_owned(), json!(channel_id.into_option()));
    if let Some(name) = issues.text(fields, "channelName", Presence::Optional, None, None).into_option() {
        out.insert("channelName".to_owned(), json!(name));
    }
    panel_fields(issues, fields, &mut out);
    if let Some(message) = issues.text(fields, "messageId", Presence::Optional, None, None).into_option() {
        out.insert("messageId".to_owned(), json!(message));
    }
    out
}

/// `z.string().url().optional().or(z.literal(''))`: a failing `.url()` is
/// a dirty result, so its own issue is reported, not the union's.
fn avatar_url(issues: &mut Issues, body: &Map<String, Value>) -> Option<String> {
    match body.get("botAvatarUrl") {
        None => None,
        Some(Value::String(text)) if text.is_empty() => Some(String::new()),
        Some(Value::String(_)) => issues
            .text_with(body, "botAvatarUrl", Presence::Optional, Text { format: Some(Format::Url), ..Text::default() })
            .into_option(),
        Some(other) => {
            let received = match other {
                Value::Null => "null",
                Value::Bool(_) => "boolean",
                Value::Number(_) => "number",
                Value::Array(_) => "array",
                _ => "object",
            };
            let path = issues.path_of("botAvatarUrl");
            issues.push_issue(
                "botAvatarUrl",
                json!({
                    "code": "invalid_union",
                    "unionErrors": [
                        { "issues": [{ "code": "invalid_type", "expected": "string", "received": received, "path": path, "message": format!("Expected string, received {received}") }], "name": "ZodError" },
                        { "issues": [{ "received": other, "code": "invalid_literal", "expected": "", "path": path, "message": "Invalid literal value, expected \"\"" }], "name": "ZodError" },
                    ],
                    "message": "Invalid input",
                }),
            );
            None
        }
    }
}

struct DiscordSettings {
    integration_id: Option<String>,
    /// The provided settings, as `mergeDiscordSettings` overlays them.
    changes: Map<String, Value>,
    bot_display_name: Option<String>,
    bot_avatar_url: Option<String>,
}

fn discord_settings_schema(issues: &mut Issues, body: &Map<String, Value>) -> DiscordSettings {
    let integration_id = issues.text(body, "integrationId", Presence::Optional, None, None).into_option();
    let mut changes = Map::new();
    if let Field::Set(channels) = issues.list(body, "supportChannels", Presence::Optional, None, None, support_channel) {
        changes.insert("supportChannels".to_owned(), Value::Array(channels));
    }
    for key in ["processDirectMessages", "ignoreBots"] {
        if let Field::Set(flag) = issues.boolean(body, key, Presence::Optional) {
            changes.insert(key.to_owned(), json!(flag));
        }
    }
    for key in ["supportPrefix", "autoReplyMessage"] {
        if let Some(text) = issues.text(body, key, Presence::Optional, None, None).into_option() {
            changes.insert(key.to_owned(), json!(text));
        }
    }
    let bot_display_name = issues.text(body, "botDisplayName", Presence::Optional, None, Some(80)).into_option();
    if let Some(name) = &bot_display_name {
        changes.insert("botDisplayName".to_owned(), json!(name));
    }
    let bot_avatar_url = avatar_url(issues, body);
    if let Some(url) = &bot_avatar_url {
        changes.insert("botAvatarUrl".to_owned(), json!(url));
    }
    if let Field::Set(panel) = issues.nested(body, "ticketPanel", Presence::Optional, ticket_panel_schema) {
        changes.insert("ticketPanel".to_owned(), Value::Object(panel));
    }
    DiscordSettings { integration_id, changes, bot_display_name, bot_avatar_url }
}

/// The nickname and the avatar, pushed to Discord; failures are logged.
async fn push_bot_profile(ctx: &Ctx, state: &DeskState, integration: &Value, current: &Map<String, Value>, data: &DiscordSettings) {
    let token = ctx.caller.env("DISCORD_BOT_TOKEN").filter(|t| !t.is_empty());
    let http = ctx.http(state);
    if let Some(name) = &data.bot_display_name
        && let (Some(token), Some(guild)) = (token.as_deref(), discord_guild_id(integration))
        && let Err(error) = providers::set_nickname(http.as_ref(), token, &guild, name).await
    {
        tracing::error!(%error, "[app-api/helpdesk-integrations] Failed to update bot nickname");
    }
    if let Some(url) = &data.bot_avatar_url {
        let previous = current.get("botAvatarUrl").filter(|v| truthy(v)).and_then(Value::as_str).unwrap_or_default();
        let Some(token) = token.as_deref() else { return };
        if previous == url {
            return;
        }
        let avatar = (!url.is_empty()).then_some(url.as_str());
        if let Err(error) = providers::set_avatar(ctx.bytes_http().as_ref(), http.as_ref(), token, avatar).await {
            tracing::error!(%error, "[app-api/helpdesk-integrations] Failed to update bot avatar");
        }
    }
}

async fn update_discord_settings(State(state): State<DeskState>, ctx: Ctx, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, discord_settings_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Internal server error"),
    };
    let Some(org_id) = ctx.org_id.clone() else {
        return org_required();
    };
    let db = &ctx.caller.db;
    let integration = match resolve_discord(db, data.integration_id.as_deref()).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Discord integration", None).into_response(),
        Err(error) => return internal("Update Discord settings error", error, None),
    };
    let current = config_of(&integration);
    let mut updated = current.clone();
    for (key, value) in &data.changes {
        updated.insert(key.clone(), value.clone());
    }
    if let Err(error) = set_config(db, row_id(&integration), &updated).await {
        return internal("Update Discord settings error", error, None);
    }
    sync_guild(ctx.kv(&state).as_ref(), &org_id, &integration).await;
    push_bot_profile(&ctx, &state, &integration, &current, &data).await;
    let mut view = discord_view(&updated);
    view.insert("integrationId".to_owned(), integration["id"].clone());
    view.insert("guildId".to_owned(), discord_guild_id(&integration).map_or(Value::Null, Value::String));
    Data(Value::Object(view)).into_response()
}

/// `mergeChannelEnabledState(providerChannels, config)`.
fn merge_channels(provider: &[Value], config: &Map<String, Value>) -> Vec<Value> {
    let configured = or_value(config.get("supportChannels").unwrap_or(&Value::Null), json!([]));
    let mut enabled: Vec<(Value, Value)> = Vec::new();
    for channel in configured.as_array().into_iter().flatten() {
        let key = channel["channelId"].clone();
        let value = channel["enabled"].clone();
        if let Some(entry) = enabled.iter_mut().find(|(k, _)| *k == key) {
            entry.1 = value;
        } else {
            enabled.push((key, value));
        }
    }
    provider
        .iter()
        .map(|channel| {
            let state = enabled
                .iter()
                .find(|(k, _)| *k == channel["id"])
                .map(|(_, v)| v.clone())
                .filter(|v| !v.is_null())
                .unwrap_or(json!(false));
            json!({ "channelId": channel["id"], "channelName": channel["name"], "enabled": state })
        })
        .collect()
}

async fn discord_channels(State(state): State<DeskState>, ctx: Ctx, RawQuery(query): RawQuery) -> Response {
    if ctx.org_id.is_none() {
        return org_required();
    }
    let Some(token) = ctx.caller.env("DISCORD_BOT_TOKEN").filter(|t| !t.is_empty()) else {
        return ApiError::internal().with_message("Discord bot token not configured").into_response();
    };
    let integration_id = query_param(query.as_deref(), "integrationId");
    let integration = match resolve_discord(&ctx.caller.db, integration_id.as_deref()).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Discord integration", None).into_response(),
        Err(error) => return internal("Get Discord channels error", error, None),
    };
    let Some(guild) = discord_guild_id(&integration) else {
        return ApiError::bad_request("No guild connected").into_response();
    };
    let channels = match providers::guild_channels(ctx.http(&state).as_ref(), &token, &guild).await {
        Ok(channels) => channels,
        Err(error) => return internal("Get Discord channels error", error, None),
    };
    Data(json!({
        "integrationId": integration["id"],
        "guildId": guild,
        "guildName": guild_name(&integration, "Unknown"),
        "channels": merge_channels(&channels, &config_of(&integration)),
    }))
    .into_response()
}

struct PanelRequest {
    integration_id: Option<String>,
    panel: Map<String, Value>,
}

fn panel_request_schema(issues: &mut Issues, body: &Map<String, Value>) -> PanelRequest {
    let integration_id = issues.text(body, "integrationId", Presence::Optional, None, None).into_option();
    let mut panel = Map::new();
    let channel_id = issues.text(body, "channelId", Presence::Required, Some(1), None);
    panel.insert("channelId".to_owned(), json!(channel_id.into_option()));
    if let Some(name) = issues.text(body, "channelName", Presence::Optional, None, None).into_option() {
        panel.insert("channelName".to_owned(), json!(name));
    }
    panel_fields(issues, body, &mut panel);
    PanelRequest { integration_id, panel }
}

/// `Number.parseInt(text, 16)`: `None` for `NaN`.
fn parse_hex(text: &str) -> Option<i64> {
    let rest = weldsuite_kit::validation::js_trim(text);
    let (negative, rest) = match rest.as_bytes().first() {
        Some(b'-') => (true, &rest[1..]),
        Some(b'+') => (false, &rest[1..]),
        _ => (false, rest),
    };
    let rest = rest.strip_prefix("0x").or_else(|| rest.strip_prefix("0X")).unwrap_or(rest);
    let digits = &rest[..rest.bytes().take_while(u8::is_ascii_hexdigit).count()];
    if digits.is_empty() {
        return None;
    }
    let value = i64::from_str_radix(&digits[..digits.len().min(15)], 16).ok()?;
    Some(if negative { -value } else { value })
}

async fn ticket_panel(State(state): State<DeskState>, ctx: Ctx, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to post ticket panel";
    let data = match validate(&headers, &body, panel_request_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let Some(org_id) = ctx.org_id.clone() else {
        return org_required();
    };
    let Some(token) = ctx.caller.env("DISCORD_BOT_TOKEN").filter(|t| !t.is_empty()) else {
        return ApiError::internal().with_message("Discord bot token not configured").into_response();
    };
    let db = &ctx.caller.db;
    let integration = match resolve_discord(db, data.integration_id.as_deref()).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Discord integration", None).into_response(),
        Err(error) => return internal("Post ticket panel error", error, Some(FAILED)),
    };
    let panel = &data.panel;
    let color_text = panel["embedColor"].as_str().unwrap_or_default().replacen('#', "", 1);
    let color = parse_hex(&color_text).filter(|c| *c != 0).unwrap_or(0x0058_65f2);
    let message = json!({
        "embeds": [{ "title": panel["embedTitle"], "description": panel["embedDescription"], "color": color }],
        "components": [{
            "type": 1,
            "components": [{ "type": 2, "style": panel["buttonStyle"], "label": panel["buttonText"], "custom_id": "open_ticket" }],
        }],
    });
    let channel_id = panel["channelId"].as_str().unwrap_or_default();
    let sent = match providers::post_message(ctx.http(&state).as_ref(), &token, channel_id, &message).await {
        Ok(sent) => sent,
        Err(error) => return internal("Post ticket panel error", error, Some(FAILED)),
    };
    let mut ticket_panel = panel.clone();
    ticket_panel.insert("messageId".to_owned(), sent["id"].clone());
    let mut config = config_of(&integration);
    config.insert("ticketPanel".to_owned(), Value::Object(ticket_panel.clone()));
    if let Err(error) = set_config(db, row_id(&integration), &config).await {
        return internal("Post ticket panel error", error, Some(FAILED));
    }
    sync_guild(ctx.kv(&state).as_ref(), &org_id, &integration).await;
    Data(json!({ "messageId": sent["id"], "ticketPanel": ticket_panel, "integrationId": integration["id"] })).into_response()
}

fn send_schema(issues: &mut Issues, body: &Map<String, Value>) -> (String, String) {
    let channel = issues.text(body, "channelId", Presence::Required, Some(1), None).into_option();
    let content = issues.text(body, "content", Presence::Required, Some(1), None).into_option();
    let _ = issues.text(body, "conversationId", Presence::Optional, None, None);
    (channel.unwrap_or_default(), content.unwrap_or_default())
}

async fn discord_send(State(state): State<DeskState>, ctx: Ctx, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to send Discord message";
    let (channel, content) = match validate(&headers, &body, send_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    if ctx.org_id.is_none() {
        return org_required();
    }
    let Some(token) = ctx.caller.env("DISCORD_BOT_TOKEN").filter(|t| !t.is_empty()) else {
        return ApiError::internal().with_message("Discord bot token not configured").into_response();
    };
    let sent = match providers::post_message(ctx.http(&state).as_ref(), &token, &channel, &json!({ "content": content })).await {
        Ok(sent) => sent,
        Err(error) => return internal("Send Discord message error", error, Some(FAILED)),
    };
    let db = &ctx.caller.db;
    match by_provider_row(db, "discord").await {
        Ok(Some(integration)) => {
            let stamped = sqlx::query(
                "update helpdesk_channel_integrations set last_sync_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
            )
            .bind(row_id(&integration))
            .bind(now())
            .execute(db)
            .await;
            if let Err(error) = stamped {
                return internal("Send Discord message error", error, Some(FAILED));
            }
        }
        Ok(None) => {}
        Err(error) => return internal("Send Discord message error", error, Some(FAILED)),
    }
    Data(json!({ "success": true, "messageId": sent["id"], "message": "Message sent" })).into_response()
}

// ── Slack ─────────────────────────────────────────────────────────────────────

/// `projectSlackSettings(config)`.
fn slack_view(config: &Map<String, Value>) -> Value {
    let ignore = config.get("ignoreBots").cloned().filter(|v| !v.is_null()).unwrap_or(json!(true));
    json!({
        "supportChannels": or_value(config.get("supportChannels").unwrap_or(&Value::Null), json!([])),
        "ignoreBots": ignore,
    })
}

async fn slack_row(ctx: &Ctx, scope: &str) -> Result<Value, Response> {
    match by_provider_row(&ctx.caller.db, "slack").await {
        Ok(Some(row)) => Ok(row),
        Ok(None) => Err(ApiError::not_found("Slack integration", None).into_response()),
        Err(error) => Err(internal(scope, error, None)),
    }
}

async fn slack_settings(ctx: Ctx) -> Response {
    if ctx.org_id.is_none() {
        return org_required();
    }
    match slack_row(&ctx, "Get Slack settings error").await {
        Ok(row) => Data(slack_view(&config_of(&row))).into_response(),
        Err(response) => response,
    }
}

fn slack_settings_schema(issues: &mut Issues, body: &Map<String, Value>) -> (Option<Vec<Value>>, Option<bool>) {
    let channels = issues.list(body, "supportChannels", Presence::Optional, None, None, support_channel).into_option();
    let ignore = issues.boolean(body, "ignoreBots", Presence::Optional).into_option();
    (channels, ignore)
}

async fn update_slack_settings(ctx: Ctx, headers: HeaderMap, body: Bytes) -> Response {
    let (channels, ignore) = match validate(&headers, &body, slack_settings_schema) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Internal server error"),
    };
    if ctx.org_id.is_none() {
        return org_required();
    }
    let row = match slack_row(&ctx, "Update Slack settings error").await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let mut config = config_of(&row);
    // `{ ...current, key: data.key ?? current.key }`: an undefined value is
    // left out of the stored JSON.
    let channels = channels.map(Value::Array).or_else(|| config.get("supportChannels").cloned());
    let ignore = ignore.map(Value::Bool).or_else(|| config.get("ignoreBots").cloned());
    for (key, value) in [("supportChannels", channels), ("ignoreBots", ignore)] {
        match value {
            Some(value) => {
                config.insert(key.to_owned(), value);
            }
            None => {
                config.remove(key);
            }
        }
    }
    if let Err(error) = set_config(&ctx.caller.db, row_id(&row), &config).await {
        return internal("Update Slack settings error", error, None);
    }
    Data(slack_view(&config)).into_response()
}

/// `slackBotToken(row)`, when truthy.
fn slack_token(row: &Value) -> Option<Value> {
    row["config"].get("botToken").filter(|t| truthy(t)).cloned()
}

/// A token value as the string a template literal makes of it.
fn token_text(token: &Value) -> String {
    token.as_str().map_or_else(|| token.to_string(), str::to_owned)
}

async fn slack_channels(State(state): State<DeskState>, ctx: Ctx) -> Response {
    if ctx.org_id.is_none() {
        return org_required();
    }
    let row = match slack_row(&ctx, "Get Slack channels error").await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let Some(token) = slack_token(&row) else {
        return ApiError::bad_request("No bot token configured").into_response();
    };
    let result = match providers::slack_channels(ctx.http(&state).as_ref(), &token_text(&token)).await {
        Ok(result) => result,
        Err(error) => return internal("Get Slack channels error", error, None),
    };
    if !truthy(&result["ok"]) {
        let error = js_text(&result["error"]);
        tracing::error!("[app-api/helpdesk-integrations] Slack channels error: {error}");
        return ApiError::internal().with_message(format!("Slack API error: {error}")).into_response();
    }
    let channels: Vec<Value> = or_value(&result["channels"], json!([])).as_array().cloned().unwrap_or_default();
    Data(json!({
        "teamName": or_value(&row["accountInfo"]["name"], json!("Slack Workspace")),
        "channels": merge_channels(&channels, &config_of(&row)),
    }))
    .into_response()
}

/// `${value}` in a template literal.
fn js_text(value: &Value) -> String {
    match value {
        Value::Null => "undefined".to_owned(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

async fn slack_test(State(state): State<DeskState>, ctx: Ctx) -> Response {
    if ctx.org_id.is_none() {
        return org_required();
    }
    let row = match slack_row(&ctx, "Slack test error").await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let Some(token) = slack_token(&row) else {
        return ApiError::bad_request("No bot token configured").into_response();
    };
    match providers::slack_auth_test(ctx.http(&state).as_ref(), &token_text(&token)).await {
        Ok(result) if !truthy(&result["ok"]) => Data(json!({
            "success": false,
            "message": format!("Slack API error: {}", js_text(&result["error"])),
        }))
        .into_response(),
        Ok(result) => {
            let mut details = Map::new();
            for (key, from) in [("botId", "user_id"), ("teamName", "team")] {
                if let Some(value) = result.get(from) {
                    details.insert(key.to_owned(), value.clone());
                }
            }
            Data(json!({ "success": true, "message": "Connection is working", "details": details })).into_response()
        }
        Err(error) => Data(json!({ "success": false, "message": error })).into_response(),
    }
}

// ── POST /:provider/test ──────────────────────────────────────────────────────

async fn provider_test(State(state): State<DeskState>, ctx: Ctx, Path(provider): Path<String>) -> Response {
    if ctx.org_id.is_none() {
        return org_required();
    }
    if provider == "discord" {
        let Some(token) = ctx.caller.env("DISCORD_BOT_TOKEN").filter(|t| !t.is_empty()) else {
            return Data(json!({ "success": false, "message": "Discord bot token not configured" })).into_response();
        };
        return match providers::bot_user(ctx.http(&state).as_ref(), &token).await {
            Ok(bot) => Data(json!({
                "success": true,
                "message": format!("Connected as {}", js_text(&bot["username"])),
                "details": { "botId": bot["id"], "botName": bot["username"] },
            }))
            .into_response(),
            Err(error) => {
                tracing::error!(%error, "[app-api/helpdesk-integrations] Test {provider} error");
                Data(json!({ "success": false, "message": error })).into_response()
            }
        };
    }
    match by_provider_row(&ctx.caller.db, &provider).await {
        Ok(Some(_)) => Data(json!({ "success": true, "message": format!("{provider} integration is connected") })).into_response(),
        Ok(None) => Data(json!({ "success": false, "message": format!("No {provider} integration found") })).into_response(),
        Err(error) => {
            tracing::error!(%error, "[app-api/helpdesk-integrations] Test {provider} error");
            Data(json!({ "success": false, "message": error.to_string() })).into_response()
        }
    }
}

// ── POST /:id/refresh ─────────────────────────────────────────────────────────

async fn refresh(State(state): State<DeskState>, ctx: Ctx, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to refresh token";
    if ctx.org_id.is_none() {
        return org_required();
    }
    let db = &ctx.caller.db;
    let integration = match by_id_or_provider(db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Integration", Some(&id)).into_response(),
        Err(error) => return internal("Refresh token error", error, Some(FAILED)),
    };
    if integration["provider"] != "discord" {
        return ApiError::bad_request(format!(
            "Token refresh not supported for {}",
            js_text(&integration["provider"])
        ))
        .into_response();
    }
    let client_id = ctx.caller.env("DISCORD_CLIENT_ID").filter(|c| !c.is_empty());
    let client_secret = ctx.caller.env("DISCORD_CLIENT_SECRET").filter(|c| !c.is_empty());
    let refresh_token = integration["refreshToken"].as_str().filter(|t| !t.is_empty()).map(str::to_owned);
    let (Some(client_id), Some(client_secret), Some(refresh_token)) = (client_id, client_secret, refresh_token) else {
        return ApiError::bad_request("Cannot refresh token — missing credentials").into_response();
    };
    let tokens = match providers::refresh_token(ctx.http(&state).as_ref(), &client_id, &client_secret, &refresh_token).await {
        Ok(tokens) => tokens,
        Err(error) => return internal("Refresh token error", error, Some(FAILED)),
    };
    let now_time = time::OffsetDateTime::now_utc();
    let Some(expires_in) = tokens["expires_in"].as_f64() else {
        return internal("Refresh token error", "Invalid time value", Some(FAILED));
    };
    #[allow(clippy::cast_possible_truncation)]
    let expires_at = now_time + time::Duration::milliseconds((expires_in * 1000.0) as i64);
    let now = weldsuite_events::iso_timestamp(now_time);
    let expires = weldsuite_events::iso_timestamp(expires_at);
    let updated = sqlx::query(
        "update helpdesk_channel_integrations set access_token = $2, refresh_token = $3, token_expires_at = $4::timestamp,
         status = 'connected', error_message = null, updated_at = $5::timestamp where id = $1",
    )
    .bind(row_id(&integration))
    .bind(tokens["access_token"].as_str())
    .bind(tokens["refresh_token"].as_str())
    .bind(&expires)
    .bind(&now)
    .execute(db)
    .await;
    if let Err(error) = updated {
        return internal("Refresh token error", error, Some(FAILED));
    }
    let mut answer = sanitized(&integration);
    answer.insert("status".to_owned(), json!("connected"));
    answer.insert("tokenExpiresAt".to_owned(), json!(expires));
    Data(Value::Object(answer)).into_response()
}

// ── DELETE /:id ───────────────────────────────────────────────────────────────

async fn disconnect(State(state): State<DeskState>, ctx: Ctx, Path(id): Path<String>) -> Response {
    if ctx.org_id.is_none() {
        return org_required();
    }
    let db = &ctx.caller.db;
    let integration = match by_id_or_provider(db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Integration", Some(&id)).into_response(),
        Err(error) => return internal("Delete error", error, None),
    };
    if integration["provider"] == "discord"
        && let Some(guild) = discord_guild_id(&integration)
        && let Err(error) = kv_delete(ctx.kv(&state).as_ref(), &format!("discord_guild:{guild}")).await
    {
        return internal("Delete error", error, None);
    }
    let now = now();
    let updated = sqlx::query(
        "update helpdesk_channel_integrations set deleted_at = $2::timestamp, status = 'disconnected', updated_at = $2::timestamp where id = $1",
    )
    .bind(row_id(&integration))
    .bind(&now)
    .execute(db)
    .await;
    if let Err(error) = updated {
        return internal("Delete error", error, None);
    }
    Data(json!({ "message": "Disconnected" })).into_response()
}
