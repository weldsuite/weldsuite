//! Charges (`billing_payments`, provider `mollie`) and the invoice mirror
//! (`billing_invoices`, provider `weldbooks`).
//!
//! A charge row is written before Mollie is called, keyed on what it is for
//! (`idempotency_key`: one row per intended charge), and its id is Mollie's
//! idempotency key, so a retry never charges twice. Its metadata carries the
//! lines, the VAT and the plan change it buys: what settles it once paid.

use sea_orm::sea_query::extension::postgres as pg;
use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::{OrmConn, PgPool, orm, orm_error, utc_timestamp};
use weldsuite_kit::generate_id;
use weldsuite_mollie::{MethodDetails, PaymentStatus};
use weldsuite_schema::master::{billing_invoices, billing_payments};

use crate::lines::Charge;
use crate::period::parse_iso;
use crate::workspace::iso_text;

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
#[derive(Debug, Clone)]
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

impl From<billing_payments::Model> for ChargeRow {
    /// The columns a charge is settled from, `paid_at` as
    /// `to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` printed it.
    fn from(row: billing_payments::Model) -> Self {
        Self {
            id: row.id,
            workspace_id: row.workspace_id,
            provider_payment_id: row.provider_payment_id,
            kind: row.kind,
            status: row.status,
            amount: row.amount,
            currency: row.currency,
            metadata: row.metadata,
            invoice_id: row.invoice_id,
            paid_at: row.paid_at.map(iso_text),
        }
    }
}

/// `jsonb_set(target, '{key}', value)`.
pub(crate) fn jsonb_set(target: impl Into<Expr>, key: &str, value: impl Into<Expr>) -> Expr {
    Expr::from(
        Func::cust("jsonb_set")
            .arg(target)
            .arg(sea_orm::ExprTrait::cast_as(
                Expr::val(format!("{{{key}}}")),
                "text[]",
            ))
            .arg(value),
    )
}

/// `metadata ->> 'invoiceMail'`.
fn invoice_mail_mark() -> Expr {
    pg::PgExpr::cast_json_field(Expr::col(billing_payments::Column::Metadata), "invoiceMail")
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

    pub(crate) async fn load(master: &PgPool, id: &str) -> Result<Option<Self>, DbErr> {
        let row = billing_payments::Entity::find_by_id(id.to_owned())
            .filter(billing_payments::Column::Provider.eq("mollie"))
            .one(&orm(master))
            .await?;
        Ok(row.map(Self::from))
    }

    pub(crate) async fn lock(tx: &impl ConnectionTrait, id: &str) -> Result<Option<Self>, DbErr> {
        let row = billing_payments::Entity::find_by_id(id.to_owned())
            .filter(billing_payments::Column::Provider.eq("mollie"))
            .lock_exclusive()
            .one(tx)
            .await?;
        Ok(row.map(Self::from))
    }

    /// Writes a charge before Mollie is called. A row with the same `key`
    /// (the same intended charge) is returned instead of a second one.
    pub(crate) async fn create(
        master: &PgPool,
        workspace_id: &str,
        key: &str,
        meta: &ChargeMeta,
    ) -> Result<Self, DbErr> {
        let mut connection = master.acquire().await.map_err(orm_error)?;
        Self::create_in(&OrmConn::new(&mut connection), workspace_id, key, meta).await
    }

    /// [`ChargeRow::create`] inside `tx`, so the row commits with what it
    /// charges for.
    pub(crate) async fn create_in(
        tx: &impl ConnectionTrait,
        workspace_id: &str,
        key: &str,
        meta: &ChargeMeta,
    ) -> Result<Self, DbErr> {
        let metadata = serde_json::to_value(meta).unwrap_or(Value::Null);
        billing_payments::Entity::insert(billing_payments::ActiveModel {
            id: Set(generate_id("bpy")),
            workspace_id: Set(workspace_id.to_owned()),
            provider: Set("mollie".to_owned()),
            kind: Set(Some(meta.purpose.as_str().to_owned())),
            idempotency_key: Set(Some(key.to_owned())),
            metadata: Set(Some(metadata)),
            amount: Set(i32::try_from(meta.charge.gross).unwrap_or(i32::MAX)),
            currency: Set(meta.charge.currency.clone()),
            status: Set("processing".to_owned()),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(billing_payments::Column::IdempotencyKey)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(tx)
        .await?;
        billing_payments::Entity::find()
            .filter(billing_payments::Column::IdempotencyKey.eq(key))
            .one(tx)
            .await?
            .map(Self::from)
            .ok_or_else(|| DbErr::RecordNotFound("billing_payments".to_owned()))
    }

    /// Renewals written but never sent (Mollie unreachable, or the run
    /// stopped between the row and the call), created before `before`.
    pub(crate) async fn unsent_renewals(
        master: &PgPool,
        before: OffsetDateTime,
        limit: u64,
    ) -> Result<Vec<Self>, DbErr> {
        use billing_payments::Column as P;
        let rows = billing_payments::Entity::find()
            .filter(P::Provider.eq("mollie"))
            .filter(P::Kind.eq("renewal"))
            .filter(P::Status.eq("processing"))
            .filter(P::ProviderPaymentId.is_null())
            .filter(P::CreatedAt.lt(utc_timestamp(before)))
            .order_by_asc(P::CreatedAt)
            .limit(limit)
            .all(&orm(master))
            .await?;
        Ok(rows.into_iter().map(Self::from).collect())
    }

    /// The Mollie payment the row was sent as.
    pub(crate) async fn set_payment(
        master: &PgPool,
        id: &str,
        payment_id: &str,
    ) -> Result<(), DbErr> {
        billing_payments::Entity::update_many()
            .col_expr(
                billing_payments::Column::ProviderPaymentId,
                Expr::value(payment_id.to_owned()),
            )
            .col_expr(
                billing_payments::Column::UpdatedAt,
                Expr::current_timestamp(),
            )
            .filter(billing_payments::Column::Id.eq(id))
            .exec(&orm(master))
            .await?;
        Ok(())
    }

    /// The Mollie state, how it was paid and why it failed.
    pub(crate) async fn record(
        tx: &impl ConnectionTrait,
        id: &str,
        status: &str,
        details: &MethodDetails,
        failure: Option<&str>,
        paid_at: Option<OffsetDateTime>,
        refunded: i64,
    ) -> Result<(), DbErr> {
        use billing_payments::Column as P;
        let method = match details.method.as_deref() {
            Some("creditcard") => Some("card"),
            Some("directdebit") => Some("sepa_debit"),
            Some(other) => Some(other),
            None => None,
        };
        // `coalesce($n, column)`: a value Mollie didn't send keeps the stored one.
        let keep = |value: Option<String>, column: P| {
            Expr::from(Func::coalesce([Expr::value(value), Expr::col(column)]))
        };
        billing_payments::Entity::update_many()
            .col_expr(P::Status, Expr::value(status.to_owned()))
            .col_expr(
                P::PaymentMethodType,
                keep(method.map(str::to_owned), P::PaymentMethodType),
            )
            .col_expr(
                P::PaymentMethodBrand,
                keep(
                    details
                        .brand
                        .as_deref()
                        .map(|b| b.chars().take(30).collect::<String>()),
                    P::PaymentMethodBrand,
                ),
            )
            .col_expr(
                P::PaymentMethodLast4,
                keep(details.last4.clone(), P::PaymentMethodLast4),
            )
            .col_expr(P::FailureMessage, Expr::value(failure.map(str::to_owned)))
            .col_expr(
                P::PaidAt,
                Expr::from(Func::coalesce([
                    Expr::col(P::PaidAt),
                    Expr::value(paid_at.map(utc_timestamp)),
                ])),
            )
            .col_expr(
                P::RefundedAmount,
                Expr::value(i32::try_from(refunded).unwrap_or(i32::MAX)),
            )
            .col_expr(P::UpdatedAt, Expr::current_timestamp())
            .filter(P::Id.eq(id))
            .exec(tx)
            .await?;
        Ok(())
    }

    /// Paid charges still without their invoice (the issuer was down).
    pub(crate) async fn paid_without_invoice(
        master: &PgPool,
        limit: u64,
    ) -> Result<Vec<Self>, DbErr> {
        use billing_payments::Column as P;
        let rows = billing_payments::Entity::find()
            .filter(P::Provider.eq("mollie"))
            .filter(P::Status.eq("succeeded"))
            .filter(P::InvoiceId.is_null())
            .filter(P::Amount.gt(0))
            .order_by_asc(P::PaidAt)
            .limit(limit)
            .all(&orm(master))
            .await?;
        Ok(rows.into_iter().map(Self::from).collect())
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

/// A `timestamp` bound as text (`$n::timestamp`): the ISO instants the
/// lines carry, as the UTC wall-clock time Postgres stores.
fn timestamp_of(text: &str) -> Option<time::PrimitiveDateTime> {
    parse_iso(text).map(utc_timestamp)
}

/// Writes the mirror and links the charge to it; idempotent on the payment.
pub(crate) async fn mirror_invoice(
    master: &PgPool,
    charge_row_id: &str,
    invoice: &InvoiceMirror<'_>,
) -> Result<String, DbErr> {
    let id = generate_id("binv");
    let lines = serde_json::to_value(&invoice.charge.lines).unwrap_or(Value::Null);
    let gross = i32::try_from(invoice.charge.gross).unwrap_or(i32::MAX);
    let mut tx = master.begin().await.map_err(orm_error)?;
    let stored = {
        let conn = OrmConn::new(&mut tx);
        billing_invoices::Entity::insert(billing_invoices::ActiveModel {
            id: Set(id.clone()),
            workspace_id: Set(invoice.workspace_id.to_owned()),
            provider: Set("weldbooks".to_owned()),
            provider_invoice_id: Set(Some(invoice.provider_invoice_id.to_owned())),
            provider_payment_id: Set(Some(invoice.provider_payment_id.to_owned())),
            number: Set(Some(invoice.number.to_owned())),
            amount_due: Set(Some(gross)),
            amount_paid: Set(Some(gross)),
            currency: Set(Some(invoice.charge.currency.clone())),
            status: Set(Some("paid".to_owned())),
            billing_reason: Set(Some(invoice.billing_reason.to_owned())),
            period_start: Set(invoice.period.as_ref().and_then(|p| timestamp_of(&p.0))),
            period_end: Set(invoice.period.as_ref().and_then(|p| timestamp_of(&p.1))),
            pdf_url: Set(Some(format!("/api/billing/invoices/{id}/document"))),
            tax_amount: Set(Some(i32::try_from(invoice.charge.tax).unwrap_or(i32::MAX))),
            subtotal_amount: Set(Some(i32::try_from(invoice.charge.net).unwrap_or(i32::MAX))),
            customer_country: Set(Some(invoice.charge.vat.country.clone())),
            customer_tax_exempt: Set(Some(invoice.charge.vat.treatment.tax_exempt().to_owned())),
            lines: Set(Some(lines)),
            document_key: Set(invoice.document_key.map(str::to_owned)),
            paid_at: Set(Some(utc_timestamp(invoice.paid_at))),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(billing_invoices::Column::ProviderPaymentId)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(&conn)
        .await?;
        let stored: String = billing_invoices::Entity::find()
            .select_only()
            .column(billing_invoices::Column::Id)
            .filter(billing_invoices::Column::ProviderPaymentId.eq(invoice.provider_payment_id))
            .into_tuple()
            .one(&conn)
            .await?
            .ok_or_else(|| DbErr::RecordNotFound("billing_invoices".to_owned()))?;
        // Linked, with its email due unless an earlier call already marked it.
        let metadata = || Expr::col(billing_payments::Column::Metadata);
        let marked =
            sea_orm::ExprTrait::is_not_null(pg::PgExpr::get_json_field(metadata(), "invoiceMail"));
        let due = jsonb_set(
            Func::coalesce([metadata(), Expr::val(json!({}))]),
            "invoiceMail",
            Expr::val(json!("due")),
        );
        billing_payments::Entity::update_many()
            .col_expr(
                billing_payments::Column::InvoiceId,
                Expr::value(stored.clone()),
            )
            .col_expr(
                billing_payments::Column::UpdatedAt,
                Expr::current_timestamp(),
            )
            .col_expr(
                billing_payments::Column::Metadata,
                Expr::case(marked, metadata()).finally(due).into(),
            )
            .filter(billing_payments::Column::Id.eq(charge_row_id))
            .exec(&conn)
            .await?;
        stored
    };
    tx.commit().await.map_err(orm_error)?;
    Ok(stored)
}

// ── the invoice email's mark ────────────────────────────────────────────────
//
// `billing_payments.metadata.invoiceMail` (no column of its own, so no
// migration): `due` from the moment the invoice is mirrored, `sent` once a
// sender claims it, `failed` after `INVOICE_MAIL_ATTEMPTS` sends nobody took,
// `none` with nobody to send it to. A charge invoiced before invoice emails
// existed has no mark and is never mailed. The claim is the mark: a crash
// between the claim and the send loses the email rather than sending it
// twice.

/// Sends nobody took before the invoice email is given up (hourly: a day).
pub(crate) const INVOICE_MAIL_ATTEMPTS: i32 = 24;

impl ChargeRow {
    /// The invoice email's mark, when it has one.
    pub(crate) fn invoice_mail(&self) -> Option<&str> {
        self.metadata
            .as_ref()
            .and_then(|metadata| metadata.get("invoiceMail"))
            .and_then(Value::as_str)
    }

    /// Claims the due invoice email of charge `id` for sending; `false` when
    /// it isn't due (sent, claimed by another caller, or never marked).
    pub(crate) async fn claim_invoice_mail(master: &PgPool, id: &str) -> Result<bool, DbErr> {
        let claimed = billing_payments::Entity::update_many()
            .col_expr(
                billing_payments::Column::Metadata,
                jsonb_set(
                    Expr::col(billing_payments::Column::Metadata),
                    "invoiceMail",
                    Expr::val(json!("sent")),
                ),
            )
            .col_expr(
                billing_payments::Column::UpdatedAt,
                Expr::current_timestamp(),
            )
            .filter(billing_payments::Column::Id.eq(id))
            .filter(billing_payments::Column::InvoiceId.is_not_null())
            .filter(sea_orm::ExprTrait::eq(invoice_mail_mark(), "due"))
            .exec(&orm(master))
            .await?;
        Ok(claimed.rows_affected == 1)
    }

    /// A claimed send nobody took: due again for the next run, or `failed`
    /// after [`INVOICE_MAIL_ATTEMPTS`].
    pub(crate) async fn release_invoice_mail(master: &PgPool, id: &str) -> Result<(), DbErr> {
        use sea_orm::ExprTrait as _;
        let metadata = || Expr::col(billing_payments::Column::Metadata);
        // `coalesce((metadata ->> 'invoiceMailAttempts')::int, 0) + 1`
        let attempts = || {
            Expr::from(Func::coalesce([
                pg::PgExpr::cast_json_field(metadata(), "invoiceMailAttempts").cast_as("int"),
                Expr::val(0),
            ]))
            .add(1)
        };
        let counted = jsonb_set(
            metadata(),
            "invoiceMailAttempts",
            Func::cust("to_jsonb").arg(attempts()),
        );
        let mark = Expr::case(
            attempts().gte(INVOICE_MAIL_ATTEMPTS),
            Expr::val(json!("failed")),
        )
        .finally(Expr::val(json!("due")));
        billing_payments::Entity::update_many()
            .col_expr(
                billing_payments::Column::Metadata,
                jsonb_set(counted, "invoiceMail", mark),
            )
            .col_expr(
                billing_payments::Column::UpdatedAt,
                Expr::current_timestamp(),
            )
            .filter(billing_payments::Column::Id.eq(id))
            .filter(invoice_mail_mark().eq("sent"))
            .exec(&orm(master))
            .await?;
        Ok(())
    }

    /// A claimed invoice email with nobody to send it to.
    pub(crate) async fn drop_invoice_mail(master: &PgPool, id: &str) -> Result<(), DbErr> {
        billing_payments::Entity::update_many()
            .col_expr(
                billing_payments::Column::Metadata,
                jsonb_set(
                    Expr::col(billing_payments::Column::Metadata),
                    "invoiceMail",
                    Expr::val(json!("none")),
                ),
            )
            .col_expr(
                billing_payments::Column::UpdatedAt,
                Expr::current_timestamp(),
            )
            .filter(billing_payments::Column::Id.eq(id))
            .filter(sea_orm::ExprTrait::eq(invoice_mail_mark(), "sent"))
            .exec(&orm(master))
            .await?;
        Ok(())
    }

    /// Charges whose invoice email is due: not sent when the invoice was
    /// issued (no mailer then, or nobody took it).
    pub(crate) async fn invoice_mail_due(
        master: &PgPool,
        limit: u64,
    ) -> Result<Vec<String>, DbErr> {
        billing_payments::Entity::find()
            .select_only()
            .column(billing_payments::Column::Id)
            .filter(billing_payments::Column::Provider.eq("mollie"))
            .filter(billing_payments::Column::InvoiceId.is_not_null())
            .filter(sea_orm::ExprTrait::eq(invoice_mail_mark(), "due"))
            .order_by_asc(billing_payments::Column::PaidAt)
            .limit(limit)
            .into_tuple()
            .all(&orm(master))
            .await
    }
}
