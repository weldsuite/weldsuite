//! Service requests on a conversation:
//! `routes/desk-conversations/request.ts` at
//! `/api/desk/conversations/{id}/{request,catalog-item,approval,fulfilment}`.
//!
//! A conversation is a service request when it was made from a catalogue
//! item (`catalog_item_id`): the item's form is its ticket type, its
//! approval steps are decided in order, and once approved (or at once,
//! without steps) its fulfilment tasks become WeldFlow tasks linked to the
//! conversation. The rules and writes are
//! [`weldsuite_desk_domain::catalog`]; timeline entries are published like
//! the linked-ticket routes publish theirs. Notifying the next approver and
//! creating the tasks run after the answer
//! ([`weldsuite_desk_domain::fulfilment`]); the answer's `request` is read
//! before they start. `POST …/fulfilment` is the one that waits for the
//! tasks. Refusals answer 409 `details.reason`, a field problem 400
//! `details.field`.

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
use weldsuite_desk_domain::catalog::{self, CatalogError, Decide};
use weldsuite_desk_domain::fulfilment::{self, FollowUp};
use weldsuite_desk_domain::webchat::{self as desk, Appended};
use weldsuite_events::EntityEvent;
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::RealtimeMessage;

use super::Ctx;
use super::attributes::{self, Update, UpdateError};
use super::inbox::{load_author, publish_change, spawn_realtime};
use super::links::{changes_to_publish, own_messages, publish_changes};
use crate::{DeskState, Refusal, validate};

/// `/desk/conversations/{id}/{request,catalog-item,approval,fulfilment}`,
/// next to the inbox routes. Deciding only needs to read the inbox: who may
/// decide a step is the step's approver, or anyone who manages the catalogue.
pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::CONVERSATIONS_READ.to_owned()]);
    let update = || gate.require([perm::CONVERSATIONS_UPDATE.to_owned()]);
    Router::new()
        .route("/{id}/request", get(read_request).route_layer(read()))
        .route("/{id}/catalog-item", put(attach).route_layer(update()))
        .route("/{id}/approval", post(decide).route_layer(read()))
        .route(
            "/{id}/fulfilment",
            post(retry_fulfilment).route_layer(update()),
        )
}

fn conversation_not_found(id: &str) -> Response {
    ApiError::not_found("Conversation", Some(id)).into_response()
}

fn failed(error: &dyn std::fmt::Display, failure: &str) -> Response {
    tracing::error!(%error, "[desk-api/desk-request] {failure}");
    ApiError::internal().with_message(failure).into_response()
}

/// `refusal(c, err, failure)`: a missing conversation, a refusal (409 with
/// its reason) or a failure.
fn refused(error: CatalogError, failure: &str) -> Response {
    match error {
        CatalogError::ConversationNotFound(id) => conversation_not_found(&id),
        CatalogError::Refused { reason, message } => ApiError::conflict(message)
            .with_details(json!({ "reason": reason }))
            .into_response(),
        error => failed(&error, failure),
    }
}

/// What happens after a step opened or the request was approved, once the
/// answer is out (`followUp`).
struct Work {
    conversation: Value,
    /// The item the request was made from; `None` when it was deleted since.
    item: Option<Value>,
    /// The step that just went to its approver.
    approval: Option<Value>,
    fulfilment_due: bool,
}

/// The route's own events and realtime messages, in order, then the
/// follow-up: the approver of a step that opened hears about it, or an
/// approved request gets its tasks. One background task, so what the
/// follow-up publishes comes after the route's own, as it does on the
/// worker (`publishEntityEvent` sends at once, `waitUntil` work later).
fn publish_then_follow_up(
    ctx: &Ctx,
    state: &DeskState,
    events: Vec<(ev::EventName, String, Value)>,
    realtime: Vec<RealtimeMessage>,
    work: Work,
) {
    let caller = &ctx.caller;
    let publisher = state.events.clone();
    let context = caller.events.clone();
    let port = state.realtime.clone();
    let notifier = crate::notify::notifier(state);
    let db = caller.db.clone();
    let org = caller.clerk_org_id.clone();
    let user_id = caller.user_id.clone();
    state.events.tracker().spawn(async move {
        for (event, entity_id, data) in events {
            publisher
                .publish_and_wait(&context, EntityEvent::new(event, entity_id, data))
                .await;
        }
        if let Some(port) = &port {
            for message in &realtime {
                if let Err(error) = port.publish_boxed(message).await {
                    tracing::error!(%error, "[app-api/desk-conversations] realtime publish failed");
                }
            }
        }
        let follow = FollowUp {
            db: &db,
            events: &publisher,
            notifier: &notifier,
            clerk_org_id: &org,
        };
        if let Some(approval) = &work.approval {
            fulfilment::notify_approver(&follow, approval, &work.conversation, work.item.as_ref())
                .await;
        } else if work.fulfilment_due
            && let Some(item) = &work.item
        {
            fulfilment::fulfil(&follow, &work.conversation, item, Some(&user_id)).await;
        }
    });
}

/// The answer of a change: the conversation, its new timeline entries and
/// the request as it stood before the follow-up started (`request`, read by
/// the caller first: its `fulfilmentStarted` then never depends on how far
/// the tasks got).
fn answer(
    id: &str,
    conversation: &Value,
    changes: &[Appended],
    request: Result<Option<Value>, sqlx::Error>,
    failure: &str,
) -> Response {
    match request {
        Ok(request) => Data(json!({
            "conversation": conversation,
            "messages": own_messages(id, changes),
            "request": request,
        }))
        .into_response(),
        Err(error) => Refusal::Database(error).respond(failure),
    }
}

// ── GET /:id/request ──────────────────────────────────────────────────────────

/// The item, approval state and steps; null when the conversation is not a
/// service request.
async fn read_request(ctx: Ctx, Path(id): Path<String>) -> Response {
    let failure = "Failed to load the service request";
    let db = &ctx.caller.db;
    match desk::get(db, &id, false).await {
        Ok(Some(_)) => {}
        Ok(None) => return conversation_not_found(&id),
        Err(error) => return Refusal::Database(error).respond(failure),
    }
    match catalog::conversation_request(db, &id).await {
        Ok(request) => Data(request.unwrap_or(Value::Null)).into_response(),
        Err(error) => Refusal::Database(error).respond(failure),
    }
}

// ── PUT /:id/catalog-item ─────────────────────────────────────────────────────

/// `attachDeskCatalogItemSchema`.
fn attach_schema(issues: &mut Issues, body: &Map<String, Value>) -> String {
    issues
        .text_with(
            body,
            "catalogItemId",
            Presence::Required,
            Text::length(Some(1), Some(30)),
        )
        .into_option()
        .unwrap_or_default()
}

/// The item's ticket type, team and priority, as the attributes writer
/// takes them: a team or priority the item leaves open is left alone.
fn item_attributes(item: &Value) -> Update {
    let set = |key: &str| {
        item[key]
            .as_str()
            .map_or(Field::Absent, |value| Field::Set(value.to_owned()))
    };
    Update {
        ticket_type_id: set("ticketTypeId"),
        department_id: set("departmentId"),
        priority: set("priority"),
        ..Update::default()
    }
}

/// Make the conversation a request of an item: the item's ticket type, team
/// and priority are applied first (on the timeline, routing and SLA react
/// as for any change), then the approval flow starts.
async fn attach(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failure = "Failed to start the service request";
    let item_id = match validate(&headers, &body, attach_schema) {
        Ok(item_id) => item_id,
        Err(refusal) => return refusal.respond(failure),
    };
    let caller = &ctx.caller;
    let db = &caller.db;
    let found = match desk::get(db, &id, false).await {
        Ok(Some((conversation, _))) => conversation,
        Ok(None) => return conversation_not_found(&id),
        Err(error) => return Refusal::Database(error).respond(failure),
    };
    let item = match catalog::get_item(db, &item_id).await {
        Ok(Some(item)) => item,
        Ok(None) => return ApiError::not_found("Catalogue item", Some(&item_id)).into_response(),
        Err(error) => return Refusal::Database(error).respond(failure),
    };
    if item["isActive"] != true {
        return ApiError::conflict("This catalogue item is switched off")
            .with_details(json!({ "reason": "item_inactive" }))
            .into_response();
    }
    if let Err(error) = catalog::assert_startable(&found) {
        return refused(error, failure);
    }

    let mut changes: Vec<Appended> = Vec::new();
    let updated = match attributes::update(db, &id, &caller.user_id, &item_attributes(&item)).await
    {
        Ok(updated) => updated,
        Err(UpdateError::NotFound) => return conversation_not_found(&id),
        Err(UpdateError::Rejected { field, message }) => {
            return ApiError::bad_request(message)
                .with_details(json!({ "field": field }))
                .into_response();
        }
        Err(UpdateError::Failed(error)) => return failed(&error, failure),
    };
    if let Some(message) = updated.message {
        let change = Appended {
            conversation: updated.conversation,
            message,
            sla_check_at: updated.sla_check_at,
        };
        publish_changes(&ctx, &state, std::slice::from_ref(&change)).await;
        // A new type can route it elsewhere (a team the item set itself stays).
        if let Some(routed) =
            crate::routing::reroute_after_attributes(&state, caller, &change.message).await
        {
            for step in &routed.steps {
                let authors = load_author(db, step.conversation["assigneeId"].as_str()).await;
                publish_change(
                    &state,
                    &caller.clerk_org_id,
                    &step.conversation,
                    &step.message,
                    &authors,
                );
            }
        }
        changes.push(change);
    }

    let started =
        match catalog::start_request(db, &id, &item, ("agent", Some(&caller.user_id))).await {
            Ok(started) => started,
            Err(error) => return refused(error, failure),
        };
    let (mut events, realtime) =
        changes_to_publish(&ctx, &state, Vec::new(), &started.changes).await;
    if started.changes.is_empty() {
        events.push((
            ev::DESK_CONVERSATION_UPDATED,
            id.clone(),
            started.conversation.clone(),
        ));
    }
    changes.extend(started.changes);
    let request = catalog::conversation_request(db, &id).await;
    publish_then_follow_up(
        &ctx,
        &state,
        events,
        realtime,
        Work {
            conversation: started.conversation.clone(),
            item: Some(item),
            approval: started.pending_approval,
            fulfilment_due: started.fulfilment_due,
        },
    );
    answer(&id, &started.conversation, &changes, request, failure)
}

// ── POST /:id/approval ────────────────────────────────────────────────────────

/// `decideDeskApprovalSchema`: the decision, and what the approver said.
fn decide_schema(issues: &mut Issues, body: &Map<String, Value>) -> (String, Option<String>) {
    let decision = issues
        .choice(
            body,
            "decision",
            Presence::Required,
            &["approved", "rejected"],
        )
        .into_option()
        .unwrap_or_default();
    let comment = issues
        .text_with(
            body,
            "comment",
            Presence::Nullish,
            Text::trimmed(None, Some(2000)),
        )
        .into_option();
    (decision, comment)
}

/// Decide the step that waits: its approver, or anyone who manages the
/// catalogue (`settings:update`).
async fn decide(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failure = "Failed to decide the approval";
    let (decision, comment) = match validate(&headers, &body, decide_schema) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(failure),
    };
    let caller = &ctx.caller;
    let db = &caller.db;
    let result = match catalog::decide(
        db,
        Decide {
            conversation_id: &id,
            user_id: &caller.user_id,
            can_manage: caller.can(perm::SETTINGS_UPDATE),
            decision: &decision,
            comment: comment.as_deref(),
        },
    )
    .await
    {
        Ok(result) => result,
        Err(error) => return refused(error, failure),
    };
    let (events, realtime) = changes_to_publish(&ctx, &state, Vec::new(), &result.changes).await;
    let item_id = result.decided["catalogItemId"].as_str().unwrap_or_default();
    let item = match catalog::get_item(db, item_id).await {
        Ok(item) => item,
        Err(error) => {
            // The decision stands, and so do its events.
            caller.publish_in_order(&state, events);
            spawn_realtime(&state, realtime);
            return Refusal::Database(error).respond(failure);
        }
    };
    let request = catalog::conversation_request(db, &id).await;
    publish_then_follow_up(
        &ctx,
        &state,
        events,
        realtime,
        Work {
            conversation: result.conversation.clone(),
            item,
            approval: result.next_approval,
            fulfilment_due: result.fulfilment_due,
        },
    );
    answer(&id, &result.conversation, &result.changes, request, failure)
}

// ── POST /:id/fulfilment ──────────────────────────────────────────────────────

/// Create the item's tasks for a request whose fulfilment never finished
/// (the run after the answer failed): approved or without approval, the item
/// still there, no `fulfilment_started` on the timeline. Waits for the tasks
/// and answers how many it created; the tasks a failed run left are kept,
/// not created twice. Publishes what the run after an approval publishes.
async fn retry_fulfilment(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
) -> Response {
    let failure = "Failed to create the tasks";
    let caller = &ctx.caller;
    let (conversation, item) = match catalog::load_fulfilment_retry(&caller.db, &id).await {
        Ok(found) => found,
        Err(error) => return refused(error, failure),
    };
    let notifier = crate::notify::notifier(&state);
    let follow = FollowUp {
        db: &caller.db,
        events: &state.events,
        notifier: &notifier,
        clerk_org_id: &caller.clerk_org_id,
    };
    match fulfilment::run(&follow, &conversation, &item, Some(&caller.user_id)).await {
        Ok(fulfilled) => {
            let created = fulfilled.map_or(0, |fulfilled| fulfilled.created);
            Data(json!({ "created": created })).into_response()
        }
        Err(error) => failed(&error, failure),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_item_sets_its_type_and_only_the_team_and_priority_it_names() {
        let open = item_attributes(&json!({
            "ticketTypeId": "ttyp_hw", "departmentId": null, "priority": null,
        }));
        assert_eq!(open.ticket_type_id, Field::Set("ttyp_hw".to_owned()));
        assert_eq!(open.department_id, Field::Absent);
        assert_eq!(open.priority, Field::Absent);
        assert!(open.tags.is_none());
        let set = item_attributes(&json!({
            "ticketTypeId": "ttyp_hw", "departmentId": "dept_it", "priority": "low",
        }));
        assert_eq!(set.department_id, Field::Set("dept_it".to_owned()));
        assert_eq!(set.priority, Field::Set("low".to_owned()));
    }

    fn body_issues<T>(
        body: &Value,
        read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
    ) -> Value {
        let mut issues = Issues::default();
        let _ = read(&mut issues, body.as_object().expect("object"));
        issues
            .finish()
            .map_or_else(|invalid| json!(invalid.issues()), |()| json!([]))
    }

    /// Zod 3's own output for `attachDeskCatalogItemSchema` and
    /// `decideDeskApprovalSchema`.
    #[test]
    fn the_bodies_are_checked() {
        assert_eq!(
            body_issues(&json!({}), attach_schema),
            json!([{"code":"invalid_type","expected":"string","received":"undefined","path":["catalogItemId"],"message":"Required"}])
        );
        assert_eq!(
            body_issues(&json!({ "catalogItemId": "x".repeat(31) }), attach_schema),
            json!([{"code":"too_big","maximum":30,"type":"string","inclusive":true,"exact":false,"message":"String must contain at most 30 character(s)","path":["catalogItemId"]}])
        );
        assert_eq!(
            body_issues(&json!({ "decision": "maybe", "comment": 5 }), decide_schema),
            json!([
                {"received":"maybe","code":"invalid_enum_value","options":["approved","rejected"],"path":["decision"],"message":"Invalid enum value. Expected 'approved' | 'rejected', received 'maybe'"},
                {"code":"invalid_type","expected":"string","received":"number","path":["comment"],"message":"Expected string, received number"},
            ])
        );
        assert_eq!(
            body_issues(&json!({ "comment": "x".repeat(2001) }), decide_schema),
            json!([
                {"expected":"'approved' | 'rejected'","received":"undefined","code":"invalid_type","path":["decision"],"message":"Required"},
                {"code":"too_big","maximum":2000,"type":"string","inclusive":true,"exact":false,"message":"String must contain at most 2000 character(s)","path":["comment"]},
            ])
        );
        let mut issues = Issues::default();
        let body = json!({ "decision": "approved", "comment": "  hi  " });
        let read = decide_schema(&mut issues, body.as_object().expect("object"));
        assert!(issues.finish().is_ok());
        assert_eq!(read, ("approved".to_owned(), Some("hi".to_owned())));
    }
}
