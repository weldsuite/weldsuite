//! `lib/pool-state.ts`: the pool mailbox states the engine writes, and how
//! the warmup sweep hears about them.
//!
//! The routes read `status`, `paused_reason` and `last_login_error` from the
//! pool row to show a mailbox's warmup and to keep the tenant mailbox in
//! `error` while a login problem stands. So every time the engine sets or
//! clears one of its own states it also marks the workspace due in the
//! master due index (kind `reach_warmup`, keyed by `workspaces.id`), and the
//! `reach-warmup-sweep` cron reacts the same day.
//!
//! The engine only ever sets and clears its own states:
//!
//! - `error` + `login_failed`: a login was rejected
//! - `paused` + `credentials_unavailable`: the sealed login cannot be opened
//! - `paused` + `low_inbox_rate`: placement dropped (daily)
//!
//! A mailbox paused for any other reason (the customer, staff, a suspended
//! mailbox or domain) is never changed by it.

use sqlx::PgPool;
use weldsuite_db::due_index;
use weldsuite_reach_domain::from_epoch_ms;

use super::db::{PoolMailbox, clip, ts};
use crate::warmup::WARMUP_DUE_KIND;

pub const LOGIN_FAILED_REASON: &str = "login_failed";
pub const LOW_INBOX_RATE_REASON: &str = "low_inbox_rate";
pub const CREDENTIALS_UNAVAILABLE_REASON: &str = "credentials_unavailable";

/// `markReachDue(env, workspace, now)`: tell the warmup sweep to look at
/// this workspace now. Best effort.
pub async fn mark_reach_due(master: &PgPool, workspace_id: &str, now: i64) {
    due_index::mark_due(master, WARMUP_DUE_KIND, workspace_id, from_epoch_ms(now)).await;
}

/// `recordLoginFailure(...)`: an active mailbox goes to `error`
/// (`login_failed`) and stays out of the network until a login works
/// again; a mailbox already parked for another reason keeps its status and
/// only records the error.
pub async fn record_login_failure(
    master: &PgPool,
    mailbox: &PoolMailbox,
    source: &str,
    detail: &str,
    now: i64,
) -> sqlx::Result<()> {
    let last_login_error = clip(&format!("{source}: {detail}"), 300);
    let stopped = sqlx::query(
        "update reach_warmup_mailboxes set status = 'error', paused_reason = $2, last_login_error = $3,
           last_login_error_at = $4::timestamptz, updated_at = $4::timestamptz
         where id = $1 and status in ('waiting', 'warming', 'maintaining')",
    )
    .bind(&mailbox.id)
    .bind(LOGIN_FAILED_REASON)
    .bind(&last_login_error)
    .bind(ts(now))
    .execute(master)
    .await?;
    if stopped.rows_affected() == 0 {
        sqlx::query(
            "update reach_warmup_mailboxes set last_login_error = $2, last_login_error_at = $3::timestamptz,
               updated_at = $3::timestamptz where id = $1",
        )
        .bind(&mailbox.id)
        .bind(&last_login_error)
        .bind(ts(now))
        .execute(master)
        .await?;
    }
    mark_reach_due(master, &mailbox.workspace_id, now).await;
    Ok(())
}

/// `pauseForCredentials(...)`: the sealed login cannot be opened; park the
/// mailbox until someone registers it again.
pub async fn pause_for_credentials(
    master: &PgPool,
    mailbox: &PoolMailbox,
    now: i64,
) -> sqlx::Result<()> {
    let paused = sqlx::query(
        "update reach_warmup_mailboxes set status = 'paused', paused_reason = $2, last_login_error = $2,
           last_login_error_at = $3::timestamptz, updated_at = $3::timestamptz
         where id = $1 and status in ('waiting', 'warming', 'maintaining')",
    )
    .bind(&mailbox.id)
    .bind(CREDENTIALS_UNAVAILABLE_REASON)
    .bind(ts(now))
    .execute(master)
    .await?;
    if paused.rows_affected() > 0 {
        mark_reach_due(master, &mailbox.workspace_id, now).await;
    }
    Ok(())
}

/// `isLoginFailedState(mailbox)`: the state a successful login lifts.
pub fn is_login_failed_state(mailbox: &PoolMailbox) -> bool {
    mailbox.status == "error" && mailbox.paused_reason.as_deref() == Some(LOGIN_FAILED_REASON)
}

/// `recordLoginSuccess(...)`: any stored login error is cleared; a mailbox
/// in `error` (`login_failed`) goes back to where its warmup had got to.
/// Costs nothing for a mailbox without an error (the common case).
pub async fn record_login_success(
    master: &PgPool,
    mailbox: &PoolMailbox,
    now: i64,
) -> sqlx::Result<()> {
    let restore = is_login_failed_state(mailbox);
    if mailbox
        .last_login_error
        .as_deref()
        .is_none_or(str::is_empty)
        && !restore
    {
        return Ok(());
    }
    sqlx::query(
        "update reach_warmup_mailboxes set last_login_error = null, last_login_error_at = null,
           updated_at = $2::timestamptz where id = $1",
    )
    .bind(&mailbox.id)
    .bind(ts(now))
    .execute(master)
    .await?;
    if restore {
        sqlx::query(
            "update reach_warmup_mailboxes set status = $2, paused_reason = null, updated_at = $3::timestamptz
             where id = $1 and status = 'error' and paused_reason = $4",
        )
        .bind(&mailbox.id)
        .bind(mailbox.unpaused_status())
        .bind(ts(now))
        .bind(LOGIN_FAILED_REASON)
        .execute(master)
        .await?;
    }
    mark_reach_due(master, &mailbox.workspace_id, now).await;
    Ok(())
}
