//! The core platform's smaller route groups, as app-api serves them
//! (`apps/workers/app-api/src/routes/`): notifications, audit logs, personal
//! and workspace API keys, the workspace home (dashboard), the credits
//! wallet, Contact Support, the feedback board, enterprise single sign-on,
//! device sessions and the app store's workspace side.
//!
//! Each route group is its own router, nested at its app-api prefix by
//! `bins/weldsuite/src/routes/mod.rs`:
//!
//! | Router | Prefix | TypeScript |
//! |---|---|---|
//! | [`notifications`] | `/api/notifications` | `routes/notifications` |
//! | [`audit_logs`] | `/api/audit-logs` | `routes/audit-logs` |
//! | [`api_keys`] | `/api/api-keys` | `routes/api-keys` |
//! | [`workspace_api_keys`] | `/api/workspace-api-keys` | `routes/workspace-api-keys` |
//! | [`dashboard`] | `/api/dashboard` | `routes/dashboard` |
//! | [`credits`] | `/api/credits` | `routes/credits` |
//! | [`support`] | `/api/support` | `routes/support` |
//! | [`feature_requests`] | `/api/feature-requests` | `routes/feature-requests` |
//! | [`sso`] | `/api/sso` | `routes/sso` |
//! | [`auth_sessions`] | `/api/auth-sessions` | `routes/auth-sessions` |
//! | [`appstore`] | `/api/appstore` | `routes/appstore` |
//!
//! Billing (Stripe, through billing-worker) is Global-only: the routes that
//! forward to it answer as the workers do when billing-worker cannot be
//! reached. The identity provider (Clerk in the Global edition) is the
//! [`weldsuite_ports::Identity`] port.

mod access;
mod groups;

use std::sync::Arc;

use axum::Router;
use weldsuite_db::PgPool;
use weldsuite_events::EntityEventPublisher;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynCache, DynRealtimePublisher, Identity};

pub use access::{Caller, PlatformError, PlatformResult, answer, now, validate, validate_query};

/// What the handlers share, cloned from the app state.
#[derive(Clone)]
pub struct CorePlatformState {
    pub events: EntityEventPublisher,
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// The workspace cache (`WORKSPACE_CACHE`).
    pub cache: Option<Arc<dyn DynCache>>,
    /// The master database.
    pub master: PgPool,
    /// The identity provider; `None` answers as the workers do when Clerk
    /// cannot be reached.
    pub identity: Option<Arc<dyn Identity>>,
}

impl std::fmt::Debug for CorePlatformState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CorePlatformState")
            .field("events", &self.events)
            .field("realtime", &self.realtime.is_some())
            .field("cache", &self.cache.is_some())
            .field("identity", &self.identity.is_some())
            .finish_non_exhaustive()
    }
}

macro_rules! group_router {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        pub fn $name<S, Q>(state: CorePlatformState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
        where
            S: Clone + Send + Sync + 'static,
            Q: PermissionQueries + 'static,
        {
            groups::$name::router(gate).with_state(state)
        }
    };
}

group_router!(
    /// `/api/notifications`: the caller's own notifications.
    notifications
);
group_router!(
    /// `/api/audit-logs`: the workspace's audit log and entity history.
    audit_logs
);
group_router!(
    /// `/api/api-keys`: the caller's personal API keys.
    api_keys
);
group_router!(
    /// `/api/workspace-api-keys`: the workspace's shared API keys.
    workspace_api_keys
);
group_router!(
    /// `/api/dashboard`: the workspace home (chart, apps, activity, badges,
    /// onboarding checklist).
    dashboard
);
group_router!(
    /// `/api/credits`: the prepaid credits wallet.
    credits
);
group_router!(
    /// `/api/support`: the enterprise Contact Support channel.
    support
);
group_router!(
    /// `/api/feature-requests`: the global feedback board.
    feature_requests
);
group_router!(
    /// `/api/sso`: enterprise single sign-on configuration.
    sso
);
group_router!(
    /// `/api/auth-sessions`: revoking the caller's device sessions.
    auth_sessions
);
group_router!(
    /// `/api/appstore`: the app store's per-workspace and per-user side.
    appstore
);
