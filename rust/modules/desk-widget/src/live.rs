//! `lib/desk-live.ts`: live delivery of a visitor's write. Every one fans out
//! to the conversation room (the visitor's other tabs, an agent who has it
//! open), to the workspace hub's `desk_conversation` / `desk_message` topics
//! (every agent's inbox), and as an in-app or push notification. A rating and
//! an auto-assignment also go to the event hub as `desk_conversation`
//! events. All of it is best effort: a failure is logged and never fails the
//! visitor's request, and it runs after the response, as the worker's
//! `waitUntil` does.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_desk_domain::realtime::{conversation_publish, now_ms};
use weldsuite_desk_domain::webchat::{
    Author, collapse_whitespace, public_conversation, public_message, resolve_authors,
};
use weldsuite_desk_domain::{assignment, sla};
use weldsuite_events::{EntityEvent, EventContext, EventSource, EventType};
use weldsuite_kit::validation::js_trim;
use weldsuite_notifications::{NewNotification, Notifier, create_and_deliver};
use weldsuite_ports::RealtimeMessage;

use crate::WidgetState;

/// Teammates notified at once.
const NOTIFY_BATCH: usize = 10;
/// Teammates notified at most.
const MAX_RECIPIENTS: i64 = 200;

/// `messageText(message)`: the body, or the files' names.
pub(crate) fn message_text(message: &Value) -> String {
    let body = js_trim(message["body"].as_str().unwrap_or_default());
    if !body.is_empty() {
        return body.to_owned();
    }
    let Some(files) = message["attachments"].as_array().filter(|f| !f.is_empty()) else {
        return String::new();
    };
    let more = if files.len() > 1 {
        format!(" +{}", files.len() - 1)
    } else {
        String::new()
    };
    let name = files[0]["name"]
        .as_str()
        .map_or_else(|| "undefined".to_owned(), str::to_owned);
    format!("📎 {name}{more}")
}

/// Publish in order, logging what fails.
async fn publish_all(state: &WidgetState, messages: Vec<RealtimeMessage>) {
    let Some(realtime) = &state.realtime else {
        return;
    };
    for message in messages {
        if let Err(error) = realtime.publish_boxed(&message).await {
            tracing::error!(%error, channel = %message.channel, "[widget-api] realtime publish failed");
        }
    }
}

/// `markDeskSlaDue(env, waitUntil, orgId, slaCheckAt)` (`lib/sla-due.ts`):
/// tell desk-api's SLA sweep when a conversation's SLA clock next comes due,
/// in the due index (kind `desk_sla`, keyed by `workspaces.id`). Best
/// effort, after the response; it can only pull the workspace's due time
/// earlier.
pub(crate) fn mark_sla_due(
    state: &WidgetState,
    master: Option<PgPool>,
    workspace_id: &str,
    sla_check_at: Option<i64>,
) {
    let (Some(master), Some(at)) = (master, sla_check_at.and_then(sla::instant)) else {
        return;
    };
    let workspace_id = workspace_id.to_owned();
    state.events.tracker().spawn(async move {
        weldsuite_db::due_index::mark_due(&master, sla::DUE_KIND, &workspace_id, at).await;
    });
}

/// `rt.publish(orgId, topic, event, data, 'system')`.
fn hub(org_id: &str, topic: &str, event: &str, data: &Value) -> RealtimeMessage {
    RealtimeMessage::workspace(org_id, topic, event, data.clone(), "system")
}

/// `publishVisitorMessage(env, orgId, conversation, message, visitorName, event)`:
/// a new visitor message to the conversation room and the agents' inbox.
pub(crate) async fn publish_visitor_message(
    state: &WidgetState,
    org_id: &str,
    conversation: &Value,
    message: &Value,
    visitor_name: &str,
    event: &str,
) {
    let record = public_message(message, &HashMap::<String, Author>::new());
    let room = json!({
        "type": "message",
        "id": message["id"],
        "content": message_text(message),
        "senderId": format!("visitor:{}", message["authorId"].as_str().unwrap_or_default()),
        "senderName": visitor_name,
        "senderType": "visitor",
        "ts": now_ms(),
        "record": record,
    });
    let conversation_id = conversation["id"].as_str().unwrap_or_default();
    publish_all(
        state,
        vec![
            conversation_publish(conversation_id, room),
            hub(org_id, "desk_conversation", event, conversation),
            hub(org_id, "desk_message", "created", message),
        ],
    )
    .await;
}

/// `publishConversationUpdated(env, orgId, conversation)`.
pub(crate) async fn publish_conversation_updated(
    state: &WidgetState,
    org_id: &str,
    conversation: &Value,
) {
    publish_all(
        state,
        vec![hub(org_id, "desk_conversation", "updated", conversation)],
    )
    .await;
}

/// `publishVisitorEvent(env, orgId, conversation, message, authors, entityAction)`:
/// a visitor-made timeline event (a rating, or the auto-assignment it set
/// off) to the event hub, the conversation room and the agents' inbox.
pub(crate) async fn publish_visitor_event(
    state: &WidgetState,
    org_id: &str,
    conversation: &Value,
    message: &Value,
    authors: &HashMap<String, Author>,
    entity_action: &str,
) {
    match EventType::catalog("desk_conversation", entity_action) {
        Ok(event) => {
            let context = EventContext::new(org_id, "system", EventSource::System);
            let entity_id = conversation["id"].as_str().unwrap_or_default().to_owned();
            state
                .events
                .publish_and_wait(
                    &context,
                    EntityEvent::new(event, entity_id, conversation.clone()),
                )
                .await;
        }
        Err(error) => tracing::error!(%error, "[widget-api] unknown entity event"),
    }
    let record = public_message(message, authors);
    let mut data = Map::new();
    data.insert("state".to_owned(), conversation["state"].clone());
    data.insert(
        "conversation".to_owned(),
        public_conversation(conversation, authors),
    );
    let event = record["eventType"]
        .as_str()
        .map_or_else(|| "event".to_owned(), str::to_owned);
    data.insert("record".to_owned(), record);
    let room = json!({ "type": "system", "event": event, "data": data, "ts": now_ms() });
    let conversation_id = conversation["id"].as_str().unwrap_or_default();
    publish_all(
        state,
        vec![
            conversation_publish(conversation_id, room),
            hub(org_id, "desk_conversation", "updated", conversation),
            hub(org_id, "desk_message", "created", message),
        ],
    )
    .await;
}

/// `autoAssignConversation(env, db, orgId, conversation)`: hand an open,
/// unowned conversation to a teammate (when the workspace has it on) and
/// publish the `assigned` event. The conversation as it now stands; on any
/// failure it stays unassigned. The pick goes through the workspace's
/// router (`workspace_id`, `workspaces.id`) when the state has one.
pub(crate) async fn auto_assign(
    state: &WidgetState,
    db: &PgPool,
    org_id: &str,
    workspace_id: &str,
    master: Option<PgPool>,
    conversation: Value,
) -> Value {
    let owned = conversation["assigneeId"]
        .as_str()
        .is_some_and(|assignee| !assignee.is_empty());
    if owned || conversation["state"] != "open" {
        return conversation;
    }
    let id = conversation["id"].as_str().unwrap_or_default().to_owned();
    let picker = match &state.assignment {
        Some(router) => assignment::Picker::Router {
            router,
            workspace_id,
        },
        None => assignment::Picker::Local,
    };
    match assignment::auto_assign_with(db, &id, &picker).await {
        Ok(Some(appended)) => {
            // The owner can change which SLA policy applies.
            if let (Some(master), Some(at)) = (master, appended.sla_check_at.and_then(sla::instant))
            {
                weldsuite_db::due_index::mark_due(&master, sla::DUE_KIND, workspace_id, at).await;
            }
            let (assigned, message) = appended.pair();
            match resolve_authors(db, &[assigned["assigneeId"].as_str()]).await {
                Ok(authors) => {
                    publish_visitor_event(state, org_id, &assigned, &message, &authors, "assigned")
                        .await;
                    assigned
                }
                Err(error) => {
                    tracing::error!(%error, "[widget-api] auto-assignment failed");
                    conversation
                }
            }
        }
        Ok(None) => conversation,
        Err(error) => {
            tracing::error!(%error, "[widget-api] auto-assignment failed");
            conversation
        }
    }
}

/// `notificationRecipients(db, conversation)`: the assignee, else every
/// active internal teammate who can work the inbox.
async fn recipients(db: &PgPool, conversation: &Value) -> Result<Vec<String>, sqlx::Error> {
    if let Some(assignee) = conversation["assigneeId"]
        .as_str()
        .filter(|assignee| !assignee.is_empty())
    {
        return Ok(vec![assignee.to_owned()]);
    }
    let rows: Vec<String> = sqlx::query_scalar(
        "select user_id from workspace_members
         where upper(status) = 'ACTIVE' and upper(member_type) = 'INTERNAL' and upper(role) <> 'VIEWER'
         limit $1",
    )
    .bind(MAX_RECIPIENTS)
    .fetch_all(db)
    .await?;
    let mut out: Vec<String> = Vec::new();
    for user_id in rows {
        if !out.contains(&user_id) {
            out.push(user_id);
        }
    }
    Ok(out)
}

/// The first `max` UTF-16 units of `text` (`slice(0, max)`).
fn utf16_prefix(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

/// `notifyTeamOfVisitorMessage({ … })`: tell the team about a visitor
/// message, in batches. Only called when a conversation starts or the ball
/// moves back to the team.
pub(crate) async fn notify_team(
    state: &WidgetState,
    db: &PgPool,
    org_id: &str,
    conversation: &Value,
    message: &Value,
    visitor_name: &str,
    is_new: bool,
) {
    let recipients = match recipients(db, conversation).await {
        Ok(recipients) => recipients,
        Err(error) => {
            tracing::error!(%error, "[widget-api] team notification failed");
            return;
        }
    };
    let preview = utf16_prefix(js_trim(&collapse_whitespace(&message_text(message))), 180);
    let title = if is_new {
        format!("New conversation from {visitor_name}")
    } else {
        format!("{visitor_name} replied")
    };
    let id = conversation["id"].as_str().unwrap_or_default();
    let notifier = Notifier {
        realtime: state.realtime.clone(),
        presence: None,
        mail: state.mail.clone(),
        http: None,
        apns: None,
    };
    for batch in recipients.chunks(NOTIFY_BATCH) {
        for user_id in batch {
            let params = NewNotification {
                workspace_id: org_id.to_owned(),
                user_id: user_id.clone(),
                title: title.clone(),
                body: preview.clone(),
                category: "helpdesk".to_owned(),
                notification_type: "message_received".to_owned(),
                entity_type: "desk_conversation".to_owned(),
                entity_id: id.to_owned(),
                action_url: format!("/welddesk/inbox/{id}"),
                severity: "info".to_owned(),
                actor_type: Some("system".to_owned()),
                actor_id: None,
                data: vec![("conversationId".to_owned(), id.to_owned())],
                ..NewNotification::default()
            };
            if let Err(error) = create_and_deliver(db, &notifier, &params).await {
                tracing::error!(%error, "[widget-api] team notification failed");
            }
        }
    }
}

/// A visitor's stored `name` and `email`.
type NameAndEmail = (Option<String>, Option<String>);

/// `visitorDisplayName(db, visitorId, fallback)`: the name or email the
/// visitor gave, else the stored one, else `Visitor`.
pub(crate) async fn visitor_display_name(
    db: &PgPool,
    visitor_id: &str,
    fallback: &Value,
) -> String {
    for key in ["name", "email"] {
        if let Some(value) = fallback[key]
            .as_str()
            .map(js_trim)
            .filter(|value| !value.is_empty())
        {
            return value.to_owned();
        }
    }
    let row: Result<Option<NameAndEmail>, sqlx::Error> =
        sqlx::query_as("select name, email from desk_visitors where id = $1 limit 1")
            .bind(visitor_id)
            .fetch_optional(db)
            .await;
    let (name, email) = match row {
        Ok(Some(row)) => row,
        Ok(None) => (None, None),
        Err(error) => {
            tracing::error!(%error, "[widget-api] visitor lookup failed");
            (None, None)
        }
    };
    [name, email]
        .into_iter()
        .flatten()
        .map(|value| js_trim(&value).to_owned())
        .find(|value| !value.is_empty())
        .unwrap_or_else(|| "Visitor".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_text_is_the_body_or_the_files() {
        assert_eq!(message_text(&json!({ "body": "  hi  " })), "hi");
        assert_eq!(
            message_text(
                &json!({ "body": null, "attachments": [{ "name": "a.png" }, { "name": "b.png" }] })
            ),
            "📎 a.png +1"
        );
        assert_eq!(message_text(&json!({ "body": "", "attachments": [] })), "");
    }

    #[test]
    fn previews_cut_at_utf16_units() {
        assert_eq!(utf16_prefix("abc", 2), "ab");
        assert_eq!(utf16_prefix("😀x", 3), "😀x");
    }
}
