//! Booking an inbox document (Rust only, edition feature `books-receipts`):
//!
//! - `POST /api/accounting-documents/:id/book`: the document becomes a bill,
//!   a receipt (`type = 'receipt'`, BOOKS-011) or a supplier credit note, is
//!   posted (approved) through the bills' own code (the posting service,
//!   BOOKS-001), is linked to the document, and, with `paidWith`, is paid.
//! - `GET /api/accounting-documents/:id/bank-candidates`: the unprocessed
//!   bank lines that could have paid it, best first.
//! - `GET /api/accounting-documents/:id/duplicates`: bills of the same
//!   supplier with the same invoice number, and documents with the same file.
//! - `GET /api/accounting-documents/:id/prefill`: what the review form starts
//!   from (the OCR result, the supplier's booking defaults), the Rust-only
//!   successor of `POST /api/bills/from-document/:documentId`, whose answer
//!   stays as it was.
//!
//! **Amounts are tax-inclusive.** A line's `amount` is what the receipt or
//! the bank line shows (VAT included), as in the bank line categorisation of
//! phase 2. The bill's lines carry exclusive unit prices, so each is worked
//! back from the amount through the tax engine (the line's own rate), and the
//! bill's total is checked to come to the amounts given, to the cent.
//!
//! **All or nothing.** Everything is checked before anything is written. The
//! steps (the bill, its posting, the payment) are each atomic in the posting
//! service; when a later one fails, the earlier ones are undone (a draft bill
//! is removed, a posted one is rejected, which reverses its entry) and the
//! document goes back as it was. A second call for a document that is booked
//! already answers the bill it became (`alreadyBooked`), and a claim on the
//! document keeps two calls at once from booking it twice.
//!
//! **Paying.** `paidWith.type`:
//! `bank_transaction` reconciles that line to the bill (the matcher's
//! `reconcile_to_documents`, as `match-documents` does), `cash` pays from the
//! entity's cash account, `private` from its private account (director's
//! current account or drawings, per legal form), `card_unmatched` records no
//! payment: the bill stays open for its bank line. Without a payment, one sure
//! candidate line (exact amount, and the supplier's IBAN or name or the
//! document's number, one line only) is linked on its own and the answer says
//! so (`autoLinked`).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::bank_matching::{DocumentShare, reconcile_to_documents};
use weldsuite_books_domain::dates::is_iso_date;
use weldsuite_books_domain::document_booking::{
    Candidate, DocumentFacts, exclusive_unit_price, score_line, single_sure, window,
};
use weldsuite_books_domain::document_posting::load_entity;
use weldsuite_books_domain::entity_context::{resolve_entity_base_currency, resolve_entity_id};
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, ok, reply, validate,
};
use weldsuite_books_domain::js::{js_date, number_text, parse_float, round_money};
use weldsuite_books_domain::payments::{AllocationInput, RecordPaymentInput, record_payment};
use weldsuite_books_domain::posting::{PostError, load_entity_accounts};
use weldsuite_books_domain::system_accounts::{ensure_role_account, private_role};
use weldsuite_books_domain::tables::BANK_TRANSACTIONS;
use weldsuite_books_domain::tax::{Direction, DocumentTaxItem, TaxArgs, calculate_document_tax};
use weldsuite_catalogs::entity_events::{
    ACCOUNTING_DOCUMENT_BOOKED, BANK_TRANSACTION_PROCESSED, BANK_TRANSACTION_UPDATED, BILL_UPDATED,
    PAYMENT_CREATED,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Issues, Number, Presence};
use weldsuite_legal_entities::{LegalEntityApp, default_entity_id_for};
use weldsuite_schema::tenant::{bank_transactions, bills, documents, parties};

use crate::accounting_documents::{find_document, is_tax_form_document};
use crate::bills::{
    BillBody, BillLine, approve_bill, create_bill, find_bill, live_items, reject_bill,
    release_documents,
};
use crate::ocr::{document_kind_of, normalize_ocr_result, payment_method_of};
use crate::rows::{js, js_rows, timestamp_of_iso};

/// The kinds a document is booked as.
pub(crate) const KINDS: [&str; 3] = ["purchase_invoice", "receipt", "credit_note"];
/// How a booked document was paid.
pub(crate) const PAID_WITH: [&str; 4] = ["bank_transaction", "cash", "private", "card_unmatched"];
/// How many bank lines are scored.
const SCAN_LIMIT: u64 = 500;
/// How many candidates are answered.
const LIST_LIMIT: usize = 25;
/// A claim on a document older than this is a booking that died.
const CLAIM_MINUTES: i64 = 5;

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}

fn day_shape(value: &str) -> bool {
    is_iso_date(value)
}

/// A refusal for what the posting service or the matcher refuses.
fn post_refusal(error: PostError) -> Refusal {
    match error.user_message() {
        Some(message) => Refusal::bad_request(message),
        None => match error {
            PostError::Database(error) => Refusal::Database(error),
            other => Refusal::Internal(other.to_string()),
        },
    }
}

// ── The request ─────────────────────────────────────────────────────────────

/// One line of the document: what it was for and what it cost, VAT included.
#[derive(Debug, Clone)]
pub(crate) struct BookLine {
    pub description: String,
    pub account_id: Option<String>,
    pub tax_rate_id: Option<String>,
    pub amount: f64,
    pub project_id: Option<String>,
}

/// How the document was paid.
#[derive(Debug, Clone)]
pub(crate) struct PaidWith {
    pub kind: String,
    pub bank_transaction_id: Option<String>,
}

/// `POST /:id/book`.
#[derive(Debug, Clone)]
pub(crate) struct BookBody {
    pub kind: String,
    pub contact_id: String,
    pub invoice_number: Option<String>,
    pub date: String,
    pub due_date: Option<String>,
    pub currency: Option<String>,
    pub lines: Vec<BookLine>,
    pub paid_with: Option<PaidWith>,
}

pub(crate) fn read_book(issues: &mut Issues, body: &Map<String, Value>) -> Option<BookBody> {
    let kind = issues.choice(body, "kind", Presence::Required, &KINDS);
    let contact = issues.text(body, "contactId", Presence::Required, Some(1), Some(30));
    let number = issues.text(body, "invoiceNumber", Presence::Nullish, None, Some(100));
    let date = issues.pattern(
        body,
        "date",
        Presence::Required,
        Some(10),
        Some(10),
        day_shape,
        "Use a YYYY-MM-DD date",
    );
    let due = issues.pattern(
        body,
        "dueDate",
        Presence::Nullish,
        Some(10),
        Some(10),
        day_shape,
        "Use a YYYY-MM-DD date",
    );
    let currency = issues.text(body, "currency", Presence::Nullish, Some(3), Some(3));
    let lines = issues.list(
        body,
        "lines",
        Presence::Required,
        Some(1),
        Some(100),
        |issues, item| {
            let fields = issues.object(item)?;
            let mut optional = |key: &str, max: usize| {
                issues
                    .text(fields, key, Presence::Nullish, None, Some(max))
                    .into_option()
                    .filter(|v| !v.is_empty())
            };
            let account_id = optional("accountId", 30);
            let tax_rate_id = optional("taxRateId", 30);
            let project_id = optional("projectId", 30);
            let description = issues.text(
                fields,
                "description",
                Presence::Required,
                Some(1),
                Some(500),
            );
            let amount = issues.number(
                fields,
                "amount",
                Presence::Required,
                Number {
                    coerce: true,
                    min: Some(0.01),
                    ..Number::default()
                },
            );
            Some(BookLine {
                description: description.into_option()?,
                account_id,
                tax_rate_id,
                amount: amount.into_option()?,
                project_id,
            })
        },
    );
    let paid = issues.nested(body, "paidWith", Presence::Nullish, |issues, fields| {
        let kind = issues.choice(fields, "type", Presence::Required, &PAID_WITH);
        let line = issues.text(
            fields,
            "bankTransactionId",
            Presence::Nullish,
            None,
            Some(30),
        );
        let kind = kind.into_option();
        let line = line.into_option().filter(|v| !v.is_empty());
        if kind.as_deref() == Some("bank_transaction") && line.is_none() {
            issues.custom(
                "bankTransactionId",
                "bankTransactionId is required to pay with a bank line",
            );
        }
        kind.map(|kind| PaidWith {
            kind,
            bank_transaction_id: line,
        })
    });
    Some(BookBody {
        kind: kind.into_option()?,
        contact_id: contact.into_option()?,
        invoice_number: number.into_option().filter(|v| !v.is_empty()),
        date: date.into_option()?,
        due_date: due.into_option().filter(|v| !v.is_empty()),
        currency: currency.into_option().filter(|v| !v.is_empty()),
        lines: lines.into_option()?,
        paid_with: paid.into_option().flatten(),
    })
}

// ── The document and its entity ─────────────────────────────────────────────

/// The request's entity, and whether the document is in it: a document of
/// another entity is not found; one with no entity belongs to the default one.
async fn entity_of_request(caller: &Caller, doc: &Value, id: &str) -> Result<String, Refusal> {
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let belongs = match text(doc, "entityId") {
        Some(own) => own == entity_id,
        None => {
            default_entity_id_for(&caller.db, Some(LegalEntityApp::Weldbooks))
                .await?
                .as_deref()
                == Some(entity_id.as_str())
        }
    };
    if belongs {
        Ok(entity_id)
    } else {
        Err(Refusal::not_found("Document", id))
    }
}

/// Take the document for booking: a conditional write, so of two bookings at
/// once one wins. Open to a document not linked to a bill, or one whose claim
/// is stale (a booking that died). `false` when another booking holds it.
async fn claim(db: &PgPool, id: &str, entity_id: &str) -> Result<bool, DbErr> {
    let stale = utc_now() - time::Duration::minutes(CLAIM_MINUTES);
    let free = Condition::any()
        .add(documents::Column::LinkedEntityType.is_null())
        .add(documents::Column::LinkedEntityType.ne("bill"))
        .add(
            Condition::all()
                .add(documents::Column::LinkedEntityId.like("booking:%"))
                .add(documents::Column::UpdatedAt.lt(stale)),
        );
    let claimed = documents::Entity::update_many()
        .col_expr(documents::Column::Status, Expr::value("linked"))
        .col_expr(documents::Column::LinkedEntityType, Expr::value("bill"))
        .col_expr(
            documents::Column::LinkedEntityId,
            Expr::value(format!("booking:{}", weldsuite_kit::generate_id("clm"))),
        )
        .col_expr(documents::Column::EntityId, Expr::value(entity_id))
        .col_expr(documents::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(documents::Column::Id.eq(id))
        .filter(documents::Column::DeletedAt.is_null())
        .filter(documents::Column::Status.ne("rejected"))
        .filter(free)
        .exec(&orm(db))
        .await?;
    Ok(claimed.rows_affected == 1)
}

/// The document as it was before the claim.
async fn restore(db: &PgPool, doc: &Value) -> Result<(), DbErr> {
    let opt = |key: &str| text(doc, key).map(str::to_owned);
    documents::Entity::update_many()
        .col_expr(
            documents::Column::Status,
            Expr::value(text(doc, "status").unwrap_or("processed")),
        )
        .col_expr(
            documents::Column::LinkedEntityType,
            Expr::value(opt("linkedEntityType")),
        )
        .col_expr(
            documents::Column::LinkedEntityId,
            Expr::value(opt("linkedEntityId")),
        )
        .col_expr(documents::Column::EntityId, Expr::value(opt("entityId")))
        .col_expr(documents::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(documents::Column::Id.eq(text(doc, "id").unwrap_or_default()))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// Take back what a failed booking did: the bill (a draft is removed, a
/// posted one rejected, which reverses its entry) and the claim on the
/// document.
async fn undo(caller: &Caller, state: &BooksState, doc: &Value, bill: Option<(&str, bool)>) {
    if let Some((bill_id, posted)) = bill {
        if posted {
            if let Err(error) = reject_bill(
                caller,
                state,
                bill_id,
                "Booking the document failed; nothing was booked.",
            )
            .await
            {
                tracing::error!(
                    bill = bill_id,
                    ?error,
                    "[book-document] could not reject the bill"
                );
            }
        } else {
            let at = utc_now();
            if let Err(error) = bills::Entity::update_many()
                .col_expr(bills::Column::DeletedAt, Expr::value(at))
                .col_expr(bills::Column::UpdatedAt, Expr::value(at))
                .filter(bills::Column::Id.eq(bill_id))
                .exec(&orm(&caller.db))
                .await
            {
                tracing::error!(bill = bill_id, %error, "[book-document] could not remove the draft bill");
            }
        }
        if let Err(error) = release_documents(&caller.db, bill_id).await {
            tracing::error!(bill = bill_id, %error, "[book-document] could not release the document");
        }
    }
    if let Err(error) = restore(&caller.db, doc).await {
        tracing::error!(%error, "[book-document] could not restore the document");
    }
}

// ── The lines ───────────────────────────────────────────────────────────────

fn tax_item(unit_price: &str, tax_rate_id: Option<&str>, index: usize) -> DocumentTaxItem {
    DocumentTaxItem {
        quantity: Some("1".to_owned()),
        unit_price: unit_price.to_owned(),
        discount_percent: Some("0".to_owned()),
        tax_rate_id: tax_rate_id.map(str::to_owned),
        id: Some(format!("probe{index}")),
        #[allow(clippy::cast_precision_loss)]
        sort_order: Some(index as f64),
        ..DocumentTaxItem::default()
    }
}

/// What each line comes to with VAT at `units` (its exclusive prices).
async fn gross_of(
    db: &PgPool,
    entity_id: &str,
    lines: &[BookLine],
    units: &[f64],
) -> Result<Vec<f64>, Refusal> {
    let items: Vec<DocumentTaxItem> = lines
        .iter()
        .zip(units)
        .enumerate()
        .map(|(index, (line, unit))| {
            tax_item(&number_text(*unit), line.tax_rate_id.as_deref(), index)
        })
        .collect();
    let args = TaxArgs::new(entity_id, Direction::Purchase, &items);
    let totals = calculate_document_tax(db, &args)
        .await
        .map_err(Refusal::from)?;
    Ok(totals
        .processed_items
        .iter()
        .map(|item| parse_float(&item.line_total_with_tax))
        .collect())
}

/// The exclusive unit price of each line: worked back from its VAT-inclusive
/// amount through the entity's tax engine (the rate of the line's tax rate,
/// nothing for a line without one), then nudged by the cent where rounding
/// left it off, so the bill's total is the amounts given.
async fn unit_prices(
    db: &PgPool,
    entity_id: &str,
    lines: &[BookLine],
) -> Result<Vec<f64>, Refusal> {
    // The line's total over its price at a round price: the rate as the
    // engine applies it (compound or reverse-charge rates included).
    let probe = vec![1000.0; lines.len()];
    let at_probe = gross_of(db, entity_id, lines, &probe).await?;
    let ratios: Vec<f64> = at_probe.iter().map(|g| g / 1000.0).collect();
    let mut units: Vec<f64> = lines
        .iter()
        .zip(&ratios)
        .map(|(line, ratio)| exclusive_unit_price(line.amount, *ratio))
        .collect();
    for _ in 0..3 {
        let got = gross_of(db, entity_id, lines, &units).await?;
        let mut settled = true;
        for (index, line) in lines.iter().enumerate() {
            let gap = round_money(line.amount - got.get(index).copied().unwrap_or(line.amount));
            if gap.abs() >= 0.005 {
                settled = false;
                let ratio = ratios[index].max(f64::EPSILON);
                units[index] = exclusive_unit_price(units[index] * ratio + gap, ratio);
            }
        }
        if settled {
            break;
        }
    }
    Ok(units)
}

// ── Paying ──────────────────────────────────────────────────────────────────

/// The bank line a booking pays with, checked before anything is written.
async fn payable_line(caller: &Caller, entity_id: &str, line_id: &str) -> Result<Value, Refusal> {
    let Some(line) = BANK_TRANSACTIONS.find_live(&caller.db, line_id).await? else {
        return Err(Refusal::not_found("Transaction", line_id));
    };
    if text(&line, "entityId") != Some(entity_id) {
        return Err(Refusal::not_found("Transaction", line_id));
    }
    if text(&line, "status") != Some("unreconciled") {
        return Err(Refusal::bad_request(
            "That bank line is already processed. Undo it first, or pick another line.",
        ));
    }
    if parse_float(text(&line, "amount").unwrap_or("0")) >= 0.0 {
        return Err(Refusal::bad_request(
            "That bank line is money coming in; a bill is paid with money going out.",
        ));
    }
    Ok(line)
}

/// What a payment of the booked bill left behind.
struct Paid {
    payment_id: String,
    journal_entry_id: Option<String>,
    amount: f64,
    method: &'static str,
    bank_transaction_id: Option<String>,
}

/// Reconcile `line` to the bill, as `match-documents` does for one document:
/// the line pays up to the bill's balance, and the rest of a bigger line stays
/// on the supplier as credit.
async fn pay_with_line(
    caller: &Caller,
    state: &BooksState,
    bill: &Value,
    line: &Value,
) -> Result<Paid, Refusal> {
    let balance = parse_float(text(bill, "balanceDue").unwrap_or("0"));
    let paid = round_money(parse_float(text(line, "amount").unwrap_or("0")).abs());
    let share = round_money(balance.min(paid));
    let http = caller.http(state);
    let matched = reconcile_to_documents(
        &caller.db,
        http.as_ref(),
        line,
        &[DocumentShare {
            invoice: false,
            id: text(bill, "id").unwrap_or_default().to_owned(),
            amount: share,
        }],
        None,
        caller.user().map(str::to_owned),
    )
    .await
    .map_err(post_refusal)?;
    let line_id = text(line, "id").unwrap_or_default();
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: text(line, "entityId"),
            entity_type: "bank_transaction",
            entity_id: line_id,
            action: "reconciled",
            changes: Some(
                [
                    (
                        "status",
                        json!({ "old": line.get("status"), "new": "reconciled" }),
                    ),
                    (
                        "reconciledBillId",
                        json!({ "old": line.get("reconciledBillId"), "new": bill.get("id") }),
                    ),
                    (
                        "reconciledPaymentId",
                        json!({ "old": line.get("reconciledPaymentId"), "new": matched.id }),
                    ),
                ]
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect(),
            ),
        },
    )
    .await;
    let event = json!({
        "id": line_id,
        "bankAccountId": line.get("bankAccountId"),
        "amount": text(line, "amount").unwrap_or("0"),
        "description": line.get("description"),
        "status": "reconciled",
    });
    caller.publish(state, BANK_TRANSACTION_UPDATED, line_id, event.clone());
    let mut processed = event;
    processed["how"] = json!("link");
    caller.publish(state, BANK_TRANSACTION_PROCESSED, line_id, processed);
    Ok(Paid {
        payment_id: matched.id,
        journal_entry_id: matched.journal_entry_id,
        amount: share,
        method: "bank_transfer",
        bank_transaction_id: Some(line_id.to_owned()),
    })
}

/// Pay the bill in cash, or privately, with no bank line.
async fn pay_without_line(
    caller: &Caller,
    state: &BooksState,
    bill: &Value,
    method: &'static str,
    money_account_id: Option<String>,
    date: &str,
) -> Result<Paid, Refusal> {
    let amount = round_money(parse_float(text(bill, "balanceDue").unwrap_or("0")));
    let paid_on = js_date(date).ok_or_else(|| Refusal::bad_request("Use a YYYY-MM-DD date"))?;
    let http = caller.http(state);
    let result = record_payment(
        &caller.db,
        http.as_ref(),
        RecordPaymentInput {
            entity_id: text(bill, "entityId").unwrap_or_default().to_owned(),
            received: false,
            amount,
            currency: text(bill, "currency").map(str::to_owned),
            date: paid_on,
            payment_method: Some(if method == "cash" { "cash" } else { "other" }.to_owned()),
            reference: text(bill, "externalReference")
                .or_else(|| text(bill, "billNumber"))
                .map(str::to_owned),
            notes: (method == "private").then(|| "Paid privately".to_owned()),
            contact_id: text(bill, "contactId").map(str::to_owned),
            money_account_id,
            allocations: vec![AllocationInput {
                invoice_id: None,
                bill_id: Some(text(bill, "id").unwrap_or_default().to_owned()),
                amount,
            }],
            user_id: caller.user().map(str::to_owned),
            ..RecordPaymentInput::default()
        },
    )
    .await
    .map_err(post_refusal)?;
    Ok(Paid {
        payment_id: result.payment_id,
        journal_entry_id: result.journal_entry_id,
        amount,
        method: if method == "cash" { "cash" } else { "private" },
        bank_transaction_id: None,
    })
}

// ── Bank lines for a document ───────────────────────────────────────────────

/// What a document says, for scoring the lines against it: the booking's own
/// values where there are any, else the OCR result, else the bill the
/// document became.
async fn facts_of(db: &PgPool, doc: &Value, overrides: &Overrides) -> Result<DocumentFacts, DbErr> {
    let ocr = doc
        .get("ocrResult")
        .filter(|v| !v.is_null())
        .map(normalize_ocr_result);
    let contact_id = overrides
        .contact_id
        .clone()
        .or_else(|| text(doc, "matchedContactId").map(str::to_owned));
    let party = match &contact_id {
        Some(id) => {
            parties::Entity::find_by_id(id.clone())
                .filter(parties::Column::DeletedAt.is_null())
                .one(&orm(db))
                .await?
        }
        None => None,
    };
    let from_ocr = |key: &str| -> Option<String> {
        ocr.as_ref()
            .and_then(|o| o.get(key))
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let vendor = |key: &str| -> Option<String> {
        ocr.as_ref()
            .and_then(|o| o["vendor"].get(key))
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let mut facts = DocumentFacts {
        amount: ocr
            .as_ref()
            .and_then(|o| o.get("total"))
            .and_then(Value::as_f64),
        date: from_ocr("invoiceDate"),
        iban: party
            .as_ref()
            .and_then(|p| p.iban.clone())
            .filter(|v| !v.is_empty())
            .or_else(|| vendor("iban"))
            .or_else(|| from_ocr("iban")),
        name: party
            .as_ref()
            .and_then(|p| p.display_name.clone())
            .or_else(|| vendor("name")),
        references: [from_ocr("invoiceNumber"), from_ocr("paymentReference")]
            .into_iter()
            .flatten()
            .collect(),
    };
    // A document already booked says what its bill says.
    if text(doc, "linkedEntityType") == Some("bill")
        && let Some(bill_id) = text(doc, "linkedEntityId")
        && let Some(bill) = find_bill(db, bill_id).await?
    {
        facts.amount = Some(parse_float(text(&bill, "total").unwrap_or("0")));
        facts.date = text(&bill, "issueDate").map(|d| d.chars().take(10).collect());
        facts.references = [text(&bill, "externalReference"), text(&bill, "billNumber")]
            .into_iter()
            .flatten()
            .map(str::to_owned)
            .collect();
    }
    if let Some(amount) = overrides.amount {
        facts.amount = Some(amount);
    }
    if let Some(date) = &overrides.date {
        facts.date = Some(date.clone());
    }
    if let Some(number) = &overrides.invoice_number {
        facts.references.insert(0, number.clone());
    }
    Ok(facts)
}

/// What the review form may pass to score against its current values.
#[derive(Debug, Default, Clone)]
struct Overrides {
    amount: Option<f64>,
    date: Option<String>,
    contact_id: Option<String>,
    invoice_number: Option<String>,
}

impl Overrides {
    fn of(caller: &Caller) -> Self {
        let q = caller.query();
        Self {
            amount: q
                .present("amount")
                .map(parse_float)
                .filter(|a| a.is_finite() && *a > 0.0),
            date: q
                .present("date")
                .map(str::to_owned)
                .filter(|d| is_iso_date(d)),
            contact_id: q.present("contactId").map(str::to_owned),
            invoice_number: q.present("invoiceNumber").map(str::to_owned),
        }
    }
}

/// The entity's unprocessed money-out lines that fall in the document's date
/// window (any date without one), newest first.
async fn lines_in_window(
    db: &PgPool,
    entity_id: &str,
    date: Option<&str>,
) -> Result<Vec<Value>, DbErr> {
    use bank_transactions::Column;
    use sea_orm::ExprTrait as _;
    let mut query = bank_transactions::Entity::find()
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Status.eq("unreconciled"))
        .filter(
            Expr::col(Column::Amount)
                .cast_as("numeric")
                .lt(Expr::val(0)),
        );
    if let Some((from, to)) = date.and_then(window) {
        let next = weldsuite_books_domain::dates::add_days(&to, 1).unwrap_or(to);
        if let (Some(from), Some(until)) = (
            timestamp_of_iso(&format!("{from}T00:00:00.000Z")),
            timestamp_of_iso(&format!("{next}T00:00:00.000Z")),
        ) {
            query = query
                .filter(Column::Date.gte(from))
                .filter(Column::Date.lt(until));
        }
    }
    query
        .order_by_desc(Column::Date)
        .limit(SCAN_LIMIT)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|model| js!(model))
        .collect()
}

/// The lines scored against `facts`, best first.
fn scored(lines: Vec<Value>, facts: &DocumentFacts) -> Vec<(Value, Candidate)> {
    let mut found: Vec<(Value, Candidate)> = lines
        .into_iter()
        .filter_map(|line| score_line(&line, facts).map(|candidate| (line, candidate)))
        .collect();
    found.sort_by(|a, b| {
        b.1.score
            .partial_cmp(&a.1.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| text(&b.0, "date").cmp(&text(&a.0, "date")))
    });
    found
}

fn candidate_view(line: &Value, candidate: &Candidate) -> Value {
    json!({
        "id": line.get("id"),
        "bankAccountId": line.get("bankAccountId"),
        "date": line.get("date"),
        "amount": text(line, "amount").unwrap_or("0"),
        "counterpartyName": line.get("counterpartyName"),
        "counterpartyIban": line.get("counterpartyIban"),
        "description": line.get("description"),
        "reference": line.get("reference"),
        "score": candidate.score,
        "reasons": candidate.reasons,
        "sure": candidate.sure,
    })
}

pub(crate) async fn bank_candidates(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        let Some(doc) = find_document(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Document", &id));
        };
        let entity_id = entity_of_request(&caller, &doc, &id).await?;
        let facts = facts_of(&caller.db, &doc, &Overrides::of(&caller)).await?;
        let lines = lines_in_window(&caller.db, &entity_id, facts.date.as_deref()).await?;
        let found = scored(lines, &facts);
        Ok(ok(Value::Array(
            found
                .iter()
                .take(LIST_LIMIT)
                .map(|(line, candidate)| candidate_view(line, candidate))
                .collect(),
        )))
    }
    .await;
    reply(result, "Failed to fetch the bank line candidates")
}

// ── Duplicates ──────────────────────────────────────────────────────────────

pub(crate) async fn duplicates(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        let Some(doc) = find_document(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Document", &id));
        };
        let entity_id = entity_of_request(&caller, &doc, &id).await?;
        let overrides = Overrides::of(&caller);
        let facts = facts_of(&caller.db, &doc, &overrides).await?;
        let contact_id = overrides
            .contact_id
            .clone()
            .or_else(|| text(&doc, "matchedContactId").map(str::to_owned));
        let number = overrides
            .invoice_number
            .clone()
            .or_else(|| facts.references.first().cloned())
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty());
        let mut same_bill = Vec::new();
        if let (Some(contact), Some(number)) = (&contact_id, &number) {
            let rows = bills::Entity::find()
                .filter(bills::Column::EntityId.eq(entity_id.as_str()))
                .filter(bills::Column::ContactId.eq(contact.as_str()))
                .filter(bills::Column::DeletedAt.is_null())
                .filter(bills::Column::Status.ne("cancelled"))
                .filter(Expr::cust_with_values(
                    "lower(btrim(external_reference)) = lower($1)",
                    [number.clone()],
                ))
                .order_by_desc(bills::Column::IssueDate)
                .limit(25)
                .all(&orm(&caller.db))
                .await?;
            for bill in js_rows!(rows)? {
                same_bill.push(json!({
                    "id": bill["id"],
                    "billNumber": bill["billNumber"],
                    "type": bill["type"],
                    "status": bill["status"],
                    "externalReference": bill["externalReference"],
                    "contactId": bill["contactId"],
                    "contactName": bill["contactName"],
                    "issueDate": bill["issueDate"],
                    "total": bill["total"],
                    "currency": bill["currency"],
                    "reason": "same supplier and invoice number",
                }));
            }
        }
        // No hash is stored with a file: the same name and size is the same
        // file for this purpose.
        let mut same_file = Vec::new();
        if let Some(size) = doc.get("fileSize").and_then(Value::as_i64) {
            let name = text(&doc, "originalFileName")
                .or_else(|| text(&doc, "fileName"))
                .unwrap_or_default()
                .to_owned();
            let default =
                default_entity_id_for(&caller.db, Some(LegalEntityApp::Weldbooks)).await?;
            let mut entity =
                Condition::any().add(documents::Column::EntityId.eq(entity_id.as_str()));
            if default.as_deref() == Some(entity_id.as_str()) {
                entity = entity.add(documents::Column::EntityId.is_null());
            }
            let rows = documents::Entity::find()
                .filter(documents::Column::Id.ne(id.as_str()))
                .filter(documents::Column::DeletedAt.is_null())
                .filter(documents::Column::Status.ne("rejected"))
                .filter(documents::Column::FileSize.eq(i32::try_from(size).unwrap_or(i32::MAX)))
                .filter(
                    Condition::any()
                        .add(documents::Column::OriginalFileName.eq(name.as_str()))
                        .add(documents::Column::FileName.eq(name.as_str())),
                )
                .filter(entity)
                .order_by_desc(documents::Column::CreatedAt)
                .limit(25)
                .all(&orm(&caller.db))
                .await?;
            for other in js_rows!(rows)? {
                same_file.push(json!({
                    "id": other["id"],
                    "fileName": other["fileName"],
                    "originalFileName": other["originalFileName"],
                    "status": other["status"],
                    "linkedEntityType": other["linkedEntityType"],
                    "linkedEntityId": other["linkedEntityId"],
                    "createdAt": other["createdAt"],
                    "reason": "same file name and size",
                }));
            }
        }
        Ok(ok(json!({ "bills": same_bill, "documents": same_file })))
    }
    .await;
    reply(result, "Failed to check the document for duplicates")
}

// ── Prefill ─────────────────────────────────────────────────────────────────

/// A line's gross amount from the OCR: its exclusive total with the rate on it.
fn gross_of_ocr_line(line: &Value) -> f64 {
    let quantity = line.get("quantity").and_then(Value::as_f64).unwrap_or(1.0);
    let net = line
        .get("total")
        .and_then(Value::as_f64)
        .or_else(|| Some(line.get("unitPrice").and_then(Value::as_f64)? * quantity))
        .unwrap_or(0.0);
    let rate = line.get("taxRate").and_then(Value::as_f64).unwrap_or(0.0);
    round_money(net * (1.0 + rate / 100.0))
}

#[allow(clippy::too_many_lines)] // the form, field by field
pub(crate) async fn prefill(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        let Some(doc) = find_document(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Document", &id));
        };
        let entity_id = entity_of_request(&caller, &doc, &id).await?;
        let Some(stored) = doc.get("ocrResult").filter(|v| !v.is_null()) else {
            return Err(Refusal::bad_request("Document has not been processed yet"));
        };
        let ocr = normalize_ocr_result(stored);
        let said = ocr
            .get("documentKind")
            .and_then(Value::as_str)
            .map(document_kind_of);
        let receipt = said == Some("receipt")
            || (said.is_none() && text(&doc, "type") == Some("receipt"));
        let kind = if said == Some("credit_note") {
            "credit_note"
        } else if receipt {
            "receipt"
        } else {
            "purchase_invoice"
        };
        let paid = ocr.get("paid").and_then(Value::as_bool).unwrap_or(false);
        let method = paid.then(|| {
            payment_method_of(ocr.get("paymentMethod").and_then(Value::as_str))
        });
        let contact_id = text(&doc, "matchedContactId").map(str::to_owned);
        let defaults = match &contact_id {
            Some(contact) => {
                crate::booking_defaults::booking_defaults(&caller.db, Some(&entity_id), contact)
                    .await?
            }
            None => None,
        };
        let default_account = defaults
            .as_ref()
            .and_then(|d| d["account"]["accountId"].as_str())
            .map(str::to_owned);
        let default_rate = defaults.as_ref().map(|d| &d["taxRate"]).filter(|r| !r.is_null());
        let default_project = defaults
            .as_ref()
            .and_then(|d| d["project"]["projectId"].as_str())
            .map(str::to_owned);
        let total = ocr.get("total").and_then(Value::as_f64);
        let mut lines: Vec<Value> = ocr["lineItems"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|line| {
                let rate = line.get("taxRate").and_then(Value::as_f64);
                // The supplier's usual VAT rate, when it is the rate printed.
                let tax_rate_id = default_rate.and_then(|d| {
                    let usual = parse_float(d["rate"].as_str().unwrap_or("NaN"));
                    (rate.is_none_or(|r| (r - usual).abs() < 0.01))
                        .then(|| d["taxRateId"].clone())
                });
                json!({
                    "description": line["description"],
                    "amount": gross_of_ocr_line(line),
                    "taxRate": rate,
                    "taxRateId": tax_rate_id.unwrap_or(Value::Null),
                    "accountId": default_account,
                    "projectId": default_project,
                })
            })
            .collect();
        if lines.is_empty()
            && let Some(total) = total
        {
            let rate = ocr["taxBreakdown"].get(0).and_then(|row| row["rate"].as_f64());
            lines.push(json!({
                "description": ocr["vendor"]["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("Scanned document"),
                "amount": round_money(total),
                "taxRate": rate,
                "taxRateId": default_rate.map_or(Value::Null, |d| d["taxRateId"].clone()),
                "accountId": default_account,
                "projectId": default_project,
            }));
        }
        // Rounding on the lines can leave the sum a cent off the total.
        if let Some(total) = total {
            let sum: f64 = lines.iter().filter_map(|l| l["amount"].as_f64()).sum();
            let gap = round_money(total - sum);
            if gap != 0.0
                && gap.abs() <= 0.05
                && let Some(last) = lines.last_mut()
            {
                let last_amount = last["amount"].as_f64().unwrap_or(0.0);
                last["amount"] = json!(round_money(last_amount + gap));
            }
        }
        let suggestion = match method {
            Some("cash") => json!({ "type": "cash" }),
            Some(_) => json!({ "type": "card_unmatched" }),
            None => Value::Null,
        };
        Ok(ok(json!({
            "sourceDocumentId": id,
            "kind": kind,
            "contactId": contact_id,
            "contactName": ocr["vendor"]["name"],
            "invoiceNumber": ocr["invoiceNumber"],
            "date": ocr["invoiceDate"],
            "dueDate": ocr["dueDate"],
            "currency": ocr["currency"],
            "lines": lines,
            "subtotal": ocr["subtotal"],
            "taxTotal": ocr["totalTax"],
            "total": ocr["total"],
            "paid": paid,
            "paymentMethod": method,
            "paidWith": suggestion,
            "iban": ocr["vendor"]["iban"].as_str().filter(|v| !v.is_empty()).map_or_else(|| ocr["iban"].clone(), |v| json!(v)),
            "paymentReference": ocr["paymentReference"],
            "confidence": ocr["confidence"],
            "defaults": defaults,
        })))
    }
    .await;
    reply(result, "Failed to read the document for booking")
}

// ── POST /:id/book ──────────────────────────────────────────────────────────

pub(crate) async fn book(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let body = match validate(&headers, &raw, read_book) {
        Ok(Some(body)) => body,
        Ok(None) => {
            return Refusal::bad_request("Invalid request body")
                .respond("Failed to book the document");
        }
        Err(refusal) => return refusal.respond("Failed to book the document"),
    };
    if let Some(paid) = &body.paid_with {
        // Paying is banking, not bookkeeping: its own permissions.
        let needs = if paid.kind == "bank_transaction" {
            "banking:update"
        } else {
            "banking:create"
        };
        if caller.user().is_some() && !(caller.can(needs) || caller.can("banking:manage")) {
            return Refusal::forbidden(
                "You need permission to record payments to pay a document while booking it.",
            )
            .respond("Failed to book the document");
        }
    }
    reply(
        book_document(&caller, &state, &id, body).await,
        "Failed to book the document",
    )
}

/// The booking itself (the route, checked and parsed).
#[allow(clippy::too_many_lines)] // the steps of one booking, in the order they happen
pub(crate) async fn book_document(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    body: BookBody,
) -> Reply {
    let db = &caller.db;
    let Some(doc) = find_document(db, id).await? else {
        return Err(Refusal::not_found("Document", id));
    };
    let entity_id = entity_of_request(caller, &doc, id).await?;
    if is_tax_form_document(db, &doc).await? {
        return Err(Refusal::bad_request(
            "Tax forms such as W-9s and exemption certificates are not booked as bills.",
        ));
    }
    if text(&doc, "status") == Some("rejected") {
        return Err(Refusal::bad_request(
            "A rejected document can't be booked. It was marked not for the books.",
        ));
    }
    // Booked already: the same answer, nothing written.
    if text(&doc, "linkedEntityType") == Some("bill")
        && let Some(bill_id) = text(&doc, "linkedEntityId")
        && !bill_id.starts_with("booking:")
        && let Some(bill) = find_bill(db, bill_id).await?
    {
        let mut view = bill.as_object().cloned().unwrap_or_default();
        view.insert(
            "items".to_owned(),
            Value::Array(live_items(db, bill_id, true).await?),
        );
        return Ok(ok(
            json!({ "bill": Value::Object(view), "alreadyBooked": true }),
        ));
    }
    if matches!(
        text(&doc, "linkedEntityType"),
        Some("invoice" | "journal_entry" | "expense")
    ) {
        return Err(Refusal::conflict(
            "This document is linked to something else already. Unlink it first.",
        ));
    }

    // Everything the booking needs, checked before anything is written.
    let contact = parties::Entity::find_by_id(body.contact_id.clone())
        .filter(parties::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    let Some(contact) = contact else {
        return Err(Refusal::bad_request(format!(
            "Contact {} not found",
            body.contact_id
        )));
    };
    let accounts = load_entity_accounts(db, &entity_id).await?;
    for line in &body.lines {
        if let Some(account) = line.account_id.as_deref()
            && accounts.by_id(Some(account)).is_none()
        {
            return Err(Refusal::bad_request(format!(
                "Account {account} does not belong to this accounting entity"
            )));
        }
    }
    let credit_note = body.kind == "credit_note";
    let mut pay_line = None;
    let mut private_account = None;
    if let Some(paid) = &body.paid_with {
        if credit_note && paid.kind != "card_unmatched" {
            return Err(Refusal::bad_request(
                "A credit note is not paid: it is applied against a bill.",
            ));
        }
        match paid.kind.as_str() {
            "bank_transaction" => {
                let line_id = paid.bank_transaction_id.as_deref().unwrap_or_default();
                pay_line = Some(payable_line(caller, &entity_id, line_id).await?);
            }
            "cash" => {
                if accounts.by_subtype("cash").is_none() {
                    return Err(Refusal::bad_request(
                        "This accounting entity has no cash account to pay from.",
                    ));
                }
            }
            "private" => {
                let entity = load_entity(db, &entity_id)
                    .await
                    .map_err(|error| Refusal::Internal(error.to_string()))?;
                let role = private_role(
                    text(&entity, "jurisdictionCode").unwrap_or_default(),
                    text(&entity, "entityType"),
                );
                let account = ensure_role_account(db, &entity_id, role)
                    .await
                    .map_err(post_refusal)?;
                private_account = account["id"].as_str().map(str::to_owned);
            }
            _ => {}
        }
    }
    let units = unit_prices(db, &entity_id, &body.lines).await?;
    let wanted: f64 = body.lines.iter().map(|l| round_money(l.amount)).sum();
    let wanted = round_money(wanted);

    if !claim(db, id, &entity_id).await? {
        // Another booking took the document between the read and the claim.
        if let Some(fresh) = find_document(db, id).await?
            && text(&fresh, "linkedEntityType") == Some("bill")
            && let Some(bill_id) = text(&fresh, "linkedEntityId")
            && let Some(bill) = find_bill(db, bill_id).await?
        {
            return Ok(ok(json!({ "bill": bill, "alreadyBooked": true })));
        }
        return Err(Refusal::conflict(
            "This document is being booked right now.",
        ));
    }

    // 1. The bill, as the bills route makes it.
    let currency = match &body.currency {
        Some(currency) => currency.to_uppercase(),
        None => resolve_entity_base_currency(db, &entity_id).await?,
    };
    let items: Vec<BillLine> = body
        .lines
        .iter()
        .zip(&units)
        .enumerate()
        .map(|(index, (line, unit))| BillLine {
            description: line.description.clone(),
            quantity: "1".to_owned(),
            unit_price: number_text(*unit),
            discount_percent: "0".to_owned(),
            tax_rate_id: line.tax_rate_id.clone(),
            account_id: line.account_id.clone(),
            project_id: line.project_id.clone(),
            #[allow(clippy::cast_precision_loss)]
            sort_order: Some(index as f64),
            accrue_use_tax: Some(false),
            ..BillLine::default()
        })
        .collect();
    let data = BillBody {
        entity_id: Some(entity_id.clone()),
        contact_id: Some(body.contact_id.clone()),
        contact_name: contact.display_name.clone(),
        issue_date: Some(body.date.clone()),
        due_date: Some(body.due_date.clone().unwrap_or_else(|| body.date.clone())),
        currency: Some(currency),
        external_reference: body.invoice_number.clone(),
        source_document_id: Some(id.to_owned()),
        bill_type: match body.kind.as_str() {
            "receipt" => Some("receipt".to_owned()),
            "credit_note" => Some("credit_note".to_owned()),
            _ => None,
        },
        items: Some(items),
        ..BillBody::default()
    };
    let bill = match create_bill(caller, state, data).await {
        Ok(bill) => bill,
        Err(refusal) => {
            undo(caller, state, &doc, None).await;
            return Err(refusal);
        }
    };
    let bill_id = text(&bill, "id").unwrap_or_default().to_owned();
    let total = parse_float(text(&bill, "total").unwrap_or("0"));
    if (round_money(total) - wanted).abs() >= 0.005 {
        undo(caller, state, &doc, Some((&bill_id, false))).await;
        return Err(Refusal::bad_request(format!(
            "The lines come to {} with VAT but the bill would be {}. Check the tax rates of the lines.",
            number_text(wanted),
            number_text(round_money(total)),
        )));
    }

    // 2. Posted, through the bills' own approval.
    if let Err(refusal) = approve_bill(caller, state, &bill_id).await {
        undo(caller, state, &doc, Some((&bill_id, false))).await;
        return Err(refusal);
    }

    // 3. Paid, when it was.
    let mut auto_linked = false;
    let posted = find_bill(db, &bill_id).await?.unwrap_or(bill.clone());
    let outcome = match body.paid_with.as_ref().map(|p| p.kind.as_str()) {
        Some("bank_transaction") => match &pay_line {
            Some(line) => pay_with_line(caller, state, &posted, line).await.map(Some),
            None => Ok(None),
        },
        Some("cash") => pay_without_line(caller, state, &posted, "cash", None, &body.date)
            .await
            .map(Some),
        Some("private") => pay_without_line(
            caller,
            state,
            &posted,
            "private",
            private_account,
            &body.date,
        )
        .await
        .map(Some),
        _ => Ok(None),
    };
    let mut paid: Option<Paid> = match outcome {
        Ok(result) => result,
        Err(refusal) => {
            undo(caller, state, &doc, Some((&bill_id, true))).await;
            return Err(refusal);
        }
    };
    // 4. No payment: one sure bank line is linked on its own.
    if paid.is_none() && !credit_note {
        match auto_link(caller, state, &entity_id, &posted, &doc, &body).await {
            Ok(Some(result)) => {
                auto_linked = true;
                paid = Some(result);
            }
            Ok(None) => {}
            // The bill is booked and right; the line is left for the person.
            Err(error) => {
                tracing::warn!(bill = %bill_id, ?error, "[book-document] could not link a bank line");
            }
        }
    }

    // 5. The document, the audit trail, the events.
    documents::Entity::update_many()
        .col_expr(documents::Column::Status, Expr::value("linked"))
        .col_expr(documents::Column::LinkedEntityType, Expr::value("bill"))
        .col_expr(
            documents::Column::LinkedEntityId,
            Expr::value(bill_id.as_str()),
        )
        .col_expr(documents::Column::EntityId, Expr::value(entity_id.as_str()))
        .col_expr(
            documents::Column::MatchedContactId,
            Expr::value(body.contact_id.as_str()),
        )
        .col_expr(documents::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(documents::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    let mut changes = Map::new();
    changes.insert(
        "status".into(),
        json!({ "old": doc.get("status"), "new": "linked" }),
    );
    changes.insert(
        "linkedEntityId".into(),
        json!({ "old": doc.get("linkedEntityId"), "new": bill_id }),
    );
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "accounting_document",
            entity_id: id,
            action: "booked",
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        ACCOUNTING_DOCUMENT_BOOKED,
        id,
        json!({
            "id": id,
            "status": "linked",
            "kind": body.kind,
            "entityId": entity_id,
            "linkedEntityType": "bill",
            "linkedEntityId": bill_id,
            "billId": bill_id,
            "paymentId": paid.as_ref().map(|p| &p.payment_id),
            "bankTransactionId": paid.as_ref().and_then(|p| p.bank_transaction_id.as_ref()),
            "autoLinked": auto_linked,
        }),
    );
    if let Some(paid) = &paid {
        caller.publish(
            state,
            PAYMENT_CREATED,
            &paid.payment_id,
            json!({
                "id": paid.payment_id,
                "billId": bill_id,
                "amount": number_text(paid.amount),
                "method": paid.method,
                "bankTransactionId": paid.bank_transaction_id,
            }),
        );
        caller.publish(
            state,
            BILL_UPDATED,
            &bill_id,
            json!({ "id": bill_id, "paymentId": paid.payment_id }),
        );
    }

    // The answer: the bill as it stands now.
    let mut view = find_bill(db, &bill_id)
        .await?
        .and_then(|b| b.as_object().cloned())
        .unwrap_or_default();
    view.insert(
        "items".to_owned(),
        Value::Array(live_items(db, &bill_id, true).await?),
    );
    let mut answer = json!({ "bill": Value::Object(view) });
    if let Some(paid) = &paid {
        answer["payment"] = json!({
            "id": paid.payment_id,
            "journalEntryId": paid.journal_entry_id,
            "amount": number_text(paid.amount),
            "method": paid.method,
        });
        answer["bankTransactionId"] = json!(paid.bank_transaction_id);
    }
    answer["autoLinked"] = json!(auto_linked);
    Ok(created(answer))
}

/// With no payment recorded: the one bank line that is sure to be this
/// document's payment, linked to its bill (`None` when there is not exactly
/// one).
async fn auto_link(
    caller: &Caller,
    state: &BooksState,
    entity_id: &str,
    bill: &Value,
    doc: &Value,
    body: &BookBody,
) -> Result<Option<Paid>, Refusal> {
    let overrides = Overrides {
        amount: Some(parse_float(text(bill, "total").unwrap_or("0"))),
        date: Some(body.date.clone()),
        contact_id: Some(body.contact_id.clone()),
        invoice_number: body.invoice_number.clone(),
    };
    let facts = facts_of(&caller.db, doc, &overrides).await?;
    let lines = lines_in_window(&caller.db, entity_id, facts.date.as_deref()).await?;
    let found = scored(lines, &facts);
    let Some(line) = single_sure(&found) else {
        return Ok(None);
    };
    Ok(Some(pay_with_line(caller, state, bill, line).await?))
}
