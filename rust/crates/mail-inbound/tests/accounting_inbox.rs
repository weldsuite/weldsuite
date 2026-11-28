//! The accounting inbox on the real schema (phase 3 of WeldBooks): a document
//! books into the legal entity whose address it was sent to, the workspace's
//! own address into the default entity, every document is announced for the
//! OCR on arrival, and an e-mail with no attachment makes a document only when
//! its body could be stored (bug 10: it used to point at an `email.html` that
//! was never uploaded).
//!
//! Needs `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL`
//! (`scripts/rust-test-db.ts`); skipped without them.

#![allow(
    clippy::disallowed_methods,
    clippy::too_many_lines,
    clippy::unwrap_used,
    clippy::assert_is_empty,
    reason = "test fixtures are written in SQL; one scenario read top to bottom"
)]

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_events::EntityEventPublisher;
use weldsuite_mail_inbound::fanout::inbox_entity;
use weldsuite_mail_inbound::{FanOut, InboundContext, MailInboundSubscriber, StaticDbs};
use weldsuite_ports::{
    BatchHandler, Delivery, Disposition, DynEventBus, DynFileStore, MemoryFileStore, PutOptions,
    RecordingEventBus,
};

const WS: &str = "ws_mailin_acct";

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

fn pdf_message(id: &str, to: &str) -> String {
    let pdf = base64::engine::general_purpose::STANDARD.encode(b"%PDF-1.4\n%%EOF\n");
    [
        "From: Supplier <billing@supplier-acct.test>",
        &format!("To: {to}"),
        "Subject: Invoice 2026-1",
        &format!("Message-ID: <{id}@supplier-acct.test>"),
        "Date: Mon, 26 Oct 2026 09:00:00 +0000",
        "MIME-Version: 1.0",
        "Content-Type: multipart/mixed; boundary=\"b\"",
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "Invoice attached.",
        "--b",
        "Content-Type: application/pdf; name=\"invoice.pdf\"",
        "Content-Disposition: attachment; filename=\"invoice.pdf\"",
        "Content-Transfer-Encoding: base64",
        "",
        &pdf,
        "--b--",
        "",
    ]
    .join("\r\n")
}

fn html_message(id: &str, to: &str) -> String {
    [
        "From: Supplier <billing@supplier-acct.test>",
        &format!("To: {to}"),
        "Subject: Your invoice, in the mail",
        &format!("Message-ID: <{id}@supplier-acct.test>"),
        "Date: Mon, 26 Oct 2026 09:00:00 +0000",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><body><p>Invoice 77: EUR 121.00</p></body></html>",
        "",
    ]
    .join("\r\n")
}

async fn deliver(
    subscriber: &MailInboundSubscriber,
    spool: &MemoryFileStore,
    id: &str,
    to: &str,
    raw: &str,
) {
    let key = format!("inbound/{id}.eml");
    spool
        .put_boxed(
            &key,
            raw.as_bytes().to_vec(),
            &PutOptions::content_type("message/rfc822"),
        )
        .await
        .expect("spooled");
    let delivery = Delivery {
        subject: "mail.inbound".to_owned(),
        payload: json!({ "key": key, "rcptTo": [to] })
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

async fn documents(tenant: &PgPool, subject: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "select to_jsonb(d) from documents d where email_subject = $1 order by created_at",
    )
    .bind(subject)
    .fetch_all(tenant)
    .await
    .expect("documents")
}

#[tokio::test]
async fn a_document_books_into_the_entity_of_its_address() {
    let (Some(master), Some(tenant)) = (
        pool("WELDSUITE_TEST_MASTER_URL").await,
        pool("WELDSUITE_TEST_TENANT_URL").await,
    ) else {
        eprintln!("skipped: WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL are not set");
        return;
    };
    let (a, b) = ("ent_inbox_a", "ent_inbox_b");
    exec(
        &master,
        &[
            "delete from workspace_due_index where workspace_id = 'ws_mailin_acct'",
            "delete from mail_account_registry where workspace_id = 'ws_mailin_acct'",
            "delete from workspaces where id = 'ws_mailin_acct'",
            "insert into workspaces (id, name, slug, clerk_org_id) values ('ws_mailin_acct', 'Acct', 'mailin-acct', 'org_mailin_acct')",
            "insert into mail_account_registry (id, email, tenant_kind, workspace_id, account_id, is_active) values
               ('mreg_acct_1', 'books@mailin-acct.test', 'workspace', 'ws_mailin_acct', 'acct_inbox_ws_mailin_acct', true),
               ('mreg_acct_2', 'a@mailin-acct.test', 'workspace', 'ws_mailin_acct', 'acct_inbox_ws_mailin_acct', true),
               ('mreg_acct_3', 'b@mailin-acct.test', 'workspace', 'ws_mailin_acct', 'acct_inbox_ws_mailin_acct', true)",
        ],
    )
    .await;
    exec(
        &tenant,
        &[
            "delete from settings",
            "delete from documents where email_subject in ('Invoice 2026-1', 'Your invoice, in the mail')",
            "delete from accounting_entity_settings where entity_id in ('ent_inbox_a', 'ent_inbox_b')",
            "delete from entities where id in ('ent_inbox_a', 'ent_inbox_b')",
            "update entities set is_default = false where is_default",
            "insert into entities (id, name, jurisdiction_code, base_currency, is_active, is_default) values
               ('ent_inbox_a', 'Entity A', 'NL', 'EUR', true, false),
               ('ent_inbox_b', 'Entity B', 'NL', 'EUR', true, true)",
            "insert into accounting_entity_settings (entity_id) values ('ent_inbox_a'), ('ent_inbox_b')",
            "insert into settings (id, email_settings) values ('acs_inbox_test',
               '{\"autoScanEnabled\": true, \"inboxAddress\": \"books@mailin-acct.test\", \"entityInboxes\": {\"ent_inbox_a\": \"a@mailin-acct.test\", \"ent_inbox_b\": \"b@mailin-acct.test\"}}'::jsonb)",
        ],
    )
    .await;

    // Which entity an address books into.
    assert_eq!(
        inbox_entity(&tenant, &["a@mailin-acct.test".to_owned()])
            .await
            .unwrap()
            .as_deref(),
        Some(a)
    );
    assert_eq!(
        inbox_entity(&tenant, &["A@MAILIN-ACCT.TEST".to_owned()])
            .await
            .unwrap()
            .as_deref(),
        Some(a),
        "addresses compare without case"
    );
    assert_eq!(
        inbox_entity(&tenant, &["books@mailin-acct.test".to_owned()])
            .await
            .unwrap()
            .as_deref(),
        Some(b),
        "the workspace's own address books into the default entity"
    );

    let spool = Arc::new(MemoryFileStore::default());
    let storage = Arc::new(MemoryFileStore::default());
    let bus = Arc::new(RecordingEventBus::new());
    let ctx =
        |storage: Option<Arc<dyn DynFileStore>>, bus: &Arc<RecordingEventBus>| InboundContext {
            master: master.clone(),
            tenants: Arc::new(StaticDbs(HashMap::from([(WS.to_owned(), tenant.clone())]))),
            storage,
            public_url: Some("https://files.example.test".to_owned()),
            mail_storage: Some(spool.clone() as Arc<dyn DynFileStore>),
            realtime: None,
            events: EntityEventPublisher::new(
                Some(Arc::clone(bus) as Arc<dyn DynEventBus>),
                tokio_util::task::TaskTracker::new(),
            ),
            http: None,
            fan_out: FanOut {
                desk: false,
                books: true,
            },
            assignment_router: None,
            ai: None,
            scanner: None,
        };
    let subscriber = MailInboundSubscriber::new(
        ctx(Some(storage.clone() as Arc<dyn DynFileStore>), &bus),
        spool.clone(),
    );

    // An invoice to an entity's own address: that entity's document, and the
    // event the OCR on arrival listens for.
    deliver(
        &subscriber,
        &spool,
        "acct-1",
        "a@mailin-acct.test",
        &pdf_message("acct-1", "a@mailin-acct.test"),
    )
    .await;
    let docs = documents(&tenant, "Invoice 2026-1").await;
    assert_eq!(docs.len(), 1, "{docs:?}");
    assert_eq!(docs[0]["entity_id"], json!(a));
    assert_eq!(docs[0]["status"], json!("pending"));
    assert_eq!(docs[0]["source"], json!("email"));
    assert_eq!(docs[0]["type"], json!("purchase_invoice"));
    let events = bus.payloads();
    let created: Vec<&Value> = events
        .iter()
        .filter(|p| {
            p["entityType"] == json!("accounting_document") && p["action"] == json!("created")
        })
        .collect();
    assert_eq!(created.len(), 1, "{events:?}");
    assert_eq!(created[0]["entityId"], docs[0]["id"]);
    assert_eq!(created[0]["data"]["entityId"], json!(a));
    assert_eq!(created[0]["metadata"]["workspaceId"], json!(WS));
    let key = docs[0]["file_key"].as_str().unwrap();
    assert!(
        storage.keys().iter().any(|k| k == key),
        "the file is stored"
    );

    // The other entity's address, and the workspace's own address (the default
    // entity, B).
    deliver(
        &subscriber,
        &spool,
        "acct-2",
        "b@mailin-acct.test",
        &pdf_message("acct-2", "b@mailin-acct.test"),
    )
    .await;
    deliver(
        &subscriber,
        &spool,
        "acct-3",
        "books@mailin-acct.test",
        &pdf_message("acct-3", "books@mailin-acct.test"),
    )
    .await;
    let docs = documents(&tenant, "Invoice 2026-1").await;
    let entities: Vec<&str> = docs
        .iter()
        .map(|d| d["entity_id"].as_str().unwrap())
        .collect();
    assert_eq!(entities, [a, b, b]);

    // Bug 10: an e-mail with no attachment stores its body, and the document
    // points at it.
    deliver(
        &subscriber,
        &spool,
        "acct-4",
        "a@mailin-acct.test",
        &html_message("acct-4", "a@mailin-acct.test"),
    )
    .await;
    let html = documents(&tenant, "Your invoice, in the mail").await;
    assert_eq!(html.len(), 1, "{html:?}");
    assert_eq!(html[0]["entity_id"], json!(a));
    assert_eq!(html[0]["mime_type"], json!("text/html"));
    let key = html[0]["file_key"].as_str().unwrap();
    assert!(key.ends_with("/email.html"), "{key}");
    let stored = storage
        .get_boxed(key)
        .await
        .expect("read")
        .expect("the body is stored");
    assert!(String::from_utf8_lossy(&stored.bytes).contains("Invoice 77"));
    assert_eq!(
        html[0]["file_size"].as_i64(),
        Some(i64::try_from(stored.bytes.len()).unwrap())
    );

    // Without a place to put the body there is no document to point at it.
    exec(
        &tenant,
        &["delete from documents where email_subject = 'Your invoice, in the mail'"],
    )
    .await;
    let bus_none = Arc::new(RecordingEventBus::new());
    let without = MailInboundSubscriber::new(ctx(None, &bus_none), spool.clone());
    deliver(
        &without,
        &spool,
        "acct-5",
        "a@mailin-acct.test",
        &html_message("acct-5", "a@mailin-acct.test"),
    )
    .await;
    assert!(
        documents(&tenant, "Your invoice, in the mail")
            .await
            .is_empty()
    );
    assert!(
        bus_none
            .payloads()
            .iter()
            .all(|p| p["entityType"] != json!("accounting_document")),
        "no document, no event"
    );

    exec(
        &tenant,
        &[
            "delete from settings",
            "update entities set is_default = false where id = 'ent_inbox_b'",
        ],
    )
    .await;
}
