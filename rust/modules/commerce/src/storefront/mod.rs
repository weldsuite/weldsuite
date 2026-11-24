//! The public storefront API (`/storefront/v1`, ADR COM-011): the catalogue,
//! carts and checkout of a sales channel, for a shop's frontend (a browser
//! with a publishable key `wcp_…`, or the merchant's server with a private
//! key `wcs_…`).
//!
//! No session: [`auth`] resolves the key through the master
//! `storefront_key_registry` to a workspace and channel, opens the tenant
//! database and applies the key's origin policy and CORS; [`limit`] counts
//! requests per key and client address. Every answer is `{ data }`, a list
//! `{ data, pagination: { hasMore, cursor } }`, or
//! `{ error: { code, message, details? } }` (a validation failure is 400
//! `VALIDATION_ERROR` with `details.fields`). The money, VAT and discount
//! rules are `weldsuite-commerce-domain`'s (`carts`, `checkout`), the ones
//! that price a staff member's order.

mod auth;
mod b2b;
mod cart;
mod catalogue;
pub(crate) mod limit;
mod orders;
mod payments;
mod shopper;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_commerce_domain::Error as DomainError;
use weldsuite_commerce_domain::carts::{self, Channel, Refusal};
use weldsuite_commerce_domain::money;
use weldsuite_db::{PgPool, Workspaces};
use weldsuite_events::{EntityEventPublisher, EventContext};
use weldsuite_kit::ApiError;
use weldsuite_ports::{DynCache, OutboundHttp};

/// What the storefront API needs from the server.
#[derive(Clone)]
pub struct StorefrontState {
    /// Entity events (the order a checkout places, the cart).
    pub events: EntityEventPublisher,
    /// VIES, for the buyer's VAT number; without it VIES reads as unavailable.
    pub http: Option<OutboundHttp>,
    /// The master database (`storefront_key_registry`).
    pub master: PgPool,
    /// Opens a workspace's tenant database by `workspaces.id`.
    pub workspaces: Arc<Workspaces>,
    /// Key lookups and rate-limit counters; without it nothing is limited
    /// and `last_used_at` is not kept.
    pub cache: Option<Arc<dyn DynCache>>,
    /// `TRUSTED_PROXIES`: where the client's address sits in
    /// `X-Forwarded-For`, counted from the right.
    pub trusted_proxies: usize,
    /// Payments (phase 5): Mollie at checkout, and WeldBooks.
    pub payments: crate::PaymentsConfig,
    /// System mail (sign-in codes, order confirmations, invitations,
    /// approvals); without it nothing is sent.
    pub mail: crate::mail::Mail,
    /// The online store's settings: the renderer's secret (the hosted
    /// principal) and the host cache.
    pub hosting: crate::online_store::OnlineStoreConfig,
}

impl std::fmt::Debug for StorefrontState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StorefrontState")
            .field("cache", &self.cache.is_some())
            .finish_non_exhaustive()
    }
}

/// Who is calling: the key's channel and workspace, put on the request by
/// [`auth`].
#[derive(Clone)]
pub(crate) struct Principal {
    pub(crate) db: PgPool,
    /// `workspaces.id`.
    pub(crate) workspace_id: String,
    /// `publishable`, `private` or `hosted` (the storefront renderer for a
    /// shop host), and the origins a publishable key allows (for `hosted`,
    /// the shop's own hosts).
    pub(crate) key_kind: String,
    pub(crate) key_origins: Vec<String>,
    pub(crate) channel: Channel,
    pub(crate) events: EventContext,
    pub(crate) state: StorefrontState,
}

/// The storefront API at its own paths, to merge at the server's root
/// (`/storefront/v1/…`). It answers CORS itself, per key: a publishable
/// key's allowed origins, nothing for a private key.
pub fn storefront_router(state: StorefrontState) -> Router {
    let api = Router::new()
        .route("/channel", get(catalogue::channel))
        .route("/products", get(catalogue::products))
        .route("/products/{id_or_slug}", get(catalogue::product))
        .route("/categories", get(catalogue::categories))
        .route("/categories/{id_or_slug}", get(catalogue::category))
        .route("/carts", post(cart::create))
        .route("/cart", get(cart::read).patch(cart::patch))
        .route("/cart/items", post(cart::add_item))
        .route(
            "/cart/items/{line_id}",
            axum::routing::patch(cart::set_quantity).delete(cart::remove_item),
        )
        .route("/cart/shipping-rates", get(cart::shipping_rates))
        .route("/cart/shipping-rate", put(cart::set_rate))
        .route(
            "/cart/discount",
            post(cart::apply_discount).delete(cart::remove_discount),
        )
        .route("/cart/checkout", post(cart::checkout))
        .route("/cart/quick-order", post(orders::quick_order))
        .route("/auth/code", post(shopper::request_code))
        .route("/auth/verify", post(shopper::verify))
        .route("/auth/sign-out", post(shopper::sign_out))
        .route("/account", get(shopper::read).patch(shopper::patch))
        .route("/account/company", put(shopper::select_company))
        .route("/account/orders", get(orders::list))
        .route("/account/orders/{id}", get(orders::read))
        .route("/account/orders/{id}/reorder", post(orders::reorder))
        .route("/orders/{id}", get(orders::guest))
        .route("/account/approvals", get(b2b::approvals))
        .route("/account/approvals/{order_id}/approve", post(b2b::approve))
        .route("/account/approvals/{order_id}/reject", post(b2b::reject))
        .route("/account/buyers", get(b2b::buyers).post(b2b::add_buyer))
        .route(
            "/account/buyers/{buyer_id}",
            axum::routing::patch(b2b::patch_buyer).delete(b2b::remove_buyer),
        )
        .route("/payments/{payment_id}", get(payments::read))
        .route("/payments/{payment_id}/retry", post(payments::retry))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn_with_state(state, auth::authenticate));
    Router::new().nest("/storefront/v1", api)
}

async fn not_found() -> Response {
    fail(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        "No such storefront route",
        None,
    )
}

/// An error answer.
pub(crate) fn fail(
    status: StatusCode,
    code: &'static str,
    message: &str,
    details: Option<Value>,
) -> Response {
    let error = ApiError::new(status, code, message);
    match details {
        Some(details) => error.with_details(details).into_response(),
        None => error.into_response(),
    }
}

pub(crate) fn data(value: Value) -> Response {
    weldsuite_kit::Data(value).into_response()
}

pub(crate) fn created(value: Value) -> Response {
    weldsuite_kit::Created(value).into_response()
}

pub(crate) fn internal(error: &dyn std::fmt::Display, message: &str) -> Response {
    tracing::error!(%error, "[storefront] {message}");
    fail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR",
        message,
        None,
    )
}

/// 400 `VALIDATION_ERROR` with `details.fields`.
pub(crate) fn validation(problems: &[(String, String)]) -> Response {
    let fields: Map<String, Value> = problems
        .iter()
        .map(|(path, message)| (path.clone(), json!(message)))
        .collect();
    fail(
        StatusCode::BAD_REQUEST,
        "VALIDATION_ERROR",
        "The request is not valid",
        Some(json!({ "fields": fields })),
    )
}

#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
/// The JSON object a request carries; an empty body is `{}`.
pub(crate) fn body_object(body: &Bytes) -> Result<Map<String, Value>, Response> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err(validation(&[(
            "body".to_owned(),
            "Must be a JSON object".to_owned(),
        )])),
    }
}

fn conflict(code: &'static str, message: &str, details: Option<Value>) -> Response {
    fail(StatusCode::CONFLICT, code, message, details)
}

fn line_list(lines: &[(String, &'static str)]) -> Vec<Value> {
    lines
        .iter()
        .map(|(id, problem)| json!({ "lineId": id, "problem": problem }))
        .collect()
}

/// The domain's refusal as the API's answer.
pub(crate) fn refuse(refusal: Refusal) -> Response {
    match refusal {
        Refusal::Database(error) => internal(&error, "The request could not be completed"),
        Refusal::CartNotFound => fail(
            StatusCode::NOT_FOUND,
            "CART_NOT_FOUND",
            "Cart not found",
            None,
        ),
        Refusal::CartNotOpen(status) => conflict(
            "CART_NOT_OPEN",
            "The cart can no longer be changed",
            Some(json!({ "status": status })),
        ),
        Refusal::Validation(problems) => validation(&problems),
        Refusal::NotSellable(why) => conflict("NOT_SELLABLE", &why, None),
        Refusal::CountryNotSold(country) => conflict(
            "COUNTRY_NOT_SOLD",
            "This channel does not sell to that country",
            Some(json!({ "country": country })),
        ),
        Refusal::RateNotAvailable => conflict(
            "RATE_NOT_AVAILABLE",
            "That shipping rate is not available for the cart's destination",
            None,
        ),
        Refusal::DiscountNotApplicable(problem) => conflict(
            "DISCOUNT_NOT_APPLICABLE",
            &format!("The discount code does not apply: {}", problem.as_str()),
            Some(json!({ "reason": problem.as_str() })),
        ),
        Refusal::TooLarge => conflict("CART_TOO_LARGE", "The cart has too many lines", None),
        Refusal::Domain(error) => domain(error),
        Refusal::NotReady { missing, lines } => conflict(
            "CART_NOT_READY",
            "The cart is not ready for checkout",
            Some(json!({ "missing": missing, "lines": line_list(&lines) })),
        ),
        Refusal::OutOfStock(lines) => conflict(
            "OUT_OF_STOCK",
            "Some items are no longer in stock",
            Some(json!({
                "lines": lines
                    .iter()
                    .map(|(id, available)| json!({ "lineId": id, "available": available }))
                    .collect::<Vec<_>>(),
            })),
        ),
        Refusal::PriceChanged(total) => conflict(
            "PRICE_CHANGED",
            "The total has changed",
            Some(json!({ "total": money::format(total) })),
        ),
        Refusal::PaymentMethodNotEnabled => conflict(
            "PAYMENT_METHOD_NOT_ENABLED",
            "This channel does not offer that payment method",
            None,
        ),
        Refusal::GuestCheckoutDisabled => conflict(
            "GUEST_CHECKOUT_DISABLED",
            "This channel does not allow checkout without signing in",
            None,
        ),
        Refusal::PaymentProviderNotConnected => conflict(
            "PAYMENT_PROVIDER_NOT_CONNECTED",
            "The shop has not connected a payment provider yet",
            None,
        ),
        Refusal::IdempotencyKeyReused => conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "That Idempotency-Key belongs to another cart",
            None,
        ),
    }
}

pub(crate) fn domain(error: DomainError) -> Response {
    match error {
        DomainError::Database(error) => internal(&error, "The request could not be completed"),
        DomainError::Invalid { field, message } => validation(&[(field, message)]),
        DomainError::SellerEntityRequired => conflict(
            "SELLER_ENTITY_REQUIRED",
            "The shop is not set up to sell yet",
            None,
        ),
        DomainError::SellerNotEu { country } => conflict(
            "SELLER_ENTITY_NOT_EU",
            "The shop's seller entity is outside the EU",
            Some(json!({ "country": country })),
        ),
        DomainError::DestinationNotSupported { country } => conflict(
            "COUNTRY_NOT_SOLD",
            "This channel does not sell to that country",
            Some(json!({ "country": country })),
        ),
        DomainError::PaymentInProgress => conflict(
            "PAYMENT_IN_PROGRESS",
            "The order has a payment in progress",
            None,
        ),
        DomainError::ApprovalPending => conflict(
            "APPROVAL_PENDING",
            "The order is waiting for approval",
            None,
        ),
        DomainError::BuyerExists => conflict(
            "BUYER_EXISTS",
            "This person is a buyer of the company already",
            None,
        ),
        DomainError::LastAdmin => {
            conflict("LAST_ADMIN", "A company needs at least one admin", None)
        }
        DomainError::NotABuyer => fail(
            StatusCode::FORBIDDEN,
            "NOT_A_BUYER",
            "You are not a buyer of that company",
            None,
        ),
        DomainError::NotAnApprover => fail(
            StatusCode::FORBIDDEN,
            "NOT_AN_APPROVER",
            "You cannot approve orders of this company",
            None,
        ),
        DomainError::NotPending => conflict(
            "NOT_PENDING",
            "The order is not waiting for an approval",
            None,
        ),
        DomainError::CompanyRequired => conflict(
            "COMPANY_REQUIRED",
            "Sign in and choose the company you are ordering for",
            None,
        ),
        DomainError::NoPaymentTerms => conflict(
            "NO_PAYMENT_TERMS",
            "The company has no payment terms, so it cannot pay on invoice",
            None,
        ),
        DomainError::CreditLimitExceeded { available } => conflict(
            "CREDIT_LIMIT_EXCEEDED",
            "The order would take the company past its credit limit",
            Some(json!({ "available": money::format(available) })),
        ),
        DomainError::TaxEngineUnavailable(why) => {
            tracing::warn!(%why, "[storefront] the VAT engine could not answer");
            fail(
                StatusCode::SERVICE_UNAVAILABLE,
                "TAX_ENGINE_UNAVAILABLE",
                "The VAT could not be calculated right now. Try again.",
                None,
            )
        }
        other => internal(&other, "The request could not be completed"),
    }
}

#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
/// The cart token the request carries. A session sent with it (`X-Shopper-Token`)
/// attaches the cart to the shopper, and on a B2B channel to the company they
/// buy for; a guest cart stays a guest cart.
pub(crate) async fn cart_token(
    principal: &Principal,
    headers: &HeaderMap,
) -> Result<String, Response> {
    let token = headers
        .get("x-cart-token")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| refuse(Refusal::CartNotFound))?;
    if let Some(loaded) = shopper::optional(principal, headers).await? {
        let who = orders::attach_of(&loaded, principal.channel.audience == "b2b");
        carts::attach(&cart::ctx(principal), &token, &who)
            .await
            .map_err(|e| internal(&e, "The cart could not be attached"))?;
    }
    Ok(token)
}
