//! The planning run: the `stash.replenishment-run` job, which plans every
//! item of a workspace and stores the plans in `stash_item_plans`
//! (`weldsuite-documentation/plans/weldstash-replenishment.md`, "Run").
//!
//! A run is a `stash_planning_runs` row and one job keyed by it. One run
//! per workspace at a time: [`start_run`] answers the running one instead of
//! starting a second (a run still `running` after six hours is taken for
//! lost, marked failed, and no longer blocks; should it still be going, it
//! writes nothing more, as every chunk's write and the finish first check,
//! under a lock, that their run is still the current one). It is started by
//! `POST /replenishment/runs` and by `weldsuite cron stash-replenishment`
//! ([`run_replenishment_sweep`]), which sweeps the master due index (kind
//! [`SWEEP_KIND`]) and plans each enabled workspace once a day at its
//! `run_hour_utc`.
//!
//! The job's steps:
//!
//! 1. `setup`: today, the settings, the demand warehouse, the active
//!    warehouses, and the products cut into chunks of about 250 items (a
//!    product and its variants, each in every active warehouse, stay in one
//!    chunk).
//! 2. `plan-<n>`, one per chunk: the inputs and plans of the chunk's items
//!    ([`super::demand::plan_items`]), and an upsert of their plans on
//!    `item_key` with the review rules of [`super::review`], under a row
//!    lock so a dismissal made meanwhile is not lost. Items with no demand,
//!    stock, incoming stock, open demand or rule (and no plan under review)
//!    get no plan; items whose rule is `off` neither.
//! 3. `finish`: plans the run didn't write are deleted (products deleted or
//!    no longer tracked, inactive warehouses, `off` rules, items gone
//!    quiet), the run row is closed with its counts, and runs older than 90
//!    days are deleted.
//! 4. `announce`: `replenishment_run` `completed`.
//! 5. `notify`: when items newly need reordering, an in-app notification to
//!    the members who may manage inventory, at most one a day each.
//!
//! A step that fails after its retries marks the run `failed` with the
//! error and publishes `replenishment_run` `failed`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration as StdDuration;

use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime, Time, UtcOffset};
use weldsuite_catalogs::entity_events::{
    REPLENISHMENT_RUN_COMPLETED, REPLENISHMENT_RUN_CREATED, REPLENISHMENT_RUN_FAILED,
};
use weldsuite_catalogs::permission_keys::INVENTORY_MANAGE;
use weldsuite_db::TenantPermissionQueries;
use weldsuite_db::due_index::{SweepResult, run_sweep};
use weldsuite_events::{EntityEventPublisher, EventContext, EventSource, publish_entity_event};
use weldsuite_kit::generate_id;
use weldsuite_notifications::{NewNotification, Notifier, create_and_deliver};
use weldsuite_permissions::{has_app_permission, resolve_effective_permissions};
use weldsuite_ports::{
    BoxFuture, DynJobs, Job, JobContext, JobError, JobRequest, PortError, StepRetry, step,
};

use super::demand::{Item, ItemPlan, Planning, plan_items, ymd};
use super::review::{Prior, Review, next_review};
use super::settings::{demand_warehouse, from_json, load_settings, settings_json};
use crate::incoming::parse_date;
use crate::now;

/// The job's name.
pub const REPLENISHMENT_RUN_JOB: &str = "stash.replenishment-run";

/// The master due index kind of the nightly runs (rows keyed by
/// `workspaces.id`).
pub const SWEEP_KIND: &str = "stash_replenishment";

/// Items per `plan-<n>` step.
const CHUNK_ITEMS: usize = 250;

/// The longest a `stash_planning_runs.error` can be.
const MAX_ERROR_LEN: usize = 1000;

/// The planning run of a workspace's tenant database outside a request, by
/// its id.
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// The tenant database and Clerk org id (when it has one) of a workspace,
/// by its id: what the nightly sweep starts runs with.
pub type SweepTenants = Arc<
    dyn Fn(String) -> BoxFuture<'static, Result<(PgPool, Option<String>), String>> + Send + Sync,
>;

/// The registered job.
pub struct ReplenishmentRunJob {
    pub tenants: TenantDatabases,
    pub events: EntityEventPublisher,
    /// The "items to reorder" notifications (in-app over realtime).
    pub notifier: Notifier,
}

impl std::fmt::Debug for ReplenishmentRunJob {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReplenishmentRunJob")
            .field("events", &self.events)
            .field("notifier", &self.notifier)
            .finish_non_exhaustive()
    }
}

// ── Starting ────────────────────────────────────────────────────────────────

/// Who starts a run, for what.
#[derive(Debug, Clone)]
pub(crate) struct RunStart {
    /// `workspaces.id` (the job's tenant).
    pub(crate) workspace_id: String,
    /// For the events' workspace and the realtime hub.
    pub(crate) clerk_org_id: Option<String>,
    /// `manual` or `schedule`.
    pub(crate) trigger: &'static str,
    /// The member who asked for it; `None` for the schedule.
    pub(crate) started_by: Option<String>,
}

/// What [`start_run`] did.
#[derive(Debug)]
pub(crate) enum Started {
    /// A new run, its job started.
    New(Value),
    /// The run that is already running.
    Running(Value),
}

/// Why a run could not start.
#[derive(Debug)]
pub(crate) enum StartError {
    Database(sqlx::Error),
    Jobs(PortError),
}

impl From<sqlx::Error> for StartError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => error.fmt(f),
            Self::Jobs(error) => write!(f, "jobs: {error}"),
        }
    }
}

/// Start a planning run unless one is running: the run row (inserted with
/// `replenishment_run` `created`, then its job started) or the running one.
pub(crate) async fn start_run(
    db: &PgPool,
    jobs: &dyn DynJobs,
    events: &EntityEventPublisher,
    start: &RunStart,
) -> Result<Started, StartError> {
    let id = generate_id("prun");
    let at = now();
    let trigger = start.trigger;
    let started_by = start.started_by.clone();
    let row_id = id.clone();
    let started = weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            sqlx::query(RUNS_LOCK).execute(&mut *conn).await?;
            sqlx::query(
                "update stash_planning_runs set status = 'failed', finished_at = $1::timestamp, \
                 error = 'The run stopped without finishing' \
                 where status = 'running' and started_at < $1::timestamp - interval '6 hours'",
            )
            .bind(&at)
            .execute(&mut *conn)
            .await?;
            let running: Option<Value> = sqlx::query_scalar(
                "select to_jsonb(t) from stash_planning_runs t where t.status = 'running' \
                 order by t.started_at desc, t.id desc limit 1",
            )
            .fetch_optional(&mut *conn)
            .await?;
            if let Some(running) = running {
                return Ok::<_, sqlx::Error>(Started::Running(weldsuite_db::js_row(running)));
            }
            let row: Value = sqlx::query_scalar(
                "insert into stash_planning_runs as t (id, created_at, trigger, status, started_at, \
                 started_by) values ($1, $2::timestamp, $3, 'running', $2::timestamp, $4) \
                 returning to_jsonb(t)",
            )
            .bind(&row_id)
            .bind(&at)
            .bind(trigger)
            .bind(started_by.as_deref())
            .fetch_one(&mut *conn)
            .await?;
            Ok(Started::New(weldsuite_db::js_row(row)))
        })
    })
    .await?;
    if let Started::New(row) = &started {
        let params = RunParams {
            workspace_id: start.workspace_id.clone(),
            clerk_org_id: start.clerk_org_id.clone(),
            run_id: id.clone(),
            started_by: start.started_by.clone(),
        };
        publish_entity_event(
            events,
            &params.event_context(),
            REPLENISHMENT_RUN_CREATED,
            id.as_str(),
            &run_event(row),
        );
        let request = JobRequest {
            name: REPLENISHMENT_RUN_JOB.to_owned(),
            key: format!("{}:{id}", start.workspace_id),
            payload: params.to_json(),
            delay: None,
        };
        if let Err(error) = jobs.start_boxed(request).await {
            let message = format!("The run could not be started: {error}");
            if let Some(failed) = fail_run(db, &id, &message).await? {
                publish_entity_event(
                    events,
                    &params.event_context(),
                    REPLENISHMENT_RUN_FAILED,
                    id.as_str(),
                    &run_event(&failed),
                );
            }
            return Err(StartError::Jobs(error));
        }
    }
    Ok(started)
}

/// The data of a `replenishment_run` event.
fn run_event(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "trigger": row["trigger"],
        "status": row["status"],
        "itemsPlanned": row["itemsPlanned"],
        "itemsToReorder": row["itemsToReorder"],
        "error": row["error"],
    })
}

/// Mark the run failed with `message` (cut to the column's length).
async fn fail_run(db: &PgPool, run_id: &str, message: &str) -> Result<Option<Value>, sqlx::Error> {
    let error: String = message.chars().take(MAX_ERROR_LEN).collect();
    let row: Option<Value> = sqlx::query_scalar(
        "update stash_planning_runs t set status = 'failed', finished_at = $2::timestamp, \
         error = $3 where t.id = $1 returning to_jsonb(t)",
    )
    .bind(run_id)
    .bind(now())
    .bind(error)
    .fetch_optional(db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

// ── The job ─────────────────────────────────────────────────────────────────

/// The job's payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunParams {
    pub(crate) workspace_id: String,
    pub(crate) clerk_org_id: Option<String>,
    pub(crate) run_id: String,
    pub(crate) started_by: Option<String>,
}

impl RunParams {
    fn to_json(&self) -> Value {
        json!({
            "workspaceId": self.workspace_id,
            "clerkOrgId": self.clerk_org_id,
            "runId": self.run_id,
            "startedBy": self.started_by,
        })
    }

    fn read(payload: &Value) -> Result<Self, JobError> {
        let text = |key: &str| {
            payload[key]
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let (Some(workspace_id), Some(run_id)) = (text("workspaceId"), text("runId")) else {
            return Err(JobError::failed(
                "stash.replenishment-run: the payload needs workspaceId and runId",
            ));
        };
        Ok(Self {
            workspace_id,
            clerk_org_id: text("clerkOrgId"),
            run_id,
            started_by: text("startedBy"),
        })
    }

    /// The events' context: the Clerk org id when the workspace has one,
    /// the member who started the run (or `system`).
    fn event_context(&self) -> EventContext {
        EventContext::new(
            self.clerk_org_id
                .clone()
                .unwrap_or_else(|| self.workspace_id.clone()),
            self.started_by
                .clone()
                .unwrap_or_else(|| "system".to_owned()),
            EventSource::System,
        )
    }
}

impl Job for ReplenishmentRunJob {
    fn name(&self) -> &'static str {
        REPLENISHMENT_RUN_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params = RunParams::read(&payload)?;
            let db = (self.tenants)(params.workspace_id.clone())
                .await
                .map_err(JobError::failed)?;
            let result = self.plan(ctx, &db, &params).await;
            if let Err(error) = &result {
                let message = error.to_string();
                step(ctx, "fail", StepRetry::default(), || async {
                    let row = fail_run(&db, &params.run_id, &message)
                        .await
                        .map_err(JobError::failed)?;
                    let data = row.as_ref().map_or_else(
                        || json!({ "id": params.run_id, "status": "failed", "error": message }),
                        run_event,
                    );
                    publish_entity_event(
                        &self.events,
                        &params.event_context(),
                        REPLENISHMENT_RUN_FAILED,
                        params.run_id.as_str(),
                        &data,
                    );
                    Ok(())
                })
                .await?;
            }
            result
        })
    }
}

/// What the `setup` step hands the others.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Setup {
    pub(crate) today: Date,
    /// The settings row (or its defaults), as the route returns it.
    pub(crate) settings: Value,
    pub(crate) demand_warehouse: Option<String>,
    pub(crate) warehouses: Vec<String>,
    /// First and last product id of each chunk.
    pub(crate) chunks: Vec<(String, String)>,
}

impl Setup {
    fn to_json(&self) -> Value {
        json!({
            "today": ymd(self.today),
            "settings": self.settings,
            "demandWarehouse": self.demand_warehouse,
            "warehouses": self.warehouses,
            "chunks": self.chunks.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>(),
        })
    }

    fn from_json(value: &Value) -> Result<Self, JobError> {
        let today = value["today"]
            .as_str()
            .and_then(parse_date)
            .ok_or_else(|| JobError::failed("setup: no date"))?;
        let strings = |items: &Value| -> Vec<String> {
            items
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        };
        let chunks = value["chunks"]
            .as_array()
            .map(|chunks| {
                chunks
                    .iter()
                    .filter_map(|chunk| {
                        Some((
                            chunk.get(0)?.as_str()?.to_owned(),
                            chunk.get(1)?.as_str()?.to_owned(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self {
            today,
            settings: value["settings"].clone(),
            demand_warehouse: value["demandWarehouse"].as_str().map(str::to_owned),
            warehouses: strings(&value["warehouses"]),
            chunks,
        })
    }

    pub(crate) fn planning(&self) -> Planning {
        Planning {
            today: self.today,
            settings: from_json(&self.settings),
            demand_warehouse: self.demand_warehouse.clone(),
        }
    }
}

/// What a `plan-<n>` step did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ChunkCounts {
    pub(crate) planned: i64,
    pub(crate) newly_open: i64,
}

impl ReplenishmentRunJob {
    async fn plan(
        &self,
        ctx: &dyn JobContext,
        db: &PgPool,
        params: &RunParams,
    ) -> Result<(), JobError> {
        let setup: Value = step(ctx, "setup", StepRetry::default(), || async {
            let today = OffsetDateTime::now_utc().date();
            Ok(setup(db, today).await.map_err(JobError::failed)?.to_json())
        })
        .await?;
        let setup = Setup::from_json(&setup)?;
        let planning = setup.planning();
        let mut totals = ChunkCounts::default();
        for (index, (first, last)) in setup.chunks.iter().enumerate() {
            let name = format!("plan-{index}");
            let counts: Value = step(
                ctx,
                &name,
                StepRetry::exponential(3, StdDuration::from_secs(10)),
                || async {
                    let counts = plan_chunk(
                        db,
                        &planning,
                        &setup.warehouses,
                        (first, last),
                        &params.run_id,
                    )
                    .await
                    .map_err(JobError::failed)?;
                    Ok(counts.map_or_else(
                        || json!({ "superseded": true }),
                        |counts| {
                            json!({ "planned": counts.planned, "newlyOpen": counts.newly_open })
                        },
                    ))
                },
            )
            .await?;
            if counts["superseded"] == json!(true) {
                // Taken for lost and failed by a later start, which plans
                // from here: stop without writing more.
                return Ok(());
            }
            totals.planned += counts["planned"].as_i64().unwrap_or(0);
            totals.newly_open += counts["newlyOpen"].as_i64().unwrap_or(0);
        }
        let run: Value = step(ctx, "finish", StepRetry::default(), || async {
            finish_run(db, &params.run_id, totals.planned)
                .await
                .map_err(JobError::failed)
        })
        .await?;
        if run.is_null() {
            // Taken for lost and failed by a later start: nothing to announce.
            return Ok(());
        }
        step(ctx, "announce", StepRetry::default(), || async {
            publish_entity_event(
                &self.events,
                &params.event_context(),
                REPLENISHMENT_RUN_COMPLETED,
                params.run_id.as_str(),
                &run_event(&run),
            );
            Ok(())
        })
        .await?;
        if totals.newly_open > 0 {
            let _sent: i64 = step(ctx, "notify", StepRetry::default(), || async {
                let hub = params
                    .clerk_org_id
                    .clone()
                    .unwrap_or_else(|| params.workspace_id.clone());
                let sent = notify_reorder(
                    db,
                    &self.notifier,
                    &hub,
                    params.clerk_org_id.as_deref(),
                    &params.run_id,
                    totals.newly_open,
                )
                .await
                .map_err(JobError::failed)?;
                Ok(i64::try_from(sent).unwrap_or(i64::MAX))
            })
            .await?;
        }
        Ok(())
    }
}

// ── Steps ───────────────────────────────────────────────────────────────────

/// Plannable rows per product (the product itself and its tracked live
/// variants), in id order.
const PRODUCT_ROWS: &str = "select p.id, (1 + count(v.id))::bigint from products p \
     left join product_variants v on v.product_id = p.id and v.deleted_at is null \
       and coalesce(v.track_inventory, true) \
     where p.deleted_at is null and coalesce(p.track_inventory, true) \
     group by p.id order by p.id";

/// The plannable products and variants with an id in `[$1, $2]`.
const CHUNK_ROWS: &str = "select p.id, null::text from products p \
     where p.deleted_at is null and coalesce(p.track_inventory, true) and p.id >= $1 and p.id <= $2 \
     union all \
     select v.product_id, v.id from product_variants v join products p on p.id = v.product_id \
     where v.deleted_at is null and coalesce(v.track_inventory, true) \
       and p.deleted_at is null and coalesce(p.track_inventory, true) and p.id >= $1 and p.id <= $2 \
     order by 1, 2 nulls first";

/// Step 1.
pub(crate) async fn setup(db: &PgPool, today: Date) -> Result<Setup, sqlx::Error> {
    let settings = settings_json(db).await?;
    let demand = demand_warehouse(db, &from_json(&settings)).await?;
    let warehouses: Vec<String> = sqlx::query_scalar(
        "select id from warehouses where deleted_at is null and coalesce(is_active, true) order by id",
    )
    .fetch_all(db)
    .await?;
    let rows: Vec<(String, i64)> = sqlx::query_as(PRODUCT_ROWS).fetch_all(db).await?;
    let chunks = chunk_ranges(&rows, warehouses.len(), CHUNK_ITEMS);
    Ok(Setup {
        today,
        settings,
        demand_warehouse: demand,
        warehouses,
        chunks,
    })
}

/// Products cut into id ranges of about `target` items (rows × warehouses);
/// a product's rows stay together, so a product with more than `target`
/// items is a chunk of its own.
pub(crate) fn chunk_ranges(
    rows: &[(String, i64)],
    warehouses: usize,
    target: usize,
) -> Vec<(String, String)> {
    if warehouses == 0 {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut current: Option<(&str, &str, usize)> = None;
    for (id, count) in rows {
        let items = usize::try_from(*count).unwrap_or(1).max(1) * warehouses;
        current = match current {
            Some((first, last, size)) if size + items > target => {
                chunks.push((first.to_owned(), last.to_owned()));
                Some((id.as_str(), id.as_str(), items))
            }
            Some((first, _, size)) => Some((first, id.as_str(), size + items)),
            None => Some((id.as_str(), id.as_str(), items)),
        };
    }
    if let Some((first, last, _)) = current {
        chunks.push((first.to_owned(), last.to_owned()));
    }
    chunks
}

/// A plan's review columns, locked for the chunk's transaction.
type PriorRow = (
    String,
    String,
    String,
    Option<String>,
    bool,
    Option<String>,
    Option<i64>,
    Option<String>,
);

/// Serialises the writers of runs: [`start_run`], each chunk's write and
/// [`finish_run`] take it first, for their transaction.
const RUNS_LOCK: &str = "select pg_advisory_xact_lock(hashtext('stash_planning_runs'))";

/// In a transaction: take [`RUNS_LOCK`], lock the run row and say whether
/// `run_id` is still the workspace's current run (`running`, and the
/// latest run that is). A run a later start took for lost is not: it must
/// write nothing more, or the later run's [`finish_run`] would delete what
/// it wrote along with the review state on those rows.
pub(crate) async fn hold_current_run(
    conn: &mut sqlx::PgConnection,
    run_id: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query(RUNS_LOCK).execute(&mut *conn).await?;
    let status: Option<String> =
        sqlx::query_scalar("select status from stash_planning_runs where id = $1 for update")
            .bind(run_id)
            .fetch_optional(&mut *conn)
            .await?;
    if status.as_deref() != Some("running") {
        return Ok(false);
    }
    let current: Option<String> = sqlx::query_scalar(
        "select id from stash_planning_runs where status = 'running' \
         order by started_at desc, id desc limit 1",
    )
    .fetch_optional(&mut *conn)
    .await?;
    Ok(current.as_deref() == Some(run_id))
}

/// Whether `run_id` is the current run now (a cheap check before the work
/// of a chunk; the write checks again under the lock).
async fn is_current_run(db: &PgPool, run_id: &str) -> Result<bool, sqlx::Error> {
    let run_id = run_id.to_owned();
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move { hold_current_run(conn, &run_id).await })
    })
    .await
}

/// Step 2 for the products in `range`, each in every one of `warehouses`.
/// `None` when the run is no longer the current one: nothing is written.
pub(crate) async fn plan_chunk(
    db: &PgPool,
    planning: &Planning,
    warehouses: &[String],
    range: (&str, &str),
    run_id: &str,
) -> Result<Option<ChunkCounts>, sqlx::Error> {
    if !is_current_run(db, run_id).await? {
        return Ok(None);
    }
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(CHUNK_ROWS)
        .bind(range.0)
        .bind(range.1)
        .fetch_all(db)
        .await?;
    let mut items = Vec::with_capacity(rows.len() * warehouses.len());
    for (product_id, variant_id) in rows {
        for warehouse in warehouses {
            items.push(Item {
                product_id: product_id.clone(),
                variant_id: variant_id.clone(),
                warehouse_id: warehouse.clone(),
            });
        }
    }
    let plans = plan_items(db, planning, items).await?;
    write_plans(db, plans, run_id).await
}

/// Upsert `plans` with their review state, all or nothing, while
/// `run_id` is the current run ([`hold_current_run`]); `None` (nothing
/// written) once it is not.
pub(crate) async fn write_plans(
    db: &PgPool,
    plans: Vec<ItemPlan>,
    run_id: &str,
) -> Result<Option<ChunkCounts>, sqlx::Error> {
    let at = now();
    let run_id = run_id.to_owned();
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            if !hold_current_run(conn, &run_id).await? {
                return Ok(None);
            }
            let keys: Vec<String> = plans.iter().map(|plan| plan.key.clone()).collect();
            let priors: Vec<PriorRow> = sqlx::query_as(
                "select item_key, id, review_status, \
                 to_char(dismissed_until, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), \
                 coalesce(dismissed_until <= $2::timestamp, false), dismissed_by, \
                 dismissed_qty::bigint, purchase_order_id \
                 from stash_item_plans where item_key = any($1) order by item_key for update",
            )
            .bind(&keys)
            .bind(&at)
            .fetch_all(&mut *conn)
            .await?;
            let mut prior_by_key: HashMap<String, (String, Prior)> = HashMap::new();
            for (key, id, status, until, over, by, qty, order) in priors {
                prior_by_key.insert(
                    key,
                    (
                        id,
                        Prior {
                            status,
                            dismissed_until: until,
                            dismissal_over: over,
                            dismissed_by: by,
                            dismissed_qty: qty,
                            purchase_order_id: order,
                        },
                    ),
                );
            }
            let ordered: Vec<String> = prior_by_key
                .values()
                .filter(|(_, prior)| prior.status == "ordered")
                .filter_map(|(_, prior)| prior.purchase_order_id.clone())
                .collect();
            let open_orders: HashSet<String> = if ordered.is_empty() {
                HashSet::new()
            } else {
                sqlx::query_scalar::<_, String>(
                    "select id from purchase_orders where id = any($1) and deleted_at is null \
                     and coalesce(status, '') not in ('received', 'closed', 'cancelled')",
                )
                .bind(&ordered)
                .fetch_all(&mut *conn)
                .await?
                .into_iter()
                .collect()
            };
            let mut counts = ChunkCounts::default();
            let mut rows = Vec::new();
            for plan in &plans {
                let prior = prior_by_key.get(&plan.key);
                let under_review = prior.is_some_and(|(_, prior)| prior.status != "none");
                if plan.rule_off || !(plan.active || under_review) {
                    continue;
                }
                let order_done = prior
                    .and_then(|(_, prior)| prior.purchase_order_id.as_ref())
                    .is_none_or(|order| !open_orders.contains(order));
                let review = next_review(
                    prior.map(|(_, prior)| prior),
                    plan.output.suggested_qty,
                    order_done,
                );
                counts.planned += 1;
                if review.newly_open {
                    counts.newly_open += 1;
                }
                let id = prior.map_or_else(|| generate_id("iplan"), |(id, _)| id.clone());
                rows.push(plan_row(plan, &id, &run_id, &at, &review));
            }
            if !rows.is_empty() {
                sqlx::query(UPSERT)
                    .bind(Value::Array(rows))
                    .execute(&mut *conn)
                    .await?;
            }
            Ok(Some(counts))
        })
    })
    .await
}

/// Insert or update plans from a JSON array of rows (`snake_case` columns).
const UPSERT: &str = "insert into stash_item_plans (id, created_at, updated_at, item_key, \
     product_id, variant_id, warehouse_id, run_id, computed_at, method, confidence, history_days, \
     nonzero_days, avg_daily_demand, demand_std_dev, seasonality, forecast_30d, forecast_90d, \
     lead_time_days, review_period_days, service_level, product_supplier_id, supplier_id, \
     safety_stock, reorder_point, order_up_to, on_hand, allocated, incoming, open_demand, \
     inventory_position, days_of_cover, stockout_date, suggested_qty, suggested_value, \
     review_status, dismissed_until, dismissed_by, dismissed_qty, purchase_order_id) \
     select r.id, r.created_at, r.updated_at, r.item_key, r.product_id, r.variant_id, \
     r.warehouse_id, r.run_id, r.computed_at, r.method, r.confidence, r.history_days, \
     r.nonzero_days, r.avg_daily_demand, r.demand_std_dev, r.seasonality, r.forecast_30d, \
     r.forecast_90d, r.lead_time_days, r.review_period_days, r.service_level, \
     r.product_supplier_id, r.supplier_id, r.safety_stock, r.reorder_point, r.order_up_to, \
     r.on_hand, r.allocated, r.incoming, r.open_demand, r.inventory_position, r.days_of_cover, \
     r.stockout_date, r.suggested_qty, r.suggested_value, r.review_status, r.dismissed_until, \
     r.dismissed_by, r.dismissed_qty, r.purchase_order_id \
     from jsonb_populate_recordset(null::stash_item_plans, $1::jsonb) r \
     on conflict (item_key) do update set updated_at = excluded.updated_at, \
     product_id = excluded.product_id, variant_id = excluded.variant_id, \
     warehouse_id = excluded.warehouse_id, run_id = excluded.run_id, \
     computed_at = excluded.computed_at, method = excluded.method, \
     confidence = excluded.confidence, history_days = excluded.history_days, \
     nonzero_days = excluded.nonzero_days, avg_daily_demand = excluded.avg_daily_demand, \
     demand_std_dev = excluded.demand_std_dev, seasonality = excluded.seasonality, \
     forecast_30d = excluded.forecast_30d, forecast_90d = excluded.forecast_90d, \
     lead_time_days = excluded.lead_time_days, review_period_days = excluded.review_period_days, \
     service_level = excluded.service_level, product_supplier_id = excluded.product_supplier_id, \
     supplier_id = excluded.supplier_id, safety_stock = excluded.safety_stock, \
     reorder_point = excluded.reorder_point, order_up_to = excluded.order_up_to, \
     on_hand = excluded.on_hand, allocated = excluded.allocated, incoming = excluded.incoming, \
     open_demand = excluded.open_demand, inventory_position = excluded.inventory_position, \
     days_of_cover = excluded.days_of_cover, stockout_date = excluded.stockout_date, \
     suggested_qty = excluded.suggested_qty, suggested_value = excluded.suggested_value, \
     review_status = excluded.review_status, dismissed_until = excluded.dismissed_until, \
     dismissed_by = excluded.dismissed_by, dismissed_qty = excluded.dismissed_qty, \
     purchase_order_id = excluded.purchase_order_id";

/// A number for a `numeric` column, rounded to `places` (null when there is
/// none).
fn decimal(value: Option<f64>, places: i32) -> Value {
    value
        .filter(|value| value.is_finite())
        .map_or(Value::Null, |value| {
            let scale = 10_f64.powi(places);
            json!((value * scale).round() / scale)
        })
}

/// An integer column: within `int4`.
fn int4(value: i64) -> Value {
    json!(value.clamp(-super::engine::MAX_QUANTITY, super::engine::MAX_QUANTITY))
}

/// The row of `plan` for [`UPSERT`].
fn plan_row(plan: &ItemPlan, id: &str, run_id: &str, at: &str, review: &Review) -> Value {
    let out = &plan.output;
    let input = &plan.input;
    json!({
        "id": id,
        "created_at": at,
        "updated_at": at,
        "item_key": plan.key,
        "product_id": plan.item.product_id,
        "variant_id": plan.item.variant_id,
        "warehouse_id": plan.item.warehouse_id,
        "run_id": run_id,
        "computed_at": at,
        "method": out.method.as_str(),
        "confidence": out.confidence.as_str(),
        "history_days": int4(out.history_days),
        "nonzero_days": int4(out.nonzero_days),
        "avg_daily_demand": decimal(out.avg_daily_demand, 4),
        "demand_std_dev": decimal(out.demand_std_dev, 4),
        "seasonality": out.seasonality.map(|indices| {
            indices.iter().map(|index| decimal(Some(*index), 4)).collect::<Vec<_>>()
        }),
        "forecast_30d": decimal(out.forecast_30d, 4),
        "forecast_90d": decimal(out.forecast_90d, 4),
        "lead_time_days": int4(input.lead_time_days),
        "review_period_days": int4(input.review_period_days),
        "service_level": decimal(Some(input.service_level.clamp(0.5, 0.999)), 3),
        "product_supplier_id": plan.product_supplier_id,
        "supplier_id": plan.supplier_id,
        "safety_stock": out.safety_stock.map(int4),
        "reorder_point": out.reorder_point.map(int4),
        "order_up_to": out.order_up_to.map(int4),
        "on_hand": int4(input.position.on_hand),
        "allocated": int4(input.position.allocated),
        "incoming": int4(input.position.incoming),
        "open_demand": int4(input.position.open_demand),
        "inventory_position": int4(out.inventory_position),
        "days_of_cover": decimal(out.days_of_cover, 1),
        "stockout_date": out.stockout_date.map(ymd),
        "suggested_qty": int4(out.suggested_qty),
        "suggested_value": decimal(out.suggested_value, 2),
        "review_status": review.status,
        "dismissed_until": review.dismissed_until,
        "dismissed_by": review.dismissed_by,
        "dismissed_qty": review.dismissed_qty.map(int4),
        "purchase_order_id": review.purchase_order_id,
    })
}

/// Step 3: drop the plans this run didn't write, close the run, prune old
/// runs. `null` when the run is no longer the current one
/// ([`hold_current_run`]; a later start took it for lost): then nothing is
/// deleted. Under the lock no superseded run writes any more, so the plans
/// without this run's id are the items it found out of scope; a plan
/// another run still running wrote is never among them.
pub(crate) async fn finish_run(
    db: &PgPool,
    run_id: &str,
    planned: i64,
) -> Result<Value, sqlx::Error> {
    let at = now();
    let run_id = run_id.to_owned();
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            if !hold_current_run(conn, &run_id).await? {
                return Ok(Value::Null);
            }
            sqlx::query(
                "delete from stash_item_plans where run_id is distinct from $1 \
                 and (run_id is null or run_id not in \
                   (select id from stash_planning_runs where status = 'running'))",
            )
            .bind(&run_id)
            .execute(&mut *conn)
            .await?;
            let row: Value = sqlx::query_scalar(
                "update stash_planning_runs t set status = 'done', finished_at = $2::timestamp, \
                 items_planned = $3, items_to_reorder = (select count(*)::integer from \
                 stash_item_plans p where p.run_id = $1 and p.review_status = 'open' \
                 and p.suggested_qty > 0) where t.id = $1 returning to_jsonb(t)",
            )
            .bind(&run_id)
            .bind(&at)
            .bind(i32::try_from(planned).unwrap_or(i32::MAX))
            .fetch_one(&mut *conn)
            .await?;
            sqlx::query(
                "delete from stash_planning_runs where status <> 'running' \
                 and started_at < $1::timestamp - interval '90 days'",
            )
            .bind(&at)
            .execute(&mut *conn)
            .await?;
            Ok(weldsuite_db::js_row(row))
        })
    })
    .await
}

/// Step 5: notify the members who may manage inventory (`inventory:manage`
/// in WeldStash) that `count` items newly need reordering, unless they had
/// such a notification in the last day. How many were notified.
pub(crate) async fn notify_reorder(
    db: &PgPool,
    notifier: &Notifier,
    hub: &str,
    clerk_org_id: Option<&str>,
    run_id: &str,
    count: i64,
) -> Result<usize, sqlx::Error> {
    let users: Vec<String> = sqlx::query_scalar(
        "select distinct user_id from workspace_members where deleted_at is null \
         and status = 'ACTIVE' and coalesce(user_id, '') <> '' order by user_id",
    )
    .fetch_all(db)
    .await?;
    let queries = TenantPermissionQueries::new(db.clone());
    let title = "Items to reorder".to_owned();
    let body = if count == 1 {
        "1 item now needs reordering.".to_owned()
    } else {
        format!("{count} items now need reordering.")
    };
    let mut sent = 0;
    for user in users {
        let resolved = resolve_effective_permissions(&queries, &user).await?;
        if !has_app_permission(&resolved, INVENTORY_MANAGE, Some("weldstash")) {
            continue;
        }
        let recent: bool = sqlx::query_scalar(
            "select exists(select 1 from notifications where user_id = $1 and category = 'wms' \
             and entity_type = 'replenishment_run' and created_at > now() - interval '1 day')",
        )
        .bind(&user)
        .fetch_one(db)
        .await?;
        if recent {
            continue;
        }
        let params = NewNotification {
            workspace_id: hub.to_owned(),
            clerk_org_id: clerk_org_id.map(str::to_owned),
            user_id: user.clone(),
            title: title.clone(),
            body: body.clone(),
            category: "wms".to_owned(),
            notification_type: "inventory_low".to_owned(),
            entity_type: "replenishment_run".to_owned(),
            entity_id: run_id.to_owned(),
            action_url: "/weldstash/replenishment".to_owned(),
            severity: "info".to_owned(),
            actor_type: Some("system".to_owned()),
            ..NewNotification::default()
        };
        match create_and_deliver(db, notifier, &params).await {
            Ok(Some(_)) => sent += 1,
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, user = %user, "[stash/replenishment] notification failed");
            }
        }
    }
    Ok(sent)
}

// ── The nightly sweep ───────────────────────────────────────────────────────

/// The next `hour`:00 UTC strictly after `now`.
pub fn next_run_at(now: OffsetDateTime, hour: i64) -> OffsetDateTime {
    let now = now.to_offset(UtcOffset::UTC);
    let hour = u8::try_from(hour.clamp(0, 23)).unwrap_or(2);
    let at = now.replace_time(Time::from_hms(hour, 0, 0).unwrap_or(Time::MIDNIGHT));
    if at > now { at } else { at + Duration::days(1) }
}

/// One tick of `weldsuite cron stash-replenishment`: for each workspace the
/// due index lists, start a scheduled run when replenishment is on (and
/// due again at the next `run_hour_utc`), or drop the row when it is off
/// (turning it on marks the workspace due again). A failed workspace is
/// retried in an hour.
pub async fn run_replenishment_sweep(
    master: &PgPool,
    tenants: &SweepTenants,
    jobs: &Arc<dyn DynJobs>,
    events: &EntityEventPublisher,
    now: OffsetDateTime,
) -> SweepResult {
    run_sweep(
        master,
        SWEEP_KIND,
        now,
        500,
        Some(Duration::hours(1)),
        |workspace_id, now| {
            let tenants = Arc::clone(tenants);
            let jobs = Arc::clone(jobs);
            let events = events.clone();
            async move {
                let (db, clerk_org_id) = tenants(workspace_id.clone()).await?;
                let settings = load_settings(&db).await.map_err(|e| e.to_string())?;
                if !settings.enabled {
                    return Ok::<_, String>(None);
                }
                let start = RunStart {
                    workspace_id,
                    clerk_org_id,
                    trigger: "schedule",
                    started_by: None,
                };
                start_run(&db, jobs.as_ref(), &events, &start)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(Some(next_run_at(now, settings.run_hour_utc)))
            }
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use time::{Month, PrimitiveDateTime};

    use super::*;

    fn at(day: u8, hour: u8, minute: u8, offset_hours: i8) -> OffsetDateTime {
        let date = Date::from_calendar_date(2026, Month::November, day).expect("date");
        let time = Time::from_hms(hour, minute, 0).expect("time");
        PrimitiveDateTime::new(date, time)
            .assume_offset(UtcOffset::from_hms(offset_hours, 0, 0).expect("offset"))
    }

    #[test]
    fn products_are_cut_into_chunks_of_about_the_target() {
        let rows: Vec<(String, i64)> = [("a", 1), ("b", 3), ("c", 1), ("d", 10), ("e", 1)]
            .iter()
            .map(|(id, n)| ((*id).to_owned(), *n))
            .collect();
        // Two warehouses, chunks of at most 8 items: a+b (8), c (2) + d (20)
        // would overflow, so d is a chunk of its own, then e.
        assert_eq!(
            chunk_ranges(&rows, 2, 8),
            vec![
                ("a".to_owned(), "b".to_owned()),
                ("c".to_owned(), "c".to_owned()),
                ("d".to_owned(), "d".to_owned()),
                ("e".to_owned(), "e".to_owned()),
            ]
        );
        assert_eq!(
            chunk_ranges(&rows, 1, 250),
            vec![("a".to_owned(), "e".to_owned())]
        );
        assert_eq!(chunk_ranges(&rows, 0, 250), Vec::<(String, String)>::new());
        assert_eq!(chunk_ranges(&[], 3, 250), Vec::<(String, String)>::new());
    }

    #[test]
    fn the_next_run_is_the_next_run_hour() {
        assert_eq!(next_run_at(at(18, 1, 30, 0), 2), at(18, 2, 0, 0));
        assert_eq!(next_run_at(at(18, 2, 0, 0), 2), at(19, 2, 0, 0));
        assert_eq!(next_run_at(at(18, 23, 59, 0), 0), at(19, 0, 0, 0));
        // Another offset reads in UTC: 03:30 at +02:00 is 01:30 UTC.
        assert_eq!(next_run_at(at(18, 3, 30, 2), 2), at(18, 2, 0, 0));
        assert_eq!(next_run_at(at(18, 4, 30, 2), 2), at(19, 2, 0, 0));
    }

    #[test]
    fn the_payload_round_trips() {
        let params = RunParams {
            workspace_id: "ws_1".to_owned(),
            clerk_org_id: Some("org_1".to_owned()),
            run_id: "prun_1".to_owned(),
            started_by: None,
        };
        assert_eq!(RunParams::read(&params.to_json()).ok(), Some(params));
        assert!(RunParams::read(&json!({ "workspaceId": "ws_1" })).is_err());
    }

    #[test]
    fn the_setup_round_trips() {
        let setup = Setup {
            today: Date::from_calendar_date(2026, Month::November, 18).expect("date"),
            settings: super::super::settings::defaults_json(),
            demand_warehouse: Some("wh_1".to_owned()),
            warehouses: vec!["wh_1".to_owned(), "wh_2".to_owned()],
            chunks: vec![("a".to_owned(), "b".to_owned())],
        };
        assert_eq!(Setup::from_json(&setup.to_json()).ok(), Some(setup));
    }

    #[test]
    fn a_manager_of_inventory_is_notified() {
        let manager = weldsuite_permissions::Grants {
            permissions: vec!["inventory:manage".to_owned()],
            denies: Vec::new(),
        };
        assert!(has_app_permission(
            &manager,
            INVENTORY_MANAGE,
            Some("weldstash")
        ));
        let reader = weldsuite_permissions::Grants {
            permissions: vec!["inventory:read".to_owned()],
            denies: Vec::new(),
        };
        assert!(!has_app_permission(
            &reader,
            INVENTORY_MANAGE,
            Some("weldstash")
        ));
        let denied = weldsuite_permissions::Grants {
            permissions: vec!["*".to_owned()],
            denies: vec!["inventory:manage".to_owned()],
        };
        assert!(!has_app_permission(
            &denied,
            INVENTORY_MANAGE,
            Some("weldstash")
        ));
    }

    #[test]
    fn numbers_are_rounded_for_their_columns() {
        assert_eq!(decimal(Some(1.234_56), 2), json!(1.23));
        assert_eq!(decimal(Some(f64::NAN), 2), Value::Null);
        assert_eq!(decimal(None, 2), Value::Null);
        assert_eq!(int4(i64::MAX), json!(2_147_483_647));
    }
}
