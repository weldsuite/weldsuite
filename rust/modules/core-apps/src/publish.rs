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
    diff_scopes, is_native_only, is_reserved, is_safe_lifecycle_webhook_url, random_hex, sha256_hex,
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
pub(crate) fn is_publicly_servable(visibility: &str, review_status: &str) -> bool {
    visibility == "public" && review_status == "approved"
}

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

/// What adopting one app in one tenant did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Adoption {
    Adopted,
    Already,
    None,
}

/// Approved, public, live, official (or a reserved first-party code).
fn is_adoptable(app: &Value) -> bool {
    if !app["deletedAt"].is_null() || app["isActive"] != Value::Bool(true) {
        return false;
    }
    if !is_publicly_servable(text(app, "visibility"), text(app, "reviewStatus")) {
        return false;
    }
    let code = text(app, "code");
    !is_native_only(code) && (text(app, "publisherType") == "weldsuite" || is_reserved(code))
}

/// `adoptSystemInstallInTenant`.
#[allow(clippy::too_many_lines)] // the service's steps, in the TypeScript order
pub(crate) async fn adopt_system_install(
    master: &PgPool,
    tenant: &PgPool,
    app: &Value,
    workspace_id: &str,
    installed_by: Option<&str>,
) -> Result<Adoption, sqlx::Error> {
    if !is_adoptable(app) {
        return Ok(Adoption::None);
    }
    let app_id = text(app, "id");
    let tenant_row: Option<(String, bool, String, Option<String>)> = sqlx::query_as(
        "select id, is_active, app_type, user_app_id from workspace_installed_apps
         where app_code = $1 and deleted_at is null limit 1",
    )
    .bind(text(app, "code"))
    .fetch_optional(tenant)
    .await?;
    let Some((row_id, true, app_type, user_app_id)) = tenant_row else {
        return Ok(Adoption::None);
    };
    let linked = app_type == "user" && user_app_id.as_deref() == Some(app_id);
    if linked {
        let status: Option<String> = sqlx::query_scalar(
            "select status from user_app_installs where app_id = $1 and workspace_id = $2 limit 1",
        )
        .bind(app_id)
        .bind(workspace_id)
        .fetch_optional(master)
        .await?;
        if status.as_deref() == Some("active") {
            return Ok(Adoption::Already);
        }
    } else if app_type == "user" && user_app_id.as_deref().is_some_and(|id| !id.is_empty()) {
        // Another hosted app owns this sidenav code.
        return Ok(Adoption::None);
    } else if app_type != "system" && app_type != "user" {
        return Ok(Adoption::None);
    }

    let scopes = app
        .get("requestedScopes")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| json!([]));
    let now = now();
    let existing: Option<(String, String)> = sqlx::query_as(
        "select id, status from user_app_installs where app_id = $1 and workspace_id = $2 limit 1",
    )
    .bind(app_id)
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    let (bump, existing_active) = match &existing {
        Some((_, status)) if status == "active" => (false, true),
        Some((install_id, _)) => {
            sqlx::query(
                "update user_app_installs set
                   status = 'active', granted_scopes = $2::jsonb, pending_scopes = null,
                   installed_by = coalesce($3, installed_by), installed_at = $4::timestamptz,
                   revoked_at = null, updated_at = $4::timestamptz
                 where id = $1",
            )
            .bind(install_id)
            .bind(&scopes)
            .bind(installed_by)
            .bind(&now)
            .execute(master)
            .await?;
            (true, false)
        }
        None => {
            sqlx::query(
                "insert into user_app_installs
                   (id, app_id, workspace_id, status, granted_scopes, installed_by, installed_at, created_at, updated_at)
                 values ($1, $2, $3, 'active', $4::jsonb, $5, $6::timestamptz, $6::timestamptz, $6::timestamptz)",
            )
            .bind(generate_id("uai"))
            .bind(app_id)
            .bind(workspace_id)
            .bind(&scopes)
            .bind(installed_by.filter(|by| !by.is_empty()).unwrap_or("system"))
            .bind(&now)
            .execute(master)
            .await?;
            (true, false)
        }
    };
    let already_linked = linked && existing_active;

    sqlx::query(
        "update workspace_installed_apps set
           app_type = 'user', user_app_id = $2, granted_scopes = $3::jsonb, is_active = true,
           deleted_at = null, updated_at = $4::timestamptz,
           installed_by = case when $5::text is null then installed_by else $5 end
         where id = $1",
    )
    .bind(&row_id)
    .bind(app_id)
    .bind(&scopes)
    .bind(&now)
    .bind(installed_by.filter(|by| !by.is_empty()))
    .execute(tenant)
    .await?;

    if bump {
        sqlx::query(
            "update user_apps set install_count = install_count + 1, updated_at = $2::timestamptz
             where id = $1",
        )
        .bind(app_id)
        .bind(&now)
        .execute(master)
        .await?;
    }
    Ok(if already_linked {
        Adoption::Already
    } else {
        Adoption::Adopted
    })
}

/// Official public apps that could claim one of `codes` (`findOfficialAppsForCodes`).
async fn official_apps_for_codes(
    master: &PgPool,
    codes: &[String],
) -> Result<Vec<Value>, sqlx::Error> {
    if codes.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        app_json!(),
        " from user_apps a
         where a.visibility = 'public' and a.review_status = 'approved' and a.is_active = true
           and a.deleted_at is null"
    ))
    .fetch_all(master)
    .await?;
    Ok(rows
        .into_iter()
        .map(row)
        .filter(|app| {
            let code = text(app, "code");
            codes.iter().any(|c| c == code)
                && (text(app, "publisherType") == "weldsuite" || is_reserved(code))
        })
        .collect())
}

/// `adoptOfficialSystemInstallsForTenant`: on every store and installed read.
pub(crate) async fn adopt_official_system_installs(
    master: &PgPool,
    tenant: &PgPool,
    workspace_id: &str,
    installed_by: Option<&str>,
) -> Result<usize, sqlx::Error> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select app_code, app_type from workspace_installed_apps
         where is_active = true and deleted_at is null",
    )
    .fetch_all(tenant)
    .await?;
    // A native-again module adopted onto its hosted app goes back to being
    // the built-in install.
    if rows
        .iter()
        .any(|(code, app_type)| app_type == "user" && is_native_only(code))
    {
        sqlx::query(
            "update workspace_installed_apps set
               app_type = 'system', user_app_id = null, granted_scopes = null, updated_at = $1::timestamptz
             where app_code = any($2) and app_type = 'user' and deleted_at is null",
        )
        .bind(now())
        .bind(crate::scopes::NATIVE_ONLY_APP_CODES.map(str::to_owned).to_vec())
        .execute(tenant)
        .await?;
    }
    let mut codes: Vec<String> = Vec::new();
    for (code, _) in rows {
        if !is_native_only(&code) && !codes.contains(&code) {
            codes.push(code);
        }
    }
    let mut adopted = 0;
    for app in official_apps_for_codes(master, &codes).await? {
        if adopt_system_install(master, tenant, &app, workspace_id, installed_by).await?
            == Adoption::Adopted
        {
            adopted += 1;
        }
    }
    Ok(adopted)
}

/// `sweepAdoptSystemInstallsForApp`: every provisioned workspace, after an
/// official app goes live. Fire-and-forget; failures are counted and logged.
pub(crate) async fn sweep_adopt_system_installs(
    master: PgPool,
    workspaces: Arc<weldsuite_db::Workspaces>,
    app: Value,
    installed_by: String,
) {
    let code = text(&app, "code").to_owned();
    if is_native_only(&code) || (text(&app, "publisherType") != "weldsuite" && !is_reserved(&code))
    {
        return;
    }
    let rows: Vec<(String, Option<String>)> = match sqlx::query_as(
        "select id, clerk_org_id from workspaces where scheduled_deletion_at is null",
    )
    .fetch_all(&master)
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "core-apps: adopt sweep could not list workspaces");
            return;
        }
    };
    let (mut adopted, mut failed) = (0, 0);
    for (workspace_id, clerk_org_id) in rows {
        let reference = clerk_org_id
            .filter(|org| !org.is_empty())
            .unwrap_or_else(|| workspace_id.clone());
        let result = match workspaces.tenant(&reference).await {
            Ok(tenant) => adopt_system_install(
                &master,
                &tenant.db,
                &app,
                &workspace_id,
                Some(&installed_by),
            )
            .await
            .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        match result {
            Ok(Adoption::Adopted) => adopted += 1,
            Ok(_) => {}
            Err(error) => {
                failed += 1;
                tracing::error!(
                    error,
                    workspace_id,
                    "core-apps: adopt sweep failed for a workspace"
                );
            }
        }
    }
    tracing::info!(code, adopted, failed, "core-apps: adopt sweep done");
}
