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
//!
//! The monthly corpus refresh does not run on these editions (it needs AI):
//! the built-in corpus is the only one. Each step is independent: one
//! failing is logged and the others still run.

use sqlx::PgPool;
use weldsuite_reach_domain::warmup::{WARMUP_GATE_WINDOW_DAYS, WARMUP_MIN_DAYS};

use super::WarmupNetwork;
use super::cleanup::{CleanupResult, run_cleanup};
use super::clock::DAY_MS;
use super::db::{is_warmup_enabled, ts};
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
    /// Always false here: no AI, no corpus refresh.
    pub corpus_refreshed: bool,
}

/// `startOfUtcDay(now)`.
pub fn start_of_utc_day(now: i64) -> i64 {
    now - now.rem_euclid(DAY_MS)
}

/// `advanceRamp(master, now)`.
pub async fn advance_ramp(master: &PgPool, now: i64) -> sqlx::Result<(usize, usize)> {
    let today = start_of_utc_day(now);
    let advanced = sqlx::query(
        "update reach_warmup_mailboxes set ramp_day = ramp_day + 1, ramp_updated_at = $1::timestamptz,
           updated_at = $1::timestamptz
         where status in ('warming', 'maintaining')
           and (ramp_updated_at is null or ramp_updated_at < $2::timestamptz)
           and id in (select from_mailbox_id from reach_warmup_messages
                      where sent_at >= $3::timestamptz and sent_at < $2::timestamptz)",
    )
    .bind(ts(now))
    .bind(ts(today))
    .bind(ts(today - DAY_MS))
    .execute(master)
    .await?
    .rows_affected();
    let graduated = sqlx::query(
        "update reach_warmup_mailboxes set status = 'maintaining', updated_at = $1::timestamptz
         where status = 'warming' and ramp_day >= $2",
    )
    .bind(ts(now))
    .bind(i32::try_from(WARMUP_MIN_DAYS).unwrap_or(i32::MAX))
    .execute(master)
    .await?
    .rows_affected();
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
) -> sqlx::Result<Vec<String>> {
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
    let paused: Vec<(String, String, String)> = sqlx::query_as(
        "update reach_warmup_mailboxes set status = 'paused', paused_reason = $2, updated_at = $3::timestamptz
         where id = any($1) and status = 'maintaining' returning id, email, workspace_id",
    )
    .bind(&low)
    .bind(LOW_INBOX_RATE_REASON)
    .bind(ts(now))
    .fetch_all(master)
    .await?;
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
pub async fn resume_after_cool_off(master: &PgPool, now: i64) -> sqlx::Result<Vec<String>> {
    let waiting: Vec<(String, String, Option<i64>, i32)> = sqlx::query_as(
        "select id, workspace_id, floor(extract(epoch from started_at) * 1000)::int8, ramp_day
         from reach_warmup_mailboxes
         where status = 'paused' and paused_reason = $1 and updated_at < $2::timestamptz",
    )
    .bind(LOW_INBOX_RATE_REASON)
    .bind(ts(now - LOW_RATE_COOL_OFF_DAYS * DAY_MS))
    .fetch_all(master)
    .await?;
    let mut resumed = Vec::new();
    for (id, workspace_id, started_at, ramp_day) in waiting {
        let status = weldsuite_reach_domain::warmup_pool::unpaused_status(
            started_at.map(|_| ""),
            i64::from(ramp_day),
        );
        let lifted = sqlx::query(
            "update reach_warmup_mailboxes set status = $2, paused_reason = null, updated_at = $3::timestamptz
             where id = $1 and status = 'paused' and paused_reason = $4",
        )
        .bind(&id)
        .bind(status)
        .bind(ts(now))
        .bind(LOW_INBOX_RATE_REASON)
        .execute(master)
        .await?;
        if lifted.rows_affected() == 0 {
            continue;
        }
        mark_reach_due(master, &workspace_id, now).await;
        resumed.push(id);
    }
    Ok(resumed)
}

/// `step(name, fallback, task)`.
fn step<T>(name: &str, fallback: T, result: sqlx::Result<T>) -> T {
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
    tracing::info!(
        advanced,
        graduated,
        rolled_up = rolled.len(),
        auto_paused = auto_paused.len(),
        resumed = resumed.len(),
        cleaned = cleanup.map_or(0, |c| c.cleaned),
        rows_deleted = cleanup.map_or(0, |c| c.rows_deleted),
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
        corpus_refreshed: false,
    }
}
