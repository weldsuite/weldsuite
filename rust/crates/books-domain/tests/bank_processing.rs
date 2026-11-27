//! Processing bank lines (Rust only, edition feature `books-bank-processing`)
//! on the real tenant schema (built from the journaled migrations by
//! `scripts/rust-test-db.ts`): a line split over two categories with VAT in
//! one entry, transfers between own accounts (the clearing account made on
//! first use, once), private payments per legal form, one undo for every kind
//! of processing, what the automatic matcher books and why, and unapplied
//! credit applied later.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.
//! Every row carries fresh ids, so runs share the database.

#![allow(
    clippy::disallowed_methods,
    clippy::too_many_lines,
    clippy::unwrap_used,
    reason = "test fixtures are written in SQL; each test is one scenario read top to bottom"
)]

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::bank_matching::{
    DocumentShare, auto_reconcile_batch, reconcile_to_documents,
};
use weldsuite_books_domain::bank_processing::{
    automatic_reason, book_transfer, counterpart_line, undo_line,
};
use weldsuite_books_domain::bank_split::{Split, SplitLine, book_split};
use weldsuite_books_domain::system_accounts::{
    DIRECTOR_CURRENT_ACCOUNT, PRIVATE, TRANSFERS_IN_TRANSIT, ensure_role_account,
};
use weldsuite_books_domain::tables::BANK_TRANSACTIONS;
use weldsuite_books_domain::unapplied_credit::{Target, apply_credit, credits_of_contact};
use weldsuite_db::master_pool;
use weldsuite_kit::generate_id;

#[allow(clippy::unused_async)] // awaited like the other fixtures
async fn pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some(master_pool(&url, 2).expect("tenant pool"))
}

async fn account(
    db: &PgPool,
    entity: &str,
    code: &str,
    name: &str,
    kind: &str,
    side: &str,
    role: Option<&str>,
) -> String {
    let id = generate_id("acc");
    sqlx::query(
        "insert into accounts (id, entity_id, code, name, type, normal_side, metadata) \
         values ($1, $2, $3, $4, $5, $6, case when $7::text is null then null else jsonb_build_object('systemRole', $7::text) end)",
    )
    .bind(&id)
    .bind(entity)
    .bind(code)
    .bind(name)
    .bind(kind)
    .bind(side)
    .bind(role)
    .execute(db)
    .await
    .expect("account");
    id
}

/// A Dutch entity of a legal form with debtors, creditors, VAT payable and a
/// bank account at `ledger_code` of `iban`: (entity, bank account).
async fn company(db: &PgPool, entity_type: &str, iban: &str) -> (String, String) {
    let entity = generate_id("ent");
    sqlx::query(
        r#"insert into entities (id, name, jurisdiction_code, base_currency, entity_type, is_active,
             tax_identifiers, bank_details, address)
           values ($1, 'Processing test', 'NL', 'EUR', $2, true,
             '{"vatNumber": "NL123456789B01", "registrationNumber": "12345678"}'::jsonb,
             '{}'::jsonb,
             '{"street": "Main 1", "city": "Amsterdam", "postalCode": "1011AA", "country": "NL"}'::jsonb)"#,
    )
    .bind(&entity)
    .bind(entity_type)
    .execute(db)
    .await
    .expect("entity");
    account(db, &entity, "1300", "Debtors", "asset", "debit", None).await;
    account(
        db,
        &entity,
        "1600",
        "Creditors",
        "liability",
        "credit",
        None,
    )
    .await;
    account(
        db,
        &entity,
        "1700",
        "VAT payable",
        "liability",
        "credit",
        Some("tax_payable"),
    )
    .await;
    let bank = bank_account(db, &entity, "1100", iban).await;
    (entity, bank)
}

async fn bank_account(db: &PgPool, entity: &str, ledger_code: &str, iban: &str) -> String {
    let ledger = account(db, entity, ledger_code, "Bank", "asset", "debit", None).await;
    let bank = generate_id("bac");
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, iban, currency, ledger_account_id) \
         values ($1, $2, 'Bank', $3, 'EUR', $4)",
    )
    .bind(&bank)
    .bind(entity)
    .bind(iban)
    .bind(&ledger)
    .execute(db)
    .await
    .expect("bank account");
    bank
}

async fn line(
    db: &PgPool,
    entity: &str,
    bank: &str,
    date: &str,
    amount: &str,
    description: &str,
    counterparty_iban: Option<&str>,
) -> Value {
    let id = generate_id("btx");
    sqlx::query(
        "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, description, \
           counterparty_name, counterparty_iban, status) \
         values ($1, $2, $3, $4::timestamp, $5::numeric, $6, 'COUNTERPARTY', $7, 'unreconciled')",
    )
    .bind(&id)
    .bind(entity)
    .bind(bank)
    .bind(date)
    .bind(amount)
    .bind(description)
    .bind(counterparty_iban)
    .execute(db)
    .await
    .expect("bank line");
    reload(db, &id).await
}

async fn reload(db: &PgPool, id: &str) -> Value {
    BANK_TRANSACTIONS
        .find_live(db, id)
        .await
        .expect("line")
        .expect("line exists")
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

/// The live lines of a journal entry: (account, debit, credit) as text.
async fn entry_lines(db: &PgPool, entry: &str) -> Vec<(String, String, String)> {
    sqlx::query_as(
        "select account_id, coalesce(debit, 0)::numeric(18,2)::text, coalesce(credit, 0)::numeric(18,2)::text \
         from journal_lines where journal_entry_id = $1 and deleted_at is null order by account_id, debit, credit",
    )
    .bind(entry)
    .fetch_all(db)
    .await
    .expect("entry lines")
}

async fn entry_status(db: &PgPool, entry: &str) -> String {
    sqlx::query_scalar("select status from journal_entries where id = $1")
        .bind(entry)
        .fetch_one(db)
        .await
        .expect("entry status")
}

async fn accounts_with_role(db: &PgPool, entity: &str, role: &str) -> Vec<(String, String)> {
    sqlx::query_as(
        "select id, code from accounts where entity_id = $1 and deleted_at is null \
           and metadata ->> 'systemRole' = $2",
    )
    .bind(entity)
    .bind(role)
    .fetch_all(db)
    .await
    .expect("accounts")
}

fn whole(account: &str, amount: f64) -> SplitLine {
    SplitLine {
        account_id: account.to_owned(),
        amount,
        ..SplitLine::default()
    }
}

#[tokio::test]
async fn a_split_books_one_balanced_entry_with_the_vat_of_each_part() {
    let Some(db) = pool().await else { return };
    let (entity, bank) = company(&db, "bv", "NL91ABNA0417164300").await;
    let input = account(
        &db,
        &entity,
        "1730",
        "VAT input",
        "asset",
        "debit",
        Some("tax_input"),
    )
    .await;
    let rent = account(&db, &entity, "4210", "Rent", "expense", "debit", None).await;
    let office = account(&db, &entity, "4300", "Office", "expense", "debit", None).await;
    let rate = generate_id("tax");
    sqlx::query(
        "insert into tax_rates (id, entity_id, jurisdiction_code, name, rate, type, ledger_account_id) \
         values ($1, $2, 'NL', 'VAT 21%', 21, 'purchase', $3)",
    )
    .bind(&rate)
    .bind(&entity)
    .bind(&input)
    .execute(&db)
    .await
    .expect("tax rate");

    // 181.50 out: 121.00 of rent with 21% VAT, and 60.50 of office costs with 21%.
    let txn = line(
        &db,
        &entity,
        &bank,
        "2026-11-20",
        "-181.50",
        "Rent and supplies",
        None,
    )
    .await;
    let parts = [
        SplitLine {
            tax_rate_id: Some(rate.clone()),
            description: Some("Rent".to_owned()),
            ..whole(&rent, 121.0)
        },
        SplitLine {
            tax_rate_id: Some(rate.clone()),
            ..whole(&office, 60.5)
        },
    ];
    let booked = book_split(
        &db,
        &txn,
        Split {
            lines: &parts,
            kind: "manual",
            user_id: Some("user_1"),
        },
    )
    .await
    .expect("split");

    let lines = entry_lines(&db, &booked.journal_entry_id).await;
    let debit: f64 = lines
        .iter()
        .map(|(_, d, _)| d.parse::<f64>().unwrap())
        .sum();
    let credit: f64 = lines
        .iter()
        .map(|(_, _, c)| c.parse::<f64>().unwrap())
        .sum();
    assert!(
        (debit - 181.5).abs() < 0.001 && (credit - 181.5).abs() < 0.001,
        "{lines:?}"
    );
    let on = |account: &str| {
        lines
            .iter()
            .filter(|(a, _, _)| a == account)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        on(&rent),
        vec![&(rent.clone(), "100.00".to_owned(), "0.00".to_owned())]
    );
    assert_eq!(
        on(&office),
        vec![&(office.clone(), "50.00".to_owned(), "0.00".to_owned())]
    );
    let ledger: String =
        sqlx::query_scalar("select ledger_account_id from bank_accounts where id = $1")
            .bind(&bank)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(
        on(&ledger),
        vec![&(ledger.clone(), "0.00".to_owned(), "181.50".to_owned())]
    );
    // Input VAT: 21.00 + 10.50, and one tax-ledger row per part.
    let vat: f64 = on(&input)
        .iter()
        .map(|(_, d, _)| d.parse::<f64>().unwrap())
        .sum();
    assert!((vat - 31.5).abs() < 0.001);
    let tax_rows: i64 =
        sqlx::query_scalar("select count(*) from tax_lines where journal_entry_id = $1")
            .bind(&booked.journal_entry_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(tax_rows, 2);

    let after = reload(&db, text(&txn, "id")).await;
    assert_eq!(text(&after, "status"), "reconciled");
    assert_eq!(text(&after, "reconciliationType"), "manual");
    assert_eq!(text(&after, "categoryAccountId"), rent);
    assert_eq!(text(&after, "journalEntryId"), booked.journal_entry_id);

    // Already processed.
    let again = book_split(
        &db,
        &after,
        Split {
            lines: &parts,
            kind: "manual",
            user_id: None,
        },
    )
    .await;
    assert!(
        again
            .unwrap_err()
            .to_string()
            .contains("already reconciled")
    );

    // The parts must add up to the line, to the cent.
    let other = line(&db, &entity, &bank, "2026-11-21", "-100.00", "Short", None).await;
    let short = [whole(&rent, 60.0), whole(&office, 39.99)];
    let error = book_split(
        &db,
        &other,
        Split {
            lines: &short,
            kind: "manual",
            user_id: None,
        },
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        error.contains("add up to 99.99 but the bank line is 100.00"),
        "{error}"
    );
    let untouched = reload(&db, text(&other, "id")).await;
    assert_eq!(text(&untouched, "status"), "unreconciled");
    // Nothing for an unknown account, a zero part or no part.
    for (parts, needle) in [
        (
            vec![whole("acc_missing", 100.0)],
            "Category account not found",
        ),
        (
            vec![whole(&rent, 100.0), whole(&office, 0.0)],
            "greater than zero",
        ),
        (vec![], "at least one category"),
    ] {
        let error = book_split(
            &db,
            &other,
            Split {
                lines: &parts,
                kind: "manual",
                user_id: None,
            },
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains(needle), "{error}");
    }

    // Undo takes the entry back.
    let undone = undo_line(&db, &after, Some("user_1".to_owned()))
        .await
        .expect("undo");
    assert_eq!((undone.what, undone.automatic), ("category", false));
    assert_eq!(
        entry_status(&db, &booked.journal_entry_id).await,
        "reversed"
    );
    let reset = reload(&db, text(&txn, "id")).await;
    assert_eq!(text(&reset, "status"), "unreconciled");
    assert!(reset["journalEntryId"].is_null() && reset["reconciliationType"].is_null());
}

#[tokio::test]
async fn a_transfer_books_both_halves_to_one_clearing_account_made_once() {
    let Some(db) = pool().await else { return };
    let (entity, current) = company(&db, "bv", "NL91ABNA0417164300").await;
    let savings = bank_account(&db, &entity, "1200", "NL86INGB0002445588").await;
    assert!(
        accounts_with_role(&db, &entity, TRANSFERS_IN_TRANSIT)
            .await
            .into_iter()
            .next()
            .is_none()
    );

    let out = line(
        &db,
        &entity,
        &current,
        "2026-11-20",
        "-500.00",
        "To savings",
        Some("NL86 INGB 0002 4455 88"),
    )
    .await;
    // The other half lands two days later; another 500 is out of the window.
    let arrives = line(
        &db,
        &entity,
        &savings,
        "2026-11-22",
        "500.00",
        "From current",
        None,
    )
    .await;
    let _far = line(
        &db,
        &entity,
        &savings,
        "2026-12-30",
        "500.00",
        "Much later",
        None,
    )
    .await;
    let _other_amount = line(
        &db,
        &entity,
        &savings,
        "2026-11-21",
        "499.00",
        "Other",
        None,
    )
    .await;
    assert_eq!(
        counterpart_line(&db, &out, &savings)
            .await
            .unwrap()
            .map(|l| text(&l, "id").to_owned()),
        Some(text(&arrives, "id").to_owned())
    );

    let done = book_transfer(&db, &out, None, "transfer", Some("user_1"))
        .await
        .expect("transfer");
    let counterpart = done
        .counterpart
        .clone()
        .expect("the other half is booked too");
    assert_eq!(counterpart.line_id, text(&arrives, "id"));
    assert_eq!(counterpart.bank_account_id, savings);

    // The clearing account was made once, with its role.
    let transit = accounts_with_role(&db, &entity, TRANSFERS_IN_TRANSIT).await;
    assert_eq!(transit.len(), 1);
    assert_eq!(transit[0].1, "1250");
    assert_eq!(done.transit_account_id, transit[0].0);

    for (id, kind) in [
        (text(&out, "id"), "transfer"),
        (text(&arrives, "id"), "transfer"),
    ] {
        let row = reload(&db, id).await;
        assert_eq!(text(&row, "status"), "reconciled");
        assert_eq!(text(&row, "reconciliationType"), kind);
        assert_eq!(text(&row, "categoryAccountId"), transit[0].0);
    }
    // The two entries cancel on the clearing account.
    let mut net = 0.0;
    for entry in [&done.journal_entry_id, &counterpart.journal_entry_id] {
        for (account, debit, credit) in entry_lines(&db, entry).await {
            if account == transit[0].0 {
                net += debit.parse::<f64>().unwrap() - credit.parse::<f64>().unwrap();
            }
        }
    }
    assert!(
        net.abs() < 0.001,
        "the clearing account nets to zero, not {net}"
    );

    // Another transfer reuses the account.
    let second = line(
        &db,
        &entity,
        &current,
        "2026-11-25",
        "-20.00",
        "Again",
        None,
    )
    .await;
    let again = book_transfer(&db, &second, Some(&savings), "transfer", None)
        .await
        .expect("again");
    assert_eq!(again.transit_account_id, transit[0].0);
    assert!(again.counterpart.is_none());
    assert_eq!(
        accounts_with_role(&db, &entity, TRANSFERS_IN_TRANSIT)
            .await
            .len(),
        1
    );

    // The other account must be one of this entity's other accounts.
    let third = line(&db, &entity, &current, "2026-11-26", "-5.00", "Wrong", None).await;
    for wrong in [current.as_str(), "bac_missing"] {
        let error = book_transfer(&db, &third, Some(wrong), "transfer", None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("other bank accounts"), "{error}");
    }
    // Another entity's account is not one of them.
    let (_, foreign) = company(&db, "bv", "NL00ABNA0000000001").await;
    assert!(
        book_transfer(&db, &third, Some(&foreign), "transfer", None)
            .await
            .is_err()
    );
    assert_eq!(
        text(&reload(&db, text(&third, "id")).await, "status"),
        "unreconciled"
    );

    // Undoing one half leaves the other.
    let undone = undo_line(&db, &reload(&db, text(&out, "id")).await, None)
        .await
        .unwrap();
    assert_eq!(undone.what, "transfer");
    assert_eq!(entry_status(&db, &done.journal_entry_id).await, "reversed");
    assert_eq!(
        text(&reload(&db, text(&arrives, "id")).await, "status"),
        "reconciled"
    );
}

#[tokio::test]
async fn private_goes_to_the_account_of_the_legal_form_made_on_first_use() {
    let Some(db) = pool().await else { return };

    // A BV: the current account with the director-shareholder.
    let (bv, bv_bank) = company(&db, "bv", "NL91ABNA0417164300").await;
    let first = ensure_role_account(&db, &bv, DIRECTOR_CURRENT_ACCOUNT)
        .await
        .unwrap();
    assert_eq!(text(&first, "code"), "1960");
    assert_eq!(text(&first, "name"), "Rekening-courant DGA");
    assert_eq!(text(&first, "type"), "liability");
    let again = ensure_role_account(&db, &bv, DIRECTOR_CURRENT_ACCOUNT)
        .await
        .unwrap();
    assert_eq!(text(&again, "id"), text(&first, "id"));
    assert_eq!(
        accounts_with_role(&db, &bv, DIRECTOR_CURRENT_ACCOUNT)
            .await
            .len(),
        1
    );

    // Two requests at once make it once.
    let (race, _) = company(&db, "bv", "NL12ABNA0000000002").await;
    let (a, b) = tokio::join!(
        ensure_role_account(&db, &race, PRIVATE),
        ensure_role_account(&db, &race, PRIVATE)
    );
    assert_eq!(text(&a.unwrap(), "id"), text(&b.unwrap(), "id"));
    assert_eq!(accounts_with_role(&db, &race, PRIVATE).await.len(), 1);

    // Money paid privately from the BV's account.
    let paid = line(&db, &bv, &bv_bank, "2026-11-20", "-80.00", "Lunch", None).await;
    let booked = book_split(
        &db,
        &paid,
        Split {
            lines: &[whole(text(&first, "id"), 80.0)],
            kind: "private",
            user_id: None,
        },
    )
    .await
    .unwrap();
    let row = reload(&db, text(&paid, "id")).await;
    assert_eq!(text(&row, "reconciliationType"), "private");
    assert_eq!(text(&row, "categoryAccountId"), text(&first, "id"));
    let undone = undo_line(&db, &row, None).await.unwrap();
    assert_eq!(undone.what, "private");
    assert_eq!(
        entry_status(&db, &booked.journal_entry_id).await,
        "reversed"
    );

    // A sole trader that already has "Privé" on 0540 (no role, made before
    // roles existed) uses it: nothing new is made.
    let (sole, _) = company(&db, "sole", "NL34ABNA0000000003").await;
    let prive = account(&db, &sole, "0540", "Privé", "equity", "debit", None).await;
    let found = ensure_role_account(&db, &sole, PRIVATE).await.unwrap();
    assert_eq!(text(&found, "id"), prive);
    assert!(
        accounts_with_role(&db, &sole, PRIVATE)
            .await
            .into_iter()
            .next()
            .is_none()
    );
    // Without one it is made on the template's code.
    let (vof, _) = company(&db, "vof", "NL56ABNA0000000004").await;
    let made = ensure_role_account(&db, &vof, PRIVATE).await.unwrap();
    assert_eq!(text(&made, "code"), "0540");
    assert_eq!(text(&made, "type"), "equity");
    // Another entity's accounts are another entity's.
    assert_ne!(text(&made, "id"), prive);
    assert_ne!(text(&made, "entityId"), sole);
}

#[tokio::test]
async fn one_undo_takes_back_a_payment_match_an_ignore_and_the_rest() {
    let Some(db) = pool().await else { return };
    let (entity, bank) = company(&db, "bv", "NL91ABNA0417164300").await;
    let party = generate_id("acn");
    sqlx::query("insert into parties (id, kind, display_name, role) values ($1, 'company', 'Acme', 'customer')")
        .bind(&party)
        .execute(&db)
        .await
        .unwrap();
    let invoice = generate_id("inv");
    sqlx::query(
        "insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name, \
           issue_date, due_date, currency, total, amount_paid, balance_due) \
         values ($1, $2, 'UN-1', 'invoice', 'sent', $3, 'Acme', '2026-11-01', '2026-12-01', 'EUR', 100, 0, 100)",
    )
    .bind(&invoice)
    .bind(&entity)
    .bind(&party)
    .execute(&db)
    .await
    .unwrap();

    // A payment match: undoing it voids the payment the match created.
    let paid = line(&db, &entity, &bank, "2026-11-20", "100.00", "UN-1", None).await;
    let matched = reconcile_to_documents(
        &db,
        None,
        &paid,
        &[DocumentShare {
            invoice: true,
            id: invoice.clone(),
            amount: 100.0,
        }],
        None,
        None,
    )
    .await
    .unwrap();
    let state = |id: String| {
        let db = db.clone();
        async move {
            sqlx::query_as::<_, (String, String)>(
                "select status, balance_due::text from invoices where id = $1",
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    assert_eq!(state(invoice.clone()).await.0, "paid");
    let undone = undo_line(&db, &reload(&db, text(&paid, "id")).await, None)
        .await
        .unwrap();
    assert_eq!(undone.what, "payment");
    assert_eq!(
        undone.payment_voided_id.as_deref(),
        Some(matched.id.as_str())
    );
    let (status, due) = state(invoice.clone()).await;
    assert_eq!((status.as_str(), due.as_str()), ("finalized", "100.00"));
    assert_eq!(
        text(&reload(&db, text(&paid, "id")).await, "status"),
        "unreconciled"
    );

    // An ignored line goes back to unprocessed; nothing was posted.
    let ignored = line(
        &db,
        &entity,
        &bank,
        "2026-11-21",
        "-3.00",
        "Ignore me",
        None,
    )
    .await;
    sqlx::query("update bank_transactions set status = 'excluded' where id = $1")
        .bind(text(&ignored, "id"))
        .execute(&db)
        .await
        .unwrap();
    let undone = undo_line(&db, &reload(&db, text(&ignored, "id")).await, None)
        .await
        .unwrap();
    assert_eq!(undone.what, "ignore");
    assert_eq!(
        text(&reload(&db, text(&ignored, "id")).await, "status"),
        "unreconciled"
    );

    // A line nothing was done to has nothing to undo.
    let untouched = reload(&db, text(&ignored, "id")).await;
    assert!(
        undo_line(&db, &untouched, None)
            .await
            .unwrap_err()
            .to_string()
            .contains("not been processed")
    );
}

#[tokio::test]
async fn the_matcher_books_what_is_certain_and_says_why() {
    let Some(db) = pool().await else { return };
    let (entity, current) = company(&db, "bv", "NL91ABNA0417164300").await;
    let _savings = bank_account(&db, &entity, "1200", "NL12RABO0123456789").await;
    let rent = account(&db, &entity, "4210", "Rent", "expense", "debit", None).await;

    // A transfer to the entity's own IBAN.
    let transfer = line(
        &db,
        &entity,
        &current,
        "2026-11-20",
        "-300.00",
        "Savings",
        Some("NL12 RABO 0123 4567 89"),
    )
    .await;
    // A line a rule books: out, on this account, saying "huur".
    let huur = line(
        &db,
        &entity,
        &current,
        "2026-11-22",
        "-1200.00",
        "Huur kantoor",
        None,
    )
    .await;
    // The same text coming in is not the rule's (it asks for money out).
    let refund = line(
        &db,
        &entity,
        &current,
        "2026-11-22",
        "75.00",
        "Huur terug",
        None,
    )
    .await;
    let rule = generate_id("rr");
    sqlx::query(
        "insert into reconciliation_rules (id, entity_id, name, priority, match_mode, conditions, actions, is_active, match_count) \
         values ($1, $2, 'Rent', 10, 'all', $3, $4, true, 0)",
    )
    .bind(&rule)
    .bind(&entity)
    .bind(json!([
        { "field": "description", "operator": "contains", "value": "huur" },
        { "field": "direction", "operator": "equals", "value": "out" },
        { "field": "bankAccountId", "operator": "equals", "value": current },
    ]))
    .bind(json!({ "categoryAccountId": rent }))
    .execute(&db)
    .await
    .unwrap();

    let (count, _results) = auto_reconcile_batch(&db, None, &current, Some("user_1"))
        .await
        .unwrap();
    assert_eq!(count, 2, "the transfer and the rent");

    let transfer = reload(&db, text(&transfer, "id")).await;
    assert_eq!(text(&transfer, "status"), "reconciled");
    assert_eq!(text(&transfer, "reconciliationType"), "auto");
    let transit = accounts_with_role(&db, &entity, TRANSFERS_IN_TRANSIT).await;
    assert_eq!(text(&transfer, "categoryAccountId"), transit[0].0);
    let reason = automatic_reason(&db, &transfer).await.unwrap().unwrap();
    assert_eq!(reason["reason"], json!("own_account_transfer"));

    let huur = reload(&db, text(&huur, "id")).await;
    assert_eq!(text(&huur, "reconciliationType"), "auto");
    assert_eq!(text(&huur, "categoryAccountId"), rent);
    let reason = automatic_reason(&db, &huur).await.unwrap().unwrap();
    assert_eq!(reason["reason"], json!("rule"));
    assert_eq!(reason["ruleId"], json!(rule));
    assert_eq!(reason["ruleName"], json!("Rent"));
    assert_eq!(
        text(&reload(&db, text(&refund, "id")).await, "status"),
        "unreconciled"
    );

    // A line booked by hand has no automatic reason.
    let manual = line(
        &db,
        &entity,
        &current,
        "2026-11-23",
        "-10.00",
        "By hand",
        None,
    )
    .await;
    book_split(
        &db,
        &manual,
        Split {
            lines: &[whole(&rent, 10.0)],
            kind: "manual",
            user_id: None,
        },
    )
    .await
    .unwrap();
    assert!(
        automatic_reason(&db, &reload(&db, text(&manual, "id")).await)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_vat_payment_to_the_tax_authority_is_booked_only_when_it_names_a_return() {
    let Some(db) = pool().await else { return };
    let (entity, bank) = company(&db, "bv", "NL91ABNA0417164300").await;
    let iban = "NL86 INGB 0002 4455 88";
    let named = line(
        &db,
        &entity,
        &bank,
        "2026-11-20",
        "-1000.00",
        "Betaling BTW aangifte 2026 Q3",
        Some(iban),
    )
    .await;
    let other_tax = line(
        &db,
        &entity,
        &bank,
        "2026-11-21",
        "-400.00",
        "Loonheffing oktober",
        Some(iban),
    )
    .await;
    let incoming = line(
        &db,
        &entity,
        &bank,
        "2026-11-22",
        "250.00",
        "Teruggaaf btw",
        Some(iban),
    )
    .await;
    let someone_else = line(
        &db,
        &entity,
        &bank,
        "2026-11-23",
        "-90.00",
        "BTW aangifte",
        Some("NL91ABNA0417164300"),
    )
    .await;

    let (count, _) = auto_reconcile_batch(&db, None, &bank, None).await.unwrap();
    assert_eq!(count, 1);
    let payable = accounts_with_role(&db, &entity, "tax_payable").await;
    let booked = reload(&db, text(&named, "id")).await;
    assert_eq!(text(&booked, "reconciliationType"), "auto");
    assert_eq!(text(&booked, "categoryAccountId"), payable[0].0);
    assert_eq!(
        automatic_reason(&db, &booked).await.unwrap().unwrap()["reason"],
        json!("tax_authority")
    );
    // Anything less certain stays to process.
    for unsure in [&other_tax, &incoming, &someone_else] {
        assert_eq!(
            text(&reload(&db, text(unsure, "id")).await, "status"),
            "unreconciled"
        );
    }
}

#[tokio::test]
async fn credit_left_on_a_contact_is_applied_to_an_open_document_later() {
    let Some(db) = pool().await else { return };
    let (entity, bank) = company(&db, "bv", "NL91ABNA0417164300").await;
    let party = |name: &'static str| {
        let db = db.clone();
        async move {
            let id = generate_id("acn");
            sqlx::query("insert into parties (id, kind, display_name, role) values ($1, 'company', $2, 'customer')")
                .bind(&id)
                .bind(name)
                .execute(&db)
                .await
                .unwrap();
            id
        }
    };
    let acme = party("Acme").await;
    let beta = party("Beta").await;
    let invoice = |number: &'static str, contact: String, total: i32| {
        let (db, entity) = (db.clone(), entity.clone());
        async move {
            let id = generate_id("inv");
            sqlx::query(
                "insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name, \
                   issue_date, due_date, currency, total, amount_paid, balance_due) \
                 values ($1, $2, $3, 'invoice', 'sent', $4, 'X', '2026-11-01', '2026-12-01', 'EUR', $5, 0, $5)",
            )
            .bind(&id)
            .bind(&entity)
            .bind(number)
            .bind(contact)
            .bind(total)
            .execute(&db)
            .await
            .unwrap();
            id
        }
    };
    let first = invoice("AC-1", acme.clone(), 100).await;
    let second = invoice("AC-2", acme.clone(), 80).await;
    let foreign = invoice("BE-1", beta.clone(), 80).await;
    let balance = |id: String| {
        let db = db.clone();
        async move {
            sqlx::query_as::<_, (String, String, String)>(
                "select status, balance_due::text, amount_paid::text from invoices where id = $1",
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };

    // Acme pays 150 against a 100 invoice: 50 stays on the contact.
    let paid = line(&db, &entity, &bank, "2026-11-20", "150.00", "AC-1", None).await;
    let matched = reconcile_to_documents(
        &db,
        None,
        &paid,
        &[DocumentShare {
            invoice: true,
            id: first.clone(),
            amount: 100.0,
        }],
        None,
        None,
    )
    .await
    .unwrap();
    let credits = credits_of_contact(&db, &entity, &acme).await.unwrap();
    assert_eq!(credits.len(), 1);
    assert_eq!(credits[0]["paymentId"], json!(matched.id));
    assert_eq!(credits[0]["unallocatedAmount"], json!("50.00"));
    assert!(
        credits_of_contact(&db, &entity, &beta)
            .await
            .unwrap()
            .into_iter()
            .next()
            .is_none()
    );

    // Part of it to the second invoice: balance and status follow, no entry is needed.
    let entries_before: i64 =
        sqlx::query_scalar("select count(*) from journal_entries where entity_id = $1")
            .bind(&entity)
            .fetch_one(&db)
            .await
            .unwrap();
    let applied = apply_credit(&db, &matched.id, &Target::Invoice(second.clone()), 30.0)
        .await
        .unwrap();
    assert!((applied.remaining - 20.0).abs() < 0.001);
    let (status, due, paid_so_far) = balance(second.clone()).await;
    assert_eq!(
        (status.as_str(), due.as_str(), paid_so_far.as_str()),
        ("partial", "50.00", "30.00")
    );
    let entries_after: i64 =
        sqlx::query_scalar("select count(*) from journal_entries where entity_id = $1")
            .bind(&entity)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(entries_before, entries_after);
    let credits = credits_of_contact(&db, &entity, &acme).await.unwrap();
    assert_eq!(credits[0]["unallocatedAmount"], json!("20.00"));

    // More than is left, more than is due, another contact's invoice, a bill, nothing.
    for (target, amount, needle) in [
        (Target::Invoice(second.clone()), 25.0, "unapplied credit"),
        (Target::Invoice(foreign.clone()), 5.0, "same contact"),
        (Target::Bill("bill_x".to_owned()), 5.0, "settles an invoice"),
        (Target::Invoice(second.clone()), 0.0, "greater than zero"),
        (Target::Invoice("inv_missing".to_owned()), 5.0, "not found"),
    ] {
        let error = apply_credit(&db, &matched.id, &target, amount)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(needle), "{error}");
    }
    // The first invoice is paid: nothing more to take.
    let error = apply_credit(&db, &matched.id, &Target::Invoice(first.clone()), 5.0)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("not open"), "{error}");
    // The rest, to the end of the credit.
    let applied = apply_credit(&db, &matched.id, &Target::Invoice(second.clone()), 20.0)
        .await
        .unwrap();
    assert!(applied.remaining.abs() < 0.001);
    assert!(
        credits_of_contact(&db, &entity, &acme)
            .await
            .unwrap()
            .into_iter()
            .next()
            .is_none()
    );

    // Undoing the line voids the payment and reopens both invoices.
    let undone = undo_line(&db, &reload(&db, text(&paid, "id")).await, None)
        .await
        .unwrap();
    assert_eq!(undone.what, "payment");
    let (status, due, _) = balance(second.clone()).await;
    assert_eq!((status.as_str(), due.as_str()), ("finalized", "80.00"));
    let (status, due, _) = balance(first.clone()).await;
    assert_eq!((status.as_str(), due.as_str()), ("finalized", "100.00"));
}
