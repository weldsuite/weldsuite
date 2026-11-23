//! `integrations.github-project-sync` (`GithubProjectSyncWorkflow`): one
//! GitHub Project (v2) link synced. Inbound, the Project's items (issues)
//! become WeldFlow tasks, the "Status" option mapped to a stage; stale
//! mappings are pruned. Outbound (unless the run is inbound only), tasks
//! without an issue get one in the link's repository and on the board, and
//! tasks on the board get their Status column reconciled. Backs both the
//! automatic sync (the App's webhook) and WeldConnect's "Sync now".

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use sea_orm::ActiveValue::Set;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_ports::{BoxFuture, Job, JobContext, JobError, StepRetry, step};
use weldsuite_schema::tenant::{
    github_issue_sync_map as sync_map, github_project_links as links, merge_connections, tasks,
};

use super::api::{
    self, ItemsPage, ProjectItemIssue, StatusOptionMapping, stage_id_for_status_option,
    status_option_for_stage_id, task_status_from_issue_state,
};
use super::{
    GITHUB_PROJECT_SYNC_JOB, GithubDeps, millis_of_iso, millis_of_timestamp, now_millis,
    status_to_stage_id, timestamp_of_millis,
};
use crate::crm::db_text;

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
    )> = links::Entity::find()
        .select_only()
        .columns([
            links::Column::ConnectionId,
            links::Column::ProjectV2NodeId,
            links::Column::ProjectId,
            links::Column::SyncDirection,
            links::Column::SyncIssues,
            links::Column::StatusOptionMap,
            links::Column::RepoFullName,
            links::Column::StatusFieldId,
        ])
        .filter(links::Column::Id.eq(project_link_id))
        .filter(links::Column::WorkspaceId.eq(workspace_id))
        .filter(links::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
        .map_err(|e| db_text(&e))?;
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
    // The link's connection is a WeldMerge connection; its installation id
    // is `external_account_id` (`Number(conn.externalAccountId)`).
    let connection: Option<(String, String, String)> = merge_connections::Entity::find()
        .select_only()
        .columns([
            merge_connections::Column::Id,
            merge_connections::Column::ExternalAccountId,
            merge_connections::Column::Status,
        ])
        .filter(merge_connections::Column::Id.eq(&connection_id))
        .filter(merge_connections::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
        .map_err(|e| db_text(&e))?;
    let Some((id, external_account_id, status)) = connection else {
        return Err(format!(
            "Connection for project link {project_link_id} not found"
        ));
    };
    let installation_id = super::installation_of(&external_account_id);
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
    let issue_at = issue_updated_at
        .map(timestamp_of_millis)
        .ok_or_else(|| "Invalid time value".to_owned())?;
    let existing: Option<(
        String,
        String,
        Option<PrimitiveDateTime>,
        Option<PrimitiveDateTime>,
    )> = sync_map::Entity::find()
        .select_only()
        .columns([
            sync_map::Column::Id,
            sync_map::Column::TaskId,
            sync_map::Column::LastSyncedTaskUpdatedAt,
            sync_map::Column::LastSyncedIssueUpdatedAt,
        ])
        .filter(sync_map::Column::ProjectLinkId.eq(project_link_id))
        .filter(sync_map::Column::ProjectItemNodeId.eq(&item.item_node_id))
        .into_tuple()
        .one(&orm(db))
        .await
        .map_err(|e| db_text(&e))?;
    let now = timestamp_of_millis(now_millis());

    if let Some((map_id, task_id, last_task, last_issue)) = existing {
        let task: Option<PrimitiveDateTime> = tasks::Entity::find()
            .select_only()
            .column(tasks::Column::UpdatedAt)
            .filter(tasks::Column::Id.eq(&task_id))
            .into_tuple()
            .one(&orm(db))
            .await
            .map_err(|e| db_text(&e))?;
        let Some(task_updated_at) = task.map(millis_of_timestamp) else {
            sync_map::Entity::delete_many()
                .filter(sync_map::Column::Id.eq(&map_id))
                .exec(&orm(db))
                .await
                .map_err(|e| db_text(&e))?;
            return Ok(());
        };
        match decide(
            task_updated_at,
            last_task.map(millis_of_timestamp),
            last_issue.map(millis_of_timestamp),
            issue_updated_at,
            item,
        ) {
            Decision::Skip => {}
            Decision::KeepTask => {
                sync_map::Entity::update_many()
                    .col_expr(
                        sync_map::Column::LastSyncedTaskUpdatedAt,
                        Expr::value(timestamp_of_millis(task_updated_at)),
                    )
                    .col_expr(
                        sync_map::Column::LastSyncedIssueUpdatedAt,
                        Expr::value(issue_at),
                    )
                    .col_expr(sync_map::Column::LastWriterSide, Expr::value("task"))
                    .col_expr(sync_map::Column::UpdatedAt, Expr::value(now))
                    .filter(sync_map::Column::Id.eq(&map_id))
                    .exec(&orm(db))
                    .await
                    .map_err(|e| db_text(&e))?;
            }
            Decision::ApplyIssue => {
                // `updateMappedTask`: the stage only when the option maps to one.
                let mut update = tasks::Entity::update_many()
                    .col_expr(tasks::Column::Title, Expr::value(&item.title))
                    .col_expr(tasks::Column::Description, Expr::value(item.body.clone()))
                    .col_expr(tasks::Column::Status, Expr::value(status))
                    .col_expr(tasks::Column::Labels, Expr::value(json!(item.labels)))
                    .col_expr(tasks::Column::UpdatedAt, Expr::value(now));
                if let Some(stage_id) = &stage_id {
                    update = update.col_expr(tasks::Column::StageId, Expr::value(stage_id));
                }
                update
                    .filter(tasks::Column::Id.eq(&task_id))
                    .exec(&orm(db))
                    .await
                    .map_err(|e| db_text(&e))?;
                sync_map::Entity::update_many()
                    .col_expr(
                        sync_map::Column::LastSyncedIssueUpdatedAt,
                        Expr::value(issue_at),
                    )
                    .col_expr(sync_map::Column::LastSyncedTaskUpdatedAt, Expr::value(now))
                    .col_expr(
                        sync_map::Column::IssueNodeId,
                        Expr::value(&item.issue_node_id),
                    )
                    .col_expr(
                        sync_map::Column::IssueNumber,
                        Expr::value(i32::try_from(item.number).unwrap_or(i32::MAX)),
                    )
                    .col_expr(sync_map::Column::RepoId, Expr::value(item.repo_id))
                    .col_expr(sync_map::Column::LastWriterSide, Expr::value("issue"))
                    .col_expr(sync_map::Column::UpdatedAt, Expr::value(now))
                    .filter(sync_map::Column::Id.eq(&map_id))
                    .exec(&orm(db))
                    .await
                    .map_err(|e| db_text(&e))?;
            }
        }
        return Ok(());
    }

    let task_id = weldsuite_kit::generate_id("tsk");
    let map_id = weldsuite_kit::generate_id("ghsm");
    tasks::Entity::insert(tasks::ActiveModel {
        id: Set(task_id.clone()),
        title: Set(item.title.clone()),
        description: Set(item.body.clone()),
        status: Set(status.to_owned()),
        stage_id: Set(stage_id.clone()),
        priority: Set("medium".to_owned()),
        progress: Set(BigDecimal::from(0)),
        project_id: Set(Some(project_id.to_owned())),
        labels: Set(Some(json!(item.labels))),
        github_issue_number: Set(Some(i32::try_from(item.number).unwrap_or(i32::MAX))),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await
    .map_err(|e| db_text(&e))?;
    sync_map::Entity::insert(sync_map::ActiveModel {
        id: Set(map_id),
        workspace_id: Set(workspace_id.to_owned()),
        project_link_id: Set(project_link_id.to_owned()),
        task_id: Set(task_id),
        project_item_node_id: Set(item.item_node_id.clone()),
        issue_node_id: Set(Some(item.issue_node_id.clone())),
        issue_number: Set(i32::try_from(item.number).unwrap_or(i32::MAX)),
        repo_id: Set(item.repo_id),
        last_synced_task_updated_at: Set(Some(now)),
        last_synced_issue_updated_at: Set(Some(issue_at)),
        last_writer_side: Set(Some("issue".to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
    })
    .exec_without_returning(&orm(db))
    .await
    .map_err(|e| db_text(&e))?;
    Ok(())
}

/// `pruneStaleMappings`: sync-map rows whose item the pull did not see.
async fn prune_stale_mappings(
    db: &PgPool,
    project_link_id: &str,
    seen: &HashSet<String>,
) -> Result<usize, String> {
    let rows: Vec<(String, String)> = sync_map::Entity::find()
        .select_only()
        .columns([sync_map::Column::Id, sync_map::Column::ProjectItemNodeId])
        .filter(sync_map::Column::ProjectLinkId.eq(project_link_id))
        .into_tuple()
        .all(&orm(db))
        .await
        .map_err(|e| db_text(&e))?;
    let stale: Vec<String> = rows
        .into_iter()
        .filter(|(_, item)| !seen.contains(item))
        .map(|(id, _)| id)
        .collect();
    if !stale.is_empty() {
        sync_map::Entity::delete_many()
            .filter(sync_map::Column::Id.is_in(stale.iter().cloned()))
            .exec(&orm(db))
            .await
            .map_err(|e| db_text(&e))?;
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
    )> = tasks::Entity::find()
        .select_only()
        .columns([
            tasks::Column::Id,
            tasks::Column::Title,
            tasks::Column::Description,
            tasks::Column::StageId,
            tasks::Column::Status,
            tasks::Column::Labels,
            tasks::Column::GithubIssueNumber,
        ])
        .filter(tasks::Column::ProjectId.eq(project_id))
        .filter(tasks::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
        .map_err(|e| db_text(&e))?;
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
    let mapped: Option<String> = sync_map::Entity::find()
        .select_only()
        .column(sync_map::Column::Id)
        .filter(sync_map::Column::TaskId.eq(&task.id))
        .into_tuple()
        .one(&orm(db))
        .await
        .map_err(|e| db_text(&e))?;
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
    let now = timestamp_of_millis(now_millis());
    let number = i32::try_from(issue.number).unwrap_or(i32::MAX);
    // Claim the task at once, so a concurrent pass never creates a second issue.
    tasks::Entity::update_many()
        .col_expr(tasks::Column::GithubIssueNumber, Expr::value(number))
        .col_expr(tasks::Column::UpdatedAt, Expr::value(now))
        .filter(tasks::Column::Id.eq(&task.id))
        .exec(&orm(db))
        .await
        .map_err(|e| db_text(&e))?;
    let issue_updated = millis_of_iso(&issue.updated_at)
        .map(timestamp_of_millis)
        .ok_or_else(|| "Invalid time value".to_owned())?;
    sync_map::Entity::insert(sync_map::ActiveModel {
        id: Set(weldsuite_kit::generate_id("ghsm")),
        workspace_id: Set(workspace_id.to_owned()),
        project_link_id: Set(project_link_id.to_owned()),
        task_id: Set(task.id.clone()),
        project_item_node_id: Set(item),
        issue_node_id: Set(Some(issue.node_id)),
        issue_number: Set(number),
        repo_id: Set(None),
        last_synced_task_updated_at: Set(Some(now)),
        last_synced_issue_updated_at: Set(Some(issue_updated)),
        last_writer_side: Set(Some("task".to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
    })
    .exec_without_returning(&orm(db))
    .await
    .map_err(|e| db_text(&e))?;
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
    let rows: Vec<(String, String)> = sync_map::Entity::find()
        .select_only()
        .columns([sync_map::Column::TaskId, sync_map::Column::ProjectItemNodeId])
        .filter(sync_map::Column::ProjectLinkId.eq(project_link_id))
        .into_tuple()
        .all(&orm(&db))
        .await
        .map_err(|e| db_text(&e))?;
    let item_by_task: HashMap<String, String> = rows.into_iter().collect();
    let tasks = project_tasks(&db, &link.project_id).await?;
    let status_to_stage = status_to_stage_id(&db, &link.project_id)
        .await
        .map_err(|e| db_text(&e))?;
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
            let now = timestamp_of_millis(now_millis());
            links::Entity::update_many()
                .col_expr(links::Column::LastSyncedAt, Expr::value(now))
                .col_expr(links::Column::LastError, Expr::value(None::<String>))
                .col_expr(links::Column::SyncCursor, Expr::value(None::<String>))
                .col_expr(links::Column::UpdatedAt, Expr::value(now))
                .filter(links::Column::Id.eq(link_id))
                .exec(&orm(&db))
                .await
                .map_err(|e| failed(db_text(&e)))?;
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
