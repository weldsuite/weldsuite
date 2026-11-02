//! The shared work of `services/user-apps.ts`: app rows as Drizzle returns
//! them, publishing a version, minting `wsat_` tokens, resolving a code to
//! its live bundle, lifecycle webhooks, and adopting first-party installs
//! onto an official hosted app.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::js_row;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::id::generate_id;
use weldsuite_ports::DynCache;

use crate::access::now;
use crate::http_transport::{HttpTransport, OutboundRequest};
use crate::scopes::{
    diff_scopes, is_safe_lifecycle_webhook_url, random_hex, sha256_hex,
};

/// A row from `to_jsonb`, as Drizzle returns it.
pub(crate) fn row(value: Value) -> Value {
    js_row(value)
}

/// A string column of a row (`''` when missing or not a string).
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// A `jsonb` string-list column (`?? []`).
pub(crate) fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// `WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS` (comma separated) holds `workspace_id`.
pub(crate) fn is_official_publisher_workspace(setting: Option<&str>, workspace_id: &str) -> bool {
    setting
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .any(|part| part == workspace_id)
}

/// Store listings drop lifecycle webhooks and Stripe ids.
pub(crate) fn store_listing(mut app: Value) -> Value {
    if let Value::Object(fields) = &mut app {
        for key in ["webhookUrl", "stripeProductId", "stripePriceId"] {
            fields.remove(key);
        }
    }
    app
}

// ── tokens ───────────────────────────────────────────────────────────────────

/// A session token lives an hour.
const SESSION_TOKEN_TTL: time::Duration = time::Duration::hours(1);

/// A minted `wsat_` token, shown once, and its expiry (`toISOString()`).
pub(crate) struct MintedToken {
    pub(crate) token: String,
    pub(crate) expires_at: Option<String>,
    /// The same expiry in epoch ms.
    pub(crate) expires_at_ms: Option<i64>,
}

/// `mintAppToken`: store the hash, hand back the token.
pub(crate) async fn mint_app_token(
    master: &PgPool,
    install_id: &str,
    app_id: &str,
    workspace_id: &str,
    token_type: &str,
    scopes: &[String],
) -> Result<MintedToken, sqlx::Error> {
    let token = format!("wsat_{}", random_hex(20));
    let hash = sha256_hex(&token);
    let prefix: String = token.chars().take(12).collect();
    let expiry = (token_type == "session").then(|| OffsetDateTime::now_utc() + SESSION_TOKEN_TTL);
    let expires_at = expiry.map(iso_timestamp);
    let expires_at_ms =
        expiry.and_then(|at| i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok());
    sqlx::query(
        "insert into user_app_tokens
           (id, install_id, app_id, workspace_id, token_hash, token_prefix, token_type, scopes, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)",
    )
    .bind(generate_id("uat"))
    .bind(install_id)
    .bind(app_id)
    .bind(workspace_id)
    .bind(&hash)
    .bind(&prefix)
    .bind(token_type)
    .bind(json!(scopes))
    .bind(expires_at.as_deref())
    .execute(master)
    .await?;
    Ok(MintedToken {
        token,
        expires_at,
        expires_at_ms,
    })
}

// ── publishing ───────────────────────────────────────────────────────────────

/// An install whose new pending scopes `publish_app_version` set.
pub(crate) struct InstallNeedingConsent {
    pub(crate) install_id: String,
    pub(crate) workspace_id: String,
}

/// Why a version cannot be published.
#[derive(Debug)]
pub(crate) enum PublishError {
    NoManifest(String),
    Database(sqlx::Error),
}

impl std::fmt::Display for PublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoManifest(id) => write!(f, "Version {id} has no manifest"),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl From<sqlx::Error> for PublishError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// `publishAppVersion`: supersede the live version, publish this one, take
/// the app's columns from its manifest, and queue new scopes on every
/// active install.
#[allow(clippy::too_many_lines)] // the service's steps, in the TypeScript order
pub(crate) async fn publish_app_version(
    master: &PgPool,
    app_id: &str,
    version_id: &str,
    manifest: Option<&Value>,
) -> Result<Vec<InstallNeedingConsent>, PublishError> {
    let Some(manifest @ Value::Object(_)) = manifest else {
        return Err(PublishError::NoManifest(version_id.to_owned()));
    };
    let now = now();
    sqlx::query(
        "update user_app_versions set status = 'superseded'
         where app_id = $1 and status = 'published' and id <> $2",
    )
    .bind(app_id)
    .bind(version_id)
    .execute(master)
    .await?;
    sqlx::query(
        "update user_app_versions set status = 'published', published_at = $2::timestamptz
         where id = $1",
    )
    .bind(version_id)
    .bind(&now)
    .execute(master)
    .await?;

    let field = |key: &str| manifest.get(key);
    let truthy_text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let pricing = field("pricing");
    let pricing_type = pricing
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("free");
    let price_monthly = match pricing.and_then(|p| p.get("monthlyPrice")) {
        Some(Value::Number(price)) if pricing_type == "subscription" => Some(price.to_string()),
        _ => None,
    };
    let currency = truthy_text(pricing.and_then(|p| p.get("currency"))).map(|c| c.to_uppercase());
    let requested = string_list(field("scopes"));
    sqlx::query(
        "update user_apps set
           name = $2,
           description = $3,
           category = coalesce($4, category),
           manifest = $5::jsonb,
           requested_scopes = $6::jsonb,
           pricing_type = $7,
           price_monthly = $8::numeric,
           currency = coalesce($9, currency),
           website_url = case when $10 then $11 else website_url end,
           privacy_url = case when $12 then $13 else privacy_url end,
           screenshots = case when $14 then $15::jsonb else screenshots end,
           webhook_url = case when $16 then $17 else webhook_url end,
           current_version_id = $18,
           updated_at = $19::timestamptz
         where id = $1",
    )
    .bind(app_id)
    .bind(field("name").and_then(Value::as_str))
    .bind(field("description").and_then(Value::as_str))
    .bind(truthy_text(field("category")))
    .bind(manifest)
    .bind(json!(requested))
    .bind(pricing_type)
    .bind(price_monthly)
    .bind(currency)
    .bind(field("websiteUrl").is_some())
    .bind(field("websiteUrl").and_then(Value::as_str))
    .bind(field("privacyUrl").is_some())
    .bind(field("privacyUrl").and_then(Value::as_str))
    .bind(field("screenshots").is_some())
    .bind(field("screenshots").cloned().unwrap_or(Value::Null))
    .bind(field("webhookUrl").is_some())
    .bind(field("webhookUrl").and_then(Value::as_str))
    .bind(version_id)
    .bind(&now)
    .execute(master)
    .await?;

    let installs: Vec<(String, String, Option<Value>)> = sqlx::query_as(
        "select id, workspace_id, granted_scopes from user_app_installs
         where app_id = $1 and status = 'active'",
    )
    .bind(app_id)
    .fetch_all(master)
    .await?;
    let mut needing = Vec::new();
    for (install_id, workspace_id, granted) in installs {
        let new_scopes = diff_scopes(&requested, &string_list(granted.as_ref()));
        if new_scopes.is_empty() {
            continue;
        }
        sqlx::query(
            "update user_app_installs set pending_scopes = $2::jsonb, updated_at = $3::timestamptz
             where id = $1",
        )
        .bind(&install_id)
        .bind(json!(new_scopes))
        .bind(&now)
        .execute(master)
        .await?;
        needing.push(InstallNeedingConsent {
            install_id,
            workspace_id,
        });
    }
    Ok(needing)
}

// ── the bundle host's code → bundle resolution ───────────────────────────────

const ASSET_CACHE_TTL: Duration = Duration::from_secs(60);

/// `uapp-assets:v2:<code>`.
pub(crate) fn asset_cache_key(code: &str) -> String {
    format!("uapp-assets:v2:{code}")
}

/// Drop the cached bundle resolution (publish, deactivate, review, delete).
pub(crate) async fn invalidate_asset_cache(cache: &dyn DynCache, code: &str) {
    if let Err(error) = cache.delete_boxed(&asset_cache_key(code)).await {
        tracing::error!(%error, "core-apps: asset cache invalidation failed");
    }
}

/// A public and approved app's bundle is open to anyone.
pub(crate) use weldsuite_apps_domain::adopt::is_publicly_servable;

/// Why the bundle host could not resolve a code.
#[derive(Debug)]
pub(crate) enum ResolveError {
    Cache(weldsuite_ports::PortError),
    Database(sqlx::Error),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cache(error) => error.fmt(f),
            Self::Database(error) => error.fmt(f),
        }
    }
}

/// `resolveBundleForCode`: the live bundle of `code` as `{ appId,
/// bundleKey, entrypoint, requiresToken }`, cached for 60 seconds. A cached
/// value is taken as it is (an entry without `requiresToken` is gated).
pub(crate) async fn resolve_bundle_for_code(
    master: &PgPool,
    cache: &dyn DynCache,
    code: &str,
) -> Result<Option<Value>, ResolveError> {
    let key = asset_cache_key(code);
    if let Some(text) = cache.get_boxed(&key).await.map_err(ResolveError::Cache)? {
        let cached: Value = serde_json::from_str(&text)
            .map_err(|error| ResolveError::Cache(weldsuite_ports::PortError::from(error)))?;
        // `if (cached)`: JSON's falsy values read as a miss.
        let falsy = match &cached {
            Value::Null => true,
            Value::Bool(flag) => !flag,
            Value::Number(number) => number.as_f64() == Some(0.0),
            Value::String(text) => text.is_empty(),
            _ => false,
        };
        if !falsy {
            return Ok(Some(cached));
        }
    }
    let app: Option<(String, Option<String>, bool, bool, String, String)> = sqlx::query_as(
        "select id, current_version_id, is_active, deleted_at is not null, visibility, review_status
         from user_apps where code = $1 limit 1",
    )
    .bind(code)
    .fetch_optional(master)
    .await
    .map_err(ResolveError::Database)?;
    let Some((app_id, Some(version_id), true, false, visibility, review_status)) = app else {
        return Ok(None);
    };
    let version: Option<(String, String)> = sqlx::query_as(
        "select bundle_key, entrypoint from user_app_versions where id = $1 limit 1",
    )
    .bind(&version_id)
    .fetch_optional(master)
    .await
    .map_err(ResolveError::Database)?;
    let Some((bundle_key, entrypoint)) = version else {
        return Ok(None);
    };
    let resolved = json!({
        "appId": app_id,
        "bundleKey": bundle_key,
        "entrypoint": entrypoint,
        "requiresToken": !is_publicly_servable(&visibility, &review_status),
    });
    cache
        .put_boxed(&key, &resolved.to_string(), Some(ASSET_CACHE_TTL))
        .await
        .map_err(ResolveError::Cache)?;
    Ok(Some(resolved))
}

// ── lifecycle webhooks ───────────────────────────────────────────────────────

/// `dispatchAppLifecycleWebhook`: a best-effort POST to the app's webhook
/// (5 seconds, no redirects). Never fails.
pub(crate) async fn dispatch_lifecycle_webhook(
    http: Arc<dyn HttpTransport>,
    webhook_url: Option<String>,
    payload: Value,
) {
    let Some(url) = webhook_url.filter(|url| !url.is_empty() && is_safe_lifecycle_webhook_url(url))
    else {
        return;
    };
    let request = OutboundRequest {
        method: "POST".to_owned(),
        url,
        headers: vec![
            ("content-type".to_owned(), "application/json".to_owned()),
            ("user-agent".to_owned(), "WeldSuite-Apps/1.0".to_owned()),
        ],
        body: Some(payload.to_string().into_bytes()),
        timeout: Some(Duration::from_secs(5)),
    };
    if let Err(error) = http.send(request).await {
        tracing::debug!(error, "core-apps: lifecycle webhook delivery failed");
    }
}

// ── first-party → hosted app adoption ────────────────────────────────────────

// Shared with external-api (`weld app publish` from the CLI).
pub(crate) use weldsuite_apps_domain::adopt::{
    adopt_official_system_installs, sweep_adopt_system_installs,
};
