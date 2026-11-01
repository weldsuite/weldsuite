//! The engine's entry points (`helpdesk-workflow-worker/src/index.ts`
//! `handleEvent` and `handleRespond`), in process: what the desk API and the
//! other callers reach over the `HELPDESK_WORKFLOW` service binding on
//! Global. Same bodies in, same statuses and bodies out.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_ports::{BoxFuture, DynJobs, JobRequest};

use super::job::{
    CONVERSATION_WORKFLOW_JOB, CUSTOMER_MESSAGE, CUSTOMER_RESPONSE, ConversationWorkflowParams,
};
use super::shared::{js_string, or, truthy};
use super::{EngineError, EngineResponse, TenantDatabases, WorkflowEngine};

/// The engine in this process: runs start as `desk.conversation-workflow`
/// jobs, answers reach them as signals.
#[derive(Clone)]
pub struct InProcessEngine {
    tenants: TenantDatabases,
    jobs: Arc<dyn DynJobs>,
}

impl std::fmt::Debug for InProcessEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("InProcessEngine")
    }
}

fn answer(status: u16, body: Value) -> EngineResponse {
    EngineResponse { status, body }
}

/// The worker's catch-all: `500 { error: message }`.
fn internal(error: impl std::fmt::Display) -> EngineResponse {
    answer(500, json!({ "error": error.to_string() }))
}

/// `body[key]` as a string (`as string`), when it is one.
fn text<'a>(body: &'a Value, key: &str) -> &'a str {
    body.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Writes `payload` under `key` of an execution's context, for the run to
/// take after its wait (a signal carries no payload).
async fn leave_on_execution(
    db: &PgPool,
    execution_id: &str,
    key: &str,
    payload: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update helpdesk_workflow_executions
         set execution_context = coalesce(execution_context, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
         where id = $1",
    )
    .bind(execution_id)
    .bind(key)
    .bind(payload)
    .execute(db)
    .await?;
    Ok(())
}

impl InProcessEngine {
    pub fn new(tenants: TenantDatabases, jobs: Arc<dyn DynJobs>) -> Self {
        Self { tenants, jobs }
    }

    /// `handleEvent`: start a run for a conversation event, unless one is
    /// active (`busy`), or hand a customer message to a run in an AI step.
    pub async fn handle_event(&self, body: &Value) -> EngineResponse {
        let workspace_id = text(body, "workspaceId").to_owned();
        let conversation_id = text(body, "conversationId").to_owned();
        let db = match (self.tenants)(workspace_id.clone()).await {
            Ok(db) => db,
            Err(error) => return internal(error),
        };
        let active: Result<Option<(String, String, Option<Value>)>, sqlx::Error> = sqlx::query_as(
            "select id, status, execution_context from helpdesk_workflow_executions
             where conversation_id = $1 and status in ('running', 'waiting_for_input', 'ai_active')
             limit 1",
        )
        .bind(&conversation_id)
        .fetch_optional(&db)
        .await;
        let active = match active {
            Ok(active) => active,
            Err(error) => return internal(error),
        };
        let data = body.get("data").cloned().unwrap_or(Value::Null);
        if let Some((id, status, context)) = &active {
            if status == "ai_active"
                && body.get("type").and_then(Value::as_str) == Some("message_received")
            {
                return self.forward_to_ai(&db, id, context.as_ref(), &data).await;
            }
            return answer(200, json!({ "success": true, "action": "busy" }));
        }

        let channel = data.get("channel").filter(|c| truthy(Some(*c)));
        let mut trigger = match &data {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        trigger.insert("conversationId".to_owned(), json!(conversation_id));
        trigger.insert("workspaceId".to_owned(), json!(workspace_id));
        trigger.insert(
            "timestamp".to_owned(),
            json!(weldsuite_events::iso_timestamp(
                time::OffsetDateTime::now_utc()
            )),
        );
        let params = ConversationWorkflowParams {
            workspace_id,
            conversation_id,
            event_type: body.get("type").cloned().unwrap_or(Value::Null),
            channel: channel.map_or_else(|| "web".to_owned(), |c| js_string(Some(c))),
            trigger_data: Value::Object(trigger),
            workflow_ids: None,
        };
        let key = generate_id("wfi");
        let request = match JobRequest::new(CONVERSATION_WORKFLOW_JOB, key.clone(), &params) {
            Ok(request) => request,
            Err(error) => return internal(error),
        };
        if let Err(error) = self.jobs.start_boxed(request).await {
            return internal(error);
        }
        answer(
            200,
            json!({ "success": true, "action": "workflow_started", "instanceId": key }),
        )
    }

    /// `forwardToAiWorkflow`: the message, to the run whose instance id the
    /// execution keeps; `busy` when it keeps none or the hand-over fails.
    async fn forward_to_ai(
        &self,
        db: &PgPool,
        execution_id: &str,
        context: Option<&Value>,
        data: &Value,
    ) -> EngineResponse {
        let busy = answer(200, json!({ "success": true, "action": "busy" }));
        let Some(instance) = context
            .and_then(|c| c.get("cfInstanceId"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return busy;
        };
        let mut payload = Map::new();
        for (key, value) in [
            (
                "content",
                or(data.get("content"), data.get("messageContent")),
            ),
            (
                "customerName",
                or(data.get("customerName"), data.get("authorName")),
            ),
            ("messageId", data.get("messageId")),
        ] {
            if let Some(value) = value {
                payload.insert(key.to_owned(), value.clone());
            }
        }
        if let Err(error) =
            leave_on_execution(db, execution_id, "pendingMessage", &Value::Object(payload)).await
        {
            tracing::error!(%error, "[Event] Failed to forward to AI workflow");
            return busy;
        }
        match self
            .jobs
            .signal_boxed(CONVERSATION_WORKFLOW_JOB, instance, CUSTOMER_MESSAGE)
            .await
        {
            Ok(_) => answer(200, json!({ "success": true, "action": "ai_message_sent" })),
            Err(error) => {
                tracing::error!(%error, "[Event] Failed to forward to AI workflow");
                busy
            }
        }
    }

    /// `handleRespond`: hand a customer's answer to the run waiting for it.
    pub async fn handle_respond(&self, body: &Value) -> EngineResponse {
        let db = match (self.tenants)(text(body, "workspaceId").to_owned()).await {
            Ok(db) => db,
            Err(error) => return internal(error),
        };
        let execution: Result<Option<(String, Option<Value>)>, sqlx::Error> = sqlx::query_as(
            "select id, execution_context from helpdesk_workflow_executions
             where conversation_id = $1 and status = 'waiting_for_input' limit 1",
        )
        .bind(text(body, "conversationId"))
        .fetch_optional(&db)
        .await;
        let (execution_id, context) = match execution {
            Ok(Some(execution)) => execution,
            Ok(None) => {
                return answer(
                    404,
                    json!({ "success": false, "error": "No waiting execution found" }),
                );
            }
            Err(error) => return internal(error),
        };
        // The run keeps its instance id in the paused execution's context;
        // without one there is no run to reach (Cloudflare's `get` throws).
        let Some(instance) = context
            .as_ref()
            .and_then(|c| c.get("cfInstanceId"))
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return answer(
                500,
                json!({ "success": false, "error": "instance.not_found" }),
            );
        };
        let mut payload = Map::new();
        for key in [
            "stepId",
            "selectedValue",
            "selectedLabel",
            "submittedData",
            "rating",
            "feedback",
        ] {
            if let Some(value) = body.get(key) {
                payload.insert(key.to_owned(), value.clone());
            }
        }
        if let Err(error) = leave_on_execution(
            &db,
            &execution_id,
            "pendingResponse",
            &Value::Object(payload),
        )
        .await
        {
            return answer(500, json!({ "success": false, "error": error.to_string() }));
        }
        match self
            .jobs
            .signal_boxed(CONVERSATION_WORKFLOW_JOB, &instance, CUSTOMER_RESPONSE)
            .await
        {
            Ok(_) => answer(200, json!({ "success": true, "action": "event_sent" })),
            Err(error) => {
                tracing::error!(%error, "[Respond] Failed to send event");
                answer(500, json!({ "success": false, "error": error.to_string() }))
            }
        }
    }
}

impl WorkflowEngine for InProcessEngine {
    fn respond<'a>(
        &'a self,
        body: &'a Value,
    ) -> BoxFuture<'a, Result<EngineResponse, EngineError>> {
        Box::pin(async move { Ok(self.handle_respond(body).await) })
    }

    fn event<'a>(&'a self, body: &'a Value) -> BoxFuture<'a, Result<EngineResponse, EngineError>> {
        Box::pin(async move { Ok(self.handle_event(body).await) })
    }
}
