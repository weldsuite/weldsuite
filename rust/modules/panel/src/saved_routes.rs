//! The routers of panel-api's saved objects, each relative to its prefix
//! under `/api/panel` (`src/index.ts`), behind the session, tenant
//! database, licence and flag layers; and the public share routes under
//! `/public/panel`. Each route checks the permission panel-api's does.

use std::sync::Arc;

use axum::Router;
use axum::routing::{delete, get, patch, post, put};
use weldsuite_catalogs::permission_keys::{
    PANEL_REPORTS_CREATE, PANEL_REPORTS_DELETE, PANEL_REPORTS_READ, PANEL_REPORTS_UPDATE,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::definitions::{computed_properties, custom_events};
use crate::{
    PanelState, annotations, cohorts, comments, dashboards, group_types, metric_trees, path_rules,
    public_share, reports, share_links,
};

/// The four `panel_reports` layers: read, create, update, delete.
struct Layers<'a, Q> {
    gate: &'a Arc<PermissionGate<Q>>,
}

impl<Q: PermissionQueries + 'static> Layers<'_, Q> {
    fn read(&self) -> weldsuite_permissions::PermissionLayer<Q> {
        self.gate.require([PANEL_REPORTS_READ])
    }
    fn create(&self) -> weldsuite_permissions::PermissionLayer<Q> {
        self.gate.require([PANEL_REPORTS_CREATE])
    }
    fn update(&self) -> weldsuite_permissions::PermissionLayer<Q> {
        self.gate.require([PANEL_REPORTS_UPDATE])
    }
    fn delete(&self) -> weldsuite_permissions::PermissionLayer<Q> {
        self.gate.require([PANEL_REPORTS_DELETE])
    }
}

/// `/api/panel/reports`.
pub fn reports_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let layers = Layers { gate };
    Router::new()
        .route("/", get(reports::list).route_layer(layers.read()))
        .route("/", post(reports::create).route_layer(layers.create()))
        .route("/{id}", get(reports::detail).route_layer(layers.read()))
        .route("/{id}", patch(reports::update).route_layer(layers.update()))
        .route(
            "/{id}",
            delete(reports::remove).route_layer(layers.delete()),
        )
        .route(
            "/{id}/versions",
            get(reports::versions).route_layer(layers.read()),
        )
        .route(
            "/{id}/versions/{version}",
            get(reports::version).route_layer(layers.read()),
        )
        .route(
            "/{id}/versions/{version}/restore",
            post(reports::restore).route_layer(layers.update()),
        )
        .with_state(state)
}

/// `/api/panel/dashboards`.
pub fn dashboards_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let layers = Layers { gate };
    Router::new()
        .route("/", get(dashboards::list).route_layer(layers.read()))
        .route("/", post(dashboards::create).route_layer(layers.create()))
        .route(
            "/templates",
            get(dashboards::list_templates).route_layer(layers.read()),
        )
        .route(
            "/from-template",
            post(dashboards::from_template).route_layer(layers.create()),
        )
        .route("/{id}", get(dashboards::detail).route_layer(layers.read()))
        .route(
            "/{id}",
            patch(dashboards::update).route_layer(layers.update()),
        )
        .route(
            "/{id}",
            delete(dashboards::remove).route_layer(layers.delete()),
        )
        .route(
            "/{id}/tiles",
            post(dashboards::add_tile).route_layer(layers.update()),
        )
        .route(
            "/{id}/tiles/{tile_id}",
            patch(dashboards::update_tile_route)
                .delete(dashboards::remove_tile)
                .route_layer(layers.update()),
        )
        .route(
            "/{id}/layout",
            put(dashboards::set_layout).route_layer(layers.update()),
        )
        .with_state(state)
}

/// `/api/panel/cohorts`.
pub fn cohorts_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let layers = Layers { gate };
    Router::new()
        .route("/", get(cohorts::list).route_layer(layers.read()))
        .route("/", post(cohorts::create).route_layer(layers.create()))
        .route("/{id}", get(cohorts::detail).route_layer(layers.read()))
        .route("/{id}", patch(cohorts::update).route_layer(layers.update()))
        .route(
            "/{id}",
            delete(cohorts::remove).route_layer(layers.delete()),
        )
        .with_state(state)
}

/// `/api/panel/annotations`.
pub fn annotations_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let layers = Layers { gate };
    Router::new()
        .route("/", get(annotations::list).route_layer(layers.read()))
        .route("/", post(annotations::create).route_layer(layers.create()))
        .route("/{id}", get(annotations::detail).route_layer(layers.read()))
        .route(
            "/{id}",
            patch(annotations::update).route_layer(layers.update()),
        )
        .route(
            "/{id}",
            delete(annotations::remove).route_layer(layers.delete()),
        )
        .with_state(state)
}

/// `/api/panel/comments`.
pub fn comments_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let layers = Layers { gate };
    Router::new()
        .route("/", get(comments::list).route_layer(layers.read()))
        .route("/", post(comments::create).route_layer(layers.create()))
        .route(
            "/{id}",
            patch(comments::update).route_layer(layers.update()),
        )
        .route(
            "/{id}",
            delete(comments::remove).route_layer(layers.delete()),
        )
        .with_state(state)
}

/// `/api/panel/custom-events`.
pub fn custom_events_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let layers = Layers { gate };
    Router::new()
        .route("/", get(custom_events::list).route_layer(layers.read()))
        .route(
            "/",
            post(custom_events::create).route_layer(layers.create()),
        )
        .route(
            "/{id}",
            get(custom_events::detail).route_layer(layers.read()),
        )
        .route(
            "/{id}",
            patch(custom_events::update).route_layer(layers.update()),
        )
        .route(
            "/{id}",
            delete(custom_events::remove).route_layer(layers.delete()),
        )
        .with_state(state)
}

/// `/api/panel/computed-properties`.
pub fn computed_properties_router<S, Q>(
    state: PanelState,
    gate: &Arc<PermissionGate<Q>>,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let layers = Layers { gate };
    Router::new()
        .route(
            "/",
            get(computed_properties::list).route_layer(layers.read()),
        )
        .route(
            "/",
            post(computed_properties::create).route_layer(layers.create()),
        )
        .route(
            "/{id}",
            get(computed_properties::detail).route_layer(layers.read()),
        )
        .route(
            "/{id}",
            patch(computed_properties::update).route_layer(layers.update()),
        )
        .route(
            "/{id}",
            delete(computed_properties::remove).route_layer(layers.delete()),
        )
        .with_state(state)
}

/// `/api/panel/path-rules`.
pub fn path_rules_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let layers = Layers { gate };
    Router::new()
        .route("/", get(path_rules::list).route_layer(layers.read()))
        .route("/", put(path_rules::set).route_layer(layers.update()))
        .route("/test", post(path_rules::test).route_layer(layers.read()))
        .with_state(state)
}

/// `/api/panel/group-types`.
pub fn group_types_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let layers = Layers { gate };
    Router::new()
        .route("/", get(group_types::list).route_layer(layers.read()))
        .route("/", post(group_types::create).route_layer(layers.create()))
        .route(
            "/{id}",
            patch(group_types::update).route_layer(layers.update()),
        )
        .route(
            "/{id}",
            delete(group_types::remove).route_layer(layers.delete()),
        )
        .with_state(state)
}

/// `/api/panel/metric-trees`.
pub fn metric_trees_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let layers = Layers { gate };
    Router::new()
        .route("/", get(metric_trees::list).route_layer(layers.read()))
        .route("/", post(metric_trees::create).route_layer(layers.create()))
        .route(
            "/{id}",
            get(metric_trees::detail).route_layer(layers.read()),
        )
        .route(
            "/{id}",
            patch(metric_trees::update).route_layer(layers.update()),
        )
        .route(
            "/{id}",
            delete(metric_trees::remove).route_layer(layers.delete()),
        )
        .with_state(state)
}

/// `/api/panel/share-links`.
pub fn share_links_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let layers = Layers { gate };
    Router::new()
        .route("/", get(share_links::list).route_layer(layers.read()))
        .route("/", post(share_links::create).route_layer(layers.create()))
        .route(
            "/{id}",
            delete(share_links::revoke).route_layer(layers.delete()),
        )
        .with_state(state)
}

/// `/public/panel/share`'s routes, relative to `/public/panel`: no session,
/// limited per address, never cached.
pub fn public_share_router<S>(state: PanelState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/share/{token}", get(public_share::show))
        .route("/share/{token}/results", post(public_share::results))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            public_share::rate_limit,
        ))
        .with_state(state)
}
