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
        let sign = weldsuite_sign::SignState {
            events: state.infra.events.clone(),
            session_secret: state.sign_session_secret.clone(),
            files: file_stores(state),
        };
        router.nest("/sign", weldsuite_sign::router(sign, &state.permissions))
    } else {
        router
    };
    // Core files, drive, search and storage (P4c): mounted unconditionally
    // once complete.
    if cfg!(feature = "conformance") {
        let files = core_files_state(state);
        // The 30-day purge `DELETE /api/files/:id` starts.
        state
            .infra
            .job_registry
            .register(weldsuite_core_files::TrashPurgeJob::new(
                tenant_databases(state),
                file_stores(state),
            ));
        let gate = &state.permissions;
        return router
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
            .nest("/search", weldsuite_core_files::search_router(files, gate));
    }
    router
}

/// The routes served before authentication, at their full paths:
/// `/api/storage/upload/:token`, `/api/storage/private/*` and
/// `/api/storage/public/*` (each checks its own credential). Empty until
/// core files are mounted.
pub(crate) fn public(state: &AppState) -> Router<AppState> {
    if cfg!(feature = "conformance") {
        weldsuite_core_files::storage_public_router(core_files_state(state))
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

/// Whether to serve a module: it is marked ported (`ApiModule.rust`, WP
/// 1.10). Conformance builds serve every module with a crate, so a port is
/// checked against its TypeScript tests before it is marked.
fn mounts(module: &str) -> bool {
    cfg!(feature = "conformance")
        || weldsuite_catalogs::api_modules()
            .iter()
            .any(|m| m.id == module && m.rust)
}
