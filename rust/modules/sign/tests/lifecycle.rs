//! The lifecycle sweep and the finalize job against the real schema: what
//! the conformance suite can't reach yet (the job is started by the signer
//! portal, the next stage) and the sweep's order of work.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are
//! set (`scripts/rust-test-db.ts` builds both; CI's `Rust · checks` sets
//! them), and skips otherwise. Every row it writes is its own (`LC`-prefixed
//! ids), and each test clears them first.

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use weldsuite_events::{EntityEventPublisher, TaskTracker, iso_timestamp};
use weldsuite_ports::{
    BoxFuture, DefaultFlags, DynFileStore, FileStores, MemoryCache, MemoryFileStore, PutOptions,
    RecordingEventBus, RecordingSystemMail,
};
use weldsuite_sign::pdf_render::{drawn_on_pages, text_of};
use weldsuite_sign::{
    FinalizeJob, FinalizeParams, Services, TenantRef, TenantResolver, finalize_request,
    run_lifecycle_sweep,
};

const ORIGINAL: &[u8] = include_bytes!("fixtures/pdf/original.pdf");
/// A 1×1 RGBA PNG, as the portal's signature pad sends.
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

struct Databases {
    master: PgPool,
    tenant: PgPool,
}

async fn databases() -> Option<Databases> {
    let (Ok(master), Ok(tenant)) = (
        std::env::var("WELDSUITE_TEST_MASTER_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
    ) else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    let connect = |url: String| async move {
        PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("database")
    };
    Some(Databases {
        master: connect(master).await,
        tenant: connect(tenant).await,
    })
}

/// Every workspace opens the test's tenant database.
struct Tenants {
    db: PgPool,
    org: String,
}

impl TenantResolver for Tenants {
    fn tenant<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<TenantRef, String>> {
        let tenant = TenantRef {
            db: self.db.clone(),
            workspace_id: reference.to_owned(),
            clerk_org_id: Some(self.org.clone()),
        };
        Box::pin(std::future::ready(Ok(tenant)))
    }
}

struct Doubles {
    events: Arc<RecordingEventBus>,
    mail: Arc<RecordingSystemMail>,
    files: Arc<MemoryFileStore>,
    services: Services,
}

fn doubles() -> Doubles {
    let events = Arc::new(RecordingEventBus::default());
    let mail = Arc::new(RecordingSystemMail::new());
    let files = Arc::new(MemoryFileStore::default());
    let services = Services {
        events: EntityEventPublisher::new(Some(events.clone()), TaskTracker::new()),
        files: Some(FileStores {
            private: files.clone(),
            public: None,
        }),
        mail: Some(mail.clone()),
        cache: Some(Arc::new(MemoryCache::new())),
        flags: Arc::new(DefaultFlags),
        portal_url: Some("https://sign.test".to_owned()),
        environment: Some("test".to_owned()),
    };
    Doubles {
        events,
        mail,
        files,
        services,
    }
}

fn now() -> OffsetDateTime {
    let now = OffsetDateTime::now_utc();
    now.replace_millisecond(now.millisecond()).expect("ms")
}

fn at(time: OffsetDateTime) -> String {
    iso_timestamp(time)
}

/// Clear one test's rows: its envelopes (ids starting with `prefix`) and
/// what hangs off them, its links and due-index rows.
async fn clear(db: &Databases, ws: &str, prefix: &str) {
    let pattern = format!("{prefix}%");
    for sql in [
        "delete from sign_events where envelope_id like $1",
        "delete from sign_fields where envelope_id like $1",
        "delete from sign_recipients where envelope_id like $1",
        "delete from sign_documents where envelope_id like $1",
        "delete from sign_envelopes where id like $1",
        "delete from files where metadata->'weldsign'->>'envelopeId' like $1",
    ] {
        sqlx::query(sql)
            .bind(&pattern)
            .execute(&db.tenant)
            .await
            .expect("clear");
    }
    sqlx::query("delete from sign_link_registry where workspace_id = $1")
        .bind(ws)
        .execute(&db.master)
        .await
        .expect("clear");
    sqlx::query("delete from workspace_due_index where workspace_id = $1")
        .bind(ws)
        .execute(&db.master)
        .await
        .expect("clear");
}

async fn envelope(db: &PgPool, id: &str, values: &[(&str, Value)]) {
    let stamp = at(now());
    let mut row = json!({
        "id": id, "kind": "envelope", "status": "draft", "title": format!("LC {id}"),
        "sender_user_id": "user_lc", "sender_name": "Gert", "sender_email": "gert@example.com",
        "signing_order_enabled": false, "created_at": stamp, "updated_at": stamp,
    });
    for (key, value) in values {
        row[*key] = value.clone();
    }
    sqlx::query(
        "insert into sign_envelopes select * from jsonb_populate_record(null::sign_envelopes, $1)",
    )
    .bind(row)
    .execute(db)
    .await
    .expect("envelope");
}

async fn recipient(db: &PgPool, envelope: &str, id: &str, name: &str, values: &[(&str, Value)]) {
    let mut row = json!({
        "id": id, "envelope_id": envelope, "role": "signer", "name": name,
        "email": format!("{}@example.com", name.to_lowercase()), "locale": "en",
        "routing_order": 1, "auth_mode": "link", "status": "pending", "reminders_sent": 0,
        "created_at": at(now()), "updated_at": at(now()),
    });
    for (key, value) in values {
        row[*key] = value.clone();
    }
    sqlx::query("insert into sign_recipients select * from jsonb_populate_record(null::sign_recipients, $1)")
        .bind(row)
        .execute(db)
        .await
        .expect("recipient");
}

async fn status_of(db: &PgPool, id: &str) -> String {
    sqlx::query_scalar("select status from sign_envelopes where id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("status")
}

/// The sweep test's requests: A has a reminder due, B is past its expiry,
/// C too but everyone signed; a live link for A seeds the workspace.
async fn seed_sweep(db: &Databases, ws: &str, org: &str, now: OffsetDateTime) {
    let day = Duration::days(1);
    // A: Ann was emailed four days ago; first reminder after 3 days, then every 3, at most 2.
    envelope(
        &db.tenant,
        "sgn_lcsa",
        &[
            ("status", json!("sent")),
            ("sent_at", json!(at(now - day * 4))),
            ("expires_at", json!(at(now + day * 10))),
            ("reminder_after_days", json!(3)),
            ("reminder_every_days", json!(3)),
            ("reminder_max_count", json!(2)),
        ],
    )
    .await;
    recipient(
        &db.tenant,
        "sgn_lcsa",
        "sgr_lcann",
        "Ann",
        &[
            ("status", json!("sent")),
            ("sent_at", json!(at(now - day * 4))),
        ],
    )
    .await;
    // B: past its expiry, Bob signed and Carl did not.
    envelope(
        &db.tenant,
        "sgn_lcsb",
        &[
            ("status", json!("in_progress")),
            ("expires_at", json!(at(now - Duration::hours(1)))),
        ],
    )
    .await;
    recipient(
        &db.tenant,
        "sgn_lcsb",
        "sgr_lcbob",
        "Bob",
        &[("status", json!("signed"))],
    )
    .await;
    recipient(
        &db.tenant,
        "sgn_lcsb",
        "sgr_lccarl",
        "Carl",
        &[("status", json!("opened"))],
    )
    .await;
    // C: past its expiry, but everyone signed: that is finalizing's job.
    envelope(
        &db.tenant,
        "sgn_lcsc",
        &[
            ("status", json!("in_progress")),
            ("expires_at", json!(at(now - Duration::hours(1)))),
        ],
    )
    .await;
    recipient(
        &db.tenant,
        "sgn_lcsc",
        "sgr_lcdan",
        "Dan",
        &[("status", json!("signed"))],
    )
    .await;
    // A live link seeds the workspace into the due index.
    sqlx::query(
        "insert into sign_link_registry (id, token_hash, workspace_id, clerk_org_id, envelope_id, recipient_id)
         values ('sgl_lc1', $1, $2, $3, 'sgn_lcsa', 'sgr_lcann')",
    )
    .bind(format!("{:064}", 1))
    .bind(ws)
    .bind(org)
    .execute(&db.master)
    .await
    .expect("link");
}

#[tokio::test]
async fn the_sweep_expires_reminds_and_stores_the_next_due_time() {
    let Some(db) = databases().await else {
        return;
    };
    let (ws, org) = ("ws_lc_sweep", "org_lc_sweep");
    clear(&db, ws, "sgn_lcs").await;
    let now = now();
    let day = Duration::days(1);
    seed_sweep(&db, ws, org, now).await;

    let doubles = doubles();
    let tenants: Arc<dyn TenantResolver> = Arc::new(Tenants {
        db: db.tenant.clone(),
        org: org.to_owned(),
    });
    let first = run_lifecycle_sweep(&db.master, &tenants, &doubles.services, now).await;
    assert!(first.seeded >= 1 && first.processed >= 1, "{first:?}");
    assert_eq!(
        (first.failed, first.expired, first.reminded),
        (0, 1, 1),
        "{first:?}"
    );
    assert_eq!(status_of(&db.tenant, "sgn_lcsb").await, "expired");
    assert_eq!(status_of(&db.tenant, "sgn_lcsc").await, "in_progress");
    let (sent, reminded_at): (i32, String) = sqlx::query_as(
        "select reminders_sent, to_char(last_reminded_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
         from sign_recipients where id = 'sgr_lcann'",
    )
    .fetch_one(&db.tenant)
    .await
    .expect("ann");
    assert_eq!((sent, reminded_at), (1, at(now)));

    // The expiry went out as an event, from the system, before the reminders.
    let events = doubles.events.payloads();
    let expired: Vec<&Value> = events
        .iter()
        .filter(|e| e["eventType"] == "sign_envelope:expired")
        .collect();
    assert_eq!(expired.len(), 1);
    assert_eq!(expired[0]["entityId"], "sgn_lcsb");
    assert_eq!(expired[0]["metadata"]["workspaceId"], org);
    assert_eq!(expired[0]["metadata"]["userId"], "system");
    assert_eq!(expired[0]["data"]["senderUserId"], "user_lc");

    // The sender heard who did not sign; Ann got a reminder with a link.
    let mail = doubles.mail.sent();
    let to_sender = mail
        .iter()
        .find(|m| m.subject.contains("expired"))
        .expect("expired mail");
    assert_eq!(to_sender.to[0].email, "gert@example.com");
    assert!(to_sender.text.contains("Carl"));
    assert!(
        to_sender
            .text
            .contains("https://app-test.weldsuite.org/w/org_lc_sweep/weldsign/sgn_lcsb")
    );
    let reminder = mail
        .iter()
        .find(|m| m.subject.starts_with("Reminder:"))
        .expect("reminder");
    assert_eq!(reminder.to[0].email, "ann@example.com");
    assert!(reminder.text.contains("https://sign.test/r/"));
    // The expired request's links stopped.
    let live: i64 = sqlx::query_scalar(
        "select count(*) from sign_link_registry where envelope_id = 'sgn_lcsb' and revoked_at is null",
    )
    .fetch_one(&db.master)
    .await
    .expect("links");
    assert_eq!(live, 0);

    // Next: Ann's second reminder, three days on.
    let next: String = sqlx::query_scalar(
        "select to_char(next_due_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
         from workspace_due_index where kind = 'sign_lifecycle' and workspace_id = $1",
    )
    .bind(ws)
    .fetch_one(&db.master)
    .await
    .expect("due row");
    assert_eq!(next, at(now + day * 3));

    // The same tick again: no seed, nothing due.
    let again = run_lifecycle_sweep(&db.master, &tenants, &doubles.services, now).await;
    assert_eq!(
        (again.seeded, again.reminded, again.expired),
        (0, 0, 0),
        "{again:?}"
    );
    clear(&db, ws, "sgn_lcs").await;
}

/// A request whose only signer signed: one document (the fixture) with a
/// signature and a text value, a copy recipient, the consent and signature
/// on the trail.
async fn seed_final(
    db: &Databases,
    doubles: &Doubles,
    org: &str,
    id: &str,
    sender: &str,
    now: OffsetDateTime,
) {
    envelope(
        &db.tenant,
        id,
        &[
            ("status", json!("in_progress")),
            ("title", json!("LC Contract")),
            ("sender_user_id", json!(sender)),
            ("sent_at", json!(at(now - Duration::days(1)))),
        ],
    )
    .await;
    let doc_key = format!("workspaces/{org}/weldsign/{id}/doc.pdf");
    doubles
        .files
        .put_boxed(
            &doc_key,
            ORIGINAL.to_vec(),
            &PutOptions::content_type("application/pdf"),
        )
        .await
        .expect("original");
    sqlx::query(
        "insert into sign_documents (id, envelope_id, name, position, storage_key, size_bytes, page_count, page_sizes, sha256)
         values ('sgd_lc1', $1, 'agreement.pdf', 0, $2, $3, 5, '[]'::jsonb, $4)",
    )
    .bind(id)
    .bind(&doc_key)
    .bind(i32::try_from(ORIGINAL.len()).expect("size"))
    .bind("a".repeat(64))
    .execute(&db.tenant)
    .await
    .expect("document");
    recipient(
        &db.tenant,
        id,
        "sgr_lcdee",
        "Dee",
        &[
            ("status", json!("signed")),
            ("signed_at", json!(at(now - Duration::hours(1)))),
            ("signed_ip", json!("203.0.113.9")),
            ("signed_user_agent", json!("LcTest/1.0")),
        ],
    )
    .await;
    recipient(
        &db.tenant,
        id,
        "sgr_lceve",
        "Eve",
        &[("role", json!("cc")), ("routing_order", json!(2))],
    )
    .await;
    let sig_key = format!("workspaces/{org}/weldsign/{id}/sig.png");
    doubles
        .files
        .put_boxed(
            &sig_key,
            STANDARD.decode(PNG).expect("png"),
            &PutOptions::content_type("image/png"),
        )
        .await
        .expect("signature");
    for (field, kind, value, key) in [
        ("sgf_lc1", "signature", None, Some(sig_key.as_str())),
        ("sgf_lc2", "text", Some("Director"), None),
    ] {
        sqlx::query(
            "insert into sign_fields (id, envelope_id, document_id, recipient_id, type, page, x, y, width, height, value, signature_key, filled_at)
             values ($1, $2, 'sgd_lc1', 'sgr_lcdee', $3, 0, 50, 100, 160, 40, $4, $5, now())",
        )
        .bind(field)
        .bind(id)
        .bind(kind)
        .bind(value)
        .bind(key)
        .execute(&db.tenant)
        .await
        .expect("field");
    }
    sqlx::query(
        "insert into sign_events (id, envelope_id, recipient_id, type, details)
         values ('sge_lc1', $1, 'sgr_lcdee', 'consented', null),
                ('sge_lc2', $1, 'sgr_lcdee', 'signed', '{\"signatureKind\":\"drawn\"}'::jsonb)",
    )
    .bind(id)
    .execute(&db.tenant)
    .await
    .expect("events");
}

#[tokio::test]
async fn finalizing_builds_the_signed_pdf_mails_it_and_files_a_copy() {
    let Some(db) = databases().await else {
        return;
    };
    let (ws, org) = ("ws_lc_final", "org_lc_final");
    clear(&db, ws, "sgn_lcf").await;
    let now = now();
    let id = "sgn_lcf1";
    let doubles = doubles();
    let sender = format!("user_lc_{}", now.unix_timestamp_nanos());
    seed_final(&db, &doubles, org, id, &sender, now).await;

    let job = FinalizeJob {
        tenants: Arc::new(Tenants {
            db: db.tenant.clone(),
            org: org.to_owned(),
        }),
        master: db.master.clone(),
        services: doubles.services.clone(),
    };
    let params = FinalizeParams {
        clerk_org_id: org.to_owned(),
        workspace_id: ws.to_owned(),
        envelope_id: id.to_owned(),
    };
    finalize_request(&job, &params).await.expect("finalize");

    // Completed, with the stored file's hash.
    let (status, sha, key): (String, String, String) = sqlx::query_as(
        "select status, final_sha256, final_storage_key from sign_envelopes where id = $1",
    )
    .bind(id)
    .fetch_one(&db.tenant)
    .await
    .expect("envelope");
    assert_eq!(status, "completed");
    assert_eq!(key, format!("workspaces/{org}/weldsign/{id}/final.pdf"));
    let stored = doubles
        .files
        .get_boxed(&key)
        .await
        .expect("get")
        .expect("final pdf");
    assert_eq!(weldsuite_sign_test_sha(&stored.bytes), sha);

    // The documents with their values, then the certificate.
    let pages = drawn_on_pages(&stored.bytes).expect("read");
    assert_eq!(pages.len(), 6);
    assert!(text_of(&pages[0]).contains(&"Director".to_owned()));
    let certificate = text_of(&pages[5]);
    assert_eq!(certificate[0], "Certificate of completion");
    for line in [
        "LC Contract",
        "Dee <dee@example.com>",
        "Drawn",
        "203.0.113.9",
        "LcTest/1.0",
        "Receives a copy",
    ] {
        assert!(
            certificate.contains(&line.to_owned()),
            "{line} in {certificate:?}"
        );
    }

    // Everyone heard: Dee and Eve with a download link and the PDF, the sender with the request.
    let mail = doubles.mail.sent();
    let mut to: Vec<&str> = mail.iter().map(|m| m.to[0].email.as_str()).collect();
    to.sort_unstable();
    assert_eq!(
        to,
        ["dee@example.com", "eve@example.com", "gert@example.com"]
    );
    let eve = mail
        .iter()
        .find(|m| m.to[0].email == "eve@example.com")
        .expect("eve");
    assert_eq!(eve.attachments[0].content_type, "application/pdf");
    assert_eq!(eve.attachments[0].filename, "LC Contract.pdf");
    assert!(eve.text.contains("https://sign.test/r/"));

    assert_trail_event_and_copy(&db, &doubles, id, &sha, now).await;

    // Finishing again changes nothing.
    finalize_request(&job, &params).await.expect("again");
    assert_eq!(doubles.mail.sent().len(), 3);
    let filed: i64 = sqlx::query_scalar(
        "select count(*) from sign_events where envelope_id = $1 and type = 'filed'",
    )
    .bind(id)
    .fetch_one(&db.tenant)
    .await
    .expect("filed");
    assert_eq!(filed, 1);
    clear(&db, ws, "sgn_lcf").await;
}

/// The trail, the event, and the copy in the sender's WeldSign/<year>.
async fn assert_trail_event_and_copy(
    db: &Databases,
    doubles: &Doubles,
    id: &str,
    sha: &str,
    now: OffsetDateTime,
) {
    let trail: Vec<String> = sqlx::query_scalar(
        "select type from sign_events where envelope_id = $1 order by created_at, id",
    )
    .bind(id)
    .fetch_all(&db.tenant)
    .await
    .expect("trail");
    for kind in ["completed", "delivered", "filed"] {
        assert!(trail.contains(&kind.to_owned()), "{kind} in {trail:?}");
    }
    let events = doubles.events.payloads();
    let types: Vec<&str> = events
        .iter()
        .filter_map(|e| e["eventType"].as_str())
        .collect();
    for kind in ["sign_envelope:completed", "folder:created", "file:created"] {
        assert!(types.contains(&kind), "{kind} in {types:?}");
    }
    let completed = events
        .iter()
        .find(|e| e["eventType"] == "sign_envelope:completed")
        .expect("completed");
    assert_eq!(completed["data"]["finalSha256"], sha);
    let (folder, parent): (String, String) = sqlx::query_as(
        "select f.name, p.name from files c join folders f on f.id = c.folder_id join folders p on p.id = f.parent_id
         where c.metadata->'weldsign'->>'envelopeId' = $1 and c.deleted_at is null",
    )
    .bind(id)
    .fetch_one(&db.tenant)
    .await
    .expect("copy");
    assert_eq!(
        (parent.as_str(), folder),
        ("WeldSign", now.year().to_string())
    );
}

fn weldsuite_sign_test_sha(bytes: &[u8]) -> String {
    hex::encode(aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, bytes))
}
