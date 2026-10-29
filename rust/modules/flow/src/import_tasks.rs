//! The `flow.import-tasks` job (`ImportTasksWorkflow`,
//! `@weldsuite/flow-domain/workflows/import-tasks`): reads an import's JSON
//! payload from the `STORAGE` bucket and creates or updates the project's
//! tasks in 500-row batches, one step each, keeping the `task_import_jobs`
//! row's progress and errors up to date.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_flow_domain::numbering::allocate_task_numbers;
use weldsuite_flow_domain::stage::{TASK_STATUSES, normalize_task_status};
use weldsuite_kit::generate_id;
use weldsuite_ports::{BoxFuture, DynFileStore, Job, JobContext, JobError, StepRetry, step};

use crate::js::{Js, as_text, js_date, js_string};
use crate::now;

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
            let db = self.database(params).await?;
            sqlx::query(
                "update task_import_jobs set status = 'running', total = $2, updated_at = $3::timestamp
                 where id = $1",
            )
            .bind(&params.job_id)
            .bind(i32::try_from(total).unwrap_or(i32::MAX))
            .bind(now())
            .execute(&db)
            .await
            .map_err(JobError::failed)?;
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
                    .map_err(JobError::failed)
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
                        .map_err(JobError::failed)?;
                    let errors: Vec<Value> = result.errors.iter().take(50).cloned().collect();
                    sqlx::query(
                        "update task_import_jobs set
                             processed = processed + $2, imported = imported + $3,
                             updated = updated + $4, failed = failed + $5,
                             errors = coalesce(errors, '[]'::jsonb) || $6::jsonb,
                             updated_at = $7::timestamp
                         where id = $1",
                    )
                    .bind(&params.job_id)
                    .bind(i32::try_from(batch_len).unwrap_or(i32::MAX))
                    .bind(i32::try_from(result.imported).unwrap_or(i32::MAX))
                    .bind(i32::try_from(result.updated).unwrap_or(i32::MAX))
                    .bind(i32::try_from(result.failed).unwrap_or(i32::MAX))
                    .bind(Value::Array(errors))
                    .bind(now())
                    .execute(&db)
                    .await
                    .map_err(JobError::failed)?;
                    Ok(())
                },
            )
            .await?;
            offset += BATCH_SIZE;
        }

        step(ctx, "finalize", StepRetry::default(), || async {
            let db = self.database(params).await?;
            let at = now();
            sqlx::query(
                "update task_import_jobs set status = 'completed', completed_at = $2::timestamp,
                        updated_at = $2::timestamp
                 where id = $1",
            )
            .bind(&params.job_id)
            .bind(&at)
            .execute(&db)
            .await
            .map_err(JobError::failed)?;
            if let Some(storage) = self.storage_for(params) {
                let _ = storage.delete_boxed(&params.r2_key).await;
            }
            Ok(())
        })
        .await
    }
}

async fn load_setup(db: &PgPool, project_id: &str) -> Result<Setup, sqlx::Error> {
    let stages: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "select id, name, system_status from project_pipeline_stages
         where project_id = $1 and deleted_at is null",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let members: Vec<(String, Option<String>)> =
        sqlx::query_as("select user_id, email from workspace_members where deleted_at is null")
            .fetch_all(db)
            .await?;
    let max: i32 = sqlx::query_scalar(
        "select coalesce(max(position), 0)::int from tasks where project_id = $1 and deleted_at is null",
    )
    .bind(project_id)
    .fetch_one(db)
    .await?;
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
fn db_message(error: &sqlx::Error) -> String {
    match error {
        sqlx::Error::Database(db) => db.message().to_owned(),
        other => other.to_string(),
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
) -> Result<BatchResult, sqlx::Error> {
    let now = now();
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
        let existing: Vec<(String, Option<String>)> = sqlx::query_as(
            "select id, key from tasks where project_id = $1 and key = any($2) and deleted_at is null",
        )
        .bind(&params.project_id)
        .bind(&keys)
        .fetch_all(db)
        .await?;
        let by_key: HashMap<String, String> = existing
            .into_iter()
            .filter_map(|(id, key)| key.map(|k| (k, id)))
            .collect();
        let new_count = upserts
            .iter()
            .filter(|u| !by_key.contains_key(&u.3))
            .count();
        let numbers = allocate_task_numbers(db, i64::try_from(new_count).unwrap_or(0)).await?;
        let mut cursor = 0;
        for (row, row_num, title, key) in &upserts {
            let values = normalize_task(row, maps);
            let outcome = if let Some(id) = by_key.get(key) {
                sqlx::query(UPDATE_TASK)
                    .bind(id)
                    .bind(&values)
                    .bind(&now)
                    .execute(db)
                    .await
                    .map(|_| true)
            } else {
                let mut record = values.clone();
                record["id"] = json!(generate_id("task"));
                record["number"] = json!(numbers.get(cursor));
                cursor += 1;
                record["key"] = json!(key);
                record["position"] = json!(take_position());
                insert_rows(db, &[record], params, &now)
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
        let numbers = allocate_task_numbers(db, i64::try_from(inserts.len()).unwrap_or(0)).await?;
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
            if insert_rows(db, chunk, params, &now).await.is_ok() {
                result.imported += i64::try_from(chunk.len()).unwrap_or(0);
                continue;
            }
            for record in chunk {
                match insert_rows(db, std::slice::from_ref(record), params, &now).await {
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

const UPDATE_TASK: &str = "update tasks set
        title = $2::jsonb->>'title', description = $2::jsonb->>'description',
        status = $2::jsonb->>'status', stage_id = $2::jsonb->>'stageId',
        priority = $2::jsonb->>'priority', type = $2::jsonb->>'type',
        assignee_id = $2::jsonb->>'assigneeId',
        assignee_ids = nullif($2::jsonb->'assigneeIds', 'null'::jsonb),
        start_date = ($2::jsonb->>'startDate')::timestamp,
        due_date = ($2::jsonb->>'dueDate')::timestamp,
        estimated_hours = ($2::jsonb->>'estimatedHours')::numeric,
        tags = nullif($2::jsonb->'tags', 'null'::jsonb),
        labels = nullif($2::jsonb->'labels', 'null'::jsonb),
        updated_at = $3::timestamp
    where id = $1";

/// One multi-row insert (Drizzle's `insert(tasks).values(chunk)`).
async fn insert_rows(
    db: &PgPool,
    records: &[Value],
    params: &ImportParams,
    now: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into tasks
             (id, number, project_id, key, title, description, status, stage_id, priority, type,
              assignee_id, assignee_ids, start_date, due_date, estimated_hours, tags, labels,
              reporter_id, is_billable, position, progress, created_at, updated_at)
         select r.id, r.number, $2, r.key, r.title, r.description, r.status, r.stage_id,
                r.priority, r.type, r.assignee_id, r.assignee_ids, r.start_date, r.due_date,
                r.estimated_hours, r.tags, r.labels, $3, true, r.position, '0',
                $4::timestamp, $4::timestamp
         from jsonb_to_recordset($1::jsonb) as r(
             id text, number int, key text, title text, description text, status text,
             stage_id text, priority text, type text, assignee_id text, assignee_ids jsonb,
             start_date timestamp, due_date timestamp, estimated_hours numeric, tags jsonb,
             labels jsonb, position int)",
    )
    .bind(Value::Array(
        records
            .iter()
            .map(|r| {
                let mut r = r.clone();
                if let Value::Object(map) = &mut r {
                    for (from, to) in [
                        ("stageId", "stage_id"),
                        ("assigneeId", "assignee_id"),
                        ("assigneeIds", "assignee_ids"),
                        ("startDate", "start_date"),
                        ("dueDate", "due_date"),
                        ("estimatedHours", "estimated_hours"),
                    ] {
                        if let Some(value) = map.remove(from) {
                            map.insert(to.to_owned(), value);
                        }
                    }
                }
                r
            })
            .collect(),
    ))
    .bind(&params.project_id)
    .bind(&params.user_id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}
