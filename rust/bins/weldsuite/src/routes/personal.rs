//! personal-api (`weldsuite-personal`): the person's own surface (consumer
//! WeldMail and WeldCalendar, ADR MAIL-008), at `/personal-api` on this
//! host. It has no API module id, so it is served whenever the shared
//! personal database is configured (`DATABASE_URL_PERSONAL`, migrated by
//! `weldsuite migrate --personal`); without it, `/personal-api` is the
//! server's 404. Conformance builds always serve it, with each request's
//! test databases, session key, bindings and outbound bridge.

use std::sync::Arc;

use axum::Router;

use crate::server::AppState;

/// The router at [`weldsuite_personal::BASE_PATH`], or none.
pub(crate) fn router(state: &AppState) -> Router {
    let conformance = cfg!(feature = "conformance");
    let personal = std::env::var("DATABASE_URL_PERSONAL")
        .ok()
        .filter(|url| !url.trim().is_empty());
    if personal.is_none() && !conformance {
        return Router::new();
    }
    let personal = match personal
        .map(|url| weldsuite_db::master_pool(&url, personal_max_connections()))
    {
        Some(Ok(pool)) => Some(pool),
        Some(Err(error)) => {
            tracing::error!(%error, "DATABASE_URL_PERSONAL is not a Postgres URL: personal-api is off");
            return Router::new();
        }
        None => None,
    };
    let router = weldsuite_personal::router(weldsuite_personal::PersonalState {
        master: Some(state.workspaces.master().clone()),
        personal,
        verifier: Some(Arc::clone(&state.verifier)),
        outbound: super::deployment_outbound(state),
        // Expo push and one-click unsubscribes; conformance builds take the
        // test's bridge per request.
        http: (!conformance)
            .then(|| {
                weldsuite_adapters_oss::ReqwestOutbound::new(std::time::Duration::from_secs(10))
                    .ok()
            })
            .flatten()
            .map(|client| weldsuite_ports::OutboundHttp(Arc::new(client))),
        tracker: state.infra.events.tracker().clone(),
        environment: state.environment.clone(),
        env: Arc::default(),
    });
    #[cfg(feature = "conformance")]
    let router = router
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state.conformance_pools),
            crate::conformance::personal_db,
        ))
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state.conformance_pools),
            crate::conformance::public,
        ));
    Router::new().nest(weldsuite_personal::BASE_PATH, router)
}

/// `DATABASE_URL_PERSONAL`'s pool size (`PERSONAL_DB_MAX_CONNECTIONS`, 5).
fn personal_max_connections() -> u32 {
    std::env::var("PERSONAL_DB_MAX_CONNECTIONS")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|max| *max > 0)
        .unwrap_or(5)
}
