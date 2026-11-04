//! Enrichment runs: where the run routes start them (`WELDDATA_ENRICH`),
//! and the `data.welddata-enrich` job that runs one, the
//! `WelddataEnrichWorkflow` of `packages/domains/data`: the column's
//! action over the target leads, in durable chunks of 25 (each a retried
//! step), five leads at a time, every cell written `running` then `done`
//! or `error`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::id::generate_id;
use weldsuite_ports::{
    BoxFuture, DynJobs, Job, JobContext, JobError, JobRequest, OutboundHttp, StepRetry, step,
};

use crate::actions::{
    ActionContext, ActionKeys, ActionResult, WebPages, config_of, known_action, run_action,
};
use crate::js::js_lowercase;
use crate::now;

/// The job's name (the Workflow, `WELDDATA_ENRICH`).
pub const WELDDATA_ENRICH_JOB: &str = "data.welddata-enrich";

/// `WELDDATA_ENRICH` as the routes use it.
pub trait EnrichRuns: Send + Sync {
    /// `WELDDATA_ENRICH.create(options)` (`options` is `{ params }`); `Err`
    /// with the message when the start fails.
    fn create<'a>(&'a self, options: &'a Value) -> BoxFuture<'a, Result<(), String>>;
}

/// A request's own `WELDDATA_ENRICH`, ahead of the jobs (conformance: the
/// test's binding through the harness, or `None` when the test has none, as
/// the worker then runs without it).
#[derive(Clone)]
pub struct RequestEnrichRuns(pub Option<Arc<dyn EnrichRuns>>);

/// The deployment's runs: `data.welddata-enrich` jobs, each under a key of
/// its own (a Workflow instance without an id gets a fresh one).
pub struct JobsEnrichRuns {
    pub jobs: Arc<dyn DynJobs>,
}

impl EnrichRuns for JobsEnrichRuns {
    fn create<'a>(&'a self, options: &'a Value) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let params = options.get("params").cloned().unwrap_or(Value::Null);
            let request = JobRequest::new(WELDDATA_ENRICH_JOB, generate_id("wdrun"), &params)
                .map_err(|error| error.to_string())?;
            self.jobs
                .start_boxed(request)
                .await
                .map_err(|error| error.to_string())
        })
    }
}

/// A workspace's tenant database by the run's `workspaceId` (the Clerk org
/// id), for the job, which runs outside any request.
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// The run's params (`WelddataEnrichParams`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnrichParams {
    /// The Clerk org id.
    pub(crate) workspace_id: String,
    pub(crate) user_id: String,
    pub(crate) list_id: String,
    pub(crate) column_id: String,
    pub(crate) lead_ids: Vec<String>,
}

/// Leads per durable step.
const CHUNK: usize = 25;
/// Leads run at once within a step.
const CONCURRENCY: usize = 5;

/// The `data.welddata-enrich` job.
pub struct WelddataEnrichJob {
    pub tenants: TenantDatabases,
    /// Findymail and Prospeo.
    pub http: OutboundHttp,
    /// Company websites, for the phone finder.
    pub pages: Arc<dyn WebPages>,
    pub keys: ActionKeys,
}

/// The column a run is for.
struct Column {
    id: String,
    kind: String,
    config: Value,
}

/// A cell's new state (`writeCell`'s patch).
struct CellWrite<'a> {
    status: &'a str,
    value: Option<&'a str>,
    data: Option<&'a Value>,
    error: Option<&'a str>,
    credits_used: Option<i64>,
    ran: bool,
}

impl CellWrite<'_> {
    const RUNNING: CellWrite<'static> = CellWrite {
        status: "running",
        value: None,
        data: None,
        error: None,
        credits_used: None,
        ran: false,
    };

    fn error(message: &str) -> CellWrite<'_> {
        CellWrite {
            status: "error",
            value: None,
            data: None,
            error: Some(message),
            credits_used: None,
            ran: true,
        }
    }
}

/// `writeCell(db, columnId, leadId, patch)`: the cell, created or updated.
async fn write_cell(
    db: &PgPool,
    column_id: &str,
    lead_id: &str,
    patch: &CellWrite<'_>,
) -> Result<(), sqlx::Error> {
    let at = now();
    sqlx::query(
        "insert into welddata_cells
           (id, created_at, updated_at, column_id, lead_id, status, value, data, error, credits_used, ran_at)
         values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, $7, $8, $9::int, $10::timestamp)
         on conflict (column_id, lead_id) do update set
           status = $5, value = $6, data = $7, error = $8, credits_used = $9::int,
           ran_at = $10::timestamp, updated_at = $2::timestamp",
    )
    .bind(generate_id("wdcell"))
    .bind(&at)
    .bind(column_id)
    .bind(lead_id)
    .bind(patch.status)
    .bind(patch.value)
    .bind(patch.data)
    .bind(patch.error)
    .bind(patch.credits_used)
    .bind(patch.ran.then_some(at.as_str()))
    .execute(db)
    .await?;
    Ok(())
}

/// `buildSiblingValues(db, listId, columnId, leadId)`: the lead's done
/// values in the list's other live columns, by lowercased column name.
async fn sibling_values(
    db: &PgPool,
    list_id: &str,
    column_id: &str,
    lead_id: &str,
) -> Result<HashMap<String, String>, sqlx::Error> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "select c.name, cell.value from welddata_cells cell
         join welddata_columns c on c.id = cell.column_id
         where c.list_id = $1 and c.id <> $2 and c.deleted_at is null
           and cell.lead_id = $3 and cell.status = 'done'",
    )
    .bind(list_id)
    .bind(column_id)
    .bind(lead_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(name, _)| !name.is_empty())
        .filter_map(|(name, value)| {
            value
                .filter(|v| !v.is_empty())
                .map(|v| (js_lowercase(&name), v))
        })
        .collect())
}

impl WelddataEnrichJob {
    /// One lead: its cell `running`, the action, then `done` or `error`.
    async fn run_lead(&self, db: &PgPool, params: &EnrichParams, column: &Column, lead_id: &str) {
        if let Err(message) = self.try_lead(db, params, column, lead_id).await {
            let written = write_cell(db, &column.id, lead_id, &CellWrite::error(&message)).await;
            if let Err(error) = written {
                tracing::warn!(%error, "welddata-enrich: writing an error cell failed");
            }
        }
    }

    async fn try_lead(
        &self,
        db: &PgPool,
        params: &EnrichParams,
        column: &Column,
        lead_id: &str,
    ) -> Result<(), String> {
        let lead: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from welddata_leads t where t.id = $1 and t.deleted_at is null limit 1",
        )
        .bind(lead_id)
        .fetch_optional(db)
        .await
        .map_err(|error| error.to_string())?;
        let Some(lead) = lead.map(js_row) else {
            return Ok(());
        };
        if !known_action(&column.kind) {
            let message = format!("Unknown action type: {}", column.kind);
            return write_cell(db, &column.id, lead_id, &CellWrite::error(&message))
                .await
                .map_err(|error| error.to_string());
        }
        write_cell(db, &column.id, lead_id, &CellWrite::RUNNING)
            .await
            .map_err(|error| error.to_string())?;
        let siblings = sibling_values(db, &params.list_id, &column.id, lead_id)
            .await
            .map_err(|error| error.to_string())?;
        let ctx = ActionContext {
            keys: &self.keys,
            http: &self.http,
            pages: self.pages.as_ref(),
            config: &column.config,
            lead: &lead,
            siblings: &siblings,
        };
        let ActionResult {
            value,
            data,
            credits_used,
        } = run_action(&column.kind, &ctx).await?;
        let done = CellWrite {
            status: "done",
            value: Some(&value),
            data: data.as_ref(),
            error: None,
            credits_used,
            ran: true,
        };
        write_cell(db, &column.id, lead_id, &done)
            .await
            .map_err(|error| error.to_string())
    }
}

impl Job for WelddataEnrichJob {
    fn name(&self) -> &'static str {
        WELDDATA_ENRICH_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params: EnrichParams = serde_json::from_value(payload)?;
            let db = (self.tenants)(params.workspace_id.clone())
                .await
                .map_err(JobError::Failed)?;
            // Read outside a step: cheap and idempotent.
            let column: Option<(String, String, Option<Value>)> = sqlx::query_as(
                "select id, type, config from welddata_columns
                 where id = $1 and list_id = $2 and deleted_at is null limit 1",
            )
            .bind(&params.column_id)
            .bind(&params.list_id)
            .fetch_optional(&db)
            .await
            .map_err(JobError::failed)?;
            let Some((id, kind, config)) = column else {
                return Ok(());
            };
            let column = Column {
                id,
                kind,
                config: config_of(config.as_ref()),
            };
            let retry = StepRetry::exponential(2, Duration::from_secs(5));
            for (index, chunk) in params.lead_ids.chunks(CHUNK).enumerate() {
                let name = format!("chunk-{index}");
                let (db, params, column) = (&db, &params, &column);
                step(ctx, &name, retry, || async move {
                    for batch in chunk.chunks(CONCURRENCY) {
                        join_all(
                            batch
                                .iter()
                                .map(|lead_id| self.run_lead(db, params, column, lead_id)),
                        )
                        .await;
                    }
                    Ok(())
                })
                .await?;
            }
            Ok(())
        })
    }
}
