//! The install's AI configuration (Helm `config.ai`, `docs/plans/eu-ai-mistral.md`
//! "Install configuration"), read from the environment at start.
//!
//! | Env | Meaning |
//! |---|---|
//! | `AI_DEFAULT_PROVIDER` | `mistral`, `compat`, or empty: AI off |
//! | `AI_MISTRAL_BASE_URL`, `MISTRAL_API_KEY` | Mistral (default `https://api.mistral.ai/v1`) |
//! | `AI_ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` | WeldSuite's EU-edition Anthropic account (optional) |
//! | `AI_OPENAI_BASE_URL`, `OPENAI_API_KEY` | WeldSuite's EU-edition OpenAI account (optional) |
//! | `AI_OPTIN_ANTHROPIC`, `AI_OPTIN_OPENAI` | Key sources workspaces may use: `weldsuite,own`, `own`, … or empty (not offered) |
//! | `AI_COMPAT_BASE_URL`, `AI_COMPAT_API_KEY`, `AI_COMPAT_REGION`, `AI_COMPAT_MODEL`, `AI_COMPAT_EMBED_MODEL` | A self-hosted install's OpenAI-compatible endpoint |
//! | `AI_FALLBACK_MODEL` | An EU model the install provider falls back to; a non-EU one is a problem |
//! | `AI_CREDIT_GATE` | `true`: the 402 gate (AI-007) |
//! | `AI_BILLING` | `credits` (default) or `display` (self-hosted: meter, never charge) |
//! | `AI_KEYS_ENCRYPTION_KEY` | 64 hex characters; seals workspaces' own keys |
//! | `AI_WORKSPACE_CONCURRENCY` | Calls one workspace may have in flight on WeldSuite's keys (default 4) |

use std::collections::BTreeMap;

use crate::catalog::{KeySource, ProviderId, Region};

/// A provider endpoint and WeldSuite's key for it.
#[derive(Clone, Default)]
pub struct Endpoint {
    pub base_url: String,
    pub api_key: Option<String>,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint")
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<set>"))
            .finish()
    }
}

/// A self-hosted install's OpenAI-compatible endpoint.
#[derive(Debug, Clone)]
pub struct CompatEndpoint {
    pub endpoint: Endpoint,
    pub region: Region,
    /// The chat model it serves (every chat task).
    pub model: String,
    /// The embeddings model, when it serves one.
    pub embed_model: Option<String>,
}

/// Which key sources workspaces may use for an opt-in provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KeySources {
    pub weldsuite: bool,
    pub own: bool,
}

impl KeySources {
    pub fn allows(self, source: KeySource) -> bool {
        match source {
            KeySource::Weldsuite => self.weldsuite,
            KeySource::Own => self.own,
        }
    }

    pub fn any(self) -> bool {
        self.weldsuite || self.own
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BillingMode {
    /// Charge the credit wallet.
    #[default]
    Credits,
    /// Meter for display only (self-hosted installs).
    Display,
}

#[derive(Clone, Debug, Default)]
pub struct AiConfig {
    /// `None`: AI off.
    pub default_provider: Option<ProviderId>,
    pub mistral: Endpoint,
    pub anthropic: Endpoint,
    pub openai: Endpoint,
    pub compat: Option<CompatEndpoint>,
    /// What workspaces may enable, and with which key. A provider offered with
    /// WeldSuite's key needs that key configured.
    pub opt_in: BTreeMap<ProviderId, KeySources>,
    /// An EU model id the install provider falls back to.
    pub fallback_model: Option<String>,
    pub credit_gate: bool,
    pub billing: BillingMode,
    /// `AI_KEYS_ENCRYPTION_KEY`, decoded.
    pub keys_encryption_key: Option<[u8; 32]>,
    pub workspace_concurrency: u32,
}

impl AiConfig {
    /// From the environment. Inconsistent settings are pushed to `problems`
    /// (the start fails with them), as `config.rs` does for every setting.
    pub fn from_lookup(lookup: &impl Fn(&str) -> Option<String>, problems: &mut Vec<String>) -> Self {
        let _ = (lookup, problems);
        todo!("AI-012 phase 1")
    }

    /// The region of a provider on this install.
    pub fn region(&self, provider: ProviderId) -> Region {
        match provider {
            ProviderId::Mistral => Region::Eu,
            ProviderId::Anthropic | ProviderId::OpenAi => Region::OutsideEu,
            ProviderId::Compat => self.compat.as_ref().map_or(Region::Eu, |c| c.region),
        }
    }

    /// `/config.json`'s `ai` block: `{ defaultProvider, providers: [{ id,
    /// region, keySources }] }`, or `None` when AI is off.
    pub fn describe(&self) -> Option<serde_json::Value> {
        todo!("AI-012 phase 1")
    }
}
