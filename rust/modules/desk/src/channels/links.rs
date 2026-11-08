//! `routes/desk-conversations/links.ts`: linked tickets at
//! `/api/desk/conversations/{id}/{links,parent,merge,major-incident,incident-update}`,
//! i.e. parent/child links (one level), major incidents with an update to
//! every linked customer, and merging duplicates. The rules and writes are
//! [`weldsuite_desk_domain::links`]; every timeline entry is published like
//! the inbox publishes its own (workspace hub, the visitor's room for public
//! entries, entity events), in the order it was written.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_desk_domain::links::{self, LinkError};
use weldsuite_desk_domain::webchat::Appended;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::Ctx;
use super::inbox;
use super::webchat::Author;
use crate::{DeskState, Refusal, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::CONVERSATIONS_READ.to_owned()]);
    let update = || gate.require([perm::CONVERSATIONS_UPDATE.to_owned()]);
    Router::new()
        .route("/{id}/links", get(read_links).route_layer(read()))
        .route("/{id}/parent", put(set_parent).route_layer(update()))
        .route("/{id}/merge", post(merge).route_layer(update()))
        .route(
            "/{id}/major-incident",
            put(major_incident).route_layer(update()),
        )
        .route(
            "/{id}/incident-update",
            post(incident_update).route_layer(update()),
        )
}

/// `publishDeskLinkChanges(c, changes)`: each change's entity events (a close
/// is `state_changed`, anything else `updated`), the SLA due time and the
/// realtime fan-out. A chat reply carries its author; an event the assignee.
/// The entity events and the realtime messages each go out as one ordered
/// batch, as TypeScript sends them.
pub(super) async fn publish_changes(ctx: &Ctx, state: &DeskState, changes: &[Appended]) {
    let caller = &ctx.caller;
    let mut events = Vec::new();
    let mut realtime = Vec::new();
    let mut authors: HashMap<String, HashMap<String, Author>> = HashMap::new();
    for change in changes {
        let conversation = &change.conversation;
        let message = &change.message;
        let action = if message["metadata"]["eventType"] == "closed" {
            ev::DESK_CONVERSATION_STATE_CHANGED
        } else {
            ev::DESK_CONVERSATION_UPDATED
        };
        events.push((
            action,
            conversation["id"].as_str().unwrap_or_default().to_owned(),
            conversation.clone(),
        ));
        events.push((
            ev::DESK_MESSAGE_CREATED,
            message["id"].as_str().unwrap_or_default().to_owned(),
            message.clone(),
        ));
        crate::mark_sla_due(state, caller, change.sla_check_at);
        let who = if message["kind"] == "message" {
            message["authorId"].as_str()
        } else {
            conversation["assigneeId"].as_str()
        };
        let key = who.unwrap_or_default().to_owned();
        if !authors.contains_key(&key) {
            let loaded = inbox::load_author(&caller.db, who).await;
            authors.insert(key.clone(), loaded);
        }
        realtime.extend(inbox::change_messages(
            &caller.clerk_org_id,
            conversation,
            message,
            &authors[&key],
        ));
    }
    caller.publish_in_order(state, events);
    inbox::spawn_realtime(state, realtime);
}

/// The answer to a refusal, a missing conversation or a failure.
fn refused(error: LinkError, failure: &str) -> Response {
    match error {
        LinkError::NotFound(id) => ApiError::not_found("Conversation", Some(&id)).into_response(),
        LinkError::Rejected { reason, message } => ApiError::conflict(message)
            .with_details(json!({ "reason": reason }))
            .into_response(),
        LinkError::Write(error) => {
            tracing::error!(%error, "[desk-api/desk-conversations] {failure}");
            ApiError::internal().with_message(failure).into_response()
        }
    }
}

/// The entries a change wrote on `id`'s own timeline.
fn own_messages(id: &str, changes: &[Appended]) -> Vec<Value> {
    changes
        .iter()
        .filter(|change| change.conversation["id"] == id)
        .map(|change| change.message.clone())
        .collect()
}

// ── GET /:id/links ────────────────────────────────────────────────────────────

async fn read_links(ctx: Ctx, Path(id): Path<String>) -> Response {
    match links::links(&ctx.caller.db, &id).await {
        Ok(Some(links)) => Data(links).into_response(),
        Ok(None) => ApiError::not_found("Conversation", Some(&id)).into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to load linked tickets"),
    }
}

// ── PUT /:id/parent ───────────────────────────────────────────────────────────

/// `setDeskConversationParentSchema`: `parentId`, a string or null.
fn parent_schema(issues: &mut Issues, body: &Map<String, Value>) -> Option<String> {
    issues
        .text(body, "parentId", Presence::Nullable, Some(1), Some(30))
        .into_option()
}

async fn set_parent(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failure = "Failed to link the conversation";
    let parent = match validate(&headers, &body, parent_schema) {
        Ok(parent) => parent,
        Err(refusal) => return refusal.respond(failure),
    };
    let caller = &ctx.caller;
    let result = links::set_parent(&caller.db, Some(&caller.user_id), &id, parent.as_deref()).await;
    match result {
        Ok(result) => {
            publish_changes(&ctx, &state, &result.changes).await;
            Data(json!({
                "conversation": result.conversation,
                "messages": own_messages(&id, &result.changes),
            }))
            .into_response()
        }
        Err(error) => refused(error, failure),
    }
}

// ── POST /:id/merge ───────────────────────────────────────────────────────────

fn merge_schema(issues: &mut Issues, body: &Map<String, Value>) -> String {
    issues
        .text(body, "targetId", Presence::Required, Some(1), Some(30))
        .into_option()
        .unwrap_or_default()
}

async fn merge(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failure = "Failed to merge the conversation";
    let target = match validate(&headers, &body, merge_schema) {
        Ok(target) => target,
        Err(refusal) => return refusal.respond(failure),
    };
    let caller = &ctx.caller;
    match links::merge(&caller.db, Some(&caller.user_id), &id, &target).await {
        Ok(result) => {
            publish_changes(&ctx, &state, &result.changes).await;
            Data(json!({
                "conversation": result.conversation,
                "target": result.target,
                "messages": own_messages(&id, &result.changes),
            }))
            .into_response()
        }
        Err(error) => refused(error, failure),
    }
}

// ── PUT /:id/major-incident ───────────────────────────────────────────────────

fn incident_schema(issues: &mut Issues, body: &Map<String, Value>) -> bool {
    issues
        .boolean(body, "isMajorIncident", Presence::Required)
        .into_option()
        .unwrap_or(false)
}

async fn major_incident(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failure = "Failed to update the major incident";
    let flag = match validate(&headers, &body, incident_schema) {
        Ok(flag) => flag,
        Err(refusal) => return refusal.respond(failure),
    };
    let caller = &ctx.caller;
    match links::set_major_incident(&caller.db, Some(&caller.user_id), &id, flag).await {
        Ok(result) => {
            publish_changes(&ctx, &state, &result.changes).await;
            Data(json!({
                "conversation": result.conversation,
                "messages": own_messages(&id, &result.changes),
            }))
            .into_response()
        }
        Err(error) => refused(error, failure),
    }
}

// ── POST /:id/incident-update ─────────────────────────────────────────────────

fn update_schema(issues: &mut Issues, body: &Map<String, Value>) -> String {
    issues
        .text_with(
            body,
            "body",
            Presence::Required,
            Text::trimmed(Some(1), Some(20_000)),
        )
        .into_option()
        .unwrap_or_default()
}

/// "Post an update to all linked customers": one reply on the incident and
/// on each open child, delivered per channel like a reply (messenger: the
/// visitor's room; email: the outbound reply; other channels: the timeline).
async fn incident_update(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failure = "Failed to post the update";
    let text = match validate(&headers, &body, update_schema) {
        Ok(text) => text,
        Err(refusal) => return refusal.respond(failure),
    };
    let caller = &ctx.caller;
    let result =
        match links::post_incident_update(&caller.db, Some(&caller.user_id), &id, &text).await {
            Ok(result) => result,
            Err(error) => return refused(error, failure),
        };
    publish_changes(&ctx, &state, &result.changes).await;
    for change in &result.changes {
        if change.conversation["channel"] == "email" {
            inbox::send_email_reply(&ctx, &state, &change.conversation, &change.message).await;
        }
    }
    let Some(own) = result.changes.first() else {
        return ApiError::internal().with_message(failure).into_response();
    };
    Created(json!({
        "conversation": result.conversation,
        "message": own.message,
        "delivered": result.changes.len() - 1,
    }))
    .into_response()
}
