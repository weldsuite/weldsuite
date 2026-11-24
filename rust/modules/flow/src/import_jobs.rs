//! Task import jobs (`POST /api/projects/:projectId/tasks/import-jobs` and
//! its status): the payload goes to the `STORAGE` bucket, a
//! `task_import_jobs` row tracks progress, and the `flow.import-tasks` job
//! (the `ImportTasksWorkflow`) does the import.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_ports::{JobRequest, PutOptions};
use weldsuite_schema::tenant::{projects, task_import_jobs as jobs_table};

use crate::import_tasks::{IMPORT_TASKS_JOB, ImportParams};
use crate::{Caller, FlowState, Refusal, Reply, outside, row_json, validate};

/// The database's own message (what the route's `catch` prints).
fn db_message(error: &DbErr) -> String {
    match error {
        DbErr::Conn(inner) | DbErr::Exec(inner) | DbErr::Query(inner) => inner.to_string(),
        other => other.to_string(),
    }
}

/// `importTasksSchema`: 1 to 50,000 objects.
fn read_rows(headers: &HeaderMap, body: &Bytes) -> Result<Vec<Value>, Refusal> {
    validate(headers, body, |issues, fields| {
        let from = issues.count();
        let rows = issues.list_with(
            fields,
            "tasks",
            Presence::Required,
            (Some(1), Some("No tasks to import")),
            Some(50_000),
            |issues, item| issues.object(item).map(|_| item.clone()),
        );
        issues.custom_message(
            from,
            "too_big",
            "Cannot import more than 50,000 tasks at once",
        );
        rows.into_option().unwrap_or_default()
    })
}

#[allow(clippy::too_many_lines)]
pub(crate) async fn start(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let rows = match read_rows(&headers, &body) {
        Ok(rows) => rows,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let Some(clerk_org_id) = caller.clerk_org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    match caller.can_write(&project_id).await {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::forbidden()
                .with_message("You do not have write access to this project")
                .into_response();
        }
        Err(error) => return outside(Err(error.into())),
    }
    let Some(storage) = caller.buckets(&state).public else {
        return ApiError::internal()
            .with_message("Storage binding not available")
            .into_response();
    };
    let Some(jobs) = state.jobs.clone() else {
        return ApiError::internal()
            .with_message("Import workflow binding not available")
            .into_response();
    };
    let db = orm(&caller.db);
    let exists: Result<Option<String>, DbErr> = projects::Entity::find()
        .select_only()
        .column(projects::Column::Id)
        .filter(projects::Column::Id.eq(&project_id))
        .filter(projects::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&db)
        .await;
    match exists {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return outside(Err(error.into())),
    }
    let job_id = generate_id("timp");
    let key = format!("imports/tasks/{clerk_org_id}/{project_id}/{job_id}.json");
    let total = rows.len();
    let started: Result<(), String> = async {
        let payload = serde_json::to_vec(&rows).map_err(|e| e.to_string())?;
        storage
            .put_boxed(&key, payload, &PutOptions::content_type("application/json"))
            .await
            .map_err(|e| e.to_string())?;
        jobs_table::Entity::insert(jobs_table::ActiveModel {
            id: Set(job_id.clone()),
            workspace_id: Set(clerk_org_id.clone()),
            user_id: Set(caller.user_id.clone()),
            project_id: Set(project_id.clone()),
            r2_key: Set(key.clone()),
            status: Set("queued".to_owned()),
            total: Set(i32::try_from(total).unwrap_or(i32::MAX)),
            processed: Set(0),
            imported: Set(0),
            updated: Set(0),
            failed: Set(0),
            errors: Set(Some(json!([]))),
            ..Default::default()
        })
        .exec_without_returning(&db)
        .await
        .map_err(|e| db_message(&e))?;
        let params = ImportParams {
            job_id: job_id.clone(),
            workspace_id: clerk_org_id.clone(),
            user_id: caller.user_id.clone(),
            project_id: project_id.clone(),
            r2_key: key.clone(),
        };
        let request = JobRequest::new(IMPORT_TASKS_JOB, job_id.clone(), &params)
            .map_err(|e| e.to_string())?;
        crate::import_tasks::remember_request(&job_id, &caller.db, &storage);
        jobs.start_boxed(request).await.map_err(|e| e.to_string())?;
        jobs_table::Entity::update_many()
            .col_expr(jobs_table::Column::WorkflowInstanceId, Expr::value(&job_id))
            .col_expr(jobs_table::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(jobs_table::Column::Id.eq(&job_id))
            .exec(&db)
            .await
            .map_err(|e| db_message(&e))?;
        Ok(())
    }
    .await;
    match started {
        Ok(()) => {
            Created(json!({ "jobId": job_id, "total": total, "status": "queued" })).into_response()
        }
        Err(message) => {
            tracing::error!(message, "[flow-api/projects] failed to start task import");
            let _ = jobs_table::Entity::update_many()
                .col_expr(jobs_table::Column::Status, Expr::value("failed"))
                .col_expr(jobs_table::Column::ErrorMessage, Expr::value(&message))
                .col_expr(jobs_table::Column::UpdatedAt, Expr::value(utc_now()))
                .filter(jobs_table::Column::Id.eq(&job_id))
                .exec(&db)
                .await;
            ApiError::internal()
                .with_message(format!("Failed to start import: {message}"))
                .into_response()
        }
    }
}

pub(crate) async fn status(
    caller: Caller,
    Path((project_id, job_id)): Path<(String, String)>,
) -> Response {
    let Some(clerk_org_id) = caller.clerk_org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    outside(job_status(&caller, &clerk_org_id, &project_id, &job_id).await)
}

async fn job_status(caller: &Caller, clerk_org_id: &str, project_id: &str, job_id: &str) -> Reply {
    if !caller.can_access(project_id).await? {
        return Err(Refusal::forbidden("You are not a member of this project"));
    }
    let row = jobs_table::Entity::find()
        .filter(jobs_table::Column::Id.eq(job_id))
        .filter(jobs_table::Column::WorkspaceId.eq(clerk_org_id))
        .filter(jobs_table::Column::ProjectId.eq(project_id))
        .one(&orm(&caller.db))
        .await?;
    let Some(job) = row.map(row_json).transpose()? else {
        return Err(Refusal::not_found("Import job", job_id));
    };
    let errors: Vec<Value> = job["errors"]
        .as_array()
        .map(|errors| errors.iter().take(100).cloned().collect())
        .unwrap_or_default();
    Ok(Data(json!({
        "jobId": job["id"],
        "status": job["status"],
        "total": job["total"],
        "processed": job["processed"],
        "imported": job["imported"],
        "updated": job["updated"],
        "failed": job["failed"],
        "errors": errors,
        "errorMessage": job["errorMessage"],
        "createdAt": job["createdAt"],
        "completedAt": job["completedAt"],
    }))
    .into_response())
}
