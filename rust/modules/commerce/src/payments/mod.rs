//! Payments (phase 5, ADR COM-013): the workspace's Mollie connection
//! (`/api/commerce-payments`), the payments, refunds and invoice of an order
//! (`/api/orders/:id/…`), Mollie's webhook and the OAuth callback (public),
//! and what follows a payment: events, and WeldBooks.
//!
//! The money rules live in `weldsuite_commerce_domain::payments`; this
//! module reads requests, maps refusals to responses, presents rows and
//! publishes the events.

mod connection;
mod order;
mod public;
mod registry;
mod settle;
mod state;

use http::StatusCode;
use serde_json::{Value, json};
use weldsuite_commerce_domain::payments::Error as PaymentError;
use weldsuite_kit::ApiError;
use weldsuite_ports::OutboundHttp;

use crate::wire::{amount, iso};
use crate::{CommerceState, Refusal};

pub(crate) use connection::routes;
pub(crate) use order::routes as order_routes;
pub use public::{PaymentsPublicState, public_router};
pub(crate) use settle::{Settle, settle_after_apply, settle_created};

/// The outbound HTTP the provider is called through; 503 without it.
pub(crate) fn http(state: &CommerceState) -> Result<&OutboundHttp, Refusal> {
    state.http.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "PAYMENTS_UNAVAILABLE",
            "Payments are not available on this server",
        )
        .into()
    })
}

/// The payment domain's refusal as the API's answer.
pub(crate) fn refuse(error: PaymentError) -> Refusal {
    let conflict = |code: &'static str, message: &str, details: Option<Value>| {
        let error = ApiError::new(StatusCode::CONFLICT, code, message);
        match details {
            Some(details) => Refusal::from(error.with_details(details)),
            None => Refusal::from(error),
        }
    };
    match error {
        PaymentError::Database(error) => Refusal::Database(error),
        PaymentError::NotConnected => conflict(
            "PAYMENT_PROVIDER_NOT_CONNECTED",
            "No payment provider is connected",
            None,
        ),
        PaymentError::AlreadyPaid => conflict("ALREADY_PAID", "The order is already paid", None),
        PaymentError::NotPayable(why) => conflict("ORDER_NOT_PAYABLE", &why, None),
        PaymentError::NothingToRefund => {
            conflict("NOTHING_TO_REFUND", "There is nothing left to refund", None)
        }
        PaymentError::RefundTooLarge { refundable } => conflict(
            "REFUND_TOO_LARGE",
            "The refund is larger than what is left on the payment",
            Some(json!({ "refundable": weldsuite_commerce_domain::money::format(refundable) })),
        ),
        PaymentError::Provider(message) => ApiError::new(
            StatusCode::BAD_GATEWAY,
            "PROVIDER_ERROR",
            format!("The payment provider answered: {message}"),
        )
        .into(),
        PaymentError::Invalid { field, message } => crate::wire::invalid(&field, &message),
        PaymentError::NotFound { resource, id } => Refusal::not_found(resource, &id),
        PaymentError::Credentials(why) => {
            tracing::error!(%why, "[commerce] stored payment credentials cannot be opened");
            ApiError::internal()
                .with_message("The stored payment credentials cannot be opened")
                .into()
        }
    }
}

/// A payment as the API shows it.
pub(crate) fn present_payment(row: &Value) -> Value {
    let get = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    let date = |key: &str| row.get(key).map_or(Value::Null, iso);
    json!({
        "id": get("id"),
        "provider": get("provider"),
        "providerPaymentId": get("providerPaymentId"),
        "status": get("status"),
        "amount": amount(&get("amount"), "0.00"),
        "amountRefunded": amount(&get("amountRefunded"), "0.00"),
        "currency": get("currency"),
        "method": get("method"),
        "checkoutUrl": get("checkoutUrl"),
        "testmode": row.get("testmode").and_then(Value::as_bool).unwrap_or(false),
        "failureReason": get("failureReason"),
        "createdAt": date("createdAt"),
        "paidAt": date("paidAt"),
        "failedAt": date("failedAt"),
        "expiredAt": date("expiredAt"),
    })
}

/// A refund as the API shows it.
pub(crate) fn present_refund(row: &Value) -> Value {
    let get = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    let date = |key: &str| row.get(key).map_or(Value::Null, iso);
    json!({
        "id": get("id"),
        "paymentId": get("paymentId"),
        "providerRefundId": get("providerRefundId"),
        "status": get("status"),
        "amount": amount(&get("amount"), "0.00"),
        "currency": get("currency"),
        "reason": get("reason"),
        "creditNoteId": get("creditNoteId"),
        "createdAt": date("createdAt"),
        "refundedAt": date("refundedAt"),
    })
}
