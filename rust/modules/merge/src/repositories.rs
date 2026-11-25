//! Repositories WeldMerge tracks, and the backfill that loads their pull
//! requests: `/api/merge/repositories`.
//!
//! ```text
//!   GET    /          → tracked repositories (merge_connections:read)
//!   POST   /          → add one: look it up through the connection's provider (GitLab, Bitbucket and Azure DevOps
//!                       also register their webhook and index its key), then load its open and recently merged pull requests
//!   PATCH  /:id       → team, prSync; issueSync accepts off|import|two_way on GitHub and GitLab, only off elsewhere (422)
//!   DELETE /:id       → stop tracking (soft delete); a provider hook and its index row are deleted first
//!   POST   /:id/sync  → read the pull requests again (Refresh)
//! ```
//!
//! Changing repositories needs `merge_connections:manage`. Loading history
//! never runs the automations: a backfill must not move issues.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder,
    QuerySelect, RelationDef,
};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::{merge_connections, merge_pull_requests, merge_repositories};

use crate::connections::find_connection;
use crate::credentials::adapter_context;
use crate::db::{Row, json_row, text};
use crate::issues::diff_fields;
use crate::mappers::{repository_dto, repository_event_data};
use crate::pr_sync::{UpsertStatus, upsert_mirror};
use crate::providers::{self, AdapterContext, RepositoryRef, issue_sync_modes, registers_webhooks};
use crate::schemas::{ISSUE_SYNC_MODES, nothing_to_update};
use crate::teams::find_team;
use crate::webhooks::{register_repository_webhook, unregister_repository_webhook};
use crate::{
    Answer, Caller, MergeError, MergeState, PendingEvent, Refusal, all, publish, validate,
};

/// The row a `.returning()` update answers with: none is the error
/// `fetch_one` raised (the route's 500).
fn returned(rows: Vec<merge_repositories::Model>) -> Result<Row, DbErr> {
    let repository = rows
        .into_iter()
        .next()
        .ok_or_else(|| DbErr::RecordNotFound("merge_repositories".to_owned()))?;
    json_row(serde_json::to_value(repository))
}

/// Open pull requests per repository.
async fn open_pull_request_counts(
    db: &PgPool,
    repository_ids: &[String],
) -> Result<HashMap<String, i64>, DbErr> {
    if repository_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, i64)> = merge_pull_requests::Entity::find()
        .select_only()
        .column(merge_pull_requests::Column::RepositoryId)
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "count")
        .filter(merge_pull_requests::Column::RepositoryId.is_in(repository_ids.iter().cloned()))
        .filter(merge_pull_requests::Column::State.eq("open"))
        .group_by(merge_pull_requests::Column::RepositoryId)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().collect())
}

async fn dto(db: &PgPool, row: &Row) -> Result<Value, DbErr> {
    let id = text(row, "id").to_owned();
    let counts = open_pull_request_counts(db, std::slice::from_ref(&id)).await?;
    Ok(repository_dto(row, counts.get(&id).copied().unwrap_or(0)))
}

pub(crate) async fn find_repository(db: &PgPool, id: &str) -> Result<Option<Row>, DbErr> {
    merge_repositories::Entity::find_by_id(id.to_owned())
        .filter(merge_repositories::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(|repository| json_row(serde_json::to_value(repository)))
        .transpose()
}

fn repository_event(row: &Row, action: &'static str) -> PendingEvent {
    PendingEvent::new(
        "merge_repository",
        action,
        text(row, "id"),
        repository_event_data(row),
    )
}

pub(crate) async fn list(caller: Caller) -> Answer {
    let connection: RelationDef = merge_repositories::Entity::belongs_to(merge_connections::Entity)
        .from(merge_repositories::Column::ConnectionId)
        .to(merge_connections::Column::Id)
        .into();
    let rows = merge_repositories::Entity::find()
        .join(JoinType::InnerJoin, connection)
        .filter(merge_repositories::Column::DeletedAt.is_null())
        .filter(merge_connections::Column::DeletedAt.is_null())
        .order_by_asc(merge_repositories::Column::FullName)
        .order_by_asc(merge_repositories::Column::Id)
        .all(&orm(&caller.db))
        .await?
        .into_iter()
        .map(|repository| json_row(serde_json::to_value(repository)))
        .collect::<Result<Vec<Row>, DbErr>>()?;
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let counts = open_pull_request_counts(&caller.db, &ids).await?;
    Ok(all(rows
        .iter()
        .map(|row| repository_dto(row, counts.get(text(row, "id")).copied().unwrap_or(0)))
        .collect()))
}

/// What a backfill did (`SyncSummary`).
struct SyncSummary {
    pull_requests_synced: usize,
    links_created: usize,
    events: Vec<PendingEvent>,
}

/// `syncRepository(db, repository, ctx)`: reads open pull requests and
/// those closed or merged in the last 30 days through the provider and
/// mirrors them, with their `auto` links. It never runs the automation
/// rules.
async fn sync_repository(
    db: &PgPool,
    repository: &Row,
    ctx: &AdapterContext,
) -> Result<SyncSummary, MergeError> {
    let pulls =
        providers::list_pull_requests_for_backfill(ctx, &RepositoryRef::of(repository)).await?;
    let mut summary = SyncSummary {
        pull_requests_synced: 0,
        links_created: 0,
        events: Vec::new(),
    };
    for pull in pulls {
        let outcome = upsert_mirror(db, repository, pull, false, true, None).await?;
        if outcome.status != UpsertStatus::Stale {
            summary.pull_requests_synced += 1;
        }
        summary.links_created += outcome.links_created;
        summary.events.extend(outcome.events);
    }
    Ok(summary)
}

async fn touch_synced(db: &PgPool, id: &str) -> Result<Row, DbErr> {
    let at = utc_now().assume_utc();
    returned(
        merge_repositories::Entity::update_many()
            .col_expr(merge_repositories::Column::LastSyncedAt, Expr::value(at))
            .col_expr(merge_repositories::Column::UpdatedAt, Expr::value(at))
            .filter(merge_repositories::Column::Id.eq(id))
            .exec_with_returning(&orm(db))
            .await?,
    )
}

pub(crate) async fn add(
    State(state): State<MergeState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (connection_id, external_id, external_project, team_id, pr_sync) =
        validate(&headers, &body, |issues, fields| {
            (
                issues
                    .text(fields, "connectionId", Presence::Required, Some(1), None)
                    .into_option()
                    .unwrap_or_default(),
                issues
                    .text(fields, "externalId", Presence::Required, Some(1), None)
                    .into_option()
                    .unwrap_or_default(),
                issues
                    .text(
                        fields,
                        "externalProject",
                        Presence::Nullish,
                        None,
                        Some(500),
                    )
                    .into_option(),
                issues
                    .text(fields, "teamId", Presence::Nullish, None, None)
                    .into_option(),
                issues
                    .boolean(fields, "prSync", Presence::Optional)
                    .into_option()
                    .unwrap_or(true),
            )
        })?;
    let db = &caller.db;
    let connection = find_connection(db, &connection_id)
        .await?
        .filter(|c| text(c, "status") == "active");
    let Some(connection) = connection else {
        return Err(Refusal::not_found("Connection", Some(&connection_id)));
    };
    let ctx = adapter_context(db, &state, &caller.overrides, &connection, None).await?;
    if let Some(team) = team_id.as_deref().filter(|t| !t.is_empty())
        && find_team(db, team).await?.is_none()
    {
        return Err(Refusal::not_found("Team", Some(team)));
    }
    let dupe: Option<String> = merge_repositories::Entity::find()
        .select_only()
        .column(merge_repositories::Column::Id)
        .filter(merge_repositories::Column::ConnectionId.eq(text(&connection, "id")))
        .filter(merge_repositories::Column::ExternalId.eq(&external_id))
        .filter(merge_repositories::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if dupe.is_some() {
        return Err(Refusal::conflict("This repository is already tracked"));
    }
    let Some(remote) =
        providers::get_repository(&ctx, &external_id, external_project.as_deref()).await?
    else {
        return Err(Refusal::not_found("Repository", Some(&external_id)));
    };
    // A provider without the repository's name: the insert's not-null refusal (500).
    let full_name = remote
        .full_name
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| {
            DbErr::Custom(
                "null value in column \"full_name\" of relation \"merge_repositories\"".to_owned(),
            )
        })?;
    let at = utc_now().assume_utc();
    let inserted = merge_repositories::Entity::insert(merge_repositories::ActiveModel {
        id: Set(generate_id("mrp")),
        connection_id: Set(text(&connection, "id").to_owned()),
        provider: Set(text(&connection, "provider").to_owned()),
        external_id: Set(remote.external_id.clone()),
        full_name: Set(full_name),
        default_branch: Set(remote.default_branch.clone()),
        // `coalesce($7, true)`
        private: Set(remote.private.as_bool().unwrap_or(true)),
        url: Set(remote.url.clone()),
        external_project: Set(remote.external_project.clone().or(external_project)),
        team_id: Set(team_id),
        issue_sync: Set("off".to_owned()),
        pr_sync: Set(pr_sync),
        created_by_user_id: Set(caller.user_id.clone()),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await;
    let mut repository = match inserted {
        Ok(row) => json_row(serde_json::to_value(row))?,
        Err(error) if weldsuite_db::is_unique_violation(&error) => {
            return Err(Refusal::conflict("This repository is already tracked"));
        }
        Err(error) => return Err(error.into()),
    };
    if registers_webhooks(text(&connection, "provider")) {
        match register_repository_webhook(db, &ctx, &caller.workspace_id, &repository).await {
            Ok(row) => repository = row,
            Err(error) => {
                // Nothing is tracked until its webhook is in place: take the new row back out.
                merge_repositories::Entity::delete_by_id(text(&repository, "id").to_owned())
                    .exec(&orm(db))
                    .await?;
                return Err(error.into());
            }
        }
    }
    // The repository is tracked now (its webhook and index row are in place):
    // a failed first sync answers it with nothing synced and leaves it
    // unsynced, so a refresh or the next webhook loads its pull requests.
    let (sync, repository) = match sync_repository(db, &repository, &ctx).await {
        Ok(sync) => (sync, touch_synced(db, text(&repository, "id")).await?),
        Err(error) => {
            tracing::warn!(?error, "merge: the first sync of a new repository failed");
            let nothing = SyncSummary {
                pull_requests_synced: 0,
                links_created: 0,
                events: Vec::new(),
            };
            (nothing, repository)
        }
    };
    let mut events = vec![repository_event(&repository, "created")];
    events.extend(sync.events);
    publish(&state, &caller.events, events);
    Ok(Created(json!({
        "repository": dto(db, &repository).await?,
        "pullRequestsSynced": sync.pull_requests_synced,
        "linksCreated": sync.links_created,
    }))
    .into_response())
}

pub(crate) async fn update(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (team_id, pr_sync, issue_sync) = validate(&headers, &body, |issues, fields| {
        let start = issues.count();
        let read = (
            issues.text(fields, "teamId", Presence::Nullish, None, None),
            issues.boolean(fields, "prSync", Presence::Optional),
            issues.choice(fields, "issueSync", Presence::Optional, &ISSUE_SYNC_MODES),
        );
        nothing_to_update(issues, start, fields, &["teamId", "prSync", "issueSync"]);
        read
    })?;
    let db = &caller.db;
    let Some(before) = find_repository(db, &id).await? else {
        return Err(Refusal::not_found("Repository", Some(&id)));
    };
    // `import` and `two_way` work for GitHub and GitLab; the other providers have no issue sync.
    if issue_sync
        .as_set()
        .is_some_and(|mode| !issue_sync_modes(text(&before, "provider")).contains(&mode.as_str()))
    {
        return Err(Refusal::unprocessable(
            "This provider has no issue sync: only \"off\" is accepted",
        ));
    }
    if let Some(team) = team_id.as_set().filter(|t| !t.is_empty())
        && find_team(db, team).await?.is_none()
    {
        return Err(Refusal::not_found("Team", None));
    }
    let (set_team, team) = match team_id {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(team) => (true, Some(team)),
    };
    let mut change = merge_repositories::Entity::update_many().col_expr(
        merge_repositories::Column::UpdatedAt,
        Expr::value(utc_now().assume_utc()),
    );
    if set_team {
        change = change.col_expr(merge_repositories::Column::TeamId, Expr::value(team));
    }
    if let Some(pr_sync) = pr_sync.into_option() {
        change = change.col_expr(merge_repositories::Column::PrSync, Expr::value(pr_sync));
    }
    if let Some(issue_sync) = issue_sync.into_option() {
        change = change.col_expr(
            merge_repositories::Column::IssueSync,
            Expr::value(issue_sync),
        );
    }
    let repository = returned(
        change
            .filter(merge_repositories::Column::Id.eq(&id))
            .exec_with_returning(&orm(db))
            .await?,
    )?;
    let changes = diff_fields(&before, &repository, &["teamId", "prSync", "issueSync"]);
    publish(
        &state,
        &caller.events,
        vec![repository_event(&repository, "updated").with_changes(changes)],
    );
    Ok(Data(dto(db, &repository).await?).into_response())
}

pub(crate) async fn remove(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let db = &caller.db;
    let Some(existing) = find_repository(db, &id).await? else {
        return Err(Refusal::not_found("Repository", Some(&id)));
    };
    // GitLab, Bitbucket and Azure DevOps: take the provider hook and the index row down first.
    if existing
        .get("webhookKey")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.is_empty())
    {
        let connection = find_connection(db, text(&existing, "connectionId")).await?;
        let ctx = match &connection {
            Some(connection) => adapter_context(db, &state, &caller.overrides, connection, None)
                .await
                .ok(),
            None => None,
        };
        unregister_repository_webhook(&state, &caller.overrides, ctx.as_ref(), &existing).await;
    }
    let at = utc_now().assume_utc();
    let rows = merge_repositories::Entity::update_many()
        .col_expr(merge_repositories::Column::DeletedAt, Expr::value(at))
        .col_expr(merge_repositories::Column::UpdatedAt, Expr::value(at))
        .filter(merge_repositories::Column::Id.eq(&id))
        .filter(merge_repositories::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(db))
        .await?;
    let Some(repository) = rows.into_iter().next() else {
        return Err(Refusal::not_found("Repository", Some(&id)));
    };
    let repository = json_row(serde_json::to_value(repository))?;
    publish(
        &state,
        &caller.events,
        vec![repository_event(&repository, "deleted")],
    );
    Ok(NoContent.into_response())
}

/// `POST /:id/sync`: reads the pull requests again (Refresh).
pub(crate) async fn sync(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let db = &caller.db;
    let Some(repository) = find_repository(db, &id).await? else {
        return Err(Refusal::not_found("Repository", Some(&id)));
    };
    let connection_id = text(&repository, "connectionId").to_owned();
    let connection = find_connection(db, &connection_id)
        .await?
        .filter(|c| text(c, "status") == "active");
    let Some(connection) = connection else {
        return Err(Refusal::not_found("Connection", Some(&connection_id)));
    };
    let ctx = adapter_context(db, &state, &caller.overrides, &connection, None).await?;
    let summary = sync_repository(db, &repository, &ctx).await?;
    let synced = touch_synced(db, &id).await?;
    publish(&state, &caller.events, summary.events);
    Ok(Data(json!({
        "repository": dto(db, &synced).await?,
        "pullRequestsSynced": summary.pull_requests_synced,
        "linksCreated": summary.links_created,
    }))
    .into_response())
}
