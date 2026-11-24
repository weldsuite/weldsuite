//! `warmup-pool.ts`: the master `reach_warmup_mailboxes` rows reach-api
//! writes when a mailbox is created, renamed, paused, resumed or deleted, and
//! reads back for the health gate and the UI. Logins are sealed with
//! `WELDREACH_WARMUP_KEY`.

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect, Set};
use serde_json::Value;
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_schema::master::{reach_warmup_mailboxes as pool, reach_warmup_messages};

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
    Database(DbErr),
}

impl From<DbErr> for PoolError {
    fn from(error: DbErr) -> Self {
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
    let at = now();
    let master = orm(master);
    let existing: Option<(String, String, Option<OffsetDateTime>, i32)> = pool::Entity::find()
        .select_only()
        .column(pool::Column::Id)
        .column(pool::Column::Status)
        .column(pool::Column::StartedAt)
        .column(pool::Column::RampDay)
        .filter(pool::Column::ClerkOrgId.eq(input.clerk_org_id.as_str()))
        .filter(pool::Column::TenantMailboxId.eq(input.tenant_mailbox_id.as_str()))
        .into_tuple()
        .one(&master)
        .await?;
    let row = pool::ActiveModel {
        workspace_id: Set(input.workspace_id.clone()),
        clerk_org_id: Set(input.clerk_org_id.clone()),
        tenant_mailbox_id: Set(input.tenant_mailbox_id.clone()),
        email: Set(email),
        domain: Set(domain),
        mailbox_type: Set(input.mailbox_type.clone()),
        first_name: Set(input.first_name.clone()),
        last_name: Set(input.last_name.clone()),
        timezone: Set(timezone),
        smtp_credentials: Set(smtp),
        imap_credentials: Set(imap),
        updated_at: Set(at),
        ..Default::default()
    };
    if let Some((id, status, started_at, ramp_day)) = existing {
        let status = if status == "removed" {
            unpaused_status(started_at.map(iso).as_deref(), i64::from(ramp_day)).to_owned()
        } else {
            status
        };
        pool::Entity::update_many()
            .set(pool::ActiveModel {
                status: Set(status),
                last_login_error: Set(None),
                last_login_error_at: Set(None),
                ..row
            })
            .filter(pool::Column::Id.eq(id.as_str()))
            .exec(&master)
            .await?;
        return Ok(id);
    }
    let id = generate_id("rwmb");
    pool::Entity::insert(pool::ActiveModel {
        id: Set(id.clone()),
        status: Set("waiting".to_owned()),
        created_at: Set(at),
        ..row
    })
    .exec_without_returning(&master)
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
    let mut update =
        pool::Entity::update_many().col_expr(pool::Column::UpdatedAt, Expr::value(now()));
    if let Some(first_name) = first_name {
        update = update.col_expr(pool::Column::FirstName, Expr::value(first_name));
    }
    if let Some(last_name) = last_name {
        update = update.col_expr(pool::Column::LastName, Expr::value(last_name));
    }
    update
        .filter(pool::Column::ClerkOrgId.eq(clerk_org_id))
        .filter(pool::Column::TenantMailboxId.eq(tenant_mailbox_id))
        .exec(&orm(master))
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
    pool::Entity::update_many()
        .col_expr(pool::Column::Status, Expr::value("paused"))
        .col_expr(
            pool::Column::PausedReason,
            Expr::value(js_slice(reason, 100)),
        )
        .col_expr(pool::Column::UpdatedAt, Expr::value(now()))
        .filter(pool::Column::ClerkOrgId.eq(clerk_org_id))
        .filter(pool::Column::TenantMailboxId.eq(tenant_mailbox_id))
        .filter(pool::Column::Status.ne("removed"))
        .exec(&orm(master))
        .await?;
    Ok(())
}

/// `resumePoolMailbox(master, clerkOrgId, tenantMailboxId)`: a staff pause stays.
pub async fn resume(
    master: &PgPool,
    clerk_org_id: &str,
    tenant_mailbox_id: &str,
) -> ReachResult<()> {
    let master = orm(master);
    let row: Option<(String, String, Option<OffsetDateTime>, i32, Option<String>)> =
        pool::Entity::find()
            .select_only()
            .column(pool::Column::Id)
            .column(pool::Column::Status)
            .column(pool::Column::StartedAt)
            .column(pool::Column::RampDay)
            .column(pool::Column::PausedReason)
            .filter(pool::Column::ClerkOrgId.eq(clerk_org_id))
            .filter(pool::Column::TenantMailboxId.eq(tenant_mailbox_id))
            .into_tuple()
            .one(&master)
            .await?;
    let Some((id, status, started_at, ramp_day, paused_reason)) = row else {
        return Ok(());
    };
    if status != "paused" || paused_reason.as_deref() == Some(STAFF_PAUSE_REASON) {
        return Ok(());
    }
    let status = unpaused_status(started_at.map(iso).as_deref(), i64::from(ramp_day));
    pool::Entity::update_many()
        .col_expr(pool::Column::Status, Expr::value(status))
        .col_expr(pool::Column::PausedReason, Expr::value(None::<String>))
        .col_expr(pool::Column::UpdatedAt, Expr::value(now()))
        .filter(pool::Column::Id.eq(id))
        .exec(&master)
        .await?;
    Ok(())
}

/// `removePoolMailbox(master, clerkOrgId, tenantMailboxId)`.
pub async fn remove(
    master: &PgPool,
    clerk_org_id: &str,
    tenant_mailbox_id: &str,
) -> ReachResult<()> {
    let master = orm(master);
    let id: Option<String> = pool::Entity::find()
        .select_only()
        .column(pool::Column::Id)
        .filter(pool::Column::ClerkOrgId.eq(clerk_org_id))
        .filter(pool::Column::TenantMailboxId.eq(tenant_mailbox_id))
        .into_tuple()
        .one(&master)
        .await?;
    let Some(id) = id else {
        return Ok(());
    };
    pool::Entity::update_many()
        .col_expr(pool::Column::Status, Expr::value("removed"))
        .col_expr(pool::Column::SmtpCredentials, Expr::value(""))
        .col_expr(pool::Column::ImapCredentials, Expr::value(""))
        .col_expr(pool::Column::UpdatedAt, Expr::value(now()))
        .filter(pool::Column::Id.eq(id.as_str()))
        .exec(&master)
        .await?;
    reach_warmup_messages::Entity::update_many()
        .col_expr(reach_warmup_messages::Column::Status, Expr::value("failed"))
        .col_expr(
            reach_warmup_messages::Column::Error,
            Expr::value("mailbox_removed"),
        )
        .filter(reach_warmup_messages::Column::Status.eq("scheduled"))
        .filter(
            sea_orm::Condition::any()
                .add(reach_warmup_messages::Column::FromMailboxId.eq(id.as_str()))
                .add(reach_warmup_messages::Column::ToMailboxId.eq(id.as_str())),
        )
        .exec(&master)
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
    pub paused_reason: Option<String>,
    pub last_login_error: Option<String>,
}

/// `readPoolMailboxes(master, clerkOrgId)`.
pub async fn read_pool(master: &PgPool, clerk_org_id: &str) -> Result<Vec<PoolView>, DbErr> {
    let rows: Vec<(
        String,
        String,
        i32,
        Option<Value>,
        Option<String>,
        Option<String>,
    )> = pool::Entity::find()
        .select_only()
        .column(pool::Column::TenantMailboxId)
        .column(pool::Column::Status)
        .column(pool::Column::RampDay)
        .column(pool::Column::Stats)
        .column(pool::Column::PausedReason)
        .column(pool::Column::LastLoginError)
        .filter(pool::Column::ClerkOrgId.eq(clerk_org_id))
        .filter(pool::Column::Status.ne("removed"))
        .into_tuple()
        .all(&orm(master))
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(tenant_mailbox_id, status, ramp_day, stats, paused_reason, last_login_error)| {
                PoolView {
                    tenant_mailbox_id,
                    status,
                    ramp_day: i64::from(ramp_day),
                    stats,
                    paused_reason,
                    last_login_error,
                }
            },
        )
        .collect())
}

/// `activePoolDomainCount(master)`.
pub async fn active_domain_count(master: &PgPool) -> Result<i64, DbErr> {
    let count: Option<i64> = pool::Entity::find()
        .select_only()
        .expr(Func::count_distinct(Expr::col(pool::Column::Domain)))
        .filter(pool::Column::Status.is_in(["waiting", "warming", "maintaining"]))
        .into_tuple()
        .one(&orm(master))
        .await?;
    count.ok_or_else(|| DbErr::RecordNotFound("count".to_owned()))
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
    Ok(reach_warmup_messages::Entity::find()
        .select_only()
        .column(reach_warmup_messages::Column::MessageIdHeader)
        .filter(reach_warmup_messages::Column::MessageIdHeader.is_in(ids))
        .into_tuple()
        .all(&orm(master))
        .await?)
}
