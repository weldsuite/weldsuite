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
//!   `OpenAI`, labelled "outside the EU", paid with WeldSuite's key (charged as
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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use weldsuite_db::PgPool;
use weldsuite_ports::{DynCache, OutboundHttp};

pub use catalog::{Capability, Feature, KeySource, ProviderId, Region, Task, Tier};
pub use config::{AiConfig, BillingMode};
pub use error::AiError;
pub use fake::FakeProvider;
pub use policy::{EffectivePolicy, Route, Target};
pub use settings::{OwnKeyStatus, UsageReport, WorkspaceAiSettings};
pub use types::{
    Audio, ChatRequest, ChatResponse, ChatStream, Document, EmbedResponse, FinishReason,
    JsonSchema, Message, OcrPage, OcrResponse, Part, Role, Served, StreamEvent, ToolCall,
    ToolChoice, ToolDef, TranscribeResponse, Usage,
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
    /// How the wallet ledger books the charge, when the caller isn't a plain
    /// AI route (`reference_type 'ai'`, `AI (<op>) [<model>]`, no key).
    pub ledger: Option<LedgerTag>,
}

/// A caller's own booking of the charge, as its TypeScript twin writes it:
/// WeldConnect's AI steps book `workflow_step`, `Workflow AI (…)` and the key
/// `wf:<execution>:<step>:<op>`, so a replayed step is never charged twice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerTag {
    /// `credit_transactions.reference_type`.
    pub reference_type: String,
    /// The idempotency key of the charge; the debt adjustment uses
    /// `<key>:debt` and the ops ledger `<key>:usage`.
    pub idempotency_key: Option<String>,
    /// What precedes ` (<op>) [<model>]` in the description (`AI` by
    /// default).
    pub label: String,
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
            ledger: None,
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

    /// Book the charge as the caller's TypeScript twin does ([`LedgerTag`]).
    #[must_use]
    pub fn ledger(mut self, tag: LedgerTag) -> Self {
        self.ledger = Some(tag);
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
    limits: Arc<WorkspaceLimits>,
}

/// The per-workspace concurrency cap on WeldSuite's keys
/// (`AI_WORKSPACE_CONCURRENCY`): one in-process semaphore per workspace, so
/// one workspace's bulk labelling can't take every slot of the shared
/// Mistral account on this replica. Calls past the cap wait for a slot. Own
/// keys aren't capped. 0: no cap.
struct WorkspaceLimits {
    max: usize,
    semaphores: Mutex<HashMap<String, Arc<Semaphore>>>,
}

impl WorkspaceLimits {
    fn new(max: u32) -> Self {
        Self {
            max: usize::try_from(max)
                .unwrap_or(usize::MAX)
                .min(Semaphore::MAX_PERMITS),
            semaphores: Mutex::default(),
        }
    }

    async fn acquire(&self, workspace_id: &str) -> Option<OwnedSemaphorePermit> {
        if self.max == 0 {
            return None;
        }
        let semaphore = {
            let mut semaphores = self
                .semaphores
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // Forget the workspaces nobody is calling for, now and then.
            if semaphores.len() > 4096 {
                semaphores.retain(|_, s| Arc::strong_count(s) > 1);
            }
            semaphores
                .entry(workspace_id.to_owned())
                .or_insert_with(|| Arc::new(Semaphore::new(self.max)))
                .clone()
        };
        semaphore.acquire_owned().await.ok()
    }
}

impl std::fmt::Debug for Ai {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ai")
            .field("default_provider", &self.inner.config.default_provider)
            .finish_non_exhaustive()
    }
}

impl Ai {
    /// The service over `http`. In production that is
    /// `ReqwestOutbound::with_timeouts(10 s, 300 s)` (connect, overall); each
    /// call is cut at 120 s (300 s for OCR and transcription) here. `cache`
    /// holds each workspace's settings for 60 s (Valkey); `None` reads them
    /// on every call.
    pub fn new(config: AiConfig, http: OutboundHttp, cache: Option<Arc<dyn DynCache>>) -> Self {
        let limits = Arc::new(WorkspaceLimits::new(config.workspace_concurrency));
        Self {
            inner: Arc::new(Inner {
                config,
                http,
                cache,
                fake: None,
                limits,
            }),
        }
    }

    /// Every provider answered by `fake` (unit tests and conformance).
    pub fn fake(config: AiConfig, fake: FakeProvider) -> Self {
        let http = fake.outbound();
        let limits = Arc::new(WorkspaceLimits::new(config.workspace_concurrency));
        Self {
            inner: Arc::new(Inner {
                config,
                http,
                cache: None,
                fake: Some(fake),
                limits,
            }),
        }
    }

    /// The same service over another HTTP client: the request's fetch stub in
    /// conformance builds. Every provider call of the copy (chat, streams,
    /// OCR, embeddings, transcription, key checks) goes through `http`; the
    /// settings cache and the concurrency cap are shared.
    #[must_use]
    pub fn with_http(&self, http: OutboundHttp) -> Self {
        Self {
            inner: Arc::new(Inner {
                config: self.inner.config.clone(),
                http,
                cache: self.inner.cache.clone(),
                fake: self.inner.fake.clone(),
                limits: self.inner.limits.clone(),
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
    pub async fn chat_stream(
        &self,
        call: &AiCall,
        request: ChatRequest,
    ) -> Result<ChatStream, AiError> {
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
    pub async fn transcribe(
        &self,
        call: &AiCall,
        audio: Audio,
    ) -> Result<TranscribeResponse, AiError> {
        let route = self.route(call).await?;
        providers::transcribe(self, call, &route, audio).await
    }

    /// The workspace's effective policy, as `GET /api/ai-settings` answers it.
    pub async fn effective_policy(
        &self,
        tenant: &PgPool,
        workspace_id: &str,
    ) -> Result<EffectivePolicy, AiError> {
        if !self.enabled() {
            return Err(AiError::Unavailable);
        }
        let settings = self.settings(tenant, workspace_id).await?;
        Ok(policy::effective(&self.inner.config, &settings))
    }

    /// The workspace's stored settings (cached 60 s), own keys as hints only.
    pub async fn settings(
        &self,
        tenant: &PgPool,
        workspace_id: &str,
    ) -> Result<WorkspaceAiSettings, AiError> {
        settings::load(tenant, workspace_id, self.inner.cache.as_deref()).await
    }

    /// Writes the workspace's providers, default and overrides
    /// (`settings::save_settings`) and clears its cache.
    pub async fn save_settings(
        &self,
        tenant: &PgPool,
        workspace_id: &str,
        settings: &WorkspaceAiSettings,
        updated_by: Option<&str>,
    ) -> Result<(), AiError> {
        settings::save_settings(tenant, settings, updated_by).await?;
        self.invalidate(workspace_id).await;
        Ok(())
    }

    /// Checks `key` with the provider (a cheap list of its models): `Ok` when
    /// it answers, the provider's refusal otherwise.
    pub async fn check_key(&self, provider: ProviderId, key: &str) -> Result<(), AiError> {
        providers::check_key(self, provider, key).await
    }

    /// Checks and stores an own key, sealed (`settings::put_key`), and clears
    /// the cache. Needs `AI_KEYS_ENCRYPTION_KEY`; a key the provider refuses
    /// isn't stored.
    pub async fn put_key(
        &self,
        tenant: &PgPool,
        workspace_id: &str,
        provider: ProviderId,
        key: &str,
        created_by: Option<&str>,
    ) -> Result<OwnKeyStatus, AiError> {
        let secret = self
            .inner
            .config
            .keys_encryption_key
            .ok_or(AiError::Unavailable)?;
        self.check_key(provider, key).await?;
        let status =
            settings::put_key(tenant, &secret, workspace_id, provider, key, created_by).await?;
        self.invalidate(workspace_id).await;
        Ok(status)
    }

    /// Checks the stored own key again and records the result
    /// (`POST /api/ai-settings/keys/:provider/test`). `None` without a key.
    pub async fn test_key(
        &self,
        tenant: &PgPool,
        workspace_id: &str,
        provider: ProviderId,
    ) -> Result<Option<OwnKeyStatus>, AiError> {
        let secret = self
            .inner
            .config
            .keys_encryption_key
            .ok_or(AiError::Unavailable)?;
        let Some(key) = settings::own_key(tenant, &secret, workspace_id, provider).await? else {
            return Ok(None);
        };
        let failure = match self.check_key(provider, &key).await {
            Ok(()) => None,
            Err(AiError::Provider {
                status, message, ..
            }) => Some(match status {
                Some(status) => format!("{status}: {message}"),
                None => message,
            }),
            Err(error) => return Err(error),
        };
        settings::mark_key(tenant, provider, failure.as_deref()).await?;
        self.invalidate(workspace_id).await;
        let settings = settings::read(tenant).await?;
        Ok(settings.own_keys.get(&provider).cloned())
    }

    /// Removes an own key and clears the cache. Whether there was one.
    pub async fn delete_key(
        &self,
        tenant: &PgPool,
        workspace_id: &str,
        provider: ProviderId,
    ) -> Result<bool, AiError> {
        let deleted = settings::delete_key(tenant, provider).await?;
        self.invalidate(workspace_id).await;
        Ok(deleted)
    }

    /// Credits and tokens per provider and feature, this month and last
    /// (`GET /api/ai-settings/usage`).
    pub async fn usage(&self, master: &PgPool, workspace_id: &str) -> Result<UsageReport, AiError> {
        settings::usage(master, workspace_id).await
    }

    /// Forget a workspace's cached settings (after a write).
    pub async fn invalidate(&self, workspace_id: &str) {
        settings::invalidate(self.inner.cache.as_deref(), workspace_id).await;
    }

    pub(crate) fn http(&self) -> &OutboundHttp {
        &self.inner.http
    }

    /// The fake behind [`Ai::fake`], to read the recorded calls.
    pub fn fake_provider(&self) -> Option<&FakeProvider> {
        self.inner.fake.as_ref()
    }

    /// A slot of the workspace's concurrency cap, for a call on WeldSuite's
    /// key; `None` for own keys and without a cap.
    pub(crate) async fn permit(
        &self,
        call: &AiCall,
        target: &Target,
    ) -> Option<OwnedSemaphorePermit> {
        if target.key_source != KeySource::Weldsuite {
            return None;
        }
        self.inner.limits.acquire(&call.workspace_id).await
    }

    async fn workspace_settings(
        &self,
        call: &AiCall,
    ) -> Result<settings::WorkspaceAiSettings, AiError> {
        if !self.enabled() {
            return Err(AiError::Unavailable);
        }
        match &call.tenant {
            Some(tenant) => {
                settings::load(tenant, &call.workspace_id, self.inner.cache.as_deref()).await
            }
            None => Ok(settings::WorkspaceAiSettings::default()),
        }
    }
}
