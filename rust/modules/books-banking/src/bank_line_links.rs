//! `GET /api/bank-transactions/:id/links` (Rust only, edition feature
//! `books-bank-links`; the TypeScript worker has no such route): what one
//! bank line is connected to, everything expanded, so a screen can show the
//! line's panel in one round trip: the payment and the documents it settled,
//! the journal entry, the deposit, the account it was categorized to, the
//! contact and the inbox documents (receipts, purchase invoices) behind it.
//!
//! The line is found as `GET /:id` finds it (the request's legal entity,
//! behind the record guard); every other row is read inside that entity.

use std::collections::HashMap;

use axum::extract::Path;
use axum::response::Response;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::http::{Caller, Refusal, ok, reply};
use weldsuite_db::orm;
use weldsuite_schema::tenant::{
    accounts, bank_deposits, bills, documents, invoices, journal_entries, parties,
    payment_allocations, payments, tax_rates,
};

use crate::bank_links::{contacts_of, json_error};
use crate::bank_transactions::find_line;
use crate::common::{field, text};

/// `row.key` as text, `None` for null, absent or empty.
fn filled<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    text(row, key).filter(|value| !value.is_empty())
}

/// `row` reduced to `keys` (a missing key is `null`).
fn pick(row: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .map(|key| ((*key).to_owned(), field(row, key)))
            .collect(),
    )
}

pub(crate) async fn links(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(txn) = find_line(&caller, &id).await? else {
                return Err(Refusal::not_found("Bank transaction", &id));
            };
            Ok(ok(build(&caller.db, &txn).await?))
        }
        .await,
        "Failed to fetch bank transaction links",
    )
}

/// One document a line settled, before it is looked up.
struct Share {
    invoice: bool,
    id: String,
    amount: String,
}

/// The payment that belongs to `txn`: the one it was reconciled to, else one
/// recorded against it.
async fn payment_of(db: &PgPool, txn: &Value, entity: &str) -> Result<Option<Value>, DbErr> {
    let line = text(txn, "id").unwrap_or_default();
    let mut any = Condition::any().add(payments::Column::BankTransactionId.eq(line));
    if let Some(payment) = filled(txn, "reconciledPaymentId") {
        any = any.add(payments::Column::Id.eq(payment));
    }
    let rows = payments::Entity::find()
        .filter(payments::Column::EntityId.eq(entity))
        .filter(payments::Column::DeletedAt.is_null())
        .filter(any)
        .order_by_desc(payments::Column::CreatedAt)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|model| serde_json::to_value(model).map_err(json_error))
        .collect::<Result<Vec<_>, _>>()?;
    let reconciled = filled(txn, "reconciledPaymentId");
    Ok(rows
        .iter()
        .find(|row| reconciled.is_some() && filled(row, "id") == reconciled)
        .or_else(|| rows.first())
        .cloned())
}

/// Remember `id` once.
fn add(shares: &mut Vec<Share>, invoice: bool, id: &str, amount: &str) {
    if !id.is_empty() && !shares.iter().any(|s| s.invoice == invoice && s.id == id) {
        shares.push(Share {
            invoice,
            id: id.to_owned(),
            amount: amount.to_owned(),
        });
    }
}

/// The documents the line settled: the payment's allocations, the payment's
/// own single document, and (when there is no payment, as for Moneybird and
/// Stripe lines) the document the line itself was reconciled to.
async fn shares_of(
    db: &PgPool,
    txn: &Value,
    payment: Option<&Value>,
    entity: &str,
) -> Result<Vec<Share>, DbErr> {
    let mut shares: Vec<Share> = Vec::new();

    if let Some(payment) = payment {
        let payment_id = text(payment, "id").unwrap_or_default();
        let allocations = payment_allocations::Entity::find()
            .filter(payment_allocations::Column::EntityId.eq(entity))
            .filter(payment_allocations::Column::PaymentId.eq(payment_id))
            .filter(payment_allocations::Column::DeletedAt.is_null())
            .order_by_asc(payment_allocations::Column::CreatedAt)
            .all(&orm(db))
            .await?
            .into_iter()
            .map(|model| serde_json::to_value(model).map_err(json_error))
            .collect::<Result<Vec<_>, _>>()?;
        for row in &allocations {
            let amount = text(row, "amount").unwrap_or("0");
            if let Some(invoice) = filled(row, "invoiceId") {
                add(&mut shares, true, invoice, amount);
            }
            if let Some(bill) = filled(row, "billId") {
                add(&mut shares, false, bill, amount);
            }
        }
        // The old single document of a payment recorded before allocations.
        let amount = text(payment, "amount").unwrap_or("0");
        if let Some(invoice) = filled(payment, "invoiceId") {
            add(&mut shares, true, invoice, amount);
        }
        if let Some(bill) = filled(payment, "billId") {
            add(&mut shares, false, bill, amount);
        }
    }
    if shares.is_empty() {
        let amount = text(txn, "amount").unwrap_or("0").trim_start_matches('-');
        if let Some(invoice) = filled(txn, "reconciledInvoiceId") {
            add(&mut shares, true, invoice, amount);
        }
        if let Some(bill) = filled(txn, "reconciledBillId") {
            add(&mut shares, false, bill, amount);
        }
    }
    Ok(shares)
}

/// The live documents (`invoices` or `bills`) of `entity` among `ids`, by id.
async fn documents_among(
    db: &PgPool,
    ids: &[&str],
    invoice: bool,
    entity: &str,
) -> Result<HashMap<String, Value>, DbErr> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<Value> = if invoice {
        invoices::Entity::find()
            .filter(invoices::Column::EntityId.eq(entity))
            .filter(invoices::Column::DeletedAt.is_null())
            .filter(invoices::Column::Id.is_in(ids.iter().copied()))
            .all(&orm(db))
            .await?
            .into_iter()
            .map(|model| serde_json::to_value(model).map_err(json_error))
            .collect::<Result<_, _>>()?
    } else {
        bills::Entity::find()
            .filter(bills::Column::EntityId.eq(entity))
            .filter(bills::Column::DeletedAt.is_null())
            .filter(bills::Column::Id.is_in(ids.iter().copied()))
            .all(&orm(db))
            .await?
            .into_iter()
            .map(|model| serde_json::to_value(model).map_err(json_error))
            .collect::<Result<_, _>>()?
    };
    Ok(rows
        .into_iter()
        .filter_map(|row| Some((text(&row, "id")?.to_owned(), row)))
        .collect())
}

/// The journal entry of the line: its own, the payment's, else the one
/// posted with the line as its source.
async fn journal_entry_of(
    db: &PgPool,
    txn: &Value,
    payment: Option<&Value>,
    entity: &str,
) -> Result<Option<Value>, DbErr> {
    let known = filled(txn, "journalEntryId")
        .or_else(|| payment.and_then(|payment| filled(payment, "journalEntryId")));
    let query = journal_entries::Entity::find()
        .filter(journal_entries::Column::EntityId.eq(entity))
        .filter(journal_entries::Column::DeletedAt.is_null());
    let row = match known {
        Some(entry) => {
            query
                .filter(journal_entries::Column::Id.eq(entry))
                .one(&orm(db))
                .await?
        }
        None => {
            query
                .filter(journal_entries::Column::SourceType.eq("bank_transaction"))
                .filter(journal_entries::Column::SourceId.eq(text(txn, "id").unwrap_or_default()))
                .order_by_desc(journal_entries::Column::CreatedAt)
                .one(&orm(db))
                .await?
        }
    };
    Ok(row
        .map(|model| serde_json::to_value(model).map_err(json_error))
        .transpose()?
        .map(|entry| {
            pick(
                &entry,
                &[
                    "id",
                    "entryNumber",
                    "date",
                    "description",
                    "sourceType",
                    "sourceId",
                ],
            )
        }))
}

/// The deposit the line is part of (by the line's `depositId`, else the
/// deposit that was matched to the line).
async fn deposit_of(db: &PgPool, txn: &Value, entity: &str) -> Result<Option<Value>, DbErr> {
    let mut any = Condition::any()
        .add(bank_deposits::Column::BankTransactionId.eq(text(txn, "id").unwrap_or_default()));
    if let Some(deposit) = filled(txn, "depositId") {
        any = any.add(bank_deposits::Column::Id.eq(deposit));
    }
    let rows = bank_deposits::Entity::find()
        .filter(bank_deposits::Column::EntityId.eq(entity))
        .filter(bank_deposits::Column::DeletedAt.is_null())
        .filter(any)
        .order_by_desc(bank_deposits::Column::CreatedAt)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|model| serde_json::to_value(model).map_err(json_error))
        .collect::<Result<Vec<_>, _>>()?;
    let own = filled(txn, "depositId");
    let row = rows
        .iter()
        .find(|row| own.is_some() && filled(row, "id") == own)
        .or_else(|| rows.first());
    Ok(row.map(|deposit| {
        json!({
            "id": field(deposit, "id"),
            "date": field(deposit, "date"),
            "amount": field(deposit, "amount"),
            "reference": field(deposit, "memo"),
        })
    }))
}

/// The account and tax rate a categorized line was booked to.
async fn category_of(db: &PgPool, txn: &Value, entity: &str) -> Result<Option<Value>, DbErr> {
    if text(txn, "reconciliationType") != Some("manual") {
        return Ok(None);
    }
    let Some(account_id) = filled(txn, "categoryAccountId") else {
        return Ok(None);
    };
    let account = accounts::Entity::find()
        .filter(accounts::Column::EntityId.eq(entity))
        .filter(accounts::Column::Id.eq(account_id))
        .one(&orm(db))
        .await?
        .map(|model| serde_json::to_value(model).map_err(json_error))
        .transpose()?;
    let rate = match filled(txn, "taxRateId") {
        Some(rate_id) => tax_rates::Entity::find()
            .filter(tax_rates::Column::EntityId.eq(entity))
            .filter(tax_rates::Column::Id.eq(rate_id))
            .one(&orm(db))
            .await?
            .map(|model| serde_json::to_value(model).map_err(json_error))
            .transpose()?,
        None => None,
    };
    Ok(Some(json!({
        "accountId": account_id,
        "accountCode": account.as_ref().map_or(Value::Null, |a| field(a, "code")),
        "accountName": account.as_ref().map_or(Value::Null, |a| field(a, "name")),
        "taxRateId": filled(txn, "taxRateId"),
        "taxRateName": rate.as_ref().map_or(Value::Null, |r| field(r, "name")),
    })))
}

/// The inbox documents behind the line: those linked to it, and those that
/// became or came with a bill it settled. Inbox documents may have no entity
/// at all, so those count as the request's.
async fn inbox_documents(
    db: &PgPool,
    txn: &Value,
    bills_settled: &HashMap<String, Value>,
    entity: &str,
) -> Result<Vec<Value>, DbErr> {
    let mut any = Condition::any().add(
        Condition::all()
            .add(documents::Column::LinkedEntityType.eq("bank_transaction"))
            .add(documents::Column::LinkedEntityId.eq(text(txn, "id").unwrap_or_default())),
    );
    let bill_ids: Vec<&str> = bills_settled.keys().map(String::as_str).collect();
    if !bill_ids.is_empty() {
        any = any.add(
            Condition::all()
                .add(documents::Column::LinkedEntityType.eq("bill"))
                .add(documents::Column::LinkedEntityId.is_in(bill_ids.iter().copied())),
        );
    }
    let sources: Vec<&str> = bills_settled
        .values()
        .filter_map(|bill| filled(bill, "sourceDocumentId"))
        .collect();
    if !sources.is_empty() {
        any = any.add(documents::Column::Id.is_in(sources));
    }
    let rows = documents::Entity::find()
        .filter(documents::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(documents::Column::EntityId.eq(entity))
                .add(documents::Column::EntityId.is_null()),
        )
        .filter(any)
        .order_by_asc(documents::Column::CreatedAt)
        .all(&orm(db))
        .await?;
    rows.into_iter()
        .map(|row| {
            serde_json::to_value(row)
                .map_err(json_error)
                .map(|document| {
                    json!({
                        "id": field(&document, "id"),
                        "fileName": field(&document, "fileName"),
                        "type": field(&document, "type"),
                        "status": field(&document, "status"),
                    })
                })
        })
        .collect()
}

/// The contact's `{ id, name }`: the line's own, else the payment's, else
/// the one every settled document shares.
async fn contact_of(
    db: &PgPool,
    txn: &Value,
    payment: Option<&Value>,
    allocations: &[Value],
) -> Result<Option<Value>, DbErr> {
    let id = filled(txn, "contactId")
        .or_else(|| payment.and_then(|payment| filled(payment, "contactId")))
        .or_else(|| {
            let first = allocations.first().and_then(|a| filled(a, "contactId"))?;
            allocations
                .iter()
                .all(|a| filled(a, "contactId") == Some(first))
                .then_some(first)
        });
    let Some(id) = id else {
        return Ok(None);
    };
    let name = parties::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?
        .map(|model| serde_json::to_value(model).map_err(json_error))
        .transpose()?
        .map_or(Value::Null, |party| field(&party, "displayName"));
    Ok(Some(json!({ "id": id, "name": name })))
}

/// How the line was dealt with.
fn processed_as(txn: &Value, payment: bool, deposit: bool, category: bool) -> &'static str {
    match text(txn, "status") {
        Some("excluded") => "excluded",
        Some("reconciled") if deposit => "deposit",
        Some("reconciled") if payment => "payment",
        Some("reconciled") if category => "category",
        _ => "unprocessed",
    }
}

/// The whole answer for one line.
pub(crate) async fn build(db: &PgPool, txn: &Value) -> Result<Value, DbErr> {
    let entity = text(txn, "entityId").unwrap_or_default();
    let payment = payment_of(db, txn, entity).await?;
    let shares = shares_of(db, txn, payment.as_ref(), entity).await?;
    let invoice_ids: Vec<&str> = shares
        .iter()
        .filter(|s| s.invoice)
        .map(|s| s.id.as_str())
        .collect();
    let bill_ids: Vec<&str> = shares
        .iter()
        .filter(|s| !s.invoice)
        .map(|s| s.id.as_str())
        .collect();
    let invoice_rows = documents_among(db, &invoice_ids, true, entity).await?;
    let bill_rows = documents_among(db, &bill_ids, false, entity).await?;
    let all: Vec<Value> = invoice_rows
        .values()
        .chain(bill_rows.values())
        .cloned()
        .collect();
    let names = contacts_of(db, &all).await?;
    let allocations: Vec<Value> = shares
        .iter()
        .filter_map(|share| {
            let row = if share.invoice {
                invoice_rows.get(&share.id)
            } else {
                bill_rows.get(&share.id)
            }?;
            let contact_id = filled(row, "contactId");
            let name = filled(row, "contactName").map(str::to_owned).or_else(|| {
                contact_id
                    .and_then(|id| names.get(id))
                    .and_then(|(name, _)| name.clone())
            });
            Some(json!({
                "documentType": if share.invoice { "invoice" } else { "bill" },
                "documentId": share.id,
                "number": field(row, if share.invoice { "invoiceNumber" } else { "billNumber" }),
                "contactId": field(row, "contactId"),
                "contactName": name,
                "amount": share.amount,
                "status": field(row, "status"),
            }))
        })
        .collect();
    let journal_entry = journal_entry_of(db, txn, payment.as_ref(), entity).await?;
    let deposit = deposit_of(db, txn, entity).await?;
    let category = category_of(db, txn, entity).await?;
    let contact = contact_of(db, txn, payment.as_ref(), &allocations).await?;
    let documents = inbox_documents(db, txn, &bill_rows, entity).await?;
    let processed = processed_as(
        txn,
        payment.is_some() || !allocations.is_empty(),
        deposit.is_some() && text(txn, "status") == Some("reconciled"),
        category.is_some(),
    );
    Ok(json!({
        "transaction": txn,
        "processedAs": processed,
        "payment": payment.as_ref().map(|payment| json!({
            "id": field(payment, "id"),
            "type": field(payment, "type"),
            "amount": field(payment, "amount"),
            "currency": field(payment, "currency"),
            "date": field(payment, "date"),
            "method": field(payment, "paymentMethod"),
            "reference": field(payment, "reference"),
            "journalEntryId": field(payment, "journalEntryId"),
        })),
        "allocations": allocations,
        "journalEntry": journal_entry,
        "deposit": deposit,
        "category": category,
        "contact": contact,
        "documents": documents,
    }))
}

/// Against the real tenant schema (`WELDSUITE_TEST_TENANT_URL`, built by
/// `scripts/rust-test-db.ts`); each test returns early without it. Rows
/// carry a fresh suffix, so runs share the database with other tests.
#[cfg(test)]
#[allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    reason = "test fixtures are written in SQL"
)]
mod db_tests {
    use serde_json::{Value, json};
    use sqlx::PgPool;

    use super::build;
    use crate::common::find_transaction;

    async fn tenant() -> Option<PgPool> {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return None;
        };
        Some(
            sqlx::postgres::PgPoolOptions::new()
                .max_connections(2)
                .connect(&url)
                .await
                .unwrap(),
        )
    }

    fn fresh(prefix: &str) -> String {
        weldsuite_kit::generate_id(prefix)
    }

    async fn exec(db: &PgPool, sql: &str, binds: &[&str]) {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()));
        for bind in binds {
            query = query.bind(*bind);
        }
        query.execute(db).await.unwrap();
    }

    async fn party(db: &PgPool, name: &str) -> String {
        let id = fresh("party_");
        exec(
            db,
            "insert into parties (id, kind, role, display_name) values ($1, 'company', 'customer', $2)",
            &[&id, name],
        )
        .await;
        id
    }

    async fn account(db: &PgPool, entity: &str, code: &str, name: &str) -> String {
        let id = fresh("acc_");
        exec(
            db,
            "insert into accounts (id, entity_id, code, name, type, normal_side) \
             values ($1, $2, $3, $4, 'expense', 'debit')",
            &[&id, entity, code, name],
        )
        .await;
        id
    }

    async fn invoice(db: &PgPool, entity: &str, contact: &str, number: &str) -> String {
        let id = fresh("inv_");
        exec(
            db,
            "insert into invoices (id, entity_id, contact_id, invoice_number, status, issue_date, due_date) \
             values ($1, $2, $3, $4, 'partial', now(), now())",
            &[&id, entity, contact, number],
        )
        .await;
        id
    }

    async fn line(db: &PgPool, entity: &str, amount: &str, extra: &str) -> Value {
        let id = fresh("btx_");
        let sql = format!(
            "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, status \
             {columns}) values ($1, $2, 'bank_x', now(), $3::numeric, {status} {values})",
            columns = if extra.is_empty() {
                ""
            } else {
                ", reconciliation_type, category_account_id, tax_rate_id, reconciled_payment_id"
            },
            status = if extra.is_empty() {
                "'unreconciled'"
            } else {
                "'reconciled'"
            },
            values = if extra.is_empty() {
                String::new()
            } else {
                format!(", {extra}")
            },
        );
        exec(db, &sql, &[&id, entity, amount]).await;
        find_transaction(db, &id).await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn an_unprocessed_line_links_to_nothing() {
        let Some(db) = tenant().await else { return };
        let entity = fresh("ent_");
        let txn = line(&db, &entity, "-12.50", "").await;
        let links = build(&db, &txn).await.unwrap();
        assert_eq!(links["processedAs"], "unprocessed");
        assert_eq!(links["transaction"]["id"], txn["id"]);
        for key in ["payment", "journalEntry", "deposit", "category", "contact"] {
            assert_eq!(links[key], Value::Null, "{key}");
        }
        assert_eq!(links["allocations"], json!([]));
        assert_eq!(links["documents"], json!([]));
    }

    #[tokio::test]
    async fn a_line_paid_to_two_invoices_lists_both_allocations() {
        let Some(db) = tenant().await else { return };
        let (entity, other) = (fresh("ent_"), fresh("ent_"));
        let contact = party(&db, "Acme BV").await;
        let first = invoice(&db, &entity, &contact, "INV-1").await;
        let second = invoice(&db, &entity, &contact, "INV-2").await;
        // An invoice of another entity must never be shown.
        let foreign = invoice(&db, &other, &contact, "INV-X").await;
        let entry = fresh("je_");
        exec(
            &db,
            "insert into journal_entries (id, entity_id, entry_number, date, status, description, source_type, source_id) \
             values ($1, $2, 'JE-9', now(), 'posted', 'Payment', 'payment', 'pay')",
            &[&entry, &entity],
        )
        .await;
        let payment = fresh("pay_");
        exec(
            &db,
            "insert into payments (id, entity_id, type, amount, currency, date, payment_method, reference, contact_id, journal_entry_id) \
             values ($1, $2, 'received', 150, 'EUR', now(), 'bank_transfer', 'REF-1', $3, $4)",
            &[&payment, &entity, &contact, &entry],
        )
        .await;
        for (invoice, amount) in [(&first, "100"), (&second, "50"), (&foreign, "5")] {
            let entity = if invoice == &foreign { &other } else { &entity };
            exec(
                &db,
                "insert into payment_allocations (id, entity_id, payment_id, invoice_id, amount) \
                 values ($1, $2, $3, $4, $5::numeric)",
                &[&fresh("pal_"), entity, &payment, invoice, amount],
            )
            .await;
        }
        let txn = line(
            &db,
            &entity,
            "150.00",
            &format!("'manual', null, null, '{payment}'"),
        )
        .await;
        let links = build(&db, &txn).await.unwrap();
        assert_eq!(links["processedAs"], "payment");
        assert_eq!(links["payment"]["id"], payment);
        assert_eq!(links["payment"]["type"], "received");
        assert_eq!(links["payment"]["method"], "bank_transfer");
        assert_eq!(links["payment"]["journalEntryId"], entry);
        assert_eq!(links["journalEntry"]["id"], entry);
        assert_eq!(links["journalEntry"]["entryNumber"], "JE-9");
        let allocations = links["allocations"].as_array().unwrap();
        assert_eq!(allocations.len(), 2);
        assert_eq!(allocations[0]["documentType"], "invoice");
        assert_eq!(allocations[0]["documentId"], first);
        assert_eq!(allocations[0]["number"], "INV-1");
        assert_eq!(allocations[0]["status"], "partial");
        assert_eq!(allocations[0]["contactId"], contact);
        assert_eq!(allocations[0]["contactName"], "Acme BV");
        assert_eq!(allocations[1]["documentId"], second);
        assert_eq!(
            links["contact"],
            json!({ "id": contact, "name": "Acme BV" })
        );
    }

    #[tokio::test]
    async fn a_categorized_line_names_its_account_and_tax_rate() {
        let Some(db) = tenant().await else { return };
        let entity = fresh("ent_");
        let account = account(&db, &entity, "4100", "Office costs").await;
        let rate = fresh("tax_");
        exec(
            &db,
            "insert into tax_rates (id, entity_id, jurisdiction_code, name, rate, type) \
             values ($1, $2, 'NL', 'NL 21%', 21, 'vat')",
            &[&rate, &entity],
        )
        .await;
        let txn = line(
            &db,
            &entity,
            "-24.20",
            &format!("'manual', '{account}', '{rate}', null"),
        )
        .await;
        let links = build(&db, &txn).await.unwrap();
        assert_eq!(links["processedAs"], "category");
        assert_eq!(
            links["category"],
            json!({
                "accountId": account,
                "accountCode": "4100",
                "accountName": "Office costs",
                "taxRateId": rate,
                "taxRateName": "NL 21%",
            })
        );
        assert_eq!(links["payment"], Value::Null);
        assert_eq!(links["allocations"], json!([]));
    }

    #[tokio::test]
    async fn a_bill_brings_its_inbox_document_and_a_linked_receipt() {
        let Some(db) = tenant().await else { return };
        let entity = fresh("ent_");
        let contact = party(&db, "Supplies NV").await;
        let document = fresh("doc_");
        let receipt = fresh("doc_");
        let bill = fresh("bill_");
        exec(
            &db,
            "insert into documents (id, file_name, file_key, type, status) \
             values ($1, 'bill.pdf', 'k1', 'purchase_invoice', 'linked')",
            &[&document],
        )
        .await;
        exec(
            &db,
            "insert into bills (id, entity_id, contact_id, bill_number, status, issue_date, due_date, source_document_id) \
             values ($1, $2, $3, 'B-7', 'approved', now(), now(), $4)",
            &[&bill, &entity, &contact, &document],
        )
        .await;
        // No payment: the line itself was reconciled to the bill (Moneybird).
        let mut txn = line(&db, &entity, "-80.00", "").await;
        exec(
            &db,
            "update bank_transactions set status = 'reconciled', reconciled_bill_id = $2 where id = $1",
            &[txn["id"].as_str().unwrap(), &bill],
        )
        .await;
        exec(
            &db,
            "insert into documents (id, file_name, file_key, type, status, linked_entity_type, linked_entity_id) \
             values ($1, 'receipt.jpg', 'k2', 'receipt', 'linked', 'bank_transaction', $2)",
            &[&receipt, txn["id"].as_str().unwrap()],
        )
        .await;
        txn = find_transaction(&db, txn["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        let links = build(&db, &txn).await.unwrap();
        assert_eq!(links["processedAs"], "payment");
        assert_eq!(links["allocations"][0]["documentType"], "bill");
        assert_eq!(links["allocations"][0]["number"], "B-7");
        assert_eq!(links["allocations"][0]["amount"], "80.00");
        let documents = links["documents"].as_array().unwrap();
        let ids: Vec<&str> = documents
            .iter()
            .map(|d| d["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&document.as_str()) && ids.contains(&receipt.as_str()));
        assert_eq!(links["contact"]["name"], "Supplies NV");
    }
}
