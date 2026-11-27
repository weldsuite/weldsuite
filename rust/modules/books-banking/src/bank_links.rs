//! Matching bank lines and documents either way round, as in Moneybird
//! (Rust only, edition feature `books-bank-links`; the TypeScript worker has
//! no such routes, so Global's platform hides them):
//!
//! - `GET /api/bank-transactions/:id/open-documents?search=`: every open
//!   document an unmatched line could settle (money in: invoices; money out:
//!   bills and credit notes to refund), best fit first, searchable by
//!   number, contact and reference.
//! - `POST /api/bank-transactions/:id/match-documents`: tie the line to one
//!   or more of them as one payment, with any gap booked to an account
//!   (bank costs, a payment discount, rounding) or left on the contact.
//! - `GET /api/bank-transactions/for-document?invoiceId=|billId=&search=`:
//!   the other way round, the unmatched lines that could have paid a
//!   document.

use std::cmp::Ordering;
use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::bank_matching::{
    DifferenceAccount, DocumentShare, reconcile_to_documents, score_line_for_document,
};
use weldsuite_books_domain::differences;
use weldsuite_books_domain::entity_context::{records_in_entity, resolve_entity_base_currency};
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, ok, reply, validate};
use weldsuite_books_domain::js::{parse_float, round_money, to_fixed};
use weldsuite_books_domain::jurisdictions::js_trim;
use weldsuite_catalogs::entity_events::{
    BANK_TRANSACTION_PROCESSED, BANK_TRANSACTION_UPDATED, BILL_UPDATED, INVOICE_UPDATED,
    PAYMENT_CREATED,
};
use weldsuite_db::orm;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_legal_entities::EntityTable;
use weldsuite_schema::tenant::{bank_accounts, bank_transactions, bills, invoices, parties};

use crate::bank_transactions::{find_line, line_event};
use crate::common::{changes, field, posting_refusal, text};

/// How many documents or lines a list answers with.
const LIST_LIMIT: usize = 50;
/// How many rows of each kind are scored before the best are kept.
const SCAN_LIMIT: u64 = 500;

/// Invoice statuses that still take money.
const OPEN_INVOICE: [&str; 4] = ["sent", "finalized", "partial", "overdue"];
/// Bill statuses that can be paid.
const OPEN_BILL: [&str; 3] = ["approved", "partial", "overdue"];

/// A row that would not serialize, as a database error.
#[allow(clippy::needless_pass_by_value)] // the shape `map_err` hands over
pub(crate) fn json_error(error: serde_json::Error) -> DbErr {
    DbErr::Json(error.to_string())
}

/// The trimmed `search` of the query string, when there is one.
fn search_term(caller: &Caller) -> Option<String> {
    caller
        .query()
        .present("search")
        .map(|s| js_trim(s).to_owned())
        .filter(|s| !s.is_empty())
}

/// `%term%`, with the `like` wildcards in the term taken literally.
fn like_pattern(term: &str) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// The contacts (`id → (name, iban)`) of `rows`.
pub(crate) async fn contacts_of(
    db: &PgPool,
    rows: &[Value],
) -> Result<HashMap<String, (Option<String>, Option<String>)>, DbErr> {
    let mut ids: Vec<String> = Vec::new();
    for row in rows {
        if let Some(id) = text(row, "contactId").filter(|id| !id.is_empty())
            && !ids.iter().any(|known| known == id)
        {
            ids.push(id.to_owned());
        }
    }
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let found: Vec<(String, Option<String>, Option<String>)> = parties::Entity::find()
        .select_only()
        .columns([
            parties::Column::Id,
            parties::Column::DisplayName,
            parties::Column::Iban,
        ])
        .filter(parties::Column::Id.is_in(ids))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(found
        .into_iter()
        .map(|(id, name, iban)| (id, (name, iban)))
        .collect())
}

/// The contacts whose name holds `pattern`, to search documents by.
async fn contacts_named(db: &PgPool, pattern: &str) -> Result<Vec<String>, DbErr> {
    parties::Entity::find()
        .select_only()
        .column(parties::Column::Id)
        .filter(parties::Column::DisplayName.ilike(pattern))
        .filter(parties::Column::DeletedAt.is_null())
        .limit(200)
        .into_tuple()
        .all(&orm(db))
        .await
}

/// Highest confidence first; equal ones by `key` (ascending, or descending
/// with `newest_first`).
fn by_confidence(a: &(f64, Value), b: &(f64, Value), key: &str, newest_first: bool) -> Ordering {
    b.0.partial_cmp(&a.0)
        .unwrap_or(Ordering::Equal)
        .then_with(|| {
            let (x, y) = (text(&a.1, key).unwrap_or(""), text(&b.1, key).unwrap_or(""));
            if newest_first { y.cmp(x) } else { x.cmp(y) }
        })
}

// ── GET /:id/open-documents ─────────────────────────────────────────────────

/// The kind a document answers as: `invoice`, `credit_note` or `bill`.
fn document_kind(row: &Value, invoice: bool) -> &'static str {
    if !invoice {
        "bill"
    } else if text(row, "type") == Some("credit_note") {
        "credit_note"
    } else {
        "invoice"
    }
}

/// A document as the matching lists show it.
fn document_view(
    row: &Value,
    invoice: bool,
    contact_name: Option<&str>,
    confidence: f64,
    reasons: &[String],
) -> Value {
    json!({
        "type": document_kind(row, invoice),
        "id": field(row, "id"),
        "number": field(row, if invoice { "invoiceNumber" } else { "billNumber" }),
        "contactId": field(row, "contactId"),
        "contactName": text(row, "contactName").filter(|n| !n.is_empty()).or(contact_name),
        "issueDate": field(row, "issueDate"),
        "dueDate": field(row, "dueDate"),
        "currency": field(row, "currency"),
        "total": text(row, "total").unwrap_or("0"),
        "openAmount": text(row, "balanceDue").unwrap_or("0"),
        "status": field(row, "status"),
        "confidence": weldsuite_books_domain::js::number_value(confidence),
        "reasons": reasons,
    })
}

/// The open invoices (`credit_notes`: the credit notes) of an entity that
/// pass the search.
async fn open_invoices(
    db: &PgPool,
    entity_id: &str,
    credit_notes: bool,
    search: Option<(&str, &[String])>,
) -> Result<Vec<Value>, DbErr> {
    use invoices::Column;
    use sea_orm::ExprTrait as _;
    let kind = if credit_notes {
        Column::Type.eq("credit_note")
    } else {
        Column::Type.ne("credit_note")
    };
    let mut query = invoices::Entity::find()
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Status.is_in(OPEN_INVOICE))
        .filter(kind)
        .filter(
            Expr::col(Column::BalanceDue)
                .cast_as("numeric")
                .gt(Expr::val(0)),
        );
    if let Some((pattern, contacts)) = search {
        let mut any = Condition::any()
            .add(Column::InvoiceNumber.ilike(pattern))
            .add(Column::ContactName.ilike(pattern))
            .add(Column::Reference.ilike(pattern));
        if !contacts.is_empty() {
            any = any.add(Column::ContactId.is_in(contacts.iter().map(String::as_str)));
        }
        query = query.filter(any);
    }
    query
        .order_by_asc(Column::DueDate)
        .limit(SCAN_LIMIT)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|model| serde_json::to_value(model).map_err(json_error))
        .collect()
}

/// The open bills of an entity that pass the search (supplier credit notes
/// are not paid out, so they stay out).
async fn open_bills(
    db: &PgPool,
    entity_id: &str,
    search: Option<(&str, &[String])>,
) -> Result<Vec<Value>, DbErr> {
    use bills::Column;
    use sea_orm::ExprTrait as _;
    let mut query = bills::Entity::find()
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Status.is_in(OPEN_BILL))
        .filter(Column::Type.ne("credit_note"))
        .filter(
            Expr::col(Column::BalanceDue)
                .cast_as("numeric")
                .gt(Expr::val(0)),
        );
    if let Some((pattern, contacts)) = search {
        let mut any = Condition::any()
            .add(Column::BillNumber.ilike(pattern))
            .add(Column::ContactName.ilike(pattern))
            .add(Column::ExternalReference.ilike(pattern))
            .add(Column::Reference.ilike(pattern));
        if !contacts.is_empty() {
            any = any.add(Column::ContactId.is_in(contacts.iter().map(String::as_str)));
        }
        query = query.filter(any);
    }
    query
        .order_by_asc(Column::DueDate)
        .limit(SCAN_LIMIT)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|model| serde_json::to_value(model).map_err(json_error))
        .collect()
}

pub(crate) async fn open_documents(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        list_open_documents(&caller, &id).await,
        "Failed to fetch open documents",
    )
}

async fn list_open_documents(caller: &Caller, id: &str) -> Reply {
    let Some(txn) = find_line(caller, id).await? else {
        return Err(Refusal::not_found("Transaction", id));
    };
    let db = &caller.db;
    let entity_id = text(&txn, "entityId").unwrap_or_default().to_owned();
    let money_in = parse_float(text(&txn, "amount").unwrap_or("0")) > 0.0;
    let search = search_term(caller).map(|term| like_pattern(&term));
    let contacts = match &search {
        Some(pattern) => contacts_named(db, pattern).await?,
        None => Vec::new(),
    };
    let filter = search
        .as_deref()
        .map(|pattern| (pattern, contacts.as_slice()));
    // (row, is an invoice)
    let mut rows: Vec<(Value, bool)> = Vec::new();
    if money_in {
        rows.extend(
            open_invoices(db, &entity_id, false, filter)
                .await?
                .into_iter()
                .map(|r| (r, true)),
        );
    } else {
        rows.extend(
            open_bills(db, &entity_id, filter)
                .await?
                .into_iter()
                .map(|r| (r, false)),
        );
        rows.extend(
            open_invoices(db, &entity_id, true, filter)
                .await?
                .into_iter()
                .map(|r| (r, true)),
        );
    }
    let all: Vec<Value> = rows.iter().map(|(row, _)| row.clone()).collect();
    let names = contacts_of(db, &all).await?;
    let mut scored: Vec<(f64, Value)> = rows
        .into_iter()
        .map(|(row, invoice)| {
            let contact = text(&row, "contactId").and_then(|c| names.get(c));
            let (confidence, reasons) = score_line_for_document(
                &txn,
                &row,
                invoice,
                contact.map(|(name, iban)| (name.as_deref().unwrap_or(""), iban.as_deref())),
            );
            let view = document_view(
                &row,
                invoice,
                contact.and_then(|(name, _)| name.as_deref()),
                confidence,
                &reasons,
            );
            (confidence, view)
        })
        .collect();
    scored.sort_by(|a, b| by_confidence(a, b, "dueDate", false));
    Ok(ok(Value::Array(
        scored
            .into_iter()
            .take(LIST_LIMIT)
            .map(|(_, view)| view)
            .collect(),
    )))
}

// ── POST /:id/match-documents ───────────────────────────────────────────────

/// The body: `{ documents: [{ type, id, amount }], differenceAccountId?,
/// differenceDescription? }`.
pub(crate) struct MatchBody {
    pub(crate) documents: Vec<(String, String, String)>,
    pub(crate) difference_account_id: Option<String>,
    pub(crate) difference_description: Option<String>,
}

fn read_match(issues: &mut Issues, body: &Map<String, Value>) -> Option<MatchBody> {
    let documents = issues.list(
        body,
        "documents",
        Presence::Required,
        Some(1),
        Some(100),
        |issues, item| {
            let fields = issues.object(item)?;
            let kind = issues.choice(fields, "type", Presence::Required, &["invoice", "bill"]);
            let id = issues.text(fields, "id", Presence::Required, Some(1), Some(30));
            let amount = issues.text(fields, "amount", Presence::Required, Some(1), None);
            Some((
                kind.into_option()?,
                id.into_option()?,
                amount.into_option()?,
            ))
        },
    );
    let account = issues.text(
        body,
        "differenceAccountId",
        Presence::Optional,
        None,
        Some(30),
    );
    let description = issues.text(
        body,
        "differenceDescription",
        Presence::Optional,
        None,
        Some(255),
    );
    Some(MatchBody {
        documents: documents.into_option()?,
        difference_account_id: account.into_option().filter(|a| !a.is_empty()),
        difference_description: description.into_option().filter(|d| !d.is_empty()),
    })
}

pub(crate) async fn match_documents(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_match) {
        Ok(Some(data)) => data,
        Ok(None) => {
            return Refusal::bad_request("documents is required")
                .respond("Failed to match the bank line");
        }
        Err(refusal) => return refusal.respond("Failed to match the bank line"),
    };
    reply(
        match_line(&caller, &state, &id, data).await,
        "Failed to match the bank line",
    )
}

#[allow(clippy::too_many_lines)] // check, match, audit, announce
pub(crate) async fn match_line(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    data: MatchBody,
) -> Reply {
    let mut shares = Vec::with_capacity(data.documents.len());
    for (kind, document_id, amount) in &data.documents {
        let amount = parse_float(amount);
        if !amount.is_finite() || round_money(amount) <= 0.0 {
            return Err(Refusal::bad_request(
                "Every amount must be greater than zero",
            ));
        }
        if shares.iter().any(|s: &DocumentShare| &s.id == document_id) {
            return Err(Refusal::bad_request(
                "Each document can only be picked once",
            ));
        }
        shares.push(DocumentShare {
            invoice: kind == "invoice",
            id: document_id.clone(),
            amount,
        });
    }
    // Every document must be one the request may touch.
    for (invoice, table, label) in [(true, "invoices", "Invoice"), (false, "bills", "Bill")] {
        let ids: Vec<&str> = shares
            .iter()
            .filter(|s| s.invoice == invoice)
            .map(|s| s.id.as_str())
            .collect();
        if !ids.is_empty() && !records_in_entity(caller, &EntityTable::new(table), &ids).await? {
            return Err(Refusal::not_found(label, ids[0]));
        }
    }
    let Some(txn) = find_line(caller, id).await? else {
        return Err(Refusal::not_found("Transaction", id));
    };
    let http = caller.http(state);
    let mut difference = data
        .difference_account_id
        .map(|account_id| DifferenceAccount {
            account_id,
            description: data.difference_description,
        });
    // No account named: a gap of a few cents goes to the rounding account;
    // never more than the entity's cap, however large the gap.
    let mut rounded = Value::Null;
    if difference.is_none()
        && let Some((account_id, gap)) = small_gap(&caller.db, &txn, &shares).await?
    {
        rounded = json!({ "accountId": account_id, "amount": to_fixed(gap, 2) });
        difference = Some(DifferenceAccount {
            account_id,
            description: Some("Rounding difference".to_owned()),
        });
    }
    let matched = reconcile_to_documents(
        &caller.db,
        http.as_ref(),
        &txn,
        &shares,
        difference,
        caller.user().map(str::to_owned),
    )
    .await
    .map_err(posting_refusal)?;

    let single = (shares.len() == 1).then(|| &shares[0]);
    let mut audit = vec![
        ("status", field(&txn, "status"), json!("reconciled")),
        (
            "reconciliationType",
            field(&txn, "reconciliationType"),
            json!("manual"),
        ),
        (
            "reconciledPaymentId",
            field(&txn, "reconciledPaymentId"),
            json!(matched.id),
        ),
    ];
    if let Some(share) = single {
        audit.push(if share.invoice {
            (
                "reconciledInvoiceId",
                field(&txn, "reconciledInvoiceId"),
                json!(share.id),
            )
        } else {
            (
                "reconciledBillId",
                field(&txn, "reconciledBillId"),
                json!(share.id),
            )
        });
    }
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: text(&txn, "entityId"),
            entity_type: "bank_transaction",
            entity_id: id,
            action: "reconciled",
            changes: Some(changes(audit)),
        },
    )
    .await;
    caller.publish(
        state,
        BANK_TRANSACTION_UPDATED,
        id,
        line_event(&txn, "reconciled"),
    );
    let mut processed = line_event(&txn, "reconciled");
    processed["how"] = json!("link");
    caller.publish(state, BANK_TRANSACTION_PROCESSED, id, processed);
    let amount = parse_float(text(&txn, "amount").unwrap_or("0")).abs();
    let mut payment = Map::new();
    payment.insert("id".to_owned(), json!(matched.id));
    payment.insert("amount".to_owned(), json!(to_fixed(amount, 2)));
    payment.insert("bankTransactionId".to_owned(), json!(id));
    if let Some(share) = single {
        payment.insert(
            if share.invoice { "invoiceId" } else { "billId" }.to_owned(),
            json!(share.id),
        );
    }
    payment.insert(
        "allocations".to_owned(),
        Value::Array(
            shares
                .iter()
                .map(|s| {
                    let mut allocation = Map::new();
                    allocation.insert(
                        if s.invoice { "invoiceId" } else { "billId" }.to_owned(),
                        json!(s.id),
                    );
                    allocation.insert(
                        "amount".to_owned(),
                        json!(to_fixed(round_money(s.amount), 2)),
                    );
                    Value::Object(allocation)
                })
                .collect(),
        ),
    );
    caller.publish(state, PAYMENT_CREATED, &matched.id, Value::Object(payment));
    // The documents' paid amounts and statuses changed.
    for share in &shares {
        caller.publish(
            state,
            if share.invoice {
                INVOICE_UPDATED
            } else {
                BILL_UPDATED
            },
            &share.id,
            json!({ "id": share.id, "paymentId": matched.id }),
        );
    }
    let mut answer = json!({
        "id": id,
        "status": "reconciled",
        "paymentId": matched.id,
        "journalEntryId": matched.journal_entry_id,
    });
    if !rounded.is_null() {
        answer["roundingDifference"] = rounded;
    }
    Ok(ok(answer))
}

/// The gap between the documents and the line, when it is small enough to
/// round off without being asked: at least a cent and within the entity's
/// rounding cap, in the entity's own currency, with a rounding account to
/// book it to. The account and the gap (documents minus line, signed).
pub(crate) async fn small_gap(
    db: &PgPool,
    txn: &Value,
    shares: &[DocumentShare],
) -> Result<Option<(String, f64)>, DbErr> {
    let paid = round_money(parse_float(text(txn, "amount").unwrap_or("0")).abs());
    let allocated = shares.iter().fold(0.0, |sum, share| {
        round_money(sum + round_money(share.amount))
    });
    let gap = round_money(allocated - paid);
    let entity_id = text(txn, "entityId").unwrap_or_default();
    let (differences, rounding) = differences::load_with_rounding(db, entity_id).await?;
    let Some(rounding) = rounding.filter(|_| differences.within_cap(gap)) else {
        return Ok(None);
    };
    // The cap is in the entity's currency: a line in another one is not rounded off.
    let line_currency: Option<Option<String>> = bank_accounts::Entity::find()
        .select_only()
        .column(bank_accounts::Column::Currency)
        .filter(bank_accounts::Column::Id.eq(text(txn, "bankAccountId").unwrap_or_default()))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let base = resolve_entity_base_currency(db, entity_id).await?;
    if line_currency
        .flatten()
        .is_some_and(|currency| !currency.is_empty() && currency != base)
    {
        return Ok(None);
    }
    Ok(Some((rounding, gap)))
}

// ── GET /for-document ───────────────────────────────────────────────────────

pub(crate) async fn for_document(caller: Caller) -> Response {
    reply(
        lines_for_document(&caller).await,
        "Failed to fetch bank transactions",
    )
}

#[allow(clippy::too_many_lines)] // load the document, scan its lines, score them
async fn lines_for_document(caller: &Caller) -> Reply {
    let q = caller.query();
    let (invoice, document_id) = match (q.present("invoiceId"), q.present("billId")) {
        (Some(invoice), None) => (true, invoice.to_owned()),
        (None, Some(bill)) => (false, bill.to_owned()),
        _ => {
            return Err(Refusal::bad_request("Pass either invoiceId or billId"));
        }
    };
    let (table, label) = if invoice {
        ("invoices", "Invoice")
    } else {
        ("bills", "Bill")
    };
    if !records_in_entity(caller, &EntityTable::new(table), &[document_id.as_str()]).await? {
        return Err(Refusal::not_found(label, &document_id));
    }
    let db = &caller.db;
    let doc = if invoice {
        invoices::Entity::find_by_id(document_id.clone())
            .filter(invoices::Column::DeletedAt.is_null())
            .one(&orm(db))
            .await?
            .map(|model| serde_json::to_value(model).map_err(json_error))
            .transpose()?
    } else {
        bills::Entity::find_by_id(document_id.clone())
            .filter(bills::Column::DeletedAt.is_null())
            .one(&orm(db))
            .await?
            .map(|model| serde_json::to_value(model).map_err(json_error))
            .transpose()?
    };
    let Some(doc) = doc else {
        return Err(Refusal::not_found(label, &document_id));
    };
    let entity_id = text(&doc, "entityId").unwrap_or_default().to_owned();
    // Money in pays an invoice; money out pays a bill or refunds a credit note.
    let money_in = invoice && text(&doc, "type") != Some("credit_note");
    let search = search_term(caller).map(|term| like_pattern(&term));
    let lines: Vec<Value> = {
        use bank_transactions::Column;
        use sea_orm::ExprTrait as _;
        let amount = Expr::col(Column::Amount).cast_as("numeric");
        let mut query = bank_transactions::Entity::find()
            .filter(Column::EntityId.eq(entity_id.as_str()))
            .filter(Column::DeletedAt.is_null())
            .filter(Column::Status.eq("unreconciled"))
            .filter(if money_in {
                amount.gt(Expr::val(0))
            } else {
                amount.lt(Expr::val(0))
            });
        if let Some(pattern) = search.as_deref() {
            query = query.filter(
                Condition::any()
                    .add(Column::Description.ilike(pattern))
                    .add(Column::CounterpartyName.ilike(pattern))
                    .add(Column::Reference.ilike(pattern))
                    .add(Column::CounterpartyIban.ilike(pattern)),
            );
        }
        query
            .order_by_desc(Column::Date)
            .limit(SCAN_LIMIT)
            .all(&orm(db))
            .await?
            .into_iter()
            .map(|model| serde_json::to_value(model).map_err(json_error))
            .collect::<Result<_, _>>()?
    };
    let names = contacts_of(db, std::slice::from_ref(&doc)).await?;
    let contact = text(&doc, "contactId").and_then(|c| names.get(c));
    let accounts: HashMap<String, (String, Option<String>)> = bank_accounts::Entity::find()
        .select_only()
        .columns([
            bank_accounts::Column::Id,
            bank_accounts::Column::Name,
            bank_accounts::Column::Currency,
        ])
        .filter(bank_accounts::Column::EntityId.eq(entity_id.as_str()))
        .into_tuple::<(String, String, Option<String>)>()
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|(id, name, currency)| (id, (name, currency)))
        .collect();
    let mut scored: Vec<(f64, Value)> = lines
        .iter()
        .map(|line| {
            let (confidence, reasons) = score_line_for_document(
                line,
                &doc,
                invoice,
                contact.map(|(name, iban)| (name.as_deref().unwrap_or(""), iban.as_deref())),
            );
            let account = text(line, "bankAccountId").and_then(|a| accounts.get(a));
            let view = json!({
                "id": field(line, "id"),
                "bankAccountId": field(line, "bankAccountId"),
                "bankAccountName": account.map(|(name, _)| name.as_str()),
                "currency": account.and_then(|(_, currency)| currency.as_deref()),
                "date": field(line, "date"),
                "amount": text(line, "amount").unwrap_or("0"),
                "description": field(line, "description"),
                "counterpartyName": field(line, "counterpartyName"),
                "counterpartyIban": field(line, "counterpartyIban"),
                "reference": field(line, "reference"),
                "confidence": weldsuite_books_domain::js::number_value(confidence),
                "reasons": reasons,
            });
            (confidence, view)
        })
        .collect();
    scored.sort_by(|a, b| by_confidence(a, b, "date", true));
    let open = text(&doc, "balanceDue").unwrap_or("0");
    Ok(ok(json!({
        "document": document_view(
            &doc,
            invoice,
            contact.and_then(|(name, _)| name.as_deref()),
            0.0,
            &[],
        ),
        "openAmount": open,
        "lines": scored.into_iter().take(LIST_LIMIT).map(|(_, view)| view).collect::<Vec<_>>(),
    })))
}
