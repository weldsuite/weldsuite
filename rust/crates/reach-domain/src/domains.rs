//! `domains.ts`: the connected domains as the app shows them.

use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_db::orm;
use weldsuite_schema::tenant::{reach_domains, reach_mailboxes};

use crate::{ReachError, ReachResult, field, js, js_all, text};

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
    use reach_mailboxes::Column;
    Ok(reach_mailboxes::Entity::find()
        .select_only()
        .column(Column::DomainId)
        .expr(Func::count(Expr::col(Asterisk)))
        .filter(Column::DomainId.is_in(domain_ids))
        .filter(Column::Status.ne("deleted"))
        .filter(Column::DeletedAt.is_null())
        .group_by(Column::DomainId)
        .into_tuple()
        .all(&orm(db))
        .await?)
}

fn count_of(counts: &[(String, i64)], id: &str) -> i64 {
    counts.iter().find(|(d, _)| d == id).map_or(0, |(_, n)| *n)
}

/// `listDomains(db)`.
pub async fn list(db: &PgPool) -> ReachResult<Vec<Value>> {
    let rows = js_all(
        reach_domains::Entity::find()
            .order_by_asc(reach_domains::Column::CreatedAt)
            .all(&orm(db))
            .await?
            .into_iter()
            .map(serde_json::to_value),
    )?;
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
    let row = reach_domains::Entity::find_by_id(id)
        .one(&orm(db))
        .await?
        .ok_or_else(|| ReachError::not_found("Domain", Some(id)))?;
    Ok(js(serde_json::to_value(row))?)
}

/// `getDomainDto(db, id)`.
pub async fn get(db: &PgPool, id: &str) -> ReachResult<Value> {
    let row = require(db, id).await?;
    let counts = mailbox_counts(db, &[id.to_owned()]).await?;
    Ok(to_dto(&row, count_of(&counts, id)))
}
