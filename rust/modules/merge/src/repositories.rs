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
use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::connections::find_connection;
use crate::credentials::adapter_context;
use crate::db::{Row, is_unique_violation, one_by_id, rows_of, text};
use crate::issues::diff_fields;
use crate::mappers::{repository_dto, repository_event_data};
use crate::pr_sync::{UpsertStatus, upsert_mirror};
use crate::providers::{self, AdapterContext, RepositoryRef, issue_sync_modes, registers_webhooks};
use crate::schemas::{ISSUE_SYNC_MODES, nothing_to_update};
use crate::teams::find_team;
use crate::webhooks::{register_repository_webhook, unregister_repository_webhook};
use crate::{
    Answer, Caller, MergeError, MergeState, PendingEvent, Refusal, all, now, publish, validate,
};

/// Open pull requests per repository.
async fn open_pull_request_counts(
    db: &PgPool,
    repository_ids: &[String],
) -> Result<HashMap<String, i64>, sqlx::Error> {
    if repository_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, i32)> = sqlx::query_as(
        "select repository_id, count(*)::int from merge_pull_requests \
         where repository_id = any($1) and state = 'open' group by repository_id",
    )
    .bind(repository_ids)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(id, n)| (id, i64::from(n))).collect())
}

async fn dto(db: &PgPool, row: &Row) -> Result<Value, sqlx::Error> {
    let id = text(row, "id").to_owned();
    let counts = open_pull_request_counts(db, std::slice::from_ref(&id)).await?;
    Ok(repository_dto(row, counts.get(&id).copied().unwrap_or(0)))
}

pub(crate) async fn find_repository(db: &PgPool, id: &str) -> Result<Option<Row>, sqlx::Error> {
    one_by_id(
        db,
        "select to_jsonb(r) from merge_repositories r where r.id = $1 and r.deleted_at is null limit 1",
        id,
    )
    .await
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
    let rows = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(r) from merge_repositories r \
             inner join merge_connections c on c.id = r.connection_id \
             where r.deleted_at is null and c.deleted_at is null \
             order by r.full_name asc, r.id asc",
        )
        .fetch_all(&caller.db)
        .await?,
    );
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

async fn touch_synced(db: &PgPool, id: &str) -> Result<Row, sqlx::Error> {
    let row: Value = sqlx::query_scalar(
        "update merge_repositories set last_synced_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1 returning to_jsonb(merge_repositories.*)",
    )
    .bind(id)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
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
    let dupe: Option<String> = sqlx::query_scalar(
        "select id from merge_repositories where connection_id = $1 and external_id = $2 \
         and deleted_at is null limit 1",
    )
    .bind(text(&connection, "id"))
    .bind(&external_id)
    .fetch_optional(db)
    .await?;
    if dupe.is_some() {
        return Err(Refusal::conflict("This repository is already tracked"));
    }
    let Some(remote) =
        providers::get_repository(&ctx, &external_id, external_project.as_deref()).await?
    else {
        return Err(Refusal::not_found("Repository", Some(&external_id)));
    };
    let now = now();
    let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into merge_repositories (id, connection_id, provider, external_id, full_name, default_branch, \
           private, url, external_project, team_id, issue_sync, pr_sync, created_by_user_id, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, $6, coalesce($7, true), $8, $9, $10, 'off', $11, $12, \
           $13::timestamptz, $13::timestamptz) \
         returning to_jsonb(merge_repositories.*)",
    )
    .bind(generate_id("mrp"))
    .bind(text(&connection, "id"))
    .bind(text(&connection, "provider"))
    .bind(&remote.external_id)
    .bind(remote.full_name.as_str())
    .bind(&remote.default_branch)
    .bind(remote.private.as_bool())
    .bind(&remote.url)
    .bind(remote.external_project.clone().or(external_project))
    .bind(&team_id)
    .bind(pr_sync)
    .bind(&caller.user_id)
    .bind(&now)
    .fetch_one(db)
    .await;
    let mut repository = match inserted {
        Ok(row) => js_row(row),
        Err(error) if is_unique_violation(&error) => {
            return Err(Refusal::conflict("This repository is already tracked"));
        }
        Err(error) => return Err(error.into()),
    };
    if registers_webhooks(text(&connection, "provider")) {
        match register_repository_webhook(db, &ctx, &caller.workspace_id, &repository).await {
            Ok(row) => repository = row,
            Err(error) => {
                // Nothing is tracked until its webhook is in place: take the new row back out.
                sqlx::query("delete from merge_repositories where id = $1")
                    .bind(text(&repository, "id"))
                    .execute(db)
                    .await?;
                return Err(error.into());
            }
        }
    }
    let sync = sync_repository(db, &repository, &ctx).await?;
    let repository = touch_synced(db, text(&repository, "id")).await?;
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
    let row: Value = sqlx::query_scalar(
        "update merge_repositories set updated_at = $2::timestamptz, \
           team_id = case when $3 then $4 else team_id end, \
           pr_sync = case when $5::boolean is null then pr_sync else $5 end, \
           issue_sync = case when $6::text is null then issue_sync else $6 end \
         where id = $1 returning to_jsonb(merge_repositories.*)",
    )
    .bind(&id)
    .bind(now())
    .bind(set_team)
    .bind(team)
    .bind(pr_sync.into_option())
    .bind(issue_sync.into_option())
    .fetch_one(db)
    .await?;
    let repository = js_row(row);
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
    let row: Option<Value> = sqlx::query_scalar(
        "update merge_repositories set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1 and deleted_at is null returning to_jsonb(merge_repositories.*)",
    )
    .bind(&id)
    .bind(now())
    .fetch_optional(db)
    .await?;
    let Some(repository) = row.map(js_row) else {
        return Err(Refusal::not_found("Repository", Some(&id)));
    };
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
