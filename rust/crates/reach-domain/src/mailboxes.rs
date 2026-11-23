//! `mailboxes.ts`: the mailbox DTO (warmup numbers from the master pool
//! included) and the "why is it not sending yet" blocker.

use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_schema::tenant::{reach_domains, reach_mailboxes as mailboxes, reach_messages};

use crate::access::utc_day_start;
use crate::warmup::{WARMUP_MIN_POOL_DOMAINS, gate};
use crate::warmup_pool::{PoolView, active_domain_count, read_pool};
use crate::{ReachResult, field, int, js, stamp, text, without};

/// The sealed columns no response or event carries (`SENSITIVE_COLUMNS`).
pub const SENSITIVE: &[&str] = &["smtpCredentials", "imapCredentials"];

/// `withoutCredentials(row)`.
pub fn without_credentials(row: &Value) -> Value {
    without(row, SENSITIVE)
}

/// `hasLoginError(pool)`.
pub fn has_login_error(pool: &PoolView) -> bool {
    pool.last_login_error
        .as_deref()
        .is_some_and(|e| !e.is_empty())
}

/// `warmupBlockerOf(mailbox, pool, poolDomains)`.
pub fn warmup_blocker(
    mailbox: &Value,
    pool: Option<&PoolView>,
    pool_domains: Option<i64>,
) -> Option<&'static str> {
    if text(mailbox, "status") != Some("warming") {
        return None;
    }
    let (ramp_day, rate, login_error) = match pool {
        Some(pool) => (
            pool.ramp_day,
            pool.stats
                .as_ref()
                .and_then(|s| s.get("inboxRate3d"))
                .and_then(Value::as_f64),
            has_login_error(pool),
        ),
        None => (
            int(mailbox, "warmupDay"),
            mailbox.get("warmupInboxRate").and_then(Value::as_f64),
            false,
        ),
    };
    let reason = gate(ramp_day, rate, login_error)?;
    if reason != "login_error" && pool_domains.is_some_and(|n| n < WARMUP_MIN_POOL_DOMAINS) {
        return Some("pool_too_small");
    }
    Some(reason)
}

/// `toMailboxDto(row, domainName, sentToday, warmup)`.
pub fn to_dto(
    row: &Value,
    domain_name: &str,
    sent_today: i64,
    sent7d: i64,
    rescues7d: i64,
    blocker: Option<&str>,
) -> Value {
    json!({
        "id": field(row, "id"),
        "domainId": field(row, "domainId"),
        "domainName": domain_name,
        "email": field(row, "email"),
        "firstName": field(row, "firstName"),
        "lastName": field(row, "lastName"),
        "signature": field(row, "signature"),
        "type": field(row, "type"),
        "status": field(row, "status"),
        "warmupDay": field(row, "warmupDay"),
        "warmupStatus": field(row, "warmupStatus"),
        "warmupInboxRate": field(row, "warmupInboxRate"),
        "warmupSent7d": sent7d,
        "warmupSpamRescues7d": rescues7d,
        "warmupBlocker": blocker,
        "dailyCap": field(row, "dailyCap"),
        "rampCurrent": field(row, "rampCurrent"),
        "sentToday": sent_today,
        "lastSentAt": field(row, "lastSentAt"),
        "pausedReason": field(row, "pausedReason"),
        "lastError": field(row, "lastError"),
        "createdAt": field(row, "createdAt"),
    })
}

async fn sent_today_by_mailbox(
    db: &PgPool,
    ids: &[String],
    now: OffsetDateTime,
) -> ReachResult<Vec<(String, i64)>> {
    use reach_messages::Column;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(reach_messages::Entity::find()
        .select_only()
        .column(Column::MailboxId)
        .expr(Func::count(Expr::col(Asterisk)))
        .filter(Column::MailboxId.is_in(ids))
        .filter(Column::Direction.eq("out"))
        .filter(Column::Status.eq("sent"))
        .filter(Column::SentAt.gte(stamp(utc_day_start(now))))
        .group_by(Column::MailboxId)
        .into_tuple()
        .all(&orm(db))
        .await?)
}

/// A mailbox with its domain's name (`leftJoin(reachDomains, …)`).
#[derive(Debug, FromQueryResult)]
struct WithDomain {
    #[sea_orm(nested)]
    mailbox: mailboxes::Model,
    domain_name: Option<String>,
}

impl WithDomain {
    /// `select({ ...mailbox, domainName: reachDomains.name })` with the left
    /// join, to filter and order before `into_model`.
    fn query() -> sea_orm::Select<mailboxes::Entity> {
        mailboxes::Entity::find()
            .column_as(reach_domains::Column::Name, "domain_name")
            .join(
                JoinType::LeftJoin,
                mailboxes::Entity::belongs_to(reach_domains::Entity)
                    .from(mailboxes::Column::DomainId)
                    .to(reach_domains::Column::Id)
                    .into(),
            )
    }

    /// The row as the routes read it, without its credentials.
    fn into_json(self) -> Result<Value, DbErr> {
        let mut row = js(serde_json::to_value(self.mailbox))?;
        if let Some(map) = row.as_object_mut() {
            map.insert("domainName".to_owned(), json!(self.domain_name));
        }
        Ok(without_credentials(&row))
    }
}

/// Where a request reads the warmup pool (`WarmupSource`): the master
/// database and the Clerk org id.
#[derive(Debug, Clone)]
pub struct WarmupSource<'a> {
    pub clerk_org_id: &'a str,
    pub master: Option<&'a PgPool>,
}

/// `readWarmupViews(source, rows)`: best effort.
async fn warmup_views(source: &WarmupSource<'_>, rows: &[Value]) -> (Vec<PoolView>, Option<i64>) {
    if rows.is_empty() {
        return (Vec::new(), None);
    }
    let Some(master) = source.master else {
        tracing::warn!("[reach-mailboxes] warmup pool unavailable: no master database");
        return (Vec::new(), None);
    };
    let views = match read_pool(master, source.clerk_org_id).await {
        Ok(views) => views,
        Err(error) => {
            tracing::warn!(%error, "[reach-mailboxes] warmup pool unavailable");
            return (Vec::new(), None);
        }
    };
    let pool_domains = if rows.iter().any(|r| text(r, "status") == Some("warming")) {
        match active_domain_count(master).await {
            Ok(n) => Some(n),
            Err(error) => {
                tracing::warn!(%error, "[reach-mailboxes] warmup pool unavailable");
                return (Vec::new(), None);
            }
        }
    } else {
        None
    };
    (views, pool_domains)
}

fn dto_of(row: &Value, sent: &[(String, i64)], views: &(Vec<PoolView>, Option<i64>)) -> Value {
    let id = text(row, "id").unwrap_or_default();
    let pool = views.0.iter().find(|v| v.tenant_mailbox_id == id);
    let stat = |key: &str| {
        pool.and_then(|p| p.stats.as_ref())
            .and_then(|s| s.get(key))
            .and_then(Value::as_i64)
            .unwrap_or_default()
    };
    to_dto(
        row,
        text(row, "domainName").unwrap_or_default(),
        sent.iter().find(|(m, _)| m == id).map_or(0, |(_, n)| *n),
        stat("sent7d"),
        stat("spamRescues7d"),
        warmup_blocker(row, pool, views.1),
    )
}

/// `listMailboxes(deps, filter)`.
pub async fn list(
    db: &PgPool,
    source: &WarmupSource<'_>,
    domain_id: Option<&str>,
    status: Option<&str>,
) -> ReachResult<Vec<Value>> {
    use mailboxes::Column;
    let mut filters = Condition::all();
    if status == Some("deleted") {
        filters = filters.add(Column::Status.eq("deleted"));
    } else {
        filters = filters
            .add(Column::Status.ne("deleted"))
            .add(Column::DeletedAt.is_null());
        if let Some(status) = status {
            filters = filters.add(Column::Status.eq(status));
        }
    }
    if let Some(domain_id) = domain_id {
        filters = filters.add(Column::DomainId.eq(domain_id));
    }
    let rows = WithDomain::query()
        .filter(filters)
        .order_by_asc(Column::CreatedAt)
        .into_model::<WithDomain>()
        .all(&orm(db))
        .await?
        .into_iter()
        .map(WithDomain::into_json)
        .collect::<Result<Vec<Value>, DbErr>>()?;
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|r| text(r, "id").map(str::to_owned))
        .collect();
    let sent = sent_today_by_mailbox(db, &ids, crate::now()).await?;
    let views = warmup_views(source, &rows).await;
    Ok(rows.iter().map(|row| dto_of(row, &sent, &views)).collect())
}

/// `getMailboxDto(deps, id)`: `None` for a deleted or unknown mailbox.
pub async fn get(db: &PgPool, source: &WarmupSource<'_>, id: &str) -> ReachResult<Option<Value>> {
    let row = WithDomain::query()
        .filter(mailboxes::Column::Id.eq(id))
        .filter(mailboxes::Column::Status.ne("deleted"))
        .into_model::<WithDomain>()
        .one(&orm(db))
        .await?;
    let Some(row) = row.map(WithDomain::into_json).transpose()? else {
        return Ok(None);
    };
    let sent = sent_today_by_mailbox(db, &[id.to_owned()], crate::now()).await?;
    let views = warmup_views(source, std::slice::from_ref(&row)).await;
    Ok(Some(dto_of(&row, &sent, &views)))
}
