//! The `mail.inbound` subscriber end to end on the real schema: the registry
//! lookup (MAIL-002: exact, catch-all, inactive), the `RCPT TO` answer, the
//! storage, the spool's removal and a redelivery that changes nothing.
//!
//! Needs `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL`
//! (`scripts/rust-test-db.ts`); skipped without them.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::json;
use sqlx::PgPool;
use weldsuite_mail_inbound::recipients::{RecipientMatch, lookup_recipient};
use weldsuite_mail_inbound::{FanOut, InboundContext, MailInboundSubscriber, StaticDbs};
use weldsuite_ports::{
    BatchHandler, Delivery, Disposition, DynFileStore, MemoryFileStore, PutOptions,
    RecordingRealtime,
};

async fn pool(var: &str) -> Option<PgPool> {
    let url = std::env::var(var).ok()?;
    Some(
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("the test database"),
    )
}

async fn exec(db: &PgPool, statements: &[&str]) {
    for statement in statements {
        sqlx::raw_sql(sqlx::AssertSqlSafe((*statement).to_owned()))
            .execute(db)
            .await
            .expect("the statement runs");
    }
}

const WS: &str = "ws_mailin_e2e";

async fn seed(master: &PgPool, tenant: &PgPool) {
    exec(
        master,
        &[
            "delete from mail_account_registry where workspace_id = 'ws_mailin_e2e'",
            "delete from workspaces where id = 'ws_mailin_e2e'",
            "insert into workspaces (id, name, slug, clerk_org_id) values ('ws_mailin_e2e', 'E2E', 'mailin-e2e', 'org_mailin_e2e')",
            "insert into mail_account_registry (id, email, tenant_kind, workspace_id, account_id, is_active) values
               ('mreg_e2e_1', 'hello@mailin-e2e.test', 'workspace', 'ws_mailin_e2e', 'mbx_e2e_hello', true),
               ('mreg_e2e_2', '*@mailin-e2e.test', 'workspace', 'ws_mailin_e2e', 'mbx_e2e_hello', true),
               ('mreg_e2e_3', 'old@mailin-e2e.test', 'workspace', 'ws_mailin_e2e', 'mbx_e2e_old', false)",
        ],
    )
    .await;
    exec(
        tenant,
        &[
            "delete from mail_messages where account_id = 'mbx_e2e_hello'",
            "delete from mail_accounts where id = 'mbx_e2e_hello'",
            "delete from workspace_members where id like 'wm_e2e_%'",
            "insert into mail_accounts (id, name, email, is_shared) values ('mbx_e2e_hello', 'Hello', 'hello@mailin-e2e.test', true)",
            "insert into workspace_members (id, user_id, email, role, status) values
               ('wm_e2e_1', 'user_e2e_1', 'one@mailin-e2e.test', 'OWNER', 'ACTIVE')",
        ],
    )
    .await;
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one delivery's whole story
async fn a_spooled_message_is_stored_once() {
    let (Some(master), Some(tenant)) = (
        pool("WELDSUITE_TEST_MASTER_URL").await,
        pool("WELDSUITE_TEST_TENANT_URL").await,
    ) else {
        eprintln!("skipped: WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL are not set");
        return;
    };
    seed(&master, &tenant).await;

    // The RCPT TO check: exact, catch-all on the custom domain, nothing for
    // another domain, and an inactive row is no match of its own.
    assert_eq!(
        lookup_recipient(&master, " Hello@MailIn-E2E.test ")
            .await
            .expect("looks up"),
        Some(RecipientMatch::Exact)
    );
    assert_eq!(
        lookup_recipient(&master, "anyone@mailin-e2e.test")
            .await
            .expect("looks up"),
        Some(RecipientMatch::CatchAll)
    );
    assert_eq!(
        lookup_recipient(&master, "old@mailin-e2e.test")
            .await
            .expect("looks up"),
        Some(RecipientMatch::CatchAll)
    );
    assert_eq!(
        lookup_recipient(&master, "x@elsewhere-e2e.test")
            .await
            .expect("looks up"),
        None
    );

    let spool = Arc::new(MemoryFileStore::default());
    let realtime = Arc::new(RecordingRealtime::new());
    let ctx = InboundContext {
        master: master.clone(),
        tenants: Arc::new(StaticDbs(HashMap::from([(WS.to_owned(), tenant.clone())]))),
        storage: None,
        public_url: None,
        mail_storage: Some(spool.clone() as Arc<dyn DynFileStore>),
        realtime: Some(realtime.clone()),
        events: weldsuite_events::EntityEventPublisher::new(
            None,
            tokio_util::task::TaskTracker::new(),
        ),
        http: None,
        fan_out: FanOut {
            desk: true,
            books: false,
        },
        assignment_router: None,
    };
    let subscriber = MailInboundSubscriber::new(ctx, spool.clone());
    let raw = "From: Partner <p@partner-e2e.test>\r\nTo: random@mailin-e2e.test\r\nSubject: Catch me\r\nMessage-ID: <e2e-1@partner-e2e.test>\r\nDate: Mon, 26 Oct 2026 09:00:00 +0000\r\n\r\nHello!\r\n";
    let key = "inbound/2026/10/26/e2e-1.eml";
    spool
        .put_boxed(
            key,
            raw.as_bytes().to_vec(),
            &PutOptions::content_type("message/rfc822"),
        )
        .await
        .expect("spooled");
    let envelope = json!({
        "key": key,
        "mailFrom": "p@partner-e2e.test",
        "rcptTo": ["random@mailin-e2e.test"],
    });
    let delivery = Delivery {
        subject: "mail.inbound".to_owned(),
        payload: envelope.to_string().into_bytes(),
        attempt: 1,
        deferrals: 0,
    };
    let dispositions = subscriber.handle(std::slice::from_ref(&delivery)).await;
    assert_eq!(dispositions, [Disposition::Ack]);

    let stored: Vec<(String, String, serde_json::Value)> = sqlx::query_as(
        "select message_id, subject, labels from mail_messages where account_id = 'mbx_e2e_hello'",
    )
    .fetch_all(&tenant)
    .await
    .expect("rows");
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].0, "<e2e-1@partner-e2e.test>");
    assert_eq!(stored[0].1, "Catch me");
    assert_eq!(stored[0].2, json!(["INBOX"]));
    // The raw MIME stays at the message's key; the spooled copy is gone.
    let keys = spool.keys();
    assert!(!keys.iter().any(|k| k == key), "{keys:?}");
    assert!(
        keys.iter()
            .any(|k| k.starts_with("mail/ws_mailin_e2e/mbx_e2e_hello/msg_")
                && k.ends_with("/raw.eml")),
        "{keys:?}"
    );
    // The member heard about it on their mail topic.
    let published = realtime.messages();
    assert!(
        published
            .iter()
            .any(|m| m.channel == "workspace:org_mailin_e2e"
                && m.payload["topic"] == "mail.user_e2e_1"
                && m.payload["event"] == "mail:new"),
        "{published:?}"
    );

    // A redelivery finds no spooled object and changes nothing.
    let again = subscriber.handle(std::slice::from_ref(&delivery)).await;
    assert_eq!(again, [Disposition::Ack]);
    let count: i64 =
        sqlx::query_scalar("select count(*) from mail_messages where account_id = 'mbx_e2e_hello'")
            .fetch_one(&tenant)
            .await
            .expect("count");
    assert_eq!(count, 1);

    // The same message spooled twice (a sender's retry) is stored once.
    spool
        .put_boxed(
            "inbound/again.eml",
            raw.as_bytes().to_vec(),
            &PutOptions::default(),
        )
        .await
        .expect("spooled");
    let retry = Delivery {
        payload: json!({ "key": "inbound/again.eml", "rcptTo": ["hello@mailin-e2e.test"] })
            .to_string()
            .into_bytes(),
        ..delivery
    };
    assert_eq!(subscriber.handle(&[retry]).await, [Disposition::Ack]);
    let count: i64 =
        sqlx::query_scalar("select count(*) from mail_messages where account_id = 'mbx_e2e_hello'")
            .fetch_one(&tenant)
            .await
            .expect("count");
    assert_eq!(count, 1);
}
