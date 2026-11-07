//! What a sync call acts on (`services/issue-sync/targets.ts`): a tracked
//! repository with its live connection, and the link between an issue and
//! its provider issue.

use serde_json::Value;
use weldsuite_db::{PgPool, js_row};

use crate::db::Row;

/// `SyncTarget`: a live repository on an active connection.
#[derive(Debug, Clone)]
pub(crate) struct SyncTarget {
    pub(crate) repository: Row,
    pub(crate) connection: Row,
}

fn target_of(row: Option<(Value, Value)>) -> Option<SyncTarget> {
    row.map(|(repository, connection)| SyncTarget {
        repository: js_row(repository),
        connection: js_row(connection),
    })
}

/// `loadTarget(db, repositoryId)`.
pub(crate) async fn load_target(
    db: &PgPool,
    repository_id: &str,
) -> Result<Option<SyncTarget>, sqlx::Error> {
    let row: Option<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(r), to_jsonb(c) from merge_repositories r \
         inner join merge_connections c on c.id = r.connection_id \
         where r.id = $1 and r.deleted_at is null and c.deleted_at is null and c.status = 'active' limit 1",
    )
    .bind(repository_id)
    .fetch_optional(db)
    .await?;
    Ok(target_of(row))
}

/// `loadTargetByExternalId(db, provider, externalId)`.
pub(crate) async fn load_target_by_external_id(
    db: &PgPool,
    provider: &str,
    external_id: &str,
) -> Result<Option<SyncTarget>, sqlx::Error> {
    let row: Option<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(r), to_jsonb(c) from merge_repositories r \
         inner join merge_connections c on c.id = r.connection_id \
         where r.provider = $1 and r.external_id = $2 and r.deleted_at is null \
           and c.deleted_at is null and c.status = 'active' limit 1",
    )
    .bind(provider)
    .bind(external_id)
    .fetch_optional(db)
    .await?;
    Ok(target_of(row))
}

/// `findLinkByIssue(db, issueId)`.
pub(crate) async fn find_link_by_issue(
    db: &PgPool,
    issue_id: &str,
) -> Result<Option<Row>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(x) from merge_external_issues x where x.issue_id = $1 limit 1",
    )
    .bind(issue_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `findLinkByNumber(db, repositoryId, number)`.
pub(crate) async fn find_link_by_number(
    db: &PgPool,
    repository_id: &str,
    number: i64,
) -> Result<Option<Row>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(x) from merge_external_issues x where x.repository_id = $1 and x.number = $2 limit 1",
    )
    .bind(repository_id)
    .bind(number)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}
