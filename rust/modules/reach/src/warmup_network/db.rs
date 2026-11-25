//! `lib/db.ts`, `lib/sql.ts`, `lib/claim.ts` and `lib/flag.ts`: the master
//! rows every job reads (the pool and its messages), the claim a queue
//! consumer takes on a dispatched message, and the `weldreach-warmup` kill
//! switch. Master database only: the engine never opens a tenant database.
//! Times are epoch milliseconds, written as the instant they name ([`at`]).

use std::sync::Arc;

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, FromQueryResult, QueryFilter, QuerySelect, Select};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_ports::{DynFlagSource, FlagContext, FlagSourceExt};
use weldsuite_reach_domain::credentials::{MailServerCredentials, open, warmup_keyring};
use weldsuite_reach_domain::{epoch_ms, from_epoch_ms, iso, js_len, js_slice};
use weldsuite_schema::master::{reach_warmup_mailboxes, reach_warmup_messages};

use super::corpus::CorpusPerson;

/// The statuses of a mailbox taking part in the network.
const ELIGIBLE_STATUSES: [&str; 3] = ["waiting", "warming", "maintaining"];

/// `isEligible(status)`.
pub fn is_eligible(status: &str) -> bool {
    ELIGIBLE_STATUSES.contains(&status)
}

/// Whether any pool mailbox takes part in the network ([`is_eligible`]):
/// without one, nothing is planned and the corpus isn't needed.
pub async fn has_eligible_mailboxes(master: &PgPool) -> Result<bool, DbErr> {
    use reach_warmup_mailboxes::Column;
    let any: Option<String> = reach_warmup_mailboxes::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::Status.is_in(ELIGIBLE_STATUSES))
        .limit(1)
        .into_tuple()
        .one(&orm(master))
        .await?;
    Ok(any.is_some())
}

/// `CLAIM_TTL_MS`: a claim is held this long before the dispatcher hands the
/// row out again.
pub const CLAIM_TTL_MS: i64 = 10 * 60_000;

/// `KILL_SWITCH_FLAG`.
pub const KILL_SWITCH_FLAG: &str = "weldreach-warmup";

/// A timestamp as text (`timestamptz(at)`'s ISO string).
pub fn ts(ms: i64) -> String {
    iso(from_epoch_ms(ms))
}

/// A timestamp parameter (`timestamptz(at)`): the instant `ms` names.
pub fn at(ms: i64) -> OffsetDateTime {
    from_epoch_ms(ms)
}

/// The columns of [`PoolMailbox`], as they are stored.
#[derive(Debug, FromQueryResult)]
struct PoolRow {
    id: String,
    workspace_id: String,
    clerk_org_id: String,
    email: String,
    domain: String,
    mailbox_type: String,
    first_name: String,
    last_name: String,
    timezone: String,
    status: String,
    started_at: Option<OffsetDateTime>,
    ramp_day: i32,
    daily_target: i32,
    planned_for: Option<String>,
    smtp_credentials: String,
    imap_credentials: String,
    paused_reason: Option<String>,
    last_login_error: Option<String>,
}

impl From<PoolRow> for PoolMailbox {
    fn from(row: PoolRow) -> Self {
        Self {
            id: row.id,
            workspace_id: row.workspace_id,
            clerk_org_id: row.clerk_org_id,
            email: row.email,
            domain: row.domain,
            mailbox_type: row.mailbox_type,
            first_name: row.first_name,
            last_name: row.last_name,
            timezone: row.timezone,
            status: row.status,
            started_at: row.started_at.map(epoch_ms),
            ramp_day: row.ramp_day,
            daily_target: row.daily_target,
            planned_for: row.planned_for,
            smtp_credentials: row.smtp_credentials,
            imap_credentials: row.imap_credentials,
            paused_reason: row.paused_reason,
            last_login_error: row.last_login_error,
        }
    }
}

/// The select list of [`PoolMailbox`]: add the conditions, then read it with
/// [`pool_mailboxes`].
pub(crate) fn pool_query() -> Select<reach_warmup_mailboxes::Entity> {
    use reach_warmup_mailboxes::Column;
    reach_warmup_mailboxes::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::WorkspaceId,
            Column::ClerkOrgId,
            Column::Email,
            Column::Domain,
            Column::MailboxType,
            Column::FirstName,
            Column::LastName,
            Column::Timezone,
            Column::Status,
            Column::StartedAt,
            Column::RampDay,
            Column::DailyTarget,
            Column::PlannedFor,
            Column::SmtpCredentials,
            Column::ImapCredentials,
            Column::PausedReason,
            Column::LastLoginError,
        ])
}

/// The pool mailboxes `query` ([`pool_query`]) finds.
pub(crate) async fn pool_mailboxes(
    master: &PgPool,
    query: Select<reach_warmup_mailboxes::Entity>,
) -> Result<Vec<PoolMailbox>, DbErr> {
    let rows = query.into_model::<PoolRow>().all(&orm(master)).await?;
    Ok(rows.into_iter().map(PoolMailbox::from).collect())
}

/// `clip(text, max)`: at most `max` characters (UTF-16 units), for error
/// text stored on a row.
pub fn clip(text: &str, max: usize) -> String {
    if js_len(text) > max {
        format!("{}…", js_slice(text, max - 1))
    } else {
        text.to_owned()
    }
}

/// `clip(text)` with its default of 500.
pub fn clip_error(text: &str) -> String {
    clip(text, 500)
}

/// A `reach_warmup_mailboxes` row, the columns the jobs use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolMailbox {
    pub id: String,
    pub workspace_id: String,
    pub clerk_org_id: String,
    pub email: String,
    pub domain: String,
    pub mailbox_type: String,
    pub first_name: String,
    pub last_name: String,
    pub timezone: String,
    pub status: String,
    pub started_at: Option<i64>,
    pub ramp_day: i32,
    pub daily_target: i32,
    pub planned_for: Option<String>,
    pub smtp_credentials: String,
    pub imap_credentials: String,
    pub paused_reason: Option<String>,
    pub last_login_error: Option<String>,
}

impl PoolMailbox {
    /// `personOf(mailbox)`.
    pub fn person(&self) -> CorpusPerson {
        CorpusPerson {
            first_name: self.first_name.clone(),
            last_name: self.last_name.clone(),
        }
    }

    /// `displayName(mailbox)`.
    pub fn display_name(&self) -> String {
        format!("{} {}", self.first_name, self.last_name)
            .trim()
            .to_owned()
    }

    /// `unpausedStatus(mailbox)`.
    pub fn unpaused_status(&self) -> &'static str {
        weldsuite_reach_domain::warmup_pool::unpaused_status(
            self.started_at.map(|_| ""),
            i64::from(self.ramp_day),
        )
    }
}

/// These mailboxes, by id.
pub async fn load_mailboxes(master: &PgPool, ids: &[String]) -> Result<Vec<PoolMailbox>, DbErr> {
    pool_mailboxes(
        master,
        pool_query().filter(reach_warmup_mailboxes::Column::Id.is_in(ids)),
    )
    .await
}

/// A `reach_warmup_messages` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarmupMessage {
    pub id: String,
    pub thread_id: String,
    pub step: i32,
    pub from_mailbox_id: String,
    pub to_mailbox_id: String,
    pub corpus_thread_id: String,
    pub message_id_header: String,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub subject: String,
    pub status: String,
    /// `claimed_at` exactly as stored (the claim is a compare-and-set on it).
    pub claimed_at: Option<OffsetDateTime>,
    pub sent_at: Option<i64>,
    pub engage_attempts: i32,
    pub created_at: i64,
}

/// The columns of [`WarmupMessage`], as they are stored.
#[derive(Debug, FromQueryResult)]
struct MessageRow {
    id: String,
    thread_id: String,
    step: i32,
    from_mailbox_id: String,
    to_mailbox_id: String,
    corpus_thread_id: String,
    message_id_header: String,
    in_reply_to: Option<String>,
    references: Option<String>,
    subject: String,
    status: String,
    claimed_at: Option<OffsetDateTime>,
    sent_at: Option<OffsetDateTime>,
    engage_attempts: i32,
    created_at: OffsetDateTime,
}

/// One message by id.
pub async fn load_message(master: &PgPool, id: &str) -> Result<Option<WarmupMessage>, DbErr> {
    use reach_warmup_messages::Column;
    let row = reach_warmup_messages::Entity::find_by_id(id.to_owned())
        .select_only()
        .columns([
            Column::Id,
            Column::ThreadId,
            Column::Step,
            Column::FromMailboxId,
            Column::ToMailboxId,
            Column::CorpusThreadId,
            Column::MessageIdHeader,
            Column::InReplyTo,
            Column::References,
            Column::Subject,
            Column::Status,
            Column::ClaimedAt,
            Column::SentAt,
            Column::EngageAttempts,
            Column::CreatedAt,
        ])
        .into_model::<MessageRow>()
        .one(&orm(master))
        .await?;
    Ok(row.map(|row| WarmupMessage {
        id: row.id,
        thread_id: row.thread_id,
        step: row.step,
        from_mailbox_id: row.from_mailbox_id,
        to_mailbox_id: row.to_mailbox_id,
        corpus_thread_id: row.corpus_thread_id,
        message_id_header: row.message_id_header,
        in_reply_to: row.in_reply_to,
        references: row.references,
        subject: row.subject,
        status: row.status,
        claimed_at: row.claimed_at,
        sent_at: row.sent_at.map(epoch_ms),
        engage_attempts: row.engage_attempts,
        created_at: epoch_ms(row.created_at),
    }))
}

/// `takeClaim(master, row, status, now)`: a message the dispatcher handed
/// out twice reaches two consumers; the compare-and-set on `claimed_at`
/// lets only one of them through. A queue retry of the same consumer sees
/// the value it wrote itself.
pub async fn take_claim(
    master: &PgPool,
    row: &WarmupMessage,
    status: &str,
    now: i64,
) -> Result<bool, DbErr> {
    use reach_warmup_messages::Column;
    let held = match row.claimed_at {
        None => Column::ClaimedAt.is_null(),
        Some(claimed_at) => Column::ClaimedAt.eq(claimed_at),
    };
    let taken = reach_warmup_messages::Entity::update_many()
        .col_expr(Column::ClaimedAt, Expr::value(at(now)))
        .filter(Column::Id.eq(&row.id))
        .filter(Column::Status.eq(status))
        .filter(held)
        .exec(&orm(master))
        .await?;
    Ok(taken.rows_affected > 0)
}

/// Hand claims back, leaving the messages for the dispatcher.
pub async fn release_claims(master: &PgPool, ids: &[String]) -> Result<(), DbErr> {
    if ids.is_empty() {
        return Ok(());
    }
    reach_warmup_messages::Entity::update_many()
        .col_expr(reach_warmup_messages::Column::ClaimedAt, Expr::null())
        .filter(reach_warmup_messages::Column::Id.is_in(ids))
        .exec(&orm(master))
        .await?;
    Ok(())
}

/// `openWarmupCredentials(env, blob)`: `None` without the key or when the
/// blob does not open.
pub fn open_login(warmup_key: Option<&str>, blob: &str) -> Option<MailServerCredentials> {
    open(&warmup_keyring(warmup_key?), Some(blob))
}

/// `isWarmupEnabled(env)`: the `weldreach-warmup` kill switch, evaluated
/// outside a request (on unless switched off).
pub async fn is_warmup_enabled(flags: &Arc<dyn DynFlagSource>) -> bool {
    let context = FlagContext {
        workspace_id: String::new(),
        clerk_org_id: None,
        user_id: "system".to_owned(),
    };
    let enabled = flags
        .is_on(weldsuite_catalogs::flags::WELDREACH_WARMUP, &context)
        .await;
    if !enabled {
        tracing::info!("[reach-warmup] kill switch {KILL_SWITCH_FLAG} is off: doing nothing");
    }
    enabled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_clipped_in_utf16_units() {
        assert_eq!(clip("abc", 5), "abc");
        assert_eq!(clip("abcdef", 5), "abcd…");
        assert_eq!(clip_error(&"x".repeat(600)).chars().count(), 500);
    }
}
