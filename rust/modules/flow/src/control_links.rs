//! `/api/project-control-links` (`routes/project-control-links/index.ts`):
//! the links between register items, tasks and milestones of a project
//! (ADR FLOW-011).
//!
//! ```text
//! GET    /        links of one object, by its `from` end or its `to` end
//! POST   /        link two objects
//! DELETE /:id     remove a link
//! ```
//!
//! `projects:read` to list, `projects:update` to link and unlink, plus the
//! membership boundary: both ends must be in projects the caller can write
//! (read for a list). The checks run in TypeScript's order: permission, then
//! the objects (404), then project access (403), then the body (400), then
//! the link rules.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use serde_json::Value;
use weldsuite_catalogs::entity_events::{
    PROJECT_CONTROL_LINK_CREATED, PROJECT_CONTROL_LINK_DELETED,
};
use weldsuite_db::is_unique_violation;
use weldsuite_flow_domain::raid::{
    LinkRef, link_ends_error, link_shape_error, present_control_link,
};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::raid::{PROJECT_DENIED, PROJECT_WRITE_DENIED, insert_link, link_values, publish_link};
use crate::raid_body::{Body, link_list_query, parse_body, read_link};
use crate::raid_store::{Direction, link_row, present_linked_objects, resolve_end};
use crate::{Caller, FlowState, Refusal, Reply, outside, reply};

const ALREADY_LINKED: &str = "These objects are already linked";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route("/", post(create).route_layer(need("projects:update")))
        .route("/{id}", delete(remove).route_layer(need("projects:update")))
        .with_state(state)
}

/// `OBJECT_LABELS[type]`.
fn label(link_type: &str) -> &'static str {
    match link_type {
        "raid_item" => "RAID item",
        "task" => "Task",
        "decision" => "Decision",
        "change_request" => "Change request",
        "deliverable" => "Deliverable",
        "benefit" => "Benefit",
        _ => "Milestone",
    }
}

fn text<'a>(body: &'a Body, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// `listQueryError(q)`: the query must name an object whole.
fn list_query_error(q: &Body) -> Option<&'static str> {
    let has = |key: &str| text(q, key).is_some_and(|value| !value.is_empty());
    if has("fromType") != has("fromId") {
        return Some("fromType and fromId must be given together");
    }
    if has("toType") != has("toId") {
        return Some("toType and toId must be given together");
    }
    if !has("fromType") && !has("toType") {
        return Some("Give fromType and fromId, or toType and toId");
    }
    None
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match link_list_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    if let Some(message) = list_query_error(&q) {
        return outside(Err(Refusal::bad_request(message)));
    }
    reply(list_links(&caller, &q).await, "Failed to list links")
}

async fn list_links(caller: &Caller, q: &Body) -> Reply {
    // `queriedObjectsError`: each queried object must exist, in a project the caller is in.
    for (type_key, id_key) in [("fromType", "fromId"), ("toType", "toId")] {
        let (Some(link_type), Some(id)) = (text(q, type_key), text(q, id_key)) else {
            continue;
        };
        let Some(end) = resolve_end(&caller.db, link_type, id).await? else {
            return Err(Refusal::not_found(label(link_type), id));
        };
        if !caller.can_access(&end.project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from project_control_links l
         where ($1::text is null or (l.from_type = $1 and l.from_id = $2))
           and ($3::text is null or (l.to_type = $3 and l.to_id = $4))",
    )
    .bind(text(q, "fromType"))
    .bind(text(q, "fromId"))
    .bind(text(q, "toType"))
    .bind(text(q, "toId"))
    .fetch_all(&caller.db)
    .await?;
    // Seen from the `from` object when one is given, else from the `to` object.
    let direction = if text(q, "fromType").is_some() {
        Direction::Outgoing
    } else {
        Direction::Incoming
    };
    let links = present_linked_objects(
        caller,
        rows.into_iter().map(weldsuite_db::js_row).collect(),
        |_| direction,
    )
    .await?;
    Ok(Data(Value::Array(links)).into_response())
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let input = match parse_body(&body, read_link) {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    let field = |key: &str| text(&input, key).unwrap_or_default();
    let from = LinkRef {
        link_type: field("fromType"),
        id: field("fromId"),
    };
    let to = LinkRef {
        link_type: field("toType"),
        id: field("toId"),
    };
    let relation = field("relation");
    if let Some(message) = link_shape_error(from, to, relation) {
        return outside(Err(Refusal::bad_request(message)));
    }
    reply(
        create_link(&state, &caller, from, to, relation).await,
        "Failed to create link",
    )
}

async fn create_link(
    state: &FlowState,
    caller: &Caller,
    from: LinkRef<'_>,
    to: LinkRef<'_>,
    relation: &str,
) -> Reply {
    let db = &caller.db;
    let from_end = resolve_end(db, from.link_type, from.id).await?;
    let to_end = resolve_end(db, to.link_type, to.id).await?;
    let Some(from_end) = from_end else {
        return Err(Refusal::not_found(label(from.link_type), from.id));
    };
    let Some(to_end) = to_end else {
        return Err(Refusal::not_found(label(to.link_type), to.id));
    };
    // Both ends must be in projects the caller can write, before anything is
    // said about how they relate.
    if !caller.can_write(&from_end.project_id).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    if to_end.project_id != from_end.project_id && !caller.can_write(&to_end.project_id).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    if let Some(message) = link_ends_error(&from_end.as_link_end(), &to_end.as_link_end(), relation)
    {
        return Err(Refusal::bad_request(message));
    }
    let existing: Option<String> = sqlx::query_scalar(
        "select id from project_control_links
         where from_type = $1 and from_id = $2 and to_type = $3 and to_id = $4 limit 1",
    )
    .bind(from.link_type)
    .bind(from.id)
    .bind(to.link_type)
    .bind(to.id)
    .fetch_optional(db)
    .await?;
    if existing.is_some() {
        return Err(Refusal::conflict(ALREADY_LINKED));
    }
    let id = generate_id("pcl");
    let link = link_values(
        &id,
        &from_end.project_id,
        (from.link_type, from.id),
        (to.link_type, to.id),
        relation,
        &caller.user_id,
        &crate::now(),
    );
    if let Err(error) = insert_link(&link).execute(db).await {
        // Two requests linking the same pair at once: the unique index decides.
        if is_unique_violation(&error) {
            return Err(Refusal::conflict(ALREADY_LINKED));
        }
        return Err(error.into());
    }
    let Some(created) = link_row(db, &id).await? else {
        return Err(Refusal::Internal("the new link is missing".to_owned()));
    };
    publish_link(state, caller, PROJECT_CONTROL_LINK_CREATED, &created);
    Ok(Created(present_control_link(&created)).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        remove_link(&state, &caller, &id).await,
        "Failed to delete link",
    )
}

async fn remove_link(state: &FlowState, caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(existing) = link_row(db, id).await? else {
        return Err(Refusal::not_found("Link", id));
    };
    let project_id = existing["projectId"].as_str().unwrap_or_default();
    if !caller.can_write(project_id).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    // The other end may sit in another project (a dependency on a milestone there).
    let to_type = existing["toType"].as_str().unwrap_or_default();
    let to_id = existing["toId"].as_str().unwrap_or_default();
    if let Some(to_end) = resolve_end(db, to_type, to_id).await?
        && to_end.project_id != project_id
        && !caller.can_write(&to_end.project_id).await?
    {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    sqlx::query("delete from project_control_links where id = $1")
        .bind(id)
        .execute(db)
        .await?;
    publish_link(state, caller, PROJECT_CONTROL_LINK_DELETED, &existing);
    Ok(NoContent.into_response())
}
