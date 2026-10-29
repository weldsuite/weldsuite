//! The guard without a database: the ledger round trip over a fake ledger
//! (as `guard.test.ts`'s `fakeLedgers`), failing open, and `guarded_send`.
//! The SQL (first contact, suppressions, the registry) is checked against
//! the real schema in `tests/outbound_schema.rs`.

use std::sync::Arc;
use std::sync::Mutex;

use super::*;
use crate::outbound::clock::system_clock;
use crate::outbound::ledger::{Inspection, LedgerError, LedgerResult};
use crate::outbound::ledger_core::{
    DeliveryEventType, LedgerCore, LedgerPolicy, ReserveDecision, StoredVerdict,
};
use crate::outbound::limits::{OutboundState, STANDARD_LIMITS, TrustLevel};

/// One `LedgerCore` per name with a fixed policy; records the calls.
struct FakeLedgers {
    policy: LedgerPolicy,
    cores: Mutex<HashMap<String, LedgerCore>>,
    calls: Mutex<Vec<(String, Option<ReserveRequest>)>>,
    broken: bool,
}

impl FakeLedgers {
    fn new(policy: LedgerPolicy) -> Arc<Self> {
        Arc::new(Self {
            policy,
            cores: Mutex::new(HashMap::new()),
            calls: Mutex::new(Vec::new()),
            broken: false,
        })
    }

    fn broken() -> Arc<Self> {
        Arc::new(Self {
            policy: policy(GuardMode::Enforce),
            cores: Mutex::new(HashMap::new()),
            calls: Mutex::new(Vec::new()),
            broken: true,
        })
    }

    fn methods(&self) -> Vec<String> {
        self.calls
            .lock()
            .expect("calls")
            .iter()
            .map(|(m, _)| m.clone())
            .collect()
    }

    fn with_core<T>(&self, key: &str, f: impl FnOnce(&mut LedgerCore) -> T) -> T {
        let mut cores = self.cores.lock().expect("cores");
        let core = cores
            .entry(key.to_owned())
            .or_insert_with(|| LedgerCore::new(system_clock()));
        f(core)
    }
}

impl OutboundLedger for FakeLedgers {
    fn reserve<'a>(
        &'a self,
        key: &'a str,
        _subject: &'a LedgerSubject,
        request: &'a ReserveRequest,
    ) -> BoxFuture<'a, LedgerResult<ReserveDecision>> {
        self.calls
            .lock()
            .expect("calls")
            .push(("reserve".to_owned(), Some(request.clone())));
        let result = if self.broken {
            Err(LedgerError("Durable Object unavailable".to_owned()))
        } else {
            Ok(self.with_core(key, |core| {
                core.reserve(&self.policy, false, request.clone())
            }))
        };
        Box::pin(std::future::ready(result))
    }

    fn commit<'a>(
        &'a self,
        key: &'a str,
        reservation_id: &'a str,
        sent_recipients: Option<&'a [String]>,
    ) -> BoxFuture<'a, LedgerResult<()>> {
        self.calls
            .lock()
            .expect("calls")
            .push(("commit".to_owned(), None));
        self.with_core(key, |core| {
            core.commit(&self.policy, reservation_id, sent_recipients);
        });
        Box::pin(std::future::ready(Ok(())))
    }

    fn release<'a>(
        &'a self,
        key: &'a str,
        reservation_id: &'a str,
    ) -> BoxFuture<'a, LedgerResult<()>> {
        self.calls
            .lock()
            .expect("calls")
            .push(("release".to_owned(), None));
        self.with_core(key, |core| core.release(reservation_id));
        Box::pin(std::future::ready(Ok(())))
    }

    fn record_delivery<'a>(
        &'a self,
        _key: &'a str,
        _subject: &'a LedgerSubject,
        _kind: DeliveryEventType,
        _at_ms: i64,
    ) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(std::future::ready(Ok(())))
    }

    fn record_verdict<'a>(
        &'a self,
        _key: &'a str,
        _verdict: &'a StoredVerdict,
        _staff_requested: bool,
    ) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(std::future::ready(Ok(())))
    }

    fn usage<'a>(
        &'a self,
        key: &'a str,
        _subject: &'a LedgerSubject,
    ) -> BoxFuture<'a, LedgerResult<OutboundUsage>> {
        let usage = self.with_core(key, |core| core.usage(&self.policy));
        Box::pin(std::future::ready(Ok(usage)))
    }

    fn inspect<'a>(
        &'a self,
        _key: &'a str,
        _subject: &'a LedgerSubject,
    ) -> BoxFuture<'a, LedgerResult<Inspection>> {
        Box::pin(std::future::ready(Err(LedgerError("not here".to_owned()))))
    }

    fn request_review<'a>(
        &'a self,
        _key: &'a str,
        _subject: &'a LedgerSubject,
    ) -> BoxFuture<'a, LedgerResult<bool>> {
        Box::pin(std::future::ready(Ok(false)))
    }

    fn refresh_policy<'a>(&'a self, _key: &'a str) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(std::future::ready(Ok(())))
    }
}

fn policy(mode: GuardMode) -> LedgerPolicy {
    LedgerPolicy {
        mode,
        trust_level: TrustLevel::Standard,
        state: OutboundState::Active,
        state_reason: None,
        state_set_by: None,
        state_set_at: None,
        allow_replies_when_suspended: false,
        limits: STANDARD_LIMITS,
    }
}

fn subject() -> SubjectInput {
    SubjectInput::Workspace {
        clerk_org_id: "org_test".to_owned(),
        workspace_id: Some("ws_test".to_owned()),
    }
}

fn guard(ledger: Arc<FakeLedgers>) -> OutboundGuard {
    OutboundGuard {
        ledger: Some(ledger),
        ..OutboundGuard::default()
    }
}

#[test]
fn bare_addresses() {
    assert_eq!(
        bare_address("\"Anna\" <Anna@Example.com>"),
        "anna@example.com"
    );
    assert_eq!(bare_address("  Bob@X.org "), "bob@x.org");
    assert_eq!(
        unique_addresses(&[
            &["A@x.com".to_owned(), "no-at".to_owned()],
            &["a@x.com".to_owned(), "Bee <b@y.com>".to_owned()],
        ]),
        ["a@x.com", "b@y.com"]
    );
}

#[tokio::test]
async fn reserves_through_the_ledger_and_commits() {
    let ledgers = FakeLedgers::new(policy(GuardMode::Enforce));
    let guard = guard(Arc::clone(&ledgers));
    let mut input = CheckOutboundInput::new(
        subject(),
        "compose",
        OutboundKind::NewThread,
        "Tom <Tom@Acme.com>",
        vec!["a@x.com".to_owned()],
    );
    input.cc = vec!["A@x.com".to_owned(), "b@y.com".to_owned()];
    let reservation = check_outbound(&guard, None, &input).await.expect("allowed");
    assert_eq!(reservation.sender, "tom@acme.com");
    assert_eq!(reservation.recipients, ["a@x.com", "b@y.com"]);
    assert_eq!(reservation.mode, ReservationMode::Guard(GuardMode::Enforce));
    assert_eq!(
        reservation.ledger.as_ref().map(|(key, _)| key.as_str()),
        Some("ws:ws_test")
    );
    commit_outbound(&guard, None, &reservation, None).await;
    assert_eq!(ledgers.methods(), ["reserve", "commit"]);
    let usage = get_outbound_usage(&guard, &subject())
        .await
        .expect("usage")
        .expect("ledger");
    assert_eq!(usage.workspace.day.used, 2);
}

#[tokio::test]
async fn sends_the_request_typescript_sends() {
    let ledgers = FakeLedgers::new(policy(GuardMode::Shadow));
    let guard = guard(Arc::clone(&ledgers));
    let mut input = CheckOutboundInput::new(
        subject(),
        "api",
        OutboundKind::NewThread,
        "sales@acme.weldmail.com",
        vec!["anna@acme.io".to_owned()],
    );
    input.subject_line = Some("Quick question".to_owned());
    input.text = Some(
        "Hi Anna, I noticed Acme is growing fast. Would you be open to a quick call next week to talk about your onboarding?"
            .to_owned(),
    );
    input.sender_daily_cap = Some(40);
    check_outbound(&guard, None, &input).await.expect("allowed");
    let calls = ledgers.calls.lock().expect("calls");
    let request = calls[0].1.clone().expect("request");
    let json = serde_json::to_value(&request).expect("json");
    assert_eq!(json["sender"], "sales@acme.weldmail.com");
    assert_eq!(json["source"], "api");
    assert_eq!(json["kind"], "new_thread");
    assert_eq!(json["sharedDomain"], true);
    assert_eq!(json["senderDailyCap"], 40);
    assert_eq!(json["senderUnregistered"], false);
    assert_eq!(json["contentFlags"]["coldOutreach"], true);
    assert!(json["template"]["fingerprint"].is_string());
    assert_eq!(json["template"]["subject"], "Quick question");
}

#[tokio::test]
async fn replies_carry_no_template_or_content_flags() {
    let ledgers = FakeLedgers::new(policy(GuardMode::Shadow));
    let guard = guard(Arc::clone(&ledgers));
    let mut input = CheckOutboundInput::new(
        subject(),
        "reply",
        OutboundKind::Reply,
        "tom@acme.com",
        vec!["p@q.com".to_owned()],
    );
    input.text = Some("Quick question, would you be open to a 15 minute call?".to_owned());
    check_outbound(&guard, None, &input).await.expect("allowed");
    let calls = ledgers.calls.lock().expect("calls");
    let json = serde_json::to_value(calls[0].1.clone().expect("request")).expect("json");
    assert_eq!(json["template"], serde_json::Value::Null);
    assert_eq!(json["contentScore"], 0);
    assert!(json.get("contentFlags").is_none());
    assert_eq!(json["senderDailyCap"], serde_json::Value::Null);
}

#[tokio::test]
async fn refuses_what_enforcement_refuses() {
    let mut strict = policy(GuardMode::Enforce);
    strict.limits.recipients_per_message = 1;
    let guard = guard(FakeLedgers::new(strict));
    let input = CheckOutboundInput::new(
        subject(),
        "compose",
        OutboundKind::NewThread,
        "tom@acme.com",
        vec!["a@x.com".to_owned(), "b@x.com".to_owned()],
    );
    let denied = check_outbound(&guard, None, &input)
        .await
        .expect_err("refused");
    assert_eq!(denied.code(), DenialCode::TooManyRecipients);
    assert_eq!(denied.status(), 422);
    assert_eq!(
        denied.message(),
        "Too many recipients in one message (at most 1)."
    );
}

#[tokio::test]
async fn fails_open_when_the_ledger_is_unreachable() {
    let guard = guard(FakeLedgers::broken());
    let input = CheckOutboundInput::new(
        subject(),
        "compose",
        OutboundKind::NewThread,
        "tom@acme.com",
        vec!["a@x.com".to_owned()],
    );
    let reservation = check_outbound(&guard, None, &input).await.expect("open");
    assert_eq!(reservation.mode, ReservationMode::Unavailable);
    assert_eq!(reservation.reservation_id, None);
}

#[tokio::test]
async fn the_backstop_holds_when_the_ledger_is_missing() {
    let guard = OutboundGuard {
        backstop: Some(Arc::new(WindowBackstop::new(2, Duration::from_secs(60)))),
        ..OutboundGuard::default()
    };
    let input = CheckOutboundInput::new(
        subject(),
        "compose",
        OutboundKind::NewThread,
        "tom@acme.com",
        vec!["a@x.com".to_owned()],
    );
    for _ in 0..2 {
        let reservation = check_outbound(&guard, None, &input).await.expect("open");
        assert_eq!(reservation.mode, ReservationMode::Unavailable);
    }
    let denied = check_outbound(&guard, None, &input)
        .await
        .expect_err("backstop");
    assert_eq!(denied.details.reason.as_deref(), Some("backstop"));
    assert_eq!(denied.details.window.as_deref(), Some("hour"));
}

#[derive(Debug)]
struct Partial(Vec<String>);

impl SentRecipients for Partial {
    fn sent_recipients(&self) -> &[String] {
        &self.0
    }
}

#[tokio::test]
async fn guarded_send_releases_on_failure_and_commits_partial_sends() {
    let ledgers = FakeLedgers::new(policy(GuardMode::Enforce));
    let guard = guard(Arc::clone(&ledgers));
    let input = CheckOutboundInput::new(
        subject(),
        "workflow",
        OutboundKind::NewThread,
        "tom@acme.com",
        vec!["a@x.com".to_owned(), "b@x.com".to_owned()],
    );
    let failed: Result<(), _> =
        guarded_send(&guard, None, &input, || async { Err(Partial(Vec::new())) }).await;
    assert!(matches!(failed, Err(GuardedSendError::Send(_))));
    let partial: Result<(), _> = guarded_send(&guard, None, &input, || async {
        Err(Partial(vec!["A@x.com".to_owned()]))
    })
    .await;
    assert!(partial.is_err());
    let sent: Result<&str, GuardedSendError<Partial>> =
        guarded_send(&guard, None, &input, || async { Ok("sent") }).await;
    assert_eq!(sent.expect("sent"), "sent");
    assert_eq!(
        ledgers.methods(),
        [
            "reserve", "release", "reserve", "commit", "reserve", "commit"
        ]
    );
    let usage = get_outbound_usage(&guard, &subject())
        .await
        .expect("usage")
        .expect("ledger");
    // One recipient of the partial send, two of the full one.
    assert_eq!(usage.workspace.day.used, 3);
}
