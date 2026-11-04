//! `services/send-tick.ts`: one send tick for one workspace, the I/O half
//! of the send engine (`scheduler.rs` holds the rules).
//!
//! 1. mark crashed sends `unknown` (never retried);
//! 2. load the active campaigns, their mailboxes, steps and today's counts;
//! 3. push enrollments that cannot send now (window closed, daily limit,
//!    mailbox capped or unusable) to the moment they can;
//! 4. claim due enrollments atomically (`claimed_at`) and look at each
//!    before planning (deleted prospect, suppression, consumer domain,
//!    missing variables, a step that already went out);
//! 5. plan and send, one email per mailbox, a few connections at a time;
//! 6. advance / stop each enrollment, update counters, apply the
//!    guardrails, complete finished campaigns;
//! 7. report when the workspace next has work.

use std::collections::HashMap;

use futures_util::StreamExt;
use serde_json::Value;
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::REACH_MAILBOX_UPDATED;
use weldsuite_db::Keyring;

use super::guardrails::{mailbox_event, record_hard_bounce};
use super::scheduler::{
    CLAIM_STALE_MS, CampaignGate, MIN_RETRY_MS, PlanCampaign, PlanContext, PlanEnrollment,
    PlanMailbox, PlannedSend, Readiness, STUCK_SENDING_MS, TEMPORARY_RETRY_MS,
    UNAVAILABLE_RETRY_MS, assess_mailboxes, evaluate_campaign_gate, next_day_window_start,
    next_step_due_at, plan_sends,
};
use crate::campaigns::{add_to_stats, complete_and_publish, load_settings, schedule_of};
use crate::outbound::{CREDENTIALS_UNAVAILABLE, OutboundDeps, SendInput, send_from_mailbox};
use crate::overview::{DEFAULT_DAY_TIMEZONE, count_sent_today};
use crate::render::{
    RenderProspect, RenderSender, compose_body, follow_up_subject, render_step, template_values,
};
use crate::schemas::{Limits, is_consumer_email};
use crate::send_window::start_of_zoned_day;
use crate::smtp::SmtpTransport;
use crate::suppressions::{SuppressionIndex, load_index, suppress_email};
use crate::{
    EventSink, ReachEvent, ReachResult, epoch_ms, from_epoch_ms, int, iso, parse_iso, text,
    text_or_empty,
};

/// Most rows one tick claims.
const CLAIM_MAX: i64 = 100;
/// SMTP connections open at once.
const SEND_CONCURRENCY: usize = 4;
/// A step that failed this many times stops the enrollment.
pub const MAX_SEND_ATTEMPTS: usize = 5;
const IN_FLIGHT_RETRY_MS: i64 = 5 * 60_000;
/// The earliest a still-due workspace is looked at again.
const RETRY_FLOOR_MS: i64 = 15_000;

/// What a tick needs (`TickDeps`).
pub struct TickDeps<'a> {
    pub db: &'a PgPool,
    pub keyring: &'a Keyring,
    pub transport: &'a dyn SmtpTransport,
    /// Entity events, published as the system user.
    pub events: &'a dyn EventSink,
    pub limits: &'a Limits,
    /// The clock (`deps.now`); the tick reads it once, sends read it again.
    pub clock: &'a (dyn Fn() -> OffsetDateTime + Send + Sync),
}

/// `TickResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TickResult {
    pub claimed: i64,
    pub sent: i64,
    pub bounced: i64,
    pub failed: i64,
    /// Enrollments put back for later.
    pub deferred: i64,
    /// When the workspace next has work; `None` when nothing is left.
    pub next_due_at: Option<OffsetDateTime>,
}

impl TickResult {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "claimed": self.claimed,
            "sent": self.sent,
            "bounced": self.bounced,
            "failed": self.failed,
            "deferred": self.deferred,
            "nextDueAt": self.next_due_at.map(iso),
        })
    }
}

/// The fields of a `reach_enrollments` update (`EnrollmentPatch`); every
/// patch also clears `claimed_at` and sets `updated_at`.
#[derive(Debug, Clone, Default)]
struct Patch {
    status: Option<String>,
    current_step: Option<i64>,
    mailbox_id: Option<String>,
    last_message_id: Option<String>,
    thread_root_message_id: Option<Option<String>>,
    next_send_at: Option<Option<i64>>,
    stopped_reason: Option<Option<String>>,
}

enum Outcome {
    Sent(Value),
    Uncertain(Value),
    Bounced(Value),
    AuthFailed(String),
    MailboxUnusable {
        error: String,
        credentials_missing: bool,
    },
    Rejected,
    Temporary,
    Busy,
    MissingVariables,
}

/// Everything loaded once per tick.
struct TickState {
    now: i64,
    campaign_order: Vec<String>,
    campaigns: HashMap<String, Value>,
    plan_campaigns: HashMap<String, PlanCampaign>,
    plan_mailboxes: HashMap<String, PlanMailbox>,
    mailboxes: HashMap<String, Value>,
    steps: HashMap<String, Vec<Value>>,
    ctx: PlanContext,
}

fn ms_of(row: &Value, key: &str) -> Option<i64> {
    text(row, key).and_then(parse_iso).map(epoch_ms)
}

fn ts(ms: i64) -> String {
    iso(from_epoch_ms(ms))
}

/// `markStuckSendingMessages(db, now)`.
pub async fn mark_stuck_sending_messages(db: &PgPool, now: i64) -> ReachResult<u64> {
    let rows = sqlx::query(
        "update reach_messages set status = 'unknown', error = 'Send interrupted; delivery unknown', updated_at = $1::timestamptz
         where direction = 'out' and status = 'sending' and created_at < $2::timestamptz",
    )
    .bind(ts(now))
    .bind(ts(now - STUCK_SENDING_MS))
    .execute(db)
    .await?;
    Ok(rows.rows_affected())
}

async fn load_state(
    deps: &TickDeps<'_>,
    now: i64,
    campaign_rows: Vec<Value>,
) -> ReachResult<TickState> {
    let db = deps.db;
    let ids: Vec<String> = campaign_rows
        .iter()
        .map(|c| text_or_empty(c, "id").to_owned())
        .collect();
    let settings = load_settings(db).await?;
    let day_timezone = settings
        .as_ref()
        .and_then(|s| text(s, "defaultTimezone"))
        .unwrap_or(DEFAULT_DAY_TIMEZONE)
        .to_owned();
    let links: Vec<(String, String)> = sqlx::query_as(
        "select campaign_id, mailbox_id from reach_campaign_mailboxes where campaign_id = any($1)",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let mailbox_rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_mailboxes t where t.deleted_at is null and t.status <> 'deleted'",
    )
    .fetch_all(db)
    .await?;
    let step_rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_campaign_steps t where t.campaign_id = any($1) order by t.\"order\" asc",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let sent_today =
        count_sent_today(db, start_of_zoned_day(from_epoch_ms(now), &day_timezone)).await?;

    let mut steps: HashMap<String, Vec<Value>> = HashMap::new();
    for step in step_rows.into_iter().map(weldsuite_db::js_row) {
        steps
            .entry(text_or_empty(&step, "campaignId").to_owned())
            .or_default()
            .push(step);
    }
    let mut mailboxes = HashMap::new();
    let mut plan_mailboxes = HashMap::new();
    for m in mailbox_rows.into_iter().map(weldsuite_db::js_row) {
        let id = text_or_empty(&m, "id").to_owned();
        plan_mailboxes.insert(
            id.clone(),
            PlanMailbox {
                id: id.clone(),
                status: text_or_empty(&m, "status").to_owned(),
                daily_cap: int(&m, "dailyCap"),
                ramp_current: int(&m, "rampCurrent"),
                last_sent_at: ms_of(&m, "lastSentAt"),
                sent_today: sent_today.by_mailbox.get(&id).copied().unwrap_or(0),
            },
        );
        mailboxes.insert(id, m);
    }
    let mut campaigns = HashMap::new();
    let mut plan_campaigns = HashMap::new();
    let mut campaign_order = Vec::new();
    for c in campaign_rows {
        let id = text_or_empty(&c, "id").to_owned();
        plan_campaigns.insert(
            id.clone(),
            PlanCampaign {
                id: id.clone(),
                schedule: schedule_of(&c),
                daily_limit: int(&c, "dailyLimit"),
                min_gap_minutes: int(&c, "minGapMinutes"),
                sent_today: sent_today.by_campaign.get(&id).copied().unwrap_or(0),
                mailbox_ids: links
                    .iter()
                    .filter(|(campaign, _)| *campaign == id)
                    .map(|(_, mailbox)| mailbox.clone())
                    .collect(),
            },
        );
        campaign_order.push(id.clone());
        campaigns.insert(id, c);
    }
    Ok(TickState {
        now,
        campaign_order,
        campaigns,
        plan_campaigns,
        plan_mailboxes,
        mailboxes,
        steps,
        ctx: PlanContext {
            now,
            day_timezone,
            max_daily_sends: deps.limits.max_daily_sends,
            workspace_sent_today: sent_today.total,
        },
    })
}

/// `and(status = 'active', next_send_at <= now, claimable(now))` as SQL on
/// `$1` (now) and `$2` (now - `CLAIM_STALE_MS`).
macro_rules! due_now {
    () => {
        "status = 'active' and next_send_at <= $1::timestamptz and (claimed_at is null or claimed_at < $2::timestamptz)"
    };
}

/// `deferUnsendable(state)`: the open campaigns and the mailboxes' readiness.
async fn defer_unsendable(db: &PgPool, state: &TickState) -> ReachResult<(Vec<String>, Readiness)> {
    let now = state.now;
    let mut open: Vec<String> = Vec::new();
    for id in &state.campaign_order {
        let pc = &state.plan_campaigns[id];
        match evaluate_campaign_gate(pc, &state.ctx) {
            CampaignGate::Open => open.push(id.clone()),
            CampaignGate::Closed { reopens_at, .. } => {
                sqlx::query(concat!(
                    "update reach_enrollments set next_send_at = $3::timestamptz, updated_at = $1::timestamptz
                     where campaign_id = $4 and ",
                    due_now!()
                ))
                .bind(ts(now))
                .bind(ts(now - CLAIM_STALE_MS))
                .bind(ts(reopens_at))
                .bind(id)
                .execute(db)
                .await?;
            }
        }
    }
    let open_campaigns: Vec<&PlanCampaign> =
        open.iter().map(|id| &state.plan_campaigns[id]).collect();
    let readiness = assess_mailboxes(state.plan_mailboxes.values(), &open_campaigns, now);
    if open.is_empty() {
        return Ok((open, readiness));
    }
    let active: Vec<String> = state
        .plan_mailboxes
        .values()
        .filter(|m| m.status == "active")
        .map(|m| m.id.clone())
        .collect();
    // Pinned to a mailbox that cannot send at all: look again in an hour.
    sqlx::query(concat!(
        "update reach_enrollments set next_send_at = $3::timestamptz, updated_at = $1::timestamptz
         where campaign_id = any($4) and mailbox_id is not null
           and (cardinality($5::varchar[]) = 0 or mailbox_id <> all($5)) and ",
        due_now!()
    ))
    .bind(ts(now))
    .bind(ts(now - CLAIM_STALE_MS))
    .bind(ts(now + UNAVAILABLE_RETRY_MS))
    .bind(&open)
    .bind(&active)
    .execute(db)
    .await?;
    let capped: Vec<String> = readiness.capped.iter().cloned().collect();
    for pc in &open_campaigns {
        // Pinned to a mailbox out of sends for today: tomorrow's window.
        if !capped.is_empty() {
            sqlx::query(concat!(
                "update reach_enrollments set next_send_at = $3::timestamptz, updated_at = $1::timestamptz
                 where campaign_id = $4 and mailbox_id = any($5) and ",
                due_now!()
            ))
            .bind(ts(now))
            .bind(ts(now - CLAIM_STALE_MS))
            .bind(ts(next_day_window_start(pc, &state.ctx)))
            .bind(&pc.id)
            .bind(&capped)
            .execute(db)
            .await?;
        }
        // First emails of a campaign none of whose mailboxes can send.
        if let Some(until) = first_email_hold(pc, state, &readiness) {
            sqlx::query(concat!(
                "update reach_enrollments set next_send_at = $3::timestamptz, updated_at = $1::timestamptz
                 where campaign_id = $4 and mailbox_id is null and ",
                due_now!()
            ))
            .bind(ts(now))
            .bind(ts(now - CLAIM_STALE_MS))
            .bind(ts(until))
            .bind(&pc.id)
            .execute(db)
            .await?;
        }
    }
    Ok((open, readiness))
}

/// `firstEmailHold(pc, state, readiness)`.
fn first_email_hold(pc: &PlanCampaign, state: &TickState, readiness: &Readiness) -> Option<i64> {
    let active: Vec<&PlanMailbox> = pc
        .mailbox_ids
        .iter()
        .filter_map(|id| state.plan_mailboxes.get(id))
        .filter(|m| m.status == "active")
        .collect();
    if active.is_empty() {
        return Some(state.now + UNAVAILABLE_RETRY_MS);
    }
    if active.iter().all(|m| readiness.capped.contains(&m.id)) {
        return Some(next_day_window_start(pc, &state.ctx));
    }
    None
}

/// `claimDue(state, open, readiness)`.
async fn claim_due(
    db: &PgPool,
    state: &TickState,
    open: &[String],
    readiness: &Readiness,
) -> ReachResult<Vec<Value>> {
    if readiness.ready.is_empty() || open.is_empty() {
        return Ok(Vec::new());
    }
    let now = state.now;
    let ready: Vec<String> = readiness.ready.iter().cloned().collect();
    let with_ready: Vec<String> = open
        .iter()
        .filter(|id| {
            state.plan_campaigns[*id]
                .mailbox_ids
                .iter()
                .any(|m| readiness.ready.contains(m))
        })
        .cloned()
        .collect();
    let limit = CLAIM_MAX.min((ready.len() as i64 * 3).max(4));
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "update reach_enrollments set claimed_at = $1::timestamptz, updated_at = $1::timestamptz
         where id in (
             select id from reach_enrollments
             where campaign_id = any($3) and ",
        due_now!(),
        " and (mailbox_id = any($4) or (cardinality($5::varchar[]) > 0 and mailbox_id is null and campaign_id = any($5)))
             order by next_send_at asc, id asc
             limit $6)
           and ",
        due_now!(),
        " returning to_jsonb(reach_enrollments)"
    ))
    .bind(ts(now))
    .bind(ts(now - CLAIM_STALE_MS))
    .bind(open)
    .bind(&ready)
    .bind(&with_ready)
    .bind(limit)
    .fetch_all(db)
    .await?;
    let mut claimed: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
    claimed.sort_by(|a, b| {
        ms_of(a, "nextSendAt")
            .unwrap_or(0)
            .cmp(&ms_of(b, "nextSendAt").unwrap_or(0))
            .then_with(|| text_or_empty(a, "id").cmp(text_or_empty(b, "id")))
    });
    Ok(claimed)
}

/// What the message rows say about the step an enrollment is on.
struct StepHistory {
    sent_or_unknown: Option<Value>,
    in_flight: bool,
    failed_attempts: usize,
    /// Earlier emails of the sequence, oldest first.
    previous: Vec<Value>,
}

fn history_for(enrollment_id: &str, step_id: &str, rows: &[Value]) -> StepHistory {
    let mine: Vec<&Value> = rows
        .iter()
        .filter(|m| text(m, "enrollmentId") == Some(enrollment_id))
        .collect();
    let for_step: Vec<&Value> = mine
        .iter()
        .copied()
        .filter(|m| text(m, "stepId") == Some(step_id))
        .collect();
    let out_status = |m: &Value| matches!(text(m, "status"), Some("sent" | "unknown"));
    StepHistory {
        sent_or_unknown: for_step
            .iter()
            .find(|m| out_status(m))
            .map(|m| (*m).clone()),
        in_flight: for_step
            .iter()
            .any(|m| text(m, "status") == Some("sending")),
        failed_attempts: for_step
            .iter()
            .filter(|m| text(m, "status") == Some("failed"))
            .count(),
        previous: mine
            .into_iter()
            .filter(|m| out_status(m))
            .cloned()
            .collect(),
    }
}

fn step_of<'a>(state: &'a TickState, e: &Value) -> Option<&'a Value> {
    let current = int(e, "currentStep");
    state
        .steps
        .get(text_or_empty(e, "campaignId"))?
        .iter()
        .find(|s| int(s, "order") == current)
}

/// `advance(state, e, message, mailboxId)`.
fn advance(state: &TickState, e: &Value, message: &Value, mailbox_id: &str) -> Patch {
    let campaign_id = text_or_empty(e, "campaignId");
    let current = int(e, "currentStep");
    let next = state
        .steps
        .get(campaign_id)
        .and_then(|steps| steps.iter().find(|s| int(s, "order") == current + 1));
    let thread_root = text(e, "threadRootMessageId")
        .or_else(|| text(message, "messageIdHeader"))
        .map(str::to_owned);
    let mut patch = Patch {
        current_step: Some(current + 1),
        mailbox_id: Some(mailbox_id.to_owned()),
        last_message_id: text(message, "id").map(str::to_owned),
        thread_root_message_id: Some(thread_root),
        ..Patch::default()
    };
    match next {
        None => {
            patch.status = Some("completed".to_owned());
            patch.next_send_at = Some(None);
        }
        Some(next) => {
            let schedule = schedule_of(&state.campaigns[campaign_id]);
            patch.status = Some("active".to_owned());
            patch.next_send_at = Some(Some(next_step_due_at(
                state.now,
                int(next, "delayDays"),
                int(next, "delayHours"),
                &schedule,
            )));
        }
    }
    patch
}

fn stop(status: &str, reason: Option<&str>) -> Patch {
    Patch {
        status: Some(status.to_owned()),
        stopped_reason: Some(reason.map(str::to_owned)),
        next_send_at: Some(None),
        ..Patch::default()
    }
}

fn put_back(until: Option<i64>) -> Patch {
    Patch {
        next_send_at: until.map(Some),
        ..Patch::default()
    }
}

struct Triage {
    patches: Vec<(String, Patch)>,
    to_plan: Vec<Value>,
    prospects: HashMap<String, Value>,
    history: Vec<Value>,
}

fn set_patch(patches: &mut Vec<(String, Patch)>, id: &str, patch: Patch) {
    if let Some(slot) = patches.iter_mut().find(|(existing, _)| existing == id) {
        slot.1 = patch;
    } else {
        patches.push((id.to_owned(), patch));
    }
}

/// `settleWithoutSending`: the patch and the tally it counts toward, or
/// `None` when the enrollment is still to be planned.
fn settle_without_sending(
    state: &TickState,
    limits: &Limits,
    e: &Value,
    prospect: Option<&Value>,
    history: &[Value],
    suppression: &SuppressionIndex,
) -> Option<(Patch, Option<&'static str>)> {
    let failed = |reason: &str| Some((stop("failed", Some(reason)), Some("failed")));
    let step = step_of(state, e);
    let Some(prospect) = prospect.filter(|p| p.get("deletedAt").is_none_or(Value::is_null)) else {
        return failed("prospect_deleted");
    };
    let Some(step) = step else {
        return Some((stop("completed", None), None));
    };
    let past = history_for(text_or_empty(e, "id"), text_or_empty(step, "id"), history);
    if let Some(sent) = &past.sent_or_unknown {
        return Some((
            advance(state, e, sent, text_or_empty(sent, "mailboxId")),
            None,
        ));
    }
    if past.in_flight {
        return Some((
            put_back(Some(state.now + IN_FLIGHT_RETRY_MS)),
            Some("deferred"),
        ));
    }
    if past.failed_attempts >= MAX_SEND_ATTEMPTS {
        return failed("send_failed");
    }
    let email = text_or_empty(prospect, "email");
    if let Some(hit) = suppression.check(email) {
        let status = if hit.reason == "bounced" {
            "bounced"
        } else {
            "unsubscribed"
        };
        return Some((
            stop(status, Some(&format!("suppressed:{}", hit.reason))),
            None,
        ));
    }
    if !limits.allow_consumer_recipients && is_consumer_email(email) {
        return failed("consumer_domain");
    }
    let probe = template_values(
        &RenderProspect::from_row(prospect),
        Some(&RenderSender {
            first_name: "sender".to_owned(),
            last_name: "sender".to_owned(),
        }),
    );
    if !render_step(
        text_or_empty(step, "subject"),
        text_or_empty(step, "body"),
        &probe,
    )
    .missing
    .is_empty()
    {
        return failed("missing_variables");
    }
    None
}

async fn triage(
    db: &PgPool,
    state: &TickState,
    limits: &Limits,
    claimed: &[Value],
    tally: &mut TickResult,
) -> ReachResult<Triage> {
    let mut prospect_ids: Vec<String> = Vec::new();
    for e in claimed {
        let id = text_or_empty(e, "prospectId").to_owned();
        if !prospect_ids.contains(&id) {
            prospect_ids.push(id);
        }
    }
    let prospect_rows: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(t) from reach_prospects t where t.id = any($1)")
            .bind(&prospect_ids)
            .fetch_all(db)
            .await?;
    let prospect_rows: Vec<Value> = prospect_rows
        .into_iter()
        .map(weldsuite_db::js_row)
        .collect();
    let enrollment_ids: Vec<String> = claimed
        .iter()
        .map(|e| text_or_empty(e, "id").to_owned())
        .collect();
    let history: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_messages t
         where t.enrollment_id = any($1) and t.direction = 'out'
           and t.status in ('sending', 'sent', 'unknown', 'failed')
         order by t.created_at asc, t.id asc",
    )
    .bind(&enrollment_ids)
    .fetch_all(db)
    .await?;
    let history: Vec<Value> = history.into_iter().map(weldsuite_db::js_row).collect();
    let emails: Vec<String> = prospect_rows
        .iter()
        .map(|p| text_or_empty(p, "email").to_owned())
        .collect();
    let suppression = load_index(db, &emails).await?;
    let prospects: HashMap<String, Value> = prospect_rows
        .into_iter()
        .map(|p| (text_or_empty(&p, "id").to_owned(), p))
        .collect();
    let mut patches = Vec::new();
    let mut to_plan = Vec::new();
    for e in claimed {
        let settled = settle_without_sending(
            state,
            limits,
            e,
            prospects.get(text_or_empty(e, "prospectId")),
            &history,
            &suppression,
        );
        match settled {
            None => to_plan.push(e.clone()),
            Some((patch, counts)) => {
                set_patch(&mut patches, text_or_empty(e, "id"), patch);
                match counts {
                    Some("failed") => tally.failed += 1,
                    Some("deferred") => tally.deferred += 1,
                    _ => {}
                }
            }
        }
    }
    Ok(Triage {
        patches,
        to_plan,
        prospects,
        history,
    })
}

struct SendOne<'a> {
    enrollment: &'a Value,
    prospect: &'a Value,
    mailbox: &'a Value,
    step: &'a Value,
    first_step: &'a Value,
    history: StepHistory,
}

/// `sendOne(input)`.
async fn send_one(deps: &TickDeps<'_>, now: i64, input: SendOne<'_>) -> ReachResult<Outcome> {
    let db = deps.db;
    let mailbox = input.mailbox;
    let mailbox_id = text_or_empty(mailbox, "id");
    // Reserve the mailbox: the gap restarts now, and a racing tick backs off.
    let reserved: Option<String> = sqlx::query_scalar(
        "update reach_mailboxes set last_sent_at = $2::timestamptz, updated_at = $2::timestamptz
         where id = $1 and status = 'active'
           and (case when $3::text is null then last_sent_at is null
                     else date_trunc('milliseconds', last_sent_at) = $3::timestamptz end)
         returning id",
    )
    .bind(mailbox_id)
    .bind(ts(now))
    .bind(text(mailbox, "lastSentAt"))
    .fetch_optional(db)
    .await?;
    if reserved.is_none() {
        return Ok(Outcome::Busy);
    }
    let values = template_values(
        &RenderProspect::from_row(input.prospect),
        Some(&RenderSender {
            first_name: text_or_empty(mailbox, "firstName").to_owned(),
            last_name: text_or_empty(mailbox, "lastName").to_owned(),
        }),
    );
    let step = input.step;
    let rendered = render_step(
        text_or_empty(step, "subject"),
        text_or_empty(step, "body"),
        &values,
    );
    if !rendered.missing.is_empty() {
        return Ok(Outcome::MissingVariables);
    }
    let mut subject = rendered.subject.clone();
    let mut in_reply_to = None;
    let mut references: Vec<String> = Vec::new();
    let mut thread_key = None;
    let reply_in_thread = input
        .step
        .get("replyInThread")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if int(step, "order") > 0 && reply_in_thread && !input.history.previous.is_empty() {
        let root = render_step(
            text_or_empty(input.first_step, "subject"),
            text_or_empty(input.first_step, "body"),
            &values,
        );
        subject = follow_up_subject(if root.missing.is_empty() {
            &root.subject
        } else {
            &rendered.subject
        });
        references = input
            .history
            .previous
            .iter()
            .map(|m| text_or_empty(m, "messageIdHeader").to_owned())
            .collect();
        in_reply_to = references.last().cloned();
        thread_key = text(input.enrollment, "threadRootMessageId")
            .map(str::to_owned)
            .or_else(|| references.first().cloned());
    }
    let full_name = [
        text(input.prospect, "firstName"),
        text(input.prospect, "lastName"),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    let full_name = crate::text::js_trim(&full_name).to_owned();
    let outbound = OutboundDeps {
        db,
        keyring: deps.keyring,
        transport: deps.transport,
        now: deps.clock,
    };
    let sent = send_from_mailbox(
        &outbound,
        &SendInput {
            mailbox_id: mailbox_id.to_owned(),
            to_email: text_or_empty(input.prospect, "email").to_owned(),
            to_name: (!full_name.is_empty()).then_some(full_name),
            subject,
            text: compose_body(&rendered.body, text(mailbox, "signature")),
            append_footer: true,
            in_reply_to,
            references,
            thread_key,
            campaign_id: text(input.enrollment, "campaignId").map(str::to_owned),
            enrollment_id: text(input.enrollment, "id").map(str::to_owned),
            step_id: text(step, "id").map(str::to_owned),
            prospect_id: text(input.prospect, "id").map(str::to_owned),
            sent_by: None,
        },
    )
    .await?;
    if sent.ok {
        return Ok(Outcome::Sent(sent.message.unwrap_or(Value::Null)));
    }
    let Some(message) = sent.message else {
        return Ok(Outcome::MailboxUnusable {
            credentials_missing: sent.error == CREDENTIALS_UNAVAILABLE,
            error: sent.error,
        });
    };
    if text(&message, "status") == Some("unknown") {
        return Ok(Outcome::Uncertain(message));
    }
    if sent.recipient_rejected {
        return Ok(Outcome::Bounced(message));
    }
    if sent.auth_failed {
        return Ok(Outcome::AuthFailed(sent.error));
    }
    Ok(if sent.permanent {
        Outcome::Rejected
    } else {
        Outcome::Temporary
    })
}

struct SendRun {
    enrollment: Value,
    mailbox_id: String,
    outcome: Outcome,
}

async fn execute_sends(
    deps: &TickDeps<'_>,
    state: &TickState,
    sends: &[PlannedSend],
    claimed: &[Value],
    t: &Triage,
) -> Vec<SendRun> {
    let by_id: HashMap<&str, &Value> = claimed
        .iter()
        .map(|e| (text_or_empty(e, "id"), e))
        .collect();
    let runs: Vec<_> = sends
        .iter()
        .map(|send| {
            let enrollment = by_id[send.enrollment_id.as_str()];
            let mailbox = &state.mailboxes[&send.mailbox_id];
            let step = step_of(state, enrollment).expect("a planned enrollment has a step");
            let steps = state
                .steps
                .get(text_or_empty(enrollment, "campaignId"))
                .map_or(&[][..], Vec::as_slice);
            let first_step = steps.iter().find(|s| int(s, "order") == 0).unwrap_or(step);
            let prospect = &t.prospects[text_or_empty(enrollment, "prospectId")];
            let history = history_for(
                text_or_empty(enrollment, "id"),
                text_or_empty(step, "id"),
                &t.history,
            );
            async move {
                let outcome = match send_one(
                    deps,
                    state.now,
                    SendOne {
                        enrollment,
                        prospect,
                        mailbox,
                        step,
                        first_step,
                        history,
                    },
                )
                .await
                {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        tracing::error!(%error, "[reach-send] send failed unexpectedly");
                        Outcome::Temporary
                    }
                };
                SendRun {
                    enrollment: enrollment.clone(),
                    mailbox_id: send.mailbox_id.clone(),
                    outcome,
                }
            }
        })
        .collect();
    futures_util::stream::iter(runs)
        .buffered(SEND_CONCURRENCY)
        .collect()
        .await
}

struct Applied {
    patches: Vec<(String, Patch)>,
    stats: Vec<(String, i64, i64)>,
    bounced: Vec<(String, String)>,
    problems: Vec<(String, &'static str, String)>,
    retry_soon: bool,
}

fn bump(stats: &mut Vec<(String, i64, i64)>, campaign_id: &str, bounced: bool) {
    let index = stats
        .iter()
        .position(|(id, _, _)| id == campaign_id)
        .unwrap_or_else(|| {
            stats.push((campaign_id.to_owned(), 0, 0));
            stats.len() - 1
        });
    if bounced {
        stats[index].2 += 1;
    } else {
        stats[index].1 += 1;
    }
}

fn set_problem(
    problems: &mut Vec<(String, &'static str, String)>,
    mailbox_id: &str,
    reason: &'static str,
    error: String,
) {
    if let Some(slot) = problems.iter_mut().find(|(id, _, _)| id == mailbox_id) {
        slot.1 = reason;
        slot.2 = error;
    } else {
        problems.push((mailbox_id.to_owned(), reason, error));
    }
}

async fn apply_outcomes(
    db: &PgPool,
    state: &TickState,
    runs: Vec<SendRun>,
    t: Triage,
    tally: &mut TickResult,
) -> ReachResult<Applied> {
    let now = state.now;
    let mut applied = Applied {
        patches: t.patches,
        stats: Vec::new(),
        bounced: Vec::new(),
        problems: Vec::new(),
        retry_soon: false,
    };
    for run in runs {
        let e = &run.enrollment;
        let id = text_or_empty(e, "id").to_owned();
        let campaign_id = text_or_empty(e, "campaignId").to_owned();
        let mut defer = |applied: &mut Applied, until: Option<i64>| {
            set_patch(&mut applied.patches, &id, put_back(until));
            tally.deferred += 1;
        };
        match run.outcome {
            Outcome::Sent(message) => {
                set_patch(
                    &mut applied.patches,
                    &id,
                    advance(state, e, &message, &run.mailbox_id),
                );
                tally.sent += 1;
                bump(&mut applied.stats, &campaign_id, false);
            }
            Outcome::Uncertain(message) => {
                set_patch(
                    &mut applied.patches,
                    &id,
                    advance(state, e, &message, &run.mailbox_id),
                );
            }
            Outcome::Bounced(message) => {
                let mut patch = stop("bounced", Some("hard_bounce"));
                patch.mailbox_id = Some(run.mailbox_id.clone());
                patch.last_message_id = text(&message, "id").map(str::to_owned);
                set_patch(&mut applied.patches, &id, patch);
                tally.bounced += 1;
                bump(&mut applied.stats, &campaign_id, true);
                applied
                    .bounced
                    .push((run.mailbox_id.clone(), campaign_id.clone()));
                let prospect = &t.prospects[text_or_empty(e, "prospectId")];
                suppress_email(
                    db,
                    text_or_empty(prospect, "email"),
                    "bounced",
                    text(&message, "id"),
                    None,
                )
                .await?;
            }
            Outcome::Rejected => {
                set_patch(
                    &mut applied.patches,
                    &id,
                    stop("failed", Some("smtp_rejected")),
                );
                tally.failed += 1;
            }
            Outcome::MissingVariables => {
                set_patch(
                    &mut applied.patches,
                    &id,
                    stop("failed", Some("missing_variables")),
                );
                tally.failed += 1;
            }
            Outcome::AuthFailed(error) => {
                set_problem(
                    &mut applied.problems,
                    &run.mailbox_id,
                    "smtp_auth_failed",
                    error,
                );
                let wait = if text(e, "mailboxId").is_some() {
                    UNAVAILABLE_RETRY_MS
                } else {
                    TEMPORARY_RETRY_MS
                };
                defer(&mut applied, Some(now + wait));
            }
            Outcome::MailboxUnusable {
                error,
                credentials_missing,
            } => {
                if credentials_missing {
                    set_problem(
                        &mut applied.problems,
                        &run.mailbox_id,
                        "credentials_unavailable",
                        error,
                    );
                }
                defer(&mut applied, Some(now + UNAVAILABLE_RETRY_MS));
            }
            Outcome::Busy => {
                applied.retry_soon = true;
                defer(&mut applied, None);
            }
            Outcome::Temporary => defer(&mut applied, Some(now + TEMPORARY_RETRY_MS)),
        }
    }
    Ok(applied)
}

async fn persist(deps: &TickDeps<'_>, now: i64, applied: &Applied) -> ReachResult<()> {
    let db = deps.db;
    for (mailbox_id, reason, error) in &applied.problems {
        let updated: Option<Value> = sqlx::query_scalar(
            "update reach_mailboxes set status = 'error', paused_reason = $2, last_error = $3, updated_at = $4::timestamptz
             where id = $1 and status = 'active' returning to_jsonb(reach_mailboxes)",
        )
        .bind(mailbox_id)
        .bind(*reason)
        .bind(crate::js_slice(error, 500))
        .bind(ts(now))
        .fetch_optional(db)
        .await?;
        if let Some(updated) = updated.map(weldsuite_db::js_row) {
            deps.events.emit(ReachEvent::new(
                REACH_MAILBOX_UPDATED,
                text_or_empty(&updated, "id"),
                mailbox_event(&updated),
            ));
        }
    }
    // The patches are the only place an enrollment changes; a reply that
    // arrived meanwhile (no longer `active`) is never overwritten.
    let updates: Vec<_> = applied
        .patches
        .iter()
        .map(|(id, patch)| {
            sqlx::query(
                "update reach_enrollments set
                 status = coalesce($2, status),
                 current_step = coalesce($3, current_step),
                 mailbox_id = coalesce($4, mailbox_id),
                 last_message_id = coalesce($5, last_message_id),
                 thread_root_message_id = case when $6 then $7 else thread_root_message_id end,
                 next_send_at = case when $8 then $9::timestamptz else next_send_at end,
                 stopped_reason = case when $10 then $11 else stopped_reason end,
                 claimed_at = null,
                 updated_at = $12::timestamptz
             where id = $1 and status = 'active'",
            )
            .bind(id)
            .bind(&patch.status)
            .bind(patch.current_step.map(|n| n as i32))
            .bind(&patch.mailbox_id)
            .bind(&patch.last_message_id)
            .bind(patch.thread_root_message_id.is_some())
            .bind(patch.thread_root_message_id.clone().flatten())
            .bind(patch.next_send_at.is_some())
            .bind(patch.next_send_at.flatten().map(ts))
            .bind(patch.stopped_reason.is_some())
            .bind(patch.stopped_reason.clone().flatten())
            .bind(ts(now))
            .execute(db)
        })
        .collect();
    let updates = futures_util::stream::iter(updates)
        .buffer_unordered(SEND_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    for update in updates {
        update?;
    }
    for (campaign_id, sent, bounced) in &applied.stats {
        add_to_stats(db, campaign_id, &[("sent", *sent), ("bounced", *bounced)]).await?;
    }
    for (mailbox_id, campaign_id) in &applied.bounced {
        record_hard_bounce(
            db,
            Some(mailbox_id),
            Some(campaign_id),
            deps.events,
            from_epoch_ms(now),
        )
        .await?;
    }
    Ok(())
}

/// `finishTick(state, retryAt)`: complete finished campaigns, then when
/// the workspace next has work.
async fn finish_tick(
    deps: &TickDeps<'_>,
    state: &TickState,
    retry_at: Option<i64>,
) -> ReachResult<Option<i64>> {
    let db = deps.db;
    complete_and_publish(db, deps.events, &state.campaign_order).await?;
    let earliest: Option<String> = sqlx::query_scalar(
        "select to_char(min(e.next_send_at) at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
         from reach_enrollments e join reach_campaigns c on c.id = e.campaign_id
         where e.status = 'active' and c.status = 'active' and c.deleted_at is null and e.next_send_at is not null",
    )
    .fetch_one(db)
    .await?;
    let Some(earliest) = earliest.as_deref().and_then(parse_iso).map(epoch_ms) else {
        return Ok(None);
    };
    let now = state.now;
    if earliest > now {
        return Ok(Some(earliest));
    }
    // Something is due but could not go out this tick.
    let Some(retry_at) = retry_at else {
        return Ok(Some(now + MIN_RETRY_MS));
    };
    let floor = now + RETRY_FLOOR_MS;
    Ok(Some(retry_at.max(floor)))
}

/// `runSendTick(deps)`.
pub async fn run_send_tick(deps: &TickDeps<'_>) -> ReachResult<TickResult> {
    let db = deps.db;
    let now = epoch_ms((deps.clock)());
    let mut tally = TickResult::default();
    mark_stuck_sending_messages(db, now).await?;
    let campaign_rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_campaigns t where t.status = 'active' and t.deleted_at is null",
    )
    .fetch_all(db)
    .await?;
    if campaign_rows.is_empty() {
        return Ok(tally);
    }
    let campaign_rows: Vec<Value> = campaign_rows
        .into_iter()
        .map(weldsuite_db::js_row)
        .collect();
    let state = load_state(deps, now, campaign_rows).await?;
    let (open, readiness) = defer_unsendable(db, &state).await?;
    let claimed = claim_due(db, &state, &open, &readiness).await?;
    tally.claimed = claimed.len() as i64;

    let mut retry_at = readiness.gap_blocked_until;
    if !claimed.is_empty() {
        let mut t = triage(db, &state, deps.limits, &claimed, &mut tally).await?;
        let to_plan: Vec<PlanEnrollment> = t
            .to_plan
            .iter()
            .map(|e| PlanEnrollment {
                id: text_or_empty(e, "id").to_owned(),
                campaign_id: text_or_empty(e, "campaignId").to_owned(),
                mailbox_id: text(e, "mailboxId").map(str::to_owned),
            })
            .collect();
        let plan = plan_sends(
            &state.ctx,
            &state.plan_campaigns,
            &state.plan_mailboxes,
            &to_plan,
        );
        for d in &plan.deferrals {
            set_patch(&mut t.patches, &d.enrollment_id, put_back(d.until));
            tally.deferred += 1;
        }
        let runs = execute_sends(deps, &state, &plan.sends, &claimed, &t).await;
        let applied = apply_outcomes(db, &state, runs, t, &mut tally).await?;
        persist(deps, now, &applied).await?;
        retry_at = [
            retry_at,
            plan.retry_at,
            applied.retry_soon.then_some(now + MIN_RETRY_MS),
        ]
        .into_iter()
        .flatten()
        .min();
    }
    tally.next_due_at = finish_tick(deps, &state, retry_at)
        .await?
        .map(from_epoch_ms);
    Ok(tally)
}
