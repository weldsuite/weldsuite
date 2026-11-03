//! `/api/connectors` routes that make, change and remove a connection
//! (`routes/connectors/index.ts`, `settings.ts`): connect with credentials,
//! authorise through WooCommerce / Moneybird / Stripe, the OAuth callback and
//! Moneybird's administration picker, PATCH and DELETE of a connection. The
//! flows are `weldsuite_connect_domain::auth`; webhooks are registered and
//! removed through `weldsuite_connect_domain::webhooks`.

use axum::body::Bytes;
use axum::extract::{OriginalUri, Path, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CONNECTOR_CONNECTION_CONNECTED, CONNECTOR_CONNECTION_DISCONNECTED, CONNECTOR_CONNECTION_UPDATED,
};
use weldsuite_connect_domain::auth::{
    AuthEnv, AuthError, TenantRef, complete_moneybird_oauth, complete_stripe_oauth,
    select_moneybird_administration, start_moneybird_oauth, start_stripe_oauth, start_woo_app_auth,
};
use weldsuite_connect_domain::catalog::{get_connector, normalize_enabled_syncs};
use weldsuite_connect_domain::clients::decrypt_credentials;
use weldsuite_connect_domain::connections::{
    NewConnection, SettingsUpdate, encrypt_credentials, encrypt_webhook_secret, get_connection,
    mark_connection_disconnected, sanitize_connection, sanitize_with_entity,
    seed_default_field_mappings, update_connection_settings, upsert_connection,
};
use weldsuite_connect_domain::provider::test_connector_credentials;
use weldsuite_connect_domain::sync::Trigger;
use weldsuite_connect_domain::webhooks::{
    delete_stripe_account_mapping, delete_webhook_mapping, generate_webhook_secret,
    put_webhook_mapping, register_connection_webhooks, stripe_account_kv_key,
    unregister_connection_webhooks, webhook_base_url,
};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{ApiError, Data};

use crate::connector_sync::{Background, spawn_sync, sync_env};
use crate::{Caller, ConnectState, Overrides, validate};

/// The flows' env, from the request's overrides and the state.
pub(crate) fn auth_env(overrides: &Overrides, state: &ConnectState) -> AuthEnv {
    let env = |name: &str| overrides.env(state, name);
    AuthEnv {
        sync: sync_env(overrides, state),
        cache: overrides.kv(state),
        internal_api_secret: env("INTERNAL_API_SECRET"),
        app_api_public_url: env("APP_API_PUBLIC_URL"),
        public_app_url: env("PUBLIC_APP_URL"),
        environment: env("ENVIRONMENT"),
        moneybird_client_id: env("MONEYBIRD_CLIENT_ID"),
        moneybird_client_secret: env("MONEYBIRD_CLIENT_SECRET"),
        stripe_connect_client_id: env("STRIPE_CONNECT_CLIENT_ID"),
        webhook_base_url: webhook_base_url(
            env("CONNECTOR_WEBHOOK_BASE_URL").as_deref(),
            env("ENVIRONMENT").as_deref(),
        ),
    }
}

fn failed(error: &dyn std::fmt::Display) -> Response {
    tracing::error!(%error, "[app-api/connectors] request failed");
    ApiError::internal()
        .with_message("Connector request failed")
        .into_response()
}

fn auth_failure(error: AuthError) -> Response {
    match error {
        AuthError::Refused(refused) => (
            StatusCode::from_u16(refused.status).unwrap_or(StatusCode::BAD_REQUEST),
            axum::Json(json!({ "error": { "code": "BAD_REQUEST", "message": refused.error } })),
        )
            .into_response(),
        AuthError::Database(error) => failed(&error),
        AuthError::Other(error) => failed(&error),
    }
}

// ── settings (`settings.ts`) ────────────────────────────────────────────────

fn iso_date(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..].iter().all(u8::is_ascii_digit)
}

fn moneybird_id(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Value {
    issues
        .text(body, key, Presence::Nullish, Some(1), Some(64))
        .into_option()
        .map_or(Value::Null, Value::String)
}

/// Unknown keys of a `.strict()` object, as Zod reports them.
fn strict_keys(issues: &mut Issues, body: &Map<String, Value>, known: &[&str]) {
    let extra: Vec<&String> = body
        .keys()
        .filter(|k| !known.contains(&k.as_str()))
        .collect();
    if extra.is_empty() {
        return;
    }
    let listed = extra
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let path = issues.path_here();
    issues.push_raw(json!({
        "code": "unrecognized_keys",
        "keys": extra,
        "path": path,
        "message": format!("Unrecognized key(s) in object: {listed}"),
    }));
}

/// `connectorSettingsSchema` at `settings`: the settings with their
/// defaults, and the refinement issues (pushed by the caller after the
/// body's other checks, as `safeParseAsync` settles them).
pub(crate) fn read_settings(
    issues: &mut Issues,
    body: &Map<String, Value>,
    refinements: &mut Vec<Value>,
) -> Option<Map<String, Value>> {
    issues
        .nested(body, "settings", Presence::Optional, |issues, settings| {
            let mut out = Map::new();
            match issues.pattern(
                settings,
                "importStartDate",
                Presence::Nullish,
                None,
                None,
                iso_date,
                "Use YYYY-MM-DD",
            ) {
                weldsuite_kit::validation::Field::Set(date) => {
                    out.insert("importStartDate".to_owned(), json!(date));
                }
                weldsuite_kit::validation::Field::Null => {
                    out.insert("importStartDate".to_owned(), Value::Null);
                }
                weldsuite_kit::validation::Field::Absent => {}
            }
            let push = issues.nested(settings, "moneybirdPush", Presence::Nullish, |issues, push| {
                let before = issues.count();
                let mut out = Map::new();
                let enabled = issues.boolean(push, "enabled", Presence::Required).into_option();
                out.insert("enabled".to_owned(), json!(enabled));
                let sources = issues
                    .list(push, "sourceConnectionIds", Presence::Optional, None, Some(20), |issues, item| {
                        issues.item_text(item, Text::length(Some(1), Some(30)))
                    })
                    .into_option()
                    .unwrap_or_default();
                out.insert("sourceConnectionIds".to_owned(), json!(sources));
                for key in [
                    "revenueLedgerAccountId",
                    "financialAccountId",
                    "feeLedgerAccountId",
                    "payoutLedgerAccountId",
                ] {
                    let id = moneybird_id(issues, push, key);
                    out.insert(key.to_owned(), id);
                }
                let overrides = issues
                    .nested(push, "taxRateOverrides", Presence::Optional, |issues, o| {
                        let mut out = Map::new();
                        for key in ["reverseCharge", "outsideEu", "exempt", "noTax"] {
                            let id = moneybird_id(issues, o, key);
                            out.insert(key.to_owned(), id);
                        }
                        out
                    })
                    .into_option()
                    .unwrap_or_else(|| {
                        ["reverseCharge", "outsideEu", "exempt", "noTax"]
                            .into_iter()
                            .map(|k| (k.to_owned(), Value::Null))
                            .collect()
                    });
                out.insert("taxRateOverrides".to_owned(), Value::Object(overrides));
                let start = issues
                    .pattern(push, "startDate", Presence::Nullish, None, None, iso_date, "Use YYYY-MM-DD")
                    .into_option();
                out.insert("startDate".to_owned(), json!(start));
                // `.superRefine(...)`, when the object itself parsed.
                if issues.count() == before {
                    let empty = |k: &str| out.get(k).is_none_or(|v| !weldsuite_connect_domain::js::truthy(v));
                    let path = issues.path_here();
                    let at = |key: &str| {
                        let mut p = path.as_array().cloned().unwrap_or_default();
                        p.push(json!(key));
                        Value::Array(p)
                    };
                    if enabled == Some(true) && empty("revenueLedgerAccountId") {
                        refinements.push(json!({ "code": "custom", "path": at("revenueLedgerAccountId"), "message": "Pick a revenue ledger account" }));
                    }
                    if !empty("financialAccountId") && (empty("feeLedgerAccountId") || empty("payoutLedgerAccountId")) {
                        refinements.push(json!({ "code": "custom", "path": at("feeLedgerAccountId"), "message": "Pick the fee and transfer ledgers for the Stripe account" }));
                    }
                }
                out
            });
            match push {
                weldsuite_kit::validation::Field::Set(push) => {
                    out.insert("moneybirdPush".to_owned(), Value::Object(push));
                }
                weldsuite_kit::validation::Field::Null => {
                    out.insert("moneybirdPush".to_owned(), Value::Null);
                }
                weldsuite_kit::validation::Field::Absent => {}
            }
            strict_keys(issues, settings, &["importStartDate", "moneybirdPush"]);
            out
        })
        .into_option()
}

/// `settingsError(provider, settings)`.
fn settings_error(provider: &str, settings: Option<&Map<String, Value>>) -> Option<&'static str> {
    let settings = settings?;
    if settings.contains_key("importStartDate") && provider != "stripe" {
        return Some("importStartDate only applies to Stripe connections");
    }
    if settings.contains_key("moneybirdPush") && provider != "moneybird" {
        return Some("moneybirdPush only applies to Moneybird connections");
    }
    None
}

/// `mergeConnectorSettings(current, patch)`.
fn merge_settings(current: &Value, patch: &Map<String, Value>) -> Value {
    let mut next = current.as_object().cloned().unwrap_or_default();
    for key in ["importStartDate", "moneybirdPush"] {
        if let Some(value) = patch.get(key) {
            next.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(next)
}

fn credentials_record(
    issues: &mut Issues,
    b: &Map<String, Value>,
    presence: Presence,
) -> Option<Map<String, Value>> {
    issues
        .nested(b, "credentials", presence, |issues, inner| {
            let mut out = Map::new();
            for name in inner.keys() {
                if let Some(value) = issues
                    .text_with(inner, name, Presence::Required, Text::length(Some(1), None))
                    .into_option()
                {
                    out.insert(name.clone(), json!(value));
                }
            }
            out
        })
        .into_option()
}

fn syncs_list(issues: &mut Issues, b: &Map<String, Value>) -> Option<Vec<String>> {
    issues
        .list(
            b,
            "enabledSyncs",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::length(Some(1), None)),
        )
        .into_option()
}

async fn entity_exists(db: &weldsuite_db::PgPool, id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<String> =
        sqlx::query_scalar("select id from entities where id = $1 and deleted_at is null limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(found.is_some())
}

fn hostname_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str().map(|h| {
                u.port()
                    .map_or_else(|| h.to_owned(), |p| format!("{h}:{p}"))
            })
        })
        .unwrap_or_else(|| url.to_owned())
}

fn text_of<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

/// `connectRequestError(connector, credentials)`.
fn connect_request_error(connector: &Value, credentials: &Map<String, Value>) -> Option<String> {
    let trimmed = |k: &str| {
        text_of(credentials, k)
            .map(weldsuite_kit::validation::js_trim)
            .filter(|v| !v.is_empty())
    };
    if connector["provider"] == "stripe" {
        return trimmed("apiKey")
            .is_none()
            .then(|| "Paste a Stripe API key, or use Connect with Stripe".to_owned());
    }
    let kind = connector["auth"]["kind"].as_str().unwrap_or_default();
    if kind == "oauth2" {
        return Some(format!(
            "Connect from the Connect button — {} authorises via OAuth",
            connector["label"].as_str().unwrap_or_default()
        ));
    }
    let set = |k: &str| text_of(credentials, k).is_some_and(|v| !v.is_empty());
    if kind == "app_auth" && (!set("consumerKey") || !set("consumerSecret")) {
        return Some(
            "Connect this store from the Connect button — WooCommerce creates the API keys after you approve access"
                .to_owned(),
        );
    }
    for field in connector["auth"]["fields"].as_array().into_iter().flatten() {
        let required = field["required"].as_bool().unwrap_or(true);
        let key = field["key"].as_str().unwrap_or_default();
        if required && trimmed(key).is_none() {
            return Some(format!(
                "{} is required",
                field["label"].as_str().unwrap_or_default()
            ));
        }
    }
    None
}

/// `POST /connect`.
#[allow(clippy::too_many_lines)]
pub(crate) async fn connect(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut refinements = Vec::new();
    let read = validate(&headers, &body, |issues, b| {
        let provider = issues
            .text(b, "provider", Presence::Required, Some(1), Some(100))
            .into_option();
        let display = issues
            .text(b, "displayName", Presence::Optional, Some(1), Some(255))
            .into_option();
        let credentials = credentials_record(issues, b, Presence::Required);
        let syncs = syncs_list(issues, b);
        let entity = issues
            .text(b, "entityId", Presence::Optional, Some(1), Some(30))
            .into_option();
        let settings = read_settings(issues, b, &mut refinements);
        for issue in refinements.drain(..) {
            issues.push_raw(issue);
        }
        (
            provider.unwrap_or_default(),
            display,
            credentials.unwrap_or_default(),
            syncs,
            entity,
            settings,
        )
    });
    let (provider, display, raw_credentials, syncs, entity, settings) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Connector request failed"),
    };
    let Some(connector) = get_connector(&provider) else {
        return ApiError::bad_request(format!("Unknown connector '{provider}'")).into_response();
    };
    if let Some(message) = connect_request_error(connector, &raw_credentials)
        .or_else(|| settings_error(&provider, settings.as_ref()).map(str::to_owned))
    {
        return ApiError::bad_request(message).into_response();
    }
    let db = caller.db.clone();
    match entity.as_deref() {
        Some(id) => match entity_exists(&db, id).await {
            Ok(true) => {}
            Ok(false) => {
                return ApiError::bad_request("Accounting entity not found").into_response();
            }
            Err(error) => return failed(&error),
        },
        None => {}
    }
    // `credentialsToStore`: Stripe keeps only its allow-listed keys.
    let mut credentials: Map<String, Value> = if provider == "stripe" {
        raw_credentials
            .iter()
            .filter(|(k, _)| matches!(k.as_str(), "stripeUserId" | "apiKey" | "entityId"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    } else {
        raw_credentials.clone()
    };
    if let Some(id) = &entity {
        credentials.insert("entityId".to_owned(), json!(id));
    }
    let env = auth_env(&caller.overrides, &state);
    let tested =
        match test_connector_credentials(&provider, &credentials, env.sync.http.as_ref()).await {
            Ok(tested) => tested,
            Err(message) => return ApiError::bad_request(message).into_response(),
        };
    let keyring = &env.sync.keyring;
    let encrypted = match encrypt_credentials(&credentials, keyring) {
        Ok(encrypted) => encrypted,
        Err(error) => return failed(&error),
    };
    let enabled = normalize_enabled_syncs(&provider, syncs.as_deref());
    let account_label = tested
        .account_name
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| hostname_of(&tested.store_url));
    let label = display
        .as_deref()
        .map(weldsuite_kit::validation::js_trim)
        .filter(|l| !l.is_empty())
        .map_or_else(
            || {
                format!(
                    "{} ({account_label})",
                    connector["label"].as_str().unwrap_or_default()
                )
            },
            str::to_owned,
        );
    let raw_secret = if provider == "shopify" {
        text_of(&credentials, "apiSecret").map(str::to_owned)
    } else {
        Some(generate_webhook_secret())
    };
    let sealed = match raw_secret.as_deref().filter(|s| !s.is_empty()) {
        Some(secret) => match encrypt_webhook_secret(secret, keyring) {
            Ok(sealed) => Some(sealed),
            Err(error) => return failed(&error),
        },
        None => None,
    };
    let row = match upsert_connection(
        &db,
        &NewConnection {
            provider: &provider,
            display_name: &label,
            user_id: &caller.user_id,
            credentials: &encrypted,
            enabled_syncs: &enabled,
            external_account_id: Some(&tested.store_url),
            webhook_secret: sealed.as_deref(),
        },
    )
    .await
    {
        Ok(row) => row,
        Err(error) => return failed(&error),
    };
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    if let Some(settings) = &settings
        && let Err(error) = update_connection_settings(
            &db,
            &id,
            &SettingsUpdate {
                settings: Some(merge_settings(&row["settings"], settings)),
                ..SettingsUpdate::default()
            },
        )
        .await
    {
        return failed(&error);
    }
    if let Err(error) = seed_default_field_mappings(&db, &id, &provider).await {
        return failed(&error);
    }
    let warning = match register_connection_webhooks(
        &db,
        env.sync.http.as_ref(),
        keyring,
        &env.webhook_base_url,
        &row,
        &credentials,
        raw_secret.as_deref().unwrap_or_default(),
    )
    .await
    {
        Ok(registered) => registered.warning,
        Err(error) => {
            tracing::error!(%error, "[app-api/connectors] webhook registration failed");
            Some("Connected. Webhook registration failed — use Sync now until the store can push updates.".to_owned())
        }
    };
    if !caller.workspace_id.is_empty()
        && !caller.clerk_org_id.is_empty()
        && let Some(cache) = env.cache.as_ref()
        && let Err(error) = put_webhook_mapping(cache, &id, &caller.workspace_id, &provider).await
    {
        tracing::error!(%error, "[app-api/connectors] webhook KV mapping failed");
    }
    let fresh = match get_connection(&db, &id).await {
        Ok(fresh) => fresh.unwrap_or(row),
        Err(error) => return failed(&error),
    };
    caller.publish(
        &state,
        CONNECTOR_CONNECTION_CONNECTED,
        &id,
        &sanitize_connection(&fresh, None),
    );
    if !caller.clerk_org_id.is_empty() {
        spawn_sync(
            &state,
            Background {
                db: db.clone(),
                env: env.sync.clone(),
                connection: fresh.clone(),
                owner_id: caller.user_id.clone(),
                workspace_id: caller.clerk_org_id.clone(),
                trigger: Trigger::Initial,
                full: false,
                syncs: None,
            },
            "initial sync",
        );
    }
    let mut out = sanitize_connection(&fresh, None);
    out["warning"] = json!(warning);
    (StatusCode::CREATED, Data(out)).into_response()
}

/// `POST /authorize`.
pub(crate) async fn authorize(
    State(state): State<ConnectState>,
    caller: Caller,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        let provider = b
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if !matches!(provider.as_str(), "woocommerce" | "moneybird" | "stripe") {
            issues.invalid_discriminator("provider", &["woocommerce", "moneybird", "stripe"]);
            return None;
        }
        let store = (provider == "woocommerce")
            .then(|| {
                issues
                    .text(b, "storeUrl", Presence::Required, Some(1), Some(500))
                    .into_option()
            })
            .flatten();
        let display = issues
            .text(b, "displayName", Presence::Optional, Some(1), Some(255))
            .into_option();
        let syncs = syncs_list(issues, b);
        let return_url = issues
            .text_with(
                b,
                "returnUrl",
                Presence::Required,
                Text {
                    format: Some(weldsuite_kit::validation::Format::Url),
                    ..Text::length(None, None)
                },
            )
            .into_option();
        let entity = (provider != "woocommerce")
            .then(|| {
                issues
                    .text(b, "entityId", Presence::Optional, Some(1), Some(30))
                    .into_option()
            })
            .flatten();
        let start = (provider == "stripe")
            .then(|| {
                issues
                    .pattern(
                        b,
                        "importStartDate",
                        Presence::Optional,
                        None,
                        None,
                        iso_date,
                        "Invalid",
                    )
                    .into_option()
            })
            .flatten();
        Some((
            provider,
            store,
            display,
            syncs,
            return_url.unwrap_or_default(),
            entity,
            start,
        ))
    });
    let (provider, store, display, syncs, return_url, entity, start) = match read {
        Ok(Some(read)) => read,
        Ok(None) => return ApiError::internal().into_response(),
        Err(refusal) => return refusal.respond("Connector request failed"),
    };
    if caller.clerk_org_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    let env = auth_env(&caller.overrides, &state);
    let enabled = normalize_enabled_syncs(&provider, syncs.as_deref());
    if provider != "woocommerce"
        && let Some(id) = entity.as_deref()
    {
        match entity_exists(&caller.db, id).await {
            Ok(true) => {}
            Ok(false) => {
                return ApiError::bad_request("Accounting entity not found").into_response();
            }
            Err(error) => return failed(&error),
        }
    }
    let result = match provider.as_str() {
        "stripe" => {
            start_stripe_oauth(
                &env,
                &caller.clerk_org_id,
                &caller.user_id,
                &enabled,
                display.as_deref(),
                &return_url,
                entity.as_deref(),
                start.as_deref(),
            )
            .await
        }
        "moneybird" => {
            start_moneybird_oauth(
                &env,
                &caller.clerk_org_id,
                &caller.user_id,
                &enabled,
                display.as_deref(),
                &return_url,
                entity.as_deref(),
            )
            .await
        }
        _ => {
            // The callback path belongs to commerce-api; the request's own origin
            // is where it is served (`originForPathFrom`).
            let origin = request_origin(&headers, &uri);
            start_woo_app_auth(
                &caller.db,
                &env,
                &caller.clerk_org_id,
                &caller.user_id,
                store.as_deref().unwrap_or_default(),
                &enabled,
                display.as_deref(),
                &return_url,
                origin.as_deref(),
            )
            .await
        }
    };
    match result {
        Ok(value) => Data(value).into_response(),
        Err(AuthError::Refused(refused)) => ApiError::bad_request(refused.error).into_response(),
        Err(other) => auth_failure(other),
    }
}

/// `originForPathFrom(new URL(c.req.url).origin, WOOCOMMERCE_AUTH_CALLBACK_PATH)`:
/// the request's own origin, which serves commerce's callback too.
fn request_origin(headers: &HeaderMap, uri: &http::Uri) -> Option<String> {
    if let (Some(scheme), Some(authority)) = (uri.scheme_str(), uri.authority()) {
        return Some(format!("{scheme}://{authority}"));
    }
    let host = headers.get(http::header::HOST)?.to_str().ok()?;
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");
    Some(format!("{proto}://{host}"))
}

/// The tenant an OAuth state names: the caller's own when it is the same
/// workspace, else opened by the Clerk org id.
async fn tenant_for(
    state: &ConnectState,
    caller: &Caller,
    clerk_org_id: String,
) -> Result<TenantRef, String> {
    if clerk_org_id == caller.clerk_org_id || clerk_org_id == caller.workspace_id {
        return Ok(TenantRef {
            db: caller.db.clone(),
            workspace_id: caller.workspace_id.clone(),
        });
    }
    let Some(tenants) = &state.tenants else {
        return Err("no tenant databases".to_owned());
    };
    let db = tenants(clerk_org_id.clone()).await?;
    let workspace_id = match caller.overrides.master(state) {
        Some(master) => sqlx::query_scalar::<_, String>(
            "select id from workspaces where clerk_org_id = $1 or id = $1 limit 1",
        )
        .bind(&clerk_org_id)
        .fetch_optional(&master)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or(clerk_org_id),
        None => clerk_org_id,
    };
    Ok(TenantRef { db, workspace_id })
}

/// `POST /oauth/callback`.
pub(crate) async fn oauth_callback(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        let provider = issues
            .choice(b, "provider", Presence::Required, &["moneybird", "stripe"])
            .into_option();
        let code = issues
            .text(b, "code", Presence::Required, Some(1), None)
            .into_option();
        let state = issues
            .text(b, "state", Presence::Required, Some(1), None)
            .into_option();
        (
            provider.unwrap_or_default(),
            code.unwrap_or_default(),
            state.unwrap_or_default(),
        )
    });
    let (provider, code, oauth_state) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Connector request failed"),
    };
    let env = auth_env(&caller.overrides, &state);
    let resolve = |org: String| tenant_for(&state, &caller, org);
    let result = if provider == "stripe" {
        complete_stripe_oauth(&env, &code, &oauth_state, resolve).await
    } else {
        complete_moneybird_oauth(&env, &code, &oauth_state, resolve).await
    };
    match result {
        Ok(value) => Data(value).into_response(),
        Err(error) => auth_failure(error),
    }
}

/// `POST /connections/:id/select-account`.
pub(crate) async fn select_account(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        issues
            .text(
                b,
                "administrationId",
                Presence::Required,
                Some(1),
                Some(100),
            )
            .into_option()
    });
    let administration = match read {
        Ok(read) => read.unwrap_or_default(),
        Err(refusal) => return refusal.respond("Connector request failed"),
    };
    if caller.clerk_org_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    let env = auth_env(&caller.overrides, &state);
    match select_moneybird_administration(
        &caller.db,
        &env,
        &id,
        &administration,
        &caller.clerk_org_id,
        &caller.workspace_id,
        &caller.user_id,
    )
    .await
    {
        Ok(value) => Data(value).into_response(),
        Err(AuthError::Refused(refused)) if refused.status == 404 => {
            ApiError::not_found("Connection", Some(&id)).into_response()
        }
        Err(AuthError::Refused(refused)) => ApiError::bad_request(refused.error).into_response(),
        Err(other) => auth_failure(other),
    }
}

/// `PATCH /connections/:id`.
#[allow(clippy::too_many_lines)]
pub(crate) async fn patch_connection(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const DIRECTIONS: [&str; 3] = ["inbound", "outbound", "bidirectional"];
    let mut refinements = Vec::new();
    let read = validate(&headers, &body, |issues, b| {
        let display = issues
            .text(b, "displayName", Presence::Optional, Some(1), Some(255))
            .into_option();
        let syncs = syncs_list(issues, b);
        let direction = issues
            .choice(b, "direction", Presence::Optional, &DIRECTIONS)
            .into_option();
        let per_object =
            issues.nested(b, "objectSyncDirections", Presence::Nullish, |issues, o| {
                let mut out = Map::new();
                for key in o.keys() {
                    if let Some(d) = issues
                        .choice(o, key, Presence::Required, &DIRECTIONS)
                        .into_option()
                    {
                        out.insert(key.clone(), json!(d));
                    }
                }
                out
            });
        let credentials = credentials_record(issues, b, Presence::Optional);
        let entity = issues.text(b, "entityId", Presence::Nullish, Some(1), Some(30));
        let settings = read_settings(issues, b, &mut refinements);
        for issue in refinements.drain(..) {
            issues.push_raw(issue);
        }
        (
            display,
            syncs,
            direction,
            per_object,
            credentials,
            entity,
            settings,
        )
    });
    let (display, syncs, direction, per_object, body_credentials, entity, settings) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Connector request failed"),
    };
    let db = caller.db.clone();
    let row = match get_connection(&db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Connection", Some(&id)).into_response(),
        Err(error) => return failed(&error),
    };
    let provider = row["provider"].as_str().unwrap_or_default().to_owned();
    let env = auth_env(&caller.overrides, &state);
    let keyring = env.sync.keyring.clone();
    if let weldsuite_kit::validation::Field::Set(entity_id) = &entity {
        match entity_exists(&db, entity_id).await {
            Ok(true) => {}
            Ok(false) => {
                return ApiError::bad_request("Accounting entity not found").into_response();
            }
            Err(error) => return failed(&error),
        }
    }
    if let Some(message) = settings_error(&provider, settings.as_ref()) {
        return ApiError::bad_request(message).into_response();
    }
    let existing = decrypt_credentials(row.get("credentials"), &keyring);
    // `buildCredentialPatch(provider, existing, body, keyring)`.
    let mut encrypted: Option<Map<String, Value>> = None;
    let mut external: Option<String> = None;
    let apply_entity = |merged: &mut Map<String, Value>| match &entity {
        weldsuite_kit::validation::Field::Set(e) => {
            merged.insert("entityId".to_owned(), json!(e));
        }
        weldsuite_kit::validation::Field::Null => {
            merged.remove("entityId");
        }
        weldsuite_kit::validation::Field::Absent => {}
    };
    if let Some(patch) = &body_credentials {
        if provider == "stripe" {
            if existing
                .get("apiKey")
                .is_none_or(|k| !weldsuite_connect_domain::js::truthy(k))
            {
                return ApiError::bad_request(
                    "Connect Stripe again to change the account of this connection",
                )
                .into_response();
            }
            if patch.keys().any(|k| k != "apiKey") {
                return ApiError::bad_request("Only the Stripe API key can be changed")
                    .into_response();
            }
        }
        let mut merged = existing.clone();
        for (k, v) in patch {
            merged.insert(k.clone(), v.clone());
        }
        apply_entity(&mut merged);
        match test_connector_credentials(&provider, &merged, env.sync.http.as_ref()).await {
            Ok(tested) => external = Some(tested.store_url),
            Err(message) => return ApiError::bad_request(message).into_response(),
        }
        match encrypt_credentials(&merged, &keyring) {
            Ok(sealed) => encrypted = Some(sealed),
            Err(error) => return failed(&error),
        }
    } else if !matches!(entity, weldsuite_kit::validation::Field::Absent) {
        let mut merged = existing.clone();
        if let weldsuite_kit::validation::Field::Set(e) = &entity {
            merged.insert("entityId".to_owned(), json!(e));
        } else {
            merged.remove("entityId");
        }
        match encrypt_credentials(&merged, &keyring) {
            Ok(sealed) => encrypted = Some(sealed),
            Err(error) => return failed(&error),
        }
    }
    let update = SettingsUpdate {
        enabled_syncs: syncs.map(|s| normalize_enabled_syncs(&provider, Some(&s))),
        direction,
        object_sync_directions: match per_object {
            weldsuite_kit::validation::Field::Set(o) => Some(Value::Object(o)),
            weldsuite_kit::validation::Field::Null => Some(Value::Null),
            weldsuite_kit::validation::Field::Absent => None,
        },
        credentials: encrypted,
        display_name: display,
        external_account_id: external.map(Some),
        settings: settings
            .as_ref()
            .map(|s| merge_settings(&row["settings"], s)),
        ..SettingsUpdate::default()
    };
    if let Err(error) = update_connection_settings(&db, &id, &update).await {
        return failed(&error);
    }
    let updated = match get_connection(&db, &id).await {
        Ok(Some(updated)) => updated,
        Ok(None) => return ApiError::internal().into_response(),
        Err(error) => return failed(&error),
    };
    if !caller.clerk_org_id.is_empty() && settings.is_some() {
        after_settings_change(&state, &caller, &env, &db, &row, &updated);
    }
    let sanitized = sanitize_with_entity(&updated, &keyring);
    caller.publish(&state, CONNECTOR_CONNECTION_UPDATED, &id, &sanitized);
    Data(sanitized).into_response()
}

/// `afterSettingsChange(...)`: re-read Stripe from a new start date, send to
/// Moneybird once enabled.
fn after_settings_change(
    state: &ConnectState,
    caller: &Caller,
    env: &AuthEnv,
    db: &weldsuite_db::PgPool,
    before: &Value,
    after: &Value,
) {
    let start = |row: &Value| row["settings"]["importStartDate"].clone();
    if after["provider"] == "stripe" && start(before) != start(after) {
        spawn_sync(
            state,
            Background {
                db: db.clone(),
                env: env.sync.clone(),
                connection: after.clone(),
                owner_id: caller.user_id.clone(),
                workspace_id: caller.clerk_org_id.clone(),
                trigger: Trigger::Manual,
                full: true,
                syncs: None,
            },
            "re-sync after start date change",
        );
    }
    if after["provider"] == "moneybird"
        && weldsuite_connect_domain::js::truthy(&after["settings"]["moneybirdPush"]["enabled"])
    {
        crate::connector_push::spawn_push(
            state,
            db.clone(),
            env.sync.clone(),
            after.clone(),
            false,
        );
    }
}

/// `DELETE /connections/:id`.
pub(crate) async fn delete_connection(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let db = caller.db.clone();
    let row = match get_connection(&db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Connection", Some(&id)).into_response(),
        Err(error) => return failed(&error),
    };
    let env = auth_env(&caller.overrides, &state);
    let credentials = decrypt_credentials(row.get("credentials"), &env.sync.keyring);
    unregister_connection_webhooks(env.sync.http.as_ref(), &row, &credentials).await;
    let Some(cache) = env.cache.clone() else {
        // `env.WORKSPACE_CACHE.delete(...)` without the binding throws.
        return ApiError::internal().into_response();
    };
    if row["provider"] == "stripe" {
        // `disconnectStripeAccount`: revoke unless another workspace still uses it.
        let account = credentials
            .get("stripeUserId")
            .and_then(Value::as_str)
            .filter(|a| !a.is_empty());
        let api_key = credentials
            .get("apiKey")
            .is_some_and(weldsuite_connect_domain::js::truthy);
        if let Some(account) = account
            && !api_key
        {
            if let Err(error) = delete_stripe_account_mapping(&cache, account, &id).await {
                tracing::error!(%error, "[app-api/connectors] unregister webhooks failed");
            } else {
                let still_used = cache
                    .get_boxed(&stripe_account_kv_key(account))
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|v| !v.is_empty());
                let client_id = env
                    .stripe_connect_client_id
                    .as_deref()
                    .map(weldsuite_kit::validation::js_trim)
                    .filter(|c| !c.is_empty());
                let secret = env
                    .sync
                    .stripe_secret_key
                    .as_deref()
                    .map(weldsuite_kit::validation::js_trim)
                    .filter(|c| !c.is_empty());
                if let (false, Some(client_id), Some(secret)) = (still_used, client_id, secret)
                    && let Err(error) = weldsuite_connect_domain::stripe::deauthorize(
                        env.sync.http.as_ref(),
                        secret,
                        client_id,
                        account,
                    )
                    .await
                {
                    tracing::error!(error = %error.message, "[app-api/connectors] unregister webhooks failed");
                }
            }
        }
    }
    if let Err(error) = delete_webhook_mapping(&cache, &id).await {
        return failed(&error);
    }
    if let Err(error) = mark_connection_disconnected(&db, &id).await {
        return failed(&error);
    }
    caller.publish(
        &state,
        CONNECTOR_CONNECTION_DISCONNECTED,
        &id,
        &json!({ "id": id, "provider": row["provider"] }),
    );
    Data(json!({ "id": id, "disconnected": true })).into_response()
}
