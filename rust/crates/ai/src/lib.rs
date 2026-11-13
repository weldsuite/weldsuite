//! AI on the Kubernetes editions (ADR AI-012, `docs/plans/eu-ai-mistral.md`).
//!
//! Global runs every AI call through `@weldsuite/ai` and the Cloudflare AI
//! Gateway. The EU edition and self-hosted installs run them through this
//! crate instead:
//!
//! - **Install provider.** Mistral on EU (`AI_DEFAULT_PROVIDER=mistral`), or a
//!   self-hosted install's own OpenAI-compatible endpoint (`compat`). Without
//!   one AI is off ([`Ai::enabled`] is false) and every call answers
//!   [`AiError::Unavailable`].
//! - **Workspace opt-in.** An admin (`ai:manage`) may enable Anthropic and
//!   OpenAI, labelled "outside the EU", paid with WeldSuite's key (charged as
//!   credits) or the workspace's own key (not charged). The settings live in
//!   the tenant tables `ai_settings` and `ai_provider_keys` ([`settings`]).
//! - **Policy.** Call sites ask for a [`Feature`], a [`Task`] and a [`Tier`],
//!   never a provider. [`policy::resolve`] picks the model: an explicit model
//!   (request or stored), then the feature's override, then the workspace
//!   default, then the install default. A provider that isn't enabled is never
//!   called. Some features are fixed to the install provider
//!   ([`Feature::overridable`]).
//! - **Fallback never leaves the EU** ([`fallback`]): a non-EU refusal re-runs
//!   on the install provider's model for the same task and tier, charged at its
//!   price; an install-provider refusal falls back only to an EU
//!   `AI_FALLBACK_MODEL`.
//! - **Metering** ([`billing`]): the Rust twin of
//!   `@weldsuite/core-domain/ai-billing`. Every call on WeldSuite's account is
//!   charged into the workspace credit wallet at the shared rate table
//!   (`rust/catalogs/ai.json`, exported from `packages/core/ai/src/catalog.ts`)
//!   and written to the ops ledger (`ai_provider_usage`). Own-key calls are
//!   counted, not charged. The 402 gate is `AI_CREDIT_GATE`.
//!
//! # Using it from a route
//!
//! ```ignore
//! let call = AiCall::new(&tenant.workspace_id, Feature::Mail, Task::Draft, Tier::Quality)
//!     .user(&caller.user_id)
//!     .tenant(tenant.db.clone())
//!     .master(master.clone())
//!     .requested_model(body.model_id.as_deref());
//! ai.assert_credits(&call).await?;
//! let answer = ai.chat(&call, ChatRequest::system_user(SYSTEM, prompt)).await?;
//! // answer.text, answer.served.meta() → `meta.ai` in the response
//! ```

pub mod billing;
pub mod catalog;
pub mod config;
pub mod error;
pub mod fake;
pub mod fallback;
pub mod policy;
pub mod providers;
pub mod settings;
pub mod types;

use std::sync::Arc;

use weldsuite_db::PgPool;
use weldsuite_ports::{DynCache, OutboundHttp};

pub use catalog::{Capability, Feature, KeySource, ProviderId, Region, Task, Tier};
pub use config::{AiConfig, BillingMode};
pub use error::AiError;
pub use fake::FakeProvider;
pub use policy::{EffectivePolicy, Route};
pub use types::{
    Audio, ChatRequest, ChatResponse, ChatStream, Document, EmbedResponse, FinishReason,
    Message, OcrPage, OcrResponse, Part, Role, Served, StreamEvent, ToolCall, ToolChoice,
    ToolDef, TranscribeResponse, Usage,
};

/// One AI call's context: who asks, for what, and where its settings and
/// wallet are. Owned, so a stream can outlive the handler's borrows.
#[derive(Debug, Clone)]
pub struct AiCall {
    /// `workspaces.id`.
    pub workspace_id: String,
    /// The member who asked; `None` for system jobs (subscribers, crons).
    pub user_id: Option<String>,
    /// The workspace's tenant database: its `ai_settings` and own keys. `None`
    /// runs on the install defaults only.
    pub tenant: Option<PgPool>,
    /// The master database, for the credit wallet and the ops ledger. `None`
    /// is unmetered, as the TypeScript workers are without one.
    pub master: Option<PgPool>,
    pub feature: Feature,
    pub task: Task,
    pub tier: Tier,
    /// An explicit model id.
    pub model: Option<RequestedModel>,
    /// The ledger's `op` (`AI (<op>) [<model>]`); the feature id when unset.
    pub op: Option<String>,
    /// The ledger's `reference_id`.
    pub reference_id: Option<String>,
}

/// Where an explicit model id came from, which decides what happens when the
/// policy doesn't allow it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestedModel {
    /// Sent by the client (`model`, `modelId`): a model the policy refuses is a
    /// 422 `AI_MODEL_NOT_ALLOWED`.
    Request(String),
    /// Stored on a record (a mail account's `modelPreference`, a workflow
    /// step's model): skipped with a log line when refused.
    Stored(String),
}

impl AiCall {
    pub fn new(workspace_id: impl Into<String>, feature: Feature, task: Task, tier: Tier) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            user_id: None,
            tenant: None,
            master: None,
            feature,
            task,
            tier,
            model: None,
            op: None,
            reference_id: None,
        }
    }

    #[must_use]
    pub fn user(mut self, user_id: impl Into<String>) -> Self {
        self.user_id = Some(user_id.into());
        self
    }

    #[must_use]
    pub fn tenant(mut self, tenant: PgPool) -> Self {
        self.tenant = Some(tenant);
        self
    }

    #[must_use]
    pub fn master(mut self, master: Option<PgPool>) -> Self {
        self.master = master;
        self
    }

    /// A model the client sent; blank or `None` is no model.
    #[must_use]
    pub fn requested_model(mut self, model: Option<&str>) -> Self {
        if let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) {
            self.model = Some(RequestedModel::Request(model.to_owned()));
        }
        self
    }

    /// A model stored on a record; blank or `None` is no model.
    #[must_use]
    pub fn stored_model(mut self, model: Option<&str>) -> Self {
        if let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) {
            self.model = Some(RequestedModel::Stored(model.to_owned()));
        }
        self
    }

    #[must_use]
    pub fn op(mut self, op: impl Into<String>) -> Self {
        self.op = Some(op.into());
        self
    }

    #[must_use]
    pub fn reference(mut self, reference_id: impl Into<String>) -> Self {
        self.reference_id = Some(reference_id.into());
        self
    }

    /// The ledger's `op`.
    pub fn op_name(&self) -> &str {
        self.op.as_deref().unwrap_or(self.feature.as_str())
    }
}

/// The AI service: configuration, HTTP client and the settings cache. Cheap to
/// clone.
#[derive(Clone)]
pub struct Ai {
    inner: Arc<Inner>,
}

struct Inner {
    config: AiConfig,
    http: OutboundHttp,
    cache: Option<Arc<dyn DynCache>>,
    fake: Option<FakeProvider>,
}

impl std::fmt::Debug for Ai {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ai")
            .field("default_provider", &self.inner.config.default_provider)
            .finish_non_exhaustive()
    }
}

impl Ai {
    /// The service over `http` (`ReqwestOutbound` in production). `cache`
    /// holds each workspace's settings for 60 s (Valkey); `None` reads them on
    /// every call.
    pub fn new(config: AiConfig, http: OutboundHttp, cache: Option<Arc<dyn DynCache>>) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                http,
                cache,
                fake: None,
            }),
        }
    }

    /// Every provider answered by `fake` (unit tests and conformance).
    pub fn fake(config: AiConfig, fake: FakeProvider) -> Self {
        let http = fake.outbound();
        Self {
            inner: Arc::new(Inner {
                config,
                http,
                cache: None,
                fake: Some(fake),
            }),
        }
    }

    /// The same service over another HTTP client: the request's fetch stub in
    /// conformance builds.
    #[must_use]
    pub fn with_http(&self, http: OutboundHttp) -> Self {
        Self {
            inner: Arc::new(Inner {
                config: self.inner.config.clone(),
                http,
                cache: self.inner.cache.clone(),
                fake: self.inner.fake.clone(),
            }),
        }
    }

    pub fn config(&self) -> &AiConfig {
        &self.inner.config
    }

    /// Whether the install has a default provider. Without one every call
    /// answers [`AiError::Unavailable`] and the AI features are hidden.
    pub fn enabled(&self) -> bool {
        self.inner.config.default_provider.is_some()
    }

    /// The route a call would take, without calling a model: for labels and
    /// pickers.
    pub async fn route(&self, call: &AiCall) -> Result<Route, AiError> {
        let settings = self.workspace_settings(call).await?;
        policy::resolve(&self.inner.config, &settings, call)
    }

    /// The hard gate (AI-007): with `AI_CREDIT_GATE` on and WeldSuite paying,
    /// [`AiError::InsufficientCredits`] when the wallet holds less than one
    /// credit. A no-op otherwise.
    pub async fn assert_credits(&self, call: &AiCall) -> Result<(), AiError> {
        let route = self.route(call).await?;
        billing::assert_credits(&self.inner.config, call, &route).await
    }

    /// One chat completion (text, tools or a JSON schema answer), with
    /// retries, fallback and metering.
    pub async fn chat(&self, call: &AiCall, request: ChatRequest) -> Result<ChatResponse, AiError> {
        let route = self.route(call).await?;
        providers::chat(self, call, &route, request).await
    }

    /// A streamed chat completion. The last event is [`StreamEvent::Finish`],
    /// after the call is metered. A refusal before the first chunk still falls
    /// back.
    pub async fn chat_stream(&self, call: &AiCall, request: ChatRequest) -> Result<ChatStream, AiError> {
        let route = self.route(call).await?;
        providers::chat_stream(self, call, &route, request).await
    }

    /// Reads a document (PDF or image): Mistral OCR, or native file input when
    /// the policy routes the feature to a provider that has it.
    pub async fn ocr(&self, call: &AiCall, document: Document) -> Result<OcrResponse, AiError> {
        let route = self.route(call).await?;
        providers::ocr(self, call, &route, document).await
    }

    /// Embeddings, always on the install provider (`search-index` is fixed).
    pub async fn embed(&self, call: &AiCall, inputs: &[String]) -> Result<EmbedResponse, AiError> {
        let route = self.route(call).await?;
        providers::embed(self, call, &route, inputs).await
    }

    /// Speech to text, always on the install provider (Voxtral on EU).
    pub async fn transcribe(&self, call: &AiCall, audio: Audio) -> Result<TranscribeResponse, AiError> {
        let route = self.route(call).await?;
        providers::transcribe(self, call, &route, audio).await
    }

    /// The workspace's effective policy, as `GET /api/ai-settings` answers it.
    pub async fn effective_policy(&self, tenant: &PgPool, workspace_id: &str) -> Result<EffectivePolicy, AiError> {
        let settings = settings::load(tenant, workspace_id, self.inner.cache.as_deref()).await?;
        Ok(policy::effective(&self.inner.config, &settings))
    }

    /// Forget a workspace's cached settings (after a write).
    pub async fn invalidate(&self, workspace_id: &str) {
        settings::invalidate(self.inner.cache.as_deref(), workspace_id).await;
    }

    pub(crate) fn http(&self) -> &OutboundHttp {
        &self.inner.http
    }

    pub(crate) fn fake_provider(&self) -> Option<&FakeProvider> {
        self.inner.fake.as_ref()
    }

    async fn workspace_settings(&self, call: &AiCall) -> Result<settings::WorkspaceAiSettings, AiError> {
        if !self.enabled() {
            return Err(AiError::Unavailable);
        }
        match &call.tenant {
            Some(tenant) => settings::load(tenant, &call.workspace_id, self.inner.cache.as_deref()).await,
            None => Ok(settings::WorkspaceAiSettings::default()),
        }
    }
}
