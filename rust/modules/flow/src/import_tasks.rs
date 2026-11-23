//! The `flow.import-tasks` job (`ImportTasksWorkflow`,
//! `@weldsuite/flow-domain/workflows/import-tasks`): reads an import's JSON
//! payload from the `STORAGE` bucket and creates or updates the project's
//! tasks in 500-row batches, one step each, keeping the `task_import_jobs`
//! row's progress and errors up to date.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_flow_domain::numbering::allocate_task_numbers;
use weldsuite_flow_domain::stage::{TASK_STATUSES, normalize_task_status};
use weldsuite_kit::generate_id;
use weldsuite_ports::{BoxFuture, DynFileStore, Job, JobContext, JobError, StepRetry, step};
use weldsuite_schema::tenant::{
    project_pipeline_stages, task_import_jobs, tasks, workspace_members,
};

use crate::js::{Js, as_text, js_date, js_string};

/// The job's name.
pub const IMPORT_TASKS_JOB: &str = "flow.import-tasks";

const BATCH_SIZE: usize = 500;
const PRIORITIES: [&str; 5] = ["critical", "high", "medium", "low", "none"];
const TYPES: [&str; 7] = [
    "task",
    "bug",
    "story",
    "epic",
    "feature",
    "improvement",
    "subtask",
];

/// The job's parameters (`ImportTasksParams`); `workspaceId` is the Clerk
/// org id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportParams {
    pub job_id: String,
    pub workspace_id: String,
    pub user_id: String,
    pub project_id: String,
    pub r2_key: String,
}

/// Opens a workspace's tenant database outside a request, by its id or
/// Clerk org id.
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// The tenant databases of imports started by this process, by job id:
/// a job that runs here uses the database the request used.
fn started_here() -> &'static Mutex<HashMap<String, Started>> {
    static STARTED: std::sync::OnceLock<Mutex<HashMap<String, Started>>> =
        std::sync::OnceLock::new();
    STARTED.get_or_init(Mutex::default)
}

/// What a request that started a job here used.
#[derive(Clone)]
struct Started {
    db: PgPool,
    storage: Arc<dyn DynFileStore>,
}

/// Remember the request's database and bucket for the job `job_id`.
pub(crate) fn remember_request(job_id: &str, db: &PgPool, storage: &Arc<dyn DynFileStore>) {
    started_here()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(
            job_id.to_owned(),
            Started {
                db: db.clone(),
                storage: Arc::clone(storage),
            },
        );
}

/// The registered job.
pub struct ImportTasksJob {
    pub tenants: Option<TenantDatabases>,
    /// The `STORAGE` bucket (the public one).
    pub storage: Option<Arc<dyn DynFileStore>>,
}

impl ImportTasksJob {
    /// The bucket the request wrote the payload to, else the app's.
    fn storage_for(&self, params: &ImportParams) -> Option<Arc<dyn DynFileStore>> {
        started_here()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&params.job_id)
            .map(|started| Arc::clone(&started.storage))
            .or_else(|| self.storage.clone())
    }

    async fn database(&self, params: &ImportParams) -> Result<PgPool, JobError> {
        let remembered = started_here()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&params.job_id)
            .cloned();
        if let Some(started) = remembered {
            return Ok(started.db);
        }
        let Some(tenants) = &self.tenants else {
            return Err(JobError::failed("no tenant databases"));
        };
        tenants(params.workspace_id.clone())
            .await
            .map_err(JobError::failed)
    }
}

/// The stage and member lookups and the first free position.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Setup {
    stages: Vec<(String, (String, Option<String>))>,
    members: Vec<(String, String)>,
    start_position: i64,
}

/// One batch's outcome.
#[derive(Debug, Default)]
struct BatchResult {
    imported: i64,
    updated: i64,
    failed: i64,
    errors: Vec<Value>,
}

impl Job for ImportTasksJob {
    fn name(&self) -> &'static str {
        IMPORT_TASKS_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params: ImportParams = serde_json::from_value(payload)?;
            let result = self.import(ctx, &params).await;
            started_here()
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&params.job_id);
            result
        })
    }
}

impl ImportTasksJob {
    #[allow(clippy::too_many_lines)]
    async fn import(&self, ctx: &dyn JobContext, params: &ImportParams) -> Result<(), JobError> {
        let rows: Value = step(
            ctx,
            "load-payload",
            StepRetry::exponential(3, Duration::from_secs(5)),
            || async {
                let Some(storage) = self.storage_for(params) else {
                    return Err(JobError::failed("R2 STORAGE binding missing"));
                };
                let object = storage
                    .get_boxed(&params.r2_key)
                    .await
                    .map_err(JobError::failed)?
                    .ok_or_else(|| {
                        JobError::failed(format!("Payload missing from R2: {}", params.r2_key))
                    })?;
                Ok(serde_json::from_slice::<Value>(&object.bytes)?)
            },
        )
        .await?;
        let Value::Array(rows) = rows else {
            return Err(JobError::failed("Invalid payload — expected array"));
        };
        let total = rows.len();

        step(ctx, "mark-running", StepRetry::default(), || async {
            use task_import_jobs::Column;
            let db = self.database(params).await?;
            task_import_jobs::Entity::update_many()
                .col_expr(Column::Status, Expr::value("running"))
                .col_expr(
                    Column::Total,
                    Expr::value(i32::try_from(total).unwrap_or(i32::MAX)),
                )
                .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
                .filter(Column::Id.eq(params.job_id.as_str()))
                .exec(&orm(&db))
                .await
                .map_err(|error| job_failed(&error))?;
            Ok(())
        })
        .await?;

        let setup: Setup = step(
            ctx,
            "load-resolution-maps",
            StepRetry::default(),
            || async {
                let db = self.database(params).await?;
                load_setup(&db, &params.project_id)
                    .await
                    .map_err(|error| job_failed(&error))
            },
        )
        .await?;
        let mut stage_map: HashMap<String, (String, Option<String>)> = HashMap::new();
        for (name, stage) in setup.stages {
            stage_map.insert(name, stage);
        }
        let mut member_map: HashMap<String, String> = HashMap::new();
        for (email, user) in setup.members {
            member_map.insert(email, user);
        }
        let maps = Maps {
            stages: stage_map,
            members: member_map,
        };
        let next_position = Mutex::new(setup.start_position);

        let mut offset = 0;
        while offset < total {
            let batch: Vec<Value> = rows[offset..(offset + BATCH_SIZE).min(total)].to_vec();
            let name = format!("process-batch-{offset}");
            let batch_len = batch.len();
            step(
                ctx,
                &name,
                StepRetry::exponential(2, Duration::from_secs(10)),
                || async {
                    let db = self.database(params).await?;
                    let result = process_batch(&db, &batch, offset, params, &maps, &next_position)
                        .await
                        .map_err(|error| job_failed(&error))?;
                    record_batch(&db, &params.job_id, batch_len, &result)
                        .await
                        .map_err(|error| job_failed(&error))?;
                    Ok(())
                },
            )
            .await?;
            offset += BATCH_SIZE;
        }

        step(ctx, "finalize", StepRetry::default(), || async {
            use task_import_jobs::Column;
            let db = self.database(params).await?;
            let at = utc_now();
            task_import_jobs::Entity::update_many()
                .col_expr(Column::Status, Expr::value("completed"))
                .col_expr(Column::CompletedAt, Expr::value(at))
                .col_expr(Column::UpdatedAt, Expr::value(at))
                .filter(Column::Id.eq(params.job_id.as_str()))
                .exec(&orm(&db))
                .await
                .map_err(|error| job_failed(&error))?;
            if let Some(storage) = self.storage_for(params) {
                let _ = storage.delete_boxed(&params.r2_key).await;
            }
            Ok(())
        })
        .await
    }
}

/// The batch's counts and its first 50 errors added to the job row:
/// `processed = processed + n, …, errors = coalesce(errors, '[]') || $errors`.
async fn record_batch(
    db: &PgPool,
    job_id: &str,
    batch_len: usize,
    result: &BatchResult,
) -> Result<(), DbErr> {
    use task_import_jobs::Column;
    let errors: Vec<Value> = result.errors.iter().take(50).cloned().collect();
    let plus = |column: Column, n: i32| {
        sea_orm::ExprTrait::add(Expr::col((task_import_jobs::Entity, column)), n)
    };
    let count = |n: i64| i32::try_from(n).unwrap_or(i32::MAX);
    let all_errors = sea_orm::sea_query::extension::postgres::PgExpr::concat(
        Expr::from(Func::coalesce([
            Expr::col((task_import_jobs::Entity, Column::Errors)),
            Expr::val(json!([])),
        ])),
        Expr::val(Value::Array(errors)),
    );
    task_import_jobs::Entity::update_many()
        .col_expr(
            Column::Processed,
            plus(
                Column::Processed,
                i32::try_from(batch_len).unwrap_or(i32::MAX),
            ),
        )
        .col_expr(
            Column::Imported,
            plus(Column::Imported, count(result.imported)),
        )
        .col_expr(
            Column::Updated,
            plus(Column::Updated, count(result.updated)),
        )
        .col_expr(Column::Failed, plus(Column::Failed, count(result.failed)))
        .col_expr(Column::Errors, all_errors)
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::Id.eq(job_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// A failed step, with the database's text as sqlx wrote it.
fn job_failed(error: &DbErr) -> JobError {
    JobError::failed(db_text(error))
}

/// The `sqlx::Error` inside a SeaORM error, when it holds one.
fn sqlx_of(error: &DbErr) -> Option<&sqlx::Error> {
    match error {
        DbErr::Conn(sea_orm::RuntimeErr::SqlxError(inner))
        | DbErr::Exec(sea_orm::RuntimeErr::SqlxError(inner))
        | DbErr::Query(sea_orm::RuntimeErr::SqlxError(inner)) => Some(inner.as_ref()),
        _ => None,
    }
}

/// The error's text: sqlx's own when the statement failed in sqlx.
fn db_text(error: &DbErr) -> String {
    sqlx_of(error).map_or_else(|| error.to_string(), ToString::to_string)
}

async fn load_setup(db: &PgPool, project_id: &str) -> Result<Setup, DbErr> {
    let stages: Vec<(String, String, Option<String>)> = {
        use project_pipeline_stages::Column;
        project_pipeline_stages::Entity::find()
            .select_only()
            .columns([Column::Id, Column::Name, Column::SystemStatus])
            .filter(Column::ProjectId.eq(project_id))
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(db))
            .await?
    };
    let members: Vec<(String, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .columns([
            workspace_members::Column::UserId,
            workspace_members::Column::Email,
        ])
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    // `coalesce(max(position), 0)`.
    let max: Option<Option<i32>> = tasks::Entity::find()
        .select_only()
        .column_as(tasks::Column::Position.max(), "max")
        .filter(tasks::Column::ProjectId.eq(project_id))
        .filter(tasks::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let max = max.flatten().unwrap_or(0);
    Ok(Setup {
        stages: stages
            .into_iter()
            .map(|(id, name, status)| (name.to_lowercase().trim().to_owned(), (id, status)))
            .collect(),
        members: members
            .into_iter()
            .filter_map(|(user, email)| {
                email
                    .filter(|e| !e.is_empty())
                    .map(|e| (e.to_lowercase().trim().to_owned(), user))
            })
            .collect(),
        start_position: i64::from(max) + 1,
    })
}

struct Maps {
    stages: HashMap<String, (String, Option<String>)>,
    members: HashMap<String, String>,
}

/// A row's field as JavaScript reads `row.field`.
fn field<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    row.get(key)
}

/// `value ? String(value).trim() : fallback`.
fn text_of(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if !weldsuite_flow_domain::js::truthy(Some(value)) {
        return None;
    }
    Some(weldsuite_kit::validation::js_trim(&js_string(&Js::from_jsonb(value))).to_owned())
}

/// `normalizeEnum`.
fn normalize_enum(
    raw: Option<&Value>,
    valid: &[&str],
    fallback: &str,
    sanitize: impl Fn(String) -> String,
) -> String {
    let Some(raw) = raw.filter(|r| weldsuite_flow_domain::js::truthy(Some(r))) else {
        return fallback.to_owned();
    };
    let value = sanitize(
        weldsuite_kit::validation::js_trim(&as_text(&Js::from_jsonb(raw)).to_lowercase())
            .to_owned(),
    );
    if valid.contains(&value.as_str()) {
        value
    } else {
        fallback.to_owned()
    }
}

/// `parseDate`.
fn parse_date(value: Option<&Value>) -> Option<String> {
    let value = value.filter(|v| weldsuite_flow_domain::js::truthy(Some(v)))?;
    js_date(weldsuite_kit::validation::js_trim(&as_text(
        &Js::from_jsonb(value),
    )))
}

/// `normalizeListField`.
fn list_field(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Array(items)) => {
            let items: Vec<Value> = items
                .iter()
                .filter(|v| matches!(v, Value::String(s) if !s.is_empty()))
                .cloned()
                .collect();
            if items.is_empty() {
                Value::Null
            } else {
                Value::Array(items)
            }
        }
        Some(Value::String(text)) if !text.is_empty() => {
            let items: Vec<Value> = text
                .split([',', ';'])
                .map(|t| weldsuite_kit::validation::js_trim(t).to_owned())
                .filter(|t| !t.is_empty())
                .map(Value::String)
                .collect();
            if items.is_empty() {
                Value::Null
            } else {
                Value::Array(items)
            }
        }
        _ => Value::Null,
    }
}

/// `normalizeTask`: the columns an import row writes.
fn normalize_task(row: &Value, maps: &Maps) -> Value {
    let title = text_of(field(row, "title")).unwrap_or_default();
    let mut status = normalize_enum(field(row, "status"), &TASK_STATUSES, "todo", |v| {
        normalize_task_status(&v.replace(|c: char| c.is_whitespace() || c == '-', "_"))
    });
    let priority = normalize_enum(field(row, "priority"), &PRIORITIES, "medium", |v| v);
    let kind = normalize_enum(field(row, "type"), &TYPES, "task", |v| v);
    let mut stage_id = Value::Null;
    if weldsuite_flow_domain::js::truthy(field(row, "stageName"))
        && let Some((id, system_status)) = maps.stages.get(&js_lower_trim(field(row, "stageName")))
    {
        stage_id = json!(id);
        status = system_status
            .as_deref()
            .map(normalize_task_status)
            .unwrap_or_default();
    }
    let assignee = field(row, "assigneeEmail")
        .filter(|v| weldsuite_flow_domain::js::truthy(Some(v)))
        .and_then(|_| {
            maps.members
                .get(&js_lower_trim(field(row, "assigneeEmail")))
        })
        .filter(|id| !id.is_empty())
        .cloned();
    json!({
        "title": title,
        "description": text_of(field(row, "description")),
        "status": status,
        "stageId": stage_id,
        "priority": priority,
        "type": kind,
        "assigneeId": assignee,
        "assigneeIds": assignee.as_ref().map(|a| json!([a])),
        "startDate": parse_date(field(row, "startDate")),
        "dueDate": parse_date(field(row, "dueDate")),
        "estimatedHours": text_of(field(row, "estimatedHours")),
        "tags": list_field(field(row, "tags")),
        "labels": list_field(field(row, "labels")),
    })
}

/// `String(value).toLowerCase().trim()`.
fn js_lower_trim(value: Option<&Value>) -> String {
    value.map_or_else(String::new, |v| {
        weldsuite_kit::validation::js_trim(&js_string(&Js::from_jsonb(v)).to_lowercase()).to_owned()
    })
}

/// The database's own message for a failed statement (`err.message`).
fn db_message(error: &DbErr) -> String {
    match sqlx_of(error) {
        Some(sqlx::Error::Database(db)) => db.message().to_owned(),
        Some(other) => other.to_string(),
        None => error.to_string(),
    }
}

#[allow(clippy::too_many_lines)]
async fn process_batch(
    db: &PgPool,
    batch: &[Value],
    start_index: usize,
    params: &ImportParams,
    maps: &Maps,
    next_position: &Mutex<i64>,
) -> Result<BatchResult, DbErr> {
    let now = utc_now();
    let mut result = BatchResult::default();
    let mut upserts: Vec<(&Value, usize, String, String)> = Vec::new();
    let mut inserts: Vec<(&Value, usize, String)> = Vec::new();
    for (i, row) in batch.iter().enumerate() {
        let row_num = start_index + i + 1;
        let title = text_of(field(row, "title")).unwrap_or_default();
        if title.is_empty() {
            result.errors.push(
                json!({ "row": row_num, "title": "(missing)", "error": "Title is required" }),
            );
            result.failed += 1;
            continue;
        }
        if let Some(key) = text_of(field(row, "key")) {
            upserts.push((row, row_num, title, key));
        } else {
            inserts.push((row, row_num, title));
        }
    }
    let take_position = || {
        let mut next = next_position.lock().unwrap_or_else(PoisonError::into_inner);
        let position = *next;
        *next += 1;
        position
    };

    if !upserts.is_empty() {
        let keys: Vec<String> = upserts.iter().map(|u| u.3.clone()).collect();
        let existing: Vec<(String, Option<String>)> = tasks::Entity::find()
            .select_only()
            .columns([tasks::Column::Id, tasks::Column::Key])
            .filter(tasks::Column::ProjectId.eq(params.project_id.as_str()))
            .filter(tasks::Column::Key.is_in(keys))
            .filter(tasks::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(db))
            .await?;
        let by_key: HashMap<String, String> = existing
            .into_iter()
            .filter_map(|(id, key)| key.map(|k| (k, id)))
            .collect();
        let new_count = upserts
            .iter()
            .filter(|u| !by_key.contains_key(&u.3))
            .count();
        let numbers = allocate_task_numbers(&orm(db), i64::try_from(new_count).unwrap_or(0))
            .await?;
        let mut cursor = 0;
        for (row, row_num, title, key) in &upserts {
            let values = normalize_task(row, maps);
            let outcome = if let Some(id) = by_key.get(key) {
                update_task(db, id, &values, now).await.map(|()| true)
            } else {
                let mut record = values.clone();
                record["id"] = json!(generate_id("task"));
                record["number"] = json!(numbers.get(cursor));
                cursor += 1;
                record["key"] = json!(key);
                record["position"] = json!(take_position());
                insert_rows(db, &[record], params, now)
                    .await
                    .map(|()| false)
            };
            match outcome {
                Ok(true) => result.updated += 1,
                Ok(false) => result.imported += 1,
                Err(error) => {
                    result.errors.push(
                        json!({ "row": row_num, "title": title, "error": db_message(&error) }),
                    );
                    result.failed += 1;
                }
            }
        }
    }

    if !inserts.is_empty() {
        let numbers = allocate_task_numbers(&orm(db), i64::try_from(inserts.len()).unwrap_or(0))
            .await?;
        let records: Vec<Value> = inserts
            .iter()
            .enumerate()
            .map(|(i, (row, _, _))| {
                let mut record = normalize_task(row, maps);
                record["id"] = json!(generate_id("task"));
                record["number"] = json!(numbers.get(i));
                record["key"] = Value::Null;
                record["position"] = json!(take_position());
                record
            })
            .collect();
        for chunk in records.chunks(100) {
            if insert_rows(db, chunk, params, now).await.is_ok() {
                result.imported += i64::try_from(chunk.len()).unwrap_or(0);
                continue;
            }
            for record in chunk {
                match insert_rows(db, std::slice::from_ref(record), params, now).await {
                    Ok(()) => result.imported += 1,
                    Err(error) => {
                        let title = record["title"]
                            .as_str()
                            .filter(|t| !t.is_empty())
                            .unwrap_or("(unknown)");
                        result
                            .errors
                            .push(json!({ "row": 0, "title": title, "error": db_message(&error) }));
                        result.failed += 1;
                    }
                }
            }
        }
    }
    Ok(result)
}

/// A field of the normalised task as `$values::jsonb->>'key'` reads it (the
/// values are strings or `null`).
fn text_of_value(values: &Value, key: &str) -> Option<String> {
    values.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// `nullif($values::jsonb->'key', 'null')`: a list field, `None` for `null`.
fn json_of_value(values: &Value, key: &str) -> Option<Value> {
    values.get(key).filter(|v| !v.is_null()).cloned()
}

/// A text value cast to the column's type in the statement (`::timestamp`,
/// `::numeric`), so Postgres reads it (and refuses it) as it did.
fn cast(text: Option<String>, to: &'static str) -> Expr {
    sea_orm::ExprTrait::cast_as(Expr::value(text), to)
}

/// The import's update of a task matched by its key.
async fn update_task(
    db: &PgPool,
    id: &str,
    values: &Value,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    use tasks::Column;
    let text = |key: &str| Expr::value(text_of_value(values, key));
    let list = |key: &str| Expr::value(json_of_value(values, key));
    tasks::Entity::update_many()
        .col_expr(Column::Title, text("title"))
        .col_expr(Column::Description, text("description"))
        .col_expr(Column::Status, text("status"))
        .col_expr(Column::StageId, text("stageId"))
        .col_expr(Column::Priority, text("priority"))
        .col_expr(Column::Type, text("type"))
        .col_expr(Column::AssigneeId, text("assigneeId"))
        .col_expr(Column::AssigneeIds, list("assigneeIds"))
        .col_expr(
            Column::StartDate,
            cast(text_of_value(values, "startDate"), "timestamp"),
        )
        .col_expr(
            Column::DueDate,
            cast(text_of_value(values, "dueDate"), "timestamp"),
        )
        .col_expr(
            Column::EstimatedHours,
            cast(text_of_value(values, "estimatedHours"), "numeric"),
        )
        .col_expr(Column::Tags, list("tags"))
        .col_expr(Column::Labels, list("labels"))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// One multi-row insert (Drizzle's `insert(tasks).values(chunk)`); the dates
/// and hours are cast from their text, the number and position to `int`, as
/// `jsonb_to_recordset` read them.
async fn insert_rows(
    db: &PgPool,
    records: &[Value],
    params: &ImportParams,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    use tasks::Column;
    let mut insert = Query::insert();
    insert.into_table(tasks::Entity).columns([
        Column::Id,
        Column::Number,
        Column::ProjectId,
        Column::Key,
        Column::Title,
        Column::Description,
        Column::Status,
        Column::StageId,
        Column::Priority,
        Column::Type,
        Column::AssigneeId,
        Column::AssigneeIds,
        Column::StartDate,
        Column::DueDate,
        Column::EstimatedHours,
        Column::Tags,
        Column::Labels,
        Column::ReporterId,
        Column::IsBillable,
        Column::Position,
        Column::Progress,
        Column::CreatedAt,
        Column::UpdatedAt,
    ]);
    for r in records {
        let text = |key: &str| Expr::value(text_of_value(r, key));
        let list = |key: &str| Expr::value(json_of_value(r, key));
        let int = |key: &str| {
            sea_orm::ExprTrait::cast_as(Expr::value(r.get(key).and_then(Value::as_i64)), "int")
        };
        insert
            .values([
                text("id"),
                int("number"),
                Expr::value(params.project_id.as_str()),
                text("key"),
                text("title"),
                text("description"),
                text("status"),
                text("stageId"),
                text("priority"),
                text("type"),
                text("assigneeId"),
                list("assigneeIds"),
                cast(text_of_value(r, "startDate"), "timestamp"),
                cast(text_of_value(r, "dueDate"), "timestamp"),
                cast(text_of_value(r, "estimatedHours"), "numeric"),
                list("tags"),
                list("labels"),
                Expr::value(params.user_id.as_str()),
                Expr::value(true),
                int("position"),
                cast(Some("0".to_owned()), "numeric"),
                Expr::value(now),
                Expr::value(now),
            ])
            .map_err(|error| DbErr::Custom(error.to_string()))?;
    }
    orm(db).execute(&insert).await?;
    Ok(())
}
