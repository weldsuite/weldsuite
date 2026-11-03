//! `lib/db.ts`, `lib/sql.ts`, `lib/claim.ts` and `lib/flag.ts`: the master
//! rows every job reads (the pool and its messages), the claim a queue
//! consumer takes on a dispatched message, and the `weldreach-warmup` kill
//! switch. Master database only: the engine never opens a tenant database.
//! Times are epoch milliseconds, written as ISO text cast to `timestamptz`.

use std::sync::Arc;

use sqlx::PgPool;
use weldsuite_ports::{DynFlagSource, FlagContext, FlagSourceExt};
use weldsuite_reach_domain::credentials::{MailServerCredentials, open, warmup_keyring};
use weldsuite_reach_domain::{from_epoch_ms, iso, js_len, js_slice};

use super::corpus::CorpusPerson;

/// `isEligible(status)`.
pub fn is_eligible(status: &str) -> bool {
    matches!(status, "waiting" | "warming" | "maintaining")
}

/// `CLAIM_TTL_MS`: a claim is held this long before the dispatcher hands the
/// row out again.
pub const CLAIM_TTL_MS: i64 = 10 * 60_000;

/// `KILL_SWITCH_FLAG`.
pub const KILL_SWITCH_FLAG: &str = "weldreach-warmup";

/// A timestamp parameter (`timestamptz(at)`).
pub fn ts(ms: i64) -> String {
    iso(from_epoch_ms(ms))
}

/// The select list of [`PoolMailbox`] (`started_at` as epoch milliseconds).
macro_rules! pool_columns {
    () => {
        "id, workspace_id, clerk_org_id, email, domain, mailbox_type, first_name, last_name, timezone, \
         status, floor(extract(epoch from started_at) * 1000)::int8 as started_at, ramp_day, daily_target, \
         planned_for, smtp_credentials, imap_credentials, paused_reason, last_login_error"
    };
}
pub(crate) use pool_columns;

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
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
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
pub async fn load_mailboxes(master: &PgPool, ids: &[String]) -> sqlx::Result<Vec<PoolMailbox>> {
    sqlx::query_as(concat!(
        "select ",
        pool_columns!(),
        " from reach_warmup_mailboxes where id = any($1)"
    ))
    .bind(ids)
    .fetch_all(master)
    .await
}

/// A `reach_warmup_messages` row.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
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
    pub claimed_at: Option<String>,
    pub sent_at: Option<i64>,
    pub engage_attempts: i32,
    pub created_at: i64,
}

/// One message by id.
pub async fn load_message(master: &PgPool, id: &str) -> sqlx::Result<Option<WarmupMessage>> {
    sqlx::query_as(
        "select id, thread_id, step, from_mailbox_id, to_mailbox_id, corpus_thread_id, \
         message_id_header, in_reply_to, \"references\", subject, status, claimed_at::text as claimed_at, \
         floor(extract(epoch from sent_at) * 1000)::int8 as sent_at, engage_attempts, \
         floor(extract(epoch from created_at) * 1000)::int8 as created_at
         from reach_warmup_messages where id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(master)
    .await
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
) -> sqlx::Result<bool> {
    let taken = sqlx::query(
        "update reach_warmup_messages set claimed_at = $1::timestamptz
         where id = $2 and status = $3
           and (($4::text is null and claimed_at is null) or claimed_at = $4::timestamptz)",
    )
    .bind(ts(now))
    .bind(&row.id)
    .bind(status)
    .bind(row.claimed_at.as_deref())
    .execute(master)
    .await?;
    Ok(taken.rows_affected() > 0)
}

/// Hand claims back, leaving the messages for the dispatcher.
pub async fn release_claims(master: &PgPool, ids: &[String]) -> sqlx::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    sqlx::query("update reach_warmup_messages set claimed_at = null where id = any($1)")
        .bind(ids)
        .execute(master)
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
