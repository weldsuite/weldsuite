//! Applying a credit note to an invoice of the same customer
//! (`services/accounting-credit-notes.ts`). Both documents already sit in
//! receivables, so applying posts nothing: it lowers the open balance of both
//! by the same amount, at most the smaller of the two.

use serde_json::Value;
use weldsuite_books_domain::http::now;
use weldsuite_books_domain::js::{self, round_money, to_fixed};
use weldsuite_books_domain::posting::PostError;
use weldsuite_db::PgPool;

use crate::finalize::load_invoice;
use crate::persist::{owned, text};

/// Invoice statuses that still have an open balance a credit note can lower.
const OPEN_STATUSES: [&str; 4] = ["sent", "finalized", "partial", "overdue"];

/// `CreditApplication`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CreditApplication {
    pub credit_note_id: String,
    pub invoice_id: String,
    pub amount: f64,
}

impl CreditApplication {
    /// As JSON (`amount` a number, as the object TypeScript returns).
    pub(crate) fn to_json(&self) -> Value {
        serde_json::json!({
            "creditNoteId": self.credit_note_id,
            "invoiceId": self.invoice_id,
            "amount": js::number_value(self.amount),
        })
    }
}

fn posting(message: impl Into<String>) -> PostError {
    PostError::Posting(message.into())
}

fn name_of(doc: &Value) -> String {
    owned(doc, "invoiceNumber")
        .or_else(|| owned(doc, "id"))
        .unwrap_or_default()
}

/// `applyCreditNote(db, creditNoteId, opts)`: apply a finalized credit note
/// to an open invoice of the same customer (the one it credits unless
/// `invoice_id` names another). `None` when nothing is left to apply.
pub(crate) async fn apply_credit_note(
    db: &PgPool,
    credit_note_id: &str,
    invoice_id: Option<&str>,
    amount: Option<f64>,
) -> Result<Option<CreditApplication>, PostError> {
    let Some(note) = load_invoice(db, credit_note_id).await? else {
        return Err(posting("Credit note not found"));
    };
    if text(&note, "type") != Some("credit_note") {
        return Err(posting(format!("{} is not a credit note", name_of(&note))));
    }
    if !js::truthy(note.get("journalEntryId")) {
        return Err(posting("Finalize the credit note before applying it"));
    }
    let Some(invoice_id) = invoice_id
        .map(str::to_owned)
        .or_else(|| owned(&note, "creditNoteForInvoiceId"))
        .filter(|id| !id.is_empty())
    else {
        return Err(posting("Choose the invoice to apply the credit note to"));
    };
    let Some(invoice) = load_invoice(db, &invoice_id).await? else {
        return Err(posting("Invoice not found"));
    };
    if !matches!(text(&invoice, "type"), Some("standard" | "correction")) {
        return Err(posting(format!(
            "A credit note can only be applied to an invoice, not to {}",
            name_of(&invoice)
        )));
    }
    if text(&invoice, "entityId") != text(&note, "entityId") {
        return Err(posting(
            "The invoice belongs to a different accounting entity",
        ));
    }
    if text(&invoice, "contactId") != text(&note, "contactId") {
        return Err(posting("The invoice belongs to a different customer"));
    }
    if text(&invoice, "currency").unwrap_or_default() != text(&note, "currency").unwrap_or_default()
    {
        return Err(posting(
            "The invoice and the credit note are in different currencies",
        ));
    }

    let note_open = js::parse_float(text(&note, "balanceDue").unwrap_or("0"));
    let invoice_open = if OPEN_STATUSES.contains(&text(&invoice, "status").unwrap_or_default()) {
        js::parse_float(text(&invoice, "balanceDue").unwrap_or("0"))
    } else {
        0.0
    };
    let available = round_money(note_open.min(invoice_open));
    if let Some(amount) = amount
        && amount > available + 0.005
    {
        return Err(posting(format!(
            "At most {} of this credit note can be applied to {}",
            to_fixed(available, 2),
            name_of(&invoice)
        )));
    }
    let amount = round_money(amount.unwrap_or(available));
    if amount.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return Ok(None);
    }

    // One statement settles both or neither; the guard locks both rows and
    // matches only while each still has the amount open.
    let note_id = text(&note, "id").unwrap_or_default().to_owned();
    let settled: Vec<String> = sqlx::query_scalar(
        "update invoices set \
         amount_paid = (coalesce(invoices.amount_paid, '0')::numeric + $1::numeric), \
         balance_due = greatest((coalesce(invoices.total, '0')::numeric - (coalesce(invoices.amount_paid, '0')::numeric + $1::numeric)), 0), \
         status = case when (coalesce(invoices.total, '0')::numeric - (coalesce(invoices.amount_paid, '0')::numeric + $1::numeric)) <= 0.005 then 'paid' \
           when (coalesce(invoices.amount_paid, '0')::numeric + $1::numeric) <= 0.005 then \
             case when invoices.due_date < now() then 'overdue' when invoices.sent_at is not null then 'sent' else 'finalized' end \
           else 'partial' end, \
         paid_at = case when (coalesce(invoices.total, '0')::numeric - (coalesce(invoices.amount_paid, '0')::numeric + $1::numeric)) <= 0.005 then now() else null end, \
         updated_at = $2::timestamp \
         from (select credit_note_row.id as note_id from invoices credit_note_row \
           inner join invoices credited_invoice_row on credited_invoice_row.id = $4 \
           where credit_note_row.id = $3 and credit_note_row.deleted_at is null \
             and credited_invoice_row.deleted_at is null \
             and credit_note_row.balance_due::numeric >= $5::numeric \
             and credited_invoice_row.balance_due::numeric >= $5::numeric \
           for update) credit_guard \
         where invoices.id = any($6) returning invoices.id",
    )
    .bind(to_fixed(amount, 2))
    .bind(now())
    .bind(&note_id)
    .bind(&invoice_id)
    .bind(to_fixed(amount - 0.005, 3))
    .bind(vec![note_id.clone(), invoice_id.clone()])
    .fetch_all(db)
    .await?;
    if settled.len() != 2 {
        return Err(posting(
            "The credit note or the invoice changed while the credit was being applied; nothing was applied. Reload and try again.",
        ));
    }
    Ok(Some(CreditApplication {
        credit_note_id: note_id,
        invoice_id,
        amount,
    }))
}

/// `applyCreditNoteOnFinalize(db, creditNoteId)`: never a posting error; a
/// credit note that can't be applied stays open as credit.
pub(crate) async fn apply_credit_note_on_finalize(
    db: &PgPool,
    credit_note_id: &str,
) -> Result<Option<CreditApplication>, PostError> {
    match apply_credit_note(db, credit_note_id, None, None).await {
        Err(PostError::Posting(_)) => Ok(None),
        other => other,
    }
}
