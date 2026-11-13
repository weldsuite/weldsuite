//! Buying credits on the Kubernetes editions: a Mollie payment for a
//! `credit_packages` row (ADR OPS-012: Mollie, Amsterdam, is the EU
//! edition's payment provider). Global's twin is a Stripe Checkout through
//! billing-worker (`billing-worker/src/routes/credit-topup.ts`, granted by
//! `handleCreditTopupCheckout` in `routes/webhooks.ts`).
//!
//! 1. `POST /api/credits/checkout` (`groups::credits`) creates the payment
//!    for the package's EUR price and answers Mollie's hosted checkout, the
//!    `{ data: { url } }` the platform already redirects to. The payment's
//!    metadata names the workspace, the package, the credits quoted and the
//!    member; the customer returns to the platform's `successUrl` with
//!    `checkout=<id>` added (Mollie has one return address for every
//!    outcome), or to its `cancelUrl` after cancelling on Mollie's page.
//! 2. `POST /api/webhooks/mollie` ([`webhook_router`]) gets only `id=tr_…`
//!    from Mollie. The body is never trusted: the payment is read back, and
//!    a paid one grants its credits once (idempotency key on the payment
//!    id, [`ledger`]); a refund or chargeback in full takes them back. Any
//!    other state changes nothing. Anything that should be retried (Mollie
//!    or the database unreachable) answers 5xx, and Mollie retries.
//! 3. `GET /api/credits/checkout/:id` ([`TopUp::status`]): the return page
//!    asks how its checkout ended. The pending checkout is kept in the cache
//!    for a week; a paid payment the webhook hasn't settled yet is settled
//!    here (the same idempotent grant). Without the cached checkout the
//!    ledger says whether it was paid.
//!
//! Mollie is only the payment: no invoice or VAT document is made for a
//! top-up (Global's comes from Stripe).

pub mod ledger;
pub mod mollie;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRequestParts, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::StatusCode;
use http::request::Parts;
use serde_json::{Value, json};
use weldsuite_db::{MasterDb, PgPool};
use weldsuite_kit::{ApiError, generate_id};
use weldsuite_ports::{DynCache, OutboundHttp};

use crate::{CorePlatformState, PlatformError, PlatformResult};
use ledger::{Applied, Purchase, Reversed};
use mollie::{Mollie, Money, NewPayment, Payment, PaymentStatus};

/// Where the webhook is served.
pub const WEBHOOK_PATH: &str = "/api/webhooks/mollie";

/// The currency every package must be priced in.
pub const CURRENCY: &str = "EUR";

/// How long the return page can look its checkout up.
const PENDING_TTL: Duration = Duration::from_hours(7 * 24);

/// The payment metadata's `kind`, as Global's Stripe sessions carry it.
const KIND: &str = "credit_topup";

/// The settings that turn the top-up on.
#[derive(Clone, PartialEq, Eq)]
pub struct TopUpSettings {
    /// `MOLLIE_API_KEY`.
    pub api_key: String,
    /// `MOLLIE_API_URL` (tests), else Mollie's.
    pub api_url: String,
    /// `MOLLIE_WEBHOOK_URL`, else `<PUBLIC_API_URL>/api/webhooks/mollie`
    /// (`APP_API_PUBLIC_URL`, `PUBLIC_URL` after it).
    pub webhook_url: String,
    /// `MOLLIE_REDIRECT_URL`, else `<PUBLIC_APP_URL>/settings/billing?credits=success`
    /// (`PUBLIC_URL` after it): where a checkout returns when the client sent
    /// no `successUrl`.
    pub redirect_url: String,
}

impl std::fmt::Debug for TopUpSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TopUpSettings")
            .field("api_url", &self.api_url)
            .field("webhook_url", &self.webhook_url)
            .field("redirect_url", &self.redirect_url)
            .finish_non_exhaustive()
    }
}

/// The first set, non-blank value of `names`.
fn first(lookup: &impl Fn(&str) -> Option<String>, names: &[&str]) -> Option<String> {
    names
        .iter()
        .filter_map(|name| lookup(name))
        .map(|value| value.trim().to_owned())
        .find(|value| !value.is_empty())
}

/// An absolute `http(s)` URL.
fn is_web_url(text: &str) -> bool {
    url::Url::parse(text).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

impl TopUpSettings {
    /// From the environment: `Ok(None)` without `MOLLIE_API_KEY` (no top-up),
    /// `Err` with a key but no usable webhook or return address (a start
    /// problem: payments could never be confirmed).
    pub fn from_lookup(lookup: &impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let Some(api_key) = first(lookup, &["MOLLIE_API_KEY"]) else {
            return Ok(None);
        };
        let api_url = first(lookup, &["MOLLIE_API_URL"])
            .unwrap_or_else(|| mollie::DEFAULT_API_URL.to_owned());
        let webhook_url = first(lookup, &["MOLLIE_WEBHOOK_URL"]).or_else(|| {
            first(
                lookup,
                &["PUBLIC_API_URL", "APP_API_PUBLIC_URL", "PUBLIC_URL"],
            )
            .map(|origin| format!("{}{WEBHOOK_PATH}", origin.trim_end_matches('/')))
        });
        let redirect_url = first(lookup, &["MOLLIE_REDIRECT_URL"]).or_else(|| {
            first(lookup, &["PUBLIC_APP_URL", "PUBLIC_URL"]).map(|origin| {
                format!(
                    "{}/settings/billing?credits=success",
                    origin.trim_end_matches('/')
                )
            })
        });
        match (webhook_url, redirect_url) {
            (Some(webhook_url), Some(redirect_url))
                if is_web_url(&webhook_url)
                    && is_web_url(&redirect_url)
                    && is_web_url(&api_url) =>
            {
                Ok(Some(Self {
                    api_key,
                    api_url,
                    webhook_url,
                    redirect_url,
                }))
            }
            _ => Err(
                "MOLLIE_API_KEY is set, but Mollie can't confirm payments: set MOLLIE_WEBHOOK_URL \
                 and MOLLIE_REDIRECT_URL (absolute URLs), or PUBLIC_URL (chart config.publicUrl)"
                    .to_owned(),
            ),
        }
    }
}

/// Whether the environment turns the top-up on: the `credit-top-up` edition
/// feature.
pub fn top_up_configured(lookup: &impl Fn(&str) -> Option<String>) -> bool {
    matches!(TopUpSettings::from_lookup(lookup), Ok(Some(_)))
}

/// The top-up: Mollie, the addresses it returns to, and where pending
/// checkouts are kept.
pub struct TopUp {
    mollie: Mollie,
    webhook_url: String,
    redirect_url: String,
    /// The process's client; a request's own (conformance) wins.
    http: Option<OutboundHttp>,
    /// Pending checkouts; without one the return page reads the ledger only.
    cache: Option<Arc<dyn DynCache>>,
}

impl std::fmt::Debug for TopUp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TopUp")
            .field("mollie", &self.mollie)
            .field("webhook_url", &self.webhook_url)
            .finish_non_exhaustive()
    }
}

/// What the checkout route read from its body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CheckoutInput {
    pub package_id: String,
    pub success_url: Option<String>,
    pub cancel_url: Option<String>,
}

/// Who starts a checkout.
#[derive(Debug, Clone, Copy)]
pub struct Buyer<'a> {
    pub workspace_id: &'a str,
    pub user_id: &'a str,
}

/// A package as the checkout prices it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Package {
    id: String,
    name: String,
    credits: i64,
    price: Option<Money>,
}

/// What the cache keeps of a pending checkout.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    payment_id: String,
    workspace_id: String,
    package_id: String,
    credits: i64,
}

fn pending_key(checkout_id: &str) -> String {
    format!("credits:topup:{checkout_id}")
}

/// A checkout id as [`TopUp::start`] makes them.
fn is_checkout_id(id: &str) -> bool {
    id.strip_prefix("ctp_").is_some_and(|rest| {
        !rest.is_empty() && rest.len() <= 40 && rest.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

/// `url` with `name=value` added to its query.
fn with_query(url: &str, name: &str, value: &str) -> Option<String> {
    let mut url = url::Url::parse(url).ok()?;
    url.query_pairs_mut().append_pair(name, value);
    Some(url.into())
}

/// A whole number of credits from metadata (Mollie keeps what it was given:
/// a number, or a string).
fn whole(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// What a payment's state means for the wallet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settlement {
    /// Paid: grant the credits (once).
    Grant(Purchase),
    /// Paid, then refunded or charged back in full: take the credits back.
    Reverse { payment_id: String },
    /// Nothing to do, and why.
    Ignore(&'static str),
}

/// What `payment` means for the wallet: only a paid top-up of ours grants.
pub fn settlement(payment: &Payment) -> Settlement {
    if payment.status != PaymentStatus::Paid {
        return Settlement::Ignore("not paid");
    }
    let metadata = &payment.metadata;
    if metadata.get("kind").and_then(Value::as_str) != Some(KIND) {
        return Settlement::Ignore("not a credit top-up");
    }
    if payment.fully_reversed() {
        return Settlement::Reverse {
            payment_id: payment.id.clone(),
        };
    }
    let Some(workspace_id) = text(metadata.get("workspaceId")) else {
        return Settlement::Ignore("no workspace in the metadata");
    };
    let Some(credits) = whole(metadata.get("credits")).filter(|credits| *credits > 0) else {
        return Settlement::Ignore("no credits in the metadata");
    };
    let Some(amount) = payment.amount.clone() else {
        return Settlement::Ignore("no amount");
    };
    Settlement::Grant(Purchase {
        payment_id: payment.id.clone(),
        checkout_id: text(metadata.get("checkoutId")),
        workspace_id,
        package_id: text(metadata.get("packageId")),
        user_id: text(metadata.get("userId")),
        credits,
        amount,
    })
}

/// What settling a payment did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settled {
    Granted(Applied),
    Reversed(Reversed),
    Ignored(&'static str),
}

/// Applies a payment's state to the wallet ([`settlement`]): idempotent, so
/// the webhook and the return page may both call it for the same payment.
pub async fn settle(master: &PgPool, payment: &Payment) -> Result<Settled, sqlx::Error> {
    match settlement(payment) {
        Settlement::Grant(purchase) => Ok(Settled::Granted(
            ledger::grant_purchase(master, &purchase).await?,
        )),
        Settlement::Reverse { payment_id } => Ok(Settled::Reversed(
            ledger::reverse_purchase(master, &payment_id).await?,
        )),
        Settlement::Ignore(reason) => Ok(Settled::Ignored(reason)),
    }
}

/// The return page's word for a payment's state.
fn status_word(status: &PaymentStatus) -> &'static str {
    match status {
        PaymentStatus::Paid => "paid",
        PaymentStatus::Canceled => "canceled",
        PaymentStatus::Expired => "expired",
        PaymentStatus::Failed => "failed",
        PaymentStatus::Open
        | PaymentStatus::Pending
        | PaymentStatus::Authorized
        | PaymentStatus::Other(_) => "pending",
    }
}

fn checkout_not_found() -> PlatformError {
    ApiError::not_found("Credit checkout", None).into()
}

impl TopUp {
    pub fn new(
        settings: &TopUpSettings,
        http: Option<OutboundHttp>,
        cache: Option<Arc<dyn DynCache>>,
    ) -> Self {
        Self {
            mollie: Mollie::new(&settings.api_url, &settings.api_key),
            webhook_url: settings.webhook_url.clone(),
            redirect_url: settings.redirect_url.clone(),
            http,
            cache,
        }
    }

    /// The request's client (conformance) or the process's.
    fn http(&self, request: Option<OutboundHttp>) -> PlatformResult<OutboundHttp> {
        request.or_else(|| self.http.clone()).ok_or_else(|| {
            PlatformError::internal("Failed to start credit checkout", "no outbound HTTP client")
        })
    }

    async fn package(master: &PgPool, id: &str) -> Result<Option<Package>, sqlx::Error> {
        let row: Option<(String, String, i32, String, String)> = sqlx::query_as(
            "select id, name, credits, price::text, currency from credit_packages
             where id = $1 and is_active = 1 limit 1",
        )
        .bind(id)
        .fetch_optional(master)
        .await?;
        Ok(row.map(|(id, name, credits, price, currency)| Package {
            id,
            name,
            credits: i64::from(credits),
            price: Money::parse(&currency, &price),
        }))
    }

    /// `POST /api/credits/checkout` with Mollie: the hosted checkout's URL.
    /// The wallet isn't touched; the webhook grants once the payment is paid.
    pub async fn start(
        &self,
        master: &PgPool,
        http: Option<OutboundHttp>,
        buyer: Buyer<'_>,
        input: &CheckoutInput,
    ) -> PlatformResult<String> {
        // `pkg?.isActive !== 1`: 404 `Credit package not found`.
        let Some(package) = Self::package(master, &input.package_id).await? else {
            return Err(ApiError::not_found("Credit package", None).into());
        };
        let Some(price) = package
            .price
            .clone()
            .filter(|price| price.currency == CURRENCY && price.cents > 0)
        else {
            return Err(ApiError::bad_request(
                "Credit package is not purchasable (no EUR price configured)",
            )
            .into());
        };
        if package.credits <= 0 {
            return Err(ApiError::bad_request(
                "Credit package is not purchasable (no credits configured)",
            )
            .into());
        }
        let http = self.http(http)?;
        let checkout_id = generate_id("ctp");
        let success = input.success_url.as_deref().unwrap_or(&self.redirect_url);
        let redirect_url = with_query(success, "checkout", &checkout_id).ok_or_else(|| {
            PlatformError::internal(
                "Failed to start credit checkout",
                "the return URL is invalid",
            )
        })?;
        let description = format!(
            "WeldSuite credits: {} ({} credits)",
            package.name, package.credits
        );
        let payment = NewPayment {
            amount: &price,
            description: &description,
            redirect_url: &redirect_url,
            cancel_url: input.cancel_url.as_deref(),
            webhook_url: &self.webhook_url,
            metadata: json!({
                "kind": KIND,
                "checkoutId": checkout_id,
                "workspaceId": buyer.workspace_id,
                "packageId": package.id,
                "credits": package.credits,
                "userId": buyer.user_id,
            }),
        };
        let created = self
            .mollie
            .create(&http, &payment, &checkout_id)
            .await
            .map_err(|error| PlatformError::internal("Failed to start credit checkout", error))?;
        let Some(url) = created.checkout_url else {
            return Err(PlatformError::internal(
                "Failed to start credit checkout",
                format!("Mollie gave payment {} no checkout", created.id),
            ));
        };
        if let Some(cache) = &self.cache {
            let pending = Pending {
                payment_id: created.id.clone(),
                workspace_id: buyer.workspace_id.to_owned(),
                package_id: package.id.clone(),
                credits: package.credits,
            };
            let stored = match serde_json::to_string(&pending) {
                Ok(text) => {
                    cache
                        .put_boxed(&pending_key(&checkout_id), &text, Some(PENDING_TTL))
                        .await
                }
                Err(error) => Err(error.into()),
            };
            if let Err(error) = stored {
                // The return page then falls back to the ledger.
                tracing::warn!(%error, checkout = %checkout_id, "credits: pending checkout not cached");
            }
        }
        tracing::info!(
            checkout = %checkout_id,
            payment = %created.id,
            workspace = %buyer.workspace_id,
            package = %package.id,
            test = self.mollie.is_test(),
            "credits: Mollie checkout started"
        );
        Ok(url)
    }

    /// `GET /api/credits/checkout/:id`: how a checkout of the caller's
    /// workspace ended: `paid`, `pending`, `canceled`, `expired`, `failed`,
    /// or `unknown` when neither the cache nor the ledger knows it any more.
    pub async fn status(
        &self,
        master: &PgPool,
        http: Option<OutboundHttp>,
        workspace_id: &str,
        checkout_id: &str,
    ) -> PlatformResult<Value> {
        if !is_checkout_id(checkout_id) {
            return Err(checkout_not_found());
        }
        let pending = match &self.cache {
            Some(cache) => match cache.get_boxed(&pending_key(checkout_id)).await {
                Ok(Some(text)) => serde_json::from_str::<Pending>(&text).ok(),
                Ok(None) => None,
                Err(error) => {
                    tracing::warn!(%error, "credits: pending checkout unreadable");
                    None
                }
            },
            None => None,
        };
        let Some(pending) = pending else {
            let granted = ledger::granted_for_checkout(master, workspace_id, checkout_id).await?;
            return Ok(match granted {
                Some(credits) => json!({ "id": checkout_id, "status": "paid", "credits": credits }),
                None => json!({ "id": checkout_id, "status": "unknown", "credits": null }),
            });
        };
        if pending.workspace_id != workspace_id {
            return Err(checkout_not_found());
        }
        let payment = match self
            .mollie
            .payment(&self.http(http)?, &pending.payment_id)
            .await
        {
            Ok(payment) => payment,
            Err(error) => {
                tracing::warn!(%error, checkout = %checkout_id, "credits: payment unreadable");
                let granted =
                    ledger::granted_for_checkout(master, workspace_id, checkout_id).await?;
                let status = if granted.is_some() { "paid" } else { "unknown" };
                return Ok(
                    json!({ "id": checkout_id, "status": status, "credits": pending.credits }),
                );
            }
        };
        if text(payment.metadata.get("workspaceId")).as_deref() != Some(workspace_id) {
            return Err(checkout_not_found());
        }
        // The webhook may not have come yet (or can't reach this install):
        // settle here too, idempotently.
        if payment.status == PaymentStatus::Paid {
            let settled = settle(master, &payment).await?;
            tracing::info!(checkout = %checkout_id, ?settled, "credits: checkout settled on return");
        }
        Ok(json!({
            "id": checkout_id,
            "status": status_word(&payment.status),
            "credits": pending.credits,
        }))
    }
}

/// The request's overrides (conformance builds): the test's master database
/// and its fetch stub.
struct PublicOverrides {
    master: Option<PgPool>,
    http: Option<OutboundHttp>,
}

impl<S: Send + Sync> FromRequestParts<S> for PublicOverrides {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(Ok(Self {
            master: parts.extensions.get::<MasterDb>().map(|m| m.0.clone()),
            http: parts.extensions.get::<OutboundHttp>().cloned(),
        }))
    }
}

/// `POST /api/webhooks/mollie`, ahead of the session.
pub fn webhook_router() -> Router<CorePlatformState> {
    Router::new().route(WEBHOOK_PATH, post(mollie_webhook))
}

/// Mollie's webhook: `id=tr_…`, form-encoded. 200 for anything settled or
/// not ours (an unknown id included, as Mollie asks); 5xx when Mollie or the
/// database can't be reached, so Mollie tries again.
async fn mollie_webhook(
    State(state): State<CorePlatformState>,
    overrides: PublicOverrides,
    body: Bytes,
) -> Response {
    let Some(top_up) = state.top_up.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let id = url::form_urlencoded::parse(&body)
        .find(|(name, _)| name == "id")
        .map(|(_, value)| value.into_owned());
    let Some(id) = id.filter(|id| mollie::is_payment_id(id)) else {
        tracing::warn!("credits: Mollie webhook without a payment id, ignored");
        return StatusCode::OK.into_response();
    };
    let Some(http) = overrides.http.or_else(|| top_up.http.clone()) else {
        tracing::error!("credits: no outbound HTTP client for Mollie");
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let payment = match top_up.mollie.payment(&http, &id).await {
        Ok(payment) => payment,
        Err(error) if error.is_not_found() => {
            tracing::warn!(%error, payment = %id, "credits: Mollie webhook for an unknown payment");
            return StatusCode::OK.into_response();
        }
        Err(error) => {
            tracing::warn!(%error, payment = %id, "credits: payment unreadable, Mollie retries");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    };
    let master = overrides.master.unwrap_or_else(|| state.master.clone());
    match settle(&master, &payment).await {
        Ok(settled) => {
            match &settled {
                Settled::Granted(Applied::New { balance_after, .. }) => tracing::info!(
                    payment = %id,
                    balance_after,
                    "credits: Mollie top-up granted"
                ),
                Settled::Granted(Applied::NoWorkspace) => tracing::error!(
                    payment = %id,
                    "credits: paid top-up for a workspace that is gone"
                ),
                other => tracing::info!(payment = %id, settled = ?other, "credits: Mollie webhook"),
            }
            StatusCode::OK.into_response()
        }
        Err(error) => {
            tracing::error!(%error, payment = %id, "credits: top-up not settled, Mollie retries");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use axum::body::Body;
    use http::Request;
    use serde_json::Map;
    use tower::ServiceExt;
    use weldsuite_events::EntityEventPublisher;
    use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, PortError};

    use super::*;

    fn lookup(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let vars: Vec<(String, String)> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name: &str| {
            vars.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn settings_follow_the_public_url() {
        assert_eq!(TopUpSettings::from_lookup(&lookup(&[])), Ok(None));
        assert_eq!(
            TopUpSettings::from_lookup(&lookup(&[("MOLLIE_API_KEY", " ")])),
            Ok(None)
        );
        let settings = TopUpSettings::from_lookup(&lookup(&[
            ("MOLLIE_API_KEY", "live_abc"),
            ("PUBLIC_URL", "https://app.weldsuite.eu/"),
        ]))
        .expect("valid")
        .expect("configured");
        assert_eq!(
            settings.webhook_url,
            "https://app.weldsuite.eu/api/webhooks/mollie"
        );
        assert_eq!(
            settings.redirect_url,
            "https://app.weldsuite.eu/settings/billing?credits=success"
        );
        assert_eq!(settings.api_url, mollie::DEFAULT_API_URL);
        assert!(
            !format!("{settings:?}").contains("live_abc"),
            "no key in logs"
        );

        let explicit = TopUpSettings::from_lookup(&lookup(&[
            ("MOLLIE_API_KEY", "test_abc"),
            ("PUBLIC_URL", "https://app.weldsuite.eu"),
            ("PUBLIC_API_URL", "https://api.weldsuite.eu"),
            (
                "MOLLIE_REDIRECT_URL",
                "https://app.weldsuite.eu/billing-done",
            ),
        ]))
        .expect("valid")
        .expect("configured");
        assert_eq!(
            explicit.webhook_url,
            "https://api.weldsuite.eu/api/webhooks/mollie"
        );
        assert_eq!(
            explicit.redirect_url,
            "https://app.weldsuite.eu/billing-done"
        );

        // A key without anywhere for Mollie to report to stops the start.
        assert!(TopUpSettings::from_lookup(&lookup(&[("MOLLIE_API_KEY", "live_abc")])).is_err());
        assert!(
            TopUpSettings::from_lookup(&lookup(&[
                ("MOLLIE_API_KEY", "live_abc"),
                ("MOLLIE_WEBHOOK_URL", "not a url"),
                ("PUBLIC_URL", "https://app.weldsuite.eu"),
            ]))
            .is_err()
        );
        assert!(top_up_configured(&lookup(&[
            ("MOLLIE_API_KEY", "live_abc"),
            ("PUBLIC_URL", "https://app.weldsuite.eu"),
        ])));
        assert!(!top_up_configured(&lookup(&[(
            "MOLLIE_API_KEY",
            "live_abc"
        )])));
    }

    #[test]
    fn checkouts_return_with_their_id() {
        assert_eq!(
            with_query(
                "https://app.weldsuite.eu/w/acme/settings/billing?credits=success",
                "checkout",
                "ctp_1"
            )
            .as_deref(),
            Some("https://app.weldsuite.eu/w/acme/settings/billing?credits=success&checkout=ctp_1")
        );
        assert!(is_checkout_id("ctp_mf3k2abcd1234"));
        for bad in ["", "ctp_", "tr_abc", "ctp_a/b", "ctp_a b"] {
            assert!(!is_checkout_id(bad), "{bad:?}");
        }
    }

    fn payment(status: PaymentStatus, metadata: &Value) -> Payment {
        Payment {
            id: "tr_abc".to_owned(),
            status,
            amount: Money::parse("EUR", "10.00"),
            amount_refunded: None,
            amount_charged_back: None,
            metadata: metadata.as_object().cloned().unwrap_or_default(),
            checkout_url: None,
        }
    }

    fn ours() -> Value {
        json!({
            "kind": "credit_topup",
            "checkoutId": "ctp_1",
            "workspaceId": "ws_1",
            "packageId": "pkg_1",
            "credits": 1000,
            "userId": "user_1",
        })
    }

    #[test]
    fn only_a_paid_top_up_grants() {
        let Settlement::Grant(purchase) = settlement(&payment(PaymentStatus::Paid, &ours())) else {
            panic!("a paid top-up grants");
        };
        assert_eq!(purchase.workspace_id, "ws_1");
        assert_eq!(purchase.credits, 1000);
        assert_eq!(purchase.amount.value(), "10.00");
        assert_eq!(purchase.checkout_id.as_deref(), Some("ctp_1"));
        assert_eq!(purchase.idempotency_key(), "mollie_payment:tr_abc");

        for status in [
            PaymentStatus::Open,
            PaymentStatus::Pending,
            PaymentStatus::Authorized,
            PaymentStatus::Canceled,
            PaymentStatus::Expired,
            PaymentStatus::Failed,
            PaymentStatus::Other("new".to_owned()),
        ] {
            assert_eq!(
                settlement(&payment(status.clone(), &ours())),
                Settlement::Ignore("not paid"),
                "{status:?}"
            );
        }
        // Someone else's payment on the same account.
        assert_eq!(
            settlement(&payment(PaymentStatus::Paid, &json!({ "orderId": "1" }))),
            Settlement::Ignore("not a credit top-up")
        );
        let mut no_credits = ours();
        no_credits["credits"] = json!(0);
        assert_eq!(
            settlement(&payment(PaymentStatus::Paid, &no_credits)),
            Settlement::Ignore("no credits in the metadata")
        );
        // Credits kept as a string still read.
        let mut text_credits = ours();
        text_credits["credits"] = json!("250");
        assert!(matches!(
            settlement(&payment(PaymentStatus::Paid, &text_credits)),
            Settlement::Grant(Purchase { credits: 250, .. })
        ));
    }

    #[test]
    fn a_full_refund_takes_the_credits_back() {
        let mut refunded = payment(PaymentStatus::Paid, &ours());
        refunded.amount_refunded = Money::parse("EUR", "10.00");
        assert_eq!(
            settlement(&refunded),
            Settlement::Reverse {
                payment_id: "tr_abc".to_owned()
            }
        );
        refunded.amount_refunded = Money::parse("EUR", "4.00");
        assert!(matches!(settlement(&refunded), Settlement::Grant(_)));
    }

    // ── the webhook route ───────────────────────────────────────────────────

    /// Mollie: records the requests, answers each with the next response.
    struct FakeMollie {
        requests: Mutex<Vec<HttpRequest>>,
        answers: Mutex<Vec<Result<HttpResponse, PortError>>>,
    }

    impl DynOutboundHttp for FakeMollie {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            self.requests.lock().expect("lock").push(request);
            let mut answers = self.answers.lock().expect("lock");
            let answer = if answers.is_empty() {
                Err(PortError::backend("no answer left"))
            } else {
                answers.remove(0)
            };
            Box::pin(std::future::ready(answer))
        }
    }

    /// A master pool that never connects: a route that reaches the database
    /// fails, so a 200 proves nothing was written.
    fn unreachable_master() -> PgPool {
        sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(200))
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .expect("lazy pool")
    }

    struct NoAudit;

    impl crate::AuditStreamGateway for NoAudit {
        fn check_url(&self, raw: &str) -> Result<String, String> {
            Ok(raw.to_owned())
        }

        fn send_test<'a>(
            &'a self,
            _test: crate::AuditStreamTest<'a>,
        ) -> BoxFuture<'a, crate::AuditStreamTestResult> {
            unreachable!("not used by the top-up")
        }
    }

    fn webhook(answers: Vec<Result<HttpResponse, PortError>>) -> (Arc<FakeMollie>, Router) {
        let fake = Arc::new(FakeMollie {
            requests: Mutex::default(),
            answers: Mutex::new(answers),
        });
        let settings = TopUpSettings::from_lookup(&lookup(&[
            ("MOLLIE_API_KEY", "test_key"),
            ("PUBLIC_URL", "https://app.weldsuite.eu"),
        ]))
        .expect("valid")
        .expect("configured");
        let http = OutboundHttp(Arc::clone(&fake) as Arc<dyn DynOutboundHttp>);
        let state = CorePlatformState {
            events: EntityEventPublisher::new(None, weldsuite_events::TaskTracker::new()),
            realtime: None,
            cache: None,
            master: unreachable_master(),
            identity: None,
            audit_streams: Arc::new(NoAudit),
            top_up: Some(Arc::new(TopUp::new(&settings, Some(http), None))),
            ai: None,
            mail: None,
        };
        (fake, webhook_router().with_state(state))
    }

    async fn post_form(app: Router, body: &str) -> StatusCode {
        let request = Request::post(WEBHOOK_PATH)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(Body::from(body.to_owned()))
            .expect("request");
        app.oneshot(request).await.expect("response").status()
    }

    fn mollie_answer(status: &str) -> HttpResponse {
        let body = json!({
            "id": "tr_abc",
            "status": status,
            "amount": { "currency": "EUR", "value": "10.00" },
            "metadata": ours(),
        });
        HttpResponse::new(200, body.to_string().into_bytes())
    }

    #[tokio::test]
    async fn the_webhook_reads_the_payment_back_and_grants_nothing_unpaid() {
        for status in ["failed", "expired", "canceled", "open"] {
            let (fake, app) = webhook(vec![Ok(mollie_answer(status))]);
            // The body only names the payment; its state comes from Mollie.
            assert_eq!(
                post_form(app, "id=tr_abc").await,
                StatusCode::OK,
                "{status}"
            );
            let requests = fake.requests.lock().expect("lock");
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].method, "GET");
            assert_eq!(requests[0].url, "https://api.mollie.com/v2/payments/tr_abc");
        }
    }

    #[tokio::test]
    async fn the_webhook_ignores_what_is_not_a_payment_of_ours() {
        // No id, or not a payment id: nothing is asked of Mollie.
        for body in ["", "id=", "id=../payments", "foo=tr_abc"] {
            let (fake, app) = webhook(Vec::new());
            assert_eq!(post_form(app, body).await, StatusCode::OK, "{body:?}");
            assert!(fake.requests.lock().expect("lock").is_empty());
        }
        // An id Mollie doesn't know (another account's, a test call).
        let (_, app) = webhook(vec![Ok(HttpResponse::new(
            404,
            br#"{"status":404,"title":"Not Found","detail":"No payment exists with token tr_abc."}"#
                .to_vec(),
        ))]);
        assert_eq!(post_form(app, "id=tr_abc").await, StatusCode::OK);
        // A paid payment that isn't a top-up.
        let (_, app) = webhook(vec![Ok(HttpResponse::new(
            200,
            json!({ "id": "tr_abc", "status": "paid", "amount": { "currency": "EUR", "value": "1.00" }, "metadata": Map::new() })
                .to_string()
                .into_bytes(),
        ))]);
        assert_eq!(post_form(app, "id=tr_abc").await, StatusCode::OK);
    }

    #[tokio::test]
    async fn the_webhook_asks_for_a_retry_when_it_cannot_settle() {
        // Mollie unreachable.
        let (_, app) = webhook(vec![Err(PortError::backend("connection refused"))]);
        assert_eq!(
            post_form(app, "id=tr_abc").await,
            StatusCode::SERVICE_UNAVAILABLE
        );
        // Paid, but the database is down: 500, so Mollie delivers again.
        let (_, app) = webhook(vec![Ok(mollie_answer("paid"))]);
        assert_eq!(
            post_form(app, "id=tr_abc").await,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
