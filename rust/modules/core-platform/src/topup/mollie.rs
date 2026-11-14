//! Mollie's Payments API v2 (`https://api.mollie.com/v2`) over the
//! [`OutboundHttp`] port: what the Kubernetes editions' credit top-up pays
//! through (Mollie, Amsterdam: the editions design's "Payments: Mollie (EU)",
//! ADR OPS-012). Global pays through Stripe instead
//! (`apps/workers/billing-worker/src/lib/stripe.ts`), so there is no
//! TypeScript twin of this client.
//!
//! Two calls: create a payment (`POST /payments`) and read one
//! (`GET /payments/{id}`). Mollie's webhook posts only a payment's id, never
//! its state: the state is always read back with [`Mollie::payment`].

use serde_json::{Map, Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp, PortError};

/// Mollie's API.
pub const DEFAULT_API_URL: &str = "https://api.mollie.com/v2";

/// An amount in a currency's minor unit (cents), as Mollie's
/// `{ currency, value }` writes it (`"10.00"`: always two decimals).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Money {
    /// ISO 4217, upper case (`EUR`).
    pub currency: String,
    pub cents: i64,
}

impl Money {
    /// From a decimal text (`"9.99"`, `"10"`, `"10.5"`, a `numeric(10,2)`
    /// column as Postgres writes it). `None` for anything else, a negative
    /// amount or more than two decimals.
    pub fn parse(currency: &str, value: &str) -> Option<Self> {
        let value = value.trim();
        let digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
        let (whole, fraction) = match value.split_once('.') {
            Some((whole, fraction)) if digits(fraction) => (whole, fraction),
            Some(_) => return None,
            None => (value, ""),
        };
        if !digits(whole) || fraction.len() > 2 {
            return None;
        }
        let whole: i64 = whole.parse().ok()?;
        let fraction: i64 = match fraction.len() {
            0 => 0,
            1 => fraction.parse::<i64>().ok()? * 10,
            _ => fraction.parse().ok()?,
        };
        let currency = currency.trim().to_ascii_uppercase();
        if currency.len() != 3 {
            return None;
        }
        Some(Self {
            currency,
            cents: whole.checked_mul(100)?.checked_add(fraction)?,
        })
    }

    /// Mollie's `value`: `"9.99"`.
    pub fn value(&self) -> String {
        format!("{}.{:02}", self.cents / 100, self.cents % 100)
    }

    /// Mollie's `{ currency, value }`.
    pub fn to_json(&self) -> Value {
        json!({ "currency": self.currency, "value": self.value() })
    }

    fn from_json(value: Option<&Value>) -> Option<Self> {
        let value = value?;
        Self::parse(
            value.get("currency")?.as_str()?,
            value.get("value")?.as_str()?,
        )
    }
}

/// A payment's state (`status`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaymentStatus {
    Open,
    Pending,
    Authorized,
    Paid,
    Canceled,
    Expired,
    Failed,
    /// A state this client doesn't know.
    Other(String),
}

impl PaymentStatus {
    fn parse(text: &str) -> Self {
        match text {
            "open" => Self::Open,
            "pending" => Self::Pending,
            "authorized" => Self::Authorized,
            "paid" => Self::Paid,
            "canceled" => Self::Canceled,
            "expired" => Self::Expired,
            "failed" => Self::Failed,
            other => Self::Other(other.to_owned()),
        }
    }
}

/// The fields of a payment the top-up reads.
#[derive(Debug, Clone, PartialEq)]
pub struct Payment {
    /// `tr_…`.
    pub id: String,
    pub status: PaymentStatus,
    pub amount: Option<Money>,
    /// What was refunded of it, when anything was.
    pub amount_refunded: Option<Money>,
    /// What was charged back of it, when anything was.
    pub amount_charged_back: Option<Money>,
    /// What the payment was created with ([`NewPayment::metadata`]).
    pub metadata: Map<String, Value>,
    /// The hosted checkout (`_links.checkout.href`); only while it can be paid.
    pub checkout_url: Option<String>,
}

impl Payment {
    fn from_json(body: &Value) -> Option<Self> {
        let id = body.get("id")?.as_str()?.to_owned();
        Some(Self {
            status: PaymentStatus::parse(body.get("status")?.as_str()?),
            amount: Money::from_json(body.get("amount")),
            amount_refunded: Money::from_json(body.get("amountRefunded")),
            amount_charged_back: Money::from_json(body.get("amountChargedBack")),
            metadata: body
                .get("metadata")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
            checkout_url: body
                .pointer("/_links/checkout/href")
                .and_then(Value::as_str)
                .map(str::to_owned),
            id,
        })
    }

    /// Everything paid was refunded or charged back.
    pub fn fully_reversed(&self) -> bool {
        let Some(amount) = &self.amount else {
            return false;
        };
        let reversed: i64 = [&self.amount_refunded, &self.amount_charged_back]
            .into_iter()
            .flatten()
            .filter(|money| money.currency == amount.currency)
            .map(|money| money.cents)
            .sum();
        amount.cents > 0 && reversed >= amount.cents
    }
}

/// A payment to create.
#[derive(Debug, Clone)]
pub struct NewPayment<'a> {
    pub amount: &'a Money,
    /// What the customer sees on the checkout and the statement (Mollie
    /// takes at most 255 characters; longer is cut).
    pub description: &'a str,
    /// Where the customer returns after paying, failing or abandoning.
    pub redirect_url: &'a str,
    /// Where the customer returns after cancelling on Mollie's page
    /// (unset: [`NewPayment::redirect_url`]).
    pub cancel_url: Option<&'a str>,
    /// Where Mollie posts the payment's id on every change.
    pub webhook_url: &'a str,
    /// Returned with the payment; at most 1 kB of JSON.
    pub metadata: Value,
}

impl NewPayment<'_> {
    /// The request body.
    pub fn body(&self) -> Value {
        let description: String = self.description.chars().take(255).collect();
        let mut body = json!({
            "amount": self.amount.to_json(),
            "description": description,
            "redirectUrl": self.redirect_url,
            "webhookUrl": self.webhook_url,
            "metadata": self.metadata,
        });
        if let Some(cancel) = self.cancel_url {
            body["cancelUrl"] = json!(cancel);
        }
        body
    }
}

/// Why a call failed.
#[derive(Debug)]
pub enum MollieError {
    /// Mollie couldn't be reached.
    Unreachable(PortError),
    /// Mollie answered with an error: its status and `detail`.
    Refused { status: u16, detail: String },
    /// Mollie's answer wasn't a payment.
    Malformed,
}

impl MollieError {
    /// Mollie has no such payment (404), e.g. one of another account.
    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::Refused { status: 404, .. })
    }
}

impl std::fmt::Display for MollieError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(error) => write!(f, "Mollie unreachable: {error}"),
            Self::Refused { status, detail } => write!(f, "Mollie answered {status}: {detail}"),
            Self::Malformed => f.write_str("Mollie answered something that is not a payment"),
        }
    }
}

/// A payment id as Mollie writes them (`tr_` and letters and digits), so an
/// id from a webhook body can go into a URL path.
pub fn is_payment_id(id: &str) -> bool {
    id.strip_prefix("tr_").is_some_and(|rest| {
        !rest.is_empty() && rest.len() <= 64 && rest.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

/// The Payments API with one account's key.
#[derive(Clone)]
pub struct Mollie {
    api_url: String,
    api_key: String,
}

impl std::fmt::Debug for Mollie {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Mollie")
            .field("api_url", &self.api_url)
            .finish_non_exhaustive()
    }
}

impl Mollie {
    /// `api_url` without a trailing slash ([`DEFAULT_API_URL`]); `api_key` a
    /// `live_…`, `test_…` or organization access token.
    pub fn new(api_url: &str, api_key: &str) -> Self {
        Self {
            api_url: api_url.trim().trim_end_matches('/').to_owned(),
            api_key: api_key.trim().to_owned(),
        }
    }

    /// Whether the key is a test key: its payments are never real.
    pub fn is_test(&self) -> bool {
        self.api_key.starts_with("test_")
    }

    /// `POST /payments`. `idempotency_key` makes a retried request create the
    /// payment once (Mollie's `Idempotency-Key` header).
    pub fn create_request(&self, payment: &NewPayment<'_>, idempotency_key: &str) -> HttpRequest {
        HttpRequest::json(
            "POST",
            format!("{}/payments", self.api_url),
            &payment.body(),
        )
        .header("authorization", format!("Bearer {}", self.api_key))
        .header("idempotency-key", idempotency_key)
    }

    /// `GET /payments/{id}`; `id` must pass [`is_payment_id`].
    pub fn get_request(&self, id: &str) -> HttpRequest {
        HttpRequest::empty("GET", format!("{}/payments/{id}", self.api_url))
            .header("authorization", format!("Bearer {}", self.api_key))
    }

    /// Creates a payment: its id, state and hosted checkout.
    pub async fn create(
        &self,
        http: &OutboundHttp,
        payment: &NewPayment<'_>,
        idempotency_key: &str,
    ) -> Result<Payment, MollieError> {
        Self::payment_of(
            http.send(self.create_request(payment, idempotency_key))
                .await,
        )
    }

    /// Reads a payment.
    pub async fn payment(&self, http: &OutboundHttp, id: &str) -> Result<Payment, MollieError> {
        if !is_payment_id(id) {
            return Err(MollieError::Refused {
                status: 404,
                detail: "not a payment id".to_owned(),
            });
        }
        Self::payment_of(http.send(self.get_request(id)).await)
    }

    fn payment_of(
        response: Result<weldsuite_ports::HttpResponse, PortError>,
    ) -> Result<Payment, MollieError> {
        let response = response.map_err(MollieError::Unreachable)?;
        let body = response.json();
        if !response.ok() {
            let detail = body
                .get("detail")
                .and_then(Value::as_str)
                .map_or_else(|| response.text(), str::to_owned);
            return Err(MollieError::Refused {
                status: response.status,
                detail,
            });
        }
        Payment::from_json(&body).ok_or(MollieError::Malformed)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpResponse};

    use super::*;

    /// Records the requests and answers each with the next canned response.
    #[derive(Default)]
    struct Recorded {
        requests: Mutex<Vec<HttpRequest>>,
        answers: Mutex<Vec<Result<HttpResponse, PortError>>>,
    }

    impl DynOutboundHttp for Recorded {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            self.requests.lock().expect("lock").push(request);
            let answer = self.answers.lock().expect("lock").remove(0);
            Box::pin(std::future::ready(answer))
        }
    }

    fn http(answers: Vec<Result<HttpResponse, PortError>>) -> (Arc<Recorded>, OutboundHttp) {
        let recorded = Arc::new(Recorded {
            requests: Mutex::default(),
            answers: Mutex::new(answers),
        });
        let http = OutboundHttp(Arc::clone(&recorded) as Arc<dyn DynOutboundHttp>);
        (recorded, http)
    }

    fn answer(status: u16, body: &Value) -> HttpResponse {
        HttpResponse::new(status, body.to_string().into_bytes())
    }

    #[test]
    fn money_reads_and_writes_two_decimals() {
        let money = Money::parse("eur", "9.99").expect("money");
        assert_eq!(money.currency, "EUR");
        assert_eq!(money.cents, 999);
        assert_eq!(money.value(), "9.99");
        assert_eq!(Money::parse("EUR", "10").expect("money").value(), "10.00");
        assert_eq!(Money::parse("EUR", "10.5").expect("money").value(), "10.50");
        assert_eq!(Money::parse("EUR", "0.05").expect("money").value(), "0.05");
        for bad in ["", "-1.00", "1.234", "1,00", "abc", ".5", "1."] {
            assert_eq!(Money::parse("EUR", bad), None, "{bad:?}");
        }
        assert_eq!(Money::parse("EURO", "1.00"), None);
    }

    #[test]
    fn payment_ids_are_checked_before_they_reach_a_path() {
        assert!(is_payment_id("tr_WDqYK6vllg"));
        for bad in ["", "tr_", "ord_abc", "tr_../x", "tr_a b", "tr_a/b"] {
            assert!(!is_payment_id(bad), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn creates_a_payment_with_the_amount_urls_and_metadata() {
        let (recorded, http) = http(vec![Ok(answer(
            201,
            &json!({
                "resource": "payment",
                "id": "tr_7UhSN1zuXS",
                "mode": "test",
                "status": "open",
                "amount": { "currency": "EUR", "value": "10.00" },
                "metadata": { "workspaceId": "ws_1" },
                "_links": { "checkout": { "href": "https://www.mollie.com/checkout/select-method/7UhSN1zuXS", "type": "text/html" } },
            }),
        ))]);
        let mollie = Mollie::new(
            "https://api.mollie.com/v2/",
            "test_dHar4XY7LxsDOtmnkVtjNVWXLSlXsM",
        );
        assert!(mollie.is_test());
        let amount = Money::parse("EUR", "10.00").expect("money");
        let payment = NewPayment {
            amount: &amount,
            description: "Credits: 1000 credits",
            redirect_url: "https://app.weldsuite.eu/settings/billing?credits=success&checkout=ctp_1",
            cancel_url: Some("https://app.weldsuite.eu/settings/billing?credits=cancelled"),
            webhook_url: "https://app.weldsuite.eu/api/webhooks/mollie",
            metadata: json!({ "workspaceId": "ws_1", "packageId": "pkg_1", "userId": "user_1" }),
        };
        let created = mollie
            .create(&http, &payment, "ctp_1")
            .await
            .expect("created");
        assert_eq!(created.id, "tr_7UhSN1zuXS");
        assert_eq!(created.status, PaymentStatus::Open);
        assert_eq!(
            created.checkout_url.as_deref(),
            Some("https://www.mollie.com/checkout/select-method/7UhSN1zuXS")
        );

        let requests = recorded.requests.lock().expect("lock");
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.url, "https://api.mollie.com/v2/payments");
        let header = |name: &str| {
            request
                .headers
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(
            header("authorization"),
            Some("Bearer test_dHar4XY7LxsDOtmnkVtjNVWXLSlXsM")
        );
        assert_eq!(header("content-type"), Some("application/json"));
        assert_eq!(header("idempotency-key"), Some("ctp_1"));
        let body: Value =
            serde_json::from_slice(request.body.as_deref().expect("body")).expect("json");
        assert_eq!(
            body,
            json!({
                "amount": { "currency": "EUR", "value": "10.00" },
                "description": "Credits: 1000 credits",
                "redirectUrl": "https://app.weldsuite.eu/settings/billing?credits=success&checkout=ctp_1",
                "cancelUrl": "https://app.weldsuite.eu/settings/billing?credits=cancelled",
                "webhookUrl": "https://app.weldsuite.eu/api/webhooks/mollie",
                "metadata": { "workspaceId": "ws_1", "packageId": "pkg_1", "userId": "user_1" },
            })
        );
    }

    #[tokio::test]
    async fn reads_a_payment_and_its_reversals() {
        let (recorded, http) = http(vec![Ok(answer(
            200,
            &json!({
                "id": "tr_abc123",
                "status": "paid",
                "amount": { "currency": "EUR", "value": "25.00" },
                "amountRefunded": { "currency": "EUR", "value": "20.00" },
                "amountChargedBack": { "currency": "EUR", "value": "5.00" },
                "metadata": { "kind": "credit_topup" },
            }),
        ))]);
        let mollie = Mollie::new(DEFAULT_API_URL, "live_key");
        let payment = mollie.payment(&http, "tr_abc123").await.expect("payment");
        assert_eq!(payment.status, PaymentStatus::Paid);
        assert_eq!(payment.metadata["kind"], "credit_topup");
        assert!(payment.fully_reversed());
        let request = &recorded.requests.lock().expect("lock")[0];
        assert_eq!(request.method, "GET");
        assert_eq!(request.url, "https://api.mollie.com/v2/payments/tr_abc123");
        assert!(request.body.is_none());
    }

    #[tokio::test]
    async fn reports_refusals_and_never_sends_a_bad_id() {
        let (recorded, http) = http(vec![
            Ok(answer(
                404,
                &json!({ "status": 404, "title": "Not Found", "detail": "No payment exists with token tr_nope." }),
            )),
            Err(PortError::backend("connection refused")),
        ]);
        let mollie = Mollie::new(DEFAULT_API_URL, "live_key");
        let missing = mollie.payment(&http, "tr_nope").await.expect_err("404");
        assert!(missing.is_not_found(), "{missing}");
        assert!(missing.to_string().contains("No payment exists"));
        let down = mollie.payment(&http, "tr_down").await.expect_err("down");
        assert!(matches!(down, MollieError::Unreachable(_)));
        let bad = mollie.payment(&http, "../admin").await.expect_err("bad id");
        assert!(bad.is_not_found());
        assert_eq!(recorded.requests.lock().expect("lock").len(), 2);
    }

    #[test]
    fn partial_reversals_and_other_currencies_are_not_full() {
        let payment = |refunded: Option<(&str, &str)>| Payment {
            id: "tr_x".to_owned(),
            status: PaymentStatus::Paid,
            amount: Money::parse("EUR", "10.00"),
            amount_refunded: refunded.and_then(|(c, v)| Money::parse(c, v)),
            amount_charged_back: None,
            metadata: Map::new(),
            checkout_url: None,
        };
        assert!(!payment(None).fully_reversed());
        assert!(!payment(Some(("EUR", "9.99"))).fully_reversed());
        assert!(!payment(Some(("USD", "10.00"))).fully_reversed());
        assert!(payment(Some(("EUR", "10.00"))).fully_reversed());
    }
}
