//! `login-recheck.ts` (runs with the planner): lets a mailbox the engine
//! took out of the network come back once its login works again.
//!
//! A mailbox in `error` (`login_failed`) neither sends nor receives, so
//! nothing else ever logs in to it. Here a few of them per run get one IMAP
//! login:
//!
//! - after the routes registered new logins (they clear
//!   `last_login_error`), at once;
//! - after an earlier IMAP failure, again once the error is 6 hours old;
//! - a failure that came from SMTP only after the logins are registered
//!   again, because an IMAP login cannot tell whether SMTP works.
//!
//! Success restores the mailbox to where its warmup had got to; failure
//! records the error and backs off 6 hours. Only the engine's own
//! `login_failed` state is ever lifted.

use sqlx::PgPool;
use weldsuite_ports::ImapConfig;

use super::WarmupNetwork;
use super::clock::HOUR_MS;
use super::db::{PoolMailbox, clip, open_login, pool_columns, ts};
use super::pool_state::{CREDENTIALS_UNAVAILABLE_REASON, LOGIN_FAILED_REASON, mark_reach_due};

/// Mailboxes tried per run.
pub const RECHECK_LIMIT: i64 = 10;
/// A failed recheck is not repeated sooner than this.
pub const RECHECK_BACKOFF_MS: i64 = 6 * HOUR_MS;

/// `RecheckResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RecheckResult {
    pub checked: usize,
    pub healed: usize,
}

async fn load_candidates(master: &PgPool, now: i64) -> sqlx::Result<Vec<PoolMailbox>> {
    sqlx::query_as(concat!(
        "select ",
        pool_columns!(),
        " from reach_warmup_mailboxes
         where status = 'error' and paused_reason = $1
           and (last_login_error is null or (last_login_error like 'imap:%' and last_login_error_at < $2::timestamptz))
         limit $3"
    ))
    .bind(LOGIN_FAILED_REASON)
    .bind(ts(now - RECHECK_BACKOFF_MS))
    .bind(RECHECK_LIMIT)
    .fetch_all(master)
    .await
}

/// `stillBroken(...)`: note why and start the back-off. The sweep is only
/// told when the error text appears for the first time.
async fn still_broken(
    master: &PgPool,
    mailbox: &PoolMailbox,
    detail: &str,
    now: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "update reach_warmup_mailboxes set last_login_error = $2, last_login_error_at = $3::timestamptz
         where id = $1",
    )
    .bind(&mailbox.id)
    .bind(clip(&format!("imap: {detail}"), 300))
    .bind(ts(now))
    .execute(master)
    .await?;
    if mailbox.last_login_error.is_none() {
        mark_reach_due(master, &mailbox.workspace_id, now).await;
    }
    Ok(())
}

async fn bring_back(master: &PgPool, mailbox: &PoolMailbox, now: i64) -> sqlx::Result<()> {
    sqlx::query(
        "update reach_warmup_mailboxes set status = $2, paused_reason = null, last_login_error = null,
           last_login_error_at = null, updated_at = $3::timestamptz
         where id = $1 and status = 'error' and paused_reason = $4",
    )
    .bind(&mailbox.id)
    .bind(mailbox.unpaused_status())
    .bind(ts(now))
    .bind(LOGIN_FAILED_REASON)
    .execute(master)
    .await?;
    mark_reach_due(master, &mailbox.workspace_id, now).await;
    Ok(())
}

/// `tryLogin(...)`: one login; `true` when it worked.
async fn try_login(net: &WarmupNetwork, mailbox: &PoolMailbox, now: i64) -> sqlx::Result<bool> {
    let Some(login) = open_login(net.warmup_key.as_deref(), &mailbox.imap_credentials) else {
        still_broken(&net.master, mailbox, CREDENTIALS_UNAVAILABLE_REASON, now).await?;
        return Ok(false);
    };
    let config = ImapConfig::new(&login.host, login.port, &login.username, &login.password);
    match net.imap.connect(&config).await {
        Ok(session) => {
            session.logout().await;
            Ok(true)
        }
        Err(error) => {
            still_broken(&net.master, mailbox, error.detail(), now).await?;
            Ok(false)
        }
    }
}

/// `recheckLogins(env, master, now)`.
pub async fn recheck_logins(net: &WarmupNetwork, now: i64) -> sqlx::Result<RecheckResult> {
    let candidates = load_candidates(&net.master, now).await?;
    let mut healed = 0;
    for mailbox in &candidates {
        let outcome = match try_login(net, mailbox, now).await {
            Ok(true) => bring_back(&net.master, mailbox, now).await.map(|()| true),
            other => other,
        };
        match outcome {
            Ok(true) => healed += 1,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(id = mailbox.id, %error, "[reach-warmup] login recheck failed");
            }
        }
    }
    Ok(RecheckResult {
        checked: candidates.len(),
        healed,
    })
}
