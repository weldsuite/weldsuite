//! Ledger catch-up (books-api `services/accounting-catch-up.ts`): book what
//! WeldBooks recorded before every document posted. For one entity:
//!
//! 1. tax-ledger rows for posted invoices and manual journal entries that have
//!    none (so the VAT return sees them);
//! 2. credit notes posted with the invoice's sign: a reversal plus a correct
//!    entry, both dated today;
//! 3. invoices sent or paid without being finalized, bills approved or paid
//!    without being posted, keeping their status;
//! 4. payments that never reached the ledger (their documents are settled);
//! 5. a payment for bank lines matched to an invoice or bill without one.
//!
//! Everything in a closed period or on/before a lock date is skipped and
//! reported. A dry run builds every posting and checks every lock without
//! writing. Running it twice is safe.

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;

use crate::document_posting::{
    PaymentAllocationInput, PaymentPostingInput, PostInvoiceOptions, amount_of, build_bill_posting,
    build_invoice_posting, build_payment_posting, filled, owned, post_bill, post_invoice, text,
    update_with_entry,
};
use crate::guards::{PostingCheck, PostingLockKind, assert_posting_allowed};
use crate::http::now;
use crate::js::{math_round, numeric, to_fixed};
use crate::payments::{AllocationInput, RecordPaymentInput, record_payment};
use crate::posting::{
    PostError, PostJournalEntryInput, PostingTaxLine, ReverseArgs, post_journal_entry,
    reverse_journal_entry,
};
use crate::tables::{
    BANK_TRANSACTIONS, BILL_ITEMS, BILLS, INVOICE_ITEMS, INVOICES, JOURNAL_ENTRIES, JOURNAL_LINES,
    PAYMENT_ALLOCATIONS, PAYMENTS, TAX_LINES, TAX_RATES,
};

const UNPOSTED_INVOICE_STATUSES: [&str; 6] = [
    "sent",
    "overdue",
    "partial",
    "paid",
    "finalized",
    "uncollectible",
];
const UNPOSTED_BILL_STATUSES: [&str; 3] = ["approved", "partial", "paid"];

/// One document the catch-up left alone (`CatchUpSkipped`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub kind: &'static str,
    pub id: String,
    pub number: Option<String>,
    pub reason: String,
}

/// `CatchUpResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CatchUpResult {
    pub dry_run: bool,
    pub invoices: i64,
    pub credit_notes_corrected: i64,
    pub bills: i64,
    pub payments: i64,
    pub bank_transactions: i64,
    pub tax_lines: i64,
    pub skipped: Vec<Skipped>,
}

impl CatchUpResult {
    /// The result as the route answers it.
    pub fn to_json(&self) -> Value {
        json!({
            "dryRun": self.dry_run,
            "invoices": self.invoices,
            "creditNotesCorrected": self.credit_notes_corrected,
            "bills": self.bills,
            "payments": self.payments,
            "bankTransactions": self.bank_transactions,
            "taxLines": self.tax_lines,
            "skipped": self.skipped.iter().map(|s| json!({
                "type": s.kind, "id": s.id, "number": s.number, "reason": s.reason,
            })).collect::<Vec<_>>(),
        })
    }
}

struct Ctx<'a> {
    db: &'a PgPool,
    http: Option<&'a OutboundHttp>,
    entity_id: &'a str,
    dry_run: bool,
    user_id: Option<String>,
    result: CatchUpResult,
}

impl Ctx<'_> {
    /// A posting refused for a reason the user can fix is skipped and
    /// reported (`skipReason`); anything else fails the run.
    fn skip(
        &mut self,
        error: PostError,
        kind: &'static str,
        id: &str,
        number: Option<String>,
    ) -> Result<(), PostError> {
        match error.user_message() {
            Some(reason) => {
                self.result.skipped.push(Skipped {
                    kind,
                    id: id.to_owned(),
                    number,
                    reason,
                });
                Ok(())
            }
            None => Err(error),
        }
    }

    async fn check_locks(
        &self,
        date: &str,
        kind: PostingLockKind,
        affects_tax: bool,
    ) -> Result<(), PostError> {
        assert_posting_allowed(
            self.db,
            PostingCheck {
                entity_id: self.entity_id,
                date,
                kind,
                affects_tax,
                user_id: self.user_id.as_deref(),
            },
        )
        .await?;
        Ok(())
    }
}

/// `taxRowsFor(taxLines, args)`: `tax_lines` properties, the zero rows left out.
fn tax_rows_for(
    tax_lines: &[PostingTaxLine],
    entity_id: &str,
    source_type: &str,
    source_id: &str,
    journal_entry_id: &str,
    tax_date: &str,
) -> Vec<Map<String, Value>> {
    let at = now();
    let opt = |v: &Option<String>| v.as_ref().map_or(Value::Null, |v| json!(v));
    tax_lines
        .iter()
        .filter(|t| t.taxable_amount != 0.0 || t.tax_amount != 0.0)
        .map(|t| {
            let mut row = Map::new();
            for (key, value) in [
                ("id", json!(generate_id("txl"))),
                ("createdAt", json!(at)),
                ("entityId", json!(entity_id)),
                ("sourceType", json!(source_type)),
                ("sourceId", json!(source_id)),
                ("sourceLineId", opt(&t.source_line_id)),
                ("journalEntryId", json!(journal_entry_id)),
                ("taxDate", json!(tax_date)),
                ("direction", json!(t.direction)),
                ("taxRateId", opt(&t.tax_rate_id)),
                ("taxRateName", opt(&t.tax_rate_name)),
                ("taxCategoryCode", opt(&t.tax_category_code)),
                ("rate", json!(to_fixed(t.rate, 4))),
                ("component", opt(&t.component)),
                ("selfAssessed", json!(t.self_assessed)),
                ("taxableAmount", json!(to_fixed(t.taxable_amount, 2))),
                ("taxAmount", json!(to_fixed(t.tax_amount, 2))),
                ("currency", json!(t.currency)),
                (
                    "baseTaxableAmount",
                    json!(to_fixed(t.base_taxable_amount, 2)),
                ),
                ("baseTaxAmount", json!(to_fixed(t.base_tax_amount, 2))),
                ("contactId", opt(&t.contact_id)),
            ] {
                row.insert(key.to_owned(), value);
            }
            row
        })
        .collect()
}

async fn insert_tax_rows(db: &PgPool, rows: &[Map<String, Value>]) -> Result<(), sqlx::Error> {
    let rows = rows.to_vec();
    weldsuite_db::atomically_with::<_, (), sqlx::Error, _>(db, move |conn| {
        Box::pin(async move {
            for row in &rows {
                TAX_LINES
                    .insert_raw(&mut *conn, TAX_LINES.values(row))
                    .await?;
            }
            Ok(())
        })
    })
    .await
}

async fn journal_entries_with_tax_lines(
    db: &PgPool,
    ids: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query_scalar(
        "select distinct journal_entry_id from tax_lines where journal_entry_id = any($1)",
    )
    .bind(ids)
    .fetch_all(db)
    .await
}

async fn items_of(db: &PgPool, invoice: bool, id: &str) -> Result<Vec<Value>, sqlx::Error> {
    if invoice {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            crate::books_row!(invoice_items),
            " from invoice_items t where t.invoice_id = $1 and t.deleted_at is null"
        ))
        .bind(id)
        .fetch_all(db)
        .await?;
        Ok(INVOICE_ITEMS.js_rows(rows))
    } else {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            crate::books_row!(bill_items),
            " from bill_items t where t.bill_id = $1 and t.deleted_at is null"
        ))
        .bind(id)
        .fetch_all(db)
        .await?;
        Ok(BILL_ITEMS.js_rows(rows))
    }
}

/// Was this credit note posted like an invoice (receivable debited)?
async fn credit_note_has_invoice_sign(
    db: &PgPool,
    journal_entry_id: &str,
) -> Result<bool, sqlx::Error> {
    let entry: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select status, posting_key from journal_entries where id = $1 limit 1")
            .bind(journal_entry_id)
            .fetch_optional(db)
            .await?;
    // Entries from the posting service carry a key and the right sign.
    let Some((status, posting_key)) = entry else {
        return Ok(false);
    };
    if posting_key.is_some_and(|k| !k.is_empty()) || status.as_deref() != Some("posted") {
        return Ok(false);
    }
    let lines: Vec<(Option<String>, Option<Value>, Option<String>)> = sqlx::query_as(
        "select jl.debit::text, a.metadata, a.code from journal_lines jl \
         inner join accounts a on jl.account_id = a.id where jl.journal_entry_id = $1",
    )
    .bind(journal_entry_id)
    .fetch_all(db)
    .await?;
    Ok(lines.iter().any(|(debit, metadata, code)| {
        let debit = debit.as_deref().map_or(0.0, |d| numeric(&json!(d)));
        let role = metadata
            .as_ref()
            .and_then(|m| m.get("systemRole"))
            .and_then(Value::as_str);
        debit > 0.0 && (role == Some("accounts_receivable") || code.as_deref() == Some("1300"))
    }))
}

/// `invoice.issueDate.toISOString().slice(0, 10)`.
fn day_of(row: &Value, key: &str) -> String {
    text(row, key)
        .and_then(|d| d.get(..10))
        .unwrap_or_default()
        .to_owned()
}

/// 1 + 2: tax ledger for posted invoices, and credit notes posted with the wrong sign.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
async fn catch_up_posted_invoices(ctx: &mut Ctx<'_>) -> Result<(), PostError> {
    let db = ctx.db;
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(invoices),
        " from invoices t where t.entity_id = $1 and t.deleted_at is null \
          and t.journal_entry_id is not null order by t.issue_date asc"
    ))
    .bind(ctx.entity_id)
    .fetch_all(db)
    .await?;
    let posted = INVOICES.js_rows(rows);
    let entry_ids: Vec<String> = posted
        .iter()
        .filter_map(|i| owned(i, "journalEntryId"))
        .collect();
    let with_tax = journal_entries_with_tax_lines(db, &entry_ids).await?;

    for invoice in posted {
        let id = text(&invoice, "id").unwrap_or_default().to_owned();
        let entry_id = text(&invoice, "journalEntryId")
            .unwrap_or_default()
            .to_owned();
        let credit_note = text(&invoice, "type") == Some("credit_note");
        let items = items_of(db, true, &id).await?;

        if credit_note && credit_note_has_invoice_sign(db, &entry_id).await? {
            let corrected = async {
                let today = now();
                ctx.check_locks(&today, PostingLockKind::Sales, true)
                    .await?;
                if ctx.dry_run {
                    build_invoice_posting(db, ctx.http, &invoice, &items).await?;
                } else {
                    let number = text(&invoice, "invoiceNumber").unwrap_or(&id);
                    reverse_journal_entry(
                        db,
                        ReverseArgs {
                            entry_id: entry_id.clone(),
                            date: today.clone(),
                            created_by: ctx.user_id.clone(),
                            lock_kind: Some(PostingLockKind::Sales),
                            description: Some(format!("Correct sign of credit note {number}")),
                            ..ReverseArgs::default()
                        },
                    )
                    .await?;
                    // Post the credit note correctly; it replaces the reversed entry on the document.
                    let mut replaced = invoice.clone();
                    if let Some(object) = replaced.as_object_mut() {
                        object.insert("journalEntryId".to_owned(), Value::Null);
                        object.insert("issueDate".to_owned(), json!(today));
                    }
                    post_invoice(
                        db,
                        ctx.http,
                        &replaced,
                        &items,
                        PostInvoiceOptions {
                            user_id: ctx.user_id.clone(),
                            keep_status: true,
                            ..PostInvoiceOptions::default()
                        },
                    )
                    .await?;
                }
                Ok::<(), PostError>(())
            }
            .await;
            match corrected {
                Ok(()) => ctx.result.credit_notes_corrected += 1,
                Err(error) => {
                    let number = owned(&invoice, "invoiceNumber");
                    ctx.skip(error, "credit_note", &id, number)?;
                }
            }
            continue;
        }

        if with_tax.contains(&entry_id) {
            continue;
        }
        let built = build_invoice_posting(db, ctx.http, &invoice, &items).await?;
        let rows = tax_rows_for(
            &built.tax_lines,
            ctx.entity_id,
            if credit_note {
                "credit_note"
            } else {
                "invoice"
            },
            &id,
            &entry_id,
            &day_of(&invoice, "issueDate"),
        );
        if rows.is_empty() {
            continue;
        }
        if !ctx.dry_run {
            insert_tax_rows(db, &rows).await?;
        }
        ctx.result.tax_lines += i64::try_from(rows.len()).unwrap_or(0);
    }
    Ok(())
}

/// 1: tax ledger for posted manual journal entries (reversals mirror their original).
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
async fn catch_up_manual_entries(ctx: &mut Ctx<'_>) -> Result<(), PostError> {
    let db = ctx.db;
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(journal_entries),
        " from journal_entries t where t.entity_id = $1 and t.deleted_at is null \
          and t.status in ('posted', 'reversed') and t.posting_key is null \
          and coalesce(t.source_type, 'manual') = 'manual' order by t.date asc"
    ))
    .bind(ctx.entity_id)
    .fetch_all(db)
    .await?;
    let entries = JOURNAL_ENTRIES.js_rows(rows);
    let ids: Vec<String> = entries.iter().filter_map(|e| owned(e, "id")).collect();
    let with_tax = journal_entries_with_tax_lines(db, &ids).await?;

    let rate_rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(tax_rates),
        " from tax_rates t where t.entity_id = $1"
    ))
    .bind(ctx.entity_id)
    .fetch_all(db)
    .await?;
    let rates = TAX_RATES.js_rows(rate_rows);
    let mut rows_by_entry: Vec<(String, Vec<Map<String, Value>>)> = Vec::new();

    for entry in entries {
        let id = text(&entry, "id").unwrap_or_default().to_owned();
        if with_tax.contains(&id) {
            continue;
        }
        let tax_date = day_of(&entry, "date");
        let rows = if let Some(original_id) = filled(&entry, "reversalOfId") {
            let Some((_, original)) = rows_by_entry.iter().find(|(key, _)| key == original_id)
            else {
                continue;
            };
            original
                .iter()
                .map(|r| {
                    let mut row = r.clone();
                    row.insert("id".to_owned(), json!(generate_id("txl")));
                    row.insert("journalEntryId".to_owned(), json!(id));
                    row.insert("taxDate".to_owned(), json!(tax_date));
                    for key in [
                        "taxableAmount",
                        "taxAmount",
                        "baseTaxableAmount",
                        "baseTaxAmount",
                    ] {
                        let value = numeric(r.get(key).unwrap_or(&Value::Null));
                        row.insert(key.to_owned(), json!(to_fixed(-value, 2)));
                    }
                    row
                })
                .collect()
        } else {
            let line_rows: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                crate::books_row!(journal_lines),
                " from journal_lines t where t.journal_entry_id = $1 and t.deleted_at is null"
            ))
            .bind(&id)
            .fetch_all(db)
            .await?;
            let mut tax_lines = Vec::new();
            for line in JOURNAL_LINES.js_rows(line_rows) {
                let Some(rate) = filled(&line, "taxRateId")
                    .and_then(|rate_id| rates.iter().find(|r| text(r, "id") == Some(rate_id)))
                else {
                    continue;
                };
                let debit = numeric(line.get("debit").unwrap_or(&Value::Null));
                let credit = numeric(line.get("credit").unwrap_or(&Value::Null));
                let tax = numeric(line.get("taxAmount").unwrap_or(&Value::Null)).abs();
                let taxable = math_round(((credit - debit).abs() - tax) * 100.0) / 100.0;
                tax_lines.push(PostingTaxLine {
                    source_line_id: owned(&line, "id"),
                    direction: if credit > debit { "sales" } else { "purchase" }.to_owned(),
                    tax_rate_id: owned(rate, "id"),
                    tax_rate_name: owned(rate, "name"),
                    tax_category_code: owned(rate, "taxCategoryCode"),
                    rate: numeric(rate.get("rate").unwrap_or(&Value::Null)),
                    taxable_amount: taxable,
                    tax_amount: tax,
                    currency: owned(&line, "currency").unwrap_or_else(|| "EUR".to_owned()),
                    base_taxable_amount: taxable,
                    base_tax_amount: tax,
                    contact_id: owned(&line, "contactId"),
                    ..PostingTaxLine::default()
                });
            }
            tax_rows_for(&tax_lines, ctx.entity_id, "journal", &id, &id, &tax_date)
        };
        let count = rows.len();
        rows_by_entry.push((id, rows.clone()));
        if count == 0 {
            continue;
        }
        if !ctx.dry_run {
            insert_tax_rows(db, &rows).await?;
        }
        ctx.result.tax_lines += i64::try_from(count).unwrap_or(0);
    }
    Ok(())
}

/// 3: invoices sent or paid without being finalized.
async fn catch_up_unposted_invoices(ctx: &mut Ctx<'_>) -> Result<(), PostError> {
    let db = ctx.db;
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(invoices),
        " from invoices t where t.entity_id = $1 and t.deleted_at is null \
          and t.journal_entry_id is null and t.status = any($2) and t.type not in ('proforma') \
          order by t.issue_date asc"
    ))
    .bind(ctx.entity_id)
    .bind(&UNPOSTED_INVOICE_STATUSES[..])
    .fetch_all(db)
    .await?;
    for invoice in INVOICES.js_rows(rows) {
        let id = text(&invoice, "id").unwrap_or_default().to_owned();
        let booked = async {
            let items = items_of(db, true, &id).await?;
            if ctx.dry_run {
                let built = build_invoice_posting(db, ctx.http, &invoice, &items).await?;
                let date = text(&invoice, "issueDate").unwrap_or_default();
                ctx.check_locks(date, PostingLockKind::Sales, !built.tax_lines.is_empty())
                    .await?;
            } else {
                post_invoice(
                    db,
                    ctx.http,
                    &invoice,
                    &items,
                    PostInvoiceOptions {
                        user_id: ctx.user_id.clone(),
                        keep_status: true,
                        ..PostInvoiceOptions::default()
                    },
                )
                .await?;
            }
            Ok::<(), PostError>(())
        }
        .await;
        match booked {
            Ok(()) => ctx.result.invoices += 1,
            Err(error) => {
                let kind = if text(&invoice, "type") == Some("credit_note") {
                    "credit_note"
                } else {
                    "invoice"
                };
                ctx.skip(error, kind, &id, owned(&invoice, "invoiceNumber"))?;
            }
        }
    }
    Ok(())
}

/// 3: bills approved or paid without being posted.
async fn catch_up_unposted_bills(ctx: &mut Ctx<'_>) -> Result<(), PostError> {
    let db = ctx.db;
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(bills),
        " from bills t where t.entity_id = $1 and t.deleted_at is null \
          and t.journal_entry_id is null and t.status = any($2) order by t.issue_date asc"
    ))
    .bind(ctx.entity_id)
    .bind(&UNPOSTED_BILL_STATUSES[..])
    .fetch_all(db)
    .await?;
    for bill in BILLS.js_rows(rows) {
        let id = text(&bill, "id").unwrap_or_default().to_owned();
        let booked = async {
            let items = items_of(db, false, &id).await?;
            if ctx.dry_run {
                let built = build_bill_posting(db, ctx.http, &bill, &items).await?;
                let date = text(&bill, "issueDate").unwrap_or_default();
                ctx.check_locks(date, PostingLockKind::Purchase, !built.tax_lines.is_empty())
                    .await?;
            } else {
                post_bill(db, ctx.http, &bill, &items, ctx.user_id.clone(), true).await?;
            }
            Ok::<(), PostError>(())
        }
        .await;
        match booked {
            Ok(()) => ctx.result.bills += 1,
            Err(error) => ctx.skip(error, "bill", &id, owned(&bill, "billNumber"))?,
        }
    }
    Ok(())
}

/// 4: payments that never reached the ledger. Their documents are already settled.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
async fn catch_up_unposted_payments(ctx: &mut Ctx<'_>) -> Result<(), PostError> {
    let db = ctx.db;
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(payments),
        " from payments t where t.entity_id = $1 and t.deleted_at is null \
          and t.journal_entry_id is null order by t.date asc"
    ))
    .bind(ctx.entity_id)
    .fetch_all(db)
    .await?;
    for payment in PAYMENTS.js_rows(rows) {
        let id = text(&payment, "id").unwrap_or_default().to_owned();
        let booked = async {
            let received = text(&payment, "type") != Some("sent");
            let amount = amount_of(&payment, "amount");
            let invoice_id = owned(&payment, "invoiceId");
            let bill_id = owned(&payment, "billId");
            let has_document = invoice_id
                .as_deref()
                .or(bill_id.as_deref())
                .is_some_and(|d| !d.is_empty());
            let contact_id = owned(&payment, "contactId").unwrap_or_default();
            let allocations = if has_document {
                vec![PaymentAllocationInput {
                    invoice_id: invoice_id.clone(),
                    bill_id: bill_id.clone(),
                    amount,
                    contact_id: contact_id.clone(),
                }]
            } else {
                Vec::new()
            };
            let reference = owned(&payment, "reference");
            let lines = build_payment_posting(
                db,
                &PaymentPostingInput {
                    entity_id: ctx.entity_id.to_owned(),
                    received,
                    amount,
                    currency: owned(&payment, "currency"),
                    exchange_rate: owned(&payment, "exchangeRate"),
                    contact_id,
                    bank_account_id: owned(&payment, "bankAccountId"),
                    payment_method: owned(&payment, "paymentMethod"),
                    reference: reference.clone(),
                    ..PaymentPostingInput::default()
                },
                &allocations,
            )
            .await?;
            let date = text(&payment, "date").unwrap_or_default().to_owned();
            if ctx.dry_run {
                ctx.check_locks(&date, PostingLockKind::General, false)
                    .await?;
                return Ok::<(), PostError>(());
            }
            let at = now();
            let mut set = Map::new();
            set.insert("journalEntryId".to_owned(), Value::Null);
            set.insert("updatedAt".to_owned(), json!(at));
            let mut also_write = vec![update_with_entry(
                &PAYMENTS,
                id.clone(),
                set,
                Some("journalEntryId"),
            )];
            if has_document {
                let mut allocation = Map::new();
                for (key, value) in [
                    ("id", json!(generate_id("pal"))),
                    ("entityId", json!(ctx.entity_id)),
                    ("paymentId", json!(id)),
                    ("invoiceId", json!(invoice_id)),
                    ("billId", json!(bill_id)),
                    ("amount", json!(to_fixed(amount, 2))),
                    ("createdAt", json!(at)),
                    ("updatedAt", json!(at)),
                ] {
                    allocation.insert(key.to_owned(), value);
                }
                also_write.push(Box::new(move |conn, _posted| {
                    Box::pin(async move {
                        PAYMENT_ALLOCATIONS
                            .insert_raw(&mut *conn, PAYMENT_ALLOCATIONS.values(&allocation))
                            .await?;
                        Ok(())
                    })
                }));
            }
            let label = if received {
                "Payment received"
            } else {
                "Payment sent"
            };
            let suffix = reference
                .as_deref()
                .filter(|r| !r.is_empty())
                .map(|r| format!(" {r}"))
                .unwrap_or_default();
            post_journal_entry(
                db,
                PostJournalEntryInput {
                    entity_id: ctx.entity_id.to_owned(),
                    date,
                    description: format!("{label}{suffix}"),
                    reference,
                    source_type: "payment".to_owned(),
                    source_id: Some(id.clone()),
                    posting_key: Some(format!("payment:{id}")),
                    lock_kind: Some(PostingLockKind::General),
                    lines,
                    created_by: ctx.user_id.clone(),
                    also_write,
                    ..PostJournalEntryInput::default()
                },
            )
            .await?;
            Ok(())
        }
        .await;
        match booked {
            Ok(()) => ctx.result.payments += 1,
            Err(error) => ctx.skip(error, "payment", &id, owned(&payment, "reference"))?,
        }
    }
    Ok(())
}

/// 5: bank lines matched to a document before a match recorded a payment.
async fn catch_up_matched_bank_lines(ctx: &mut Ctx<'_>) -> Result<(), PostError> {
    let db = ctx.db;
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(bank_transactions),
        " from bank_transactions t where t.entity_id = $1 and t.deleted_at is null \
          and t.status = 'reconciled' and t.reconciled_payment_id is null and t.journal_entry_id is null \
          and (t.reconciled_invoice_id is not null or t.reconciled_bill_id is not null) \
          order by t.date asc"
    ))
    .bind(ctx.entity_id)
    .fetch_all(db)
    .await?;
    for txn in BANK_TRANSACTIONS.js_rows(rows) {
        let id = text(&txn, "id").unwrap_or_default().to_owned();
        let invoice = filled(&txn, "reconciledInvoiceId").is_some();
        let document_id = owned(&txn, "reconciledInvoiceId")
            .or_else(|| owned(&txn, "reconciledBillId"))
            .unwrap_or_default();
        let booked = async {
            let doc: Option<(String, Option<String>, Option<String>)> = if invoice {
                sqlx::query_as(
                    "select id, contact_id, balance_due::text from invoices where id = $1 limit 1",
                )
            } else {
                sqlx::query_as(
                    "select id, contact_id, balance_due::text from bills where id = $1 limit 1",
                )
            }
            .bind(&document_id)
            .fetch_optional(db)
            .await?;
            let open = doc
                .as_ref()
                .and_then(|(_, _, balance)| balance.as_deref())
                .map_or(0.0, crate::js::parse_float);
            let Some((doc_id, contact_id, _)) = doc.filter(|_| open > 0.0) else {
                return Ok::<bool, PostError>(false);
            };
            let date = text(&txn, "date").unwrap_or_default().to_owned();
            if ctx.dry_run {
                ctx.check_locks(&date, PostingLockKind::General, false)
                    .await?;
            } else {
                let amount = amount_of(&txn, "amount").abs();
                let allocation = AllocationInput {
                    invoice_id: invoice.then(|| doc_id.clone()),
                    bill_id: (!invoice).then(|| doc_id.clone()),
                    amount: amount.min(open),
                };
                record_payment(
                    db,
                    ctx.http,
                    RecordPaymentInput {
                        entity_id: ctx.entity_id.to_owned(),
                        received: invoice,
                        amount,
                        date,
                        payment_method: Some("bank_transfer".to_owned()),
                        reference: owned(&txn, "reference").or_else(|| owned(&txn, "description")),
                        contact_id,
                        bank_account_id: owned(&txn, "bankAccountId"),
                        bank_transaction_id: Some(id.clone()),
                        allocations: vec![allocation],
                        user_id: ctx.user_id.clone(),
                        ..RecordPaymentInput::default()
                    },
                )
                .await?;
            }
            Ok(true)
        }
        .await;
        match booked {
            Ok(true) => ctx.result.bank_transactions += 1,
            Ok(false) => ctx.result.skipped.push(Skipped {
                kind: "bank_transaction",
                id: id.clone(),
                number: owned(&txn, "reference"),
                reason: "The matched document has no open balance (a payment was probably recorded by hand). Check the line and unreconcile it if needed.".to_owned(),
            }),
            Err(error) => ctx.skip(error, "bank_transaction", &id, owned(&txn, "reference"))?,
        }
    }
    Ok(())
}

/// `runPostingCatchUp(db, entityId, opts)`.
pub async fn run_posting_catch_up(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    entity_id: &str,
    dry_run: bool,
    user_id: Option<String>,
) -> Result<CatchUpResult, PostError> {
    let mut ctx = Ctx {
        db,
        http,
        entity_id,
        dry_run,
        user_id,
        result: CatchUpResult {
            dry_run,
            ..CatchUpResult::default()
        },
    };
    catch_up_posted_invoices(&mut ctx).await?;
    catch_up_manual_entries(&mut ctx).await?;
    catch_up_unposted_invoices(&mut ctx).await?;
    catch_up_unposted_bills(&mut ctx).await?;
    catch_up_unposted_payments(&mut ctx).await?;
    catch_up_matched_bank_lines(&mut ctx).await?;
    Ok(ctx.result)
}
