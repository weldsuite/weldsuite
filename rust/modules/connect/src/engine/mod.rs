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

pub use actions::merge::MergeWorkflowActions;
pub(crate) mod template;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sea_orm::sea_query::extension::postgres as pg;
use sea_orm::sea_query::{Alias, Expr, Func, OnConflict, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, QueryTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_events::{EntityEventPublisher, iso_timestamp};
use weldsuite_ports::{
    BoxFuture, DynRealtimePublisher, Job, JobContext, JobError, OutboundHttp, RealtimeMessage,
    StepRetry, step,
};
use weldsuite_schema::tenant::{
    helpdesk_workflows, notifications, workflow_execution_steps as step_rows,
    workflow_executions as runs_table, workflow_variables, workflows,
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
    /// The push (Expo) of the notifications the WeldSuite actions send (chat
    /// mentions, task assignments, the inbox's team notices); `None`
    /// notifies in-app only. Conformance builds have none.
    pub push_http: Option<OutboundHttp>,
    /// `env.EXECUTE_WORKFLOW`, for `workflow_complete` chains.
    pub runs: Option<Arc<dyn WorkflowRuns>>,
    /// The worker's env values the actions read.
    pub env: Arc<HashMap<String, String>>,
    /// The entity events the WeldSuite record actions publish (connect-api's
    /// `ENTITY_EVENTS`, which runs them on Global).
    pub events: EntityEventPublisher,
    /// The master database: the calendar re-plan's due index (`create_task`)
    /// and `send_email`'s sender-ownership check.
    pub master: Option<PgPool>,
    /// Customer mail and the outbound guard's ledgers (`send_email`).
    pub outbound: weldsuite_mail_domain::outbound::OutboundBindings,
    /// WeldDesk's `AssignmentRouter` (`env.HELPDESK_WORKFLOW`), which hands
    /// out inbox conversations a workflow opens or assigns; without it the
    /// pick is local.
    pub assignment: Option<Arc<weldsuite_desk_domain::assignment_router::AssignmentRouter>>,
    /// `env.MERGE_INTERNAL`: WeldMerge's workflow-action intake, for the
    /// `merge.*` steps. None while WeldMerge is not served: those steps then
    /// fail, as the worker without the binding.
    pub merge: Option<Arc<dyn MergeWorkflowActions>>,
    /// The install's AI (`weldsuite-ai`), for the `ai_generate` /
    /// `ai_classify` steps; without it they fail as the worker without its
    /// gateway.
    pub ai: Option<weldsuite_ai::Ai>,
}

impl std::fmt::Debug for EngineDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineDeps")
            .field("realtime", &self.realtime.is_some())
            .field("http", &self.http.is_some())
            .field("push_http", &self.push_http.is_some())
            .field("runs", &self.runs.is_some())
            .field("ai", &self.ai.is_some())
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

/// `extract(epoch from <timestamp>)::float8 * 1000`: the seconds Postgres
/// reads to the microsecond, as a double, in milliseconds.
#[allow(clippy::cast_precision_loss)]
pub(crate) fn epoch_ms(at: PrimitiveDateTime) -> f64 {
    let micros = at.assume_utc().unix_timestamp_nanos() / 1_000;
    micros as f64 / 1_000_000.0 * 1000.0
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
    let db = orm(db);
    let row = workflows::Entity::find_by_id(params.workflow_id.as_str())
        .filter(workflows::Column::DeletedAt.is_null())
        .one(&db)
        .await
        .map_err(failed)?;
    let Some(workflow) = row else {
        return Ok(skipped(format!(
            "Workflow {} not found",
            params.workflow_id
        )));
    };
    if workflow.status != "active" && params.is_test != Some(true) {
        return Ok(skipped("Workflow not active".into()));
    }
    let records: Vec<(String, Option<Value>)> = workflow_variables::Entity::find()
        .select_only()
        .columns([
            workflow_variables::Column::Name,
            workflow_variables::Column::Value,
        ])
        .filter(
            Condition::any()
                .add(workflow_variables::Column::WorkflowId.eq(&params.workflow_id))
                .add(workflow_variables::Column::WorkflowId.is_null()),
        )
        .filter(workflow_variables::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&db)
        .await
        .map_err(failed)?;
    let mut variables = Map::new();
    for (name, value) in records {
        variables.insert(name, value.unwrap_or(Value::Null));
    }
    let cap = workflow
        .settings
        .as_ref()
        .and_then(|settings| settings.get("maxCreditsPerRun"))
        .and_then(Value::as_f64)
        .filter(|cap| cap.fract() == 0.0 && *cap >= 1.0 && *cap <= 9_007_199_254_740_991.0);
    #[allow(clippy::cast_possible_truncation)]
    Ok(Loaded {
        skipped: false,
        reason: None,
        name: workflow.name,
        version: i64::from(workflow.version),
        created_by: workflow.created_by,
        steps: workflow
            .steps
            .as_ref()
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        variables,
        max_credits_per_run: cap.map(|cap| cap as i64),
    })
}

/// `cancelQueuedExecutionRow(db, id, reason)`.
async fn cancel_queued_row(db: &PgPool, id: &str, reason: &str) -> Result<(), JobError> {
    let now = utc_now();
    runs_table::Entity::update_many()
        .col_expr(runs_table::Column::Status, Expr::value("cancelled"))
        .col_expr(runs_table::Column::CompletedAt, Expr::value(now))
        .col_expr(
            runs_table::Column::Error,
            Expr::value(json!({ "message": format!("Not run: {reason}") })),
        )
        .col_expr(runs_table::Column::UpdatedAt, Expr::value(now))
        .filter(runs_table::Column::Id.eq(id))
        .exec(&orm(db))
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
    let now = utc_now();
    let is_test = params.is_test == Some(true);
    let trigger_type = params
        .trigger_type
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "manual".into());
    let test_context = || json!({ "isTest": true });
    // On a replay the row is there: it starts again while it is startable.
    let mut restart = OnConflict::column(runs_table::Column::Id);
    restart
        .update_columns([
            runs_table::Column::Status,
            runs_table::Column::StartedAt,
            runs_table::Column::TotalSteps,
            runs_table::Column::CurrentStepIndex,
            runs_table::Column::WorkflowVersion,
            runs_table::Column::WorkflowName,
            runs_table::Column::CfWorkflowInstanceId,
            runs_table::Column::UpdatedAt,
        ])
        .action_and_where(runs_table::Column::Status.is_in(["queued", "pending", "running"]));
    if is_test {
        restart.value(
            runs_table::Column::ExecutionContext,
            pg::PgExpr::concat(
                Func::coalesce([
                    Expr::col((runs_table::Entity, runs_table::Column::ExecutionContext)),
                    Expr::val(json!({})),
                ]),
                Expr::val(test_context()),
            ),
        );
    }
    let started = runs_table::Entity::insert(runs_table::ActiveModel {
        id: Set(id.to_owned()),
        workflow_id: Set(params.workflow_id.clone()),
        workflow_version: Set(i32::try_from(loaded.version).unwrap_or_default()),
        workflow_name: Set(Some(loaded.name.clone())),
        status: Set("running".to_owned()),
        triggered_by: Set(Some(params.user_id.clone())),
        trigger_type: Set(Some(trigger_type)),
        trigger_id: Set(params.trigger_id.clone()),
        trigger_data: Set(params.trigger_data.clone()),
        started_at: Set(Some(now)),
        total_steps: Set(Some(i32::try_from(loaded.steps.len()).unwrap_or(i32::MAX))),
        current_step_index: Set(Some(0)),
        cf_workflow_instance_id: Set(Some(instance_id.to_owned())),
        execution_context: Set(is_test.then(test_context)),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .on_conflict(restart)
    .exec_without_returning(&orm(db))
    .await
    .map_err(failed)?;
    Ok(started > 0)
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
    let updated = runs_table::Entity::update_many()
        .col_expr(runs_table::Column::Status, Expr::value("waiting_for_input"))
        .col_expr(runs_table::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(runs_table::Column::Id.eq(id))
        .filter(runs_table::Column::Status.eq("running"))
        .filter(Expr::exists(
            Query::select()
                .expr(Expr::val(1))
                .from(step_rows::Entity)
                .and_where(step_rows::Column::ExecutionId.eq(id))
                .and_where(
                    step_rows::Column::StepIndex.eq(i32::try_from(index + 1).unwrap_or(i32::MAX)),
                )
                .and_where(step_rows::Column::Status.eq("waiting_for_input"))
                .to_owned(),
        ))
        .exec(&orm(db))
        .await
        .map_err(failed)?;
    Ok(updated.rows_affected > 0)
}

/// `markExecutionResumed(db, id)`.
async fn mark_resumed(db: &PgPool, id: &str) -> Result<bool, JobError> {
    let updated = runs_table::Entity::update_many()
        .col_expr(runs_table::Column::Status, Expr::value("running"))
        .col_expr(runs_table::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(runs_table::Column::Id.eq(id))
        .filter(runs_table::Column::Status.eq("waiting_for_input"))
        .exec(&orm(db))
        .await
        .map_err(failed)?;
    Ok(updated.rows_affected > 0)
}

/// Whether the run's row says `cancelled`.
pub(crate) async fn is_cancelled(db: &PgPool, execution_id: &str) -> Result<bool, JobError> {
    let status: Option<String> = runs_table::Entity::find()
        .select_only()
        .column(runs_table::Column::Status)
        .filter(runs_table::Column::Id.eq(execution_id))
        .into_tuple()
        .one(&orm(db))
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
                Some(row_id) => step_rows::Entity::find()
                    .select_only()
                    .expr(pg::PgExpr::get_json_field(
                        Expr::col(step_rows::Column::Output),
                        "decision",
                    ))
                    .filter(step_rows::Column::Id.eq(row_id))
                    .into_tuple::<Option<Value>>()
                    .one(&orm(db))
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
) -> Result<(), DbErr> {
    let db = orm(db);
    let counts = |(executions, successes, failures): (Option<i32>, Option<i32>, Option<i32>)| {
        (
            executions.unwrap_or(0) + 1,
            if success {
                Some(successes.unwrap_or(0) + 1)
            } else {
                successes
            },
            if success {
                failures
            } else {
                Some(failures.unwrap_or(0) + 1)
            },
        )
    };
    if source == Some("helpdesk") {
        // helpdesk_workflows keeps no average.
        let row: Option<(Option<i32>, Option<i32>, Option<i32>)> =
            helpdesk_workflows::Entity::find()
                .select_only()
                .columns([
                    helpdesk_workflows::Column::ExecutionCount,
                    helpdesk_workflows::Column::SuccessCount,
                    helpdesk_workflows::Column::FailureCount,
                ])
                .filter(helpdesk_workflows::Column::Id.eq(workflow_id))
                .into_tuple()
                .one(&db)
                .await?;
        let Some(row) = row else {
            return Ok(());
        };
        let (executions, successes, failures) = counts(row);
        helpdesk_workflows::Entity::update_many()
            .col_expr(
                helpdesk_workflows::Column::ExecutionCount,
                Expr::value(executions),
            )
            .col_expr(
                helpdesk_workflows::Column::SuccessCount,
                Expr::value(successes),
            )
            .col_expr(
                helpdesk_workflows::Column::FailureCount,
                Expr::value(failures),
            )
            .col_expr(
                helpdesk_workflows::Column::LastExecutedAt,
                Expr::value(utc_now()),
            )
            .filter(helpdesk_workflows::Column::Id.eq(workflow_id))
            .exec(&db)
            .await?;
        return Ok(());
    }
    let row: Option<(Option<i32>, Option<i32>, Option<i32>)> = workflows::Entity::find()
        .select_only()
        .columns([
            workflows::Column::ExecutionCount,
            workflows::Column::SuccessCount,
            workflows::Column::FailureCount,
        ])
        .filter(workflows::Column::Id.eq(workflow_id))
        .into_tuple()
        .one(&db)
        .await?;
    let Some(row) = row else {
        return Ok(());
    };
    let average = recent_average_duration(&db, workflow_id)
        .await?
        .map(to_fixed_2);
    let (executions, successes, failures) = counts(row);
    let mut update = workflows::Entity::update_many()
        .col_expr(workflows::Column::ExecutionCount, Expr::value(executions))
        .col_expr(workflows::Column::SuccessCount, Expr::value(successes))
        .col_expr(workflows::Column::FailureCount, Expr::value(failures))
        .col_expr(workflows::Column::LastExecutedAt, Expr::value(utc_now()));
    // `coalesce($avg::numeric, average_execution_time)`.
    if let Some(average) = average {
        update = update.col_expr(
            workflows::Column::AverageExecutionTime,
            Func::cast_as(Expr::val(average), "numeric").into(),
        );
    }
    update
        .filter(workflows::Column::Id.eq(workflow_id))
        .exec(&db)
        .await?;
    Ok(())
}

/// The average duration of the workflow's last 500 timed runs, tests left
/// out: `avg(duration)::float8` over them.
async fn recent_average_duration(
    db: &sea_orm::DatabaseConnection,
    workflow_id: &str,
) -> Result<Option<f64>, DbErr> {
    let recent = runs_table::Entity::find()
        .select_only()
        .column(runs_table::Column::Duration)
        .filter(runs_table::Column::WorkflowId.eq(workflow_id))
        .filter(runs_table::Column::Duration.is_not_null())
        .filter(crate::executions::not_test_run())
        .order_by_desc(runs_table::Column::StartedAt)
        .limit(500)
        .into_query();
    let average = Query::select()
        .expr(Func::cast_as(
            Func::avg(Expr::col(Alias::new("duration"))),
            "float8",
        ))
        .from_subquery(recent, Alias::new("recent_runs"))
        .to_owned();
    match db.query_one(&average).await? {
        Some(row) => row.try_get_by_index(0),
        None => Ok(None),
    }
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
        let db = orm(db);
        let connect: Vec<(String, Option<Value>)> = workflows::Entity::find()
            .select_only()
            .columns([workflows::Column::Id, workflows::Column::Triggers])
            .filter(workflows::Column::Status.eq("active"))
            .filter(workflows::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&db)
            .await?;
        let helpdesk: Vec<(String, Option<Value>)> = helpdesk_workflows::Entity::find()
            .select_only()
            .columns([
                helpdesk_workflows::Column::Id,
                helpdesk_workflows::Column::Triggers,
            ])
            .filter(helpdesk_workflows::Column::Status.eq("active"))
            .filter(helpdesk_workflows::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&db)
            .await?;
        Ok::<_, DbErr>((connect, helpdesk))
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
    let db = orm(db);
    let owner: Option<(Option<String>, Option<Value>)> = match workflows::Entity::find()
        .select_only()
        .columns([workflows::Column::CreatedBy, workflows::Column::Settings])
        .filter(workflows::Column::Id.eq(&params.workflow_id))
        .into_tuple()
        .one(&db)
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
    let at = OffsetDateTime::now_utc();
    let now = iso_timestamp(at);
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
    let inserted = notifications::Entity::insert(notifications::ActiveModel {
        id: Set(id.clone()),
        user_id: Set(user_id.clone()),
        title: Set(title.clone()),
        body: Set(Some(body.clone())),
        category: Set("system".to_owned()),
        notification_type: Set(notification_type.to_owned()),
        entity_type: Set(Some("workflow_execution".to_owned())),
        entity_id: Set(Some(execution_id.to_owned())),
        action_url: Set(Some(action_url.clone())),
        actor_type: Set(Some("system".to_owned())),
        icon: Set(Some("workflow".to_owned())),
        severity: Set(severity.to_owned()),
        is_read: Set(false),
        delivered_in_app: Set(true),
        delivered_email: Set(false),
        delivered_push: Set(false),
        created_at: Set(utc_timestamp(at).assume_utc()),
        ..Default::default()
    })
    .exec_without_returning(&db)
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
    let row: Option<(String, Option<PrimitiveDateTime>, Option<Value>)> =
        runs_table::Entity::find()
            .select_only()
            .columns([
                runs_table::Column::Status,
                runs_table::Column::StartedAt,
                runs_table::Column::ExecutionContext,
            ])
            .filter(runs_table::Column::Id.eq(execution_id))
            .into_tuple()
            .one(&orm(db))
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
        .map(|started| (completed_at - epoch_ms(started).round() as i64).max(0));
    let is_test = params.is_test == Some(true)
        || row
            .as_ref()
            .and_then(|(_, _, context)| context.as_ref())
            .is_some_and(|c| c["isTest"] == json!(true));
    let error = result
        .error
        .as_ref()
        .map(|(step_id, message)| json!({ "message": message, "stepId": step_id }));
    let now = OffsetDateTime::from_unix_timestamp_nanos(i128::from(completed_at) * 1_000_000)
        .map_or_else(|_| utc_now(), utc_timestamp);
    let mut update = runs_table::Entity::update_many()
        .col_expr(
            runs_table::Column::Status,
            Expr::value(if succeeded { "completed" } else { "failed" }),
        )
        .col_expr(runs_table::Column::CompletedAt, Expr::value(now))
        .col_expr(
            runs_table::Column::Duration,
            Expr::value(duration.map(|d| i32::try_from(d).unwrap_or(i32::MAX))),
        );
    if succeeded {
        update = update.col_expr(
            runs_table::Column::CurrentStepIndex,
            Expr::value(i32::try_from(loaded.steps.len()).unwrap_or(i32::MAX)),
        );
    }
    update
        .col_expr(
            runs_table::Column::Output,
            Expr::value(Value::Object(result.output.clone())),
        )
        .col_expr(runs_table::Column::Error, Expr::value(error))
        .col_expr(runs_table::Column::UpdatedAt, Expr::value(now))
        .filter(runs_table::Column::Id.eq(execution_id))
        .filter(runs_table::Column::Status.ne("cancelled"))
        .exec(&orm(db))
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

/// The env values only the engine's steps read, beside the module's
/// [`crate::ENV_NAMES`]: `TELNYX_API_KEY` (`send_sms`) and
/// `PERMISSIONS_APP_ENFORCE` (the record steps' owner check).
pub const ENGINE_ENV_NAMES: &[&str] = &["TELNYX_API_KEY", "PERMISSIONS_APP_ENFORCE"];

/// [`crate::ENV_NAMES`] and [`ENGINE_ENV_NAMES`] from the process
/// environment, for [`EngineDeps::env`].
pub fn env_from_process() -> HashMap<String, String> {
    let mut env = crate::env_from_process();
    for name in ENGINE_ENV_NAMES {
        if let Ok(value) = std::env::var(name) {
            env.insert((*name).to_owned(), value);
        }
    }
    env
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
