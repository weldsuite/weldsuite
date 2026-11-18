//! The routers of panel-api's visitor routes: people (with erasure),
//! groups, sessions and recordings, heatmaps and the live view, each
//! relative to its prefix, behind the session, tenant database, licence and
//! flag layers like [`crate::router`].

use std::sync::Arc;

use axum::Router;
use axum::routing::{delete, get, patch, post, put};
use weldsuite_catalogs::permission_keys::{
    PANEL_PEOPLE_DELETE, PANEL_PEOPLE_READ, PANEL_RECORDINGS_READ, PANEL_REPORTS_CREATE,
    PANEL_REPORTS_DELETE, PANEL_REPORTS_READ, PANEL_REPORTS_UPDATE, PEOPLE_READ,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{PanelState, groups, heatmaps, live, people, sessions};

/// `/api/panel/people`.
pub fn people_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([PANEL_PEOPLE_READ]);
    Router::new()
        .route("/", get(people::list).route_layer(read()))
        // `people:read` too: the WeldCRM person card.
        .route(
            "/by-email",
            get(people::by_email).route_layer(gate.require([PANEL_PEOPLE_READ, PEOPLE_READ])),
        )
        .route("/{id}", get(people::detail).route_layer(read()))
        .route(
            "/{id}",
            delete(people::erase).route_layer(gate.require([PANEL_PEOPLE_DELETE])),
        )
        .with_state(state)
}

/// `/api/panel/groups`.
pub fn groups_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([PANEL_PEOPLE_READ]);
    Router::new()
        .route("/", get(groups::list).route_layer(read()))
        .route("/{type}/{key}", get(groups::profile).route_layer(read()))
        .route(
            "/{type}/{key}",
            delete(groups::remove).route_layer(gate.require([PANEL_PEOPLE_DELETE])),
        )
        .with_state(state)
}

/// `/api/panel/sessions`.
pub fn sessions_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let watch = || gate.require([PANEL_RECORDINGS_READ]);
    Router::new()
        .route("/{id}", get(sessions::detail).route_layer(watch()))
        .route(
            "/{id}/chunks/{seq}",
            get(sessions::chunk).route_layer(watch()),
        )
        .route(
            "/{id}/favorite",
            put(sessions::favorite).route_layer(watch()),
        )
        .route(
            "/{id}/favorite",
            delete(sessions::unfavorite).route_layer(watch()),
        )
        .route("/{id}/summary", get(sessions::summary).route_layer(watch()))
        .with_state(state)
}

/// `/api/panel/heatmaps`.
pub fn heatmaps_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/pages",
            get(heatmaps::list).route_layer(gate.require([PANEL_REPORTS_READ])),
        )
        .route(
            "/pages",
            post(heatmaps::create).route_layer(gate.require([PANEL_REPORTS_CREATE])),
        )
        .route(
            "/pages/{id}",
            patch(heatmaps::update).route_layer(gate.require([PANEL_REPORTS_UPDATE])),
        )
        .route(
            "/pages/{id}",
            delete(heatmaps::remove).route_layer(gate.require([PANEL_REPORTS_DELETE])),
        )
        // What a visitor saw: the recordings permission, not the reports one.
        .route(
            "/pages/{id}/snapshot",
            get(heatmaps::snapshot).route_layer(gate.require([PANEL_RECORDINGS_READ])),
        )
        .with_state(state)
}

/// `/api/panel/live`.
pub fn live_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/",
            get(live::live).route_layer(gate.require([PANEL_REPORTS_READ])),
        )
        .with_state(state)
}
