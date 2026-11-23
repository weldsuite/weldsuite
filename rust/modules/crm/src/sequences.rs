//! `/api/sequences` and `/api/customer-sequences` (`routes/sequences/index.ts`):
//! sequences are `workflows` rows tagged `__type:sequence`, their people
//! `sequence_enrollments`. Enrolling into a running sequence, launch, start
//! and resume start one `crm.execute-sequence` run per enrollment
//! ([`SequenceRuns`]); pause and unenroll only flip rows, and a parked run is
//! woken with the resume signal.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use futures_util::future::join_all;
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::{Asterisk, Expr, Func, OnConflict, Query, SubQueryStatement};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait,
    FromQueryResult, JoinType, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::SEQUENCE_UPDATED;
use weldsuite_crm_domain::sequence_run::{EXECUTE_SEQUENCE_JOB, SEQUENCE_RESUME_EVENT};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_ports::{BoxFuture, DynJobs, JobRequest};
use weldsuite_schema::tenant::{
    companies, people, person_companies, sequence_enrollments as enrollments, workflows,
};

use crate::orm_rows::{before, cursor_row, js_date, js_date_or_null, json};
use crate::{Answer, Caller, CrmState, answer, js_limit, page, query_map, validate};

const LOG: &str = "sequences";

/// Runs created or woken at once (`WORKFLOW_CALL_CONCURRENCY`).
const CALL_CONCURRENCY: usize = 10;
/// Enrollment ids per `update … where id = any(…)` (`ENROLLMENT_ID_CHUNK`).
const ID_CHUNK: usize = 200;

// ── Runs ────────────────────────────────────────────────────────────────────

/// How a start went (`startEnrollmentRuns`' outcomes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunStart {
    Triggered,
    /// The create failed but the run is there (a retry of a create that
    /// went through).
    Exists,
    Failed(String),
}

/// `EXECUTE_SEQUENCE` as the routes use it.
pub trait SequenceRuns: Send + Sync {
    /// Start the run for one enrollment (instance id = enrollment id).
    fn start<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, RunStart>;
    /// Wake a run parked on a pause; `false` when the hint was not delivered.
    fn wake<'a>(&'a self, id: &'a str) -> BoxFuture<'a, bool>;
}

/// A request's own `EXECUTE_SEQUENCE`, ahead of the jobs (conformance: the
/// test's binding through the harness, or `None` when the test has none, as
/// the worker then runs without it).
#[derive(Clone)]
pub struct RequestSequenceRuns(pub Option<Arc<dyn SequenceRuns>>);

/// The deployment's runs: `crm.execute-sequence` jobs, woken by signal.
pub struct JobsSequenceRuns {
    pub jobs: Arc<dyn DynJobs>,
}

impl SequenceRuns for JobsSequenceRuns {
    fn start<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, RunStart> {
        Box::pin(async move {
            let request = match JobRequest::new(EXECUTE_SEQUENCE_JOB, id, params) {
                Ok(request) => request,
                Err(error) => return RunStart::Failed(error.to_string()),
            };
            match self.jobs.start_boxed(request).await {
                Ok(()) => RunStart::Triggered,
                Err(error) => RunStart::Failed(error.to_string()),
            }
        })
    }

    fn wake<'a>(&'a self, id: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            self.jobs
                .signal_boxed(EXECUTE_SEQUENCE_JOB, id, SEQUENCE_RESUME_EVENT)
                .await
                .is_ok()
        })
    }
}

/// The request's runs, else the deployment's.
fn runs(state: &CrmState, caller: &Caller) -> Option<Arc<dyn SequenceRuns>> {
    match &caller.sequence_runs {
        Some(RequestSequenceRuns(runs)) => runs.clone(),
        None => state
            .services
            .jobs
            .clone()
            .map(|jobs| Arc::new(JobsSequenceRuns { jobs }) as Arc<dyn SequenceRuns>),
    }
}

/// `SequenceRunContext`: the run's params besides the enrollment.
#[allow(clippy::struct_field_names)] // the job's own param names
struct RunContext<'a> {
    /// The Clerk org id (the job's `workspaceId`; left out when unknown).
    workspace_id: Option<&'a str>,
    user_id: &'a str,
    sequence_id: &'a str,
}

/// `startEnrollmentRuns(c, db, ctx, enrollments)`: claim, then start each
/// claimed run once; a failed start gives its claim back. Never fails.
async fn start_runs(
    state: &CrmState,
    caller: &Caller,
    ctx: &RunContext<'_>,
    enrollments: &[(String, String)],
) -> usize {
    if enrollments.is_empty() {
        return 0;
    }
    let Some(runs) = runs(state, caller) else {
        tracing::warn!(
            "[crm-api/sequences] EXECUTE_SEQUENCE binding missing, skipping workflow trigger"
        );
        return 0;
    };
    let db = orm(&caller.db);
    let ids: Vec<String> = enrollments.iter().map(|(id, _)| id.clone()).collect();
    let mut claimed: Vec<String> = Vec::new();
    for chunk in ids.chunks(ID_CHUNK) {
        match claim(&db, chunk).await {
            Ok(rows) => claimed.extend(rows),
            Err(error) => {
                tracing::error!(%error, "[crm-api/sequences] failed to claim enrollment runs");
            }
        }
    }
    let customer = |id: &str| {
        enrollments
            .iter()
            .find(|(enrollment, _)| enrollment == id)
            .map(|(_, customer)| customer.clone())
            .unwrap_or_default()
    };
    let mut outcomes = Vec::with_capacity(claimed.len());
    for lane in claimed.chunks(CALL_CONCURRENCY) {
        let started = lane.iter().map(|id| {
            let runs = Arc::clone(&runs);
            let mut params = Map::new();
            if let Some(workspace) = ctx.workspace_id {
                params.insert("workspaceId".into(), json!(workspace));
            }
            params.insert("userId".into(), json!(ctx.user_id));
            params.insert("sequenceId".into(), json!(ctx.sequence_id));
            params.insert("enrollmentId".into(), json!(id));
            params.insert("customerId".into(), json!(customer(id)));
            let params = Value::Object(params);
            async move { runs.start(id, &params).await }
        });
        outcomes.extend(join_all(started).await);
    }
    let failed: Vec<String> = claimed
        .iter()
        .zip(&outcomes)
        .filter_map(|(id, outcome)| match outcome {
            RunStart::Failed(error) => {
                tracing::error!(error, "[crm-api/sequences] EXECUTE_SEQUENCE.create failed");
                Some(id.clone())
            }
            _ => None,
        })
        .collect();
    for chunk in failed.chunks(ID_CHUNK) {
        if let Err(error) = release(&db, chunk).await {
            tracing::error!(%error, "[crm-api/sequences] failed to release enrollment claims");
        }
    }
    outcomes
        .iter()
        .filter(|outcome| **outcome == RunStart::Triggered)
        .count()
}

/// Claim the active, unclaimed enrollments among `ids` for their runs (the
/// run's instance id is the enrollment id): the ids claimed.
async fn claim(db: &DatabaseConnection, ids: &[String]) -> Result<Vec<String>, DbErr> {
    use enrollments::Column;
    let rows = enrollments::Entity::update_many()
        .col_expr(Column::ExecutionId, Expr::col(Column::Id))
        .filter(Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(Column::Status.eq("active"))
        .filter(Column::ExecutionId.is_null())
        .exec_with_returning(db)
        .await?;
    Ok(rows.into_iter().map(|row| row.id).collect())
}

/// Give back the claims of runs that failed to start.
async fn release(db: &DatabaseConnection, ids: &[String]) -> Result<(), DbErr> {
    use enrollments::Column;
    enrollments::Entity::update_many()
        .col_expr(Column::ExecutionId, Expr::value(None::<String>))
        .filter(Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(sea_orm::ExprTrait::equals(
            Expr::col((enrollments::Entity, Column::ExecutionId)),
            (enrollments::Entity, Column::Id),
        ))
        .exec(db)
        .await?;
    Ok(())
}

/// `wakeRuns(c, executionIds)`: best effort.
async fn wake_runs(state: &CrmState, caller: &Caller, execution_ids: &[String]) {
    let Some(runs) = runs(state, caller) else {
        return;
    };
    if execution_ids.is_empty() {
        return;
    }
    let mut missed = 0;
    for lane in execution_ids.chunks(CALL_CONCURRENCY) {
        let delivered = join_all(lane.iter().map(|id| runs.wake(id))).await;
        missed += delivered.iter().filter(|ok| !**ok).count();
    }
    if missed > 0 {
        tracing::warn!(
            "[crm-api/sequences] resume event not delivered to {missed} of {} runs",
            execution_ids.len()
        );
    }
}

/// `startPendingRuns(c, db, ctx)`.
async fn start_pending(state: &CrmState, caller: &Caller, ctx: &RunContext<'_>) -> Answer<usize> {
    use enrollments::Column;
    let rows: Vec<(String, String)> = enrollments::Entity::find()
        .select_only()
        .columns([Column::Id, Column::CustomerId])
        .filter(Column::SequenceId.eq(ctx.sequence_id))
        .filter(Column::Status.eq("active"))
        .filter(Column::ExecutionId.is_null())
        .into_tuple()
        .all(&orm(&caller.db))
        .await?;
    Ok(start_runs(state, caller, ctx, &rows).await)
}

/// `activateSequence(c, db, ctx, { resumePaused })`: (activated, resumed).
async fn activate(
    state: &CrmState,
    caller: &Caller,
    ctx: &RunContext<'_>,
    resume_paused: bool,
) -> Answer<(usize, usize)> {
    use enrollments::Column;
    let db = &orm(&caller.db);
    set_sequence_status(db, ctx.sequence_id, "active", utc_now()).await?;
    let activated = enrollments::Entity::update_many()
        .col_expr(Column::Status, Expr::value("active"))
        .filter(Column::SequenceId.eq(ctx.sequence_id))
        .filter(Column::Status.eq("pending"))
        .exec_with_returning(db)
        .await?;
    let mut resumed = 0;
    if resume_paused {
        let rows = enrollments::Entity::update_many()
            .col_expr(Column::Status, Expr::value("active"))
            .col_expr(Column::PausedAt, Expr::value(None::<PrimitiveDateTime>))
            .filter(Column::SequenceId.eq(ctx.sequence_id))
            .filter(Column::Status.eq("paused"))
            .exec_with_returning(db)
            .await?;
        resumed = rows.len();
        let parked: Vec<String> = rows
            .into_iter()
            .filter_map(|row| row.execution_id)
            .collect();
        wake_runs(state, caller, &parked).await;
    }
    start_pending(state, caller, ctx).await?;
    Ok((activated.len(), resumed))
}

/// The sequence's `status` and `updatedAt`.
async fn set_sequence_status(
    db: &DatabaseConnection,
    id: &str,
    status: &str,
    at: PrimitiveDateTime,
) -> Result<(), DbErr> {
    workflows::Entity::update_many()
        .col_expr(workflows::Column::Status, Expr::value(status))
        .col_expr(workflows::Column::UpdatedAt, Expr::value(at))
        .filter(workflows::Column::Id.eq(id))
        .exec(db)
        .await?;
    Ok(())
}

// ── Reads ───────────────────────────────────────────────────────────────────

/// The fields of `row` named in `keys`, in that order (a Drizzle `select({...})`).
fn pick(row: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        out.insert(
            (*key).to_owned(),
            row.get(*key).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(out)
}

/// `.limit(n)` as Drizzle renders it: no `LIMIT` at all for NaN or a
/// negative number.
fn sql_limit(limit: Option<i64>) -> Option<u64> {
    limit.and_then(|n| u64::try_from(n).ok())
}

/// The page of a `limit + 1` probe as the route cuts it, with JavaScript's
/// comparisons and `slice` for a NaN (`None`) or negative limit.
fn js_cut(rows: Vec<Value>, limit: Option<i64>) -> (Vec<Value>, bool, Option<String>) {
    let Some(limit) = limit else {
        return (rows, false, None);
    };
    let len = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    let has_more = len > limit;
    let mut rows = rows;
    if has_more {
        let end = if limit < 0 {
            (len + limit).max(0)
        } else {
            limit.min(len)
        };
        rows.truncate(usize::try_from(end).unwrap_or(0));
    }
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        None
    };
    (rows, has_more, cursor)
}

/// `and(...conditions)`.
fn all_of(conditions: &[Condition]) -> Condition {
    conditions
        .iter()
        .cloned()
        .fold(Condition::all(), Condition::add)
}

/// `conditions.slice(0, -1)` whenever a cursor was sent (it drops the last
/// condition even when the cursor row was not found).
fn count_conds(conds: &[Condition], cursor: bool) -> &[Condition] {
    if cursor {
        &conds[..conds.len() - 1]
    } else {
        conds
    }
}

/// `(select count(*) from sequence_enrollments s where s.sequence_id = w.id
/// and <status>)`: the sequence's enrollments in that status.
fn enrollment_count(status: Condition) -> Expr {
    use enrollments::Column;
    let mut select = Query::select();
    select
        .expr(Func::count(Expr::col(Asterisk)))
        .from(enrollments::Entity)
        .and_where(sea_orm::ExprTrait::equals(
            Expr::col((enrollments::Entity, Column::SequenceId)),
            (workflows::Entity, workflows::Column::Id),
        ))
        .cond_where(status);
    Expr::SubQuery(None, Box::new(SubQueryStatement::SelectStatement(select)))
}

/// The counts a sequence is listed with, by key.
fn enrollment_counts(statuses: &[(&'static str, Condition)]) -> Vec<(&'static str, Expr)> {
    statuses
        .iter()
        .map(|(name, status)| (*name, enrollment_count(status.clone())))
        .collect()
}

/// `!= 'unenrolled'`, then the statuses by name: what `enrolledCount` and
/// each `<status>EnrolledCount` count.
fn counted(statuses: &[&'static str]) -> Vec<(&'static str, Condition)> {
    use enrollments::Column;
    let mut out = vec![(
        "enrolled_count",
        Condition::all().add(Column::Status.ne("unenrolled")),
    )];
    for status in statuses {
        let name = match *status {
            "active" => "active_enrolled_count",
            "pending" => "pending_enrolled_count",
            "completed" => "completed_enrolled_count",
            _ => "failed_enrolled_count",
        };
        out.push((name, Condition::all().add(Column::Status.eq(*status))));
    }
    out
}

/// A sequence with its enrollment counts.
#[derive(Debug, FromQueryResult)]
struct ListedSequence {
    #[sea_orm(nested)]
    workflow: workflows::Model,
    enrolled_count: i64,
    active_enrolled_count: i64,
    pending_enrolled_count: i64,
}

/// A sequence with every enrollment count the detail shows.
#[derive(Debug, FromQueryResult)]
struct DetailedSequence {
    #[sea_orm(nested)]
    workflow: workflows::Model,
    enrolled_count: i64,
    active_enrolled_count: i64,
    pending_enrolled_count: i64,
    completed_enrolled_count: i64,
    failed_enrolled_count: i64,
}

/// A workflow row as Drizzle returns it, with `counts` by key.
fn with_counts(workflow: workflows::Model, counts: &[(&str, i64)]) -> Result<Value, DbErr> {
    let mut row = json(serde_json::to_value(workflow))?;
    if let Value::Object(fields) = &mut row {
        for (key, count) in counts {
            fields.insert((*key).to_owned(), json!(count));
        }
    }
    Ok(row)
}

/// The workflows with their enrollment counts.
fn sequences_with(counts: Vec<(&'static str, Expr)>) -> sea_orm::Select<workflows::Entity> {
    counts
        .into_iter()
        .fold(workflows::Entity::find(), |select, (name, count)| {
            select.expr_as(count, name)
        })
}

/// `tags ? '__type:sequence'`: the workflow is a sequence. The tags are a
/// jsonb array of strings, so containment is the same test.
fn sequence_tagged() -> Expr {
    sea_orm::sea_query::extension::postgres::PgExpr::contains(
        Expr::from(Func::coalesce([
            Expr::col((workflows::Entity, workflows::Column::Tags)),
            Expr::val(json!([])),
        ])),
        Expr::val(json!(["__type:sequence"])),
    )
}

const LIST_KEYS: [&str; 14] = [
    "id",
    "name",
    "description",
    "status",
    "steps",
    "tags",
    "executionCount",
    "successCount",
    "lastExecutedAt",
    "createdAt",
    "updatedAt",
    "enrolledCount",
    "activeEnrolledCount",
    "pendingEnrolledCount",
];

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    answer(
        run_list(&caller, query.as_deref()).await,
        LOG,
        "Failed to list sequences",
    )
}

async fn run_list(caller: &Caller, raw: Option<&str>) -> Answer {
    use workflows::{Column, Entity};
    let q = query_map(raw);
    let limit = js_limit(q.get("limit"), 50, 100);
    let mut conds = vec![
        Condition::all().add(Column::DeletedAt.is_null()),
        Condition::all().add(sequence_tagged()),
    ];
    if let Some(search) = q.get("search").filter(|s| !s.is_empty()) {
        let term = format!("%{search}%");
        conds.push(
            Condition::any()
                .add(Column::Name.like(term.as_str()))
                .add(Column::Description.like(term)),
        );
    }
    let cursor = q.get("cursor").filter(|c| !c.is_empty());
    if let Some(cursor) = cursor
        && let Some(row) =
            cursor_row::<Entity>(&caller.db, Column::CreatedAt, Column::Id, cursor).await?
    {
        conds.push(before(Column::CreatedAt, Column::Id, &row));
    }
    let db = orm(&caller.db);
    let rows = sequences_with(enrollment_counts(&counted(&["active", "pending"])))
        .filter(all_of(&conds))
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(sql_limit(limit.map(|n| n + 1)))
        .into_model::<ListedSequence>()
        .all(&db)
        .await?;
    let total = Entity::find()
        .filter(all_of(count_conds(&conds, cursor.is_some())))
        .count(&db)
        .await?;
    let rows = rows
        .into_iter()
        .map(|row| {
            let counts = [
                ("enrolledCount", row.enrolled_count),
                ("activeEnrolledCount", row.active_enrolled_count),
                ("pendingEnrolledCount", row.pending_enrolled_count),
            ];
            with_counts(row.workflow, &counts).map(|row| pick(&row, &LIST_KEYS))
        })
        .collect::<Result<Vec<_>, DbErr>>()?;
    let (rows, has_more, next) = js_cut(rows, limit);
    Ok(page(
        rows,
        i64::try_from(total).unwrap_or(i64::MAX),
        has_more,
        next,
    ))
}

const DETAIL_KEYS: [&str; 19] = [
    "id",
    "name",
    "description",
    "status",
    "steps",
    "triggers",
    "tags",
    "settings",
    "executionCount",
    "successCount",
    "failureCount",
    "lastExecutedAt",
    "createdAt",
    "updatedAt",
    "enrolledCount",
    "activeEnrolledCount",
    "pendingEnrolledCount",
    "completedEnrolledCount",
    "failedEnrolledCount",
];

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        run_detail(&caller, &id).await,
        LOG,
        "Failed to fetch sequence",
    )
}

async fn run_detail(caller: &Caller, id: &str) -> Answer {
    let row = sequences_with(enrollment_counts(&counted(&[
        "active",
        "pending",
        "completed",
        "failed",
    ])))
    .filter(workflows::Column::Id.eq(id))
    .filter(workflows::Column::DeletedAt.is_null())
    .into_model::<DetailedSequence>()
    .one(&orm(&caller.db))
    .await?;
    let Some(row) = row else {
        return Ok(ApiError::not_found("Sequence", Some(id)).into_response());
    };
    let counts = [
        ("enrolledCount", row.enrolled_count),
        ("activeEnrolledCount", row.active_enrolled_count),
        ("pendingEnrolledCount", row.pending_enrolled_count),
        ("completedEnrolledCount", row.completed_enrolled_count),
        ("failedEnrolledCount", row.failed_enrolled_count),
    ];
    let row = with_counts(row.workflow, &counts)?;
    Ok(Data(pick(&row, &DETAIL_KEYS)).into_response())
}

const ENROLLMENT_KEYS: [&str; 20] = [
    "id",
    "sequenceId",
    "customerId",
    "status",
    "executionId",
    "currentStepIndex",
    "totalSteps",
    "enrolledBy",
    "enrolledAt",
    "completedAt",
    "pausedAt",
    "unenrolledAt",
    "failedAt",
    "errorMessage",
    "customerSnapshot",
    "customerEmail",
    "customerFirstName",
    "customerLastName",
    "customerFullName",
    "customerCompanyName",
];

pub(crate) async fn enrollments(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    answer(
        run_enrollments(&caller, &id, query.as_deref()).await,
        LOG,
        "Failed to list enrollments",
    )
}

/// An enrollment with its person's contact fields.
#[derive(Debug, FromQueryResult)]
struct ListedEnrollment {
    #[sea_orm(nested)]
    enrollment: enrollments::Model,
    customer_email: Option<String>,
    customer_first_name: Option<String>,
    customer_last_name: Option<String>,
    customer_full_name: Option<String>,
    customer_company_name: Option<String>,
}

/// `innerJoin(people, eq(e.customerId, people.id))`.
fn enrolled_person() -> RelationDef {
    enrollments::Entity::belongs_to(people::Entity)
        .from(enrollments::Column::CustomerId)
        .to(people::Column::Id)
        .into()
}

/// `e.customer_snapshot->>key`, else the person's `column`.
fn snapshot_or(key: &str, column: Option<people::Column>) -> Expr {
    let snapshot = sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
        Expr::col((enrollments::Entity, enrollments::Column::CustomerSnapshot)),
        key,
    );
    match column {
        Some(column) => Expr::from(Func::coalesce([
            snapshot,
            Expr::col((people::Entity, column)),
        ])),
        None => snapshot,
    }
}

/// An enrollment row as Drizzle returns it, with its person's fields.
fn enrollment_json(row: ListedEnrollment) -> Result<Value, DbErr> {
    let mut full = json(serde_json::to_value(row.enrollment))?;
    if let Value::Object(fields) = &mut full {
        for (key, value) in [
            ("customerEmail", row.customer_email),
            ("customerFirstName", row.customer_first_name),
            ("customerLastName", row.customer_last_name),
            ("customerFullName", row.customer_full_name),
            ("customerCompanyName", row.customer_company_name),
        ] {
            fields.insert(key.to_owned(), json!(value));
        }
    }
    Ok(full)
}

/// The enrollment's fields the list returns, `totalSteps` from the
/// sequence's steps when it has any.
fn listed_enrollment(row: &Value, step_count: usize) -> Value {
    let mut picked = pick(row, &ENROLLMENT_KEYS);
    let total_steps = if step_count > 0 {
        json!(step_count)
    } else {
        match row.get("totalSteps") {
            Some(Value::Null) | None => json!(0),
            Some(value) => value.clone(),
        }
    };
    picked["totalSteps"] = total_steps;
    picked
}

async fn run_enrollments(caller: &Caller, id: &str, raw: Option<&str>) -> Answer {
    use enrollments::{Column, Entity};
    let q = query_map(raw);
    let limit = js_limit(q.get("limit"), 25, 100);
    let mut conds = vec![
        Condition::all().add(Column::SequenceId.eq(id)),
        Condition::all().add(people::Column::DeletedAt.is_null()),
    ];
    if let Some(status) = q.get("status").filter(|s| !s.is_empty()) {
        conds.push(Condition::all().add(Column::Status.eq(status.as_str())));
    }
    if let Some(search) = q.get("search").filter(|s| !s.is_empty()) {
        let term = format!("%{search}%");
        conds.push(
            Condition::any()
                .add(people::Column::DisplayName.like(term.as_str()))
                .add(people::Column::Email.like(term)),
        );
    }
    let cursor = q.get("cursor").filter(|c| !c.is_empty());
    if let Some(cursor) = cursor
        && let Some(row) =
            cursor_row::<Entity>(&caller.db, Column::EnrolledAt, Column::Id, cursor).await?
    {
        conds.push(before(Column::EnrolledAt, Column::Id, &row));
    }
    let db = orm(&caller.db);
    let rows = Entity::find()
        .expr_as(
            snapshot_or("email", Some(people::Column::Email)),
            "customer_email",
        )
        .expr_as(
            snapshot_or("firstName", Some(people::Column::FirstName)),
            "customer_first_name",
        )
        .expr_as(
            snapshot_or("lastName", Some(people::Column::LastName)),
            "customer_last_name",
        )
        .expr_as(
            snapshot_or("fullName", Some(people::Column::DisplayName)),
            "customer_full_name",
        )
        .expr_as(snapshot_or("companyName", None), "customer_company_name")
        .join(JoinType::InnerJoin, enrolled_person())
        .filter(all_of(&conds))
        .order_by_desc(Column::EnrolledAt)
        .order_by_desc(Column::Id)
        .limit(sql_limit(limit.map(|n| n + 1)))
        .into_model::<ListedEnrollment>()
        .all(&db)
        .await?;
    let total = Entity::find()
        .join(JoinType::InnerJoin, enrolled_person())
        .filter(all_of(count_conds(&conds, cursor.is_some())))
        .count(&db)
        .await?;
    let steps: Option<Option<Value>> = workflows::Entity::find()
        .select_only()
        .column(workflows::Column::Steps)
        .filter(workflows::Column::Id.eq(id))
        .into_tuple()
        .one(&db)
        .await?;
    let step_count = match steps.flatten() {
        Some(Value::Array(steps)) => steps.len(),
        _ => 0,
    };
    let rows = rows
        .into_iter()
        .map(enrollment_json)
        .collect::<Result<Vec<_>, DbErr>>()?;
    let (rows, has_more, next) = js_cut(rows, limit);
    let rows = rows
        .iter()
        .map(|row| listed_enrollment(row, step_count))
        .collect();
    Ok(page(
        rows,
        i64::try_from(total).unwrap_or(i64::MAX),
        has_more,
        next,
    ))
}

// ── Enroll ──────────────────────────────────────────────────────────────────

const ENROLL_MESSAGE: &str = "personIds (or customerIds) must include at least one id";

/// `enrollSchema`: the ids of both fields, or the 400.
fn enroll_body(issues: &mut Issues, body: &Map<String, Value>) -> Vec<String> {
    let mut aborted = false;
    let mut ids = Vec::new();
    let mut any = false;
    for key in ["personIds", "customerIds"] {
        match body.get(key) {
            None => {}
            Some(Value::Array(items)) => {
                aborted |= items.iter().any(|item| !item.is_string());
                any |= !items.is_empty();
                ids.extend(items.iter().filter_map(Value::as_str).map(str::to_owned));
            }
            Some(_) => aborted = true,
        }
        issues.list(
            body,
            key,
            Presence::Optional,
            Some(1),
            None,
            |issues, item| issues.item_text(item, Text::default()),
        );
    }
    if !aborted && !any {
        issues.custom_here(ENROLL_MESSAGE);
    }
    ids
}

pub(crate) async fn enroll(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ids = match validate(&headers, &body, enroll_body) {
        Ok(ids) => ids,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    answer(
        run_enroll(&state, &caller, &id, ids).await,
        LOG,
        "Failed to enroll customers",
    )
}

/// A person's `customerSnapshot`, `undefined` fields left out.
fn snapshot(person: &Value, company: Option<&String>) -> Value {
    let mut out = Map::new();
    let mut set = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    };
    let field = |key: &str| person.get(key).filter(|v| !v.is_null()).cloned();
    set("email", field("email"));
    set("firstName", field("firstName"));
    set("lastName", field("lastName"));
    set(
        "fullName",
        field("fullName").or_else(|| field("displayName")),
    );
    set("companyName", company.map(|c| json!(c)));
    set(
        "phone",
        field("directPhone").or_else(|| field("mobilePhone")),
    );
    let address = person.get("primaryAddress").and_then(Value::as_object);
    set("city", address.and_then(|a| a.get("city")).cloned());
    set("country", address.and_then(|a| a.get("country")).cloned());
    Value::Object(out)
}

#[allow(clippy::too_many_lines)] // the enroll route's reads and insert, as TypeScript has them
async fn run_enroll(
    state: &CrmState,
    caller: &Caller,
    sequence_id: &str,
    requested: Vec<String>,
) -> Answer {
    let mut ids: Vec<String> = Vec::new();
    for id in requested {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let db = &orm(&caller.db);
    let sequence = sequence_row(caller, sequence_id).await?;
    let people = people::Entity::find()
        .filter(people::Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(people::Column::DeletedAt.is_null())
        .all(db)
        .await?;
    let employments: Vec<(String, String)> = person_companies::Entity::find()
        .select_only()
        .column(person_companies::Column::PersonId)
        .column(companies::Column::DisplayName)
        .join(
            JoinType::InnerJoin,
            person_companies::Entity::belongs_to(companies::Entity)
                .from(person_companies::Column::CompanyId)
                .to(companies::Column::Id)
                .into(),
        )
        .filter(person_companies::Column::PersonId.is_in(ids.iter().map(String::as_str)))
        .filter(person_companies::Column::IsPrimary.eq(true))
        .filter(person_companies::Column::EndedAt.is_null())
        .into_tuple()
        .all(db)
        .await?;
    let enrolled: Vec<String> = enrollments::Entity::find()
        .select_only()
        .column(enrollments::Column::CustomerId)
        .filter(enrollments::Column::SequenceId.eq(sequence_id))
        .filter(enrollments::Column::CustomerId.is_in(ids.iter().map(String::as_str)))
        .into_tuple()
        .all(db)
        .await?;
    let Some((status, steps)) = sequence else {
        return Ok(ApiError::not_found("Sequence", Some(sequence_id)).into_response());
    };
    let active = status.as_deref() == Some("active");
    let total_steps = match steps {
        Some(Value::Array(steps)) => steps.len(),
        _ => 0,
    };
    let people = people
        .into_iter()
        .map(|person| json(serde_json::to_value(person)))
        .collect::<Result<Vec<_>, DbErr>>()?;
    let person = |id: &str| {
        people
            .iter()
            .find(|p| p.get("id").and_then(Value::as_str) == Some(id))
    };
    let known: Vec<&String> = ids.iter().filter(|id| person(id).is_some()).collect();
    if known.is_empty() {
        return Ok(ApiError::bad_request("No matching people found to enroll")
            .with_details(json!({ "ids": ids }))
            .into_response());
    }
    let mut companies: std::collections::HashMap<&str, &String> = std::collections::HashMap::new();
    for (person_id, company) in &employments {
        if !company.is_empty() {
            companies.insert(person_id, company);
        }
    }
    let to_enroll: Vec<&String> = known
        .into_iter()
        .filter(|id| !enrolled.contains(*id))
        .collect();
    if to_enroll.is_empty() {
        return Ok(Data(json!({ "enrolled": 0, "enrollmentIds": [] })).into_response());
    }
    let at = utc_now();
    let total_steps =
        i32::try_from(total_steps).map_err(|_| DbErr::Custom("integer out of range".to_owned()))?;
    let rows = to_enroll.iter().map(|customer| enrollments::ActiveModel {
        id: Set(generate_id("senr")),
        sequence_id: Set(sequence_id.to_owned()),
        customer_id: Set((*customer).clone()),
        counterparty_id: Set(Some((*customer).clone())),
        status: Set(if active { "active" } else { "pending" }.to_owned()),
        total_steps: Set(Some(total_steps)),
        enrolled_by: Set(Some(caller.user_id.clone())),
        enrolled_at: Set(at),
        customer_snapshot: Set(Some(snapshot(
            person(customer).unwrap_or(&Value::Null),
            companies.get(customer.as_str()).copied(),
        ))),
        ..Default::default()
    });
    // A person enrolled meanwhile is skipped (`on conflict do nothing`).
    let inserted: Vec<(String, String)> = enrollments::Entity::insert_many(rows)
        .on_conflict(
            OnConflict::columns([
                enrollments::Column::SequenceId,
                enrollments::Column::CustomerId,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec_with_returning(db)
        .await?
        .into_iter()
        .map(|row| (row.id, row.customer_id))
        .collect();
    if active {
        start_runs(state, caller, &context(caller, sequence_id), &inserted).await;
    }
    let ids: Vec<&String> = inserted.iter().map(|(id, _)| id).collect();
    Ok(Data(json!({ "enrolled": inserted.len(), "enrollmentIds": ids })).into_response())
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/// The sequence's `(status, steps)`, when it is there and not deleted.
async fn sequence_row(
    caller: &Caller,
    id: &str,
) -> Result<Option<(Option<String>, Option<Value>)>, DbErr> {
    workflows::Entity::find()
        .select_only()
        .columns([workflows::Column::Status, workflows::Column::Steps])
        .filter(workflows::Column::Id.eq(id))
        .filter(workflows::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await
}

fn context<'a>(caller: &'a Caller, sequence_id: &'a str) -> RunContext<'a> {
    RunContext {
        workspace_id: caller.clerk_org_id.as_deref(),
        user_id: &caller.user_id,
        sequence_id,
    }
}

pub(crate) async fn launch(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        run_launch(&state, &caller, &id).await,
        LOG,
        "Failed to launch sequence",
    )
}

async fn run_launch(state: &CrmState, caller: &Caller, id: &str) -> Answer {
    let Some((_, steps)) = sequence_row(caller, id).await? else {
        return Ok(ApiError::not_found("Sequence", Some(id)).into_response());
    };
    if !matches!(steps, Some(Value::Array(ref steps)) if !steps.is_empty()) {
        return Ok(
            ApiError::bad_request("Add at least one step before launching this sequence")
                .into_response(),
        );
    }
    let enrolled = enrollments::Entity::find()
        .filter(enrollments::Column::SequenceId.eq(id))
        .filter(enrollments::Column::Status.ne("unenrolled"))
        .count(&orm(&caller.db))
        .await?;
    if enrolled == 0 {
        return Ok(ApiError::bad_request(
            "Enroll at least one person before launching this sequence",
        )
        .into_response());
    }
    let (activated, _) = activate(state, caller, &context(caller, id), false).await?;
    caller.publish(
        state,
        SEQUENCE_UPDATED,
        id,
        &json!({ "id": id, "status": "active" }),
    );
    Ok(Data(json!({ "activated": activated })).into_response())
}

pub(crate) async fn start(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        run_start(&state, &caller, &id).await,
        LOG,
        "Failed to start sequence",
    )
}

async fn run_start(state: &CrmState, caller: &Caller, id: &str) -> Answer {
    if sequence_row(caller, id).await?.is_none() {
        return Ok(ApiError::not_found("Sequence", Some(id)).into_response());
    }
    let triggered = start_pending(state, caller, &context(caller, id)).await?;
    Ok(Data(json!({ "triggered": triggered })).into_response())
}

pub(crate) async fn resume(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        run_resume(&state, &caller, &id).await,
        LOG,
        "Failed to resume sequence",
    )
}

async fn run_resume(state: &CrmState, caller: &Caller, id: &str) -> Answer {
    if sequence_row(caller, id).await?.is_none() {
        return Ok(ApiError::not_found("Sequence", Some(id)).into_response());
    }
    let (activated, resumed) = activate(state, caller, &context(caller, id), true).await?;
    caller.publish(
        state,
        SEQUENCE_UPDATED,
        id,
        &json!({ "id": id, "status": "active" }),
    );
    Ok(Data(json!({
        "resumed": true,
        "activated": activated,
        "resumedEnrollments": resumed,
    }))
    .into_response())
}

pub(crate) async fn pause(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        run_pause(&state, &caller, &id).await,
        LOG,
        "Failed to pause sequence",
    )
}

async fn run_pause(state: &CrmState, caller: &Caller, id: &str) -> Answer {
    if sequence_row(caller, id).await?.is_none() {
        return Ok(ApiError::not_found("Sequence", Some(id)).into_response());
    }
    let at = utc_now();
    let db = orm(&caller.db);
    set_sequence_status(&db, id, "paused", at).await?;
    let paused = enrollments::Entity::update_many()
        .col_expr(enrollments::Column::Status, Expr::value("paused"))
        .col_expr(enrollments::Column::PausedAt, Expr::value(at))
        .filter(enrollments::Column::SequenceId.eq(id))
        .filter(enrollments::Column::Status.eq("active"))
        .exec_with_returning(&db)
        .await?;
    caller.publish(
        state,
        SEQUENCE_UPDATED,
        id,
        &json!({ "id": id, "status": "paused" }),
    );
    Ok(Data(json!({ "paused": true, "pausedEnrollments": paused.len() })).into_response())
}

// ── Enrollments ─────────────────────────────────────────────────────────────

pub(crate) async fn unenroll(
    State(state): State<CrmState>,
    caller: Caller,
    Path(enrollment_id): Path<String>,
) -> Response {
    answer(
        run_unenroll(&state, &caller, &enrollment_id).await,
        LOG,
        "Failed to unenroll",
    )
}

async fn run_unenroll(state: &CrmState, caller: &Caller, id: &str) -> Answer {
    let db = orm(&caller.db);
    let existing: Option<(String, Option<String>)> = enrollments::Entity::find_by_id(id.to_owned())
        .select_only()
        .columns([
            enrollments::Column::Status,
            enrollments::Column::ExecutionId,
        ])
        .into_tuple()
        .one(&db)
        .await?;
    let Some((status, execution_id)) = existing else {
        return Ok(ApiError::not_found("Enrollment", Some(id)).into_response());
    };
    enrollments::Entity::update_many()
        .col_expr(enrollments::Column::Status, Expr::value("unenrolled"))
        .col_expr(enrollments::Column::UnenrolledAt, Expr::value(utc_now()))
        .filter(enrollments::Column::Id.eq(id))
        .exec(&db)
        .await?;
    if status == "paused"
        && let Some(run) = execution_id
    {
        wake_runs(state, caller, &[run]).await;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub(crate) async fn pause_enrollment(
    caller: Caller,
    Path((sequence_id, enrollment_id)): Path<(String, String)>,
) -> Response {
    answer(
        run_pause_enrollment(&caller, &sequence_id, &enrollment_id).await,
        LOG,
        "Failed to pause enrollment",
    )
}

async fn run_pause_enrollment(caller: &Caller, sequence_id: &str, id: &str) -> Answer {
    let db = orm(&caller.db);
    let status: Option<String> = enrollments::Entity::find_by_id(id.to_owned())
        .select_only()
        .column(enrollments::Column::Status)
        .filter(enrollments::Column::SequenceId.eq(sequence_id))
        .into_tuple()
        .one(&db)
        .await?;
    let Some(status) = status else {
        return Ok(ApiError::not_found("Enrollment", Some(id)).into_response());
    };
    if status != "active" {
        return Ok(ApiError::conflict(format!(
            "Only an active enrollment can be paused (this one is {status})"
        ))
        .into_response());
    }
    enrollments::Entity::update_many()
        .col_expr(enrollments::Column::Status, Expr::value("paused"))
        .col_expr(enrollments::Column::PausedAt, Expr::value(utc_now()))
        .filter(enrollments::Column::Id.eq(id))
        .filter(enrollments::Column::Status.eq("active"))
        .exec(&db)
        .await?;
    Ok(Data(json!({ "paused": true })).into_response())
}

pub(crate) async fn resume_enrollment(
    State(state): State<CrmState>,
    caller: Caller,
    Path((sequence_id, enrollment_id)): Path<(String, String)>,
) -> Response {
    answer(
        run_resume_enrollment(&state, &caller, &sequence_id, &enrollment_id).await,
        LOG,
        "Failed to resume enrollment",
    )
}

async fn run_resume_enrollment(
    state: &CrmState,
    caller: &Caller,
    sequence_id: &str,
    id: &str,
) -> Answer {
    let db = orm(&caller.db);
    let existing: Option<(String, String, Option<String>)> =
        enrollments::Entity::find_by_id(id.to_owned())
            .select_only()
            .columns([
                enrollments::Column::CustomerId,
                enrollments::Column::Status,
                enrollments::Column::ExecutionId,
            ])
            .filter(enrollments::Column::SequenceId.eq(sequence_id))
            .into_tuple()
            .one(&db)
            .await?;
    let sequence = sequence_row(caller, sequence_id).await?;
    let (Some((customer, status, execution_id)), Some((sequence_status, _))) = (existing, sequence)
    else {
        return Ok(ApiError::not_found("Enrollment", Some(id)).into_response());
    };
    if status != "paused" {
        return Ok(ApiError::conflict(format!(
            "Only a paused enrollment can be resumed (this one is {status})"
        ))
        .into_response());
    }
    if sequence_status.as_deref() == Some("paused") {
        return Ok(
            ApiError::conflict("Resume the sequence before resuming a person").into_response(),
        );
    }
    enrollments::Entity::update_many()
        .col_expr(enrollments::Column::Status, Expr::value("active"))
        .col_expr(
            enrollments::Column::PausedAt,
            Expr::value(None::<PrimitiveDateTime>),
        )
        .filter(enrollments::Column::Id.eq(id))
        .filter(enrollments::Column::Status.eq("paused"))
        .exec(&db)
        .await?;
    if let Some(run) = execution_id {
        wake_runs(state, caller, &[run]).await;
    } else {
        start_runs(
            state,
            caller,
            &context(caller, sequence_id),
            &[(id.to_owned(), customer)],
        )
        .await;
    }
    Ok(Data(json!({ "resumed": true })).into_response())
}

// ── /customer-sequences ─────────────────────────────────────────────────────

pub(crate) async fn customer_sequences(
    caller: Caller,
    Path(customer_id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    answer(
        run_customer_sequences(&caller, &customer_id, query.as_deref()).await,
        "customer-sequences",
        "Failed to list customer sequences",
    )
}

/// An enrollment with its sequence's name and status.
#[derive(Debug, FromQueryResult)]
struct CustomerSequence {
    #[sea_orm(nested)]
    enrollment: enrollments::Model,
    sequence_name: String,
    sequence_status: String,
}

async fn run_customer_sequences(caller: &Caller, customer_id: &str, raw: Option<&str>) -> Answer {
    let q = query_map(raw);
    let limit = sql_limit(js_limit(q.get("limit"), 50, 100));
    let rows = enrollments::Entity::find()
        .column_as(workflows::Column::Name, "sequence_name")
        .column_as(workflows::Column::Status, "sequence_status")
        .join(
            JoinType::InnerJoin,
            enrollments::Entity::belongs_to(workflows::Entity)
                .from(enrollments::Column::SequenceId)
                .to(workflows::Column::Id)
                .into(),
        )
        .filter(enrollments::Column::CustomerId.eq(customer_id))
        .filter(workflows::Column::DeletedAt.is_null())
        .order_by_desc(enrollments::Column::EnrolledAt)
        .limit(limit)
        .into_model::<CustomerSequence>()
        .all(&orm(&caller.db))
        .await?;
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let e = row.enrollment;
            json!({
                "enrollmentId": e.id,
                "sequenceId": e.sequence_id,
                "status": e.status,
                "currentStepIndex": e.current_step_index,
                "totalSteps": e.total_steps,
                "enrolledAt": js_date(e.enrolled_at),
                "completedAt": js_date_or_null(e.completed_at),
                "sequenceName": row.sequence_name,
                "sequenceStatus": row.sequence_status,
            })
        })
        .collect();
    let total = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    Ok(page(rows, total, false, None))
}
