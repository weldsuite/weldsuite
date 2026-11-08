//! An inbound call on the WeldDesk inbox, after `ingest_desk_phone`
//! (`lib/desk-phone-routing.ts`): the hub events (`desk_conversation
//! created` for a new conversation, `desk_message created` for the caller's
//! message), so WeldConnect workflows triggered by phone conversations run;
//! then routing (a new conversation only) and auto-assignment, as the widget
//! and email paths do, each step published like theirs. Best effort: a
//! failure is logged and never fails the webhook.

use serde_json::Value;
use weldsuite_catalogs::entity_events::{
    DESK_CONVERSATION_ASSIGNED, DESK_CONVERSATION_CREATED, DESK_CONVERSATION_UPDATED,
    DESK_MESSAGE_CREATED,
};
use weldsuite_db::PgPool;
use weldsuite_desk_domain::assignment::{Picker, auto_assign_with};
use weldsuite_desk_domain::routing::{self, Keep, Step, Trigger};
use weldsuite_desk_domain::webchat;
use weldsuite_events::{EntityEvent, EventContext, EventSource};
use weldsuite_ports::RealtimeMessage;

use crate::CallState;

/// `announceDeskPhoneCall({ … })`. `org` is the Clerk org id (events,
/// realtime); the due index is keyed by `workspaces.id`, found from it.
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
pub(crate) async fn announce_call(
    state: &CallState,
    db: &PgPool,
    master: &PgPool,
    org: &str,
    conversation_id: &str,
    message: &Value,
    created: bool,
) {
    let conversation = match webchat::get(db, conversation_id, false).await {
        Ok(Some((conversation, _))) => conversation,
        Ok(None) => return,
        Err(error) => {
            tracing::error!(%error, "[desk-phone] routing / auto-assignment failed");
            return;
        }
    };
    let context = EventContext::new(org, "system", EventSource::System);
    if created {
        state
            .events
            .publish_and_wait(
                &context,
                EntityEvent::new(
                    DESK_CONVERSATION_CREATED,
                    conversation_id,
                    conversation.clone(),
                ),
            )
            .await;
    }
    state
        .events
        .publish_and_wait(
            &context,
            EntityEvent::new(
                DESK_MESSAGE_CREATED,
                message["id"].as_str().unwrap_or_default(),
                message.clone(),
            ),
        )
        .await;

    // The workspace's AssignmentRouter (round robin, a rotation per team),
    // keyed by `workspaces.id` like the widget and email paths.
    let router_workspace = match &state.assignment {
        Some(_) => crate::credits::resolve_workspace(master, org)
            .await
            .ok()
            .flatten(),
        None => None,
    };
    let picker = match (&state.assignment, router_workspace.as_deref()) {
        (Some(router), Some(workspace_id)) => Picker::Router {
            router,
            workspace_id,
        },
        _ => Picker::Local,
    };
    let done: Result<(Vec<Step>, Option<i64>), String> = if created {
        routing::route_and_assign(
            db,
            conversation_id,
            Keep::default(),
            Trigger::Opened,
            &picker,
        )
        .await
        .map(|routed| (routed.steps, routed.sla_check_at))
        .map_err(|error| error.to_string())
    } else if conversation["assigneeId"]
        .as_str()
        .is_none_or(str::is_empty)
        && conversation["state"] == "open"
    {
        auto_assign_with(db, conversation_id, &picker)
            .await
            .map(|assigned| match assigned {
                Some(appended) => {
                    let at = appended.sla_check_at;
                    let (conversation, message) = appended.pair();
                    let step = Step {
                        conversation,
                        message,
                        action: "assigned",
                    };
                    (vec![step], at)
                }
                None => (Vec::new(), None),
            })
            .map_err(|error| error.to_string())
    } else {
        Ok((Vec::new(), None))
    };
    let (steps, sla_check_at) = match done {
        Ok(done) => done,
        Err(error) => {
            tracing::error!(%error, "[desk-phone] routing / auto-assignment failed");
            return;
        }
    };
    if let Some(at) = sla_check_at.and_then(weldsuite_desk_domain::sla::instant) {
        match crate::credits::resolve_workspace(master, org).await {
            Ok(Some(workspace_id)) => {
                weldsuite_db::due_index::mark_due(
                    master,
                    weldsuite_desk_domain::sla::DUE_KIND,
                    &workspace_id,
                    at,
                )
                .await;
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "[desk-phone] desk SLA due mark failed"),
        }
    }
    for step in steps {
        let event = if step.action == "assigned" {
            DESK_CONVERSATION_ASSIGNED
        } else {
            DESK_CONVERSATION_UPDATED
        };
        let id = step.conversation["id"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        state
            .events
            .publish_and_wait(
                &context,
                EntityEvent::new(event, id, step.conversation.clone()),
            )
            .await;
        let Some(realtime) = &state.realtime else {
            continue;
        };
        for publish in [
            RealtimeMessage::workspace(
                org,
                "desk_conversation",
                "updated",
                step.conversation.clone(),
                "system",
            ),
            RealtimeMessage::workspace(
                org,
                "desk_message",
                "created",
                step.message.clone(),
                "system",
            ),
        ] {
            if let Err(error) = realtime.publish_boxed(&publish).await {
                tracing::error!(%error, "[desk-phone] realtime publish failed");
            }
        }
    }
}
