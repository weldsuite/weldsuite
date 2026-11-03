//! `services/scheduler.ts`: who sends what, and when. The pure planning half
//! of the send engine (no database, no clock of its own):
//!
//! - a mailbox sends at most one email per tick, only while `active`, only
//!   under min(ramp, daily cap), and only after its minimum gap (plus a
//!   stable 0-50 % jitter) since the previous send;
//! - a campaign sends only inside its window, on its send days, up to its
//!   daily limit; the workspace has one `maxDailySends` across campaigns;
//! - a prospect's first email picks the campaign mailbox with the most
//!   capacity left today, and that mailbox is sticky for the sequence.
//!
//! Times are epoch milliseconds, as JavaScript's `Date#getTime()`.

use std::collections::{HashMap, HashSet};

use crate::send_window::{SendSchedule, snap_into_window_ms, start_of_next_zoned_day};
use crate::{epoch_ms, from_epoch_ms};

pub const MINUTE_MS: i64 = 60_000;
pub const HOUR_MS: i64 = 60 * MINUTE_MS;
/// How long a claim on an enrollment holds before another tick may take it.
pub const CLAIM_STALE_MS: i64 = 10 * MINUTE_MS;
/// An outbound row still `sending` after this long belongs to a crashed send.
pub const STUCK_SENDING_MS: i64 = 15 * MINUTE_MS;
/// Retry after a temporary SMTP error.
pub const TEMPORARY_RETRY_MS: i64 = 15 * MINUTE_MS;
/// Retry when a mailbox is unusable (paused, in error, deleted).
pub const UNAVAILABLE_RETRY_MS: i64 = HOUR_MS;
/// The smallest wait between two ticks of one workspace.
pub const MIN_RETRY_MS: i64 = MINUTE_MS;

/// FNV-1a, 32 bit, over UTF-16 code units (`charCodeAt`).
fn hash32(text: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for unit in text.encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// `jitterFraction(seed)`: 0..0.5 of the gap, stable for one previous send.
pub fn jitter_fraction(seed: &str) -> f64 {
    f64::from(hash32(seed) % 51) / 100.0
}

/// `PlanMailbox`.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanMailbox {
    pub id: String,
    pub status: String,
    pub daily_cap: i64,
    pub ramp_current: i64,
    /// Epoch ms of the last send.
    pub last_sent_at: Option<i64>,
    /// Outbound emails from this mailbox since the start of today.
    pub sent_today: i64,
}

/// `mailboxCapacity(m)`.
pub fn mailbox_capacity(m: &PlanMailbox) -> i64 {
    (m.ramp_current.min(m.daily_cap) - m.sent_today).max(0)
}

/// `gapEndsAt(m, minGapMinutes)`: `None` when the mailbox never sent.
pub fn gap_ends_at(m: &PlanMailbox, min_gap_minutes: i64) -> Option<i64> {
    let last = m.last_sent_at?;
    let jitter = jitter_fraction(&format!("{}:{last}", m.id));
    // `new Date(last + gap * MINUTE_MS * (1 + jitter))` truncates.
    let gap = (min_gap_minutes as f64 * MINUTE_MS as f64) * (1.0 + jitter);
    Some((last as f64 + gap).trunc() as i64)
}

/// `isGapOver(m, minGapMinutes, now)`.
pub fn is_gap_over(m: &PlanMailbox, min_gap_minutes: i64, now: i64) -> bool {
    gap_ends_at(m, min_gap_minutes).is_none_or(|end| end <= now)
}

/// `PlanCampaign`.
#[derive(Debug, Clone)]
pub struct PlanCampaign {
    pub id: String,
    pub schedule: SendSchedule,
    pub daily_limit: i64,
    pub min_gap_minutes: i64,
    /// Outbound campaign emails since the start of today.
    pub sent_today: i64,
    /// Mailboxes assigned to the campaign, in link order.
    pub mailbox_ids: Vec<String>,
}

/// `PlanContext`.
#[derive(Debug, Clone)]
pub struct PlanContext {
    pub now: i64,
    /// The zone where "today" starts (the workspace default timezone).
    pub day_timezone: String,
    pub max_daily_sends: i64,
    /// Outbound emails of every kind since the start of today.
    pub workspace_sent_today: i64,
}

/// `nextDayWindowStart(campaign, ctx)`.
pub fn next_day_window_start(campaign: &PlanCampaign, ctx: &PlanContext) -> i64 {
    let tomorrow = start_of_next_zoned_day(from_epoch_ms(ctx.now), &ctx.day_timezone);
    snap_into_window_ms(epoch_ms(tomorrow), &campaign.schedule)
}

/// `CampaignGate`: open, or closed for a reason until a time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CampaignGate {
    Open,
    Closed {
        reason: &'static str,
        reopens_at: i64,
    },
}

/// `evaluateCampaignGate(campaign, ctx)`.
pub fn evaluate_campaign_gate(campaign: &PlanCampaign, ctx: &PlanContext) -> CampaignGate {
    if ctx.workspace_sent_today >= ctx.max_daily_sends {
        return CampaignGate::Closed {
            reason: "workspace_limit",
            reopens_at: next_day_window_start(campaign, ctx),
        };
    }
    let snapped = snap_into_window_ms(ctx.now, &campaign.schedule);
    if snapped != ctx.now {
        return CampaignGate::Closed {
            reason: "window",
            reopens_at: snapped,
        };
    }
    if campaign.sent_today >= campaign.daily_limit {
        return CampaignGate::Closed {
            reason: "daily_limit",
            reopens_at: next_day_window_start(campaign, ctx),
        };
    }
    CampaignGate::Open
}

/// `Readiness`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Readiness {
    /// Mailboxes that could send right now: usable, under cap, gap over.
    pub ready: HashSet<String>,
    /// The earliest end of a gap among active, under-cap mailboxes.
    pub gap_blocked_until: Option<i64>,
    /// Mailboxes that are not `active`.
    pub unusable: HashSet<String>,
    /// `active` mailboxes with no capacity left today.
    pub capped: HashSet<String>,
}

/// `assessMailboxes(mailboxes, openCampaigns, now)`: judged with the
/// smallest gap of the open campaigns.
pub fn assess_mailboxes<'a>(
    mailboxes: impl IntoIterator<Item = &'a PlanMailbox>,
    open: &[&PlanCampaign],
    now: i64,
) -> Readiness {
    let floor_gap = open.iter().map(|c| c.min_gap_minutes).min().unwrap_or(0);
    let mut out = Readiness::default();
    for m in mailboxes {
        if m.status != "active" {
            out.unusable.insert(m.id.clone());
        } else if mailbox_capacity(m) <= 0 {
            out.capped.insert(m.id.clone());
        } else if is_gap_over(m, floor_gap, now) {
            out.ready.insert(m.id.clone());
        } else if let Some(ends) = gap_ends_at(m, floor_gap)
            && out.gap_blocked_until.is_none_or(|current| ends < current)
        {
            out.gap_blocked_until = Some(ends);
        }
    }
    out
}

/// `PlanEnrollment`.
#[derive(Debug, Clone)]
pub struct PlanEnrollment {
    pub id: String,
    pub campaign_id: String,
    /// The sticky sender; `None` until the first email.
    pub mailbox_id: Option<String>,
}

/// `PlannedSend`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedSend {
    pub enrollment_id: String,
    pub campaign_id: String,
    pub mailbox_id: String,
}

/// `PlannedDeferral`: `until` `None` keeps `next_send_at` (only un-claims).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedDeferral {
    pub enrollment_id: String,
    pub until: Option<i64>,
    pub reason: &'static str,
}

/// `TickPlan`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TickPlan {
    pub sends: Vec<PlannedSend>,
    pub deferrals: Vec<PlannedDeferral>,
    /// The earliest a deferred-but-still-due enrollment could be sent.
    pub retry_at: Option<i64>,
}

struct PlanRun<'a> {
    ctx: &'a PlanContext,
    mailboxes: &'a HashMap<String, PlanMailbox>,
    plan: TickPlan,
    used: HashSet<String>,
    campaign_remaining: HashMap<String, i64>,
    workspace_remaining: i64,
    in_an_hour: i64,
    in_a_minute: i64,
}

impl PlanRun<'_> {
    fn defer(&mut self, e: &PlanEnrollment, until: Option<i64>, reason: &'static str) {
        self.plan.deferrals.push(PlannedDeferral {
            enrollment_id: e.id.clone(),
            until,
            reason,
        });
    }

    fn retry_soon(&mut self, at: i64) {
        self.plan.retry_at = Some(match self.plan.retry_at {
            Some(current) if current <= at => current,
            _ => at,
        });
    }
}

/// `compareReadiness`: most capacity left first, then the longest rested,
/// then the id (`localeCompare`; ids are lower-case ASCII).
fn compare_readiness(a: &PlanMailbox, b: &PlanMailbox) -> std::cmp::Ordering {
    mailbox_capacity(b)
        .cmp(&mailbox_capacity(a))
        .then_with(|| {
            a.last_sent_at
                .unwrap_or(0)
                .cmp(&b.last_sent_at.unwrap_or(0))
        })
        .then_with(|| a.id.cmp(&b.id))
}

/// `pickStickyMailbox`.
fn pick_sticky<'m>(
    run: &mut PlanRun<'m>,
    e: &PlanEnrollment,
    mailbox_id: &str,
    campaign: &PlanCampaign,
) -> Option<&'m PlanMailbox> {
    let mailboxes = run.mailboxes;
    let Some(m) = mailboxes.get(mailbox_id).filter(|m| m.status == "active") else {
        let at = run.in_an_hour;
        run.defer(e, Some(at), "mailbox_unavailable");
        return None;
    };
    if mailbox_capacity(m) <= 0 {
        let at = next_day_window_start(campaign, run.ctx);
        run.defer(e, Some(at), "mailbox_capacity");
        return None;
    }
    if run.used.contains(&m.id) {
        run.defer(e, None, "mailbox_busy");
        let at = run.in_a_minute;
        run.retry_soon(at);
        return None;
    }
    if let Some(ends) = gap_ends_at(m, campaign.min_gap_minutes)
        && ends > run.ctx.now
    {
        run.defer(e, None, "mailbox_gap");
        run.retry_soon(ends);
        return None;
    }
    Some(m)
}

/// `pickFirstMailbox`.
fn pick_first<'m>(
    run: &mut PlanRun<'m>,
    e: &PlanEnrollment,
    campaign: &PlanCampaign,
) -> Option<&'m PlanMailbox> {
    let mailboxes = run.mailboxes;
    let usable: Vec<&PlanMailbox> = campaign
        .mailbox_ids
        .iter()
        .filter_map(|id| mailboxes.get(id))
        .filter(|m| m.status == "active")
        .collect();
    if usable.is_empty() {
        let at = run.in_an_hour;
        run.defer(e, Some(at), "no_mailbox");
        return None;
    }
    let with_capacity: Vec<&PlanMailbox> = usable
        .into_iter()
        .filter(|m| mailbox_capacity(m) > 0)
        .collect();
    if with_capacity.is_empty() {
        let at = next_day_window_start(campaign, run.ctx);
        run.defer(e, Some(at), "mailbox_capacity");
        return None;
    }
    let free: Vec<&PlanMailbox> = with_capacity
        .into_iter()
        .filter(|m| !run.used.contains(&m.id))
        .collect();
    if free.is_empty() {
        run.defer(e, None, "mailbox_busy");
        let at = run.in_a_minute;
        run.retry_soon(at);
        return None;
    }
    let now = run.ctx.now;
    let mut ready: Vec<&PlanMailbox> = free
        .iter()
        .copied()
        .filter(|m| is_gap_over(m, campaign.min_gap_minutes, now))
        .collect();
    if ready.is_empty() {
        run.defer(e, None, "mailbox_gap");
        for m in &free {
            if let Some(ends) = gap_ends_at(m, campaign.min_gap_minutes) {
                run.retry_soon(ends);
            }
        }
        return None;
    }
    ready.sort_by(|a, b| compare_readiness(a, b));
    ready.first().copied()
}

fn plan_enrollment(
    run: &mut PlanRun<'_>,
    campaigns: &HashMap<String, PlanCampaign>,
    e: &PlanEnrollment,
) {
    let Some(campaign) = campaigns.get(&e.campaign_id) else {
        run.defer(e, None, "campaign_inactive");
        return;
    };
    run.campaign_remaining
        .entry(campaign.id.clone())
        .or_insert_with(|| (campaign.daily_limit - campaign.sent_today).max(0));
    if run.workspace_remaining <= 0 {
        let at = next_day_window_start(campaign, run.ctx);
        run.defer(e, Some(at), "workspace_limit");
        return;
    }
    if run
        .campaign_remaining
        .get(&campaign.id)
        .copied()
        .unwrap_or(0)
        <= 0
    {
        let at = next_day_window_start(campaign, run.ctx);
        run.defer(e, Some(at), "campaign_limit");
        return;
    }
    let chosen = match &e.mailbox_id {
        Some(mailbox_id) => pick_sticky(run, e, mailbox_id, campaign),
        None => pick_first(run, e, campaign),
    };
    let Some(chosen) = chosen else {
        return;
    };
    run.used.insert(chosen.id.clone());
    run.workspace_remaining -= 1;
    let remaining = run
        .campaign_remaining
        .get(&campaign.id)
        .copied()
        .unwrap_or(1);
    run.campaign_remaining
        .insert(campaign.id.clone(), remaining - 1);
    run.plan.sends.push(PlannedSend {
        enrollment_id: e.id.clone(),
        campaign_id: campaign.id.clone(),
        mailbox_id: chosen.id.clone(),
    });
}

/// `planSends(ctx, campaigns, mailboxes, claimed)`: which claimed
/// enrollments (oldest due first) send from which mailbox, and which wait.
#[allow(
    clippy::implicit_hasher,
    reason = "the tick builds both maps with the default hasher"
)]
pub fn plan_sends(
    ctx: &PlanContext,
    campaigns: &HashMap<String, PlanCampaign>,
    mailboxes: &HashMap<String, PlanMailbox>,
    claimed: &[PlanEnrollment],
) -> TickPlan {
    let mut run = PlanRun {
        ctx,
        mailboxes,
        plan: TickPlan::default(),
        used: HashSet::new(),
        campaign_remaining: HashMap::new(),
        workspace_remaining: (ctx.max_daily_sends - ctx.workspace_sent_today).max(0),
        in_an_hour: ctx.now + UNAVAILABLE_RETRY_MS,
        in_a_minute: ctx.now + MIN_RETRY_MS,
    };
    for e in claimed {
        plan_enrollment(&mut run, campaigns, e);
    }
    run.plan
}

/// `nextStepDueAt(sentAt, next, schedule)`: the delay after `sent_at`,
/// moved into the campaign window.
pub fn next_step_due_at(
    sent_at: i64,
    delay_days: i64,
    delay_hours: i64,
    schedule: &SendSchedule,
) -> i64 {
    let delay = delay_days * 24 * HOUR_MS + delay_hours * HOUR_MS;
    snap_into_window_ms(sent_at + delay, schedule)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jitter_is_stable_and_bounded() {
        let a = jitter_fraction("rmbx_1:1760263200000");
        assert_eq!(a, jitter_fraction("rmbx_1:1760263200000"));
        assert!((0.0..=0.5).contains(&a));
    }

    #[test]
    fn capacity_and_gap() {
        let m = PlanMailbox {
            id: "rmbx_1".to_owned(),
            status: "active".to_owned(),
            daily_cap: 30,
            ramp_current: 10,
            last_sent_at: Some(1_000_000),
            sent_today: 4,
        };
        assert_eq!(mailbox_capacity(&m), 6);
        let end = gap_ends_at(&m, 8).expect("a gap");
        assert!((1_000_000 + 8 * MINUTE_MS..=1_000_000 + 12 * MINUTE_MS).contains(&end));
        assert!(!is_gap_over(&m, 8, end - 1));
        assert!(is_gap_over(&m, 8, end));
    }
}
