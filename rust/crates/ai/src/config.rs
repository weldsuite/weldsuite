//! The install's AI configuration (Helm `config.ai`, `docs/plans/eu-ai-mistral.md`
//! "Install configuration"), read from the environment at start. The
//! TypeScript workers have no twin: Global configures `@weldsuite/ai` with the
//! Cloudflare gateway's settings (`packages/core/ai/src/config.ts`).
//!
//! | Env | Meaning |
//! |---|---|
//! | `AI_DEFAULT_PROVIDER` | `mistral`, `compat`, or empty: AI off (`compat` when `AI_COMPAT_BASE_URL` is set) |
//! | `AI_MISTRAL_BASE_URL`, `MISTRAL_API_KEY` | Mistral (default `https://api.mistral.ai/v1`) |
//! | `AI_ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` | WeldSuite's EU-edition Anthropic account (optional; default `https://api.anthropic.com`) |
//! | `AI_OPENAI_BASE_URL`, `OPENAI_API_KEY` | WeldSuite's EU-edition `OpenAI` account (optional; default `https://api.openai.com/v1`) |
//! | `AI_OPTIN_ANTHROPIC`, `AI_OPTIN_OPENAI` | Key sources workspaces may use: `weldsuite,own`, `own`, … or empty (not offered) |
//! | `AI_COMPAT_BASE_URL`, `AI_COMPAT_API_KEY`, `AI_COMPAT_REGION`, `AI_COMPAT_MODEL`, `AI_COMPAT_EMBED_MODEL` | A self-hosted install's OpenAI-compatible endpoint |
//! | `AI_FALLBACK_MODEL` | An EU model the install provider falls back to; a non-EU one is a problem |
//! | `AI_CREDIT_GATE` | `true`: the 402 gate (AI-007) |
//! | `AI_BILLING` | `credits` (default) or `display` (self-hosted: meter, never charge) |
//! | `AI_KEYS_ENCRYPTION_KEY` | 64 hex characters; seals workspaces' own keys |
//! | `AI_WORKSPACE_CONCURRENCY` | Calls one workspace may have in flight on WeldSuite's keys (default 4) |
//!
//! Every inconsistent setting is a problem, so the start fails and names it
//! instead of an AI feature failing on its first call: a provider that
//! doesn't exist, an install provider without its key or endpoint, a key
//! source a provider can't serve, a fallback outside the EU.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::catalog::{KeySource, ProviderId, Region};

/// Mistral's API, the EU edition's install provider.
pub const MISTRAL_BASE_URL: &str = "https://api.mistral.ai/v1";
/// Anthropic's Messages API (`<base>/v1/messages`).
pub const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
/// `OpenAI`'s API.
pub const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
/// `AI_WORKSPACE_CONCURRENCY` unset.
pub const DEFAULT_WORKSPACE_CONCURRENCY: u32 = 4;

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
    /// The chat model it serves (every chat task), as the endpoint names it
    /// (without the `compat/` prefix of its canonical id).
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

#[derive(Clone, Default)]
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
    /// An EU model id the install provider falls back to: `mistral/<id>` or
    /// `compat/<AI_COMPAT_MODEL>`.
    pub fallback_model: Option<String>,
    pub credit_gate: bool,
    pub billing: BillingMode,
    /// `AI_KEYS_ENCRYPTION_KEY`, decoded.
    pub keys_encryption_key: Option<[u8; 32]>,
    pub workspace_concurrency: u32,
}

/// Every field but the keys, which show only whether they are set.
impl std::fmt::Debug for AiConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AiConfig")
            .field("default_provider", &self.default_provider)
            .field("mistral", &self.mistral)
            .field("anthropic", &self.anthropic)
            .field("openai", &self.openai)
            .field("compat", &self.compat)
            .field("opt_in", &self.opt_in)
            .field("fallback_model", &self.fallback_model)
            .field("credit_gate", &self.credit_gate)
            .field("billing", &self.billing)
            .field(
                "keys_encryption_key",
                &self.keys_encryption_key.as_ref().map(|_| "<set>"),
            )
            .field("workspace_concurrency", &self.workspace_concurrency)
            .finish()
    }
}

/// `name`'s value, trimmed; blank is unset (as the chart writes an empty value).
fn read(lookup: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    lookup(name)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// A base URL without its trailing slash, so paths join with one.
fn base_url(lookup: &impl Fn(&str) -> Option<String>, name: &str, default: &str) -> String {
    read(lookup, name)
        .as_deref()
        .unwrap_or(default)
        .trim_end_matches('/')
        .to_owned()
}

/// 64 hex characters as 32 bytes.
fn decode_key(hex: &str) -> Option<[u8; 32]> {
    let bytes = hex.as_bytes();
    if bytes.len() != 64 {
        return None;
    }
    let nibble = |c: u8| {
        char::from(c)
            .to_digit(16)
            .and_then(|d| u8::try_from(d).ok())
    };
    let mut key = [0_u8; 32];
    let (pairs, _) = bytes.as_chunks::<2>();
    for (slot, [high, low]) in key.iter_mut().zip(pairs) {
        *slot = nibble(*high)? << 4 | nibble(*low)?;
    }
    Some(key)
}

fn flag(lookup: &impl Fn(&str) -> Option<String>, name: &str, problems: &mut Vec<String>) -> bool {
    match read(lookup, name).as_deref() {
        None | Some("false") => false,
        Some("true") => true,
        Some(_) => {
            problems.push(format!("{name} must be true or false"));
            false
        }
    }
}

impl CompatEndpoint {
    /// `AI_COMPAT_*`: the endpoint when its base URL and model are set.
    fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        problems: &mut Vec<String>,
    ) -> Option<Self> {
        let region = match read(lookup, "AI_COMPAT_REGION").as_deref() {
            None | Some("eu") => Region::Eu,
            Some("outside-eu") => Region::OutsideEu,
            Some(_) => {
                problems.push("AI_COMPAT_REGION must be eu or outside-eu".to_owned());
                Region::Eu
            }
        };
        let model = read(lookup, "AI_COMPAT_MODEL")
            .map(|model| model.strip_prefix("compat/").unwrap_or(&model).to_owned());
        match (read(lookup, "AI_COMPAT_BASE_URL"), model) {
            (Some(_), Some(model)) => Some(Self {
                endpoint: Endpoint {
                    base_url: base_url(lookup, "AI_COMPAT_BASE_URL", ""),
                    api_key: read(lookup, "AI_COMPAT_API_KEY"),
                },
                region,
                model,
                embed_model: read(lookup, "AI_COMPAT_EMBED_MODEL"),
            }),
            (Some(_), None) => {
                problems.push(
                    "AI_COMPAT_BASE_URL needs AI_COMPAT_MODEL, the chat model the endpoint serves"
                        .to_owned(),
                );
                None
            }
            (None, model) => {
                if model.is_some() || read(lookup, "AI_COMPAT_EMBED_MODEL").is_some() {
                    problems.push(
                        "AI_COMPAT_MODEL and AI_COMPAT_EMBED_MODEL need AI_COMPAT_BASE_URL"
                            .to_owned(),
                    );
                }
                None
            }
        }
    }
}

impl AiConfig {
    /// From the environment. Inconsistent settings are pushed to `problems`
    /// (the start fails with them), as `config.rs` does for every setting.
    #[allow(
        clippy::too_many_lines,
        reason = "one variable after the other, as the binary's Config::from_lookup"
    )]
    pub fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        problems: &mut Vec<String>,
    ) -> Self {
        let endpoint = |url: &str, default: &str, key: &str| Endpoint {
            base_url: base_url(lookup, url, default),
            api_key: read(lookup, key),
        };
        let mistral = endpoint("AI_MISTRAL_BASE_URL", MISTRAL_BASE_URL, "MISTRAL_API_KEY");
        let anthropic = endpoint(
            "AI_ANTHROPIC_BASE_URL",
            ANTHROPIC_BASE_URL,
            "ANTHROPIC_API_KEY",
        );
        let openai = endpoint("AI_OPENAI_BASE_URL", OPENAI_BASE_URL, "OPENAI_API_KEY");
        let compat = CompatEndpoint::from_lookup(lookup, problems);

        let encryption_key_raw = read(lookup, "AI_KEYS_ENCRYPTION_KEY");
        let keys_encryption_key = encryption_key_raw.as_deref().and_then(|raw| {
            let key = decode_key(raw);
            if key.is_none() {
                problems.push(
                    "AI_KEYS_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)"
                        .to_owned(),
                );
            }
            key
        });

        let default_provider = match read(lookup, "AI_DEFAULT_PROVIDER").as_deref() {
            // A self-hosted install's own endpoint is its default unless it
            // names another.
            None => compat.as_ref().map(|_| ProviderId::Compat),
            Some("mistral") => Some(ProviderId::Mistral),
            Some("compat") => Some(ProviderId::Compat),
            Some(raw @ ("anthropic" | "openai")) => {
                problems.push(format!(
                    "AI_DEFAULT_PROVIDER must be mistral or compat: {raw} is outside the EU, a \
                     provider workspaces opt in to (AI_OPTIN_{})",
                    raw.to_uppercase()
                ));
                None
            }
            Some(raw) => {
                problems.push(format!(
                    "AI_DEFAULT_PROVIDER must be mistral, compat or empty (AI off), not {raw}"
                ));
                None
            }
        };
        match default_provider {
            Some(ProviderId::Mistral) if mistral.api_key.is_none() => {
                problems.push("AI_DEFAULT_PROVIDER=mistral needs MISTRAL_API_KEY".to_owned());
            }
            Some(ProviderId::Compat) if compat.is_none() => problems.push(
                "AI_DEFAULT_PROVIDER=compat needs AI_COMPAT_BASE_URL and AI_COMPAT_MODEL"
                    .to_owned(),
            ),
            _ => {}
        }

        let mut opt_in = BTreeMap::new();
        for (provider, name, endpoint, key_name) in [
            (
                ProviderId::Anthropic,
                "AI_OPTIN_ANTHROPIC",
                &anthropic,
                "ANTHROPIC_API_KEY",
            ),
            (
                ProviderId::OpenAi,
                "AI_OPTIN_OPENAI",
                &openai,
                "OPENAI_API_KEY",
            ),
        ] {
            let Some(raw) = read(lookup, name) else {
                continue;
            };
            let mut sources = KeySources::default();
            for source in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                match source {
                    "weldsuite" => sources.weldsuite = true,
                    "own" => sources.own = true,
                    // The chart writes `none` for a provider it offers with no key.
                    "none" => {}
                    other => problems.push(format!(
                        "{name}: {other} is not a key source (weldsuite, own)"
                    )),
                }
            }
            if !sources.any() {
                continue;
            }
            if sources.weldsuite && endpoint.api_key.is_none() {
                problems.push(format!(
                    "{name} offers WeldSuite's key, which needs {key_name}"
                ));
            }
            if sources.own && encryption_key_raw.is_none() {
                problems.push(format!(
                    "{name} offers workspaces' own keys, which need AI_KEYS_ENCRYPTION_KEY to seal them"
                ));
            }
            if default_provider.is_none() {
                problems.push(format!(
                    "{name} needs an install provider (AI_DEFAULT_PROVIDER): an opted-in provider falls back to it"
                ));
            }
            opt_in.insert(provider, sources);
        }

        let fallback_model = match read(lookup, "AI_FALLBACK_MODEL") {
            None => None,
            Some(raw) if raw.eq_ignore_ascii_case("none") => None,
            Some(raw) => {
                if default_provider.is_none() {
                    problems.push(
                        "AI_FALLBACK_MODEL needs an install provider (AI_DEFAULT_PROVIDER)"
                            .to_owned(),
                    );
                }
                eu_fallback(&raw, &mistral, compat.as_ref(), problems)
            }
        };

        let billing = match read(lookup, "AI_BILLING").as_deref() {
            None | Some("credits") => BillingMode::Credits,
            Some("display") => BillingMode::Display,
            Some(_) => {
                problems.push("AI_BILLING must be credits or display".to_owned());
                BillingMode::Credits
            }
        };
        let workspace_concurrency = match read(lookup, "AI_WORKSPACE_CONCURRENCY") {
            None => DEFAULT_WORKSPACE_CONCURRENCY,
            Some(raw) => match raw.parse::<u32>() {
                Ok(n) if n > 0 => n,
                _ => {
                    problems
                        .push("AI_WORKSPACE_CONCURRENCY must be a whole number above 0".to_owned());
                    DEFAULT_WORKSPACE_CONCURRENCY
                }
            },
        };

        Self {
            default_provider,
            mistral,
            anthropic,
            openai,
            compat,
            opt_in,
            fallback_model,
            credit_gate: flag(lookup, "AI_CREDIT_GATE", problems),
            billing,
            keys_encryption_key,
            workspace_concurrency,
        }
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
    /// region, keySources }] }`, or `None` when AI is off. The install
    /// provider comes first and runs on the install's key (`weldsuite`); the
    /// opt-in providers follow with the key sources a workspace may pick.
    pub fn describe(&self) -> Option<Value> {
        let install = self.default_provider?;
        let mut providers = vec![json!({
            "id": install.as_str(),
            "region": self.region(install).as_str(),
            "keySources": [KeySource::Weldsuite.as_str()],
        })];
        for (provider, sources) in &self.opt_in {
            let key_sources: Vec<&str> = [KeySource::Weldsuite, KeySource::Own]
                .into_iter()
                .filter(|source| sources.allows(*source))
                .map(KeySource::as_str)
                .collect();
            if *provider == install || key_sources.is_empty() {
                continue;
            }
            providers.push(json!({
                "id": provider.as_str(),
                "region": self.region(*provider).as_str(),
                "keySources": key_sources,
            }));
        }
        Some(json!({
            "defaultProvider": install.as_str(),
            "providers": providers,
        }))
    }
}

/// `AI_FALLBACK_MODEL` as a canonical EU model id: `mistral/<id>` (with
/// Mistral's key), or the compat endpoint's model when its region is `eu`.
/// Anything else is a problem: fallback never leaves the EU.
fn eu_fallback(
    raw: &str,
    mistral: &Endpoint,
    compat: Option<&CompatEndpoint>,
    problems: &mut Vec<String>,
) -> Option<String> {
    if let Some(model) = raw.strip_prefix("mistral/")
        && !model.is_empty()
    {
        if mistral.api_key.is_none() {
            problems.push(format!("AI_FALLBACK_MODEL {raw} needs MISTRAL_API_KEY"));
        }
        return Some(raw.to_owned());
    }
    let named = raw.strip_prefix("compat/").unwrap_or(raw);
    match compat {
        Some(compat) if compat.model == named && compat.region == Region::Eu => {
            return Some(format!("compat/{named}"));
        }
        Some(compat) if compat.model == named => problems.push(format!(
            "AI_FALLBACK_MODEL must be an EU model: {raw} is on the compat endpoint, whose \
             AI_COMPAT_REGION is outside-eu"
        )),
        _ => problems.push(format!(
            "AI_FALLBACK_MODEL must be an EU model: mistral/<model>, or the compat endpoint's \
             AI_COMPAT_MODEL with AI_COMPAT_REGION=eu; {raw} is neither"
        )),
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn read(vars: &[(&str, &str)]) -> (AiConfig, Vec<String>) {
        let lookup = |name: &str| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        };
        let mut problems = Vec::new();
        let config = AiConfig::from_lookup(&lookup, &mut problems);
        (config, problems)
    }

    fn valid(vars: &[(&str, &str)]) -> AiConfig {
        let (config, problems) = read(vars);
        assert!(problems.is_empty(), "{problems:?}");
        config
    }

    fn problems_in(vars: &[(&str, &str)]) -> Vec<String> {
        read(vars).1
    }

    #[test]
    fn ai_is_off_by_default() {
        let config = valid(&[]);
        assert_eq!(config.default_provider, None);
        assert_eq!(config.describe(), None);
        assert_eq!(config.mistral.base_url, MISTRAL_BASE_URL);
        assert_eq!(config.anthropic.base_url, ANTHROPIC_BASE_URL);
        assert_eq!(config.openai.base_url, OPENAI_BASE_URL);
        assert!(config.compat.is_none());
        assert!(config.opt_in.is_empty());
        assert_eq!(config.fallback_model, None);
        assert!(!config.credit_gate);
        assert_eq!(config.billing, BillingMode::Credits);
        assert_eq!(config.keys_encryption_key, None);
        assert_eq!(config.workspace_concurrency, 4);
        // Blank values are unset, as the chart writes them.
        let blank = valid(&[("AI_DEFAULT_PROVIDER", " "), ("AI_OPTIN_OPENAI", "")]);
        assert_eq!(blank.default_provider, None);
    }

    #[test]
    fn the_eu_edition_on_mistral_with_both_opt_ins() {
        let config = valid(&[
            ("AI_DEFAULT_PROVIDER", "mistral"),
            ("MISTRAL_API_KEY", "mk-1"),
            ("AI_MISTRAL_BASE_URL", "https://api.mistral.ai/v1/"),
            ("ANTHROPIC_API_KEY", "sk-ant-1"),
            ("AI_OPTIN_ANTHROPIC", "weldsuite, own"),
            ("AI_OPTIN_OPENAI", "own"),
            ("AI_KEYS_ENCRYPTION_KEY", KEY_HEX),
            ("AI_FALLBACK_MODEL", "mistral/mistral-small-2506"),
            ("AI_CREDIT_GATE", "true"),
            ("AI_WORKSPACE_CONCURRENCY", "8"),
        ]);
        assert_eq!(config.default_provider, Some(ProviderId::Mistral));
        assert_eq!(config.mistral.base_url, MISTRAL_BASE_URL, "trailing slash");
        assert_eq!(config.mistral.api_key.as_deref(), Some("mk-1"));
        assert_eq!(
            config.opt_in.get(&ProviderId::Anthropic),
            Some(&KeySources {
                weldsuite: true,
                own: true
            })
        );
        assert_eq!(
            config.opt_in.get(&ProviderId::OpenAi),
            Some(&KeySources {
                weldsuite: false,
                own: true
            })
        );
        assert_eq!(
            config.fallback_model.as_deref(),
            Some("mistral/mistral-small-2506")
        );
        assert!(config.credit_gate);
        assert_eq!(config.workspace_concurrency, 8);
        let key = config.keys_encryption_key.expect("key");
        assert_eq!((key[0], key[1], key[31]), (0, 1, 0x1f));
        assert_eq!(
            config.describe(),
            Some(json!({
                "defaultProvider": "mistral",
                "providers": [
                    { "id": "mistral", "region": "eu", "keySources": ["weldsuite"] },
                    { "id": "anthropic", "region": "outside-eu", "keySources": ["weldsuite", "own"] },
                    { "id": "openai", "region": "outside-eu", "keySources": ["own"] },
                ],
            }))
        );
    }

    #[test]
    fn keys_stay_out_of_debug() {
        let config = valid(&[
            ("AI_DEFAULT_PROVIDER", "mistral"),
            ("MISTRAL_API_KEY", "mk-secret"),
            ("AI_KEYS_ENCRYPTION_KEY", KEY_HEX),
        ]);
        let debug = format!("{config:?}");
        assert!(!debug.contains("mk-secret"), "{debug}");
        assert!(!debug.contains("[0, 1, 2"), "{debug}");
        assert!(debug.contains("<set>"), "{debug}");
    }

    #[test]
    fn the_install_provider_needs_its_key_or_endpoint() {
        let mistral = problems_in(&[("AI_DEFAULT_PROVIDER", "mistral")]);
        assert_eq!(
            mistral,
            ["AI_DEFAULT_PROVIDER=mistral needs MISTRAL_API_KEY"]
        );
        let compat = problems_in(&[("AI_DEFAULT_PROVIDER", "compat")]);
        assert_eq!(
            compat,
            ["AI_DEFAULT_PROVIDER=compat needs AI_COMPAT_BASE_URL and AI_COMPAT_MODEL"]
        );
    }

    #[test]
    fn refuses_unknown_and_non_eu_install_providers() {
        let unknown = problems_in(&[("AI_DEFAULT_PROVIDER", "gemini")]);
        assert_eq!(unknown.len(), 1, "{unknown:?}");
        assert!(
            unknown[0].contains("mistral, compat or empty"),
            "{unknown:?}"
        );
        for outside in ["anthropic", "openai"] {
            let problems = problems_in(&[
                ("AI_DEFAULT_PROVIDER", outside),
                ("ANTHROPIC_API_KEY", "k"),
                ("OPENAI_API_KEY", "k"),
            ]);
            assert_eq!(problems.len(), 1, "{problems:?}");
            assert!(problems[0].contains("outside the EU"), "{problems:?}");
            assert!(problems[0].contains("AI_OPTIN_"), "{problems:?}");
        }
    }

    #[test]
    fn a_self_hosted_endpoint_is_the_default_when_set() {
        let config = valid(&[
            ("AI_COMPAT_BASE_URL", "http://vllm.ai.svc:8000/v1/"),
            ("AI_COMPAT_MODEL", "meta-llama/Llama-3.3-70B-Instruct"),
            ("AI_COMPAT_EMBED_MODEL", "BAAI/bge-m3"),
            ("AI_FALLBACK_MODEL", "meta-llama/Llama-3.3-70B-Instruct"),
        ]);
        assert_eq!(config.default_provider, Some(ProviderId::Compat));
        let compat = config.compat.as_ref().expect("compat");
        assert_eq!(compat.endpoint.base_url, "http://vllm.ai.svc:8000/v1");
        assert_eq!(compat.endpoint.api_key, None);
        assert_eq!(compat.region, Region::Eu);
        assert_eq!(compat.embed_model.as_deref(), Some("BAAI/bge-m3"));
        assert_eq!(
            config.fallback_model.as_deref(),
            Some("compat/meta-llama/Llama-3.3-70B-Instruct"),
            "the canonical id"
        );
        assert_eq!(
            config.describe(),
            Some(json!({
                "defaultProvider": "compat",
                "providers": [{ "id": "compat", "region": "eu", "keySources": ["weldsuite"] }],
            }))
        );

        // An endpoint outside the EU says so, and Mistral stays the default
        // when the install names it.
        let outside = valid(&[
            ("AI_DEFAULT_PROVIDER", "mistral"),
            ("MISTRAL_API_KEY", "mk"),
            (
                "AI_COMPAT_BASE_URL",
                "https://example.openai.azure.com/openai/v1",
            ),
            ("AI_COMPAT_MODEL", "compat/gpt-5-mini"),
            ("AI_COMPAT_REGION", "outside-eu"),
            ("AI_COMPAT_API_KEY", "azure-key"),
        ]);
        assert_eq!(outside.default_provider, Some(ProviderId::Mistral));
        assert_eq!(outside.region(ProviderId::Compat), Region::OutsideEu);
        assert_eq!(
            outside.compat.map(|c| c.model).as_deref(),
            Some("gpt-5-mini")
        );
    }

    #[test]
    fn an_incomplete_endpoint_is_a_problem() {
        assert_eq!(
            problems_in(&[("AI_COMPAT_BASE_URL", "http://ollama:11434/v1")]),
            ["AI_COMPAT_BASE_URL needs AI_COMPAT_MODEL, the chat model the endpoint serves"]
        );
        assert_eq!(
            problems_in(&[("AI_COMPAT_MODEL", "llama3.3")]),
            ["AI_COMPAT_MODEL and AI_COMPAT_EMBED_MODEL need AI_COMPAT_BASE_URL"]
        );
        let region = problems_in(&[
            ("AI_COMPAT_BASE_URL", "http://ollama:11434/v1"),
            ("AI_COMPAT_MODEL", "llama3.3"),
            ("AI_COMPAT_REGION", "us"),
        ]);
        assert_eq!(region, ["AI_COMPAT_REGION must be eu or outside-eu"]);
    }

    #[test]
    fn fallback_never_leaves_the_eu() {
        let base = [
            ("AI_DEFAULT_PROVIDER", "mistral"),
            ("MISTRAL_API_KEY", "mk"),
        ];
        let with = |fallback: &'static str| {
            let mut vars = base.to_vec();
            vars.push(("AI_FALLBACK_MODEL", fallback));
            read(&vars)
        };
        for none in ["none", "NONE", ""] {
            let (config, problems) = with(none);
            assert!(problems.is_empty(), "{problems:?}");
            assert_eq!(config.fallback_model, None, "{none}");
        }
        for outside in [
            "anthropic/claude-sonnet-5-5",
            "openai/gpt-5",
            "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            "mistral/",
        ] {
            let (config, problems) = with(outside);
            assert_eq!(problems.len(), 1, "{outside}: {problems:?}");
            assert!(problems[0].contains("must be an EU model"), "{problems:?}");
            assert_eq!(config.fallback_model, None);
        }

        // The compat endpoint's model, only when it is in the EU.
        let mut vars = base.to_vec();
        vars.extend([
            (
                "AI_COMPAT_BASE_URL",
                "https://example.openai.azure.com/openai/v1",
            ),
            ("AI_COMPAT_MODEL", "gpt-5-mini"),
            ("AI_COMPAT_REGION", "outside-eu"),
            ("AI_FALLBACK_MODEL", "compat/gpt-5-mini"),
        ]);
        let problems = read(&vars).1;
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(problems[0].contains("outside-eu"), "{problems:?}");

        // Mistral as the fallback of a compat install needs Mistral's key.
        let problems = problems_in(&[
            ("AI_COMPAT_BASE_URL", "http://vllm:8000/v1"),
            ("AI_COMPAT_MODEL", "qwen"),
            ("AI_FALLBACK_MODEL", "mistral/mistral-small-2506"),
        ]);
        assert_eq!(
            problems,
            ["AI_FALLBACK_MODEL mistral/mistral-small-2506 needs MISTRAL_API_KEY"]
        );

        // A fallback with AI off has nothing to fall back from.
        let problems = problems_in(&[
            ("MISTRAL_API_KEY", "mk"),
            ("AI_FALLBACK_MODEL", "mistral/mistral-small-2506"),
        ]);
        assert_eq!(
            problems,
            ["AI_FALLBACK_MODEL needs an install provider (AI_DEFAULT_PROVIDER)"]
        );
    }

    #[test]
    fn an_opt_in_needs_the_keys_it_offers() {
        let base = [
            ("AI_DEFAULT_PROVIDER", "mistral"),
            ("MISTRAL_API_KEY", "mk"),
        ];
        let with = |extra: &[(&'static str, &'static str)]| {
            let mut vars = base.to_vec();
            vars.extend_from_slice(extra);
            read(&vars)
        };
        let (_, problems) = with(&[("AI_OPTIN_ANTHROPIC", "weldsuite")]);
        assert_eq!(
            problems,
            ["AI_OPTIN_ANTHROPIC offers WeldSuite's key, which needs ANTHROPIC_API_KEY"]
        );
        let (_, problems) = with(&[("AI_OPTIN_OPENAI", "own")]);
        assert_eq!(
            problems,
            [
                "AI_OPTIN_OPENAI offers workspaces' own keys, which need AI_KEYS_ENCRYPTION_KEY to seal them"
            ]
        );
        let (_, problems) = with(&[("AI_OPTIN_OPENAI", "weldsuite,byok")]);
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(
            problems[0].contains("byok is not a key source"),
            "{problems:?}"
        );
        // `none` offers nothing, and an empty list is no opt-in.
        let (config, problems) = with(&[("AI_OPTIN_ANTHROPIC", "none")]);
        assert!(problems.is_empty(), "{problems:?}");
        assert!(config.opt_in.is_empty());
        // Without an install provider there is nothing to fall back to.
        let problems = problems_in(&[("AI_OPTIN_OPENAI", "weldsuite"), ("OPENAI_API_KEY", "sk")]);
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(
            problems[0].contains("needs an install provider"),
            "{problems:?}"
        );
    }

    #[test]
    fn the_encryption_key_is_64_hex_characters() {
        for bad in [
            &KEY_HEX[..62],
            "zz02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        ] {
            let (config, problems) = read(&[("AI_KEYS_ENCRYPTION_KEY", bad)]);
            assert_eq!(
                problems,
                ["AI_KEYS_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)"]
            );
            assert_eq!(config.keys_encryption_key, None);
        }
        // A malformed key is named once, not again by the opt-in that needs it.
        let problems = problems_in(&[
            ("AI_DEFAULT_PROVIDER", "mistral"),
            ("MISTRAL_API_KEY", "mk"),
            ("AI_OPTIN_ANTHROPIC", "own"),
            ("AI_KEYS_ENCRYPTION_KEY", "short"),
        ]);
        assert_eq!(problems.len(), 1, "{problems:?}");
        let upper = valid(&[("AI_KEYS_ENCRYPTION_KEY", &KEY_HEX.to_uppercase())]);
        assert_eq!(upper.keys_encryption_key.map(|k| k[10]), Some(0x0a));
    }

    #[test]
    fn billing_gate_and_concurrency() {
        let display = valid(&[("AI_BILLING", "display"), ("AI_CREDIT_GATE", "false")]);
        assert_eq!(display.billing, BillingMode::Display);
        assert!(!display.credit_gate);
        let problems = problems_in(&[
            ("AI_BILLING", "free"),
            ("AI_CREDIT_GATE", "yes"),
            ("AI_WORKSPACE_CONCURRENCY", "0"),
        ]);
        assert_eq!(
            problems,
            [
                "AI_BILLING must be credits or display",
                "AI_WORKSPACE_CONCURRENCY must be a whole number above 0",
                "AI_CREDIT_GATE must be true or false",
            ]
        );
        assert_eq!(
            problems_in(&[("AI_WORKSPACE_CONCURRENCY", "four")]).len(),
            1
        );
    }

    #[test]
    fn regions_come_from_the_catalog_and_the_endpoint() {
        let config = valid(&[]);
        assert_eq!(config.region(ProviderId::Mistral), Region::Eu);
        assert_eq!(config.region(ProviderId::Anthropic), Region::OutsideEu);
        assert_eq!(config.region(ProviderId::OpenAi), Region::OutsideEu);
        assert_eq!(config.region(ProviderId::Compat), Region::Eu);
    }
}
