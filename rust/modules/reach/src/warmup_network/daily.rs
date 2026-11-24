//! `daily.ts` (cron, 02:30 UTC): ramp, stats, auto-pause, cleanup.
//!
//! 1. Ramp: a warming / maintaining mailbox that actually sent warmup mail
//!    yesterday (UTC day) moves one ramp day on; one that sent nothing stays
//!    where it is. Warming mailboxes at `WARMUP_MIN_DAYS` become
//!    `maintaining`. Guarded by `ramp_updated_at`, so a second run the same
//!    UTC day advances nobody twice.
//! 2. Stats rollup per pool mailbox ([`roll_up_stats`]).
//! 3. Auto-pause: a maintaining mailbox whose 3-day inbox rate fell below
//!    [`AUTO_PAUSE_INBOX_RATE`] is paused with `low_inbox_rate`, and lifted
//!    again after [`LOW_RATE_COOL_OFF_DAYS`] to be measured anew; a pause
//!    with any other reason is never touched.
//! 4. Cleanup of old warmup mail and old message rows ([`run_cleanup`]).
//! 5. The corpus refresh ([`refresh_corpus`]): a new generated set when the
//!    stored one is a month old and the pool has mailboxes taking part, tried
//!    at most once a week, with the install's AI (Claude where the install
//!    has WeldSuite's Anthropic key); without AI the built-in set stays.
//!
//! Each step is independent: one failing is logged and the others still run.

use sea_orm::sea_query::{Expr, Query};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_reach_domain::warmup::{WARMUP_GATE_WINDOW_DAYS, WARMUP_MIN_DAYS};
use weldsuite_schema::master::{reach_warmup_mailboxes as pool, reach_warmup_messages as messages};

use super::WarmupNetwork;
use super::cleanup::{CleanupResult, run_cleanup};
use super::clock::DAY_MS;
use super::db::{at, is_warmup_enabled};
use super::generate::refresh_corpus;
use super::pool_state::{LOW_INBOX_RATE_REASON, mark_reach_due};
use super::stats::{RolledUpMailbox, roll_up_stats};

/// A maintaining mailbox below this inbox rate over 3 days is paused.
pub const AUTO_PAUSE_INBOX_RATE: f64 = 0.6;
/// A paused mailbox is probed again after this long.
pub const LOW_RATE_COOL_OFF_DAYS: i64 = WARMUP_GATE_WINDOW_DAYS;

/// `DailyResult`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DailyResult {
    pub disabled: bool,
    pub advanced: usize,
    pub graduated: usize,
    pub rolled_up: usize,
    pub auto_paused: Vec<String>,
    pub resumed: Vec<String>,
    pub cleanup: Option<CleanupResult>,
    /// Whether a new corpus was generated and stored.
    pub corpus_refreshed: bool,
}

/// `startOfUtcDay(now)`.
pub fn start_of_utc_day(now: i64) -> i64 {
    now - now.rem_euclid(DAY_MS)
}

/// `advanceRamp(master, now)`.
pub async fn advance_ramp(master: &PgPool, now: i64) -> Result<(usize, usize), DbErr> {
    use sea_orm::ExprTrait as _;
    let today = start_of_utc_day(now);
    let sent_yesterday = Query::select()
        .column(messages::Column::FromMailboxId)
        .from(messages::Entity)
        .and_where(messages::Column::SentAt.gte(at(today - DAY_MS)))
        .and_where(messages::Column::SentAt.lt(at(today)))
        .to_owned();
    let advanced = pool::Entity::update_many()
        .col_expr(
            pool::Column::RampDay,
            Expr::col(pool::Column::RampDay).add(1),
        )
        .col_expr(pool::Column::RampUpdatedAt, Expr::value(at(now)))
        .col_expr(pool::Column::UpdatedAt, Expr::value(at(now)))
        .filter(pool::Column::Status.is_in(["warming", "maintaining"]))
        .filter(
            Condition::any()
                .add(pool::Column::RampUpdatedAt.is_null())
                .add(pool::Column::RampUpdatedAt.lt(at(today))),
        )
        .filter(pool::Column::Id.in_subquery(sent_yesterday))
        .exec(&orm(master))
        .await?
        .rows_affected;
    let graduated = pool::Entity::update_many()
        .col_expr(pool::Column::Status, Expr::value("maintaining"))
        .col_expr(pool::Column::UpdatedAt, Expr::value(at(now)))
        .filter(pool::Column::Status.eq("warming"))
        .filter(pool::Column::RampDay.gte(i32::try_from(WARMUP_MIN_DAYS).unwrap_or(i32::MAX)))
        .exec(&orm(master))
        .await?
        .rows_affected;
    Ok((
        usize::try_from(advanced).unwrap_or_default(),
        usize::try_from(graduated).unwrap_or_default(),
    ))
}

/// `pauseOnLowPlacement(...)`: the ids paused.
pub async fn pause_on_low_placement(
    master: &PgPool,
    rolled: &[RolledUpMailbox],
    now: i64,
) -> Result<Vec<String>, DbErr> {
    let low: Vec<&str> = rolled
        .iter()
        .filter(|m| {
            m.status == "maintaining" && m.inbox_rate_3d.is_some_and(|r| r < AUTO_PAUSE_INBOX_RATE)
        })
        .map(|m| m.id.as_str())
        .collect();
    if low.is_empty() {
        return Ok(Vec::new());
    }
    let paused: Vec<(String, String, String)> = pool::Entity::update_many()
        .col_expr(pool::Column::Status, Expr::value("paused"))
        .col_expr(
            pool::Column::PausedReason,
            Expr::value(LOW_INBOX_RATE_REASON),
        )
        .col_expr(pool::Column::UpdatedAt, Expr::value(at(now)))
        .filter(pool::Column::Id.is_in(low))
        .filter(pool::Column::Status.eq("maintaining"))
        .exec_with_returning(&orm(master))
        .await?
        .into_iter()
        .map(|row| (row.id, row.email, row.workspace_id))
        .collect();
    for (id, email, workspace_id) in &paused {
        tracing::warn!(
            id,
            email,
            "[reach-warmup] daily: paused, {LOW_INBOX_RATE_REASON}"
        );
        mark_reach_due(master, workspace_id, now).await;
    }
    Ok(paused.into_iter().map(|(id, _, _)| id).collect())
}

/// `resumeAfterCoolOff(...)`: lift the engine's own low-placement pauses
/// after the cool-off; the mailbox is measured again (and paused again if
/// the rate is still low).
pub async fn resume_after_cool_off(master: &PgPool, now: i64) -> Result<Vec<String>, DbErr> {
    let waiting: Vec<(String, String, Option<OffsetDateTime>, i32)> = pool::Entity::find()
        .select_only()
        .columns([
            pool::Column::Id,
            pool::Column::WorkspaceId,
            pool::Column::StartedAt,
            pool::Column::RampDay,
        ])
        .filter(pool::Column::Status.eq("paused"))
        .filter(pool::Column::PausedReason.eq(LOW_INBOX_RATE_REASON))
        .filter(pool::Column::UpdatedAt.lt(at(now - LOW_RATE_COOL_OFF_DAYS * DAY_MS)))
        .into_tuple()
        .all(&orm(master))
        .await?;
    let mut resumed = Vec::new();
    for (id, workspace_id, started_at, ramp_day) in waiting {
        let status = weldsuite_reach_domain::warmup_pool::unpaused_status(
            started_at.map(|_| ""),
            i64::from(ramp_day),
        );
        let lifted = pool::Entity::update_many()
            .col_expr(pool::Column::Status, Expr::value(status))
            .col_expr(pool::Column::PausedReason, Expr::null())
            .col_expr(pool::Column::UpdatedAt, Expr::value(at(now)))
            .filter(pool::Column::Id.eq(&id))
            .filter(pool::Column::Status.eq("paused"))
            .filter(pool::Column::PausedReason.eq(LOW_INBOX_RATE_REASON))
            .exec(&orm(master))
            .await?;
        if lifted.rows_affected == 0 {
            continue;
        }
        mark_reach_due(master, &workspace_id, now).await;
        resumed.push(id);
    }
    Ok(resumed)
}

/// `step(name, fallback, task)`.
fn step<T>(name: &str, fallback: T, result: Result<T, DbErr>) -> T {
    result.unwrap_or_else(|error| {
        tracing::error!(%error, "[reach-warmup] daily: {name} failed");
        fallback
    })
}

/// `runDailyTick(env, deps)`.
pub async fn run_daily(net: &WarmupNetwork, now: i64) -> DailyResult {
    if !is_warmup_enabled(&net.flags).await {
        return DailyResult {
            disabled: true,
            ..DailyResult::default()
        };
    }
    let master = &net.master;
    let (advanced, graduated) = step("ramp", (0, 0), advance_ramp(master, now).await);
    let rolled = step("stats rollup", Vec::new(), roll_up_stats(master, now).await);
    let auto_paused = step(
        "auto-pause",
        Vec::new(),
        pause_on_low_placement(master, &rolled, now).await,
    );
    let resumed = step(
        "cool-off resume",
        Vec::new(),
        resume_after_cool_off(master, now).await,
    );
    let cleanup = step("cleanup", None, run_cleanup(net, now).await.map(Some));
    let corpus_refreshed = refresh_corpus(master, net.ai.as_ref(), now).await;
    tracing::info!(
        advanced,
        graduated,
        rolled_up = rolled.len(),
        auto_paused = auto_paused.len(),
        resumed = resumed.len(),
        cleaned = cleanup.map_or(0, |c| c.cleaned),
        rows_deleted = cleanup.map_or(0, |c| c.rows_deleted),
        corpus_refreshed,
        "[reach-warmup] daily"
    );
    DailyResult {
        disabled: false,
        advanced,
        graduated,
        rolled_up: rolled.len(),
        auto_paused,
        resumed,
        cleanup,
        corpus_refreshed,
    }
}
