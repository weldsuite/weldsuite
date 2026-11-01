//! The third-party integration steps (`engine/actions/providers/*`):
//! Slack, Google Sheets, Gmail, Google Calendar, Teams, Twilio, Notion,
//! Airtable, GitHub and Asana, each through [`OutboundHttp`] with the
//! workspace's connected integration (`workflow_integrations`), and the
//! legacy `slack_message` step.

use std::sync::Arc;

use base64::Engine;
use serde_json::{Map, Value, json};
use weldsuite_db::Keyring;
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

use super::records::is_email_address;
use super::{ActionCtx, ActionError, ActionResult};
use crate::js::{as_text, js_number, js_string, truthy};

// ── Plumbing ────────────────────────────────────────────────────────────────

/// `asText(value || '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        Some(v) if truthy(v) => as_text(Some(v)),
        _ => String::new(),
    }
}

/// `value ? asText(value) : undefined`.
fn text_if(value: Option<&Value>) -> Option<String> {
    match value {
        Some(v) if truthy(v) => Some(as_text(Some(v))),
        _ => None,
    }
}

fn integration_id(inputs: &Map<String, Value>) -> Option<String> {
    text_if(inputs.get("integrationId"))
}

/// A `RetryableProviderError`.
fn retryable(message: &str, details: Value) -> ActionError {
    ActionError {
        details: Some(details),
        ..ActionError::named("RetryableProviderError", message)
    }
}

/// `fetch(...)`: a request that can't connect fails like `fetch` does.
async fn send(ctx: &ActionCtx<'_>, request: HttpRequest) -> Result<HttpResponse, ActionError> {
    let http = ctx
        .deps
        .http
        .clone()
        .unwrap_or_else(|| OutboundHttp(Arc::new(crate::Unreachable)));
    http.0
        .send(request)
        .await
        .map_err(|_| ActionError::named("TypeError", "fetch failed"))
}

fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<String>) -> HttpRequest {
    HttpRequest {
        method: method.to_owned(),
        url: url.to_owned(),
        headers: headers
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        body: body.map(String::into_bytes),
    }
}

fn bearer_json(method: &str, url: &str, token: &str, body: &Value) -> HttpRequest {
    let auth = format!("Bearer {token}");
    request(
        method,
        url,
        &[
            ("Authorization", &auth),
            ("Content-Type", "application/json"),
        ],
        Some(crate::js::json_text(body)),
    )
}

/// `await response.json()`: `None` when the body isn't JSON (TypeScript
/// throws a `SyntaxError` there).
fn json_of(response: &HttpResponse) -> Result<Value, ActionError> {
    serde_json::from_slice(&response.body)
        .map_err(|_| ActionError::named("SyntaxError", "Unexpected end of JSON input"))
}

/// `encodeURIComponent`.
fn encode_component(value: &str) -> String {
    const KEEP: &[u8] = b"-_.!~*'()";
    let mut out = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || KEEP.contains(byte) {
            out.push(char::from(*byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `new URLSearchParams(pairs).toString()`.
fn form(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
}

// ── Integrations (`integrations.ts`, `providers/token.ts`) ──────────────────

/// `resolveIntegration(db, { type, integrationId })`: the live row.
pub(super) async fn resolve_integration(
    ctx: &ActionCtx<'_>,
    kind: &str,
    id: Option<&str>,
) -> Result<Value, ActionError> {
    let selector = id.map_or_else(|| format!("type={kind}"), |id| format!("id={id}"));
    let row: Option<Value> = match id {
        Some(id) => sqlx::query_scalar(
            "select to_jsonb(t) from workflow_integrations t where t.id = $1 and t.deleted_at is null limit 1",
        )
        .bind(id)
        .fetch_optional(ctx.db)
        .await,
        None => sqlx::query_scalar(
            "select to_jsonb(t) from workflow_integrations t where t.type = $1 and t.deleted_at is null limit 1",
        )
        .bind(kind)
        .fetch_optional(ctx.db)
        .await,
    }
    .map_err(|e| ActionError::plain(&e.to_string()))?;
    let Some(row) = row else {
        return Err(ActionError::named(
            "IntegrationNotFoundError",
            &format!("Integration not found: {selector}"),
        ));
    };
    let status = js_string(row.get("status"));
    if status != "connected" {
        return Err(ActionError::named(
            "IntegrationNotConnectedError",
            &format!("Integration {selector} is not connected (status: {status})"),
        ));
    }
    Ok(row)
}

/// `integrationBearerToken(integ)`.
fn bearer_token(row: &Value) -> Option<String> {
    let tokens = &row["oauth_tokens"];
    let credentials = &row["credentials"];
    tokens["accessToken"]
        .as_str()
        .or_else(|| {
            ["accessToken", "botToken", "apiKey", "token"]
                .iter()
                .find_map(|key| credentials[*key].as_str())
        })
        .map(str::to_owned)
}

fn keyring(ctx: &ActionCtx<'_>) -> Keyring {
    let key = |name: &str| ctx.deps.env.get(name).filter(|v| !v.is_empty()).cloned();
    Keyring {
        v1: key("DATABASE_ENCRYPTION_KEY"),
        v2: key("DATABASE_ENCRYPTION_KEY_V2"),
    }
}

/// `assertOwnerStillMember(ctx)`.
async fn assert_owner_still_member(ctx: &ActionCtx<'_>) -> Result<(), ActionError> {
    let Some(owner) = ctx.info.owner_user_id.as_deref().filter(|o| !o.is_empty()) else {
        return Ok(());
    };
    let member: Option<String> = sqlx::query_scalar(
        "select id from workspace_members where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(owner)
    .fetch_optional(ctx.db)
    .await
    .map_err(|e| ActionError::plain(&e.to_string()))?;
    if member.is_none() {
        return Err(ActionError::fatal(
            "The workflow's owner is no longer a member of this workspace, so it can't use its connected integrations",
        ));
    }
    Ok(())
}

/// `refreshOAuthToken(auth, refreshToken, env)`: the new token and when it
/// expires.
async fn refresh_oauth_token(
    ctx: &ActionCtx<'_>,
    auth: &Value,
    refresh_token: &str,
) -> Result<(String, Option<String>), ActionError> {
    let id_env = js_string(auth.get("clientIdEnv"));
    let secret_env = js_string(auth.get("clientSecretEnv"));
    let client_id = ctx.deps.env.get(&id_env).filter(|v| !v.is_empty());
    let client_secret = ctx.deps.env.get(&secret_env).filter(|v| !v.is_empty());
    let (Some(client_id), Some(client_secret)) = (client_id, client_secret) else {
        return Err(ActionError::plain(&format!(
            "Missing OAuth client env ({id_env}/{secret_env})"
        )));
    };
    let body = form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ]);
    let response = send(
        ctx,
        request(
            "POST",
            &js_string(auth.get("tokenUrl")),
            &[("Content-Type", "application/x-www-form-urlencoded")],
            Some(body),
        ),
    )
    .await?;
    let answer = json_of(&response)?;
    let access = answer
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty());
    match access {
        Some(access) if response.ok() => {
            let expires_at = answer
                .get("expires_in")
                .and_then(Value::as_f64)
                .filter(|s| *s != 0.0)
                .map(|seconds| {
                    #[allow(clippy::cast_possible_truncation)]
                    let at = time::OffsetDateTime::now_utc()
                        + time::Duration::milliseconds((seconds * 1000.0) as i64);
                    weldsuite_events::iso_timestamp(at)
                });
            Ok((access.to_owned(), expires_at))
        }
        _ => {
            let error = answer
                .get("error")
                .and_then(Value::as_str)
                .filter(|e| !e.is_empty());
            if error == Some("invalid_grant") {
                return Err(ActionError::fatal_with(
                    "The connection is no longer valid (its refresh token was revoked or expired). Reconnect it from WeldConnect → Integrations.",
                    json!({ "error": "invalid_grant" }),
                ));
            }
            Err(ActionError::plain(&format!(
                "Token refresh failed: {}",
                error.map_or_else(|| response.status.to_string(), str::to_owned)
            )))
        }
    }
}

/// `getValidIntegrationToken(ctx, { type, integrationId })`.
async fn valid_token(
    ctx: &ActionCtx<'_>,
    kind: &str,
    id: Option<&str>,
) -> Result<String, ActionError> {
    assert_owner_still_member(ctx).await?;
    let row = resolve_integration(ctx, kind, id).await?;
    let row_type = js_string(row.get("type"));
    let def = crate::catalog::integration(&row_type);
    let auth = def.and_then(|d| d.get("auth"));
    let auth_kind = auth.and_then(|a| a.get("kind")).and_then(Value::as_str);
    if auth_kind == Some("app_installation") {
        let auth = auth.unwrap_or(&Value::Null);
        let app_env = js_string(auth.get("appIdEnv"));
        let key_env = js_string(auth.get("privateKeyEnv"));
        let app_id = ctx.deps.env.get(&app_env).filter(|v| !v.is_empty());
        let private_key = ctx.deps.env.get(&key_env).filter(|v| !v.is_empty());
        let (Some(app_id), Some(private_key)) = (app_id, private_key) else {
            return Err(ActionError::plain(&format!(
                "Missing app installation env ({app_env}/{key_env})"
            )));
        };
        let installation = js_number(row.get("settings").and_then(|s| s.get("installationId")));
        #[allow(clippy::cast_possible_truncation)]
        let valid = installation.is_finite()
            && installation.fract() == 0.0
            && installation > 0.0
            && installation <= 9_007_199_254_740_991.0;
        if !valid {
            return Err(ActionError::fatal(&format!(
                "The \"{row_type}\" connection has no valid installation configured. Reconnect it from WeldConnect → Integrations."
            )));
        }
        if row_type != "github" {
            return Err(ActionError::plain(&format!(
                "Integration type \"{row_type}\" declares app_installation auth but has no token minter wired up"
            )));
        }
        let http = ctx
            .deps
            .http
            .clone()
            .unwrap_or_else(|| OutboundHttp(Arc::new(crate::Unreachable)));
        let creds = crate::github_app::AppCredentials {
            app_id: app_id.clone(),
            private_key: private_key.clone(),
        };
        #[allow(clippy::cast_possible_truncation)]
        return crate::github_app::installation_token(&http, &creds, installation as i64, true)
            .await
            .map_err(|message| ActionError::plain(&message));
    }
    let keys = keyring(ctx);
    let tokens = &row["oauth_tokens"];
    if let Some(sealed) = tokens
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
    {
        let mut access = crate::crypto::maybe_decrypt(sealed, &keys);
        let expires_ms = tokens
            .get("expiresAt")
            .and_then(Value::as_str)
            .and_then(|at| {
                time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339).ok()
            })
            .map(|at| at.unix_timestamp_nanos() / 1_000_000);
        let now_ms = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
        let expiring = expires_ms.is_some_and(|at| at - now_ms < 5 * 60_000);
        let refresh = tokens
            .get("refreshToken")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty());
        if let (true, Some(refresh_sealed), Some("oauth2")) = (expiring, refresh, auth_kind) {
            let refresh_plain = crate::crypto::maybe_decrypt(refresh_sealed, &keys);
            let (fresh, expires_at) =
                refresh_oauth_token(ctx, auth.unwrap_or(&Value::Null), &refresh_plain).await?;
            let stored = crate::crypto::seal_if_keyed(&fresh, &keys)
                .map_err(|message| ActionError::plain(&message))?;
            let mut tokens = json!({ "accessToken": stored, "refreshToken": refresh_sealed });
            if let Some(at) = expires_at {
                tokens["expiresAt"] = json!(at);
            }
            sqlx::query(
                "update workflow_integrations set oauth_tokens = $2, updated_at = $3::timestamp where id = $1",
            )
            .bind(js_string(row.get("id")))
            .bind(&tokens)
            .bind(super::now_text())
            .execute(ctx.db)
            .await
            .map_err(|e| ActionError::plain(&e.to_string()))?;
            access = fresh;
        }
        return Ok(access);
    }
    if let Some(bearer) = bearer_token(&row) {
        return Ok(crate::crypto::maybe_decrypt(&bearer, &keys));
    }
    Err(ActionError::plain(&format!(
        "Integration \"{row_type}\" has no usable token"
    )))
}

/// `getIntegrationCredentials(ctx, { type, integrationId })`: the
/// credentials, opened.
async fn credentials(
    ctx: &ActionCtx<'_>,
    kind: &str,
    id: Option<&str>,
) -> Result<Map<String, Value>, ActionError> {
    assert_owner_still_member(ctx).await?;
    let row = resolve_integration(ctx, kind, id).await?;
    let keys = keyring(ctx);
    let mut out = Map::new();
    if let Some(Value::Object(credentials)) = row.get("credentials") {
        for (key, value) in credentials {
            let opened = match value {
                Value::String(text) => crate::crypto::maybe_decrypt(text, &keys),
                other => js_string(Some(other)),
            };
            out.insert(key.clone(), Value::String(opened));
        }
    }
    Ok(out)
}

fn credential<'m>(credentials: &'m Map<String, Value>, key: &str) -> Option<&'m str> {
    credentials
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}

// ── slack_message (`communication.ts`) ──────────────────────────────────────

pub(super) async fn slack_message(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let channel = text_or_empty(inputs.get("channel"));
    let text = text_or_empty(inputs.get("text"));
    if channel.is_empty() {
        return Err(ActionError::plain("Slack channel is required"));
    }
    if text.is_empty() {
        return Err(ActionError::plain("Slack message text is required"));
    }
    let row = resolve_integration(ctx, "slack", integration_id(inputs).as_deref()).await?;
    let Some(token) = bearer_token(&row) else {
        return Err(ActionError::plain("Slack integration has no usable token"));
    };
    let response = send(
        ctx,
        bearer_json(
            "POST",
            "https://slack.com/api/chat.postMessage",
            &token,
            &json!({ "channel": channel, "text": text }),
        ),
    )
    .await?;
    let result = json_of(&response)?;
    if result.get("ok") != Some(&Value::Bool(true)) {
        let error = result.get("error").filter(|e| truthy(e));
        return Err(ActionError::plain(&format!(
            "Slack error: {}",
            error.map_or_else(|| "unknown".to_owned(), |e| as_text(Some(e)))
        )));
    }
    Ok(
        json!({ "sent": true, "channel": channel, "ts": result.get("ts").cloned().unwrap_or(Value::Null) }),
    )
}

// ── slack.post_message ──────────────────────────────────────────────────────

/// `NON_RETRYABLE_SLACK_ERRORS`.
fn slack_error_message(code: &str) -> Option<&'static str> {
    Some(match code {
        "channel_not_found" => {
            "Slack channel not found — it may have been deleted, archived, or the id/name is wrong."
        }
        "not_in_channel" => {
            "WeldSuite's Slack app hasn't been invited to this channel yet. Invite it from Slack (/invite @WeldSuite) and try again — private channels always need this."
        }
        "is_archived" => "This Slack channel is archived and no longer accepts messages.",
        "msg_too_long" => "The Slack message is too long (over 40,000 characters).",
        "no_text" => "Slack message text is required.",
        "invalid_auth" | "account_inactive" | "not_authed" => {
            "The Slack connection is no longer valid. Reconnect it from WeldConnect → Integrations."
        }
        "token_revoked" => {
            "The Slack connection was revoked. Reconnect it from WeldConnect → Integrations."
        }
        "missing_scope" => {
            "The Slack connection is missing a required permission scope. Reconnect it from WeldConnect → Integrations."
        }
        _ => return None,
    })
}

/// `Number(header) || undefined`.
fn header_seconds(response: &HttpResponse, name: &str) -> Option<f64> {
    response
        .header(name)
        .map(|v| js_number(Some(&json!(v))))
        .filter(|n| n.is_finite() && *n != 0.0)
}

pub(super) async fn slack_post_message(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let channel = text_or_empty(inputs.get("channel")).trim().to_owned();
    let text = text_or_empty(inputs.get("text"));
    let thread_ts = text_if(inputs.get("threadTs")).map(|t| t.trim().to_owned());
    if channel.is_empty() {
        return Err(ActionError::fatal("Slack channel is required"));
    }
    if text.trim().is_empty() {
        return Err(ActionError::fatal("Slack message text is required"));
    }
    let token = valid_token(ctx, "slack", integration_id(inputs).as_deref()).await?;
    let mut body = json!({ "channel": channel, "text": text });
    if let Some(ts) = thread_ts.filter(|t| !t.is_empty()) {
        body["thread_ts"] = json!(ts);
    }
    let response = send(
        ctx,
        bearer_json(
            "POST",
            "https://slack.com/api/chat.postMessage",
            &token,
            &body,
        ),
    )
    .await?;
    if response.status == 429 {
        let retry = header_seconds(&response, "retry-after");
        let suffix = retry.map_or_else(String::new, |s| {
            format!(" — retry after {}s", js_string(Some(&json!(s))))
        });
        let details = retry.map_or_else(|| json!({}), |s| json!({ "retryAfterSeconds": s }));
        return Err(retryable(
            &format!("Slack is rate-limiting this workspace{suffix}"),
            details,
        ));
    }
    let result = json_of(&response)?;
    if result.get("ok") != Some(&Value::Bool(true)) {
        let code = result
            .get("error")
            .filter(|e| truthy(e))
            .map_or_else(|| "unknown".to_owned(), |e| as_text(Some(e)));
        if let Some(mapped) = slack_error_message(&code) {
            return Err(ActionError::fatal_with(
                mapped,
                json!({ "slackError": code }),
            ));
        }
        if code == "ratelimited" {
            return Err(retryable(
                "Slack is rate-limiting this workspace",
                json!({ "slackError": code }),
            ));
        }
        return Err(ActionError::fatal_with(
            &format!("Slack error: {code}"),
            json!({ "slackError": code }),
        ));
    }
    let resolved = result
        .get("channel")
        .and_then(Value::as_str)
        .map_or_else(|| channel.clone(), str::to_owned);
    let ts = result
        .get("ts")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty());
    let permalink = match ts {
        Some(ts) if !resolved.is_empty() => {
            let url = format!(
                "https://slack.com/api/chat.getPermalink?{}",
                form(&[("channel", &resolved), ("message_ts", ts)])
            );
            let auth = format!("Bearer {token}");
            match send(ctx, request("GET", &url, &[("Authorization", &auth)], None)).await {
                Ok(answer) => serde_json::from_slice::<Value>(&answer.body)
                    .ok()
                    .filter(|j| j.get("ok") == Some(&Value::Bool(true)))
                    .and_then(|j| j.get("permalink").cloned()),
                Err(_) => None,
            }
        }
        _ => None,
    };
    let mut out = json!({ "ok": true, "channel": resolved });
    if let Some(ts) = result.get("ts") {
        out["ts"] = ts.clone();
    }
    if let Some(permalink) = permalink {
        out["permalink"] = permalink;
    }
    Ok(out)
}

// ── Google (`google-errors.ts`) ─────────────────────────────────────────────

/// `throwGoogleApiError(response, action)`.
fn google_error(response: &HttpResponse, action: &str) -> ActionError {
    let error = serde_json::from_slice::<Value>(&response.body)
        .ok()
        .and_then(|j| j.get("error").cloned());
    let details = error.clone().unwrap_or(Value::Null);
    let status = response.status;
    let message = error
        .as_ref()
        .and_then(|e| e.get("message"))
        .filter(|m| truthy(m))
        .map(|m| as_text(Some(m)))
        .unwrap_or_else(|| {
            let reason = http::StatusCode::from_u16(status)
                .ok()
                .and_then(|s| s.canonical_reason())
                .unwrap_or_default();
            if reason.is_empty() {
                format!("HTTP {status}")
            } else {
                reason.to_owned()
            }
        });
    let reason = error
        .as_ref()
        .and_then(|e| e.get("errors"))
        .and_then(|e| e.get(0))
        .and_then(|e| e.get("reason"))
        .filter(|r| truthy(r))
        .map(|r| as_text(Some(r)).to_lowercase())
        .unwrap_or_default();
    let fatal = |message: String| {
        if details.is_null() {
            ActionError::fatal(&message)
        } else {
            ActionError::fatal_with(&message, details.clone())
        }
    };
    let retry = |message: String| ActionError {
        details: (!details.is_null()).then(|| details.clone()),
        ..ActionError::named("RetryableProviderError", &message)
    };
    const RATE: [&str; 4] = [
        "ratelimitexceeded",
        "userratelimitexceeded",
        "quotaexceeded",
        "dailylimitexceeded",
    ];
    const PERMISSION: [&str; 4] = [
        "insufficientpermissions",
        "accessnotconfigured",
        "forbidden",
        "permission_denied",
    ];
    match status {
        401 => fatal(format!(
            "{action}: the Google connection is no longer valid. Reconnect it from WeldConnect → Integrations."
        )),
        403 => {
            if RATE.iter().any(|r| reason.contains(r)) {
                return retry(format!(
                    "{action}: Google rate/quota limit reached — {message}"
                ));
            }
            let lower = message.to_lowercase();
            if PERMISSION.iter().any(|r| reason.contains(r))
                || lower.contains("insufficient")
                || lower.contains("permission")
            {
                return fatal(format!(
                    "{action}: the Google connection is missing a required permission, or can't access this resource. Reconnect it from WeldConnect → Integrations, or check sharing on the resource."
                ));
            }
            fatal(format!("{action}: {message}"))
        }
        404 => fatal(format!("{action}: not found — {message}")),
        429 => {
            let suffix = header_seconds(response, "retry-after").map_or_else(String::new, |s| {
                format!(" — retry after {}s", js_string(Some(&json!(s))))
            });
            retry(format!(
                "{action}: Google is rate-limiting this request{suffix}"
            ))
        }
        500.. => retry(format!("{action}: Google returned {status} — {message}")),
        _ => fatal(format!("{action}: {message}")),
    }
}

// ── google_sheets.* ─────────────────────────────────────────────────────────

const SHEETS_BASE: &str = "https://sheets.googleapis.com/v4/spreadsheets";

/// `columnLetterToIndex(letter)`.
fn column_index(letter: &str) -> Result<i64, ActionError> {
    let trimmed = letter.trim().to_uppercase();
    if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(ActionError::fatal(&format!(
            "Invalid column letter: \"{letter}\""
        )));
    }
    let mut index: i64 = 0;
    for byte in trimmed.bytes() {
        index = index * 26 + i64::from(byte - 64);
    }
    Ok(index - 1)
}

/// `parseColumnMapping(raw)`.
fn column_mapping(raw: Option<&Value>) -> Result<Map<String, Value>, ActionError> {
    let parsed = match raw {
        None | Some(Value::Null) => return Err(ActionError::fatal("columnMapping is required")),
        Some(Value::String(text)) => serde_json::from_str::<Value>(text)
            .map_err(|_| ActionError::fatal("columnMapping is not valid JSON"))?,
        Some(other) => other.clone(),
    };
    let Value::Object(mapping) = parsed else {
        return Err(ActionError::fatal(
            "columnMapping must be a JSON object of column letter to value, e.g. {\"A\": \"Jane\"}",
        ));
    };
    if mapping.is_empty() {
        return Err(ActionError::fatal("columnMapping has no columns"));
    }
    Ok(mapping)
}

pub(super) async fn sheets_append_row(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let spreadsheet = text_or_empty(inputs.get("spreadsheetId")).trim().to_owned();
    if spreadsheet.is_empty() {
        return Err(ActionError::fatal("spreadsheetId is required"));
    }
    let sheet = text_if(inputs.get("sheetName"))
        .map_or_else(|| "Sheet1".to_owned(), |s| s.trim().to_owned());
    let mapping = column_mapping(inputs.get("columnMapping"))?;
    let mut by_index = std::collections::BTreeMap::new();
    for (key, value) in &mapping {
        by_index.insert(column_index(key)?, value.clone());
    }
    let max = by_index.keys().copied().max().unwrap_or(-1);
    let row: Vec<Value> = (0..=max)
        .map(|i| by_index.get(&i).cloned().unwrap_or_else(|| json!("")))
        .collect();
    let token = valid_token(ctx, "google_sheets", integration_id(inputs).as_deref()).await?;
    let range = encode_component(&format!("{sheet}!A1"));
    let url = format!(
        "{SHEETS_BASE}/{}/values/{range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
        encode_component(&spreadsheet)
    );
    let response = send(
        ctx,
        bearer_json("POST", &url, &token, &json!({ "values": [row] })),
    )
    .await?;
    if !response.ok() {
        return Err(google_error(&response, "Sheets append row"));
    }
    let answer = json_of(&response)?;
    let mut out = json!({ "ok": true });
    if let Some(range) = answer.pointer("/updates/updatedRange") {
        out["updatedRange"] = range.clone();
    }
    if let Some(rows) = answer.pointer("/updates/updatedRows") {
        out["updatedRows"] = rows.clone();
    }
    Ok(out)
}

pub(super) async fn sheets_update_row(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let spreadsheet = text_or_empty(inputs.get("spreadsheetId")).trim().to_owned();
    if spreadsheet.is_empty() {
        return Err(ActionError::fatal("spreadsheetId is required"));
    }
    let sheet = text_if(inputs.get("sheetName"))
        .map_or_else(|| "Sheet1".to_owned(), |s| s.trim().to_owned());
    let mapping = column_mapping(inputs.get("columnMapping"))?;
    let token = valid_token(ctx, "google_sheets", integration_id(inputs).as_deref()).await?;

    // `resolveTargetRow`.
    let present = |v: Option<&Value>| match v {
        None | Some(Value::Null) => false,
        Some(v) => !as_text(Some(v)).trim().is_empty(),
    };
    let target_row: i64 = if present(inputs.get("rowNumber")) {
        let n = js_number(inputs.get("rowNumber"));
        if !(n.is_finite() && n.fract() == 0.0 && n >= 1.0) {
            return Err(ActionError::fatal("rowNumber must be a positive integer"));
        }
        #[allow(clippy::cast_possible_truncation)]
        let n = n as i64;
        n
    } else {
        let column = text_if(inputs.get("lookupColumn"))
            .map(|c| c.trim().to_owned())
            .unwrap_or_default();
        if column.is_empty() || !present(inputs.get("lookupValue")) {
            return Err(ActionError::fatal(
                "Provide either rowNumber, or both lookupColumn and lookupValue",
            ));
        }
        column_index(&column)?;
        let range = encode_component(&format!("{sheet}!{column}:{column}"));
        let auth = format!("Bearer {token}");
        let url = format!(
            "{SHEETS_BASE}/{}/values/{range}",
            encode_component(&spreadsheet)
        );
        let response = send(ctx, request("GET", &url, &[("Authorization", &auth)], None)).await?;
        if !response.ok() {
            return Err(google_error(&response, "Sheets lookup row"));
        }
        let answer = json_of(&response)?;
        let wanted = as_text(inputs.get("lookupValue")).trim().to_owned();
        let found = answer
            .get("values")
            .and_then(Value::as_array)
            .and_then(|cells| {
                cells.iter().position(|cell| {
                    let first = cell.get(0).filter(|v| !v.is_null());
                    as_text(first).trim() == wanted
                })
            });
        let Some(index) = found else {
            return Err(ActionError::fatal(&format!(
                "No row found where column {column} = \"{wanted}\""
            )));
        };
        i64::try_from(index).unwrap_or(0) + 1
    };
    let mut data = Vec::new();
    for (column, value) in &mapping {
        column_index(column)?;
        data.push(json!({
            "range": format!("{sheet}!{}{target_row}", column.to_uppercase()),
            "values": [[value]],
        }));
    }
    let url = format!(
        "{SHEETS_BASE}/{}/values:batchUpdate",
        encode_component(&spreadsheet)
    );
    let response = send(
        ctx,
        bearer_json(
            "POST",
            &url,
            &token,
            &json!({ "valueInputOption": "USER_ENTERED", "data": data }),
        ),
    )
    .await?;
    if !response.ok() {
        return Err(google_error(&response, "Sheets update row"));
    }
    let answer = json_of(&response)?;
    let mut out = json!({ "ok": true, "row": target_row });
    if let Some(cells) = answer.get("totalUpdatedCells") {
        out["updatedCells"] = cells.clone();
    }
    Ok(out)
}

// ── gmail.send_email ────────────────────────────────────────────────────────

/// `isValidRecipient(recipient)`: `Name <address>` or a bare address.
pub(super) fn is_valid_recipient(recipient: &str) -> bool {
    let address = recipient
        .trim_end()
        .strip_suffix('>')
        .and_then(|rest| rest.rsplit_once('<'))
        .filter(|(_, inner)| !inner.contains('<') && !inner.contains('>'))
        .map_or(recipient, |(_, inner)| inner);
    is_email_address(address.trim())
}

/// `validatedRecipients(value, field, required)` over a split list.
pub(super) fn validated(
    recipients: Vec<String>,
    field: &str,
    required: bool,
) -> Result<Vec<String>, ActionError> {
    if recipients.is_empty() {
        if required {
            return Err(ActionError::fatal(&format!(
                "No recipient address: \"{field}\" resolved to an empty value"
            )));
        }
        return Ok(Vec::new());
    }
    if let Some(invalid) = recipients.iter().find(|r| !is_valid_recipient(r)) {
        let suffix = if field == "To" {
            String::new()
        } else {
            format!(" ({field})")
        };
        return Err(ActionError::fatal(&format!(
            "Recipient address \"{invalid}\" is not valid{suffix}"
        )));
    }
    Ok(recipients)
}

fn split_list(text: &str) -> Vec<String> {
    text.split([',', ';'])
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect()
}

pub(super) async fn gmail_send_email(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let list = |key: &str| match inputs.get(key) {
        Some(Value::String(text)) => split_list(text),
        _ => Vec::new(),
    };
    let to = validated(list("to"), "To", true)?;
    let cc = validated(list("cc"), "Cc", false)?;
    let bcc = validated(list("bcc"), "Bcc", false)?;
    let subject_raw = match inputs.get("subject") {
        None | Some(Value::Null) => String::new(),
        some => as_text(some),
    };
    let subject = subject_raw
        .split(['\r', '\n'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_owned();
    if subject.is_empty() {
        return Err(ActionError::fatal("Gmail subject is required"));
    }
    let body = match inputs.get("body") {
        None | Some(Value::Null) => String::new(),
        some => as_text(some),
    };
    if body.trim().is_empty() {
        return Err(ActionError::fatal("Gmail body is required"));
    }
    let html = if inputs.get("isHtml") == Some(&Value::Bool(false)) {
        crate::engine::template::escape_html(&body)
            .replace("\r\n", "<br>")
            .replace('\n', "<br>")
    } else {
        body
    };
    let token = valid_token(ctx, "gmail", integration_id(inputs).as_deref()).await?;
    let mut headers = vec![format!("To: {}", to.join(", "))];
    if !cc.is_empty() {
        headers.push(format!("Cc: {}", cc.join(", ")));
    }
    if !bcc.is_empty() {
        headers.push(format!("Bcc: {}", bcc.join(", ")));
    }
    headers.push(format!("Subject: {subject}"));
    headers.push("MIME-Version: 1.0".to_owned());
    headers.push("Content-Type: text/html; charset=UTF-8".to_owned());
    let message = format!("{}\r\n\r\n{html}", headers.join("\r\n"));
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(message.as_bytes());
    let response = send(
        ctx,
        bearer_json(
            "POST",
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            &token,
            &json!({ "raw": raw }),
        ),
    )
    .await?;
    if !response.ok() {
        return Err(google_error(&response, "Gmail send"));
    }
    let answer = json_of(&response)?;
    let mut out = json!({ "ok": true });
    for key in ["id", "threadId"] {
        if let Some(value) = answer.get(key) {
            out[key] = value.clone();
        }
    }
    Ok(out)
}

// ── google_calendar.create_event ────────────────────────────────────────────

fn has_offset(text: &str) -> bool {
    static OFFSET: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(Z|[+-]\d{2}:?\d{2})$").expect("the offset pattern compiles")
    });
    OFFSET.is_match(text)
}

pub(super) async fn calendar_create_event(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let summary = text_or_empty(inputs.get("summary")).trim().to_owned();
    let start = text_or_empty(inputs.get("startDateTime")).trim().to_owned();
    let end = text_or_empty(inputs.get("endDateTime")).trim().to_owned();
    if summary.is_empty() {
        return Err(ActionError::fatal("Event title (summary) is required"));
    }
    if start.is_empty() || end.is_empty() {
        return Err(ActionError::fatal("Event start and end are required"));
    }
    let time_zone = text_if(inputs.get("timeZone")).map(|t| t.trim().to_owned());
    if !(has_offset(&start) && has_offset(&end)) && time_zone.is_none() {
        return Err(ActionError::fatal(
            "timeZone is required when startDateTime/endDateTime have no UTC offset (no trailing Z)",
        ));
    }
    let attendees = match inputs.get("attendees") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        some => {
            let emails = split_list(&as_text(some));
            if emails.is_empty() {
                None
            } else {
                if let Some(invalid) = emails.iter().find(|e| !is_valid_recipient(e)) {
                    return Err(ActionError::fatal(&format!(
                        "Attendee address \"{invalid}\" is not valid"
                    )));
                }
                Some(
                    emails
                        .into_iter()
                        .map(|email| json!({ "email": email }))
                        .collect::<Vec<_>>(),
                )
            }
        }
    };
    let token = valid_token(ctx, "google_calendar", integration_id(inputs).as_deref()).await?;
    let calendar = text_if(inputs.get("calendarId"))
        .map_or_else(|| "primary".to_owned(), |c| c.trim().to_owned());
    let at = |when: &str| {
        let mut slot = json!({ "dateTime": when });
        if let Some(zone) = &time_zone {
            slot["timeZone"] = json!(zone);
        }
        slot
    };
    let mut body = json!({ "summary": summary, "start": at(&start), "end": at(&end) });
    if let Some(description) = text_if(inputs.get("description")) {
        body["description"] = json!(description);
    }
    if let Some(attendees) = attendees {
        body["attendees"] = json!(attendees);
    }
    let url = format!(
        "https://www.googleapis.com/calendar/v3/calendars/{}/events",
        encode_component(&calendar)
    );
    let response = send(ctx, bearer_json("POST", &url, &token, &body)).await?;
    if !response.ok() {
        return Err(google_error(&response, "Calendar create event"));
    }
    let answer = json_of(&response)?;
    let mut out = json!({ "ok": true });
    for key in ["id", "htmlLink"] {
        if let Some(value) = answer.get(key) {
            out[key] = value.clone();
        }
    }
    Ok(out)
}

// ── teams / twilio ──────────────────────────────────────────────────────────

pub(super) async fn teams_post_message(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let text = text_or_empty(inputs.get("text"));
    if text.is_empty() {
        return Err(ActionError::plain("Teams message text is required"));
    }
    let credentials = credentials(ctx, "teams", integration_id(inputs).as_deref()).await?;
    let Some(webhook) = credential(&credentials, "webhookUrl") else {
        return Err(ActionError::plain("Teams integration has no webhook URL"));
    };
    let title = text_if(inputs.get("title"));
    let mut card = json!({
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        "summary": title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| "WeldConnect notification".to_owned()),
        "text": text,
    });
    if let Some(title) = title {
        card["title"] = json!(title);
    }
    let response = send(
        ctx,
        request(
            "POST",
            webhook,
            &[("Content-Type", "application/json")],
            Some(crate::js::json_text(&card)),
        ),
    )
    .await?;
    if !response.ok() {
        return Err(ActionError::plain(&format!(
            "Teams post failed: {} - {}",
            response.status,
            response.text()
        )));
    }
    Ok(json!({ "sent": true }))
}

pub(super) async fn twilio_send_sms(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let to = text_or_empty(inputs.get("to"));
    let body = text_or_empty(inputs.get("body"));
    if to.is_empty() {
        return Err(ActionError::plain("Twilio recipient (to) is required"));
    }
    if body.is_empty() {
        return Err(ActionError::plain("Twilio message body is required"));
    }
    let credentials = credentials(ctx, "twilio", integration_id(inputs).as_deref()).await?;
    let sid = credential(&credentials, "accountSid");
    let auth_token = credential(&credentials, "authToken");
    let from = text_if(inputs.get("from"))
        .or_else(|| credential(&credentials, "fromNumber").map(str::to_owned));
    let (Some(sid), Some(auth_token)) = (sid, auth_token) else {
        return Err(ActionError::plain(
            "Twilio Account SID / Auth Token missing",
        ));
    };
    let Some(from) = from.filter(|f| !f.is_empty()) else {
        return Err(ActionError::plain(
            "Twilio \"from\" number missing (set a default or pass one)",
        ));
    };
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("{sid}:{auth_token}"));
    let auth = format!("Basic {basic}");
    let response = send(
        ctx,
        request(
            "POST",
            &format!("https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"),
            &[
                ("Authorization", &auth),
                ("Content-Type", "application/x-www-form-urlencoded"),
            ],
            Some(form(&[("To", &to), ("From", &from), ("Body", &body)])),
        ),
    )
    .await?;
    let answer = json_of(&response)?;
    if !response.ok() {
        let detail = answer
            .get("error_message")
            .filter(|m| truthy(m))
            .map_or_else(|| response.status.to_string(), |m| as_text(Some(m)));
        return Err(ActionError::plain(&format!("Twilio send failed: {detail}")));
    }
    let mut out = json!({ "sent": true });
    if let Some(sid) = answer.get("sid") {
        out["messageSid"] = sid.clone();
    }
    Ok(out)
}

// ── notion / airtable ───────────────────────────────────────────────────────

/// `parseJsonObject(v)`.
fn json_object(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::String(text)) if !text.trim().is_empty() => {
            match serde_json::from_str::<Value>(text) {
                Ok(Value::Object(map)) => map,
                _ => Map::new(),
            }
        }
        _ => Map::new(),
    }
}

async fn token_credential(
    ctx: &ActionCtx<'_>,
    kind: &str,
    label: &str,
    inputs: &Map<String, Value>,
) -> Result<String, ActionError> {
    let credentials = credentials(ctx, kind, integration_id(inputs).as_deref()).await?;
    credential(&credentials, "token")
        .map(str::to_owned)
        .ok_or_else(|| ActionError::plain(&format!("{label} integration has no token")))
}

const NOTION_VERSION: &str = "2022-06-28";

fn notion_request(method: &str, url: &str, token: &str, body: &Value) -> HttpRequest {
    let auth = format!("Bearer {token}");
    request(
        method,
        url,
        &[
            ("Authorization", &auth),
            ("Content-Type", "application/json"),
            ("Notion-Version", NOTION_VERSION),
        ],
        Some(crate::js::json_text(body)),
    )
}

/// `${json.message || res.status}`.
fn message_or_status(answer: &Value, key: &str, status: u16) -> String {
    answer
        .get(key)
        .filter(|m| truthy(m))
        .map_or_else(|| status.to_string(), |m| as_text(Some(m)))
}

fn copy(out: &mut Value, answer: &Value, from: &str, to: &str) {
    if let Some(value) = answer.get(from) {
        out[to] = value.clone();
    }
}

pub(super) async fn notion_create_page(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let database = text_or_empty(inputs.get("databaseId"));
    let title = text_or_empty(inputs.get("title"));
    if database.is_empty() {
        return Err(ActionError::plain("Notion databaseId is required"));
    }
    if title.is_empty() {
        return Err(ActionError::plain("Notion page title is required"));
    }
    let token = token_credential(ctx, "notion", "Notion", inputs).await?;
    let mut properties = Map::new();
    properties.insert(
        "Name".into(),
        json!({ "title": [{ "text": { "content": title } }] }),
    );
    properties.extend(json_object(inputs.get("properties")));
    let response = send(
        ctx,
        notion_request(
            "POST",
            "https://api.notion.com/v1/pages",
            &token,
            &json!({ "parent": { "database_id": database }, "properties": properties }),
        ),
    )
    .await?;
    let answer = json_of(&response)?;
    if !response.ok() {
        return Err(ActionError::plain(&format!(
            "Notion create failed: {}",
            message_or_status(&answer, "message", response.status)
        )));
    }
    let mut out = json!({ "created": true });
    copy(&mut out, &answer, "id", "id");
    copy(&mut out, &answer, "url", "url");
    Ok(out)
}

pub(super) async fn notion_update_page(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let page = text_or_empty(inputs.get("pageId"));
    if page.is_empty() {
        return Err(ActionError::plain("Notion pageId is required"));
    }
    let properties = json_object(inputs.get("properties"));
    let token = token_credential(ctx, "notion", "Notion", inputs).await?;
    let response = send(
        ctx,
        notion_request(
            "PATCH",
            &format!("https://api.notion.com/v1/pages/{page}"),
            &token,
            &json!({ "properties": properties }),
        ),
    )
    .await?;
    let answer = json_of(&response)?;
    if !response.ok() {
        return Err(ActionError::plain(&format!(
            "Notion update failed: {}",
            message_or_status(&answer, "message", response.status)
        )));
    }
    let mut out = json!({ "updated": true });
    copy(&mut out, &answer, "id", "id");
    Ok(out)
}

/// `${JSON.stringify(json.error) || res.status}`.
fn airtable_error(answer: &Value, status: u16) -> String {
    match answer.get("error") {
        None => status.to_string(),
        Some(error) => crate::js::json_text(error),
    }
}

pub(super) async fn airtable_record(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
    update: bool,
) -> ActionResult {
    let base = text_or_empty(inputs.get("baseId"));
    let table = text_or_empty(inputs.get("tableId"));
    let record = text_or_empty(inputs.get("recordId"));
    if update {
        if base.is_empty() || table.is_empty() || record.is_empty() {
            return Err(ActionError::plain(
                "Airtable baseId, tableId and recordId are required",
            ));
        }
    } else if base.is_empty() || table.is_empty() {
        return Err(ActionError::plain(
            "Airtable baseId and tableId are required",
        ));
    }
    let fields = json_object(inputs.get("fields"));
    let token = token_credential(ctx, "airtable", "Airtable", inputs).await?;
    let mut url = format!(
        "https://api.airtable.com/v0/{base}/{}",
        encode_component(&table)
    );
    if update {
        url = format!("{url}/{record}");
    }
    let response = send(
        ctx,
        bearer_json(
            if update { "PATCH" } else { "POST" },
            &url,
            &token,
            &json!({ "fields": fields }),
        ),
    )
    .await?;
    let answer = json_of(&response)?;
    if !response.ok() {
        let verb = if update { "update" } else { "create" };
        return Err(ActionError::plain(&format!(
            "Airtable {verb} failed: {}",
            airtable_error(&answer, response.status)
        )));
    }
    let mut out = if update {
        json!({ "updated": true })
    } else {
        json!({ "created": true })
    };
    copy(&mut out, &answer, "id", "id");
    Ok(out)
}

// ── github.* ────────────────────────────────────────────────────────────────

fn github_request(method: &str, url: &str, token: &str, body: &Value) -> HttpRequest {
    let auth = format!("Bearer {token}");
    request(
        method,
        url,
        &[
            ("Authorization", &auth),
            ("Accept", "application/vnd.github+json"),
            ("User-Agent", "WeldSuite-WeldConnect"),
            ("X-GitHub-Api-Version", "2022-11-28"),
            ("Content-Type", "application/json"),
        ],
        Some(crate::js::json_text(body)),
    )
}

/// `parseRepo(raw)`.
fn parse_repo(raw: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = raw.trim().split('/').collect();
    match parts.as_slice() {
        [owner, name] if !owner.is_empty() && !name.is_empty() => {
            Some(((*owner).to_owned(), (*name).to_owned()))
        }
        _ => None,
    }
}

/// `parseList(raw)`.
fn parse_list(raw: Option<&Value>) -> Option<Vec<String>> {
    let Some(Value::String(text)) = raw else {
        return None;
    };
    let items: Vec<String> = text
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    (!items.is_empty()).then_some(items)
}

/// `mapGithubError(res)`.
fn github_error(response: &HttpResponse) -> ActionError {
    let body = serde_json::from_slice::<Value>(&response.body)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let status = response.status;
    let message = body.get("message").filter(|m| truthy(m)).map_or_else(
        || format!("GitHub API error ({status})"),
        |m| as_text(Some(m)),
    );
    match status {
        401 => ActionError::fatal_with(
            "The GitHub connection is no longer valid — the App installation may have been suspended or revoked. Reconnect it from WeldConnect → Integrations.",
            body,
        ),
        403 if response.header("x-ratelimit-remaining") == Some("0") => {
            let reset = js_number(
                response
                    .header("x-ratelimit-reset")
                    .map(|v| json!(v))
                    .as_ref(),
            );
            let retry_after = reset.is_finite().then(|| {
                #[allow(clippy::cast_precision_loss)]
                let now = time::OffsetDateTime::now_utc().unix_timestamp() as f64;
                (reset - now).max(0.0)
            });
            let suffix = retry_after.map_or_else(String::new, |s| {
                format!(" — retry after {}s", js_string(Some(&json!(s))))
            });
            let mut details = body.clone();
            if let (Some(seconds), Value::Object(map)) = (retry_after, &mut details) {
                map.insert("retryAfterSeconds".into(), json!(seconds));
            }
            retryable(&format!("GitHub API rate limit exceeded{suffix}"), details)
        }
        403 => ActionError::fatal_with(
            &format!(
                "GitHub refused this request: {message} — the installation may not have permission for this repository."
            ),
            body,
        ),
        404 => ActionError::fatal_with(
            &format!("GitHub repository or issue not found: {message}"),
            body,
        ),
        410 => ActionError::fatal_with(
            &format!("Issues are disabled on this repository: {message}"),
            body,
        ),
        422 => ActionError::fatal_with(&format!("GitHub rejected this request: {message}"), body),
        _ => retryable(&format!("GitHub API error ({status}): {message}"), body),
    }
}

pub(super) async fn github_create_issue(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let repo = parse_repo(&text_or_empty(inputs.get("repo")));
    let title = text_or_empty(inputs.get("title")).trim().to_owned();
    let Some((owner, name)) = repo else {
        return Err(ActionError::fatal(
            "GitHub repository is required, as \"owner/repo\"",
        ));
    };
    if title.is_empty() {
        return Err(ActionError::fatal("GitHub issue title is required"));
    }
    let token = valid_token(ctx, "github", integration_id(inputs).as_deref()).await?;
    let mut body = json!({ "title": title });
    if let Some(text) = text_if(inputs.get("body")) {
        body["body"] = json!(text);
    }
    if let Some(labels) = parse_list(inputs.get("labels")) {
        body["labels"] = json!(labels);
    }
    if let Some(assignees) = parse_list(inputs.get("assignees")) {
        body["assignees"] = json!(assignees);
    }
    let response = send(
        ctx,
        github_request(
            "POST",
            &format!("https://api.github.com/repos/{owner}/{name}/issues"),
            &token,
            &body,
        ),
    )
    .await?;
    if !response.ok() {
        return Err(github_error(&response));
    }
    let answer = json_of(&response)?;
    let mut out = json!({ "ok": true });
    copy(&mut out, &answer, "number", "number");
    copy(&mut out, &answer, "html_url", "url");
    Ok(out)
}

pub(super) async fn github_create_comment(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let repo = parse_repo(&text_or_empty(inputs.get("repo")));
    let issue = js_number(inputs.get("issueNumber"));
    let body = text_or_empty(inputs.get("body")).trim().to_owned();
    let Some((owner, name)) = repo else {
        return Err(ActionError::fatal(
            "GitHub repository is required, as \"owner/repo\"",
        ));
    };
    if !(issue.is_finite() && issue > 0.0) {
        return Err(ActionError::fatal("GitHub issue/PR number is required"));
    }
    if body.is_empty() {
        return Err(ActionError::fatal("GitHub comment body is required"));
    }
    let token = valid_token(ctx, "github", integration_id(inputs).as_deref()).await?;
    let response = send(
        ctx,
        github_request(
            "POST",
            &format!(
                "https://api.github.com/repos/{owner}/{name}/issues/{}/comments",
                js_string(Some(&json!(issue)))
            ),
            &token,
            &json!({ "body": body }),
        ),
    )
    .await?;
    if !response.ok() {
        return Err(github_error(&response));
    }
    let answer = json_of(&response)?;
    let mut out = json!({ "ok": true });
    copy(&mut out, &answer, "id", "id");
    copy(&mut out, &answer, "html_url", "url");
    Ok(out)
}

// ── asana.* ─────────────────────────────────────────────────────────────────

fn asana_error(answer: &Value, status: u16) -> String {
    answer
        .pointer("/errors/0/message")
        .filter(|m| truthy(m))
        .map_or_else(|| status.to_string(), |m| as_text(Some(m)))
}

pub(super) async fn asana_create_task(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let name = text_or_empty(inputs.get("name"));
    if name.is_empty() {
        return Err(ActionError::plain("Asana task name is required"));
    }
    let project = text_if(inputs.get("projectId"));
    let workspace = text_if(inputs.get("workspaceId"));
    if project.is_none() && workspace.is_none() {
        return Err(ActionError::plain(
            "Asana task needs a projectId or workspaceId",
        ));
    }
    let token = token_credential(ctx, "asana", "Asana", inputs).await?;
    let mut data = json!({ "name": name });
    for (from, to) in [
        ("notes", "notes"),
        ("assignee", "assignee"),
        ("dueOn", "due_on"),
    ] {
        if let Some(value) = text_if(inputs.get(from)) {
            data[to] = json!(value);
        }
    }
    if let Some(project) = project {
        data["projects"] = json!([project]);
    } else if let Some(workspace) = workspace {
        data["workspace"] = json!(workspace);
    }
    let response = send(
        ctx,
        bearer_json(
            "POST",
            "https://app.asana.com/api/1.0/tasks",
            &token,
            &json!({ "data": data }),
        ),
    )
    .await?;
    let answer = json_of(&response)?;
    if !response.ok() {
        return Err(ActionError::plain(&format!(
            "Asana create failed: {}",
            asana_error(&answer, response.status)
        )));
    }
    let mut out = json!({ "created": true });
    if let Some(gid) = answer.pointer("/data/gid") {
        out["id"] = gid.clone();
    }
    Ok(out)
}

pub(super) async fn asana_update_task(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let task = text_or_empty(inputs.get("taskId"));
    if task.is_empty() {
        return Err(ActionError::plain("Asana taskId is required"));
    }
    let token = token_credential(ctx, "asana", "Asana", inputs).await?;
    let mut data = Map::new();
    if let Some(name) = inputs.get("name") {
        data.insert("name".into(), json!(as_text(Some(name))));
    }
    if let Some(notes) = inputs.get("notes") {
        data.insert("notes".into(), json!(as_text(Some(notes))));
    }
    if let Some(completed) = inputs.get("completed") {
        data.insert("completed".into(), json!(truthy(completed)));
    }
    if let Some(due) = inputs.get("dueOn") {
        data.insert("due_on".into(), json!(as_text(Some(due))));
    }
    let response = send(
        ctx,
        bearer_json(
            "PUT",
            &format!("https://app.asana.com/api/1.0/tasks/{task}"),
            &token,
            &json!({ "data": data }),
        ),
    )
    .await?;
    let answer = json_of(&response)?;
    if !response.ok() {
        return Err(ActionError::plain(&format!(
            "Asana update failed: {}",
            asana_error(&answer, response.status)
        )));
    }
    let mut out = json!({ "updated": true });
    if let Some(gid) = answer.pointer("/data/gid") {
        out["id"] = gid.clone();
    }
    Ok(out)
}
