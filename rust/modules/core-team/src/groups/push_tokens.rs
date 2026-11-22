//! `/api/push-tokens` (`app-api/src/routes/push-tokens`,
//! `services/push-tokens.ts`): the caller's mobile push tokens in
//! `device_tokens`, keyed by `(user, device, app)`. No permission: device
//! plumbing for every signed-in member, and no entity events.
//!
//! - `GET /`: the caller's active tokens, masked to their last 12 characters.
//! - `POST /`: register (re-activates a deactivated token).
//! - `POST /test`: send a test push to the caller's WeldChat devices through
//!   Expo, deactivating the tokens Expo calls invalid.
//! - `DELETE /?deviceId=`: deactivate a device's push and call tokens.
//!
//! Expo's push API is reached through [`ExpoGateway`], a request extension:
//! the Kubernetes editions have none yet (a test push then fails as when
//! Expo can't be reached), conformance builds send it through the test's
//! fetch stub.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Router};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, FromQueryResult, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::BoxFuture;
use weldsuite_schema::tenant::device_tokens as tokens;

use crate::{Caller, CoreTeamState, TeamError, TeamResult, answer, validate, validate_query};

pub(crate) fn router<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", get(list).post(register).delete(unregister))
        .route("/test", post(test))
}

/// `@weldsuite/notifications`' `CALL_DEVICE_SUFFIX`.
const CALL_DEVICE_SUFFIX: &str = ":call";
/// Call tokens ring a phone; they are never for ordinary pushes.
const CALL_TOKEN_TYPES: [&str; 2] = ["voip", "expo_call"];
const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";
const MAX_PER_REQUEST: usize = 100;

/// One HTTP POST to Expo's push API: the status and body, or why it could
/// not be sent (the workers' `fetch` throwing).
pub trait ExpoTransport: Send + Sync {
    fn post<'a>(
        &'a self,
        url: &'a str,
        body: String,
    ) -> BoxFuture<'a, Result<(u16, String), String>>;
}

/// The Expo transport a request uses, as a request extension.
#[derive(Clone)]
pub struct ExpoGateway(pub Arc<dyn ExpoTransport>);

impl std::fmt::Debug for ExpoGateway {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ExpoGateway")
    }
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// A `timestamp` as the route's `Date` serializes: `toISOString()`.
fn js_date(at: Option<PrimitiveDateTime>) -> Value {
    weldsuite_schema::js::timestamp::option::serialize(&at, serde_json::value::Serializer)
        .unwrap_or(Value::Null)
}

/// A listed token's columns.
#[derive(Debug, FromQueryResult)]
struct TokenRow {
    device_id: String,
    platform: String,
    app_code: String,
    token: String,
    last_used_at: Option<PrimitiveDateTime>,
    updated_at: PrimitiveDateTime,
}

async fn list(caller: Caller) -> Response {
    let rows: Result<Vec<TokenRow>, DbErr> = tokens::Entity::find()
        .select_only()
        .columns([
            tokens::Column::DeviceId,
            tokens::Column::Platform,
            tokens::Column::AppCode,
            tokens::Column::Token,
            tokens::Column::LastUsedAt,
            tokens::Column::UpdatedAt,
        ])
        .filter(tokens::Column::UserId.eq(&caller.user_id))
        .filter(tokens::Column::IsActive.is_null())
        .into_model()
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => {
            let tokens: Vec<Value> = rows
                .into_iter()
                .map(|row| {
                    // Masked, so screenshots never carry a whole token.
                    let units: Vec<u16> = row.token.encode_utf16().collect();
                    let start = units.len().saturating_sub(12);
                    let suffix = String::from_utf16_lossy(&units[start..]);
                    json!({
                        "deviceId": row.device_id,
                        "platform": row.platform,
                        "appCode": row.app_code,
                        "tokenSuffix": suffix,
                        "lastUsedAt": js_date(row.last_used_at),
                        "updatedAt": js_date(Some(row.updated_at)),
                    })
                })
                .collect();
            Data(Value::Array(tokens)).into_response()
        }
        Err(error) => TeamError::internal("Failed to list push tokens", error).respond(),
    }
}

// ── POST / ──────────────────────────────────────────────────────────────────

struct Registration {
    token: String,
    platform: String,
    device_id: String,
    token_type: String,
    app_code: String,
    device_model: Option<String>,
    os_version: Option<String>,
    app_version: Option<String>,
}

async fn register(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let input = validate(&headers, &body, |issues, fields| Registration {
                token: issues
                    .string(fields, "token", true, Some(1), None)
                    .unwrap_or_default(),
                platform: issues
                    .one_of(fields, "platform", &["ios", "android", "web"])
                    .unwrap_or_default(),
                device_id: issues
                    .string(fields, "deviceId", true, Some(1), None)
                    .unwrap_or_default(),
                token_type: issues
                    .choice(
                        fields,
                        "tokenType",
                        Presence::Optional,
                        &["expo", "fcm", "apns", "voip", "expo_call"],
                    )
                    .into_option()
                    .unwrap_or_else(|| "expo".to_owned()),
                app_code: issues
                    .string(fields, "appCode", false, Some(1), None)
                    .unwrap_or_else(|| "weldsuite".to_owned()),
                device_model: issues.string(fields, "deviceModel", false, None, None),
                os_version: issues.string(fields, "osVersion", false, None, None),
                app_version: issues.string(fields, "appVersion", false, None, None),
            })?;
            register_token(&caller.db, &caller.user_id, &input)
                .await
                .map_err(|error| TeamError::internal("Failed to register push token", error))?;
            Ok(Data(json!({
                "deviceId": input.device_id,
                "platform": input.platform,
                "registered": true,
            }))
            .into_response())
        }
        .await,
    )
}

/// `registerPushToken`: upsert on `(user, device, app)`; the optional device
/// details a re-registration leaves out stay as they were.
async fn register_token(db: &PgPool, user_id: &str, input: &Registration) -> Result<(), DbErr> {
    let stamp = utc_now();
    // `coalesce($detail, device_tokens.detail)`: a detail the registration
    // sent replaces the stored one.
    let details = [
        (tokens::Column::DeviceModel, &input.device_model),
        (tokens::Column::OsVersion, &input.os_version),
        (tokens::Column::AppVersion, &input.app_version),
    ]
    .into_iter()
    .filter(|(_, value)| value.is_some())
    .map(|(column, _)| column);
    let mut written = vec![
        tokens::Column::Token,
        tokens::Column::TokenType,
        tokens::Column::Platform,
    ];
    written.extend(details);
    written.extend([
        tokens::Column::IsActive,
        tokens::Column::LastUsedAt,
        tokens::Column::UpdatedAt,
    ]);
    tokens::Entity::insert(tokens::ActiveModel {
        id: Set(generate_id("dt")),
        user_id: Set(user_id.to_owned()),
        device_id: Set(input.device_id.clone()),
        platform: Set(input.platform.clone()),
        token: Set(input.token.clone()),
        token_type: Set(input.token_type.clone()),
        app_code: Set(input.app_code.clone()),
        device_model: Set(input.device_model.clone()),
        os_version: Set(input.os_version.clone()),
        app_version: Set(input.app_version.clone()),
        is_active: Set(None),
        last_used_at: Set(Some(stamp)),
        created_at: Set(stamp),
        updated_at: Set(stamp),
    })
    .on_conflict(
        OnConflict::columns([
            tokens::Column::UserId,
            tokens::Column::DeviceId,
            tokens::Column::AppCode,
        ])
        .update_columns(written)
        .to_owned(),
    )
    .exec_without_returning(&orm(db))
    .await?;
    Ok(())
}

// ── DELETE /?deviceId= ──────────────────────────────────────────────────────

async fn unregister(caller: Caller, RawQuery(query): RawQuery) -> Response {
    answer(
        async {
            let device_id = validate_query(query.as_deref(), |issues, values| {
                issues
                    .string(values, "deviceId", true, Some(1), None)
                    .unwrap_or_default()
            })?;
            let stamp = utc_now();
            tokens::Entity::update_many()
                .col_expr(tokens::Column::IsActive, Expr::value(stamp))
                .col_expr(tokens::Column::UpdatedAt, Expr::value(stamp))
                .filter(tokens::Column::UserId.eq(&caller.user_id))
                .filter(tokens::Column::DeviceId.is_in([
                    device_id.clone(),
                    format!("{device_id}{CALL_DEVICE_SUFFIX}"),
                ]))
                .exec(&orm(&caller.db))
                .await
                .map_err(|error| TeamError::internal("Failed to unregister push token", error))?;
            Ok(Data(json!({ "deviceId": device_id, "unregistered": true })).into_response())
        }
        .await,
    )
}

// ── POST /test ──────────────────────────────────────────────────────────────

async fn test(caller: Caller, expo: Option<Extension<ExpoGateway>>) -> Response {
    let expo = expo.map(|Extension(gateway)| gateway);
    answer(send_test(&caller, expo.as_ref()).await)
}

async fn send_test(caller: &Caller, expo: Option<&ExpoGateway>) -> TeamResult<Response> {
    const FAILED: &str = "Failed to send test push";
    let rows: Vec<(String, String, String)> = tokens::Entity::find()
        .select_only()
        .columns([
            tokens::Column::Token,
            tokens::Column::AppCode,
            tokens::Column::TokenType,
        ])
        .filter(tokens::Column::UserId.eq(&caller.user_id))
        .filter(tokens::Column::IsActive.is_null())
        .filter(tokens::Column::AppCode.is_in(["weldchat", "weldsuite"]))
        .into_tuple()
        .all(&orm(&caller.db))
        .await
        .map_err(|error| TeamError::internal(FAILED, error))?;

    // One Expo request per app: mixing EAS projects fails a whole batch.
    let mut by_app: Vec<(String, Vec<String>)> = Vec::new();
    for (token, app_code, token_type) in rows {
        if CALL_TOKEN_TYPES.contains(&token_type.as_str()) || token.is_empty() {
            continue;
        }
        match by_app.iter_mut().find(|(app, _)| *app == app_code) {
            Some((_, tokens)) => tokens.push(token),
            None => by_app.push((app_code, vec![token])),
        }
    }
    if by_app.is_empty() {
        return Err(TeamError::api(ApiError::bad_request(
            "No active WeldChat push token registered for this account. Open WeldChat, grant notification permission, then try again.",
        )));
    }

    let mut tickets: Vec<Value> = Vec::new();
    let mut invalid: Vec<String> = Vec::new();
    for (_, tokens) in by_app {
        let messages: Vec<Value> = tokens
            .into_iter()
            .map(|to| {
                json!({
                    "to": to,
                    "title": "WeldChat test",
                    "body": "If you see this, push delivery works.",
                    "sound": "default",
                    "priority": "high",
                    "channelId": "chat",
                    "data": {
                        "notificationType": "push_test",
                        "actionUrl": "",
                        "entityType": "",
                        "entityId": "",
                    },
                })
            })
            .collect();
        let sent = send_expo_push(expo, messages)
            .await
            .map_err(|error| TeamError::internal(FAILED, error))?;
        tickets.extend(sent.tickets);
        invalid.extend(sent.invalid_tokens);
    }

    let invalid: Vec<String> = invalid.into_iter().filter(|t| !t.is_empty()).collect();
    if !invalid.is_empty() {
        let stamp = utc_now();
        tokens::Entity::update_many()
            .col_expr(tokens::Column::IsActive, Expr::value(stamp))
            .col_expr(tokens::Column::UpdatedAt, Expr::value(stamp))
            .filter(tokens::Column::Token.is_in(invalid))
            .exec(&orm(&caller.db))
            .await
            .map_err(|error| TeamError::internal(FAILED, error))?;
    }

    let ok = tickets.iter().filter(|t| t["status"] == "ok").count();
    let failed: Vec<&Value> = tickets.iter().filter(|t| t["status"] == "error").collect();
    if ok == 0 {
        let first = failed.first().copied().unwrap_or(&Value::Null);
        let message = truthy_text(&first["message"])
            .or_else(|| truthy_text(&first["details"]["error"]))
            .unwrap_or_else(|| "Expo rejected the test push".to_owned());
        return Err(TeamError::api(ApiError::internal().with_message(message)));
    }
    let errors: Vec<Value> = failed
        .iter()
        .map(|t| {
            json!(
                truthy_text(&t["details"]["error"])
                    .or_else(|| truthy_text(&t["message"]))
                    .unwrap_or_else(|| "error".to_owned())
            )
        })
        .collect();
    Ok(Data(json!({ "sent": ok, "failed": failed.len(), "errors": errors })).into_response())
}

/// A non-empty string, as `x || …` keeps it.
fn truthy_text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

// ── Expo's push API (`@weldsuite/notifications` `sendExpoPush`) ─────────────

struct ExpoResult {
    tickets: Vec<Value>,
    invalid_tokens: Vec<String>,
}

/// `/^(Exponent|Expo)PushToken\[.+\]$/`.
fn is_expo_push_token(token: &str) -> bool {
    ["ExponentPushToken[", "ExpoPushToken["]
        .iter()
        .find_map(|prefix| token.strip_prefix(prefix))
        .and_then(|rest| rest.strip_suffix(']'))
        .is_some_and(|inner| {
            !inner.is_empty() && !inner.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
        })
}

/// `formatExpoHttpError`: a readable reason from Expo's error body.
fn format_expo_http_error(status: u16, body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return format!("HTTP {status}");
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        if let Some(errors) = parsed["errors"].as_array() {
            let joined = errors
                .iter()
                .map(|e| {
                    [&e["code"], &e["message"]]
                        .iter()
                        .filter_map(|v| truthy_text(v))
                        .collect::<Vec<_>>()
                        .join(": ")
                })
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("; ");
            if !joined.is_empty() {
                return format!("HTTP {status}: {joined}");
            }
        }
        if let Some(error) = truthy_text(&parsed["error"]) {
            return format!("HTTP {status}: {error}");
        }
        if let Some(message) = truthy_text(&parsed["error"]["message"]) {
            return format!("HTTP {status}: {message}");
        }
        if let Some(message) = truthy_text(&parsed["message"]) {
            return format!("HTTP {status}: {message}");
        }
    }
    let units: Vec<u16> = trimmed.encode_utf16().take(300).collect();
    let head = String::from_utf16_lossy(&units);
    format!("HTTP {status}: {head}")
}

/// `postExpoChunk`: one request; a rejected batch of several is retried one
/// message at a time, so the good tokens still deliver.
fn post_chunk<'a>(
    expo: Option<&'a ExpoGateway>,
    chunk: &'a [Value],
) -> BoxFuture<'a, Result<Vec<Value>, String>> {
    Box::pin(async move {
        let Some(expo) = expo else {
            return Err("no Expo push transport is configured".to_owned());
        };
        let (status, body) = expo
            .0
            .post(EXPO_PUSH_URL, Value::Array(chunk.to_vec()).to_string())
            .await?;
        if (200..300).contains(&status) {
            let parsed: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
            return parsed["data"]
                .as_array()
                .cloned()
                .ok_or_else(|| "Expo answered without data".to_owned());
        }
        let message = format_expo_http_error(status, &body);
        tracing::error!(message, "push-tokens: Expo API error");
        if chunk.len() > 1 && (status == 400 || status == 403) {
            let mut tickets = Vec::new();
            for message in chunk {
                tickets.extend(post_chunk(Some(expo), std::slice::from_ref(message)).await?);
            }
            return Ok(tickets);
        }
        Ok(chunk
            .iter()
            .map(|_| json!({ "status": "error", "message": message }))
            .collect())
    })
}

async fn send_expo_push(
    expo: Option<&ExpoGateway>,
    messages: Vec<Value>,
) -> Result<ExpoResult, String> {
    let mut tickets = Vec::new();
    let mut invalid_tokens = Vec::new();
    let mut eligible = Vec::new();
    for message in messages {
        let to = message["to"].as_str().unwrap_or_default().to_owned();
        if to.is_empty() || !is_expo_push_token(&to) {
            tickets.push(json!({
                "status": "error",
                "message": "Not an Expo push token (ExponentPushToken[…]). Re-open the app to re-register.",
                "details": { "error": "InvalidCredentials" },
            }));
            if !to.is_empty() {
                invalid_tokens.push(to);
            }
            continue;
        }
        eligible.push(message);
    }
    for chunk in eligible.chunks(MAX_PER_REQUEST) {
        let sent = post_chunk(expo, chunk).await?;
        for (index, ticket) in sent.iter().enumerate() {
            if ticket["status"] == "error" && ticket["details"]["error"] == "DeviceNotRegistered" {
                invalid_tokens.push(
                    chunk
                        .get(index)
                        .and_then(|m| m["to"].as_str())
                        .unwrap_or_default()
                        .to_owned(),
                );
            }
        }
        tickets.extend(sent);
    }
    Ok(ExpoResult {
        tickets,
        invalid_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expo_tokens_match_the_pattern() {
        assert!(is_expo_push_token("ExponentPushToken[abc]"));
        assert!(is_expo_push_token("ExpoPushToken[x]"));
        assert!(!is_expo_push_token("ExponentPushToken[]"));
        assert!(!is_expo_push_token("fcm:abc"));
    }

    #[test]
    fn expo_errors_read_like_format_expo_http_error() {
        assert_eq!(format_expo_http_error(400, ""), "HTTP 400");
        assert_eq!(
            format_expo_http_error(
                400,
                r#"{"errors":[{"code":"PUSH_TOO_MANY_EXPERIENCE_IDS","message":"mixed"}]}"#
            ),
            "HTTP 400: PUSH_TOO_MANY_EXPERIENCE_IDS: mixed"
        );
        assert_eq!(
            format_expo_http_error(500, r#"{"error":"down"}"#),
            "HTTP 500: down"
        );
        assert_eq!(
            format_expo_http_error(502, "Bad gateway"),
            "HTTP 502: Bad gateway"
        );
    }
}
