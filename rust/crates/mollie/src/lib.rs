//! Mollie's API v2 (`https://api.mollie.com/v2`) over the [`OutboundHttp`]
//! port: the Kubernetes editions' payment provider (Mollie, Amsterdam: the
//! editions design's "Payments: Mollie (EU)", ADR OPS-012). Global pays
//! through Stripe instead (`apps/workers/billing-worker/src/lib/stripe.ts`),
//! so there is no TypeScript twin of this client.
//!
//! Two products use it, with one key (`MOLLIE_API_KEY`) and one webhook
//! (`/api/webhooks/mollie`):
//!
//! - the credit top-up (ADR BILL-013): one-off payments;
//! - plan billing (ADR BILL-014): a customer per paying workspace, a mandate
//!   from a first payment on Mollie's hosted checkout, recurring payments on
//!   that mandate charged by WeldSuite's own renewal job, and refunds.
//!
//! Mollie's webhook posts only a payment's id, never its state: the state is
//! always read back with [`Mollie::payment`].

use serde_json::{Map, Value, json};
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp, PortError};

/// Mollie's API.
pub const DEFAULT_API_URL: &str = "https://api.mollie.com/v2";

// ── money ───────────────────────────────────────────────────────────────────

/// An amount in a currency's minor unit (cents), as Mollie's
/// `{ currency, value }` writes it (`"10.00"`: always two decimals).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Money {
    /// ISO 4217, upper case (`EUR`).
    pub currency: String,
    pub cents: i64,
}

impl Money {
    /// An amount in cents. Negative amounts are clamped to zero: Mollie never
    /// takes one.
    pub fn from_cents(currency: &str, cents: i64) -> Self {
        Self {
            currency: currency.trim().to_ascii_uppercase(),
            cents: cents.max(0),
        }
    }

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

// ── payments ────────────────────────────────────────────────────────────────

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

    /// Mollie's word for it.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Open => "open",
            Self::Pending => "pending",
            Self::Authorized => "authorized",
            Self::Paid => "paid",
            Self::Canceled => "canceled",
            Self::Expired => "expired",
            Self::Failed => "failed",
            Self::Other(text) => text,
        }
    }

    /// The payment can't succeed any more.
    pub fn is_final_failure(&self) -> bool {
        matches!(self, Self::Canceled | Self::Expired | Self::Failed)
    }

    /// A recurring charge Mollie took on: paid, or still being collected
    /// (SEPA Direct Debit sits at `pending` for some business days).
    pub fn is_accepted(&self) -> bool {
        matches!(
            self,
            Self::Paid | Self::Pending | Self::Authorized | Self::Open
        )
    }
}

/// How a payment relates to a mandate (`sequenceType`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sequence {
    /// A payment on its own (`oneoff`).
    OneOff,
    /// The customer pays on Mollie's hosted checkout, which leaves a mandate
    /// for later recurring payments (`first`).
    First { customer_id: String },
    /// Charged on a mandate, without the customer (`recurring`).
    Recurring {
        customer_id: String,
        mandate_id: String,
    },
}

/// What a payment was paid with, masked: what the billing page shows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MethodDetails {
    /// `creditcard`, `directdebit`, `ideal`, `paypal`, `bancontact`, …
    pub method: Option<String>,
    /// The card brand (`Visa`, `Mastercard`, …), for a card.
    pub brand: Option<String>,
    /// The card's or account's last four characters.
    pub last4: Option<String>,
    /// `Visa •••• 4242`, `NL•• •••• 1234`, `PayPal`.
    pub label: Option<String>,
    /// A card's expiry, `YYYY-MM-DD` (the last day of its month).
    pub expiry: Option<String>,
}

impl MethodDetails {
    fn from_json(method: Option<&str>, details: Option<&Value>) -> Self {
        let method = method.map(str::to_owned);
        let text = |key: &str| {
            details
                .and_then(|d| d.get(key))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        let card_number = text("cardNumber");
        let card_label = text("cardLabel");
        let account = text("consumerAccount");
        let last4 = card_number
            .as_deref()
            .map(last_four)
            .or_else(|| account.as_deref().map(last_four));
        let label = match (card_label.as_deref(), card_number.as_deref(), account.as_deref()) {
            (brand, Some(number), _) => Some(format!(
                "{} •••• {}",
                brand.unwrap_or("Card"),
                last_four(number)
            )),
            (_, None, Some(account)) if method.as_deref() == Some("paypal") || account.contains('@') => {
                Some("PayPal".to_owned())
            }
            (_, None, Some(account)) => Some(mask_iban(account)),
            _ => None,
        };
        Self {
            method,
            brand: card_label,
            last4,
            label,
            expiry: text("cardExpiryDate"),
        }
    }
}

fn last_four(text: &str) -> String {
    let chars: Vec<char> = text.chars().filter(char::is_ascii_alphanumeric).collect();
    chars[chars.len().saturating_sub(4)..].iter().collect()
}

/// `NL•• •••• 1234`: the country of an IBAN and its last four characters.
pub fn mask_iban(iban: &str) -> String {
    let compact: String = iban.chars().filter(|c| !c.is_whitespace()).collect();
    let country: String = compact.chars().take(2).collect();
    format!("{country}•• •••• {}", last_four(&compact))
}

/// The fields of a payment WeldSuite reads.
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
    /// `oneoff`, `first` or `recurring`.
    pub sequence_type: Option<String>,
    /// `cst_…`, for a first or recurring payment.
    pub customer_id: Option<String>,
    /// `mdt_…`: the mandate a paid first payment created, or the one a
    /// recurring payment was charged on.
    pub mandate_id: Option<String>,
    /// How it was paid, masked.
    pub details: MethodDetails,
    /// `paidAt`, ISO 8601.
    pub paid_at: Option<String>,
    /// Why it failed, when Mollie says (`details.failureReason`,
    /// `details.bankReason`).
    pub failure_reason: Option<String>,
}

impl Payment {
    fn from_json(body: &Value) -> Option<Self> {
        let id = body.get("id")?.as_str()?.to_owned();
        let text = |key: &str| {
            body.get(key)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        let details = body.get("details");
        let failure_reason = details
            .and_then(|d| d.get("failureReason").or_else(|| d.get("bankReason")))
            .and_then(Value::as_str)
            .map(str::to_owned);
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
            sequence_type: text("sequenceType"),
            customer_id: text("customerId"),
            mandate_id: text("mandateId"),
            details: MethodDetails::from_json(body.get("method").and_then(Value::as_str), details),
            paid_at: text("paidAt"),
            failure_reason,
            id,
        })
    }

    /// Everything paid was refunded or charged back.
    pub fn fully_reversed(&self) -> bool {
        let Some(amount) = &self.amount else {
            return false;
        };
        amount.cents > 0 && self.reversed_cents() >= amount.cents
    }

    /// What was refunded or charged back of it, in its own currency.
    pub fn reversed_cents(&self) -> i64 {
        let Some(amount) = &self.amount else {
            return 0;
        };
        [&self.amount_refunded, &self.amount_charged_back]
            .into_iter()
            .flatten()
            .filter(|money| money.currency == amount.currency)
            .map(|money| money.cents)
            .sum()
    }

    /// Charged back (SEPA reversal, card dispute), in part or in full.
    pub fn charged_back(&self) -> bool {
        self.amount_charged_back
            .as_ref()
            .is_some_and(|money| money.cents > 0)
    }
}

/// A payment to create.
#[derive(Debug, Clone)]
pub struct NewPayment<'a> {
    pub amount: &'a Money,
    /// What the customer sees on the checkout and the statement (Mollie
    /// takes at most 255 characters; longer is cut).
    pub description: &'a str,
    /// Where the customer returns after paying, failing or abandoning. A
    /// recurring payment has no checkout and needs none.
    pub redirect_url: Option<&'a str>,
    /// Where the customer returns after cancelling on Mollie's page
    /// (unset: [`NewPayment::redirect_url`]).
    pub cancel_url: Option<&'a str>,
    /// Where Mollie posts the payment's id on every change.
    pub webhook_url: &'a str,
    /// Returned with the payment; at most 1 kB of JSON.
    pub metadata: Value,
    pub sequence: Sequence,
    /// The methods the checkout offers (empty: every method the profile has
    /// that suits the payment).
    pub methods: Vec<String>,
    /// The checkout's language (`nl_NL`, `en_US`).
    pub locale: Option<String>,
}

impl NewPayment<'_> {
    /// The request body.
    pub fn body(&self) -> Value {
        let description: String = self.description.chars().take(255).collect();
        let mut body = json!({
            "amount": self.amount.to_json(),
            "description": description,
            "webhookUrl": self.webhook_url,
            "metadata": self.metadata,
        });
        if let Some(redirect) = self.redirect_url {
            body["redirectUrl"] = json!(redirect);
        }
        if let Some(cancel) = self.cancel_url {
            body["cancelUrl"] = json!(cancel);
        }
        match &self.sequence {
            Sequence::OneOff => {}
            Sequence::First { customer_id } => {
                body["sequenceType"] = json!("first");
                body["customerId"] = json!(customer_id);
            }
            Sequence::Recurring {
                customer_id,
                mandate_id,
            } => {
                body["sequenceType"] = json!("recurring");
                body["customerId"] = json!(customer_id);
                body["mandateId"] = json!(mandate_id);
            }
        }
        if !self.methods.is_empty() {
            body["method"] = json!(self.methods);
        }
        if let Some(locale) = &self.locale {
            body["locale"] = json!(locale);
        }
        body
    }
}

// ── customers, mandates, refunds ────────────────────────────────────────────

/// A customer to create: one per paying workspace.
#[derive(Debug, Clone, Default)]
pub struct NewCustomer {
    pub name: String,
    pub email: Option<String>,
    pub locale: Option<String>,
    pub metadata: Value,
}

/// A mandate's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MandateStatus {
    Valid,
    Pending,
    Invalid,
    Other(String),
}

/// A mandate: the customer's permission to be charged without them.
#[derive(Debug, Clone, PartialEq)]
pub struct Mandate {
    /// `mdt_…`.
    pub id: String,
    pub status: MandateStatus,
    /// `creditcard`, `directdebit` or `paypal`.
    pub method: Option<String>,
    pub details: MethodDetails,
    /// `createdAt`, ISO 8601.
    pub created_at: Option<String>,
}

impl Mandate {
    fn from_json(body: &Value) -> Option<Self> {
        let id = body.get("id")?.as_str()?.to_owned();
        let method = body.get("method").and_then(Value::as_str);
        Some(Self {
            status: match body.get("status").and_then(Value::as_str) {
                Some("valid") => MandateStatus::Valid,
                Some("pending") => MandateStatus::Pending,
                Some("invalid") => MandateStatus::Invalid,
                other => MandateStatus::Other(other.unwrap_or_default().to_owned()),
            },
            method: method.map(str::to_owned),
            details: MethodDetails::from_json(method, body.get("details")),
            created_at: body
                .get("createdAt")
                .and_then(Value::as_str)
                .map(str::to_owned),
            id,
        })
    }

    /// Mollie can charge it.
    pub fn is_usable(&self) -> bool {
        matches!(self.status, MandateStatus::Valid | MandateStatus::Pending)
    }
}

/// A refund of (part of) a payment.
#[derive(Debug, Clone, PartialEq)]
pub struct Refund {
    /// `re_…`.
    pub id: String,
    pub status: String,
    pub amount: Option<Money>,
}

// ── errors ──────────────────────────────────────────────────────────────────

/// Why a call failed.
#[derive(Debug)]
pub enum MollieError {
    /// Mollie couldn't be reached.
    Unreachable(PortError),
    /// Mollie answered with an error: its status and `detail`.
    Refused { status: u16, detail: String },
    /// Mollie's answer wasn't what was asked for.
    Malformed,
}

impl MollieError {
    /// Mollie has no such resource (404), e.g. one of another account.
    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::Refused { status: 404, .. })
    }

    /// Mollie refused the request itself (4xx): retrying it won't help.
    pub fn is_refusal(&self) -> bool {
        matches!(self, Self::Refused { status, .. } if (400..500).contains(status))
    }
}

impl std::fmt::Display for MollieError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(error) => write!(f, "Mollie unreachable: {error}"),
            Self::Refused { status, detail } => write!(f, "Mollie answered {status}: {detail}"),
            Self::Malformed => f.write_str("Mollie answered something unexpected"),
        }
    }
}

impl std::error::Error for MollieError {}

// ── ids ─────────────────────────────────────────────────────────────────────

fn is_id(id: &str, prefix: &str) -> bool {
    id.strip_prefix(prefix).is_some_and(|rest| {
        !rest.is_empty() && rest.len() <= 64 && rest.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

/// A payment id as Mollie writes them (`tr_` and letters and digits), so an
/// id from a webhook body can go into a URL path.
pub fn is_payment_id(id: &str) -> bool {
    is_id(id, "tr_")
}

/// A customer id (`cst_…`).
pub fn is_customer_id(id: &str) -> bool {
    is_id(id, "cst_")
}

/// A mandate id (`mdt_…`).
pub fn is_mandate_id(id: &str) -> bool {
    is_id(id, "mdt_")
}

fn not_an_id(what: &str) -> MollieError {
    MollieError::Refused {
        status: 404,
        detail: format!("not a {what} id"),
    }
}

// ── the client ──────────────────────────────────────────────────────────────

/// Mollie's API with one account's key.
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

    fn authorized(&self, request: HttpRequest) -> HttpRequest {
        request.header("authorization", format!("Bearer {}", self.api_key))
    }

    fn post(&self, path: &str, body: &Value, idempotency_key: Option<&str>) -> HttpRequest {
        let request =
            self.authorized(HttpRequest::json("POST", format!("{}{path}", self.api_url), body));
        match idempotency_key {
            Some(key) => request.header("idempotency-key", key),
            None => request,
        }
    }

    fn get(&self, path: &str) -> HttpRequest {
        self.authorized(HttpRequest::empty("GET", format!("{}{path}", self.api_url)))
    }

    /// `POST /payments`. `idempotency_key` makes a retried request create the
    /// payment once (Mollie's `Idempotency-Key` header, kept for an hour).
    pub fn create_request(&self, payment: &NewPayment<'_>, idempotency_key: &str) -> HttpRequest {
        self.post("/payments", &payment.body(), Some(idempotency_key))
    }

    /// `GET /payments/{id}`; `id` must pass [`is_payment_id`].
    pub fn get_request(&self, id: &str) -> HttpRequest {
        self.get(&format!("/payments/{id}"))
    }

    /// Creates a payment: its id, state and hosted checkout.
    pub async fn create(
        &self,
        http: &OutboundHttp,
        payment: &NewPayment<'_>,
        idempotency_key: &str,
    ) -> Result<Payment, MollieError> {
        let body = Self::json_of(
            http.send(self.create_request(payment, idempotency_key))
                .await,
        )?;
        Payment::from_json(&body).ok_or(MollieError::Malformed)
    }

    /// Reads a payment.
    pub async fn payment(&self, http: &OutboundHttp, id: &str) -> Result<Payment, MollieError> {
        if !is_payment_id(id) {
            return Err(not_an_id("payment"));
        }
        let body = Self::json_of(http.send(self.get_request(id)).await)?;
        Payment::from_json(&body).ok_or(MollieError::Malformed)
    }

    /// `POST /customers`: the new customer's id.
    pub async fn create_customer(
        &self,
        http: &OutboundHttp,
        customer: &NewCustomer,
        idempotency_key: &str,
    ) -> Result<String, MollieError> {
        let mut body = json!({ "name": customer.name, "metadata": customer.metadata });
        if let Some(email) = &customer.email {
            body["email"] = json!(email);
        }
        if let Some(locale) = &customer.locale {
            body["locale"] = json!(locale);
        }
        let answer = Self::json_of(
            http.send(self.post("/customers", &body, Some(idempotency_key)))
                .await,
        )?;
        answer
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_customer_id(id))
            .map(str::to_owned)
            .ok_or(MollieError::Malformed)
    }

    /// `GET /customers/{id}/mandates`: every mandate of the customer, newest
    /// first.
    pub async fn mandates(
        &self,
        http: &OutboundHttp,
        customer_id: &str,
    ) -> Result<Vec<Mandate>, MollieError> {
        if !is_customer_id(customer_id) {
            return Err(not_an_id("customer"));
        }
        let answer = Self::json_of(
            http.send(self.get(&format!("/customers/{customer_id}/mandates?limit=50")))
                .await,
        )?;
        let mut mandates: Vec<Mandate> = answer
            .pointer("/_embedded/mandates")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Mandate::from_json).collect())
            .unwrap_or_default();
        mandates.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(mandates)
    }

    /// `GET /customers/{customer}/mandates/{id}`.
    pub async fn mandate(
        &self,
        http: &OutboundHttp,
        customer_id: &str,
        mandate_id: &str,
    ) -> Result<Mandate, MollieError> {
        if !is_customer_id(customer_id) {
            return Err(not_an_id("customer"));
        }
        if !is_mandate_id(mandate_id) {
            return Err(not_an_id("mandate"));
        }
        let answer = Self::json_of(
            http.send(self.get(&format!("/customers/{customer_id}/mandates/{mandate_id}")))
                .await,
        )?;
        Mandate::from_json(&answer).ok_or(MollieError::Malformed)
    }

    /// `DELETE /customers/{customer}/mandates/{id}`: no payment can be charged
    /// on it any more. A mandate that is already gone counts as revoked.
    pub async fn revoke_mandate(
        &self,
        http: &OutboundHttp,
        customer_id: &str,
        mandate_id: &str,
    ) -> Result<(), MollieError> {
        if !is_customer_id(customer_id) {
            return Err(not_an_id("customer"));
        }
        if !is_mandate_id(mandate_id) {
            return Err(not_an_id("mandate"));
        }
        let request = self.authorized(HttpRequest::empty(
            "DELETE",
            format!("{}/customers/{customer_id}/mandates/{mandate_id}", self.api_url),
        ));
        match Self::json_of(http.send(request).await) {
            Ok(_) => Ok(()),
            Err(error) if error.is_not_found() => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// `POST /payments/{id}/refunds`: refunds `amount` of a paid payment.
    pub async fn refund(
        &self,
        http: &OutboundHttp,
        payment_id: &str,
        amount: &Money,
        description: &str,
        idempotency_key: &str,
    ) -> Result<Refund, MollieError> {
        if !is_payment_id(payment_id) {
            return Err(not_an_id("payment"));
        }
        let description: String = description.chars().take(140).collect();
        let body = json!({ "amount": amount.to_json(), "description": description });
        let answer = Self::json_of(
            http.send(self.post(
                &format!("/payments/{payment_id}/refunds"),
                &body,
                Some(idempotency_key),
            ))
            .await,
        )?;
        Ok(Refund {
            id: answer
                .get("id")
                .and_then(Value::as_str)
                .ok_or(MollieError::Malformed)?
                .to_owned(),
            status: answer
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            amount: Money::from_json(answer.get("amount")),
        })
    }

    fn json_of(response: Result<HttpResponse, PortError>) -> Result<Value, MollieError> {
        let response = response.map_err(MollieError::Unreachable)?;
        if response.status == 204 {
            return Ok(Value::Null);
        }
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
        Ok(body)
    }
}

/// `url` with `name=value` added to its query, or `None` when it isn't a URL.
pub fn with_query(url: &str, name: &str, value: &str) -> Option<String> {
    let mut url = url::Url::parse(url).ok()?;
    url.query_pairs_mut().append_pair(name, value);
    Some(url.into())
}

/// A locale Mollie's checkout takes, from a WeldSuite language (`nl`, `en`).
pub fn checkout_locale(language: Option<&str>) -> Option<String> {
    match language.map(|l| l.trim().to_ascii_lowercase()) {
        Some(l) if l.starts_with("nl") => Some("nl_NL".to_owned()),
        Some(l) if l.starts_with("de") => Some("de_DE".to_owned()),
        Some(l) if l.starts_with("fr") => Some("fr_FR".to_owned()),
        Some(l) if l.starts_with("es") => Some("es_ES".to_owned()),
        Some(l) if l.starts_with("en") => Some("en_US".to_owned()),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
