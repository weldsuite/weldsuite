//! The record chats of WeldBooks' records and the questions on them
//! (ADR BOOKS-015) against the real tenant schema (`WELDSUITE_TEST_TENANT_URL`,
//! built by `scripts/rust-test-db.ts`; each test returns early without it).
//!
//! Members are rows of `workspace_members` (an OWNER, or a made-up role plus
//! the permissions each test lists), so the checks resolve them as the chat
//! does. The tests share a database and the members' ids are fresh, but the
//! managers of a chat are found among all the workspace's members, so the
//! tests that read them hold a lock and retire every other member first.

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::assert_is_empty,
    clippy::cloned_ref_to_slice_refs,
    reason = "test fixtures are written in SQL; each test is one scenario read top to bottom"
)]

use std::collections::HashSet;

use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::Mutex;
use weldsuite_chat_domain::books_records;
use weldsuite_chat_domain::entity::{Provider, can_access_entity, provider, record_chat_providers};
use weldsuite_chat_domain::questions::{self, Filters};
use weldsuite_chat_domain::{Can, questions::new_metadata};
use weldsuite_kit::generate_id;

static ONE_AT_A_TIME: Mutex<()> = Mutex::const_new(());

fn pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return None;
    };
    Some(weldsuite_db::master_pool(&url, 4).unwrap())
}

fn fresh(prefix: &str) -> String {
    generate_id(prefix)
}

/// Every member but `keep` is retired, so the managers are ours.
async fn keep_only(db: &PgPool, keep: &[&String]) {
    let keep: Vec<String> = keep.iter().map(|user| (*user).clone()).collect();
    sqlx::query("update workspace_members set status = 'INACTIVE' where user_id <> all($1)")
        .bind(&keep)
        .execute(db)
        .await
        .unwrap();
}

async fn member(db: &PgPool, role: &str, permissions: &[&str]) -> String {
    let user = format!("bq_{}", fresh("u"));
    sqlx::query(
        "insert into workspace_members (id, user_id, role, permissions, status, created_at) \
         values ($1, $2, $3, $4::text::jsonb, 'ACTIVE', now() + (random() * interval '1 second'))",
    )
    .bind(fresh("wm"))
    .bind(&user)
    .bind(role)
    .bind(json!(permissions).to_string())
    .execute(db)
    .await
    .unwrap();
    user
}

async fn entity(db: &PgPool, restricted: bool) -> String {
    let id = fresh("ent");
    sqlx::query(
        "insert into entities (id, name, jurisdiction_code, base_currency, is_active, access_restricted) \
         values ($1, 'Record chats', 'NL', 'EUR', true, $2)",
    )
    .bind(&id)
    .bind(restricted)
    .execute(db)
    .await
    .unwrap();
    id
}

async fn list_member(db: &PgPool, entity: &str, user: &str) {
    sqlx::query("insert into legal_entity_members (id, entity_id, user_id) values ($1, $2, $3)")
        .bind(fresh("lem"))
        .bind(entity)
        .bind(user)
        .execute(db)
        .await
        .unwrap();
}

struct Records {
    invoice: String,
    bill: String,
    line: String,
    document: String,
    vat_return: String,
    party: String,
}

async fn records(db: &PgPool, entity: &str, creator: Option<&str>) -> Records {
    let party = fresh("pty");
    sqlx::query(
        "insert into parties (id, kind, display_name, role, owner_id) \
         values ($1, 'company', 'Acme Trading', 'both', $2)",
    )
    .bind(&party)
    .bind(creator)
    .execute(db)
    .await
    .unwrap();
    let invoice = fresh("inv");
    sqlx::query(
        "insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name, \
           issue_date, due_date, currency, total, amount_paid, balance_due, created_by) \
         values ($1, $2, 'INV-2026-1', 'standard', 'sent', $3, 'Acme Trading', now(), now(), 'EUR', 121, 0, 121, $4)",
    )
    .bind(&invoice)
    .bind(entity)
    .bind(&party)
    .bind(creator)
    .execute(db)
    .await
    .unwrap();
    let bill = fresh("bil");
    sqlx::query(
        "insert into bills (id, entity_id, bill_number, type, status, contact_id, contact_name, \
           issue_date, due_date, currency, total, amount_paid, balance_due, created_by) \
         values ($1, $2, 'BILL-9', 'standard', 'approved', $3, 'Acme Trading', now(), now(), 'EUR', 100, 0, 100, $4)",
    )
    .bind(&bill)
    .bind(entity)
    .bind(&party)
    .bind(creator)
    .execute(db)
    .await
    .unwrap();
    let bank = fresh("bac");
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, currency) values ($1, $2, 'Bank', 'EUR')",
    )
    .bind(&bank)
    .bind(entity)
    .execute(db)
    .await
    .unwrap();
    let line = fresh("btx");
    sqlx::query(
        "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, description, \
           counterparty_name, status) \
         values ($1, $2, $3, now(), '-25.00', 'COFFEE', 'Coffee Corner', 'unreconciled')",
    )
    .bind(&line)
    .bind(entity)
    .bind(&bank)
    .execute(db)
    .await
    .unwrap();
    let document = fresh("doc");
    sqlx::query(
        "insert into documents (id, entity_id, type, file_name, file_key, source, status, created_by) \
         values ($1, $2, 'purchase_invoice', 'scan.pdf', 'key', 'upload', 'pending', $3)",
    )
    .bind(&document)
    .bind(entity)
    .bind(creator)
    .execute(db)
    .await
    .unwrap();
    let vat_return = fresh("vat");
    sqlx::query(
        "insert into vat_returns (id, entity_id, period_type, period_start, period_end, period_label, status) \
         values ($1, $2, 'quarterly', now() - interval '90 days', now(), '2026 Q3', 'calculated')",
    )
    .bind(&vat_return)
    .bind(entity)
    .execute(db)
    .await
    .unwrap();
    Records {
        invoice,
        bill,
        line,
        document,
        vat_return,
        party,
    }
}

impl Records {
    fn of(&self, kind: Provider) -> &str {
        match kind {
            Provider::Invoice => &self.invoice,
            Provider::Bill => &self.bill,
            Provider::BankTransaction => &self.line,
            Provider::AccountingDocument => &self.document,
            Provider::VatReturn => &self.vat_return,
            Provider::Party => &self.party,
            _ => unreachable!(),
        }
    }
}

const BOOKS: [Provider; 6] = [
    Provider::Invoice,
    Provider::Bill,
    Provider::BankTransaction,
    Provider::AccountingDocument,
    Provider::VatReturn,
    Provider::Party,
];

async fn may_open(db: &PgPool, user: &str, kind: Provider, id: &str) -> bool {
    let can = Can::user(db, user);
    can_access_entity(kind, db, user, id, &can).await.unwrap()
}

#[tokio::test]
async fn the_six_types_are_providers_with_the_permission_of_their_records() {
    let types: Vec<&str> = BOOKS.iter().map(|p| p.type_name()).collect();
    assert_eq!(
        types,
        [
            "invoice",
            "bill",
            "bank_transaction",
            "accounting_document",
            "vat_return",
            "accounting_contact"
        ]
    );
    let permissions: Vec<&str> = BOOKS.iter().map(|p| p.required_permission()).collect();
    assert_eq!(
        permissions,
        [
            "invoices:read",
            "bills:read",
            "banking:read",
            "invoices:read",
            "reports:read",
            "invoices:read"
        ]
    );
    for kind in BOOKS {
        assert_eq!(provider(kind.type_name()), Some(kind));
        assert!(kind.is_books());
    }
    // The record chat groups list them after the others, the legacy name left out.
    let listed: Vec<&str> = record_chat_providers().map(Provider::type_name).collect();
    assert_eq!(
        &listed[..8],
        [
            "company", "person", "task", "project", "domain", "sheet", "doc", "board"
        ]
    );
    assert_eq!(&listed[8..], types);
}

#[tokio::test]
async fn access_follows_the_permission_of_the_type_and_the_records_entity() {
    let Some(db) = pool() else { return };
    let _one = ONE_AT_A_TIME.lock().await;
    let open = entity(&db, false).await;
    let hidden = entity(&db, true).await;
    let owner = member(&db, "OWNER", &[]).await;
    let all = [
        "invoices:read",
        "bills:read",
        "banking:read",
        "reports:read",
    ];
    let accountant = member(&db, "LIMITED", &all).await;
    let insider = member(&db, "LIMITED", &all).await;
    list_member(&db, &hidden, &insider).await;
    let invoicer = member(&db, "LIMITED", &["invoices:read"]).await;
    let nobody = member(&db, "LIMITED", &[]).await;
    let in_open = records(&db, &open, Some(&owner)).await;
    let in_hidden = records(&db, &hidden, Some(&owner)).await;

    // The owner sees every entity, a restricted one included.
    for kind in BOOKS {
        assert!(
            may_open(&db, &owner, kind, in_open.of(kind)).await,
            "{kind:?}"
        );
        assert!(
            may_open(&db, &owner, kind, in_hidden.of(kind)).await,
            "{kind:?}"
        );
    }
    // A member with every read permission sees the open entity's records, and
    // of the restricted entity's none (a contact has no entity: always).
    for kind in BOOKS {
        assert!(
            may_open(&db, &accountant, kind, in_open.of(kind)).await,
            "{kind:?}"
        );
        assert_eq!(
            may_open(&db, &accountant, kind, in_hidden.of(kind)).await,
            kind == Provider::Party,
            "{kind:?}"
        );
        // Listed on the restricted entity, they see it.
        assert!(
            may_open(&db, &insider, kind, in_hidden.of(kind)).await,
            "{kind:?}"
        );
    }
    // Each type's own permission: invoices, documents and contacts open with
    // `invoices:read` and nothing else does.
    for kind in BOOKS {
        assert_eq!(
            may_open(&db, &invoicer, kind, in_open.of(kind)).await,
            matches!(
                kind,
                Provider::Invoice | Provider::AccountingDocument | Provider::Party
            ),
            "{kind:?}"
        );
        assert!(
            !may_open(&db, &nobody, kind, in_open.of(kind)).await,
            "{kind:?}"
        );
    }
    // A record that is gone, or never was, opens for nobody.
    sqlx::query("update invoices set deleted_at = now() where id = $1")
        .bind(&in_open.invoice)
        .execute(&db)
        .await
        .unwrap();
    assert!(!may_open(&db, &owner, Provider::Invoice, &in_open.invoice).await);
    assert!(!may_open(&db, &owner, Provider::Bill, "bil_missing").await);

    // A batch is the same check as one record: the lists and the single check agree.
    let can = Can::user(&db, &accountant);
    let ids = vec![
        in_open.bill.clone(),
        in_hidden.bill.clone(),
        "bil_missing".to_owned(),
    ];
    let seen = Provider::Bill
        .filter_visible(&db, &accountant, &can, &ids)
        .await
        .unwrap();
    assert_eq!(seen, HashSet::from([in_open.bill.clone()]));
}

#[tokio::test]
async fn a_chat_is_named_after_its_record_and_followed_by_its_creator_and_managers() {
    let Some(db) = pool() else { return };
    let _one = ONE_AT_A_TIME.lock().await;
    let open = entity(&db, false).await;
    let hidden = entity(&db, true).await;
    let creator = member(&db, "LIMITED", &["invoices:read"]).await;
    let owner = member(&db, "OWNER", &[]).await;
    let bookkeeper = member(&db, "LIMITED", &["journal:create", "invoices:read"]).await;
    let insider = member(&db, "LIMITED", &["journal:create"]).await;
    list_member(&db, &hidden, &insider).await;
    let reader = member(&db, "LIMITED", &["invoices:read", "bills:read"]).await;
    keep_only(&db, &[&creator, &owner, &bookkeeper, &insider, &reader]).await;
    let in_open = records(&db, &open, Some(&creator)).await;
    let in_hidden = records(&db, &hidden, Some(&creator)).await;

    let names = [
        (Provider::Invoice, "INV-2026-1"),
        (Provider::Bill, "BILL-9"),
        (Provider::BankTransaction, "Coffee Corner"),
        (Provider::AccountingDocument, "scan.pdf"),
        (Provider::VatReturn, "2026 Q3"),
        (Provider::Party, "Acme Trading"),
    ];
    for (kind, name) in names {
        let resolved = kind
            .resolve(&db, &owner, in_open.of(kind))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(resolved.display_name, name, "{kind:?}");
    }

    // An invoice: its creator first, then the members who manage the books in
    // its entity (`journal:create`): the owner, the bookkeeper and the member
    // listed on another entity (who sees this one as anyone does), not the reader.
    let invoice = Provider::Invoice
        .resolve(&db, &owner, &in_open.invoice)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(invoice.default_member_ids[0], creator);
    let managers: HashSet<&String> = invoice.default_member_ids.iter().skip(1).collect();
    assert_eq!(managers, HashSet::from([&owner, &bookkeeper, &insider]));
    assert!(!invoice.default_member_ids.contains(&reader));

    // A restricted entity's managers are those who see it: the owner and the member listed on it.
    let hidden_invoice = Provider::Invoice
        .resolve(&db, &owner, &in_hidden.invoice)
        .await
        .unwrap()
        .unwrap();
    let managers: HashSet<&String> = hidden_invoice.default_member_ids.iter().skip(1).collect();
    assert_eq!(managers, HashSet::from([&owner, &insider]));
    assert!(!hidden_invoice.default_member_ids.contains(&bookkeeper));

    // A bank line has no creator: managers only. A contact has no entity: its owner only.
    let line = Provider::BankTransaction
        .resolve(&db, &owner, &in_open.line)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        line.default_member_ids.iter().collect::<HashSet<_>>(),
        HashSet::from([&owner, &bookkeeper, &insider])
    );
    let party = Provider::Party
        .resolve(&db, &owner, &in_open.party)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(party.default_member_ids, std::slice::from_ref(&creator));

    // Not more than five managers, the creator on top.
    for _ in 0..7 {
        member(&db, "LIMITED", &["journal:create"]).await;
    }
    let crowded = Provider::Bill
        .resolve(&db, &owner, &in_open.bill)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        crowded.default_member_ids.len(),
        1 + books_records::MAX_MANAGERS
    );
    assert_eq!(crowded.default_member_ids[0], creator);

    // A missing or deleted record has no chat to start.
    assert!(
        Provider::Bill
            .resolve(&db, &owner, "bil_missing")
            .await
            .unwrap()
            .is_none()
    );
}

// ── Questions ───────────────────────────────────────────────────────────────

async fn channel(db: &PgPool, kind: Provider, record: &str) -> String {
    let id = fresh("ch");
    sqlx::query(
        "insert into chat_channels (id, name, slug, type, entity_type, entity_id, entity_display_name) \
         values ($1, 'Chat', $1, 'entity', $2, $3, 'Chat')",
    )
    .bind(&id)
    .bind(kind.type_name())
    .bind(record)
    .execute(db)
    .await
    .unwrap();
    id
}

async fn message(
    db: &PgPool,
    channel: &str,
    author: &str,
    text: &str,
    parent: Option<&str>,
    metadata: Option<&Value>,
) -> String {
    let id = fresh("msg");
    sqlx::query(
        "insert into chat_messages (id, channel_id, author_id, author_name, content, parent_id, metadata) \
         values ($1, $2, $3, $4, $5, $6, $7::text::jsonb)",
    )
    .bind(&id)
    .bind(channel)
    .bind(author)
    .bind(format!("Name of {author}"))
    .bind(text)
    .bind(parent)
    .bind(metadata.map(Value::to_string))
    .execute(db)
    .await
    .unwrap();
    id
}

async fn status(db: &PgPool, message: &str) -> String {
    let (status,): (String,) = sqlx::query_as(
        "select metadata -> 'question' ->> 'status' from chat_messages where id = $1",
    )
    .bind(message)
    .fetch_one(db)
    .await
    .unwrap();
    status
}

#[tokio::test]
async fn a_reply_by_someone_else_answers_and_the_status_moves_by_hand() {
    let Some(db) = pool() else { return };
    // Its members are owners: kept apart from the test that counts the managers.
    let _one = ONE_AT_A_TIME.lock().await;
    let entity = entity(&db, false).await;
    let owner = member(&db, "OWNER", &[]).await;
    let asker = member(&db, "OWNER", &[]).await;
    let records = records(&db, &entity, Some(&owner)).await;
    let chat = channel(&db, Provider::Invoice, &records.invoice).await;
    let metadata = new_metadata(std::slice::from_ref(&owner));
    let ask = message(&db, &chat, &asker, "What is this?", None, Some(&metadata)).await;
    let plain = message(&db, &chat, &asker, "Just a note", None, None).await;

    // The asker's own reply is not an answer.
    message(&db, &chat, &asker, "More detail", Some(&ask), None).await;
    assert!(
        questions::answer_on_reply(&db, &ask, &asker)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(status(&db, &ask).await, "open");

    // Someone else's is, once; the reply changes only the status of the question.
    message(&db, &chat, &owner, "It is the March rent", Some(&ask), None).await;
    let changed = questions::answer_on_reply(&db, &ask, &owner)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (changed.from.as_str(), changed.to.as_str()),
        ("open", "answered")
    );
    assert_eq!(changed.record_type, "invoice");
    assert_eq!(changed.record_id, records.invoice);
    assert_eq!(status(&db, &ask).await, "answered");
    let (asked_to,): (Value,) = sqlx::query_as(
        "select metadata -> 'question' -> 'askedTo' from chat_messages where id = $1",
    )
    .bind(&ask)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(asked_to, json!([owner]));
    // A second answer changes nothing.
    assert!(
        questions::answer_on_reply(&db, &ask, &owner)
            .await
            .unwrap()
            .is_none()
    );
    // A reply to a message that is no question is none.
    assert!(
        questions::answer_on_reply(&db, &plain, &owner)
            .await
            .unwrap()
            .is_none()
    );
    // A plain message is not a question.
    assert!(questions::find(&db, &plain).await.unwrap().is_none());

    // Resolved by hand, and re-opened.
    let resolved = questions::set_status(&db, &ask, "resolved")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (resolved.from.as_str(), resolved.to.as_str()),
        ("answered", "resolved")
    );
    assert_eq!(status(&db, &ask).await, "resolved");
    // A reply to a resolved question leaves it resolved.
    assert!(
        questions::answer_on_reply(&db, &ask, &owner)
            .await
            .unwrap()
            .is_none()
    );
    let reopened = questions::set_status(&db, &ask, "open")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (reopened.from.as_str(), reopened.to.as_str()),
        ("resolved", "open")
    );
    assert_eq!(status(&db, &ask).await, "open");
    // Setting it to what it is changes nothing and says so.
    let same = questions::set_status(&db, &ask, "open")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(same.from, same.to);
    // A message that is no question has no status to set.
    assert!(
        questions::set_status(&db, &plain, "resolved")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        questions::set_status(&db, "msg_missing", "resolved")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_receipt_answers_the_open_questions_on_a_bank_line() {
    let Some(db) = pool() else { return };
    // Its members are owners: kept apart from the test that counts the managers.
    let _one = ONE_AT_A_TIME.lock().await;
    let entity = entity(&db, false).await;
    let asker = member(&db, "OWNER", &[]).await;
    let records = records(&db, &entity, None).await;
    let other = records_line(&db, &entity).await;
    let chat = channel(&db, Provider::BankTransaction, &records.line).await;
    let other_chat = channel(&db, Provider::BankTransaction, &other).await;
    let open = new_metadata(&[]);
    let first = message(
        &db,
        &chat,
        &asker,
        "What was this payment?",
        None,
        Some(&open),
    )
    .await;
    let second = message(&db, &chat, &asker, "And the VAT?", None, Some(&open)).await;
    let resolved_meta = json!({ "question": { "status": "resolved" } });
    let done = message(&db, &chat, &asker, "Old one", None, Some(&resolved_meta)).await;
    let elsewhere = message(&db, &other_chat, &asker, "Another line", None, Some(&open)).await;

    let changed = questions::answer_open_on_record(&db, "bank_transaction", &records.line)
        .await
        .unwrap();
    let ids: HashSet<&str> = changed.iter().map(|c| c.message_id.as_str()).collect();
    assert_eq!(ids, HashSet::from([first.as_str(), second.as_str()]));
    assert!(
        changed
            .iter()
            .all(|c| c.record_id == records.line && c.to == "answered")
    );
    assert_eq!(status(&db, &first).await, "answered");
    assert_eq!(status(&db, &second).await, "answered");
    // What was resolved stays resolved, and another line's question is its own.
    assert_eq!(status(&db, &done).await, "resolved");
    assert_eq!(status(&db, &elsewhere).await, "open");
    // Nothing left to answer, and a record with no chat has nothing.
    assert!(
        questions::answer_open_on_record(&db, "bank_transaction", &records.line)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        questions::answer_open_on_record(&db, "bank_transaction", "btx_none")
            .await
            .unwrap()
            .is_empty()
    );
}

async fn records_line(db: &PgPool, entity: &str) -> String {
    records(db, entity, None).await.line
}

#[tokio::test]
async fn the_list_holds_the_questions_on_records_the_caller_may_see() {
    let Some(db) = pool() else { return };
    let _one = ONE_AT_A_TIME.lock().await;
    let open = entity(&db, false).await;
    let hidden = entity(&db, true).await;
    let owner = member(&db, "OWNER", &[]).await;
    let all = [
        "invoices:read",
        "bills:read",
        "banking:read",
        "reports:read",
    ];
    let accountant = member(&db, "LIMITED", &all).await;
    let invoicer = member(&db, "LIMITED", &["invoices:read"]).await;
    let in_open = records(&db, &open, Some(&owner)).await;
    let in_hidden = records(&db, &hidden, Some(&owner)).await;
    let asked = new_metadata(std::slice::from_ref(&accountant));
    let unaddressed = new_metadata(&[]);

    let chat_invoice = channel(&db, Provider::Invoice, &in_open.invoice).await;
    let chat_bill = channel(&db, Provider::Bill, &in_open.bill).await;
    let chat_line = channel(&db, Provider::BankTransaction, &in_open.line).await;
    let chat_hidden = channel(&db, Provider::Invoice, &in_hidden.invoice).await;
    let chat_party = channel(&db, Provider::Party, &in_open.party).await;
    let q_invoice = message(&db, &chat_invoice, &owner, "Invoice?", None, Some(&asked)).await;
    let q_bill = message(&db, &chat_bill, &owner, "Bill?", None, Some(&unaddressed)).await;
    let q_line = message(&db, &chat_line, &owner, "Line?", None, Some(&asked)).await;
    let q_hidden = message(&db, &chat_hidden, &owner, "Hidden?", None, Some(&asked)).await;
    let q_party = message(
        &db,
        &chat_party,
        &owner,
        "Contact?",
        None,
        Some(&unaddressed),
    )
    .await;
    // A chat message that is no question, and a deleted question, are not listed.
    message(&db, &chat_invoice, &owner, "A plain note", None, None).await;
    let gone = message(
        &db,
        &chat_bill,
        &owner,
        "Deleted?",
        None,
        Some(&unaddressed),
    )
    .await;
    sqlx::query("update chat_messages set deleted_at = now() where id = $1")
        .bind(&gone)
        .execute(&db)
        .await
        .unwrap();

    let ids = |page: &questions::Page| -> HashSet<String> {
        page.items.iter().map(|q| q.id.clone()).collect()
    };

    // The owner sees all five (the restricted entity's too).
    let can = Can::user(&db, &owner);
    let page = questions::list(&db, &owner, &can, &Filters::default(), None, 100)
        .await
        .unwrap();
    let mine: HashSet<String> = [&q_invoice, &q_bill, &q_line, &q_hidden, &q_party]
        .iter()
        .map(|id| (*id).clone())
        .collect();
    assert!(mine.is_subset(&ids(&page)));
    assert!(!ids(&page).contains(&gone));
    let first = page.items.iter().find(|q| q.id == q_invoice).unwrap();
    assert_eq!(first.record_type, "invoice");
    assert_eq!(first.record_id, in_open.invoice);
    assert_eq!(first.record_title.as_deref(), Some("INV-2026-1"));
    assert_eq!(first.text, "Invoice?");
    assert_eq!(first.status, "open");
    assert_eq!(first.asked_by.id, owner);
    assert_eq!(
        first
            .asked_to
            .iter()
            .map(|p| p.id.clone())
            .collect::<Vec<_>>(),
        [accountant.clone()]
    );
    assert_eq!(first.entity_id.as_deref(), Some(open.as_str()));
    assert_eq!(first.reply_count, 0);
    let json = first.json();
    assert_eq!(
        json["link"],
        format!("/weldbooks/invoices?stack=invoice:{}", in_open.invoice)
    );
    let party = page.items.iter().find(|q| q.id == q_party).unwrap();
    assert!(party.entity_id.is_none());

    // The accountant sees them but the restricted entity's.
    let can = Can::user(&db, &accountant);
    let page = questions::list(&db, &accountant, &can, &Filters::default(), None, 100)
        .await
        .unwrap();
    for id in [&q_invoice, &q_bill, &q_line, &q_party] {
        assert!(ids(&page).contains(id));
    }
    assert!(!ids(&page).contains(&q_hidden));

    // `askedTo=me` is what is asked to them.
    let page = questions::list(
        &db,
        &accountant,
        &can,
        &Filters {
            asked_to: Some(&accountant),
            ..Filters::default()
        },
        None,
        100,
    )
    .await
    .unwrap();
    assert!(ids(&page).contains(&q_invoice) && ids(&page).contains(&q_line));
    assert!(!ids(&page).contains(&q_bill) && !ids(&page).contains(&q_hidden));

    // A type filter, and the types the member's permissions open: `invoices:read` only.
    let page = questions::list(
        &db,
        &accountant,
        &can,
        &Filters {
            record_type: Some("bank_transaction"),
            ..Filters::default()
        },
        None,
        100,
    )
    .await
    .unwrap();
    assert!(
        page.items
            .iter()
            .all(|q| q.record_type == "bank_transaction")
    );
    assert!(ids(&page).contains(&q_line));
    let can = Can::user(&db, &invoicer);
    let page = questions::list(&db, &invoicer, &can, &Filters::default(), None, 100)
        .await
        .unwrap();
    assert!(page.items.iter().all(|q| matches!(
        q.record_type.as_str(),
        "invoice" | "accounting_document" | "accounting_contact"
    )));
    assert!(ids(&page).contains(&q_invoice) && ids(&page).contains(&q_party));
    assert!(!ids(&page).contains(&q_bill) && !ids(&page).contains(&q_line));

    // The status filter and the paging.
    questions::set_status(&db, &q_bill, "resolved")
        .await
        .unwrap();
    let can = Can::user(&db, &owner);
    let resolved = questions::list(
        &db,
        &owner,
        &can,
        &Filters {
            status: Some("resolved"),
            ..Filters::default()
        },
        None,
        100,
    )
    .await
    .unwrap();
    assert!(ids(&resolved).contains(&q_bill) && !ids(&resolved).contains(&q_invoice));
    let everything = questions::list(&db, &owner, &can, &Filters::default(), None, 100)
        .await
        .unwrap();
    let first_two = questions::list(&db, &owner, &can, &Filters::default(), None, 2)
        .await
        .unwrap();
    assert!(first_two.has_more);
    assert_eq!(first_two.total, everything.total);
    assert_eq!(
        first_two.cursor.as_deref(),
        Some(everything.items[1].id.as_str())
    );
    let next_two = questions::list(
        &db,
        &owner,
        &can,
        &Filters::default(),
        first_two.cursor.as_deref(),
        2,
    )
    .await
    .unwrap();
    let paged: Vec<&str> = first_two
        .items
        .iter()
        .chain(&next_two.items)
        .map(|q| q.id.as_str())
        .collect();
    let whole: Vec<&str> = everything
        .items
        .iter()
        .take(4)
        .map(|q| q.id.as_str())
        .collect();
    assert_eq!(paged, whole);
}
