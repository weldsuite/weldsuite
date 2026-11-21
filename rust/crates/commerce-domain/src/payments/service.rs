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

use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use weldsuite_kit::generate_id;

use super::connection::{self, with_provider};
use super::provider::{PaymentRequest, ProviderPayment, ProviderRefund};
use super::{Env, Error, PAYMENT_ROW, REFUND_ROW, cents, is_open, text};
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

// ── reading ─────────────────────────────────────────────────────────────────

/// The payments and refunds of an order, oldest first.
///
/// # Errors
/// A failed statement.
pub async fn list(db: &PgPool, order_id: &str) -> Result<(Vec<Value>, Vec<Value>), sqlx::Error> {
    let payments = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {PAYMENT_ROW} from commerce_payments where order_id = $1 \
         order by created_at asc, id asc"
    )))
    .bind(order_id)
    .fetch_all(db)
    .await?;
    let refunds = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {REFUND_ROW} from commerce_refunds where order_id = $1 \
         order by created_at asc, id asc"
    )))
    .bind(order_id)
    .fetch_all(db)
    .await?;
    Ok((payments, refunds))
}

/// A payment by its provider's id (`tr_…`).
///
/// # Errors
/// A failed statement.
pub async fn by_provider_id(db: &PgPool, provider_id: &str) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {PAYMENT_ROW} from commerce_payments \
         where provider = 'mollie' and provider_payment_id = $1 limit 1"
    )))
    .bind(provider_id)
    .fetch_optional(db)
    .await
}

/// A payment by our id.
///
/// # Errors
/// A failed statement.
pub async fn by_id(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {PAYMENT_ROW} from commerce_payments where id = $1 limit 1"
    )))
    .bind(id)
    .fetch_optional(db)
    .await
}

/// The payments of an order still waiting on the shopper for over a minute:
/// the ones a read of the order looks up at the provider (no timer does).
///
/// # Errors
/// A failed statement.
pub async fn stale_open(db: &PgPool, order_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {PAYMENT_ROW} from commerce_payments where order_id = $1 \
           and status in ('open', 'pending') and provider_payment_id is not null \
           and updated_at < (now() at time zone 'utc') - interval '1 minute' \
         order by created_at asc"
    )))
    .bind(order_id)
    .fetch_all(db)
    .await
}

/// What an order has taken and given back: paid payments, and refunds that
/// reached `refunded`.
///
/// # Errors
/// A failed statement.
pub async fn amounts(
    conn: &mut PgConnection,
    order_id: &str,
) -> Result<(Cents, Cents), sqlx::Error> {
    let (paid, refunded): (String, String) = sqlx::query_as(
        "select \
           (select coalesce(sum(amount), 0)::text from commerce_payments \
              where order_id = $1 and status = 'paid'), \
           (select coalesce(sum(amount), 0)::text from commerce_refunds \
              where order_id = $1 and status = 'refunded')",
    )
    .bind(order_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok((
        money::parse(&paid).unwrap_or(0),
        money::parse(&refunded).unwrap_or(0),
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

/// The order's payment state for a new payment: its number, currency, what
/// is outstanding.
async fn payable(db: &PgPool, order_id: &str) -> Result<(String, String, Cents), Error> {
    let order: Option<(String, String, String, String, String, Option<String>)> = sqlx::query_as(
        "select order_number, coalesce(currency, 'EUR'), total::text, status, \
           coalesce(payment_status, 'pending'), approval_status \
         from orders where id = $1 and deleted_at is null",
    )
    .bind(order_id)
    .fetch_optional(db)
    .await?;
    let Some((number, currency, total, status, payment_status, approval)) = order else {
        return Err(Error::NotFound {
            resource: "Order",
            id: order_id.to_owned(),
        });
    };
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
    let paid: String = sqlx::query_scalar(
        "select coalesce(sum(amount), 0)::text from commerce_payments \
         where order_id = $1 and status = 'paid'",
    )
    .bind(order_id)
    .fetch_one(db)
    .await?;
    let outstanding = money::parse(&total).unwrap_or(0) - money::parse(&paid).unwrap_or(0);
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
pub async fn create_for_order(env: &Env<'_>, new: &NewOrderPayment<'_>) -> Result<Value, Error> {
    let (number, currency, outstanding) = payable(env.db, new.order_id).await?;
    let reusable: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {PAYMENT_ROW} from commerce_payments where order_id = $1 and status = 'open' \
           and checkout_url is not null and amount = $2::numeric \
           and (expires_at is null or expires_at > (now() at time zone 'utc')) \
         order by created_at desc limit 1"
    )))
    .bind(new.order_id)
    .bind(money::format(outstanding))
    .fetch_optional(env.db)
    .await?;
    if let Some(payment) = reusable {
        return Ok(payment);
    }
    let attempt: i64 =
        sqlx::query_scalar("select count(*) from commerce_payments where order_id = $1")
            .bind(new.order_id)
            .fetch_one(env.db)
            .await?;
    let key = format!("wc-pay-{}-{attempt}", new.order_id);
    if let Some(existing) = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {PAYMENT_ROW} from commerce_payments where idempotency_key = $1"
    )))
    .bind(&key)
    .fetch_optional(env.db)
    .await?
    {
        return Ok(existing);
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

    let inserted: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "insert into commerce_payments (id, order_id, connection_id, provider, provider_payment_id, \
           status, amount, currency, method, checkout_url, redirect_url, testmode, provider_data, \
           idempotency_key, expires_at) \
         values ($1, $2, $3, 'mollie', $4, $5, $6::numeric, $7, $8, $9, $10, $11, $12::jsonb, $13, \
           ($14::text)::timestamptz at time zone 'utc') \
         on conflict do nothing returning {PAYMENT_ROW}"
    )))
    .bind(&id)
    .bind(new.order_id)
    .bind(&active.id)
    .bind(&created.id)
    .bind(mollie_status(&created.status))
    .bind(money::format(outstanding))
    .bind(&currency)
    .bind(created.method.as_deref())
    .bind(created.checkout_url.as_deref())
    .bind(&redirect)
    .bind(active.testmode)
    .bind(&created.raw)
    .bind(&key)
    .bind(created.expires_at.as_deref())
    .fetch_optional(env.db)
    .await?;
    sqlx::query(
        "update orders set payment_status = 'pending', updated_at = (now() at time zone 'utc') \
         where id = $1 and payment_status = 'failed'",
    )
    .bind(new.order_id)
    .execute(env.db)
    .await?;
    match inserted {
        Some(row) => Ok(row),
        None => by_provider_id(env.db, &created.id)
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

/// Reads `payment` (a [`PAYMENT_ROW`]) and its refunds at the provider and
/// applies them.
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
    let current: Option<(String, String, String, String)> = sqlx::query_as(
        "select order_id, status, currency, amount::text from commerce_payments \
         where id = $1 for update",
    )
    .bind(payment_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((order_id, old_status, currency, amount)) = current else {
        return Err(Error::NotFound {
            resource: "Payment",
            id: payment_id.to_owned(),
        });
    };
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
    sqlx::query(
        "update commerce_payments set status = $2, method = coalesce($3, method), \
           checkout_url = case when $2 in ('open', 'pending', 'authorized') \
             then coalesce($4, checkout_url) else null end, \
           failure_reason = case when $2 in ('failed', 'canceled', 'expired') \
             then coalesce($5, failure_reason, $2) else failure_reason end, \
           paid_at = case when $2 = 'paid' and paid_at is null \
             then coalesce(($6::text)::timestamptz at time zone 'utc', now() at time zone 'utc') else paid_at end, \
           failed_at = case when $2 = 'failed' and failed_at is null then now() at time zone 'utc' else failed_at end, \
           canceled_at = case when $2 = 'canceled' and canceled_at is null then now() at time zone 'utc' else canceled_at end, \
           expired_at = case when $2 = 'expired' and expired_at is null then now() at time zone 'utc' else expired_at end, \
           expires_at = coalesce(($7::text)::timestamptz at time zone 'utc', expires_at), \
           provider_data = $8::jsonb, updated_at = now() at time zone 'utc' \
         where id = $1",
    )
    .bind(payment_id)
    .bind(status)
    .bind(read.method.as_deref())
    .bind(read.checkout_url.as_deref())
    .bind(read.failure_reason.as_deref())
    .bind(read.paid_at.as_deref())
    .bind(read.expires_at.as_deref())
    .bind(&read.raw)
    .execute(&mut *conn)
    .await?;
    applied.status_changed = status != old_status;

    sync_refunds(
        &mut *conn,
        &order_id,
        payment_id,
        &currency,
        refunds,
        &mut applied,
    )
    .await?;

    if status == "paid" && old_status != "paid" {
        let paid_at: Option<String> = sqlx::query_scalar(
            "select to_char(paid_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from commerce_payments where id = $1",
        )
        .bind(payment_id)
        .fetch_one(&mut *conn)
        .await?;
        let paid = Payment {
            paid_at,
            method: read.method.clone(),
            reference: Some(read.id.clone()),
        };
        // The order is paid when the payments that were made come to its
        // total, not when any one of them is paid: a payment is for the
        // amount outstanding when it was created, and the order may have
        // changed since. A smaller payment leaves the order `pending`
        // (`amountPaid` shows it).
        let (taken, _) = amounts(&mut *conn, &order_id).await?;
        let order: Option<(String, String)> = sqlx::query_as(
            "select coalesce(payment_status, 'pending'), coalesce(total, 0)::text              from orders where id = $1",
        )
        .bind(&order_id)
        .fetch_optional(&mut *conn)
        .await?;
        let total = order
            .as_ref()
            .and_then(|(_, total)| money::parse(total))
            .unwrap_or(0);
        let already_paid = order
            .as_ref()
            .is_some_and(|(status, _)| crate::status::is_paid(status));
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
            sqlx::query(
                "update orders set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb),                    '{overpaid}', to_jsonb($2::text)), updated_at = now() at time zone 'utc'                  where id = $1",
            )
            .bind(&order_id)
            .bind(money::format(over))
            .execute(&mut *conn)
            .await?;
            applied.order_changed = true;
        }
    }
    if failed && applied.status_changed {
        let changed = sqlx::query(
            "update orders set payment_status = 'failed', updated_at = now() at time zone 'utc' \
             where id = $1 and coalesce(payment_status, 'pending') = 'pending' \
               and not exists (select 1 from commerce_payments \
                 where order_id = $1 and id <> $2 and status in ('open', 'pending', 'authorized', 'paid'))",
        )
        .bind(&order_id)
        .bind(payment_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
        applied.order_changed |= changed > 0;
    }
    if sync_order_state(&mut *conn, &order_id).await? {
        applied.order_changed = true;
    }
    debug_assert!(money::parse(&amount).is_some());
    Ok(applied)
}

/// Brings the order's `payment_status` in line with what was paid and
/// refunded; `true` when it moved.
async fn sync_order_state(conn: &mut PgConnection, order_id: &str) -> Result<bool, sqlx::Error> {
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
    let changed = sqlx::query(
        "update orders set payment_status = $2, updated_at = now() at time zone 'utc' \
         where id = $1 and payment_status in ('paid', 'partially_refunded', 'refunded') \
           and payment_status <> $2",
    )
    .bind(order_id)
    .bind(target)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(changed > 0)
}

/// What the payment has been refunded of, counting refunds still on their
/// way (they are spent already).
async fn recount(conn: &mut PgConnection, payment_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update commerce_payments set updated_at = now() at time zone 'utc', amount_refunded = ( \
           select coalesce(sum(amount), 0) from commerce_refunds \
           where payment_id = $1 and status not in ('failed', 'canceled')) \
         where id = $1",
    )
    .bind(payment_id)
    .execute(&mut *conn)
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
) -> Result<(), sqlx::Error> {
    for refund in refunds {
        let status = refund_status(&refund.status);
        let existing: Option<(String, String)> = sqlx::query_as(
            "select id, status from commerce_refunds \
             where provider = 'mollie' and provider_refund_id = $1 for update",
        )
        .bind(&refund.id)
        .fetch_optional(&mut *conn)
        .await?;
        let id = match existing {
            Some((id, old)) => {
                if old == status {
                    continue;
                }
                sqlx::query(
                    "update commerce_refunds set status = $2, \
                       refunded_at = case when $2 = 'refunded' and refunded_at is null \
                         then now() at time zone 'utc' else refunded_at end, \
                       failed_at = case when $2 in ('failed', 'canceled') and failed_at is null \
                         then now() at time zone 'utc' else failed_at end, \
                       updated_at = now() at time zone 'utc' where id = $1",
                )
                .bind(&id)
                .bind(status)
                .execute(&mut *conn)
                .await?;
                id
            }
            // A refund made in Mollie's dashboard.
            None => {
                let id = generate_id("cref");
                sqlx::query(
                    "insert into commerce_refunds (id, order_id, payment_id, provider, \
                       provider_refund_id, status, amount, currency, reason, refunded_at, failed_at) \
                     values ($1, $2, $3, 'mollie', $4, $5, $6::numeric, $7, 'Refunded in Mollie', \
                       case when $5 = 'refunded' then now() at time zone 'utc' end, \
                       case when $5 in ('failed', 'canceled') then now() at time zone 'utc' end)",
                )
                .bind(&id)
                .bind(order_id)
                .bind(payment_id)
                .bind(&refund.id)
                .bind(status)
                .bind(money::format(Cents::from(refund.amount_cents)))
                .bind(currency)
                .execute(&mut *conn)
                .await?;
                id
            }
        };
        applied.status_changed = true;
        if status == "refunded" {
            applied.refunds_completed.push(id);
        }
    }
    recount(&mut *conn, payment_id).await?;
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
    let candidates: Vec<(String, Option<String>, String, String, String)> = sqlx::query_as(
        "select id, provider_payment_id, amount::text, amount_refunded::text, currency \
         from commerce_payments where order_id = $1 and status = 'paid' \
           and ($2::text is null or id = $2) order by created_at asc for update",
    )
    .bind(new.order_id)
    .bind(new.payment_id)
    .fetch_all(&mut *tx)
    .await?;
    let best = candidates
        .iter()
        .map(|(id, provider, amount, refunded, currency)| {
            let left = money::parse(amount).unwrap_or(0) - money::parse(refunded).unwrap_or(0);
            (left, id, provider, currency)
        })
        .max_by_key(|(left, ..)| *left);
    let Some((left, payment_id, provider_id, currency)) = best else {
        return Err(Error::NothingToRefund);
    };
    if left <= 0 {
        return Err(Error::NothingToRefund);
    }
    if new.amount > left {
        return Err(Error::RefundTooLarge { refundable: left });
    }
    let (Some(provider_id), Ok(amount_cents)) = (provider_id.clone(), i64::try_from(new.amount))
    else {
        return Err(Error::Provider("The payment has no provider id".to_owned()));
    };
    let (payment_id, currency) = (payment_id.clone(), currency.clone());
    let refund_id = generate_id("cref");
    let key = format!("wc-refund-{refund_id}");
    sqlx::query(
        "insert into commerce_refunds (id, order_id, payment_id, provider, status, amount, \
           currency, reason, created_by, idempotency_key) \
         values ($1, $2, $3, 'mollie', 'pending', $4::numeric, $5, $6, $7, $8)",
    )
    .bind(&refund_id)
    .bind(new.order_id)
    .bind(&payment_id)
    .bind(money::format(new.amount))
    .bind(&currency)
    .bind(new.reason)
    .bind(new.created_by)
    .bind(&key)
    .execute(&mut *tx)
    .await?;
    recount(&mut tx, &payment_id).await?;
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
    match made {
        Ok(made) => {
            let status = refund_status(&made.status);
            sqlx::query(
                "update commerce_refunds set provider_refund_id = $2, status = $3, \
                   refunded_at = case when $3 = 'refunded' then now() at time zone 'utc' end, \
                   updated_at = now() at time zone 'utc' where id = $1",
            )
            .bind(&refund_id)
            .bind(&made.id)
            .bind(status)
            .execute(&mut *tx)
            .await?;
            recount(&mut tx, &payment_id).await?;
            let order_changed = sync_order_state(&mut tx, new.order_id).await?;
            let row: Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "select {REFUND_ROW} from commerce_refunds where id = $1"
            )))
            .bind(&refund_id)
            .fetch_one(&mut *tx)
            .await?;
            tx.commit().await?;
            Ok(Refunded {
                refund: row,
                order_id: new.order_id.to_owned(),
                completed: status == "refunded",
                order_changed,
            })
        }
        Err(error) => {
            sqlx::query(
                "update commerce_refunds set status = 'failed', \
                   failed_at = now() at time zone 'utc', updated_at = now() at time zone 'utc' \
                 where id = $1",
            )
            .bind(&refund_id)
            .execute(&mut *tx)
            .await?;
            recount(&mut tx, &payment_id).await?;
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
pub async fn order_of(
    db: &PgPool,
    payment: &Value,
) -> Result<Option<(String, String)>, sqlx::Error> {
    sqlx::query_as("select id, order_number from orders where id = $1 and deleted_at is null")
        .bind(text(payment, "orderId"))
        .fetch_optional(db)
        .await
}

/// Makes sure the order exists (a payment's order may be gone).
///
/// # Errors
/// A failed statement.
pub async fn order_exists(conn: &mut PgConnection, order_id: &str) -> Result<bool, crate::DbErr> {
    Ok(orders::load(conn, order_id, false).await?.is_some())
}
