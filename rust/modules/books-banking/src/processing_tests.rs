//! The processing routes' handlers (edition feature `books-bank-processing`)
//! against the real tenant schema (`WELDSUITE_TEST_TENANT_URL`, built by
//! `scripts/rust-test-db.ts`; each test returns early without it): what each
//! answers, what it publishes, its refusals and the entity it is scoped to.
//! The handlers run behind a [`Caller`] on one entity and a recording event
//! bus; every row carries fresh ids, so runs share the database.

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::unused_async,
    reason = "test fixtures are written in SQL; each test is one scenario read top to bottom"
)]

use std::sync::Arc;

use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::bank_split::SplitLine;
use weldsuite_books_domain::differences;
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, validate_value};
use weldsuite_books_domain::tables::BANK_TRANSACTIONS;
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_ports::{DynEventBus, RecordingEventBus};

use crate::bank_links::{MatchBody, match_line, small_gap};
use crate::bank_processing::{
    attach, categorize_line, private_line, read_categorize, transfer_line, undo_processing,
    update_notes,
};
use crate::common::find_transaction;
use crate::rule_suggestions::suggest;

struct World {
    db: PgPool,
    state: BooksState,
    bus: Arc<RecordingEventBus>,
}

impl World {
    fn new() -> Option<Self> {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return None;
        };
        let db = weldsuite_db::master_pool(&url, 2).unwrap();
        let bus = Arc::new(RecordingEventBus::new());
        let tracker = TaskTracker::new();
        let state = BooksState::new(EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
            tracker,
        ));
        Some(Self { db, state, bus })
    }

    fn caller(&self, entity: &str) -> Caller {
        Caller::in_process(
            self.db.clone(),
            "ws_proc_test",
            "ws_proc_test",
            "user_proc",
            entity,
            None,
        )
    }

    /// The events published since the last call, as `entityType.action`
    /// with their data, in order.
    async fn events(&self) -> Vec<(String, Value)> {
        // The caller's outbox task ends with the caller, so let it run
        // instead of waiting for the tracker.
        for _ in 0..200 {
            tokio::task::yield_now().await;
        }
        let events = self
            .bus
            .payloads()
            .into_iter()
            .map(|payload| {
                (
                    format!(
                        "{}.{}",
                        payload["entityType"].as_str().unwrap_or_default(),
                        payload["action"].as_str().unwrap_or_default()
                    ),
                    payload["data"].clone(),
                )
            })
            .collect();
        self.bus.clear();
        events
    }
}

fn fresh(prefix: &str) -> String {
    weldsuite_kit::generate_id(prefix)
}

async fn account(
    db: &PgPool,
    entity: &str,
    code: &str,
    name: &str,
    kind: &str,
    side: &str,
) -> String {
    let id = fresh("acc");
    sqlx::query(
        "insert into accounts (id, entity_id, code, name, type, normal_side) values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&id)
    .bind(entity)
    .bind(code)
    .bind(name)
    .bind(kind)
    .bind(side)
    .execute(db)
    .await
    .unwrap();
    id
}

/// A Dutch BV with a bank account: (entity, bank account, its ledger account).
async fn company(db: &PgPool, iban: &str) -> (String, String, String) {
    let entity = fresh("ent");
    sqlx::query(
        r#"insert into entities (id, name, jurisdiction_code, base_currency, entity_type, is_active,
             tax_identifiers, bank_details, address)
           values ($1, 'Processing routes', 'NL', 'EUR', 'bv', true,
             '{"vatNumber": "NL123456789B01", "registrationNumber": "12345678"}'::jsonb, '{}'::jsonb,
             '{"street": "Main 1", "city": "Amsterdam", "postalCode": "1011AA", "country": "NL"}'::jsonb)"#,
    )
    .bind(&entity)
    .execute(db)
    .await
    .unwrap();
    account(db, &entity, "1300", "Debtors", "asset", "debit").await;
    account(db, &entity, "1600", "Creditors", "liability", "credit").await;
    let ledger = account(db, &entity, "1100", "Bank", "asset", "debit").await;
    let bank = fresh("bac");
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, iban, currency, ledger_account_id) \
         values ($1, $2, 'Bank', $3, 'EUR', $4)",
    )
    .bind(&bank)
    .bind(&entity)
    .bind(iban)
    .bind(&ledger)
    .execute(db)
    .await
    .unwrap();
    (entity, bank, ledger)
}

async fn line(
    db: &PgPool,
    entity: &str,
    bank: &str,
    amount: &str,
    description: &str,
    counterparty: (Option<&str>, Option<&str>),
) -> String {
    let id = fresh("btx");
    sqlx::query(
        "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, description, \
           counterparty_name, counterparty_iban, status) \
         values ($1, $2, $3, '2026-11-20', $4::numeric, $5, $6, $7, 'unreconciled')",
    )
    .bind(&id)
    .bind(entity)
    .bind(bank)
    .bind(amount)
    .bind(description)
    .bind(counterparty.0)
    .bind(counterparty.1)
    .execute(db)
    .await
    .unwrap();
    id
}

async fn row(db: &PgPool, id: &str) -> Value {
    BANK_TRANSACTIONS.find_live(db, id).await.unwrap().unwrap()
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

/// A handler's answer as (status, body).
async fn answer(reply: Reply) -> (u16, Value) {
    let response: Response = match reply {
        Ok(response) => response,
        Err(refusal) => refusal.respond("Failed"),
    };
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn data(body: &Value) -> &Value {
    &body["data"]
}

fn parts(lines: &Value) -> Result<Vec<SplitLine>, Refusal> {
    validate_value(&json!({ "lines": lines }), read_categorize)
}

#[tokio::test]
async fn categorize_books_a_split_and_publishes_how() {
    let Some(world) = World::new() else {
        return;
    };
    let (entity, bank, _) = company(&world.db, "NL91ABNA0417164300").await;
    let rent = account(&world.db, &entity, "4210", "Rent", "expense", "debit").await;
    let office = account(&world.db, &entity, "4300", "Office", "expense", "debit").await;
    let id = line(
        &world.db,
        &entity,
        &bank,
        "-150.00",
        "Rent and supplies",
        (Some("Vastgoed"), None),
    )
    .await;
    let caller = world.caller(&entity);

    let lines = parts(&json!([
        { "accountId": rent, "amount": "100.00", "description": "Rent" },
        { "accountId": office, "amount": 50 },
    ]))
    .unwrap();
    let (status, body) = answer(categorize_line(&caller, &world.state, &id, lines).await).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(data(&body)["status"], json!("reconciled"));
    assert_eq!(data(&body)["reconciliationType"], json!("manual"));
    assert_eq!(data(&body)["categoryAccountId"], json!(rent));
    assert_eq!(data(&body)["lines"], json!(2));
    let entry = text(data(&body), "journalEntryId").to_owned();
    assert_eq!(text(&row(&world.db, &id).await, "journalEntryId"), entry);
    let posted: i64 = sqlx::query_scalar(
        "select count(*) from journal_lines where journal_entry_id = $1 and deleted_at is null",
    )
    .bind(&entry)
    .fetch_one(&world.db)
    .await
    .unwrap();
    assert_eq!(
        posted, 3,
        "one bank line and one per category: a single entry"
    );

    let events = world.events().await;
    let names: Vec<&str> = events.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        [
            "bank_transaction.updated",
            "bank_transaction.processed",
            "journal_entry.created"
        ]
    );
    assert_eq!(events[1].1["how"], json!("category"));

    // Already processed, a sum that is off, a contact that isn't there.
    let again = parts(&json!([{ "accountId": rent, "amount": 150 }])).unwrap();
    let (status, body) = answer(categorize_line(&caller, &world.state, &id, again).await).await;
    assert_eq!(status, 400, "{body}");
    let off = line(&world.db, &entity, &bank, "-80.00", "Off", (None, None)).await;
    let short = parts(&json!([{ "accountId": rent, "amount": 79 }])).unwrap();
    let (status, body) = answer(categorize_line(&caller, &world.state, &off, short).await).await;
    assert_eq!(status, 400);
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("add up to 79.00 but the bank line is 80.00"),
        "{body}"
    );
    let stranger =
        parts(&json!([{ "accountId": rent, "amount": 80, "contactId": "acn_missing" }])).unwrap();
    let (status, body) = answer(categorize_line(&caller, &world.state, &off, stranger).await).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(text(&row(&world.db, &off).await, "status"), "unreconciled");
    assert!(
        world.events().await.is_empty(),
        "a refusal publishes nothing"
    );

    // The body: at least one line, each with an account and an amount.
    for bad in [
        json!([]),
        json!([{ "amount": 5 }]),
        json!([{ "accountId": "a" }]),
        json!("x"),
    ] {
        assert!(parts(&bad).is_err(), "{bad}");
    }

    // Another entity's request does not see the line.
    let (other, _, _) = company(&world.db, "NL12ABNA0000000002").await;
    let foreign = parts(&json!([{ "accountId": rent, "amount": 80 }])).unwrap();
    let (status, _) =
        answer(categorize_line(&world.caller(&other), &world.state, &off, foreign).await).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn transfer_private_and_undo_answer_and_publish() {
    let Some(world) = World::new() else {
        return;
    };
    let (entity, current, _) = company(&world.db, "NL91ABNA0417164300").await;
    // A second account of the same entity.
    let ledger = account(&world.db, &entity, "1200", "Savings", "asset", "debit").await;
    let savings = fresh("bac");
    sqlx::query("insert into bank_accounts (id, entity_id, name, iban, currency, ledger_account_id) values ($1, $2, 'Savings', 'NL86INGB0002445588', 'EUR', $3)")
        .bind(&savings).bind(&entity).bind(&ledger).execute(&world.db).await.unwrap();
    let caller = world.caller(&entity);

    let out = line(
        &world.db,
        &entity,
        &current,
        "-200.00",
        "To savings",
        (None, Some("NL86 INGB 0002 4455 88")),
    )
    .await;
    let arrives = line(
        &world.db,
        &entity,
        &savings,
        "200.00",
        "From current",
        (None, None),
    )
    .await;
    let (status, body) = answer(transfer_line(&caller, &world.state, &out, None).await).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(data(&body)["reconciliationType"], json!("transfer"));
    assert_eq!(data(&body)["counterpart"]["id"], json!(arrives));
    assert_eq!(data(&body)["counterpart"]["bankAccountId"], json!(savings));
    let transit = text(data(&body), "categoryAccountId").to_owned();
    for id in [&out, &arrives] {
        let booked = row(&world.db, id).await;
        assert_eq!(text(&booked, "reconciliationType"), "transfer");
        assert_eq!(text(&booked, "categoryAccountId"), transit);
    }
    let events = world.events().await;
    let processed: Vec<&Value> = events
        .iter()
        .filter(|(name, _)| name == "bank_transaction.processed")
        .map(|(_, data)| data)
        .collect();
    assert_eq!(processed.len(), 2, "both halves are announced");
    assert!(processed.iter().all(|d| d["how"] == json!("transfer")));

    // The other account must be another one of this entity's.
    let third = line(&world.db, &entity, &current, "-9.00", "Odd", (None, None)).await;
    let (status, _) =
        answer(transfer_line(&caller, &world.state, &third, Some(current.clone())).await).await;
    assert_eq!(status, 400);
    // Another entity's request does not see it.
    let (other, _, _) = company(&world.db, "NL12ABNA0000000002").await;
    let (status, _) =
        answer(transfer_line(&world.caller(&other), &world.state, &third, None).await).await;
    assert_eq!(status, 404);

    // Private: a BV's money goes to the current account with the director.
    let (status, body) = answer(private_line(&caller, &world.state, &third).await).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(data(&body)["reconciliationType"], json!("private"));
    let account_row: (String, String) =
        sqlx::query_as("select code, name from accounts where id = $1")
            .bind(text(data(&body), "categoryAccountId"))
            .fetch_one(&world.db)
            .await
            .unwrap();
    assert_eq!(
        account_row,
        ("1960".to_owned(), "Rekening-courant DGA".to_owned())
    );
    let events = world.events().await;
    assert!(
        events
            .iter()
            .any(|(name, d)| name == "bank_transaction.processed" && d["how"] == json!("private"))
    );
    let (status, _) = answer(private_line(&caller, &world.state, &third).await).await;
    assert_eq!(status, 400, "a processed line can't be booked again");

    // Undo: private, transfer (one half), nothing to undo, another entity.
    let (status, body) = answer(undo_processing(&caller, &world.state, &third).await).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(data(&body)["undone"], json!("private"));
    assert_eq!(data(&body)["status"], json!("unreconciled"));
    assert_eq!(
        text(&row(&world.db, &third).await, "status"),
        "unreconciled"
    );
    let events = world.events().await;
    let names: Vec<&str> = events.iter().map(|(name, _)| name.as_str()).collect();
    assert!(
        names.contains(&"bank_transaction.unprocessed") && names.contains(&"journal_entry.updated"),
        "{names:?}"
    );
    let (status, _) = answer(undo_processing(&caller, &world.state, &third).await).await;
    assert_eq!(status, 400);
    let (status, _) =
        answer(undo_processing(&world.caller(&other), &world.state, &out).await).await;
    assert_eq!(status, 404);
    let (status, body) = answer(undo_processing(&caller, &world.state, &out).await).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(data(&body)["undone"], json!("transfer"));
    assert_eq!(
        text(&row(&world.db, &arrives).await, "status"),
        "reconciled"
    );
}

#[tokio::test]
async fn attach_document_and_notes() {
    let Some(world) = World::new() else {
        return;
    };
    let (entity, bank, _) = company(&world.db, "NL91ABNA0417164300").await;
    let (other, _, _) = company(&world.db, "NL12ABNA0000000002").await;
    let id = line(&world.db, &entity, &bank, "-12.00", "Lunch", (None, None)).await;
    let caller = world.caller(&entity);
    let document = |entity: Option<&str>, linked: Option<(&str, &str)>| {
        let (db, entity) = (world.db.clone(), entity.map(str::to_owned));
        let linked = linked.map(|(a, b)| (a.to_owned(), b.to_owned()));
        async move {
            let id = fresh("doc");
            sqlx::query(
                "insert into documents (id, entity_id, file_name, file_key, file_size, mime_type, type, source, status, \
                   linked_entity_type, linked_entity_id) \
                 values ($1, $2, 'receipt.pdf', $3, 10, 'application/pdf', 'receipt', 'upload', \
                   case when $4::text is null then 'inbox' else 'linked' end, $4, $5)",
            )
            .bind(&id)
            .bind(entity)
            .bind(format!("k/{id}"))
            .bind(linked.as_ref().map(|l| l.0.clone()))
            .bind(linked.as_ref().map(|l| l.1.clone()))
            .execute(&db)
            .await
            .unwrap();
            id
        }
    };

    // A document with no entity, and one of the line's entity.
    let loose = document(None, None).await;
    let (status, body) = answer(attach(&caller, &world.state, &id, &loose).await).await;
    assert_eq!(status, 200, "{body}");
    let linked: (String, String, String, Option<String>) = sqlx::query_as(
        "select linked_entity_type, linked_entity_id, status, entity_id from documents where id = $1",
    )
    .bind(&loose)
    .fetch_one(&world.db)
    .await
    .unwrap();
    assert_eq!(
        linked,
        (
            "bank_transaction".to_owned(),
            id.clone(),
            "linked".to_owned(),
            Some(entity.clone())
        )
    );
    // Nothing is booked: the line is as it was.
    assert_eq!(text(&row(&world.db, &id).await, "status"), "unreconciled");
    let events = world.events().await;
    assert!(
        events
            .iter()
            .any(|(name, _)| name == "accounting_document.updated")
    );
    // The same document again is fine; another link is refused.
    let (status, _) = answer(attach(&caller, &world.state, &id, &loose).await).await;
    assert_eq!(status, 200);
    let elsewhere = document(Some(&entity), Some(("bill", "bill_1"))).await;
    let (status, body) = answer(attach(&caller, &world.state, &id, &elsewhere).await).await;
    assert_eq!(status, 400, "{body}");
    // A document of another entity, and one that isn't there, are not found.
    let foreign = document(Some(&other), None).await;
    for missing in [foreign.as_str(), "doc_missing"] {
        let (status, _) = answer(attach(&caller, &world.state, &id, missing).await).await;
        assert_eq!(status, 404);
    }
    // Another entity's request does not see the line.
    let (status, _) = answer(attach(&world.caller(&other), &world.state, &id, &loose).await).await;
    assert_eq!(status, 404);

    // Notes.
    let (status, body) =
        answer(update_notes(&caller, &world.state, &id, Some("Paid in cash".to_owned())).await)
            .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(data(&body)["notes"], json!("Paid in cash"));
    assert_eq!(text(&row(&world.db, &id).await, "notes"), "Paid in cash");
    let (status, body) = answer(update_notes(&caller, &world.state, &id, None).await).await;
    assert_eq!(status, 200, "{body}");
    assert!(row(&world.db, &id).await["notes"].is_null());
    let (status, _) = answer(
        update_notes(
            &world.caller(&other),
            &world.state,
            &id,
            Some("x".to_owned()),
        )
        .await,
    )
    .await;
    assert_eq!(status, 404);
    // `{ notes }` only: the body must carry it.
    assert!(
        validate_value(&json!({}), |issues, body| {
            issues.text(
                body,
                "notes",
                weldsuite_kit::validation::Presence::Nullable,
                None,
                Some(5000),
            )
        })
        .is_err()
    );
}

#[tokio::test]
async fn a_rule_is_suggested_after_the_same_booking_twice() {
    let Some(world) = World::new() else {
        return;
    };
    let (entity, bank, _) = company(&world.db, "NL91ABNA0417164300").await;
    let rent = account(&world.db, &entity, "4210", "Rent", "expense", "debit").await;
    let other = account(&world.db, &entity, "4300", "Office", "expense", "debit").await;
    let caller = world.caller(&entity);
    let book = |id: String, account: String| {
        let (caller, world) = (&caller, &world);
        async move {
            let amount = text(&row(&world.db, &id).await, "amount")
                .trim_start_matches('-')
                .to_owned();
            let lines = parts(&json!([{ "accountId": account, "amount": amount }])).unwrap();
            let (status, body) =
                answer(categorize_line(caller, &world.state, &id, lines).await).await;
            assert_eq!(status, 200, "{body}");
        }
    };
    let iban = Some("NL02 ABNA 0123 4567 89");

    let first = line(
        &world.db,
        &entity,
        &bank,
        "-1200.00",
        "Huur oktober",
        (Some("Vastgoed BV"), iban),
    )
    .await;
    let second = line(
        &world.db,
        &entity,
        &bank,
        "-1200.00",
        "Huur november",
        (Some("Vastgoed B.V."), iban),
    )
    .await;
    let third = line(
        &world.db,
        &entity,
        &bank,
        "-1200.00",
        "Huur december",
        (Some("Vastgoed"), Some("NL02ABNA0123456789")),
    )
    .await;
    book(first.clone(), rent.clone()).await;
    // Once is not a pattern.
    let line_three = find_transaction(&world.db, &third).await.unwrap().unwrap();
    assert!(suggest(&world.db, &line_three).await.unwrap().is_none());
    book(second.clone(), rent.clone()).await;
    let suggestion = suggest(&world.db, &line_three)
        .await
        .unwrap()
        .expect("twice before");
    assert_eq!(suggestion["actions"]["categoryAccountId"], json!(rent));
    assert_eq!(
        suggestion["conditions"][0],
        json!({ "field": "counterpartyIban", "operator": "equals", "value": "NL02ABNA0123456789" })
    );
    assert_eq!(
        suggestion["conditions"][1],
        json!({ "field": "direction", "operator": "equals", "value": "out" })
    );
    assert_eq!(suggestion["evidence"]["times"], json!(2));
    assert!(
        suggestion["name"]
            .as_str()
            .unwrap()
            .ends_with("→ 4210 Rent"),
        "{suggestion}"
    );

    // The line booked the same way is suggested too (the third one now), but
    // not when the history went elsewhere.
    book(third.clone(), rent.clone()).await;
    let booked = find_transaction(&world.db, &third).await.unwrap().unwrap();
    assert!(suggest(&world.db, &booked).await.unwrap().is_some());
    let odd = line(
        &world.db,
        &entity,
        &bank,
        "-300.00",
        "Huur",
        (Some("Vastgoed"), iban),
    )
    .await;
    book(odd.clone(), other.clone()).await;
    let odd_line = find_transaction(&world.db, &odd).await.unwrap().unwrap();
    assert!(
        suggest(&world.db, &odd_line).await.unwrap().is_none(),
        "booked elsewhere once"
    );

    // Money in from the same counterparty is another pattern.
    let incoming = line(
        &world.db,
        &entity,
        &bank,
        "50.00",
        "Terug",
        (Some("Vastgoed"), iban),
    )
    .await;
    let incoming = find_transaction(&world.db, &incoming)
        .await
        .unwrap()
        .unwrap();
    assert!(suggest(&world.db, &incoming).await.unwrap().is_none());

    // Without a counterparty there is nothing to match on; another entity has no history.
    let nobody = line(&world.db, &entity, &bank, "-1200.00", "Huur", (None, None)).await;
    let nobody = find_transaction(&world.db, &nobody).await.unwrap().unwrap();
    assert!(suggest(&world.db, &nobody).await.unwrap().is_none());
    let (other_entity, other_bank, _) = company(&world.db, "NL12ABNA0000000002").await;
    let theirs = line(
        &world.db,
        &other_entity,
        &other_bank,
        "-1200.00",
        "Huur",
        (Some("Vastgoed"), iban),
    )
    .await;
    let theirs = find_transaction(&world.db, &theirs).await.unwrap().unwrap();
    assert!(suggest(&world.db, &theirs).await.unwrap().is_none());

    // Once a rule does it, the suggestion is moot.
    sqlx::query(
        "insert into reconciliation_rules (id, entity_id, name, priority, match_mode, conditions, actions, is_active, match_count) \
         values ($1, $2, 'Rent', 1, 'all', $3, $4, true, 0)",
    )
    .bind(fresh("rr"))
    .bind(&entity)
    .bind(json!([{ "field": "counterpartyIban", "operator": "equals", "value": "NL02ABNA0123456789" }]))
    .bind(json!({ "categoryAccountId": rent }))
    .execute(&world.db)
    .await
    .unwrap();
    assert!(suggest(&world.db, &booked).await.unwrap().is_none());
}

#[tokio::test]
async fn a_small_gap_is_rounded_off_never_a_large_one() {
    let Some(world) = World::new() else {
        return;
    };
    let (entity, bank, _) = company(&world.db, "NL91ABNA0417164300").await;
    let rounding = account(&world.db, &entity, "4660", "Rounding", "expense", "debit").await;
    sqlx::query(
        "update accounts set metadata = jsonb_build_object('systemRole', 'rounding') where id = $1",
    )
    .bind(&rounding)
    .execute(&world.db)
    .await
    .unwrap();
    let party = fresh("acn");
    sqlx::query("insert into parties (id, kind, display_name, role) values ($1, 'company', 'Acme', 'customer')")
        .bind(&party).execute(&world.db).await.unwrap();
    let invoice = |number: &'static str| {
        let (db, entity, party) = (world.db.clone(), entity.clone(), party.clone());
        async move {
            let id = fresh("inv");
            sqlx::query(
                "insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name, \
                   issue_date, due_date, currency, total, amount_paid, balance_due) \
                 values ($1, $2, $3, 'invoice', 'sent', $4, 'Acme', '2026-11-01', '2026-12-01', 'EUR', 100, 0, 100)",
            )
            .bind(&id).bind(&entity).bind(number).bind(&party)
            .execute(&db).await.unwrap();
            id
        }
    };
    let body = |invoice: &str| MatchBody {
        documents: vec![(
            "invoice".to_owned(),
            invoice.to_owned(),
            "100.00".to_owned(),
        )],
        difference_account_id: None,
        difference_description: None,
    };
    let caller = world.caller(&entity);

    // 0.02 short: booked to the rounding account, and the answer says so.
    let short_cents = invoice("RD-1").await;
    let paid = line(&world.db, &entity, &bank, "99.98", "RD-1", (None, None)).await;
    let (status, answer_body) =
        answer(match_line(&caller, &world.state, &paid, body(&short_cents)).await).await;
    assert_eq!(status, 200, "{answer_body}");
    assert_eq!(
        data(&answer_body)["roundingDifference"],
        json!({ "accountId": rounding, "amount": "0.02" })
    );
    let entry = text(data(&answer_body), "journalEntryId");
    let on_rounding: Option<String> = sqlx::query_scalar(
        "select (sum(coalesce(debit, 0)) - sum(coalesce(credit, 0)))::numeric(18,2)::text \
         from journal_lines where journal_entry_id = $1 and account_id = $2",
    )
    .bind(entry)
    .bind(&rounding)
    .fetch_one(&world.db)
    .await
    .unwrap();
    assert_eq!(on_rounding.as_deref(), Some("0.02"));
    let status: String = sqlx::query_scalar("select status from invoices where id = $1")
        .bind(&short_cents)
        .fetch_one(&world.db)
        .await
        .unwrap();
    assert_eq!(status, "paid");
    let events = world.events().await;
    assert!(
        events
            .iter()
            .any(|(name, d)| name == "bank_transaction.processed" && d["how"] == json!("link"))
    );

    // A euro short is at the cap; a cent more is not rounded off.
    let at_cap = invoice("RD-2").await;
    let line_cap = row(
        &world.db,
        &line(&world.db, &entity, &bank, "99.00", "RD-2", (None, None)).await,
    )
    .await;
    let shares = |id: &str| {
        vec![weldsuite_books_domain::bank_matching::DocumentShare {
            invoice: true,
            id: id.to_owned(),
            amount: 100.0,
        }]
    };
    assert_eq!(
        small_gap(&world.db, &line_cap, &shares(&at_cap))
            .await
            .unwrap()
            .map(|(a, g)| (a, (g * 100.0).round())),
        Some((rounding.clone(), 100.0))
    );
    let too_far = row(
        &world.db,
        &line(&world.db, &entity, &bank, "98.99", "RD-2", (None, None)).await,
    )
    .await;
    assert!(
        small_gap(&world.db, &too_far, &shares(&at_cap))
            .await
            .unwrap()
            .is_none()
    );
    let (status, refused) =
        answer(match_line(&caller, &world.state, text(&too_far, "id"), body(&at_cap)).await).await;
    assert_eq!(status, 400);
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("add up to 100.00 but the bank line is 98.99"),
        "{refused}"
    );
    assert_eq!(
        text(&row(&world.db, text(&too_far, "id")).await, "status"),
        "unreconciled"
    );

    // The cap is the entity's: 0.50 rounds off 0.40 but not 0.60; zero rounds off nothing.
    let settings = differences::merged(None, json!({ "roundingCap": "0.50" }).as_object().unwrap());
    differences::store(&world.db, &entity, &settings)
        .await
        .unwrap();
    for (amount, rounded) in [
        ("99.60", true),
        ("99.40", false),
        ("100.40", true),
        ("100.60", false),
    ] {
        let candidate = row(
            &world.db,
            &line(&world.db, &entity, &bank, amount, "RD-2", (None, None)).await,
        )
        .await;
        let gap = small_gap(&world.db, &candidate, &shares(&at_cap))
            .await
            .unwrap();
        assert_eq!(gap.is_some(), rounded, "{amount}");
    }
    let none = differences::merged(
        Some(&settings),
        json!({ "roundingCap": "0.00" }).as_object().unwrap(),
    );
    differences::store(&world.db, &entity, &none).await.unwrap();
    let candidate = row(
        &world.db,
        &line(&world.db, &entity, &bank, "99.99", "RD-2", (None, None)).await,
    )
    .await;
    assert!(
        small_gap(&world.db, &candidate, &shares(&at_cap))
            .await
            .unwrap()
            .is_none()
    );

    // An entity without a rounding account books nothing automatically.
    let (bare, bare_bank, _) = company(&world.db, "NL12ABNA0000000002").await;
    let bare_line = row(
        &world.db,
        &line(&world.db, &bare, &bare_bank, "99.99", "x", (None, None)).await,
    )
    .await;
    assert!(
        small_gap(&world.db, &bare_line, &shares("inv_x"))
            .await
            .unwrap()
            .is_none()
    );
    // The stored settings keep what else the entity had.
    let stored: Value =
        sqlx::query_scalar("select jurisdiction_settings from entities where id = $1")
            .bind(&entity)
            .fetch_one(&world.db)
            .await
            .unwrap();
    assert_eq!(stored["differences"]["roundingCap"], json!("0.00"));
}
