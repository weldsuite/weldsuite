//! `mailboxes.ts`: the mailbox DTO (warmup numbers from the master pool
//! included) and the "why is it not sending yet" blocker.

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;

use crate::access::utc_day_start;
use crate::warmup::{WARMUP_MIN_POOL_DOMAINS, gate};
use crate::warmup_pool::{PoolView, active_domain_count, read_pool};
use crate::{ReachResult, field, int, iso, text, without};

/// The sealed columns no response or event carries (`SENSITIVE_COLUMNS`).
pub const SENSITIVE: &[&str] = &["smtpCredentials", "imapCredentials"];

/// `withoutCredentials(row)`.
pub fn without_credentials(row: &Value) -> Value {
    without(row, SENSITIVE)
}

fn has_login_error(pool: &PoolView) -> bool {
    pool.last_login_error.as_deref().is_some_and(|e| !e.is_empty())
}

/// `warmupBlockerOf(mailbox, pool, poolDomains)`.
pub fn warmup_blocker(mailbox: &Value, pool: Option<&PoolView>, pool_domains: Option<i64>) -> Option<&'static str> {
    if text(mailbox, "status") != Some("warming") {
        return None;
    }
    let (ramp_day, rate, login_error) = match pool {
        Some(pool) => (
            pool.ramp_day,
            pool.stats.as_ref().and_then(|s| s.get("inboxRate3d")).and_then(Value::as_f64),
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
pub fn to_dto(row: &Value, domain_name: &str, sent_today: i64, sent7d: i64, rescues7d: i64, blocker: Option<&str>) -> Value {
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

async fn sent_today_by_mailbox(db: &PgPool, ids: &[String], now: OffsetDateTime) -> ReachResult<Vec<(String, i64)>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_as(
        "select mailbox_id, count(*) from reach_messages
         where mailbox_id = any($1) and direction = 'out' and status = 'sent' and sent_at >= $2::timestamptz
         group by mailbox_id",
    )
    .bind(ids)
    .bind(iso(utc_day_start(now)))
    .fetch_all(db)
    .await?)
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
pub async fn list(db: &PgPool, source: &WarmupSource<'_>, domain_id: Option<&str>, status: Option<&str>) -> ReachResult<Vec<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(m) || jsonb_build_object('domain_name', d.name) from reach_mailboxes m
         left join reach_domains d on m.domain_id = d.id
         where (case when $1::text = 'deleted' then m.status = 'deleted'
                     else m.status <> 'deleted' and m.deleted_at is null and ($1::text is null or m.status = $1) end)
           and ($2::text is null or m.domain_id = $2)
         order by m.created_at",
    )
    .bind(status)
    .bind(domain_id)
    .fetch_all(db)
    .await?;
    let rows: Vec<Value> = crate::js_rows(rows).iter().map(without_credentials).collect();
    let ids: Vec<String> = rows.iter().filter_map(|r| text(r, "id").map(str::to_owned)).collect();
    let sent = sent_today_by_mailbox(db, &ids, crate::now()).await?;
    let views = warmup_views(source, &rows).await;
    Ok(rows.iter().map(|row| dto_of(row, &sent, &views)).collect())
}

/// `getMailboxDto(deps, id)`: `None` for a deleted or unknown mailbox.
pub async fn get(db: &PgPool, source: &WarmupSource<'_>, id: &str) -> ReachResult<Option<Value>> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) || jsonb_build_object('domain_name', d.name) from reach_mailboxes m
         left join reach_domains d on m.domain_id = d.id
         where m.id = $1 and m.status <> 'deleted' limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row.map(|r| without_credentials(&weldsuite_db::js_row(r))) else {
        return Ok(None);
    };
    let sent = sent_today_by_mailbox(db, &[id.to_owned()], crate::now()).await?;
    let views = warmup_views(source, std::slice::from_ref(&row)).await;
    Ok(Some(dto_of(&row, &sent, &views)))
}
