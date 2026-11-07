//! Routing after an agent edits a conversation's ticket fields (PATCH
//! `/api/desk/conversations/:id`, `lib/desk-routing.ts`): a change to the
//! type or the tags runs the workspace's routing rules again
//! (`weldsuite_desk_domain::routing`), except that a change which set the
//! team itself keeps that team. Also the entity event's `changes`.

use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_desk_domain::assignment::Picker;
use weldsuite_desk_domain::notify::EntityKind;
use weldsuite_desk_domain::routing::{self, Keep, Routed, Trigger};
use weldsuite_events::EntityEvent;

use crate::notify::{Assigned, assigned};
use crate::{Caller, DeskState};

/// The ticket columns an attribute change can move (`ATTRIBUTE_COLUMNS`).
const ATTRIBUTE_COLUMNS: [&str; 4] = ["ticketTypeId", "priority", "tags", "departmentId"];

/// `deskAttributeChanges(before, after)`: the entity event's `changes`.
pub(crate) fn attribute_changes(before: Option<&Value>, after: &Value) -> Option<Map<String, Value>> {
    let before = before?;
    let mut changes = Map::new();
    for key in ATTRIBUTE_COLUMNS {
        let old = before.get(key).cloned().unwrap_or(Value::Null);
        let new = after.get(key).cloned().unwrap_or(Value::Null);
        if old != new {
            changes.insert(key.to_owned(), json!({ "old": old, "new": new }));
        }
    }
    (!changes.is_empty()).then_some(changes)
}

/// Several entity events in a row, kept in that order (fire and forget).
pub(crate) fn publish_in_order(state: &DeskState, caller: &Caller, events: Vec<EntityEvent>) {
    let publisher = state.events.clone();
    let context = caller.events.clone();
    state.events.tracker().spawn(async move {
        for event in events {
            publisher.publish_and_wait(&context, event).await;
        }
    });
}

/// `rerouteAfterAttributes(c, message, publishChange)`: re-route after an
/// `attributes_changed` event the agent caused, publishing every step's
/// entity events and notifying a new owner; the caller pushes the steps
/// live. `None` when the change doesn't re-route or nothing applied.
pub(crate) async fn reroute_after_attributes(
    state: &DeskState,
    caller: &Caller,
    message: &Value,
) -> Option<Routed> {
    let (reroute, keep_team) = routing::change_reroutes(&message["metadata"]["changes"]);
    if !reroute {
        return None;
    }
    let id = message["conversationId"].as_str().unwrap_or_default();
    let keep = Keep {
        team: keep_team,
        assignee: false,
    };
    let routed = match routing::route_and_assign(&caller.db, id, keep, Trigger::Changed, &Picker::Local).await {
        Ok(routed) => routed,
        Err(error) => {
            tracing::error!(%error, "[desk-api/desk-conversations] routing failed");
            return None;
        }
    };
    if routed.steps.is_empty() {
        return None;
    }
    let mut events = Vec::new();
    let mut previous: Option<String> = None;
    for step in &routed.steps {
        let event = if step.action == "assigned" {
            ev::DESK_CONVERSATION_ASSIGNED
        } else {
            ev::DESK_CONVERSATION_UPDATED
        };
        let conversation_id = step.conversation["id"].as_str().unwrap_or_default().to_owned();
        events.push(EntityEvent::new(event, conversation_id.clone(), step.conversation.clone()));
        events.push(EntityEvent::new(
            ev::DESK_MESSAGE_CREATED,
            step.message["id"].as_str().unwrap_or_default().to_owned(),
            step.message.clone(),
        ));
        let owner = step.conversation["assigneeId"].as_str().map(str::to_owned);
        if step.action == "assigned" {
            let subject = ["title", "name", "email"]
                .into_iter()
                .map(|key| &step.conversation[key])
                .find(|value| value.as_str().is_some_and(|text| !text.is_empty()))
                .and_then(Value::as_str)
                .map(str::to_owned);
            assigned(
                state,
                caller,
                Assigned {
                    assignee_id: owner.clone(),
                    previous: previous.clone(),
                    kind: EntityKind::Conversation,
                    entity_id: conversation_id,
                    subject,
                    reference: Some(format!(
                        "#{}",
                        weldsuite_desk_domain::workflow::shared::js_string(
                            step.conversation.get("conversationNumber")
                        )
                    )),
                    by: None,
                },
            );
        }
        previous = owner;
    }
    publish_in_order(state, caller, events);
    crate::mark_sla_due(state, caller, routed.sla_check_at);
    Some(routed)
}
