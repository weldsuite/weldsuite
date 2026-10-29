//! The ported `/api` routes, by object, as the workers organise them. Paths,
//! bodies, status codes and messages are the TypeScript routes'; the
//! conformance suite (`rust/conformance/suites.json`) runs their tests here.
//!
//! Core routes live in this crate; a ported `weld*` module is its own crate
//! under `rust/modules/` and is mounted at its path prefix.

mod access_requests;
mod feature_flags;
mod me;

use std::sync::{Arc, OnceLock};

use axum::Router;
use axum::routing::{get, patch, post};
use weldsuite_ports::{DynCache, MemoryCache};

use crate::server::AppState;

/// Every ported route, relative to `/api`.
#[allow(clippy::too_many_lines)] // one block per mounted module or core area
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
    let router = core_apps(router, state);
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
    let router = chat(router, state);
    core_files(router, state)
}

/// Core files, drive, search and storage (P4c), with the 30-day purge
/// `DELETE /api/files/:id` starts. Conformance builds only until complete,
/// like [`core_team`].
fn core_files(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !cfg!(feature = "conformance") {
        return router;
    }
    let files = core_files_state(state);
    state
        .infra
        .job_registry
        .register(weldsuite_core_files::TrashPurgeJob::new(
            tenant_databases(state),
            file_stores(state),
        ));
    let gate = &state.permissions;
    router
        .nest(
            "/storage",
            weldsuite_core_files::storage_router(files.clone(), gate),
        )
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
        .nest("/search", weldsuite_core_files::search_router(files, gate))
}

/// The routes served before authentication, at their full paths:
/// `/api/storage/upload/:token`, `/api/storage/private/*` and
/// `/api/storage/public/*` (each checks its own credential), the CLI's
/// device login (`/api/cli-auth/device`, `/api/cli-auth/token`) and the
/// WeldApps bundle host (`/public/user-apps/*`). Empty until core files and
/// WeldApps are mounted.
pub(crate) fn public(state: &AppState) -> Router<AppState> {
    if cfg!(feature = "conformance") {
        let apps = core_apps_state(state);
        weldsuite_core_files::storage_public_router(core_files_state(state))
            .nest(
                "/api/cli-auth",
                weldsuite_core_apps::cli_auth_public(apps.clone()),
            )
            .nest(
                "/public/user-apps",
                weldsuite_core_apps::public_user_apps(apps),
            )
    } else {
        Router::new()
    }
}

/// The core files state, shared by the authenticated and the public routes.
fn core_files_state(state: &AppState) -> weldsuite_core_files::CoreFilesState {
    weldsuite_core_files::CoreFilesState {
        events: state.infra.events.clone(),
        files: file_stores(state),
        public_files_url: state.files_public_url.clone(),
        storage: weldsuite_core_files::StorageState {
            cache: Some(upload_token_cache(state)),
            verifier: Some(Arc::clone(&state.verifier)),
            signing_key: state.storage_signing_key.clone(),
            environment: Arc::from(state.environment.as_str()),
            jobs: Some(Arc::clone(&state.infra.jobs)),
        },
    }
}

/// Where upload tokens live: Valkey, or without it one in-process cache for
/// the whole process (enough for a single replica), shared by the route that
/// mints a token and the one that redeems it.
fn upload_token_cache(state: &AppState) -> Arc<dyn DynCache> {
    static LOCAL: OnceLock<Arc<dyn DynCache>> = OnceLock::new();
    state.infra.cache.clone().unwrap_or_else(|| {
        Arc::clone(LOCAL.get_or_init(|| {
            tracing::warn!("VALKEY_URL is not set: upload tokens live in this process only");
            Arc::new(MemoryCache::new())
        }))
    })
}

/// A workspace's tenant database for jobs, which run outside any request.
fn tenant_databases(state: &AppState) -> weldsuite_core_files::TenantDatabases {
    let workspaces = Arc::clone(&state.workspaces);
    Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    })
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
        .nest(
            "/auth-desktop",
            weldsuite_core_apps::auth_desktop(core_apps_state(state)),
        )
}

/// WeldApps (`weldsuite-core-apps`): `/api/user-apps` and the CLI login's
/// approval, behind the session and workspace layers.
///
/// Conformance builds only, like [`core_team`].
fn core_apps(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !cfg!(feature = "conformance") {
        return router;
    }
    let apps = core_apps_state(state);
    router
        .nest(
            "/user-apps",
            weldsuite_core_apps::user_apps(apps.clone(), &state.permissions),
        )
        .nest("/cli-auth", weldsuite_core_apps::cli_auth_approve(apps))
}

/// What the WeldApps routers share in the process: the outbound HTTP client,
/// the env settings they read (`EXTERNAL_API_URL`, the bundle signing secret,
/// …) and the app gateway's token cache.
type AppsShared = (
    std::sync::Arc<dyn weldsuite_core_apps::HttpTransport>,
    std::sync::Arc<std::collections::HashMap<String, String>>,
    std::sync::Arc<weldsuite_core_apps::GatewayTokens>,
);

fn apps_shared() -> &'static AppsShared {
    static SHARED: std::sync::OnceLock<AppsShared> = std::sync::OnceLock::new();
    SHARED.get_or_init(|| {
        (
            std::sync::Arc::new(weldsuite_core_apps::ReqwestTransport::new()),
            std::sync::Arc::new(weldsuite_core_apps::CoreAppsState::env_from_process()),
            std::sync::Arc::default(),
        )
    })
}

/// The env settings of the WeldApps routes, for the server's bundle-host
/// guard.
pub(crate) fn apps_env() -> std::sync::Arc<std::collections::HashMap<String, String>> {
    std::sync::Arc::clone(&apps_shared().1)
}

fn core_apps_state(state: &AppState) -> weldsuite_core_apps::CoreAppsState {
    let (http, env, gateway_tokens) = apps_shared();
    weldsuite_core_apps::CoreAppsState {
        events: state.infra.events.clone(),
        master: state.workspaces.master().clone(),
        workspaces: std::sync::Arc::clone(&state.workspaces),
        cache: state.infra.cache.clone(),
        files: file_stores(state),
        // No identity provider on Kubernetes until the Zitadel adapter (P5,
        // ADR SEC-012); conformance builds take the test's per request.
        identity: None,
        http: std::sync::Arc::clone(http),
        env: std::sync::Arc::clone(env),
        gateway_tokens: std::sync::Arc::clone(gateway_tokens),
    }
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

/// WeldChat (`weldsuite-chat`): chat-api's object routes, each at its own
/// prefix, once the module is marked ported (always in conformance builds).
fn chat(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !mounts("chat") {
        return router;
    }
    let chat = chat_state(state);
    // The pin auto-expiry runs where the jobs adapter calls it.
    state
        .infra
        .job_registry
        .register(weldsuite_chat::UnpinExpiredMessageJob {
            tenants: chat_tenants(state),
            realtime: state.infra.realtime.clone(),
        });
    let gate = &state.permissions;
    router
        .nest(
            "/channel-members",
            weldsuite_chat::channel_members(chat.clone(), gate),
        )
        .nest("/channels", weldsuite_chat::channels(chat.clone(), gate))
        .nest("/chat-activity", weldsuite_chat::activity(chat.clone(), gate))
        .nest("/chat-directories", weldsuite_chat::directories(chat.clone(), gate))
        .nest("/chat-dm", weldsuite_chat::dm(chat.clone(), gate))
        .nest("/chat-search", weldsuite_chat::search(chat.clone(), gate))
        .nest("/chat-messages", weldsuite_chat::messages(chat.clone(), gate))
        .nest("/chat-bookmarks", weldsuite_chat::bookmarks(chat.clone(), gate))
        .nest("/chat-drafts", weldsuite_chat::drafts(chat.clone(), gate))
        .nest("/chat-sections", weldsuite_chat::sections(chat.clone(), gate))
        .nest("/chat-status", weldsuite_chat::status(chat, gate))
}

/// WeldChat's handle on the app: events, realtime, files, jobs, its env.
fn chat_state(state: &AppState) -> weldsuite_chat::ChatState {
    static ENV: std::sync::OnceLock<Arc<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    let env = ENV.get_or_init(|| {
        let names = [
            "R2_PUBLIC_URL",
            "PUBLIC_APP_URL",
            "CALL_RING_SECRET",
            "APNS_KEY_ID",
            "APNS_TEAM_ID",
            "APNS_PRIVATE_KEY",
        ];
        Arc::new(
            names
                .iter()
                .filter_map(|name| std::env::var(name).ok().map(|value| ((*name).to_owned(), value)))
                .collect(),
        )
    });
    weldsuite_chat::ChatState {
        events: state.infra.events.clone(),
        realtime: state.infra.realtime.clone(),
        // Conformance: the test's KV through the request only, as a worker
        // without the binding has no rate limit or call bookkeeping.
        cache: if cfg!(feature = "conformance") {
            None
        } else {
            state.infra.cache.clone()
        },
        // Conformance: the test's STORAGE bucket through the request only.
        files: if cfg!(feature = "conformance") {
            None
        } else {
            file_stores(state)
        },
        jobs: Some(Arc::clone(&state.infra.jobs)),
        unpin_jobs: !cfg!(feature = "conformance"),
        http: None,
        presence: None,
        env: Arc::clone(env),
    }
}

/// A workspace's tenant database for WeldChat's jobs.
fn chat_tenants(state: &AppState) -> weldsuite_chat::TenantDatabases {
    let workspaces = Arc::clone(&state.workspaces);
    Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    })
}
