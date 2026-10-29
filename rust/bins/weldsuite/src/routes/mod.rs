//! The ported `/api` routes, by object, as the workers organise them. Paths,
//! bodies, status codes and messages are the TypeScript routes'; the
//! conformance suite (`rust/conformance/suites.json`) runs their tests here.
//!
//! Core routes live in this crate; a ported `weld*` module is its own crate
//! under `rust/modules/` and is mounted at its path prefix.

mod access_requests;
mod feature_flags;
mod me;

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
