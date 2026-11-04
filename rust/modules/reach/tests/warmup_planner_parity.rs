//! Parity with reach-warmup-worker's planner. Its
//! `src/testing/rust-fixtures.test.ts` seeded a pool and its earlier mail in
//! pglite, ran `runPlannerTick` on the scripted random sequence and wrote what
//! it started, planned and scheduled into `tests/fixtures/warmup_planner.json`;
//! this test seeds the same rows in the real master schema
//! (`WELDSUITE_TEST_MASTER_URL`; skipped without it), runs the Rust planner on
//! the same sequence and compares. Ids and Message-IDs are random on both
//! sides and left out. Regenerate with `pnpm rust:reach-warmup-fixtures`.
//!
//! The planner reads the pool without an order (the heap's), so the tables
//! are truncated and the rows inserted in the fixture's order, as pglite has
//! them.

use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ports::{BoxFuture, DefaultFlags, MemoryImap};
use weldsuite_reach::warmup_network::WarmupNetwork;
use weldsuite_reach::warmup_network::planner::run_planner;
use weldsuite_reach_domain::smtp::{SmtpConfig, SmtpEnvelope, SmtpSendResult, SmtpTransport};
use weldsuite_reach_domain::{epoch_ms, parse_iso};

fn fixture() -> Value {
    let path = format!(
        "{}/tests/fixtures/warmup_planner.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture")).expect("JSON")
}

/// The fixture's scripted source, from its beginning, cycling.
fn scripted(sequence: &[f64]) -> impl FnMut() -> f64 + Send + use<> {
    let sequence = sequence.to_vec();
    let mut i = 0;
    move || {
        let value = sequence[i % sequence.len()];
        i += 1;
        value
    }
}

/// The planner never sends.
struct NoSmtp;

impl SmtpTransport for NoSmtp {
    fn send(
        &self,
        _config: SmtpConfig,
        _envelope: SmtpEnvelope,
        _raw: String,
    ) -> BoxFuture<'_, Result<SmtpSendResult, String>> {
        Box::pin(std::future::ready(Err(
            "the planner sends nothing".to_owned()
        )))
    }
}

fn s(v: &Value) -> Option<&str> {
    v.as_str()
}

async fn seed(master: &PgPool, f: &Value) {
    sqlx::query("truncate reach_warmup_messages, reach_warmup_mailboxes")
        .execute(master)
        .await
        .expect("truncate");
    for m in f["pool"].as_array().expect("pool") {
        let id = s(&m["id"]).expect("id");
        let first = s(&m["firstName"]).expect("first name");
        let domain = s(&m["domain"]).expect("domain");
        sqlx::query(
            "insert into reach_warmup_mailboxes (id, workspace_id, clerk_org_id, tenant_mailbox_id, email, domain,
               mailbox_type, first_name, last_name, timezone, status, started_at, ramp_day, daily_target,
               planned_for, smtp_credentials, imap_credentials)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14, $15, 'sealed', 'sealed')",
        )
        .bind(id)
        .bind(s(&m["workspaceId"]))
        .bind(format!("org_{id}"))
        .bind(format!("rmb_{id}"))
        .bind(format!("{}@{domain}", first.to_lowercase()))
        .bind(domain)
        .bind(s(&m["mailboxType"]))
        .bind(first)
        .bind(s(&m["lastName"]))
        .bind(s(&m["timezone"]))
        .bind(s(&m["status"]))
        .bind(s(&m["startedAt"]))
        .bind(i32::try_from(m["rampDay"].as_i64().expect("ramp day")).expect("i32"))
        .bind(i32::try_from(m["dailyTarget"].as_i64().expect("target")).expect("i32"))
        .bind(s(&m["plannedFor"]))
        .execute(master)
        .await
        .expect("mailbox");
    }
    for m in f["history"].as_array().expect("history") {
        let id = s(&m["id"]).expect("id");
        sqlx::query(
            "insert into reach_warmup_messages (id, thread_id, step, from_mailbox_id, to_mailbox_id,
               corpus_thread_id, message_id_header, subject, status, scheduled_at)
             values ($1, $2, 0, $3, $4, $5, $6, 'Earlier', $7, $8::timestamptz)",
        )
        .bind(id)
        .bind(format!("rwth_{id}"))
        .bind(s(&m["from"]))
        .bind(s(&m["to"]))
        .bind(s(&m["corpusThreadId"]))
        .bind(format!("{id}@history.test"))
        .bind(s(&m["status"]))
        .bind(s(&m["scheduledAt"]))
        .execute(master)
        .await
        .expect("history");
    }
}

async fn rows(master: &PgPool, sql: &'static str) -> Vec<Value> {
    sqlx::query_scalar::<_, Value>(sql)
        .fetch_all(master)
        .await
        .expect(sql)
        .into_iter()
        .map(weldsuite_db::js_row)
        .collect()
}

#[tokio::test]
async fn a_planner_run_matches_typescript() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_MASTER_URL") else {
        eprintln!("skipped: WELDSUITE_TEST_MASTER_URL is not set");
        return;
    };
    let master = PgPool::connect(&url).await.expect("master");
    let f = fixture();
    seed(&master, &f).await;
    let net = WarmupNetwork {
        master: master.clone(),
        warmup_key: None,
        smtp: Arc::new(NoSmtp),
        imap: Arc::new(MemoryImap::new()),
        flags: Arc::new(DefaultFlags),
    };
    let sequence: Vec<f64> = serde_json::from_value(f["sequence"].clone()).expect("sequence");
    let now = epoch_ms(parse_iso(s(&f["now"]).expect("now")).expect("iso"));
    let mut rng = scripted(&sequence);
    let result = run_planner(&net, now, &mut rng).await.expect("planned");
    assert_eq!(
        json!({
            "status": result.status,
            "poolMailboxes": result.pool_mailboxes,
            "poolDomains": result.pool_domains,
            "started": result.started,
            "loginsRestored": result.logins_restored,
            "mailboxesPlanned": result.mailboxes_planned,
            "messagesPlanned": result.messages_planned,
        }),
        f["result"],
        "result"
    );

    let mut planned: Vec<Value> = rows(
        &master,
        "select to_jsonb(t) from reach_warmup_messages t where message_id_header not like '%@history.test'",
    )
    .await
    .into_iter()
    .map(|m| {
        json!({
            "from": m["fromMailboxId"],
            "to": m["toMailboxId"],
            "step": m["step"],
            "corpusThreadId": m["corpusThreadId"],
            "subject": m["subject"],
            "status": m["status"],
            "scheduledAt": m["scheduledAt"],
        })
    })
    .collect();
    let key = |m: &Value| {
        format!(
            "{}{}",
            s(&m["scheduledAt"]).unwrap_or_default(),
            s(&m["from"]).unwrap_or_default()
        )
    };
    planned.sort_by_key(key);
    let expected = f["planned"].as_array().expect("planned");
    assert_eq!(planned.len(), expected.len(), "planned messages");
    for (index, (actual, expected)) in planned.iter().zip(expected).enumerate() {
        assert_eq!(actual, expected, "planned message {index}");
    }

    let mailboxes: Vec<Value> = rows(
        &master,
        "select to_jsonb(t) from reach_warmup_mailboxes t order by id",
    )
    .await
    .into_iter()
    .map(|m| {
        json!({
            "id": m["id"],
            "status": m["status"],
            "rampDay": m["rampDay"],
            "dailyTarget": m["dailyTarget"],
            "plannedFor": m["plannedFor"],
            "startedAt": m["startedAt"],
        })
    })
    .collect();
    assert_eq!(Value::Array(mailboxes), f["mailboxes"], "mailboxes");

    sqlx::query("truncate reach_warmup_messages, reach_warmup_mailboxes")
        .execute(&master)
        .await
        .expect("truncate");
}
