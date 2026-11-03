//! Connecting a store or accounting account (`connectors/auth.ts`,
//! `connectors/stripe-auth.ts`, `@weldsuite/connectors` `woocommerce/auth.ts`):
//! WooCommerce's application authentication (the shop posts API keys to our
//! callback, the `user_id` an HMAC-signed state), Moneybird's OAuth with its
//! administration picker, and Stripe Connect OAuth. What a finished
//! connection starts in the background (webhooks, the event, the first sync)
//! runs on the event tracker.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEvent, EventContext, EventSource, EventType};
use weldsuite_ports::DynCache;

use crate::connections::{
    NewConnection, SettingsUpdate, encrypt_credentials, encrypt_webhook_secret,
    ensure_pending_connection, get_connection, sanitize_connection, seed_default_field_mappings,
    update_connection_settings, upsert_connection,
};
use crate::moneybird::{self, Administration, Moneybird};
use crate::stripe::{self, Stripe};
use crate::sync::{SyncArgs, SyncEnv, Trigger, sync_connection};
use crate::webhooks::{
    generate_webhook_secret, put_stripe_account_mapping, put_webhook_mapping,
    register_connection_webhooks,
};

pub const WOOCOMMERCE_APP_NAME: &str = "WeldSuite";
pub const WOOCOMMERCE_AUTH_CALLBACK_PATH: &str = "/webhooks/woocommerce/auth";
const WOOCOMMERCE_AUTH_STATE_TTL_SECONDS: i64 = 15 * 60;
const MONEYBIRD_STATE_PREFIX: &str = "mb_oauth_state:";
const STRIPE_STATE_PREFIX: &str = "stripe_oauth_state:";

/// What the connect flows read (`ConnectorAuthEnv`).
#[derive(Clone)]
pub struct AuthEnv {
    pub sync: SyncEnv,
    /// `WORKSPACE_CACHE`: OAuth states and the webhook mappings.
    pub cache: Option<Arc<dyn DynCache>>,
    pub internal_api_secret: Option<String>,
    pub app_api_public_url: Option<String>,
    pub public_app_url: Option<String>,
    pub environment: Option<String>,
    pub moneybird_client_id: Option<String>,
    pub moneybird_client_secret: Option<String>,
    pub stripe_connect_client_id: Option<String>,
    /// `connectorWebhookBaseUrl(env)`.
    pub webhook_base_url: String,
}

impl AuthEnv {
    fn public_app_url(&self) -> String {
        self.public_app_url
            .clone()
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| "https://app.weldsuite.org".to_owned())
    }

    fn trimmed(value: Option<&String>) -> Option<String> {
        value
            .map(|v| weldsuite_kit::validation::js_trim(v).to_owned())
            .filter(|v| !v.is_empty())
    }
}

/// A refusal of the flow: `{ error, status }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub error: String,
    pub status: u16,
}

fn refused(error: impl Into<String>, status: u16) -> Refused {
    Refused {
        error: error.into(),
        status,
    }
}

/// Why a flow stopped: refused, or the database.
#[derive(Debug)]
pub enum AuthError {
    Refused(Refused),
    Database(sqlx::Error),
    Other(String),
}

impl From<sqlx::Error> for AuthError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<Refused> for AuthError {
    fn from(refused: Refused) -> Self {
        Self::Refused(refused)
    }
}

// ── return URLs, callback URLs ──────────────────────────────────────────────

/// `isAllowedConnectorReturnUrl(url)`.
pub fn is_allowed_return_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return false;
    }
    let host = parsed.host_str().unwrap_or_default();
    let allowed = matches!(
        host,
        "localhost" | "127.0.0.1" | "app.weldsuite.org" | "app-test.weldsuite.org"
    ) || host.ends_with(".weldsuite.pages.dev");
    if !allowed {
        return false;
    }
    let pathname = parsed.path();
    let path = pathname
        .strip_prefix("/w/")
        .and_then(|rest| {
            let slash = rest.find('/')?;
            (slash > 0).then(|| &rest[slash..])
        })
        .unwrap_or(pathname);
    path == "/weldconnect/connectors"
        || path == "/weldconnect/connectors/"
        || path.starts_with("/weldconnect/connectors/")
        || path.starts_with("/settings/integrations/woocommerce")
        || path.starts_with("/settings/integrations/shopify")
        || path.starts_with("/settings/integrations/moneybird")
}

fn https_origin(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let with = if value.contains("://") {
        value.to_owned()
    } else {
        format!("https://{value}")
    };
    let parsed = url::Url::parse(&with).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

/// `resolveWooCommerceAuthCallbackUrl({ requestOrigin, appApiPublicUrl, environment })`.
pub fn woo_callback_url(
    request_origin: Option<&str>,
    app_api_public_url: Option<&str>,
    environment: Option<&str>,
) -> Option<String> {
    let from_env = match environment {
        Some("production") => Some("https://app-api.weldsuite.org"),
        Some("test") => Some("https://app-api-test.weldsuite.org"),
        _ => None,
    };
    let origin = https_origin(request_origin)
        .or_else(|| https_origin(app_api_public_url))
        .or_else(|| https_origin(from_env))?;
    Some(format!(
        "{}{WOOCOMMERCE_AUTH_CALLBACK_PATH}",
        origin.trim_end_matches('/')
    ))
}

/// `buildWooCommerceAuthUrl({ storeUrl, userId, returnUrl, callbackUrl })`.
fn woo_auth_url(store_url: &str, user_id: &str, return_url: &str, callback_url: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("app_name", WOOCOMMERCE_APP_NAME)
        .append_pair("scope", "read_write")
        .append_pair("user_id", user_id)
        .append_pair("return_url", return_url)
        .append_pair("callback_url", callback_url)
        .finish();
    format!("{store_url}/wc-auth/v1/authorize?{query}")
}

type HmacSha256 = Hmac<Sha256>;

fn mac(secret: &str, message: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(message.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The signed WooCommerce `user_id` state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WooState {
    pub clerk_org_id: String,
    pub connection_id: String,
    pub connected_by: String,
}

/// `signWooCommerceAuthUserId(state, secret)`: `wooa.<body>.<mac>`, the body
/// `JSON.stringify` of the state in its key order.
pub fn sign_woo_user_id(state: &WooState, secret: &str) -> String {
    let now = (crate::js::now_ms() / 1000.0).floor() as i64;
    let json = format!(
        "{{\"clerkOrgId\":{},\"connectionId\":{},\"connectedBy\":{},\"exp\":{}}}",
        Value::String(state.clerk_org_id.clone()),
        Value::String(state.connection_id.clone()),
        Value::String(state.connected_by.clone()),
        now + WOOCOMMERCE_AUTH_STATE_TTL_SECONDS
    );
    let body = b64url(json.as_bytes());
    let signature = b64url(&mac(secret, &body));
    format!("wooa.{body}.{signature}")
}

/// `verifyWooCommerceAuthUserId(userId, secret)`.
pub fn verify_woo_user_id(user_id: &str, secret: &str) -> Option<WooState> {
    if secret.is_empty() {
        return None;
    }
    let parts: Vec<&str> = user_id.split('.').collect();
    if parts.len() != 3 || parts[0] != "wooa" || parts[1].is_empty() || parts[2].is_empty() {
        return None;
    }
    let decode = |s: &str| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(s.trim_end_matches('='))
            .ok()
    };
    let given = decode(parts[2])?;
    let expected = mac(secret, parts[1]);
    if given.len() != expected.len()
        || given
            .iter()
            .zip(&expected)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            != 0
    {
        return None;
    }
    let parsed: Value = serde_json::from_slice(&decode(parts[1])?).ok()?;
    let field = |k: &str| {
        parsed
            .get(k)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let exp = parsed.get("exp").and_then(Value::as_f64)?;
    let now = (crate::js::now_ms() / 1000.0).floor();
    if exp < now {
        return None;
    }
    Some(WooState {
        clerk_org_id: field("clerkOrgId")?,
        connection_id: field("connectionId")?,
        connected_by: field("connectedBy")?,
    })
}

/// `parseWooCommerceAuthCallback(body)`: the user id and the keys.
pub fn parse_woo_callback(body: &str) -> Option<(String, String, String)> {
    let raw: Value = serde_json::from_str(body).ok()?;
    let record = raw.as_object()?;
    let user_id = match record.get("user_id") {
        Some(Value::String(s)) => weldsuite_kit::validation::js_trim(s).to_owned(),
        None | Some(Value::Null) => String::new(),
        Some(other) => {
            weldsuite_kit::validation::js_trim(&crate::clients::as_text(other)).to_owned()
        }
    };
    let text = |k: &str| {
        record
            .get(k)
            .and_then(Value::as_str)
            .map(|s| weldsuite_kit::validation::js_trim(s).to_owned())
            .unwrap_or_default()
    };
    let (key, secret) = (text("consumer_key"), text("consumer_secret"));
    if user_id.is_empty() || key.is_empty() || secret.is_empty() {
        return None;
    }
    Some((user_id, key, secret))
}

// ── shared ──────────────────────────────────────────────────────────────────

fn strings(list: &[String]) -> Vec<String> {
    list.to_vec()
}

fn credential_map(pairs: &[(&str, Option<&str>)]) -> Map<String, Value> {
    pairs
        .iter()
        .filter_map(|(k, v)| {
            v.filter(|v| !v.is_empty())
                .map(|v| ((*k).to_owned(), json!(v)))
        })
        .collect()
}

/// `publishEntityEventRaw({ entityType: 'connector_connection', action: 'connected' })`.
async fn publish_connected(env: &SyncEnv, workspace_id: &str, user_id: &str, row: &Value) {
    let Ok(event) = EventType::catalog("connector_connection", "connected") else {
        return;
    };
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    env.events
        .publish_and_wait(
            &EventContext::new(workspace_id, user_id, EventSource::System),
            EntityEvent::new(event, id, sanitize_connection(row, None)),
        )
        .await;
}

async fn initial_sync(
    db: &PgPool,
    env: &SyncEnv,
    connection_id: &str,
    owner: &str,
    workspace: &str,
) {
    let fresh = match get_connection(db, connection_id).await {
        Ok(Some(fresh)) => fresh,
        Ok(None) => return,
        Err(error) => {
            tracing::error!(%error, "[connectors/auth] initial sync failed");
            return;
        }
    };
    if let Err(error) = sync_connection(&SyncArgs {
        db,
        env,
        connection: &fresh,
        owner_id: owner,
        workspace_id: workspace,
        trigger: Trigger::Initial,
        full: false,
        syncs: None,
    })
    .await
    {
        tracing::error!(%error, "[connectors/auth] initial sync failed");
    }
}

async fn cache_put(
    cache: Option<&Arc<dyn DynCache>>,
    key: &str,
    value: &str,
    ttl: u64,
) -> Result<(), String> {
    let Some(cache) = cache else {
        return Err("no workspace cache".to_owned());
    };
    cache
        .put_boxed(key, value, Some(Duration::from_secs(ttl)))
        .await
        .map_err(|error| error.to_string())
}

/// Reads and deletes an OAuth state.
async fn take_state(cache: Option<&Arc<dyn DynCache>>, key: &str) -> Option<String> {
    let cache = cache?;
    let raw = cache.get_boxed(key).await.ok().flatten()?;
    let _ = cache.delete_boxed(key).await;
    Some(raw)
}

// ── WooCommerce ─────────────────────────────────────────────────────────────

/// `startWooCommerceAppAuth(...)`: the shop's grant URL and the pending
/// connection.
#[allow(clippy::too_many_arguments)] // `startWooCommerceAppAuth`'s arguments
pub async fn start_woo_app_auth(
    db: &PgPool,
    env: &AuthEnv,
    clerk_org_id: &str,
    user_id: &str,
    store_url: &str,
    enabled_syncs: &[String],
    display_name: Option<&str>,
    return_url: &str,
    request_origin: Option<&str>,
) -> Result<Value, AuthError> {
    if !is_allowed_return_url(return_url) {
        return Err(refused("Return URL is not a WeldSuite page", 400).into());
    }
    let Some(callback) = woo_callback_url(
        request_origin,
        env.app_api_public_url.as_deref(),
        env.environment.as_deref(),
    ) else {
        return Err(refused(
            "WooCommerce needs a public HTTPS callback to send API keys. Set APP_API_PUBLIC_URL to this worker’s HTTPS origin.",
            400,
        )
        .into());
    };
    let Some(secret) = AuthEnv::trimmed(env.internal_api_secret.as_ref()) else {
        return Err(refused(
            "WooCommerce connect is not configured (missing internal signing secret)",
            400,
        )
        .into());
    };
    let store = crate::clients::normalize_store_url(store_url)
        .map_err(|error| refused(error.message, 400))?;
    let host = url::Url::parse(&store)
        .ok()
        .and_then(|u| {
            u.host_str().map(|h| {
                u.port()
                    .map_or_else(|| h.to_owned(), |p| format!("{h}:{p}"))
            })
        })
        .unwrap_or_else(|| store.clone());
    let label = display_name
        .map(weldsuite_kit::validation::js_trim)
        .filter(|l| !l.is_empty())
        .map_or_else(|| format!("WooCommerce ({host})"), str::to_owned);
    let row = ensure_pending_connection(db, "woocommerce", &label, user_id, enabled_syncs, &store)
        .await?;
    let connection_id = row["id"].as_str().unwrap_or_default().to_owned();
    let signed = sign_woo_user_id(
        &WooState {
            clerk_org_id: clerk_org_id.to_owned(),
            connection_id: connection_id.clone(),
            connected_by: user_id.to_owned(),
        },
        &secret,
    );
    Ok(json!({
        "connectionId": connection_id,
        "authorizeUrl": woo_auth_url(&store, &signed, return_url, &callback),
    }))
}

/// Where a WooCommerce callback's tenant is: its database and
/// `workspaces.id`, for the state's Clerk org id.
pub struct TenantRef {
    pub db: PgPool,
    pub workspace_id: String,
}

/// `completeWooCommerceAppAuth({ rawBody })`: `{ ok, status, message }`;
/// the webhooks, the event and the first sync run in the background.
pub async fn complete_woo_app_auth<F, Fut>(
    env: &AuthEnv,
    raw_body: &str,
    tenant_for: F,
) -> Result<(bool, u16, &'static str), AuthError>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<TenantRef, String>>,
{
    let Some((user_id, key, secret_key)) = parse_woo_callback(raw_body) else {
        return Ok((false, 400, "invalid WooCommerce auth payload"));
    };
    let state = AuthEnv::trimmed(env.internal_api_secret.as_ref())
        .and_then(|secret| verify_woo_user_id(&user_id, &secret));
    let Some(state) = state else {
        return Ok((false, 400, "unknown or expired WooCommerce auth"));
    };
    let tenant = tenant_for(state.clerk_org_id.clone())
        .await
        .map_err(AuthError::Other)?;
    let db = tenant.db;
    let Some(row) = get_connection(&db, &state.connection_id).await? else {
        return Ok((false, 400, "connection not found"));
    };
    let store = row["external_account_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if store.is_empty() {
        return Ok((false, 400, "connection is missing a store URL"));
    }
    let credentials = credential_map(&[
        ("storeUrl", Some(&store)),
        ("consumerKey", Some(&key)),
        ("consumerSecret", Some(&secret_key)),
    ]);
    let keyring = &env.sync.keyring;
    let encrypted = encrypt_credentials(&credentials, keyring).map_err(AuthError::Other)?;
    let raw_secret = generate_webhook_secret();
    let sealed = encrypt_webhook_secret(&raw_secret, keyring).map_err(AuthError::Other)?;
    let enabled: Option<Vec<String>> = row["enabled_syncs"].as_array().map(|list| {
        list.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    });
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    update_connection_settings(
        &db,
        &id,
        &SettingsUpdate {
            credentials: Some(encrypted),
            external_account_id: Some(Some(store.clone())),
            webhook_secret: Some(Some(sealed)),
            enabled_syncs: enabled,
            ..SettingsUpdate::default()
        },
    )
    .await?;
    seed_default_field_mappings(&db, &id, "woocommerce").await?;
    let Some(fresh) = get_connection(&db, &id).await? else {
        return Ok((false, 500, "connection vanished after save"));
    };
    let env = env.clone();
    let workspace_id = tenant.workspace_id;
    let tracker = env.sync.events.tracker().clone();
    tracker.spawn(async move {
        if let Err(error) = register_connection_webhooks(
            &db,
            env.sync.http.as_ref(),
            &env.sync.keyring,
            &env.webhook_base_url,
            &fresh,
            &credentials,
            &raw_secret,
        )
        .await
        {
            tracing::error!(%error, "[connectors/auth] webhook registration failed");
        }
        if let Some(cache) = env.cache.as_ref()
            && let Err(error) = put_webhook_mapping(cache, &id, &workspace_id, "woocommerce").await
        {
            tracing::error!(%error, "[connectors/auth] webhook KV mapping failed");
        }
        publish_connected(&env.sync, &state.clerk_org_id, &state.connected_by, &fresh).await;
        initial_sync(
            &db,
            &env.sync,
            &id,
            &state.connected_by,
            &state.clerk_org_id,
        )
        .await;
    });
    Ok((true, 200, "connected"))
}

// ── Moneybird ───────────────────────────────────────────────────────────────

fn moneybird_app(env: &AuthEnv) -> Result<(String, String), Refused> {
    match (
        AuthEnv::trimmed(env.moneybird_client_id.as_ref()),
        AuthEnv::trimmed(env.moneybird_client_secret.as_ref()),
    ) {
        (Some(id), Some(secret)) => Ok((id, secret)),
        _ => Err(refused(
            "Moneybird connect is not configured (missing MONEYBIRD_CLIENT_ID / MONEYBIRD_CLIENT_SECRET)",
            400,
        )),
    }
}

/// The OAuth state stored for Moneybird and Stripe, in the TypeScript
/// payload's key order.
fn oauth_state_json(pairs: &[(&str, Value)]) -> String {
    let parts: Vec<String> = pairs
        .iter()
        .map(|(k, v)| format!("{}:{}", Value::String((*k).to_owned()), v))
        .collect();
    format!("{{{}}}", parts.join(","))
}

/// `startMoneybirdOAuth(...)`.
pub async fn start_moneybird_oauth(
    env: &AuthEnv,
    clerk_org_id: &str,
    user_id: &str,
    enabled_syncs: &[String],
    display_name: Option<&str>,
    return_url: &str,
    entity_id: Option<&str>,
) -> Result<Value, AuthError> {
    if !is_allowed_return_url(return_url) {
        return Err(refused("Return URL is not a WeldSuite page", 400).into());
    }
    let (client_id, _) = moneybird_app(env)?;
    let state = uuid::Uuid::new_v4().to_string();
    let mut pairs = vec![
        ("clerkOrgId", json!(clerk_org_id)),
        ("userId", json!(user_id)),
        ("enabledSyncs", json!(strings(enabled_syncs))),
    ];
    if let Some(name) = display_name {
        pairs.push(("displayName", json!(name)));
    }
    pairs.push(("returnUrl", json!(return_url)));
    pairs.push(("entityId", json!(entity_id)));
    cache_put(
        env.cache.as_ref(),
        &format!("{MONEYBIRD_STATE_PREFIX}{state}"),
        &oauth_state_json(&pairs),
        moneybird::AUTH_STATE_TTL_SECONDS,
    )
    .await
    .map_err(AuthError::Other)?;
    Ok(json!({
        "authorizeUrl": moneybird::authorize_url(
            &client_id,
            &moneybird::redirect_uri(&env.public_app_url()),
            &state,
        ),
    }))
}

/// `finishMoneybirdConnection(...)`: mappings, webhooks and the KV mapping
/// now; the event and the first sync in the background.
async fn finish_moneybird(
    db: &PgPool,
    env: &AuthEnv,
    row: &Value,
    clerk_org_id: &str,
    workspace_id: &str,
    user_id: &str,
    credentials: &Map<String, Value>,
) -> Result<(), AuthError> {
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    seed_default_field_mappings(db, &id, "moneybird").await?;
    let raw_secret = generate_webhook_secret();
    if let Err(error) = register_connection_webhooks(
        db,
        env.sync.http.as_ref(),
        &env.sync.keyring,
        &env.webhook_base_url,
        row,
        credentials,
        &raw_secret,
    )
    .await
    {
        tracing::error!(%error, "[connectors/auth] Moneybird webhook registration failed");
    }
    if let Some(cache) = env.cache.as_ref()
        && let Err(error) = put_webhook_mapping(cache, &id, workspace_id, "moneybird").await
    {
        tracing::warn!(%error, "[connectors/auth] Moneybird D1/KV index failed");
    }
    let db = db.clone();
    let sync = env.sync.clone();
    let row = row.clone();
    let (clerk, user) = (clerk_org_id.to_owned(), user_id.to_owned());
    env.sync.events.tracker().spawn(async move {
        publish_connected(&sync, &clerk, &user, &row).await;
        initial_sync(&db, &sync, &id, &user, &clerk).await;
    });
    Ok(())
}

fn admins_json(admins: &[Administration]) -> Value {
    Value::Array(admins.iter().map(Administration::to_json).collect())
}

/// `completeMoneybirdOAuth({ code, state })`.
pub async fn complete_moneybird_oauth<F, Fut>(
    env: &AuthEnv,
    code: &str,
    state: &str,
    tenant_for: F,
) -> Result<Value, AuthError>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<TenantRef, String>>,
{
    let Some(raw) = take_state(
        env.cache.as_ref(),
        &format!("{MONEYBIRD_STATE_PREFIX}{state}"),
    )
    .await
    else {
        return Err(refused("Unknown or expired Moneybird authorisation", 400).into());
    };
    let Ok(saved) = serde_json::from_str::<Value>(&raw) else {
        return Err(refused("Corrupt Moneybird authorisation state", 400).into());
    };
    let (client_id, client_secret) = moneybird_app(env)?;
    let http = env.sync.http.as_ref();
    let tokens = moneybird::exchange_code(
        http,
        &client_id,
        &client_secret,
        code,
        &moneybird::redirect_uri(&env.public_app_url()),
    )
    .await
    .map_err(|error| refused(error.message, 400))?;
    let admins = Moneybird::new(&tokens.access_token, None)
        .list_administrations(http)
        .await
        .map_err(|error| refused(error.message, 400))?;
    if admins.is_empty() {
        return Err(refused("This Moneybird account has no administrations", 400).into());
    }
    let clerk = saved["clerkOrgId"].as_str().unwrap_or_default().to_owned();
    let user = saved["userId"].as_str().unwrap_or_default().to_owned();
    let enabled: Vec<String> = saved["enabledSyncs"]
        .as_array()
        .map(|l| {
            l.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let entity = saved["entityId"].as_str().filter(|e| !e.is_empty());
    let return_url = saved["returnUrl"].clone();
    let tenant = tenant_for(clerk.clone()).await.map_err(AuthError::Other)?;
    let single = (admins.len() == 1).then(|| admins[0].clone());
    let credentials = credential_map(&[
        ("accessToken", Some(&tokens.access_token)),
        ("refreshToken", tokens.refresh_token.as_deref()),
        ("administrationId", single.as_ref().map(|a| a.id.as_str())),
        ("entityId", entity),
    ]);
    let encrypted =
        encrypt_credentials(&credentials, &env.sync.keyring).map_err(AuthError::Other)?;
    let label = saved["displayName"]
        .as_str()
        .map(weldsuite_kit::validation::js_trim)
        .filter(|l| !l.is_empty())
        .map_or_else(
            || {
                single.as_ref().map_or_else(
                    || "Moneybird".to_owned(),
                    |a| format!("Moneybird ({})", a.name),
                )
            },
            str::to_owned,
        );
    let entity_value = entity.map(str::to_owned);
    if let Some(single) = &single {
        let row = upsert_connection(
            &tenant.db,
            &NewConnection {
                provider: "moneybird",
                display_name: &label,
                user_id: &user,
                credentials: &encrypted,
                enabled_syncs: &enabled,
                external_account_id: Some(&single.id),
                webhook_secret: None,
            },
        )
        .await?;
        finish_moneybird(
            &tenant.db,
            env,
            &row,
            &clerk,
            &tenant.workspace_id,
            &user,
            &credentials,
        )
        .await?;
        let id = row["id"].as_str().unwrap_or_default();
        let fresh = get_connection(&tenant.db, id).await?.unwrap_or(row);
        return Ok(json!({
            "connection": sanitize_connection(&fresh, entity_value.as_deref()),
            "administrations": admins_json(&admins),
            "needsPicker": false,
            "returnUrl": return_url,
        }));
    }
    let pending = ensure_pending_connection(
        &tenant.db,
        "moneybird",
        &label,
        &user,
        &enabled,
        &format!("pending:oauth:{user}"),
    )
    .await?;
    let pending_id = pending["id"].as_str().unwrap_or_default().to_owned();
    update_connection_settings(
        &tenant.db,
        &pending_id,
        &SettingsUpdate {
            credentials: Some(encrypted),
            display_name: Some(label.clone()),
            enabled_syncs: Some(enabled.clone()),
            external_account_id: Some(Some(format!("pending:{pending_id}"))),
            ..SettingsUpdate::default()
        },
    )
    .await?;
    sqlx::query("update connector_connections set status = 'pending', updated_at = $1::timestamp where id = $2")
        .bind(crate::js::now_iso())
        .bind(&pending_id)
        .execute(&tenant.db)
        .await?;
    let fresh = get_connection(&tenant.db, &pending_id)
        .await?
        .unwrap_or(pending);
    Ok(json!({
        "connection": sanitize_connection(&fresh, entity_value.as_deref()),
        "administrations": admins_json(&admins),
        "needsPicker": true,
        "returnUrl": return_url,
    }))
}

/// `selectMoneybirdAdministration({ connectionId, administrationId })`.
pub async fn select_moneybird_administration(
    db: &PgPool,
    env: &AuthEnv,
    connection_id: &str,
    administration_id: &str,
    clerk_org_id: &str,
    workspace_id: &str,
    user_id: &str,
) -> Result<Value, AuthError> {
    let row = get_connection(db, connection_id).await?;
    let Some(row) = row.filter(|r| r["provider"] == "moneybird") else {
        return Err(refused("Connection not found", 404).into());
    };
    let existing = crate::clients::decrypt_credentials(row.get("credentials"), &env.sync.keyring);
    let Some(access) = existing
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
    else {
        return Err(refused("Moneybird authorisation is incomplete — connect again", 400).into());
    };
    let admins = Moneybird::new(access, None)
        .list_administrations(env.sync.http.as_ref())
        .await
        .map_err(|error| refused(error.message, 400))?;
    let Some(chosen) = admins.iter().find(|a| a.id == administration_id) else {
        return Err(refused(
            "That administration is not available on this Moneybird account",
            400,
        )
        .into());
    };
    let mut credentials = existing.clone();
    credentials.insert("administrationId".to_owned(), json!(chosen.id));
    let encrypted =
        encrypt_credentials(&credentials, &env.sync.keyring).map_err(AuthError::Other)?;
    let display = row["display_name"]
        .as_str()
        .filter(|n| n.contains('('))
        .map_or_else(|| format!("Moneybird ({})", chosen.name), str::to_owned);
    update_connection_settings(
        db,
        connection_id,
        &SettingsUpdate {
            credentials: Some(encrypted),
            external_account_id: Some(Some(chosen.id.clone())),
            display_name: Some(display),
            ..SettingsUpdate::default()
        },
    )
    .await?;
    let fresh = get_connection(db, connection_id)
        .await?
        .unwrap_or_else(|| row.clone());
    finish_moneybird(
        db,
        env,
        &fresh,
        clerk_org_id,
        workspace_id,
        user_id,
        &credentials,
    )
    .await?;
    let latest = get_connection(db, connection_id).await?.unwrap_or(fresh);
    let entity = credentials
        .get("entityId")
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty());
    Ok(json!({ "connection": sanitize_connection(&latest, entity) }))
}

// ── Stripe ──────────────────────────────────────────────────────────────────

fn stripe_platform(env: &AuthEnv) -> Result<(String, String), Refused> {
    match (
        AuthEnv::trimmed(env.stripe_connect_client_id.as_ref()),
        AuthEnv::trimmed(env.sync.stripe_secret_key.as_ref()),
    ) {
        (Some(id), Some(key)) => Ok((id, key)),
        _ => Err(refused(
            "Stripe connect is not configured (missing STRIPE_CONNECT_CLIENT_ID / STRIPE_SECRET_KEY)",
            400,
        )),
    }
}

/// `startStripeOAuth(...)`.
#[allow(clippy::too_many_arguments)] // `startStripeOAuth`'s arguments
pub async fn start_stripe_oauth(
    env: &AuthEnv,
    clerk_org_id: &str,
    user_id: &str,
    enabled_syncs: &[String],
    display_name: Option<&str>,
    return_url: &str,
    entity_id: Option<&str>,
    import_start_date: Option<&str>,
) -> Result<Value, AuthError> {
    if !is_allowed_return_url(return_url) {
        return Err(refused("Return URL is not a WeldSuite page", 400).into());
    }
    let (client_id, _) = stripe_platform(env)?;
    let state = format!("{}{}", stripe::OAUTH_STATE_PREFIX, uuid::Uuid::new_v4());
    let mut pairs = vec![
        ("clerkOrgId", json!(clerk_org_id)),
        ("userId", json!(user_id)),
        ("enabledSyncs", json!(strings(enabled_syncs))),
    ];
    if let Some(name) = display_name {
        pairs.push(("displayName", json!(name)));
    }
    pairs.push(("returnUrl", json!(return_url)));
    pairs.push(("entityId", json!(entity_id)));
    pairs.push(("importStartDate", json!(import_start_date)));
    cache_put(
        env.cache.as_ref(),
        &format!("{STRIPE_STATE_PREFIX}{state}"),
        &oauth_state_json(&pairs),
        stripe::AUTH_STATE_TTL_SECONDS,
    )
    .await
    .map_err(AuthError::Other)?;
    Ok(json!({
        "authorizeUrl": stripe::authorize_url(&client_id, &stripe::redirect_uri(&env.public_app_url()), &state),
    }))
}

/// `finishStripeConnection(...)`: the KV mapping now, the event and the
/// first sync in the background.
pub async fn finish_stripe(
    db: &PgPool,
    env: &AuthEnv,
    row: &Value,
    clerk_org_id: &str,
    workspace_id: &str,
    user_id: &str,
    oauth_account_id: Option<&str>,
) {
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    if let Some(cache) = env.cache.as_ref() {
        let written = match oauth_account_id {
            Some(account) => put_stripe_account_mapping(cache, account, workspace_id, &id).await,
            None => put_webhook_mapping(cache, &id, workspace_id, "stripe").await,
        };
        if let Err(error) = written {
            tracing::warn!(%error, "[connectors/stripe-auth] KV/D1 index failed");
        }
    }
    let db = db.clone();
    let sync = env.sync.clone();
    let row = row.clone();
    let (clerk, user) = (clerk_org_id.to_owned(), user_id.to_owned());
    env.sync.events.tracker().spawn(async move {
        publish_connected(&sync, &clerk, &user, &row).await;
        initial_sync(&db, &sync, &id, &user, &clerk).await;
    });
}

/// `completeStripeOAuth({ code, state })`.
pub async fn complete_stripe_oauth<F, Fut>(
    env: &AuthEnv,
    code: &str,
    state: &str,
    tenant_for: F,
) -> Result<Value, AuthError>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<TenantRef, String>>,
{
    let raw = take_state(env.cache.as_ref(), &format!("{STRIPE_STATE_PREFIX}{state}")).await;
    let Some(saved) = raw.and_then(|r| serde_json::from_str::<Value>(&r).ok()) else {
        return Err(refused("Unknown or expired Stripe authorisation", 400).into());
    };
    let (_, secret_key) = stripe_platform(env)?;
    let http = env.sync.http.as_ref();
    let tokens = stripe::exchange_code(http, &secret_key, code)
        .await
        .map_err(|error| refused(error.message, 400))?;
    let account = tokens.stripe_user_id;
    let mut creds = Map::new();
    creds.insert("stripeUserId".to_owned(), json!(account));
    creds.insert("platformSecretKey".to_owned(), json!(secret_key));
    let tested = Stripe::from_credentials(&creds, None)
        .test(http)
        .await
        .map_err(|message| refused(message, 400))?;
    let clerk = saved["clerkOrgId"].as_str().unwrap_or_default().to_owned();
    let user = saved["userId"].as_str().unwrap_or_default().to_owned();
    let enabled: Vec<String> = saved["enabledSyncs"]
        .as_array()
        .map(|l| {
            l.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let entity = saved["entityId"]
        .as_str()
        .filter(|e| !e.is_empty())
        .map(str::to_owned);
    let tenant = tenant_for(clerk.clone()).await.map_err(AuthError::Other)?;
    let credentials = credential_map(&[
        ("stripeUserId", Some(&account)),
        ("entityId", entity.as_deref()),
    ]);
    let label = saved["displayName"]
        .as_str()
        .map(weldsuite_kit::validation::js_trim)
        .filter(|l| !l.is_empty())
        .map_or_else(
            || {
                format!(
                    "Stripe ({})",
                    tested
                        .account_name
                        .clone()
                        .unwrap_or_else(|| account.clone())
                )
            },
            str::to_owned,
        );
    let encrypted =
        encrypt_credentials(&credentials, &env.sync.keyring).map_err(AuthError::Other)?;
    let row = upsert_connection(
        &tenant.db,
        &NewConnection {
            provider: "stripe",
            display_name: &label,
            user_id: &user,
            credentials: &encrypted,
            enabled_syncs: &enabled,
            external_account_id: Some(&account),
            webhook_secret: None,
        },
    )
    .await?;
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    if let Some(start) = saved["importStartDate"].as_str().filter(|s| !s.is_empty()) {
        let mut settings = row["settings"].as_object().cloned().unwrap_or_default();
        settings.insert("importStartDate".to_owned(), json!(start));
        update_connection_settings(
            &tenant.db,
            &id,
            &SettingsUpdate {
                settings: Some(Value::Object(settings)),
                ..SettingsUpdate::default()
            },
        )
        .await?;
    }
    let fresh = get_connection(&tenant.db, &id).await?.unwrap_or(row);
    finish_stripe(
        &tenant.db,
        env,
        &fresh,
        &clerk,
        &tenant.workspace_id,
        &user,
        Some(&account),
    )
    .await;
    Ok(json!({
        "connection": sanitize_connection(&fresh, entity.as_deref()),
        "administrations": [],
        "needsPicker": false,
        "returnUrl": saved["returnUrl"],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn return_urls_and_states() {
        assert!(is_allowed_return_url(
            "https://app.weldsuite.org/weldconnect/connectors"
        ));
        assert!(is_allowed_return_url(
            "https://app-test.weldsuite.org/w/acme/weldconnect/connectors/x"
        ));
        assert!(is_allowed_return_url(
            "http://localhost:3000/settings/integrations/moneybird"
        ));
        assert!(!is_allowed_return_url(
            "https://evil.example/weldconnect/connectors"
        ));
        assert!(!is_allowed_return_url(
            "https://app.weldsuite.org/settings/billing"
        ));
        let state = WooState {
            clerk_org_id: "org_1".to_owned(),
            connection_id: "conn_1".to_owned(),
            connected_by: "user_1".to_owned(),
        };
        let signed = sign_woo_user_id(&state, "s3cret");
        assert_eq!(verify_woo_user_id(&signed, "s3cret"), Some(state));
        assert_eq!(verify_woo_user_id(&signed, "other"), None);
        assert_eq!(
            woo_callback_url(None, None, Some("test")).as_deref(),
            Some("https://app-api-test.weldsuite.org/webhooks/woocommerce/auth")
        );
        assert_eq!(
            woo_callback_url(Some("http://localhost:8787"), None, None),
            None
        );
    }
}
