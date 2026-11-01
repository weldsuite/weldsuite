//! WeldHost (`weldsuite-host`): host-api's `/api/domains`, `/api/dns-zones`,
//! `/api/dns-records`, `/api/domain-transfers` and `/api/email-forwards`,
//! and Realtime Register's webhook at `/public/webhooks/realtime-register`.
//! Served once `host` is marked ported; conformance builds always mount it.

use std::sync::{Arc, OnceLock};

use axum::Router;

use crate::server::AppState;

/// host-api's `/api` prefixes, under `/api`.
pub(crate) fn api(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !super::mounts("host") {
        return router;
    }
    router.merge(weldsuite_host::router(
        host_state(state),
        &state.permissions,
    ))
}

/// The Realtime Register webhook, ahead of the session. Conformance builds
/// open the test's tenant database for every workspace.
pub(crate) fn public(state: &AppState) -> Router<AppState> {
    if !super::mounts("host") {
        return Router::new();
    }
    let router = weldsuite_host::public_router(host_state(state));
    #[cfg(feature = "conformance")]
    let router = router.route_layer(axum::middleware::from_fn_with_state(
        Arc::clone(&state.conformance_pools),
        crate::conformance::public_tenant,
    ));
    router
}

/// WeldHost's handle on the app: events, the cache (Realtime Register
/// process mappings), the master database (TLD pricing, the due index),
/// outbound HTTP (Realtime Register, Cloudflare, DNS over HTTPS) and the
/// workspaces' tenant databases. Conformance builds take the test's KV,
/// master database and fetch stub per request.
fn host_state(state: &AppState) -> weldsuite_host::HostState {
    static HTTP: OnceLock<Option<weldsuite_ports::OutboundHttp>> = OnceLock::new();
    let conformance = cfg!(feature = "conformance");
    let workspaces = Arc::clone(&state.workspaces);
    let tenants: weldsuite_host::TenantDatabases = Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| (tenant.db, tenant.workspace_id))
                .map_err(|error| error.to_string())
        })
    });
    weldsuite_host::HostState {
        events: state.infra.events.clone(),
        cache: if conformance {
            None
        } else {
            state.infra.cache.clone()
        },
        master: (!conformance).then(|| state.workspaces.master().clone()),
        http: if conformance {
            None
        } else {
            HTTP.get_or_init(|| {
                weldsuite_adapters_oss::ReqwestOutbound::new(std::time::Duration::from_secs(30))
                    .ok()
                    .map(|client| weldsuite_ports::OutboundHttp(Arc::new(client)))
            })
            .clone()
        },
        tenants: Some(tenants),
    }
}
