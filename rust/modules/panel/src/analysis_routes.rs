//! The routers of panel-api's analysis routes: insights (root cause and AI
//! themes across recordings), metric tree values and usage, each relative
//! to its prefix, behind the session, tenant database, licence and flag
//! layers like [`crate::router`].

use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post};
use weldsuite_catalogs::permission_keys::{
    PANEL_PROJECTS_MANAGE, PANEL_RECORDINGS_READ, PANEL_REPORTS_READ,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{PanelState, ai_summaries, explain, metric_tree_values, usage};

/// `/api/panel/insights`: `explain` (root cause, `panel_reports:read`) and
/// `summarise` (AI themes, `panel_recordings:read`; the handler also checks
/// `panel_reports:read`).
pub fn insights_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/explain",
            post(explain::explain).route_layer(gate.require([PANEL_REPORTS_READ])),
        )
        .route(
            "/summarise",
            post(ai_summaries::summarise).route_layer(gate.require([PANEL_RECORDINGS_READ])),
        )
        .with_state(state)
}

/// `/api/panel/metric-tree-values`.
pub fn metric_tree_values_router<S, Q>(
    state: PanelState,
    gate: &Arc<PermissionGate<Q>>,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([PANEL_REPORTS_READ]);
    Router::new()
        .route("/", post(metric_tree_values::preview).route_layer(read()))
        .route("/{id}", post(metric_tree_values::saved).route_layer(read()))
        .with_state(state)
}

/// `/api/panel/usage`: `panel_projects:manage`.
pub fn usage_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/",
            get(usage::usage).route_layer(gate.require([PANEL_PROJECTS_MANAGE])),
        )
        .with_state(state)
}
