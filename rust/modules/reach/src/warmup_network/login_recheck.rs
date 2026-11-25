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

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use sqlx::PgPool;
use weldsuite_db::orm;
use weldsuite_ports::ImapConfig;
use weldsuite_schema::master::reach_warmup_mailboxes::{self as pool, Column};

use super::WarmupNetwork;
use super::clock::HOUR_MS;
use super::db::{PoolMailbox, at, clip, open_login, pool_mailboxes, pool_query};
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

async fn load_candidates(master: &PgPool, now: i64) -> Result<Vec<PoolMailbox>, DbErr> {
    let query = pool_query()
        .filter(Column::Status.eq("error"))
        .filter(Column::PausedReason.eq(LOGIN_FAILED_REASON))
        .filter(
            Condition::any().add(Column::LastLoginError.is_null()).add(
                Condition::all()
                    .add(Column::LastLoginError.like("imap:%"))
                    .add(Column::LastLoginErrorAt.lt(at(now - RECHECK_BACKOFF_MS))),
            ),
        )
        .limit(u64::try_from(RECHECK_LIMIT).unwrap_or_default());
    pool_mailboxes(master, query).await
}

/// `stillBroken(...)`: note why and start the back-off. The sweep is only
/// told when the error text appears for the first time.
async fn still_broken(
    master: &PgPool,
    mailbox: &PoolMailbox,
    detail: &str,
    now: i64,
) -> Result<(), DbErr> {
    pool::Entity::update_many()
        .col_expr(
            Column::LastLoginError,
            Expr::value(clip(&format!("imap: {detail}"), 300)),
        )
        .col_expr(Column::LastLoginErrorAt, Expr::value(at(now)))
        .filter(Column::Id.eq(&mailbox.id))
        .exec(&orm(master))
        .await?;
    if mailbox.last_login_error.is_none() {
        mark_reach_due(master, &mailbox.workspace_id, now).await;
    }
    Ok(())
}

async fn bring_back(master: &PgPool, mailbox: &PoolMailbox, now: i64) -> Result<(), DbErr> {
    pool::Entity::update_many()
        .col_expr(Column::Status, Expr::value(mailbox.unpaused_status()))
        .col_expr(Column::PausedReason, Expr::null())
        .col_expr(Column::LastLoginError, Expr::null())
        .col_expr(Column::LastLoginErrorAt, Expr::null())
        .col_expr(Column::UpdatedAt, Expr::value(at(now)))
        .filter(Column::Id.eq(&mailbox.id))
        .filter(Column::Status.eq("error"))
        .filter(Column::PausedReason.eq(LOGIN_FAILED_REASON))
        .exec(&orm(master))
        .await?;
    mark_reach_due(master, &mailbox.workspace_id, now).await;
    Ok(())
}

/// `tryLogin(...)`: one login; `true` when it worked.
async fn try_login(net: &WarmupNetwork, mailbox: &PoolMailbox, now: i64) -> Result<bool, DbErr> {
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
pub async fn recheck_logins(net: &WarmupNetwork, now: i64) -> Result<RecheckResult, DbErr> {
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
