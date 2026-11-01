//! WeldConnect's execution engine: `ExecuteWorkflowWorkflow`
//! (`apps/workers/workflow-worker/src/index.ts` and `engine/`) as the
//! [`EXECUTE_WORKFLOW_JOB`] job.
//!
//! A run loads its workflow and variables, claims (or creates) its
//! execution row, builds the trigger data, runs the steps (conditions,
//! branches, loops, retries, delays), parks on a step that waits for input
//! until an approval resumes it, then finalizes the row, the workflow's
//! stats, any `workflow_complete` chains and the owner's notification.
//! Step names are the Workflow's, so a replay on Restate returns what each
//! step returned:
//!
//! - `step.do(name, …)` → [`step`]; an action runs once per attempt
//!   (`step-<i>-<id>-attempt-<n>`) and the engine retries it itself;
//! - `step.sleep` → [`JobContext::sleep`] (retry back-off, `delay` steps);
//! - `step.waitForEvent('resume-step')` → [`JobContext::wait_for_signal`].
//!   A signal carries no payload: the approval route writes its decision on
//!   the waiting step's row first, and the run reads it from there.
//!
//! Jobs can't be killed from outside, so cancelling a run marks its row
//! `cancelled` and signals it; the run checks its row before each step and
//! after a wait, and stops.
//!
//! Not on the Kubernetes editions: the `workflow_runs` usage meter (as
//! Global without `USAGE_METER`).

mod actions;
mod hooks;
mod steps;
pub(crate) mod template;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEventPublisher, iso_timestamp};
use weldsuite_ports::{
    BoxFuture, DynRealtimePublisher, Job, JobContext, JobError, OutboundHttp, RealtimeMessage,
    StepRetry, step,
};

use crate::TenantDatabases;
use crate::runs::{EXECUTE_WORKFLOW_JOB, RESUME_SIGNAL, WorkflowRuns};
use hooks::{Hooks, execution_event};
use steps::{RunInfo, RunResult, Runner};

/// `WAIT_FOR_INPUT_TIMEOUT`: seven days.
const WAIT_FOR_INPUT: Duration = Duration::from_hours(7 * 24);
/// Wakes of a parked wait that find no decision (a cancel, a stray signal)
/// before the wait gives up.
const MAX_WAKES: usize = 20;
/// `MAX_CHAIN_DEPTH`.
const MAX_CHAIN_DEPTH: i64 = 10;

/// `ExecuteWorkflowParams`: what `EXECUTE_WORKFLOW.create({ params })` sends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteWorkflowParams {
    pub workspace_id: String,
    #[serde(default)]
    pub user_id: String,
    pub workflow_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_depth: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_test: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
}

/// What the engine reaches outside its payload.
#[derive(Clone)]
pub struct EngineDeps {
    /// A workspace's tenant database, by `workspaces.id` or Clerk org id.
    pub tenants: TenantDatabases,
    /// `env.REALTIME`; without it nothing is published.
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// Third-party HTTP (`http_request`, `webhook`, the providers).
    pub http: Option<OutboundHttp>,
    /// `env.EXECUTE_WORKFLOW`, for `workflow_complete` chains.
    pub runs: Option<Arc<dyn WorkflowRuns>>,
    /// The worker's env values the actions read.
    pub env: Arc<HashMap<String, String>>,
    /// The entity events the WeldSuite record actions publish (connect-api's
    /// `ENTITY_EVENTS`, which runs them on Global).
    pub events: EntityEventPublisher,
    /// The master database: the calendar re-plan's due index (`create_task`).
    pub master: Option<PgPool>,
}

impl std::fmt::Debug for EngineDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineDeps")
            .field("realtime", &self.realtime.is_some())
            .field("http", &self.http.is_some())
            .field("runs", &self.runs.is_some())
            .finish_non_exhaustive()
    }
}

/// The `ExecuteWorkflowWorkflow` Workflow.
#[derive(Clone)]
pub struct ExecuteWorkflowJob {
    pub deps: EngineDeps,
}

impl Job for ExecuteWorkflowJob {
    fn name(&self) -> &'static str {
        EXECUTE_WORKFLOW_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params: ExecuteWorkflowParams = serde_json::from_value(payload)?;
            run_workflow(&self.deps, ctx, &params).await.map(|_| ())
        })
    }
}

// ── Small helpers ───────────────────────────────────────────────────────────

/// workflow-worker's `generateId(prefix)`: 24 alphanumerics.
pub(crate) fn engine_id(prefix: &str) -> String {
    format!(
        "{prefix}_{}",
        weldsuite_kit::random_string(
            24,
            "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        )
    )
}

pub(crate) fn now_ms() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or_default()
}

/// `new Date()` as Drizzle writes it.
pub(crate) fn now_text() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

fn failed(error: impl std::fmt::Display) -> JobError {
    JobError::failed(error)
}

// ── The run ─────────────────────────────────────────────────────────────────

/// What `load-workflow` answers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Loaded {
    skipped: bool,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: i64,
    #[serde(default)]
    created_by: Option<String>,
    #[serde(default)]
    steps: Vec<Value>,
    #[serde(default)]
    variables: Map<String, Value>,
    #[serde(default)]
    max_credits_per_run: Option<i64>,
}

async fn load_workflow(db: &PgPool, params: &ExecuteWorkflowParams) -> Result<Loaded, JobError> {
    let skipped = |reason: String| Loaded {
        skipped: true,
        reason: Some(reason),
        name: String::new(),
        version: 0,
        created_by: None,
        steps: Vec::new(),
        variables: Map::new(),
        max_credits_per_run: None,
    };
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(w) from workflows w where w.id = $1 and w.deleted_at is null limit 1",
    )
    .bind(&params.workflow_id)
    .fetch_optional(db)
    .await
    .map_err(failed)?;
    let Some(workflow) = row.map(weldsuite_db::js_row) else {
        return Ok(skipped(format!(
            "Workflow {} not found",
            params.workflow_id
        )));
    };
    if workflow["status"] != "active" && params.is_test != Some(true) {
        return Ok(skipped("Workflow not active".into()));
    }
    let records: Vec<(String, Option<Value>)> = sqlx::query_as(
        "select name, value from workflow_variables
         where (workflow_id = $1 or workflow_id is null) and deleted_at is null",
    )
    .bind(&params.workflow_id)
    .fetch_all(db)
    .await
    .map_err(failed)?;
    let mut variables = Map::new();
    for (name, value) in records {
        variables.insert(name, value.unwrap_or(Value::Null));
    }
    let cap = workflow["settings"]["maxCreditsPerRun"]
        .as_f64()
        .filter(|cap| cap.fract() == 0.0 && *cap >= 1.0 && *cap <= 9_007_199_254_740_991.0);
    #[allow(clippy::cast_possible_truncation)]
    Ok(Loaded {
        skipped: false,
        reason: None,
        name: crate::js::js_string(workflow.get("name")),
        version: workflow["version"].as_i64().unwrap_or_default(),
        created_by: workflow["createdBy"].as_str().map(str::to_owned),
        steps: workflow["steps"].as_array().cloned().unwrap_or_default(),
        variables,
        max_credits_per_run: cap.map(|cap| cap as i64),
    })
}

/// `cancelQueuedExecutionRow(db, id, reason)`.
async fn cancel_queued_row(db: &PgPool, id: &str, reason: &str) -> Result<(), JobError> {
    let now = now_text();
    sqlx::query(
        "update workflow_executions
         set status = 'cancelled', completed_at = $2::timestamp, error = $3, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(&now)
    .bind(json!({ "message": format!("Not run: {reason}") }))
    .execute(db)
    .await
    .map_err(failed)?;
    Ok(())
}

/// `startExecutionRow(db, input)`: the row, claimed while it is still
/// startable; `false` when it was cancelled (or finished) first.
async fn start_execution_row(
    db: &PgPool,
    params: &ExecuteWorkflowParams,
    loaded: &Loaded,
    id: &str,
    instance_id: &str,
) -> Result<bool, JobError> {
    let now = now_text();
    let is_test = params.is_test == Some(true);
    let trigger_type = params
        .trigger_type
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "manual".into());
    let started: Option<String> = sqlx::query_scalar(
        "insert into workflow_executions as t
            (id, workflow_id, workflow_version, workflow_name, status, triggered_by, trigger_type,
             trigger_id, trigger_data, started_at, total_steps, current_step_index,
             cf_workflow_instance_id, execution_context, created_at, updated_at)
         values ($1, $2, $3, $4, 'running', $5, $6, $7, $8, $9::timestamp, $10, 0, $11,
                 case when $12 then '{\"isTest\": true}'::jsonb end, $9::timestamp, $9::timestamp)
         on conflict (id) do update set
             status = 'running', started_at = excluded.started_at, total_steps = excluded.total_steps,
             current_step_index = 0, workflow_version = excluded.workflow_version,
             workflow_name = excluded.workflow_name,
             cf_workflow_instance_id = excluded.cf_workflow_instance_id,
             updated_at = excluded.updated_at,
             execution_context = case when $12
                 then coalesce(t.execution_context, '{}'::jsonb) || '{\"isTest\": true}'::jsonb
                 else t.execution_context end
         where t.status in ('queued', 'pending', 'running')
         returning t.id",
    )
    .bind(id)
    .bind(&params.workflow_id)
    .bind(i32::try_from(loaded.version).unwrap_or_default())
    .bind(&loaded.name)
    .bind(&params.user_id)
    .bind(&trigger_type)
    .bind(&params.trigger_id)
    .bind(&params.trigger_data)
    .bind(&now)
    .bind(i32::try_from(loaded.steps.len()).unwrap_or(i32::MAX))
    .bind(instance_id)
    .bind(is_test)
    .fetch_optional(db)
    .await
    .map_err(failed)?;
    Ok(started.is_some())
}

/// How a run ended, for the caller (tests).
#[derive(Debug, Clone, PartialEq)]
pub enum RunEnd {
    Skipped(String),
    Cancelled,
    Finished {
        succeeded: bool,
        execution_id: String,
    },
}

/// One run of `params` (`ExecuteWorkflowWorkflow.run`).
pub async fn run_workflow(
    deps: &EngineDeps,
    ctx: &dyn JobContext,
    params: &ExecuteWorkflowParams,
) -> Result<RunEnd, JobError> {
    let db = (deps.tenants)(params.workspace_id.clone())
        .await
        .map_err(failed)?;
    let rt = deps.realtime.as_ref();

    let loaded: Loaded = step(ctx, "load-workflow", StepRetry::default(), || {
        load_workflow(&db, params)
    })
    .await?;
    if loaded.skipped {
        let reason = loaded.reason.clone().unwrap_or_default();
        if let Some(execution_id) = &params.execution_id {
            step(
                ctx,
                "cancel-skipped-execution",
                StepRetry::default(),
                || cancel_queued_row(&db, execution_id, &reason),
            )
            .await?;
        }
        return Ok(RunEnd::Skipped(reason));
    }

    let instance_id = ctx.key().to_owned();
    let execution_id: Option<String> =
        step(ctx, "create-execution", StepRetry::default(), || async {
            let id = params
                .execution_id
                .clone()
                .unwrap_or_else(|| engine_id("wex"));
            if !start_execution_row(&db, params, &loaded, &id, &instance_id).await? {
                return Ok(None);
            }
            execution_event(
                rt,
                &params.workspace_id,
                &id,
                "started",
                json!({
                    "executionId": id,
                    "workflowId": params.workflow_id,
                    "workflowName": loaded.name,
                    "totalSteps": loaded.steps.len(),
                }),
            )
            .await;
            Ok(Some(id))
        })
        .await?;
    let Some(execution_id) = execution_id else {
        return Ok(RunEnd::Skipped(
            "Execution was cancelled before it started".into(),
        ));
    };

    let started_at: i64 = step(ctx, "run-started-at", StepRetry::ONCE, || async {
        Ok(now_ms())
    })
    .await?;
    let trigger_type = params
        .trigger_type
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "manual".into());
    let trigger_data = template::build_trigger_data(
        &trigger_type,
        params.trigger_data.as_ref(),
        &template::TriggerMeta {
            user_id: &params.user_id,
            workspace_id: &params.workspace_id,
            workflow_id: &params.workflow_id,
            workflow_name: &loaded.name,
            execution_id: &execution_id,
            started_at,
        },
    );

    let hooks = Hooks::new(
        db.clone(),
        deps.realtime.clone(),
        &params.workspace_id,
        &execution_id,
        loaded.steps.len(),
        &params.workflow_id,
    );
    let info = RunInfo {
        workspace_id: params.workspace_id.clone(),
        user_id: params.user_id.clone(),
        owner_user_id: loaded.created_by.clone(),
        execution_id: execution_id.clone(),
        chain_depth: params.chain_depth.unwrap_or(0),
        max_credits_per_run: loaded.max_credits_per_run,
    };
    let result = run_with_input_waits(
        ctx,
        deps,
        &db,
        &hooks,
        &info,
        &loaded.steps,
        &trigger_data,
        &loaded.variables,
    )
    .await?;
    if result.cancelled {
        return Ok(RunEnd::Cancelled);
    }

    let cancelled: bool = step(ctx, "finalize", StepRetry::default(), || {
        finalize(deps, &db, params, &loaded, &execution_id, &result)
    })
    .await?;
    if cancelled {
        return Ok(RunEnd::Cancelled);
    }
    let succeeded = result.status == "completed";
    let mut payload = json!({ "executionId": execution_id });
    if let Some((_, message)) = &result.error {
        payload["error"] = json!(message);
    }
    execution_event(
        rt,
        &params.workspace_id,
        &execution_id,
        if succeeded { "completed" } else { "failed" },
        payload,
    )
    .await;
    Ok(RunEnd::Finished {
        succeeded,
        execution_id,
    })
}

/// `markExecutionWaiting(db, id, waitingStepIndex)`.
async fn mark_waiting(db: &PgPool, id: &str, index: usize) -> Result<bool, JobError> {
    let updated: Option<String> = sqlx::query_scalar(
        "update workflow_executions set status = 'waiting_for_input', updated_at = $3::timestamp
         where id = $1 and status = 'running'
           and exists (select 1 from workflow_execution_steps
                       where execution_id = $1 and step_index = $2 and status = 'waiting_for_input')
         returning id",
    )
    .bind(id)
    .bind(i32::try_from(index + 1).unwrap_or(i32::MAX))
    .bind(now_text())
    .fetch_optional(db)
    .await
    .map_err(failed)?;
    Ok(updated.is_some())
}

/// `markExecutionResumed(db, id)`.
async fn mark_resumed(db: &PgPool, id: &str) -> Result<bool, JobError> {
    let updated: Option<String> = sqlx::query_scalar(
        "update workflow_executions set status = 'running', updated_at = $2::timestamp
         where id = $1 and status = 'waiting_for_input' returning id",
    )
    .bind(id)
    .bind(now_text())
    .fetch_optional(db)
    .await
    .map_err(failed)?;
    Ok(updated.is_some())
}

/// Whether the run's row says `cancelled`.
pub(crate) async fn is_cancelled(db: &PgPool, execution_id: &str) -> Result<bool, JobError> {
    let status: Option<String> =
        sqlx::query_scalar("select status from workflow_executions where id = $1")
            .bind(execution_id)
            .fetch_optional(db)
            .await
            .map_err(failed)?;
    Ok(status.as_deref() == Some("cancelled"))
}

/// `waitExpiredMessage(stepType)`.
fn wait_expired_message(step_type: Option<&str>) -> &'static str {
    if step_type == Some("manual_step") {
        "Approval expired: nobody approved or rejected this step within 7 days"
    } else {
        "No input arrived within 7 days"
    }
}

/// `manualStepDecision(payload)`.
pub(crate) fn manual_step_decision(payload: &Value) -> Value {
    let approved = payload["approved"] == json!(true) || payload["decision"] == "approved";
    let text = |key: &str| {
        payload[key]
            .as_str()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map_or(Value::Null, |t| json!(t))
    };
    json!({
        "approved": approved,
        "decision": if approved { "approved" } else { "rejected" },
        "comment": text("comment"),
        "decidedBy": text("decidedBy"),
        "decidedByName": text("decidedByName"),
        "decidedAt": text("decidedAt"),
    })
}

/// `runWithInputWaits(workflow, context, deps)`.
#[allow(clippy::too_many_arguments)]
async fn run_with_input_waits(
    ctx: &dyn JobContext,
    deps: &EngineDeps,
    db: &PgPool,
    hooks: &Hooks,
    info: &RunInfo,
    steps: &[Value],
    trigger_data: &Value,
    variables: &Map<String, Value>,
) -> Result<RunResult, JobError> {
    let mut runner = Runner::new(ctx, deps, db, hooks, info, steps, trigger_data, variables);
    let mut result = runner.execute(0, Map::new()).await?;
    while result.status == "waiting_for_input" && !result.cancelled {
        let Some((step_id, step_type)) = result.waiting.clone() else {
            break;
        };
        let Some(index) = steps.iter().position(|s| template::step_id(s) == step_id) else {
            break;
        };
        let name = format!("await-input-{index}");
        step(ctx, &name, StepRetry::default(), || {
            mark_waiting(db, &info.execution_id, index)
        })
        .await?;
        let mut payload = None;
        for wake in 0..MAX_WAKES {
            let wait = if wake == 0 {
                format!("wait-input-{index}")
            } else {
                format!("wait-input-{index}-{wake}")
            };
            if !ctx
                .wait_for_signal(&wait, RESUME_SIGNAL, WAIT_FOR_INPUT)
                .await?
            {
                break;
            }
            if is_cancelled(db, &info.execution_id).await? {
                result.cancelled = true;
                return Ok(result);
            }
            let decision: Option<Value> = match hooks.row_id(index) {
                Some(row_id) => sqlx::query_scalar(
                    "select output -> 'decision' from workflow_execution_steps where id = $1",
                )
                .bind(row_id)
                .fetch_optional(db)
                .await
                .map_err(failed)?
                .flatten(),
                None => None,
            };
            if let Some(decision) = decision.filter(|d| !d.is_null()) {
                payload = Some(decision);
                break;
            }
        }
        let Some(payload) = payload else {
            let message = wait_expired_message(step_type.as_deref());
            hooks
                .mark_wait_expired(&steps[index], index, message)
                .await
                .map_err(failed)?;
            result = RunResult::failed(result.output, &step_id, message);
            break;
        };
        let name = format!("resume-{index}");
        step(ctx, &name, StepRetry::default(), || {
            mark_resumed(db, &info.execution_id)
        })
        .await?;
        let step_output = if step_type.as_deref() == Some("manual_step") {
            manual_step_decision(&payload)
        } else {
            payload
        };
        hooks
            .mark_finished(index, Some(&step_output))
            .await
            .map_err(failed)?;
        let mut seed = result.output.clone();
        seed.insert(step_id.clone(), step_output);
        result = runner.execute(index + 1, seed).await?;
    }
    Ok(result)
}

// ── Finalize ────────────────────────────────────────────────────────────────

/// `Number(avg).toFixed(2)`, ties away from zero as `toFixed` picks the
/// larger candidate.
#[allow(clippy::float_cmp)] // a tie is exactly half a cent
fn to_fixed_2(value: f64) -> String {
    let scaled = value * 100.0;
    let rounded = if (scaled - scaled.trunc()).abs() == 0.5 {
        scaled.trunc() + scaled.signum()
    } else {
        scaled.round()
    };
    format!("{:.2}", rounded / 100.0)
}

/// `updateWorkflowStats(db, workflowId, success, source)`.
async fn update_stats(
    db: &PgPool,
    workflow_id: &str,
    success: bool,
    source: Option<&str>,
) -> Result<(), sqlx::Error> {
    let helpdesk = source == Some("helpdesk");
    let table = if helpdesk {
        "helpdesk_workflows"
    } else {
        "workflows"
    };
    let row: Option<(Option<i32>, Option<i32>, Option<i32>)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select execution_count, success_count, failure_count from {table} where id = $1 limit 1"
        )))
        .bind(workflow_id)
        .fetch_optional(db)
        .await?;
    let Some((executions, successes, failures)) = row else {
        return Ok(());
    };
    let average = if helpdesk {
        None
    } else {
        let avg: Option<f64> = sqlx::query_scalar(
            "select avg(duration)::float8 from (
                 select duration from workflow_executions
                 where workflow_id = $1 and duration is not null
                   and coalesce(execution_context ->> 'isTest', 'false') <> 'true'
                 order by started_at desc limit 500) recent_runs",
        )
        .bind(workflow_id)
        .fetch_one(db)
        .await?;
        avg.map(to_fixed_2)
    };
    // helpdesk_workflows keeps no average (its run binds $6 as null).
    let set_average = if helpdesk {
        ""
    } else {
        ", average_execution_time = coalesce($6::numeric, average_execution_time)"
    };
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "update {table} set execution_count = $2, success_count = $3, failure_count = $4,
             last_executed_at = $5::timestamp{set_average}
         where id = $1 and ($6::text is null or true)"
    )))
    .bind(workflow_id)
    .bind(executions.unwrap_or(0) + 1)
    .bind(if success {
        Some(successes.unwrap_or(0) + 1)
    } else {
        successes
    })
    .bind(if success {
        failures
    } else {
        Some(failures.unwrap_or(0) + 1)
    })
    .bind(now_text())
    .bind(average)
    .execute(db)
    .await?;
    Ok(())
}

/// `triggerSetting(trigger, key)`: the flat key, else the config's.
fn trigger_setting<'a>(trigger: &'a Value, key: &str) -> Option<&'a Value> {
    match trigger.get(key) {
        Some(flat) if !flat.is_null() && flat != "" => Some(flat),
        _ => trigger.get("config").filter(|c| c.is_object())?.get(key),
    }
}

/// `matchWorkflowCompleteTriggers(candidates, completedWorkflowId, succeeded)`.
fn match_complete_triggers(
    candidates: &[(String, Value, &'static str)],
    completed: &str,
    succeeded: bool,
) -> Vec<(String, &'static str, bool)> {
    let status = if succeeded { "success" } else { "failure" };
    let mut out = Vec::new();
    for (id, triggers, source) in candidates {
        if id == completed {
            continue;
        }
        let matching: Vec<&Value> = triggers
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter(|t| {
                if t["type"] != "workflow_complete" || t["isEnabled"] == json!(false) {
                    return false;
                }
                if trigger_setting(t, "sourceWorkflowId").and_then(Value::as_str) != Some(completed)
                {
                    return false;
                }
                let outcome = trigger_setting(t, "triggerOn")
                    .and_then(Value::as_str)
                    .filter(|o| ["success", "failure", "both"].contains(o))
                    .unwrap_or("success");
                outcome == "both" || outcome == status
            })
            .collect();
        if matching.is_empty() {
            continue;
        }
        let pass_output = matching
            .iter()
            .any(|t| trigger_setting(t, "passOutput") == Some(&json!(true)));
        out.push((id.clone(), *source, pass_output));
    }
    out
}

/// `fireWorkflowCompleteTriggers(env, db, run)`.
async fn fire_complete_triggers(
    deps: &EngineDeps,
    db: &PgPool,
    params: &ExecuteWorkflowParams,
    workflow_name: &str,
    execution_id: &str,
    succeeded: bool,
    output: &Map<String, Value>,
) {
    let chain_depth = params.chain_depth.unwrap_or(0);
    if chain_depth >= MAX_CHAIN_DEPTH {
        tracing::warn!("Workflow chain depth limit reached ({MAX_CHAIN_DEPTH}), skipping");
        return;
    }
    let load = async {
        let connect: Vec<(String, Option<Value>)> = sqlx::query_as(
            "select id, triggers from workflows where status = 'active' and deleted_at is null",
        )
        .fetch_all(db)
        .await?;
        let helpdesk: Vec<(String, Option<Value>)> = sqlx::query_as(
            "select id, triggers from helpdesk_workflows where status = 'active' and deleted_at is null",
        )
        .fetch_all(db)
        .await?;
        Ok::<_, sqlx::Error>((connect, helpdesk))
    };
    let (connect, helpdesk) = match load.await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "Failed to load workflow_complete triggers");
            return;
        }
    };
    let candidates: Vec<(String, Value, &'static str)> = connect
        .into_iter()
        .map(|(id, t)| (id, t.unwrap_or(Value::Null), "weldconnect"))
        .chain(
            helpdesk
                .into_iter()
                .map(|(id, t)| (id, t.unwrap_or(Value::Null), "helpdesk")),
        )
        .collect();
    let dispatches = match_complete_triggers(&candidates, &params.workflow_id, succeeded);
    let Some(runs) = &deps.runs else { return };
    for (workflow_id, source, pass_output) in dispatches {
        let mut trigger_data = Map::new();
        trigger_data.insert("sourceWorkflowId".into(), json!(params.workflow_id));
        if !workflow_name.is_empty() {
            trigger_data.insert("sourceWorkflowName".into(), json!(workflow_name));
        }
        trigger_data.insert("sourceExecutionId".into(), json!(execution_id));
        trigger_data.insert(
            "status".into(),
            json!(if succeeded { "success" } else { "failure" }),
        );
        if pass_output {
            trigger_data.insert("output".into(), Value::Object(output.clone()));
        }
        let id: String = format!("{execution_id}-then-{workflow_id}")
            .chars()
            .take(100)
            .collect();
        let chained = json!({
            "workspaceId": params.workspace_id,
            "userId": params.user_id,
            "workflowId": workflow_id,
            "triggerType": "workflow_complete",
            "source": source,
            "triggerData": trigger_data,
            "chainDepth": chain_depth + 1,
        });
        if let Err(error) = runs.start(Some(&id), &chained).await {
            tracing::warn!(%error, "Could not start chained workflow {workflow_id}");
        }
    }
}

/// `notifyRunFinished(input)`: best effort.
async fn notify_run_finished(
    deps: &EngineDeps,
    db: &PgPool,
    params: &ExecuteWorkflowParams,
    execution_id: &str,
    workflow_name: &str,
    succeeded: bool,
    error_message: Option<&str>,
) {
    let owner: Option<(Option<String>, Option<Value>)> =
        match sqlx::query_as("select created_by, settings from workflows where id = $1 limit 1")
            .bind(&params.workflow_id)
            .fetch_optional(db)
            .await
        {
            Ok(owner) => owner,
            Err(error) => {
                tracing::error!(%error, "[RunNotifications] failed");
                return;
            }
        };
    let (created_by, settings) = owner.unwrap_or((None, None));
    let settings = settings.unwrap_or(Value::Null);
    let wants = if succeeded {
        settings["notifyOnComplete"] == json!(true)
    } else {
        settings["notifyOnError"] != json!(false)
    };
    if !wants {
        return;
    }
    let recipient = created_by
        .as_deref()
        .map(str::trim)
        .filter(|o| !o.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            let trigger = params.user_id.trim();
            (!trigger.is_empty() && trigger != "system").then(|| trigger.to_owned())
        });
    let Some(user_id) = recipient else { return };
    let truncate = |text: &str, max: usize| {
        if text.chars().count() > max {
            format!("{}…", text.chars().take(max - 1).collect::<String>())
        } else {
            text.to_owned()
        }
    };
    let id = engine_id("notif");
    let now = now_text();
    let name = truncate(
        if workflow_name.is_empty() {
            "Workflow"
        } else {
            workflow_name
        },
        150,
    );
    let title = if succeeded {
        format!("Workflow completed: {name}")
    } else {
        format!("Workflow failed: {name}")
    };
    let body = if succeeded {
        "The run finished successfully.".to_owned()
    } else {
        truncate(
            error_message
                .filter(|m| !m.is_empty())
                .unwrap_or("The run failed."),
            500,
        )
    };
    let action_url = format!("/weldconnect/executions/{execution_id}");
    let notification_type = if succeeded {
        "workflow_completed"
    } else {
        "workflow_failed"
    };
    let severity = if succeeded { "success" } else { "error" };
    let inserted = sqlx::query(
        "insert into notifications
            (id, user_id, title, body, category, notification_type, entity_type, entity_id, action_url,
             actor_type, icon, severity, is_read, delivered_in_app, delivered_email, delivered_push,
             created_at)
         values ($1, $2, $3, $4, 'system', $5, 'workflow_execution', $6, $7, 'system', 'workflow', $8,
                 false, true, false, false, $9::timestamp)",
    )
    .bind(&id)
    .bind(&user_id)
    .bind(&title)
    .bind(&body)
    .bind(notification_type)
    .bind(execution_id)
    .bind(&action_url)
    .bind(severity)
    .bind(&now)
    .execute(db)
    .await;
    if let Err(error) = inserted {
        tracing::error!(%error, "[RunNotifications] failed");
        return;
    }
    if let Some(realtime) = &deps.realtime {
        let message = RealtimeMessage::personal(
            &params.workspace_id,
            &format!("notification.{user_id}"),
            "created",
            json!({
                "id": id, "title": title, "body": body, "category": "system",
                "notificationType": notification_type, "actionUrl": action_url,
                "entityType": "workflow_execution", "entityId": execution_id,
                "createdAt": now, "isRead": false, "severity": severity,
                "actorType": "system", "actorId": null,
            }),
            &user_id,
        );
        if let Err(error) = realtime.publish_boxed(&message).await {
            tracing::warn!(%error, "[RunNotifications] live publish failed");
        }
    }
}

/// The `finalize` step: `true` when the run was cancelled meanwhile.
async fn finalize(
    deps: &EngineDeps,
    db: &PgPool,
    params: &ExecuteWorkflowParams,
    loaded: &Loaded,
    execution_id: &str,
    result: &RunResult,
) -> Result<bool, JobError> {
    let succeeded = result.status == "completed";
    let row: Option<(String, Option<f64>, Option<Value>)> = sqlx::query_as(
        "select status, extract(epoch from started_at)::float8 * 1000, execution_context
         from workflow_executions where id = $1 limit 1",
    )
    .bind(execution_id)
    .fetch_optional(db)
    .await
    .map_err(failed)?;
    if row
        .as_ref()
        .is_some_and(|(status, _, _)| status == "cancelled")
    {
        return Ok(true);
    }
    let completed_at = now_ms();
    #[allow(clippy::cast_possible_truncation)]
    let duration = row
        .as_ref()
        .and_then(|(_, started, _)| *started)
        .map(|started| (completed_at - started.round() as i64).max(0));
    let is_test = params.is_test == Some(true)
        || row
            .as_ref()
            .and_then(|(_, _, context)| context.as_ref())
            .is_some_and(|c| c["isTest"] == json!(true));
    let error = result
        .error
        .as_ref()
        .map(|(step_id, message)| json!({ "message": message, "stepId": step_id }));
    let now = crate::cron::iso(completed_at).unwrap_or_else(now_text);
    sqlx::query(
        "update workflow_executions
         set status = $2, completed_at = $3::timestamp, duration = $4,
             current_step_index = case when $5 then $6 else current_step_index end,
             output = $7, error = $8, updated_at = $3::timestamp
         where id = $1 and status <> 'cancelled'",
    )
    .bind(execution_id)
    .bind(if succeeded { "completed" } else { "failed" })
    .bind(&now)
    .bind(duration.map(|d| i32::try_from(d).unwrap_or(i32::MAX)))
    .bind(succeeded)
    .bind(i32::try_from(loaded.steps.len()).unwrap_or(i32::MAX))
    .bind(Value::Object(result.output.clone()))
    .bind(error)
    .execute(db)
    .await
    .map_err(failed)?;
    if !is_test {
        update_stats(db, &params.workflow_id, succeeded, params.source.as_deref())
            .await
            .map_err(failed)?;
        fire_complete_triggers(
            deps,
            db,
            params,
            &loaded.name,
            execution_id,
            succeeded,
            &result.output,
        )
        .await;
        if params.source.as_deref() != Some("helpdesk") {
            notify_run_finished(
                deps,
                db,
                params,
                execution_id,
                &loaded.name,
                succeeded,
                result.error.as_ref().map(|(_, m)| m.as_str()),
            )
            .await;
        }
    }
    Ok(false)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_ties_up() {
        assert_eq!(to_fixed_2(12.125), "12.13");
        assert_eq!(to_fixed_2(1.005), "1.00");
        assert_eq!(to_fixed_2(10.0), "10.00");
        assert_eq!(to_fixed_2(2.0 / 3.0), "0.67");
    }

    #[test]
    fn workflow_complete_triggers_match_outcome_and_source() {
        let candidates = vec![
            (
                "wf_b".to_owned(),
                json!([{ "type": "workflow_complete", "config": { "sourceWorkflowId": "wf_a", "triggerOn": "both", "passOutput": true } }]),
                "weldconnect",
            ),
            (
                "wf_c".to_owned(),
                json!([{ "type": "workflow_complete", "sourceWorkflowId": "wf_a" }]),
                "weldconnect",
            ),
            (
                "wf_a".to_owned(),
                json!([{ "type": "workflow_complete", "sourceWorkflowId": "wf_a" }]),
                "weldconnect",
            ),
        ];
        assert_eq!(
            match_complete_triggers(&candidates, "wf_a", false),
            vec![("wf_b".to_owned(), "weldconnect", true)]
        );
        assert_eq!(match_complete_triggers(&candidates, "wf_a", true).len(), 2);
    }

    #[test]
    fn decisions_read_the_approval_payload() {
        let decision = manual_step_decision(
            &json!({ "decision": "approved", "comment": "  ok ", "decidedBy": "u1" }),
        );
        assert_eq!(decision["approved"], json!(true));
        assert_eq!(decision["comment"], json!("ok"));
        assert_eq!(decision["decidedByName"], Value::Null);
    }
}
