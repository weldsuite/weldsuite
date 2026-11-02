//! `domains.ts`: the connected domains as the app shows them.

use serde_json::{Value, json};
use sqlx::PgPool;

use crate::{ReachError, ReachResult, field, js_rows, text};

/// `toDomainDto(row, mailboxCount)`.
pub fn to_dto(row: &Value, mailbox_count: i64) -> Value {
    json!({
        "id": field(row, "id"),
        "hostDomainId": field(row, "hostDomainId"),
        "name": field(row, "name"),
        "mailpoolDomainId": field(row, "mailpoolDomainId"),
        "status": field(row, "status"),
        "dnsStatus": field(row, "dnsStatus"),
        "dmarcPolicy": field(row, "dmarcPolicy"),
        "connectedAt": field(row, "connectedAt"),
        "lastError": field(row, "lastError"),
        "mailboxCount": mailbox_count,
        "createdAt": field(row, "createdAt"),
    })
}

/// `domainMailboxCounts(db, domainIds)`.
pub async fn mailbox_counts(db: &PgPool, domain_ids: &[String]) -> ReachResult<Vec<(String, i64)>> {
    if domain_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_as(
        "select domain_id, count(*) from reach_mailboxes
         where domain_id = any($1) and status <> 'deleted' and deleted_at is null group by domain_id",
    )
    .bind(domain_ids)
    .fetch_all(db)
    .await?)
}

fn count_of(counts: &[(String, i64)], id: &str) -> i64 {
    counts.iter().find(|(d, _)| d == id).map_or(0, |(_, n)| *n)
}

/// `listDomains(db)`.
pub async fn list(db: &PgPool) -> ReachResult<Vec<Value>> {
    let rows = js_rows(
        sqlx::query_scalar("select to_jsonb(t) from reach_domains t order by t.created_at")
            .fetch_all(db)
            .await?,
    );
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|r| text(r, "id").map(str::to_owned))
        .collect();
    let counts = mailbox_counts(db, &ids).await?;
    Ok(rows
        .iter()
        .map(|row| to_dto(row, count_of(&counts, text(row, "id").unwrap_or_default())))
        .collect())
}

/// `requireDomain(db, id)`.
pub async fn require(db: &PgPool, id: &str) -> ReachResult<Value> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from reach_domains t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    row.map(weldsuite_db::js_row)
        .ok_or_else(|| ReachError::not_found("Domain", Some(id)))
}

/// `getDomainDto(db, id)`.
pub async fn get(db: &PgPool, id: &str) -> ReachResult<Value> {
    let row = require(db, id).await?;
    let counts = mailbox_counts(db, &[id.to_owned()]).await?;
    Ok(to_dto(&row, count_of(&counts, id)))
}
