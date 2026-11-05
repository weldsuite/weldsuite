//! Git-provider connections (ADR MERGE-002): `/api/merge/connections`.
//!
//! ```text
//!   GET    /                           → connections (merge_connections:read)
//!   POST   /github                     → adopt the workspace's GitHub App installation, or { status: 'needs_install' }
//!   DELETE /:id                        → stop tracking the connection and its repositories (never uninstalls the App)
//!   GET    /:id/available-repositories → what the installation can see, from GitHub
//! ```
//!
//! For GitHub a connection adopts the workspace's existing GitHub App
//! installation (`github_connections`, written by connect-api's install
//! flow): no second consent, nothing secret stored. Changing connections
//! needs `merge_connections:manage`. Entity events carry the provider and
//! account login only, never credentials.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::response::IntoResponse;
use http::StatusCode;
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::{Data, NoContent, generate_id};

use crate::db::{Row, is_unique_violation, rows_of, text};
use crate::github::js_string;
use crate::github_client::list_installation_repositories;
use crate::mappers::{connection_dto, connection_event_data, repository_event_data};
use crate::{Answer, Caller, MergeState, PendingEvent, Refusal, all, now, publish};

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
async fn repository_count(db: &PgPool, connection_id: &str) -> Result<i64, sqlx::Error> {
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

async fn find_github_connection(
    db: &PgPool,
    external_account_id: &str,
) -> Result<Option<Row>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from merge_connections c where c.provider = 'github' \
         and c.external_account_id = $1 and c.deleted_at is null limit 1",
    )
    .bind(external_account_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `POST /github`: adopts the workspace's active GitHub App installation;
/// idempotent.
pub(crate) async fn connect_github(State(state): State<MergeState>, caller: Caller) -> Answer {
    let db = &caller.db;
    let installation: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(g) from github_connections g where g.status = 'active' and g.deleted_at is null \
         order by g.created_at desc, g.id desc limit 1",
    )
    .fetch_optional(db)
    .await?;
    let Some(installation) = installation.map(js_row) else {
        return Ok(Data(json!({ "status": "needs_install" })).into_response());
    };
    let external_account_id = js_string(installation.get("installationId"));
    let (connection, created) = match find_github_connection(db, &external_account_id).await? {
        Some(existing) if text(&existing, "status") == "active" => (existing, false),
        Some(existing) => {
            let revived: Value = sqlx::query_scalar(
                "update merge_connections set status = 'active', updated_at = $2::timestamptz \
                 where id = $1 returning to_jsonb(merge_connections.*)",
            )
            .bind(text(&existing, "id"))
            .bind(now())
            .fetch_one(db)
            .await?;
            (js_row(revived), false)
        }
        None => {
            let now = now();
            let account_type = if text(&installation, "ownerType") == "org" {
                "organization"
            } else {
                "user"
            };
            let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(
                "insert into merge_connections (id, provider, external_account_id, account_login, account_type, \
                   status, created_by_user_id, created_at, updated_at) \
                 values ($1, 'github', $2, $3, $4, 'active', $5, $6::timestamptz, $6::timestamptz) \
                 returning to_jsonb(merge_connections.*)",
            )
            .bind(generate_id("mcn"))
            .bind(&external_account_id)
            .bind(installation.get("ownerLogin").and_then(Value::as_str))
            .bind(account_type)
            .bind(&caller.user_id)
            .bind(&now)
            .fetch_one(db)
            .await;
            match inserted {
                Ok(row) => (js_row(row), true),
                // Two members connected at once: the other insert won.
                Err(error) if is_unique_violation(&error) => {
                    match find_github_connection(db, &external_account_id).await? {
                        Some(winner) => (winner, false),
                        None => return Err(error.into()),
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
    };
    if created {
        publish(
            &state,
            &caller.events,
            vec![PendingEvent::new(
                "merge_connection",
                "created",
                text(&connection, "id"),
                connection_event_data(&connection),
            )],
        );
    }
    let count = repository_count(db, text(&connection, "id")).await?;
    let body =
        Data(json!({ "status": "connected", "connection": connection_dto(&connection, count) }));
    Ok(if created {
        (StatusCode::CREATED, body).into_response()
    } else {
        body.into_response()
    })
}

/// `DELETE /:id`: soft-deletes the connection and its repositories. Never
/// uninstalls the GitHub App.
pub(crate) async fn remove(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let db = &caller.db;
    if find_connection(db, &id).await?.is_none() {
        return Err(Refusal::not_found("Connection", Some(&id)));
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

/// `GET /:id/available-repositories`: what the installation can see, from
/// GitHub, marking the repositories already tracked.
pub(crate) async fn available_repositories(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let db = &caller.db;
    let connection = find_connection(db, &id)
        .await?
        .filter(|c| text(c, "provider") == "github");
    let Some(connection) = connection else {
        return Err(Refusal::not_found("Connection", Some(&id)));
    };
    let client = caller
        .overrides
        .github(&state, text(&connection, "externalAccountId"));
    let available = list_installation_repositories(&client).await?;
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
            let external_id = js_string(repo.get("id"));
            let mut row = Map::new();
            row.insert("externalId".to_owned(), json!(external_id));
            // `undefined` fields drop out of the JSON, as `JSON.stringify` drops them.
            if let Some(name) = repo.get("full_name") {
                row.insert("fullName".to_owned(), name.clone());
            }
            if let Some(private) = repo.get("private") {
                row.insert("private".to_owned(), private.clone());
            }
            row.insert(
                "defaultBranch".to_owned(),
                repo.get("default_branch").cloned().unwrap_or(Value::Null),
            );
            row.insert(
                "url".to_owned(),
                repo.get("html_url").cloned().unwrap_or(Value::Null),
            );
            row.insert("added".to_owned(), json!(added.contains(&external_id)));
            Value::Object(row)
        })
        .collect();
    Ok(all(rows))
}
