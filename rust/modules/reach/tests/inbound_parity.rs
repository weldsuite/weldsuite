//! Parity with reach-api's inbound reply path. Its
//! `src/testing/rust-inbound-fixtures.test.ts` ran the TypeScript parser and
//! whole deliveries (`deliverInbound`) on pglite and wrote what they did into
//! `tests/fixtures/inbound_*.json`. These tests run the Rust port on the same
//! messages and seeds and compare: the parsed message, its kind, bounce,
//! reply text and opt-out; and for each delivery its result and entity
//! events, the raw copies kept and the rows left behind.
//!
//! The delivery test needs `WELDSUITE_TEST_TENANT_URL` (a tenant database
//! built by `scripts/rust-test-db.ts`) and skips without it. Regenerate the
//! fixtures with `pnpm rust:reach-inbound-fixtures`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use sqlx::{AssertSqlSafe, PgPool};
use weldsuite_ports::{DynFileStore, MemoryFileStore};
use weldsuite_reach::inbound::bounce::BounceInfo;
use weldsuite_reach::inbound::deliver::candidate_message_ids;
use weldsuite_reach::inbound::handler::threading_ids_of;
use weldsuite_reach::inbound::parse::{ParsedInbound, parse_inbound};
use weldsuite_reach::inbound::rules::{classify_inbound, is_unsubscribe_request};
use weldsuite_reach::inbound::{DeliverInput, InboundMailbox, deliver_inbound};
use weldsuite_reach::weldsuite_reach_domain::text::strip_quoted_history;
use weldsuite_reach::weldsuite_reach_domain::{EventSink, ReachEvent, iso, parse_iso};

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).expect("the fixture exists");
    serde_json::from_str(&text).expect("the fixture is JSON")
}

/// The generator writes integral numbers as JSON integers; compare numbers
/// by value.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|other| same(v, other)))
        }
        _ => a == b,
    }
}

fn assert_same(label: &str, actual: &Value, expected: &Value) {
    assert!(
        same(actual, expected),
        "{label}: differs\n--- rust\n{}\n--- typescript\n{}",
        serde_json::to_string_pretty(actual).unwrap_or_default(),
        serde_json::to_string_pretty(expected).unwrap_or_default()
    );
}

// ---------------------------------------------------------------------------
// Parsing and classifying
// ---------------------------------------------------------------------------

fn bounce_json(bounce: Option<&BounceInfo>) -> Value {
    bounce.map_or(Value::Null, |b| {
        json!({
            "recipients": b.recipients,
            "originalMessageId": b.original_message_id,
            "status": b.status,
            "action": b.action,
            "diagnostic": b.diagnostic,
            "permanent": b.permanent,
            "addressRejected": b.address_rejected,
            "source": b.source,
        })
    })
}

fn parsed_json(parsed: &ParsedInbound) -> Value {
    let headers: Map<String, Value> = parsed
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();
    json!({
        "messageId": parsed.message_id,
        "inReplyTo": parsed.in_reply_to,
        "references": parsed.references,
        "from": parsed.from.as_ref().map(|f| json!({ "email": f.email, "name": f.name })),
        "to": parsed.to,
        "subject": parsed.subject,
        "text": parsed.text,
        "headers": headers,
        "contentType": parsed.content_type,
        "reportParts": parsed.report_parts.iter().map(|p| json!({ "mimeType": p.mime_type, "text": p.text })).collect::<Vec<_>>(),
    })
}

#[test]
fn parsing_and_classifying_messages() {
    let f = fixture("inbound_parse");
    for case in f["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap_or_default();
        let raw = case["raw"].as_str().expect("raw");
        let parsed = parse_inbound(raw.as_bytes()).expect("parses");
        let classification = classify_inbound(&parsed);
        let reply_text = strip_quoted_history(&parsed.text);
        let actual = json!({
            "parsed": parsed_json(&parsed),
            "classification": {
                "kind": classification.kind,
                "bounce": bounce_json(classification.bounce.as_ref()),
                "autoReplyReason": classification.auto_reply_reason,
            },
            "replyText": reply_text,
            "optOut": is_unsubscribe_request(&parsed.subject, &reply_text),
            "threadingIds": threading_ids_of(&parsed),
            "candidateIds": candidate_message_ids(&parsed, classification.bounce.as_ref()),
        });
        assert_same(name, &actual, &case["expected"]);
    }
}

// ---------------------------------------------------------------------------
// Normalisation (the generator's `Placeholders`)
// ---------------------------------------------------------------------------

/// `^([a-z]+)_[0-9a-z]{12,}$`: an id `generateId` made; its prefix.
fn generated_prefix(text: &str) -> Option<&str> {
    let (prefix, rest) = text.split_once('_')?;
    (!prefix.is_empty()
        && prefix.bytes().all(|b| b.is_ascii_lowercase())
        && rest.len() >= 12
        && rest
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase()))
    .then_some(prefix)
}

fn is_iso(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() >= 20
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && text.ends_with('Z')
}

#[derive(Default)]
struct Placeholders {
    ids: HashMap<String, String>,
    counters: HashMap<String, usize>,
}

impl Placeholders {
    fn of(&mut self, prefix: &str, value: &str) -> String {
        if let Some(known) = self.ids.get(value) {
            return known.clone();
        }
        let n = self.counters.entry(prefix.to_owned()).or_default();
        *n += 1;
        let placeholder = format!("<{prefix}:{n}>");
        self.ids.insert(value.to_owned(), placeholder.clone());
        placeholder
    }

    fn text(&mut self, value: &str) -> String {
        if let Some(prefix) = generated_prefix(value) {
            return self.of(prefix, value);
        }
        // `reach/<org>/<id>.eml`.
        if let Some(rest) = value.strip_prefix("reach/")
            && let Some((org, file)) = rest.split_once('/')
            && let Some(id) = file.strip_suffix(".eml")
            && !org.is_empty()
            && id.contains('_')
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        {
            return format!("reach/{org}/{}.eml", self.text(id));
        }
        if is_iso(value) {
            if value >= "2026-10-20" {
                return "<ts>".to_owned();
            }
            return parse_iso(value).map_or_else(|| value.to_owned(), iso);
        }
        value.to_owned()
    }

    fn json(&mut self, value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(|v| self.json(v)).collect()),
            // serde_json keeps keys sorted, as the generator sorts them.
            Value::Object(map) => {
                Value::Object(map.iter().map(|(k, v)| (k.clone(), self.json(v))).collect())
            }
            Value::String(text) => Value::String(self.text(text)),
            other => other.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Whole deliveries
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RecordingEvents(Mutex<Vec<Value>>);

impl EventSink for RecordingEvents {
    fn emit(&self, event: ReachEvent) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(json!({
                "event": event.event.wire(),
                "entityId": event.entity_id,
                "data": event.data,
                "changes": event.changes.map(Value::Object),
            }));
    }
}

async fn tenant() -> Option<PgPool> {
    let url = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    Some(PgPool::connect(&url).await.expect("the tenant database"))
}

const RESET: [&str; 17] = [
    "delete from crm_activities",
    "delete from crm_opportunities",
    "delete from person_companies",
    "delete from people",
    "delete from companies",
    "delete from workspace_members",
    "delete from reach_messages",
    "delete from reach_enrollments",
    "delete from reach_campaign_mailboxes",
    "delete from reach_campaign_steps",
    "delete from reach_campaigns",
    "delete from reach_prospect_list_members",
    "delete from reach_prospect_lists",
    "delete from reach_prospects",
    "delete from reach_suppressions",
    "delete from reach_mailboxes",
    "delete from reach_settings",
];

const SEED_TABLES: [&str; 10] = [
    "reach_settings",
    "reach_mailboxes",
    "reach_campaigns",
    "reach_prospects",
    "reach_enrollments",
    "reach_messages",
    "reach_suppressions",
    "workspace_members",
    "companies",
    "people",
];

async fn seed(db: &PgPool, seed: &Value) {
    for table in SEED_TABLES {
        let sql =
            format!("insert into {table} select * from jsonb_populate_record(null::{table}, $1)");
        for row in seed[table].as_array().into_iter().flatten() {
            sqlx::query(AssertSqlSafe(sql.clone()))
                .bind(row)
                .execute(db)
                .await
                .unwrap_or_else(|e| panic!("seeding {table}: {e}"));
        }
    }
}

async fn reach_rows(db: &PgPool, table: &str, sort_key: &str) -> Value {
    let sql = format!("select to_jsonb(t) from {table} t");
    let rows: Vec<Value> = sqlx::query_scalar(AssertSqlSafe(sql))
        .fetch_all(db)
        .await
        .expect("rows");
    let mut rows: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
    rows.sort_by_key(|r| r[sort_key].as_str().unwrap_or_default().to_owned());
    Value::Array(rows)
}

/// The generator's `snapshot()`.
async fn snapshot(db: &PgPool, crm_queries: &Map<String, Value>) -> Value {
    let mut rows = Map::new();
    for (table, query) in crm_queries {
        let found: Vec<Value> =
            sqlx::query_scalar(AssertSqlSafe(query.as_str().expect("a query").to_owned()))
                .fetch_all(db)
                .await
                .expect("crm rows");
        rows.insert(table.clone(), Value::Array(found));
    }
    rows.insert(
        "reach_campaigns".into(),
        reach_rows(db, "reach_campaigns", "id").await,
    );
    rows.insert(
        "reach_enrollments".into(),
        reach_rows(db, "reach_enrollments", "id").await,
    );
    rows.insert(
        "reach_mailboxes".into(),
        reach_rows(db, "reach_mailboxes", "id").await,
    );
    rows.insert(
        "reach_messages".into(),
        reach_rows(db, "reach_messages", "messageIdHeader").await,
    );
    rows.insert(
        "reach_prospects".into(),
        reach_rows(db, "reach_prospects", "id").await,
    );
    rows.insert(
        "reach_suppressions".into(),
        reach_rows(db, "reach_suppressions", "value").await,
    );
    Value::Object(rows)
}

#[tokio::test]
async fn whole_deliveries() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set: skipping the inbound delivery parity");
        return;
    };
    let f = fixture("inbound_deliveries");
    let org = f["org"].as_str().expect("org");
    let now = parse_iso(f["now"].as_str().expect("now")).expect("an ISO time");
    let mailbox = InboundMailbox {
        id: f["mailbox"]["id"].as_str().expect("id").to_owned(),
        email: f["mailbox"]["email"].as_str().expect("email").to_owned(),
    };
    let crm_queries = f["crmQueries"].as_object().expect("crmQueries");
    for case in f["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().unwrap_or_default();
        for sql in RESET {
            sqlx::query(sql).execute(&db).await.expect(sql);
        }
        seed(&db, &case["seed"]).await;
        let bucket = Arc::new(MemoryFileStore::default());
        let storage: Arc<dyn DynFileStore> = bucket.clone();
        let mut deliveries = Vec::new();
        for message in case["messages"].as_array().expect("messages") {
            let raw = message["raw"].as_str().expect("raw").as_bytes();
            let events = RecordingEvents::default();
            let result = deliver_inbound(DeliverInput {
                db: &db,
                clerk_org_id: org,
                mailbox: &mailbox,
                raw,
                parsed: None,
                storage: Some(Arc::clone(&storage)),
                events: &events,
                now,
            })
            .await
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));
            let mut events = events
                .0
                .into_inner()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            events.sort_by_key(|e| e["event"].as_str().unwrap_or_default().to_owned());
            deliveries.push(json!({ "result": result.to_json(), "events": events }));
        }
        let mut p = Placeholders::default();
        let mut actual = p.json(&json!({
            "deliveries": deliveries,
            "rows": snapshot(&db, crm_queries).await,
            "storage": bucket.keys(),
        }));
        if let Some(links) = actual["rows"]["person_companies"].as_array_mut() {
            let key = |r: &Value| {
                format!(
                    "{}|{}",
                    r["personId"].as_str().unwrap_or("null"),
                    r["companyId"].as_str().unwrap_or("null")
                )
            };
            links.sort_by_key(key);
        }
        if let Some(keys) = actual["storage"].as_array_mut() {
            keys.sort_by_key(|k| k.as_str().unwrap_or_default().to_owned());
        }
        assert_same(name, &actual, &case["expected"]);
    }
}
