//! The AI catalog (AI-006, one source of truth): providers with their region,
//! models with capabilities and prices, each provider's task map, and the
//! features an admin can route. Source: `packages/core/ai/src/catalog.ts` (and
//! the rate table of `billing-rates.ts`), exported to `rust/catalogs/ai.json`
//! by `pnpm rust:catalogs`.
//!
//! The enums below name what call sites use; a test checks they match the
//! JSON both ways.

use std::collections::{BTreeMap, HashSet};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};

/// A provider. Its region comes from the catalog, never from a workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderId {
    /// The EU edition's install provider.
    Mistral,
    /// Opt-in, outside the EU.
    Anthropic,
    /// Opt-in, outside the EU.
    #[serde(rename = "openai")]
    OpenAi,
    /// A self-hosted install's own OpenAI-compatible endpoint (vLLM, Ollama,
    /// Azure); its region is the install's `AI_COMPAT_REGION`.
    Compat,
}

impl ProviderId {
    pub const ALL: [Self; 4] = [Self::Mistral, Self::Anthropic, Self::OpenAi, Self::Compat];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mistral => "mistral",
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::Compat => "compat",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.as_str() == raw)
    }

    /// Providers a workspace admin may enable (the install provider is always on).
    pub fn opt_in(self) -> bool {
        matches!(self, Self::Anthropic | Self::OpenAi)
    }

    /// The API the backend speaks to it.
    pub fn api(self) -> Api {
        provider(self).api
    }
}

/// Where a provider processes data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Region {
    Eu,
    OutsideEu,
}

impl Region {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Eu => "eu",
            Self::OutsideEu => "outside-eu",
        }
    }

    /// `eu` or `outside-eu` (`AI_COMPAT_REGION`).
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "eu" => Some(Self::Eu),
            "outside-eu" => Some(Self::OutsideEu),
            _ => None,
        }
    }
}

/// Whose key pays for a non-EU provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum KeySource {
    /// WeldSuite's account: charged as credits.
    #[default]
    Weldsuite,
    /// The workspace's own key: counted, not charged.
    Own,
}

impl KeySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Weldsuite => "weldsuite",
            Self::Own => "own",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "weldsuite" => Some(Self::Weldsuite),
            "own" => Some(Self::Own),
            _ => None,
        }
    }
}

/// The tasks of `recommended` in `packages/core/ai/src/models.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Task {
    Classify,
    Evaluate,
    Sentiment,
    Summarize,
    Translate,
    Draft,
    Copilot,
    Embed,
    Rerank,
    Transcribe,
    Ocr,
}

impl Task {
    /// In `recommended`'s order.
    pub const ALL: [Self; 11] = [
        Self::Classify,
        Self::Evaluate,
        Self::Sentiment,
        Self::Summarize,
        Self::Translate,
        Self::Draft,
        Self::Copilot,
        Self::Embed,
        Self::Rerank,
        Self::Transcribe,
        Self::Ocr,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Classify => "classify",
            Self::Evaluate => "evaluate",
            Self::Sentiment => "sentiment",
            Self::Summarize => "summarize",
            Self::Translate => "translate",
            Self::Draft => "draft",
            Self::Copilot => "copilot",
            Self::Embed => "embed",
            Self::Rerank => "rerank",
            Self::Transcribe => "transcribe",
            Self::Ocr => "ocr",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.as_str() == raw)
    }

    /// A chat completion (every task but embeddings, reranking,
    /// transcription and OCR).
    pub fn is_chat(self) -> bool {
        !matches!(
            self,
            Self::Embed | Self::Rerank | Self::Transcribe | Self::Ocr
        )
    }

    /// Served only by the install provider, whatever a workspace chose:
    /// embeddings (vectors of two models can't share an index) and speech to
    /// text (Mistral only).
    pub fn install_only(self) -> bool {
        matches!(self, Self::Embed | Self::Transcribe)
    }
}

/// `free` or `quality`, as in `recommended`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tier {
    Free,
    Quality,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Quality => "quality",
        }
    }
}

/// What a model can do; a feature lists what it needs. Every chat model
/// streams, so the chat tasks need [`Capability::Stream`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Tools,
    JsonSchema,
    FileInput,
    Vision,
    Stream,
    Embed,
    Stt,
    Ocr,
    /// Drives a desktop from screenshots: WeldAgent's `computer_use` tool in
    /// the sandbox (`weldsuite-sandbox`) is offered only to a model with it.
    ComputerUse,
}

impl Capability {
    pub const ALL: [Self; 9] = [
        Self::Tools,
        Self::JsonSchema,
        Self::FileInput,
        Self::Vision,
        Self::Stream,
        Self::Embed,
        Self::Stt,
        Self::Ocr,
        Self::ComputerUse,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tools => "tools",
            Self::JsonSchema => "json_schema",
            Self::FileInput => "file_input",
            Self::Vision => "vision",
            Self::Stream => "stream",
            Self::Embed => "embed",
            Self::Stt => "stt",
            Self::Ocr => "ocr",
            Self::ComputerUse => "computer_use",
        }
    }
}

/// The unit an admin can route, and the `op` on each credit charge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Feature {
    Mail,
    DeskTranslate,
    Forms,
    Board,
    Connect,
    BooksOcr,
    Files,
    Data,
    Search,
    Reach,
    Merge,
    Meet,
    Assistant,
    Agents,
    /// Fixed: vectors from two models can't share an index.
    SearchIndex,
    /// Fixed: a system job with no customer content.
    ReachWarmup,
    /// Fixed: WeldSuite's own outbound abuse control stays in the EU.
    MailReview,
}

impl Feature {
    pub const ALL: [Self; 17] = [
        Self::Mail,
        Self::DeskTranslate,
        Self::Forms,
        Self::Board,
        Self::Connect,
        Self::BooksOcr,
        Self::Files,
        Self::Data,
        Self::Search,
        Self::Reach,
        Self::Merge,
        Self::Meet,
        Self::Assistant,
        Self::Agents,
        Self::SearchIndex,
        Self::ReachWarmup,
        Self::MailReview,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mail => "mail",
            Self::DeskTranslate => "desk-translate",
            Self::Forms => "forms",
            Self::Board => "board",
            Self::Connect => "connect",
            Self::BooksOcr => "books-ocr",
            Self::Files => "files",
            Self::Data => "data",
            Self::Search => "search",
            Self::Reach => "reach",
            Self::Merge => "merge",
            Self::Meet => "meet",
            Self::Assistant => "assistant",
            Self::Agents => "agents",
            Self::SearchIndex => "search-index",
            Self::ReachWarmup => "reach-warmup",
            Self::MailReview => "mail-review",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.as_str() == raw)
    }

    /// Whether an admin may move this feature off the install provider.
    pub fn overridable(self) -> bool {
        !matches!(
            self,
            Self::SearchIndex | Self::ReachWarmup | Self::MailReview
        )
    }

    /// Its catalog entry.
    pub fn info(self) -> &'static FeatureInfo {
        feature(self)
    }
}

/// Whether a provider is the install's or one a workspace opts in to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Offered {
    Install,
    OptIn,
}

/// The API the backend speaks to a provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Api {
    /// Chat completions (`/chat/completions`), embeddings, transcription.
    OpenaiCompatible,
    /// The Messages API (`/v1/messages`).
    Anthropic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: ProviderId,
    pub label: String,
    /// `None`: set by the install (`compat`).
    pub region: Option<Region>,
    pub offered: Offered,
    pub api: Api,
    /// The default base URL; `None`: the install's.
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// Canonical id, with the provider prefix.
    pub id: String,
    pub provider: ProviderId,
    pub label: String,
    pub capabilities: Vec<Capability>,
    /// Context window in tokens.
    pub context: Option<u64>,
    /// The provider's retirement date: still callable, left out of pickers.
    pub retires: Option<String>,
}

impl ModelInfo {
    pub fn has(&self, capability: Capability) -> bool {
        self.capabilities.contains(&capability)
    }

    pub fn has_all(&self, needs: &[Capability]) -> bool {
        needs.iter().all(|need| self.has(*need))
    }

    /// The id the provider knows it by (the canonical id without its prefix).
    pub fn native_id(&self) -> &str {
        native_model_id(&self.id)
    }
}

/// A task's models at each tier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskModels {
    pub free: String,
    pub quality: String,
}

impl TaskModels {
    pub fn get(&self, tier: Tier) -> &str {
        match tier {
            Tier::Free => &self.free,
            Tier::Quality => &self.quality,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureInfo {
    pub id: Feature,
    /// The first is the one its model picker is for.
    pub tasks: Vec<Task>,
    /// Besides its task's needs.
    pub needs: Vec<Capability>,
    pub overridable: bool,
}

/// `ModelPrice` (`billing-rates.ts`): USD per million tokens, per page or per
/// minute of audio.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub input_per_m: f64,
    pub output_per_m: f64,
    #[serde(default)]
    pub per_page: Option<f64>,
    #[serde(default)]
    pub per_page_annotated: Option<f64>,
    #[serde(default)]
    pub per_minute: Option<f64>,
}

/// `rust/catalogs/ai.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub tasks: Vec<Task>,
    pub capabilities: Vec<Capability>,
    pub providers: Vec<ProviderInfo>,
    pub models: Vec<ModelInfo>,
    pub provider_tasks: BTreeMap<ProviderId, BTreeMap<Task, TaskModels>>,
    pub task_needs: BTreeMap<Task, Vec<Capability>>,
    pub compat_capabilities: Vec<Capability>,
    pub features: Vec<FeatureInfo>,
    pub prices: BTreeMap<String, Price>,
    pub default_price: Price,
    pub workers_ai_fallback_price: Price,
    pub provider_markup: f64,
    pub credits_per_usd: f64,
}

const CATALOG_JSON: &str = include_str!("../../../catalogs/ai.json");

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(CATALOG_JSON).unwrap_or_else(|error| {
        panic!("rust/catalogs/ai.json is invalid ({error}); run pnpm rust:catalogs")
    })
});

/// The whole catalog.
pub fn catalog() -> &'static Catalog {
    &CATALOG
}

/// Every model, in the catalog's order.
pub fn models() -> &'static [ModelInfo] {
    &CATALOG.models
}

/// A model by its canonical id.
pub fn model(id: &str) -> Option<&'static ModelInfo> {
    CATALOG.models.iter().find(|m| m.id == id)
}

/// A model by its canonical id, or by the id its provider knows it by
/// (`claude-sonnet-5-5`, `mistral-small-2603`).
pub fn find_model(id: &str) -> Option<&'static ModelInfo> {
    model(id).or_else(|| CATALOG.models.iter().find(|m| m.native_id() == id))
}

/// A provider's entry.
///
/// # Panics
///
/// When `rust/catalogs/ai.json` lacks the provider (a test checks it doesn't).
pub fn provider(id: ProviderId) -> &'static ProviderInfo {
    CATALOG
        .providers
        .iter()
        .find(|p| p.id == id)
        .unwrap_or_else(|| panic!("rust/catalogs/ai.json lacks provider {}", id.as_str()))
}

/// The model `provider` serves `task` with at `tier`; `None` when it doesn't
/// serve it (`compat`'s models come from the install, see `policy`).
pub fn task_model(provider: ProviderId, task: Task, tier: Tier) -> Option<&'static str> {
    CATALOG
        .provider_tasks
        .get(&provider)?
        .get(&task)
        .map(|models| models.get(tier))
}

/// A feature's entry.
///
/// # Panics
///
/// When `rust/catalogs/ai.json` lacks the feature (a test checks it doesn't).
pub fn feature(id: Feature) -> &'static FeatureInfo {
    CATALOG
        .features
        .iter()
        .find(|f| f.id == id)
        .unwrap_or_else(|| panic!("rust/catalogs/ai.json lacks feature {}", id.as_str()))
}

/// What a model needs to serve `task` for `feature` (`featureNeeds`).
pub fn needs(feature: Feature, task: Task) -> Vec<Capability> {
    let mut needs = self::feature(feature).needs.clone();
    for need in CATALOG.task_needs.get(&task).into_iter().flatten() {
        if !needs.contains(need) {
            needs.push(*need);
        }
    }
    needs
}

/// What an install's own OpenAI-compatible chat model is assumed to do.
pub fn compat_capabilities() -> &'static [Capability] {
    &CATALOG.compat_capabilities
}

/// `PROVIDER_MARKUP`.
pub fn provider_markup() -> f64 {
    CATALOG.provider_markup
}

/// `CREDITS_PER_USD`.
pub fn credits_per_usd() -> f64 {
    CATALOG.credits_per_usd
}

static WARNED_UNPRICED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

/// `priceForModel`: the published price of a canonical model id, or the
/// fallback (Workers AI's for `@cf/…`, Sonnet-class otherwise), warning once
/// per unknown id.
pub fn price(model: &str) -> Price {
    if let Some(price) = CATALOG.prices.get(model) {
        return *price;
    }
    let first = WARNED_UNPRICED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(model.to_owned());
    if first {
        tracing::warn!(
            model,
            "[weldsuite-ai] no published price for the model; billing at the fallback rate (add it to MODEL_PRICES in packages/core/ai/src/billing-rates.ts)"
        );
    }
    if model.starts_with("@cf/") {
        CATALOG.workers_ai_fallback_price
    } else {
        CATALOG.default_price
    }
}

/// `mistral/mistral-small-2603` → `(Mistral, "mistral-small-2603")`; `None`
/// without a known provider prefix.
pub fn split_model_id(id: &str) -> Option<(ProviderId, &str)> {
    let (prefix, native) = id.split_once('/')?;
    let provider = ProviderId::parse(prefix)?;
    (!native.is_empty()).then_some((provider, native))
}

/// The id a provider knows a canonical id by: the part after the first `/`.
pub fn native_model_id(id: &str) -> &str {
    id.split_once('/').map_or(id, |(_, native)| native)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw() -> serde_json::Value {
        serde_json::from_str(CATALOG_JSON).expect("json")
    }

    fn strings(value: &serde_json::Value) -> Vec<String> {
        value
            .as_array()
            .expect("array")
            .iter()
            .map(|v| v.as_str().expect("string").to_owned())
            .collect()
    }

    #[test]
    fn the_enums_match_the_json_both_ways() {
        let raw = raw();
        let tasks = strings(&raw["tasks"]);
        let expected: Vec<String> = Task::ALL.iter().map(|t| t.as_str().to_owned()).collect();
        assert_eq!(tasks, expected, "Task vs catalog.ts AI_TASKS");

        let capabilities = strings(&raw["capabilities"]);
        let expected: Vec<String> = Capability::ALL
            .iter()
            .map(|c| c.as_str().to_owned())
            .collect();
        assert_eq!(capabilities, expected, "Capability vs AI_CAPABILITIES");

        let providers: Vec<String> = raw["providers"]
            .as_array()
            .expect("providers")
            .iter()
            .map(|p| p["id"].as_str().expect("id").to_owned())
            .collect();
        let expected: Vec<String> = ProviderId::ALL
            .iter()
            .map(|p| p.as_str().to_owned())
            .collect();
        assert_eq!(providers, expected, "ProviderId vs AI_PROVIDERS");

        let features: Vec<String> = raw["features"]
            .as_array()
            .expect("features")
            .iter()
            .map(|f| f["id"].as_str().expect("id").to_owned())
            .collect();
        let expected: Vec<String> = Feature::ALL.iter().map(|f| f.as_str().to_owned()).collect();
        assert_eq!(features, expected, "Feature vs AI_FEATURES");

        // Serde names agree with as_str.
        for task in Task::ALL {
            assert_eq!(serde_json::to_value(task).expect("task"), task.as_str());
        }
        for capability in Capability::ALL {
            assert_eq!(
                serde_json::to_value(capability).expect("capability"),
                capability.as_str()
            );
        }
        for provider in ProviderId::ALL {
            assert_eq!(
                serde_json::to_value(provider).expect("provider"),
                provider.as_str()
            );
        }
        for feature in Feature::ALL {
            assert_eq!(
                serde_json::to_value(feature).expect("feature"),
                feature.as_str()
            );
            assert_eq!(feature.overridable(), feature.info().overridable);
        }
    }

    #[test]
    fn opt_in_and_regions_follow_the_catalog() {
        for id in ProviderId::ALL {
            let info = provider(id);
            assert_eq!(
                id.opt_in(),
                info.offered == Offered::OptIn,
                "{}",
                id.as_str()
            );
        }
        assert_eq!(provider(ProviderId::Mistral).region, Some(Region::Eu));
        assert_eq!(
            provider(ProviderId::Anthropic).region,
            Some(Region::OutsideEu)
        );
        assert_eq!(provider(ProviderId::OpenAi).region, Some(Region::OutsideEu));
        assert_eq!(provider(ProviderId::Compat).region, None);
        assert_eq!(ProviderId::Anthropic.api(), Api::Anthropic);
        assert_eq!(ProviderId::Mistral.api(), Api::OpenaiCompatible);
    }

    #[test]
    fn every_task_map_names_a_capable_model_of_its_provider() {
        for (provider, tasks) in &catalog().provider_tasks {
            for (task, models) in tasks {
                for tier in [Tier::Free, Tier::Quality] {
                    let id = models.get(tier);
                    let info = model(id).unwrap_or_else(|| panic!("{id} is not in the catalog"));
                    assert_eq!(info.provider, *provider, "{id}");
                    let needs = &catalog().task_needs[task];
                    assert!(info.has_all(needs), "{id} can't {}", task.as_str());
                    assert!(catalog().prices.contains_key(id), "{id} has no price");
                }
            }
        }
    }

    #[test]
    fn mistral_serves_every_task_but_rerank() {
        for task in Task::ALL {
            assert_eq!(
                task_model(ProviderId::Mistral, task, Tier::Quality).is_some(),
                task != Task::Rerank,
                "{}",
                task.as_str()
            );
        }
        assert_eq!(
            task_model(ProviderId::Mistral, Task::Embed, Tier::Free),
            Some("mistral/mistral-embed-2312")
        );
        assert_eq!(
            task_model(ProviderId::Anthropic, Task::Embed, Tier::Free),
            None
        );
        assert_eq!(
            task_model(ProviderId::OpenAi, Task::Transcribe, Tier::Free),
            None
        );
        assert_eq!(
            task_model(ProviderId::Compat, Task::Draft, Tier::Free),
            None
        );
    }

    #[test]
    fn needs_join_the_feature_and_the_task() {
        assert_eq!(
            needs(Feature::BooksOcr, Task::Ocr),
            vec![Capability::FileInput]
        );
        assert_eq!(
            needs(Feature::Mail, Task::Draft),
            vec![Capability::JsonSchema, Capability::Stream]
        );
        assert_eq!(
            needs(Feature::Assistant, Task::Copilot),
            vec![Capability::Tools, Capability::Stream]
        );
        assert_eq!(
            needs(Feature::SearchIndex, Task::Embed),
            vec![Capability::Embed]
        );
        assert_eq!(
            needs(Feature::Meet, Task::Transcribe),
            vec![Capability::Stt]
        );
    }

    /// Computer use (the sandbox's desktop) only on the opt-in providers'
    /// models that drive one, never on the install provider's.
    #[test]
    fn computer_use_is_an_opt_in_models_capability() {
        for model in models() {
            if model.has(Capability::ComputerUse) {
                assert!(model.provider.opt_in(), "{}", model.id);
            }
        }
        for id in [
            "anthropic/claude-sonnet-5-5",
            "anthropic/claude-opus-5-5",
            "openai/gpt-5",
        ] {
            assert!(
                model(id).is_some_and(|m| m.has(Capability::ComputerUse)),
                "{id}"
            );
        }
        assert!(
            !model("mistral/mistral-large-4-0").is_some_and(|m| m.has(Capability::ComputerUse))
        );
    }

    #[test]
    fn prices_follow_the_rate_table() {
        let small = price("mistral/mistral-small-2603");
        assert!((small.input_per_m - 0.15).abs() < f64::EPSILON);
        assert!((small.output_per_m - 0.6).abs() < f64::EPSILON);
        assert_eq!(price("mistral/mistral-ocr-4-1").per_page, Some(0.004));
        assert_eq!(
            price("mistral/voxtral-mini-transcribe-3-0").per_minute,
            Some(0.0035)
        );
        let sonnet = price("anthropic/claude-sonnet-5-5");
        assert!((sonnet.input_per_m - 2.0).abs() < f64::EPSILON);
        // Unknown ids fall back like priceForModel.
        assert!((price("@cf/some/model").input_per_m - 0.1).abs() < f64::EPSILON);
        assert!((price("someone/new-model").input_per_m - 3.0).abs() < f64::EPSILON);
        assert!((provider_markup() - 2.5).abs() < f64::EPSILON);
        assert!((credits_per_usd() - 100.0).abs() < f64::EPSILON);
    }

    #[test]
    fn model_ids_split_on_their_provider() {
        assert_eq!(
            split_model_id("mistral/mistral-small-2603"),
            Some((ProviderId::Mistral, "mistral-small-2603"))
        );
        assert_eq!(
            split_model_id("compat/meta-llama/Llama-3.3-70B"),
            Some((ProviderId::Compat, "meta-llama/Llama-3.3-70B"))
        );
        assert_eq!(split_model_id("@cf/meta/llama"), None);
        assert_eq!(split_model_id("claude-sonnet-5-5"), None);
        assert_eq!(
            find_model("claude-sonnet-5-5").map(|m| m.id.as_str()),
            Some("anthropic/claude-sonnet-5-5")
        );
        assert_eq!(native_model_id("openai/gpt-5"), "gpt-5");
        assert_eq!(
            model("mistral/mistral-large-4-0").map(ModelInfo::native_id),
            Some("mistral-large-4-0")
        );
    }
}
