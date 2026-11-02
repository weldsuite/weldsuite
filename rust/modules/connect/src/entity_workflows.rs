//! The `weldconnect` hub subscriber: workflow-worker's
//! `entity-workflows-consumer.ts` and `matchAndDispatchWorkflowTriggers`
//! (`@weldsuite/entity-events/workflow-dispatch`). Each entity event starts
//! the runs of the workspace's active workflows whose `entity_event` trigger
//! matches it, one run per event and workflow; a workflow at its concurrent
//! run limit gets a `skipped` row instead.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition};
use weldsuite_subscribers::{HubEvent, Tenants};

use crate::executions::{Skipped, at_concurrency_limit, insert_skipped};
use crate::js::{as_text, truthy};
use crate::runs::WorkflowRuns;

/// `MAX_ENTITY_WORKFLOW_DEPTH`.
const MAX_DEPTH: u32 = 3;

/// The subscriber.
pub struct EntityWorkflowsSubscriber {
    tenants: Arc<dyn Tenants>,
    /// `env.EXECUTE_WORKFLOW`; without it every event is skipped.
    runs: Option<Arc<dyn WorkflowRuns>>,
}

impl std::fmt::Debug for EntityWorkflowsSubscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EntityWorkflowsSubscriber")
            .field("runs", &self.runs.is_some())
            .finish_non_exhaustive()
    }
}

/// `deriveEventTypes(action, changes)`.
pub(crate) fn derive_event_types(
    action: &str,
    changes: Option<&Map<String, Value>>,
) -> Vec<String> {
    let mut types = vec![action.to_owned()];
    if action == "updated"
        && let Some(changes) = changes
    {
        if changes.contains_key("status") {
            types.push("status_changed".into());
        }
        if changes.contains_key("assigneeId") || changes.contains_key("assigneeName") {
            types.push("assigned".into());
        }
        if changes.contains_key("tags") {
            types.push("tagged".into());
        }
        if changes.contains_key("priority") {
            types.push("priority_changed".into());
        }
    }
    types
}

/// `===` between JSON values.
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    crate::engine::template::strict_equals(a, b)
}

/// `evalFilters(filters, data)`.
pub(crate) fn eval_filters(filters: Option<&Value>, data: &Map<String, Value>) -> bool {
    let Some(Value::Array(filters)) = filters else {
        return true;
    };
    filters.iter().all(|filter| {
        let value = data.get(&crate::js::js_string(filter.get("field")));
        let expected = filter.get("value");
        match filter
            .get("operator")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "eq" | "equals" => same(value, expected),
            "neq" | "not_equals" => !same(value, expected),
            "contains" => as_text(value).contains(&as_text(expected)),
            "exists" => !matches!(value, None | Some(Value::Null)),
            "not_exists" => matches!(value, None | Some(Value::Null)),
            _ => true,
        }
    })
}

/// `triggerMatchesEvent(trigger, entityType, eventTypes, data)` (the JSONB
/// fallback when the trigger index can't be read).
fn trigger_matches(
    trigger: &Value,
    entity_type: &str,
    event_types: &[String],
    data: &Map<String, Value>,
) -> bool {
    if trigger["type"] != "entity_event" || trigger["isEnabled"] == json!(false) {
        return false;
    }
    let pick = |key: &str| {
        trigger
            .get(key)
            .filter(|v| truthy(v))
            .or_else(|| trigger.get("config").and_then(|c| c.get(key)))
            .and_then(Value::as_str)
    };
    if pick("entityType") != Some(entity_type) {
        return false;
    }
    if let Some(event_type) = pick("eventType").filter(|e| !e.is_empty())
        && !event_types.iter().any(|t| t == event_type)
    {
        return false;
    }
    eval_filters(trigger.get("config").and_then(|c| c.get("filters")), data)
}

/// One workflow to start.
struct Match {
    workflow_id: String,
    workflow_name: Option<String>,
    trigger_id: Option<String>,
    settings: Option<Value>,
}

/// `workflowInstanceIdForEvent(eventId, workflowId)`.
fn instance_id(event_id: &str, workflow_id: &str) -> String {
    format!("{event_id}-{workflow_id}")
        .chars()
        .take(64)
        .collect()
}

async fn matches(
    db: &PgPool,
    event: &HubEvent,
    event_types: &[String],
    data: &Map<String, Value>,
) -> Result<Vec<Match>, sqlx::Error> {
    let indexed: Result<
        Vec<(
            String,
            String,
            Option<String>,
            Option<Value>,
            Option<String>,
            Option<Value>,
        )>,
        _,
    > = sqlx::query_as(
        "select i.workflow_id, i.trigger_id, i.event_type, i.filters, w.name, w.settings
             from workflow_trigger_index i join workflows w on i.workflow_id = w.id
             where i.category = 'entity_event' and i.entity_type = $1 and i.is_enabled = true
               and w.status = 'active' and w.deleted_at is null",
    )
    .bind(&event.entity_type)
    .fetch_all(db)
    .await;
    match indexed {
        Ok(rows) => Ok(rows
            .into_iter()
            .filter(|(_, _, event_type, filters, _, _)| {
                event_type
                    .as_deref()
                    .is_none_or(|t| t.is_empty() || event_types.iter().any(|e| e == t))
                    && eval_filters(filters.as_ref(), data)
            })
            .map(|(workflow_id, trigger_id, _, _, name, settings)| Match {
                workflow_id,
                workflow_name: name,
                trigger_id: Some(trigger_id),
                settings,
            })
            .collect()),
        Err(error) => {
            tracing::warn!(%error, "[TriggerMatcher] trigger index unavailable, falling back to JSONB scan");
            let workflows: Vec<(String, Option<String>, Option<Value>, Option<Value>)> = sqlx::query_as(
                "select id, name, triggers, settings from workflows where status = 'active' and deleted_at is null",
            )
            .fetch_all(db)
            .await?;
            let mut out = Vec::new();
            for (id, name, triggers, settings) in workflows {
                for trigger in triggers
                    .as_ref()
                    .and_then(Value::as_array)
                    .map_or(&[][..], Vec::as_slice)
                {
                    if trigger_matches(trigger, &event.entity_type, event_types, data) {
                        out.push(Match {
                            workflow_id: id.clone(),
                            workflow_name: name.clone(),
                            trigger_id: trigger["id"].as_str().map(str::to_owned),
                            settings: settings.clone(),
                        });
                    }
                }
            }
            Ok(out)
        }
    }
}

impl EntityWorkflowsSubscriber {
    pub fn new(tenants: Arc<dyn Tenants>, runs: Option<Arc<dyn WorkflowRuns>>) -> Self {
        Self { tenants, runs }
    }

    /// `handleEntityWorkflowMessage(event, env)`.
    pub async fn handle_one(&self, delivery: &Delivery) -> Disposition {
        let event = match HubEvent::parse(&delivery.payload) {
            Ok(event) => event,
            Err(error) => {
                tracing::error!(%error, "[EntityWorkflows] not an entity event; dropped");
                return Disposition::Ack;
            }
        };
        let workspace_id = event.metadata.workspace_id.clone();
        if workspace_id.is_empty() {
            tracing::warn!(
                event_id = event.id,
                "[EntityWorkflows] Skipping event — missing workspaceId"
            );
            return Disposition::Ack;
        }
        let Some(runs) = &self.runs else {
            tracing::warn!(
                event_id = event.id,
                "[EntityWorkflows] Skipping event — EXECUTE_WORKFLOW binding missing"
            );
            return Disposition::Ack;
        };
        let tenant = match self.tenants.tenant(&workspace_id).await {
            Ok(tenant) => tenant,
            Err(error) => {
                return Disposition::retry(format!("cannot resolve the workspace: {error}"));
            }
        };
        match dispatch(&tenant.db, runs.as_ref(), &event, &workspace_id).await {
            Ok(()) => Disposition::Ack,
            Err(error) => Disposition::retry(error.to_string()),
        }
    }
}

/// `matchAndDispatchWorkflowTriggers(input)`.
async fn dispatch(
    db: &PgPool,
    runs: &dyn WorkflowRuns,
    event: &HubEvent,
    workspace_id: &str,
) -> Result<(), sqlx::Error> {
    let chain_depth = event.metadata.workflow_depth.map_or(0, |depth| depth + 1);
    if chain_depth >= MAX_DEPTH {
        tracing::warn!(
            "[TriggerMatcher] Skipping {}:{} ({}) — workflow chain depth {chain_depth} reached the limit of {MAX_DEPTH}",
            event.entity_type,
            event.action,
            event.entity_id
        );
        return Ok(());
    }
    let data = match event.data_value() {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let changes: Option<Value> = event
        .changes_raw
        .as_ref()
        .and_then(|raw| serde_json::from_str(raw.get()).ok())
        .filter(|v: &Value| !v.is_null());
    let event_types =
        derive_event_types(&event.action, changes.as_ref().and_then(Value::as_object));
    let user_id = event
        .metadata
        .user_id
        .clone()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "system".into());
    let mut trigger_data = json!({
        "eventType": format!("{}:{}", event.entity_type, event.action),
        "entityType": event.entity_type,
        "entityId": event.entity_id,
        "action": event.action,
        "data": Value::Object(data.clone()),
    });
    if let Some(changes) = &changes {
        trigger_data["changes"] = changes.clone();
    }
    for row in matches(db, event, &event_types, &data).await? {
        if at_concurrency_limit(db, &row.workflow_id, row.settings.as_ref()).await? {
            let name = row.workflow_name.clone().unwrap_or_default();
            let skipped = insert_skipped(
                db,
                Skipped {
                    workflow_id: &row.workflow_id,
                    workflow_version: None,
                    workflow_name: row.workflow_name.as_deref(),
                    triggered_by: Some(&user_id),
                    trigger_type: "entity_event",
                    trigger_id: row.trigger_id.as_deref(),
                    trigger_data: Some(&trigger_data),
                    reason: "concurrency_limit",
                    message: format!("Skipped: \"{name}\" is already at its concurrent run limit."),
                },
            )
            .await;
            if let Err(error) = skipped {
                tracing::error!(%error, "[TriggerMatcher] Failed to record skipped execution for {}", row.workflow_id);
            }
            continue;
        }
        let mut data_with_event = trigger_data.clone();
        if !event.id.is_empty() {
            data_with_event["eventId"] = json!(event.id);
        }
        let mut params = json!({
            "workspaceId": workspace_id,
            "userId": user_id,
            "workflowId": row.workflow_id,
            "triggerType": "entity_event",
            "triggerData": data_with_event,
            "chainDepth": chain_depth,
            "source": "weldconnect",
        });
        if let Some(trigger_id) = row.trigger_id.as_ref().filter(|t| !t.is_empty()) {
            params["triggerId"] = json!(trigger_id);
        }
        let id = (!event.id.is_empty()).then(|| instance_id(&event.id, &row.workflow_id));
        if let Err(error) = runs.start(id.as_deref(), &params).await {
            tracing::error!(%error, "[TriggerMatcher] Failed to dispatch workflow {}", row.workflow_id);
        }
    }
    Ok(())
}

impl BatchHandler for EntityWorkflowsSubscriber {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(batch.len());
            for delivery in batch {
                out.push(self.handle_one(delivery).await);
            }
            out
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn event_types_and_filters() {
        let changes: Map<String, Value> =
            serde_json::from_value(json!({ "status": {}, "tags": {} })).unwrap();
        assert_eq!(
            derive_event_types("updated", Some(&changes)),
            vec!["updated", "status_changed", "tagged"]
        );
        let data: Map<String, Value> =
            serde_json::from_value(json!({ "status": "won", "name": "Acme Corp" })).unwrap();
        assert!(eval_filters(
            Some(
                &json!([{ "field": "status", "operator": "eq", "value": "won" },
                         { "field": "name", "operator": "contains", "value": "Corp" }])
            ),
            &data
        ));
        assert!(!eval_filters(
            Some(&json!([{ "field": "missing", "operator": "exists" }])),
            &data
        ));
        assert_eq!(instance_id("evt_1", "wf_2"), "evt_1-wf_2");
    }
}
