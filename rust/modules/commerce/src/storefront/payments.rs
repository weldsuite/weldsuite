//! Mollie at storefront checkout (ADR COM-013) and the return page's
//! routes: `GET /payments/:paymentId`, `POST /payments/:paymentId/retry`.
//!
//! The order is placed (`pending`) and committed first; the Mollie payment
//! is created after, with no transaction open. When Mollie refuses or cannot
//! be reached the order stays `pending` with no payment and the answer is
//! 502 `PROVIDER_ERROR` with `details.orderId`; checking out again with the
//! same `Idempotency-Key` returns that order and tries the payment again.
//!
//! A shopper's return to the shop never marks anything paid: the payment is
//! read back from Mollie (here when the page asks and the payment is still
//! open; otherwise by Mollie's webhook).

use axum::Extension;
use axum::extract::Path;
use axum::response::Response;
use http::StatusCode;
use serde_json::{Value, json};
use weldsuite_commerce_domain::payments::connection;
use weldsuite_commerce_domain::payments::service::{self, NewOrderPayment};
use weldsuite_commerce_domain::payments::{Env, Error as PaymentError};

use super::{Principal, conflict, data, fail, internal};
use crate::payments::{Settle, settle_after_apply, settle_created};

#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
fn env(principal: &Principal) -> Result<Env<'_>, Response> {
    let http = principal.state.http.as_ref().ok_or_else(unavailable)?;
    Ok(principal.state.payments.env(&principal.db, http))
}

fn unavailable() -> Response {
    fail(
        StatusCode::SERVICE_UNAVAILABLE,
        "PAYMENTS_UNAVAILABLE",
        "Payments are not available on this server",
        None,
    )
}

fn not_connected(details: Option<Value>) -> Response {
    conflict(
        "PAYMENT_PROVIDER_NOT_CONNECTED",
        "The shop has not connected a payment provider yet",
        details,
    )
}

fn settle(principal: &Principal) -> Settle<'_> {
    Settle {
        events: &principal.state.events,
        ctx: &principal.events,
        db: &principal.db,
        config: &principal.state.payments,
        workspace_id: &principal.workspace_id,
        user_id: "system",
    }
}

/// A publishable key's `redirectUrl` must be on one of the key's allowed
/// origins; a private key (the merchant's server) may redirect anywhere
/// `https`.
pub(super) fn redirect_allowed(principal: &Principal, redirect: &str) -> bool {
    if principal.key_kind != "publishable" {
        return true;
    }
    let Ok(url) = url::Url::parse(redirect) else {
        return false;
    };
    let origin = url.origin().ascii_serialization();
    principal
        .key_origins
        .iter()
        .any(|allowed| allowed.trim_end_matches('/').eq_ignore_ascii_case(&origin))
}

/// The shop has a usable Mollie connection.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
pub(super) async fn connected(principal: &Principal) -> Result<(), Response> {
    match connection::row(&principal.db).await {
        Ok(Some(row)) if row["status"] == "connected" => Ok(()),
        Ok(_) => Err(not_connected(None)),
        Err(error) => Err(internal(&error, "Checkout failed")),
    }
}

/// The server can reach Mollie and say where its webhooks go.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
pub(super) fn reachable(principal: &Principal) -> Result<(), Response> {
    if principal.state.http.is_none() || principal.state.payments.public_url.is_none() {
        return Err(unavailable());
    }
    Ok(())
}

fn shown(payment: &Value) -> Value {
    json!({
        "id": payment["id"],
        "status": payment["status"],
        "checkoutUrl": payment["checkoutUrl"],
    })
}

fn failure(error: PaymentError, order_id: &str) -> Response {
    let details = Some(json!({ "orderId": order_id }));
    match error {
        PaymentError::Provider(message) => {
            tracing::warn!(%message, order_id, "[storefront] the Mollie payment could not be created");
            fail(
                StatusCode::BAD_GATEWAY,
                "PROVIDER_ERROR",
                "The payment could not be started. Try again.",
                details,
            )
        }
        PaymentError::NotConnected => not_connected(details),
        PaymentError::AlreadyPaid => conflict("ALREADY_PAID", "The order is already paid", details),
        PaymentError::NotPayable(why) => conflict("ORDER_NOT_PAYABLE", &why, details),
        other => internal(&other, "The payment could not be started"),
    }
}

/// The Mollie payment of a placed order, as `{ id, status, checkoutUrl }`;
/// `redirect_url` is where the shopper returns to (`?order=<id>` added).
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
pub(super) async fn create(
    principal: &Principal,
    order_id: &str,
    redirect_url: &str,
) -> Result<Value, Response> {
    let env = env(principal)?;
    let Some(public_url) = principal.state.payments.public_url.as_deref() else {
        return Err(unavailable());
    };
    let redirect = weldsuite_mollie::with_query(redirect_url, "order", order_id)
        .unwrap_or_else(|| redirect_url.to_owned());
    match service::create_for_order(
        &env,
        &NewOrderPayment {
            order_id,
            workspace_id: &principal.workspace_id,
            redirect_url: &redirect,
            public_url,
            locale: None,
        },
    )
    .await
    {
        Ok(payment) => Ok(shown(&payment)),
        Err(error) => Err(failure(error, order_id)),
    }
}

/// The finalised, unpaid invoice of an order placed on invoice (a B2B
/// channel). A failure stays on the order (`metadata.invoiceError`); the
/// order is placed either way.
pub(super) async fn invoice_on_placement(principal: &Principal, order_id: &str) {
    let Some(invoicing) = principal.state.payments.invoicing.as_ref() else {
        return;
    };
    let actor = weldsuite_commerce_domain::payments::books::Actor {
        db: &principal.db,
        workspace_id: &principal.workspace_id,
        clerk_org_id: Some(&principal.events.workspace_id),
        user_id: "storefront",
    };
    let _ = weldsuite_commerce_domain::payments::books::invoice_order(
        invoicing.as_ref(),
        actor,
        order_id,
        false,
        false,
    )
    .await;
}

/// A payment of an order on this channel, with the order's number.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
async fn find(
    principal: &Principal,
    payment_id: &str,
) -> Result<(Value, String, String), Response> {
    let payment = service::by_id(&principal.db, payment_id)
        .await
        .map_err(|e| internal(&e, "The payment could not be read"))?;
    let missing = || {
        fail(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            "Payment not found",
            None,
        )
    };
    let Some(payment) = payment else {
        return Err(missing());
    };
    let order: Option<(String, String, Option<String>)> = sqlx::query_as(
        "select id, order_number, channel_id from orders where id = $1 and deleted_at is null",
    )
    .bind(payment["orderId"].as_str())
    .fetch_optional(&principal.db)
    .await
    .map_err(|e| internal(&e, "The payment could not be read"))?;
    match order {
        Some((id, number, Some(channel))) if channel == principal.channel.id => {
            Ok((payment, id, number))
        }
        _ => Err(missing()),
    }
}

/// `GET /payments/:paymentId`: for the shop's return page.
pub(crate) async fn read(
    Extension(principal): Extension<Principal>,
    Path(payment_id): Path<String>,
) -> Response {
    let (mut payment, order_id, number) = match find(&principal, &payment_id).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    if service::waiting(&payment)
        && let Ok(env) = env(&principal)
    {
        match service::read_back(&env, &payment).await {
            Ok(applied) => {
                settle_after_apply(&settle(&principal), &applied).await;
                if let Ok(Some(fresh)) = service::by_id(&principal.db, &payment_id).await {
                    payment = fresh;
                }
            }
            Err(error) => {
                tracing::warn!(%error, "[storefront] a payment could not be read back");
            }
        }
    }
    data(json!({
        "id": payment["id"],
        "status": payment["status"],
        "orderId": order_id,
        "orderNumber": number,
        "checkoutUrl": payment["checkoutUrl"],
    }))
}

/// `POST /payments/:paymentId/retry`: a new payment for the unpaid order.
pub(crate) async fn retry(
    Extension(principal): Extension<Principal>,
    Path(payment_id): Path<String>,
) -> Response {
    let (payment, order_id, _) = match find(&principal, &payment_id).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    if let Err(response) = connected(&principal).await {
        return response;
    }
    let redirect = payment["redirectUrl"].as_str().unwrap_or_default();
    match create(&principal, &order_id, &strip_order(redirect)).await {
        Ok(created) => {
            settle_created(&settle(&principal), &order_id).await;
            super::created(created)
        }
        Err(response) => response,
    }
}

/// The redirect URL as the shop gave it, without the `order` the payment
/// added.
fn strip_order(redirect: &str) -> String {
    let Ok(mut url) = url::Url::parse(redirect) else {
        return redirect.to_owned();
    };
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(name, _)| name != "order")
        .map(|(n, v)| (n.into_owned(), v.into_owned()))
        .collect();
    url.set_query(None);
    if !kept.is_empty() {
        url.query_pairs_mut().extend_pairs(kept);
    }
    url.into()
}
