//! Payments and refunds of an order: creating them at the provider, and the
//! read-back that applies the provider's state to our rows.
//!
//! The provider's state is the truth. A webhook (or a status poll on read)
//! only says "look at this payment": [`read_back`] reads the payment and its
//! refunds from the provider, then [`apply`] writes them in one short
//! transaction: `commerce_payments`, `commerce_refunds`, the order's
//! `payment_status`, and, the first time a payment reads as paid,
//! [`orders::write::mark_paid`]. Applying the same state twice changes
//! nothing, so webhooks may repeat.

use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, ExprTrait, Func, OnConflict};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, QueryTrait, Select, TryInsertResult,
};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use time::format_description::well_known::{Iso8601, Rfc3339};
use time::{Duration, OffsetDateTime, PrimitiveDateTime, UtcOffset};
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{commerce_payments, commerce_refunds, orders as order_rows};

use super::connection::{self, with_provider};
use super::provider::{PaymentRequest, ProviderPayment, ProviderRefund};
use super::{Env, Error, cents, is_open, payment_row, refund_row, text};
use crate::db;
use crate::money::{self, Cents};
use crate::orders;
use crate::orders::write::{self, Payment};

const KNOWN_PAYMENT: [&str; 7] = [
    "open",
    "pending",
    "authorized",
    "paid",
    "failed",
    "canceled",
    "expired",
];
const KNOWN_REFUND: [&str; 6] = [
    "pending",
    "queued",
    "processing",
    "refunded",
    "failed",
    "canceled",
];

fn refund_status(status: &str) -> &str {
    KNOWN_REFUND
        .iter()
        .find(|known| **known == status)
        .copied()
        .unwrap_or("pending")
}

fn final_failure(status: &str) -> bool {
    matches!(status, "failed" | "canceled" | "expired")
}

/// A provider's ISO 8601 time as the `timestamp` (UTC) that
/// `($1::text)::timestamptz at time zone 'utc'` makes of it; a time without
/// an offset is UTC, the connections' time zone.
///
/// # Errors
/// Text that is not a time: the statement Postgres refused.
fn utc_time(text: Option<&str>) -> Result<Option<PrimitiveDateTime>, DbErr> {
    let Some(text) = text else {
        return Ok(None);
    };
    let trimmed = text.trim();
    OffsetDateTime::parse(trimmed, &Rfc3339)
        .or_else(|_| OffsetDateTime::parse(trimmed, &Iso8601::DEFAULT))
        .map(|at| {
            let at = at.to_offset(UtcOffset::UTC);
            PrimitiveDateTime::new(at.date(), at.time())
        })
        .or_else(|_| PrimitiveDateTime::parse(trimmed, &Iso8601::DEFAULT))
        .map(Some)
        .map_err(|_| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp with time zone: \"{text}\""
            ))
        })
}

// ── reading ─────────────────────────────────────────────────────────────────

/// The payments and refunds of an order, oldest first.
///
/// # Errors
/// A failed statement.
pub async fn list(db: &PgPool, order_id: &str) -> Result<(Vec<Value>, Vec<Value>), DbErr> {
    let orm = orm(db);
    let payments = commerce_payments::Entity::find()
        .filter(commerce_payments::Column::OrderId.eq(order_id))
        .order_by_asc(commerce_payments::Column::CreatedAt)
        .order_by_asc(commerce_payments::Column::Id)
        .all(&orm)
        .await?;
    let refunds = commerce_refunds::Entity::find()
        .filter(commerce_refunds::Column::OrderId.eq(order_id))
        .order_by_asc(commerce_refunds::Column::CreatedAt)
        .order_by_asc(commerce_refunds::Column::Id)
        .all(&orm)
        .await?;
    Ok((
        payments.iter().map(payment_row).collect(),
        refunds.iter().map(refund_row).collect(),
    ))
}

/// A payment by its provider's id (`tr_…`).
///
/// # Errors
/// A failed statement.
pub async fn by_provider_id(db: &PgPool, provider_id: &str) -> Result<Option<Value>, DbErr> {
    let found = commerce_payments::Entity::find()
        .filter(commerce_payments::Column::Provider.eq("mollie"))
        .filter(commerce_payments::Column::ProviderPaymentId.eq(provider_id))
        .one(&orm(db))
        .await?;
    Ok(found.as_ref().map(payment_row))
}

/// A payment by our id.
///
/// # Errors
/// A failed statement.
pub async fn by_id(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let found = commerce_payments::Entity::find_by_id(id)
        .one(&orm(db))
        .await?;
    Ok(found.as_ref().map(payment_row))
}

/// The payments of an order still waiting on the shopper for over a minute:
/// the ones a read of the order looks up at the provider (no timer does).
///
/// # Errors
/// A failed statement.
pub async fn stale_open(db: &PgPool, order_id: &str) -> Result<Vec<Value>, DbErr> {
    let before = db::now() - Duration::minutes(1);
    let found = commerce_payments::Entity::find()
        .filter(commerce_payments::Column::OrderId.eq(order_id))
        .filter(commerce_payments::Column::Status.is_in(["open", "pending"]))
        .filter(commerce_payments::Column::ProviderPaymentId.is_not_null())
        .filter(commerce_payments::Column::UpdatedAt.lt(before))
        .order_by_asc(commerce_payments::Column::CreatedAt)
        .all(&orm(db))
        .await?;
    Ok(found.iter().map(payment_row).collect())
}

/// `sum(amount)` of the order's paid payments (null when there is none).
fn paid_sum(order_id: &str) -> Select<commerce_payments::Entity> {
    commerce_payments::Entity::find()
        .select_only()
        .column_as(
            Expr::col((commerce_payments::Entity, commerce_payments::Column::Amount)).sum(),
            "paid",
        )
        .filter(commerce_payments::Column::OrderId.eq(order_id))
        .filter(commerce_payments::Column::Status.eq("paid"))
}

/// What an order has taken and given back: paid payments, and refunds that
/// reached `refunded`.
///
/// # Errors
/// A failed statement.
pub async fn amounts(conn: &mut PgConnection, order_id: &str) -> Result<(Cents, Cents), DbErr> {
    // One statement, so both sums read the same snapshot.
    let refunded = commerce_refunds::Entity::find()
        .select_only()
        .expr(Expr::col((commerce_refunds::Entity, commerce_refunds::Column::Amount)).sum())
        .filter(commerce_refunds::Column::OrderId.eq(order_id))
        .filter(commerce_refunds::Column::Status.eq("refunded"))
        .into_query();
    let sums: Option<(Option<BigDecimal>, Option<BigDecimal>)> = paid_sum(order_id)
        .column_as(Expr::SubQuery(None, Box::new(refunded.into())), "refunded")
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    let (paid, refunded) = sums.unwrap_or_default();
    Ok((
        db::cents_or_zero(paid.as_ref()),
        db::cents_or_zero(refunded.as_ref()),
    ))
}

// ── creating a payment ──────────────────────────────────────────────────────

/// A payment to create for an order.
#[derive(Debug, Clone, Copy)]
pub struct NewOrderPayment<'a> {
    pub order_id: &'a str,
    pub workspace_id: &'a str,
    /// Where the shopper returns after Mollie's page.
    pub redirect_url: &'a str,
    /// The install's public URL: the webhook is
    /// `<public_url>/webhooks/commerce/mollie/<connection id>`.
    pub public_url: &'a str,
    pub locale: Option<&'a str>,
}

/// An order's columns a new payment looks at: number, currency, total,
/// status, payment status, approval status.
type PayableOrder = (
    String,
    Option<String>,
    BigDecimal,
    String,
    Option<String>,
    Option<String>,
);

/// The order's payment state for a new payment: its number, currency, what
/// is outstanding.
async fn payable(db: &PgPool, order_id: &str) -> Result<(String, String, Cents), Error> {
    let orm = orm(db);
    let order: Option<PayableOrder> = order_rows::Entity::find_by_id(order_id)
        .filter(order_rows::Column::DeletedAt.is_null())
        .select_only()
        .columns([
            order_rows::Column::OrderNumber,
            order_rows::Column::Currency,
            order_rows::Column::Total,
            order_rows::Column::Status,
            order_rows::Column::PaymentStatus,
            order_rows::Column::ApprovalStatus,
        ])
        .into_tuple()
        .one(&orm)
        .await?;
    let Some((number, currency, total, status, payment_status, approval)) = order else {
        return Err(Error::NotFound {
            resource: "Order",
            id: order_id.to_owned(),
        });
    };
    let currency = currency.unwrap_or_else(|| "EUR".to_owned());
    let payment_status = payment_status.unwrap_or_else(|| "pending".to_owned());
    if status == "cancelled" {
        return Err(Error::NotPayable("The order is cancelled".to_owned()));
    }
    if approval.as_deref() == Some("pending") {
        return Err(Error::NotPayable(
            "The order is waiting for approval".to_owned(),
        ));
    }
    if payment_status == "on_invoice" {
        return Err(Error::NotPayable("The order is on invoice".to_owned()));
    }
    if crate::status::is_paid(&payment_status) {
        return Err(Error::AlreadyPaid);
    }
    let paid: Option<Option<BigDecimal>> = paid_sum(order_id).into_tuple().one(&orm).await?;
    let outstanding = db::cents(&total) - db::cents_or_zero(paid.flatten().as_ref());
    if outstanding <= 0 {
        return Err(Error::AlreadyPaid);
    }
    Ok((number, currency, outstanding))
}

fn mollie_status(status: &str) -> &str {
    KNOWN_PAYMENT
        .iter()
        .find(|known| **known == status)
        .copied()
        .unwrap_or("open")
}

/// A payment for the order's outstanding amount at the provider, and its
/// row. An open payment of the same amount that is still payable is
/// returned instead of a second one; a retry after a lost answer carries the
/// same idempotency key, so the provider creates the payment once.
///
/// # Errors
/// [`Error::NotConnected`], [`Error::AlreadyPaid`], [`Error::NotPayable`],
/// [`Error::Provider`] when the provider refuses or cannot be reached (the
/// order stays as it was).
#[allow(
    clippy::too_many_lines,
    reason = "reuse, the provider call, then the row and the order"
)]
pub async fn create_for_order(env: &Env<'_>, new: &NewOrderPayment<'_>) -> Result<Value, Error> {
    let (number, currency, outstanding) = payable(env.db, new.order_id).await?;
    let orm = orm(env.db);
    let reusable = commerce_payments::Entity::find()
        .filter(commerce_payments::Column::OrderId.eq(new.order_id))
        .filter(commerce_payments::Column::Status.eq("open"))
        .filter(commerce_payments::Column::CheckoutUrl.is_not_null())
        .filter(commerce_payments::Column::Amount.eq(db::decimal(outstanding)))
        .filter(
            Condition::any()
                .add(commerce_payments::Column::ExpiresAt.is_null())
                .add(commerce_payments::Column::ExpiresAt.gt(db::now())),
        )
        .order_by_desc(commerce_payments::Column::CreatedAt)
        .one(&orm)
        .await?;
    if let Some(payment) = reusable {
        return Ok(payment_row(&payment));
    }
    let attempt = commerce_payments::Entity::find()
        .filter(commerce_payments::Column::OrderId.eq(new.order_id))
        .count(&orm)
        .await?;
    let key = format!("wc-pay-{}-{attempt}", new.order_id);
    if let Some(existing) = commerce_payments::Entity::find()
        .filter(commerce_payments::Column::IdempotencyKey.eq(key.as_str()))
        .one(&orm)
        .await?
    {
        return Ok(payment_row(&existing));
    }

    let active = connection::active(env).await?;
    let webhook = format!(
        "{}/webhooks/commerce/mollie/{}",
        new.public_url.trim_end_matches('/'),
        active.id
    );
    // The shop's return page reads the payment back by its id: it comes back
    // with `?order=<id>&payment=<id>` (the order's is the caller's).
    let id = generate_id("cpay");
    let redirect = weldsuite_mollie::with_query(new.redirect_url, "payment", &id)
        .unwrap_or_else(|| new.redirect_url.to_owned());
    let description = format!("Order {number}");
    let amount_cents = i64::try_from(outstanding)
        .map_err(|_| Error::Provider("The amount is too large".to_owned()))?;
    let request = PaymentRequest {
        amount_cents,
        currency: &currency,
        description: &description,
        redirect_url: &redirect,
        webhook_url: &webhook,
        metadata: json!({ "orderId": new.order_id, "workspace": new.workspace_id }),
        idempotency_key: &key,
        locale: new.locale.map(str::to_owned),
    };
    let created = with_provider!(env, |provider| provider.create_payment(&request));

    // `created_at`, `updated_at` and `amount_refunded` take their defaults.
    let row = commerce_payments::ActiveModel {
        id: Set(id),
        order_id: Set(new.order_id.to_owned()),
        connection_id: Set(Some(active.id.clone())),
        provider: Set("mollie".to_owned()),
        provider_payment_id: Set(Some(created.id.clone())),
        status: Set(mollie_status(&created.status).to_owned()),
        amount: Set(db::decimal(outstanding)),
        currency: Set(currency.clone()),
        method: Set(created.method.clone()),
        checkout_url: Set(created.checkout_url.clone()),
        redirect_url: Set(Some(redirect.clone())),
        testmode: Set(active.testmode),
        provider_data: Set(Some(created.raw.clone())),
        idempotency_key: Set(Some(key.clone())),
        expires_at: Set(utc_time(created.expires_at.as_deref())?),
        ..Default::default()
    };
    // Any unique index (the provider's id, the idempotency key) turns a
    // second insert into nothing: the row that is there is read back below.
    let inserted = commerce_payments::Entity::insert(row)
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .try_insert()
        .exec_with_returning(&orm)
        .await?;
    order_rows::Entity::update_many()
        .col_expr(order_rows::Column::PaymentStatus, Expr::value("pending"))
        .col_expr(order_rows::Column::UpdatedAt, Expr::value(db::now()))
        .filter(order_rows::Column::Id.eq(new.order_id))
        .filter(order_rows::Column::PaymentStatus.eq("failed"))
        .exec(&orm)
        .await?;
    match inserted {
        TryInsertResult::Inserted(row) => Ok(payment_row(&row)),
        TryInsertResult::Empty | TryInsertResult::Conflicted => by_provider_id(env.db, &created.id)
            .await?
            .ok_or_else(|| Error::Provider("The payment could not be stored".to_owned())),
    }
}

// ── the read-back ───────────────────────────────────────────────────────────

/// What applying a provider's state changed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    pub order_id: String,
    pub payment_id: String,
    /// The payment turned paid and the order with it (once).
    pub newly_paid: bool,
    /// The payment's status moved.
    pub status_changed: bool,
    /// Refunds that just reached `refunded`.
    pub refunds_completed: Vec<String>,
    /// The order's `payment_status` or amounts changed.
    pub order_changed: bool,
}

/// Reads `payment` (a payment row as [`by_id`] gives it) and its refunds at
/// the provider and applies them.
///
/// # Errors
/// [`Error::NotConnected`], [`Error::Provider`], a failed statement.
pub async fn read_back(env: &Env<'_>, payment: &Value) -> Result<Applied, Error> {
    let provider_id = text(payment, "providerPaymentId")
        .ok_or_else(|| Error::Provider("The payment has no provider id".to_owned()))?
        .to_owned();
    let read = with_provider!(env, |provider| provider.read_payment(&provider_id));
    let refunds = if read.status == "paid" {
        with_provider!(env, |provider| provider.read_refunds(&provider_id))
    } else {
        Vec::new()
    };
    let mut tx = env.db.begin().await?;
    let applied = apply(
        &mut tx,
        text(payment, "id").unwrap_or_default(),
        &read,
        &refunds,
    )
    .await?;
    tx.commit().await?;
    Ok(applied)
}

/// `at` once `reached`: kept when it is set already.
fn stamped(
    at: Option<PrimitiveDateTime>,
    reached: bool,
    now: PrimitiveDateTime,
) -> Option<PrimitiveDateTime> {
    if reached && at.is_none() {
        Some(now)
    } else {
        at
    }
}

/// Writes the provider's state of one payment: see the module docs.
///
/// # Errors
/// A failed statement.
#[allow(
    clippy::too_many_lines,
    reason = "the payment, its refunds, then the order"
)]
pub async fn apply(
    conn: &mut PgConnection,
    payment_id: &str,
    read: &ProviderPayment,
    refunds: &[ProviderRefund],
) -> Result<Applied, Error> {
    let now = db::now();
    let current = commerce_payments::Entity::find_by_id(payment_id)
        .lock_exclusive()
        .one(&db::on(conn))
        .await?;
    let Some(current) = current else {
        return Err(Error::NotFound {
            resource: "Payment",
            id: payment_id.to_owned(),
        });
    };
    let order_id = current.order_id.clone();
    let old_status = current.status.clone();
    let mut applied = Applied {
        order_id: order_id.clone(),
        payment_id: payment_id.to_owned(),
        ..Applied::default()
    };
    // Paid stays paid: a later "open" read of a paid payment is a stale one.
    let status = if old_status == "paid" {
        "paid"
    } else {
        mollie_status(&read.status)
    };
    let failed = final_failure(status);
    let read_paid_at = utc_time(read.paid_at.as_deref())?;
    let read_expires_at = utc_time(read.expires_at.as_deref())?;
    debug_assert!(money::parse(&current.amount.to_plain_string()).is_some());
    // The row is locked: what it holds now is what the update would see.
    let updated = commerce_payments::ActiveModel {
        id: Unchanged(current.id.clone()),
        status: Set(status.to_owned()),
        method: Set(read.method.clone().or(current.method)),
        checkout_url: Set(if is_open(status) {
            read.checkout_url.clone().or(current.checkout_url)
        } else {
            None
        }),
        failure_reason: Set(if failed {
            read.failure_reason
                .clone()
                .or(current.failure_reason)
                .or_else(|| Some(status.to_owned()))
        } else {
            current.failure_reason
        }),
        paid_at: Set(if status == "paid" && current.paid_at.is_none() {
            Some(read_paid_at.unwrap_or(now))
        } else {
            current.paid_at
        }),
        failed_at: Set(stamped(current.failed_at, status == "failed", now)),
        canceled_at: Set(stamped(current.canceled_at, status == "canceled", now)),
        expired_at: Set(stamped(current.expired_at, status == "expired", now)),
        expires_at: Set(read_expires_at.or(current.expires_at)),
        provider_data: Set(Some(read.raw.clone())),
        updated_at: Set(now),
        ..Default::default()
    }
    .update(&db::on(conn))
    .await?;
    applied.status_changed = status != old_status;

    sync_refunds(
        &mut *conn,
        &order_id,
        payment_id,
        &updated.currency,
        refunds,
        &mut applied,
        now,
    )
    .await?;

    if status == "paid" && old_status != "paid" {
        let paid = Payment {
            paid_at: updated.paid_at.map(super::iso),
            method: read.method.clone(),
            reference: Some(read.id.clone()),
        };
        // The order is paid when the payments that were made come to its
        // total, not when any one of them is paid: a payment is for the
        // amount outstanding when it was created, and the order may have
        // changed since. A smaller payment leaves the order `pending`
        // (`amountPaid` shows it).
        let (taken, _) = amounts(&mut *conn, &order_id).await?;
        let order: Option<(Option<String>, Option<BigDecimal>)> =
            order_rows::Entity::find_by_id(order_id.as_str())
                .select_only()
                .columns([order_rows::Column::PaymentStatus, order_rows::Column::Total])
                .into_tuple()
                .one(&db::on(conn))
                .await?;
        let total = order
            .as_ref()
            .map_or(0, |(_, total)| db::cents_or_zero(total.as_ref()));
        let already_paid = order.as_ref().is_some_and(|(status, _)| {
            crate::status::is_paid(status.as_deref().unwrap_or("pending"))
        });
        if !already_paid && taken >= total {
            match write::mark_paid(&mut *conn, &order_id, &paid).await {
                Ok(()) => {
                    applied.newly_paid = true;
                    applied.order_changed = true;
                }
                // Cancelled meanwhile: the payment is recorded, the order is
                // left alone.
                Err(
                    crate::Error::AlreadyPaid
                    | crate::Error::NotEditable(_)
                    | crate::Error::ApprovalPending,
                ) => {}
                Err(crate::Error::Database(error)) => return Err(Error::Database(error)),
                Err(other) => return Err(Error::Provider(other.to_string())),
            }
        }
        // More was paid than the order is worth (a second payment, or an old
        // link paid after the total changed): recorded, and flagged for staff
        // to refund.
        let over = (taken - total).max(0);
        if over > 0 && order.is_some() {
            order_rows::Entity::update_many()
                .col_expr(
                    order_rows::Column::Metadata,
                    Expr::cust_with_values(
                        "jsonb_set(coalesce(\"metadata\", '{}'::jsonb), '{overpaid}', to_jsonb($1::text))",
                        [money::format(over)],
                    ),
                )
                .col_expr(order_rows::Column::UpdatedAt, Expr::value(now))
                .filter(order_rows::Column::Id.eq(order_id.as_str()))
                .exec(&db::on(conn))
                .await?;
            applied.order_changed = true;
        }
    }
    if failed && applied.status_changed {
        let others_live = commerce_payments::Entity::find()
            .select_only()
            .column(commerce_payments::Column::Id)
            .filter(commerce_payments::Column::OrderId.eq(order_id.as_str()))
            .filter(commerce_payments::Column::Id.ne(payment_id))
            .filter(commerce_payments::Column::Status.is_in([
                "open",
                "pending",
                "authorized",
                "paid",
            ]))
            .into_query();
        let changed = order_rows::Entity::update_many()
            .col_expr(order_rows::Column::PaymentStatus, Expr::value("failed"))
            .col_expr(order_rows::Column::UpdatedAt, Expr::value(now))
            .filter(order_rows::Column::Id.eq(order_id.as_str()))
            .filter(
                Condition::any()
                    .add(order_rows::Column::PaymentStatus.is_null())
                    .add(order_rows::Column::PaymentStatus.eq("pending")),
            )
            .filter(Expr::not_exists(others_live))
            .exec(&db::on(conn))
            .await?
            .rows_affected;
        applied.order_changed |= changed > 0;
    }
    if sync_order_state(&mut *conn, &order_id, now).await? {
        applied.order_changed = true;
    }
    Ok(applied)
}

/// Brings the order's `payment_status` in line with what was paid and
/// refunded; `true` when it moved.
async fn sync_order_state(
    conn: &mut PgConnection,
    order_id: &str,
    now: PrimitiveDateTime,
) -> Result<bool, DbErr> {
    let (paid, refunded) = amounts(&mut *conn, order_id).await?;
    if paid <= 0 {
        return Ok(false);
    }
    let target = if refunded >= paid {
        "refunded"
    } else if refunded > 0 {
        "partially_refunded"
    } else {
        "paid"
    };
    let changed = order_rows::Entity::update_many()
        .col_expr(order_rows::Column::PaymentStatus, Expr::value(target))
        .col_expr(order_rows::Column::UpdatedAt, Expr::value(now))
        .filter(order_rows::Column::Id.eq(order_id))
        .filter(order_rows::Column::PaymentStatus.is_in(["paid", "partially_refunded", "refunded"]))
        .filter(order_rows::Column::PaymentStatus.ne(target))
        .exec(&db::on(conn))
        .await?
        .rows_affected;
    Ok(changed > 0)
}

/// What the payment has been refunded of, counting refunds still on their
/// way (they are spent already).
async fn recount(
    conn: &mut PgConnection,
    payment_id: &str,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    let spent = commerce_refunds::Entity::find()
        .select_only()
        .expr(Func::coalesce([
            Expr::col((commerce_refunds::Entity, commerce_refunds::Column::Amount)).sum(),
            Expr::val(0),
        ]))
        .filter(commerce_refunds::Column::PaymentId.eq(payment_id))
        .filter(commerce_refunds::Column::Status.is_not_in(["failed", "canceled"]))
        .into_query();
    commerce_payments::Entity::update_many()
        .col_expr(commerce_payments::Column::UpdatedAt, Expr::value(now))
        .col_expr(
            commerce_payments::Column::AmountRefunded,
            Expr::SubQuery(None, Box::new(spent.into())),
        )
        .filter(commerce_payments::Column::Id.eq(payment_id))
        .exec(&db::on(conn))
        .await?;
    Ok(())
}

#[allow(
    clippy::single_match_else,
    reason = "update the known refund, else add it"
)]
async fn sync_refunds(
    conn: &mut PgConnection,
    order_id: &str,
    payment_id: &str,
    currency: &str,
    refunds: &[ProviderRefund],
    applied: &mut Applied,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    for refund in refunds {
        let status = refund_status(&refund.status);
        let existing = commerce_refunds::Entity::find()
            .filter(commerce_refunds::Column::Provider.eq("mollie"))
            .filter(commerce_refunds::Column::ProviderRefundId.eq(refund.id.as_str()))
            .lock_exclusive()
            .one(&db::on(conn))
            .await?;
        let id = match existing {
            Some(existing) => {
                if existing.status == status {
                    continue;
                }
                commerce_refunds::ActiveModel {
                    id: Unchanged(existing.id.clone()),
                    status: Set(status.to_owned()),
                    refunded_at: Set(stamped(existing.refunded_at, status == "refunded", now)),
                    failed_at: Set(stamped(
                        existing.failed_at,
                        matches!(status, "failed" | "canceled"),
                        now,
                    )),
                    updated_at: Set(now),
                    ..Default::default()
                }
                .update(&db::on(conn))
                .await?;
                existing.id
            }
            // A refund made in Mollie's dashboard.
            None => {
                let id = generate_id("cref");
                commerce_refunds::Entity::insert(commerce_refunds::ActiveModel {
                    id: Set(id.clone()),
                    order_id: Set(order_id.to_owned()),
                    payment_id: Set(payment_id.to_owned()),
                    provider: Set("mollie".to_owned()),
                    provider_refund_id: Set(Some(refund.id.clone())),
                    status: Set(status.to_owned()),
                    amount: Set(db::decimal(Cents::from(refund.amount_cents))),
                    currency: Set(currency.to_owned()),
                    reason: Set(Some("Refunded in Mollie".to_owned())),
                    refunded_at: Set((status == "refunded").then_some(now)),
                    failed_at: Set(matches!(status, "failed" | "canceled").then_some(now)),
                    ..Default::default()
                })
                .exec_without_returning(&db::on(conn))
                .await?;
                id
            }
        };
        applied.status_changed = true;
        if status == "refunded" {
            applied.refunds_completed.push(id);
        }
    }
    recount(&mut *conn, payment_id, now).await?;
    Ok(())
}

// ── refunds ─────────────────────────────────────────────────────────────────

/// A refund to make.
#[derive(Debug, Clone, Copy)]
pub struct NewRefund<'a> {
    pub order_id: &'a str,
    pub amount: Cents,
    pub reason: Option<&'a str>,
    /// Default: the paid payment with the most left to refund.
    pub payment_id: Option<&'a str>,
    pub created_by: &'a str,
}

/// A refund as made.
#[derive(Debug, Clone)]
pub struct Refunded {
    /// The refund row.
    pub refund: Value,
    pub order_id: String,
    /// It reached `refunded` already (else a webhook will say so).
    pub completed: bool,
    /// The order's `payment_status` moved.
    pub order_changed: bool,
}

/// Refunds `amount` of a paid payment of the order, at the provider.
///
/// The amount is set aside first (a `pending` refund row counts against the
/// payment), so two refunds at once cannot refund more than was paid; the
/// provider is called with no connection held. A refusal marks the row
/// `failed` and frees the amount.
///
/// # Errors
/// [`Error::NothingToRefund`], [`Error::RefundTooLarge`], [`Error::Invalid`],
/// [`Error::NotConnected`], [`Error::Provider`] with the provider's message.
#[allow(
    clippy::too_many_lines,
    reason = "set the amount aside, call the provider, settle"
)]
pub async fn refund(env: &Env<'_>, new: &NewRefund<'_>) -> Result<Refunded, Error> {
    if new.amount <= 0 {
        return Err(Error::Invalid {
            field: "amount".to_owned(),
            message: "Must be more than zero".to_owned(),
        });
    }
    let mut tx = env.db.begin().await?;
    let now = db::now();
    let candidates = commerce_payments::Entity::find()
        .filter(commerce_payments::Column::OrderId.eq(new.order_id))
        .filter(commerce_payments::Column::Status.eq("paid"))
        .apply_if(new.payment_id, |query, id| {
            query.filter(commerce_payments::Column::Id.eq(id))
        })
        .order_by_asc(commerce_payments::Column::CreatedAt)
        .lock_exclusive()
        .all(&db::on(&mut tx))
        .await?;
    let best = candidates
        .iter()
        .map(|payment| {
            let left = db::cents(&payment.amount) - db::cents(&payment.amount_refunded);
            (left, payment)
        })
        .max_by_key(|(left, _)| *left);
    let Some((left, payment)) = best else {
        return Err(Error::NothingToRefund);
    };
    if left <= 0 {
        return Err(Error::NothingToRefund);
    }
    if new.amount > left {
        return Err(Error::RefundTooLarge { refundable: left });
    }
    let (Some(provider_id), Ok(amount_cents)) = (
        payment.provider_payment_id.clone(),
        i64::try_from(new.amount),
    ) else {
        return Err(Error::Provider("The payment has no provider id".to_owned()));
    };
    let (payment_id, currency) = (payment.id.clone(), payment.currency.clone());
    let refund_id = generate_id("cref");
    let key = format!("wc-refund-{refund_id}");
    commerce_refunds::Entity::insert(commerce_refunds::ActiveModel {
        id: Set(refund_id.clone()),
        order_id: Set(new.order_id.to_owned()),
        payment_id: Set(payment_id.clone()),
        provider: Set("mollie".to_owned()),
        status: Set("pending".to_owned()),
        amount: Set(db::decimal(new.amount)),
        currency: Set(currency.clone()),
        reason: Set(new.reason.map(str::to_owned)),
        created_by: Set(Some(new.created_by.to_owned())),
        idempotency_key: Set(Some(key.clone())),
        ..Default::default()
    })
    .exec_without_returning(&db::on(&mut tx))
    .await?;
    recount(&mut tx, &payment_id, now).await?;
    tx.commit().await?;

    let description = new
        .reason
        .map_or_else(|| "Refund".to_owned(), str::to_owned);
    let made: Result<ProviderRefund, Error> = async {
        Ok(with_provider!(env, |provider| provider.create_refund(
            &provider_id,
            amount_cents,
            &currency,
            &description,
            &key
        )))
    }
    .await;
    let mut tx = env.db.begin().await?;
    let now = db::now();
    match made {
        Ok(made) => {
            let status = refund_status(&made.status);
            commerce_refunds::Entity::update_many()
                .col_expr(
                    commerce_refunds::Column::ProviderRefundId,
                    Expr::value(made.id.as_str()),
                )
                .col_expr(commerce_refunds::Column::Status, Expr::value(status))
                .col_expr(
                    commerce_refunds::Column::RefundedAt,
                    Expr::value((status == "refunded").then_some(now)),
                )
                .col_expr(commerce_refunds::Column::UpdatedAt, Expr::value(now))
                .filter(commerce_refunds::Column::Id.eq(refund_id.as_str()))
                .exec(&db::on(&mut tx))
                .await?;
            recount(&mut tx, &payment_id, now).await?;
            let order_changed = sync_order_state(&mut tx, new.order_id, now).await?;
            let row = commerce_refunds::Entity::find_by_id(refund_id.as_str())
                .one(&db::on(&mut tx))
                .await?
                .ok_or_else(|| DbErr::RecordNotFound(format!("commerce_refunds {refund_id}")))?;
            tx.commit().await?;
            Ok(Refunded {
                refund: refund_row(&row),
                order_id: new.order_id.to_owned(),
                completed: status == "refunded",
                order_changed,
            })
        }
        Err(error) => {
            commerce_refunds::Entity::update_many()
                .col_expr(commerce_refunds::Column::Status, Expr::value("failed"))
                .col_expr(commerce_refunds::Column::FailedAt, Expr::value(now))
                .col_expr(commerce_refunds::Column::UpdatedAt, Expr::value(now))
                .filter(commerce_refunds::Column::Id.eq(refund_id.as_str()))
                .exec(&db::on(&mut tx))
                .await?;
            recount(&mut tx, &payment_id, now).await?;
            tx.commit().await?;
            Err(error)
        }
    }
}

/// Whether a payment row still waits on the shopper.
#[must_use]
pub fn waiting(payment: &Value) -> bool {
    text(payment, "status").is_some_and(is_open)
}

/// The amount of a payment row, in cents.
#[must_use]
pub fn amount_of(payment: &Value) -> Cents {
    cents(payment, "amount")
}

/// The order of a payment, with its number: for the storefront's return
/// page.
///
/// # Errors
/// A failed statement.
pub async fn order_of(db: &PgPool, payment: &Value) -> Result<Option<(String, String)>, DbErr> {
    // No order id matches no order.
    let Some(order_id) = text(payment, "orderId") else {
        return Ok(None);
    };
    order_rows::Entity::find_by_id(order_id)
        .filter(order_rows::Column::DeletedAt.is_null())
        .select_only()
        .columns([order_rows::Column::Id, order_rows::Column::OrderNumber])
        .into_tuple()
        .one(&orm(db))
        .await
}

/// Makes sure the order exists (a payment's order may be gone).
///
/// # Errors
/// A failed statement.
pub async fn order_exists(conn: &mut PgConnection, order_id: &str) -> Result<bool, DbErr> {
    Ok(orders::load(conn, order_id, false)
        .await
        .map_err(db::from_sqlx)?
        .is_some())
}
