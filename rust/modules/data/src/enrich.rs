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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::id::generate_id;
use weldsuite_ports::{
    BoxFuture, DynJobs, Job, JobContext, JobError, JobRequest, OutboundHttp, StepRetry, step,
};
use weldsuite_schema::tenant::{welddata_cells, welddata_columns, welddata_leads};

use crate::actions::{
    ActionContext, ActionKeys, ActionResult, AiModel, WebPages, config_of, known_action, run_action,
};
use crate::js::js_lowercase;
use crate::service::{int4, js};

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
    /// The install's AI, for `ai` columns; `None` with AI off (the cells are
    /// done and empty, as the worker's stub leaves them).
    pub ai: Option<weldsuite_ai::Ai>,
    /// The master database: the `ai` cells' credit wallet.
    pub master: Option<PgPool>,
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
) -> Result<(), DbErr> {
    use welddata_cells::Column as Cell;
    let at = utc_now();
    let cell = welddata_cells::ActiveModel {
        id: Set(generate_id("wdcell")),
        created_at: Set(at),
        updated_at: Set(at),
        column_id: Set(column_id.to_owned()),
        lead_id: Set(lead_id.to_owned()),
        status: Set(patch.status.to_owned()),
        value: Set(patch.value.map(str::to_owned)),
        data: Set(patch.data.cloned()),
        error: Set(patch.error.map(str::to_owned)),
        credits_used: Set(patch.credits_used.map(int4).transpose()?),
        ran_at: Set(patch.ran.then_some(at)),
    };
    // The update takes the row's own values (`excluded`): those of the insert.
    welddata_cells::Entity::insert(cell)
        .on_conflict(
            OnConflict::columns([Cell::ColumnId, Cell::LeadId])
                .update_columns([
                    Cell::Status,
                    Cell::Value,
                    Cell::Data,
                    Cell::Error,
                    Cell::CreditsUsed,
                    Cell::RanAt,
                    Cell::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec_without_returning(&orm(db))
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
) -> Result<HashMap<String, String>, DbErr> {
    use welddata_cells::Column as Cell;
    use welddata_columns::Column as Col;
    let rows: Vec<(String, Option<String>)> = welddata_cells::Entity::find()
        .select_only()
        .column(Col::Name)
        .column(Cell::Value)
        .join(
            JoinType::InnerJoin,
            welddata_cells::Entity::belongs_to(welddata_columns::Entity)
                .from(Cell::ColumnId)
                .to(Col::Id)
                .into(),
        )
        .filter(Col::ListId.eq(list_id))
        .filter(Col::Id.ne(column_id))
        .filter(Col::DeletedAt.is_null())
        .filter(Cell::LeadId.eq(lead_id))
        .filter(Cell::Status.eq("done"))
        .into_tuple()
        .all(&orm(db))
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
    /// The model of a run's `ai` cells, for the run's workspace and member;
    /// `None` with AI off or for another kind of column.
    async fn ai_model(&self, db: &PgPool, params: &EnrichParams, kind: &str) -> Option<AiModel> {
        let ai = self.ai.clone().filter(|ai| ai.enabled() && kind == "ai")?;
        // The run carries the Clerk org id; the AI settings are keyed by `workspaces.id`.
        let workspace_id = match &self.master {
            Some(master) => weldsuite_core_domain::credits::resolve_internal_workspace_id(
                master,
                &params.workspace_id,
            )
            .await
            .ok()
            .flatten(),
            None => None,
        };
        Some(AiModel {
            ai,
            workspace_id: workspace_id.unwrap_or_else(|| params.workspace_id.clone()),
            user_id: params.user_id.clone(),
            tenant: Some(db.clone()),
            master: self.master.clone(),
        })
    }

    /// One lead: its cell `running`, the action, then `done` or `error`.
    async fn run_lead(
        &self,
        db: &PgPool,
        params: &EnrichParams,
        column: &Column,
        lead_id: &str,
        ai: Option<&AiModel>,
    ) {
        if let Err(message) = self.try_lead(db, params, column, lead_id, ai).await {
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
        ai: Option<&AiModel>,
    ) -> Result<(), String> {
        let lead = welddata_leads::Entity::find_by_id(lead_id)
            .filter(welddata_leads::Column::DeletedAt.is_null())
            .one(&orm(db))
            .await
            .and_then(|lead| lead.map(js).transpose())
            .map_err(|error| error.to_string())?;
        let Some(lead) = lead else {
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
            ai,
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
            let column: Option<(String, String, Option<Value>)> = welddata_columns::Entity::find()
                .select_only()
                .columns([
                    welddata_columns::Column::Id,
                    welddata_columns::Column::Type,
                    welddata_columns::Column::Config,
                ])
                .filter(welddata_columns::Column::Id.eq(params.column_id.as_str()))
                .filter(welddata_columns::Column::ListId.eq(params.list_id.as_str()))
                .filter(welddata_columns::Column::DeletedAt.is_null())
                .into_tuple()
                .one(&orm(&db))
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
            let model = self.ai_model(&db, &params, &column.kind).await;
            let retry = StepRetry::exponential(2, Duration::from_secs(5));
            for (index, chunk) in params.lead_ids.chunks(CHUNK).enumerate() {
                let name = format!("chunk-{index}");
                let (db, params, column, model) = (&db, &params, &column, model.as_ref());
                step(ctx, &name, retry, || async move {
                    for batch in chunk.chunks(CONCURRENCY) {
                        join_all(
                            batch
                                .iter()
                                .map(|lead_id| self.run_lead(db, params, column, lead_id, model)),
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
