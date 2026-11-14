//! `/api/ai-settings` (Rust only; ADR AI-012, `docs/plans/eu-ai-mistral.md`):
//! which AI providers the workspace allows, on whose key, where each feature
//! runs, and what has been spent.
//!
//! There is no TypeScript twin: Global runs AI through `@weldsuite/ai` and
//! its own gateway, so app-api does not mount the route and the path is
//! registered to `core` in `@weldsuite/api-modules` only for the Kubernetes
//! editions. The router is mounted only when the install has an AI provider
//! (`AppState.ai`); without one the path is a 404 like any unmounted route.
//!
//! The shapes are the platform's (`@weldsuite/app-api-client/schemas/ai-settings`):
//!
//! | Route | Permission | |
//! |---|---|---|
//! | `GET /` | any member | the effective policy; key status only with `ai:manage`; `canManage` |
//! | `PUT /` | `ai:manage` | providers, default, overrides; answers the new policy |
//! | `PUT /keys/:provider` | `ai:manage` | check with the provider, seal, store; answers the key status |
//! | `POST /keys/:provider/test` | `ai:manage` | check again; 404 without a key |
//! | `DELETE /keys/:provider` | `ai:manage` | 204; 404 without a key |
//! | `GET /usage` | `ai:manage` | credits and tokens, this and last month |
//!
//! A key is never in a response, an event, a log line or an error message:
//! the status carries its hint (`sk-…a1b2`) only.
//!
//! Rules (`apply`): only the opt-in providers can be switched, and only with
//! a key source the install offers; enabling one outside the EU needs
//! `acknowledgedOutsideEu`; the default provider must be enabled; overrides
//! are checked with `policy::allows` (so a fixed feature, or a disabled
//! provider, is refused); disabling a provider keeps its own key. Enabling
//! with `own` keys before a key is stored is accepted: the provider is not
//! routed to (`available: false`) until a working key is saved. Enabling a
//! provider outside the EU emails the workspace owners.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use http::header::CONTENT_TYPE;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_ai::policy::{self, offered_key_sources};
use weldsuite_ai::settings::{self, FeatureOverride, ProviderSetting, UsageReport};
use weldsuite_ai::{
    Ai, AiConfig, AiError, Feature, KeySource, ProviderId, Region, WorkspaceAiSettings, catalog,
};
use weldsuite_catalogs::entity_events::{
    AI_PROVIDER_KEY_REMOVED, AI_PROVIDER_KEY_SET, AI_SETTINGS_UPDATED,
};
use weldsuite_emails::ai::{ProviderEnabled, provider_enabled};
use weldsuite_emails::{EmailBrand, EmailLocale, SystemEmail, send_system_email};
use weldsuite_kit::validation::json_body;
use weldsuite_kit::{ApiError, Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, answer, now};

/// The permission that opens every write, the key status and the usage.
const MANAGE: &str = "ai:manage";

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    let manage = || gate.require([MANAGE]);
    Router::new()
        .route("/", get(read).route_layer(gate.resolve()))
        .route("/", put(update).route_layer(manage()))
        .route("/usage", get(usage).route_layer(manage()))
        .route("/keys/{provider}", put(set_key).route_layer(manage()))
        .route("/keys/{provider}", delete(remove_key).route_layer(manage()))
        .route(
            "/keys/{provider}/test",
            post(test_key).route_layer(manage()),
        )
}

// ── helpers ─────────────────────────────────────────────────────────────────

/// The install's AI service; 503 `ai_unavailable` when there is none.
fn ai(state: &CorePlatformState) -> PlatformResult<&Ai> {
    state
        .ai
        .as_ref()
        .filter(|ai| ai.enabled())
        .ok_or_else(|| AiError::Unavailable.into_api_error().into())
}

/// An [`AiError`] as the route answers it. A database failure is logged by
/// `into_api_error`; nothing here carries a key.
fn ai_error(error: AiError) -> PlatformError {
    error.into_api_error().into()
}

/// A provider path segment: only the opt-in providers have keys of their own.
fn key_provider(config: &AiConfig, raw: &str) -> PlatformResult<ProviderId> {
    let provider = ProviderId::parse(raw)
        .filter(|p| p.opt_in())
        .ok_or_else(|| ApiError::not_found("AI provider", Some(raw)))?;
    if !offered_key_sources(config, provider).contains(&KeySource::Own) {
        return Err(ApiError::bad_request(format!(
            "This installation does not allow your own {} key",
            catalog::provider(provider).label
        ))
        .into());
    }
    Ok(provider)
}

/// The settings page's view of the workspace: the effective policy, the key
/// status of every provider with a stored key (only for `ai:manage`), and
/// `canManage`.
fn view(config: &AiConfig, settings: &WorkspaceAiSettings, can_manage: bool) -> Value {
    let policy = policy::effective(config, settings);
    let providers: Vec<Value> = policy
        .providers
        .into_iter()
        .map(|mut provider| {
            if can_manage
                && let Some(id) = provider["id"].as_str().and_then(ProviderId::parse)
                && let Some(key) = settings.own_keys.get(&id)
                && let Value::Object(map) = &mut provider
            {
                map.insert(
                    "key".to_owned(),
                    serde_json::to_value(key).unwrap_or(Value::Null),
                );
            }
            provider
        })
        .collect();
    json!({
        "installProvider": policy.install_provider,
        "defaultProvider": policy.default_provider,
        "providers": providers,
        "features": policy.features,
        "canManage": can_manage,
    })
}

async fn current_view(
    state: &CorePlatformState,
    caller: &Caller,
    fresh: bool,
) -> PlatformResult<Value> {
    let ai = ai(state)?;
    let settings = if fresh {
        settings::read(&caller.db).await
    } else {
        ai.settings(&caller.db, &caller.workspace_id).await
    }
    .map_err(ai_error)?;
    Ok(view(ai.config(), &settings, caller.can(MANAGE)))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn read(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    answer(
        async {
            let view = current_view(&state, &caller, false).await?;
            Ok(Data(view).into_response())
        }
        .await,
    )
}

// ── PUT / ───────────────────────────────────────────────────────────────────

/// `updateAiSettingsSchema`, parsed.
#[derive(Debug, Default)]
struct UpdateInput {
    providers: Vec<(ProviderId, bool, KeySource)>,
    /// `None`: untouched; `Some(None)`: back to the install default.
    #[allow(
        clippy::option_option,
        reason = "absent, null and a value are three different requests"
    )]
    default_provider: Option<Option<ProviderId>>,
    /// `None` entry: remove the override.
    feature_overrides: Vec<(Feature, Option<FeatureOverride>)>,
    acknowledged_outside_eu: bool,
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::bad_request(message)
}

fn key_source(value: &Value, what: &str) -> Result<KeySource, ApiError> {
    value
        .as_str()
        .and_then(KeySource::parse)
        .ok_or_else(|| invalid(format!("{what}: expected \"weldsuite\" or \"own\"")))
}

fn provider_id(value: &Value, what: &str) -> Result<ProviderId, ApiError> {
    value
        .as_str()
        .and_then(ProviderId::parse)
        .ok_or_else(|| invalid(format!("{what}: unknown AI provider")))
}

/// Reads the body as `updateAiSettingsSchema` does.
fn parse_update(body: &Value) -> Result<UpdateInput, ApiError> {
    let Some(fields) = body.as_object() else {
        return Err(invalid("Expected an object"));
    };
    let mut input = UpdateInput::default();
    match fields.get("providers") {
        None | Some(Value::Null) => {}
        Some(Value::Object(providers)) => {
            for (name, entry) in providers {
                let provider = ProviderId::parse(name)
                    .filter(|p| p.opt_in())
                    .ok_or_else(|| {
                        invalid(format!(
                            "providers.{name}: only Anthropic and OpenAI can be switched"
                        ))
                    })?;
                let entry = entry
                    .as_object()
                    .ok_or_else(|| invalid(format!("providers.{name}: expected an object")))?;
                let enabled = entry
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                        invalid(format!("providers.{name}.enabled: expected a boolean"))
                    })?;
                let source = key_source(
                    entry.get("keySource").unwrap_or(&Value::Null),
                    &format!("providers.{name}.keySource"),
                )?;
                input.providers.push((provider, enabled, source));
            }
        }
        Some(_) => return Err(invalid("providers: expected an object")),
    }
    match fields.get("defaultProvider") {
        None => {}
        Some(Value::Null) => input.default_provider = Some(None),
        Some(value) => input.default_provider = Some(Some(provider_id(value, "defaultProvider")?)),
    }
    match fields.get("featureOverrides") {
        None | Some(Value::Null) => {}
        Some(Value::Object(overrides)) => {
            for (name, entry) in overrides {
                let feature = Feature::parse(name)
                    .ok_or_else(|| invalid(format!("featureOverrides.{name}: unknown feature")))?;
                if entry.is_null() {
                    input.feature_overrides.push((feature, None));
                    continue;
                }
                let entry = entry.as_object().ok_or_else(|| {
                    invalid(format!(
                        "featureOverrides.{name}: expected an object or null"
                    ))
                })?;
                let provider = provider_id(
                    entry.get("provider").unwrap_or(&Value::Null),
                    &format!("featureOverrides.{name}.provider"),
                )?;
                let model = match entry.get("model") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(model)) if !model.trim().is_empty() => {
                        Some(model.trim().to_owned())
                    }
                    Some(_) => {
                        return Err(invalid(format!(
                            "featureOverrides.{name}.model: expected a model id"
                        )));
                    }
                };
                input
                    .feature_overrides
                    .push((feature, Some(FeatureOverride { provider, model })));
            }
        }
        Some(_) => return Err(invalid("featureOverrides: expected an object")),
    }
    match fields.get("acknowledgedOutsideEu") {
        None | Some(Value::Null) => {}
        Some(Value::Bool(ack)) => input.acknowledged_outside_eu = *ack,
        Some(_) => return Err(invalid("acknowledgedOutsideEu: expected a boolean")),
    }
    Ok(input)
}

/// What an update changed that the route acts on.
#[derive(Debug)]
struct Applied {
    settings: WorkspaceAiSettings,
    /// Providers that went from disabled to enabled, outside the EU or not.
    newly_enabled: Vec<(ProviderId, KeySource)>,
}

/// Whether `provider` may be routed to under `settings` as far as the
/// workspace's own choices go (the install provider, or an enabled opt-in).
fn is_enabled(config: &AiConfig, settings: &WorkspaceAiSettings, provider: ProviderId) -> bool {
    config.default_provider == Some(provider)
        || settings.providers.get(&provider).is_some_and(|s| s.enabled)
}

/// The rules of `PUT /api/ai-settings` over the stored settings: the new
/// settings, or the refusal. Pure: the route saves what it returns.
fn apply(
    config: &AiConfig,
    current: &WorkspaceAiSettings,
    input: &UpdateInput,
    user_id: &str,
    now: &str,
) -> Result<Applied, ApiError> {
    let mut next = current.clone();
    let mut newly_enabled = Vec::new();

    for &(provider, enabled, source) in &input.providers {
        let label = catalog::provider(provider).label.as_str();
        let offered = offered_key_sources(config, provider);
        if offered.is_empty() {
            return Err(invalid(format!(
                "{label} is not offered on this installation"
            )));
        }
        if !offered.contains(&source) {
            return Err(invalid(format!(
                "This installation does not offer {label} with {} keys",
                match source {
                    KeySource::Weldsuite => "WeldSuite's",
                    KeySource::Own => "your own",
                }
            )));
        }
        let was_enabled = current.providers.get(&provider).is_some_and(|s| s.enabled);
        if enabled && !was_enabled {
            if config.region(provider) == Region::OutsideEu && !input.acknowledged_outside_eu {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "OUTSIDE_EU_NOT_ACKNOWLEDGED",
                    format!("{label} runs outside the EU: confirm it with acknowledgedOutsideEu"),
                ));
            }
            newly_enabled.push((provider, source));
        }
        let previous = current.providers.get(&provider);
        next.providers.insert(
            provider,
            ProviderSetting {
                enabled,
                key_source: source,
                enabled_by: match (enabled, was_enabled) {
                    (true, true) => previous.and_then(|s| s.enabled_by.clone()),
                    (true, false) => Some(user_id.to_owned()),
                    (false, _) => None,
                },
                enabled_at: match (enabled, was_enabled) {
                    (true, true) => previous.and_then(|s| s.enabled_at.clone()),
                    (true, false) => Some(now.to_owned()),
                    (false, _) => None,
                },
            },
        );
    }

    match input.default_provider {
        Some(None) => next.default_provider = None,
        Some(Some(provider)) => {
            if !is_enabled(config, &next, provider) {
                return Err(invalid(format!(
                    "{} is not enabled for this workspace",
                    catalog::provider(provider).label
                )));
            }
            next.default_provider = Some(provider);
        }
        None => {}
    }
    // A default that has just been switched off goes back to the install's.
    if let Some(default) = next.default_provider
        && !is_enabled(config, &next, default)
    {
        next.default_provider = None;
    }

    for (feature, entry) in &input.feature_overrides {
        let Some(entry) = entry else {
            next.feature_overrides.remove(feature);
            continue;
        };
        if !feature.overridable() {
            return Err(invalid(format!(
                "{} is fixed by WeldSuite and cannot be overridden",
                feature.as_str()
            )));
        }
        if !is_enabled(config, &next, entry.provider) {
            return Err(invalid(format!(
                "{} is not enabled for this workspace",
                catalog::provider(entry.provider).label
            )));
        }
        if let Some(model) = &entry.model {
            let own_model = model.starts_with(&format!("{}/", entry.provider.as_str()));
            if !own_model || !policy::allows(config, &next, *feature, model) {
                return Err(invalid(format!(
                    "{model} cannot serve {} with {}",
                    feature.as_str(),
                    catalog::provider(entry.provider).label
                )));
            }
        }
        next.feature_overrides.insert(*feature, entry.clone());
    }

    Ok(Applied {
        settings: next,
        newly_enabled,
    })
}

/// The `ai_settings:updated` payload: what is enabled and on whose key, the
/// default, and which features are overridden. Never a key.
fn updated_event(settings: &WorkspaceAiSettings) -> Value {
    let providers: Map<String, Value> = settings
        .providers
        .iter()
        .map(|(provider, setting)| {
            (
                provider.as_str().to_owned(),
                json!({ "enabled": setting.enabled, "keySource": setting.key_source }),
            )
        })
        .collect();
    json!({
        "providers": providers,
        "defaultProvider": settings.default_provider,
        "overriddenFeatures": settings
            .feature_overrides
            .keys()
            .map(|f| f.as_str())
            .collect::<Vec<_>>(),
    })
}

async fn update(
    State(state): State<CorePlatformState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let ai = ai(&state)?;
            let content_type = headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok());
            let body = json_body(content_type, &body)
                .map_err(|bad| PlatformError::Response(Box::new(bad.into_response())))?;
            let input = parse_update(&body)?;
            let current = settings::read(&caller.db).await.map_err(ai_error)?;
            let applied = apply(ai.config(), &current, &input, &caller.user_id, &now())?;
            ai.save_settings(
                &caller.db,
                &caller.workspace_id,
                &applied.settings,
                Some(&caller.user_id),
            )
            .await
            .map_err(ai_error)?;
            caller.publish(
                &state,
                AI_SETTINGS_UPDATED,
                &caller.workspace_id,
                &updated_event(&applied.settings),
            );
            let outside_eu: Vec<(ProviderId, KeySource)> = applied
                .newly_enabled
                .iter()
                .copied()
                .filter(|(provider, _)| ai.config().region(*provider) == Region::OutsideEu)
                .collect();
            if !outside_eu.is_empty() {
                notify_owners(&state, &caller, &outside_eu).await;
            }
            let view = view(ai.config(), &applied.settings_with_keys(&current), true);
            Ok(Data(view).into_response())
        }
        .await,
    )
}

impl Applied {
    /// The new settings with the stored keys' status carried over (the save
    /// does not touch them), for the answer.
    fn settings_with_keys(&self, current: &WorkspaceAiSettings) -> WorkspaceAiSettings {
        let mut settings = self.settings.clone();
        settings.own_keys.clone_from(&current.own_keys);
        settings
    }
}

// ── the owners' email ───────────────────────────────────────────────────────

/// Emails every workspace owner that a provider outside the EU was enabled
/// and by whom (`ai.provider-enabled`). A failure is logged, never raised.
async fn notify_owners(
    state: &CorePlatformState,
    caller: &Caller,
    enabled: &[(ProviderId, KeySource)],
) {
    let Some(transport) = state.mail.as_deref() else {
        tracing::warn!("ai-settings: no system mail configured; the owners were not told");
        return;
    };
    let owners: Vec<(Option<String>, Option<String>)> = match sqlx::query_as(
        "select email, name from workspace_members
         where role = 'OWNER' and status = 'ACTIVE' and deleted_at is null
           and email is not null and email <> ''
         order by created_at asc",
    )
    .fetch_all(&caller.db)
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "ai-settings: could not read the workspace owners");
            return;
        }
    };
    let actor: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select name, email from workspace_members where user_id = $1 limit 1")
            .bind(&caller.user_id)
            .fetch_optional(&caller.db)
            .await
            .unwrap_or(None);
    let enabled_by = actor
        .and_then(|(name, email)| {
            name.filter(|n| !n.trim().is_empty())
                .or_else(|| email.filter(|e| !e.trim().is_empty()))
        })
        .unwrap_or_else(|| caller.user_id.clone());
    let workspace_name: Option<String> =
        sqlx::query_scalar("select name from workspaces where id = $1")
            .bind(&caller.workspace_id)
            .fetch_optional(&caller.master(state))
            .await
            .unwrap_or(None);
    let workspace_name = workspace_name.unwrap_or_else(|| caller.workspace_id.clone());
    let base = caller
        .env_value("PUBLIC_APP_URL")
        .or_else(|| caller.env_value("PUBLIC_URL"))
        .unwrap_or_default();
    let base = base.trim_end_matches('/');
    let settings_url = match caller.clerk_org_id.as_deref().filter(|org| !org.is_empty()) {
        Some(org) => format!("{base}/w/{org}/settings/ai"),
        None => format!("{base}/settings/ai"),
    };
    let brand = EmailBrand::weldsuite("WeldSuite");
    let mut sent_to: Vec<String> = Vec::new();
    for (provider, source) in enabled {
        for (email, name) in &owners {
            let Some(email) = email.as_deref().map(str::trim).filter(|e| !e.is_empty()) else {
                continue;
            };
            // One mail per owner and provider, even for a duplicated member.
            let tag = format!("{email}|{}", provider.as_str());
            if sent_to.contains(&tag) {
                continue;
            }
            sent_to.push(tag);
            let props = ProviderEnabled {
                recipient_name: name.clone(),
                workspace_name: workspace_name.clone(),
                provider_name: email_provider_name(*provider),
                enabled_by: enabled_by.clone(),
                own_key: *source == KeySource::Own,
                settings_url: settings_url.clone(),
            };
            let result = match provider_enabled(EmailLocale::En, &brand, &props) {
                Ok(rendered) => {
                    send_system_email(transport, SystemEmail::to(rendered, brand.clone(), email))
                        .await
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                }
                Err(error) => Err(error.to_string()),
            };
            if let Err(error) = result {
                tracing::error!(
                    error,
                    provider = provider.as_str(),
                    "ai-settings: the owners' email failed"
                );
            }
        }
    }
}

// ── keys ────────────────────────────────────────────────────────────────────

/// `{ hint, status, lastError, lastCheckedAt }`: the key's state, never the key.
/// The provider as the owners' email names it: the product and the company
/// the workspace's data now goes to ("Claude (Anthropic)").
fn email_provider_name(provider: ProviderId) -> String {
    let label = &catalog::provider(provider).label;
    match provider {
        ProviderId::Anthropic => format!("{label} (Anthropic)"),
        ProviderId::OpenAi => format!("{label} (OpenAI)"),
        ProviderId::Mistral | ProviderId::Compat => label.clone(),
    }
}

fn key_status(status: &weldsuite_ai::OwnKeyStatus) -> Value {
    serde_json::to_value(status).unwrap_or(Value::Null)
}

async fn set_key(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(provider): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let ai = ai(&state)?;
            let provider = key_provider(ai.config(), &provider)?;
            let content_type = headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok());
            let body = json_body(content_type, &body)
                .map_err(|bad| PlatformError::Response(Box::new(bad.into_response())))?;
            let api_key = body
                .get("apiKey")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|k| (8..=512).contains(&k.chars().count()))
                .ok_or_else(|| invalid("apiKey: expected 8 to 512 characters"))?;
            let status = ai
                .put_key(
                    &caller.db,
                    &caller.workspace_id,
                    provider,
                    api_key,
                    Some(&caller.user_id),
                )
                .await
                .map_err(key_error)?;
            caller.publish(
                &state,
                AI_PROVIDER_KEY_SET,
                provider.as_str(),
                &json!({ "provider": provider, "hint": status.hint }),
            );
            Ok(Data(key_status(&status)).into_response())
        }
        .await,
    )
}

/// A key the provider refuses is the caller's to fix: 422 with a fixed
/// message (the provider's own text is not echoed). Other failures answer as
/// any AI error.
fn key_error(error: AiError) -> PlatformError {
    match error {
        AiError::Provider {
            provider,
            status: Some(400..=404),
            ..
        } => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "AI_KEY_REJECTED",
            format!(
                "{} did not accept this API key. Check that it is complete and still active.",
                catalog::provider(provider).label
            ),
        )
        .into(),
        other => ai_error(other),
    }
}

async fn test_key(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(provider): Path<String>,
) -> Response {
    answer(
        async {
            let ai = ai(&state)?;
            let provider = key_provider(ai.config(), &provider)?;
            let status = ai
                .test_key(&caller.db, &caller.workspace_id, provider)
                .await
                .map_err(ai_error)?
                .ok_or_else(|| ApiError::not_found("AI provider key", Some(provider.as_str())))?;
            Ok(Data(key_status(&status)).into_response())
        }
        .await,
    )
}

async fn remove_key(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(provider): Path<String>,
) -> Response {
    answer(
        async {
            let ai = ai(&state)?;
            let provider = key_provider(ai.config(), &provider)?;
            let deleted = ai
                .delete_key(&caller.db, &caller.workspace_id, provider)
                .await
                .map_err(ai_error)?;
            if !deleted {
                return Err(ApiError::not_found("AI provider key", Some(provider.as_str())).into());
            }
            caller.publish(
                &state,
                AI_PROVIDER_KEY_REMOVED,
                provider.as_str(),
                &json!({ "provider": provider }),
            );
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── usage ───────────────────────────────────────────────────────────────────

/// `YYYY-MM` of the month before `(year, month)`.
fn previous_month(year: i32, month: u8) -> (i32, u8) {
    if month == 1 {
        (year - 1, 12)
    } else {
        (year, month - 1)
    }
}

fn month_report(label: &str, rows: &[settings::UsageRow]) -> Value {
    // Only providers the platform knows; an older ledger row of another kind
    // of model is not an AI provider's.
    let mut by_provider: BTreeMap<(ProviderId, &'static str), [i64; 3]> = BTreeMap::new();
    let mut by_feature: BTreeMap<String, i64> = BTreeMap::new();
    for row in rows {
        if let Some(provider) = ProviderId::parse(&row.provider) {
            let source = KeySource::parse(&row.key_source).unwrap_or_default();
            let entry = by_provider.entry((provider, source.as_str())).or_default();
            entry[0] += row.credits;
            entry[1] += row.input_tokens;
            entry[2] += row.output_tokens;
        }
        let feature = row.feature.clone().unwrap_or_else(|| "other".to_owned());
        *by_feature.entry(feature).or_default() += row.credits;
    }
    json!({
        "month": label,
        "byProvider": by_provider
            .into_iter()
            .map(|((provider, source), [credits, input, output])| json!({
                "provider": provider,
                "credits": credits,
                "inputTokens": input,
                "outputTokens": output,
                "keySource": source,
            }))
            .collect::<Vec<_>>(),
        "byFeature": by_feature
            .into_iter()
            .map(|(feature, credits)| json!({ "feature": feature, "credits": credits }))
            .collect::<Vec<_>>(),
    })
}

/// The platform's `aiUsageSchema`: the current month first, then the last.
fn usage_view(report: &UsageReport, now: OffsetDateTime) -> Value {
    let (year, month) = (now.year(), u8::from(now.month()));
    let (last_year, last_month) = previous_month(year, month);
    json!({
        "months": [
            month_report(&format!("{year:04}-{month:02}"), &report.this_month),
            month_report(&format!("{last_year:04}-{last_month:02}"), &report.last_month),
        ],
    })
}

async fn usage(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    answer(
        async {
            let ai = ai(&state)?;
            let report = ai
                .usage(&caller.master(&state), &caller.workspace_id)
                .await
                .map_err(ai_error)?;
            Ok(Data(usage_view(&report, OffsetDateTime::now_utc())).into_response())
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use weldsuite_ai::config::{Endpoint, KeySources};

    use super::*;

    fn endpoint(key: &str) -> Endpoint {
        Endpoint {
            base_url: "https://example.test/v1".to_owned(),
            api_key: Some(key.to_owned()),
        }
    }

    /// EU: Mistral, Anthropic with both key sources, `OpenAI` with own keys only.
    fn eu() -> AiConfig {
        AiConfig {
            default_provider: Some(ProviderId::Mistral),
            mistral: endpoint("mk"),
            anthropic: endpoint("ak"),
            opt_in: BTreeMap::from([
                (
                    ProviderId::Anthropic,
                    KeySources {
                        weldsuite: true,
                        own: true,
                    },
                ),
                (
                    ProviderId::OpenAi,
                    KeySources {
                        weldsuite: false,
                        own: true,
                    },
                ),
            ]),
            keys_encryption_key: Some([1; 32]),
            ..AiConfig::default()
        }
    }

    fn body(value: &Value) -> UpdateInput {
        parse_update(value).expect("parses")
    }

    fn run(current: &WorkspaceAiSettings, value: &Value) -> Result<Applied, ApiError> {
        apply(
            &eu(),
            current,
            &body(value),
            "user_1",
            "2026-11-13T10:00:00.000Z",
        )
    }

    #[test]
    fn enabling_outside_the_eu_needs_the_acknowledgement() {
        let enable =
            json!({ "providers": { "anthropic": { "enabled": true, "keySource": "weldsuite" } } });
        let refused = run(&WorkspaceAiSettings::default(), &enable).expect_err("refused");
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        assert_eq!(refused.code(), "OUTSIDE_EU_NOT_ACKNOWLEDGED");

        let acknowledged = json!({
            "providers": { "anthropic": { "enabled": true, "keySource": "weldsuite" } },
            "acknowledgedOutsideEu": true
        });
        let applied = run(&WorkspaceAiSettings::default(), &acknowledged).expect("accepted");
        let setting = &applied.settings.providers[&ProviderId::Anthropic];
        assert!(setting.enabled);
        assert_eq!(setting.enabled_by.as_deref(), Some("user_1"));
        assert_eq!(
            setting.enabled_at.as_deref(),
            Some("2026-11-13T10:00:00.000Z")
        );
        assert_eq!(
            applied.newly_enabled,
            vec![(ProviderId::Anthropic, KeySource::Weldsuite)]
        );

        // Already enabled: no new acknowledgement, no new notice, who and when stay.
        let again = apply(
            &eu(),
            &applied.settings,
            &body(
                &json!({ "providers": { "anthropic": { "enabled": true, "keySource": "own" } } }),
            ),
            "user_2",
            "2026-11-14T10:00:00.000Z",
        )
        .expect("accepted");
        assert_eq!(again.newly_enabled.len(), 0);
        let setting = &again.settings.providers[&ProviderId::Anthropic];
        assert_eq!(setting.key_source, KeySource::Own);
        assert_eq!(setting.enabled_by.as_deref(), Some("user_1"));
    }

    #[test]
    fn only_opt_in_providers_with_an_offered_key_source_can_be_switched() {
        for provider in ["mistral", "compat", "nope"] {
            let input =
                json!({ "providers": { provider: { "enabled": true, "keySource": "weldsuite" } } });
            assert!(parse_update(&input).is_err(), "{provider}");
        }
        // OpenAI is offered with own keys only on this install.
        let weldsuite_key = json!({
            "providers": { "openai": { "enabled": true, "keySource": "weldsuite" } },
            "acknowledgedOutsideEu": true
        });
        let refused = run(&WorkspaceAiSettings::default(), &weldsuite_key).expect_err("refused");
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        let own_key = json!({
            "providers": { "openai": { "enabled": true, "keySource": "own" } },
            "acknowledgedOutsideEu": true
        });
        // Accepted before a key is stored: it just isn't routed to yet.
        assert!(run(&WorkspaceAiSettings::default(), &own_key).is_ok());
    }

    #[test]
    fn disabling_keeps_the_key_and_resets_a_default_that_went_away() {
        let mut current = WorkspaceAiSettings::default();
        current.providers.insert(
            ProviderId::Anthropic,
            ProviderSetting {
                enabled: true,
                key_source: KeySource::Own,
                enabled_by: Some("user_0".to_owned()),
                enabled_at: Some("2026-01-01T00:00:00.000Z".to_owned()),
            },
        );
        current.default_provider = Some(ProviderId::Anthropic);
        current.own_keys.insert(
            ProviderId::Anthropic,
            weldsuite_ai::OwnKeyStatus {
                hint: "sk-…a1b2".to_owned(),
                status: "ok".to_owned(),
                last_error: None,
                last_checked_at: None,
            },
        );
        let applied = run(
            &current,
            &json!({ "providers": { "anthropic": { "enabled": false, "keySource": "own" } } }),
        )
        .expect("accepted");
        assert!(!applied.settings.providers[&ProviderId::Anthropic].enabled);
        assert_eq!(applied.settings.default_provider, None);
        // The key rides along in the answer, untouched by the save.
        let kept = applied.settings_with_keys(&current);
        assert!(kept.own_keys.contains_key(&ProviderId::Anthropic));
        assert_eq!(applied.newly_enabled.len(), 0);
    }

    #[test]
    fn the_default_provider_must_be_enabled() {
        let refused = run(
            &WorkspaceAiSettings::default(),
            &json!({ "defaultProvider": "anthropic" }),
        )
        .expect_err("refused");
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        let ok = run(
            &WorkspaceAiSettings::default(),
            &json!({
                "providers": { "anthropic": { "enabled": true, "keySource": "weldsuite" } },
                "defaultProvider": "anthropic",
                "acknowledgedOutsideEu": true
            }),
        )
        .expect("accepted");
        assert_eq!(ok.settings.default_provider, Some(ProviderId::Anthropic));
        let cleared = run(&ok.settings, &json!({ "defaultProvider": null })).expect("accepted");
        assert_eq!(cleared.settings.default_provider, None);
        // Absent leaves it alone.
        let kept = run(&ok.settings, &json!({})).expect("accepted");
        assert_eq!(kept.settings.default_provider, Some(ProviderId::Anthropic));
    }

    #[test]
    fn overrides_are_refused_for_fixed_features_and_disabled_providers() {
        let fixed = run(
            &WorkspaceAiSettings::default(),
            &json!({ "featureOverrides": { "search-index": { "provider": "mistral" } } }),
        )
        .expect_err("fixed");
        assert_eq!(fixed.status(), StatusCode::BAD_REQUEST);

        let disabled = run(
            &WorkspaceAiSettings::default(),
            &json!({ "featureOverrides": { "mail": { "provider": "anthropic" } } }),
        )
        .expect_err("disabled");
        assert_eq!(disabled.status(), StatusCode::BAD_REQUEST);

        let unknown_feature = parse_update(&json!({ "featureOverrides": { "nope": null } }));
        assert!(unknown_feature.is_err());

        // Enabled in the same request: allowed, with a model of that provider.
        let ok = run(
            &WorkspaceAiSettings::default(),
            &json!({
                "providers": { "anthropic": { "enabled": true, "keySource": "weldsuite" } },
                "featureOverrides": { "mail": { "provider": "anthropic", "model": "anthropic/claude-sonnet-5-5" } },
                "acknowledgedOutsideEu": true
            }),
        )
        .expect("accepted");
        assert_eq!(
            ok.settings.feature_overrides[&Feature::Mail]
                .model
                .as_deref(),
            Some("anthropic/claude-sonnet-5-5")
        );
        // A model of another provider than the one named is refused.
        let mismatch = run(
            &ok.settings,
            &json!({ "featureOverrides": { "mail": { "provider": "anthropic", "model": "mistral/mistral-large-4-0" } } }),
        )
        .expect_err("mismatch");
        assert_eq!(mismatch.status(), StatusCode::BAD_REQUEST);
        // Null removes the override.
        let removed = run(
            &ok.settings,
            &json!({ "featureOverrides": { "mail": null } }),
        )
        .expect("accepted");
        assert!(removed.settings.feature_overrides.is_empty());
    }

    #[test]
    fn the_view_shows_key_status_only_to_managers() {
        let mut settings = WorkspaceAiSettings::default();
        settings.own_keys.insert(
            ProviderId::Anthropic,
            weldsuite_ai::OwnKeyStatus {
                hint: "sk-…a1b2".to_owned(),
                status: "ok".to_owned(),
                last_error: None,
                last_checked_at: None,
            },
        );
        let manager = view(&eu(), &settings, true);
        let member = view(&eu(), &settings, false);
        let key_of = |view: &Value| {
            view["providers"]
                .as_array()
                .expect("providers")
                .iter()
                .find(|p| p["id"] == "anthropic")
                .expect("anthropic")
                .get("key")
                .cloned()
        };
        assert_eq!(key_of(&manager).expect("key")["hint"], "sk-…a1b2");
        assert_eq!(key_of(&member), None);
        assert_eq!(manager["canManage"], true);
        assert_eq!(member["canManage"], false);
        assert_eq!(member["installProvider"], "mistral");
        assert_eq!(member["defaultProvider"], "mistral");
        assert!(!member.to_string().contains("ciphertext"));
    }

    #[test]
    fn usage_is_grouped_per_provider_and_feature_for_two_months() {
        let row =
            |provider: &str, feature: Option<&str>, source: &str, credits| settings::UsageRow {
                provider: provider.to_owned(),
                feature: feature.map(str::to_owned),
                key_source: source.to_owned(),
                calls: 1,
                credits,
                input_tokens: 10,
                output_tokens: 5,
            };
        let report = UsageReport {
            this_month: vec![
                row("mistral", Some("mail"), "weldsuite", 3),
                row("mistral", Some("forms"), "weldsuite", 2),
                row("anthropic", Some("mail"), "own", 0),
                row("@cf", Some("mail"), "weldsuite", 1),
            ],
            last_month: vec![row("mistral", None, "weldsuite", 4)],
        };
        let now = OffsetDateTime::from_unix_timestamp(1_768_000_000).expect("time");
        let view = usage_view(&report, now);
        let months = view["months"].as_array().expect("months");
        assert_eq!(months.len(), 2);
        assert_eq!(
            months[0]["month"],
            format!("{:04}-{:02}", now.year(), u8::from(now.month()))
        );
        let mistral = months[0]["byProvider"]
            .as_array()
            .expect("providers")
            .iter()
            .find(|p| p["provider"] == "mistral")
            .expect("mistral");
        assert_eq!(mistral["credits"], 5);
        assert_eq!(mistral["inputTokens"], 20);
        assert_eq!(mistral["keySource"], "weldsuite");
        assert_eq!(months[0]["byProvider"].as_array().expect("p").len(), 2);
        let features = months[0]["byFeature"].as_array().expect("features");
        let mail = features
            .iter()
            .find(|f| f["feature"] == "mail")
            .expect("mail");
        assert_eq!(mail["credits"], 4);
        assert_eq!(months[1]["byFeature"][0]["feature"], "other");
        assert_eq!(previous_month(2026, 1), (2025, 12));
        assert_eq!(previous_month(2026, 7), (2026, 6));
    }
}
