//! `ProcessResponseWorkflow` as the `forms.process-response` job
//! (`workflows/process-response.ts`): what happens after a response is
//! submitted (or a verified respondent edited theirs).
//!
//! The job loads the response, then runs the ordered steps of
//! [`process_steps`], each as its own durable step: a failing step retries
//! with backoff without repeating the others. Integration steps run once per
//! enabled integration of their kind and are recorded in
//! `form_response_actions` (pending, then done, skipped or failed with the
//! error). One run per response: the key is `process-response-<id>`, where
//! the id is the response's (`<responseId>-update-<stamp>` for an edit, as
//! the Workflow instance id).
//!
//! Adding a step is one type: implement [`ProcessStep`] in its own module
//! under `steps/` and list it in [`process_steps`].

use std::sync::Arc;
use std::time::Duration;

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QuerySelect, Select,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_ports::{BoxFuture, DynJobs, Job, JobContext, JobError, JobRequest, StepRetry, step};
use weldsuite_schema::tenant::{
    form_integrations, form_response_actions, form_response_files, form_responses, form_versions,
    forms,
};

use crate::common::{Ctx, db_error_text, instant, row_json, rows_json, text};
use crate::engine::FormDefinition;
use crate::{TenantDb, TenantResolver};

/// The job's name.
pub const PROCESS_RESPONSE_JOB: &str = "forms.process-response";

/// `ProcessResponseParams`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessResponseParams {
    /// Clerk org id of the workspace.
    pub clerk_org_id: String,
    /// `workspaces.id`.
    pub workspace_id: String,
    pub form_id: String,
    pub response_id: String,
    /// `submit`, or `update` when a verified respondent edited a completed response.
    pub mode: String,
    /// The Retry button: only that integration's step runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_integration_id: Option<String>,
}

/// Starts runs (`PROCESS_RESPONSE.create({ id, params })`): the jobs port,
/// or in conformance builds the test's Workflow binding.
pub trait ProcessRuns: Send + Sync {
    /// Start the run `id`; an `Err` carries why it could not.
    fn start<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, Result<(), String>>;
}

/// The request's own [`ProcessRuns`] (conformance: the test's `PROCESS_RESPONSE`).
#[derive(Clone)]
pub struct RequestProcessRuns(pub Arc<dyn ProcessRuns>);

/// Runs on the jobs port, one per key.
pub struct JobsProcessRuns(pub Arc<dyn DynJobs>);

impl ProcessRuns for JobsProcessRuns {
    fn start<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let request = JobRequest {
                name: PROCESS_RESPONSE_JOB.to_owned(),
                key: format!("process-response-{id}"),
                payload: params.clone(),
                delay: None,
            };
            self.0
                .start_boxed(request)
                .await
                .map_err(|error| error.to_string())
        })
    }
}

/// `Date.now().toString(36)`.
fn base36(mut n: i64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n <= 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[usize::try_from(n % 36).unwrap_or(0)]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `startProcessing(env, params)`: the instance id is the response id; an
/// edit or a retry gets one of its own (`<responseId>-update-<stamp>`).
pub(crate) async fn start_processing(
    ctx: &Ctx,
    params: &ProcessResponseParams,
    now_ms: i64,
) -> Result<(), String> {
    let Some(runs) = ctx.svc.process.clone() else {
        tracing::warn!("forms: no ProcessResponse runner; the response's steps did not start");
        return Ok(());
    };
    let suffix = if params.retry_integration_id.is_some() {
        Some("retry")
    } else if params.mode == "update" {
        Some("update")
    } else {
        None
    };
    let id = match suffix {
        Some(suffix) => format!("{}-{suffix}-{}", params.response_id, base36(now_ms)),
        None => params.response_id.clone(),
    };
    let params = serde_json::to_value(params).map_err(|error| error.to_string())?;
    runs.start(&id, &params).await
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/// Everything a step needs, read fresh inside the step (`ProcessContext`).
pub struct ProcessContext {
    pub db: PgPool,
    /// The workspace the response belongs to, with the worker's services
    /// (`env`, the master database, the buckets, events, mail, the cache).
    pub(crate) ctx: Ctx,
    pub params: ProcessResponseParams,
    /// The `forms` row, as Drizzle returns it.
    pub form: Value,
    /// The `form_responses` row.
    pub response: Value,
    /// The version the response answered.
    pub definition: FormDefinition,
    /// Its `form_response_files` rows.
    pub files: Vec<Value>,
}

/// What an integration step did (`StepResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum StepResult {
    Done {
        entity_type: Option<String>,
        entity_id: Option<String>,
    },
    /// The reason shown on the integration.
    Skipped(String),
}

/// What a step runs for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepKind {
    /// Once per response (notifications, the receipt email).
    Always,
    /// Once per enabled integration of this kind (`crm`, `desk`, `flow`).
    Integration(&'static str),
}

/// One step of `ProcessResponse` (`ProcessStep`).
pub trait ProcessStep: Send + Sync {
    /// Unique; the durable step's name.
    fn name(&self) -> &'static str;
    fn kind(&self) -> StepKind;
    /// `retries`: Cloudflare's default unless the step says otherwise.
    fn retry(&self) -> StepRetry {
        StepRetry::exponential(5, Duration::from_secs(10))
    }
    /// Run the step; `integration` is the `form_integrations` row of an
    /// integration step. An `Err` is retried, then recorded as failed.
    fn run<'a>(
        &'a self,
        ctx: &'a ProcessContext,
        integration: Option<&'a Value>,
    ) -> BoxFuture<'a, Result<StepResult, String>>;
}

/// `PROCESS_STEPS`: the ordered steps (`workflows/steps/index.ts`).
pub fn process_steps() -> Vec<Arc<dyn ProcessStep>> {
    crate::steps::all()
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/// `ProcessResponseWorkflow`.
pub struct ProcessResponseJob {
    pub tenants: Arc<dyn TenantResolver>,
    /// The worker's services the steps use.
    pub state: crate::FormsState,
    /// What a request would carry (conformance: the test's buckets, env,
    /// ledgers and master database); empty in the app.
    pub request: http::Extensions,
    pub steps: Vec<Arc<dyn ProcessStep>>,
}

fn failed(error: impl std::fmt::Display) -> JobError {
    JobError::failed(error)
}

/// A database error as the job's failure, with the driver's message.
fn db_failed(error: &DbErr) -> JobError {
    failed(db_error_text(error))
}

/// The first row `find` reads, as Drizzle returns it; `failed` says why not.
async fn read_row<E>(
    db: &DatabaseConnection,
    find: Select<E>,
    failed: &str,
) -> Result<Option<Value>, String>
where
    E: EntityTrait,
    E::Model: Serialize,
{
    find.one(db)
        .await
        .map_err(|_| failed.to_owned())?
        .map(row_json)
        .transpose()
        .map_err(|_| failed.to_owned())
}

/// `loadContext(env, params, db)`: `None` when the response is not completed
/// or does not exist.
async fn load_context(
    job: &ProcessResponseJob,
    tenant: &TenantDb,
    params: &ProcessResponseParams,
) -> Result<Option<ProcessContext>, String> {
    let db = &tenant.db;
    let orm_db = orm(db);
    let failed = "forms: reading the response failed";
    let Some(response) = read_row(
        &orm_db,
        form_responses::Entity::find_by_id(params.response_id.as_str()),
        failed,
    )
    .await?
    else {
        return Ok(None);
    };
    if text(&response, "status") != "completed" {
        return Ok(None);
    }
    let form = read_row(
        &orm_db,
        forms::Entity::find_by_id(text(&response, "formId")),
        failed,
    )
    .await?;
    let version = read_row(
        &orm_db,
        form_versions::Entity::find_by_id(text(&response, "versionId")),
        failed,
    )
    .await?;
    let (Some(form), Some(version)) = (form, version) else {
        return Ok(None);
    };
    let files_failed = "forms: reading the response's files failed";
    let files = form_response_files::Entity::find()
        .filter(form_response_files::Column::ResponseId.eq(text(&response, "id")))
        .all(&orm_db)
        .await
        .map_err(|_| files_failed.to_owned())?;
    let files = rows_json(files).map_err(|_| files_failed.to_owned())?;
    let definition = FormDefinition::parse(&version["definition"])
        .map_err(|_| "forms: the version's definition does not parse".to_owned())?;
    let ctx = Ctx {
        db: db.clone(),
        master: job.state.master(&job.request),
        workspace_id: if tenant.workspace_id.is_empty() {
            params.workspace_id.clone()
        } else {
            tenant.workspace_id.clone()
        },
        clerk_org_id: params.clerk_org_id.clone(),
        svc: job.state.services(&job.request),
    };
    Ok(Some(ProcessContext {
        db: db.clone(),
        ctx,
        params: params.clone(),
        form,
        response,
        definition,
        files,
    }))
}

/// `markPending`: one row per integration per response, attempts counted.
async fn mark_pending(
    ctx: &ProcessContext,
    integration: &Value,
    now: OffsetDateTime,
) -> Result<(), DbErr> {
    use form_response_actions::Column;
    form_response_actions::Entity::insert(form_response_actions::ActiveModel {
        id: Set(weldsuite_kit::generate_id("fra")),
        response_id: Set(text(&ctx.response, "id").to_owned()),
        form_id: Set(text(&ctx.form, "id").to_owned()),
        integration_id: Set(text(integration, "id").to_owned()),
        kind: Set(text(integration, "kind").to_owned()),
        status: Set("pending".to_owned()),
        attempts: Set(1),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::columns([Column::ResponseId, Column::IntegrationId])
            .value(Column::Status, Expr::value("pending"))
            .value(Column::Error, Expr::value(Option::<String>::None))
            .value(
                Column::Attempts,
                sea_orm::ExprTrait::add(
                    Expr::col((form_response_actions::Entity, Column::Attempts)),
                    1,
                ),
            )
            .value(Column::UpdatedAt, Expr::value(now))
            .to_owned(),
    )
    .exec_without_returning(&orm(&ctx.db))
    .await?;
    Ok(())
}

/// `finishAction`: the action row and the integration's last error.
async fn finish_action(
    ctx: &ProcessContext,
    integration: &Value,
    outcome: Result<&StepResult, &str>,
    now: OffsetDateTime,
) -> Result<(), DbErr> {
    use form_response_actions::Column;
    let db = orm(&ctx.db);
    let response_id = text(&ctx.response, "id");
    let integration_id = text(integration, "id");
    let (status, error, entity) = match outcome {
        Ok(StepResult::Done {
            entity_type,
            entity_id,
        }) => ("done", None, Some((entity_type, entity_id))),
        Ok(StepResult::Skipped(reason)) => ("skipped", Some(reason.as_str()), None),
        Err(error) => ("failed", Some(error), None),
    };
    let mut update = form_response_actions::Entity::update_many()
        .col_expr(Column::Status, Expr::value(status));
    if let Some((entity_type, entity_id)) = entity {
        update = update
            .col_expr(Column::EntityType, Expr::value(entity_type.clone()))
            .col_expr(Column::EntityId, Expr::value(entity_id.clone()));
    }
    update
        .col_expr(Column::Error, Expr::value(error))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::ResponseId.eq(response_id))
        .filter(Column::IntegrationId.eq(integration_id))
        .exec(&db)
        .await?;
    form_integrations::Entity::update_many()
        .col_expr(form_integrations::Column::LastError, Expr::value(error))
        .filter(form_integrations::Column::Id.eq(integration_id))
        .exec(&db)
        .await?;
    Ok(())
}

impl ProcessResponseJob {
    async fn tenant(&self, params: &ProcessResponseParams) -> Result<TenantDb, JobError> {
        self.tenants
            .tenant(&params.clerk_org_id)
            .await
            .map_err(JobError::Failed)
    }

    async fn run_integration_step(
        &self,
        ctx: &dyn JobContext,
        params: &ProcessResponseParams,
        step_impl: &Arc<dyn ProcessStep>,
        kind: &str,
        integration_id: &str,
    ) -> Result<(), JobError> {
        let name = format!("{}:{integration_id}", step_impl.name());
        step(ctx, &name, step_impl.retry(), || async {
            let tenant = self.tenant(params).await?;
            let db = tenant.db.clone();
            let integration = read_row(
                &orm(&db),
                form_integrations::Entity::find_by_id(integration_id),
                "forms: reading the integration failed",
            )
            .await
            .map_err(failed)?;
            // Not this step's kind, or removed or switched off since the run started.
            let Some(integration) = integration
                .filter(|i| text(i, "kind") == kind && i["enabled"] == Value::Bool(true))
            else {
                return Ok(Value::Null);
            };
            let Some(process) = load_context(self, &tenant, params).await.map_err(failed)? else {
                return Ok(Value::Null);
            };
            let now = instant(process.ctx.now_ms());
            mark_pending(&process, &integration, now)
                .await
                .map_err(|error| db_failed(&error))?;
            match step_impl.run(&process, Some(&integration)).await {
                Ok(outcome) => {
                    finish_action(&process, &integration, Ok(&outcome), now)
                        .await
                        .map_err(|error| db_failed(&error))?;
                    Ok(Value::Null)
                }
                Err(error) => {
                    finish_action(&process, &integration, Err(&error), now)
                        .await
                        .map_err(|error| db_failed(&error))?;
                    Err(failed(error))
                }
            }
        })
        .await
        .map(|_: Value| ())
    }
}

impl Job for ProcessResponseJob {
    fn name(&self) -> &'static str {
        PROCESS_RESPONSE_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params: ProcessResponseParams = serde_json::from_value(payload)?;
            let integrations: Option<Vec<(String, String)>> = step(
                ctx,
                "load response",
                StepRetry::exponential(5, Duration::from_secs(10)),
                || async {
                    let tenant = self.tenant(&params).await?;
                    let db = tenant.db.clone();
                    let Some(process) = load_context(self, &tenant, &params)
                        .await
                        .map_err(failed)?
                    else {
                        return Ok(None);
                    };
                    let rows: Vec<(String, String)> = form_integrations::Entity::find()
                        .select_only()
                        .columns([form_integrations::Column::Id, form_integrations::Column::Kind])
                        .filter(form_integrations::Column::FormId.eq(text(&process.form, "id")))
                        .filter(form_integrations::Column::Enabled.eq(true))
                        .into_tuple()
                        .all(&orm(&db))
                        .await
                        .map_err(|error| db_failed(&error))?;
                    Ok(Some(rows))
                },
            )
            .await?;
            let Some(integrations) = integrations else {
                return Ok(());
            };
            for step_impl in &self.steps {
                let outcome = match step_impl.kind() {
                    StepKind::Always => {
                        // A retry runs one integration's step again, not the notifications.
                        if params.retry_integration_id.is_some() {
                            continue;
                        }
                        step(ctx, step_impl.name(), step_impl.retry(), || async {
                            let tenant = self.tenant(&params).await?;
                            if let Some(process) =
                                load_context(self, &tenant, &params).await.map_err(failed)?
                            {
                                step_impl.run(&process, None).await.map_err(failed)?;
                            }
                            Ok(Value::Null)
                        })
                        .await
                        .map(|_: Value| ())
                    }
                    StepKind::Integration(kind) => {
                        let mut result = Ok(());
                        for (id, _) in integrations.iter().filter(|(id, k)| {
                            k == kind
                                && params
                                    .retry_integration_id
                                    .as_deref()
                                    .is_none_or(|retry| retry == id)
                        }) {
                            if let Err(error) = self
                                .run_integration_step(ctx, &params, step_impl, kind, id)
                                .await
                            {
                                result = Err(error);
                                break;
                            }
                        }
                        result
                    }
                };
                // A failing step fails alone: recorded, the others still run.
                if let Err(error) = outcome {
                    tracing::error!(%error, step = step_impl.name(), response = params.response_id, "forms: ProcessResponse step failed");
                }
            }
            Ok(())
        })
    }
}

/// The steps run in place, once each, as `inlineSteps` runs them where the
/// worker has no Workflow binding (and the tests run them): a failure is not
/// retried.
struct InlineSteps {
    key: String,
}

impl JobContext for InlineSteps {
    fn key(&self) -> &str {
        &self.key
    }

    fn run_step<'s>(
        &'s self,
        _name: &'s str,
        _retry: StepRetry,
        step: &'s weldsuite_ports::StepFn<'s>,
    ) -> BoxFuture<'s, Result<Value, JobError>> {
        step()
    }
}

impl ProcessResponseJob {
    /// `runProcessResponse(env, params, inlineSteps)`: the run, here and now.
    pub async fn run_inline(&self, params: &ProcessResponseParams) -> Result<(), JobError> {
        let payload = serde_json::to_value(params)?;
        let steps = InlineSteps {
            key: params.response_id.clone(),
        };
        self.run(&steps, payload).await
    }
}

/// The run's params as the Workflow binding gets them.
#[allow(dead_code)]
pub(crate) fn params_json(params: &ProcessResponseParams) -> Value {
    serde_json::to_value(params).unwrap_or_else(|_| json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_stamps_are_base36() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(1_700_000_000_000), "loyw3v28");
        assert_eq!(
            process_steps().iter().map(|s| s.name()).collect::<Vec<_>>(),
            ["crm", "desk", "flow", "notify", "receipt", "quota"]
        );
        let params = ProcessResponseParams {
            clerk_org_id: "org".to_owned(),
            workspace_id: "ws".to_owned(),
            form_id: "frm".to_owned(),
            response_id: "frs".to_owned(),
            mode: "submit".to_owned(),
            retry_integration_id: None,
        };
        assert_eq!(
            params_json(&params),
            json!({ "clerkOrgId": "org", "workspaceId": "ws", "formId": "frm", "responseId": "frs", "mode": "submit" })
        );
    }
}
