//! `integrations.github-project-sync` (`GithubProjectSyncWorkflow`): one
//! GitHub Project (v2) link synced. Inbound, the Project's items (issues)
//! become WeldFlow tasks, the "Status" option mapped to a stage; stale
//! mappings are pruned. Outbound (unless the run is inbound only), tasks
//! without an issue get one in the link's repository and on the board, and
//! tasks on the board get their Status column reconciled. Backs both the
//! automatic sync (the App's webhook) and WeldConnect's "Sync now".

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::{BoxFuture, Job, JobContext, JobError, StepRetry, step};

use super::api::{
    self, ItemsPage, ProjectItemIssue, StatusOptionMapping, stage_id_for_status_option,
    status_option_for_stage_id, task_status_from_issue_state,
};
use super::{
    GITHUB_PROJECT_SYNC_JOB, GithubDeps, iso_of_millis, millis_of_iso, now_millis,
    status_to_stage_id,
};

/// `GithubProjectSyncParams`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    workspace_id: String,
    project_link_id: String,
    #[serde(default)]
    inbound_only: Option<bool>,
}

/// `LinkData`, as the `load-link` step returns it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkData {
    pub installation_id: i64,
    pub project_v2_node_id: String,
    pub project_id: String,
    pub sync_direction: String,
    pub sync_issues: bool,
    pub status_option_map: Option<Vec<StatusOptionMapping>>,
    pub repo_full_name: Option<String>,
    pub status_field_id: Option<String>,
}

fn retry(limit: u32, seconds: u64) -> StepRetry {
    StepRetry::exponential(limit, Duration::from_secs(seconds))
}

fn failed(error: impl std::fmt::Display) -> JobError {
    JobError::failed(error)
}

/// `loadLinkData(env, workspaceId, projectLinkId)`.
pub async fn load_link_data(
    db: &PgPool,
    workspace_id: &str,
    project_link_id: &str,
) -> Result<LinkData, String> {
    #[allow(clippy::type_complexity)]
    let link: Option<(
        String,
        String,
        String,
        String,
        bool,
        Option<Value>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "select connection_id, project_v2_node_id, project_id, sync_direction, sync_issues, \
         status_option_map, repo_full_name, status_field_id from github_project_links \
         where id = $1 and workspace_id = $2 and deleted_at is null limit 1",
    )
    .bind(project_link_id)
    .bind(workspace_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let Some((
        connection_id,
        node_id,
        project_id,
        direction,
        sync_issues,
        option_map,
        repo,
        status_field,
    )) = link
    else {
        return Err(format!("Project link {project_link_id} not found"));
    };
    let connection: Option<(String, i64, String)> = sqlx::query_as(
        "select id, installation_id, status from github_connections \
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(&connection_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let Some((id, installation_id, status)) = connection else {
        return Err(format!(
            "Connection for project link {project_link_id} not found"
        ));
    };
    if status != "active" {
        return Err(format!("Connection {id} is not active (status: {status})"));
    }
    Ok(LinkData {
        installation_id,
        project_v2_node_id: node_id,
        project_id,
        sync_direction: direction,
        sync_issues,
        status_option_map: api::status_option_map(option_map.as_ref()),
        repo_full_name: repo,
        status_field_id: status_field,
    })
}

/// What to do with a task already mapped to a Project item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    ApplyIssue,
    KeepTask,
    Skip,
}

/// `decideExistingItem`: by the last-synced times; a conflict (both sides
/// changed) goes to the newer side.
fn decide(
    task_updated_at: i64,
    last_synced_task: Option<i64>,
    last_synced_issue: Option<i64>,
    issue_updated_at: Option<i64>,
    item: &ProjectItemIssue,
) -> Decision {
    // An unreadable GitHub time compares false, as an Invalid Date does.
    let task_changed = last_synced_task.is_some_and(|last| task_updated_at > last);
    let issue_changed = match last_synced_issue {
        Some(last) => issue_updated_at.is_some_and(|at| at > last),
        None => true,
    };
    if !task_changed {
        return Decision::ApplyIssue;
    }
    if !issue_changed {
        return Decision::Skip;
    }
    let task_wins = issue_updated_at.is_some_and(|at| task_updated_at >= at);
    tracing::warn!(
        "[GithubProjectSync] CONFLICT on item {} (issue #{}). Winner: {}.",
        item.item_node_id,
        item.number,
        if task_wins { "task" } else { "issue" }
    );
    if task_wins {
        Decision::KeepTask
    } else {
        Decision::ApplyIssue
    }
}

/// `upsertItemAsTask(db, workspaceId, projectLinkId, projectId, map, item)`.
async fn upsert_item_as_task(
    db: &PgPool,
    workspace_id: &str,
    project_link_id: &str,
    project_id: &str,
    status_option_map: Option<&[StatusOptionMapping]>,
    item: &ProjectItemIssue,
) -> Result<(), String> {
    let issue_updated_at = millis_of_iso(&item.updated_at);
    let status = task_status_from_issue_state(&item.state, item.state_reason.as_deref());
    // An empty stage id is no stage (`if (stageId)`).
    let stage_id = stage_id_for_status_option(status_option_map, item.status_option_id.as_deref())
        .filter(|id| !id.is_empty());
    let issue_iso = issue_updated_at
        .map(iso_of_millis)
        .ok_or_else(|| "Invalid time value".to_owned())?;
    let existing: Option<(String, String, Option<i64>, Option<i64>)> = sqlx::query_as(
        "select id, task_id, \
           floor(extract(epoch from last_synced_task_updated_at) * 1000)::bigint, \
           floor(extract(epoch from last_synced_issue_updated_at) * 1000)::bigint \
         from github_issue_sync_map where project_link_id = $1 and project_item_node_id = $2 limit 1",
    )
    .bind(project_link_id)
    .bind(&item.item_node_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let now = iso_of_millis(now_millis());

    if let Some((map_id, task_id, last_task, last_issue)) = existing {
        let task: Option<i64> = sqlx::query_scalar(
            "select floor(extract(epoch from updated_at) * 1000)::bigint from tasks where id = $1 limit 1",
        )
        .bind(&task_id)
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?;
        let Some(task_updated_at) = task else {
            sqlx::query("delete from github_issue_sync_map where id = $1")
                .bind(&map_id)
                .execute(db)
                .await
                .map_err(|e| e.to_string())?;
            return Ok(());
        };
        match decide(
            task_updated_at,
            last_task,
            last_issue,
            issue_updated_at,
            item,
        ) {
            Decision::Skip => {}
            Decision::KeepTask => {
                sqlx::query(
                    "update github_issue_sync_map set last_synced_task_updated_at = $2::timestamp, \
                     last_synced_issue_updated_at = $3::timestamp, last_writer_side = 'task', \
                     updated_at = $4::timestamp where id = $1",
                )
                .bind(&map_id)
                .bind(iso_of_millis(task_updated_at))
                .bind(&issue_iso)
                .bind(&now)
                .execute(db)
                .await
                .map_err(|e| e.to_string())?;
            }
            Decision::ApplyIssue => {
                // `updateMappedTask`.
                sqlx::query(
                    "update tasks set title = $2, description = $3, status = $4, labels = $5, \
                     updated_at = $6::timestamp, stage_id = case when $7::text is null then stage_id else $7 end \
                     where id = $1",
                )
                .bind(&task_id)
                .bind(&item.title)
                .bind(&item.body)
                .bind(status)
                .bind(json!(item.labels))
                .bind(&now)
                .bind(&stage_id)
                .execute(db)
                .await
                .map_err(|e| e.to_string())?;
                sqlx::query(
                    "update github_issue_sync_map set last_synced_issue_updated_at = $2::timestamp, \
                     last_synced_task_updated_at = $3::timestamp, issue_node_id = $4, issue_number = $5, \
                     repo_id = $6, last_writer_side = 'issue', updated_at = $3::timestamp where id = $1",
                )
                .bind(&map_id)
                .bind(&issue_iso)
                .bind(&now)
                .bind(&item.issue_node_id)
                .bind(i32::try_from(item.number).unwrap_or(i32::MAX))
                .bind(item.repo_id)
                .execute(db)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
        return Ok(());
    }

    let task_id = weldsuite_kit::generate_id("tsk");
    let map_id = weldsuite_kit::generate_id("ghsm");
    sqlx::query(
        "insert into tasks (id, title, description, status, stage_id, priority, progress, project_id, \
         labels, github_issue_number, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, 'medium', '0', $6, $7, $8, $9::timestamp, $9::timestamp)",
    )
    .bind(&task_id)
    .bind(&item.title)
    .bind(&item.body)
    .bind(status)
    .bind(&stage_id)
    .bind(project_id)
    .bind(json!(item.labels))
    .bind(i32::try_from(item.number).unwrap_or(i32::MAX))
    .bind(&now)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "insert into github_issue_sync_map (id, workspace_id, project_link_id, task_id, project_item_node_id, \
         issue_node_id, issue_number, repo_id, last_synced_task_updated_at, last_synced_issue_updated_at, \
         last_writer_side, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamp, $10::timestamp, 'issue', $9::timestamp, $9::timestamp)",
    )
    .bind(&map_id)
    .bind(workspace_id)
    .bind(project_link_id)
    .bind(&task_id)
    .bind(&item.item_node_id)
    .bind(&item.issue_node_id)
    .bind(i32::try_from(item.number).unwrap_or(i32::MAX))
    .bind(item.repo_id)
    .bind(&now)
    .bind(&issue_iso)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// `pruneStaleMappings`: sync-map rows whose item the pull did not see.
async fn prune_stale_mappings(
    db: &PgPool,
    project_link_id: &str,
    seen: &HashSet<String>,
) -> Result<usize, String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select id, project_item_node_id from github_issue_sync_map where project_link_id = $1",
    )
    .bind(project_link_id)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    let stale: Vec<String> = rows
        .into_iter()
        .filter(|(_, item)| !seen.contains(item))
        .map(|(id, _)| id)
        .collect();
    if !stale.is_empty() {
        sqlx::query("delete from github_issue_sync_map where id = any($1)")
            .bind(&stale)
            .execute(db)
            .await
            .map_err(|e| e.to_string())?;
        tracing::info!(
            "[GithubProjectSync] Pruned {} stale mapping(s) for link {project_link_id}",
            stale.len()
        );
    }
    Ok(stale.len())
}

/// A task as the outbound reconcile reads it.
#[derive(Debug, Clone)]
pub(crate) struct TaskRow {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) description: Option<String>,
    pub(crate) stage_id: Option<String>,
    pub(crate) status: String,
    pub(crate) labels: Option<Value>,
    pub(crate) github_issue_number: Option<i32>,
}

/// `(task.labels as string[] | null) ?? undefined` for the issue.
pub(crate) fn labels_of(labels: Option<&Value>) -> Option<Vec<String>> {
    labels.and_then(Value::as_array).map(|labels| {
        labels
            .iter()
            .map(|l| l.as_str().map_or_else(|| l.to_string(), str::to_owned))
            .collect()
    })
}

/// The outbound reconcile's tasks: the project's live ones, in the table's order.
async fn project_tasks(db: &PgPool, project_id: &str) -> Result<Vec<TaskRow>, String> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<Value>,
        Option<i32>,
    )> = sqlx::query_as(
        "select id, title, description, stage_id, status, labels, github_issue_number from tasks \
         where project_id = $1 and deleted_at is null",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(
            |(id, title, description, stage_id, status, labels, github_issue_number)| TaskRow {
                id,
                title,
                description,
                stage_id,
                status,
                labels,
                github_issue_number,
            },
        )
        .collect())
}

/// One task of the outbound reconcile (`reconcileTask`).
async fn reconcile_task(
    deps: &GithubDeps,
    db: &PgPool,
    token: &str,
    workspace_id: &str,
    project_link_id: &str,
    link: &LinkData,
    repo_full_name: &str,
    task: &TaskRow,
    existing_item: Option<&String>,
    status_to_stage: &[(String, String)],
) -> Result<&'static str, String> {
    let http = deps.http.as_ref();
    let effective_stage = task.stage_id.clone().or_else(|| {
        status_to_stage
            .iter()
            .find(|(status, _)| *status == task.status)
            .map(|(_, id)| id.clone())
    });
    let option_id = status_option_for_stage_id(
        link.status_option_map.as_deref(),
        effective_stage.as_deref(),
    );

    // Already on the board: reconcile its Status, never create it again.
    if let Some(item) = existing_item {
        let (Some(option_id), Some(field)) = (option_id, link.status_field_id.as_deref()) else {
            return Ok("none");
        };
        api::update_project_item_status(
            http,
            token,
            &link.project_v2_node_id,
            item,
            field,
            &option_id,
        )
        .await?;
        return Ok("restatused");
    }

    // Anti-duplicate safeguards (`isAlreadyPushed`).
    if task.github_issue_number.is_some() {
        return Ok("none");
    }
    let mapped: Option<String> =
        sqlx::query_scalar("select id from github_issue_sync_map where task_id = $1 limit 1")
            .bind(&task.id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    if mapped.is_some() {
        return Ok("none");
    }

    // `createIssueForTask`.
    let labels = labels_of(task.labels.as_ref());
    let issue = api::create_issue(
        http,
        token,
        repo_full_name,
        &task.title,
        task.description.as_deref(),
        labels.as_deref(),
    )
    .await?;
    let item =
        api::add_issue_to_project(http, token, &link.project_v2_node_id, &issue.node_id).await?;
    if let (Some(option_id), Some(field)) = (option_id, link.status_field_id.as_deref()) {
        api::update_project_item_status(
            http,
            token,
            &link.project_v2_node_id,
            &item,
            field,
            &option_id,
        )
        .await?;
    }
    let now = iso_of_millis(now_millis());
    // Claim the task at once, so a concurrent pass never creates a second issue.
    sqlx::query(
        "update tasks set github_issue_number = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(&task.id)
    .bind(i32::try_from(issue.number).unwrap_or(i32::MAX))
    .bind(&now)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    let issue_updated = millis_of_iso(&issue.updated_at)
        .map(iso_of_millis)
        .ok_or_else(|| "Invalid time value".to_owned())?;
    sqlx::query(
        "insert into github_issue_sync_map (id, workspace_id, project_link_id, task_id, project_item_node_id, \
         issue_node_id, issue_number, repo_id, last_synced_task_updated_at, last_synced_issue_updated_at, \
         last_writer_side, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, $6, $7, null, $8::timestamp, $9::timestamp, 'task', $8::timestamp, $8::timestamp)",
    )
    .bind(weldsuite_kit::generate_id("ghsm"))
    .bind(workspace_id)
    .bind(project_link_id)
    .bind(&task.id)
    .bind(&item)
    .bind(&issue.node_id)
    .bind(i32::try_from(issue.number).unwrap_or(i32::MAX))
    .bind(&now)
    .bind(&issue_updated)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    Ok("pushed")
}

/// `reconcileOutbound`: WeldFlow tasks → GitHub issues on the board.
async fn reconcile_outbound(
    deps: &GithubDeps,
    workspace_id: &str,
    project_link_id: &str,
    link: &LinkData,
    token: &str,
    repo_full_name: &str,
) -> Result<Value, String> {
    let db = deps.db(workspace_id).await?;
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select task_id, project_item_node_id from github_issue_sync_map where project_link_id = $1",
    )
    .bind(project_link_id)
    .fetch_all(&db)
    .await
    .map_err(|e| e.to_string())?;
    let item_by_task: HashMap<String, String> = rows.into_iter().collect();
    let tasks = project_tasks(&db, &link.project_id).await?;
    let status_to_stage = status_to_stage_id(&db, &link.project_id)
        .await
        .map_err(|e| e.to_string())?;
    let (mut pushed, mut restatused) = (0, 0);
    for task in &tasks {
        match reconcile_task(
            deps,
            &db,
            token,
            workspace_id,
            project_link_id,
            link,
            repo_full_name,
            task,
            item_by_task.get(&task.id),
            &status_to_stage,
        )
        .await
        {
            Ok("pushed") => pushed += 1,
            Ok("restatused") => restatused += 1,
            Ok(_) => {}
            Err(error) => {
                tracing::error!(
                    "[GithubProjectSync] Failed outbound for task {}: {error}",
                    task.id
                );
            }
        }
    }
    tracing::info!(
        "[GithubProjectSync] Outbound reconcile for link {project_link_id}: created {pushed}, restatused {restatused}"
    );
    Ok(json!({ "pushed": pushed, "restatused": restatused }))
}

/// The job.
pub struct GithubProjectSyncJob {
    pub deps: GithubDeps,
}

impl GithubProjectSyncJob {
    async fn run_sync(&self, ctx: &dyn JobContext, params: Params) -> Result<(), JobError> {
        let deps = &self.deps;
        let Params {
            workspace_id,
            project_link_id,
            inbound_only,
        } = params;
        let (ws, link_id) = (workspace_id.as_str(), project_link_id.as_str());

        let link: LinkData = step(ctx, "load-link", retry(3, 5), || async move {
            let db = deps.db(ws).await.map_err(failed)?;
            load_link_data(&db, ws, link_id).await.map_err(failed)
        })
        .await?;
        if !link.sync_issues {
            tracing::info!("[GithubProjectSync] syncIssues=false for link {link_id}, skipping");
            return Ok(());
        }
        let installation = link.installation_id;
        let token: String = step(ctx, "acquire-token", retry(3, 5), || async move {
            deps.token(installation).await.map_err(failed)
        })
        .await?;

        // Inbound: the Project's items → WeldFlow tasks.
        let mut total = 0;
        if link.sync_direction != "outbound" {
            let mut cursor: Option<String> = None;
            let mut page = 1;
            let mut seen = HashSet::new();
            loop {
                let name = format!("page-{page}");
                let (token_ref, link_ref, cursor_ref) = (&token, &link, &cursor);
                let result: ItemsPage = step(ctx, &name, retry(3, 30), || async move {
                    api::fetch_project_items_page(
                        deps.http.as_ref(),
                        token_ref,
                        &link_ref.project_v2_node_id,
                        cursor_ref.as_deref(),
                    )
                    .await
                    .map_err(failed)
                })
                .await?;
                for item in &result.items {
                    seen.insert(item.item_node_id.clone());
                }
                if !result.items.is_empty() {
                    let name = format!("apply-batch-{page}");
                    let items = &result.items;
                    let link_ref = &link;
                    let _: Value = step(ctx, &name, retry(3, 10), || async move {
                        let db = deps.db(ws).await.map_err(failed)?;
                        for item in items {
                            if let Err(error) = upsert_item_as_task(
                                &db,
                                ws,
                                link_id,
                                &link_ref.project_id,
                                link_ref.status_option_map.as_deref(),
                                item,
                            )
                            .await
                            {
                                tracing::error!(
                                    "[GithubProjectSync] Failed to upsert item {}: {error}",
                                    item.item_node_id
                                );
                            }
                        }
                        Ok(json!({ "processed": items.len() }))
                    })
                    .await?;
                    total += result.items.len();
                }
                match (result.has_next_page, result.end_cursor) {
                    (true, Some(next)) if !next.is_empty() => {
                        cursor = Some(next);
                        page += 1;
                    }
                    _ => break,
                }
            }
            let seen = &seen;
            let _: Value = step(ctx, "prune-stale-mappings", retry(3, 5), || async move {
                let db = deps.db(ws).await.map_err(failed)?;
                let pruned = prune_stale_mappings(&db, link_id, seen)
                    .await
                    .map_err(failed)?;
                Ok(json!({ "pruned": pruned }))
            })
            .await?;
        }

        // Outbound reconcile: WeldFlow tasks → new GitHub issues on the board.
        if inbound_only != Some(true) && link.sync_direction != "inbound" {
            match link.repo_full_name.as_deref().filter(|r| !r.is_empty()) {
                None => tracing::info!(
                    "[GithubProjectSync] No target repo on link {link_id} — skipping outbound reconcile (link a repo to enable WeldFlow→GitHub)."
                ),
                Some(repo) => {
                    let (token_ref, link_ref) = (&token, &link);
                    let _: Value = step(ctx, "outbound-reconcile", retry(3, 15), || async move {
                        reconcile_outbound(deps, ws, link_id, link_ref, token_ref, repo)
                            .await
                            .map_err(failed)
                    })
                    .await?;
                }
            }
        }

        let _: Value = step(ctx, "update-link", retry(3, 5), || async move {
            let db = deps.db(ws).await.map_err(failed)?;
            let now = iso_of_millis(now_millis());
            sqlx::query(
                "update github_project_links set last_synced_at = $2::timestamp, last_error = null, \
                 sync_cursor = null, updated_at = $2::timestamp where id = $1",
            )
            .bind(link_id)
            .bind(&now)
            .execute(&db)
            .await
            .map_err(failed)?;
            tracing::info!(
                "[GithubProjectSync] Completed sync for link {link_id}. Processed {total} items."
            );
            Ok(Value::Null)
        })
        .await?;
        Ok(())
    }
}

impl Job for GithubProjectSyncJob {
    fn name(&self) -> &'static str {
        GITHUB_PROJECT_SYNC_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params: Params = serde_json::from_value(payload)?;
            self.run_sync(ctx, params).await
        })
    }
}
