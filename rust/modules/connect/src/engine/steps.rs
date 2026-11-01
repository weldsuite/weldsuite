//! `executeWorkflowSteps` (`engine/execute-steps.ts`): the main sequence,
//! a step's own condition, its inputs, attempts and retries, condition
//! branches, loops (with their per-step tallies), delays, and a step that
//! waits for input.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::{BoxFuture, JobContext, JobError, StepRetry};

use super::actions::{ActionCtx, ActionError, execute_action};
use super::hooks::{Hooks, Outcome};
use super::template::{
    Scope, StepTree, branch_ids_of, build_step_tree, condition_branches, evaluate_condition,
    if_branch_id, if_not_branch_id, loop_body_id, resolve_inputs, step_id, step_type,
    steps_under_branch, value_branch_id,
};
use super::{EngineDeps, is_cancelled};
use crate::js::{js_number, js_string};

/// `MAX_LOOP_ITERATIONS_PER_RUN`.
const MAX_LOOP_ITERATIONS: usize = 250;

/// Who and what a run is.
#[derive(Debug, Clone)]
#[allow(dead_code)] // the chain depth and credit cap go to the CRM and AI actions
pub(crate) struct RunInfo {
    pub(crate) workspace_id: String,
    pub(crate) user_id: String,
    /// The workflow's `createdBy`, whose permissions CRM steps act with.
    pub(crate) owner_user_id: Option<String>,
    pub(crate) execution_id: String,
    pub(crate) chain_depth: i64,
    pub(crate) max_credits_per_run: Option<i64>,
}

/// `ExecuteStepsResult`, plus whether the run's row was cancelled.
#[derive(Debug, Clone)]
pub(crate) struct RunResult {
    /// `completed`, `failed` or `waiting_for_input`.
    pub(crate) status: &'static str,
    pub(crate) output: Map<String, Value>,
    /// The failed step and its message.
    pub(crate) error: Option<(String, String)>,
    /// The waiting step and its type.
    pub(crate) waiting: Option<(String, Option<String>)>,
    pub(crate) cancelled: bool,
}

impl RunResult {
    pub(crate) fn failed(output: Map<String, Value>, step_id: &str, message: &str) -> Self {
        Self {
            status: "failed",
            output,
            error: Some((step_id.to_owned(), message.to_owned())),
            waiting: None,
            cancelled: false,
        }
    }
}

/// One attempt as the journal keeps it: the action's result or its error.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Attempted {
    ok: bool,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Option<ActionError>,
}

/// `LoopStepTally`.
#[derive(Debug, Clone, Default)]
struct Tally {
    runs: usize,
    skipped: usize,
    failed: Option<(String, Option<Value>, Option<String>)>,
    continued_errors: usize,
    last_error: Option<String>,
}

type Tallies = Arc<Mutex<HashMap<usize, Tally>>>;

/// `Scope`: where a sequence runs.
#[derive(Clone, Default)]
struct StepScope {
    suffix: String,
    tally: Option<Tallies>,
    loop_scope: Option<(Value, usize)>,
    nested: bool,
}

enum AttemptResult {
    Succeeded { result: Value, attempts: u32 },
    Failed { error: ActionError, attempts: u32 },
}

/// `StepRunner`.
pub(crate) struct Runner<'a> {
    ctx: &'a dyn JobContext,
    deps: &'a EngineDeps,
    db: &'a PgPool,
    hooks: &'a Hooks,
    info: &'a RunInfo,
    steps: &'a [Value],
    tree: StepTree,
    trigger_data: &'a Value,
    output: Map<String, Value>,
    variables: Map<String, Value>,
    contact: Map<String, Value>,
    loop_iterations: usize,
}

impl<'a> Runner<'a> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        ctx: &'a dyn JobContext,
        deps: &'a EngineDeps,
        db: &'a PgPool,
        hooks: &'a Hooks,
        info: &'a RunInfo,
        steps: &'a [Value],
        trigger_data: &'a Value,
        variables: &Map<String, Value>,
    ) -> Self {
        Self {
            ctx,
            deps,
            db,
            hooks,
            info,
            steps,
            tree: build_step_tree(steps),
            trigger_data,
            output: Map::new(),
            variables: variables.clone(),
            contact: Map::new(),
            loop_iterations: 0,
        }
    }

    /// `executeWorkflowSteps(workflow, context, deps, { startIndex, seedOutput })`.
    /// Variables a step set stay set across resumes, as the run's context.
    pub(crate) async fn execute(
        &mut self,
        start_index: usize,
        seed: Map<String, Value>,
    ) -> Result<RunResult, JobError> {
        self.output = seed;
        let main: Vec<usize> = self
            .tree
            .main
            .iter()
            .copied()
            .filter(|&index| index >= start_index)
            .collect();
        let halted = self.sequence(main, StepScope::default()).await?;
        Ok(halted.unwrap_or_else(|| RunResult {
            status: "completed",
            output: self.output.clone(),
            error: None,
            waiting: None,
            cancelled: false,
        }))
    }

    fn sequence(
        &mut self,
        indexes: Vec<usize>,
        scope: StepScope,
    ) -> BoxFuture<'_, Result<Option<RunResult>, JobError>> {
        Box::pin(async move {
            for index in indexes {
                if let Some(result) = self.run_step(index, scope.clone()).await? {
                    return Ok(Some(result));
                }
            }
            Ok(None)
        })
    }

    async fn begin(&self, step: &Value, index: usize, scope: &StepScope) -> Result<(), JobError> {
        if scope.tally.is_none() {
            self.hooks
                .on_step_start(step, index)
                .await
                .map_err(JobError::failed)?;
        }
        Ok(())
    }

    async fn report(
        &self,
        step: &Value,
        index: usize,
        scope: &StepScope,
        outcome: &Outcome,
    ) -> Result<(), JobError> {
        let Some(tally) = &scope.tally else {
            return self
                .hooks
                .on_step_result(step, index, outcome)
                .await
                .map_err(JobError::failed);
        };
        let mut tallies = tally.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = tallies.entry(index).or_default();
        if outcome.status == "skipped" {
            entry.skipped += 1;
        } else {
            entry.runs += 1;
        }
        if outcome.status == "failed" {
            if outcome.continued {
                entry.continued_errors += 1;
                entry.last_error.clone_from(&outcome.error);
            } else {
                entry.failed = Some((
                    outcome
                        .error
                        .clone()
                        .unwrap_or_else(|| "Unknown error".into()),
                    outcome.error_details.clone(),
                    outcome.error_type.clone(),
                ));
            }
        }
        Ok(())
    }

    async fn skip_branches(
        &self,
        branch_ids: &[String],
        scope: &StepScope,
    ) -> Result<(), JobError> {
        if scope.tally.is_some() {
            return Ok(());
        }
        for branch_id in branch_ids {
            for index in steps_under_branch(&self.tree, self.steps, branch_id) {
                let step = &self.steps[index];
                self.hooks
                    .on_step_start(step, index)
                    .await
                    .map_err(JobError::failed)?;
                self.hooks
                    .on_step_result(step, index, &Outcome::skipped())
                    .await
                    .map_err(JobError::failed)?;
            }
        }
        Ok(())
    }

    fn scope_values<'s>(&'s self, scope: &'s StepScope) -> Scope<'s> {
        Scope {
            previous_results: &self.output,
            trigger_data: self.trigger_data,
            variables: &self.variables,
            contact_data: &self.contact,
            iteration: scope
                .loop_scope
                .as_ref()
                .map(|(item, index)| (item, *index)),
        }
    }

    /// `runStepWithRetry(step, index, suffix, inputs, actionCtx, deps)`.
    async fn attempt(
        &self,
        step: &Value,
        index: usize,
        scope: &StepScope,
        inputs: &Map<String, Value>,
    ) -> Result<AttemptResult, JobError> {
        let policy = step.get("retryPolicy");
        let on_error = step.get("onError");
        let max_attempts = match policy.and_then(|p| p.get("maxAttempts")) {
            Some(value) if !value.is_null() => js_number(Some(value)),
            _ if on_error.and_then(|o| o.get("action")) == Some(&json!("retry")) => {
                match on_error.and_then(|o| o.get("retryCount")) {
                    Some(count) if !count.is_null() => js_number(Some(count)) + 1.0,
                    _ => 1.0,
                }
            }
            _ => 1.0,
        };
        // `Math.max(1, maxAttempts)`: NaN runs no attempt at all.
        let limit = if max_attempts.is_nan() {
            0
        } else {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let limit = max_attempts.max(1.0).min(f64::from(u32::MAX)).ceil() as u32;
            limit
        };
        let base_delay = match policy.and_then(|p| p.get("delayMs")) {
            Some(v) if !v.is_null() => js_number(Some(v)),
            _ => 0.0,
        };
        let backoff = match policy.and_then(|p| p.get("backoffMultiplier")) {
            Some(v) if !v.is_null() => js_number(Some(v)),
            _ => 1.0,
        };
        let id = step_id(step);
        let kind = step_type(step);
        let action = ActionCtx {
            deps: self.deps,
            db: self.db,
            info: self.info,
            step_id: &id,
            previous_results: &self.output,
            trigger_data: self.trigger_data,
            variables: &self.variables,
            loop_scope: scope
                .loop_scope
                .as_ref()
                .map(|(item, index)| (item, *index)),
        };
        let mut attempts = 0;
        let mut last_error = ActionError::plain("undefined");
        while attempts < limit {
            attempts += 1;
            let name = format!("step-{index}-{id}{}-attempt-{attempts}", scope.suffix);
            let attempted: Attempted =
                weldsuite_ports::step(self.ctx, &name, StepRetry::ONCE, || async {
                    Ok(match execute_action(&kind, inputs, &action).await {
                        Ok(result) => Attempted {
                            ok: true,
                            result,
                            error: None,
                        },
                        Err(error) => Attempted {
                            ok: false,
                            result: Value::Null,
                            error: Some(error),
                        },
                    })
                })
                .await?;
            if attempted.ok {
                return Ok(AttemptResult::Succeeded {
                    result: attempted.result,
                    attempts,
                });
            }
            let error = attempted
                .error
                .unwrap_or_else(|| ActionError::plain("Unknown error"));
            let fatal = error.non_retryable;
            last_error = error;
            if fatal {
                break;
            }
            if attempts < limit {
                let delay = base_delay * backoff.powi(i32::try_from(attempts - 1).unwrap_or(0));
                if delay > 0.0 && delay.is_finite() {
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    let ms = delay.min(1e15) as u64;
                    self.ctx
                        .sleep(
                            &format!("retry-{index}{}-{attempts}", scope.suffix),
                            Duration::from_millis(ms),
                        )
                        .await?;
                }
            }
        }
        Ok(AttemptResult::Failed {
            error: last_error,
            attempts,
        })
    }

    fn run_step(
        &mut self,
        index: usize,
        scope: StepScope,
    ) -> BoxFuture<'_, Result<Option<RunResult>, JobError>> {
        Box::pin(async move {
            let steps: &'a [Value] = self.steps;
            let step = &steps[index];
            if is_cancelled(self.db, &self.info.execution_id).await? {
                return Ok(Some(RunResult {
                    status: "failed",
                    output: self.output.clone(),
                    error: None,
                    waiting: None,
                    cancelled: true,
                }));
            }
            self.begin(step, index, &scope).await?;
            let id = step_id(step);
            let kind = step_type(step);
            if let Some(condition) = step.get("condition").filter(|c| crate::js::truthy(c))
                && !evaluate_condition(condition, &self.scope_values(&scope))
            {
                self.output.insert(id.clone(), json!({ "skipped": true }));
                self.report(step, index, &scope, &Outcome::skipped())
                    .await?;
                self.skip_branches(&branch_ids_of(step), &scope).await?;
                return Ok(None);
            }
            // `step.config ?? step.inputs ?? {}`.
            let raw = match step.get("config") {
                Some(config) if !config.is_null() => config,
                _ => step
                    .get("inputs")
                    .filter(|i| !i.is_null())
                    .unwrap_or(&Value::Null),
            };
            let raw_inputs = raw.as_object().cloned().unwrap_or_default();
            let escape: &[&str] = if (kind == "send_email" || kind == "email")
                && raw_inputs.get("isHtml") != Some(&json!(false))
            {
                &["body", "html"]
            } else {
                &[]
            };
            let inputs = resolve_inputs(&raw_inputs, &self.scope_values(&scope), escape);
            let (result, attempts) = match self.attempt(step, index, &scope, &inputs).await? {
                AttemptResult::Succeeded { result, attempts } => (result, attempts),
                AttemptResult::Failed { error, attempts } => {
                    return self.fail(step, index, &scope, error, attempts).await;
                }
            };
            if kind == "set_variable" && result["set"] == json!(true) {
                self.variables
                    .insert(js_string(result.get("name")), result["value"].clone());
            }
            if result.get("__waitingForInput") == Some(&json!(true)) {
                if scope.nested {
                    return self
                        .fail(
                            step,
                            index,
                            &scope,
                            ActionError::fatal(
                                "A step that waits for input cannot run inside a branch or a loop",
                            ),
                            attempts,
                        )
                        .await;
                }
                let outcome = Outcome {
                    status: "waiting_for_input",
                    result: Some(result.clone()),
                    attempts,
                    ..Outcome::default()
                };
                self.report(step, index, &scope, &outcome).await?;
                return Ok(Some(RunResult {
                    status: "waiting_for_input",
                    output: self.output.clone(),
                    error: None,
                    waiting: Some((id, result["stepType"].as_str().map(str::to_owned))),
                    cancelled: false,
                }));
            }
            self.output.insert(id.clone(), result.clone());
            if kind == "loop" {
                return self.run_loop(index, scope, result, attempts).await;
            }
            let outcome = Outcome {
                status: "completed",
                result: Some(result.clone()),
                attempts,
                ..Outcome::default()
            };
            self.report(step, index, &scope, &outcome).await?;
            if kind == "condition" {
                let chosen = if condition_branches(step).is_some() {
                    result["matchedBranch"]
                        .as_str()
                        .map(|branch| value_branch_id(&id, branch))
                } else if result["passed"] == json!(true) {
                    Some(if_branch_id(&id))
                } else {
                    Some(if_not_branch_id(&id))
                };
                let others: Vec<String> = branch_ids_of(step)
                    .into_iter()
                    .filter(|b| Some(b) != chosen.as_ref())
                    .collect();
                self.skip_branches(&others, &scope).await?;
                if let Some(chosen) = chosen {
                    let body = self.tree.branches.get(&chosen).cloned().unwrap_or_default();
                    let nested = StepScope {
                        nested: true,
                        ..scope.clone()
                    };
                    if let Some(result) = self.sequence(body, nested).await? {
                        return Ok(Some(result));
                    }
                }
                return Ok(None);
            }
            if let Some(ms) = result.get("__delayMs").and_then(Value::as_f64)
                && ms > 0.0
            {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let ms = ms.min(1e15) as u64;
                self.ctx
                    .sleep(
                        &format!("delay-{index}{}", scope.suffix),
                        Duration::from_millis(ms),
                    )
                    .await?;
            }
            Ok(None)
        })
    }

    async fn fail(
        &mut self,
        step: &Value,
        index: usize,
        scope: &StepScope,
        error: ActionError,
        attempts: u32,
    ) -> Result<Option<RunResult>, JobError> {
        let id = step_id(step);
        let continue_on_error = step.get("continueOnError") == Some(&json!(true))
            || step.get("onError").and_then(|o| o.get("action")) == Some(&json!("continue"));
        let mut outcome = Outcome {
            status: "failed",
            error: Some(error.message.clone()),
            error_details: error.details.clone(),
            error_type: Some(error.name.clone()),
            continued: false,
            attempts,
            result: None,
        };
        if continue_on_error {
            self.output.insert(id, json!({ "error": error.message }));
            outcome.continued = true;
            self.report(step, index, scope, &outcome).await?;
            self.skip_branches(&branch_ids_of(step), scope).await?;
            return Ok(None);
        }
        self.report(step, index, scope, &outcome).await?;
        Ok(Some(RunResult::failed(
            self.output.clone(),
            &id,
            &error.message,
        )))
    }

    fn run_loop(
        &mut self,
        index: usize,
        scope: StepScope,
        result: Value,
        attempts: u32,
    ) -> BoxFuture<'_, Result<Option<RunResult>, JobError>> {
        Box::pin(async move {
            let steps: &'a [Value] = self.steps;
            let step = &steps[index];
            let id = step_id(step);
            let items = result["items"].as_array().cloned().unwrap_or_default();
            let body_id = loop_body_id(&id);
            let body = self
                .tree
                .branches
                .get(&body_id)
                .cloned()
                .unwrap_or_default();
            let tally = scope
                .tally
                .clone()
                .unwrap_or_else(|| Arc::new(Mutex::new(HashMap::new())));
            let mut failure: Option<(String, usize)> = None;
            for (i, item) in items.iter().enumerate() {
                self.loop_iterations += 1;
                if self.loop_iterations > MAX_LOOP_ITERATIONS {
                    failure = Some((
                        format!(
                            "This run reached the limit of {MAX_LOOP_ITERATIONS} loop iterations"
                        ),
                        i,
                    ));
                    break;
                }
                let inner = StepScope {
                    suffix: format!("{}-i{i}", scope.suffix),
                    tally: Some(Arc::clone(&tally)),
                    loop_scope: Some((item.clone(), i)),
                    nested: true,
                };
                if let Some(halt) = self.sequence(body.clone(), inner).await? {
                    if halt.cancelled {
                        return Ok(Some(halt));
                    }
                    failure = Some((
                        halt.error
                            .map_or_else(|| "A step in the loop failed".into(), |(_, m)| m),
                        i,
                    ));
                    break;
                }
            }
            if scope.tally.is_none() {
                self.record_loop_body(
                    &steps_under_branch(&self.tree, self.steps, &body_id),
                    &tally,
                )
                .await?;
            }
            if let Some((message, item)) = failure {
                return self
                    .fail(
                        step,
                        index,
                        &scope,
                        ActionError::fatal(&format!("Item {}: {message}", item + 1)),
                        attempts,
                    )
                    .await;
            }
            let summary = json!({ "count": items.len(), "iterations": items.len() });
            self.output.insert(id, summary.clone());
            let outcome = Outcome {
                status: "completed",
                result: Some(summary),
                attempts,
                ..Outcome::default()
            };
            self.report(step, index, &scope, &outcome).await?;
            Ok(None)
        })
    }

    /// `recordLoopBody(indexes, tally)`: one outcome per body step.
    async fn record_loop_body(&self, indexes: &[usize], tally: &Tallies) -> Result<(), JobError> {
        for &index in indexes {
            let step = &self.steps[index];
            let counts = tally
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&index)
                .cloned();
            self.hooks
                .on_step_start(step, index)
                .await
                .map_err(JobError::failed)?;
            let outcome = match counts {
                None => Outcome::skipped(),
                Some(counts) if counts.runs == 0 => Outcome::skipped(),
                Some(Tally {
                    failed: Some((error, details, kind)),
                    ..
                }) => Outcome {
                    status: "failed",
                    error: Some(error),
                    error_details: details,
                    error_type: kind,
                    attempts: 1,
                    ..Outcome::default()
                },
                Some(counts) if counts.continued_errors > 0 => Outcome {
                    status: "failed",
                    error: Some(format!(
                        "{} of {} runs failed; last error: {}",
                        counts.continued_errors,
                        counts.runs,
                        counts.last_error.as_deref().unwrap_or("unknown")
                    )),
                    continued: true,
                    attempts: 1,
                    ..Outcome::default()
                },
                Some(counts) => Outcome {
                    status: "completed",
                    result: Some(json!({ "runs": counts.runs, "skipped": counts.skipped })),
                    attempts: 1,
                    ..Outcome::default()
                },
            };
            self.hooks
                .on_step_result(step, index, &outcome)
                .await
                .map_err(JobError::failed)?;
        }
        Ok(())
    }
}
