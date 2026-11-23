//! The shared work of `services/user-apps.ts`: app rows as Drizzle returns
//! them, publishing a version, minting `wsat_` tokens, resolving a code to
//! its live bundle, lifecycle webhooks, and adopting first-party installs
//! onto an official hosted app.

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::id::generate_id;
use weldsuite_ports::DynCache;
use weldsuite_schema::master::{user_app_installs, user_app_tokens, user_app_versions, user_apps};

use crate::http_transport::{HttpTransport, OutboundRequest};
use crate::scopes::{diff_scopes, is_safe_lifecycle_webhook_url, random_hex, sha256_hex};

/// A row as Drizzle returns it: the entity serializes as Drizzle did.
pub(crate) fn row<M: serde::Serialize>(model: M) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

/// `at` as Drizzle writes a `Date` to a `timestamptz` column: UTC, to the
/// millisecond.
pub(crate) fn to_millis(at: OffsetDateTime) -> OffsetDateTime {
    utc_timestamp(at).assume_utc()
}

/// `new Date()` as Drizzle writes it to a `timestamptz` column.
pub(crate) fn now_tz() -> OffsetDateTime {
    to_millis(OffsetDateTime::now_utc())
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
) -> Result<MintedToken, DbErr> {
    let token = format!("wsat_{}", random_hex(20));
    let hash = sha256_hex(&token);
    let prefix: String = token.chars().take(12).collect();
    let expiry = (token_type == "session").then(|| OffsetDateTime::now_utc() + SESSION_TOKEN_TTL);
    let expires_at = expiry.map(iso_timestamp);
    let expires_at_ms =
        expiry.and_then(|at| i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok());
    user_app_tokens::Entity::insert(user_app_tokens::ActiveModel {
        id: Set(generate_id("uat")),
        install_id: Set(install_id.to_owned()),
        app_id: Set(app_id.to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        token_hash: Set(hash),
        token_prefix: Set(prefix),
        token_type: Set(token_type.to_owned()),
        scopes: Set(Some(json!(scopes))),
        expires_at: Set(expiry.map(to_millis)),
        ..Default::default()
    })
    .exec_without_returning(&orm(master))
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
    Database(DbErr),
}

impl std::fmt::Display for PublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoManifest(id) => write!(f, "Version {id} has no manifest"),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl From<DbErr> for PublishError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

/// The app's columns a published manifest sets: name, description, the
/// manifest and its scopes, pricing; category and currency only when given
/// (`coalesce`), the URLs and screenshots only when the manifest has the key.
fn manifest_columns(
    manifest: &Value,
    requested: &[String],
) -> Result<sea_orm::UpdateMany<user_apps::Entity>, DbErr> {
    let field = |key: &str| manifest.get(key);
    let truthy_text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let plain_text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    let pricing = field("pricing");
    let pricing_type = pricing
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("free");
    // `$n::numeric` of the number's text.
    let price_monthly = match pricing.and_then(|p| p.get("monthlyPrice")) {
        Some(Value::Number(price)) if pricing_type == "subscription" => Some(
            BigDecimal::from_str(&price.to_string())
                .map_err(|error| DbErr::Type(error.to_string()))?,
        ),
        _ => None,
    };
    let currency = truthy_text(pricing.and_then(|p| p.get("currency"))).map(|c| c.to_uppercase());
    let mut update = user_apps::Entity::update_many()
        .col_expr(user_apps::Column::Name, Expr::value(plain_text(field("name"))))
        .col_expr(
            user_apps::Column::Description,
            Expr::value(plain_text(field("description"))),
        )
        .col_expr(user_apps::Column::Manifest, Expr::value(manifest.clone()))
        .col_expr(
            user_apps::Column::RequestedScopes,
            Expr::value(json!(requested)),
        )
        .col_expr(user_apps::Column::PricingType, Expr::value(pricing_type))
        .col_expr(user_apps::Column::PriceMonthly, Expr::value(price_monthly));
    if let Some(category) = truthy_text(field("category")) {
        update = update.col_expr(user_apps::Column::Category, Expr::value(category));
    }
    if let Some(currency) = currency {
        update = update.col_expr(user_apps::Column::Currency, Expr::value(currency));
    }
    for (key, column) in [
        ("websiteUrl", user_apps::Column::WebsiteUrl),
        ("privacyUrl", user_apps::Column::PrivacyUrl),
        ("webhookUrl", user_apps::Column::WebhookUrl),
    ] {
        if let Some(value) = field(key) {
            update = update.col_expr(column, Expr::value(plain_text(Some(value))));
        }
    }
    if let Some(screenshots) = field("screenshots") {
        update = update.col_expr(
            user_apps::Column::Screenshots,
            Expr::value(screenshots.clone()),
        );
    }
    Ok(update)
}

/// `publishAppVersion`: supersede the live version, publish this one, take
/// the app's columns from its manifest, and queue new scopes on every
/// active install.
pub(crate) async fn publish_app_version(
    master: &PgPool,
    app_id: &str,
    version_id: &str,
    manifest: Option<&Value>,
) -> Result<Vec<InstallNeedingConsent>, PublishError> {
    let Some(manifest @ Value::Object(_)) = manifest else {
        return Err(PublishError::NoManifest(version_id.to_owned()));
    };
    let db = orm(master);
    let now = now_tz();
    user_app_versions::Entity::update_many()
        .col_expr(user_app_versions::Column::Status, Expr::value("superseded"))
        .filter(user_app_versions::Column::AppId.eq(app_id))
        .filter(user_app_versions::Column::Status.eq("published"))
        .filter(user_app_versions::Column::Id.ne(version_id))
        .exec(&db)
        .await?;
    user_app_versions::Entity::update_many()
        .col_expr(user_app_versions::Column::Status, Expr::value("published"))
        .col_expr(user_app_versions::Column::PublishedAt, Expr::value(now))
        .filter(user_app_versions::Column::Id.eq(version_id))
        .exec(&db)
        .await?;

    let requested = string_list(manifest.get("scopes"));
    manifest_columns(manifest, &requested)?
        .col_expr(user_apps::Column::CurrentVersionId, Expr::value(version_id))
        .col_expr(user_apps::Column::UpdatedAt, Expr::value(now))
        .filter(user_apps::Column::Id.eq(app_id))
        .exec(&db)
        .await?;

    let installs: Vec<(String, String, Option<Value>)> = user_app_installs::Entity::find()
        .select_only()
        .columns([
            user_app_installs::Column::Id,
            user_app_installs::Column::WorkspaceId,
            user_app_installs::Column::GrantedScopes,
        ])
        .filter(user_app_installs::Column::AppId.eq(app_id))
        .filter(user_app_installs::Column::Status.eq("active"))
        .into_tuple()
        .all(&db)
        .await?;
    let mut needing = Vec::new();
    for (install_id, workspace_id, granted) in installs {
        let new_scopes = diff_scopes(&requested, &string_list(granted.as_ref()));
        if new_scopes.is_empty() {
            continue;
        }
        user_app_installs::Entity::update_many()
            .col_expr(
                user_app_installs::Column::PendingScopes,
                Expr::value(json!(new_scopes)),
            )
            .col_expr(user_app_installs::Column::UpdatedAt, Expr::value(now))
            .filter(user_app_installs::Column::Id.eq(&install_id))
            .exec(&db)
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
    Database(DbErr),
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
    let db = orm(master);
    let app: Option<(
        String,
        Option<String>,
        bool,
        Option<OffsetDateTime>,
        String,
        String,
    )> = user_apps::Entity::find()
        .select_only()
        .columns([
            user_apps::Column::Id,
            user_apps::Column::CurrentVersionId,
            user_apps::Column::IsActive,
            user_apps::Column::DeletedAt,
            user_apps::Column::Visibility,
            user_apps::Column::ReviewStatus,
        ])
        .filter(user_apps::Column::Code.eq(code))
        .into_tuple()
        .one(&db)
        .await
        .map_err(ResolveError::Database)?;
    let Some((app_id, Some(version_id), true, None, visibility, review_status)) = app else {
        return Ok(None);
    };
    let version: Option<(String, String)> = user_app_versions::Entity::find()
        .select_only()
        .columns([
            user_app_versions::Column::BundleKey,
            user_app_versions::Column::Entrypoint,
        ])
        .filter(user_app_versions::Column::Id.eq(&version_id))
        .into_tuple()
        .one(&db)
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
