//! Threat protection end to end on the real schema: an infected attachment
//! is never stored and sends its message to Spam; while the scanner is down
//! files wait in quarantine and the workspace comes due; the rescan settles
//! them.
//!
//! Needs `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL`
//! (`scripts/rust-test-db.ts`); skipped without them.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;
use serde_json::json;
use sqlx::PgPool;
use weldsuite_mail_inbound::rescan::{RescanContext, rescan_due};
use weldsuite_mail_inbound::{FanOut, InboundContext, MailInboundSubscriber, StaticDbs};
use weldsuite_ports::{
    BatchHandler, Delivery, Disposition, DynFileStore, EICAR, FakeScanner, MemoryFileStore,
    PutOptions, VirusScanner,
};

const WS: &str = "ws_mailin_threats";

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

async fn seed(master: &PgPool, tenant: &PgPool) {
    exec(
        master,
        &[
            "delete from workspace_due_index where workspace_id = 'ws_mailin_threats'",
            "delete from mail_account_registry where workspace_id = 'ws_mailin_threats'",
            "delete from workspaces where id = 'ws_mailin_threats'",
            "insert into workspaces (id, name, slug, clerk_org_id) values ('ws_mailin_threats', 'Threats', 'mailin-threats', 'org_mailin_threats')",
            "insert into mail_account_registry (id, email, tenant_kind, workspace_id, account_id, is_active) values
               ('mreg_threats_1', 'inbox@mailin-threats.test', 'workspace', 'ws_mailin_threats', 'mbx_threats', true)",
        ],
    )
    .await;
    exec(
        tenant,
        &[
            "delete from mail_attachments where message_id in (select id from mail_messages where account_id = 'mbx_threats')",
            "delete from mail_messages where account_id = 'mbx_threats'",
            "delete from mail_accounts where id = 'mbx_threats'",
            "insert into mail_accounts (id, name, email, is_shared) values ('mbx_threats', 'Inbox', 'inbox@mailin-threats.test', true)",
        ],
    )
    .await;
}

/// A message to the test mailbox with a clean `notes.txt` and a
/// `report.pdf` holding `second_file`.
fn message_with_files(id: &str, second_file: &[u8]) -> String {
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    [
        "From: Stranger <s@stranger-threats.test>",
        "To: inbox@mailin-threats.test",
        "Subject: Quarterly notes",
        &format!("Message-ID: <{id}@stranger-threats.test>"),
        "Date: Mon, 26 Oct 2026 09:00:00 +0000",
        "MIME-Version: 1.0",
        "Content-Type: multipart/mixed; boundary=\"b\"",
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "See attached.",
        "--b",
        "Content-Type: text/plain; name=\"notes.txt\"",
        "Content-Disposition: attachment; filename=\"notes.txt\"",
        "Content-Transfer-Encoding: base64",
        "",
        &b64(b"just notes"),
        "--b",
        "Content-Type: application/octet-stream; name=\"report.pdf\"",
        "Content-Disposition: attachment; filename=\"report.pdf\"",
        "Content-Transfer-Encoding: base64",
        "",
        &b64(second_file),
        "--b--",
        "",
    ]
    .join("\r\n")
}

async fn deliver(
    subscriber: &MailInboundSubscriber,
    spool: &MemoryFileStore,
    key: &str,
    raw: &str,
) {
    spool
        .put_boxed(
            key,
            raw.as_bytes().to_vec(),
            &PutOptions::content_type("message/rfc822"),
        )
        .await
        .expect("spooled");
    let delivery = Delivery {
        subject: "mail.inbound".to_owned(),
        payload: json!({ "key": key, "rcptTo": ["inbox@mailin-threats.test"] })
            .to_string()
            .into_bytes(),
        attempt: 1,
        deferrals: 0,
    };
    assert_eq!(
        subscriber.handle(std::slice::from_ref(&delivery)).await,
        [Disposition::Ack]
    );
}

/// A message's attachments: file name, scan status, signature, storage path.
type ScanRow = (String, Option<String>, Option<String>, Option<String>);

async fn scan_rows(tenant: &PgPool, rfc_id: &str) -> Vec<ScanRow> {
    sqlx::query_as(
        "select a.file_name, a.scan_status, a.scan_signature, a.storage_path
         from mail_attachments a join mail_messages m on m.id = a.message_id
         where m.message_id = $1 order by a.file_name",
    )
    .bind(rfc_id)
    .fetch_all(tenant)
    .await
    .expect("rows")
}

async fn due_rows(master: &PgPool) -> i64 {
    sqlx::query_scalar(
        "select count(*) from workspace_due_index
         where kind = 'mail_attachment_scan' and workspace_id = 'ws_mailin_threats'",
    )
    .fetch_one(master)
    .await
    .expect("count")
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // the scan, the outage and the rescan
async fn infected_files_are_never_stored_and_pending_ones_are_rescanned() {
    let (Some(master), Some(tenant)) = (
        pool("WELDSUITE_TEST_MASTER_URL").await,
        pool("WELDSUITE_TEST_TENANT_URL").await,
    ) else {
        eprintln!("skipped: WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL are not set");
        return;
    };
    seed(&master, &tenant).await;

    let spool = Arc::new(MemoryFileStore::default());
    let storage = Arc::new(MemoryFileStore::default());
    let scanner = Arc::new(FakeScanner::new());
    let tenants = || Arc::new(StaticDbs(HashMap::from([(WS.to_owned(), tenant.clone())])));
    let ctx = InboundContext {
        master: master.clone(),
        tenants: tenants(),
        storage: Some(storage.clone() as Arc<dyn DynFileStore>),
        public_url: Some("https://files.example.test".to_owned()),
        mail_storage: Some(spool.clone() as Arc<dyn DynFileStore>),
        realtime: None,
        events: weldsuite_events::EntityEventPublisher::new(
            None,
            tokio_util::task::TaskTracker::new(),
        ),
        http: None,
        fan_out: FanOut {
            desk: false,
            books: false,
        },
        assignment_router: None,
        ai: None,
        scanner: Some(scanner.clone() as Arc<dyn VirusScanner>),
    };
    let subscriber = MailInboundSubscriber::new(ctx, spool.clone());

    // 1. EICAR: never stored; the message goes to Spam with a threats entry;
    //    the clean file is stored as before.
    deliver(
        &subscriber,
        &spool,
        "inbound/threats-1.eml",
        &message_with_files("threats-1", EICAR),
    )
    .await;
    let (labels, is_spam, threats): (serde_json::Value, Option<bool>, Option<serde_json::Value>) =
        sqlx::query_as(
            "select labels, is_spam, threats from mail_messages
             where message_id = '<threats-1@stranger-threats.test>'",
        )
        .fetch_one(&tenant)
        .await
        .expect("the message");
    assert_eq!(labels, json!(["SPAM"]));
    assert_eq!(is_spam, Some(true));
    let threats = threats.expect("threats");
    assert_eq!(threats[0]["kind"], "attachment");
    assert_eq!(threats[0]["fileName"], "report.pdf");
    assert_eq!(threats[0]["signature"], FakeScanner::EICAR_SIGNATURE);
    let rows = scan_rows(&tenant, "<threats-1@stranger-threats.test>").await;
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(
        rows[1],
        (
            "report.pdf".to_owned(),
            Some("infected".to_owned()),
            Some(FakeScanner::EICAR_SIGNATURE.to_owned()),
            None
        )
    );
    assert_eq!(rows[0].0, "notes.txt");
    assert_eq!(rows[0].1.as_deref(), Some("clean"));
    let stored = storage.keys();
    assert!(
        stored.iter().any(|k| k.ends_with("_notes.txt")),
        "{stored:?}"
    );
    assert!(
        !stored.iter().any(|k| k.ends_with("_report.pdf")),
        "{stored:?}"
    );

    // 2. The scanner is down: stored in the inbox, files in the mail
    //    bucket's quarantine, the workspace due.
    scanner.set_available(false);
    deliver(
        &subscriber,
        &spool,
        "inbound/threats-2.eml",
        &message_with_files("threats-2", b"harmless"),
    )
    .await;
    let labels: serde_json::Value = sqlx::query_scalar(
        "select labels from mail_messages where message_id = '<threats-2@stranger-threats.test>'",
    )
    .fetch_one(&tenant)
    .await
    .expect("the message");
    assert_eq!(labels, json!(["INBOX"]));
    let rows = scan_rows(&tenant, "<threats-2@stranger-threats.test>").await;
    assert_eq!(rows.len(), 2, "{rows:?}");
    for row in &rows {
        assert_eq!(row.1.as_deref(), Some("pending"), "{rows:?}");
        let path = row.3.as_deref().unwrap_or_default();
        assert!(
            path.starts_with("mail/ws_mailin_threats/mbx_threats/")
                && path.contains("/quarantine/"),
            "{rows:?}"
        );
    }
    assert_eq!(due_rows(&master).await, 1);

    // 3. The rescan with the scanner back: the files move to STORAGE, the
    //    quarantine empties and the due row goes.
    scanner.set_available(true);
    let rescan = RescanContext {
        master: master.clone(),
        tenants: tenants(),
        scanner: scanner.clone(),
        mail_storage: spool.clone(),
        storage: storage.clone(),
        public_url: Some("https://files.example.test".to_owned()),
    };
    let later = time::OffsetDateTime::now_utc() + std::time::Duration::from_mins(10);
    let report = rescan_due(&rescan, later).await.expect("the rescan");
    assert_eq!(report.clean, 2, "{report:?}");
    let rows = scan_rows(&tenant, "<threats-2@stranger-threats.test>").await;
    for row in &rows {
        assert_eq!(row.1.as_deref(), Some("clean"), "{rows:?}");
        assert!(
            row.3
                .as_deref()
                .is_some_and(|p| p.starts_with("workspaces/ws_mailin_threats/mail/attachments/")),
            "{rows:?}"
        );
    }
    assert!(!spool.keys().iter().any(|k| k.contains("/quarantine/")));
    assert_eq!(due_rows(&master).await, 0);
}
