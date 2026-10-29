//! `weld login`'s device-code flow, `/api/cli-auth/*`
//! (`routes/cli-auth/index.ts`, `services/cli-auth.ts`):
//!
//! - `POST /device` (public): a pending session, with the codes;
//! - `POST /token` (public): the CLI polls until the key is minted (once);
//! - `POST /approve` (session + workspace): the developer portal confirms and
//!   mints a personal `wsk_` key.
//!
//! Sessions live in the workspace cache for ten minutes. No entity events:
//! credentials are infrastructure, as for API keys.

use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_kit::id::generate_id;
use weldsuite_kit::{ApiError, Data};
use weldsuite_ports::DynCache;

use crate::CoreAppsState;
use crate::access::{AppsError, AppsResult, Caller, OrInternal, Public, answer, now, now_ms, validate};
use crate::bundle_access::encode_uri_component;
use crate::schemas;
use crate::scopes::{random_hex, sha256_hex};

const CLI_AUTH_TTL_SECONDS: i64 = 600;
const CLI_AUTH_POLL_INTERVAL_SECONDS: i64 = 2;
const CLI_KEY_NAME: &str = "Weld CLI";
const CLI_KEY_SCOPES: [&str; 1] = ["user-apps:manage"];
/// No ambiguous I/O/0/1: easy to read aloud and type.
const USER_CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub(crate) fn public_router() -> Router<CoreAppsState> {
    Router::new()
        .route("/device", post(device))
        .route("/token", post(token))
}

pub(crate) fn approve_router() -> Router<CoreAppsState> {
    Router::new().route("/approve", post(approve))
}

fn device_key(device_code: &str) -> String {
    format!("cli-auth:device:{device_code}")
}

fn user_key(user_code: &str) -> String {
    format!("cli-auth:user:{}", normalize_user_code(user_code))
}

/// Upper case, letters and digits only.
fn normalize_user_code(raw: &str) -> String {
    weldsuite_kit::validation::js_trim(raw)
        .to_uppercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

/// `ABCD-EFGH`.
fn format_user_code(code: &str) -> String {
    let clean = normalize_user_code(code);
    if clean.len() <= 4 {
        return clean;
    }
    format!("{}-{}", &clean[..4], &clean[4..])
}

fn generate_user_code() -> String {
    let mut bytes = [0u8; 8];
    aws_lc_rs::rand::fill(&mut bytes).expect("the system random source works");
    bytes
        .iter()
        .map(|b| char::from(USER_CODE_ALPHABET[usize::from(*b) % USER_CODE_ALPHABET.len()]))
        .collect()
}

fn is_test_environment(environment: Option<&str>) -> bool {
    matches!(environment, Some("test" | "preview"))
}

/// The external-api host the minted key talks to.
fn default_external_api_url(environment: Option<&str>) -> &'static str {
    if is_test_environment(environment) {
        "https://api-test.weldsuite.org"
    } else {
        "https://api.weldsuite.org"
    }
}

/// `resolveLoginUrl`: only first-party developer portals (no open redirect).
fn resolve_login_url(requested: Option<&str>, environment: Option<&str>) -> String {
    let fallback = if is_test_environment(environment) {
        "https://developer-test.weldsuite.org"
    } else {
        "https://developer.weldsuite.org"
    }
    .to_owned();
    let Some(Ok(mut url)) = requested.map(url::Url::parse) else {
        return fallback;
    };
    const ALLOWED: [&str; 4] = [
        "developer.weldsuite.org",
        "developer-test.weldsuite.org",
        "localhost",
        "127.0.0.1",
    ];
    let host = url.host_str().unwrap_or_default().to_owned();
    let allowed = ALLOWED.contains(&host.as_str());
    if url.scheme() != "https" && !(url.scheme() == "http" && allowed) {
        return fallback;
    }
    if !allowed {
        return fallback;
    }
    if (host == "localhost" || host == "127.0.0.1") && url.port().is_none() {
        let _ = url.set_port(Some(3202));
    }
    url.origin().ascii_serialization()
}

/// Both keys of a session, for `ttl_seconds`.
async fn put_session(cache: &dyn DynCache, session: &Value, ttl_seconds: i64) -> Result<(), String> {
    let ttl = Some(Duration::from_secs(u64::try_from(ttl_seconds).unwrap_or(0)));
    let device_code = session["deviceCode"].as_str().unwrap_or_default();
    let user_code = session["userCode"].as_str().unwrap_or_default();
    cache
        .put_boxed(&device_key(device_code), &session.to_string(), ttl)
        .await
        .map_err(|e| e.to_string())?;
    cache
        .put_boxed(&user_key(user_code), device_code, ttl)
        .await
        .map_err(|e| e.to_string())
}

async fn session_by_device(cache: &dyn DynCache, device_code: &str) -> Result<Option<Value>, String> {
    match cache.get_boxed(&device_key(device_code)).await.map_err(|e| e.to_string())? {
        Some(text) => serde_json::from_str::<Value>(&text)
            .map(|value| (!value.is_null()).then_some(value))
            .map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

// ── POST /device ─────────────────────────────────────────────────────────────

async fn device(State(state): State<CoreAppsState>, public: Public, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let requested = validate(&headers, &body, schemas::cli_device)?;
            let overrides = &public.overrides;
            let login_url = resolve_login_url(requested.as_deref(), overrides.env(&state, "ENVIRONMENT"));
            let device_code = random_hex(32);
            let user_code = generate_user_code();
            let display = format_user_code(&user_code);
            let cache = overrides.cache(&state)?;
            let session = json!({
                "status": "pending",
                "deviceCode": device_code,
                "userCode": user_code,
                "createdAt": now_ms(),
            });
            put_session(cache.as_ref(), &session, CLI_AUTH_TTL_SECONDS)
                .await
                .map_err(|e| AppsError::internal("Internal Server Error", e))?;
            let verification_uri = format!("{login_url}/cli-auth");
            Ok(Data(json!({
                "deviceCode": device_code,
                "userCode": display,
                "verificationUri": verification_uri,
                "verificationUriComplete": format!("{verification_uri}?code={}", encode_uri_component(&display)),
                "expiresIn": CLI_AUTH_TTL_SECONDS,
                "interval": CLI_AUTH_POLL_INTERVAL_SECONDS,
            }))
            .into_response())
        }
        .await,
    )
}

// ── POST /token ──────────────────────────────────────────────────────────────

async fn token(State(state): State<CoreAppsState>, public: Public, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let device_code = validate(&headers, &body, schemas::cli_token)?;
            let cache = public.overrides.cache(&state)?;
            let session = session_by_device(cache.as_ref(), &device_code)
                .await
                .map_err(|e| AppsError::internal("Internal Server Error", e))?;
            let Some(session) = session else {
                return Err(ApiError::bad_request("Device code expired or unknown. Run weld login again.").into());
            };
            if session["status"] == "pending" {
                return Ok(Data(json!({ "status": "pending", "interval": CLI_AUTH_POLL_INTERVAL_SECONDS })).into_response());
            }
            // One-shot: gone before the key is handed over.
            for key in [
                device_key(session["deviceCode"].as_str().unwrap_or("undefined")),
                user_key(session["userCode"].as_str().unwrap_or("undefined")),
            ] {
                cache
                    .delete_boxed(&key)
                    .await
                    .map_err(|e| AppsError::internal("Internal Server Error", e))?;
            }
            let mut out = Map::new();
            out.insert("status".to_owned(), json!("complete"));
            for key in ["apiKey", "keyId", "keyPrefix", "orgId", "orgName", "userId", "email", "apiUrl"] {
                if let Some(value) = session.get(key) {
                    out.insert(key.to_owned(), value.clone());
                }
            }
            Ok(Data(Value::Object(out)).into_response())
        }
        .await,
    )
}

// ── POST /approve ────────────────────────────────────────────────────────────

/// `generateApiKey`: `wsk_` + 64 hex, its SHA-256, and `wsk_` + 8 hex to show.
fn generate_api_key() -> (String, String, String) {
    let key = format!("wsk_{}", random_hex(32));
    let hash = sha256_hex(&key);
    let prefix = format!("wsk_{}", &key[4..12]);
    (key, hash, prefix)
}

/// `registerApiKey`: best-effort; a key that lists but can't authenticate is
/// recoverable, a thrown error after the plaintext was minted is not.
async fn register_api_key(master: &PgPool, org: &str, hash: &str, tenant_key_id: &str) {
    let result: Result<(), sqlx::Error> = async {
        let workspace: Option<String> = sqlx::query_scalar(
            "select id from workspaces where id = $1 or clerk_org_id = $1 limit 1",
        )
        .bind(org)
        .fetch_optional(master)
        .await?;
        let Some(workspace_id) = workspace else {
            tracing::error!(org, tenant_key_id, "core-apps: no master workspace; the CLI key will not authenticate");
            return Ok(());
        };
        sqlx::query(
            "insert into api_key_registry (id, key_hash, key_type, workspace_id, tenant_key_id, created_at)
             values ($1, $2, 'personal', $3, $4, $5::timestamptz)",
        )
        .bind(generate_id("akr"))
        .bind(hash)
        .bind(workspace_id)
        .bind(tenant_key_id)
        .bind(now())
        .execute(master)
        .await?;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        tracing::error!(%error, "core-apps: failed to write the CLI key to the master registry");
    }
}

/// `unregisterApiKey`: best-effort.
async fn unregister_api_key(master: &PgPool, tenant_key_id: &str) {
    if let Err(error) = sqlx::query("delete from api_key_registry where tenant_key_id = $1")
        .bind(tenant_key_id)
        .execute(master)
        .await
    {
        tracing::error!(%error, "core-apps: failed to remove a key from the master registry");
    }
}

async fn approve(State(state): State<CoreAppsState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(approve_with(&state, &caller, &headers, &body).await)
}

async fn approve_with(state: &CoreAppsState, caller: &Caller, headers: &HeaderMap, body: &Bytes) -> AppsResult<Response> {
    const FAILED: &str = "Failed to authorize the CLI";
    let raw_code = validate(headers, body, schemas::cli_approve)?;
    let Some(org_id) = caller.org_id.clone().filter(|org| !org.is_empty()) else {
        return Err(ApiError::unauthorized().into());
    };
    let cache = caller.overrides.cache(state)?;
    let device_code = cache
        .get_boxed(&user_key(&raw_code))
        .await
        .map_err(|e| AppsError::internal("Internal Server Error", e))?
        .filter(|code| !code.is_empty());
    let session = match device_code {
        Some(device_code) => session_by_device(cache.as_ref(), &device_code)
            .await
            .map_err(|e| AppsError::internal("Internal Server Error", e))?,
        None => None,
    };
    let Some(session) = session else {
        return Err(ApiError::bad_request("Code expired or unknown. Run weld login again in the terminal.").into());
    };
    if session["status"] == "complete" {
        return Ok(Data(json!({ "status": "complete", "alreadyApproved": true })).into_response());
    }

    let master = caller.master(state);
    let now = now();
    // Earlier Weld CLI keys of this user go: no key sprawl.
    let earlier: Vec<String> = sqlx::query_scalar(
        "select id from api_keys where user_id = $1 and name = $2 and deleted_at is null",
    )
    .bind(&caller.user_id)
    .bind(CLI_KEY_NAME)
    .fetch_all(&caller.db)
    .await
    .or_internal(FAILED)?;
    for id in &earlier {
        sqlx::query(
            "update api_keys set deleted_at = $3::timestamptz, updated_at = $3::timestamptz
             where id = $1 and user_id = $2",
        )
        .bind(id)
        .bind(&caller.user_id)
        .bind(&now)
        .execute(&caller.db)
        .await
        .or_internal(FAILED)?;
        unregister_api_key(&master, id).await;
    }

    let (key, hash, prefix) = generate_api_key();
    let id = generate_id("ak");
    sqlx::query(
        "insert into api_keys
           (id, user_id, name, description, key_hash, key_prefix, scopes, expires_at, created_at, updated_at)
         values ($1, $2, $3, 'Minted by weld login (device code)', $4, $5, $6::jsonb, null,
                 $7::timestamptz, $7::timestamptz)",
    )
    .bind(&id)
    .bind(&caller.user_id)
    .bind(CLI_KEY_NAME)
    .bind(&hash)
    .bind(&prefix)
    .bind(json!(CLI_KEY_SCOPES))
    .bind(&now)
    .execute(&caller.db)
    .await
    .or_internal(FAILED)?;
    register_api_key(&master, &org_id, &hash, &id).await;

    // Labels for the CLI; both calls go out, and either failing drops both.
    let (mut email, mut org_name) = (Value::Null, Value::Null);
    if let Some(identity) = caller.overrides.identity(state) {
        let user = identity.user_profile(&caller.user_id).await;
        let org = identity.organization(&org_id).await;
        match (user, org) {
            (Ok(user), Ok(org)) => {
                email = user.primary_email().map_or(Value::Null, |e| json!(e));
                org_name = json!(org.name);
            }
            (user, org) => {
                let error = user.err().map(|e| e.to_string()).or_else(|| org.err().map(|e| e.to_string()));
                tracing::warn!(error, "core-apps: could not load the identity provider's labels");
            }
        }
    }

    let created_at = session["createdAt"].as_f64().unwrap_or(0.0);
    let complete = json!({
        "status": "complete",
        "deviceCode": session["deviceCode"],
        "userCode": session["userCode"],
        "createdAt": session["createdAt"],
        "apiKey": key,
        "keyId": id,
        "keyPrefix": prefix,
        "orgId": org_id,
        "orgName": org_name,
        "userId": caller.user_id,
        "email": email,
        "apiUrl": default_external_api_url(caller.overrides.env(state, "ENVIRONMENT")),
    });
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    let elapsed = ((now_ms() as f64 - created_at) / 1000.0).floor() as i64;
    let remaining = (CLI_AUTH_TTL_SECONDS - elapsed).max(30);
    put_session(cache.as_ref(), &complete, remaining)
        .await
        .map_err(|e| AppsError::internal(FAILED, e))?;
    Ok(Data(json!({
        "status": "complete",
        "keyPrefix": prefix,
        "orgId": org_id,
        "orgName": org_name,
        "email": email,
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_codes_read_aloud() {
        assert_eq!(normalize_user_code(" abcd-2345 "), "ABCD2345");
        assert_eq!(format_user_code("abcd2345"), "ABCD-2345");
        assert_eq!(format_user_code("abc"), "ABC");
        let code = generate_user_code();
        assert_eq!(code.len(), 8);
        assert!(code.bytes().all(|b| USER_CODE_ALPHABET.contains(&b)));
    }

    #[test]
    fn login_urls_stay_first_party() {
        assert_eq!(
            resolve_login_url(Some("http://localhost/anything"), Some("test")),
            "http://localhost:3202"
        );
        assert_eq!(
            resolve_login_url(Some("https://evil.example.com"), Some("test")),
            "https://developer-test.weldsuite.org"
        );
        assert_eq!(resolve_login_url(None, Some("production")), "https://developer.weldsuite.org");
        assert_eq!(
            resolve_login_url(Some("http://developer.weldsuite.org"), None),
            "http://developer.weldsuite.org"
        );
    }
}
