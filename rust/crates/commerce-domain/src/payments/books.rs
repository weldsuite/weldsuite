//! The WeldBooks side of payments (ADR COM-013): a paid order becomes a
//! finalised invoice with its payment recorded, a refund that reached
//! `refunded` becomes a credit note against it, and a pay-on-invoice order
//! gets a finalised, unpaid invoice when it is placed.
//!
//! Module crates never depend on each other, so WeldCommerce reaches
//! WeldBooks through the [`Invoicing`] port; `weldsuite-books-sales`
//! implements it (it depends on this crate, not the other way round) and the
//! server hands the implementation to the commerce module.
//!
//! **Invoicing never undoes a payment.** A failure is logged, kept on the
//! order as `metadata.invoiceError` and answered to whoever asked; the
//! `/api/orders/:id/invoice` route runs it again. All of this is idempotent:
//! an order with an invoice already is not invoiced twice.

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_ports::BoxFuture;

use super::{cents, text};
use crate::money::{self, Cents};

/// The invoice of an order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvoiceRef {
    pub id: String,
    pub number: String,
    pub status: String,
}

/// A credit note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreditNoteRef {
    pub id: String,
    pub number: String,
}

/// What was paid, for the payment WeldBooks records.
#[derive(Debug, Clone)]
pub struct PaymentFacts {
    pub amount: Cents,
    pub currency: String,
    pub method: Option<String>,
    pub reference: Option<String>,
    /// ISO timestamp.
    pub paid_at: Option<String>,
}

/// Who WeldBooks acts for.
#[derive(Debug, Clone, Copy)]
pub struct Actor<'a> {
    pub db: &'a PgPool,
    /// `workspaces.id`.
    pub workspace_id: &'a str,
    pub clerk_org_id: Option<&'a str>,
    pub user_id: &'a str,
}

/// An invoice to make for an order.
pub struct InvoiceRequest<'a> {
    pub actor: Actor<'a>,
    pub order_id: &'a str,
    /// The seller's accounting entity.
    pub entity_id: &'a str,
    /// Paid: the payment to record on the invoice. `None`: an unpaid invoice
    /// (pay on invoice).
    pub payment: Option<PaymentFacts>,
}

/// A credit note for a refund.
pub struct CreditNoteRequest<'a> {
    pub actor: Actor<'a>,
    pub order_id: &'a str,
    /// The refund the credit note is for; it tags the note, so a retry
    /// resumes from the note it made instead of making a second one.
    pub refund_id: &'a str,
    pub invoice_id: &'a str,
    pub entity_id: &'a str,
    pub amount: Cents,
    pub currency: &'a str,
    pub reason: Option<&'a str>,
    pub reference: Option<&'a str>,
}

/// WeldBooks, as WeldCommerce needs it.
pub trait Invoicing: Send + Sync {
    /// A finalised invoice for the order, found if the order has one
    /// already; with `payment`, the payment recorded on it (once).
    fn invoice_order<'a>(
        &'a self,
        request: &'a InvoiceRequest<'a>,
    ) -> BoxFuture<'a, Result<InvoiceRef, String>>;

    /// A finalised credit note against the invoice for `amount`, with the
    /// refund recorded.
    fn credit_note<'a>(
        &'a self,
        request: &'a CreditNoteRequest<'a>,
    ) -> BoxFuture<'a, Result<CreditNoteRef, String>>;
}

/// The seller's entity (see `vat`).
///
/// # Errors
/// A failed statement.
pub async fn seller_entity(db: &PgPool) -> Result<Option<String>, crate::DbErr> {
    let mut conn = db.acquire().await.map_err(crate::db::from_sqlx)?;
    crate::vat::seller_entity_id(&mut conn).await
}

/// `commerce_settings.auto_invoice` (on when there is no row).
async fn auto_invoice(db: &PgPool) -> Result<bool, sqlx::Error> {
    let on: Option<bool> = sqlx::query_scalar("select auto_invoice from commerce_settings limit 1")
        .fetch_optional(db)
        .await?;
    Ok(on.unwrap_or(true))
}

async fn set_error(db: &PgPool, order_id: &str, error: Option<&str>) {
    let result = match error {
        Some(error) => {
            sqlx::query(
                "update orders set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), \
                   '{invoiceError}', to_jsonb($2::text)) where id = $1",
            )
            .bind(order_id)
            .bind(error.chars().take(500).collect::<String>())
            .execute(db)
            .await
        }
        None => {
            sqlx::query(
                "update orders set metadata = metadata - 'invoiceError' \
                 where id = $1 and metadata ? 'invoiceError'",
            )
            .bind(order_id)
            .execute(db)
            .await
        }
    };
    if let Err(failure) = result {
        tracing::error!(%failure, order_id, "[commerce] could not record the invoicing outcome");
    }
}

/// The order's buyer as a CRM person and party, made when the order has
/// none (a guest checkout): found by email, else created with
/// `in_crm = false` (ADR COM-012), so the invoice has a customer.
///
/// # Errors
/// A message when the order names nobody to invoice.
#[allow(
    clippy::single_match_else,
    clippy::type_complexity,
    clippy::too_many_lines,
    reason = "look up, then create, person and party"
)]
pub async fn ensure_customer(actor: Actor<'_>, order_id: &str) -> Result<(), String> {
    let failed = |error: sqlx::Error| format!("The customer could not be prepared: {error}");
    let mut tx = actor.db.begin().await.map_err(failed)?;
    let order: Option<(
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "select counterparty_id, person_id, customer_name, customer_email \
             from orders where id = $1 and deleted_at is null for update",
    )
    .bind(order_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    let Some((counterparty, person, name, email)) = order else {
        return Err("The order was not found".to_owned());
    };
    if counterparty.is_some() {
        return Ok(());
    }
    let person = match person {
        Some(person) => person,
        None => {
            let Some(email) = email.as_deref().filter(|e| !e.trim().is_empty()) else {
                return Err("The order has no customer to invoice: no email address".to_owned());
            };
            let found: Option<String> = sqlx::query_scalar(
                "select id from people where lower(email) = lower($1) and deleted_at is null \
                 order by created_at asc limit 1",
            )
            .bind(email)
            .fetch_optional(&mut *tx)
            .await
            .map_err(failed)?;
            match found {
                Some(id) => id,
                None => {
                    let id = generate_id("per");
                    let display = name
                        .as_deref()
                        .filter(|n| !n.trim().is_empty())
                        .unwrap_or(email);
                    sqlx::query(
                        "insert into people (id, display_name, full_name, email, in_crm, source, owner_id) \
                         values ($1, $2, $2, $3, false, 'weldcommerce', $4)",
                    )
                    .bind(&id)
                    .bind(display)
                    .bind(email)
                    .bind(actor.user_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(failed)?;
                    id
                }
            }
        }
    };
    let party: Option<String> = sqlx::query_scalar(
        "select id from parties where person_id = $1 and deleted_at is null limit 1",
    )
    .bind(&person)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    let party = match party {
        Some(party) => party,
        None => {
            let id = generate_id("party");
            sqlx::query(
                "insert into parties (id, kind, person_id, role, display_name, billing_address, \
                   archived_at, owner_id) \
                 select $1, 'person', p.id, 'customer', p.display_name, p.primary_address, \
                   p.archived_at, $3 from people p where p.id = $2",
            )
            .bind(&id)
            .bind(&person)
            .bind(actor.user_id)
            .execute(&mut *tx)
            .await
            .map_err(failed)?;
            id
        }
    };
    sqlx::query(
        "update orders set person_id = $2, counterparty_id = $3, \
           updated_at = now() at time zone 'utc' where id = $1",
    )
    .bind(order_id)
    .bind(&person)
    .bind(&party)
    .execute(&mut *tx)
    .await
    .map_err(failed)?;
    tx.commit().await.map_err(failed)
}

/// What the order's paid payments come to, as the payment to record.
async fn paid_facts(db: &PgPool, order_id: &str) -> Result<Option<PaymentFacts>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {} from commerce_payments where order_id = $1 and status = 'paid' \
         order by paid_at asc, id asc",
        super::PAYMENT_ROW
    )))
    .bind(order_id)
    .fetch_all(db)
    .await?;
    let Some(last) = rows.last() else {
        return Ok(None);
    };
    let amount: Cents = rows.iter().map(|row| cents(row, "amount")).sum();
    Ok(Some(PaymentFacts {
        amount,
        currency: text(last, "currency").unwrap_or("EUR").to_owned(),
        method: text(last, "method").map(str::to_owned),
        reference: text(last, "providerPaymentId").map(str::to_owned),
        paid_at: text(last, "paidAt").map(|t| format!("{t}Z")),
    }))
}

/// The invoice of a paid order (`paid`), or the unpaid one of an order placed
/// on invoice (`!paid`). `force` ignores `auto_invoice` (the retry route).
/// `Ok(None)` when automatic invoicing is off.
///
/// # Errors
/// The message of what went wrong; it is also kept on the order as
/// `metadata.invoiceError`.
pub async fn invoice_order(
    books: &dyn Invoicing,
    actor: Actor<'_>,
    order_id: &str,
    paid: bool,
    force: bool,
) -> Result<Option<InvoiceRef>, String> {
    let run = async {
        if !force
            && !auto_invoice(actor.db)
                .await
                .map_err(|e| format!("settings: {e}"))?
        {
            return Ok(None);
        }
        let entity = seller_entity(actor.db)
            .await
            .map_err(|e| format!("seller entity: {e}"))?
            .ok_or_else(|| "No seller entity is set up in WeldBooks".to_owned())?;
        ensure_customer(actor, order_id).await?;
        let payment = if paid {
            Some(
                paid_facts(actor.db, order_id)
                    .await
                    .map_err(|e| format!("payments: {e}"))?
                    .ok_or_else(|| "The order has no paid payment".to_owned())?,
            )
        } else {
            None
        };
        books
            .invoice_order(&InvoiceRequest {
                actor,
                order_id,
                entity_id: &entity,
                payment,
            })
            .await
            .map(Some)
    };
    match run.await {
        Ok(invoice) => {
            if invoice.is_some() {
                set_error(actor.db, order_id, None).await;
            }
            Ok(invoice)
        }
        Err(message) => {
            tracing::error!(%message, order_id, "[commerce] invoicing failed");
            set_error(actor.db, order_id, Some(&message)).await;
            Err(message)
        }
    }
}

/// The credit note of a refund that reached `refunded`, linked in
/// `commerce_refunds.credit_note_id`. Made once: a refund with a credit note
/// is left alone.
///
/// # Errors
/// As [`invoice_order`].
pub async fn credit_refund(
    books: &dyn Invoicing,
    actor: Actor<'_>,
    refund_id: &str,
    force: bool,
) -> Result<Option<CreditNoteRef>, String> {
    let refund: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {} from commerce_refunds where id = $1",
        super::REFUND_ROW
    )))
    .bind(refund_id)
    .fetch_optional(actor.db)
    .await
    .map_err(|e| format!("refund: {e}"))?;
    let Some(refund) = refund else {
        return Ok(None);
    };
    if text(&refund, "status") != Some("refunded") || text(&refund, "creditNoteId").is_some() {
        return Ok(None);
    }
    let order_id = text(&refund, "orderId").unwrap_or_default().to_owned();
    if !force
        && !auto_invoice(actor.db)
            .await
            .map_err(|e| format!("settings: {e}"))?
    {
        return Ok(None);
    }
    // The credit note needs the invoice: make it when it is not there yet.
    let invoice = invoice_order(books, actor, &order_id, true, true)
        .await?
        .ok_or_else(|| "The order has no invoice".to_owned())?;
    let entity = seller_entity(actor.db)
        .await
        .map_err(|e| format!("seller entity: {e}"))?
        .ok_or_else(|| "No seller entity is set up in WeldBooks".to_owned())?;
    let currency = text(&refund, "currency").unwrap_or("EUR").to_owned();
    let reason = text(&refund, "reason").map(str::to_owned);
    let reference = text(&refund, "providerRefundId").map(str::to_owned);
    let made = books
        .credit_note(&CreditNoteRequest {
            actor,
            order_id: &order_id,
            refund_id,
            invoice_id: &invoice.id,
            entity_id: &entity,
            amount: cents(&refund, "amount"),
            currency: &currency,
            reason: reason.as_deref(),
            reference: reference.as_deref(),
        })
        .await;
    match made {
        Ok(note) => {
            sqlx::query(
                "update commerce_refunds set credit_note_id = $2, \
                   updated_at = now() at time zone 'utc' where id = $1",
            )
            .bind(refund_id)
            .bind(&note.id)
            .execute(actor.db)
            .await
            .map_err(|e| format!("refund: {e}"))?;
            set_error(actor.db, &order_id, None).await;
            Ok(Some(note))
        }
        Err(message) => {
            tracing::error!(%message, order_id, "[commerce] credit note failed");
            set_error(actor.db, &order_id, Some(&message)).await;
            Err(message)
        }
    }
}

/// Formats an amount for a message.
#[must_use]
pub fn amount_text(amount: Cents) -> String {
    money::format(amount)
}
