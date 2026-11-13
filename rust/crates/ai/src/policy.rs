//! The workspace policy resolver (`docs/plans/eu-ai-mistral.md`, "Workspace
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
//! install, or whose key source isn't configured) is never routed to; fixed
//! features ([`Feature::overridable`]) stay on the install provider; and the
//! fallback chain goes from a non-EU provider to the install provider's model
//! for the same task and tier, never the other way.

use serde::Serialize;

use crate::catalog::{Feature, KeySource, ProviderId, Region};
use crate::config::AiConfig;
use crate::error::AiError;
use crate::settings::WorkspaceAiSettings;
use crate::AiCall;

/// One step of a route: a provider, a canonical model and whose key pays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub provider: ProviderId,
    pub model: String,
    pub region: Region,
    pub key_source: KeySource,
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

/// The route for `call`.
pub fn resolve(config: &AiConfig, settings: &WorkspaceAiSettings, call: &AiCall) -> Result<Route, AiError> {
    let _ = (config, settings, call);
    todo!("AI-012 phase 1")
}

/// What `GET /api/ai-settings` answers: every provider with its region and
/// state, the default, the overrides, and the models each feature may use.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePolicy {
    pub install_provider: ProviderId,
    pub default_provider: ProviderId,
    pub providers: Vec<serde_json::Value>,
    pub features: Vec<serde_json::Value>,
}

/// The effective policy for the settings page and every model picker.
pub fn effective(config: &AiConfig, settings: &WorkspaceAiSettings) -> EffectivePolicy {
    let _ = (config, settings);
    todo!("AI-012 phase 1")
}

/// Whether `model` may serve `feature` under `settings` (an enabled provider
/// and the feature's capabilities): `PUT /api/ai-settings` checks overrides
/// with it.
pub fn allows(config: &AiConfig, settings: &WorkspaceAiSettings, feature: Feature, model: &str) -> bool {
    let _ = (config, settings, feature, model);
    todo!("AI-012 phase 1")
}
