//! `planner.ts` (cron, every 30 minutes): turns the pool into scheduled
//! warmup mail.
//!
//! 1. The pool has to span `WARMUP_MIN_POOL_DOMAINS` domains; below that
//!    every `waiting` mailbox stays waiting and nothing is planned.
//! 2. `waiting` mailboxes start: status `warming`, ramp day 1.
//! 3. Each warming / maintaining mailbox not yet planned for its LOCAL date
//!    gets today's messages: the ramp (or maintenance) target spread over
//!    the rest of its business hours, each with a recipient chosen under the
//!    pairing rules and a corpus thread.
//!
//! Idempotent per local day: the day is claimed with one conditional UPDATE
//! (`planned_for` differs from today's date), so two overlapping runs cannot
//! plan one mailbox twice. Before planning, [`recheck_logins`] brings back
//! mailboxes whose login works again.

use std::collections::{HashMap, HashSet};

use sqlx::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_reach_domain::smtp::generate_message_id;
use weldsuite_reach_domain::warmup::{
    WARMUP_MAINTAIN_MAX, WARMUP_MAINTAIN_MIN, WARMUP_MIN_POOL_DOMAINS, ramp_target,
};

use super::WarmupNetwork;
use super::clock::{
    DAY_MS, HOUR_MS, Rng, business_window, daily_target_for, js_round, local_date, new_threads_for,
    plan_day, shuffled, spread_times,
};
use super::corpus::{CorpusThread, corpus, render_corpus_message};
use super::db::{PoolMailbox, is_warmup_enabled, pool_columns, ts};
use super::login_recheck::recheck_logins;
use super::pairing::{PairingMailbox, PairingState, pair_key, pick_recipient, pick_thread_id};

/// A pair does not start a new thread within this long of its last one.
pub const PAIR_COOLDOWN_DAYS: i64 = 3;
/// Corpus threads the pair used within this long ago are avoided.
pub const THREAD_MEMORY_DAYS: i64 = 14;
/// Warmup mail planned this far back (and later) counts as "received
/// today" for balancing.
pub const BALANCE_WINDOW_MS: i64 = 12 * HOUR_MS;
/// Mailboxes planned per run; the rest wait for the next.
pub const MAX_MAILBOXES_PER_RUN: usize = 150;

/// `PlannerResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PlannerResult {
    /// `disabled`, `pool_too_small` or `ok`.
    pub status: &'static str,
    pub pool_mailboxes: usize,
    pub pool_domains: usize,
    pub started: usize,
    pub logins_restored: usize,
    pub mailboxes_planned: usize,
    pub messages_planned: usize,
}

/// `loadEligible(master)` (no order, as in TypeScript).
async fn load_eligible(master: &PgPool) -> sqlx::Result<Vec<PoolMailbox>> {
    sqlx::query_as(concat!(
        "select ",
        pool_columns!(),
        " from reach_warmup_mailboxes where status in ('waiting', 'warming', 'maintaining')"
    ))
    .fetch_all(master)
    .await
}

/// `startWaiting(...)`: waiting -> warming, ramp day 1; the loaded rows are
/// updated to match.
async fn start_waiting(
    master: &PgPool,
    mailboxes: &mut [PoolMailbox],
    now: i64,
) -> sqlx::Result<usize> {
    let started: Vec<String> = sqlx::query_scalar(
        "update reach_warmup_mailboxes set status = 'warming', started_at = $1::timestamptz, ramp_day = 1,
           ramp_updated_at = $1::timestamptz, updated_at = $1::timestamptz
         where status = 'waiting' returning id",
    )
    .bind(ts(now))
    .fetch_all(master)
    .await?;
    let ids: HashSet<&String> = started.iter().collect();
    for mailbox in mailboxes.iter_mut().filter(|m| ids.contains(&m.id)) {
        "warming".clone_into(&mut mailbox.status);
        mailbox.ramp_day = 1;
    }
    Ok(ids.len())
}

/// `expectedDailyVolume(mailbox)`: what a mailbox sends on an ordinary
/// day, the reference for how much it should receive.
fn expected_daily_volume(mailbox: &PoolMailbox) -> i64 {
    if mailbox.status == "maintaining" {
        let middle = (WARMUP_MAINTAIN_MIN + WARMUP_MAINTAIN_MAX) as f64 / 2.0;
        return new_threads_for(js_round(middle));
    }
    new_threads_for(ramp_target(i64::from(mailbox.ramp_day)).max(1))
}

fn to_pairing(mailbox: &PoolMailbox) -> PairingMailbox {
    PairingMailbox {
        id: mailbox.id.clone(),
        workspace_id: mailbox.workspace_id.clone(),
        domain: mailbox.domain.clone(),
        mailbox_type: mailbox.mailbox_type.clone(),
        capacity: expected_daily_volume(mailbox),
    }
}

async fn load_received_counts(master: &PgPool, now: i64) -> sqlx::Result<HashMap<String, i64>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "select to_mailbox_id, count(*)::int8 from reach_warmup_messages
         where status <> 'failed' and scheduled_at >= $1::timestamptz group by to_mailbox_id",
    )
    .bind(ts(now - BALANCE_WINDOW_MS))
    .fetch_all(master)
    .await?;
    Ok(rows.into_iter().collect())
}

#[derive(Default)]
struct PairHistory {
    /// Pairs (either direction) that started a thread within the cool-down.
    cooling: HashSet<String>,
    /// Corpus threads each pair used recently.
    threads_by_pair: HashMap<String, HashSet<String>>,
}

async fn load_pair_history(
    master: &PgPool,
    sender_id: &str,
    now: i64,
) -> sqlx::Result<PairHistory> {
    let rows: Vec<(String, String, String, i64)> = sqlx::query_as(
        "select from_mailbox_id, to_mailbox_id, corpus_thread_id, floor(extract(epoch from scheduled_at) * 1000)::int8
         from reach_warmup_messages
         where step = 0 and status <> 'failed' and scheduled_at >= $1::timestamptz
           and (from_mailbox_id = $2 or to_mailbox_id = $2)",
    )
    .bind(ts(now - THREAD_MEMORY_DAYS * DAY_MS))
    .bind(sender_id)
    .fetch_all(master)
    .await?;
    let cooling_since = now - PAIR_COOLDOWN_DAYS * DAY_MS;
    let mut history = PairHistory::default();
    for (from, to, thread, scheduled_at) in rows {
        let key = pair_key(&from, &to);
        if scheduled_at >= cooling_since {
            history.cooling.insert(key.clone());
        }
        history
            .threads_by_pair
            .entry(key)
            .or_default()
            .insert(thread);
    }
    Ok(history)
}

struct PlanContext<'a> {
    master: &'a PgPool,
    now: i64,
    threads: HashMap<&'static str, &'static CorpusThread>,
    thread_ids: Vec<String>,
    /// Everyone who can receive.
    candidates: Vec<PairingMailbox>,
    mailboxes: HashMap<String, PoolMailbox>,
    /// Planned receives per mailbox, shared across senders.
    received: HashMap<String, i64>,
    thread_use: HashMap<String, i64>,
}

/// One row to insert.
struct NewMessage {
    id: String,
    thread_id: String,
    from: String,
    to: String,
    corpus_thread_id: String,
    message_id_header: String,
    subject: String,
    scheduled_at: i64,
}

/// `claimDay(...)`: false when another run already planned the local date
/// (or the mailbox stopped being active in the meantime).
async fn claim_day(
    ctx: &PlanContext<'_>,
    mailbox: &PoolMailbox,
    date: &str,
    planned: i64,
) -> sqlx::Result<bool> {
    let claimed = sqlx::query(
        "update reach_warmup_mailboxes set planned_for = $2, daily_target = $3, updated_at = $4::timestamptz
         where id = $1 and status in ('warming', 'maintaining') and (planned_for is null or planned_for <> $2)",
    )
    .bind(&mailbox.id)
    .bind(date)
    .bind(i32::try_from(planned).unwrap_or(i32::MAX))
    .bind(ts(ctx.now))
    .execute(ctx.master)
    .await?;
    Ok(claimed.rows_affected() > 0)
}

/// `releaseDay(...)`: hand the day back after a failed insert.
async fn release_day(ctx: &PlanContext<'_>, mailbox: &PoolMailbox) -> sqlx::Result<()> {
    sqlx::query(
        "update reach_warmup_mailboxes set planned_for = $2, daily_target = $3 where id = $1",
    )
    .bind(&mailbox.id)
    .bind(mailbox.planned_for.as_deref())
    .bind(mailbox.daily_target)
    .execute(ctx.master)
    .await?;
    Ok(())
}

fn build_message(
    ctx: &PlanContext<'_>,
    sender: &PoolMailbox,
    recipient: &PoolMailbox,
    thread_id: &str,
    at: i64,
) -> Option<NewMessage> {
    let thread = ctx.threads.get(thread_id)?;
    let rendered = render_corpus_message(thread, 0, &sender.person(), &recipient.person()).ok()?;
    Some(NewMessage {
        id: generate_id("rwms"),
        thread_id: generate_id("rwth"),
        from: sender.id.clone(),
        to: recipient.id.clone(),
        corpus_thread_id: thread.id.clone(),
        // Stored before the send: the inbound filter drops forwarded warmup
        // mail by this id.
        message_id_header: generate_message_id(&sender.domain).ok()?,
        subject: rendered.subject,
        scheduled_at: at,
    })
}

fn choose_thread(
    ctx: &mut PlanContext<'_>,
    history: &mut PairHistory,
    sender_id: &str,
    recipient_id: &str,
    rng: Rng<'_>,
) -> Option<String> {
    let key = pair_key(sender_id, recipient_id);
    let used = history.threads_by_pair.entry(key).or_default();
    let chosen = pick_thread_id(&ctx.thread_ids, used, &mut ctx.thread_use, rng)?;
    used.insert(chosen.clone());
    Some(chosen)
}

fn build_day_messages(
    ctx: &mut PlanContext<'_>,
    sender: &PoolMailbox,
    history: &mut PairHistory,
    times: &[i64],
    rng: Rng<'_>,
) -> Vec<NewMessage> {
    let mut state = PairingState::new(
        std::mem::take(&mut ctx.received),
        std::mem::take(&mut history.cooling),
    );
    let sender_node = to_pairing(sender);
    let mut rows = Vec::new();
    for &at in times {
        let candidates = std::mem::take(&mut ctx.candidates);
        let recipient = pick_recipient(&sender_node, &candidates, &mut state, &mut *rng)
            .and_then(|node| ctx.mailboxes.get(&node.id))
            .cloned();
        ctx.candidates = candidates;
        let Some(recipient) = recipient else {
            break;
        };
        let row = choose_thread(ctx, history, &sender.id, &recipient.id, &mut *rng)
            .and_then(|thread| build_message(ctx, sender, &recipient, &thread, at));
        rows.extend(row);
    }
    ctx.received = state.received;
    history.cooling = state.cooling_pairs;
    rows
}

async fn insert_messages(master: &PgPool, rows: &[NewMessage]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut ids = Vec::new();
    let mut threads = Vec::new();
    let mut froms = Vec::new();
    let mut tos = Vec::new();
    let mut corpus_ids = Vec::new();
    let mut headers = Vec::new();
    let mut subjects = Vec::new();
    let mut times = Vec::new();
    for row in rows {
        ids.push(row.id.clone());
        threads.push(row.thread_id.clone());
        froms.push(row.from.clone());
        tos.push(row.to.clone());
        corpus_ids.push(row.corpus_thread_id.clone());
        headers.push(row.message_id_header.clone());
        subjects.push(row.subject.clone());
        times.push(ts(row.scheduled_at));
    }
    sqlx::query(
        "insert into reach_warmup_messages (id, thread_id, step, from_mailbox_id, to_mailbox_id,
           corpus_thread_id, message_id_header, in_reply_to, \"references\", subject, status, scheduled_at)
         select id, thread_id, 0, from_id, to_id, corpus_id, header, null, null, subject, 'scheduled', at::timestamptz
         from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
           as t(id, thread_id, from_id, to_id, corpus_id, header, subject, at)",
    )
    .bind(&ids)
    .bind(&threads)
    .bind(&froms)
    .bind(&tos)
    .bind(&corpus_ids)
    .bind(&headers)
    .bind(&subjects)
    .bind(&times)
    .execute(master)
    .await?;
    Ok(())
}

/// `planMailbox(ctx, sender)`: the messages planned, or `None` when the day
/// was not ours to plan.
async fn plan_mailbox(
    ctx: &mut PlanContext<'_>,
    sender: &PoolMailbox,
    rng: Rng<'_>,
) -> sqlx::Result<Option<usize>> {
    let window = business_window(ctx.now, &sender.timezone);
    let maintaining = sender.status == "maintaining";
    let target = daily_target_for(maintaining, i64::from(sender.ramp_day.max(1)), &mut *rng);
    let day = plan_day(target, &window, ctx.now);
    if !claim_day(ctx, sender, &window.date, day.count).await? {
        return Ok(None);
    }
    if day.count == 0 {
        return Ok(Some(0));
    }
    let planned = async {
        let mut history = load_pair_history(ctx.master, &sender.id, ctx.now).await?;
        let times = spread_times(day.from, day.until, day.count, &mut *rng);
        let rows = build_day_messages(ctx, sender, &mut history, &times, rng);
        insert_messages(ctx.master, &rows).await?;
        if rows.len() as i64 != day.count {
            sqlx::query("update reach_warmup_mailboxes set daily_target = $2 where id = $1")
                .bind(&sender.id)
                .bind(i32::try_from(rows.len()).unwrap_or(i32::MAX))
                .execute(ctx.master)
                .await?;
        }
        Ok::<_, sqlx::Error>(rows.len())
    }
    .await;
    match planned {
        Ok(count) => Ok(Some(count)),
        Err(error) => {
            let _ = release_day(ctx, sender).await;
            Err(error)
        }
    }
}

/// `runPlannerTick(env, deps)`.
pub async fn run_planner(
    net: &WarmupNetwork,
    now: i64,
    rng: Rng<'_>,
) -> Result<PlannerResult, String> {
    if !is_warmup_enabled(&net.flags).await {
        return Ok(PlannerResult {
            status: "disabled",
            ..PlannerResult::default()
        });
    }
    let master = &net.master;
    let logins_restored = match recheck_logins(net, now).await {
        Ok(result) => result.healed,
        Err(error) => {
            tracing::error!(%error, "[reach-warmup] planner: login recheck failed");
            0
        }
    };
    let mut eligible = load_eligible(master).await.map_err(|e| e.to_string())?;
    let pool_domains = eligible
        .iter()
        .map(|m| m.domain.as_str())
        .collect::<HashSet<_>>()
        .len();
    let mut result = PlannerResult {
        status: "ok",
        pool_mailboxes: eligible.len(),
        pool_domains,
        logins_restored,
        ..PlannerResult::default()
    };
    if (pool_domains as i64) < WARMUP_MIN_POOL_DOMAINS {
        tracing::info!(
            pool_domains,
            mailboxes = eligible.len(),
            "[reach-warmup] planner: the pool spans too few domains; waiting"
        );
        result.status = "pool_too_small";
        return Ok(result);
    }

    result.started = start_waiting(master, &mut eligible, now)
        .await
        .map_err(|e| e.to_string())?;
    let open: Vec<PoolMailbox> = eligible
        .iter()
        .filter(|m| {
            (m.status == "warming" || m.status == "maintaining")
                && m.planned_for.as_deref() != Some(local_date(now, &m.timezone).as_str())
        })
        .cloned()
        .collect();
    let due: Vec<PoolMailbox> = shuffled(&mut *rng, &open)
        .into_iter()
        .take(MAX_MAILBOXES_PER_RUN)
        .collect();
    if due.is_empty() {
        return Ok(result);
    }

    let threads = corpus();
    let mut ctx = PlanContext {
        master,
        now,
        threads: threads.iter().map(|t| (t.id.as_str(), t)).collect(),
        thread_ids: threads.iter().map(|t| t.id.clone()).collect(),
        candidates: eligible.iter().map(to_pairing).collect(),
        mailboxes: eligible.iter().map(|m| (m.id.clone(), m.clone())).collect(),
        received: load_received_counts(master, now)
            .await
            .map_err(|e| e.to_string())?,
        thread_use: HashMap::new(),
    };
    for sender in &due {
        match plan_mailbox(&mut ctx, sender, &mut *rng).await {
            Ok(Some(count)) => {
                result.mailboxes_planned += 1;
                result.messages_planned += count;
            }
            Ok(None) => {}
            Err(error) => {
                tracing::error!(id = sender.id, %error, "[reach-warmup] planner: failed");
            }
        }
    }
    tracing::info!(
        pool = eligible.len(),
        pool_domains,
        started = result.started,
        planned = result.mailboxes_planned,
        messages = result.messages_planned,
        "[reach-warmup] planner"
    );
    Ok(result)
}
