//! Task import jobs (`POST /api/projects/:projectId/tasks/import-jobs` and
//! its status): the payload goes to the `STORAGE` bucket, a
//! `task_import_jobs` row tracks progress, and the `flow.import-tasks` job
//! (the `ImportTasksWorkflow`) does the import.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_db::js_row;
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_ports::{JobRequest, PutOptions};

use crate::import_tasks::{IMPORT_TASKS_JOB, ImportParams};
use crate::{Caller, FlowState, Refusal, Reply, now, outside, validate};

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
    let exists: Result<Option<String>, sqlx::Error> =
        sqlx::query_scalar("select id from projects where id = $1 and deleted_at is null limit 1")
            .bind(&project_id)
            .fetch_optional(&caller.db)
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
        sqlx::query(
            "insert into task_import_jobs
                 (id, workspace_id, user_id, project_id, r2_key, status, total, processed,
                  imported, updated, failed, errors)
             values ($1, $2, $3, $4, $5, 'queued', $6, 0, 0, 0, 0, '[]'::jsonb)",
        )
        .bind(&job_id)
        .bind(&clerk_org_id)
        .bind(&caller.user_id)
        .bind(&project_id)
        .bind(&key)
        .bind(i32::try_from(total).unwrap_or(i32::MAX))
        .execute(&caller.db)
        .await
        .map_err(|e| e.to_string())?;
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
        sqlx::query(
            "update task_import_jobs set workflow_instance_id = $2, updated_at = $3::timestamp
             where id = $1",
        )
        .bind(&job_id)
        .bind(&job_id)
        .bind(now())
        .execute(&caller.db)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    match started {
        Ok(()) => {
            Created(json!({ "jobId": job_id, "total": total, "status": "queued" })).into_response()
        }
        Err(message) => {
            tracing::error!(message, "[flow-api/projects] failed to start task import");
            let _ = sqlx::query(
                "update task_import_jobs set status = 'failed', error_message = $2,
                        updated_at = $3::timestamp
                 where id = $1",
            )
            .bind(&job_id)
            .bind(&message)
            .bind(now())
            .execute(&caller.db)
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
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(j) from task_import_jobs j
         where j.id = $1 and j.workspace_id = $2 and j.project_id = $3 limit 1",
    )
    .bind(job_id)
    .bind(clerk_org_id)
    .bind(project_id)
    .fetch_optional(&caller.db)
    .await?;
    let Some(job) = row.map(js_row) else {
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
