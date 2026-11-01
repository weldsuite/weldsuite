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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::SEQUENCE_UPDATED;
use weldsuite_crm_domain::drizzle_row;
use weldsuite_crm_domain::sequence_run::{EXECUTE_SEQUENCE_JOB, SEQUENCE_RESUME_EVENT};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_ports::{BoxFuture, DynJobs, JobRequest};

use crate::{Answer, Caller, CrmState, answer, js_limit, now, page, query_map, validate};

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
    let ids: Vec<String> = enrollments.iter().map(|(id, _)| id.clone()).collect();
    let mut claimed: Vec<String> = Vec::new();
    for chunk in ids.chunks(ID_CHUNK) {
        let rows: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar(
            "update sequence_enrollments set execution_id = id
             where id = any($1) and status = 'active' and execution_id is null returning id",
        )
        .bind(chunk)
        .fetch_all(&caller.db)
        .await;
        match rows {
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
        let released = sqlx::query(
            "update sequence_enrollments set execution_id = null
             where id = any($1) and execution_id = id",
        )
        .bind(chunk)
        .execute(&caller.db)
        .await;
        if let Err(error) = released {
            tracing::error!(%error, "[crm-api/sequences] failed to release enrollment claims");
        }
    }
    outcomes
        .iter()
        .filter(|outcome| **outcome == RunStart::Triggered)
        .count()
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
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select id, customer_id from sequence_enrollments
         where sequence_id = $1 and status = 'active' and execution_id is null",
    )
    .bind(ctx.sequence_id)
    .fetch_all(&caller.db)
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
    let db = &caller.db;
    sqlx::query("update workflows set status = 'active', updated_at = $2::timestamp where id = $1")
        .bind(ctx.sequence_id)
        .bind(now())
        .execute(db)
        .await?;
    let activated: Vec<String> = sqlx::query_scalar(
        "update sequence_enrollments set status = 'active'
         where sequence_id = $1 and status = 'pending' returning id",
    )
    .bind(ctx.sequence_id)
    .fetch_all(db)
    .await?;
    let mut resumed = 0;
    if resume_paused {
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(
            "update sequence_enrollments set status = 'active', paused_at = null
             where sequence_id = $1 and status = 'paused' returning id, execution_id",
        )
        .bind(ctx.sequence_id)
        .fetch_all(db)
        .await?;
        resumed = rows.len();
        let parked: Vec<String> = rows.into_iter().filter_map(|(_, run)| run).collect();
        wake_runs(state, caller, &parked).await;
    }
    start_pending(state, caller, ctx).await?;
    Ok((activated.len(), resumed))
}

// ── Reads ───────────────────────────────────────────────────────────────────

/// One `where` condition with `{}` where its arguments go.
struct Cond {
    sql: String,
    args: Vec<String>,
}

fn cond(sql: &str, args: &[&str]) -> Cond {
    Cond {
        sql: sql.to_owned(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
    }
}

/// `and(...conditions)` numbered from `$1`, and its arguments.
fn render(conds: &[Cond]) -> (String, Vec<String>) {
    let mut args = Vec::new();
    let parts: Vec<String> = conds
        .iter()
        .map(|c| {
            let mut sql = String::new();
            let mut pieces = c.sql.split("{}");
            sql.push_str(pieces.next().unwrap_or_default());
            for (arg, piece) in c.args.iter().zip(pieces) {
                args.push(arg.clone());
                sql.push('$');
                sql.push_str(&args.len().to_string());
                sql.push_str(piece);
            }
            sql
        })
        .collect();
    (parts.join(" and "), args)
}

/// Run a `select to_jsonb …` with text arguments. The SQL is built here
/// from fixed fragments; every value the caller sent is bound.
async fn fetch_rows(
    caller: &Caller,
    sql: &str,
    args: &[String],
) -> Result<Vec<Value>, sqlx::Error> {
    let mut query = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(sql.to_owned()));
    for arg in args {
        query = query.bind(arg);
    }
    Ok(query
        .fetch_all(&caller.db)
        .await?
        .into_iter()
        .map(drizzle_row)
        .collect())
}

async fn fetch_count(caller: &Caller, sql: &str, args: &[String]) -> Result<i64, sqlx::Error> {
    let mut query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql.to_owned()));
    for arg in args {
        query = query.bind(arg);
    }
    query.fetch_one(&caller.db).await
}

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
fn limit_sql(limit: Option<i64>) -> String {
    limit
        .filter(|n| *n >= 0)
        .map_or_else(String::new, |n| format!(" limit {n}"))
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

/// The cursor row's `created_at` as Drizzle reads and binds it back.
const MS: &str = "to_char(date_trunc('milliseconds', {col}), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS')";

fn ms_of(column: &str) -> String {
    MS.replace("{col}", column)
}

/// `(select count(*)::int from sequence_enrollments … status <predicate>)`.
fn enrollment_count(name: &str, predicate: &str) -> String {
    format!(
        "'{name}', (select count(*)::int from sequence_enrollments s
            where s.sequence_id = w.id and s.status {predicate})"
    )
}

/// `conditions.slice(0, -1)` whenever a cursor was sent (it drops the last
/// condition even when the cursor row was not found).
fn count_conds(conds: &[Cond], cursor: bool) -> &[Cond] {
    if cursor {
        &conds[..conds.len() - 1]
    } else {
        conds
    }
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
    let q = query_map(raw);
    let limit = js_limit(q.get("limit"), 50, 100);
    let mut conds = vec![
        cond("w.deleted_at is null", &[]),
        cond("w.tags::jsonb ? '__type:sequence'", &[]),
    ];
    if let Some(search) = q.get("search").filter(|s| !s.is_empty()) {
        let term = format!("%{search}%");
        conds.push(cond(
            "(w.name like {} or w.description like {})",
            &[&term, &term],
        ));
    }
    let cursor = q.get("cursor").filter(|c| !c.is_empty());
    if let Some(cursor) = cursor {
        let row: Option<(Option<String>, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select {}, id from workflows where id = $1 limit 1",
            ms_of("created_at")
        )))
        .bind(cursor)
        .fetch_optional(&caller.db)
        .await?;
        if let Some((Some(created), id)) = row {
            conds.push(cond(
                "(w.created_at < {}::timestamp or (w.created_at = {}::timestamp and w.id < {}))",
                &[&created, &created, &id],
            ));
        }
    }
    let (filter, args) = render(&conds);
    let counts = [
        enrollment_count("enrolled_count", "!= 'unenrolled'"),
        enrollment_count("active_enrolled_count", "= 'active'"),
        enrollment_count("pending_enrolled_count", "= 'pending'"),
    ]
    .join(", ");
    let rows = fetch_rows(
        caller,
        &format!(
            "select to_jsonb(w) || jsonb_build_object({counts}) from workflows w where {filter}
             order by w.created_at desc, w.id desc{}",
            limit_sql(limit.map(|n| n + 1))
        ),
        &args,
    )
    .await?;
    let (count_filter, count_args) = render(count_conds(&conds, cursor.is_some()));
    let total = fetch_count(
        caller,
        &format!("select count(*) from workflows w where {count_filter}"),
        &count_args,
    )
    .await?;
    let rows: Vec<Value> = rows.iter().map(|row| pick(row, &LIST_KEYS)).collect();
    let (rows, has_more, next) = js_cut(rows, limit);
    Ok(page(rows, total, has_more, next))
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
    let counts = [
        enrollment_count("enrolled_count", "!= 'unenrolled'"),
        enrollment_count("active_enrolled_count", "= 'active'"),
        enrollment_count("pending_enrolled_count", "= 'pending'"),
        enrollment_count("completed_enrolled_count", "= 'completed'"),
        enrollment_count("failed_enrolled_count", "= 'failed'"),
    ]
    .join(", ");
    let rows = fetch_rows(
        caller,
        &format!(
            "select to_jsonb(w) || jsonb_build_object({counts}) from workflows w
             where w.id = $1 and w.deleted_at is null limit 1"
        ),
        &[id.to_owned()],
    )
    .await?;
    let Some(row) = rows.first() else {
        return Ok(ApiError::not_found("Sequence", Some(id)).into_response());
    };
    Ok(Data(pick(row, &DETAIL_KEYS)).into_response())
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

async fn run_enrollments(caller: &Caller, id: &str, raw: Option<&str>) -> Answer {
    let q = query_map(raw);
    let limit = js_limit(q.get("limit"), 25, 100);
    let mut conds = vec![
        cond("e.sequence_id = {}", &[id]),
        cond("p.deleted_at is null", &[]),
    ];
    if let Some(status) = q.get("status").filter(|s| !s.is_empty()) {
        conds.push(cond("e.status = {}", &[status]));
    }
    if let Some(search) = q.get("search").filter(|s| !s.is_empty()) {
        let term = format!("%{search}%");
        conds.push(cond(
            "(p.display_name like {} or p.email like {})",
            &[&term, &term],
        ));
    }
    let cursor = q.get("cursor").filter(|c| !c.is_empty());
    if let Some(cursor) = cursor {
        let row: Option<(Option<String>, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select {}, id from sequence_enrollments where id = $1 limit 1",
            ms_of("enrolled_at")
        )))
        .bind(cursor)
        .fetch_optional(&caller.db)
        .await?;
        if let Some((Some(enrolled), row_id)) = row {
            conds.push(cond(
                "(e.enrolled_at < {}::timestamp or (e.enrolled_at = {}::timestamp and e.id < {}))",
                &[&enrolled, &enrolled, &row_id],
            ));
        }
    }
    let (filter, args) = render(&conds);
    let rows = fetch_rows(
        caller,
        &format!(
            "select to_jsonb(e) || jsonb_build_object(
               'customer_email', coalesce(e.customer_snapshot->>'email', p.email),
               'customer_first_name', coalesce(e.customer_snapshot->>'firstName', p.first_name),
               'customer_last_name', coalesce(e.customer_snapshot->>'lastName', p.last_name),
               'customer_full_name', coalesce(e.customer_snapshot->>'fullName', p.display_name),
               'customer_company_name', e.customer_snapshot->>'companyName')
             from sequence_enrollments e inner join people p on e.customer_id = p.id
             where {filter} order by e.enrolled_at desc, e.id desc{}",
            limit_sql(limit.map(|n| n + 1))
        ),
        &args,
    )
    .await?;
    let (count_filter, count_args) = render(count_conds(&conds, cursor.is_some()));
    let total = fetch_count(
        caller,
        &format!(
            "select count(*) from sequence_enrollments e inner join people p on e.customer_id = p.id
             where {count_filter}"
        ),
        &count_args,
    )
    .await?;
    let steps: Option<Option<Value>> =
        sqlx::query_scalar("select steps from workflows where id = $1 limit 1")
            .bind(id)
            .fetch_optional(&caller.db)
            .await?;
    let step_count = match steps.flatten() {
        Some(Value::Array(steps)) => steps.len(),
        _ => 0,
    };
    let (rows, has_more, next) = js_cut(rows, limit);
    let rows = rows
        .iter()
        .map(|row| {
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
        })
        .collect();
    Ok(page(rows, total, has_more, next))
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
    let db = &caller.db;
    let mut ids: Vec<String> = Vec::new();
    for id in requested {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let sequence: Option<(Option<String>, Option<Value>)> = sqlx::query_as(
        "select status, steps from workflows where id = $1 and deleted_at is null limit 1",
    )
    .bind(sequence_id)
    .fetch_optional(db)
    .await?;
    let people: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(p) from people p where p.id = any($1) and p.deleted_at is null",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let employments: Vec<(String, String)> = sqlx::query_as(
        "select pc.person_id, c.display_name from person_companies pc
         inner join companies c on pc.company_id = c.id
         where pc.person_id = any($1) and pc.is_primary = true and pc.ended_at is null",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let enrolled: Vec<String> = sqlx::query_scalar(
        "select customer_id from sequence_enrollments where sequence_id = $1 and customer_id = any($2)",
    )
    .bind(sequence_id)
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let Some((status, steps)) = sequence else {
        return Ok(ApiError::not_found("Sequence", Some(sequence_id)).into_response());
    };
    let active = status.as_deref() == Some("active");
    let total_steps = match steps {
        Some(Value::Array(steps)) => steps.len(),
        _ => 0,
    };
    let people: Vec<Value> = people.into_iter().map(drizzle_row).collect();
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
    let at = now();
    let rows: Vec<Value> = to_enroll
        .iter()
        .map(|customer| {
            json!({
                "id": generate_id("senr"),
                "sequence_id": sequence_id,
                "customer_id": customer,
                "counterparty_id": customer,
                "status": if active { "active" } else { "pending" },
                "total_steps": total_steps,
                "enrolled_by": caller.user_id,
                "enrolled_at": at,
                "customer_snapshot": snapshot(
                    person(customer).unwrap_or(&Value::Null),
                    companies.get(customer.as_str()).copied(),
                ),
            })
        })
        .collect();
    let inserted: Vec<(String, String)> = sqlx::query_as(
        "insert into sequence_enrollments (id, sequence_id, customer_id, counterparty_id, status,
           total_steps, enrolled_by, enrolled_at, customer_snapshot)
         select x.id, x.sequence_id, x.customer_id, x.counterparty_id, x.status, x.total_steps,
           x.enrolled_by, x.enrolled_at::timestamp, x.customer_snapshot
         from jsonb_to_recordset($1::jsonb) as x(id text, sequence_id text, customer_id text,
           counterparty_id text, status text, total_steps int, enrolled_by text, enrolled_at text,
           customer_snapshot jsonb)
         on conflict (sequence_id, customer_id) do nothing
         returning id, customer_id",
    )
    .bind(Value::Array(rows).to_string())
    .fetch_all(db)
    .await?;
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
) -> Result<Option<(Option<String>, Option<Value>)>, sqlx::Error> {
    sqlx::query_as(
        "select status, steps from workflows where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
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
    let enrolled: i64 = sqlx::query_scalar(
        "select count(*) from sequence_enrollments where sequence_id = $1 and status != 'unenrolled'",
    )
    .bind(id)
    .fetch_one(&caller.db)
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
    let at = now();
    sqlx::query("update workflows set status = 'paused', updated_at = $2::timestamp where id = $1")
        .bind(id)
        .bind(&at)
        .execute(&caller.db)
        .await?;
    let paused: Vec<String> = sqlx::query_scalar(
        "update sequence_enrollments set status = 'paused', paused_at = $2::timestamp
         where sequence_id = $1 and status = 'active' returning id",
    )
    .bind(id)
    .bind(&at)
    .fetch_all(&caller.db)
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
    let existing: Option<(String, Option<String>)> = sqlx::query_as(
        "select status, execution_id from sequence_enrollments where id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    let Some((status, execution_id)) = existing else {
        return Ok(ApiError::not_found("Enrollment", Some(id)).into_response());
    };
    sqlx::query(
        "update sequence_enrollments set status = 'unenrolled', unenrolled_at = $2::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(now())
    .execute(&caller.db)
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
    let status: Option<String> = sqlx::query_scalar(
        "select status from sequence_enrollments where id = $1 and sequence_id = $2 limit 1",
    )
    .bind(id)
    .bind(sequence_id)
    .fetch_optional(&caller.db)
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
    sqlx::query(
        "update sequence_enrollments set status = 'paused', paused_at = $2::timestamp
         where id = $1 and status = 'active'",
    )
    .bind(id)
    .bind(now())
    .execute(&caller.db)
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
    let existing: Option<(String, String, Option<String>)> = sqlx::query_as(
        "select customer_id, status, execution_id from sequence_enrollments
         where id = $1 and sequence_id = $2 limit 1",
    )
    .bind(id)
    .bind(sequence_id)
    .fetch_optional(&caller.db)
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
    sqlx::query(
        "update sequence_enrollments set status = 'active', paused_at = null
         where id = $1 and status = 'paused'",
    )
    .bind(id)
    .execute(&caller.db)
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

async fn run_customer_sequences(caller: &Caller, customer_id: &str, raw: Option<&str>) -> Answer {
    let q = query_map(raw);
    let limit = limit_sql(js_limit(q.get("limit"), 50, 100));
    let rows = fetch_rows(
        caller,
        &format!(
            "select jsonb_build_object('enrollment_id', e.id, 'sequence_id', e.sequence_id,
               'status', e.status, 'current_step_index', e.current_step_index,
               'total_steps', e.total_steps, 'enrolled_at', e.enrolled_at,
               'completed_at', e.completed_at, 'sequence_name', w.name, 'sequence_status', w.status)
             from sequence_enrollments e inner join workflows w on e.sequence_id = w.id
             where e.customer_id = $1 and w.deleted_at is null
             order by e.enrolled_at desc{limit}"
        ),
        &[customer_id.to_owned()],
    )
    .await?;
    let total = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    Ok(page(rows, total, false, None))
}
