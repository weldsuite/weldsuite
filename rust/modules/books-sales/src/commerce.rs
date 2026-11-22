//! WeldBooks for WeldCommerce's payments (ADR COM-013): the implementation
//! of `weldsuite_commerce_domain::payments::books::Invoicing`.
//!
//! - **An invoice for an order**: the draft is made by the from-order route's
//!   own code (`invoices::from_order`: the order's lines, rates and VAT
//!   treatment, as COM-014 priced them), finalised (posted) like
//!   `POST /:id/finalize`, and a paid order's payment is recorded against it
//!   like `POST /:id/record-payment`. An order that has an invoice already
//!   is not invoiced twice, and a payment is recorded once, so every step is
//!   safe to run again.
//! - **A credit note for a refund**: the credit note of the invoice
//!   (`create_credit_note`), scaled down to the refunded amount when the
//!   refund is partial (every line and the VAT in proportion, to the cent),
//!   finalised, and the refund recorded as a payment out against it.
//!
//! WeldCommerce (the module crate) does not depend on this crate; the server
//! hands it a [`CommerceInvoicing`].

use std::str::FromStr;

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use weldsuite_books_domain::http::{BooksState, Caller, now};
use weldsuite_books_domain::js;
use weldsuite_books_domain::payments::{AllocationInput, RecordPaymentInput, record_payment};
use weldsuite_catalogs::entity_events::{INVOICE_UPDATED, PAYMENT_CREATED};
use weldsuite_commerce_domain::money::{self, Cents};
use weldsuite_commerce_domain::payments::books::{
    Actor, CreditNoteRef, CreditNoteRequest, InvoiceRef, InvoiceRequest, Invoicing, PaymentFacts,
};
use weldsuite_db::{OrmConn, PgPool, orm, utc_now};
use weldsuite_ports::BoxFuture;
use weldsuite_schema::tenant::{invoice_items, invoices};

use crate::errors::SalesError;
use crate::finalize::{FinalizeOptions, finalize_invoice, load_invoice, load_items};
use crate::invoices::actions::create_credit_note;
use crate::invoices::from_order::from_order;
use crate::invoices::{event_data, write::runtime};
use crate::persist::{owned, text};

/// WeldBooks as WeldCommerce's invoicing.
#[derive(Clone)]
pub struct CommerceInvoicing {
    state: BooksState,
}

impl CommerceInvoicing {
    #[must_use]
    pub fn new(state: BooksState) -> Self {
        Self { state }
    }

    fn caller(&self, actor: Actor<'_>, entity_id: &str) -> Caller {
        Caller::in_process(
            actor.db.clone(),
            actor.workspace_id,
            actor.clerk_org_id.unwrap_or(actor.workspace_id),
            actor.user_id,
            entity_id,
            self.state.http.clone(),
        )
    }
}

fn failed(error: impl Into<SalesError>) -> String {
    error.into().message()
}

fn as_f64(cents: Cents) -> f64 {
    #[allow(clippy::cast_precision_loss)]
    let value = cents as f64 / 100.0;
    value
}

fn cents_of(value: Option<&Value>) -> Cents {
    value
        .and_then(Value::as_str)
        .and_then(money::parse)
        .or_else(|| {
            value
                .and_then(Value::as_f64)
                .and_then(|n| money::parse(&format!("{n:.2}")))
        })
        .unwrap_or(0)
}

impl CommerceInvoicing {
    #[allow(clippy::single_match_else, reason = "find the invoice, else make it")]
    async fn invoice(&self, request: &InvoiceRequest<'_>) -> Result<InvoiceRef, String> {
        let caller = self.caller(request.actor, request.entity_id);
        let db = request.actor.db;
        let existing: Option<String> = invoices::Entity::find()
            .select_only()
            .column(invoices::Column::Id)
            .filter(invoices::Column::CommerceOrderId.eq(request.order_id))
            .filter(invoices::Column::Type.eq("standard"))
            .filter(invoices::Column::DeletedAt.is_null())
            .filter(invoices::Column::Status.is_not_in(["cancelled", "void", "written_off"]))
            .order_by_asc(invoices::Column::CreatedAt)
            .into_tuple()
            .one(&orm(db))
            .await
            .map_err(failed)?;
        let id = match existing {
            Some(id) => id,
            None => {
                let made = from_order(&caller, &self.state, request.order_id)
                    .await
                    .map_err(|e| e.message())?;
                made["invoiceId"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "The invoice could not be made".to_owned())?
            }
        };
        let rt = runtime(&caller, &self.state);
        let invoice = load_invoice(db, &id)
            .await
            .map_err(failed)?
            .ok_or_else(|| "The invoice was not found".to_owned())?;
        if text(&invoice, "status") == Some("draft") {
            finalize_invoice(
                db,
                &id,
                FinalizeOptions {
                    user_id: Some(request.actor.user_id.to_owned()),
                    mark_sent: false,
                    runtime: &rt,
                    http: rt.http.as_ref(),
                },
            )
            .await
            .map_err(|e| e.message())?;
            caller.publish(
                &self.state,
                INVOICE_UPDATED,
                &id,
                event_data(&invoice, &json!("finalized")),
            );
        }
        if let Some(payment) = &request.payment {
            self.record_once(&caller, request, &id, payment).await?;
        }
        let invoice = load_invoice(db, &id)
            .await
            .map_err(failed)?
            .ok_or_else(|| "The invoice was not found".to_owned())?;
        Ok(InvoiceRef {
            id,
            number: owned(&invoice, "invoiceNumber").unwrap_or_default(),
            status: owned(&invoice, "status").unwrap_or_default(),
        })
    }

    /// The order's payment on its invoice, once.
    async fn record_once(
        &self,
        caller: &Caller,
        request: &InvoiceRequest<'_>,
        invoice_id: &str,
        payment: &PaymentFacts,
    ) -> Result<(), String> {
        let db = request.actor.db;
        let invoice = load_invoice(db, invoice_id)
            .await
            .map_err(failed)?
            .ok_or_else(|| "The invoice was not found".to_owned())?;
        if cents_of(invoice.get("amountPaid")) >= payment.amount {
            return Ok(());
        }
        let amount = as_f64(payment.amount - cents_of(invoice.get("amountPaid")));
        let result = record_payment(
            db,
            caller.http(&self.state).as_ref(),
            RecordPaymentInput {
                entity_id: request.entity_id.to_owned(),
                received: true,
                amount,
                currency: Some(payment.currency.clone()),
                date: payment.paid_at.clone().unwrap_or_else(now),
                payment_method: Some(
                    payment
                        .method
                        .clone()
                        .unwrap_or_else(|| "mollie".to_owned()),
                ),
                reference: payment.reference.clone(),
                contact_id: owned(&invoice, "contactId"),
                allocations: vec![AllocationInput {
                    invoice_id: Some(invoice_id.to_owned()),
                    bill_id: None,
                    amount,
                }],
                user_id: Some(request.actor.user_id.to_owned()),
                ..RecordPaymentInput::default()
            },
        )
        .await
        .map_err(failed)?;
        caller.publish(
            &self.state,
            PAYMENT_CREATED,
            &result.payment_id,
            json!({
                "id": result.payment_id,
                "invoiceId": invoice_id,
                "amount": money::format(payment.amount),
                "method": payment.method,
            }),
        );
        Ok(())
    }

    async fn credit(&self, request: &CreditNoteRequest<'_>) -> Result<CreditNoteRef, String> {
        let caller = self.caller(request.actor, request.entity_id);
        let db = request.actor.db;
        let invoice = load_invoice(db, request.invoice_id)
            .await
            .map_err(failed)?
            .ok_or_else(|| "The invoice was not found".to_owned())?;
        // One credit note per refund, tagged with it in its internal notes
        // (never printed; `reference` keeps the order number the customer
        // sees): a retry after a failure part-way resumes from that note.
        let tag = format!("WeldCommerce refund {}", request.refund_id);
        let earlier = tagged_credit_note(db, request.invoice_id, &tag)
            .await
            .map_err(failed)?;
        let note_id = match earlier {
            // Finalised already: at most the payment out is missing.
            Some((id, status)) if status != "draft" => id,
            earlier => {
                // A draft left by a failed run may be scaled already: make
                // it again from the invoice rather than scale it twice.
                if let Some((draft, _)) = earlier {
                    // `now() at time zone 'utc'`: the database's clock.
                    let db_now = || {
                        Func::cust("timezone")
                            .arg("utc")
                            .arg(Expr::current_timestamp())
                    };
                    invoices::Entity::update_many()
                        .col_expr(invoices::Column::DeletedAt, db_now().into())
                        .col_expr(invoices::Column::UpdatedAt, db_now().into())
                        .filter(invoices::Column::Id.eq(draft))
                        .filter(invoices::Column::Status.eq("draft"))
                        .exec(&orm(db))
                        .await
                        .map_err(failed)?;
                }
                self.make_credit_note(&caller, request, &invoice, &tag)
                    .await?
            }
        };
        // The money going back out of the books, once.
        let note = load_invoice(db, &note_id)
            .await
            .map_err(failed)?
            .ok_or_else(|| "The credit note was not found".to_owned())?;
        if cents_of(note.get("amountPaid")) >= request.amount {
            return Ok(CreditNoteRef {
                number: owned(&note, "invoiceNumber").unwrap_or_default(),
                id: note_id,
            });
        }
        let amount = as_f64(request.amount - cents_of(note.get("amountPaid")));
        let result = record_payment(
            db,
            caller.http(&self.state).as_ref(),
            RecordPaymentInput {
                entity_id: request.entity_id.to_owned(),
                received: false,
                amount,
                currency: Some(request.currency.to_owned()),
                date: now(),
                payment_method: Some("mollie".to_owned()),
                reference: request.reference.map(str::to_owned),
                notes: request.reason.map(str::to_owned),
                contact_id: owned(&note, "contactId"),
                allocations: vec![AllocationInput {
                    invoice_id: Some(note_id.clone()),
                    bill_id: None,
                    amount,
                }],
                user_id: Some(request.actor.user_id.to_owned()),
                ..RecordPaymentInput::default()
            },
        )
        .await
        .map_err(failed)?;
        caller.publish(
            &self.state,
            PAYMENT_CREATED,
            &result.payment_id,
            json!({
                "id": result.payment_id,
                "invoiceId": note_id,
                "amount": money::format(request.amount),
            }),
        );
        Ok(CreditNoteRef {
            number: owned(&note, "invoiceNumber").unwrap_or_default(),
            id: note_id,
        })
    }

    /// A new credit note for `request`: tagged right away, scaled down to a
    /// partial refund, then finalised. Its id.
    async fn make_credit_note(
        &self,
        caller: &Caller,
        request: &CreditNoteRequest<'_>,
        invoice: &Value,
        tag: &str,
    ) -> Result<String, String> {
        let db = request.actor.db;
        let made = create_credit_note(caller, &self.state, request.invoice_id)
            .await
            .map_err(|e| e.message())?;
        let note_id = made["id"]
            .as_str()
            .ok_or_else(|| "The credit note could not be made".to_owned())?
            .to_owned();
        // `concat_ws(E'\n', nullif(internal_notes, ''), tag)`: the tag on a
        // line of its own after any notes the invoice had.
        let notes = Func::cust("concat_ws")
            .arg("\n")
            .arg(
                Func::cust("nullif")
                    .arg(Expr::col(invoices::Column::InternalNotes))
                    .arg(""),
            )
            .arg(tag);
        invoices::Entity::update_many()
            .col_expr(invoices::Column::InternalNotes, notes.into())
            .filter(invoices::Column::Id.eq(note_id.as_str()))
            .exec(&orm(db))
            .await
            .map_err(failed)?;
        let invoice_total = cents_of(invoice.get("total"));
        if request.amount > 0 && request.amount < invoice_total {
            scale_draft(db, &note_id, request.amount, invoice_total).await?;
        }
        let rt = runtime(caller, &self.state);
        finalize_invoice(
            db,
            &note_id,
            FinalizeOptions {
                user_id: Some(request.actor.user_id.to_owned()),
                mark_sent: false,
                runtime: &rt,
                http: rt.http.as_ref(),
            },
        )
        .await
        .map_err(|e| e.message())?;
        Ok(note_id)
    }
}

impl Invoicing for CommerceInvoicing {
    fn invoice_order<'a>(
        &'a self,
        request: &'a InvoiceRequest<'a>,
    ) -> BoxFuture<'a, Result<InvoiceRef, String>> {
        Box::pin(self.invoice(request))
    }

    fn credit_note<'a>(
        &'a self,
        request: &'a CreditNoteRequest<'a>,
    ) -> BoxFuture<'a, Result<CreditNoteRef, String>> {
        Box::pin(self.credit(request))
    }
}

// ── a partial credit note ───────────────────────────────────────────────────

/// A draft credit note (a full copy of its invoice) brought down to `refund`
/// of the invoice's `invoice_total`: each line's amount, with its VAT, in
/// proportion, so the lines add up to the refund to the cent.
async fn scale_draft(
    db: &PgPool,
    note_id: &str,
    refund: Cents,
    invoice_total: Cents,
) -> Result<(), String> {
    let note = load_invoice(db, note_id)
        .await
        .map_err(failed)?
        .ok_or_else(|| "The credit note was not found".to_owned())?;
    let items = load_items(db, note_id, true).await.map_err(failed)?;
    let gross: Vec<Cents> = items
        .iter()
        .map(|item| cents_of(item.get("lineTotalWithTax")))
        .collect();
    let scaled = money::allocate(refund, &gross);
    let mut tx = db.begin().await.map_err(failed)?;
    let conn = OrmConn::new(&mut tx);
    let (mut net_sum, mut tax_sum) = (0, 0);
    for (index, item) in items.iter().enumerate() {
        let new_gross = scaled[index];
        let old_gross = gross[index];
        let old_tax = cents_of(item.get("taxAmount"));
        let tax = if old_gross > 0 {
            money::div_round(old_tax * new_gross, old_gross)
        } else {
            0
        };
        let net = new_gross - tax;
        net_sum += net;
        tax_sum += tax;
        let quantity = js::parse_float(item["quantity"].as_str().unwrap_or("1")).max(0.0001);
        let unit = format!("{:.4}", as_f64(net) / quantity);
        invoice_items::Entity::update_many()
            .col_expr(invoice_items::Column::UnitPrice, numeric(&unit)?)
            .col_expr(
                invoice_items::Column::LineTotal,
                numeric(&money::format(net))?,
            )
            .col_expr(
                invoice_items::Column::TaxAmount,
                numeric(&money::format(tax))?,
            )
            .col_expr(
                invoice_items::Column::LineTotalWithTax,
                numeric(&money::format(new_gross))?,
            )
            .col_expr(invoice_items::Column::DiscountPercent, Expr::value(0))
            .col_expr(invoice_items::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(invoice_items::Column::Id.eq(item["id"].as_str()))
            .exec(&conn)
            .await
            .map_err(failed)?;
    }
    let breakdown = scaled_breakdown(
        note.get("taxBreakdown"),
        refund,
        invoice_total,
        net_sum,
        tax_sum,
    );
    scale_invoice(&conn, note_id, (net_sum, tax_sum, refund), breakdown)
        .await
        .map_err(failed)?;
    tx.commit().await.map_err(failed)
}

/// The credit note's totals after scaling: `(net, tax, total)` in cents, the
/// total open in full, and its VAT rows.
async fn scale_invoice<C: ConnectionTrait>(
    db: &C,
    note_id: &str,
    (net, tax, total): (Cents, Cents, Cents),
    breakdown: Value,
) -> Result<(), DbErr> {
    let total = amount(&money::format(total))?;
    invoices::Entity::update_many()
        .col_expr(
            invoices::Column::Subtotal,
            Expr::value(amount(&money::format(net))?),
        )
        .col_expr(invoices::Column::DiscountTotal, Expr::value(0))
        .col_expr(
            invoices::Column::TaxTotal,
            Expr::value(amount(&money::format(tax))?),
        )
        .col_expr(invoices::Column::Total, Expr::value(total.clone()))
        .col_expr(invoices::Column::BalanceDue, Expr::value(total))
        // A JSON `null` stays the jsonb `null` it was bound as.
        .col_expr(invoices::Column::TaxBreakdown, Expr::value(breakdown))
        .col_expr(invoices::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(invoices::Column::Id.eq(note_id))
        .exec(db)
        .await?;
    Ok(())
}

/// An amount the route formats as text (`$n::numeric`), as the exact
/// decimal it reads as; text that is not one fails as Postgres refuses it.
fn amount(text: &str) -> Result<BigDecimal, DbErr> {
    BigDecimal::from_str(text)
        .map_err(|_| DbErr::Custom(format!("invalid input syntax for type numeric: \"{text}\"")))
}

/// [`amount`] as the value a column is set to.
fn numeric(text: &str) -> Result<Expr, String> {
    amount(text).map(Expr::value).map_err(failed)
}

/// The latest live credit note of `invoice_id` whose internal notes carry
/// `tag` (`position(tag in coalesce(internal_notes, '')) > 0`): its id and
/// status.
async fn tagged_credit_note(
    db: &PgPool,
    invoice_id: &str,
    tag: &str,
) -> Result<Option<(String, String)>, DbErr> {
    let notes = Func::coalesce([Expr::col(invoices::Column::InternalNotes), Expr::value("")]);
    let tagged = sea_orm::ExprTrait::gt(Func::cust("strpos").arg(notes).arg(tag), 0);
    invoices::Entity::find()
        .select_only()
        .column(invoices::Column::Id)
        .column(invoices::Column::Status)
        .filter(invoices::Column::CreditNoteForInvoiceId.eq(invoice_id))
        .filter(invoices::Column::DeletedAt.is_null())
        .filter(tagged)
        .order_by_desc(invoices::Column::CreatedAt)
        .into_tuple()
        .one(&orm(db))
        .await
}

/// The VAT rows in proportion; the last row takes the rounding, so the rows
/// add up to the credit note's VAT and taxable amount.
fn scaled_breakdown(
    rows: Option<&Value>,
    refund: Cents,
    invoice_total: Cents,
    net_sum: Cents,
    tax_sum: Cents,
) -> Value {
    let Some(rows) = rows.and_then(Value::as_array).filter(|r| !r.is_empty()) else {
        return rows.cloned().unwrap_or(Value::Null);
    };
    let share = |value: Option<&Value>| money::div_round(cents_of(value) * refund, invoice_total);
    let mut out: Vec<Value> = rows.clone();
    let (mut taxable_left, mut tax_left) = (net_sum, tax_sum);
    let last = out.len() - 1;
    for (index, row) in out.iter_mut().enumerate() {
        let (taxable, tax) = if index == last {
            (taxable_left, tax_left)
        } else {
            (share(row.get("taxableAmount")), share(row.get("taxAmount")))
        };
        taxable_left -= taxable;
        tax_left -= tax;
        row["taxableAmount"] = json!(as_f64(taxable));
        row["taxAmount"] = json!(as_f64(tax));
    }
    Value::Array(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_credit_notes_vat_rows_add_up() {
        let rows = json!([
            { "taxRate": 21.0, "taxableAmount": 10.0, "taxAmount": 2.1 },
            { "taxRate": 9.0, "taxableAmount": 10.0, "taxAmount": 0.9 },
        ]);
        // Half of 23.00 is 11.50: 10.00 net and 1.50 VAT, say.
        let scaled = scaled_breakdown(Some(&rows), 1150, 2300, 1000, 150);
        let taxable: f64 = scaled
            .as_array()
            .expect("rows")
            .iter()
            .map(|r| r["taxableAmount"].as_f64().expect("number"))
            .sum();
        let tax: f64 = scaled
            .as_array()
            .expect("rows")
            .iter()
            .map(|r| r["taxAmount"].as_f64().expect("number"))
            .sum();
        assert!((taxable - 10.0).abs() < 1e-9);
        assert!((tax - 1.5).abs() < 1e-9);
        assert_eq!(scaled[0]["taxRate"], 21.0);
    }

    #[test]
    fn amounts_read_as_cents_from_text_or_numbers() {
        assert_eq!(cents_of(Some(&json!("12.50"))), 1250);
        assert_eq!(cents_of(Some(&json!(12.5))), 1250);
        assert_eq!(cents_of(None), 0);
        assert!((as_f64(1250) - 12.5).abs() < 1e-9);
    }
}
