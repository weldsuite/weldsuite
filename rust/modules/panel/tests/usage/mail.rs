//! `services/usage-mail.test.ts`: the usage notice goes to every owner,
//! from WeldPanel, with the usage and a link into the workspace; a failed
//! address doesn't stop the others; the owners come from the workspace's
//! tenant database, its admins when no owner has an address.

use std::sync::atomic::{AtomicUsize, Ordering};

use weldsuite_db::master_pool;
use weldsuite_panel::usage_mail::{Recipient, notice_recipients, send_usage_notice, usage_url};
use weldsuite_panel::usage_settlement::UsageNotice;
use weldsuite_ports::{
    BoxFuture, DynSystemMail, OutgoingMail, PortError, RecordingSystemMail, SentMail, SystemMail,
};

const PLATFORM_URL: &str = "https://app-test.weldsuite.org";

fn notice(kind: &'static str) -> UsageNotice {
    UsageNotice {
        workspace_id: "ws_alpha".to_owned(),
        workspace_name: "Acme Staffing".to_owned(),
        clerk_org_id: Some("org_alpha".to_owned()),
        kind,
        month: "2026-11".to_owned(),
        events: (41_000, 50_000),
        recordings: (12, 500),
    }
}

fn to(email: &str, name: Option<&str>) -> Recipient {
    Recipient {
        email: email.to_owned(),
        name: name.map(str::to_owned),
    }
}

#[tokio::test]
async fn mails_every_owner_from_weldpanel_with_the_usage_and_a_link_into_the_workspace() {
    let transport = RecordingSystemMail::new();
    let sent = send_usage_notice(
        &transport,
        &[
            to("owner@acme.test", Some("Olga")),
            to("cofounder@acme.test", None),
        ],
        &notice("near"),
        Some(PLATFORM_URL),
    )
    .await;

    assert_eq!(sent, 2);
    let mails = transport.sent();
    assert_eq!(
        mails
            .iter()
            .map(|m| m.to.iter().map(|to| to.email.clone()).collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        [vec!["owner@acme.test"], vec!["cofounder@acme.test"]]
    );
    let mail = &mails[0];
    assert_eq!(mail.from.email, "notifications@mail.weldsuite.org");
    assert_eq!(mail.from.name.as_deref(), Some("WeldPanel"));
    assert_eq!(
        mail.subject,
        "Acme Staffing has used 80% of its WeldPanel allowance"
    );
    assert!(mail.html.contains("41,000 of 50,000"));
    assert!(
        mail.html
            .contains("https://app-test.weldsuite.org/w/org_alpha/weldpanel/settings?tab=usage")
    );
    assert!(mail.text.contains("Events: 41,000 of 50,000"));
}

#[tokio::test]
async fn writes_the_blocked_kinds_to_the_point_what_stopped() {
    let transport = RecordingSystemMail::new();
    let owner = [to("o@acme.test", None)];
    send_usage_notice(
        &transport,
        &owner,
        &notice("replay_blocked"),
        Some(PLATFORM_URL),
    )
    .await;
    send_usage_notice(
        &transport,
        &owner,
        &notice("events_blocked"),
        Some(PLATFORM_URL),
    )
    .await;

    let mails = transport.sent();
    assert_eq!(
        mails[0].subject,
        "WeldPanel stopped recording sessions for Acme Staffing"
    );
    assert_eq!(
        mails[1].subject,
        "WeldPanel is dropping events for Acme Staffing"
    );
    assert!(mails[1].text.contains("cannot be recovered"));
}

/// Refuses the first email, then hands the rest to a recording transport.
#[derive(Default)]
struct FirstRefused {
    calls: AtomicUsize,
    inner: RecordingSystemMail,
}

impl SystemMail for FirstRefused {
    fn send(&self, mail: OutgoingMail) -> impl Future<Output = Result<SentMail, PortError>> + Send {
        let refused: Option<BoxFuture<'_, Result<SentMail, PortError>>> =
            (self.calls.fetch_add(1, Ordering::SeqCst) == 0)
                .then(|| Box::pin(std::future::ready(Err(PortError::backend("rejected")))) as _);
        refused.unwrap_or_else(|| self.inner.send_boxed(mail))
    }
}

#[tokio::test]
async fn keeps_going_when_one_address_fails_and_counts_only_what_was_sent() {
    let transport = FirstRefused::default();
    let sent = send_usage_notice(
        &transport,
        &[to("a@acme.test", None), to("b@acme.test", None)],
        &notice("near"),
        Some(PLATFORM_URL),
    )
    .await;

    assert_eq!(sent, 1);
    assert_eq!(transport.inner.sent().len(), 1);
}

#[tokio::test]
async fn sends_nothing_to_no_one() {
    let transport = RecordingSystemMail::new();
    assert_eq!(
        send_usage_notice(&transport, &[], &notice("near"), Some(PLATFORM_URL)).await,
        0
    );
    assert_eq!(transport.sent().len(), 0);
}

#[test]
fn links_to_the_workspace_by_its_clerk_org_id_and_to_the_platform_origin_without_one() {
    assert_eq!(
        usage_url(Some(PLATFORM_URL), Some("org_alpha")),
        "https://app-test.weldsuite.org/w/org_alpha/weldpanel/settings?tab=usage"
    );
    assert_eq!(
        usage_url(None, None),
        "https://app.weldsuite.org/weldpanel/settings?tab=usage"
    );
}

/// The owners with an address, else the admins with one, on the real
/// tenant schema (`WELDSUITE_TEST_TENANT_URL`), inside a transaction that
/// is rolled back.
#[tokio::test]
async fn uses_the_owners_when_there_are_any_and_the_admins_otherwise() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        return;
    };
    let pool = master_pool(&url, 1).expect("tenant");
    let mut tx = pool.begin().await.expect("transaction");
    sqlx::query("delete from workspace_members")
        .execute(&mut *tx)
        .await
        .expect("clear");
    for (id, role, email, deleted) in [
        ("wm_owner", "OWNER", Some("owner@acme.test"), false),
        ("wm_owner_no_mail", "OWNER", None, false),
        ("wm_owner_gone", "OWNER", Some("gone@acme.test"), true),
        ("wm_admin", "ADMIN", Some("admin@acme.test"), false),
        ("wm_member", "MEMBER", Some("member@acme.test"), false),
    ] {
        sqlx::query(
            "insert into workspace_members (id, user_id, role, email, name, deleted_at)
             values ($1, $1, $2, $3, 'Olga', case when $4 then now() end)",
        )
        .bind(id)
        .bind(role)
        .bind(email)
        .bind(deleted)
        .execute(&mut *tx)
        .await
        .expect("member");
    }

    assert_eq!(
        notice_recipients(&mut tx).await.expect("recipients"),
        [to("owner@acme.test", Some("Olga"))]
    );

    sqlx::query("update workspace_members set email = null where role = 'OWNER'")
        .execute(&mut *tx)
        .await
        .expect("no owner address");
    assert_eq!(
        notice_recipients(&mut tx).await.expect("recipients"),
        [to("admin@acme.test", Some("Olga"))]
    );
    tx.rollback().await.expect("rollback");
}
