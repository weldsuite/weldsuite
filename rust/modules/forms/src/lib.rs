//! WeldForms, forms, surveys and quizzes: what forms-api
//! (`apps/workers/forms-api`) serves, built in both backends from the first
//! route (ADR FORMS-001).
//!
//! - [`engine`]: `@weldsuite/forms-engine`, its own crate (the definition and its checks,
//!   answer validation, logic, the path, the submission result, recall and
//!   display), held equal by the shared fixtures.
//! - [`router`]: the member routes at `/api/forms` (forms with their
//!   revisions, lifecycle, versions, access list and subscription; their
//!   responses, columns, summary, insights and CSV/XLSX exports; invitations
//!   and reminders; integrations and their dry run; folders, themes,
//!   workspace settings, usage, media; a person's responses across forms and
//!   the GDPR erase; the AI routes, 503 `ai_unavailable` here (ADR AI-011);
//!   and the members-only fill page at `/api/forms/fill/:publicId`).
//! - [`public_router`]: the respondent side at `/public/forms`, called only
//!   by the forms portal with `FORMS_PORTAL_SECRET` (ADR FORMS-002): the
//!   published form from the public cache, views, sessions, codes, abuse
//!   reports, progress, uploads and submit, and ALTCHA's challenge.
//! - [`ProcessResponseJob`]: `ProcessResponseWorkflow` on the jobs port, with
//!   its steps ([`process_steps`]): CRM, Desk and Flow per integration, then
//!   the notifications, the receipt and the quota notices.
//! - [`run_reminders_sweep`], [`run_digest_sweep`]: `weldsuite cron
//!   forms-reminders` / `forms-digest` on the master due index.
//!
//! On Kubernetes the cache port (Valkey) holds what Global keeps in KV (the
//! public cache, seeds, codes) and in the `FormCounters` Durable Object
//! (views, rate-limit windows, wrong-code counts, as atomic counters).
//! Respondent sessions are the worker's HMAC tokens byte for byte, so a
//! session either backend issued opens on the other.

/// The forms engine (`weldsuite-forms-engine`, `@weldsuite/forms-engine`).
pub use weldsuite_forms_engine as engine;

mod access;
mod ai;
mod bot_check;
mod codes;
mod common;
mod counters;
mod creator_access;
mod crypto;
mod export;
mod folders_themes;
mod forms;
mod input;
mod integration_config;
mod integration_support;
mod integration_test;
mod integrations;
mod invitations;
mod mail;
mod members;
mod model;
mod notify;
mod process;
mod public_cache;
mod public_form;
mod publishing;
mod respondent;
mod response_model;
mod response_text;
mod responses;
mod results;
mod routes;
mod sessions;
mod steps;
mod submit;
mod sweeps;
mod usage;
mod workspace;
mod zip;

use std::collections::HashMap;
use std::sync::Arc;

use http::Extensions;
use sqlx::PgPool;
use weldsuite_events::EntityEventPublisher;
use weldsuite_kit::RequestEnv;
use weldsuite_ports::{
    BoxFuture, DynCache, DynJobs, DynRealtimePublisher, DynSystemMail, FileStores, MemoryCache,
    OutboundHttp, RequestCache,
};

pub use common::{ENV_KEYS, env_from_process};
pub use model::starter_templates;
pub use process::{
    JobsProcessRuns, PROCESS_RESPONSE_JOB, ProcessContext, ProcessResponseJob,
    ProcessResponseParams, ProcessRuns, ProcessStep, RequestProcessRuns, StepKind, StepResult,
    process_steps,
};
pub use routes::{FORMS_PORTAL_KEY_HEADER, RESPONDENT_IP_HEADER, public_router, router};
pub use sweeps::{run_digest_sweep, run_reminders_sweep};

/// One workspace's tenant database, as [`TenantResolver`] opens it.
#[derive(Clone)]
pub struct TenantDb {
    pub db: PgPool,
    /// `workspaces.id`.
    pub workspace_id: String,
    /// The Clerk org id, when the workspace has one.
    pub clerk_org_id: Option<String>,
    pub suspended: bool,
}

/// Opens a workspace's tenant database by its Clerk org id (or
/// `workspaces.id`): the public routes and the job, outside a member's
/// request. The bin hands in its `Workspaces`.
pub trait TenantResolver: Send + Sync {
    fn tenant<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<TenantDb, String>>;
}

/// What the forms handlers share.
#[derive(Clone)]
pub struct FormsState {
    pub events: EntityEventPublisher,
    /// The master database (link and invitation registries, plans). A
    /// request's `MasterDb` (conformance) wins.
    pub master: Option<PgPool>,
    /// The private bucket (respondent uploads) and the public one (media).
    pub files: Option<FileStores>,
    /// Valkey (`WORKSPACE_CACHE` and `FORM_COUNTERS`). Without it, this
    /// process's memory: enough for one replica.
    pub cache: Option<Arc<dyn DynCache>>,
    /// Starts `forms.process-response`.
    pub jobs: Option<Arc<dyn DynJobs>>,
    /// In-app notifications (`REALTIME`).
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// System mail (the code emails); without it codes are not sent.
    pub mail: Option<Arc<dyn DynSystemMail>>,
    /// Third-party HTTP (Turnstile's siteverify). A request's (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// Opens the workspace behind a public link.
    pub tenants: Option<Arc<dyn TenantResolver>>,
    /// The outbound mail guard's ledgers (codes count against the workspace,
    /// source `forms`). A request's `RequestOutbound` (conformance) wins.
    pub outbound: weldsuite_mail_domain::outbound::OutboundBindings,
    /// The worker's env from the process ([`env_from_process`]).
    pub env: Arc<HashMap<String, String>>,
    /// The cache when there is no Valkey.
    pub local_cache: Arc<MemoryCache>,
    /// The install's AI (the AI routes); `None` with AI off. A request's own
    /// `Ai` (conformance) wins.
    pub ai: Option<weldsuite_ai::Ai>,
}

impl std::fmt::Debug for FormsState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FormsState")
            .field("master", &self.master.is_some())
            .field("files", &self.files.is_some())
            .field("cache", &self.cache.is_some())
            .field("jobs", &self.jobs.is_some())
            .field("mail", &self.mail.is_some())
            .field("tenants", &self.tenants.is_some())
            .finish_non_exhaustive()
    }
}

impl FormsState {
    /// The services a request reaches: its own stand-ins (conformance)
    /// first, then the app's.
    pub(crate) fn services(&self, extensions: &Extensions) -> common::Svc {
        let cache = extensions
            .get::<RequestCache>()
            .map(|cache| Arc::clone(&cache.0))
            .or_else(|| self.cache.clone())
            .unwrap_or_else(|| Arc::clone(&self.local_cache) as Arc<dyn DynCache>);
        let process = extensions
            .get::<RequestProcessRuns>()
            .map(|runs| Arc::clone(&runs.0))
            .or_else(|| {
                self.jobs
                    .clone()
                    .map(|jobs| Arc::new(JobsProcessRuns(jobs)) as Arc<dyn ProcessRuns>)
            });
        common::Svc {
            events: self.events.clone(),
            env: common::Env::new(
                extensions.get::<RequestEnv>().cloned(),
                Arc::clone(&self.env),
            ),
            cache,
            files: extensions
                .get::<FileStores>()
                .cloned()
                .or_else(|| self.files.clone()),
            process,
            mail: self.mail.clone(),
            realtime: self.realtime.clone(),
            outbound: extensions
                .get::<weldsuite_mail_domain::outbound::RequestOutbound>()
                .map_or_else(|| self.outbound.clone(), |own| own.0.clone()),
            http: extensions
                .get::<OutboundHttp>()
                .cloned()
                .or_else(|| self.http.clone()),
            ai: extensions
                .get::<weldsuite_ai::Ai>()
                .or(self.ai.as_ref())
                .filter(|ai| ai.enabled())
                .cloned(),
        }
    }

    /// The master database: the request's (conformance), else the app's.
    pub(crate) fn master(&self, extensions: &Extensions) -> Option<PgPool> {
        extensions
            .get::<weldsuite_db::MasterDb>()
            .map(|master| master.0.clone())
            .or_else(|| self.master.clone())
    }
}
