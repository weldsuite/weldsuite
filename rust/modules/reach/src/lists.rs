//! `/api/reach/lists` (`routes/lists`): prospect lists and their members.
//! Lists are organisation only: nothing here publishes an event.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_reach_domain::lists::{self, PageQuery};

use crate::prospects::page_response;
use crate::{Caller, ReachState, respond, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ReachState> {
    let read = || gate.require([perm::REACH_PROSPECTS_READ]);
    let update = || gate.require([perm::REACH_PROSPECTS_UPDATE]);
    Router::new()
        .route(
            "/",
            get(list)
                .route_layer(read())
                .merge(post(create).route_layer(gate.require([perm::REACH_PROSPECTS_CREATE]))),
        )
        .route(
            "/{id}",
            get(read_one)
                .route_layer(read())
                .merge(axum::routing::patch(update_one).route_layer(update()))
                .merge(
                    axum::routing::delete(delete_one)
                        .route_layer(gate.require([perm::REACH_PROSPECTS_DELETE])),
                ),
        )
        .route("/{id}/members", post(add_members).route_layer(update()))
        .route(
            "/{id}/members/remove",
            post(remove_members).route_layer(update()),
        )
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    respond(
        lists::list_lists(&caller.db, &PageQuery::from_query(query.as_deref()))
            .await
            .map(page_response),
    )
}

async fn read_one(caller: Caller, Path(id): Path<String>) -> Response {
    respond(
        lists::get_list(&caller.db, &id)
            .await
            .map(|l| Data(l).into_response()),
    )
}

/// `createReachListSchema` (`partial` for an update).
fn list_input(
    issues: &mut Issues,
    body: &Map<String, Value>,
    presence: Presence,
) -> (Option<String>, Field<String>) {
    let name = issues
        .text_with(body, "name", presence, Text::trimmed(Some(1), Some(200)))
        .into_option();
    let description = issues.text_with(
        body,
        "description",
        Presence::Optional,
        Text::trimmed(None, Some(2000)),
    );
    (name, description)
}

async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let (name, description) = match validate(&headers, &body, |issues, body| {
        list_input(issues, body, Presence::Required)
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    respond(
        async {
            let row = lists::create_list(
                &caller.db,
                name.as_deref().unwrap_or_default(),
                description.as_set().map(String::as_str),
                "manual",
                None,
                Some(&caller.user_id),
            )
            .await?;
            Ok((StatusCode::CREATED, Data(lists::to_list(&row))).into_response())
        }
        .await,
    )
}

async fn update_one(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (name, description) = match validate(&headers, &body, |issues, body| {
        list_input(issues, body, Presence::Optional)
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let description = description.into_option();
    respond(
        lists::update_list(
            &caller.db,
            &id,
            name.as_deref(),
            description.as_deref().map(Some),
        )
        .await
        .map(|l| Data(l).into_response()),
    )
}

async fn delete_one(caller: Caller, Path(id): Path<String>) -> Response {
    respond(
        lists::delete_list(&caller.db, &id)
            .await
            .map(|()| NoContent.into_response()),
    )
}

/// `reachListMembersSchema`.
fn members(headers: &HeaderMap, body: &Bytes) -> Result<Vec<String>, Response> {
    validate(headers, body, |issues, body| {
        issues
            .list(
                body,
                "prospectIds",
                Presence::Required,
                Some(1),
                Some(5000),
                |issues, item| issues.item_text(item, Text::length(Some(1), Some(30))),
            )
            .into_option()
            .unwrap_or_default()
    })
}

async fn add_members(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ids = match members(&headers, &body) {
        Ok(ids) => ids,
        Err(response) => return response,
    };
    respond(
        lists::add_members(&caller.db, &id, &ids)
            .await
            .map(|r| Data(r).into_response()),
    )
}

async fn remove_members(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ids = match members(&headers, &body) {
        Ok(ids) => ids,
        Err(response) => return response,
    };
    respond(
        lists::remove_members(&caller.db, &id, &ids)
            .await
            .map(|r| Data(r).into_response()),
    )
}
