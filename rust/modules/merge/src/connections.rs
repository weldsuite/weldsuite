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
use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::{Data, NoContent};
use weldsuite_schema::tenant::{merge_connections, merge_repositories};

use crate::credentials::adapter_context;
use crate::db::{Row, json_row, json_rows, now_at, text};
use crate::github_install::install_page;
use crate::installations::release_github_installation_index;
use crate::mappers::{connection_dto, connection_event_data, repository_event_data};
use crate::providers::list_available_repositories;
use crate::webhooks::{master_of, release_connection_webhooks};
use crate::{Answer, Caller, MergeError, MergeState, PendingEvent, Refusal, all, publish};

/// Live repositories per connection.
async fn repository_counts(
    db: &PgPool,
    connection_ids: &[String],
) -> Result<HashMap<String, i64>, DbErr> {
    if connection_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, i64)> = merge_repositories::Entity::find()
        .select_only()
        .column(merge_repositories::Column::ConnectionId)
        .column_as(merge_repositories::Column::Id.count(), "count")
        .filter(
            merge_repositories::Column::ConnectionId
                .is_in(connection_ids.iter().map(String::as_str)),
        )
        .filter(merge_repositories::Column::DeletedAt.is_null())
        .group_by(merge_repositories::Column::ConnectionId)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().collect())
}

/// `repositoryCount(db, connectionId)`.
pub(crate) async fn repository_count(db: &PgPool, connection_id: &str) -> Result<i64, DbErr> {
    let count = merge_repositories::Entity::find()
        .filter(merge_repositories::Column::ConnectionId.eq(connection_id))
        .filter(merge_repositories::Column::DeletedAt.is_null())
        .count(&orm(db))
        .await?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
}

/// A connection row as the services read it (credentials included: never
/// returned as is, see `connection_dto`).
pub(crate) fn connection_row(connection: merge_connections::Model) -> Result<Row, DbErr> {
    json_row(serde_json::to_value(connection))
}

/// `findConnection(db, id)`: a live connection.
pub(crate) async fn find_connection(db: &PgPool, id: &str) -> Result<Option<Row>, DbErr> {
    merge_connections::Entity::find_by_id(id.to_owned())
        .filter(merge_connections::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(connection_row)
        .transpose()
}

pub(crate) async fn list(caller: Caller) -> Answer {
    let rows = json_rows(
        merge_connections::Entity::find()
            .filter(merge_connections::Column::DeletedAt.is_null())
            .order_by_desc(merge_connections::Column::CreatedAt)
            .order_by_desc(merge_connections::Column::Id)
            .all(&orm(&caller.db))
            .await?
            .into_iter()
            .map(serde_json::to_value),
    )?;
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
    crate::require_provider(db, "github", None).await?;
    let connection = merge_connections::Entity::find()
        .filter(merge_connections::Column::Provider.eq("github"))
        .filter(merge_connections::Column::Status.eq("active"))
        .filter(merge_connections::Column::DeletedAt.is_null())
        .order_by_desc(merge_connections::Column::CreatedAt)
        .order_by_desc(merge_connections::Column::Id)
        .one(&orm(db))
        .await?
        .map(connection_row)
        .transpose()?;
    let Some(connection) = connection else {
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
    let (_, at) = now_at();
    let orm_db = orm(db);
    let repositories = json_rows(
        merge_repositories::Entity::update_many()
            .col_expr(merge_repositories::Column::DeletedAt, Expr::value(at))
            .col_expr(merge_repositories::Column::UpdatedAt, Expr::value(at))
            .filter(merge_repositories::Column::ConnectionId.eq(&id))
            .filter(merge_repositories::Column::DeletedAt.is_null())
            .exec_with_returning(&orm_db)
            .await?
            .into_iter()
            .map(serde_json::to_value),
    )?;
    let connection = connection_row(
        merge_connections::ActiveModel {
            id: Unchanged(id.clone()),
            deleted_at: Set(Some(at)),
            updated_at: Set(at),
            ..Default::default()
        }
        .update(&orm_db)
        .await?,
    )?;
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
    let added: HashSet<String> = merge_repositories::Entity::find()
        .select_only()
        .column(merge_repositories::Column::ExternalId)
        .filter(merge_repositories::Column::ConnectionId.eq(&id))
        .filter(merge_repositories::Column::DeletedAt.is_null())
        .into_tuple::<String>()
        .all(&orm(db))
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
