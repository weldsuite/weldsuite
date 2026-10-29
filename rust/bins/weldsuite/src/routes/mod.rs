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
        let sign = weldsuite_sign::SignState {
            events: state.infra.events.clone(),
            session_secret: state.sign_session_secret.clone(),
        };
        return router.nest("/sign", weldsuite_sign::router(sign, &state.permissions));
    }
    router
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
