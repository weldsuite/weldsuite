//! `POST /v1/oauth/token` (`routes/oauth.ts`): the OAuth 2.0
//! `client_credentials` grant for an installed WeldApp's backend. The client
//! credentials in the body are the authentication (the route sits before
//! the key layers); the answer is a one-hour `wsat_` session token with the
//! install's granted scopes, in RFC 6749's shape, not the house envelope.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::id::{generate_id, random_string};

use crate::auth::sha256_hex;
use crate::{ExternalApiState, master_db};

const TOKEN_TTL_SECONDS: i64 = 3600;

/// `{ error, error_description }` with its status.
fn oauth_error(status: StatusCode, code: &str, description: &str) -> Response {
    (
        status,
        Json(json!({ "error": code, "error_description": description })),
    )
        .into_response()
}

/// The four fields of a token request.
#[derive(Default)]
struct TokenRequest {
    grant_type: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    workspace_id: Option<String>,
}

/// A JSON body's field as the route reads it: `body.grant_type` compared to
/// a string, `!body.client_id` for presence (a non-string value keeps its
/// JavaScript text).
fn json_field(body: &Value, key: &str) -> Option<String> {
    match body.get(key)? {
        Value::String(text) => Some(text.clone()),
        Value::Null | Value::Bool(false) => None,
        Value::Number(number) if number.as_f64() == Some(0.0) => None,
        Value::Bool(true) => Some("true".to_owned()),
        Value::Number(number) => Some(number.to_string()),
        Value::Array(_) | Value::Object(_) => Some(String::from("[object]")),
    }
}

/// `parseTokenRequest`: JSON when the content type says so, else a form
/// (`c.req.parseBody()`: url-encoded or multipart, any other type reads as
/// empty). `None` is a body that could not be read.
async fn parse_token_request(request: Request) -> Option<TokenRequest> {
    let content_type = request
        .headers()
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    if content_type.contains("application/json") {
        let bytes = axum::body::to_bytes(request.into_body(), usize::MAX)
            .await
            .ok()?;
        let body: Value = serde_json::from_slice(&bytes).ok()?;
        // `if (!body)`: a falsy JSON value is a malformed request.
        let falsy = match &body {
            Value::Null | Value::Bool(false) => true,
            Value::String(text) => text.is_empty(),
            Value::Number(number) => number.as_f64() == Some(0.0),
            _ => false,
        };
        if falsy {
            return None;
        }
        return Some(TokenRequest {
            grant_type: json_field(&body, "grant_type"),
            client_id: json_field(&body, "client_id"),
            client_secret: json_field(&body, "client_secret"),
            workspace_id: json_field(&body, "workspace_id"),
        });
    }
    let media = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let mut fields: Vec<(String, String)> = Vec::new();
    if media == "application/x-www-form-urlencoded" {
        let bytes: Bytes = axum::body::to_bytes(request.into_body(), usize::MAX)
            .await
            .ok()?;
        fields = form_urlencoded::parse(&bytes).into_owned().collect();
    } else if media == "multipart/form-data" {
        let mut multipart =
            <axum::extract::Multipart as axum::extract::FromRequest<()>>::from_request(
                request,
                &(),
            )
            .await
            .ok()?;
        while let Some(field) = multipart.next_field().await.ok()? {
            let Some(name) = field.name().map(str::to_owned) else {
                continue;
            };
            // A file part is not a string field.
            if field.file_name().is_some() {
                continue;
            }
            let text = field.text().await.ok()?;
            fields.push((name, text));
        }
    }
    // `parseBody` keeps the last value of a repeated field.
    let pick = |key: &str| {
        fields
            .iter()
            .rev()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };
    Some(TokenRequest {
        grant_type: pick("grant_type"),
        client_id: pick("client_id"),
        client_secret: pick("client_secret"),
        workspace_id: pick("workspace_id"),
    })
}

/// Constant-time comparison of two hex digests.
fn timing_safe_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |diff, (x, y)| diff | (x ^ y))
        == 0
}

/// `POST /v1/oauth/token`.
pub(crate) async fn token(State(state): State<ExternalApiState>, request: Request) -> Response {
    let master = master_db(&state, request.extensions());
    let Some(body) = parse_token_request(request).await else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "Malformed request body",
        );
    };
    if body.grant_type.as_deref() != Some("client_credentials") {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "unsupported_grant_type",
            "Only grant_type=client_credentials is supported",
        );
    }
    let present = |value: &Option<String>| {
        value
            .as_deref()
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let (Some(client_id), Some(client_secret), Some(workspace_id)) = (
        present(&body.client_id),
        present(&body.client_secret),
        present(&body.workspace_id),
    ) else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "client_id, client_secret and workspace_id are required",
        );
    };
    match mint(&master, &client_id, &client_secret, &workspace_id).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "external-api: oauth token failed");
            crate::session::internal().into_response()
        }
    }
}

async fn mint(
    master: &weldsuite_db::PgPool,
    client_id: &str,
    client_secret: &str,
    workspace_id: &str,
) -> Result<Response, sqlx::Error> {
    let client: Option<(String, String)> = sqlx::query_as(
        "select c.app_id, c.client_secret_hash from user_app_oauth_clients c
           join user_apps a on a.id = c.app_id
          where c.client_id = $1 and a.is_active = true and a.deleted_at is null
          limit 1",
    )
    .bind(client_id)
    .fetch_optional(master)
    .await?;
    let secret_hash = sha256_hex(client_secret);
    let Some((app_id, _)) = client
        .as_ref()
        .filter(|(_, stored)| timing_safe_equal(&secret_hash, stored))
    else {
        return Ok(oauth_error(
            StatusCode::UNAUTHORIZED,
            "invalid_client",
            "Unknown client or invalid client secret",
        ));
    };
    let install: Option<(String, Option<Value>)> = sqlx::query_as(
        "select id, granted_scopes from user_app_installs
          where app_id = $1 and workspace_id = $2 and status = 'active'
          limit 1",
    )
    .bind(app_id)
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    let Some((install_id, granted)) = install else {
        return Ok(oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_grant",
            "App is not installed (or install is revoked) in the requested workspace",
        ));
    };
    let token = format!("wsat_{}", random_string(40, "0123456789abcdef"));
    let now = OffsetDateTime::now_utc();
    let expires_at = now + time::Duration::seconds(TOKEN_TTL_SECONDS);
    // `?? []`: a null column is no scopes.
    let scopes = match granted {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    };
    sqlx::query(
        "insert into user_app_tokens
           (id, install_id, app_id, workspace_id, token_hash, token_prefix, token_type, scopes, expires_at, created_at)
         values ($1, $2, $3, $4, $5, $6, 'session', $7, $8::timestamptz, $9::timestamptz)",
    )
    .bind(generate_id("uat"))
    .bind(&install_id)
    .bind(app_id)
    .bind(workspace_id)
    .bind(sha256_hex(&token))
    .bind(&token[..12])
    .bind(Value::Array(scopes.clone()))
    .bind(iso_timestamp(expires_at))
    .bind(iso_timestamp(now))
    .execute(master)
    .await?;
    let scope = scopes
        .iter()
        .map(|scope| {
            scope
                .as_str()
                .map_or_else(|| scope.to_string(), str::to_owned)
        })
        .collect::<Vec<_>>()
        .join(" ");
    Ok(Json(json!({
        "access_token": token,
        "token_type": "Bearer",
        "expires_in": TOKEN_TTL_SECONDS,
        "scope": scope,
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_fields_read_like_javascript() {
        let body = json!({ "a": "x", "b": "", "c": 5, "d": null });
        assert_eq!(json_field(&body, "a").as_deref(), Some("x"));
        assert_eq!(json_field(&body, "b").as_deref(), Some(""));
        assert_eq!(json_field(&body, "c").as_deref(), Some("5"));
        assert_eq!(json_field(&body, "d"), None);
        assert_eq!(json_field(&body, "e"), None);
    }

    #[test]
    fn secrets_compare_in_constant_time() {
        assert!(timing_safe_equal("abc", "abc"));
        assert!(!timing_safe_equal("abc", "abd"));
        assert!(!timing_safe_equal("abc", "ab"));
    }
}
