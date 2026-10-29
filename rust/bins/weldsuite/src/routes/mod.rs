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
    if mounts("sign") {
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
        return router.nest("/sign", weldsuite_sign::router(sign, &state.permissions));
    }
    router
}

/// WeldSign's handle on the app: databases, files, mail, cache, flags, jobs.
pub(crate) fn sign_state(state: &AppState) -> weldsuite_sign::SignState {
    weldsuite_sign::SignState {
        events: state.infra.events.clone(),
        session_secret: state.sign_session_secret.clone(),
        files: state
            .infra
            .files
            .clone()
            .map(|private| weldsuite_ports::FileStores {
                private,
                public: state.infra.public_files.clone(),
            }),
        master: Some(state.workspaces.master().clone()),
        mail: state.infra.mail.clone(),
        cache: state.infra.cache.clone(),
        flags: Arc::clone(&state.infra.flags),
        jobs: Some(Arc::clone(&state.infra.jobs)),
        portal_url: state.sign_portal_url.clone(),
        environment: Some(Arc::from(state.environment.as_str())),
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
