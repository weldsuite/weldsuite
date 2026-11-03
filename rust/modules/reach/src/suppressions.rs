//! `/api/reach/suppressions` (`routes/suppressions`): the suppression list.
//! No event for the entries themselves; campaigns a suppression empties are
//! completed and announced.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use http::{HeaderMap, StatusCode};
use serde_json::json;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_reach_domain::lists::PageQuery;
use weldsuite_reach_domain::suppressions;

use crate::prospects::page_response;
use crate::{Caller, ReachState, respond, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ReachState> {
    let update = || gate.require([perm::REACH_SETTINGS_UPDATE]);
    Router::new()
        .route(
            "/",
            get(list)
                .route_layer(gate.require([perm::REACH_SETTINGS_READ]))
                .merge(axum::routing::post(add).route_layer(update())),
        )
        .route("/{id}", delete(remove).route_layer(update()))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    respond(
        suppressions::list(&caller.db, &PageQuery::from_query(query.as_deref()))
            .await
            .map(page_response),
    )
}

async fn add(
    State(state): State<ReachState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let values = match validate(&headers, &body, |issues, body| {
        issues
            .list(
                body,
                "values",
                Presence::Required,
                Some(1),
                Some(10_000),
                |issues, item| {
                    issues.item_text(
                        item,
                        Text {
                            trim: true,
                            lowercase: true,
                            format: None,
                            min: Some(3),
                            max: Some(320),
                        },
                    )
                },
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(values) => values,
        Err(response) => return response,
    };
    let sink = caller.sink(&state);
    respond(
        suppressions::add_manual(&caller.db, &sink, &values, &caller.user_id)
            .await
            .map(|(added, skipped)| {
                (
                    StatusCode::CREATED,
                    Data(json!({ "added": added, "skipped": skipped })),
                )
                    .into_response()
            }),
    )
}

async fn remove(caller: Caller, Path(id): Path<String>) -> Response {
    respond(
        suppressions::remove(&caller.db, &id)
            .await
            .map(|()| NoContent.into_response()),
    )
}
