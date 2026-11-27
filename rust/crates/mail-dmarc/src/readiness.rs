//! When a domain is ready for a stricter DMARC policy (ADR MAIL-015,
//! phase 4 of the plan), worked out from authenticated reports only.
//!
//! Ready for `p=quarantine` when, over the window (the last 30 days):
//!
//! - reports came on at least [`MIN_DAYS`] different days, from at least
//!   [`MIN_REPORTERS`] reporters;
//! - at least 98% of the messages passed DMARC, leaving out the sources the
//!   customer marked "not mine";
//! - WeldSuite's own mail passed at least 99.5%;
//! - no unmarked source that sends 1% or more of the mail fails.
//!
//! Ready for `p=reject` after [`REJECT_AFTER_DAYS`] days of reports at
//! `quarantine` that meet the same bar. Advice only: WeldSuite never edits
//! a customer's DNS.

use serde::Serialize;

use crate::record::{Inspection, Record, RecordState};
use crate::sources;

pub const MIN_DAYS: u32 = 14;
pub const MIN_REPORTERS: u32 = 2;
/// Per mille of messages that must pass.
pub const MIN_PASS_PERMILLE: u64 = 980;
pub const MIN_WELDSUITE_PASS_PERMILLE: u64 = 995;
/// A source this share (per mille) of the mail or more must pass, or be
/// marked.
pub const SOURCE_SHARE_PERMILLE: u64 = 10;
pub const REJECT_AFTER_DAYS: u32 = 30;
/// Failing sources named at most.
const MAX_SOURCE_BLOCKERS: usize = 5;

/// What the customer said about a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mark {
    Mine,
    NotMine,
}

impl Mark {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "mine" => Some(Self::Mine),
            "not_mine" => Some(Self::NotMine),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mine => "mine",
            Self::NotMine => "not_mine",
        }
    }
}

/// One source's messages over the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceStat {
    pub key: String,
    pub messages: u64,
    pub passed: u64,
    pub mark: Option<Mark>,
}

/// The authenticated reports of the window, summed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Window {
    /// Distinct UTC days the reports cover.
    pub days_with_reports: u32,
    /// Distinct reporters.
    pub reporters: u32,
    pub sources: Vec<SourceStat>,
    /// Days the reports have shown the current policy without a break,
    /// counted back from the newest.
    pub days_at_policy: u32,
}

/// What stands in the way of the next step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Blocker {
    /// The record is missing, doubled or unusable: fix it first.
    RecordProblem {
        state: String,
    },
    /// No authenticated report yet.
    NoReports,
    TooFewDays {
        have: u32,
        need: u32,
    },
    TooFewReporters {
        have: u32,
        need: u32,
    },
    PassRate {
        permille: u64,
        need: u64,
    },
    WeldsuiteFailing {
        permille: u64,
        need: u64,
    },
    /// An unmarked source with a real share of the mail fails DMARC.
    FailingSource {
        key: String,
        name: String,
        share_permille: u64,
        pass_permille: u64,
    },
    /// Not long enough at `quarantine` to go to `reject`.
    TooSoon {
        days: u32,
        need: u32,
    },
}

/// The advice for a domain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Advice {
    /// The published policy, when the record is usable.
    pub current: Option<String>,
    /// The next step, `quarantine` or `reject`; none at `reject`.
    pub next: Option<String>,
    pub ready: bool,
    pub blockers: Vec<Blocker>,
    /// The record to publish for the next step.
    pub suggested_record: Option<String>,
}

fn permille(part: u64, whole: u64) -> u64 {
    if whole == 0 {
        return 1000;
    }
    part.saturating_mul(1000) / whole
}

/// The advice for a domain whose record is `inspection`.
pub fn advise(inspection: &Inspection, window: &Window) -> Advice {
    let Some(policy) = inspection
        .policy
        .as_ref()
        .filter(|_| inspection.state == RecordState::Ok)
    else {
        return Advice {
            current: None,
            next: None,
            ready: false,
            blockers: vec![Blocker::RecordProblem {
                state: inspection.state.as_str().to_owned(),
            }],
            suggested_record: None,
        };
    };
    let next = match policy.p.as_str() {
        "none" => "quarantine",
        "quarantine" => "reject",
        _ => {
            return Advice {
                current: Some(policy.p.clone()),
                next: None,
                ready: false,
                blockers: Vec::new(),
                suggested_record: None,
            };
        }
    };
    let mut blockers = window_blockers(window);
    if next == "reject" && window.days_at_policy < REJECT_AFTER_DAYS {
        blockers.push(Blocker::TooSoon {
            days: window.days_at_policy,
            need: REJECT_AFTER_DAYS,
        });
    }
    let suggested_record = inspection
        .found
        .first()
        .and_then(|text| Record::parse(text))
        .map(|record| record.with_policy(next).render());
    Advice {
        current: Some(policy.p.clone()),
        next: Some(next.to_owned()),
        ready: blockers.is_empty(),
        blockers,
        suggested_record,
    }
}

/// What the reports of the window say against a stricter policy.
fn window_blockers(window: &Window) -> Vec<Blocker> {
    let mut blockers = Vec::new();
    let total: u64 = window.sources.iter().map(|s| s.messages).sum();
    if total == 0 {
        blockers.push(Blocker::NoReports);
    } else {
        if window.days_with_reports < MIN_DAYS {
            blockers.push(Blocker::TooFewDays {
                have: window.days_with_reports,
                need: MIN_DAYS,
            });
        }
        if window.reporters < MIN_REPORTERS {
            blockers.push(Blocker::TooFewReporters {
                have: window.reporters,
                need: MIN_REPORTERS,
            });
        }
        let counted = window
            .sources
            .iter()
            .filter(|s| s.mark != Some(Mark::NotMine));
        let (messages, passed) = counted.fold((0, 0), |(m, p), s| (m + s.messages, p + s.passed));
        let rate = permille(passed, messages);
        if rate < MIN_PASS_PERMILLE {
            blockers.push(Blocker::PassRate {
                permille: rate,
                need: MIN_PASS_PERMILLE,
            });
        }
        let ours = window
            .sources
            .iter()
            .filter(|s| sources::is_weldsuite(&s.key));
        let (messages, passed) = ours.fold((0, 0), |(m, p), s| (m + s.messages, p + s.passed));
        let rate = permille(passed, messages);
        if messages > 0 && rate < MIN_WELDSUITE_PASS_PERMILLE {
            blockers.push(Blocker::WeldsuiteFailing {
                permille: rate,
                need: MIN_WELDSUITE_PASS_PERMILLE,
            });
        }
        let mut failing: Vec<&SourceStat> = window
            .sources
            .iter()
            .filter(|s| {
                s.mark.is_none() && !sources::is_weldsuite(&s.key) && !sources::is_rest(&s.key)
            })
            .filter(|s| permille(s.messages, total) >= SOURCE_SHARE_PERMILLE)
            .filter(|s| permille(s.passed, s.messages) < MIN_PASS_PERMILLE)
            .collect();
        failing.sort_by(|a, b| b.messages.cmp(&a.messages).then_with(|| a.key.cmp(&b.key)));
        blockers.extend(failing.into_iter().take(MAX_SOURCE_BLOCKERS).map(|s| {
            Blocker::FailingSource {
                key: s.key.clone(),
                name: sources::label(&s.key).to_owned(),
                share_permille: permille(s.messages, total),
                pass_permille: permille(s.passed, s.messages),
            }
        }));
    }
    blockers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::inspect;

    fn record(text: &str) -> Inspection {
        inspect(&[text.to_owned()], None, crate::record::BASE_RECORD)
    }

    fn source(key: &str, messages: u64, passed: u64, mark: Option<Mark>) -> SourceStat {
        SourceStat {
            key: key.to_owned(),
            messages,
            passed,
            mark,
        }
    }

    fn healthy() -> Window {
        Window {
            days_with_reports: 20,
            reporters: 3,
            sources: vec![
                source("weldsuite:customer", 900, 900, None),
                source("name:google.com", 100, 99, None),
                source("ip:203.0.113.9", 5, 0, None),
            ],
            days_at_policy: 20,
        }
    }

    #[test]
    fn a_healthy_domain_is_ready_for_quarantine() {
        let advice = advise(&record("v=DMARC1; p=none; rua=mailto:a@x.test"), &healthy());
        assert!(advice.ready, "{advice:?}");
        assert_eq!(advice.next.as_deref(), Some("quarantine"));
        assert_eq!(
            advice.suggested_record.as_deref(),
            Some("v=DMARC1; p=quarantine; rua=mailto:a@x.test")
        );
    }

    #[test]
    fn a_failing_unmarked_source_blocks_until_marked() {
        let mut window = healthy();
        window
            .sources
            .push(source("name:mailchimp.test", 120, 10, None));
        let advice = advise(&record("v=DMARC1; p=none"), &window);
        assert!(!advice.ready);
        assert!(
            advice.blockers.iter().any(
                |b| matches!(b, Blocker::FailingSource { name, .. } if name == "mailchimp.test")
            )
        );
        window.sources.last_mut().expect("source").mark = Some(Mark::NotMine);
        assert!(advise(&record("v=DMARC1; p=none"), &window).ready);
    }

    #[test]
    fn weldsuite_failing_blocks() {
        let mut window = healthy();
        window.sources[0] = source("weldsuite:customer", 900, 800, None);
        let advice = advise(&record("v=DMARC1; p=none"), &window);
        assert!(
            advice
                .blockers
                .iter()
                .any(|b| matches!(b, Blocker::WeldsuiteFailing { .. }))
        );
    }

    #[test]
    fn reject_waits_thirty_days_at_quarantine() {
        let mut window = healthy();
        window.days_at_policy = 12;
        let advice = advise(&record("v=DMARC1; p=quarantine; pct=50"), &window);
        assert_eq!(advice.next.as_deref(), Some("reject"));
        assert_eq!(
            advice.blockers,
            vec![Blocker::TooSoon { days: 12, need: 30 }]
        );
        assert_eq!(
            advice.suggested_record.as_deref(),
            Some("v=DMARC1; p=reject")
        );
    }

    #[test]
    fn too_little_data_and_broken_records_say_so() {
        let empty = advise(&record("v=DMARC1; p=none"), &Window::default());
        assert_eq!(empty.blockers, vec![Blocker::NoReports]);
        let few = Window {
            days_with_reports: 3,
            reporters: 1,
            ..healthy()
        };
        let advice = advise(&record("v=DMARC1; p=none"), &few);
        assert!(
            advice
                .blockers
                .contains(&Blocker::TooFewDays { have: 3, need: 14 })
        );
        assert!(
            advice
                .blockers
                .contains(&Blocker::TooFewReporters { have: 1, need: 2 })
        );
        let doubled = inspect(
            &[
                "v=DMARC1; p=none".to_owned(),
                "v=DMARC1; p=reject".to_owned(),
            ],
            None,
            crate::record::BASE_RECORD,
        );
        assert_eq!(
            advise(&doubled, &healthy()).blockers,
            vec![Blocker::RecordProblem {
                state: "multiple".to_owned()
            }]
        );
        let done = advise(&record("v=DMARC1; p=reject"), &healthy());
        assert_eq!((done.next, done.ready), (None, false));
    }

    #[test]
    fn blockers_serialize_with_a_code() {
        let json = serde_json::to_value(Blocker::TooFewDays { have: 3, need: 14 }).expect("json");
        assert_eq!(
            json,
            serde_json::json!({ "code": "tooFewDays", "have": 3, "need": 14 })
        );
        let json = serde_json::to_value(Blocker::FailingSource {
            key: "ip:1".to_owned(),
            name: "1".to_owned(),
            share_permille: 5,
            pass_permille: 0,
        })
        .expect("json");
        assert_eq!(json["sharePermille"], 5);
    }
}
