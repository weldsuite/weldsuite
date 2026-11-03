//! `integrations.github-project-outbound` (`GithubProjectOutboundSyncWorkflow`):
//! one WeldFlow task mutation pushed to its GitHub Project item.
//!
//! - `create`: the issue (REST), on the board, its Status, the sync map;
//! - `update`: the issue's title and body;
//! - `status`: the Status column, and the issue closed or reopened;
//! - `delete`: the issue closed as not planned.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::{BoxFuture, Job, JobContext, JobError, StepRetry, step};

use super::api::{self, StatusOptionMapping, status_option_for_stage_id};
use super::project_sync::labels_of;
use super::{
    GITHUB_PROJECT_OUTBOUND_JOB, GithubDeps, iso_of_millis, millis_of_iso, now_millis,
    status_to_stage_id,
};

/// `GithubProjectOutboundSyncParams`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    workspace_id: String,
    task_id: String,
    kind: String,
    #[serde(default)]
    project_link_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskSnapshot {
    id: String,
    title: String,
    description: Option<String>,
    stage_id: Option<String>,
    status: String,
    labels: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkSnapshot {
    id: String,
    project_v2_node_id: String,
    repo_full_name: Option<String>,
    status_field_id: Option<String>,
    status_option_map: Option<Vec<StatusOptionMapping>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncMapSnapshot {
    id: String,
    issue_node_id: Option<String>,
    issue_number: i32,
    project_item_node_id: String,
}

/// What `load-task` returns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Loaded {
    task: TaskSnapshot,
    link: LinkSnapshot,
    installation_id: i64,
    /// `status → stageId`, in the stages' order.
    status_to_stage_id: Vec<(String, String)>,
    sync_map: Option<SyncMapSnapshot>,
}

/// `PushResult`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    issue_number: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    issue_node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_item_node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    issue_updated_at: Option<String>,
}

fn retry(limit: u32, seconds: u64) -> StepRetry {
    StepRetry::exponential(limit, Duration::from_secs(seconds))
}

fn failed(error: impl std::fmt::Display) -> JobError {
    JobError::failed(error)
}

/// The `load-task` step: the task, its link, the link's connection and the
/// stage fallback; none when the task syncs through no (outbound) link.
async fn load(
    db: &PgPool,
    workspace_id: &str,
    task_id: &str,
    kind: &str,
    param_link_id: Option<&str>,
) -> Result<Option<Loaded>, String> {
    #[allow(clippy::type_complexity)]
    let task: Option<(
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<Value>,
        Option<String>,
    )> = sqlx::query_as(
        "select id, title, description, stage_id, status, labels, project_id from tasks \
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(task_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let Some((id, title, description, stage_id, status, labels, project_id)) = task else {
        return Err(format!("Task {task_id} not found"));
    };
    let sync_map: Option<(String, Option<String>, i32, String, String)> = sqlx::query_as(
        "select id, issue_node_id, issue_number, project_item_node_id, project_link_id \
         from github_issue_sync_map where task_id = $1 limit 1",
    )
    .bind(task_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;

    // `resolveLinkId`: the mapped link, else (create only) the given one or
    // the task project's.
    let link_id = match (&sync_map, kind) {
        (Some((.., link)), _) => Some(link.clone()),
        (None, "create") => match (param_link_id.filter(|l| !l.is_empty()), &project_id) {
            (Some(link), _) => Some(link.to_owned()),
            (None, Some(project)) if !project.is_empty() => sqlx::query_scalar(
                "select id from github_project_links where project_id = $1 and deleted_at is null limit 1",
            )
            .bind(project)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?,
            _ => None,
        },
        _ => None,
    };
    let Some(link_id) = link_id else {
        return Ok(None);
    };
    #[allow(clippy::type_complexity)]
    let link: Option<(
        String,
        String,
        Option<String>,
        Option<String>,
        Option<Value>,
        String,
        String,
        String,
    )> = sqlx::query_as(
        "select id, project_v2_node_id, repo_full_name, status_field_id, status_option_map, \
         sync_direction, connection_id, project_id from github_project_links \
         where id = $1 and workspace_id = $2 and deleted_at is null limit 1",
    )
    .bind(&link_id)
    .bind(workspace_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let Some((lid, node, repo, field, option_map, direction, connection_id, link_project)) = link
    else {
        return Err(format!("Project link {link_id} not found"));
    };
    if direction == "inbound" {
        tracing::info!("[GithubProjectOutbound] syncDirection=inbound for link {lid} — no-op");
        return Ok(None);
    }
    let connection: Option<(String, i64, String)> = sqlx::query_as(
        "select id, installation_id, status from github_connections \
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(&connection_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let Some((cid, installation_id, cstatus)) = connection else {
        return Err(format!("Connection for link {lid} not found"));
    };
    if cstatus != "active" {
        return Err(format!("Connection {cid} is not active"));
    }
    let status_to_stage_id = status_to_stage_id(db, &link_project)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(Loaded {
        task: TaskSnapshot {
            id,
            title,
            description,
            stage_id,
            status,
            labels,
        },
        link: LinkSnapshot {
            id: lid,
            project_v2_node_id: node,
            repo_full_name: repo,
            status_field_id: field,
            status_option_map: api::status_option_map(option_map.as_ref()),
        },
        installation_id,
        status_to_stage_id,
        sync_map: sync_map.map(
            |(id, issue_node_id, issue_number, item, _)| SyncMapSnapshot {
                id,
                issue_node_id,
                issue_number,
                project_item_node_id: item,
            },
        ),
    }))
}

/// `applyMappedStatus`: the Status column, when the stage has an option.
async fn apply_mapped_status(
    deps: &GithubDeps,
    token: &str,
    link: &LinkSnapshot,
    item: &str,
    stage: Option<&str>,
) -> Result<(), String> {
    let option = status_option_for_stage_id(link.status_option_map.as_deref(), stage);
    if let (Some(option), Some(field)) = (option, link.status_field_id.as_deref()) {
        api::update_project_item_status(
            deps.http.as_ref(),
            token,
            &link.project_v2_node_id,
            item,
            field,
            &option,
        )
        .await?;
    }
    Ok(())
}

/// The `push-to-github` step.
async fn push(
    deps: &GithubDeps,
    loaded: &Loaded,
    kind: &str,
    stage: Option<&str>,
) -> Result<Option<PushResult>, String> {
    let http = deps.http.as_ref();
    let token = deps.token(loaded.installation_id).await?;
    let (task, link) = (&loaded.task, &loaded.link);
    if kind == "create" {
        let Some(repo) = link.repo_full_name.as_deref().filter(|r| !r.is_empty()) else {
            tracing::info!(
                "[GithubProjectOutbound] Link {} has no repo — cannot create issue",
                link.id
            );
            return Ok(None);
        };
        let labels = labels_of(task.labels.as_ref());
        let issue = api::create_issue(
            http,
            &token,
            repo,
            &task.title,
            task.description.as_deref(),
            labels.as_deref(),
        )
        .await?;
        let item =
            api::add_issue_to_project(http, &token, &link.project_v2_node_id, &issue.node_id)
                .await?;
        apply_mapped_status(deps, &token, link, &item, stage).await?;
        return Ok(Some(PushResult {
            issue_number: Some(issue.number),
            issue_node_id: Some(issue.node_id),
            project_item_node_id: Some(item),
            issue_updated_at: Some(issue.updated_at),
        }));
    }
    let map = loaded.sync_map.as_ref().ok_or("not mapped")?;
    match kind {
        "update" => {
            let Some(node) = map.issue_node_id.as_deref().filter(|n| !n.is_empty()) else {
                tracing::info!(
                    "[GithubProjectOutbound] No issueNodeId for task {} — skipping update",
                    task.id
                );
                return Ok(None);
            };
            let updated = api::update_issue_fields(
                http,
                &token,
                node,
                Some(&task.title),
                task.description.as_deref(),
            )
            .await?;
            Ok(Some(PushResult {
                issue_updated_at: Some(updated),
                ..PushResult::default()
            }))
        }
        "status" => {
            apply_mapped_status(deps, &token, link, &map.project_item_node_id, stage).await?;
            let mut updated = iso_of_millis(now_millis());
            if let Some(node) = map.issue_node_id.as_deref().filter(|n| !n.is_empty()) {
                // Mirror the open or closed state onto the issue (best effort).
                let mirrored = match task.status.as_str() {
                    "done" => api::close_issue(http, &token, node, "COMPLETED").await,
                    "cancelled" => api::close_issue(http, &token, node, "NOT_PLANNED").await,
                    _ => api::reopen_issue(http, &token, node).await,
                };
                match mirrored {
                    Ok(at) => updated = at,
                    Err(error) => tracing::info!(
                        "[GithubProjectOutbound] issue state change skipped for task {}: {error}",
                        task.id
                    ),
                }
            }
            Ok(Some(PushResult {
                issue_updated_at: Some(updated),
                ..PushResult::default()
            }))
        }
        "delete" => {
            let Some(node) = map.issue_node_id.as_deref().filter(|n| !n.is_empty()) else {
                return Ok(None);
            };
            let updated = api::close_issue(http, &token, node, "NOT_PLANNED").await?;
            Ok(Some(PushResult {
                issue_updated_at: Some(updated),
                ..PushResult::default()
            }))
        }
        other => Err(format!("Unknown kind: {other}")),
    }
}

/// The `update-sync-map` step.
async fn record(
    db: &PgPool,
    workspace_id: &str,
    loaded: &Loaded,
    kind: &str,
    result: &PushResult,
) -> Result<(), String> {
    let now = iso_of_millis(now_millis());
    let issue_updated = match result.issue_updated_at.as_deref() {
        Some(at) => millis_of_iso(at)
            .map(iso_of_millis)
            .ok_or_else(|| "Invalid time value".to_owned())?,
        None => now.clone(),
    };
    if kind == "create" {
        let number = result.issue_number.and_then(|n| i32::try_from(n).ok());
        sqlx::query(
            "update tasks set github_issue_number = $2, updated_at = $3::timestamp where id = $1",
        )
        .bind(&loaded.task.id)
        .bind(number)
        .bind(&now)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query(
            "insert into github_issue_sync_map (id, workspace_id, project_link_id, task_id, project_item_node_id, \
             issue_node_id, issue_number, last_synced_task_updated_at, last_synced_issue_updated_at, \
             last_writer_side, created_at, updated_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8::timestamp, $9::timestamp, 'task', $8::timestamp, $8::timestamp)",
        )
        .bind(weldsuite_kit::generate_id("ghsm"))
        .bind(workspace_id)
        .bind(&loaded.link.id)
        .bind(&loaded.task.id)
        .bind(&result.project_item_node_id)
        .bind(&result.issue_node_id)
        .bind(number)
        .bind(&now)
        .bind(&issue_updated)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    if let Some(map) = &loaded.sync_map {
        sqlx::query(
            "update github_issue_sync_map set last_synced_task_updated_at = $2::timestamp, \
             last_synced_issue_updated_at = $3::timestamp, last_writer_side = 'task', \
             updated_at = $2::timestamp where id = $1",
        )
        .bind(&map.id)
        .bind(&now)
        .bind(&issue_updated)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The job.
pub struct GithubProjectOutboundJob {
    pub deps: GithubDeps,
}

impl GithubProjectOutboundJob {
    async fn run_push(&self, ctx: &dyn JobContext, params: Params) -> Result<(), JobError> {
        let deps = &self.deps;
        let (ws, task_id, kind) = (
            params.workspace_id.as_str(),
            params.task_id.as_str(),
            params.kind.as_str(),
        );
        let param_link = params.project_link_id.as_deref();
        let loaded: Option<Loaded> = step(ctx, "load-task", retry(3, 5), || async move {
            let db = deps.db(ws).await.map_err(failed)?;
            load(&db, ws, task_id, kind, param_link)
                .await
                .map_err(failed)
        })
        .await?;
        let Some(loaded) = loaded else {
            tracing::info!("[GithubProjectOutbound] No-op for task {task_id} (kind={kind})");
            return Ok(());
        };
        // The task's stage, else the stage of its status.
        let stage = loaded.task.stage_id.clone().or_else(|| {
            loaded
                .status_to_stage_id
                .iter()
                .find(|(status, _)| *status == loaded.task.status)
                .map(|(_, id)| id.clone())
        });
        if kind != "create" && loaded.sync_map.is_none() {
            tracing::info!(
                "[GithubProjectOutbound] Task {task_id} not mapped — skipping kind={kind}"
            );
            return Ok(());
        }
        let (loaded_ref, stage_ref) = (&loaded, stage.as_deref());
        let result: Option<PushResult> = step(ctx, "push-to-github", retry(3, 30), || async move {
            push(deps, loaded_ref, kind, stage_ref)
                .await
                .map_err(failed)
        })
        .await?;
        let Some(result) = result else {
            return Ok(());
        };
        let result = &result;
        let _: Value = step(ctx, "update-sync-map", retry(3, 5), || async move {
            let db = deps.db(ws).await.map_err(failed)?;
            record(&db, ws, loaded_ref, kind, result)
                .await
                .map_err(failed)?;
            Ok(json!(null))
        })
        .await?;
        Ok(())
    }
}

impl Job for GithubProjectOutboundJob {
    fn name(&self) -> &'static str {
        GITHUB_PROJECT_OUTBOUND_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params: Params = serde_json::from_value(payload)?;
            self.run_push(ctx, params).await
        })
    }
}
