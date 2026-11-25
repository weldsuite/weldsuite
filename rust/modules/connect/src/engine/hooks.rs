//! `buildExecutionHooks` (`engine/persistence.ts`): one
//! `workflow_execution_steps` row per step, its logs and outcome, the run's
//! progress, an error-log row per failure, and the realtime events the run
//! page follows. A replayed run finds its step rows and leaves them be.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_ports::{DynRealtimePublisher, RealtimeMessage};
use weldsuite_schema::tenant::{
    workflow_error_logs as error_logs, workflow_execution_steps as step_rows,
    workflow_executions as runs_table,
};

use super::{engine_id, epoch_ms, now_ms, now_text};
use crate::js::js_string;

/// A step's outcome (`StepOutcome`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Outcome {
    /// `completed`, `failed`, `skipped` or `waiting_for_input`.
    pub(crate) status: &'static str,
    pub(crate) result: Option<Value>,
    pub(crate) error: Option<String>,
    pub(crate) error_details: Option<Value>,
    pub(crate) error_type: Option<String>,
    pub(crate) continued: bool,
    pub(crate) attempts: u32,
}

impl Outcome {
    pub(crate) fn skipped() -> Self {
        Self {
            status: "skipped",
            ..Self::default()
        }
    }
}

fn status_event(status: &str) -> &'static str {
    match status {
        "completed" => "step_completed",
        "failed" => "step_failed",
        "skipped" => "step_skipped",
        _ => "waiting_for_input",
    }
}

fn log_line(level: &str, message: &str) -> Value {
    json!({ "timestamp": now_text(), "level": level, "message": message })
}

/// `outcomeLog(outcome, duration)`.
fn outcome_log(outcome: &Outcome, duration: Option<i64>) -> Value {
    let attempt_note = if outcome.attempts > 1 {
        format!(" (attempt {})", outcome.attempts)
    } else {
        String::new()
    };
    match outcome.status {
        "completed" => log_line(
            "info",
            &format!("Completed in {}ms{attempt_note}", duration.unwrap_or(0)),
        ),
        "skipped" => log_line("info", "Skipped: condition not met"),
        "waiting_for_input" => log_line("info", "Waiting for input"),
        _ => log_line(
            "error",
            &format!(
                "Failed: {}{attempt_note}{}",
                outcome.error.as_deref().unwrap_or("unknown error"),
                if outcome.continued {
                    " (workflow continued)"
                } else {
                    ""
                }
            ),
        ),
    }
}

/// `str.slice(0, n)`.
fn clip(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

#[derive(Default)]
struct State {
    row_ids: HashMap<usize, String>,
    started_at: HashMap<usize, i64>,
    logs: HashMap<usize, Vec<Value>>,
    finished: HashSet<usize>,
    replayed: HashSet<usize>,
}

/// The run's hooks.
pub(crate) struct Hooks {
    pub(crate) db: PgPool,
    pub(crate) realtime: Option<Arc<dyn DynRealtimePublisher>>,
    pub(crate) workspace_id: String,
    pub(crate) execution_id: String,
    pub(crate) total_steps: usize,
    pub(crate) workflow_id: String,
    state: Mutex<State>,
}

/// `rt.workflowExecutionEvent(workspaceId, executionId, event, payload)`;
/// a failed publish is logged.
pub(crate) async fn execution_event(
    realtime: Option<&Arc<dyn DynRealtimePublisher>>,
    workspace_id: &str,
    execution_id: &str,
    event: &str,
    payload: Value,
) {
    let Some(realtime) = realtime else { return };
    let message = RealtimeMessage::workspace(
        workspace_id,
        &format!("workflow_execution.{execution_id}"),
        event,
        payload,
        "system",
    );
    if let Err(error) = realtime.publish_boxed(&message).await {
        tracing::warn!(%error, "[workflow] realtime publish failed");
    }
}

impl Hooks {
    pub(crate) fn new(
        db: PgPool,
        realtime: Option<Arc<dyn DynRealtimePublisher>>,
        workspace_id: &str,
        execution_id: &str,
        total_steps: usize,
        workflow_id: &str,
    ) -> Self {
        Self {
            db,
            realtime,
            workspace_id: workspace_id.to_owned(),
            execution_id: execution_id.to_owned(),
            total_steps,
            workflow_id: workflow_id.to_owned(),
            state: Mutex::default(),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        f(&mut self.state.lock().unwrap_or_else(PoisonError::into_inner))
    }

    async fn event(&self, event: &str, payload: Value) {
        execution_event(
            self.realtime.as_ref(),
            &self.workspace_id,
            &self.execution_id,
            event,
            payload,
        )
        .await;
    }

    async fn write_progress(&self) -> Result<(), DbErr> {
        let finished = i32::try_from(self.with(|s| s.finished.len())).unwrap_or(i32::MAX);
        runs_table::Entity::update_many()
            .col_expr(runs_table::Column::CurrentStepIndex, Expr::value(finished))
            .col_expr(runs_table::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(runs_table::Column::Id.eq(&self.execution_id))
            .exec(&orm(&self.db))
            .await?;
        Ok(())
    }

    /// `recordStepError`: best effort.
    async fn record_error(&self, step: &Value, outcome: &Outcome) {
        let name = step.get("name").and_then(Value::as_str);
        let inserted = error_logs::Entity::insert(error_logs::ActiveModel {
            id: Set(engine_id("wel")),
            workflow_id: Set(Some(self.workflow_id.clone())),
            execution_id: Set(Some(self.execution_id.clone())),
            error_message: Set(outcome
                .error
                .clone()
                .unwrap_or_else(|| "Unknown error".to_owned())),
            error_type: Set(outcome.error_type.as_deref().map(|t| clip(t, 100))),
            severity: Set(if outcome.continued {
                "warning"
            } else {
                "error"
            }
            .to_owned()),
            step_id: Set(Some(clip(&js_string(step.get("id")), 50))),
            step_name: Set(name.map(|n| clip(n, 255))),
            step_type: Set(Some(clip(&js_string(step.get("type")), 100))),
            input: Set(outcome
                .error_details
                .as_ref()
                .map(|details| json!({ "details": details }))),
            occurred_at: Set(utc_now()),
            ..Default::default()
        })
        .exec_without_returning(&orm(&self.db))
        .await;
        if let Err(error) = inserted {
            tracing::warn!(%error, "[ExecutionHooks] could not write error log");
        }
    }

    fn base_payload(&self, step: &Value, index: usize) -> Map<String, Value> {
        let mut payload = Map::new();
        payload.insert("stepIndex".into(), json!(index + 1));
        payload.insert("totalSteps".into(), json!(self.total_steps));
        payload.insert(
            "stepId".into(),
            step.get("id").cloned().unwrap_or(Value::Null),
        );
        if let Some(name) = step.get("name") {
            payload.insert("stepName".into(), name.clone());
        }
        payload
    }

    /// `onStepStart(step, index)`.
    pub(crate) async fn on_step_start(&self, step: &Value, index: usize) -> Result<(), DbErr> {
        let db = orm(&self.db);
        let existing: Option<(String, String, Option<PrimitiveDateTime>, Option<Value>)> =
            step_rows::Entity::find()
                .select_only()
                .columns([
                    step_rows::Column::Id,
                    step_rows::Column::Status,
                    step_rows::Column::StartedAt,
                    step_rows::Column::Logs,
                ])
                .filter(step_rows::Column::ExecutionId.eq(&self.execution_id))
                .filter(
                    step_rows::Column::StepIndex.eq(i32::try_from(index + 1).unwrap_or(i32::MAX)),
                )
                .into_tuple()
                .one(&db)
                .await?;
        if let Some((id, status, started_at, logs)) = existing {
            #[allow(clippy::cast_possible_truncation)]
            let started = started_at.map_or_else(now_ms, |at| epoch_ms(at).round() as i64);
            self.with(|s| {
                s.row_ids.insert(index, id);
                s.started_at.insert(index, started);
                s.logs.insert(
                    index,
                    logs.and_then(|l| l.as_array().cloned()).unwrap_or_default(),
                );
                if status != "running" {
                    s.replayed.insert(index);
                }
            });
            return Ok(());
        }
        let row_id = engine_id("wes");
        let id = js_string(step.get("id"));
        let kind = js_string(step.get("type"));
        let name = step.get("name").and_then(Value::as_str);
        let logs = vec![log_line(
            "info",
            &format!("Started {} ({kind})", name.unwrap_or(&id)),
        )];
        self.with(|s| {
            s.row_ids.insert(index, row_id.clone());
            s.started_at.insert(index, now_ms());
            s.logs.insert(index, logs.clone());
        });
        step_rows::Entity::insert(step_rows::ActiveModel {
            id: Set(row_id),
            execution_id: Set(self.execution_id.clone()),
            step_id: Set(id),
            step_name: Set(name.map(str::to_owned)),
            step_type: Set(Some(kind)),
            step_index: Set(i32::try_from(index + 1).unwrap_or(i32::MAX)),
            status: Set("running".to_owned()),
            started_at: Set(Some(utc_now())),
            logs: Set(Some(Value::Array(logs))),
            ..Default::default()
        })
        .exec_without_returning(&db)
        .await?;
        let mut payload = self.base_payload(step, index);
        payload.insert(
            "stepType".into(),
            step.get("type").cloned().unwrap_or(Value::Null),
        );
        self.event("step_started", Value::Object(payload)).await;
        Ok(())
    }

    /// `onStepResult(step, index, outcome)`.
    pub(crate) async fn on_step_result(
        &self,
        step: &Value,
        index: usize,
        outcome: &Outcome,
    ) -> Result<(), DbErr> {
        let finished = matches!(outcome.status, "completed" | "skipped")
            || (outcome.status == "failed" && outcome.continued);
        if self.with(|s| s.replayed.contains(&index)) {
            if finished {
                self.with(|s| s.finished.insert(index));
            }
            return Ok(());
        }
        let (row_id, start, logs) = self.with(|s| {
            (
                s.row_ids.get(&index).cloned(),
                s.started_at.get(&index).copied(),
                s.logs.get(&index).cloned().unwrap_or_default(),
            )
        });
        let duration = start.map(|start| now_ms() - start);
        if let Some(row_id) = row_id {
            let output = if outcome.status == "skipped" {
                Some(json!({ "skipped": true }))
            } else {
                outcome.result.clone().filter(|r| !r.is_null())
            };
            let error = outcome.error.as_ref().map(|message| {
                let mut error = json!({ "message": message });
                if let Some(details) = &outcome.error_details {
                    error["details"] = details.clone();
                }
                error
            });
            let mut logs = logs;
            logs.push(outcome_log(outcome, duration));
            step_rows::Entity::update_many()
                .col_expr(step_rows::Column::Status, Expr::value(outcome.status))
                .col_expr(step_rows::Column::CompletedAt, Expr::value(utc_now()))
                .col_expr(
                    step_rows::Column::Duration,
                    Expr::value(duration.map(|d| i32::try_from(d).unwrap_or(i32::MAX))),
                )
                .col_expr(step_rows::Column::Output, Expr::value(output))
                .col_expr(step_rows::Column::Error, Expr::value(error))
                .col_expr(
                    step_rows::Column::RetryCount,
                    Expr::value(i32::try_from(outcome.attempts.saturating_sub(1)).unwrap_or(0)),
                )
                .col_expr(step_rows::Column::Logs, Expr::value(Value::Array(logs)))
                .filter(step_rows::Column::Id.eq(&row_id))
                .exec(&orm(&self.db))
                .await?;
        }
        if outcome.status == "failed" {
            self.record_error(step, outcome).await;
        }
        if finished {
            self.with(|s| s.finished.insert(index));
            self.write_progress().await?;
        }
        let mut payload = self.base_payload(step, index);
        if let Some(error) = &outcome.error {
            payload.insert("error".into(), json!(error));
        }
        if let Some(duration) = duration {
            payload.insert("duration".into(), json!(duration));
        }
        self.event(status_event(outcome.status), Value::Object(payload))
            .await;
        Ok(())
    }

    /// `markFinished(index, output)`: a waiting step that got its input.
    pub(crate) async fn mark_finished(
        &self,
        index: usize,
        output: Option<&Value>,
    ) -> Result<(), DbErr> {
        let row_id = self.with(|s| {
            s.finished.insert(index);
            s.row_ids.get(&index).cloned()
        });
        if let Some(row_id) = row_id {
            let mut update = step_rows::Entity::update_many()
                .col_expr(step_rows::Column::Status, Expr::value("completed"))
                .col_expr(step_rows::Column::CompletedAt, Expr::value(utc_now()));
            // `coalesce($output, output)`.
            if let Some(output) = output {
                update = update.col_expr(step_rows::Column::Output, Expr::value(output.clone()));
            }
            update
                .filter(step_rows::Column::Id.eq(&row_id))
                .filter(step_rows::Column::Status.eq("waiting_for_input"))
                .exec(&orm(&self.db))
                .await?;
        }
        self.write_progress().await
    }

    /// `markWaitExpired(step, index, message)`.
    pub(crate) async fn mark_wait_expired(
        &self,
        step: &Value,
        index: usize,
        message: &str,
    ) -> Result<(), DbErr> {
        let Some((row_id, start, logs)) = self.with(|s| {
            s.row_ids.get(&index).cloned().map(|id| {
                (
                    id,
                    s.started_at.get(&index).copied(),
                    s.logs.get(&index).cloned().unwrap_or_default(),
                )
            })
        }) else {
            return Ok(());
        };
        let duration = start.map(|start| now_ms() - start);
        let failed = Outcome {
            status: "failed",
            error: Some(message.to_owned()),
            ..Outcome::default()
        };
        let mut logs = logs;
        logs.push(outcome_log(&failed, duration));
        let updated = step_rows::Entity::update_many()
            .col_expr(step_rows::Column::Status, Expr::value("failed"))
            .col_expr(step_rows::Column::CompletedAt, Expr::value(utc_now()))
            .col_expr(
                step_rows::Column::Duration,
                Expr::value(duration.map(|d| i32::try_from(d).unwrap_or(i32::MAX))),
            )
            .col_expr(
                step_rows::Column::Error,
                Expr::value(json!({ "message": message })),
            )
            .col_expr(step_rows::Column::Logs, Expr::value(Value::Array(logs)))
            .filter(step_rows::Column::Id.eq(&row_id))
            .filter(step_rows::Column::Status.eq("waiting_for_input"))
            .exec(&orm(&self.db))
            .await?;
        if updated.rows_affected == 0 {
            return Ok(());
        }
        let outcome = Outcome {
            status: "failed",
            error: Some(message.to_owned()),
            error_type: Some("WaitExpiredError".into()),
            ..Outcome::default()
        };
        self.record_error(step, &outcome).await;
        let mut payload = self.base_payload(step, index);
        payload.insert("error".into(), json!(message));
        self.event("step_failed", Value::Object(payload)).await;
        Ok(())
    }

    /// The step row of a waiting step, for the decision an approval left.
    pub(crate) fn row_id(&self, index: usize) -> Option<String> {
        self.with(|s| s.row_ids.get(&index).cloned())
    }
}
