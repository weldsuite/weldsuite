//! The core platform's team and settings routes, as app-api serves them
//! (`apps/workers/app-api/src/routes/`): team members, roles, the caller's
//! role and seat limits, invitations, workspace settings, the caller's
//! profile, preferences, notification preferences and push tokens, account
//! deletion, and the app catalog with its access requests.
//!
//! Each route group is its own router, nested at its app-api prefix by
//! `bins/weldsuite/src/routes/mod.rs`:
//!
//! | Router | Prefix | TypeScript |
//! |---|---|---|
//! | [`team_members`] | `/api/team-members` | `routes/team-members` |
//! | [`roles`] | `/api/roles` | `routes/roles` |
//! | [`my_role`] | `/api/my-role` | `routes/my-role` |
//! | [`member_limits`] | `/api/member-limits` | `routes/member-limits` |
//! | [`workspace_settings`] | `/api/workspace-settings` | `routes/workspace-settings` |
//! | [`settings_profile`] | `/api/settings/profile` | `routes/settings-profile` |
//! | [`user_preferences`] | `/api/user-preferences` | `routes/user-preferences` |
//! | [`notification_preferences`] | `/api/notification-preferences` | `routes/notification-preferences` |
//! | [`push_tokens`] | `/api/push-tokens` | `routes/push-tokens` |
//! | [`app_catalog`] | `/api/app-catalog` | `routes/app-catalog`, `routes/app-access` |
//! | [`workspaces`] | `/api/workspaces` | `routes/workspaces` |
//! | [`account`] | `/api/account` (no workspace) | `routes/account` |
//! | [`invitations`] | `/api/invitations` (no workspace) | `routes/invitations` |
//!
//! `account` and `invitations` sit outside the workspace layers, as app-api
//! mounts them above its `/api/*` guard: a user with no workspace may still
//! delete their account or open an invitation.
//!
//! The identity provider (Clerk in the Global edition) is the
//! [`weldsuite_ports::Identity`] port; billing (Stripe) is Global-only and
//! skipped as the workers skip it without the binding.

mod access;
mod groups;

use std::sync::Arc;

use axum::Router;
use weldsuite_db::{PgPool, Workspaces};
use weldsuite_events::EntityEventPublisher;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynCache, DynRealtimePublisher, FileStores, Identity};

pub use access::{
    AccountCaller, Caller, TeamError, TeamResult, answer, now, validate, validate_query,
};

/// What the handlers share, cloned from the app state.
#[derive(Clone)]
pub struct CoreTeamState {
    pub events: EntityEventPublisher,
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// The workspace cache (`WORKSPACE_CACHE`).
    pub cache: Option<Arc<dyn DynCache>>,
    /// The private and public buckets (avatars go to the public one).
    pub files: Option<FileStores>,
    /// The master database.
    pub master: PgPool,
    /// Other workspaces' tenant databases (invitations look across them).
    pub workspaces: Arc<Workspaces>,
    /// The identity provider; `None` answers as the workers do when Clerk
    /// cannot be reached.
    pub identity: Option<Arc<dyn Identity>>,
}

impl std::fmt::Debug for CoreTeamState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreTeamState")
            .field("events", &self.events)
            .field("realtime", &self.realtime.is_some())
            .field("cache", &self.cache.is_some())
            .field("files", &self.files.is_some())
            .field("identity", &self.identity.is_some())
            .finish_non_exhaustive()
    }
}

macro_rules! group_router {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        pub fn $name<S, Q>(state: CoreTeamState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
        where
            S: Clone + Send + Sync + 'static,
            Q: PermissionQueries + 'static,
        {
            groups::$name::router(gate).with_state(state)
        }
    };
}

group_router!(
    /// `/api/team-members`: the directory, profiles, notes, activity, per-member
    /// access, and invite / role change / removal (with the identity provider).
    team_members
);
group_router!(
    /// `/api/roles`: system and custom roles, the permission catalog.
    roles
);
group_router!(
    /// `/api/my-role`: the caller's role and what it lets them manage.
    my_role
);
group_router!(
    /// `/api/member-limits`: the seat limit, the seats in use.
    member_limits
);
group_router!(
    /// `/api/workspace-settings`: settings, rename, slug, deletion.
    workspace_settings
);
group_router!(
    /// `/api/settings/profile`: the caller's own profile and avatar.
    settings_profile
);
group_router!(
    /// `/api/user-preferences`: the caller's preferences.
    user_preferences
);
group_router!(
    /// `/api/notification-preferences`: the caller's notification settings.
    notification_preferences
);
group_router!(
    /// `/api/push-tokens`: the caller's mobile push tokens.
    push_tokens
);
group_router!(
    /// `/api/app-catalog`: the catalog, install and uninstall, access requests.
    app_catalog
);
group_router!(
    /// `/api/workspaces`: the workspaces the caller belongs to.
    workspaces
);

/// `/api/account`: account deletion. Behind the session only, no workspace.
pub fn account<S>(state: CoreTeamState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    groups::account::router().with_state(state)
}

/// `/api/invitations`: invitation details and acceptance. Behind the session
/// only, no workspace.
pub fn invitations<S>(state: CoreTeamState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    groups::invitations::router().with_state(state)
}
