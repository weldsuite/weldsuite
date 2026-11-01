//! `ConversationWorkflow` (`helpdesk-workflow-worker/src/workflows/conversation-workflow.ts`)
//! as the `desk.conversation-workflow` job.
//!
//! A run matches the workspace's active helpdesk workflows to the event,
//! marks the conversation as having an active workflow, runs each matched
//! workflow's steps in order (one execution row each), and clears the mark.
//! Step names, step boundaries and waits are the Workflow's, one for one:
//!
//! - `step.do(name, …)` → [`step`] with Cloudflare's default retries;
//! - `step.waitForEvent('customer_response' | 'customer_message')` →
//!   [`JobContext::wait_for_signal`]. A signal carries no payload, so the
//!   answer itself travels in the execution row: [`super::engine`] writes
//!   it to `execution_context.pendingResponse` (`pendingMessage`) before it
//!   signals, and the step after the wait takes it from there (the `resume`
//!   step writes the context the Workflow writes, which drops it). A wait
//!   that times out fails the run, as `waitForEvent` throws;
//! - `step.sleep` → [`JobContext::sleep`].

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_ports::{
    BoxFuture, DynRealtimePublisher, Job, JobContext, JobError, RealtimeMessage, StepRetry, step,
};

use super::TenantDatabases;
use super::dispatch::{Dispatch, dispatch_step_to_channel};
use super::handlers::{StepDeps, StepInput, StepOutcome, execute_step_handler};
use super::shared::{as_text, js_number, js_string, strict_equals, truthy};
use crate::http::DynDeskHttp;
use crate::realtime::{conversation_publish, now_ms};

/// The job's name.
pub const CONVERSATION_WORKFLOW_JOB: &str = "desk.conversation-workflow";
/// The signal a customer's answer to an interactive step sends.
pub const CUSTOMER_RESPONSE: &str = "customer_response";
/// The signal a customer message sends to a run in an AI step.
pub const CUSTOMER_MESSAGE: &str = "customer_message";

const RESPONSE_TIMEOUT: Duration = Duration::from_mins(30);
const MESSAGE_TIMEOUT: Duration = Duration::from_mins(60);

/// `ConversationWorkflowParams`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationWorkflowParams {
    pub workspace_id: String,
    pub conversation_id: String,
    /// `conversation_created` or `message_received` (any value, as sent).
    #[serde(default)]
    pub event_type: Value,
    pub channel: String,
    pub trigger_data: Value,
    /// Pre-matched workflow ids: skip trigger matching.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_ids: Option<Vec<String>>,
}

/// What the job reaches outside its payload.
#[derive(Clone)]
pub struct EngineDeps {
    pub tenants: TenantDatabases,
    /// `env.REALTIME`; without it nothing is published.
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// Discord's and Slack's APIs.
    pub http: Option<DynDeskHttp>,
    /// `DISCORD_BOT_TOKEN`.
    pub discord_bot_token: Option<String>,
}

/// The `ConversationWorkflow` Workflow.
#[derive(Clone)]
pub struct ConversationWorkflowJob {
    pub deps: EngineDeps,
}

// ---------------------------------------------------------------------------
// Trigger matching
// ---------------------------------------------------------------------------

/// `matchesEventType(cfg, eventType)`.
fn matches_event_type(cfg: &Value, event_type: &Value) -> bool {
    let entity = cfg.get("entityType").and_then(Value::as_str);
    let event = cfg.get("eventType");
    let event_is = |name: &str| event.and_then(Value::as_str) == Some(name);
    match event_type.as_str() {
        Some("conversation_created") => {
            entity == Some("helpdesk_conversation") && (!truthy(event) || event_is("created"))
        }
        Some("message_received") => {
            let conversation_message = entity == Some("helpdesk_conversation")
                && (event_is("message_received") || event_is("first_message"));
            let message_created = entity == Some("helpdesk_conversation_message")
                && (!truthy(event) || event_is("created"));
            conversation_message || message_created
        }
        _ => true,
    }
}

/// `triggerMatches(t, params)`.
fn trigger_matches(trigger: &Value, event_type: &Value, channel: &str) -> bool {
    if !truthy(trigger.get("isEnabled"))
        || trigger.get("type").and_then(Value::as_str) != Some("entity_event")
    {
        return false;
    }
    let Some(cfg) = trigger.get("config").filter(|c| truthy(Some(*c))) else {
        return false;
    };
    if !matches_event_type(cfg, event_type) {
        return false;
    }
    // `cfg.channels?.length && !cfg.channels.includes(params.channel)`.
    match cfg.get("channels") {
        Some(Value::Array(channels)) if !channels.is_empty() => channels
            .iter()
            .any(|c| strict_equals(Some(c), Some(&json!(channel)))),
        Some(Value::String(channels)) if !channels.is_empty() => channels.contains(channel),
        _ => true,
    }
}

/// `workflowMatches(wf, params)`.
pub fn workflow_matches(
    workflow_id: &str,
    triggers: &Value,
    event_type: &Value,
    channel: &str,
    workflow_ids: Option<&[String]>,
) -> bool {
    if let Some(ids) = workflow_ids.filter(|ids| !ids.is_empty()) {
        return ids.iter().any(|id| id == workflow_id);
    }
    match triggers {
        Value::Array(triggers) => triggers
            .iter()
            .any(|t| trigger_matches(t, event_type, channel)),
        _ => false,
    }
}

/// A matched workflow, as the `match-triggers` step returns it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MatchedWorkflow {
    id: String,
    name: String,
    steps: Vec<Value>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn failed(error: impl std::fmt::Display) -> JobError {
    JobError::failed(error)
}

fn now_text() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `(a.order ?? 0) - (b.order ?? 0)` as a sort order (`NaN` ties).
fn by_sort_order(a: &Value, b: &Value) -> std::cmp::Ordering {
    let order = |s: &Value| match s.get("order") {
        None | Some(Value::Null) => 0.0,
        other => js_number(other),
    };
    order(a)
        .partial_cmp(&order(b))
        .unwrap_or(std::cmp::Ordering::Equal)
}

/// `` `${value}` `` of a step's id.
fn id_text(step: &Value) -> String {
    js_string(step.get("id"))
}

/// The run's mutable state between steps (`RunContext` / `ExecutionContext`).
struct Run<'a> {
    ctx: &'a dyn JobContext,
    params: &'a ConversationWorkflowParams,
    /// Shared by every workflow of the run, as `rc.stepResults` is.
    step_results: Map<String, Value>,
}

/// One workflow of the run.
struct Execution<'a> {
    workflow: &'a MatchedWorkflow,
    id: String,
    variables: Map<String, Value>,
}

impl ConversationWorkflowJob {
    async fn db(&self, workspace: &str) -> Result<PgPool, JobError> {
        (self.deps.tenants)(workspace.to_owned())
            .await
            .map_err(failed)
    }

    async fn publish(&self, message: RealtimeMessage) {
        if let Some(realtime) = &self.deps.realtime
            && let Err(error) = realtime.publish_boxed(&message).await
        {
            tracing::warn!(%error, "[helpdesk-workflow] realtime publish failed");
        }
    }

    /// `publishRefetch(ec, hasNewMessage)`.
    async fn publish_refetch(&self, conversation_id: &str, has_new_message: bool) {
        if has_new_message {
            self.publish(conversation_publish(
                conversation_id,
                json!({ "type": "refetch", "ts": now_ms() }),
            ))
            .await;
        }
    }

    /// `matchWorkflows(params)`.
    async fn match_workflows(
        &self,
        params: &ConversationWorkflowParams,
    ) -> Result<Vec<MatchedWorkflow>, JobError> {
        let db = self.db(&params.workspace_id).await?;
        let rows: Vec<(String, String, Option<Value>, Option<Value>)> = sqlx::query_as(
            "select id, name, steps, triggers from helpdesk_workflows
             where status = 'active' and deleted_at is null
             order by sort_order",
        )
        .fetch_all(&db)
        .await
        .map_err(failed)?;
        let total = rows.len();
        let matched: Vec<MatchedWorkflow> = rows
            .into_iter()
            .filter(|(id, _, _, triggers)| {
                workflow_matches(
                    id,
                    triggers.as_ref().unwrap_or(&Value::Null),
                    &params.event_type,
                    &params.channel,
                    params.workflow_ids.as_deref(),
                )
            })
            .map(|(id, name, steps, _)| MatchedWorkflow {
                id,
                name,
                steps: match steps {
                    Some(Value::Array(steps)) => steps,
                    _ => Vec::new(),
                },
            })
            .collect();
        tracing::info!(
            event_type = %params.event_type,
            matched = matched.len(),
            total,
            "[match-triggers]"
        );
        Ok(matched)
    }

    /// `setActive`/`finalize`: `has_active_workflow` on the conversation.
    async fn set_active(
        &self,
        params: &ConversationWorkflowParams,
        active: bool,
    ) -> Result<(), JobError> {
        let db = self.db(&params.workspace_id).await?;
        sqlx::query(
            "update helpdesk_conversations set has_active_workflow = $2, updated_at = $3::timestamp
             where id = $1",
        )
        .bind(&params.conversation_id)
        .bind(active)
        .bind(now_text())
        .execute(&db)
        .await
        .map_err(failed)?;
        Ok(())
    }

    /// The run, returning what `run()` returns.
    pub async fn execute(
        &self,
        ctx: &dyn JobContext,
        params: &ConversationWorkflowParams,
    ) -> Result<Value, JobError> {
        let matched: Vec<MatchedWorkflow> =
            step(ctx, "match-triggers", StepRetry::default(), || async {
                self.match_workflows(params).await
            })
            .await?;
        if matched.is_empty() {
            return Ok(json!({ "action": "no_workflows" }));
        }
        step(ctx, "set-active", StepRetry::default(), || async {
            self.set_active(params, true).await
        })
        .await?;

        let mut run = Run {
            ctx,
            params,
            step_results: Map::new(),
        };
        for workflow in &matched {
            self.run_workflow(&mut run, workflow).await?;
        }

        step(ctx, "finalize", StepRetry::default(), || async {
            self.set_active(params, false).await
        })
        .await?;
        self.publish(conversation_publish(
            &params.conversation_id,
            json!({ "type": "refetch", "ts": now_ms() }),
        ))
        .await;
        self.publish(RealtimeMessage::workspace(
            &params.workspace_id,
            "helpdesk",
            "conversation_new",
            json!({ "conversationId": params.conversation_id }),
            "system",
        ))
        .await;
        Ok(json!({ "success": true, "action": "completed", "workflowCount": matched.len() }))
    }

    /// `execHandler(ec, wfStep, triggerData)`.
    async fn exec_handler(
        &self,
        run: &Run<'_>,
        execution: &Execution<'_>,
        step_def: &Value,
        trigger_data: &Value,
    ) -> Result<StepOutcome, JobError> {
        let db = self.db(&run.params.workspace_id).await?;
        let deps = StepDeps {
            db,
            realtime: self.deps.realtime.clone(),
        };
        execute_step_handler(
            &deps,
            step_def,
            StepInput {
                conversation_id: &run.params.conversation_id,
                workspace_id: &run.params.workspace_id,
                execution_id: &execution.id,
                trigger_data,
                step_results: &run.step_results,
                variables: &execution.variables,
            },
        )
        .await
        .map_err(failed)
    }

    /// `execHandler` as one durable step.
    async fn handler_step(
        &self,
        run: &Run<'_>,
        execution: &Execution<'_>,
        name: &str,
        step_def: &Value,
        trigger_data: &Value,
    ) -> Result<StepOutcome, JobError> {
        step(run.ctx, name, StepRetry::default(), || async {
            self.exec_handler(run, execution, step_def, trigger_data)
                .await
        })
        .await
    }

    /// `updateExecution(ec, values)`: the columns the run sets.
    async fn update_execution(
        &self,
        run: &Run<'_>,
        execution_id: &str,
        update: ExecutionUpdate,
    ) -> Result<(), JobError> {
        let db = self.db(&run.params.workspace_id).await?;
        sqlx::query(
            "update helpdesk_workflow_executions set
               status = $2,
               updated_at = $3::timestamp,
               current_step_index = case when $4::int is null then current_step_index else $4 end,
               current_step_id = case when $5::text is null then current_step_id else $5 end,
               execution_context = case when $6::jsonb is null then execution_context else $6 end,
               error = case when $7::jsonb is null then error else $7 end,
               completed_at = case when $8 then $3::timestamp else completed_at end
             where id = $1",
        )
        .bind(execution_id)
        .bind(update.status)
        .bind(now_text())
        .bind(update.current_step_index)
        .bind(update.current_step_id)
        .bind(update.context)
        .bind(update.error)
        .bind(update.completed)
        .execute(&db)
        .await
        .map_err(failed)?;
        Ok(())
    }

    /// `dispatchToChannel(ec, wfStep, stepOutcome)`.
    async fn dispatch_to_channel(&self, run: &Run<'_>, step_def: &Value, outcome: &StepOutcome) {
        let channel = run.params.channel.as_str();
        if !outcome.has_new_message || channel == "chat" || channel == "web" {
            return;
        }
        let db = match self.db(&run.params.workspace_id).await {
            Ok(db) => db,
            Err(error) => {
                tracing::error!(%error, "[Workflow] Channel dispatch failed");
                return;
            }
        };
        dispatch_step_to_channel(&Dispatch {
            db: &db,
            http: self.deps.http.as_ref(),
            discord_bot_token: self.deps.discord_bot_token.as_deref(),
            conversation_id: &run.params.conversation_id,
            channel,
            step_type: step_def
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            step_result: &outcome.result,
        })
        .await;
    }

    /// `runWorkflow(rc, workflow)`.
    async fn run_workflow(
        &self,
        run: &mut Run<'_>,
        workflow: &MatchedWorkflow,
    ) -> Result<(), JobError> {
        let mut main_steps: Vec<Value> = workflow
            .steps
            .iter()
            .filter(|s| !truthy(s.get("parentBranchId")))
            .cloned()
            .collect();
        main_steps.sort_by(by_sort_order);

        let instance_id = run.ctx.key().to_owned();
        let params = run.params;
        let total_steps = i32::try_from(main_steps.len()).unwrap_or(i32::MAX);
        let execution_id: String = step(
            run.ctx,
            &format!("exec-create-{}", workflow.id),
            StepRetry::default(),
            || async {
                let db = self.db(&params.workspace_id).await?;
                let id = generate_id("wex");
                let channel = if params.channel.is_empty() { "web" } else { params.channel.as_str() };
                sqlx::query(
                    "insert into helpdesk_workflow_executions
                       (id, helpdesk_workflow_id, workflow_version, workflow_name, status, triggered_by,
                        trigger_type, trigger_data, started_at, total_steps, current_step_index,
                        conversation_id, channel, execution_context, created_at, updated_at)
                     values ($1, $2, 1, $3, 'running', 'system', 'entity_event', $4, $5::timestamp,
                        $6, 0, $7, $8, $9, $5::timestamp, $5::timestamp)",
                )
                .bind(&id)
                .bind(&workflow.id)
                .bind(&workflow.name)
                .bind(&params.trigger_data)
                .bind(now_text())
                .bind(total_steps)
                .bind(&params.conversation_id)
                .bind(channel)
                .bind(json!({ "cfInstanceId": instance_id }))
                .execute(&db)
                .await
                .map_err(failed)?;
                Ok(id)
            },
        )
        .await?;

        let mut execution = Execution {
            workflow,
            id: execution_id,
            variables: Map::new(),
        };
        for (i, step_def) in main_steps.iter().enumerate() {
            if self.run_main_step(run, &mut execution, step_def, i).await? {
                break;
            }
        }

        let execution_id = execution.id.clone();
        step(
            run.ctx,
            &format!("complete-{}", workflow.id),
            StepRetry::default(),
            || async {
                let db = self.db(&params.workspace_id).await?;
                let output = Value::Object(run.step_results.clone());
                sqlx::query(
                    "update helpdesk_workflow_executions set status = 'completed',
                       completed_at = $2::timestamp, output = $3, updated_at = $2::timestamp
                     where id = $1 and status = 'running'",
                )
                .bind(&execution_id)
                .bind(now_text())
                .bind(output)
                .execute(&db)
                .await
                .map_err(failed)?;
                Ok(())
            },
        )
        .await
    }

    /// `runMainStep(ec, wfStep, i)`: `true` when the workflow failed and stops.
    async fn run_main_step(
        &self,
        run: &mut Run<'_>,
        execution: &mut Execution<'_>,
        step_def: &Value,
        i: usize,
    ) -> Result<bool, JobError> {
        let workflow_id = execution.workflow.id.clone();
        let step_id = id_text(step_def);
        let trigger_data = run.params.trigger_data.clone();
        let outcome = self
            .handler_step(
                run,
                execution,
                &format!("step-{workflow_id}-{i}-{step_id}"),
                step_def,
                &trigger_data,
            )
            .await?;
        run.step_results.insert(step_id, outcome.result.clone());

        self.publish_refetch(&run.params.conversation_id, outcome.has_new_message)
            .await;
        self.dispatch_to_channel(run, step_def, &outcome).await;

        let step_type = step_def
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if outcome.kind == "waiting_for_input" {
            self.wait_for_customer_response(run, execution, step_def, i)
                .await?;
            return Ok(false);
        }
        let escalated = truthy(outcome.result.get("escalated"));
        if matches!(step_type, "ai_auto_reply" | "ai_agent")
            && outcome.kind == "completed"
            && !escalated
        {
            self.run_ai_loop(run, execution, step_def, i).await?;
            return Ok(false);
        }
        if outcome.kind == "delay" {
            let ms = outcome
                .delay_ms
                .filter(|ms| *ms != 0.0 && !ms.is_nan())
                .unwrap_or(1000.0);
            run.ctx
                .sleep(
                    &format!("delay-{workflow_id}-{i}"),
                    Duration::from_secs_f64(ms.max(0.0) / 1000.0),
                )
                .await?;
            return Ok(false);
        }
        if outcome.kind == "failed" && !truthy(step_def.get("continueOnError")) {
            let message = match &outcome.error {
                Some(error) if truthy(Some(error)) => error.clone(),
                _ => json!("Step failed"),
            };
            let execution_id = execution.id.clone();
            step(
                run.ctx,
                &format!("fail-{workflow_id}"),
                StepRetry::default(),
                || async {
                    self.update_execution(
                        run,
                        &execution_id,
                        ExecutionUpdate {
                            error: Some(json!({ "message": message })),
                            completed: true,
                            ..ExecutionUpdate::status("failed")
                        },
                    )
                    .await
                },
            )
            .await?;
            return Ok(true);
        }
        Ok(false)
    }

    /// `waitForCustomerResponse(ec, wfStep, i)`.
    async fn wait_for_customer_response(
        &self,
        run: &mut Run<'_>,
        execution: &Execution<'_>,
        step_def: &Value,
        i: usize,
    ) -> Result<(), JobError> {
        let workflow_id = &execution.workflow.id;
        let step_id = id_text(step_def);
        let instance_id = run.ctx.key().to_owned();
        let paused_context = json!({
            "cfInstanceId": instance_id,
            "stepResults": run.step_results,
            "variables": execution.variables,
            "waitingStepId": step_def.get("id"),
        });
        step(
            run.ctx,
            &format!("pause-{workflow_id}-{i}"),
            StepRetry::default(),
            || async {
                self.update_execution(
                    run,
                    &execution.id,
                    ExecutionUpdate {
                        current_step_index: Some(i32::try_from(i + 1).unwrap_or(i32::MAX)),
                        current_step_id: Some(step_id.clone()),
                        context: Some(paused_context.clone()),
                        ..ExecutionUpdate::status("waiting_for_input")
                    },
                )
                .await
            },
        )
        .await?;

        let payload = loop {
            let woke = run
                .ctx
                .wait_for_signal(
                    &format!("wait-{workflow_id}-{i}"),
                    CUSTOMER_RESPONSE,
                    RESPONSE_TIMEOUT,
                )
                .await?;
            if !woke {
                return Err(failed(format!(
                    "waitForEvent timed out waiting for {CUSTOMER_RESPONSE}"
                )));
            }
            let taken: Option<Value> = step(
                run.ctx,
                &format!("resume-{workflow_id}-{i}"),
                StepRetry::default(),
                || async { self.take_response(run, execution, &step_id).await },
            )
            .await?;
            // A signal kept from before, with no answer behind it: wait again.
            if let Some(payload) = taken {
                break payload;
            }
        };
        let merged = merge_response(run.step_results.get(&step_id), &payload);
        run.step_results.insert(step_id, merged);

        let selected = payload.get("selectedValue");
        if step_def.get("type").and_then(Value::as_str) == Some("send_choices") && truthy(selected)
        {
            self.run_branch_children(run, execution, step_def, i, &as_text(selected))
                .await?;
        }
        Ok(())
    }

    /// The `resume` step: take the answer [`super::engine`] left on the
    /// execution, record it in the step results and flip the execution back
    /// to running (the context written drops the answer). `None` when there
    /// is no answer yet.
    async fn take_response(
        &self,
        run: &Run<'_>,
        execution: &Execution<'_>,
        step_id: &str,
    ) -> Result<Option<Value>, JobError> {
        let db = self.db(&run.params.workspace_id).await?;
        let pending: Option<Option<Value>> = sqlx::query_scalar(
            "select execution_context -> 'pendingResponse' from helpdesk_workflow_executions where id = $1",
        )
        .bind(&execution.id)
        .fetch_optional(&db)
        .await
        .map_err(failed)?;
        let Some(payload) = pending.flatten().filter(|p| !p.is_null()) else {
            return Ok(None);
        };
        let mut step_results = run.step_results.clone();
        step_results.insert(
            step_id.to_owned(),
            merge_response(run.step_results.get(step_id), &payload),
        );
        self.update_execution(
            run,
            &execution.id,
            ExecutionUpdate {
                context: Some(
                    json!({ "stepResults": step_results, "variables": execution.variables }),
                ),
                ..ExecutionUpdate::status("running")
            },
        )
        .await?;
        Ok(Some(payload))
    }

    /// `runBranchChildren(ec, wfStep, i, selectedValue)`.
    async fn run_branch_children(
        &self,
        run: &mut Run<'_>,
        execution: &Execution<'_>,
        step_def: &Value,
        i: usize,
        selected: &str,
    ) -> Result<(), JobError> {
        let branch_id = format!("{}_branch_{selected}", id_text(step_def));
        let mut children: Vec<Value> = execution
            .workflow
            .steps
            .iter()
            .filter(|s| s.get("parentBranchId").and_then(Value::as_str) == Some(branch_id.as_str()))
            .cloned()
            .collect();
        children.sort_by(by_sort_order);
        let trigger_data = run.params.trigger_data.clone();
        for (j, child) in children.iter().enumerate() {
            let child_id = id_text(child);
            let outcome = self
                .handler_step(
                    run,
                    execution,
                    &format!("branch-{}-{i}-{j}-{child_id}", execution.workflow.id),
                    child,
                    &trigger_data,
                )
                .await?;
            run.step_results.insert(child_id, outcome.result.clone());
            self.publish_refetch(&run.params.conversation_id, outcome.has_new_message)
                .await;
        }
        Ok(())
    }

    /// `runAiLoop(ec, wfStep, i)`: answer customer messages until the AI
    /// escalates. (The AI steps escalate at once while AI is unavailable, so
    /// no run reaches this today.)
    async fn run_ai_loop(
        &self,
        run: &mut Run<'_>,
        execution: &Execution<'_>,
        step_def: &Value,
        i: usize,
    ) -> Result<(), JobError> {
        let workflow_id = execution.workflow.id.clone();
        let step_id = id_text(step_def);
        let active_context = json!({
            "cfInstanceId": run.ctx.key(),
            "stepResults": run.step_results,
            "variables": execution.variables,
            "aiStepId": step_def.get("id"),
        });
        step(
            run.ctx,
            &format!("ai-active-{workflow_id}-{i}"),
            StepRetry::default(),
            || async {
                self.update_execution(
                    run,
                    &execution.id,
                    ExecutionUpdate {
                        current_step_id: Some(step_id.clone()),
                        context: Some(active_context.clone()),
                        ..ExecutionUpdate::status("ai_active")
                    },
                )
                .await
            },
        )
        .await?;

        let mut round = 0;
        loop {
            let woke = run
                .ctx
                .wait_for_signal(
                    &format!("ai-msg-{workflow_id}-{i}-{round}"),
                    CUSTOMER_MESSAGE,
                    MESSAGE_TIMEOUT,
                )
                .await?;
            if !woke {
                return Err(failed(format!(
                    "waitForEvent timed out waiting for {CUSTOMER_MESSAGE}"
                )));
            }
            let outcome: StepOutcome = step(
                run.ctx,
                &format!("ai-respond-{workflow_id}-{i}-{round}"),
                StepRetry::default(),
                || async {
                    let message = self.take_message(run, execution).await?;
                    let mut trigger_data = match &run.params.trigger_data {
                        Value::Object(map) => map.clone(),
                        _ => Map::new(),
                    };
                    let content =
                        super::shared::or(message.get("content"), message.get("messageContent"));
                    match content {
                        Some(content) => trigger_data.insert("content".to_owned(), content.clone()),
                        None => trigger_data.remove("content"),
                    };
                    match message.get("customerName") {
                        Some(name) => trigger_data.insert("customerName".to_owned(), name.clone()),
                        None => trigger_data.remove("customerName"),
                    };
                    self.exec_handler(run, execution, step_def, &Value::Object(trigger_data))
                        .await
                },
            )
            .await?;
            run.step_results
                .insert(format!("{step_id}_round_{round}"), outcome.result.clone());
            self.publish_refetch(&run.params.conversation_id, outcome.has_new_message)
                .await;
            round += 1;
            if truthy(outcome.result.get("escalated")) {
                break;
            }
        }

        let context = json!({ "stepResults": run.step_results, "variables": execution.variables });
        step(
            run.ctx,
            &format!("ai-escalated-{workflow_id}-{i}"),
            StepRetry::default(),
            || async {
                self.update_execution(
                    run,
                    &execution.id,
                    ExecutionUpdate {
                        context: Some(context.clone()),
                        ..ExecutionUpdate::status("running")
                    },
                )
                .await
            },
        )
        .await
    }

    /// The customer message [`super::engine`] left on the execution, taken off it.
    async fn take_message(
        &self,
        run: &Run<'_>,
        execution: &Execution<'_>,
    ) -> Result<Value, JobError> {
        let db = self.db(&run.params.workspace_id).await?;
        let message: Option<Option<Value>> = sqlx::query_scalar(
            "update helpdesk_workflow_executions t
               set execution_context = t.execution_context - 'pendingMessage'
             from helpdesk_workflow_executions old
             where t.id = $1 and old.id = t.id
             returning old.execution_context -> 'pendingMessage'",
        )
        .bind(&execution.id)
        .fetch_optional(&db)
        .await
        .map_err(failed)?;
        Ok(message.flatten().unwrap_or_else(|| json!({})))
    }
}

/// `{ ...stepResults[stepId], ...payload, responded: true }`.
fn merge_response(previous: Option<&Value>, payload: &Value) -> Value {
    let mut merged = match previous {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    if let Value::Object(payload) = payload {
        for (key, value) in payload {
            merged.insert(key.clone(), value.clone());
        }
    }
    merged.insert("responded".to_owned(), json!(true));
    Value::Object(merged)
}

/// The columns `updateExecution` sets; `None` leaves a column alone.
struct ExecutionUpdate {
    status: &'static str,
    current_step_index: Option<i32>,
    current_step_id: Option<String>,
    context: Option<Value>,
    error: Option<Value>,
    completed: bool,
}

impl ExecutionUpdate {
    fn status(status: &'static str) -> Self {
        Self {
            status,
            current_step_index: None,
            current_step_id: None,
            context: None,
            error: None,
            completed: false,
        }
    }
}

impl Job for ConversationWorkflowJob {
    fn name(&self) -> &'static str {
        CONVERSATION_WORKFLOW_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params: ConversationWorkflowParams = serde_json::from_value(payload)?;
            self.execute(ctx, &params).await.map(|_| ())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_sort_by_order_stably() {
        let mut steps = [
            json!({ "id": "c", "order": 2 }),
            json!({ "id": "a" }),
            json!({ "id": "b", "order": "1" }),
            json!({ "id": "d", "order": 0 }),
        ];
        steps.sort_by(by_sort_order);
        let ids: Vec<&str> = steps
            .iter()
            .map(|s| s["id"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(ids, ["a", "d", "b", "c"]);
    }

    #[test]
    fn answers_merge_over_the_waiting_result() {
        let merged = merge_response(
            Some(&json!({ "messageId": "m", "conversationId": "c" })),
            &json!({ "stepId": "ask", "selectedValue": "a" }),
        );
        assert_eq!(
            merged,
            json!({ "messageId": "m", "conversationId": "c", "stepId": "ask", "selectedValue": "a", "responded": true })
        );
    }
}
