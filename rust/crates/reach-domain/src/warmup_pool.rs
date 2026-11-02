//! `warmup-pool.ts`: the master `reach_warmup_mailboxes` rows reach-api
//! writes when a mailbox is created, renamed, paused, resumed or deleted, and
//! reads back for the health gate and the UI. Logins are sealed with
//! `WELDREACH_WARMUP_KEY`.

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::credentials::{MailServerCredentials, seal, warmup_keyring};
use crate::warmup::{WARMUP_MIN_DAYS, domain_of};
use crate::{ReachResult, iso, js_slice, now};

/// `STAFF_PAUSE_REASON`.
pub const STAFF_PAUSE_REASON: &str = "paused_by_staff";

/// `unpausedStatus(row)`.
pub fn unpaused_status(started_at: Option<&str>, ramp_day: i64) -> &'static str {
    if started_at.is_none() {
        return "waiting";
    }
    if ramp_day >= WARMUP_MIN_DAYS {
        "maintaining"
    } else {
        "warming"
    }
}

/// `RegisterPoolMailboxInput`.
#[derive(Debug, Clone)]
pub struct RegisterInput {
    pub workspace_id: String,
    pub clerk_org_id: String,
    pub tenant_mailbox_id: String,
    pub email: String,
    pub first_name: String,
    pub last_name: String,
    pub mailbox_type: String,
    pub timezone: Option<String>,
    pub smtp: MailServerCredentials,
    pub imap: MailServerCredentials,
}

/// Why the pool could not take a mailbox.
#[derive(Debug)]
pub enum PoolError {
    /// `WarmupKeyMissingError`.
    KeyMissing,
    Sealing(String),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for PoolError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl std::fmt::Display for PoolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::KeyMissing => f.write_str("WELDREACH_WARMUP_KEY is not configured"),
            Self::Sealing(error) => write!(f, "sealing failed: {error}"),
            Self::Database(error) => write!(f, "{error}"),
        }
    }
}

/// `registerPoolMailbox(master, env, input)`: the pool row id.
pub async fn register(
    master: &PgPool,
    warmup_key: Option<&str>,
    input: &RegisterInput,
) -> Result<String, PoolError> {
    let key = warmup_key
        .filter(|k| !k.is_empty())
        .ok_or(PoolError::KeyMissing)?;
    let keyring = warmup_keyring(key);
    let smtp = seal(&keyring, &input.smtp).map_err(PoolError::Sealing)?;
    let imap = seal(&keyring, &input.imap).map_err(PoolError::Sealing)?;
    let email = crate::text::js_trim(&input.email).to_lowercase();
    let domain = domain_of(&email);
    let timezone = input
        .timezone
        .clone()
        .unwrap_or_else(|| "Europe/Amsterdam".to_owned());
    let at = iso(now());
    let existing: Option<(String, String, Option<String>, i32)> = sqlx::query_as(
        "select id, status, started_at::text, ramp_day from reach_warmup_mailboxes
         where clerk_org_id = $1 and tenant_mailbox_id = $2 limit 1",
    )
    .bind(&input.clerk_org_id)
    .bind(&input.tenant_mailbox_id)
    .fetch_optional(master)
    .await?;
    if let Some((id, status, started_at, ramp_day)) = existing {
        let status = if status == "removed" {
            unpaused_status(started_at.as_deref(), i64::from(ramp_day)).to_owned()
        } else {
            status
        };
        sqlx::query(
            "update reach_warmup_mailboxes set workspace_id = $2, clerk_org_id = $3, tenant_mailbox_id = $4, email = $5,
                 domain = $6, mailbox_type = $7, first_name = $8, last_name = $9, timezone = $10,
                 smtp_credentials = $11, imap_credentials = $12, updated_at = $13::timestamptz, status = $14,
                 last_login_error = null, last_login_error_at = null
             where id = $1",
        )
        .bind(&id)
        .bind(&input.workspace_id)
        .bind(&input.clerk_org_id)
        .bind(&input.tenant_mailbox_id)
        .bind(&email)
        .bind(&domain)
        .bind(&input.mailbox_type)
        .bind(&input.first_name)
        .bind(&input.last_name)
        .bind(&timezone)
        .bind(&smtp)
        .bind(&imap)
        .bind(&at)
        .bind(&status)
        .execute(master)
        .await?;
        return Ok(id);
    }
    let id = generate_id("rwmb");
    sqlx::query(
        "insert into reach_warmup_mailboxes (id, workspace_id, clerk_org_id, tenant_mailbox_id, email, domain,
             mailbox_type, first_name, last_name, timezone, smtp_credentials, imap_credentials, updated_at, status,
             created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, 'waiting', $13::timestamptz)",
    )
    .bind(&id)
    .bind(&input.workspace_id)
    .bind(&input.clerk_org_id)
    .bind(&input.tenant_mailbox_id)
    .bind(&email)
    .bind(&domain)
    .bind(&input.mailbox_type)
    .bind(&input.first_name)
    .bind(&input.last_name)
    .bind(&timezone)
    .bind(&smtp)
    .bind(&imap)
    .bind(&at)
    .execute(master)
    .await?;
    Ok(id)
}

/// `updatePoolMailboxProfile(master, clerkOrgId, tenantMailboxId, profile)`.
pub async fn update_profile(
    master: &PgPool,
    clerk_org_id: &str,
    tenant_mailbox_id: &str,
    first_name: Option<&str>,
    last_name: Option<&str>,
) -> ReachResult<()> {
    sqlx::query(
        "update reach_warmup_mailboxes set updated_at = $3::timestamptz,
             first_name = coalesce($4, first_name), last_name = coalesce($5, last_name)
         where clerk_org_id = $1 and tenant_mailbox_id = $2",
    )
    .bind(clerk_org_id)
    .bind(tenant_mailbox_id)
    .bind(iso(now()))
    .bind(first_name)
    .bind(last_name)
    .execute(master)
    .await?;
    Ok(())
}

/// `pausePoolMailbox(master, clerkOrgId, tenantMailboxId, reason)`.
pub async fn pause(
    master: &PgPool,
    clerk_org_id: &str,
    tenant_mailbox_id: &str,
    reason: &str,
) -> ReachResult<()> {
    sqlx::query(
        "update reach_warmup_mailboxes set status = 'paused', paused_reason = $3, updated_at = $4::timestamptz
         where clerk_org_id = $1 and tenant_mailbox_id = $2 and status <> 'removed'",
    )
    .bind(clerk_org_id)
    .bind(tenant_mailbox_id)
    .bind(js_slice(reason, 100))
    .bind(iso(now()))
    .execute(master)
    .await?;
    Ok(())
}

/// `resumePoolMailbox(master, clerkOrgId, tenantMailboxId)`: a staff pause stays.
pub async fn resume(
    master: &PgPool,
    clerk_org_id: &str,
    tenant_mailbox_id: &str,
) -> ReachResult<()> {
    let row: Option<(String, String, Option<String>, i32, Option<String>)> = sqlx::query_as(
        "select id, status, started_at::text, ramp_day, paused_reason from reach_warmup_mailboxes
         where clerk_org_id = $1 and tenant_mailbox_id = $2 limit 1",
    )
    .bind(clerk_org_id)
    .bind(tenant_mailbox_id)
    .fetch_optional(master)
    .await?;
    let Some((id, status, started_at, ramp_day, paused_reason)) = row else {
        return Ok(());
    };
    if status != "paused" || paused_reason.as_deref() == Some(STAFF_PAUSE_REASON) {
        return Ok(());
    }
    sqlx::query(
        "update reach_warmup_mailboxes set status = $2, paused_reason = null, updated_at = $3::timestamptz where id = $1",
    )
    .bind(&id)
    .bind(unpaused_status(started_at.as_deref(), i64::from(ramp_day)))
    .bind(iso(now()))
    .execute(master)
    .await?;
    Ok(())
}

/// `removePoolMailbox(master, clerkOrgId, tenantMailboxId)`.
pub async fn remove(
    master: &PgPool,
    clerk_org_id: &str,
    tenant_mailbox_id: &str,
) -> ReachResult<()> {
    let id: Option<String> = sqlx::query_scalar(
        "select id from reach_warmup_mailboxes where clerk_org_id = $1 and tenant_mailbox_id = $2 limit 1",
    )
    .bind(clerk_org_id)
    .bind(tenant_mailbox_id)
    .fetch_optional(master)
    .await?;
    let Some(id) = id else {
        return Ok(());
    };
    sqlx::query(
        "update reach_warmup_mailboxes set status = 'removed', smtp_credentials = '', imap_credentials = '',
             updated_at = $2::timestamptz where id = $1",
    )
    .bind(&id)
    .bind(iso(now()))
    .execute(master)
    .await?;
    sqlx::query(
        "update reach_warmup_messages set status = 'failed', error = 'mailbox_removed'
         where status = 'scheduled' and (from_mailbox_id = $1 or to_mailbox_id = $1)",
    )
    .bind(&id)
    .execute(master)
    .await?;
    Ok(())
}

/// A pool row without logins (`PoolMailboxView`).
#[derive(Debug, Clone)]
pub struct PoolView {
    pub tenant_mailbox_id: String,
    pub status: String,
    pub ramp_day: i64,
    pub stats: Option<Value>,
    pub last_login_error: Option<String>,
}

/// `readPoolMailboxes(master, clerkOrgId)`.
pub async fn read_pool(master: &PgPool, clerk_org_id: &str) -> Result<Vec<PoolView>, sqlx::Error> {
    let rows: Vec<(String, String, i32, Option<Value>, Option<String>)> = sqlx::query_as(
        "select tenant_mailbox_id, status, ramp_day, stats, last_login_error from reach_warmup_mailboxes
         where clerk_org_id = $1 and status <> 'removed'",
    )
    .bind(clerk_org_id)
    .fetch_all(master)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(tenant_mailbox_id, status, ramp_day, stats, last_login_error)| PoolView {
                tenant_mailbox_id,
                status,
                ramp_day: i64::from(ramp_day),
                stats,
                last_login_error,
            },
        )
        .collect())
}

/// `activePoolDomainCount(master)`.
pub async fn active_domain_count(master: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "select count(distinct domain) from reach_warmup_mailboxes where status in ('waiting', 'warming', 'maintaining')",
    )
    .fetch_one(master)
    .await
}

/// `findWarmupMessageIds(master, messageIds)`.
pub async fn find_warmup_message_ids(
    master: &PgPool,
    message_ids: &[String],
) -> ReachResult<Vec<String>> {
    let ids: Vec<String> = crate::unique(
        &message_ids
            .iter()
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>(),
    );
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_scalar(
        "select message_id_header from reach_warmup_messages where message_id_header = any($1)",
    )
    .bind(&ids)
    .fetch_all(master)
    .await?)
}
