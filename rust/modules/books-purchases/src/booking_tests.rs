//! Booking an inbox document, against the real tenant schema
//! (`WELDSUITE_TEST_TENANT_URL`; each test returns early without it): the
//! receipt paid with a bank line, the supplier invoice that finds its line on
//! its own, cash and private payments, what is refused before anything is
//! written, the rollback of a booking that fails late, idempotency, entity
//! isolation, the bank line candidates, duplicates, the supplier's booking
//! defaults and the release of a deleted bill's document.

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::assert_is_empty,
    clippy::int_plus_one,
    clippy::cloned_ref_to_slice_refs,
    clippy::len_zero,
    clippy::ignored_unit_patterns,
    clippy::unused_async,
    reason = "test fixtures are written in SQL; each test is one scenario read top to bottom"
)]

use axum::extract::{Path, State};
use serde_json::{Value, json};

use crate::booking_defaults::booking_defaults;
use crate::document_booking::{bank_candidates, book_document, duplicates, prefill, read_book};
use crate::test_support::{
    DEFAULT_ENTITY, World, account, answer, answer_of, bank_line, book_body, company, count,
    document, fresh, ocr_result, row_of, supplier, text,
};

fn names(events: &[(String, Value)]) -> Vec<&str> {
    events.iter().map(|(name, _)| name.as_str()).collect()
}

fn lines(account: &str, tax: &str, amount: f64) -> Value {
    json!([{ "description": "Printer paper", "accountId": account, "taxRateId": tax, "amount": amount }])
}

#[tokio::test]
async fn a_receipt_is_booked_paid_with_its_bank_line() {
    let Some(world) = World::new() else {
        return;
    };
    let co = company(&world.db, "NL91ABNA0417164300").await;
    let shop = supplier(&world.db, "Bol.com", Some("NL02ABNA0123456789")).await;
    let ocr = ocr_result("Bol.com", "NL02ABNA0123456789", "R-1", "2026-11-18", 121.0);
    let doc = document(
        &world.db,
        Some(&co.entity),
        "bon.pdf",
        1200,
        "processed",
        Some(&ocr),
    )
    .await;
    let line = bank_line(
        &world.db,
        &co.entity,
        &co.bank,
        "2026-11-20",
        "-121.00",
        "Bol.com order",
        (Some("Bol.com"), Some("NL02ABNA0123456789")),
    )
    .await;
    let caller = world.caller(&co.entity);
    world.events().await;

    let body = book_body(&json!({
        "kind": "receipt",
        "contactId": shop,
        "invoiceNumber": "R-1",
        "date": "2026-11-18",
        "lines": lines(&co.office, &co.vat21, 121.0),
        "paidWith": { "type": "bank_transaction", "bankTransactionId": line },
    }));
    let (status, out) = answer(book_document(&caller, &world.state, &doc, body).await).await;
    assert_eq!(status, 201, "{out}");
    let data = &out["data"];
    assert_eq!(data["autoLinked"], json!(false));
    let bill = &data["bill"];
    assert_eq!(text(bill, "type"), "receipt");
    assert_eq!(text(bill, "status"), "paid");
    assert_eq!(text(bill, "total"), "121.00");
    assert_eq!(text(bill, "taxTotal"), "21.00");
    assert_eq!(text(bill, "sourceDocumentId"), doc);
    assert_eq!(text(bill, "externalReference"), "R-1");
    assert_eq!(bill["items"].as_array().unwrap().len(), 1);
    assert_eq!(data["bankTransactionId"], json!(line));
    assert_eq!(text(&data["payment"], "amount"), "121");

    // The document is linked to the bill, the line to the payment and the bill.
    let doc_row = row_of(&world.db, "documents", &doc).await;
    assert_eq!(text(&doc_row, "status"), "linked");
    assert_eq!(text(&doc_row, "linked_entity_type"), "bill");
    assert_eq!(text(&doc_row, "linked_entity_id"), text(bill, "id"));
    let line_row = row_of(&world.db, "bank_transactions", &line).await;
    assert_eq!(text(&line_row, "status"), "reconciled");
    assert_eq!(text(&line_row, "reconciled_bill_id"), text(bill, "id"));
    assert_eq!(
        text(&line_row, "reconciled_payment_id"),
        text(&data["payment"], "id")
    );
    // Posted once: the bill's entry and the payment's.
    let entries = count(
        &world.db,
        "select count(*) from journal_entries where source_id = $1",
        text(bill, "id"),
    )
    .await;
    assert_eq!(entries, 1);

    let events = world.events().await;
    let names = names(&events);
    for expected in [
        "bill.created",
        "bill.updated",
        "journal_entry.created",
        "bank_transaction.processed",
        "payment.created",
        "accounting_document.booked",
    ] {
        assert!(names.contains(&expected), "{expected} in {names:?}");
    }
    let booked = events
        .iter()
        .find(|(name, _)| name == "accounting_document.booked")
        .unwrap();
    assert_eq!(booked.1["billId"], bill["id"]);
    assert_eq!(booked.1["kind"], json!("receipt"));

    // Booking it again answers the bill it became and writes nothing.
    let again = book_body(&json!({
        "kind": "receipt", "contactId": shop, "date": "2026-11-18",
        "lines": lines(&co.office, &co.vat21, 121.0),
    }));
    let (status, out) = answer(book_document(&caller, &world.state, &doc, again).await).await;
    assert_eq!(status, 200, "{out}");
    assert_eq!(out["data"]["alreadyBooked"], json!(true));
    assert_eq!(text(&out["data"]["bill"], "id"), text(bill, "id"));
    let bills = count(
        &world.db,
        "select count(*) from bills where source_document_id = $1",
        &doc,
    )
    .await;
    assert_eq!(bills, 1);
    assert!(world.events().await.is_empty());
}

#[tokio::test]
async fn an_invoice_finds_its_one_sure_bank_line_and_leaves_the_unsure_ones() {
    let Some(world) = World::new() else {
        return;
    };
    let co = company(&world.db, "NL91ABNA0417164300").await;
    let acme = supplier(&world.db, "Acme Trading", Some("NL02ABNA0123456789")).await;
    let caller = world.caller(&co.entity);

    // One line is the supplier's, for the exact amount: linked on its own.
    let ocr = ocr_result(
        "Acme Trading",
        "NL02ABNA0123456789",
        "F-100",
        "2026-11-18",
        242.0,
    );
    let doc = document(
        &world.db,
        Some(&co.entity),
        "f100.pdf",
        2200,
        "processed",
        Some(&ocr),
    )
    .await;
    let sure = bank_line(
        &world.db,
        &co.entity,
        &co.bank,
        "2026-11-25",
        "-242.00",
        "Factuur F-100",
        (Some("Acme Trading B.V."), Some("NL02ABNA0123456789")),
    )
    .await;
    let stranger = bank_line(
        &world.db,
        &co.entity,
        &co.bank,
        "2026-11-25",
        "-242.00",
        "Something",
        (Some("Other"), Some("DE89370400440532013000")),
    )
    .await;
    let body = book_body(&json!({
        "kind": "purchase_invoice", "contactId": acme, "invoiceNumber": "F-100", "date": "2026-11-18",
        "dueDate": "2026-12-18", "lines": lines(&co.rent, &co.vat21, 242.0),
    }));
    let (status, out) = answer(book_document(&caller, &world.state, &doc, body).await).await;
    assert_eq!(status, 201, "{out}");
    assert_eq!(out["data"]["autoLinked"], json!(true));
    assert_eq!(out["data"]["bankTransactionId"], json!(sure));
    assert_eq!(text(&out["data"]["bill"], "status"), "paid");
    assert_eq!(
        text(
            &row_of(&world.db, "bank_transactions", &stranger).await,
            "status"
        ),
        "unreconciled"
    );

    // Two lines that are both sure: nothing is guessed.
    let ocr = ocr_result(
        "Acme Trading",
        "NL02ABNA0123456789",
        "F-200",
        "2026-11-18",
        60.5,
    );
    let doc = document(
        &world.db,
        Some(&co.entity),
        "f200.pdf",
        2300,
        "processed",
        Some(&ocr),
    )
    .await;
    for _ in 0..2 {
        bank_line(
            &world.db,
            &co.entity,
            &co.bank,
            "2026-11-26",
            "-60.50",
            "Factuur F-200",
            (Some("Acme Trading"), Some("NL02ABNA0123456789")),
        )
        .await;
    }
    let body = book_body(&json!({
        "kind": "purchase_invoice", "contactId": acme, "invoiceNumber": "F-200", "date": "2026-11-18",
        "lines": lines(&co.rent, &co.vat21, 60.5),
    }));
    let (status, out) = answer(book_document(&caller, &world.state, &doc, body).await).await;
    assert_eq!(status, 201, "{out}");
    assert_eq!(out["data"]["autoLinked"], json!(false));
    assert_eq!(text(&out["data"]["bill"], "status"), "approved");
    assert!(out["data"].get("payment").is_none());

    // And the bank lines it could have been paid with are offered, best first.
    let (status, out) =
        answer_of(bank_candidates(world.caller(&co.entity), Path(doc.clone())).await).await;
    assert_eq!(status, 200, "{out}");
    let found = out["data"].as_array().unwrap();
    assert_eq!(found.len(), 2, "{out}");
    assert_eq!(found[0]["sure"], json!(true));
    assert!(found[0]["score"].as_f64().unwrap() >= 0.8);
    assert!(found[0]["reasons"].as_array().unwrap().len() >= 2);
}

#[tokio::test]
async fn cash_private_and_card_pay_as_asked() {
    let Some(world) = World::new() else {
        return;
    };
    let co = company(&world.db, "NL91ABNA0417164300").await;
    let shop = supplier(&world.db, "Gamma", None).await;
    let caller = world.caller(&co.entity);
    let book = |doc: String, kind: &str, paid: Value| {
        let body = book_body(&json!({
            "kind": kind, "contactId": shop, "date": "2026-11-18",
            "lines": lines(&co.office, &co.vat21, 12.1),
            "paidWith": paid,
        }));
        (doc, body)
    };

    // Cash needs a cash account.
    let doc = document(&world.db, Some(&co.entity), "c1.pdf", 10, "processed", None).await;
    let (id, body) = book(doc.clone(), "receipt", json!({ "type": "cash" }));
    let (status, out) = answer(book_document(&caller, &world.state, &id, body).await).await;
    assert_eq!(status, 400, "{out}");
    assert!(
        out["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cash account")
    );
    // Nothing was written: no bill, the document as it was.
    assert_eq!(
        count(
            &world.db,
            "select count(*) from bills where source_document_id = $1",
            &doc
        )
        .await,
        0
    );
    assert_eq!(
        text(&row_of(&world.db, "documents", &doc).await, "status"),
        "processed"
    );

    let cash = {
        let id = account(
            &world.db, &co.entity, "1010", "Cash", "asset", "debit", None,
        )
        .await;
        sqlx::query("update accounts set subtype = 'cash' where id = $1")
            .bind(&id)
            .execute(&world.db)
            .await
            .unwrap();
        id
    };
    let (id, body) = book(doc.clone(), "receipt", json!({ "type": "cash" }));
    let (status, out) = answer(book_document(&caller, &world.state, &id, body).await).await;
    assert_eq!(status, 201, "{out}");
    assert_eq!(text(&out["data"]["bill"], "status"), "paid");
    assert_eq!(text(&out["data"]["payment"], "method"), "cash");
    let credited: i64 = sqlx::query_scalar(
        "select count(*) from journal_lines l join journal_entries e on e.id = l.journal_entry_id \
         where e.source_type = 'payment' and l.account_id = $1 and l.credit::numeric = 12.10",
    )
    .bind(&cash)
    .fetch_one(&world.db)
    .await
    .unwrap();
    assert_eq!(credited, 1, "the cash account is credited");

    // Private: the director's current account (a BV), made on first use.
    let doc = document(&world.db, Some(&co.entity), "p1.pdf", 11, "processed", None).await;
    let (id, body) = book(
        doc.clone(),
        "purchase_invoice",
        json!({ "type": "private" }),
    );
    let (status, out) = answer(book_document(&caller, &world.state, &id, body).await).await;
    assert_eq!(status, 201, "{out}");
    assert_eq!(text(&out["data"]["bill"], "status"), "paid");
    assert_eq!(text(&out["data"]["payment"], "method"), "private");
    let private: i64 = sqlx::query_scalar(
        "select count(*) from journal_lines l join accounts a on a.id = l.account_id \
         join journal_entries e on e.id = l.journal_entry_id \
         where e.source_type = 'payment' and a.metadata->>'systemRole' = 'director_current_account' \
           and a.entity_id = $1 and l.credit::numeric = 12.10",
    )
    .bind(&co.entity)
    .fetch_one(&world.db)
    .await
    .unwrap();
    assert_eq!(
        private, 1,
        "paid from the director's current account, not the bank"
    );
    let from_bank: i64 = sqlx::query_scalar(
        "select count(*) from journal_lines where account_id = $1 and deleted_at is null",
    )
    .bind(&co.bank_ledger)
    .fetch_one(&world.db)
    .await
    .unwrap();
    assert_eq!(from_bank, 0);

    // A card payment whose bank line has not come in yet: booked, still open.
    let doc = document(&world.db, Some(&co.entity), "k1.pdf", 12, "processed", None).await;
    let (id, body) = book(doc, "receipt", json!({ "type": "card_unmatched" }));
    let (status, out) = answer(book_document(&caller, &world.state, &id, body).await).await;
    assert_eq!(status, 201, "{out}");
    assert_eq!(text(&out["data"]["bill"], "status"), "approved");
    assert!(out["data"].get("payment").is_none());
    assert_eq!(text(&out["data"]["bill"], "balanceDue"), "12.10");
}

#[tokio::test]
async fn a_credit_note_is_a_supplier_credit_note_and_is_not_paid() {
    let Some(world) = World::new() else {
        return;
    };
    let co = company(&world.db, "NL91ABNA0417164300").await;
    let shop = supplier(&world.db, "Supplier", None).await;
    let caller = world.caller(&co.entity);
    let doc = document(&world.db, Some(&co.entity), "cn.pdf", 5, "processed", None).await;
    let paid = book_body(&json!({
        "kind": "credit_note", "contactId": shop, "date": "2026-11-18",
        "lines": lines(&co.office, &co.vat21, 24.2),
        "paidWith": { "type": "cash" },
    }));
    let (status, out) = answer(book_document(&caller, &world.state, &doc, paid).await).await;
    assert_eq!(status, 400, "{out}");
    let body = book_body(&json!({
        "kind": "credit_note", "contactId": shop, "date": "2026-11-18",
        "lines": lines(&co.office, &co.vat21, 24.2),
    }));
    let (status, out) = answer(book_document(&caller, &world.state, &doc, body).await).await;
    assert_eq!(status, 201, "{out}");
    assert_eq!(text(&out["data"]["bill"], "type"), "credit_note");
    assert_eq!(text(&out["data"]["bill"], "total"), "24.20");
    assert!(!text(&out["data"]["bill"], "journalEntryId").is_empty());
}

#[tokio::test]
async fn what_is_wrong_is_refused_before_anything_is_written() {
    let Some(world) = World::new() else {
        return;
    };
    let co = company(&world.db, "NL91ABNA0417164300").await;
    let other = company(&world.db, "NL12ABNA0000000002").await;
    let shop = supplier(&world.db, "Shop", None).await;
    let caller = world.caller(&co.entity);
    let doc = document(&world.db, Some(&co.entity), "w1.pdf", 7, "processed", None).await;
    let untouched = |db: sqlx::PgPool, doc: String| async move {
        assert_eq!(
            count(
                &db,
                "select count(*) from bills where source_document_id = $1",
                &doc
            )
            .await,
            0
        );
        let row = row_of(&db, "documents", &doc).await;
        assert_eq!(text(&row, "status"), "processed");
        assert!(row["linked_entity_id"].is_null());
    };

    // A contact that is not there; an account of another entity.
    for (contact, account) in [
        ("pty_missing", co.office.as_str()),
        (shop.as_str(), other.office.as_str()),
    ] {
        let body = book_body(&json!({
            "kind": "receipt", "contactId": contact, "date": "2026-11-18",
            "lines": [{ "description": "x", "accountId": account, "amount": 5 }],
        }));
        let (status, out) = answer(book_document(&caller, &world.state, &doc, body).await).await;
        assert_eq!(status, 400, "{out}");
        untouched(world.db.clone(), doc.clone()).await;
    }

    // A bank line that is already processed, one that is money in, one of
    // another entity.
    let done = bank_line(
        &world.db,
        &co.entity,
        &co.bank,
        "2026-11-20",
        "-5.00",
        "d",
        (None, None),
    )
    .await;
    sqlx::query("update bank_transactions set status = 'reconciled' where id = $1")
        .bind(&done)
        .execute(&world.db)
        .await
        .unwrap();
    let income = bank_line(
        &world.db,
        &co.entity,
        &co.bank,
        "2026-11-20",
        "5.00",
        "i",
        (None, None),
    )
    .await;
    let foreign = bank_line(
        &world.db,
        &other.entity,
        &other.bank,
        "2026-11-20",
        "-5.00",
        "f",
        (None, None),
    )
    .await;
    for (line, expected) in [(&done, 400), (&income, 400), (&foreign, 404)] {
        let body = book_body(&json!({
            "kind": "receipt", "contactId": shop, "date": "2026-11-18",
            "lines": [{ "description": "x", "accountId": co.office, "amount": 5 }],
            "paidWith": { "type": "bank_transaction", "bankTransactionId": line },
        }));
        let (status, out) = answer(book_document(&caller, &world.state, &doc, body).await).await;
        assert_eq!(status, expected, "{out}");
        untouched(world.db.clone(), doc.clone()).await;
    }

    // A rejected document is not for the books; a rejected body is not read.
    let rejected = document(&world.db, Some(&co.entity), "r.pdf", 8, "rejected", None).await;
    let body = book_body(&json!({
        "kind": "receipt", "contactId": shop, "date": "2026-11-18",
        "lines": [{ "description": "x", "amount": 5 }],
    }));
    let (status, _) = answer(book_document(&caller, &world.state, &rejected, body).await).await;
    assert_eq!(status, 400);
    for bad in [
        json!({}),
        json!({ "kind": "gift", "contactId": "c", "date": "2026-11-18", "lines": [{ "description": "x", "amount": 1 }] }),
        json!({ "kind": "receipt", "contactId": "c", "date": "18-11-2026", "lines": [{ "description": "x", "amount": 1 }] }),
        json!({ "kind": "receipt", "contactId": "c", "date": "2026-11-18", "lines": [] }),
        json!({ "kind": "receipt", "contactId": "c", "date": "2026-11-18", "lines": [{ "description": "x", "amount": 0 }] }),
        json!({ "kind": "receipt", "contactId": "c", "date": "2026-11-18", "lines": [{ "description": "x", "amount": 1 }],
                "paidWith": { "type": "bank_transaction" } }),
        json!({ "kind": "receipt", "contactId": "c", "date": "2026-11-18", "lines": [{ "description": "x", "amount": 1 }],
                "paidWith": { "type": "barter" } }),
    ] {
        assert!(
            weldsuite_books_domain::http::validate_value(&bad, read_book).is_err(),
            "{bad}"
        );
    }
}

#[tokio::test]
async fn a_booking_that_fails_late_leaves_nothing_behind() {
    let Some(world) = World::new() else {
        return;
    };
    let co = company(&world.db, "NL91ABNA0417164300").await;
    let shop = supplier(&world.db, "Shop", None).await;
    let caller = world.caller(&co.entity);
    // A bank account with no ledger account: the payment cannot be posted.
    let orphan = fresh("bac");
    sqlx::query("insert into bank_accounts (id, entity_id, name, iban, currency) values ($1, $2, 'Loose', 'NL86INGB0002445588', 'EUR')")
        .bind(&orphan)
        .bind(&co.entity)
        .execute(&world.db)
        .await
        .unwrap();
    let line = bank_line(
        &world.db,
        &co.entity,
        &orphan,
        "2026-11-20",
        "-12.10",
        "x",
        (None, None),
    )
    .await;
    let doc = document(
        &world.db,
        Some(&co.entity),
        "late.pdf",
        9,
        "processed",
        None,
    )
    .await;
    let body = book_body(&json!({
        "kind": "receipt", "contactId": shop, "date": "2026-11-18",
        "lines": lines(&co.office, &co.vat21, 12.1),
        "paidWith": { "type": "bank_transaction", "bankTransactionId": line },
    }));
    let (status, out) = answer(book_document(&caller, &world.state, &doc, body).await).await;
    assert_eq!(status, 400, "{out}");
    // The document is as it was, the bill is cancelled and its entry reversed.
    let row = row_of(&world.db, "documents", &doc).await;
    assert_eq!(text(&row, "status"), "processed");
    assert!(row["linked_entity_id"].is_null(), "{row}");
    let bill: Value =
        sqlx::query_scalar("select to_jsonb(b) from bills b where source_document_id = $1")
            .bind(&doc)
            .fetch_one(&world.db)
            .await
            .unwrap();
    assert_eq!(text(&bill, "status"), "cancelled");
    let net: String = sqlx::query_scalar(
        "select coalesce(sum(l.debit::numeric - l.credit::numeric), 0)::text from journal_lines l \
         join journal_entries e on e.id = l.journal_entry_id where e.entity_id = $1 and l.deleted_at is null",
    )
    .bind(&co.entity)
    .fetch_one(&world.db)
    .await
    .unwrap();
    assert_eq!(net.parse::<f64>().unwrap(), 0.0, "the books net to nothing");
    assert_eq!(
        text(
            &row_of(&world.db, "bank_transactions", &line).await,
            "status"
        ),
        "unreconciled"
    );
    // The document can be booked again.
    let again = book_body(&json!({
        "kind": "receipt", "contactId": shop, "date": "2026-11-18",
        "lines": lines(&co.office, &co.vat21, 12.1),
    }));
    let (status, out) = answer(book_document(&caller, &world.state, &doc, again).await).await;
    assert_eq!(status, 201, "{out}");
}

#[tokio::test]
async fn a_document_belongs_to_one_entity() {
    let Some(world) = World::new() else {
        return;
    };
    let co = company(&world.db, "NL91ABNA0417164300").await;
    let other = company(&world.db, "NL12ABNA0000000002").await;
    let shop = supplier(&world.db, "Shop", None).await;
    let _default = DEFAULT_ENTITY.lock().await;
    let doc = document(
        &world.db,
        Some(&co.entity),
        "iso.pdf",
        20,
        "processed",
        None,
    )
    .await;
    let body = || {
        book_body(&json!({
            "kind": "receipt", "contactId": shop, "date": "2026-11-18",
            "lines": lines(&co.office, &co.vat21, 12.1),
        }))
    };
    // The other entity's request does not see it, in any of the routes.
    let intruder = world.caller(&other.entity);
    let (status, _) = answer(book_document(&intruder, &world.state, &doc, body()).await).await;
    assert_eq!(status, 404);
    let (status, _) =
        answer_of(bank_candidates(world.caller(&other.entity), Path(doc.clone())).await).await;
    assert_eq!(status, 404);
    let (status, _) =
        answer_of(duplicates(world.caller(&other.entity), Path(doc.clone())).await).await;
    assert_eq!(status, 404);
    let (status, _) =
        answer_of(prefill(world.caller(&other.entity), Path(doc.clone())).await).await;
    assert_eq!(status, 404);
    // A document with no entity is the default entity's: not this one's unless it is.
    let loose = document(&world.db, None, "loose.pdf", 21, "processed", None).await;
    sqlx::query("update entities set is_default = false where is_default")
        .execute(&world.db)
        .await
        .unwrap();
    sqlx::query("update entities set is_default = true where id = $1")
        .bind(&co.entity)
        .execute(&world.db)
        .await
        .unwrap();
    let (status, _) = answer(book_document(&intruder, &world.state, &loose, body()).await).await;
    assert_eq!(status, 404);
    let (status, out) =
        answer(book_document(&world.caller(&co.entity), &world.state, &loose, body()).await).await;
    assert_eq!(status, 201, "{out}");
    // Booked, it belongs to the entity.
    assert_eq!(
        text(&row_of(&world.db, "documents", &loose).await, "entity_id"),
        co.entity
    );
    sqlx::query("update entities set is_default = false where id = $1")
        .bind(&co.entity)
        .execute(&world.db)
        .await
        .unwrap();
}

#[tokio::test]
async fn duplicates_are_the_same_supplier_and_number_or_the_same_file() {
    let Some(world) = World::new() else {
        return;
    };
    let co = company(&world.db, "NL91ABNA0417164300").await;
    let acme = supplier(&world.db, "Acme", None).await;
    let caller = world.caller(&co.entity);
    let first = document(
        &world.db,
        Some(&co.entity),
        "inv.pdf",
        4321,
        "processed",
        None,
    )
    .await;
    let body = book_body(&json!({
        "kind": "purchase_invoice", "contactId": acme, "invoiceNumber": " F-9 ", "date": "2026-11-18",
        "lines": lines(&co.office, &co.vat21, 12.1),
    }));
    let (status, out) = answer(book_document(&caller, &world.state, &first, body).await).await;
    assert_eq!(status, 201, "{out}");
    let bill_id = text(&out["data"]["bill"], "id").to_owned();

    // Mailed again: same file name and size, and the OCR reads the same number.
    let ocr = ocr_result("Acme", "NL02ABNA0123456789", "f-9", "2026-11-19", 12.1);
    let second = document(
        &world.db,
        Some(&co.entity),
        "inv.pdf",
        4321,
        "processed",
        Some(&ocr),
    )
    .await;
    sqlx::query("update documents set matched_contact_id = $2 where id = $1")
        .bind(&second)
        .bind(&acme)
        .execute(&world.db)
        .await
        .unwrap();
    let (status, out) =
        answer_of(duplicates(world.caller(&co.entity), Path(second.clone())).await).await;
    assert_eq!(status, 200, "{out}");
    let bills = out["data"]["bills"].as_array().unwrap();
    assert_eq!(bills.len(), 1, "{out}");
    assert_eq!(text(&bills[0], "id"), bill_id);
    assert_eq!(
        text(&bills[0], "reason"),
        "same supplier and invoice number"
    );
    let files = out["data"]["documents"].as_array().unwrap();
    assert_eq!(files.len(), 1, "{out}");
    assert_eq!(text(&files[0], "id"), first);

    // A different supplier with the same number is not a duplicate.
    let other_supplier = supplier(&world.db, "Zeta", None).await;
    sqlx::query("update documents set matched_contact_id = $2 where id = $1")
        .bind(&second)
        .bind(&other_supplier)
        .execute(&world.db)
        .await
        .unwrap();
    let (_, out) = answer_of(duplicates(world.caller(&co.entity), Path(second)).await).await;
    assert!(out["data"]["bills"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_supplier_s_defaults_come_from_its_last_posted_bills() {
    let Some(world) = World::new() else {
        return;
    };
    let co = company(&world.db, "NL91ABNA0417164300").await;
    let acme = supplier(&world.db, "Acme", None).await;
    let caller = world.caller(&co.entity);
    // Nothing yet: the supplier's own default account, or nothing at all.
    let none = booking_defaults(&world.db, Some(&co.entity), &acme)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(none["basedOnBills"], json!(0));
    assert!(none["account"].is_null() && none["taxRate"].is_null() && none["project"].is_null());
    assert!(
        booking_defaults(&world.db, None, "pty_missing")
            .await
            .unwrap()
            .is_none()
    );

    // Three bills to rent with 21%, one to office: rent is the usual.
    for (index, account) in [&co.rent, &co.rent, &co.office, &co.rent]
        .into_iter()
        .enumerate()
    {
        let doc = document(
            &world.db,
            Some(&co.entity),
            &format!("d{index}.pdf"),
            100 + i32::try_from(index).unwrap(),
            "processed",
            None,
        )
        .await;
        let body = book_body(&json!({
            "kind": "purchase_invoice", "contactId": acme, "date": format!("2026-11-{:02}", 10 + index),
            "lines": lines(account, &co.vat21, 121.0),
        }));
        let (status, out) = answer(book_document(&caller, &world.state, &doc, body).await).await;
        assert_eq!(status, 201, "{out}");
    }
    // A draft is not history.
    let draft = fresh("bil");
    sqlx::query(
        "insert into bills (id, entity_id, bill_number, type, status, contact_id, issue_date, due_date) \
         values ($1, $2, 'DRAFT', 'standard', 'draft', $3, now(), now())",
    )
    .bind(&draft)
    .bind(&co.entity)
    .bind(&acme)
    .execute(&world.db)
    .await
    .unwrap();
    let defaults = booking_defaults(&world.db, Some(&co.entity), &acme)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(defaults["basedOnBills"], json!(4));
    assert_eq!(defaults["account"]["accountId"], json!(co.rent));
    assert_eq!(defaults["account"]["count"], json!(3));
    assert_eq!(defaults["account"]["source"], json!("history"));
    assert_eq!(defaults["taxRate"]["taxRateId"], json!(co.vat21));
    assert_eq!(defaults["taxRate"]["count"], json!(4));
    assert!(defaults["project"].is_null());
    assert!(defaults["lastBill"]["id"].is_string());

    // The review form starts from them for a document of that supplier.
    let ocr = ocr_result("Acme", "NL02ABNA0123456789", "N-1", "2026-11-20", 121.0);
    let doc = document(
        &world.db,
        Some(&co.entity),
        "next.pdf",
        999,
        "processed",
        Some(&ocr),
    )
    .await;
    sqlx::query("update documents set matched_contact_id = $2 where id = $1")
        .bind(&doc)
        .bind(&acme)
        .execute(&world.db)
        .await
        .unwrap();
    let (status, out) = answer_of(prefill(world.caller(&co.entity), Path(doc)).await).await;
    assert_eq!(status, 200, "{out}");
    let form = &out["data"];
    assert_eq!(text(form, "kind"), "receipt");
    assert_eq!(form["paid"], json!(true));
    assert_eq!(text(form, "paymentMethod"), "card");
    assert_eq!(form["paidWith"]["type"], json!("card_unmatched"));
    assert_eq!(form["contactId"], json!(acme));
    assert_eq!(text(form, "invoiceNumber"), "N-1");
    let line = &form["lines"][0];
    assert_eq!(line["accountId"], json!(co.rent));
    assert_eq!(line["taxRateId"], json!(co.vat21));
    assert_eq!(line["amount"], json!(121.0));
    assert_eq!(text(form, "iban"), "NL02ABNA0123456789");
}

#[tokio::test]
async fn deleting_a_bill_releases_its_document() {
    let Some(world) = World::new() else {
        return;
    };
    let co = company(&world.db, "NL91ABNA0417164300").await;
    let shop = supplier(&world.db, "Shop", None).await;
    let caller = world.caller(&co.entity);
    let ocr = ocr_result("Shop", "NL02ABNA0123456789", "D-1", "2026-11-18", 12.1);
    let doc = document(
        &world.db,
        Some(&co.entity),
        "del.pdf",
        33,
        "processed",
        Some(&ocr),
    )
    .await;
    // A draft bill made from the document, as the bills route makes it.
    let bill = crate::bills::create_bill(
        &caller,
        &world.state,
        crate::bills::BillBody {
            entity_id: Some(co.entity.clone()),
            contact_id: Some(shop.clone()),
            issue_date: Some("2026-11-18".to_owned()),
            due_date: Some("2026-12-18".to_owned()),
            source_document_id: Some(doc.clone()),
            items: Some(vec![crate::bills::BillLine {
                description: "x".to_owned(),
                quantity: "1".to_owned(),
                unit_price: "10".to_owned(),
                discount_percent: "0".to_owned(),
                account_id: Some(co.office.clone()),
                ..crate::bills::BillLine::default()
            }]),
            ..crate::bills::BillBody::default()
        },
    )
    .await
    .unwrap();
    let bill_id = text(&bill, "id").to_owned();
    let linked = row_of(&world.db, "documents", &doc).await;
    assert_eq!(text(&linked, "status"), "linked");
    assert_eq!(text(&linked, "linked_entity_id"), bill_id);

    let response = crate::bills::remove(
        world.caller(&co.entity),
        State(world.state.clone()),
        Path(bill_id.clone()),
    )
    .await;
    assert_eq!(response.status().as_u16(), 204);
    let released = row_of(&world.db, "documents", &doc).await;
    assert_eq!(text(&released, "status"), "processed");
    assert!(released["linked_entity_type"].is_null());
    assert!(released["linked_entity_id"].is_null());
    // A document that was linked to something else is not touched.
    let other = document(&world.db, Some(&co.entity), "keep.pdf", 34, "linked", None).await;
    sqlx::query("update documents set linked_entity_type = 'invoice', linked_entity_id = 'inv_1' where id = $1")
        .bind(&other)
        .execute(&world.db)
        .await
        .unwrap();
    crate::bills::release_documents(&world.db, &bill_id)
        .await
        .unwrap();
    assert_eq!(
        text(&row_of(&world.db, "documents", &other).await, "status"),
        "linked"
    );
}

#[tokio::test]
async fn an_open_receipt_is_a_candidate_for_the_bank_line_that_comes_in_later() {
    use weldsuite_books_domain::bank_matching::find_matches;
    let Some(world) = World::new() else {
        return;
    };
    let co = company(&world.db, "NL91ABNA0417164300").await;
    let shop = supplier(&world.db, "Bol.com", Some("NL02ABNA0123456789")).await;
    let caller = world.caller(&co.entity);
    // A card receipt booked before its bank line is there: open, type receipt.
    let doc = document(
        &world.db,
        Some(&co.entity),
        "later.pdf",
        77,
        "processed",
        None,
    )
    .await;
    let body = book_body(&json!({
        "kind": "receipt", "contactId": shop, "invoiceNumber": "R-77", "date": "2026-11-18",
        "lines": lines(&co.office, &co.vat21, 121.0),
        "paidWith": { "type": "card_unmatched" },
    }));
    let (status, out) = answer(book_document(&caller, &world.state, &doc, body).await).await;
    assert_eq!(status, 201, "{out}");
    let receipt = text(&out["data"]["bill"], "id").to_owned();
    assert_eq!(text(&out["data"]["bill"], "type"), "receipt");
    assert_eq!(text(&out["data"]["bill"], "status"), "approved");

    // The bank line arrives: the matcher offers the receipt.
    let line = bank_line(
        &world.db,
        &co.entity,
        &co.bank,
        "2026-11-19",
        "-121.00",
        "Bol.com order",
        (Some("Bol.com"), Some("NL02ABNA0123456789")),
    )
    .await;
    let row = row_of_json(&world.db, &line).await;
    let found = find_matches(&world.db, &row, None).await.unwrap();
    let best = found.first().expect("a suggestion");
    assert_eq!(best.kind, "bill");
    assert_eq!(best.entity_id, receipt);
    assert!(best.confidence >= 0.8, "{}", best.confidence);

    // And the candidates of the document, before it was booked, are the same line.
    let unbooked = document(
        &world.db,
        Some(&co.entity),
        "unbooked.pdf",
        78,
        "processed",
        Some(&ocr_result(
            "Bol.com",
            "NL02ABNA0123456789",
            "R-78",
            "2026-11-18",
            121.0,
        )),
    )
    .await;
    let (_, out) = answer_of(bank_candidates(world.caller(&co.entity), Path(unbooked)).await).await;
    assert_eq!(text(&out["data"][0], "id"), line);
}

/// The row of a bank line as the matcher reads it.
async fn row_of_json(db: &sqlx::PgPool, id: &str) -> Value {
    weldsuite_books_domain::tables::BANK_TRANSACTIONS
        .find_live(db, id)
        .await
        .unwrap()
        .unwrap()
}
