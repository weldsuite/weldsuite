//! The workspace policy resolver (`weldsuite-documentation/plans/eu-ai-mistral.md`, "Workspace
//! policy"). Pure: settings and configuration in, a [`Route`] out.
//!
//! For a call from a feature at a task and tier:
//!
//! 1. An explicit model (request or stored), used only if its provider is
//!    enabled and it has the feature's capabilities. Otherwise a request is
//!    [`AiError::ModelNotAllowed`] and a stored choice is skipped with a log
//!    line.
//! 2. The feature's override: its provider and model, or the provider's task
//!    map.
//! 3. The workspace default provider's task map.
//! 4. The install default.
//!
//! Whatever the settings say: a provider that isn't enabled (or offered by the
//! install, or whose key source isn't configured, or whose own key is marked
//! failing) is never routed to; fixed features ([`Feature::overridable`]) and
//! the install-only tasks (embeddings, transcription) stay on the install
//! provider; and the fallback chain goes from a non-EU provider to the
//! install provider's model for the same task and tier, then to the install's
//! EU `AI_FALLBACK_MODEL`, never from an EU target to a non-EU one.

use serde::Serialize;
use serde_json::{Value, json};

use crate::catalog::{self, Capability, Feature, KeySource, ProviderId, Region, Task, Tier};
use crate::config::{AiConfig, Endpoint};
use crate::error::AiError;
use crate::settings::WorkspaceAiSettings;
use crate::{AiCall, RequestedModel};

/// One step of a route: a provider, a canonical model and whose key pays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub provider: ProviderId,
    pub model: String,
    pub region: Region,
    pub key_source: KeySource,
}

impl Target {
    /// The id the provider knows the model by.
    pub fn native_model(&self) -> &str {
        catalog::native_model_id(&self.model)
    }
}

/// Where a call goes, and where it falls back to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub primary: Target,
    /// Tried in order on a provider refusal; never a non-EU target after an
    /// EU one.
    pub fallbacks: Vec<Target>,
}

impl Route {
    /// The primary target, then the fallbacks.
    pub fn targets(&self) -> impl Iterator<Item = &Target> {
        std::iter::once(&self.primary).chain(self.fallbacks.iter())
    }
}

/// WeldSuite's endpoint for `provider` on this install.
pub(crate) fn endpoint(config: &AiConfig, provider: ProviderId) -> Option<&Endpoint> {
    match provider {
        ProviderId::Mistral => Some(&config.mistral),
        ProviderId::Anthropic => Some(&config.anthropic),
        ProviderId::OpenAi => Some(&config.openai),
        ProviderId::Compat => config.compat.as_ref().map(|c| &c.endpoint),
    }
}

fn has_weldsuite_key(config: &AiConfig, provider: ProviderId) -> bool {
    endpoint(config, provider)
        .and_then(|e| e.api_key.as_deref())
        .is_some_and(|k| !k.trim().is_empty())
}

/// Whether, and on whose key, a workspace may call `provider`: the install
/// provider always (on WeldSuite's key); an opt-in provider only when the
/// install offers it, the workspace enabled it, and its key source is
/// configured (WeldSuite's key present, or an own key stored, not failing,
/// with `AI_KEYS_ENCRYPTION_KEY` set). `None`: never route to it.
pub fn provider_key_source(
    config: &AiConfig,
    settings: &WorkspaceAiSettings,
    provider: ProviderId,
) -> Option<KeySource> {
    let install = config.default_provider?;
    if provider == install {
        return Some(KeySource::Weldsuite);
    }
    if !provider.opt_in() {
        return None;
    }
    let offered = config.opt_in.get(&provider).copied().unwrap_or_default();
    let setting = settings.providers.get(&provider).filter(|s| s.enabled)?;
    let source = setting.key_source;
    if !offered.allows(source) {
        return None;
    }
    let configured = match source {
        KeySource::Weldsuite => has_weldsuite_key(config, provider),
        KeySource::Own => {
            config.keys_encryption_key.is_some()
                && settings
                    .own_keys
                    .get(&provider)
                    .is_some_and(|key| !key.failing())
        }
    };
    configured.then_some(source)
}

/// The key sources the install offers for `provider` (`/config.json` and the
/// settings page): WeldSuite's only when its key is configured.
pub fn offered_key_sources(config: &AiConfig, provider: ProviderId) -> Vec<KeySource> {
    if config.default_provider == Some(provider) {
        return vec![KeySource::Weldsuite];
    }
    if !provider.opt_in() {
        return Vec::new();
    }
    let offered = config.opt_in.get(&provider).copied().unwrap_or_default();
    let mut sources = Vec::new();
    if offered.weldsuite && has_weldsuite_key(config, provider) {
        sources.push(KeySource::Weldsuite);
    }
    if offered.own {
        sources.push(KeySource::Own);
    }
    sources
}

/// The capabilities of `model` (canonical) on `provider`: the catalog's, or
/// for `compat` the install's own chat model or embeddings model. `None`: a
/// model the provider doesn't serve here.
fn capabilities(config: &AiConfig, provider: ProviderId, model: &str) -> Option<Vec<Capability>> {
    if provider == ProviderId::Compat {
        let compat = config.compat.as_ref()?;
        let native = catalog::native_model_id(model);
        if native == compat.model {
            return Some(catalog::compat_capabilities().to_vec());
        }
        if compat.embed_model.as_deref() == Some(native) {
            return Some(vec![Capability::Embed]);
        }
        return None;
    }
    catalog::model(model)
        .filter(|m| m.provider == provider)
        .map(|m| m.capabilities.clone())
}

fn capable(config: &AiConfig, provider: ProviderId, model: &str, needs: &[Capability]) -> bool {
    capabilities(config, provider, model).is_some_and(|caps| needs.iter().all(|n| caps.contains(n)))
}

/// The canonical model `provider` serves `task` with at `tier` on this
/// install: the catalog's task map, or the `compat` endpoint's configured
/// models (chat tasks and embeddings).
pub fn task_model(
    config: &AiConfig,
    provider: ProviderId,
    task: Task,
    tier: Tier,
) -> Option<String> {
    if provider == ProviderId::Compat {
        let compat = config.compat.as_ref()?;
        return match task {
            Task::Embed => compat.embed_model.as_ref().map(|m| format!("compat/{m}")),
            task if task.is_chat() => Some(format!("compat/{}", compat.model)),
            _ => None,
        };
    }
    catalog::task_model(provider, task, tier).map(str::to_owned)
}

/// An explicit id as `(provider, canonical id)`: a prefixed id, a catalog
/// model by the id its provider knows it by, or the `compat` endpoint's own
/// model.
fn parse_model(config: &AiConfig, raw: &str) -> Option<(ProviderId, String)> {
    let raw = raw.trim();
    if let Some((provider, native)) = catalog::split_model_id(raw) {
        return Some((provider, format!("{}/{native}", provider.as_str())));
    }
    if let Some(model) = catalog::find_model(raw) {
        return Some((model.provider, model.id.clone()));
    }
    let compat = config.compat.as_ref()?;
    (raw == compat.model || compat.embed_model.as_deref() == Some(raw))
        .then(|| (ProviderId::Compat, format!("compat/{raw}")))
}

fn target(config: &AiConfig, provider: ProviderId, model: String, key_source: KeySource) -> Target {
    Target {
        provider,
        model,
        region: config.region(provider),
        key_source,
    }
}

/// Why an explicit model can't serve a call (for the log line).
fn explicit_target(
    config: &AiConfig,
    settings: &WorkspaceAiSettings,
    feature: Feature,
    task: Task,
    raw: &str,
) -> Result<Target, &'static str> {
    let install = config.default_provider.ok_or("AI is off")?;
    let (provider, model) = parse_model(config, raw).ok_or("unknown model")?;
    let key_source =
        provider_key_source(config, settings, provider).ok_or("provider not enabled")?;
    if (!feature.overridable() || task.install_only()) && provider != install {
        return Err("the feature stays on the install provider");
    }
    let Some(caps) = capabilities(config, provider, &model) else {
        return Err("unknown model");
    };
    if !catalog::needs(feature, task)
        .iter()
        .all(|n| caps.contains(n))
    {
        return Err("the model lacks a capability the feature needs");
    }
    Ok(target(config, provider, model, key_source))
}

/// The route for `call`.
pub fn resolve(
    config: &AiConfig,
    settings: &WorkspaceAiSettings,
    call: &AiCall,
) -> Result<Route, AiError> {
    let install = config.default_provider.ok_or(AiError::Unavailable)?;
    let needs = catalog::needs(call.feature, call.task);
    let primary = primary_target(config, settings, call, install, &needs)?;
    let fallbacks = fallbacks(config, call.task, call.tier, &needs, &primary);
    Ok(Route { primary, fallbacks })
}

fn primary_target(
    config: &AiConfig,
    settings: &WorkspaceAiSettings,
    call: &AiCall,
    install: ProviderId,
    needs: &[Capability],
) -> Result<Target, AiError> {
    // 1. An explicit model.
    if let Some(requested) = &call.model {
        let raw = match requested {
            RequestedModel::Request(model) | RequestedModel::Stored(model) => model,
        };
        match explicit_target(config, settings, call.feature, call.task, raw) {
            Ok(target) => return Ok(target),
            Err(reason) => {
                tracing::info!(
                    workspace = %call.workspace_id,
                    feature = call.feature.as_str(),
                    model = %raw,
                    reason,
                    "[weldsuite-ai] the policy doesn't allow this model"
                );
                if let RequestedModel::Request(model) = requested {
                    return Err(AiError::ModelNotAllowed {
                        model: model.clone(),
                    });
                }
            }
        }
    }

    if call.feature.overridable() && !call.task.install_only() {
        // 2. The feature's override.
        if let Some(entry) = settings.feature_overrides.get(&call.feature) {
            if let Some(key_source) = provider_key_source(config, settings, entry.provider) {
                let chosen = entry
                    .model
                    .as_deref()
                    .and_then(|raw| parse_model(config, raw))
                    .filter(|(provider, model)| {
                        *provider == entry.provider && capable(config, *provider, model, needs)
                    })
                    .map(|(_, model)| model);
                let model = chosen.or_else(|| {
                    task_model(config, entry.provider, call.task, call.tier)
                        .filter(|model| capable(config, entry.provider, model, needs))
                });
                if let Some(model) = model {
                    return Ok(target(config, entry.provider, model, key_source));
                }
            } else {
                tracing::info!(
                    workspace = %call.workspace_id,
                    feature = call.feature.as_str(),
                    provider = entry.provider.as_str(),
                    "[weldsuite-ai] the feature's override names a provider that isn't enabled; skipped"
                );
            }
        }
        // 3. The workspace default.
        if let Some(provider) = settings.default_provider.filter(|p| *p != install) {
            if let Some(key_source) = provider_key_source(config, settings, provider) {
                if let Some(model) = task_model(config, provider, call.task, call.tier)
                    .filter(|model| capable(config, provider, model, needs))
                {
                    return Ok(target(config, provider, model, key_source));
                }
            } else {
                tracing::info!(
                    workspace = %call.workspace_id,
                    provider = provider.as_str(),
                    "[weldsuite-ai] the workspace default provider isn't enabled; skipped"
                );
            }
        }
    }

    // 4. The install default.
    let model = task_model(config, install, call.task, call.tier).ok_or(AiError::Unavailable)?;
    Ok(target(config, install, model, KeySource::Weldsuite))
}

/// `AI_FALLBACK_MODEL` as a target: an id with a provider prefix, a catalog
/// model, or the `compat` endpoint's model.
fn fallback_model_target(config: &AiConfig) -> Option<Target> {
    let raw = config.fallback_model.as_deref()?.trim();
    if raw.is_empty() {
        return None;
    }
    let (provider, model) = parse_model(config, raw).or_else(|| {
        config
            .compat
            .as_ref()
            .map(|_| (ProviderId::Compat, format!("compat/{raw}")))
    })?;
    Some(target(config, provider, model, KeySource::Weldsuite))
}

/// Whether `next` may follow `previous` in a chain: never EU → non-EU.
fn may_follow(previous: &Target, next: &Target) -> bool {
    !(previous.region == Region::Eu && next.region == Region::OutsideEu)
}

fn fallbacks(
    config: &AiConfig,
    task: Task,
    tier: Tier,
    needs: &[Capability],
    primary: &Target,
) -> Vec<Target> {
    let mut chain: Vec<Target> = Vec::new();
    // Vectors of two models can't share an index: embeddings never fall back.
    if task == Task::Embed {
        return chain;
    }
    let Some(install) = config.default_provider else {
        return chain;
    };
    let mut last = primary.clone();
    // A provider other than the install's falls back to the install
    // provider's model for the same task and tier, on WeldSuite's account.
    if primary.provider != install
        && let Some(model) = task_model(config, install, task, tier)
        && model != primary.model
        && capable(config, install, &model, needs)
    {
        let next = target(config, install, model, KeySource::Weldsuite);
        if may_follow(&last, &next) {
            last = next.clone();
            chain.push(next);
        }
    }
    // Then the install's own fallback model, which must be in the EU.
    if let Some(next) = fallback_model_target(config)
        && next.region == Region::Eu
        && next.model != primary.model
        && !chain.iter().any(|t| t.model == next.model)
        && capable(config, next.provider, &next.model, needs)
        && may_follow(&last, &next)
    {
        chain.push(next);
    }
    chain
}

/// What `GET /api/ai-settings` answers: every provider with its region and
/// state, the default, the overrides, and the models each feature may use.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePolicy {
    pub install_provider: ProviderId,
    pub default_provider: ProviderId,
    /// `{ id, label, region, install, offered, enabled, available, keySource,
    /// keySources, enabledBy, enabledAt }` for the install provider and each
    /// opt-in provider the install offers (the platform's `aiProviderState`:
    /// `install` marks the install provider, `offered` is true for every
    /// provider listed, `available` says it can be routed to now, `keySource`
    /// is null for an opt-in provider never set up). No key status: the route
    /// adds it for admins.
    pub providers: Vec<Value>,
    /// `{ id, overridable, tasks, needs, override, effective: { provider,
    /// model, region }, models: [{ id, label, provider, region }] }` per
    /// feature (the platform's `aiFeatureState`): `effective` is where its
    /// main task goes now, `models` what its model picker may offer.
    pub features: Vec<Value>,
}

fn model_entry(config: &AiConfig, provider: ProviderId, id: &str, label: &str) -> Value {
    json!({
        "id": id,
        "label": label,
        "provider": provider.as_str(),
        "region": config.region(provider).as_str(),
    })
}

/// The models `feature` may use under `settings`: what its picker offers.
fn feature_models(
    config: &AiConfig,
    settings: &WorkspaceAiSettings,
    feature: Feature,
) -> Vec<Value> {
    let info = catalog::feature(feature);
    let Some(task) = info.tasks.first().copied() else {
        return Vec::new();
    };
    let mut models: Vec<Value> = catalog::models()
        .iter()
        .filter(|m| m.retires.is_none())
        .filter(|m| explicit_target(config, settings, feature, task, &m.id).is_ok())
        .map(|m| model_entry(config, m.provider, &m.id, &m.label))
        .collect();
    if let Some(compat) = &config.compat {
        for model in std::iter::once(&compat.model).chain(compat.embed_model.iter()) {
            let id = format!("compat/{model}");
            if explicit_target(config, settings, feature, task, &id).is_ok() {
                models.push(model_entry(config, ProviderId::Compat, &id, model));
            }
        }
    }
    models
}

/// The effective policy for the settings page and every model picker.
pub fn effective(config: &AiConfig, settings: &WorkspaceAiSettings) -> EffectivePolicy {
    let install = config.default_provider.unwrap_or(ProviderId::Mistral);
    let default_provider = settings
        .default_provider
        .filter(|p| provider_key_source(config, settings, *p).is_some())
        .unwrap_or(install);
    let providers = ProviderId::ALL
        .into_iter()
        .filter(|p| *p == install || (p.opt_in() && !offered_key_sources(config, *p).is_empty()))
        .map(|provider| {
            let setting = settings.providers.get(&provider);
            let is_install = provider == install;
            json!({
                "id": provider.as_str(),
                "label": catalog::provider(provider).label,
                "region": config.region(provider).as_str(),
                "install": is_install,
                "offered": true,
                "enabled": is_install || setting.is_some_and(|s| s.enabled),
                "available": provider_key_source(config, settings, provider).is_some(),
                "keySource": if is_install {
                    Some(KeySource::Weldsuite.as_str())
                } else {
                    setting.map(|s| s.key_source.as_str())
                },
                "keySources": offered_key_sources(config, provider)
                    .into_iter()
                    .map(KeySource::as_str)
                    .collect::<Vec<_>>(),
                "enabledBy": setting.and_then(|s| s.enabled_by.clone()),
                "enabledAt": setting.and_then(|s| s.enabled_at.clone()),
            })
        })
        .collect();
    let features = Feature::ALL
        .into_iter()
        .map(|feature| {
            let info = catalog::feature(feature);
            let task = info.tasks.first().copied().unwrap_or(Task::Draft);
            let route = resolve(
                config,
                settings,
                &AiCall::new("", feature, task, Tier::Quality),
            )
            .ok();
            let override_entry = feature
                .overridable()
                .then(|| settings.feature_overrides.get(&feature))
                .flatten()
                .map(|entry| json!({ "provider": entry.provider.as_str(), "model": entry.model }));
            json!({
                "id": feature.as_str(),
                "overridable": feature.overridable(),
                "tasks": info.tasks.iter().map(|t| t.as_str()).collect::<Vec<_>>(),
                "needs": info.needs.iter().map(|c| c.as_str()).collect::<Vec<_>>(),
                "override": override_entry,
                "effective": {
                    "provider": route
                        .as_ref()
                        .map_or(install, |r| r.primary.provider)
                        .as_str(),
                    "model": route.as_ref().map_or_else(String::new, |r| r.primary.model.clone()),
                    "region": route
                        .as_ref()
                        .map_or_else(|| config.region(install), |r| r.primary.region)
                        .as_str(),
                },
                "models": feature_models(config, settings, feature),
            })
        })
        .collect();
    EffectivePolicy {
        install_provider: install,
        default_provider,
        providers,
        features,
    }
}

/// Whether `model` may serve `feature` under `settings` (an enabled provider
/// and the feature's capabilities, for its main task): `PUT
/// /api/ai-settings` checks overrides with it.
pub fn allows(
    config: &AiConfig,
    settings: &WorkspaceAiSettings,
    feature: Feature,
    model: &str,
) -> bool {
    let Some(task) = catalog::feature(feature).tasks.first().copied() else {
        return false;
    };
    explicit_target(config, settings, feature, task, model).is_ok()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::config::{CompatEndpoint, KeySources};
    use crate::settings::{FeatureOverride, OwnKeyStatus, ProviderSetting};

    fn endpoint(url: &str, key: Option<&str>) -> Endpoint {
        Endpoint {
            base_url: url.to_owned(),
            api_key: key.map(str::to_owned),
        }
    }

    /// EU: Mistral, both opt-ins offered with both key sources.
    fn eu() -> AiConfig {
        AiConfig {
            default_provider: Some(ProviderId::Mistral),
            mistral: endpoint("https://api.mistral.ai/v1", Some("mk")),
            anthropic: endpoint("https://api.anthropic.com/v1", Some("ak")),
            openai: endpoint("https://api.openai.com/v1", Some("ok")),
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
                        weldsuite: true,
                        own: true,
                    },
                ),
            ]),
            keys_encryption_key: Some([1; 32]),
            ..AiConfig::default()
        }
    }

    fn enable(settings: &mut WorkspaceAiSettings, provider: ProviderId, key_source: KeySource) {
        settings.providers.insert(
            provider,
            ProviderSetting {
                enabled: true,
                key_source,
                enabled_by: Some("user_admin".to_owned()),
                enabled_at: None,
            },
        );
        if key_source == KeySource::Own {
            settings.own_keys.insert(
                provider,
                OwnKeyStatus {
                    hint: "sk-…a1b2".to_owned(),
                    status: "ok".to_owned(),
                    last_error: None,
                    last_checked_at: None,
                },
            );
        }
    }

    fn call(feature: Feature, task: Task, tier: Tier) -> AiCall {
        AiCall::new("ws_1", feature, task, tier)
    }

    fn route(config: &AiConfig, settings: &WorkspaceAiSettings, call: &AiCall) -> Route {
        resolve(config, settings, call).expect("route")
    }

    #[test]
    fn without_settings_everything_runs_on_the_install_provider() {
        let route = route(
            &eu(),
            &WorkspaceAiSettings::default(),
            &call(Feature::Mail, Task::Draft, Tier::Quality),
        );
        assert_eq!(route.primary.provider, ProviderId::Mistral);
        assert_eq!(route.primary.model, "mistral/mistral-large-4-0");
        assert_eq!(route.primary.region, Region::Eu);
        assert_eq!(route.primary.key_source, KeySource::Weldsuite);
        assert_eq!(route.fallbacks.len(), 0);
        let classify = resolve(
            &eu(),
            &WorkspaceAiSettings::default(),
            &call(Feature::Reach, Task::Classify, Tier::Free),
        )
        .expect("route");
        assert_eq!(classify.primary.model, "mistral/mistral-small-2603");
    }

    #[test]
    fn ai_off_is_unavailable() {
        let config = AiConfig::default();
        assert!(matches!(
            resolve(
                &config,
                &WorkspaceAiSettings::default(),
                &call(Feature::Mail, Task::Draft, Tier::Free)
            ),
            Err(AiError::Unavailable)
        ));
        // A task nobody serves (rerank) is unavailable too.
        assert!(matches!(
            resolve(
                &eu(),
                &WorkspaceAiSettings::default(),
                &call(Feature::Search, Task::Rerank, Tier::Free)
            ),
            Err(AiError::Unavailable)
        ));
    }

    #[test]
    fn the_workspace_default_routes_and_falls_back_to_the_install_provider() {
        let mut settings = WorkspaceAiSettings::default();
        enable(&mut settings, ProviderId::Anthropic, KeySource::Weldsuite);
        settings.default_provider = Some(ProviderId::Anthropic);
        let route = route(
            &eu(),
            &settings,
            &call(Feature::Mail, Task::Draft, Tier::Quality),
        );
        assert_eq!(route.primary.model, "anthropic/claude-opus-5-5");
        assert_eq!(route.primary.region, Region::OutsideEu);
        assert_eq!(route.fallbacks.len(), 1);
        assert_eq!(route.fallbacks[0].model, "mistral/mistral-large-4-0");
        assert_eq!(route.fallbacks[0].key_source, KeySource::Weldsuite);
    }

    #[test]
    fn a_default_provider_that_is_not_enabled_is_skipped() {
        let mut settings = WorkspaceAiSettings {
            default_provider: Some(ProviderId::OpenAi),
            ..WorkspaceAiSettings::default()
        };
        let route = route(
            &eu(),
            &settings,
            &call(Feature::Mail, Task::Draft, Tier::Free),
        );
        assert_eq!(route.primary.provider, ProviderId::Mistral);
        // Enabled but then disabled again: back on Mistral at once.
        enable(&mut settings, ProviderId::OpenAi, KeySource::Weldsuite);
        assert_eq!(
            resolve(
                &eu(),
                &settings,
                &call(Feature::Mail, Task::Draft, Tier::Free)
            )
            .expect("route")
            .primary
            .provider,
            ProviderId::OpenAi
        );
        settings
            .providers
            .get_mut(&ProviderId::OpenAi)
            .expect("openai")
            .enabled = false;
        assert_eq!(
            resolve(
                &eu(),
                &settings,
                &call(Feature::Mail, Task::Draft, Tier::Free)
            )
            .expect("route")
            .primary
            .provider,
            ProviderId::Mistral
        );
    }

    #[test]
    fn the_override_beats_the_default() {
        let mut settings = WorkspaceAiSettings::default();
        enable(&mut settings, ProviderId::Anthropic, KeySource::Weldsuite);
        enable(&mut settings, ProviderId::OpenAi, KeySource::Own);
        settings.default_provider = Some(ProviderId::OpenAi);
        settings.feature_overrides.insert(
            Feature::Mail,
            FeatureOverride {
                provider: ProviderId::Anthropic,
                model: Some("anthropic/claude-haiku-5-5".to_owned()),
            },
        );
        let mail = route(
            &eu(),
            &settings,
            &call(Feature::Mail, Task::Draft, Tier::Quality),
        );
        assert_eq!(mail.primary.model, "anthropic/claude-haiku-5-5");
        let forms = route(
            &eu(),
            &settings,
            &call(Feature::Forms, Task::Draft, Tier::Quality),
        );
        assert_eq!(forms.primary.model, "openai/gpt-5");
        assert_eq!(forms.primary.key_source, KeySource::Own);
        // An override without a model uses the provider's task map.
        settings.feature_overrides.insert(
            Feature::Mail,
            FeatureOverride {
                provider: ProviderId::Anthropic,
                model: None,
            },
        );
        let mail = route(
            &eu(),
            &settings,
            &call(Feature::Mail, Task::Classify, Tier::Free),
        );
        assert_eq!(mail.primary.model, "anthropic/claude-haiku-5-5");
        // A model of another provider in the override falls back to the
        // override provider's task map.
        settings.feature_overrides.insert(
            Feature::Mail,
            FeatureOverride {
                provider: ProviderId::Anthropic,
                model: Some("openai/gpt-5".to_owned()),
            },
        );
        let mail = route(
            &eu(),
            &settings,
            &call(Feature::Mail, Task::Draft, Tier::Free),
        );
        assert_eq!(mail.primary.model, "anthropic/claude-sonnet-5-5");
    }

    #[test]
    fn an_override_on_a_disabled_provider_goes_to_the_default_then_the_install() {
        let mut settings = WorkspaceAiSettings::default();
        settings.feature_overrides.insert(
            Feature::Mail,
            FeatureOverride {
                provider: ProviderId::Anthropic,
                model: Some("anthropic/claude-sonnet-5-5".to_owned()),
            },
        );
        let route = route(
            &eu(),
            &settings,
            &call(Feature::Mail, Task::Draft, Tier::Free),
        );
        assert_eq!(route.primary.provider, ProviderId::Mistral);
        enable(&mut settings, ProviderId::OpenAi, KeySource::Weldsuite);
        settings.default_provider = Some(ProviderId::OpenAi);
        let route = resolve(
            &eu(),
            &settings,
            &call(Feature::Mail, Task::Draft, Tier::Free),
        )
        .expect("route");
        assert_eq!(route.primary.provider, ProviderId::OpenAi);
    }

    #[test]
    fn a_requested_model_is_used_or_refused() {
        let mut settings = WorkspaceAiSettings::default();
        enable(&mut settings, ProviderId::Anthropic, KeySource::Weldsuite);
        let allowed = call(Feature::Mail, Task::Draft, Tier::Free)
            .requested_model(Some("anthropic/claude-sonnet-5-5"));
        assert_eq!(
            route(&eu(), &settings, &allowed).primary.model,
            "anthropic/claude-sonnet-5-5"
        );
        // The id the provider knows it by works too.
        let native =
            call(Feature::Mail, Task::Draft, Tier::Free).requested_model(Some("claude-sonnet-5-5"));
        assert_eq!(
            route(&eu(), &settings, &native).primary.model,
            "anthropic/claude-sonnet-5-5"
        );
        // A Mistral model is always allowed.
        let mistral = call(Feature::Mail, Task::Draft, Tier::Free)
            .requested_model(Some("mistral/mistral-small-2603"));
        assert_eq!(
            route(&eu(), &settings, &mistral).primary.model,
            "mistral/mistral-small-2603"
        );

        for refused in [
            "openai/gpt-5",                             // not enabled
            "@cf/meta/llama-3.3-70b-instruct-fp8-fast", // not a provider here
            "mistral/mistral-embed-2312",               // can't chat
            "mistral/mistral-tiny-made-up",             // not in the catalog
        ] {
            let request =
                call(Feature::Mail, Task::Draft, Tier::Free).requested_model(Some(refused));
            match resolve(&eu(), &settings, &request) {
                Err(AiError::ModelNotAllowed { model }) => assert_eq!(model, refused),
                other => panic!("{refused}: {other:?}"),
            }
        }
    }

    #[test]
    fn a_stored_model_that_is_refused_is_skipped() {
        let mut settings = WorkspaceAiSettings::default();
        enable(&mut settings, ProviderId::OpenAi, KeySource::Weldsuite);
        settings.default_provider = Some(ProviderId::OpenAi);
        let stored = call(Feature::Mail, Task::Draft, Tier::Free)
            .stored_model(Some("anthropic/claude-sonnet-5-5"));
        let route = route(&eu(), &settings, &stored);
        assert_eq!(route.primary.model, "openai/gpt-5");
        let stored_ok =
            call(Feature::Mail, Task::Draft, Tier::Free).stored_model(Some("openai/gpt-5-mini"));
        assert_eq!(
            resolve(&eu(), &settings, &stored_ok)
                .expect("route")
                .primary
                .model,
            "openai/gpt-5-mini"
        );
    }

    #[test]
    fn capability_checks_follow_the_feature() {
        let mut settings = WorkspaceAiSettings::default();
        enable(&mut settings, ProviderId::Anthropic, KeySource::Weldsuite);
        // books-ocr needs file input: Claude and Mistral OCR have it, the
        // embeddings model doesn't.
        assert!(allows(
            &eu(),
            &settings,
            Feature::BooksOcr,
            "anthropic/claude-sonnet-5-5"
        ));
        assert!(allows(
            &eu(),
            &settings,
            Feature::BooksOcr,
            "mistral/mistral-ocr-4-1"
        ));
        assert!(!allows(
            &eu(),
            &settings,
            Feature::BooksOcr,
            "mistral/mistral-embed-2312"
        ));
        // OCR on Anthropic: native file input, falling back to Mistral OCR.
        settings.feature_overrides.insert(
            Feature::BooksOcr,
            FeatureOverride {
                provider: ProviderId::Anthropic,
                model: None,
            },
        );
        let ocr = route(
            &eu(),
            &settings,
            &call(Feature::BooksOcr, Task::Ocr, Tier::Quality),
        );
        assert_eq!(ocr.primary.model, "anthropic/claude-sonnet-5-5");
        assert_eq!(ocr.fallbacks[0].model, "mistral/mistral-ocr-4-1");
        // The assistant needs tools: the OCR model can't serve it.
        assert!(!allows(
            &eu(),
            &settings,
            Feature::Assistant,
            "mistral/mistral-ocr-4-1"
        ));
        assert!(allows(
            &eu(),
            &settings,
            Feature::Assistant,
            "mistral/mistral-large-4-0"
        ));
        // A disabled provider is never allowed.
        assert!(!allows(&eu(), &settings, Feature::Mail, "openai/gpt-5"));
    }

    #[test]
    fn fixed_features_and_install_only_tasks_stay_on_the_install_provider() {
        let mut settings = WorkspaceAiSettings::default();
        enable(&mut settings, ProviderId::Anthropic, KeySource::Weldsuite);
        settings.default_provider = Some(ProviderId::Anthropic);
        for feature in [
            Feature::SearchIndex,
            Feature::ReachWarmup,
            Feature::MailReview,
        ] {
            let task = catalog::feature(feature).tasks[0];
            let route = route(&eu(), &settings, &call(feature, task, Tier::Free));
            assert_eq!(
                route.primary.provider,
                ProviderId::Mistral,
                "{}",
                feature.as_str()
            );
            assert!(!allows(
                &eu(),
                &settings,
                feature,
                "anthropic/claude-haiku-5-5"
            ));
        }
        // A client can't move them either.
        let request = call(Feature::MailReview, Task::Classify, Tier::Free)
            .requested_model(Some("anthropic/claude-haiku-5-5"));
        assert!(matches!(
            resolve(&eu(), &settings, &request),
            Err(AiError::ModelNotAllowed { .. })
        ));
        // Meet's summaries follow the default; its transcription stays on Voxtral.
        let summary = route(
            &eu(),
            &settings,
            &call(Feature::Meet, Task::Summarize, Tier::Quality),
        );
        assert_eq!(summary.primary.provider, ProviderId::Anthropic);
        let transcript = route(
            &eu(),
            &settings,
            &call(Feature::Meet, Task::Transcribe, Tier::Quality),
        );
        assert_eq!(
            transcript.primary.model,
            "mistral/voxtral-mini-transcribe-3-0"
        );
        // Embeddings never fall back to another model.
        let embed = route(
            &eu(),
            &settings,
            &call(Feature::SearchIndex, Task::Embed, Tier::Free),
        );
        assert_eq!(embed.primary.model, "mistral/mistral-embed-2312");
        assert_eq!(embed.fallbacks.len(), 0);
    }

    #[test]
    fn key_sources_must_be_configured() {
        let mut settings = WorkspaceAiSettings {
            default_provider: Some(ProviderId::Anthropic),
            ..WorkspaceAiSettings::default()
        };
        enable(&mut settings, ProviderId::Anthropic, KeySource::Weldsuite);
        // The install has no WeldSuite Anthropic key.
        let mut config = eu();
        config.anthropic.api_key = None;
        assert_eq!(
            route(
                &config,
                &settings,
                &call(Feature::Mail, Task::Draft, Tier::Free)
            )
            .primary
            .provider,
            ProviderId::Mistral
        );
        // The install offers only own keys.
        let mut config = eu();
        config.opt_in.insert(
            ProviderId::Anthropic,
            KeySources {
                weldsuite: false,
                own: true,
            },
        );
        assert_eq!(
            route(
                &config,
                &settings,
                &call(Feature::Mail, Task::Draft, Tier::Free)
            )
            .primary
            .provider,
            ProviderId::Mistral
        );
        // An own key needs a stored key and the encryption key.
        let mut own = WorkspaceAiSettings {
            default_provider: Some(ProviderId::Anthropic),
            providers: BTreeMap::from([(
                ProviderId::Anthropic,
                ProviderSetting {
                    enabled: true,
                    key_source: KeySource::Own,
                    enabled_by: None,
                    enabled_at: None,
                },
            )]),
            ..WorkspaceAiSettings::default()
        };
        assert_eq!(
            route(&config, &own, &call(Feature::Mail, Task::Draft, Tier::Free))
                .primary
                .provider,
            ProviderId::Mistral
        );
        enable(&mut own, ProviderId::Anthropic, KeySource::Own);
        let routed = route(&config, &own, &call(Feature::Mail, Task::Draft, Tier::Free));
        assert_eq!(routed.primary.provider, ProviderId::Anthropic);
        assert_eq!(routed.primary.key_source, KeySource::Own);
        let mut no_key = config.clone();
        no_key.keys_encryption_key = None;
        assert_eq!(
            route(&no_key, &own, &call(Feature::Mail, Task::Draft, Tier::Free))
                .primary
                .provider,
            ProviderId::Mistral
        );
        // A failing own key is skipped until it is tested again.
        own.own_keys
            .get_mut(&ProviderId::Anthropic)
            .expect("key")
            .status = "failing".to_owned();
        assert_eq!(
            route(&config, &own, &call(Feature::Mail, Task::Draft, Tier::Free))
                .primary
                .provider,
            ProviderId::Mistral
        );
        // Not offered at all.
        let mut config = eu();
        config.opt_in.remove(&ProviderId::Anthropic);
        assert_eq!(
            route(
                &config,
                &settings,
                &call(Feature::Mail, Task::Draft, Tier::Free)
            )
            .primary
            .provider,
            ProviderId::Mistral
        );
        assert_eq!(offered_key_sources(&config, ProviderId::Anthropic).len(), 0);
        assert_eq!(
            offered_key_sources(&eu(), ProviderId::Anthropic),
            vec![KeySource::Weldsuite, KeySource::Own]
        );
        assert_eq!(
            offered_key_sources(&eu(), ProviderId::Mistral),
            vec![KeySource::Weldsuite]
        );
    }

    fn compat(region: Region) -> CompatEndpoint {
        CompatEndpoint {
            endpoint: endpoint("http://vllm.ai.svc:8000/v1", None),
            region,
            model: "meta-llama/Llama-3.3-70B-Instruct".to_owned(),
            embed_model: Some("BAAI/bge-m3".to_owned()),
        }
    }

    #[test]
    fn the_fallback_model_must_be_in_the_eu() {
        let mut config = eu();
        config.compat = Some(compat(Region::Eu));
        config.fallback_model = Some("compat/meta-llama/Llama-3.3-70B-Instruct".to_owned());
        let mut settings = WorkspaceAiSettings::default();
        let route1 = route(
            &config,
            &settings,
            &call(Feature::Mail, Task::Draft, Tier::Free),
        );
        assert_eq!(route1.primary.provider, ProviderId::Mistral);
        assert_eq!(route1.fallbacks.len(), 1);
        assert_eq!(route1.fallbacks[0].provider, ProviderId::Compat);
        assert_eq!(
            route1.fallbacks[0].model,
            "compat/meta-llama/Llama-3.3-70B-Instruct"
        );
        // Anthropic → Mistral → the in-cluster model.
        enable(&mut settings, ProviderId::Anthropic, KeySource::Weldsuite);
        settings.default_provider = Some(ProviderId::Anthropic);
        let chain: Vec<_> = route(
            &config,
            &settings,
            &call(Feature::Mail, Task::Draft, Tier::Free),
        )
        .targets()
        .map(|t| t.provider)
        .collect();
        assert_eq!(
            chain,
            vec![
                ProviderId::Anthropic,
                ProviderId::Mistral,
                ProviderId::Compat
            ]
        );
        // A fallback model outside the EU is never added.
        config.compat = Some(compat(Region::OutsideEu));
        let route2 = route(
            &config,
            &WorkspaceAiSettings::default(),
            &call(Feature::Mail, Task::Draft, Tier::Free),
        );
        assert_eq!(route2.fallbacks.len(), 0);
        let mut config = eu();
        config.fallback_model = Some("anthropic/claude-haiku-5-5".to_owned());
        let route3 = route(
            &config,
            &WorkspaceAiSettings::default(),
            &call(Feature::Mail, Task::Draft, Tier::Free),
        );
        assert_eq!(route3.fallbacks.len(), 0);
        // A fallback model that lacks what the feature needs isn't added.
        let mut config = eu();
        config.compat = Some(compat(Region::Eu));
        config.fallback_model = Some("compat/meta-llama/Llama-3.3-70B-Instruct".to_owned());
        let ocr = route(
            &config,
            &WorkspaceAiSettings::default(),
            &call(Feature::BooksOcr, Task::Ocr, Tier::Free),
        );
        assert_eq!(ocr.fallbacks.len(), 0);
        // Another Mistral model works as the fallback too.
        let mut config = eu();
        config.fallback_model = Some("mistral/mistral-small-2603".to_owned());
        let route4 = route(
            &config,
            &WorkspaceAiSettings::default(),
            &call(Feature::Mail, Task::Draft, Tier::Free),
        );
        assert_eq!(route4.fallbacks[0].model, "mistral/mistral-small-2603");
    }

    #[test]
    fn a_self_hosted_compat_install_serves_its_own_models() {
        let config = AiConfig {
            default_provider: Some(ProviderId::Compat),
            compat: Some(compat(Region::Eu)),
            ..AiConfig::default()
        };
        let settings = WorkspaceAiSettings::default();
        let draft = route(
            &config,
            &settings,
            &call(Feature::Mail, Task::Draft, Tier::Quality),
        );
        assert_eq!(
            draft.primary.model,
            "compat/meta-llama/Llama-3.3-70B-Instruct"
        );
        assert_eq!(
            draft.primary.native_model(),
            "meta-llama/Llama-3.3-70B-Instruct"
        );
        let embed = route(
            &config,
            &settings,
            &call(Feature::SearchIndex, Task::Embed, Tier::Free),
        );
        assert_eq!(embed.primary.model, "compat/BAAI/bge-m3");
        assert!(matches!(
            resolve(
                &config,
                &settings,
                &call(Feature::Meet, Task::Transcribe, Tier::Free)
            ),
            Err(AiError::Unavailable)
        ));
        let requested = call(Feature::Mail, Task::Draft, Tier::Free)
            .requested_model(Some("meta-llama/Llama-3.3-70B-Instruct"));
        assert_eq!(
            route(&config, &settings, &requested).primary.provider,
            ProviderId::Compat
        );
        // Mistral isn't offered on this install.
        let mistral = call(Feature::Mail, Task::Draft, Tier::Free)
            .requested_model(Some("mistral/mistral-small-2603"));
        assert!(matches!(
            resolve(&config, &settings, &mistral),
            Err(AiError::ModelNotAllowed { .. })
        ));
    }

    /// A tiny deterministic generator, so the property test needs no crate.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0 >> 33
        }

        fn pick<T: Copy>(&mut self, items: &[T]) -> T {
            let len = u64::try_from(items.len()).expect("len");
            items[usize::try_from(self.next() % len).expect("index")]
        }

        fn chance(&mut self) -> bool {
            self.next().is_multiple_of(2)
        }
    }

    /// Whether `target` is one the workspace and install allow: the install
    /// provider, an enabled and configured opt-in provider, or the install's
    /// EU fallback model.
    fn permitted(config: &AiConfig, settings: &WorkspaceAiSettings, target: &Target) -> bool {
        if Some(target.provider) == config.default_provider {
            return target.key_source == KeySource::Weldsuite;
        }
        if provider_key_source(config, settings, target.provider) == Some(target.key_source) {
            return true;
        }
        fallback_model_target(config).is_some_and(|fallback| {
            fallback.model == target.model
                && target.region == Region::Eu
                && target.key_source == KeySource::Weldsuite
        })
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn a_disabled_provider_is_never_routed_to() {
        let models = [
            "anthropic/claude-sonnet-5-5",
            "anthropic/claude-haiku-5-5",
            "openai/gpt-5",
            "openai/gpt-5-mini",
            "mistral/mistral-small-2603",
            "mistral/mistral-ocr-4-1",
            "mistral/mistral-embed-2312",
            "compat/meta-llama/Llama-3.3-70B-Instruct",
            "made-up/model",
        ];
        let providers = [
            ProviderId::Anthropic,
            ProviderId::OpenAi,
            ProviderId::Mistral,
            ProviderId::Compat,
        ];
        let tiers = [Tier::Free, Tier::Quality];
        let mut rng = Lcg(0x005e_eda1);
        let mut routed_opt_in = 0;
        for _ in 0..4000 {
            let mut config = eu();
            if rng.chance() {
                config.compat = Some(compat(if rng.chance() {
                    Region::Eu
                } else {
                    Region::OutsideEu
                }));
            }
            if rng.chance() {
                config.fallback_model = Some(rng.pick(&models).to_owned());
            }
            for provider in [ProviderId::Anthropic, ProviderId::OpenAi] {
                match rng.next() % 4 {
                    0 => {
                        config.opt_in.remove(&provider);
                    }
                    1 => {
                        config.opt_in.insert(
                            provider,
                            KeySources {
                                weldsuite: rng.chance(),
                                own: rng.chance(),
                            },
                        );
                    }
                    _ => {}
                }
                if rng.next().is_multiple_of(3) {
                    match provider {
                        ProviderId::Anthropic => config.anthropic.api_key = None,
                        _ => config.openai.api_key = None,
                    }
                }
            }
            if rng.next().is_multiple_of(5) {
                config.keys_encryption_key = None;
            }
            let mut settings = WorkspaceAiSettings::default();
            for provider in providers {
                if rng.chance() {
                    settings.providers.insert(
                        provider,
                        ProviderSetting {
                            enabled: rng.chance(),
                            key_source: if rng.chance() {
                                KeySource::Own
                            } else {
                                KeySource::Weldsuite
                            },
                            enabled_by: None,
                            enabled_at: None,
                        },
                    );
                }
                if rng.chance() {
                    settings.own_keys.insert(
                        provider,
                        OwnKeyStatus {
                            hint: "…".to_owned(),
                            status: if rng.chance() { "ok" } else { "failing" }.to_owned(),
                            last_error: None,
                            last_checked_at: None,
                        },
                    );
                }
            }
            if rng.chance() {
                settings.default_provider = Some(rng.pick(&providers));
            }
            for feature in Feature::ALL {
                if rng.next().is_multiple_of(3) {
                    settings.feature_overrides.insert(
                        feature,
                        FeatureOverride {
                            provider: rng.pick(&providers),
                            model: rng.chance().then(|| rng.pick(&models).to_owned()),
                        },
                    );
                }
            }
            let feature = rng.pick(&Feature::ALL);
            let task = rng.pick(&catalog::feature(feature).tasks);
            let mut call = call(feature, task, rng.pick(&tiers));
            match rng.next() % 3 {
                0 => call = call.requested_model(Some(rng.pick(&models))),
                1 => call = call.stored_model(Some(rng.pick(&models))),
                _ => {}
            }
            let Ok(route) = resolve(&config, &settings, &call) else {
                continue;
            };
            for target in route.targets() {
                assert!(
                    permitted(&config, &settings, target),
                    "{target:?} for {} under {settings:?}",
                    feature.as_str()
                );
                if target.provider.opt_in() {
                    routed_opt_in += 1;
                }
            }
            // Never EU → non-EU, and fixed features stay home.
            let mut previous: Option<&Target> = None;
            for target in route.targets() {
                if let Some(previous) = previous {
                    assert!(may_follow(previous, target), "{route:?}");
                }
                previous = Some(target);
            }
            if !feature.overridable() || task.install_only() {
                assert_eq!(Some(route.primary.provider), config.default_provider);
            }
        }
        assert!(
            routed_opt_in > 100,
            "the generator should reach the opt-in providers"
        );
    }

    #[test]
    fn the_effective_policy_lists_providers_features_and_pickers() {
        let mut settings = WorkspaceAiSettings::default();
        enable(&mut settings, ProviderId::Anthropic, KeySource::Own);
        settings.default_provider = Some(ProviderId::Anthropic);
        settings.feature_overrides.insert(
            Feature::Forms,
            FeatureOverride {
                provider: ProviderId::Mistral,
                model: Some("mistral/mistral-small-2603".to_owned()),
            },
        );
        let policy = effective(&eu(), &settings);
        assert_eq!(policy.install_provider, ProviderId::Mistral);
        assert_eq!(policy.default_provider, ProviderId::Anthropic);
        let ids: Vec<&str> = policy
            .providers
            .iter()
            .map(|p| p["id"].as_str().expect("id"))
            .collect();
        assert_eq!(ids, vec!["mistral", "anthropic", "openai"]);
        assert_eq!(policy.providers[1]["region"], "outside-eu");
        assert_eq!(policy.providers[1]["enabled"], true);
        assert_eq!(policy.providers[1]["keySource"], "own");
        assert_eq!(policy.providers[0]["install"], true);
        assert_eq!(policy.providers[1]["install"], false);
        assert_eq!(policy.providers[2]["enabled"], false);
        assert_eq!(policy.providers[2]["keySource"], serde_json::Value::Null);
        assert_eq!(policy.providers[2]["available"], false);
        let mail = &policy.features[0];
        assert_eq!(mail["id"], "mail");
        assert_eq!(mail["effective"]["provider"], "anthropic");
        let models: Vec<&str> = mail["models"]
            .as_array()
            .expect("models")
            .iter()
            .map(|m| m["id"].as_str().expect("id"))
            .collect();
        assert!(models.contains(&"anthropic/claude-sonnet-5-5"));
        assert!(models.contains(&"mistral/mistral-large-4-0"));
        assert!(!models.contains(&"openai/gpt-5"), "OpenAI isn't enabled");
        assert!(
            !models.contains(&"mistral/mistral-medium-3-5"),
            "retiring models stay out of pickers"
        );
        assert!(!models.contains(&"mistral/mistral-embed-2312"));
        let forms = policy
            .features
            .iter()
            .find(|f| f["id"] == "forms")
            .expect("forms");
        assert_eq!(forms["override"]["model"], "mistral/mistral-small-2603");
        assert_eq!(forms["effective"]["model"], "mistral/mistral-small-2603");
        let index = policy
            .features
            .iter()
            .find(|f| f["id"] == "search-index")
            .expect("index");
        assert_eq!(index["overridable"], false);
        assert_eq!(index["effective"]["provider"], "mistral");
        assert_eq!(index["effective"]["region"], "eu");
        let index_models: Vec<&str> = index["models"]
            .as_array()
            .expect("models")
            .iter()
            .map(|m| m["id"].as_str().expect("id"))
            .collect();
        assert_eq!(index_models, vec!["mistral/mistral-embed-2312"]);
    }
}
