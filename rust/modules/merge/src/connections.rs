//! Git-provider connections (ADR MERGE-002): `/api/merge/connections`.
//!
//! ```text
//!   GET    /                           → connections (merge_connections:read)
//!   POST   /github                     → the workspace's live GitHub connection, or { status: 'needs_install', url? }
//!   DELETE /:id                        → stop tracking the connection and its repositories (never uninstalls the App)
//!   GET    /:id/available-repositories → what the connection can see, from its provider
//! ```
//!
//! A GitHub connection is the workspace's GitHub App installation, recorded
//! by the install flow ([`crate::installations`]); nothing secret is stored
//! for the App itself: installation tokens are minted per call. GitLab,
//! Bitbucket and Azure DevOps connect with OAuth or a token
//! ([`crate::oauth`]). Changing connections needs `merge_connections:manage`.
//! Entity events carry the provider and account login only, never
//! credentials.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::response::IntoResponse;
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::{Data, NoContent};

use crate::credentials::adapter_context;
use crate::db::{Row, rows_of, text};
use crate::github_install::install_page;
use crate::installations::release_github_installation_index;
use crate::mappers::{connection_dto, connection_event_data, repository_event_data};
use crate::providers::list_available_repositories;
use crate::webhooks::{master_of, release_connection_webhooks};
use crate::{Answer, Caller, MergeError, MergeState, PendingEvent, Refusal, all, now, publish};

/// Live repositories per connection.
async fn repository_counts(
    db: &PgPool,
    connection_ids: &[String],
) -> Result<HashMap<String, i64>, sqlx::Error> {
    if connection_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, i32)> = sqlx::query_as(
        "select connection_id, count(*)::int from merge_repositories \
         where connection_id = any($1) and deleted_at is null group by connection_id",
    )
    .bind(connection_ids)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(id, n)| (id, i64::from(n))).collect())
}

/// `repositoryCount(db, connectionId)`.
pub(crate) async fn repository_count(db: &PgPool, connection_id: &str) -> Result<i64, sqlx::Error> {
    let count: i32 = sqlx::query_scalar(
        "select count(*)::int from merge_repositories where connection_id = $1 and deleted_at is null",
    )
    .bind(connection_id)
    .fetch_one(db)
    .await?;
    Ok(i64::from(count))
}

/// `findConnection(db, id)`: a live connection.
pub(crate) async fn find_connection(db: &PgPool, id: &str) -> Result<Option<Row>, sqlx::Error> {
    crate::db::one_by_id(
        db,
        "select to_jsonb(c) from merge_connections c where c.id = $1 and c.deleted_at is null limit 1",
        id,
    )
    .await
}

pub(crate) async fn list(caller: Caller) -> Answer {
    let rows = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(c) from merge_connections c where c.deleted_at is null \
             order by c.created_at desc, c.id desc",
        )
        .fetch_all(&caller.db)
        .await?,
    );
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let counts = repository_counts(&caller.db, &ids).await?;
    Ok(all(rows
        .iter()
        .map(|row| connection_dto(row, counts.get(text(row, "id")).copied().unwrap_or(0)))
        .collect()))
}

/// `POST /github`: the workspace's live GitHub connection, newest active
/// first; with none (or only revoked or suspended ones) the member has to
/// install the App first (`needs_install`, with the install page when the
/// App's slug is known).
pub(crate) async fn connect_github(State(state): State<MergeState>, caller: Caller) -> Answer {
    let db = &caller.db;
    let connection: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from merge_connections c where c.provider = 'github' and c.status = 'active' \
         and c.deleted_at is null order by c.created_at desc, c.id desc limit 1",
    )
    .fetch_optional(db)
    .await?;
    let Some(connection) = connection.map(js_row) else {
        let body = match caller.overrides.env_set(&state, "GITHUB_APP_SLUG") {
            Some(slug) => json!({ "status": "needs_install", "url": install_page(&slug, None) }),
            None => json!({ "status": "needs_install" }),
        };
        return Ok(Data(body).into_response());
    };
    let count = repository_count(db, text(&connection, "id")).await?;
    Ok(
        Data(json!({ "status": "connected", "connection": connection_dto(&connection, count) }))
            .into_response(),
    )
}

/// `DELETE /:id`: soft-deletes the connection and its repositories, taking
/// their provider hooks and index rows down. Never uninstalls the GitHub App.
pub(crate) async fn remove(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let db = &caller.db;
    let Some(existing) = find_connection(db, &id).await? else {
        return Err(Refusal::not_found("Connection", Some(&id)));
    };
    // A GitHub installation leaves the master index (when it names this
    // workspace) and the webhook route cache, so another workspace can
    // install it and its events stop reaching this one. First, so a failure
    // leaves the connection in place to retry.
    if text(&existing, "provider") == "github" {
        release_github_installation(&state, &caller, text(&existing, "externalAccountId")).await?;
    }
    let now = now();
    let repositories = rows_of(
        sqlx::query_scalar(
            "update merge_repositories set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
             where connection_id = $1 and deleted_at is null returning to_jsonb(merge_repositories.*)",
        )
        .bind(&id)
        .bind(&now)
        .fetch_all(db)
        .await?,
    );
    let connection: Value = sqlx::query_scalar(
        "update merge_connections set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1 returning to_jsonb(merge_connections.*)",
    )
    .bind(&id)
    .bind(&now)
    .fetch_one(db)
    .await?;
    let connection = js_row(connection);
    release_connection_webhooks(db, &state, &caller.overrides, &connection, &repositories).await;
    let mut events: Vec<PendingEvent> = repositories
        .iter()
        .map(|repo| {
            PendingEvent::new(
                "merge_repository",
                "deleted",
                text(repo, "id"),
                repository_event_data(repo),
            )
        })
        .collect();
    events.push(PendingEvent::new(
        "merge_connection",
        "deleted",
        text(&connection, "id"),
        connection_event_data(&connection),
    ));
    publish(&state, &caller.events, events);
    Ok(NoContent.into_response())
}

/// `releaseGithubInstallation(env, installationId, workspaceId)`: the
/// installation's master index row (only when it names this workspace) and
/// integration-webhook-worker's `gh-install:<id>` route cache.
async fn release_github_installation(
    state: &MergeState,
    caller: &Caller,
    installation_id: &str,
) -> Result<(), MergeError> {
    let master = master_of(state, &caller.overrides)?;
    release_github_installation_index(&master, installation_id, &caller.workspace_id).await?;
    if let Some(cache) = caller.overrides.cache(state) {
        cache
            .delete_boxed(&format!("gh-install:{installation_id}"))
            .await
            .map_err(|error| MergeError::Unexpected(error.to_string()))?;
    }
    Ok(())
}

/// `GET /:id/available-repositories`: what the connection can see, from its
/// provider, marking the repositories already tracked.
pub(crate) async fn available_repositories(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let db = &caller.db;
    let Some(connection) = find_connection(db, &id).await? else {
        return Err(Refusal::not_found("Connection", Some(&id)));
    };
    let ctx = adapter_context(db, &state, &caller.overrides, &connection, None).await?;
    let available = list_available_repositories(&ctx).await?;
    let added: HashSet<String> = sqlx::query_scalar::<_, String>(
        "select external_id from merge_repositories where connection_id = $1 and deleted_at is null",
    )
    .bind(&id)
    .fetch_all(db)
    .await?
    .into_iter()
    .collect();
    let rows: Vec<Value> = available
        .iter()
        .map(|repo| {
            let mut row = Map::new();
            row.insert("externalId".to_owned(), json!(repo.external_id));
            // `undefined` fields drop out of the JSON, as `JSON.stringify` drops them.
            if !repo.full_name.is_null() {
                row.insert("fullName".to_owned(), repo.full_name.clone());
            }
            if !repo.private.is_null() {
                row.insert("private".to_owned(), repo.private.clone());
            }
            row.insert("defaultBranch".to_owned(), json!(repo.default_branch));
            row.insert("url".to_owned(), json!(repo.url));
            row.insert("externalProject".to_owned(), json!(repo.external_project));
            row.insert("added".to_owned(), json!(added.contains(&repo.external_id)));
            Value::Object(row)
        })
        .collect();
    Ok(all(rows))
}
