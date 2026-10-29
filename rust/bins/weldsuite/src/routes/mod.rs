//! The ported `/api` routes, by object, as the workers organise them. Paths,
//! bodies, status codes and messages are the TypeScript routes'; the
//! conformance suite (`rust/conformance/suites.json`) runs their tests here.
//!
//! Core routes live in this crate; a ported `weld*` module is its own crate
//! under `rust/modules/` and is mounted at its path prefix.

mod access_requests;
mod feature_flags;
mod me;

use std::sync::Arc;

use axum::Router;
use axum::routing::{get, patch, post};

use crate::server::AppState;

/// Every ported route, relative to `/api`.
pub(crate) fn api(state: &AppState) -> Router<AppState> {
    let router = Router::new()
        .route("/me/permissions", get(me::permissions))
        .route("/feature-flags", get(feature_flags::list))
        .route("/access-requests", post(access_requests::create))
        .route(
            "/access-requests/me/pending",
            get(access_requests::my_pending),
        )
        .route(
            "/access-requests/{id}",
            patch(access_requests::resolve).route_layer(state.permissions.require(["team:update"])),
        );
    // Core: WeldObjects, custom fields, object templates and grid views
    // (P4, sub-phase 4e). Served in conformance builds while the port is
    // checked; mounted unconditionally once complete.
    let router = if cfg!(feature = "conformance") {
        let objects = weldsuite_core_objects::CoreObjectsState {
            events: state.infra.events.clone(),
        };
        let gate = &state.permissions;
        router
            .nest(
                "/custom-objects",
                weldsuite_core_objects::custom_objects_router(objects.clone(), gate),
            )
            .nest(
                "/objects",
                weldsuite_core_objects::objects_router(objects.clone(), gate),
            )
            .nest(
                "/related",
                weldsuite_core_objects::related_router(objects.clone(), gate),
            )
            .nest(
                "/custom-fields",
                weldsuite_core_objects::custom_fields_router(objects.clone(), gate),
            )
            .nest(
                "/object-templates",
                weldsuite_core_objects::object_templates_router(objects.clone(), gate),
            )
            .nest(
                "/grid-views",
                weldsuite_core_objects::grid_views_router(objects, gate),
            )
    } else {
        router
    };
    let router = core_team(router, state);
    let router = if mounts("know") {
        let know = weldsuite_know::KnowState {
            events: state.infra.events.clone(),
        };
        router.nest(
            "/knowledge",
            weldsuite_know::router(know, &state.permissions),
        )
    } else {
        router
    };
    let router = if mounts("sign") {
        let sign = sign_state(state);
        // The finalize job runs where the jobs adapter calls it: in this
        // process, or from Restate through this pod's jobs endpoint.
        state
            .infra
            .job_registry
            .register(weldsuite_sign::FinalizeJob {
                tenants: Arc::new(crate::cron::WorkspaceTenants(Arc::clone(&state.workspaces))),
                master: state.workspaces.master().clone(),
                services: sign.services(),
            });
        router.nest("/sign", weldsuite_sign::router(sign, &state.permissions))
    } else {
        router
    };
    // Core files, drive and search (P4c): mounted unconditionally once complete.
    if cfg!(feature = "conformance") {
        let files = weldsuite_core_files::CoreFilesState {
            events: state.infra.events.clone(),
            files: file_stores(state),
            public_files_url: state.files_public_url.clone(),
        };
        let gate = &state.permissions;
        return router
            .nest(
                "/files",
                weldsuite_core_files::files_router(files.clone(), gate),
            )
            .nest(
                "/folders",
                weldsuite_core_files::folders_router(files.clone(), gate),
            )
            .nest(
                "/drive",
                weldsuite_core_files::drive_router(files.clone(), gate),
            )
            .nest("/search", weldsuite_core_files::search_router(files, gate));
    }
    router
}

/// WeldSign's handle on the app: databases, files, mail, cache, flags, jobs.
pub(crate) fn sign_state(state: &AppState) -> weldsuite_sign::SignState {
    weldsuite_sign::SignState {
        events: state.infra.events.clone(),
        session_secret: state.sign_session_secret.clone(),
        files: file_stores(state),
        master: Some(state.workspaces.master().clone()),
        mail: state.infra.mail.clone(),
        cache: state.infra.cache.clone(),
        flags: Arc::clone(&state.infra.flags),
        jobs: Some(Arc::clone(&state.infra.jobs)),
        portal_url: state.sign_portal_url.clone(),
        environment: Some(Arc::from(state.environment.as_str())),
    }
}

/// The private bucket and the legacy public one, when object storage is
/// configured.
fn file_stores(state: &AppState) -> Option<weldsuite_ports::FileStores> {
    state
        .infra
        .files
        .clone()
        .map(|private| weldsuite_ports::FileStores {
            private,
            public: state.infra.public_files.clone(),
        })
}

/// The team and settings routes of the core platform
/// (`weldsuite-core-team`), each at its app-api prefix.
///
/// Served in conformance builds only while the port is incomplete: core
/// areas are mounted unconditionally once complete, which for this crate is
/// when every group's suite passes with every route covered.
fn core_team(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !cfg!(feature = "conformance") {
        return router;
    }
    let team = core_team_state(state);
    let gate = &state.permissions;
    router
        .nest(
            "/team-members",
            weldsuite_core_team::team_members(team.clone(), gate),
        )
        .nest("/roles", weldsuite_core_team::roles(team.clone(), gate))
        .nest("/my-role", weldsuite_core_team::my_role(team.clone(), gate))
        .nest(
            "/member-limits",
            weldsuite_core_team::member_limits(team.clone(), gate),
        )
        .nest(
            "/workspace-settings",
            weldsuite_core_team::workspace_settings(team.clone(), gate),
        )
        .nest(
            "/settings/profile",
            weldsuite_core_team::settings_profile(team.clone(), gate),
        )
        .nest(
            "/user-preferences",
            weldsuite_core_team::user_preferences(team.clone(), gate),
        )
        .nest(
            "/notification-preferences",
            weldsuite_core_team::notification_preferences(team.clone(), gate),
        )
        .nest(
            "/push-tokens",
            weldsuite_core_team::push_tokens(team.clone(), gate),
        )
        .nest(
            "/app-catalog",
            weldsuite_core_team::app_catalog(team.clone(), gate),
        )
        .nest("/workspaces", weldsuite_core_team::workspaces(team, gate))
}

/// The routes that need a session but no workspace (app-api mounts them
/// above its `/api/*` guard): `/api/account`, `/api/invitations`. Relative
/// to `/api`; the server puts only the session layer in front of them.
///
/// Conformance builds only, like [`core_team`].
pub(crate) fn account(state: &AppState) -> Router<AppState> {
    if !cfg!(feature = "conformance") {
        return Router::new();
    }
    let team = core_team_state(state);
    Router::new()
        .nest("/account", weldsuite_core_team::account(team.clone()))
        .nest("/invitations", weldsuite_core_team::invitations(team))
}

fn core_team_state(state: &AppState) -> weldsuite_core_team::CoreTeamState {
    weldsuite_core_team::CoreTeamState {
        events: state.infra.events.clone(),
        realtime: state.infra.realtime.clone(),
        cache: state.infra.cache.clone(),
        files: state
            .infra
            .files
            .clone()
            .map(|private| weldsuite_ports::FileStores {
                private,
                public: state.infra.public_files.clone(),
            }),
        master: state.workspaces.master().clone(),
        workspaces: std::sync::Arc::clone(&state.workspaces),
        // No identity provider on Kubernetes until the Zitadel adapter (P5,
        // ADR SEC-012); conformance builds take the test's per request.
        identity: None,
    }
}

/// Whether to serve a module: it is marked ported (`ApiModule.rust`, WP
/// 1.10). Conformance builds serve every module with a crate, so a port is
/// checked against its TypeScript tests before it is marked.
fn mounts(module: &str) -> bool {
    cfg!(feature = "conformance")
        || weldsuite_catalogs::api_modules()
            .iter()
            .any(|m| m.id == module && m.rust)
}
