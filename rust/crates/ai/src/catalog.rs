//! The AI catalog (AI-006, one source of truth): providers with their region,
//! models with capabilities and prices, each provider's task map, and the
//! features an admin can route. Source: `packages/core/ai/src/catalog.ts`,
//! exported to `rust/catalogs/ai.json` by `pnpm rust:catalogs`.
//!
//! The enums below name what call sites use; a test checks they match the
//! JSON both ways.

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
}

/// The tasks of `recommended` in `packages/core/ai/src/models.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
}

/// `free` or `quality`, as in `recommended`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tier {
    Free,
    Quality,
}

/// What a model can do; a feature lists what it needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    Tools,
    JsonSchema,
    FileInput,
    Vision,
    Stream,
    Embed,
    Stt,
    Ocr,
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
        !matches!(self, Self::SearchIndex | Self::ReachWarmup | Self::MailReview)
    }
}
