//! Charges (`billing_payments`, provider `mollie`) and the invoice mirror
//! (`billing_invoices`, provider `weldbooks`).
//!
//! A charge row is written before Mollie is called, keyed on what it is for
//! (`idempotency_key`: one row per intended charge), and its id is Mollie's
//! idempotency key, so a retry never charges twice. Its metadata carries the
//! lines, the VAT and the plan change it buys: what settles it once paid.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_mollie::{MethodDetails, PaymentStatus};

use crate::lines::Charge;
use crate::period::iso;

/// What a charge is for (`billing_payments.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Purpose {
    /// A new subscription: a first payment on the hosted checkout.
    Checkout,
    /// More seats or a dearer plan: prorated, on the mandate (or a hosted
    /// checkout when the mandate can't be charged).
    Change,
    /// The plan and add-ons due on an anchor, on the mandate.
    Renewal,
    /// A past-due charge paid through a pay link or "Pay now".
    PayLink,
    /// A new payment method: a zero-amount first payment.
    Mandate,
    /// A credit package (BILL-013's top-up), its VAT on top: the payment is
    /// the top-up's, this row prices and invoices it ([`crate::top_up`]).
    Credits,
    /// An add-on added between anchors (a WeldReach inbox), for the rest of
    /// the month, on the mandate ([`crate::addons`]).
    Addon,
}

impl Purpose {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Checkout => "checkout",
            Self::Change => "change",
            Self::Renewal => "renewal",
            Self::PayLink => "pay_link",
            Self::Mandate => "mandate",
            Self::Credits => "credits",
            Self::Addon => "addon",
        }
    }
}

/// `billing_payments.metadata` of a Mollie charge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChargeMeta {
    pub(crate) purpose: Purpose,
    pub(crate) charge: Charge,
    /// The plan, seats, cycle and seat price the charge buys.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) plan_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) seats: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cycle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) unit_amount: Option<i64>,
    /// A renewal's new period.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) period_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) period_end: Option<String>,
    /// A pay link's: the past-due row it pays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) settles: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) language: Option<String>,
    /// The billing details the VAT was decided on: the invoice uses them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) customer: Option<crate::buyer::BillingDetails>,
    /// A change already applied (at acceptance, or once paid).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) applied: Option<bool>,
    /// A chargeback already reopened it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) charged_back: Option<bool>,
    /// A top-up's: the credits and the package they came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) credits: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) package_id: Option<String>,
}

/// `billing_payments.status` for a Mollie state: what Global's mirror uses.
pub(crate) fn status_of(status: &PaymentStatus) -> &'static str {
    match status {
        PaymentStatus::Paid => "succeeded",
        PaymentStatus::Failed => "failed",
        PaymentStatus::Canceled | PaymentStatus::Expired => "canceled",
        PaymentStatus::Open
        | PaymentStatus::Pending
        | PaymentStatus::Authorized
        | PaymentStatus::Other(_) => "processing",
    }
}

/// One charge row.
#[derive(Debug, Clone, FromRow)]
pub(crate) struct ChargeRow {
    pub(crate) id: String,
    pub(crate) workspace_id: String,
    pub(crate) provider_payment_id: Option<String>,
    pub(crate) kind: Option<String>,
    pub(crate) status: String,
    pub(crate) amount: i32,
    pub(crate) currency: String,
    pub(crate) metadata: Option<Value>,
    pub(crate) invoice_id: Option<String>,
    pub(crate) paid_at: Option<String>,
}

macro_rules! columns {
    () => {
        "id, workspace_id, provider_payment_id, kind, status, amount, currency,
    metadata, invoice_id,
    to_char(paid_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as paid_at"
    };
}

impl ChargeRow {
    pub(crate) fn meta(&self) -> Option<ChargeMeta> {
        self.metadata
            .clone()
            .and_then(|metadata| serde_json::from_value(metadata).ok())
    }

    pub(crate) fn is_paid(&self) -> bool {
        self.status == "succeeded"
    }

    pub(crate) async fn load(master: &PgPool, id: &str) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as(concat!(
            "select ",
            columns!(),
            " from billing_payments where id = $1 and provider = 'mollie'"
        ))
        .bind(id)
        .fetch_optional(master)
        .await
    }

    pub(crate) async fn lock(
        tx: &mut sqlx::PgConnection,
        id: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as(concat!(
            "select ",
            columns!(),
            " from billing_payments where id = $1 and provider = 'mollie' for update"
        ))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
    }

    /// Writes a charge before Mollie is called. A row with the same `key`
    /// (the same intended charge) is returned instead of a second one.
    pub(crate) async fn create(
        master: &PgPool,
        workspace_id: &str,
        key: &str,
        meta: &ChargeMeta,
    ) -> Result<Self, sqlx::Error> {
        let mut connection = master.acquire().await?;
        Self::create_in(&mut connection, workspace_id, key, meta).await
    }

    /// [`ChargeRow::create`] inside `tx`, so the row commits with what it
    /// charges for.
    pub(crate) async fn create_in(
        tx: &mut sqlx::PgConnection,
        workspace_id: &str,
        key: &str,
        meta: &ChargeMeta,
    ) -> Result<Self, sqlx::Error> {
        let metadata = serde_json::to_value(meta).unwrap_or(Value::Null);
        sqlx::query(
            "insert into billing_payments
                 (id, workspace_id, provider, kind, idempotency_key, metadata, amount, currency, status)
             values ($1, $2, 'mollie', $3, $4, $5::jsonb, $6, $7, 'processing')
             on conflict (idempotency_key) do nothing",
        )
        .bind(generate_id("bpy"))
        .bind(workspace_id)
        .bind(meta.purpose.as_str())
        .bind(key)
        .bind(&metadata)
        .bind(i32::try_from(meta.charge.gross).unwrap_or(i32::MAX))
        .bind(&meta.charge.currency)
        .execute(&mut *tx)
        .await?;
        sqlx::query_as(concat!(
            "select ",
            columns!(),
            " from billing_payments where idempotency_key = $1"
        ))
        .bind(key)
        .fetch_one(&mut *tx)
        .await
    }

    /// Renewals written but never sent (Mollie unreachable, or the run
    /// stopped between the row and the call), created before `before`.
    pub(crate) async fn unsent_renewals(
        master: &PgPool,
        before: &str,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as(concat!(
            "select ",
            columns!(),
            " from billing_payments
             where provider = 'mollie' and kind = 'renewal' and status = 'processing'
               and provider_payment_id is null and created_at < $1::timestamp
             order by created_at limit $2"
        ))
        .bind(before)
        .bind(limit)
        .fetch_all(master)
        .await
    }

    /// The Mollie payment the row was sent as.
    pub(crate) async fn set_payment(
        master: &PgPool,
        id: &str,
        payment_id: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "update billing_payments set provider_payment_id = $2, updated_at = now() where id = $1",
        )
        .bind(id)
        .bind(payment_id)
        .execute(master)
        .await?;
        Ok(())
    }

    /// The Mollie state, how it was paid and why it failed.
    pub(crate) async fn record(
        tx: &mut sqlx::PgConnection,
        id: &str,
        status: &str,
        details: &MethodDetails,
        failure: Option<&str>,
        paid_at: Option<OffsetDateTime>,
        refunded: i64,
    ) -> Result<(), sqlx::Error> {
        let method = match details.method.as_deref() {
            Some("creditcard") => Some("card"),
            Some("directdebit") => Some("sepa_debit"),
            Some(other) => Some(other),
            None => None,
        };
        sqlx::query(
            "update billing_payments set status = $2, payment_method_type = coalesce($3, payment_method_type),
                 payment_method_brand = coalesce($4, payment_method_brand),
                 payment_method_last4 = coalesce($5, payment_method_last4),
                 failure_message = $6, paid_at = coalesce(paid_at, $7::timestamp),
                 refunded_amount = $8, updated_at = now()
             where id = $1",
        )
        .bind(id)
        .bind(status)
        .bind(method)
        .bind(details.brand.as_deref().map(|b| b.chars().take(30).collect::<String>()))
        .bind(details.last4.as_deref())
        .bind(failure)
        .bind(paid_at.map(iso))
        .bind(i32::try_from(refunded).unwrap_or(i32::MAX))
        .execute(&mut *tx)
        .await?;
        Ok(())
    }

    /// Paid charges still without their invoice (the issuer was down).
    pub(crate) async fn paid_without_invoice(
        master: &PgPool,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as(concat!(
            "select ",
            columns!(),
            " from billing_payments
             where provider = 'mollie' and status = 'succeeded' and invoice_id is null
               and amount > 0
             order by paid_at limit $1"
        ))
        .bind(limit)
        .fetch_all(master)
        .await
    }
}

/// A `billing_invoices` row for a WeldBooks invoice.
pub(crate) struct InvoiceMirror<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) provider_invoice_id: &'a str,
    pub(crate) provider_payment_id: &'a str,
    pub(crate) number: &'a str,
    pub(crate) charge: &'a Charge,
    pub(crate) period: Option<(String, String)>,
    pub(crate) billing_reason: &'a str,
    pub(crate) document_key: Option<&'a str>,
    pub(crate) paid_at: OffsetDateTime,
}

/// Writes the mirror and links the charge to it; idempotent on the payment.
pub(crate) async fn mirror_invoice(
    master: &PgPool,
    charge_row_id: &str,
    invoice: &InvoiceMirror<'_>,
) -> Result<String, sqlx::Error> {
    let id = generate_id("binv");
    let lines = serde_json::to_value(&invoice.charge.lines).unwrap_or(Value::Null);
    let gross = i32::try_from(invoice.charge.gross).unwrap_or(i32::MAX);
    let mut tx = master.begin().await?;
    sqlx::query(
        "insert into billing_invoices
             (id, workspace_id, provider, provider_invoice_id, provider_payment_id, number,
              amount_due, amount_paid, currency, status, billing_reason, period_start, period_end,
              pdf_url, tax_amount, subtotal_amount, customer_country, customer_tax_exempt,
              lines, document_key, paid_at)
         values ($1, $2, 'weldbooks', $3, $4, $5, $6, $6, $7, 'paid', $8, $9::timestamp,
                 $10::timestamp, $11, $12, $13, $14, $15, $16::jsonb, $17, $18::timestamp)
         on conflict (provider_payment_id) do nothing",
    )
    .bind(&id)
    .bind(invoice.workspace_id)
    .bind(invoice.provider_invoice_id)
    .bind(invoice.provider_payment_id)
    .bind(invoice.number)
    .bind(gross)
    .bind(&invoice.charge.currency)
    .bind(invoice.billing_reason)
    .bind(invoice.period.as_ref().map(|p| p.0.clone()))
    .bind(invoice.period.as_ref().map(|p| p.1.clone()))
    .bind(format!("/api/billing/invoices/{id}/document"))
    .bind(i32::try_from(invoice.charge.tax).unwrap_or(i32::MAX))
    .bind(i32::try_from(invoice.charge.net).unwrap_or(i32::MAX))
    .bind(&invoice.charge.vat.country)
    .bind(invoice.charge.vat.treatment.tax_exempt())
    .bind(&lines)
    .bind(invoice.document_key)
    .bind(iso(invoice.paid_at))
    .execute(&mut *tx)
    .await?;
    let stored: String =
        sqlx::query_scalar("select id from billing_invoices where provider_payment_id = $1")
            .bind(invoice.provider_payment_id)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query("update billing_payments set invoice_id = $2, updated_at = now() where id = $1")
        .bind(charge_row_id)
        .bind(&stored)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(stored)
}
