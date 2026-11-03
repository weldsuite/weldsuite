//! `buildExecutionHooks` (`engine/persistence.ts`): one
//! `workflow_execution_steps` row per step, its logs and outcome, the run's
//! progress, an error-log row per failure, and the realtime events the run
//! page follows. A replayed run finds its step rows and leaves them be.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::{DynRealtimePublisher, RealtimeMessage};

use super::{engine_id, now_ms, now_text};
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

    async fn write_progress(&self) -> Result<(), sqlx::Error> {
        let finished = i32::try_from(self.with(|s| s.finished.len())).unwrap_or(i32::MAX);
        sqlx::query(
            "update workflow_executions set current_step_index = $2, updated_at = $3::timestamp where id = $1",
        )
        .bind(&self.execution_id)
        .bind(finished)
        .bind(now_text())
        .execute(&self.db)
        .await?;
        Ok(())
    }

    /// `recordStepError`: best effort.
    async fn record_error(&self, step: &Value, outcome: &Outcome) {
        let name = step.get("name").and_then(Value::as_str);
        let inserted = sqlx::query(
            "insert into workflow_error_logs
                (id, workflow_id, execution_id, error_message, error_type, severity, step_id, step_name,
                 step_type, input, occurred_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamp)",
        )
        .bind(engine_id("wel"))
        .bind(&self.workflow_id)
        .bind(&self.execution_id)
        .bind(outcome.error.as_deref().unwrap_or("Unknown error"))
        .bind(outcome.error_type.as_deref().map(|t| clip(t, 100)))
        .bind(if outcome.continued { "warning" } else { "error" })
        .bind(clip(&js_string(step.get("id")), 50))
        .bind(name.map(|n| clip(n, 255)))
        .bind(clip(&js_string(step.get("type")), 100))
        .bind(
            outcome
                .error_details
                .as_ref()
                .map(|details| json!({ "details": details })),
        )
        .bind(now_text())
        .execute(&self.db)
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
    pub(crate) async fn on_step_start(
        &self,
        step: &Value,
        index: usize,
    ) -> Result<(), sqlx::Error> {
        let existing: Option<(String, String, Option<f64>, Option<Value>)> = sqlx::query_as(
            "select id, status, extract(epoch from started_at)::float8 * 1000, logs
             from workflow_execution_steps where execution_id = $1 and step_index = $2 limit 1",
        )
        .bind(&self.execution_id)
        .bind(i32::try_from(index + 1).unwrap_or(i32::MAX))
        .fetch_optional(&self.db)
        .await?;
        if let Some((id, status, started_at, logs)) = existing {
            #[allow(clippy::cast_possible_truncation)]
            let started = started_at.map_or_else(now_ms, |ms| ms.round() as i64);
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
        sqlx::query(
            "insert into workflow_execution_steps
                (id, execution_id, step_id, step_name, step_type, step_index, status, started_at, logs)
             values ($1, $2, $3, $4, $5, $6, 'running', $7::timestamp, $8)",
        )
        .bind(&row_id)
        .bind(&self.execution_id)
        .bind(&id)
        .bind(name)
        .bind(&kind)
        .bind(i32::try_from(index + 1).unwrap_or(i32::MAX))
        .bind(now_text())
        .bind(Value::Array(logs))
        .execute(&self.db)
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
    ) -> Result<(), sqlx::Error> {
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
            sqlx::query(
                "update workflow_execution_steps
                 set status = $2, completed_at = $3::timestamp, duration = $4, output = $5, error = $6,
                     retry_count = $7, logs = $8
                 where id = $1",
            )
            .bind(&row_id)
            .bind(outcome.status)
            .bind(now_text())
            .bind(duration.map(|d| i32::try_from(d).unwrap_or(i32::MAX)))
            .bind(output)
            .bind(error)
            .bind(i32::try_from(outcome.attempts.saturating_sub(1)).unwrap_or(0))
            .bind(Value::Array(logs))
            .execute(&self.db)
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
    ) -> Result<(), sqlx::Error> {
        let row_id = self.with(|s| {
            s.finished.insert(index);
            s.row_ids.get(&index).cloned()
        });
        if let Some(row_id) = row_id {
            sqlx::query(
                "update workflow_execution_steps
                 set status = 'completed', completed_at = $2::timestamp, output = coalesce($3, output)
                 where id = $1 and status = 'waiting_for_input'",
            )
            .bind(&row_id)
            .bind(now_text())
            .bind(output)
            .execute(&self.db)
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
    ) -> Result<(), sqlx::Error> {
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
        let updated = sqlx::query(
            "update workflow_execution_steps
             set status = 'failed', completed_at = $2::timestamp, duration = $3, error = $4, logs = $5
             where id = $1 and status = 'waiting_for_input'",
        )
        .bind(&row_id)
        .bind(now_text())
        .bind(duration.map(|d| i32::try_from(d).unwrap_or(i32::MAX)))
        .bind(json!({ "message": message }))
        .bind(Value::Array(logs))
        .execute(&self.db)
        .await?;
        if updated.rows_affected() == 0 {
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
