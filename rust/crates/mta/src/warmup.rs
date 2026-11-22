//! The per-IP warm-up (ADR MAIL-011). Receivers judge a new address by its
//! history, so each source IP has a daily cap that rises one step at a time
//! along `MTA_WARMUP_SCHEDULE` (50, 100, 200, … 50,000 by default), with no
//! cap after the last step.
//!
//! **An IP moves to the next step only after a UTC day on which it sent at
//! least `MTA_WARMUP_ADVANCE_PERCENT` (default 50) of that step's cap.** A
//! day with less mail, or none, neither advances it nor undoes a step, and
//! no day advances it more than one step. The cap therefore rises only once
//! the IP has shown the receivers the volume under it: an address that
//! sends a handful a day stays at the first step however old it is, and one
//! with a backlog moves up a step a day.
//!
//! The step is not stored. It is worked out from the IP's daily counts
//! (`mta_ip_usage`, one row per IP and UTC day) of the last
//! [`HISTORY_DAYS`] days, walked oldest first; housekeeping drops older
//! rows. So an IP whose volume falls for two months comes back down to the
//! step its recent days earn, as an address that goes quiet goes cold at
//! the receivers too.

use std::fmt::Write as _;

/// The days of counts the step is worked out from (and housekeeping keeps).
pub const HISTORY_DAYS: i32 = 60;

/// `MTA_WARMUP_ADVANCE_PERCENT` when unset.
pub const DEFAULT_ADVANCE_PERCENT: u32 = 50;

/// How an IP warms up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Warmup {
    /// The daily cap of each step; empty: no warm-up, no cap.
    pub schedule: Vec<u32>,
    /// The share of a step's cap, in percent (1 to 100), that one day must
    /// send for the IP to move to the next step.
    pub advance_percent: u32,
}

/// One UTC day's count of an IP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaySent {
    /// 0 today, 1 yesterday, …
    pub days_ago: u32,
    /// `YYYY-MM-DD`.
    pub day: String,
    pub sent: u32,
}

/// Where an IP stands today.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IpState {
    /// 0-based; the schedule's length once past its last step.
    pub step: usize,
    /// The past day that earned the current step; `None` at the first.
    pub earned_on: Option<DaySent>,
    pub sent_today: u32,
}

impl IpState {
    /// The current step started today: yesterday earned it.
    pub fn advanced_today(&self) -> bool {
        self.earned_on.as_ref().is_some_and(|day| day.days_ago == 1)
    }
}

impl Warmup {
    /// No warm-up (`MTA_WARMUP_SCHEDULE=off`).
    pub fn off() -> Self {
        Self {
            schedule: Vec::new(),
            advance_percent: DEFAULT_ADVANCE_PERCENT,
        }
    }

    pub fn is_off(&self) -> bool {
        self.schedule.is_empty()
    }

    pub fn steps(&self) -> usize {
        self.schedule.len()
    }

    /// The daily cap at `step`; `None` past the last step (no cap).
    pub fn cap(&self, step: usize) -> Option<u32> {
        self.schedule.get(step).copied()
    }

    /// What one day at `step` must send for the next step: the advance share
    /// of the cap, rounded up, at least 1. `None` past the last step.
    pub fn threshold(&self, step: usize) -> Option<u32> {
        let cap = self.cap(step)?;
        let share = (u64::from(cap) * u64::from(self.advance_percent.clamp(1, 100))).div_ceil(100);
        Some(u32::try_from(share).unwrap_or(cap).max(1))
    }

    /// The IP's step from its daily counts, oldest first (days without a
    /// count are days without mail). Today's count is reported, never
    /// walked: today can earn tomorrow's step, not today's.
    pub fn state(&self, history: &[DaySent]) -> IpState {
        let mut state = IpState {
            step: 0,
            earned_on: None,
            sent_today: 0,
        };
        for day in history {
            if day.days_ago == 0 {
                state.sent_today = state.sent_today.saturating_add(day.sent);
                continue;
            }
            if self
                .threshold(state.step)
                .is_some_and(|needed| day.sent >= needed)
            {
                state.step += 1;
                state.earned_on = Some(day.clone());
            }
        }
        state
    }

    /// One IP's state for the operator (`weldsuite mta warmup`): step,
    /// today's cap, sent today, what it takes to advance, and its recent
    /// days.
    pub fn report(&self, ip: &str, first_day: Option<&str>, history: &[DaySent]) -> String {
        let state = self.state(history);
        let steps = self.steps();
        let mut out = String::new();
        let _ = writeln!(
            out,
            "{ip}{}",
            first_day.map_or_else(String::new, |day| format!("  (first send {day})"))
        );
        let since = state.earned_on.as_ref().map_or_else(String::new, |day| {
            format!(", earned on {} ({} sent)", day.day, day.sent)
        });
        if let Some(cap) = self.cap(state.step) {
            let _ = writeln!(out, "  step        {} of {steps}{since}", state.step + 1);
            let _ = writeln!(out, "  cap today   {cap}");
            let over = state.sent_today.saturating_sub(cap);
            let _ = writeln!(
                out,
                "  sent today  {}{}",
                state.sent_today,
                if over > 0 {
                    format!(" ({over} over the cap: a soft pool)")
                } else {
                    String::new()
                }
            );
            let needed = self.threshold(state.step).unwrap_or(cap);
            let next = self
                .cap(state.step + 1)
                .map_or_else(|| "no cap".to_owned(), |next| format!("a cap of {next}"));
            if state.sent_today >= needed {
                let _ = writeln!(
                    out,
                    "  to advance  done today ({needed} needed): {next} from tomorrow (UTC)"
                );
            } else {
                let _ = writeln!(
                    out,
                    "  to advance  send {needed} in one UTC day ({} more today): then {next}",
                    needed - state.sent_today
                );
            }
        } else {
            let _ = writeln!(out, "  step        warmed up (all {steps} steps){since}");
            let _ = writeln!(out, "  cap today   none");
            let _ = writeln!(out, "  sent today  {}", state.sent_today);
        }
        let recent: Vec<String> = history
            .iter()
            .filter(|day| day.days_ago > 0)
            .rev()
            .take(7)
            .map(|day| format!("{} {}", day.day, day.sent))
            .collect();
        let _ = writeln!(
            out,
            "  last days   {}",
            if recent.is_empty() {
                "no mail".to_owned()
            } else {
                recent.join(", ")
            }
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warmup() -> Warmup {
        Warmup {
            schedule: vec![50, 100, 200],
            advance_percent: 50,
        }
    }

    fn day(days_ago: u32, sent: u32) -> DaySent {
        DaySent {
            days_ago,
            day: format!("2026-11-{:02}", 20 - days_ago),
            sent,
        }
    }

    #[test]
    fn caps_and_thresholds() {
        let w = warmup();
        assert_eq!(w.cap(0), Some(50));
        assert_eq!(w.cap(2), Some(200));
        assert_eq!(w.cap(3), None);
        assert_eq!(w.threshold(0), Some(25));
        assert_eq!(w.threshold(1), Some(50));
        assert_eq!(w.threshold(3), None);
        // Rounded up, never 0.
        let odd = Warmup {
            schedule: vec![1, 3],
            advance_percent: 50,
        };
        assert_eq!(odd.threshold(0), Some(1));
        assert_eq!(odd.threshold(1), Some(2));
        let full = Warmup {
            schedule: vec![50],
            advance_percent: 100,
        };
        assert_eq!(full.threshold(0), Some(50));
        assert!(Warmup::off().is_off());
        assert_eq!(Warmup::off().cap(0), None);
    }

    #[test]
    fn no_history_is_the_first_step() {
        let state = warmup().state(&[]);
        assert_eq!(state.step, 0);
        assert_eq!(state.earned_on, None);
        assert_eq!(state.sent_today, 0);
        assert!(!state.advanced_today());
    }

    #[test]
    fn days_below_the_share_do_not_advance() {
        // Production on 2026-11-20: 1 to 9 a day for eight days.
        let history: Vec<DaySent> = (1..=8).rev().map(|ago| day(ago, ago + 1)).collect();
        let state = warmup().state(&history);
        assert_eq!(state.step, 0);
        assert_eq!(warmup().cap(state.step), Some(50));
        // 24 of 50 is just under half.
        assert_eq!(warmup().state(&[day(1, 24)]).step, 0);
    }

    #[test]
    fn a_day_at_the_share_advances_one_step() {
        let state = warmup().state(&[day(3, 25)]);
        assert_eq!(state.step, 1);
        assert_eq!(state.earned_on, Some(day(3, 25)));
        assert!(!state.advanced_today());
        // A day far over the threshold still moves one step only.
        assert_eq!(warmup().state(&[day(2, 5_000)]).step, 1);
        // Yesterday earned it: the step starts today.
        assert!(warmup().state(&[day(1, 30)]).advanced_today());
    }

    #[test]
    fn each_step_needs_its_own_share() {
        // 30 earns step 2 (cap 100); 30 again is under 50 and doesn't.
        let state = warmup().state(&[day(3, 30), day(2, 30), day(1, 50)]);
        assert_eq!(state.step, 2);
        assert_eq!(state.earned_on, Some(day(1, 50)));
    }

    #[test]
    fn gap_days_neither_advance_nor_reset() {
        // No row for days 9 to 2: no mail then.
        let state = warmup().state(&[day(10, 25), day(1, 3)]);
        assert_eq!(state.step, 1);
        assert_eq!(state.earned_on, Some(day(10, 25)));
        let state = warmup().state(&[day(10, 25), day(5, 0), day(1, 50)]);
        assert_eq!(state.step, 2);
    }

    #[test]
    fn past_the_last_step_there_is_no_cap() {
        let state = warmup().state(&[day(4, 25), day(3, 50), day(2, 100), day(1, 7)]);
        assert_eq!(state.step, 3);
        assert_eq!(warmup().cap(state.step), None);
        assert_eq!(warmup().threshold(state.step), None);
    }

    #[test]
    fn today_counts_for_tomorrow_only() {
        let state = warmup().state(&[day(1, 3), day(0, 40)]);
        assert_eq!(state.step, 0);
        assert_eq!(state.sent_today, 40);
    }

    #[test]
    fn reports_what_it_takes_to_advance() {
        let w = warmup();
        let report = w.report("203.0.113.7", Some("2026-11-12"), &[day(1, 9), day(0, 4)]);
        assert!(
            report.contains("203.0.113.7  (first send 2026-11-12)"),
            "{report}"
        );
        assert!(report.contains("step        1 of 3\n"), "{report}");
        assert!(report.contains("cap today   50\n"), "{report}");
        assert!(report.contains("sent today  4\n"), "{report}");
        assert!(
            report.contains("send 25 in one UTC day (21 more today): then a cap of 100"),
            "{report}"
        );
        assert!(report.contains("last days   2026-11-19 9"), "{report}");

        let report = w.report("203.0.113.7", None, &[day(2, 25), day(0, 60)]);
        assert!(
            report.contains("step        2 of 3, earned on 2026-11-18 (25 sent)"),
            "{report}"
        );
        assert!(
            report.contains("done today (50 needed): a cap of 200 from tomorrow"),
            "{report}"
        );

        let report = w.report("203.0.113.7", None, &[day(1, 80)]);
        assert!(report.contains("sent today  0\n"), "{report}");

        let over = w.report("203.0.113.7", None, &[day(0, 70)]);
        assert!(over.contains("sent today  70 (20 over the cap"), "{over}");

        let done = w.report("203.0.113.7", None, &[day(3, 25), day(2, 50), day(1, 100)]);
        assert!(done.contains("warmed up (all 3 steps)"), "{done}");
        assert!(done.contains("cap today   none"), "{done}");

        let quiet = w.report("203.0.113.7", None, &[]);
        assert!(quiet.contains("last days   no mail"), "{quiet}");
    }
}
