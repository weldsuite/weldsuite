//! `ledger-core.test.ts`, case for case.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use super::*;
use crate::outbound::limits::{NEW_LIMITS, STANDARD_LIMITS};

const START: i64 = 1_791_883_800_000; // Date.UTC(2026, 9, 13, 9, 30)
const MINUTE: i64 = 60_000;

struct Fixture {
    now: Arc<AtomicI64>,
    core: LedgerCore,
}

impl Fixture {
    fn new() -> Self {
        let now = Arc::new(AtomicI64::new(START));
        let clock_now = Arc::clone(&now);
        let core = LedgerCore::new(Arc::new(move || clock_now.load(Ordering::SeqCst)));
        Self { now, core }
    }

    fn advance(&self, ms: i64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }

    fn clock(&self) -> Clock {
        let now = Arc::clone(&self.now);
        Arc::new(move || now.load(Ordering::SeqCst))
    }

    fn reserve(&mut self, p: &LedgerPolicy, req: ReserveRequest) -> ReserveDecision {
        self.core.reserve(p, false, req)
    }

    fn send(&mut self, p: &LedgerPolicy, req: ReserveRequest) -> ReserveDecision {
        let decision = self.core.reserve(p, false, req);
        if decision.allow
            && let Some(id) = &decision.reservation_id
        {
            self.core.commit(p, id, None);
        }
        decision
    }
}

fn policy() -> LedgerPolicy {
    LedgerPolicy {
        mode: GuardMode::Enforce,
        trust_level: TrustLevel::Standard,
        state: OutboundState::Active,
        state_reason: None,
        state_set_by: None,
        state_set_at: None,
        allow_replies_when_suspended: false,
        limits: STANDARD_LIMITS,
    }
}

fn request() -> ReserveRequest {
    ReserveRequest {
        sender: "tom@acme.com".to_owned(),
        source: "compose".to_owned(),
        kind: OutboundKind::NewThread,
        recipients: vec!["a@x.com".to_owned()],
        first_contact: Vec::new(),
        template: None,
        content_score: 0,
        content_flags: None,
        shared_domain: false,
        sender_daily_cap: None,
        sender_unregistered: false,
    }
}

fn recipients(n: usize, domain: &str) -> Vec<String> {
    (0..n).map(|i| format!("r{i}@{domain}")).collect()
}

fn with_recipients(list: Vec<String>) -> ReserveRequest {
    ReserveRequest {
        recipients: list,
        ..request()
    }
}

fn first_contacts(list: Vec<String>) -> ReserveRequest {
    ReserveRequest {
        recipients: list.clone(),
        first_contact: list,
        ..request()
    }
}

fn code(decision: &ReserveDecision) -> Option<DenialCode> {
    decision.denial.as_ref().map(|d| d.code)
}

#[test]
fn allows_sends_within_the_limits_and_counts_recipients() {
    let mut f = Fixture::new();
    let decision = f.send(&policy(), with_recipients(recipients(3, "x.com")));
    assert!(decision.allow);
    assert_eq!(f.core.usage(&policy()).workspace.day.used, 3);
}

#[test]
fn refuses_more_recipients_than_one_message_may_have() {
    let mut f = Fixture::new();
    let p = LedgerPolicy {
        trust_level: TrustLevel::New,
        limits: NEW_LIMITS,
        ..policy()
    };
    let decision = f.reserve(&p, with_recipients(recipients(21, "x.com")));
    assert!(!decision.allow);
    let denial = decision.denial.expect("denial");
    assert_eq!(denial.code, DenialCode::TooManyRecipients);
    assert_eq!(denial.limit, Some(20));
}

#[test]
fn enforces_the_per_sender_hourly_window_and_says_when_it_clears() {
    let mut f = Fixture::new();
    let p = policy();
    for i in 0..2 {
        assert!(
            f.send(&p, with_recipients(recipients(50, &format!("d{i}.com"))))
                .allow
        );
    }
    let denied = f.reserve(&p, with_recipients(vec!["one@more.com".to_owned()]));
    let denial = denied.denial.expect("denial");
    assert_eq!(denial.code, DenialCode::SendingLimited);
    assert_eq!(denial.window.as_deref(), Some("hour"));
    assert_eq!(denial.limit, Some(100));
    assert_eq!(
        denial.retry_after.as_deref(),
        Some("2026-10-13T10:00:00.000Z")
    );
    f.advance(60 * MINUTE);
    assert!(
        f.send(&p, with_recipients(vec!["one@more.com".to_owned()]))
            .allow
    );
}

#[test]
fn counts_pending_reservations_against_the_windows() {
    let mut f = Fixture::new();
    let p = LedgerPolicy {
        limits: OutboundLimits {
            sender_per_hour: 5,
            ..STANDARD_LIMITS
        },
        ..policy()
    };
    let first = f.reserve(&p, with_recipients(recipients(5, "x.com")));
    assert!(first.allow);
    let second = f.reserve(&p, with_recipients(vec!["x@y.com".to_owned()]));
    assert_eq!(code(&second), Some(DenialCode::SendingLimited));
    f.core
        .release(first.reservation_id.as_deref().expect("reserved"));
    assert!(
        f.reserve(&p, with_recipients(vec!["x@y.com".to_owned()]))
            .allow
    );
}

#[test]
fn reservations_expire_after_two_minutes() {
    let mut f = Fixture::new();
    let p = LedgerPolicy {
        limits: OutboundLimits {
            sender_per_hour: 5,
            ..STANDARD_LIMITS
        },
        ..policy()
    };
    assert!(f.reserve(&p, with_recipients(recipients(5, "x.com"))).allow);
    f.advance(2 * MINUTE);
    assert!(
        f.reserve(&p, with_recipients(vec!["x@y.com".to_owned()]))
            .allow
    );
}

#[test]
fn lets_a_mailboxs_own_daily_cap_lower_the_limit_never_raise_it() {
    let mut f = Fixture::new();
    let p = policy();
    let capped = |list: Vec<String>, sender: &str, cap: i64| ReserveRequest {
        sender: sender.to_owned(),
        sender_daily_cap: Some(cap),
        ..with_recipients(list)
    };
    assert!(
        f.send(&p, capped(recipients(10, "x.com"), "tom@acme.com", 10))
            .allow
    );
    let denial = f
        .reserve(&p, capped(vec!["x@y.com".to_owned()], "tom@acme.com", 10))
        .denial
        .expect("denial");
    assert_eq!(denial.window.as_deref(), Some("day"));
    assert_eq!(denial.limit, Some(10));
    assert!(
        f.reserve(
            &p,
            capped(vec!["x@y.com".to_owned()], "other@acme.com", 99_999)
        )
        .allow
    );
}

#[test]
fn caps_first_contacts_per_workspace_and_suggests_weldreach() {
    let mut f = Fixture::new();
    let p = LedgerPolicy {
        limits: OutboundLimits {
            first_contact_per_day: 3,
            ..STANDARD_LIMITS
        },
        ..policy()
    };
    assert!(f.send(&p, first_contacts(recipients(3, "x.com"))).allow);
    let denial = f
        .reserve(&p, first_contacts(vec!["new@z.com".to_owned()]))
        .denial
        .expect("denial");
    assert_eq!(denial.code, DenialCode::FirstContactLimited);
    assert_eq!(denial.suggest_weld_reach, Some(true));
    assert_eq!(denial.reason.as_deref(), Some("workspace_first_contact"));
    assert!(
        f.reserve(&p, with_recipients(vec!["known@z.com".to_owned()]))
            .allow
    );
}

#[test]
fn applies_the_shared_weldmail_first_contact_cap() {
    let mut f = Fixture::new();
    let p = policy();
    let shared = |list: Vec<String>| ReserveRequest {
        sender: "sales@acme.weldmail.com".to_owned(),
        shared_domain: true,
        ..first_contacts(list)
    };
    assert!(f.send(&p, shared(recipients(20, "x.com"))).allow);
    let denial = f
        .reserve(&p, shared(vec!["n@z.com".to_owned()]))
        .denial
        .expect("denial");
    assert_eq!(denial.code, DenialCode::FirstContactLimited);
    assert_eq!(denial.reason.as_deref(), Some("weldmail_shared_domain"));
}

#[test]
fn keeps_replies_going_under_the_reply_floor_also_when_on_hold() {
    let mut f = Fixture::new();
    let p = LedgerPolicy {
        state: OutboundState::Hold,
        limits: OutboundLimits {
            sender_per_hour: 1,
            ..STANDARD_LIMITS
        },
        ..policy()
    };
    assert_eq!(
        code(&f.reserve(&p, request())),
        Some(DenialCode::SendingOnHold)
    );
    for i in 0..5 {
        let reply = ReserveRequest {
            kind: OutboundKind::Reply,
            ..with_recipients(vec![format!("c{i}@x.com")])
        };
        assert!(f.send(&p, reply).allow);
    }
}

#[test]
fn refuses_everything_when_suspended_unless_replies_are_allowed() {
    let mut f = Fixture::new();
    let reply = || ReserveRequest {
        kind: OutboundKind::Reply,
        ..request()
    };
    let suspended = LedgerPolicy {
        state: OutboundState::Suspended,
        ..policy()
    };
    assert_eq!(
        code(&f.reserve(&suspended, reply())),
        Some(DenialCode::SendingSuspended)
    );
    let allow_replies = LedgerPolicy {
        allow_replies_when_suspended: true,
        ..suspended
    };
    assert!(f.reserve(&allow_replies, reply()).allow);
}

#[test]
fn gives_invitations_from_weldsuite_itself_workspace_windows_only() {
    let mut f = Fixture::new();
    let p = LedgerPolicy {
        trust_level: TrustLevel::New,
        limits: NEW_LIMITS,
        ..policy()
    };
    let invite = ReserveRequest {
        sender: String::new(),
        source: "calendar".to_owned(),
        ..with_recipients(recipients(40, "x.com"))
    };
    assert!(f.send(&p, invite).allow);
    let big = ReserveRequest {
        sender: String::new(),
        source: "meet".to_owned(),
        ..with_recipients(recipients(261, "y.com"))
    };
    let denial = f.reserve(&p, big).denial.expect("denial");
    assert_eq!(denial.code, DenialCode::SendingLimited);
    assert_eq!(denial.reason.as_deref(), Some("workspace_day"));
}

#[test]
fn refuses_an_unregistered_shared_address_only_when_enforcing() {
    let mut f = Fixture::new();
    let req = || ReserveRequest {
        sender: "ghost@acme.weldmail.com".to_owned(),
        shared_domain: true,
        sender_unregistered: true,
        ..request()
    };
    let denial = f.reserve(&policy(), req()).denial.expect("denial");
    assert_eq!(denial.code, DenialCode::SenderNotOwned);
    assert_eq!(
        denial.reason.as_deref(),
        Some("unregistered_shared_address")
    );
    let shadow = LedgerPolicy {
        mode: GuardMode::Shadow,
        ..policy()
    };
    assert_eq!(
        f.reserve(&shadow, req()).shadow_denial.map(|d| d.code),
        Some(DenialCode::SenderNotOwned)
    );
}

#[test]
fn only_logs_in_shadow_mode() {
    let mut f = Fixture::new();
    let p = LedgerPolicy {
        mode: GuardMode::Shadow,
        limits: OutboundLimits {
            sender_per_hour: 1,
            ..STANDARD_LIMITS
        },
        ..policy()
    };
    f.send(&p, request());
    let decision = f.reserve(&p, with_recipients(vec!["b@x.com".to_owned()]));
    assert!(decision.allow);
    assert_eq!(
        decision.shadow_denial.map(|d| d.code),
        Some(DenialCode::SendingLimited)
    );
    assert_eq!(
        f.core.shadow_counts(),
        BTreeMap::from([("SENDING_LIMITED".to_owned(), 1)])
    );
}

#[test]
fn skips_the_ledger_entirely_in_off_mode() {
    let mut f = Fixture::new();
    let off = LedgerPolicy {
        mode: GuardMode::Off,
        ..policy()
    };
    let decision = f.reserve(&off, request());
    assert_eq!(
        serde_json::to_value(&decision).expect("json"),
        serde_json::json!({ "allow": true, "mode": "off", "reservationId": null })
    );
}

#[test]
fn stops_first_contacts_when_the_platform_budget_is_used_except_for_trusted_workspaces() {
    let mut f = Fixture::new();
    let req = || ReserveRequest {
        first_contact: vec!["a@x.com".to_owned()],
        ..request()
    };
    assert_eq!(
        code(&f.core.reserve(&policy(), true, req())),
        Some(DenialCode::PlatformLimited)
    );
    let trusted = LedgerPolicy {
        trust_level: TrustLevel::Trusted,
        ..policy()
    };
    assert!(f.core.reserve(&trusted, true, req()).allow);
}

fn template() -> RequestTemplate {
    RequestTemplate {
        fingerprint: "a1b2c3d4e5f60718".to_owned(),
        sample: "hi tokname quick question".to_owned(),
        subject: "Quick question".to_owned(),
    }
}

fn verdict(category: &str, confidence: f64) -> StoredVerdict {
    StoredVerdict {
        fingerprint: template().fingerprint,
        category: category.to_owned(),
        unsolicited: true,
        confidence,
        signals: vec!["meeting request to strangers".to_owned()],
        model_id: "test".to_owned(),
        reviewed_at: iso(START),
    }
}

#[test]
fn queues_a_review_once_a_template_reaches_enough_first_contacts() {
    let mut f = Fixture::new();
    let p = policy();
    let mut review = None;
    for i in 0..thresholds::REVIEW_FIRST_CONTACT_RECIPIENTS {
        let to = format!("p{i}@d{i}.com");
        let d = f.reserve(
            &p,
            ReserveRequest {
                template: Some(template()),
                source: "crm_sequence".to_owned(),
                ..first_contacts(vec![to])
            },
        );
        review = f
            .core
            .commit(&p, d.reservation_id.as_deref().expect("reserved"), None)
            .or(review);
    }
    let review = review.expect("review");
    assert_eq!(review.fingerprint, template().fingerprint);
    assert_eq!(review.reason, ReviewReason::TemplateThreshold);
    assert_eq!(review.first_contact_recipients, 10);
    assert_eq!(review.sources, ["crm_sequence"]);
}

#[test]
fn samples_first_contact_sends_of_a_new_workspace() {
    let mut f = Fixture::new();
    let p = LedgerPolicy {
        trust_level: TrustLevel::New,
        limits: NEW_LIMITS,
        ..policy()
    };
    let d = f.reserve(
        &p,
        ReserveRequest {
            first_contact: vec!["a@x.com".to_owned()],
            template: Some(template()),
            ..request()
        },
    );
    let review = f
        .core
        .commit(&p, d.reservation_id.as_deref().expect("reserved"), None);
    assert_eq!(
        review.map(|r| r.reason),
        Some(ReviewReason::NewWorkspaceSample)
    );
}

#[test]
fn caps_a_cold_outreach_template_at_its_daily_first_contact_limit() {
    let mut f = Fixture::new();
    let p = policy();
    let actions = f.core.record_verdict(&verdict("cold_outreach", 0.9), false);
    assert_eq!(actions[0].to_state, None);
    assert_eq!(actions[0].trigger, "cold_outreach_template");
    assert_eq!(actions[0].severity, CaseSeverity::Warning);
    assert_eq!(
        actions[0].reason,
        "A template was classified as cold outreach."
    );
    for i in 0..thresholds::COLD_TEMPLATE_FIRST_CONTACT_PER_DAY {
        let req = ReserveRequest {
            template: Some(template()),
            ..first_contacts(vec![format!("p{i}@x.com")])
        };
        assert!(f.send(&p, req).allow);
    }
    // A near-duplicate (one bit off) is the same template.
    let near = RequestTemplate {
        fingerprint: "a1b2c3d4e5f60719".to_owned(),
        ..template()
    };
    let denial = f
        .reserve(
            &p,
            ReserveRequest {
                template: Some(near),
                ..first_contacts(vec!["late@x.com".to_owned()])
            },
        )
        .denial
        .expect("denial");
    assert_eq!(denial.code, DenialCode::FirstContactLimited);
    assert_eq!(denial.reason.as_deref(), Some("cold_outreach_template"));
    assert_eq!(denial.suggest_weld_reach, Some(true));
    assert!(f.core.usage(&p).cold_outreach_capped);
}

#[test]
fn leaves_an_info_case_for_a_harmless_verdict_staff_asked_for() {
    let mut f = Fixture::new();
    let harmless = StoredVerdict {
        unsolicited: false,
        signals: Vec::new(),
        ..verdict("personal_1to1", 0.8)
    };
    assert_eq!(f.core.record_verdict(&harmless, false).len(), 0);
    let actions = f.core.record_verdict(&harmless, true);
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].trigger, "staff_review");
    assert_eq!(actions[0].severity, CaseSeverity::Info);
    assert_eq!(actions[0].reason, "Requested review: personal 1to1 (0.80).");
}

#[test]
fn puts_the_workspace_on_hold_for_a_phishing_verdict() {
    let mut f = Fixture::new();
    let actions = f
        .core
        .record_verdict(&verdict("phishing_or_scam", 0.95), false);
    assert_eq!(actions[0].to_state, Some(OutboundState::Hold));
    assert_eq!(actions[0].trigger, "phishing");
    assert_eq!(actions[0].severity, CaseSeverity::Urgent);
}

#[test]
fn restricts_on_a_high_hard_bounce_rate() {
    let mut f = Fixture::new();
    let p = policy();
    f.send(&p, with_recipients(recipients(40, "x.com")));
    for _ in 0..4 {
        f.core.record_delivery(DeliveryEventType::HardBounce, START);
    }
    let evaluation = f.core.evaluate(&p);
    let rate = evaluation.risk.hard_bounce_rate_7d.expect("rate");
    assert!((rate - 0.1).abs() < 1e-9);
    assert!(
        evaluation.actions.iter().any(|a| {
            a.to_state == Some(OutboundState::Restricted) && a.trigger == "bounce_rate"
        })
    );
}

#[test]
fn restricts_on_spam_complaints() {
    let mut f = Fixture::new();
    let p = policy();
    f.send(&p, with_recipients(recipients(30, "x.com")));
    f.core.record_delivery(DeliveryEventType::Complained, START);
    f.core.record_delivery(DeliveryEventType::Complained, START);
    assert!(
        f.core.evaluate(&p).actions.iter().any(|a| {
            a.to_state == Some(OutboundState::Restricted) && a.trigger == "complaints"
        })
    );
}

#[test]
fn does_not_undo_a_recent_staff_decision_but_opens_a_case() {
    let mut f = Fixture::new();
    let p = LedgerPolicy {
        state_set_by: Some("staff@weldsuite.org".to_owned()),
        state_set_at: Some(START - MINUTE),
        ..policy()
    };
    f.send(&p, with_recipients(recipients(40, "x.com")));
    for _ in 0..4 {
        f.core.record_delivery(DeliveryEventType::HardBounce, START);
    }
    let actions = f.core.evaluate(&p).actions;
    assert!(
        actions
            .iter()
            .any(|a| a.to_state.is_none() && a.trigger == "bounce_rate")
    );
    assert!(actions.iter().all(|a| a.to_state.is_none()));
}

#[test]
fn never_loosens_a_hold_is_not_turned_into_a_restriction() {
    let mut f = Fixture::new();
    let p = LedgerPolicy {
        state: OutboundState::Hold,
        ..policy()
    };
    f.send(
        &p,
        ReserveRequest {
            kind: OutboundKind::Reply,
            ..with_recipients(recipients(40, "x.com"))
        },
    );
    for _ in 0..4 {
        f.core.record_delivery(DeliveryEventType::HardBounce, START);
    }
    assert!(
        f.core
            .evaluate(&p)
            .actions
            .iter()
            .all(|a| a.to_state.is_none())
    );
}

#[test]
fn persists_and_reloads_its_state() {
    let mut f = Fixture::new();
    f.send(&policy(), with_recipients(recipients(7, "x.com")));
    f.core.record_delivery(DeliveryEventType::Delivered, START);
    let changes = f.core.changes();
    let fields: HashMap<String, String> = changes.put.into_iter().collect();
    let reloaded = LedgerCore::load(f.clock(), &fields);
    let usage = reloaded.usage(&policy());
    assert_eq!(usage.workspace.day.used, 7);
    assert_eq!(usage.deliveries7d.delivered, 1);
    // The committed reservation was removed, not left behind.
    assert!(!fields.keys().any(|key| key.starts_with("r:")));
}

#[test]
fn a_reservation_survives_a_reload_and_commits() {
    let mut f = Fixture::new();
    let p = policy();
    let decision = f.reserve(&p, with_recipients(recipients(2, "x.com")));
    let fields: HashMap<String, String> = f.core.changes().put.into_iter().collect();
    let mut reloaded = LedgerCore::load(f.clock(), &fields);
    reloaded.commit(&p, decision.reservation_id.as_deref().expect("id"), None);
    assert_eq!(reloaded.usage(&p).workspace.day.used, 2);
    let changes = reloaded.changes();
    assert!(changes.delete.iter().any(|key| key.starts_with("r:")));
}

#[test]
fn drops_a_day_window_as_the_hours_roll_over_and_prunes_old_buckets() {
    let mut f = Fixture::new();
    let p = LedgerPolicy {
        limits: OutboundLimits {
            sender_per_day: 10,
            ..STANDARD_LIMITS
        },
        ..policy()
    };
    f.send(&p, with_recipients(recipients(10, "x.com")));
    let denied = f.reserve(&p, with_recipients(vec!["x@y.com".to_owned()]));
    assert_eq!(denied.denial.and_then(|d| d.window).as_deref(), Some("day"));
    f.advance(24 * 60 * MINUTE);
    assert!(
        f.reserve(&p, with_recipients(vec!["x@y.com".to_owned()]))
            .allow
    );
    f.advance(9 * 24 * 60 * MINUTE);
    assert_ne!(f.core.prune().len(), 0);
}
