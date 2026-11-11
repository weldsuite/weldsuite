//! What a WeldDesk service request does after the rows change
//! (`@weldsuite/desk-domain/catalog`, `packages/domains/desk/src/catalog.ts`),
//! for every writer of a request (the desk API when an agent decides an
//! approval or makes a conversation a request):
//!
//! - [`fulfil`] (`fulfilDeskCatalogRequest`): the item's fulfilment tasks
//!   become WeldFlow tasks linked to the conversation
//!   (`tasks.source_type = 'desk_conversation'`), each announced like the
//!   flow API announces a task (`project_task created`, an assignment
//!   notification), and the timeline gets `fulfilment_started`. Idempotent
//!   per conversation.
//! - [`notify_approver`] (`notifyDeskApprover`): the approver of a step that
//!   just opened hears about it.
//!
//! The rows are written by [`crate::catalog`]. Both run after the response
//! (the workers' `waitUntil`): they never fail, a failure is logged and the
//! request that triggered them is unaffected.

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventSource, EventType};
use weldsuite_flow_domain::analytics::task_analytics_payload;
use weldsuite_flow_domain::js::iso_from_millis;
use weldsuite_flow_domain::tasks::create_task;
use weldsuite_notifications::{NewNotification, Notifier, create_and_deliver};

use crate::catalog;
use crate::realtime::now_ms;
use crate::workflow::shared::js_string;

const DAY_MS: f64 = 86_400_000.0;

/// `DeskCatalogContext`: where the follow-up writes and publishes.
#[derive(Clone, Copy)]
pub struct FollowUp<'a> {
    pub db: &'a PgPool,
    pub events: &'a EntityEventPublisher,
    pub notifier: &'a Notifier,
    /// The workspace's Clerk org id: notifications and entity events are
    /// still keyed by it.
    pub clerk_org_id: &'a str,
}

fn truthy_text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row[key].as_str().filter(|value| !value.is_empty())
}

/// `taskData(template, conversation, now)`: the task a template creates,
/// for `createTask`. It goes to the template's assignee, else the
/// conversation's, else nobody; due `dueInDays` from `now`.
fn task_data(template: &Value, conversation: &Value, now: i64) -> Map<String, Value> {
    let mut data = Map::new();
    data.insert("title".to_owned(), template["title"].clone());
    if let Some(description) = template.get("description") {
        data.insert("description".to_owned(), description.clone());
    }
    if let Some(assignee) =
        truthy_text(template, "assigneeId").or_else(|| truthy_text(conversation, "assigneeId"))
    {
        data.insert("assigneeId".to_owned(), json!(assignee));
    }
    // `typeof template.dueInDays === 'number'`.
    if let Some(days) = template["dueInDays"].as_f64() {
        #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
        let due = (now as f64 + days * DAY_MS) as i64;
        if let Some(due) = iso_from_millis(due) {
            data.insert("dueDate".to_owned(), json!(due));
        }
    }
    data.insert("sourceType".to_owned(), json!("desk_conversation"));
    data.insert("sourceId".to_owned(), conversation["id"].clone());
    data
}

/// `publishEntityEventRaw({ workspaceId: clerkOrgId, userId, … })`, awaited.
async fn publish(
    ctx: &FollowUp<'_>,
    user_id: &str,
    (entity_type, action): (&str, &str),
    entity_id: &str,
    data: Value,
) {
    match EventType::catalog(entity_type, action) {
        Ok(event) => {
            let context = EventContext::new(ctx.clerk_org_id, user_id, EventSource::System);
            ctx.events
                .publish_and_wait(&context, EntityEvent::new(event, entity_id, data))
                .await;
        }
        Err(error) => tracing::error!(%error, "[desk-catalog] unknown entity event"),
    }
}

/// `sendTaskAssignmentNotification` for a fulfilment task (no project, so it
/// opens the task list): nothing for the member who caused it.
async fn notify_assignee(
    ctx: &FollowUp<'_>,
    assignee: &str,
    assigned_by: &str,
    task: &Value,
) -> Result<(), sqlx::Error> {
    if assignee == assigned_by {
        return Ok(());
    }
    let name: Result<Option<Option<String>>, sqlx::Error> =
        sqlx::query_scalar("select name from workspace_members where user_id = $1 limit 1")
            .bind(assigned_by)
            .fetch_optional(ctx.db)
            .await;
    let by = match name {
        Ok(name) => name.flatten().filter(|name| !name.is_empty()),
        Err(error) => {
            tracing::error!(%error, "[Notifications] Failed to resolve assigner name");
            None
        }
    }
    .unwrap_or_else(|| "Someone".to_owned());
    let task_id = task["id"].as_str().unwrap_or_default();
    let title = task["title"].as_str().unwrap_or_default();
    let params = NewNotification {
        workspace_id: ctx.clerk_org_id.to_owned(),
        user_id: assignee.to_owned(),
        title: "Task assigned to you".to_owned(),
        body: format!("{by} assigned \"{title}\" to you"),
        category: "crm".to_owned(),
        notification_type: "task_assigned".to_owned(),
        entity_type: "task".to_owned(),
        entity_id: task_id.to_owned(),
        action_url: "/weldcrm/tasks".to_owned(),
        severity: "info".to_owned(),
        actor_type: Some("user".to_owned()),
        actor_id: Some(assigned_by.to_owned()),
        data: vec![("taskId".to_owned(), task_id.to_owned())],
        ..NewNotification::default()
    };
    create_and_deliver(ctx.db, ctx.notifier, &params).await?;
    Ok(())
}

/// `fulfilDeskCatalogRequest(ctx, input)`: create the item's fulfilment
/// tasks for an approved (or approval-free) request; no project. A request
/// whose `fulfilment_started` event exists is left alone, and an item
/// without tasks writes nothing. `actor_user_id` is the member whose action
/// approved the request; absent for the system. The tasks that were
/// created, in the item's order; `None` when it did nothing or failed.
pub async fn fulfil(
    ctx: &FollowUp<'_>,
    conversation: &Value,
    item: &Value,
    actor_user_id: Option<&str>,
) -> Option<Vec<String>> {
    match try_fulfil(ctx, conversation, item, actor_user_id).await {
        Ok(task_ids) => task_ids,
        Err(error) => {
            tracing::error!(%error, "[desk-catalog] fulfilment failed");
            None
        }
    }
}

async fn try_fulfil(
    ctx: &FollowUp<'_>,
    conversation: &Value,
    item: &Value,
    actor_user_id: Option<&str>,
) -> Result<Option<Vec<String>>, String> {
    let failed = |error: &dyn std::fmt::Display| error.to_string();
    let templates: &[Value] = item["fulfilmentTasks"]
        .as_array()
        .map_or(&[], Vec::as_slice);
    if templates.is_empty() {
        return Ok(None);
    }
    let conversation_id = conversation["id"].as_str().unwrap_or_default();
    if catalog::fulfilment_started(ctx.db, conversation_id)
        .await
        .map_err(|error| failed(&error))?
    {
        return Ok(None);
    }
    let actor = actor_user_id.unwrap_or("system");

    let now = now_ms();
    let mut task_ids = Vec::with_capacity(templates.len());
    for template in templates {
        let data = task_data(template, conversation, now);
        let created = create_task(ctx.db, &data, None, actor)
            .await
            .map_err(|error| failed(&error))?;
        let task_id = created.row["id"].as_str().unwrap_or_default().to_owned();
        task_ids.push(task_id.clone());
        publish(
            ctx,
            actor,
            ("project_task", "created"),
            &task_id,
            task_analytics_payload(&created.row, &json!({ "projectId": null }), now_ms()),
        )
        .await;
        for assignee in &created.assignee_ids {
            if let Err(error) = notify_assignee(ctx, assignee, actor, &created.row).await {
                tracing::error!(%error, "[desk-catalog] task assignment notification failed");
            }
        }
    }

    let recorded = catalog::record_fulfilment(ctx.db, conversation_id, actor_user_id, &task_ids)
        .await
        .map_err(|error| failed(&error))?;
    let after_id = recorded.conversation["id"].as_str().unwrap_or_default();
    publish(
        ctx,
        actor,
        ("desk_conversation", "updated"),
        after_id,
        recorded.conversation.clone(),
    )
    .await;
    let message_id = recorded.message["id"].as_str().unwrap_or_default();
    publish(
        ctx,
        actor,
        ("desk_message", "created"),
        message_id,
        recorded.message.clone(),
    )
    .await;
    Ok(Some(task_ids))
}

/// The approver's notification: "Approval needed: <item> for <requester>",
/// linking to the inbox conversation.
fn approver_notification(
    clerk_org_id: &str,
    approver: &str,
    approval: &Value,
    conversation: &Value,
    item: Option<&Value>,
) -> NewNotification {
    let requester = truthy_text(conversation, "name")
        .or_else(|| truthy_text(conversation, "email"))
        .unwrap_or("a customer");
    // `item?.name ?? conversation.title ?? 'Service request'`.
    let what = item
        .and_then(|item| item["name"].as_str())
        .or_else(|| conversation["title"].as_str())
        .unwrap_or("Service request");
    let number = js_string(conversation.get("conversationNumber"));
    let body = match truthy_text(approval, "stepName") {
        Some(step) => format!("{step} · request #{number}"),
        None => format!("Request #{number}"),
    };
    let id = conversation["id"].as_str().unwrap_or_default();
    NewNotification {
        workspace_id: clerk_org_id.to_owned(),
        user_id: approver.to_owned(),
        title: format!("Approval needed: {what} for {requester}"),
        body,
        category: "helpdesk".to_owned(),
        notification_type: "custom".to_owned(),
        entity_type: "desk_conversation".to_owned(),
        entity_id: id.to_owned(),
        action_url: format!("/welddesk/inbox/{id}"),
        severity: "info".to_owned(),
        actor_type: Some("system".to_owned()),
        actor_id: None,
        data: vec![
            ("conversationId".to_owned(), id.to_owned()),
            ("stepIndex".to_owned(), js_string(approval.get("stepIndex"))),
        ],
        ..NewNotification::default()
    }
}

/// `notifyDeskApprover(ctx, input)`: an in-app notification for the approver
/// of a step that just opened. A step without an approver notifies nobody
/// (the approvals list shows it to the catalogue's managers).
pub async fn notify_approver(
    ctx: &FollowUp<'_>,
    approval: &Value,
    conversation: &Value,
    item: Option<&Value>,
) {
    let Some(approver) = truthy_text(approval, "approverId") else {
        return;
    };
    let params = approver_notification(ctx.clerk_org_id, approver, approval, conversation, item);
    if let Err(error) = create_and_deliver(ctx.db, ctx.notifier, &params).await {
        tracing::error!(%error, "[desk-catalog] approver notification failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn a_task_goes_to_the_templates_assignee_else_the_conversations() {
        let conversation = json!({ "id": "dconv_1", "assigneeId": "user_bob" });
        let own = task_data(
            &json!({ "id": "t1", "title": "Order", "assigneeId": "user_alice", "dueInDays": 2 }),
            &conversation,
            NOW,
        );
        assert_eq!(
            Value::Object(own),
            json!({
                "title": "Order", "assigneeId": "user_alice",
                "dueDate": iso_from_millis(NOW + 2 * 86_400_000),
                "sourceType": "desk_conversation", "sourceId": "dconv_1",
            })
        );
        let owner = task_data(
            &json!({ "id": "t2", "title": "Hand over", "assigneeId": null, "dueInDays": 0 }),
            &conversation,
            NOW,
        );
        assert_eq!(owner["assigneeId"], "user_bob");
        assert_eq!(owner["dueDate"], json!(iso_from_millis(NOW)));
        let nobody = task_data(
            &json!({ "id": "t3", "title": "Check", "description": "Twice", "dueInDays": null }),
            &json!({ "id": "dconv_2", "assigneeId": null }),
            NOW,
        );
        assert_eq!(
            Value::Object(nobody),
            json!({
                "title": "Check", "description": "Twice",
                "sourceType": "desk_conversation", "sourceId": "dconv_2",
            })
        );
    }

    #[test]
    fn the_approver_reads_the_item_the_requester_and_the_step() {
        let approval = json!({ "approverId": "user_alice", "stepName": "Budget", "stepIndex": 1 });
        let conversation = json!({
            "id": "dconv_1", "name": "Customer 903", "email": "c@example.test",
            "title": "Laptop please", "conversationNumber": 903,
        });
        let params = approver_notification(
            "org_1",
            "user_alice",
            &approval,
            &conversation,
            Some(&json!({ "name": "Server access" })),
        );
        assert_eq!(
            params.title,
            "Approval needed: Server access for Customer 903"
        );
        assert_eq!(params.body, "Budget · request #903");
        assert_eq!(params.action_url, "/welddesk/inbox/dconv_1");
        assert_eq!(params.notification_type, "custom");
        assert_eq!(
            params.data,
            [
                ("conversationId".to_owned(), "dconv_1".to_owned()),
                ("stepIndex".to_owned(), "1".to_owned()),
            ]
        );

        // The item is gone and the step has no name: the title and the number.
        let bare = approver_notification(
            "org_1",
            "user_alice",
            &json!({ "approverId": "user_alice", "stepName": null, "stepIndex": 0 }),
            &json!({ "id": "dconv_2", "name": "", "email": null, "title": null, "conversationNumber": 7 }),
            None,
        );
        assert_eq!(
            bare.title,
            "Approval needed: Service request for a customer"
        );
        assert_eq!(bare.body, "Request #7");
    }
}
