//! Workspace signup and provisioning (P4 sub-phase 4a): app-api's
//! `/api/onboarding` routes (`apps/workers/app-api/src/routes/onboarding`),
//! and what the workspace worker does behind them on Global, here in the
//! one process:
//!
//! | Piece | TypeScript | Here |
//! |---|---|---|
//! | the 13 routes | `routes/onboarding/index.ts` | [`router`] |
//! | the onboard service (`WORKSPACE_WORKER.onboard`) | `workspace-worker/src/routes/onboard.ts` (`runOnboard`) | [`WorkspaceService`] |
//! | provisioning | `ProvisionWorkspaceWorkflow` | [`ProvisionJob`] (`workspace.provision`, on the Jobs port) |
//! | Clerk's webhooks | `workspace-worker/src/routes/webhooks/clerk.ts` | [`IdentitySync`] (`weldsuite cron identity-sync`) |
//! | scheduled deletion, teardown retry | `services/deletion-sweep.ts`, `services/teardown-sweep.ts` | [`sweep_scheduled_deletions`], [`sweep_unfinished_teardowns`] |
//!
//! The routes need a session but no workspace (app-api mounts them above its
//! `/api/*` guard): the caller is creating one.
//!
//! The routes that create a workspace answer as app-api does without the
//! `WORKSPACE_WORKER` binding (500 "Workspace service not configured")
//! when the state has no [`WorkspaceService`]: the conformance build, and a
//! server without an identity provider or tenant shards.

mod caller;
mod onboard;
mod provision;
mod routes;
mod slug;
mod sweeps;
mod sync;
mod territory;

use std::sync::Arc;

use axum::Router;
use weldsuite_db::PgPool;
use weldsuite_events::EntityEventPublisher;
use weldsuite_ports::{BoxFuture, DynSystemMail, Identity};

pub use caller::OnboardingCaller;
pub use onboard::{InitialMember, OnboardOutcome, WorkspaceService};
pub use provision::{PROVISION_JOB, ProvisionJob, ProvisionPayload};
pub use slug::{slugify_workspace_name, with_random_suffix};
pub use sweeps::{
    DeletionSweepResult, TEARDOWN_BATCH_LIMIT, TEARDOWN_RETRY_AFTER, TeardownSweepResult,
    sweep_scheduled_deletions, sweep_unfinished_teardowns,
};
pub use sync::{IdentitySync, SyncReport, WATERMARK_KEY};

/// A workspace's tenant database, by `workspaces.id` or its organization id
/// (jobs and crons run outside any request).
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// What the routes share, cloned from the app state.
#[derive(Clone)]
pub struct OnboardingState {
    /// Fire-and-forget work (the reseller's email) runs on its tracker.
    pub events: EntityEventPublisher,
    pub master: PgPool,
    /// `getTenantDbForWorkspace`, for `/finalize`.
    pub tenants: TenantDatabases,
    /// The identity provider; `None` answers as the workers do when Clerk
    /// cannot be reached.
    pub identity: Option<Arc<dyn Identity>>,
    /// The reseller's "new workspace request" email.
    pub mail: Option<Arc<dyn DynSystemMail>>,
    /// Creates workspaces; `None` answers 500 "Workspace service not
    /// configured", as app-api without its `WORKSPACE_WORKER` binding.
    pub workspace_service: Option<Arc<WorkspaceService>>,
}

impl std::fmt::Debug for OnboardingState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OnboardingState")
            .field("identity", &self.identity.is_some())
            .field("mail", &self.mail.is_some())
            .field("workspace_service", &self.workspace_service.is_some())
            .finish_non_exhaustive()
    }
}

/// `/api/onboarding`: behind the session layer only.
pub fn router<S>(state: OnboardingState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    routes::router().with_state(state)
}
