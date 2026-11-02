//! The outbound guard's SQL against the real schema (databases built from
//! the journaled migrations by `scripts/rust-test-db.ts`, as CI does): first
//! contact and suppressions in the tenant database (with the
//! `mail_correspondents` trigger), sender ownership, policies, the trail and
//! cases in the master database, and the delivery-status match.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are
//! set; otherwise it returns early.

#![allow(clippy::too_many_lines)] // each test walks one scenario through, step by step

use std::sync::Arc;

use serde_json::json;
use weldsuite_db::{PgPool, master_pool};
use weldsuite_mail_domain::outbound::cases::{OpenCase, open_outbound_case};
use weldsuite_mail_domain::outbound::clock::now_ms;
use weldsuite_mail_domain::outbound::correspondents::{
    add_suppression, find_known_correspondents, find_suppressed,
};
use weldsuite_mail_domain::outbound::delivery_events::{ParsedSendingEvent, mark_sent_copy};
use weldsuite_mail_domain::outbound::ledger_core::{CaseSeverity, DeliveryEventType};
use weldsuite_mail_domain::outbound::limits::{GuardMode, OutboundState, TrustLevel};
use weldsuite_mail_domain::outbound::policy_store::{
    DeliveryRates, StateChange, apply_automatic_state, load_ledger_policy, save_risk_score,
};
use weldsuite_mail_domain::outbound::{
    CheckOutboundInput, DenialCode, LedgerSubject, OutboundGuard, OutboundKind, SenderOwnership,
    SubjectInput, check_outbound, commit_outbound, sender_ownership,
};

fn databases() -> Option<(PgPool, PgPool)> {
    let master = std::env::var("WELDSUITE_TEST_MASTER_URL").ok()?;
    let tenant = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    Some((
        master_pool(&master, 2).expect("master pool"),
        master_pool(&tenant, 2).expect("tenant pool"),
    ))
}

#[tokio::test]
async fn first_contact_suppressions_and_correspondents() {
    let Some((_, tenant)) = databases() else {
        eprintln!("test databases not set; skipping");
        return;
    };
    sqlx::raw_sql(
        r#"delete from mail_messages where id like 'msg_obt_%';
          delete from mail_accounts where id like 'mail_obt_%';
          delete from mail_correspondents where email like '%@obt.test';
          delete from mail_suppressions where email like '%@obt.test';
          insert into mail_accounts (id, name, email, is_shared) values
              ('mail_obt_in', 'In', 'in@acme.obt.test', true);
          insert into mail_messages (id, account_id, message_id, "from", "to", sent_date, source) values
              ('msg_obt_1', 'mail_obt_in', '<m1@x>', '{"email":"Known@OBT.test"}', '[{"email":"in@acme.obt.test"}]', now(), 'inbound');"#,
    )
    .execute(&tenant)
    .await
    .expect("seed");

    // The trigger recorded the sender, lower-cased.
    let known = find_known_correspondents(&tenant, &["known@obt.test".to_owned()])
        .await
        .expect("known");
    assert!(known.contains("known@obt.test"));

    let guard = OutboundGuard::default();
    let subject = SubjectInput::Workspace {
        clerk_org_id: "org_obt".to_owned(),
        workspace_id: Some("ws_obt".to_owned()),
    };
    let input = CheckOutboundInput::new(
        subject.clone(),
        "compose",
        OutboundKind::NewThread,
        "tom@acme.obt.test",
        vec!["known@obt.test".to_owned(), "new@obt.test".to_owned()],
    );
    let reservation = check_outbound(&guard, Some(&tenant), &input)
        .await
        .expect("allowed");
    assert_eq!(reservation.first_contact, ["new@obt.test"]);

    commit_outbound(&guard, Some(&tenant), &reservation, None).await;
    commit_outbound(&guard, Some(&tenant), &reservation, None).await;
    let count: i32 = sqlx::query_scalar(
        "select outbound_count from mail_correspondents where email = 'new@obt.test'",
    )
    .fetch_one(&tenant)
    .await
    .expect("count");
    assert_eq!(count, 2);

    // A complaint is refused in every mode; a bounce is not.
    add_suppression(
        &tenant,
        "Angry@OBT.test",
        "complaint",
        Some("tom@acme.obt.test"),
        "cloudflare_event",
        None,
        now_ms(),
    )
    .await
    .expect("suppress");
    add_suppression(
        &tenant,
        "angry@obt.test",
        "hard_bounce",
        None,
        "cloudflare_event",
        Some(&json!({ "detail": "550" })),
        now_ms(),
    )
    .await
    .expect("never downgraded");
    add_suppression(
        &tenant,
        "gone@obt.test",
        "hard_bounce",
        None,
        "cloudflare_event",
        None,
        now_ms(),
    )
    .await
    .expect("suppress");
    let suppressed = find_suppressed(&tenant, &["angry@obt.test".to_owned()])
        .await
        .expect("suppressed");
    assert_eq!(suppressed[0].reason, "complaint");
    let to_angry = CheckOutboundInput::new(
        subject.clone(),
        "compose",
        OutboundKind::Reply,
        "tom@acme.obt.test",
        vec!["angry@obt.test".to_owned()],
    );
    let denied = check_outbound(&guard, Some(&tenant), &to_angry)
        .await
        .expect_err("refused");
    assert_eq!(denied.code(), DenialCode::RecipientSuppressed);
    assert_eq!(
        denied.details.recipients.as_deref(),
        Some(&["angry@obt.test".to_owned()][..])
    );
    let to_gone = CheckOutboundInput::new(
        subject,
        "compose",
        OutboundKind::Reply,
        "tom@acme.obt.test",
        vec!["gone@obt.test".to_owned()],
    );
    assert!(
        check_outbound(&guard, Some(&tenant), &to_gone)
            .await
            .is_ok()
    );

    // A delivery event marks the latest SENT copy to that recipient.
    sqlx::raw_sql(
        r#"insert into mail_messages (id, account_id, message_id, "from", "to", sent_date, source) values
              ('msg_obt_sent', 'mail_obt_in', '<s1@x>', '{"email":"in@acme.obt.test"}', '[{"email":"Gone@obt.test"}]', now() - interval '1 minute', 'sent');"#,
    )
    .execute(&tenant)
    .await
    .expect("sent copy");
    let event = ParsedSendingEvent {
        kind: DeliveryEventType::HardBounce,
        sender: "in@acme.obt.test".to_owned(),
        recipient: "gone@obt.test".to_owned(),
        at_ms: now_ms(),
        detail: Some("550 5.1.1".to_owned()),
    };
    assert!(
        mark_sent_copy(&tenant, "mail_obt_in", &event)
            .await
            .expect("marked")
    );
    let status: Option<String> =
        sqlx::query_scalar("select delivery_status from mail_messages where id = 'msg_obt_sent'")
            .fetch_one(&tenant)
            .await
            .expect("status");
    assert_eq!(status.as_deref(), Some("bounced"));
    // A weaker status does not replace it.
    let delivered = ParsedSendingEvent {
        kind: DeliveryEventType::Delivered,
        ..event
    };
    assert!(
        !mark_sent_copy(&tenant, "mail_obt_in", &delivered)
            .await
            .expect("kept")
    );
}

#[tokio::test]
async fn ownership_policies_and_cases() {
    let Some((master, _)) = databases() else {
        eprintln!("test databases not set; skipping");
        return;
    };
    sqlx::raw_sql(
        r"delete from outbound_mail_cases where workspace_id like 'ws_obt%';
          delete from outbound_mail_events where workspace_id like 'ws_obt%';
          delete from outbound_mail_policies where workspace_id like 'ws_obt%';
          delete from mail_account_registry where email like '%obt.test';
          delete from workspaces where id like 'ws_obt%';
          insert into workspaces (id, name, slug, clerk_org_id, created_at) values
              ('ws_obt', 'Acme', 'acme-obt', 'org_obt', now() - interval '30 days'),
              ('ws_obt_other', 'Other', 'other-obt', 'org_obt_other', now());
          insert into mail_account_registry (id, email, workspace_id, account_id, is_active) values
              ('mreg_obt_1', 'tom@acme.obt.test', 'ws_obt', 'mail_1', true),
              ('mreg_obt_2', 'eve@other.obt.test', 'ws_obt_other', 'mail_2', true),
              ('mreg_obt_3', 'sales@acme.weldmail.com', 'ws_obt_other', 'mail_3', true);",
    )
    .execute(&master)
    .await
    .expect("seed");

    let guard = OutboundGuard {
        master: Some(master.clone()),
        cache: Some(Arc::new(weldsuite_ports::MemoryCache::new())),
        ..OutboundGuard::default()
    };
    let subject = LedgerSubject::workspace("ws_obt", Some("org_obt"));
    assert_eq!(
        sender_ownership(&guard, &subject, "tom@acme.obt.test").await,
        SenderOwnership::Owned
    );
    assert_eq!(
        sender_ownership(&guard, &subject, "eve@other.obt.test").await,
        SenderOwnership::Other
    );
    // Another address on a domain only someone else has registered.
    assert_eq!(
        sender_ownership(&guard, &subject, "mallory@other.obt.test").await,
        SenderOwnership::Other
    );
    assert_eq!(
        sender_ownership(&guard, &subject, "nobody@unclaimed.obt.test").await,
        SenderOwnership::Owned
    );
    assert_eq!(
        sender_ownership(&guard, &subject, "ghost@acme.weldmail.com").await,
        SenderOwnership::Unregistered
    );
    let denied = check_outbound(
        &guard,
        None,
        &CheckOutboundInput::new(
            SubjectInput::Workspace {
                clerk_org_id: "org_obt".to_owned(),
                workspace_id: None,
            },
            "compose",
            OutboundKind::NewThread,
            "Eve <eve@other.obt.test>",
            vec!["a@x.test".to_owned()],
        ),
    )
    .await
    .expect_err("not ours");
    assert_eq!(denied.code(), DenialCode::SenderNotOwned);

    // No row: the defaults for an unpaid workspace.
    let policy = load_ledger_policy(&master, None, &subject, DeliveryRates::default(), now_ms())
        .await
        .expect("policy");
    assert_eq!(policy.policy.mode, GuardMode::Shadow);
    assert_eq!(policy.policy.trust_level, TrustLevel::New);
    assert_eq!(policy.policy.limits.sender_per_hour, 30);

    // A score worth showing creates the row; staff overrides apply.
    save_risk_score(&master, &subject, 42, now_ms())
        .await
        .expect("risk");
    sqlx::raw_sql(
        r#"update outbound_mail_policies set trust_override = 'trusted', limits = '{"senderPerHour": 7}'
          where workspace_id = 'ws_obt'"#,
    )
    .execute(&master)
    .await
    .expect("override");
    let policy = load_ledger_policy(&master, None, &subject, DeliveryRates::default(), now_ms())
        .await
        .expect("policy");
    assert_eq!(policy.risk_score, 42);
    assert_eq!(policy.policy.trust_level, TrustLevel::Trusted);
    assert_eq!(policy.policy.limits.sender_per_hour, 7);

    apply_automatic_state(
        &master,
        &subject,
        &StateChange {
            from: OutboundState::Active,
            to: OutboundState::Restricted,
            customer_reason: "limited".to_owned(),
            reason: "Hard bounces at 9.0% over 7 days.".to_owned(),
            details: json!({ "riskScore": 42 }),
        },
        now_ms(),
    )
    .await
    .expect("state");
    let policy = load_ledger_policy(&master, None, &subject, DeliveryRates::default(), now_ms())
        .await
        .expect("policy");
    assert_eq!(policy.policy.state, OutboundState::Restricted);
    assert_eq!(policy.policy.state_set_by.as_deref(), Some("system"));
    assert_eq!(policy.policy.limits.sender_per_hour, 10);

    let case = OpenCase {
        subject: Some(subject.clone()),
        trigger: "bounce_rate".to_owned(),
        severity: CaseSeverity::Warning,
        summary: "Hard bounces at 9.0% over 7 days.".to_owned(),
        risk_score: Some(42),
        state: Some("restricted".to_owned()),
        template: None,
        metrics: vec![("hardBounces7d".to_owned(), json!(9))],
    };
    assert!(open_outbound_case(&master, &case, now_ms()).await.is_some());
    // The same trigger the same day is a repeat.
    assert!(open_outbound_case(&master, &case, now_ms()).await.is_none());
    let kinds: Vec<String> = sqlx::query_scalar(
        "select kind from outbound_mail_events where workspace_id = 'ws_obt' order by created_at, kind",
    )
    .fetch_all(&master)
    .await
    .expect("events");
    assert!(kinds.contains(&"state_changed".to_owned()));
    assert!(kinds.contains(&"case_opened".to_owned()));
    let metrics: serde_json::Value =
        sqlx::query_scalar("select metrics from outbound_mail_cases where workspace_id = 'ws_obt'")
            .fetch_one(&master)
            .await
            .expect("case");
    assert_eq!(metrics["summary"], "Hard bounces at 9.0% over 7 days.");
    assert_eq!(metrics["state"], "restricted");
    assert_eq!(metrics["hardBounces7d"], 9);
}
