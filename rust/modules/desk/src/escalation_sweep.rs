//! WeldDesk escalation rules, run by the SLA sweep ([`crate::sla_sweep`]) on
//! the same due index (`cron/escalation-sweep.ts`): a desk write stores when
//! a conversation's team rules next need checking
//! (`desk_conversations.escalation_check_at`, through the SLA refresh) and
//! folds it into the workspace's due time.
//!
//! For each conversation whose check came due,
//! [`weldsuite_desk_domain::escalation::run`] fires the rules that are due.
//! Every timeline event it wrote goes out as a `desk_conversation` entity
//! event (`assigned` when the owner changed, else `updated`) and live to the
//! inbox; a public notice to the customer also reaches their conversation
//! room; whoever now owns the conversation is told.

use serde_json::{Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::PgPool;
use weldsuite_desk_domain::assignment::Picker;
use weldsuite_desk_domain::escalation::{self, Escalated};
use weldsuite_desk_domain::notify::{EntityKind, ticket_assigned};
use weldsuite_desk_domain::realtime::{conversation_publish, now_ms};
use weldsuite_desk_domain::webchat;
use weldsuite_events::{EntityEvent, EventContext, EventSource};
use weldsuite_notifications::Notifier;
use weldsuite_ports::RealtimeMessage;

use crate::sla_sweep::SweepServices;

/// A conversation whose escalation failed is looked at again after this.
const CONVERSATION_RETRY_MS: i64 = 30 * 60_000;
/// Conversations per workspace per tick; the rest stay due for the next tick.
const CONVERSATIONS_PER_TICK: i64 = 100;

/// `publishEscalation(env, db, orgId, result)`: best effort.
async fn publish(services: &SweepServices, db: &PgPool, org_id: &str, result: &Escalated) {
    let context = EventContext::new(org_id, "system", EventSource::System);
    for step in &result.steps {
        let event = if step.action == "assigned" {
            ev::DESK_CONVERSATION_ASSIGNED
        } else {
            ev::DESK_CONVERSATION_UPDATED
        };
        let id = step.conversation["id"].as_str().unwrap_or_default().to_owned();
        services
            .events
            .publish_and_wait(&context, EntityEvent::new(event, id, step.conversation.clone()))
            .await;
    }
    if let Some(realtime) = &services.realtime {
        for step in &result.steps {
            let mut messages = vec![
                RealtimeMessage::workspace(org_id, "desk_conversation", "updated", step.conversation.clone(), "system"),
                RealtimeMessage::workspace(org_id, "desk_message", "created", step.message.clone(), "system"),
            ];
            if webchat::is_public(&step.message) && step.message["kind"] == "message" {
                let record = webchat::public_message(&step.message, &std::collections::HashMap::new());
                let id = step.conversation["id"].as_str().unwrap_or_default();
                messages.push(conversation_publish(
                    id,
                    json!({
                        "type": "message",
                        "id": step.message["id"],
                        "content": step.message["body"].as_str().unwrap_or_default(),
                        "senderId": "system",
                        "senderName": "Support",
                        "senderType": "system",
                        "ts": now_ms(),
                        "record": record,
                    }),
                ));
            }
            for message in messages {
                if let Err(error) = realtime.publish_boxed(&message).await {
                    tracing::error!(%error, "[DeskEscalation] publishing failed");
                }
            }
        }
    }
    let Some(conversation) = &result.conversation else {
        return;
    };
    let id = conversation["id"].as_str().unwrap_or_default();
    let subject = ["title", "name", "email"]
        .into_iter()
        .map(|key| &conversation[key])
        .find(|value| value.as_str().is_some_and(|text| !text.is_empty()))
        .and_then(Value::as_str);
    let reference = format!(
        "#{}",
        weldsuite_desk_domain::workflow::shared::js_string(conversation.get("conversationNumber"))
    );
    let notifier = Notifier {
        realtime: services.realtime.clone(),
        presence: None,
        mail: services.mail.clone(),
        http: None,
        apns: None,
    };
    for owner in &result.new_owners {
        match ticket_assigned(db, owner, None, EntityKind::Conversation, id, subject, Some(&reference)).await {
            Ok(Some(notification)) => crate::notify::deliver_with(db, &notifier, org_id, &notification).await,
            Ok(None) => {}
            Err(error) => tracing::error!(%error, "[DeskEscalation] publishing failed"),
        }
    }
}

/// `sweepWorkspaceEscalations(env, db, orgId, now)`: run one workspace's due
/// escalation rules; how many conversations were escalated.
pub async fn sweep_workspace(
    services: &SweepServices,
    db: &PgPool,
    org_id: &str,
    now: i64,
) -> Result<usize, sqlx::Error> {
    let mut escalated = 0;
    let retry_at = now + CONVERSATION_RETRY_MS;
    for id in escalation::list_due(db, now, CONVERSATIONS_PER_TICK).await? {
        match escalation::run(db, &id, now, &Picker::Local).await {
            Ok(result) => {
                if !result.steps.is_empty() {
                    escalated += 1;
                }
                publish(services, db, org_id, &result).await;
            }
            Err(error) => {
                tracing::error!(%error, conversation = %id, org_id, "[DeskEscalation] conversation failed");
                if let Err(error) = escalation::back_off(db, &id, retry_at).await {
                    tracing::warn!(%error, conversation = %id, "[DeskEscalation] could not back off");
                }
            }
        }
    }
    Ok(escalated)
}
