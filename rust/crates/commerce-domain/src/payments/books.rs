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

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{BinOper, Expr, ExprTrait, Func, Query};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
    QueryTrait, RuntimeErr,
};
use sqlx::PgPool;
use time::PrimitiveDateTime;
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_ports::BoxFuture;
use weldsuite_schema::tenant::{
    commerce_payments, commerce_refunds, commerce_settings, orders, parties, people,
};

use crate::db;
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

/// A failed statement in words, as the messages kept on the order put it:
/// sqlx's own text when sqlx ran the statement.
fn says(error: &DbErr) -> String {
    match error {
        DbErr::Conn(RuntimeErr::SqlxError(inner))
        | DbErr::Exec(RuntimeErr::SqlxError(inner))
        | DbErr::Query(RuntimeErr::SqlxError(inner)) => inner.to_string(),
        other => other.to_string(),
    }
}

/// The seller's entity (see `vat`).
///
/// # Errors
/// A failed statement.
pub async fn seller_entity(db: &PgPool) -> Result<Option<String>, DbErr> {
    let mut conn = db.acquire().await.map_err(db::from_sqlx)?;
    crate::vat::seller_entity_id(&mut conn).await
}

/// `commerce_settings.auto_invoice` (on when there is no row).
async fn auto_invoice(db: &PgPool) -> Result<bool, DbErr> {
    let on: Option<bool> = commerce_settings::Entity::find()
        .select_only()
        .column(commerce_settings::Column::AutoInvoice)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(on.unwrap_or(true))
}

async fn set_error(db: &PgPool, order_id: &str, error: Option<&str>) {
    let update = orders::Entity::update_many().filter(orders::Column::Id.eq(order_id));
    let update = match error {
        Some(error) => update.col_expr(
            orders::Column::Metadata,
            Expr::cust_with_values(
                "jsonb_set(coalesce(\"metadata\", '{}'::jsonb), '{invoiceError}', to_jsonb($1::text))",
                [error.chars().take(500).collect::<String>()],
            ),
        ),
        // `metadata - 'invoiceError'` where `metadata ? 'invoiceError'`.
        None => update
            .col_expr(
                orders::Column::Metadata,
                Expr::col(orders::Column::Metadata).sub("invoiceError"),
            )
            .filter(
                Expr::col((orders::Entity, orders::Column::Metadata))
                    .binary(BinOper::Custom("?"), "invoiceError"),
            ),
    };
    if let Err(failure) = update.exec(&orm(db)).await {
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
    let failed = |error: DbErr| format!("The customer could not be prepared: {}", says(&error));
    let mut tx = actor
        .db
        .begin()
        .await
        .map_err(|error| failed(db::from_sqlx(error)))?;
    let order: Option<(
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = orders::Entity::find_by_id(order_id)
        .filter(orders::Column::DeletedAt.is_null())
        .select_only()
        .columns([
            orders::Column::CounterpartyId,
            orders::Column::PersonId,
            orders::Column::CustomerName,
            orders::Column::CustomerEmail,
        ])
        .lock_exclusive()
        .into_tuple()
        .one(&db::on(&mut tx))
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
            let found: Option<String> = people::Entity::find()
                .select_only()
                .column(people::Column::Id)
                .filter(
                    Func::lower(Expr::col((people::Entity, people::Column::Email)))
                        .eq(Func::lower(Expr::val(email))),
                )
                .filter(people::Column::DeletedAt.is_null())
                .order_by_asc(people::Column::CreatedAt)
                .into_tuple()
                .one(&db::on(&mut tx))
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
                    people::Entity::insert(people::ActiveModel {
                        id: Set(id.clone()),
                        display_name: Set(display.to_owned()),
                        full_name: Set(Some(display.to_owned())),
                        email: Set(Some(email.to_owned())),
                        in_crm: Set(false),
                        source: Set(Some("weldcommerce".to_owned())),
                        owner_id: Set(Some(actor.user_id.to_owned())),
                        ..Default::default()
                    })
                    .exec_without_returning(&db::on(&mut tx))
                    .await
                    .map_err(failed)?;
                    id
                }
            }
        }
    };
    let party: Option<String> = parties::Entity::find()
        .select_only()
        .column(parties::Column::Id)
        .filter(parties::Column::PersonId.eq(person.as_str()))
        .filter(parties::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&db::on(&mut tx))
        .await
        .map_err(failed)?;
    let party = match party {
        Some(party) => party,
        None => {
            let id = generate_id("party");
            // `insert … select` from the person, so the address is copied as
            // stored (and no person means no party).
            let person_row = people::Entity::find_by_id(person.as_str())
                .select_only()
                .expr(Expr::val(id.as_str()))
                .expr(Expr::val("person"))
                .column(people::Column::Id)
                .expr(Expr::val("customer"))
                .column(people::Column::DisplayName)
                .column(people::Column::PrimaryAddress)
                .column(people::Column::ArchivedAt)
                .expr(Expr::val(actor.user_id))
                .into_query();
            let insert = Query::insert()
                .into_table(parties::Entity)
                .columns([
                    parties::Column::Id,
                    parties::Column::Kind,
                    parties::Column::PersonId,
                    parties::Column::Role,
                    parties::Column::DisplayName,
                    parties::Column::BillingAddress,
                    parties::Column::ArchivedAt,
                    parties::Column::OwnerId,
                ])
                .select_from(person_row)
                .map_err(|error| failed(DbErr::Custom(error.to_string())))?
                .to_owned();
            db::on(&mut tx).execute(&insert).await.map_err(failed)?;
            id
        }
    };
    orders::Entity::update_many()
        .col_expr(orders::Column::PersonId, Expr::value(person.as_str()))
        .col_expr(orders::Column::CounterpartyId, Expr::value(party.as_str()))
        .col_expr(orders::Column::UpdatedAt, Expr::value(db::now()))
        .filter(orders::Column::Id.eq(order_id))
        .exec(&db::on(&mut tx))
        .await
        .map_err(failed)?;
    tx.commit()
        .await
        .map_err(|error| failed(db::from_sqlx(error)))
}

/// A `timestamp` as Postgres writes it into JSON: `2026-11-21T10:00:00`,
/// then the microseconds without trailing zeros (none when zero).
fn json_time(at: PrimitiveDateTime) -> String {
    let base = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    );
    let micros = at.microsecond();
    if micros == 0 {
        return base;
    }
    let fraction = format!("{micros:06}");
    format!("{base}.{}", fraction.trim_end_matches('0'))
}

/// What the order's paid payments come to, as the payment to record.
async fn paid_facts(db: &PgPool, order_id: &str) -> Result<Option<PaymentFacts>, DbErr> {
    let rows = commerce_payments::Entity::find()
        .filter(commerce_payments::Column::OrderId.eq(order_id))
        .filter(commerce_payments::Column::Status.eq("paid"))
        .order_by_asc(commerce_payments::Column::PaidAt)
        .order_by_asc(commerce_payments::Column::Id)
        .all(&orm(db))
        .await?;
    let Some(last) = rows.last() else {
        return Ok(None);
    };
    let amount: Cents = rows.iter().map(|row| db::cents(&row.amount)).sum();
    Ok(Some(PaymentFacts {
        amount,
        currency: last.currency.clone(),
        method: last.method.clone(),
        reference: last.provider_payment_id.clone(),
        paid_at: last.paid_at.map(|at| format!("{}Z", json_time(at))),
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
                .map_err(|e| format!("settings: {}", says(&e)))?
        {
            return Ok(None);
        }
        let entity = seller_entity(actor.db)
            .await
            .map_err(|e| format!("seller entity: {}", says(&e)))?
            .ok_or_else(|| "No seller entity is set up in WeldBooks".to_owned())?;
        ensure_customer(actor, order_id).await?;
        let payment = if paid {
            Some(
                paid_facts(actor.db, order_id)
                    .await
                    .map_err(|e| format!("payments: {}", says(&e)))?
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
    let refund = commerce_refunds::Entity::find_by_id(refund_id)
        .one(&orm(actor.db))
        .await
        .map_err(|e| format!("refund: {}", says(&e)))?;
    let Some(refund) = refund else {
        return Ok(None);
    };
    if refund.status != "refunded" || refund.credit_note_id.is_some() {
        return Ok(None);
    }
    let order_id = refund.order_id;
    if !force
        && !auto_invoice(actor.db)
            .await
            .map_err(|e| format!("settings: {}", says(&e)))?
    {
        return Ok(None);
    }
    // The credit note needs the invoice: make it when it is not there yet.
    let invoice = invoice_order(books, actor, &order_id, true, true)
        .await?
        .ok_or_else(|| "The order has no invoice".to_owned())?;
    let entity = seller_entity(actor.db)
        .await
        .map_err(|e| format!("seller entity: {}", says(&e)))?
        .ok_or_else(|| "No seller entity is set up in WeldBooks".to_owned())?;
    let made = books
        .credit_note(&CreditNoteRequest {
            actor,
            order_id: &order_id,
            refund_id,
            invoice_id: &invoice.id,
            entity_id: &entity,
            amount: db::cents(&refund.amount),
            currency: &refund.currency,
            reason: refund.reason.as_deref(),
            reference: refund.provider_refund_id.as_deref(),
        })
        .await;
    match made {
        Ok(note) => {
            commerce_refunds::Entity::update_many()
                .col_expr(
                    commerce_refunds::Column::CreditNoteId,
                    Expr::value(note.id.as_str()),
                )
                .col_expr(commerce_refunds::Column::UpdatedAt, Expr::value(db::now()))
                .filter(commerce_refunds::Column::Id.eq(refund_id))
                .exec(&orm(actor.db))
                .await
                .map_err(|e| format!("refund: {}", says(&e)))?;
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
