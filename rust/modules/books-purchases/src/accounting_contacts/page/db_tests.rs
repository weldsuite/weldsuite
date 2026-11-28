//! The contact page against a database (`WELDSUITE_TEST_TENANT_URL`; each
//! test returns early without it). A caller made in-process has no request
//! entity the layer settled, so the entity scope is given as the layer would
//! settle it.

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::many_single_char_names,
    clippy::cast_possible_truncation,
    clippy::assert_is_empty,
    clippy::single_match_else,
    reason = "test fixtures are written in SQL; each test is one scenario read top to bottom"
)]

use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, header};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::contact_page::bank_line_condition;
use weldsuite_legal_entities::EntityScopeCondition;
use weldsuite_schema::tenant::{bank_transactions, invoices, parties};

use super::{
    Cursor, Readable, build_timeline, by_crm, defaults, page_of, page_window, read_defaults,
    statement, summary_in, update_defaults,
};
use crate::booking_defaults::booking_defaults;
use crate::test_support::{
    World, answer_of, bank_line, company, document, fresh, row_of, supplier, text, with_permissions,
};

fn only(entity: &str) -> EntityScopeCondition {
    EntityScopeCondition::In {
        ids: vec![entity.to_owned()],
        include_unassigned: false,
    }
}

const ALL: Readable = Readable {
    documents: true,
    bills: true,
    banking: true,
};

#[allow(clippy::too_many_arguments, reason = "a fixture row")]
async fn invoice(
    db: &PgPool,
    entity: &str,
    contact: &str,
    number: &str,
    kind: &str,
    status: &str,
    issue: &str,
    due: &str,
    total: &str,
    balance: &str,
    currency: &str,
    history: Option<&Value>,
) -> String {
    let id = fresh("inv");
    sqlx::query(
        "insert into invoices (id, entity_id, invoice_number, type, status, contact_id, issue_date, due_date, currency, \
           total, balance_due, email_history) \
         values ($1, $2, $3, $4, $5, $6, $7::timestamp, $8::timestamp, $9, $10::numeric, $11::numeric, $12)",
    )
    .bind(&id)
    .bind(entity)
    .bind(number)
    .bind(kind)
    .bind(status)
    .bind(contact)
    .bind(issue)
    .bind(due)
    .bind(currency)
    .bind(total)
    .bind(balance)
    .bind(history)
    .execute(db)
    .await
    .unwrap();
    id
}

async fn bill(
    db: &PgPool,
    entity: &str,
    contact: &str,
    number: &str,
    kind: &str,
    status: &str,
    issue: &str,
    balance: &str,
) -> String {
    let id = fresh("bil");
    sqlx::query(
        "insert into bills (id, entity_id, bill_number, type, status, contact_id, issue_date, due_date, currency, \
           total, balance_due) \
         values ($1, $2, $3, $4, $5, $6, $7::timestamp, $7::timestamp, 'EUR', $8::numeric, $8::numeric)",
    )
    .bind(&id)
    .bind(entity)
    .bind(number)
    .bind(kind)
    .bind(status)
    .bind(contact)
    .bind(issue)
    .bind(balance)
    .execute(db)
    .await
    .unwrap();
    id
}

async fn payment(
    db: &PgPool,
    entity: &str,
    contact: &str,
    kind: &str,
    date: &str,
    amount: &str,
) -> String {
    let id = fresh("pay");
    sqlx::query(
        "insert into payments (id, entity_id, type, amount, currency, date, contact_id, reference) \
         values ($1, $2, $3, $4::numeric, 'EUR', $5::timestamp, $6, 'ref-1')",
    )
    .bind(&id)
    .bind(entity)
    .bind(kind)
    .bind(amount)
    .bind(date)
    .bind(contact)
    .execute(db)
    .await
    .unwrap();
    id
}

async fn quote(db: &PgPool, contact: &str, status: &str, created: &str, valid_days: i64) -> String {
    let id = fresh("quote");
    sqlx::query(
        "insert into crm_quotes (id, created_at, quote_number, name, customer_id, line_items, subtotal, total, currency, \
           valid_from, valid_until, status) \
         values ($1, $2::timestamp, $3, 'Website', $4, '[]'::jsonb, '300.00', '363.00', 'EUR', now(), \
           now() + ($5 || ' days')::interval, $6)",
    )
    .bind(&id)
    .bind(created)
    .bind(format!("Q-{}", &id[id.len() - 6..]))
    .bind(contact)
    .bind(valid_days.to_string())
    .bind(status)
    .execute(db)
    .await
    .unwrap();
    id
}

fn keys_of(item: &Value) -> Vec<&str> {
    let mut keys: Vec<&str> = item
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    keys
}

fn who(item: &Value) -> (String, String) {
    (
        item["type"].as_str().unwrap().to_owned(),
        item["objectId"].as_str().unwrap().to_owned(),
    )
}

struct Scene {
    a: crate::test_support::Company,
    b: crate::test_support::Company,
    contact: String,
    quote: String,
    i1: String,
    credit: String,
    i3: String,
    i_other_entity: String,
    bill: String,
    receipt: String,
    payment: String,
    line_direct: String,
    line_payment: String,
    line_invoice: String,
    line_unrelated: String,
    doc_matched: String,
    doc_bill: String,
}

async fn scene(world: &World) -> Scene {
    let db = &world.db;
    let a = company(db, "NL91ABNA0417164300").await;
    let b = company(db, "NL02ABNA0123456789").await;
    let contact = supplier(db, "Acme", None).await;
    let other = supplier(db, "Someone else", None).await;
    let quote = quote(db, &contact, "sent", "2026-11-02T12:00:00", 30).await;
    let history = json!([
        { "type": "link", "nonce": "n", "at": "2026-11-02T10:00:00.000Z" },
        { "type": "sent", "at": "2026-11-02T10:00:01.000Z", "to": ["a@x.test"] },
        { "type": "viewed", "at": "2026-11-03T09:00:00.000Z" },
        { "type": "reminder", "at": "2026-11-20T08:00:00.000Z", "level": 2, "to": ["a@x.test"] },
        { "type": "bounced", "at": "2026-11-21T08:00:00.000Z", "to": ["a@x.test"], "error": "no" },
    ]);
    let i1 = invoice(
        db,
        &a.entity,
        &contact,
        "F-1",
        "standard",
        "sent",
        "2026-11-01T00:00:00",
        "2099-12-01T00:00:00",
        "121.00",
        "121.00",
        "EUR",
        Some(&history),
    )
    .await;
    let credit = invoice(
        db,
        &a.entity,
        &contact,
        "CN-1",
        "credit_note",
        "finalized",
        "2026-11-10T00:00:00",
        "2026-11-10T00:00:00",
        "50.00",
        "50.00",
        "EUR",
        None,
    )
    .await;
    // The same moment as the credit note: the cursor has to tell them apart.
    let i3 = invoice(
        db,
        &a.entity,
        &contact,
        "F-3",
        "standard",
        "overdue",
        "2026-11-10T00:00:00",
        "2026-11-11T00:00:00",
        "121.00",
        "121.00",
        "EUR",
        None,
    )
    .await;
    let i_other_entity = invoice(
        db,
        &b.entity,
        &contact,
        "F-B",
        "standard",
        "sent",
        "2026-11-05T00:00:00",
        "2099-12-01T00:00:00",
        "10.00",
        "10.00",
        "EUR",
        None,
    )
    .await;
    invoice(
        db,
        &a.entity,
        &other,
        "F-OTHER",
        "standard",
        "sent",
        "2026-11-05T00:00:00",
        "2099-12-01T00:00:00",
        "10.00",
        "10.00",
        "EUR",
        None,
    )
    .await;
    let bill = bill(
        db,
        &a.entity,
        &contact,
        "B-1",
        "standard",
        "approved",
        "2026-11-08T00:00:00",
        "60.50",
    )
    .await;
    let receipt = bill_receipt(db, &a.entity, &contact).await;
    let payment = payment(
        db,
        &a.entity,
        &contact,
        "received",
        "2026-11-15T00:00:00",
        "40.00",
    )
    .await;
    let line_direct = bank_line(
        db,
        &a.entity,
        &a.bank,
        "2026-11-16",
        "-12.00",
        "Direct",
        (Some("Acme"), None),
    )
    .await;
    sqlx::query("update bank_transactions set contact_id = $2 where id = $1")
        .bind(&line_direct)
        .bind(&contact)
        .execute(db)
        .await
        .unwrap();
    let line_payment = bank_line(
        db,
        &a.entity,
        &a.bank,
        "2026-11-17",
        "40.00",
        "Via payment",
        (None, None),
    )
    .await;
    sqlx::query("update bank_transactions set reconciled_payment_id = $2 where id = $1")
        .bind(&line_payment)
        .bind(&payment)
        .execute(db)
        .await
        .unwrap();
    let line_invoice = bank_line(
        db,
        &a.entity,
        &a.bank,
        "2026-11-18",
        "121.00",
        "Via invoice",
        (None, None),
    )
    .await;
    sqlx::query("update bank_transactions set reconciled_invoice_id = $2 where id = $1")
        .bind(&line_invoice)
        .bind(&i1)
        .execute(db)
        .await
        .unwrap();
    let line_unrelated = bank_line(
        db,
        &a.entity,
        &a.bank,
        "2026-11-19",
        "5.00",
        "Unrelated",
        (None, None),
    )
    .await;
    let doc_matched = document(db, Some(&a.entity), "matched.pdf", 10, "processed", None).await;
    sqlx::query("update documents set matched_contact_id = $2 where id = $1")
        .bind(&doc_matched)
        .bind(&contact)
        .execute(db)
        .await
        .unwrap();
    let doc_bill = document(db, Some(&a.entity), "behind-bill.pdf", 11, "linked", None).await;
    sqlx::query(
        "update documents set linked_entity_type = 'bill', linked_entity_id = $2 where id = $1",
    )
    .bind(&doc_bill)
    .bind(&bill)
    .execute(db)
    .await
    .unwrap();
    let doc_other = document(db, Some(&a.entity), "other.pdf", 12, "processed", None).await;
    sqlx::query("update documents set matched_contact_id = $2 where id = $1")
        .bind(&doc_other)
        .bind(&other)
        .execute(db)
        .await
        .unwrap();
    Scene {
        a,
        b,
        contact,
        quote,
        i1,
        credit,
        i3,
        i_other_entity,
        bill,
        receipt,
        payment,
        line_direct,
        line_payment,
        line_invoice,
        line_unrelated,
        doc_matched,
        doc_bill,
    }
}

async fn bill_receipt(db: &PgPool, entity: &str, contact: &str) -> String {
    bill(
        db,
        entity,
        contact,
        "R-1",
        "receipt",
        "paid",
        "2026-11-12T00:00:00",
        "0",
    )
    .await
}

async fn party(db: &PgPool, id: &str) -> parties::Model {
    <parties::Entity as sea_orm::EntityTrait>::find_by_id(id.to_owned())
        .one(&weldsuite_db::orm(db))
        .await
        .unwrap()
        .unwrap()
}

async fn full(
    world: &World,
    s: &Scene,
    scope: &EntityScopeCondition,
    readable: Readable,
) -> Vec<Value> {
    let party = party(&world.db, &s.contact).await;
    let page = build_timeline(
        &world.db,
        scope,
        &party,
        readable,
        None,
        100,
        1_900_000_000_000,
    )
    .await
    .unwrap();
    assert!(!page.has_more && page.cursor.is_none());
    assert_eq!(page.total as usize, page.items.len());
    page.items
}

#[tokio::test]
async fn the_timeline_merges_every_kind_newest_first_within_the_entity() {
    let Some(world) = World::new() else { return };
    let s = scene(&world).await;
    let items = full(&world, &s, &only(&s.a.entity), ALL).await;

    // Every item has the contract's ten fields and nothing else; newest first.
    for item in &items {
        assert_eq!(
            keys_of(item),
            [
                "amount",
                "currency",
                "date",
                "hint",
                "objectId",
                "objectType",
                "status",
                "subtitle",
                "title",
                "type"
            ],
            "{item}"
        );
    }
    let dates: Vec<&str> = items.iter().map(|i| i["date"].as_str().unwrap()).collect();
    let mut sorted = dates.clone();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(dates, sorted, "newest first");

    let has = |kind: &str, id: &str| {
        items
            .iter()
            .any(|i| i["type"] == kind && i["objectId"] == id)
    };
    // Quote, invoices, the credit note, the bill and receipt, the payment,
    // three bank lines, two documents, four mail events.
    assert!(has("quote", &s.quote));
    assert!(has("invoice", &s.i1));
    assert!(has("invoice", &s.i3));
    assert!(has("credit_note", &s.credit));
    assert!(has("bill", &s.bill));
    assert!(has("receipt", &s.receipt));
    assert!(has("payment", &s.payment));
    for line in [&s.line_direct, &s.line_payment, &s.line_invoice] {
        assert!(has("bank_line", line), "{line}");
    }
    assert!(!has("bank_line", &s.line_unrelated));
    assert!(has("document", &s.doc_matched) && has("document", &s.doc_bill));
    for kind in ["email_sent", "email_viewed", "reminder", "email_bounced"] {
        assert!(has(kind, &s.i1), "{kind}");
    }
    assert_eq!(items.len(), 1 + 3 + 2 + 1 + 3 + 2 + 4, "{items:#?}");
    // Another entity's invoice is not here; the quote is, whatever the entity.
    assert!(!has("invoice", &s.i_other_entity));
    let in_b = full(&world, &s, &only(&s.b.entity), ALL).await;
    assert_eq!(
        in_b.iter().map(who).collect::<Vec<_>>(),
        [
            ("invoice".to_owned(), s.i_other_entity.clone()),
            ("quote".to_owned(), s.quote.clone()),
        ],
        "{in_b:#?}"
    );
    let nowhere = full(&world, &s, &EntityScopeCondition::Nothing, ALL).await;
    assert_eq!(
        nowhere.iter().map(who).collect::<Vec<_>>(),
        [("quote".to_owned(), s.quote.clone())]
    );

    // The items say what they are, as data.
    let find = |kind: &str, id: &str| {
        items
            .iter()
            .find(|i| i["type"] == kind && i["objectId"] == id)
            .unwrap()
            .clone()
    };
    let overdue = find("invoice", &s.i3);
    assert_eq!(
        (
            overdue["title"].as_str(),
            overdue["hint"].as_str(),
            overdue["amount"].as_str(),
            overdue["currency"].as_str(),
            overdue["status"].as_str()
        ),
        (
            Some("F-3"),
            Some("overdue"),
            Some("121.00"),
            Some("EUR"),
            Some("overdue")
        )
    );
    assert!(find("invoice", &s.i1)["hint"].is_null());
    assert_eq!(find("credit_note", &s.credit)["objectType"], "invoice");
    let reminder = find("reminder", &s.i1);
    assert_eq!(
        (
            reminder["hint"].as_str(),
            reminder["subtitle"].as_str(),
            reminder["title"].as_str(),
            reminder["objectType"].as_str()
        ),
        (
            Some("level:2"),
            Some("a@x.test"),
            Some("F-1"),
            Some("invoice")
        )
    );
    assert_eq!(find("payment", &s.payment)["hint"], "received");
    assert_eq!(find("bill", &s.bill)["hint"], "overdue");
    let line = find("bank_line", &s.line_direct);
    assert_eq!(
        (
            line["hint"].as_str(),
            line["amount"].as_str(),
            line["currency"].as_str(),
            line["objectType"].as_str()
        ),
        (
            Some("out"),
            Some("-12.00"),
            Some("EUR"),
            Some("bank_transaction")
        )
    );
    assert_eq!(find("bank_line", &s.line_payment)["hint"], "in");
    assert_eq!(find("document", &s.doc_bill)["title"], "behind-bill.pdf");
}

#[tokio::test]
async fn the_timeline_leaves_out_what_the_caller_cannot_read() {
    let Some(world) = World::new() else { return };
    let s = scene(&world).await;
    let scope = only(&s.a.entity);
    let kinds = |items: &[Value]| -> HashSet<String> {
        items
            .iter()
            .map(|i| i["type"].as_str().unwrap().to_owned())
            .collect()
    };
    let sales = full(
        &world,
        &s,
        &scope,
        Readable {
            documents: true,
            bills: false,
            banking: false,
        },
    )
    .await;
    assert_eq!(sales.len(), 1 + 3 + 4 + 2);
    assert!(
        kinds(&sales).is_disjoint(
            &["bill", "receipt", "payment", "bank_line"]
                .map(str::to_owned)
                .into()
        )
    );
    let money = full(
        &world,
        &s,
        &scope,
        Readable {
            documents: false,
            bills: true,
            banking: true,
        },
    )
    .await;
    assert_eq!(money.len(), 2 + 1 + 3);
    assert_eq!(
        kinds(&money),
        ["bill", "receipt", "payment", "bank_line"]
            .map(str::to_owned)
            .into()
    );
    let nothing = full(
        &world,
        &s,
        &scope,
        Readable {
            documents: false,
            bills: false,
            banking: false,
        },
    )
    .await;
    assert!(nothing.is_empty());
    let bills_only = full(
        &world,
        &s,
        &scope,
        Readable {
            documents: false,
            bills: true,
            banking: false,
        },
    )
    .await;
    assert_eq!(bills_only.len(), 2);
}

#[tokio::test]
async fn the_timeline_pages_by_cursor_without_losing_or_repeating_an_item() {
    let Some(world) = World::new() else { return };
    let s = scene(&world).await;
    let scope = only(&s.a.entity);
    let party = party(&world.db, &s.contact).await;
    let whole: Vec<(String, String, String)> = full(&world, &s, &scope, ALL)
        .await
        .iter()
        .map(|i| {
            (
                i["type"].as_str().unwrap().to_owned(),
                i["objectId"].as_str().unwrap().to_owned(),
                i["date"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(whole.len(), 16);

    for limit in [1_u64, 3, 5, 16, 100] {
        let mut seen = Vec::new();
        let mut cursor: Option<Cursor> = None;
        let mut pages = 0;
        loop {
            let page = build_timeline(
                &world.db,
                &scope,
                &party,
                ALL,
                cursor.as_ref(),
                limit,
                1_900_000_000_000,
            )
            .await
            .unwrap();
            assert_eq!(page.total, 16, "the total is the whole, not the page");
            assert!(page.items.len() as u64 <= limit);
            seen.extend(page.items.iter().map(|i| {
                (
                    i["type"].as_str().unwrap().to_owned(),
                    i["objectId"].as_str().unwrap().to_owned(),
                    i["date"].as_str().unwrap().to_owned(),
                )
            }));
            pages += 1;
            match page.cursor {
                Some(next) => {
                    assert!(page.has_more);
                    cursor = Some(Cursor::parse(&next).unwrap());
                }
                None => {
                    assert!(!page.has_more);
                    break;
                }
            }
            assert!(pages < 40);
        }
        assert_eq!(seen, whole, "limit {limit}");
    }
    assert!(Cursor::parse("nonsense").is_none());
    assert!(Cursor::parse("x:y").is_none());
    assert_eq!(
        Cursor::parse("12:invoice:inv_1").unwrap(),
        Cursor {
            millis: 12,
            key: "invoice:inv_1".to_owned()
        }
    );
}

#[tokio::test]
async fn the_summary_sums_per_currency_and_hides_what_is_not_readable() {
    let Some(world) = World::new() else { return };
    let s = scene(&world).await;
    let scope = only(&s.a.entity);
    let party = party(&world.db, &s.contact).await;
    // A dollar invoice, and unbilled hours on a project of the contact.
    invoice(
        &world.db,
        &s.a.entity,
        &s.contact,
        "F-USD",
        "standard",
        "sent",
        "2026-11-03T00:00:00",
        "2099-01-01T00:00:00",
        "20.00",
        "20.00",
        "USD",
        None,
    )
    .await;
    let project = fresh("prj");
    sqlx::query("insert into projects (id, created_at, updated_at, name, counterparty_id, hourly_rate) values ($1, now(), now(), 'Hours', $2, 100)")
        .bind(&project)
        .bind(&s.contact)
        .execute(&world.db)
        .await
        .unwrap();
    sqlx::query("insert into time_entries (id, project_id, user_id, date, duration, billable, status) values ($1, $2, 'u', '2026-11-20', 90, true, 'draft')")
        .bind(fresh("te"))
        .bind(&project)
        .execute(&world.db)
        .await
        .unwrap();

    let caller = with_permissions(
        world.caller(&s.a.entity),
        &["invoices:read", "bills:read", "banking:read", "time:read"],
    );
    let summary = summary_in(&caller, &scope, &party).await.unwrap();
    // Open invoices: F-1 and F-3 in EUR (the credit note is credit), F-USD in USD.
    assert_eq!(
        summary["toReceive"],
        json!([
            { "currency": "EUR", "amount": "242.00", "count": 2 },
            { "currency": "USD", "amount": "20.00", "count": 1 },
        ])
    );
    assert_eq!(
        summary["overdue"],
        json!([{ "currency": "EUR", "amount": "121.00", "count": 1 }])
    );
    assert_eq!(
        summary["toPay"],
        json!([{ "currency": "EUR", "amount": "60.50", "count": 1 }])
    );
    // The open credit note (50.00) and the payment's 40.00 nothing was applied to.
    assert_eq!(
        summary["unappliedCredit"],
        json!([{ "currency": "EUR", "amount": "90.00", "count": 2 }])
    );
    assert_eq!(
        summary["openQuotes"],
        json!({ "count": 1, "amount": [{ "currency": "EUR", "amount": "363.00", "count": 1 }] })
    );
    assert_eq!(
        summary["unbilledHours"],
        json!({ "hours": "1.5", "amount": "150.00", "currency": "EUR" })
    );

    // Without the money and time permissions those parts are empty or absent.
    let narrow = with_permissions(world.caller(&s.a.entity), &["invoices:read"]);
    let summary = summary_in(&narrow, &scope, &party).await.unwrap();
    assert_eq!(summary["toPay"], json!([]));
    assert_eq!(
        summary["unappliedCredit"],
        json!([{ "currency": "EUR", "amount": "50.00", "count": 1 }])
    );
    assert!(summary.get("unbilledHours").is_none());
    // Another entity's view of the same contact sees none of this entity's money.
    let elsewhere = summary_in(&caller, &only(&s.b.entity), &party)
        .await
        .unwrap();
    assert_eq!(
        elsewhere["toReceive"],
        json!([{ "currency": "EUR", "amount": "10.00", "count": 1 }])
    );
    assert_eq!(elsewhere["overdue"], json!([]));
}

#[tokio::test]
async fn a_page_of_a_list_carries_its_pagination_and_no_paging_asks_for_none() {
    let Some(world) = World::new() else { return };
    let s = scene(&world).await;
    // No page, no pageSize: the list is whole, as it always was.
    assert_eq!(page_window(&world.caller(&s.a.entity)).unwrap(), None);
    assert_eq!(
        page_window(&world.caller(&s.a.entity).with_query("page=2&pageSize=500")).unwrap(),
        Some((2, 100))
    );
    assert_eq!(
        page_window(&world.caller(&s.a.entity).with_query("pageSize=10")).unwrap(),
        Some((1, 10))
    );
    assert!(page_window(&world.caller(&s.a.entity).with_query("page=x")).is_err());

    let db = weldsuite_db::orm(&world.db);
    let list = |window| {
        let select = invoices::Entity::find()
            .filter(invoices::Column::ContactId.eq(s.contact.as_str()))
            .filter(invoices::Column::DeletedAt.is_null());
        page_of(
            &db,
            select,
            invoices::Column::IssueDate,
            invoices::Column::Id,
            window,
            |row| crate::rows::js!(row),
        )
    };
    let (status, first) = answer_of(list((1, 2)).await.unwrap()).await;
    assert_eq!(status, 200);
    assert_eq!(first["data"].as_array().unwrap().len(), 2);
    assert_eq!(first["pagination"]["totalCount"], 4);
    assert_eq!(first["pagination"]["hasMore"], true);
    let (_, second) = answer_of(list((2, 2)).await.unwrap()).await;
    assert_eq!(second["data"].as_array().unwrap().len(), 2);
    assert_eq!(second["pagination"]["hasMore"], false);
    let ids: HashSet<&str> = first["data"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["data"].as_array().unwrap())
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 4);
    let (_, beyond) = answer_of(list((3, 2)).await.unwrap()).await;
    assert!(beyond["data"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn bank_lines_belong_to_a_contact_by_the_rule_of_the_timeline() {
    let Some(world) = World::new() else { return };
    let s = scene(&world).await;
    let found: HashSet<String> = bank_transactions::Entity::find()
        .filter(bank_transactions::Column::EntityId.eq(s.a.entity.as_str()))
        .filter(bank_line_condition(&s.contact))
        .all(&weldsuite_db::orm(&world.db))
        .await
        .unwrap()
        .into_iter()
        .map(|line| line.id)
        .collect();
    assert_eq!(
        found,
        HashSet::from([
            s.line_direct.clone(),
            s.line_payment.clone(),
            s.line_invoice.clone()
        ])
    );
    assert!(!found.contains(&s.line_unrelated));
    // A line settling a payment that was allocated to the contact's bill counts too.
    let allocated = bank_line(
        &world.db,
        &s.a.entity,
        &s.a.bank,
        "2026-11-20",
        "-60.50",
        "Allocated",
        (None, None),
    )
    .await;
    let other = supplier(&world.db, "Payer", None).await;
    let pay = payment(
        &world.db,
        &s.a.entity,
        &other,
        "paid",
        "2026-11-20T00:00:00",
        "60.50",
    )
    .await;
    sqlx::query("update bank_transactions set reconciled_payment_id = $2 where id = $1")
        .bind(&allocated)
        .bind(&pay)
        .execute(&world.db)
        .await
        .unwrap();
    sqlx::query("insert into payment_allocations (id, entity_id, payment_id, bill_id, amount) values ($1, $2, $3, $4, '60.50')")
        .bind(fresh("pal"))
        .bind(&s.a.entity)
        .bind(&pay)
        .bind(&s.bill)
        .execute(&world.db)
        .await
        .unwrap();
    let again = bank_transactions::Entity::find()
        .filter(bank_transactions::Column::Id.eq(allocated.as_str()))
        .filter(bank_line_condition(&s.contact))
        .all(&weldsuite_db::orm(&world.db))
        .await
        .unwrap();
    assert_eq!(again.len(), 1);
}

fn json_headers() -> HeaderMap {
    HeaderMap::from_iter([(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    )])
}

#[tokio::test]
async fn the_statement_lists_open_items_per_currency_as_json_and_pdf() {
    let Some(world) = World::new() else { return };
    let s = scene(&world).await;
    // More: a USD invoice, a draft, a paid one, a later one, and a B invoice.
    invoice(
        &world.db,
        &s.a.entity,
        &s.contact,
        "F-USD",
        "standard",
        "sent",
        "2026-11-03T00:00:00",
        "2026-12-03T00:00:00",
        "20.00",
        "20.00",
        "USD",
        None,
    )
    .await;
    invoice(
        &world.db,
        &s.a.entity,
        &s.contact,
        "F-DRAFT",
        "standard",
        "draft",
        "2026-11-03T00:00:00",
        "2026-12-03T00:00:00",
        "20.00",
        "20.00",
        "EUR",
        None,
    )
    .await;
    invoice(
        &world.db,
        &s.a.entity,
        &s.contact,
        "F-PAID",
        "standard",
        "paid",
        "2026-11-03T00:00:00",
        "2026-12-03T00:00:00",
        "20.00",
        "0.00",
        "EUR",
        None,
    )
    .await;
    invoice(
        &world.db,
        &s.a.entity,
        &s.contact,
        "F-LATER",
        "standard",
        "sent",
        "2026-12-20T00:00:00",
        "2027-01-20T00:00:00",
        "20.00",
        "20.00",
        "EUR",
        None,
    )
    .await;

    let caller = world
        .caller(&s.a.entity)
        .with_query("format=json&asOf=2026-11-30");
    let response = statement(caller, State(world.state.clone()), Path(s.contact.clone())).await;
    let (status, out) = answer_of(response).await;
    assert_eq!(status, 200, "{out}");
    let data = &out["data"];
    assert_eq!(data["asOf"], "2026-11-30");
    assert_eq!(data["entityId"], json!(s.a.entity));
    assert_eq!(data["contact"]["name"], "Acme");
    let rows = data["rows"].as_array().unwrap();
    let numbers: Vec<&str> = rows.iter().map(|r| r["number"].as_str().unwrap()).collect();
    // Oldest first; the credit note is negative; draft, paid, later and B's are not listed.
    assert_eq!(numbers, ["F-1", "F-USD", "CN-1", "F-3"], "{rows:#?}");
    let credit = &rows[2];
    assert_eq!(
        (
            credit["kind"].as_str(),
            credit["balance"].as_str(),
            credit["amount"].as_str()
        ),
        (Some("credit_note"), Some("-50.00"), Some("-50.00"))
    );
    assert!(credit["dueDate"].is_null());
    assert!(rows[3]["overdueDays"].as_i64().unwrap() > 0);
    assert_eq!(rows[0]["overdueDays"], 0);
    assert_eq!(
        data["totals"],
        json!([{ "currency": "EUR", "amount": "192.00" }, { "currency": "USD", "amount": "20.00" }])
    );

    // The PDF.
    let caller = world.caller(&s.a.entity).with_query("asOf=2026-11-30");
    let response = statement(caller, State(world.state.clone()), Path(s.contact.clone())).await;
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/pdf");
    assert!(
        response.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .contains("statement-Acme-2026-11-30")
    );
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(bytes.starts_with(b"%PDF-1.4"));

    // Refusals.
    for (query, id, wanted) in [
        ("asOf=soon", s.contact.as_str(), 400),
        ("format=xml", s.contact.as_str(), 400),
        ("", "pty_unknown", 404),
    ] {
        let caller = world.caller(&s.a.entity).with_query(query);
        let (status, _) =
            answer_of(statement(caller, State(world.state.clone()), Path(id.to_owned())).await)
                .await;
        assert_eq!(status, wanted, "{query}");
    }
}

#[tokio::test]
async fn defaults_are_stored_read_and_feed_the_booking_defaults() {
    let Some(world) = World::new() else { return };
    let co = company(&world.db, "NL91ABNA0417164300").await;
    let acme = supplier(&world.db, "Acme", None).await;
    let caller = world.caller(&co.entity);
    world.events().await;

    let patch = |body: Value| {
        let caller = world.caller(&co.entity);
        let acme = acme.clone();
        let state = world.state.clone();
        async move {
            answer_of(
                update_defaults(
                    caller,
                    State(state),
                    Path(acme),
                    json_headers(),
                    body.to_string().into(),
                )
                .await,
            )
            .await
        }
    };
    let (status, out) = patch(json!({
        "defaultExpenseAccountId": co.office, "defaultTaxRateId": co.vat21,
        "paymentTermsDays": 14, "remindersPaused": true,
    }))
    .await;
    assert_eq!(status, 200, "{out}");
    assert_eq!(
        out["data"],
        json!({
            "contactId": acme, "defaultExpenseAccountId": co.office, "defaultTaxRateId": co.vat21,
            "paymentTermsDays": 14, "remindersPaused": true,
        })
    );
    let row = row_of(&world.db, "parties", &acme).await;
    assert_eq!(text(&row, "default_tax_rate_id"), co.vat21);
    assert_eq!(text(&row, "payment_terms"), "14");
    // The pause is the entity's: its list, next to the keys already there.
    assert!(row["average_deal_size"].is_null(), "{row}");
    let entity_row = row_of(&world.db, "entities", &co.entity).await;
    assert_eq!(
        entity_row["jurisdiction_settings"]["reminders"]["pausedContactIds"],
        json!([acme])
    );
    let events = world.events().await;
    assert!(
        events
            .iter()
            .any(|(n, d)| n == "accounting_contact.updated" && d["id"] == json!(acme)),
        "{events:?}"
    );

    // The stored defaults answer a GET, and the contact's own view carries the rate.
    let (_, read) = answer_of(defaults(caller, Path(acme.clone())).await).await;
    assert_eq!(read["data"]["defaultTaxRateId"], json!(co.vat21));

    // The booking defaults prefer them, saying so, over the history: with
    // posted bills for another account and no rate on their lines.
    for number in ["H-1", "H-2"] {
        let id = bill(
            &world.db,
            &co.entity,
            &acme,
            number,
            "standard",
            "approved",
            "2026-11-10T00:00:00",
            "10",
        )
        .await;
        sqlx::query("update bills set journal_entry_id = 'jnl_history' where id = $1")
            .bind(&id)
            .execute(&world.db)
            .await
            .unwrap();
        sqlx::query("insert into bill_items (id, entity_id, bill_id, description, unit_price, account_id) values ($1, $2, $3, 'x', '1', $4)")
            .bind(fresh("bli"))
            .bind(&co.entity)
            .bind(&id)
            .bind(&co.rent)
            .execute(&world.db)
            .await
            .unwrap();
    }
    let booked = booking_defaults(&world.db, Some(&co.entity), &acme)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(booked["account"]["accountId"], json!(co.office));
    assert_eq!(booked["account"]["source"], "contact");
    assert_eq!(booked["taxRate"]["taxRateId"], json!(co.vat21));
    assert_eq!(booked["taxRate"]["source"], "contact");

    // Cleared, the history answers again; a stored default whose row is gone is ignored.
    let (status, _) = patch(json!({ "defaultExpenseAccountId": null, "defaultTaxRateId": null, "paymentTermsDays": null, "remindersPaused": false })).await;
    assert_eq!(status, 200);
    let booked = booking_defaults(&world.db, Some(&co.entity), &acme)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(booked["account"]["accountId"], json!(co.rent));
    assert_eq!(booked["account"]["source"], "history");
    assert!(booked["taxRate"].is_null());
    let row = row_of(&world.db, "parties", &acme).await;
    assert!(row["default_tax_rate_id"].is_null() && row["payment_terms"].is_null());
    assert!(row["average_deal_size"].is_null(), "{row}");
    let entity_row = row_of(&world.db, "entities", &co.entity).await;
    assert!(
        entity_row["jurisdiction_settings"]
            .get("reminders")
            .is_none(),
        "{entity_row}"
    );
    sqlx::query("update parties set default_expense_account_id = 'acc_gone' where id = $1")
        .bind(&acme)
        .execute(&world.db)
        .await
        .unwrap();
    let booked = booking_defaults(&world.db, Some(&co.entity), &acme)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(booked["account"]["source"], "history");

    // Refusals.
    for bad in [
        json!({}),
        json!({ "colour": "red" }),
        json!({ "defaultExpenseAccountId": "acc_missing" }),
        json!({ "defaultTaxRateId": "tax_missing" }),
        json!({ "paymentTermsDays": -1 }),
        json!({ "paymentTermsDays": "soon" }),
        json!({ "remindersPaused": "yes" }),
        json!({ "defaultTaxRateId": 5 }),
    ] {
        let (status, out) = patch(bad.clone()).await;
        assert_eq!(status, 400, "{bad}: {out}");
    }
    let (status, _) = answer_of(
        update_defaults(
            world.caller(&co.entity),
            State(world.state.clone()),
            Path("pty_none".to_owned()),
            json_headers(),
            json!({ "remindersPaused": true }).to_string().into(),
        )
        .await,
    )
    .await;
    assert_eq!(status, 404);
}

#[test]
fn the_defaults_body_is_checked() {
    let patch =
        read_defaults(&json!({ "paymentTermsDays": null, "remindersPaused": true })).unwrap();
    assert_eq!(patch.payment_terms_days, Some(None));
    assert_eq!(patch.reminders_paused, Some(true));
    assert!(patch.expense_account.is_none() && patch.tax_rate.is_none());
    assert!(read_defaults(&json!([])).is_err());
    assert!(read_defaults(&json!({ "paymentTermsDays": 10_000 })).is_err());
}

#[tokio::test]
async fn the_contact_of_a_crm_company_or_person_comes_with_its_summary() {
    let Some(world) = World::new() else { return };
    let s = scene(&world).await;
    let company = fresh("cmp");
    let person = fresh("per");
    sqlx::query("update parties set company_id = $2 where id = $1")
        .bind(&s.contact)
        .bind(&company)
        .execute(&world.db)
        .await
        .unwrap();
    let wrapped = supplier(&world.db, "Piet", None).await;
    sqlx::query("update parties set person_id = $2, kind = 'person' where id = $1")
        .bind(&wrapped)
        .bind(&person)
        .execute(&world.db)
        .await
        .unwrap();

    let ask = |query: String| {
        let caller =
            with_permissions(world.caller(&s.a.entity), &["invoices:read"]).with_query(&query);
        async move { answer_of(by_crm(caller).await).await }
    };
    let (status, out) = ask(format!("companyId={company}")).await;
    assert_eq!(status, 200, "{out}");
    assert_eq!(out["data"]["contact"]["id"], json!(s.contact));
    assert_eq!(out["data"]["contact"]["name"], "Acme");
    for key in [
        "toReceive",
        "overdue",
        "toPay",
        "unappliedCredit",
        "openQuotes",
    ] {
        assert!(out["data"]["summary"].get(key).is_some(), "{key}");
    }
    let (_, out) = ask(format!("personId={person}")).await;
    assert_eq!(out["data"]["contact"]["id"], json!(wrapped));
    // None: null, not an error.
    let (status, out) = ask("companyId=cmp_nobody".to_owned()).await;
    assert_eq!((status, &out["data"]), (200, &Value::Null), "{out}");
    // Neither or both is refused.
    for query in ["", "companyId=a&personId=b"] {
        let (status, _) = ask(query.to_owned()).await;
        assert_eq!(status, 400, "{query}");
    }
}
