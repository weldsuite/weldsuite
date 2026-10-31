//! `routes/integrations/helpdesk-oauth.ts`: the Discord and Slack OAuth
//! callbacks at `/api/integrations/helpdesk/{discord,slack}/callback`.
//! Public: the browser comes back from the provider without a session; the
//! one-time state nonce in `WORKSPACE_CACHE` (written by the `/connect`
//! routes) is the credential. Every outcome is a redirect.

use axum::Router;
use axum::extract::{RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::StatusCode;
use http::header::LOCATION;
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use super::{
    PublicCtx, PublicState, Urls, discord_guild_id, form_encode, json_object, kv_delete,
    kv_get_json, kv_put, providers, truthy,
};
use crate::js::query_param;
use crate::tables::HELPDESK_CHANNEL_INTEGRATIONS as HCI;

const DISCORD_SETTINGS_PATH: &str = "/settings/integrations/discord";
const SLACK_SETTINGS_PATH: &str = "/welddesk/settings/integrations/slack";

pub(super) fn routes() -> Router<PublicState> {
    Router::new()
        .route("/discord/callback", get(discord_callback))
        .route("/slack/callback", get(slack_callback))
}

/// `c.redirect(url)`.
fn redirect(url: &str) -> Response {
    (StatusCode::FOUND, [(LOCATION, url.to_owned())]).into_response()
}

/// `workspaceAppUrl(baseUrl, clerkOrgId, path)`: `{base}/w/{org}{path}`.
fn workspace_url(base: &str, org: Option<&str>, path: &str) -> String {
    let base = weldsuite_kit::validation::js_trim(base).trim_end_matches('/');
    let inner = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("/{path}")
    };
    match org.filter(|o| !o.is_empty()) {
        Some(org) => format!("{base}/w/{}{inner}", encode_uri_component(org)),
        None => format!("{base}{inner}"),
    }
}

/// `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = std::fmt::Write::write_fmt(&mut out, format_args!("%{byte:02X}"));
        }
    }
    out
}

fn urls(ctx: &PublicCtx) -> Urls {
    Urls {
        environment: ctx.env("ENVIRONMENT"),
        worker_override: ctx.env("APP_API_PUBLIC_URL"),
        app_override: ctx.env("PUBLIC_APP_URL"),
    }
}

/// The state the `/connect` route stored: `{ orgId, userId, callerOrigin }`.
struct StateData {
    org_id: String,
    caller_origin: Option<String>,
}

/// Read and spend the state nonce. `Ok(None)`: no such state.
async fn take_state(
    ctx: &PublicCtx,
    state: &PublicState,
    provider: &str,
    nonce: &str,
) -> Result<Option<StateData>, String> {
    let kv = ctx.kv(state);
    let key = format!("{provider}_oauth_state:{nonce}");
    let Some(data) = kv_get_json(kv.as_ref(), &key).await? else {
        return Ok(None);
    };
    if data.is_null() {
        return Ok(None);
    }
    kv_delete(kv.as_ref(), &key).await?;
    Ok(Some(StateData {
        org_id: js_text(&data["orgId"]),
        caller_origin: data["callerOrigin"]
            .as_str()
            .filter(|o| !o.is_empty())
            .map(str::to_owned),
    }))
}

fn js_text(value: &Value) -> String {
    match value {
        Value::Null => "undefined".to_owned(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `getWorkspaceForOrg(env, orgId)`: the workspace's id, from the master
/// database.
async fn workspace_id(
    ctx: &PublicCtx,
    state: &PublicState,
    reference: &str,
) -> Result<String, String> {
    let master = ctx.master(state).ok_or("no master database")?;
    let id: Option<String> =
        sqlx::query_scalar("select id from workspaces where id = $1 or clerk_org_id = $1 limit 1")
            .bind(reference)
            .fetch_optional(&master)
            .await
            .map_err(|error| error.to_string())?;
    id.ok_or_else(|| format!("Workspace not found: {reference}"))
}

// ── Discord ───────────────────────────────────────────────────────────────────

async fn discord_callback(
    State(state): State<PublicState>,
    ctx: PublicCtx,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.as_deref();
    let code = query_param(query, "code").filter(|c| !c.is_empty());
    let nonce = query_param(query, "state").filter(|s| !s.is_empty());
    let guild_param = query_param(query, "guild_id").filter(|g| !g.is_empty());
    let urls = urls(&ctx);
    let default_app = urls.app();
    let (Some(code), Some(nonce)) = (code, nonce) else {
        return redirect(&format!(
            "{default_app}{DISCORD_SETTINGS_PATH}?error=missing_params"
        ));
    };
    let mut app_url = default_app.clone();
    let mut state_org: Option<String> = None;
    let outcome = discord_flow(
        &ctx,
        &state,
        &urls,
        &code,
        &nonce,
        guild_param,
        &mut app_url,
        &mut state_org,
    )
    .await;
    match outcome {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "[app-api/integrations-helpdesk] Discord OAuth callback error");
            redirect(&workspace_url(
                &app_url,
                state_org.as_deref(),
                &format!("{DISCORD_SETTINGS_PATH}?error=callback_failed"),
            ))
        }
    }
}

#[allow(clippy::too_many_arguments)] // the route's locals, shared with its catch
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
async fn discord_flow(
    ctx: &PublicCtx,
    state: &PublicState,
    urls: &Urls,
    code: &str,
    nonce: &str,
    guild_param: Option<String>,
    app_url: &mut String,
    state_org: &mut Option<String>,
) -> Result<Response, String> {
    let default_app = urls.app();
    let Some(data) = take_state(ctx, state, "discord", nonce).await? else {
        return Ok(redirect(&format!(
            "{default_app}{DISCORD_SETTINGS_PATH}?error=invalid_state"
        )));
    };
    *app_url = data
        .caller_origin
        .clone()
        .unwrap_or_else(|| default_app.clone());
    let org = data.org_id.clone();
    *state_org = Some(org.clone());
    let page = |query: &str| {
        workspace_url(
            app_url,
            Some(&org),
            &format!("{DISCORD_SETTINGS_PATH}?{query}"),
        )
    };

    let client_id = ctx.env("DISCORD_CLIENT_ID").filter(|c| !c.is_empty());
    let client_secret = ctx.env("DISCORD_CLIENT_SECRET").filter(|c| !c.is_empty());
    let bot_token = ctx.env("DISCORD_BOT_TOKEN").filter(|c| !c.is_empty());
    let (Some(client_id), Some(client_secret)) = (client_id, client_secret) else {
        return Ok(redirect(&page("error=config_error")));
    };

    let http = ctx.http(state);
    let tokens = providers::exchange_code(
        http.as_ref(),
        &client_id,
        &client_secret,
        code,
        &urls.redirect_uri("discord"),
    )
    .await?;
    let guild = &tokens["guild"];
    let resolved = guild["id"]
        .as_str()
        .filter(|g| !g.is_empty())
        .map(str::to_owned)
        .or(guild_param);
    let mut guild_name = guild["name"]
        .as_str()
        .filter(|n| !n.is_empty())
        .unwrap_or("Discord Server")
        .to_owned();
    if let (Some(resolved), Some(bot_token)) = (&resolved, &bot_token)
        && let Ok(info) = providers::get_guild(http.as_ref(), bot_token, resolved).await
    {
        guild_name = js_text(&info["name"]);
    }
    let Some(resolved) = resolved else {
        return Ok(redirect(&page("error=missing_guild")));
    };

    let workspace = workspace_id(ctx, state, &org).await?;
    let db = ctx.tenant_db(state, &org).await?;
    let now_time = time::OffsetDateTime::now_utc();
    let expires_in = tokens["expires_in"].as_f64().ok_or("Invalid time value")?;
    #[allow(clippy::cast_possible_truncation)]
    let expires_at = now_time + time::Duration::milliseconds((expires_in * 1000.0) as i64);
    let now = weldsuite_events::iso_timestamp(now_time);
    let expires = weldsuite_events::iso_timestamp(expires_at);
    let account = json!({ "id": resolved, "name": guild_name, "metadata": { "guildId": resolved, "guildName": guild_name } });

    let existing = integration_for_guild(&db, &resolved)
        .await
        .map_err(|e| e.to_string())?;
    let integration_id = if let Some(existing) = existing {
        let id = existing["id"].as_str().unwrap_or_default().to_owned();
        sqlx::query(
            "update helpdesk_channel_integrations set status = 'connected', name = $2, account_info = $3,
             access_token = $4, refresh_token = $5, token_expires_at = $6::timestamp, error_message = null,
             last_sync_at = $7::timestamp, updated_at = $7::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&guild_name)
        .bind(&account)
        .bind(tokens["access_token"].as_str())
        .bind(tokens["refresh_token"].as_str())
        .bind(&expires)
        .bind(&now)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
        id
    } else {
        let id = generate_id("chi");
        sqlx::query(
            "insert into helpdesk_channel_integrations
               (id, provider, status, name, account_info, access_token, refresh_token, token_expires_at,
                config, last_sync_at, created_at, updated_at)
             values ($1, 'discord', 'connected', $2, $3, $4, $5, $6::timestamp, $7, $8::timestamp, $8::timestamp, $8::timestamp)",
        )
        .bind(&id)
        .bind(&guild_name)
        .bind(&account)
        .bind(tokens["access_token"].as_str())
        .bind(tokens["refresh_token"].as_str())
        .bind(&expires)
        .bind(json!({ "supportChannels": [], "processDirectMessages": false, "ignoreBots": true }))
        .bind(&now)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
        id
    };

    let mapping = json_object(&[
        ("clerkOrgId", Some(&json!(org))),
        ("internalWorkspaceId", Some(&json!(workspace))),
    ]);
    kv_put(
        ctx.kv(state).as_ref(),
        &format!("discord_guild:{resolved}"),
        &mapping,
        None,
    )
    .await?;
    let query = form_encode(&[("connected", "true"), ("integrationId", &integration_id)]);
    Ok(redirect(&page(&query)))
}

/// `findIntegrationByGuildId`: the live Discord row for a guild.
async fn integration_for_guild(db: &PgPool, guild: &str) -> Result<Option<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from helpdesk_channel_integrations t
         where t.provider = 'discord' and t.deleted_at is null order by t.created_at desc",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| HCI.js(row))
        .find(|row| discord_guild_id(row).as_deref() == Some(guild)))
}

// ── Slack ─────────────────────────────────────────────────────────────────────

async fn slack_callback(
    State(state): State<PublicState>,
    ctx: PublicCtx,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.as_deref();
    let code = query_param(query, "code").filter(|c| !c.is_empty());
    let nonce = query_param(query, "state").filter(|s| !s.is_empty());
    let urls = urls(&ctx);
    let default_app = urls.app();
    let (Some(code), Some(nonce)) = (code, nonce) else {
        return redirect(&format!(
            "{default_app}{SLACK_SETTINGS_PATH}?error=missing_params"
        ));
    };
    let mut state_org: Option<String> = None;
    match slack_flow(&ctx, &state, &urls, &code, &nonce, &mut state_org).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "[app-api/integrations-helpdesk] Slack OAuth callback error");
            // The catch redirects to the default app, not the caller's origin.
            redirect(&workspace_url(
                &default_app,
                state_org.as_deref(),
                &format!("{SLACK_SETTINGS_PATH}?error=callback_failed"),
            ))
        }
    }
}

#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
async fn slack_flow(
    ctx: &PublicCtx,
    state: &PublicState,
    urls: &Urls,
    code: &str,
    nonce: &str,
    state_org: &mut Option<String>,
) -> Result<Response, String> {
    let default_app = urls.app();
    let Some(data) = take_state(ctx, state, "slack", nonce).await? else {
        return Ok(redirect(&format!(
            "{default_app}{SLACK_SETTINGS_PATH}?error=invalid_state"
        )));
    };
    let app_url = data
        .caller_origin
        .clone()
        .unwrap_or_else(|| default_app.clone());
    let org = data.org_id.clone();
    *state_org = Some(org.clone());
    let page = |query: &str| {
        workspace_url(
            &app_url,
            Some(&org),
            &format!("{SLACK_SETTINGS_PATH}?{query}"),
        )
    };

    let client_id = ctx.env("SLACK_CLIENT_ID").filter(|c| !c.is_empty());
    let client_secret = ctx.env("SLACK_CLIENT_SECRET").filter(|c| !c.is_empty());
    let (Some(client_id), Some(client_secret)) = (client_id, client_secret) else {
        return Ok(redirect(&page("error=config_error")));
    };
    let form = form_encode(&[
        ("client_id", &client_id),
        ("client_secret", &client_secret),
        ("code", code),
        ("redirect_uri", &urls.redirect_uri("slack")),
    ]);
    let token = providers::slack_exchange(ctx.http(state).as_ref(), form).await?;
    let bot_token = token["access_token"].as_str().filter(|t| !t.is_empty());
    let Some(bot_token) = bot_token.filter(|_| truthy(&token["ok"])) else {
        let reason = token["error"]
            .as_str()
            .filter(|e| !e.is_empty())
            .unwrap_or("token_exchange_failed");
        tracing::error!("[app-api/integrations-helpdesk] Slack token exchange failed: {reason}");
        return Ok(redirect(&page(&format!(
            "error={}",
            encode_uri_component(reason)
        ))));
    };
    let team_id = token["team"]["id"].as_str().map(str::to_owned);
    let team_name = token["team"]["name"]
        .as_str()
        .filter(|n| !n.is_empty())
        .unwrap_or("Slack Workspace")
        .to_owned();

    let workspace = workspace_id(ctx, state, &org).await?;
    let db = ctx.tenant_db(state, &org).await?;
    let existing: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from helpdesk_channel_integrations t where t.provider = 'slack' and t.deleted_at is null limit 1",
    )
    .fetch_optional(&db)
    .await
    .map_err(|e| e.to_string())?;
    let now = crate::now();
    let mut metadata = serde_json::Map::new();
    if let Some(team) = &team_id {
        metadata.insert("teamId".to_owned(), json!(team));
    }
    if let Some(bot_user) = token.get("bot_user_id").filter(|v| !v.is_null()) {
        metadata.insert("botUserId".to_owned(), bot_user.clone());
    }
    let account = json!({ "id": team_id.as_deref().filter(|t| !t.is_empty()).unwrap_or("unknown"), "name": team_name, "metadata": metadata });
    let mut config = existing
        .as_ref()
        .and_then(|row| row["config"].as_object().cloned())
        .unwrap_or_default();
    config.insert("botToken".to_owned(), json!(bot_token));
    if let Some(existing) = existing {
        sqlx::query(
            "update helpdesk_channel_integrations set status = 'connected', name = $2, account_info = $3, config = $4,
             access_token = $5, updated_at = $6::timestamp where id = $1",
        )
        .bind(existing["id"].as_str())
        .bind(&team_name)
        .bind(&account)
        .bind(Value::Object(config))
        .bind(bot_token)
        .bind(&now)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    } else {
        sqlx::query(
            "insert into helpdesk_channel_integrations
               (id, provider, status, name, account_info, config, access_token, created_at, updated_at)
             values ($1, 'slack', 'connected', $2, $3, $4, $5, $6::timestamp, $6::timestamp)",
        )
        .bind(generate_id("chi"))
        .bind(&team_name)
        .bind(&account)
        .bind(Value::Object(config))
        .bind(bot_token)
        .bind(&now)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    }
    if let Some(team) = team_id.filter(|t| !t.is_empty()) {
        let mapping = json_object(&[
            ("clerkOrgId", Some(&json!(org))),
            ("internalWorkspaceId", Some(&json!(workspace))),
        ]);
        kv_put(
            ctx.kv(state).as_ref(),
            &format!("slack_team:{team}"),
            &mapping,
            None,
        )
        .await?;
    }
    Ok(redirect(&page("connected=true")))
}
