//! Payments (ADR COM-013): a payment provider port, Mollie as its first
//! adapter, on each workspace's own Mollie account.
//!
//! - [`provider`]: the port ([`provider::PaymentProvider`]: create a payment,
//!   read it back, refund, list refunds) and the Mollie adapter.
//! - [`connection`]: the workspace's connection and its tokens (encrypted;
//!   refreshed before they expire and on a 401; `needs_reauth` when a refresh
//!   fails).
//! - [`service`]: payments and refunds of an order, and the read-back that
//!   applies a provider's state to `commerce_payments`, `commerce_refunds`
//!   and the order.
//! - [`books`]: the WeldBooks side (an invoice for a paid order, a credit
//!   note for a refund) behind a port the books module implements.
//!
//! Two rules run through all of it. **Paid means confirmed by the provider**:
//! an order becomes paid only when the payment is read back as paid, never
//! from a redirect or a request body. And **the tenant pool holds one
//! connection in production**: every function here that takes a pool
//! (`&PgPool`) holds a connection only for one statement or one short
//! transaction, and never calls the provider (or asks the pool for another
//! connection) while holding one. A function that takes a `&mut PgConnection`
//! runs inside the caller's transaction and does no HTTP.

pub mod books;
pub mod connection;
pub mod provider;
pub mod service;

use serde_json::Value;
use weldsuite_db::{Keyring, PgPool};
use weldsuite_mollie::connect::ConnectApp;
use weldsuite_ports::OutboundHttp;

use crate::money::Cents;

/// What the payment functions need from the server.
#[derive(Clone, Copy)]
pub struct Env<'a> {
    pub db: &'a PgPool,
    pub http: &'a OutboundHttp,
    /// Opens the stored tokens and keys.
    pub keyring: &'a Keyring,
    /// Mollie's API (`https://api.mollie.com/v2`).
    pub api_url: &'a str,
    /// The install's Mollie Connect app; without it OAuth is unavailable.
    pub connect: Option<&'a ConnectApp>,
}

/// Why a payment operation was refused.
#[derive(Debug)]
pub enum Error {
    /// A failed statement (ORM or SQL).
    Database(sea_orm::DbErr),
    /// No usable connection (409 `PAYMENT_PROVIDER_NOT_CONNECTED`).
    NotConnected,
    /// The order is paid (409 `ALREADY_PAID`).
    AlreadyPaid,
    /// The order cannot take a payment: cancelled, on invoice (409
    /// `ORDER_NOT_PAYABLE`).
    NotPayable(String),
    /// No paid payment has anything left to refund (409 `NOTHING_TO_REFUND`).
    NothingToRefund,
    /// More than the payment still holds (409 `REFUND_TOO_LARGE`).
    RefundTooLarge {
        refundable: Cents,
    },
    /// The provider refused or could not be reached (502 `PROVIDER_ERROR`).
    Provider(String),
    /// An input the rules refuse (400).
    Invalid {
        field: String,
        message: String,
    },
    NotFound {
        resource: &'static str,
        id: String,
    },
    /// Stored credentials could not be opened (a missing or changed key).
    Credentials(String),
}

impl From<sea_orm::DbErr> for Error {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::Database(error)
    }
}

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(crate::db::from_sqlx(error))
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(f, "database: {error}"),
            Self::NotConnected => f.write_str("no payment provider is connected"),
            Self::AlreadyPaid => f.write_str("the order is paid"),
            Self::NotPayable(why) | Self::Provider(why) | Self::Credentials(why) => {
                f.write_str(why)
            }
            Self::NothingToRefund => f.write_str("nothing to refund"),
            Self::RefundTooLarge { .. } => f.write_str("the refund is larger than what is left"),
            Self::Invalid { field, message } => write!(f, "{field}: {message}"),
            Self::NotFound { resource, id } => write!(f, "{resource} {id} not found"),
        }
    }
}

impl std::error::Error for Error {}

/// The columns of a `commerce_payments` row as the API reads them (camelCase;
/// timestamps as Postgres writes them).
pub(crate) const PAYMENT_ROW: &str = "jsonb_build_object('id', id, 'orderId', order_id, \
    'connectionId', connection_id, 'provider', provider, 'providerPaymentId', provider_payment_id, \
    'status', status, 'amount', amount::text, 'amountRefunded', amount_refunded::text, \
    'currency', currency, 'method', method, 'checkoutUrl', checkout_url, \
    'redirectUrl', redirect_url, 'testmode', testmode, 'failureReason', failure_reason, \
    'createdAt', created_at, 'paidAt', paid_at, 'failedAt', failed_at, \
    'expiredAt', expired_at, 'canceledAt', canceled_at, 'expiresAt', expires_at)";

/// The columns of a `commerce_refunds` row.
pub(crate) const REFUND_ROW: &str = "jsonb_build_object('id', id, 'orderId', order_id, \
    'paymentId', payment_id, 'provider', provider, 'providerRefundId', provider_refund_id, \
    'status', status, 'amount', amount::text, 'currency', currency, 'reason', reason, \
    'creditNoteId', credit_note_id, 'createdAt', created_at, 'refundedAt', refunded_at, \
    'failedAt', failed_at)";

/// A text property of a row.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// An amount property of a row, in cents (0 when absent).
pub(crate) fn cents(row: &Value, key: &str) -> Cents {
    text(row, key).and_then(crate::money::parse).unwrap_or(0)
}

/// Whether a payment status still waits on the shopper.
#[must_use]
pub fn is_open(status: &str) -> bool {
    matches!(status, "open" | "pending" | "authorized")
}
