//! A workspace's AI settings: the tenant tables `ai_settings` (a singleton)
//! and `ai_provider_keys` (`packages/core/db/src/schema/ai-settings.ts`).
//!
//! `ai_settings` columns: `id`, `providers` jsonb
//! (`{ "anthropic": { "enabled", "keySource", "enabledBy", "enabledAt" } }`),
//! `default_provider` (null: the install default), `feature_overrides` jsonb
//! (`{ "mail": { "provider": "anthropic", "model": "anthropic/claude-sonnet-5-5" } }`),
//! `updated_by`, `updated_at`, `created_at`.
//!
//! `ai_provider_keys` columns: `id`, `provider` (unique), `ciphertext`,
//! `key_hint`, `status` (`ok` | `failing`), `last_error`, `last_checked_at`,
//! `created_by`, `created_at`, `updated_at`.
//!
//! Own keys are sealed with AES-256-GCM under `AI_KEYS_ENCRYPTION_KEY`, with
//! the additional data `ai_provider_keys:<workspaceId>:<provider>` (the
//! construction of `weldsuite_db::crypto`'s v3), so a row copied onto another
//! workspace fails to open. Only [`key_hint`] ever leaves this module.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use weldsuite_db::PgPool;
use weldsuite_ports::DynCache;

use crate::catalog::{Feature, KeySource, ProviderId};
use crate::error::AiError;

/// One opt-in provider's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSetting {
    pub enabled: bool,
    #[serde(default)]
    pub key_source: KeySource,
    pub enabled_by: Option<String>,
    pub enabled_at: Option<String>,
}

/// A feature routed away from the workspace default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureOverride {
    pub provider: ProviderId,
    /// A canonical model id; `None` uses the provider's task map.
    pub model: Option<String>,
}

/// An own key's state, without the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnKeyStatus {
    pub hint: String,
    /// `ok` or `failing`.
    pub status: String,
    pub last_error: Option<String>,
    pub last_checked_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAiSettings {
    pub providers: BTreeMap<ProviderId, ProviderSetting>,
    /// `None`: the install default.
    pub default_provider: Option<ProviderId>,
    pub feature_overrides: BTreeMap<Feature, FeatureOverride>,
    /// Own keys present, by provider (no ciphertext).
    pub own_keys: BTreeMap<ProviderId, OwnKeyStatus>,
    pub updated_by: Option<String>,
    pub updated_at: Option<String>,
}

/// The settings, from the cache (60 s) or the tenant database. No row is the
/// default: install provider only.
pub async fn load(
    tenant: &PgPool,
    workspace_id: &str,
    cache: Option<&dyn DynCache>,
) -> Result<WorkspaceAiSettings, AiError> {
    let _ = (tenant, workspace_id, cache);
    todo!("AI-012 phase 1")
}

/// Forget the cached settings after a write.
pub async fn invalidate(cache: Option<&dyn DynCache>, workspace_id: &str) {
    let _ = (cache, workspace_id);
    todo!("AI-012 phase 1")
}

/// The own key for `provider`, opened; `None` without one.
pub async fn own_key(
    tenant: &PgPool,
    encryption_key: &[u8; 32],
    workspace_id: &str,
    provider: ProviderId,
) -> Result<Option<String>, AiError> {
    let _ = (tenant, encryption_key, workspace_id, provider);
    todo!("AI-012 phase 1")
}

/// Seal an own key for storage (`ciphertext`).
pub fn seal_key(
    encryption_key: &[u8; 32],
    workspace_id: &str,
    provider: ProviderId,
    key: &str,
) -> Result<String, AiError> {
    let _ = (encryption_key, workspace_id, provider, key);
    todo!("AI-012 phase 1")
}

/// Open a sealed own key; fails for a row copied from another workspace.
pub fn open_key(
    encryption_key: &[u8; 32],
    workspace_id: &str,
    provider: ProviderId,
    ciphertext: &str,
) -> Result<String, AiError> {
    let _ = (encryption_key, workspace_id, provider, ciphertext);
    todo!("AI-012 phase 1")
}

/// The only form of a key that is ever returned: `sk-…a1b2`.
pub fn key_hint(key: &str) -> String {
    let _ = key;
    todo!("AI-012 phase 1")
}

/// Marks an own key `failing` (a 401/402/403 from the provider) or `ok`.
pub async fn mark_key(
    tenant: &PgPool,
    provider: ProviderId,
    failing: Option<&str>,
) -> Result<(), AiError> {
    let _ = (tenant, provider, failing);
    todo!("AI-012 phase 1")
}
