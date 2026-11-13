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
//!
//! The settings are cached for 60 s under `ai-settings:<workspaceId>`; a
//! write clears that entry ([`invalidate`]). Usage for the settings page is
//! read from the master ops ledger (`ai_provider_usage`, [`usage`]).

use std::collections::BTreeMap;
use std::time::Duration;

use aws_lc_rs::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_ports::DynCache;

use crate::catalog::{Feature, KeySource, ProviderId};
use crate::error::AiError;

/// An `ai_settings` row: providers, default provider, overrides, updated by,
/// updated at.
type SettingsRow = (Value, Option<String>, Value, Option<String>, Option<String>);
/// An `ai_provider_keys` row without its ciphertext: provider, hint, status,
/// last error, last checked at.
type KeyRow = (String, String, String, Option<String>, Option<String>);

/// How long a workspace's settings are cached.
pub const CACHE_TTL: Duration = Duration::from_secs(60);

/// The id of the singleton `ai_settings` row this module writes.
const SETTINGS_ROW_ID: &str = "ais_workspace";

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

impl OwnKeyStatus {
    /// Marked `failing` after a 401/402/403: not routed to until it is
    /// tested again or replaced.
    pub fn failing(&self) -> bool {
        self.status == KEY_FAILING
    }
}

/// `ai_provider_keys.status` of a key that works.
pub const KEY_OK: &str = "ok";
/// `ai_provider_keys.status` of a key the provider refused.
pub const KEY_FAILING: &str = "failing";

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

/// `ai-settings:<workspaceId>`.
pub fn cache_key(workspace_id: &str) -> String {
    format!("ai-settings:{workspace_id}")
}

/// `relation "…" does not exist`: an install whose tenant schema predates
/// the AI settings runs on the install defaults.
fn missing_table(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .is_some_and(|code| code == "42P01")
}

/// The `providers` jsonb, keeping only providers and fields this build
/// knows.
pub(crate) fn parse_providers(value: &Value) -> BTreeMap<ProviderId, ProviderSetting> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, entry)| {
            let provider = ProviderId::parse(key)?;
            let setting = serde_json::from_value::<ProviderSetting>(entry.clone()).ok()?;
            Some((provider, setting))
        })
        .collect()
}

/// The `feature_overrides` jsonb, keeping only overridable features and known
/// providers.
pub(crate) fn parse_overrides(value: &Value) -> BTreeMap<Feature, FeatureOverride> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, entry)| {
            let feature = Feature::parse(key).filter(|f| f.overridable())?;
            let provider = ProviderId::parse(entry.get("provider")?.as_str()?)?;
            let model = entry
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(str::to_owned);
            Some((feature, FeatureOverride { provider, model }))
        })
        .collect()
}

/// Reads the settings from the tenant database (no cache).
pub async fn read(tenant: &PgPool) -> Result<WorkspaceAiSettings, AiError> {
    let row: Result<Option<SettingsRow>, _> = sqlx::query_as(
        "select providers, default_provider, feature_overrides, updated_by,
                    to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
             from ai_settings
             order by created_at asc
             limit 1",
    )
    .fetch_optional(tenant)
    .await;
    let row = match row {
        Ok(row) => row,
        Err(error) if missing_table(&error) => {
            tracing::warn!(
                "[weldsuite-ai] ai_settings is missing; running on the install defaults"
            );
            return Ok(WorkspaceAiSettings::default());
        }
        Err(error) => return Err(error.into()),
    };
    let mut settings = WorkspaceAiSettings::default();
    if let Some((providers, default_provider, overrides, updated_by, updated_at)) = row {
        settings.providers = parse_providers(&providers);
        settings.default_provider = default_provider.as_deref().and_then(ProviderId::parse);
        settings.feature_overrides = parse_overrides(&overrides);
        settings.updated_by = updated_by;
        settings.updated_at = updated_at;
    }
    let keys: Result<Vec<KeyRow>, _> = sqlx::query_as(
        "select provider, key_hint, status, last_error,
                    to_char(last_checked_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
             from ai_provider_keys",
    )
    .fetch_all(tenant)
    .await;
    let keys = match keys {
        Ok(keys) => keys,
        Err(error) if missing_table(&error) => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    settings.own_keys = keys
        .into_iter()
        .filter_map(|(provider, hint, status, last_error, last_checked_at)| {
            Some((
                ProviderId::parse(&provider)?,
                OwnKeyStatus {
                    hint,
                    status,
                    last_error,
                    last_checked_at,
                },
            ))
        })
        .collect();
    Ok(settings)
}

/// The settings, from the cache (60 s) or the tenant database. No row is the
/// default: install provider only.
pub async fn load(
    tenant: &PgPool,
    workspace_id: &str,
    cache: Option<&dyn DynCache>,
) -> Result<WorkspaceAiSettings, AiError> {
    let key = cache_key(workspace_id);
    if let Some(cache) = cache
        && let Ok(Some(raw)) = cache.get_boxed(&key).await
        && let Ok(settings) = serde_json::from_str::<WorkspaceAiSettings>(&raw)
    {
        return Ok(settings);
    }
    let settings = read(tenant).await?;
    if let Some(cache) = cache
        && let Ok(raw) = serde_json::to_string(&settings)
        && let Err(error) = cache.put_boxed(&key, &raw, Some(CACHE_TTL)).await
    {
        tracing::warn!(%error, "[weldsuite-ai] could not cache the AI settings");
    }
    Ok(settings)
}

/// Forget the cached settings after a write.
pub async fn invalidate(cache: Option<&dyn DynCache>, workspace_id: &str) {
    if let Some(cache) = cache
        && let Err(error) = cache.delete_boxed(&cache_key(workspace_id)).await
    {
        tracing::warn!(%error, "[weldsuite-ai] could not clear the cached AI settings");
    }
}

/// Writes the workspace's providers, default and overrides (`PUT
/// /api/ai-settings`). The caller has checked them against the policy
/// (`policy::allows`) and clears the cache (`Ai::invalidate`).
pub async fn save_settings(
    tenant: &PgPool,
    settings: &WorkspaceAiSettings,
    updated_by: Option<&str>,
) -> Result<(), AiError> {
    let providers: Map<String, Value> = settings
        .providers
        .iter()
        .map(|(provider, setting)| {
            (
                provider.as_str().to_owned(),
                serde_json::to_value(setting).unwrap_or(Value::Null),
            )
        })
        .collect();
    let overrides: Map<String, Value> = settings
        .feature_overrides
        .iter()
        .map(|(feature, entry)| {
            (
                feature.as_str().to_owned(),
                serde_json::json!({
                    "provider": entry.provider.as_str(),
                    "model": entry.model,
                }),
            )
        })
        .collect();
    let updated = sqlx::query(
        "update ai_settings
         set providers = $1, default_provider = $2, feature_overrides = $3,
             updated_by = $4, updated_at = now()
         where id = (select id from ai_settings order by created_at asc limit 1)",
    )
    .bind(Value::Object(providers.clone()))
    .bind(settings.default_provider.map(ProviderId::as_str))
    .bind(Value::Object(overrides.clone()))
    .bind(updated_by)
    .execute(tenant)
    .await?;
    if updated.rows_affected() == 0 {
        sqlx::query(
            "insert into ai_settings
                 (id, providers, default_provider, feature_overrides, updated_by, updated_at)
             values ($1, $2, $3, $4, $5, now())
             on conflict (id) do update set
                 providers = excluded.providers,
                 default_provider = excluded.default_provider,
                 feature_overrides = excluded.feature_overrides,
                 updated_by = excluded.updated_by,
                 updated_at = excluded.updated_at",
        )
        .bind(SETTINGS_ROW_ID)
        .bind(Value::Object(providers))
        .bind(settings.default_provider.map(ProviderId::as_str))
        .bind(Value::Object(overrides))
        .bind(updated_by)
        .execute(tenant)
        .await?;
    }
    Ok(())
}

/// Seals and stores an own key (`PUT /api/ai-settings/keys/:provider`),
/// replacing the provider's previous one, as `ok`: the caller has checked it
/// with the provider first (`Ai::check_key`). Its status, for the answer.
pub async fn put_key(
    tenant: &PgPool,
    encryption_key: &[u8; 32],
    workspace_id: &str,
    provider: ProviderId,
    key: &str,
    created_by: Option<&str>,
) -> Result<OwnKeyStatus, AiError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AiError::Invalid("the API key is empty".to_owned()));
    }
    let ciphertext = seal_key(encryption_key, workspace_id, provider, key)?;
    let hint = key_hint(key);
    let checked_at: Option<String> = sqlx::query_scalar(
        "insert into ai_provider_keys
             (id, provider, ciphertext, key_hint, status, last_error, last_checked_at,
              created_by, created_at, updated_at)
         values ($1, $2, $3, $4, 'ok', null, now(), $5, now(), now())
         on conflict (provider) do update set
             ciphertext = excluded.ciphertext,
             key_hint = excluded.key_hint,
             status = 'ok',
             last_error = null,
             last_checked_at = excluded.last_checked_at,
             created_by = excluded.created_by,
             updated_at = now()
         returning to_char(last_checked_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
    )
    .bind(generate_id("aipk"))
    .bind(provider.as_str())
    .bind(&ciphertext)
    .bind(&hint)
    .bind(created_by)
    .fetch_one(tenant)
    .await?;
    Ok(OwnKeyStatus {
        hint,
        status: KEY_OK.to_owned(),
        last_error: None,
        last_checked_at: checked_at,
    })
}

/// Removes an own key (`DELETE /api/ai-settings/keys/:provider`). Whether
/// there was one.
pub async fn delete_key(tenant: &PgPool, provider: ProviderId) -> Result<bool, AiError> {
    let deleted = sqlx::query("delete from ai_provider_keys where provider = $1")
        .bind(provider.as_str())
        .execute(tenant)
        .await?;
    Ok(deleted.rows_affected() > 0)
}

/// The own key for `provider`, opened; `None` without one.
pub async fn own_key(
    tenant: &PgPool,
    encryption_key: &[u8; 32],
    workspace_id: &str,
    provider: ProviderId,
) -> Result<Option<String>, AiError> {
    let ciphertext: Option<String> =
        sqlx::query_scalar("select ciphertext from ai_provider_keys where provider = $1 limit 1")
            .bind(provider.as_str())
            .fetch_optional(tenant)
            .await?;
    ciphertext
        .map(|sealed| open_key(encryption_key, workspace_id, provider, &sealed))
        .transpose()
}

/// The additional data an own key is bound to.
pub fn key_aad(workspace_id: &str, provider: ProviderId) -> String {
    format!("ai_provider_keys:{workspace_id}:{}", provider.as_str())
}

const SEALED_PREFIX: &str = "v1:";

/// Seal an own key for storage (`ciphertext`): `v1:<iv>:<ciphertext+tag>`,
/// lowercase hex, a random 96-bit IV (the layout of `weldsuite_db::crypto`).
pub fn seal_key(
    encryption_key: &[u8; 32],
    workspace_id: &str,
    provider: ProviderId,
    key: &str,
) -> Result<String, AiError> {
    if workspace_id.is_empty() {
        return Err(AiError::Invalid(
            "an own key is sealed for a workspace".to_owned(),
        ));
    }
    let unbound = UnboundKey::new(&AES_256_GCM, encryption_key)
        .map_err(|_| AiError::Invalid("AI_KEYS_ENCRYPTION_KEY is not a 256-bit key".to_owned()))?;
    let sealing = LessSafeKey::new(unbound);
    let mut iv = [0_u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut iv)
        .map_err(|_| AiError::Invalid("the system random number generator failed".to_owned()))?;
    let mut in_out = key.as_bytes().to_vec();
    sealing
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(iv),
            Aad::from(key_aad(workspace_id, provider).as_bytes()),
            &mut in_out,
        )
        .map_err(|_| AiError::Invalid("sealing the key failed".to_owned()))?;
    Ok(format!(
        "{SEALED_PREFIX}{}:{}",
        hex::encode(iv),
        hex::encode(in_out)
    ))
}

/// Open a sealed own key; fails for a row copied from another workspace.
pub fn open_key(
    encryption_key: &[u8; 32],
    workspace_id: &str,
    provider: ProviderId,
    ciphertext: &str,
) -> Result<String, AiError> {
    let refused = || {
        AiError::Invalid(format!(
            "the stored {} key can't be opened (sealed for another workspace, tampered with, or the wrong AI_KEYS_ENCRYPTION_KEY)",
            provider.as_str()
        ))
    };
    let (iv, sealed) = ciphertext
        .strip_prefix(SEALED_PREFIX)
        .and_then(|rest| rest.split_once(':'))
        .ok_or_else(refused)?;
    let iv = hex::decode(iv).map_err(|_| refused())?;
    let mut in_out = hex::decode(sealed).map_err(|_| refused())?;
    let nonce = Nonce::try_assume_unique_for_key(&iv).map_err(|_| refused())?;
    let unbound = UnboundKey::new(&AES_256_GCM, encryption_key).map_err(|_| refused())?;
    let plaintext = LessSafeKey::new(unbound)
        .open_in_place(
            nonce,
            Aad::from(key_aad(workspace_id, provider).as_bytes()),
            &mut in_out,
        )
        .map_err(|_| refused())?;
    String::from_utf8(plaintext.to_vec()).map_err(|_| refused())
}

/// The only form of a key that is ever returned: `sk-…a1b2` (the `sk-`
/// prefix when the key has one, then its last four characters). Keys too
/// short to spare four characters show none.
pub fn key_hint(key: &str) -> String {
    let key = key.trim();
    let prefix = if key.starts_with("sk-") { "sk-" } else { "" };
    let chars: Vec<char> = key.chars().collect();
    if chars.len() < 12 {
        return format!("{prefix}…");
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{prefix}…{tail}")
}

/// Marks an own key `failing` (a 401/402/403 from the provider, with the
/// reason) or `ok` (`failing: None`, after a successful test).
pub async fn mark_key(
    tenant: &PgPool,
    provider: ProviderId,
    failing: Option<&str>,
) -> Result<(), AiError> {
    let status = if failing.is_some() {
        KEY_FAILING
    } else {
        KEY_OK
    };
    let reason = failing.map(|reason| reason.chars().take(500).collect::<String>());
    sqlx::query(
        "update ai_provider_keys
         set status = $2, last_error = $3, last_checked_at = now(), updated_at = now()
         where provider = $1",
    )
    .bind(provider.as_str())
    .bind(status)
    .bind(reason)
    .execute(tenant)
    .await?;
    Ok(())
}

/// One line of the usage report: a provider, feature and key source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub provider: String,
    /// `None` for calls made before features were recorded.
    pub feature: Option<String>,
    pub key_source: String,
    pub calls: i64,
    pub credits: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

/// `GET /api/ai-settings/usage`: this month and last month, from the ops
/// ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub this_month: Vec<UsageRow>,
    pub last_month: Vec<UsageRow>,
}

/// Credits and tokens per provider, feature and key source, this month and
/// last month (UTC), from the master `ai_provider_usage`.
pub async fn usage(master: &PgPool, workspace_id: &str) -> Result<UsageReport, AiError> {
    type Row = (String, String, Option<String>, String, i64, i64, i64, i64);
    let rows: Vec<Row> = sqlx::query_as(
        "with bounds as (
             select date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' as this_start,
                    (date_trunc('month', now() at time zone 'UTC') - interval '1 month') at time zone 'UTC' as last_start
         )
         select case when u.created_at >= b.this_start then 'this' else 'last' end as period,
                split_part(u.model_id, '/', 1) as provider,
                u.feature,
                u.key_source,
                count(*)::bigint,
                coalesce(sum(u.credits_charged), 0)::bigint,
                coalesce(sum(u.input_tokens), 0)::bigint,
                coalesce(sum(u.output_tokens), 0)::bigint
         from ai_provider_usage u, bounds b
         where u.workspace_id = $1 and u.created_at >= b.last_start
         group by 1, 2, 3, 4
         order by 1, 2, 3, 4",
    )
    .bind(workspace_id)
    .fetch_all(master)
    .await?;
    let mut report = UsageReport {
        this_month: Vec::new(),
        last_month: Vec::new(),
    };
    for (period, provider, feature, key_source, calls, credits, input_tokens, output_tokens) in rows
    {
        let row = UsageRow {
            provider,
            feature,
            key_source,
            calls,
            credits,
            input_tokens,
            output_tokens,
        };
        if period == "this" {
            report.this_month.push(row);
        } else {
            report.last_month.push(row);
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const KEY: [u8; 32] = [7; 32];

    #[test]
    fn a_sealed_key_opens_only_for_its_workspace_and_provider() {
        let sealed =
            seal_key(&KEY, "ws_a", ProviderId::Anthropic, "sk-ant-secret-1234").expect("seal");
        assert!(sealed.starts_with("v1:"));
        assert!(!sealed.contains("secret"));
        assert_eq!(
            open_key(&KEY, "ws_a", ProviderId::Anthropic, &sealed).expect("open"),
            "sk-ant-secret-1234"
        );
        // A row copied onto another workspace, or relabelled for another
        // provider, fails.
        assert!(open_key(&KEY, "ws_b", ProviderId::Anthropic, &sealed).is_err());
        assert!(open_key(&KEY, "ws_a", ProviderId::OpenAi, &sealed).is_err());
        // The wrong key and a tampered value fail.
        assert!(open_key(&[8; 32], "ws_a", ProviderId::Anthropic, &sealed).is_err());
        let mut tampered = sealed.clone();
        let last = tampered.pop().expect("char");
        tampered.push(if last == '0' { '1' } else { '0' });
        assert!(open_key(&KEY, "ws_a", ProviderId::Anthropic, &tampered).is_err());
        assert!(open_key(&KEY, "ws_a", ProviderId::Anthropic, "plain").is_err());
        // Two seals of the same key differ (random IV).
        let again =
            seal_key(&KEY, "ws_a", ProviderId::Anthropic, "sk-ant-secret-1234").expect("seal");
        assert_ne!(sealed, again);
        assert!(seal_key(&KEY, "", ProviderId::Anthropic, "k").is_err());
    }

    #[test]
    fn the_error_never_carries_the_key() {
        let sealed =
            seal_key(&KEY, "ws_a", ProviderId::OpenAi, "sk-proj-topsecret-9999").expect("seal");
        let error = open_key(&KEY, "ws_b", ProviderId::OpenAi, &sealed).expect_err("refused");
        assert!(!error.to_string().contains("topsecret"));
    }

    #[test]
    fn hints_show_the_prefix_and_last_four_only() {
        assert_eq!(key_hint("sk-ant-api03-abcdefghijklmnopa1b2"), "sk-…a1b2");
        assert_eq!(key_hint("sk-proj-0123456789xyz9"), "sk-…xyz9");
        assert_eq!(key_hint("AbCdEfGhIjKlMnOpQrStUvWxYz012345"), "…2345");
        assert_eq!(key_hint("short"), "…");
        assert_eq!(key_hint("sk-short"), "sk-…");
    }

    #[test]
    fn stored_json_parses_leniently() {
        let providers = parse_providers(&json!({
            "anthropic": { "enabled": true, "keySource": "own", "enabledBy": "user_1", "enabledAt": "2026-11-13T10:00:00.000Z" },
            "openai": { "enabled": false },
            "gemini": { "enabled": true },
            "mistral": "nonsense",
        }));
        assert_eq!(providers.len(), 2);
        assert_eq!(providers[&ProviderId::Anthropic].key_source, KeySource::Own);
        assert_eq!(
            providers[&ProviderId::Anthropic].enabled_by.as_deref(),
            Some("user_1")
        );
        assert_eq!(
            providers[&ProviderId::OpenAi].key_source,
            KeySource::Weldsuite
        );
        assert!(!providers[&ProviderId::OpenAi].enabled);

        let overrides = parse_overrides(&json!({
            "mail": { "provider": "anthropic", "model": "anthropic/claude-sonnet-5-5" },
            "forms": { "provider": "openai", "model": null },
            "board": { "provider": "openai", "model": "  " },
            "search-index": { "provider": "openai" },
            "unknown": { "provider": "openai" },
            "data": { "provider": "gemini" },
        }));
        assert_eq!(overrides.len(), 3);
        assert_eq!(
            overrides[&Feature::Mail].model.as_deref(),
            Some("anthropic/claude-sonnet-5-5")
        );
        assert_eq!(overrides[&Feature::Forms].model, None);
        assert_eq!(overrides[&Feature::Board].model, None);
        assert!(!overrides.contains_key(&Feature::SearchIndex));
    }

    #[test]
    fn settings_round_trip_through_the_cache_format() {
        let mut settings = WorkspaceAiSettings::default();
        settings.providers.insert(
            ProviderId::OpenAi,
            ProviderSetting {
                enabled: true,
                key_source: KeySource::Weldsuite,
                enabled_by: Some("user_1".to_owned()),
                enabled_at: None,
            },
        );
        settings.default_provider = Some(ProviderId::OpenAi);
        settings.feature_overrides.insert(
            Feature::BooksOcr,
            FeatureOverride {
                provider: ProviderId::Mistral,
                model: None,
            },
        );
        settings.own_keys.insert(
            ProviderId::Anthropic,
            OwnKeyStatus {
                hint: "sk-…a1b2".to_owned(),
                status: KEY_FAILING.to_owned(),
                last_error: Some("401".to_owned()),
                last_checked_at: None,
            },
        );
        let raw = serde_json::to_string(&settings).expect("json");
        assert!(raw.contains("\"openai\""));
        assert!(raw.contains("\"books-ocr\""));
        let back: WorkspaceAiSettings = serde_json::from_str(&raw).expect("back");
        assert_eq!(back, settings);
        assert!(back.own_keys[&ProviderId::Anthropic].failing());
        assert_eq!(cache_key("ws_1"), "ai-settings:ws_1");
    }

    #[tokio::test]
    async fn the_cache_is_cleared_on_invalidate() {
        use weldsuite_ports::Cache as _;

        let cache = weldsuite_ports::MemoryCache::default();
        cache
            .put(&cache_key("ws_1"), "{}", Some(CACHE_TTL))
            .await
            .expect("put");
        invalidate(Some(&cache as &dyn DynCache), "ws_1").await;
        assert_eq!(cache.get(&cache_key("ws_1")).await.expect("get"), None);
        // No cache is a no-op.
        invalidate(None, "ws_1").await;
    }
}
