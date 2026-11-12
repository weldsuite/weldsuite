//! The bank-feed providers (`@weldsuite/bank-feeds`): Plaid, Stripe
//! Financial Connections, Ponto and Enable Banking, as outbound calls
//! through the `OutboundHttp` port. Each turns its aggregator's shapes into
//! the provider-neutral model: amounts in signed minor units (money in
//! positive), calendar dates, pending flagged, one connection status.
//!
//! Webhook verification and parsing live with integration-webhook-worker;
//! books only links, syncs and disconnects.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Map, Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use super::normalize::{
    account_fingerprint, connection_status, decimal_to_minor, iban_fingerprint, normalize_date,
    persistent_account_fingerprint, re_pull_window, sha256_hex,
};
use super::ponto_signature::{PontoSignature, sign_request};
use super::{
    FeedAccount, FeedBalance, FeedConnection, FeedError, FeedTransaction, StoredConnection,
    SyncResult,
};
use crate::js::{iso_from_millis, number_text};

// ── Reading untyped payloads (`http.ts`) ────────────────────────────────────

pub(crate) fn rec(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn arr(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `asString`: a string, or a finite number as text.
pub(crate) fn st(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()).map(number_text),
        _ => None,
    }
}

/// `asNumber`: a finite number, or a numeric string.
pub(crate) fn num(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) if !crate::jurisdictions::js_trim(s).is_empty() => {
            let n = weldsuite_kit::validation::js_number(s);
            n.is_finite().then_some(n)
        }
        _ => None,
    }
}

/// `kindForStatus`.
fn kind_for_status(status: u16) -> &'static str {
    match status {
        401 | 403 => "auth",
        429 => "rate_limit",
        408 => "transient",
        s if s >= 500 => "transient",
        _ => "permanent",
    }
}

enum Body {
    None,
    Json(Value),
    Form(Vec<(String, String)>),
}

/// `new URLSearchParams(entries).toString()`.
pub(crate) fn form_text(entries: &[(String, String)]) -> String {
    let mut out = form_urlencoded::Serializer::new(String::new());
    for (key, value) in entries {
        out.append_pair(key, value);
    }
    out.finish()
}

/// `queryString(entries)`.
fn query_string(entries: &[(String, String)]) -> String {
    if entries.is_empty() {
        String::new()
    } else {
        format!("?{}", form_text(entries))
    }
}

fn pair(key: &str, value: impl Into<String>) -> (String, String) {
    (key.to_owned(), value.into())
}

type MapError = fn(u16, &Map<String, Value>) -> Option<FeedError>;

/// `requestJson(url, options)`: one JSON request; the error never carries the
/// request body.
async fn request_json(
    http: Option<&OutboundHttp>,
    provider: &str,
    method: Option<&str>,
    url: &str,
    headers: Vec<(String, String)>,
    body: Body,
    map_error: Option<MapError>,
) -> Result<Map<String, Value>, FeedError> {
    send_json(
        http,
        provider,
        build_request(method, url, headers, body),
        map_error,
    )
    .await
}

/// The request `requestJson` sends: `Accept` (JSON unless the call names
/// its own), the body and its type.
fn build_request(
    method: Option<&str>,
    url: &str,
    headers: Vec<(String, String)>,
    body: Body,
) -> HttpRequest {
    let own_accept = headers.iter().any(|(k, _)| k == "Accept");
    let mut headers: Vec<(String, String)> = (!own_accept)
        .then(|| pair("Accept", "application/json"))
        .into_iter()
        .chain(headers)
        .collect();
    let payload = match body {
        Body::None => None,
        Body::Json(value) => {
            if !headers.iter().any(|(k, _)| k == "Content-Type") {
                headers.push(pair("Content-Type", "application/json"));
            }
            Some(value.to_string())
        }
        Body::Form(entries) => {
            headers.push(pair("Content-Type", "application/x-www-form-urlencoded"));
            Some(form_text(&entries))
        }
    };
    let method = method.unwrap_or(if payload.is_some() { "POST" } else { "GET" });
    HttpRequest {
        method: method.to_owned(),
        url: url.to_owned(),
        headers,
        body: payload.map(String::into_bytes),
    }
}

/// Send a built request and read its JSON answer.
async fn send_json(
    http: Option<&OutboundHttp>,
    provider: &str,
    request: HttpRequest,
    map_error: Option<MapError>,
) -> Result<Map<String, Value>, FeedError> {
    let Some(http) = http else {
        return Err(FeedError::new(
            provider,
            "transient",
            format!("{provider} request failed: network error"),
        ));
    };
    let response = http.send(request).await.map_err(|error| {
        FeedError::new(
            provider,
            "transient",
            format!("{provider} request failed: {error}"),
        )
    })?;
    let parsed = match serde_json::from_slice::<Value>(&response.body) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    if response.ok() {
        return Ok(parsed);
    }
    if let Some(mapped) = map_error.and_then(|map| map(response.status, &parsed)) {
        return Err(mapped);
    }
    Err(FeedError {
        status: Some(response.status),
        ..FeedError::new(
            provider,
            kind_for_status(response.status),
            format!("{provider} responded {}", response.status),
        )
    })
}

fn encode(segment: &str) -> String {
    weldsuite_kit::cursor::encode_uri_component(segment)
}

fn now_iso() -> String {
    crate::http::now()
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    arr(value)
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

// ── Configuration (`factory.ts`) ────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PlaidConfig {
    pub client_id: String,
    pub secret: String,
    pub production: bool,
    pub webhook_url: Option<String>,
    pub redirect_uri: Option<String>,
    pub country_codes: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct StripeConfig {
    pub secret_key: String,
    pub api_version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PontoConfig {
    pub client_id: String,
    pub client_secret: String,
    /// A sandbox application (`PONTO_ENV=sandbox`): it authorizes on the
    /// sandbox's own page. The API host is the same; the mTLS certificate
    /// decides which data answers.
    pub sandbox: bool,
    /// The signature certificate every request is signed with; None sends
    /// them unsigned (Ponto requires signatures for payments only).
    pub signature: Option<PontoSignature>,
}

#[derive(Debug, Clone)]
pub struct EnableBankingConfig {
    pub app_id: String,
    pub private_key: String,
}

/// `BankFeedConfig`: the providers this server has credentials for.
#[derive(Debug, Clone, Default)]
pub struct FeedConfig {
    pub plaid: Option<PlaidConfig>,
    pub stripe: Option<StripeConfig>,
    pub ponto: Option<PontoConfig>,
    /// `PONTO_APPLICATION_ID`: the Ponto application's id in Isabel's
    /// developer portal, which its webhook signatures name. Set, Ponto's
    /// webhooks are on (verified by the receiver even without the OAuth
    /// client) and connections are polled once a day.
    pub ponto_application_id: Option<String>,
    pub enable_banking: Option<EnableBankingConfig>,
    /// `BANK_FEED_PROVIDERS`.
    pub routing: Option<String>,
}

impl FeedConfig {
    /// `bankFeedConfigFromEnv(env)`, reading each variable through `get`.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Self {
        let filled = |name: &str| get(name).filter(|v| !v.is_empty());
        let webhook_base = get("BANK_FEED_WEBHOOK_URL").map(|v| v.trim_end_matches('/').to_owned());
        let mut config = Self {
            routing: get("BANK_FEED_PROVIDERS"),
            ponto_application_id: filled("PONTO_APPLICATION_ID"),
            ..Self::default()
        };
        if let (Some(client_id), Some(secret)) = (filled("PLAID_CLIENT_ID"), filled("PLAID_SECRET"))
        {
            config.plaid = Some(PlaidConfig {
                client_id,
                secret,
                production: get("PLAID_ENV").as_deref() == Some("production"),
                webhook_url: webhook_base
                    .as_ref()
                    .filter(|b| !b.is_empty())
                    .map(|b| format!("{b}/plaid")),
                redirect_uri: filled("PLAID_REDIRECT_URI"),
                country_codes: filled("PLAID_COUNTRY_CODES").map(|codes| {
                    codes
                        .split(',')
                        .map(|c| crate::jurisdictions::js_trim(c).to_uppercase())
                        .collect()
                }),
            });
        }
        if let Some(secret_key) = filled("STRIPE_FC_SECRET_KEY") {
            config.stripe = Some(StripeConfig {
                secret_key,
                api_version: filled("STRIPE_FC_API_VERSION"),
            });
        }
        if let (Some(client_id), Some(client_secret)) =
            (filled("PONTO_CLIENT_ID"), filled("PONTO_CLIENT_SECRET"))
        {
            config.ponto = Some(PontoConfig {
                client_id,
                client_secret,
                sandbox: get("PONTO_ENV").as_deref() == Some("sandbox"),
                signature: match (
                    filled("PONTO_SIGNATURE_CERT_ID"),
                    filled("PONTO_SIGNATURE_KEY"),
                ) {
                    (Some(certificate_id), Some(private_key)) => Some(PontoSignature {
                        certificate_id,
                        private_key,
                    }),
                    _ => None,
                },
            });
        }
        if let (Some(app_id), Some(private_key)) = (
            filled("ENABLE_BANKING_APP_ID"),
            filled("ENABLE_BANKING_PRIVATE_KEY"),
        ) {
            config.enable_banking = Some(EnableBankingConfig {
                app_id,
                private_key,
            });
        }
        config
    }

    /// `configuredProviderIds(config)`.
    fn configured(&self) -> Vec<&'static str> {
        let mut ids = Vec::new();
        if self.plaid.is_some() {
            ids.push("plaid");
        }
        if self.stripe.is_some() {
            ids.push("stripe_fc");
        }
        if self.ponto.is_some() {
            ids.push("ponto");
        }
        if self.enable_banking.is_some() {
            ids.push("enable_banking");
        }
        ids
    }

    /// `enabledProviders(country, config)`: the providers offered for a
    /// country, in the order to show them.
    pub fn enabled(&self, country: &str) -> Vec<&'static str> {
        let code = country.to_uppercase();
        let configured = self.configured();
        let order: Vec<String> = match self.routing.as_deref().filter(|r| !r.is_empty()) {
            Some(spec) => {
                let routing = parse_routing(spec);
                let mut order = routing.get(code.as_str()).cloned().unwrap_or_default();
                order.extend(routing.get("*").cloned().unwrap_or_default());
                order
            }
            None => ["plaid", "stripe_fc", "ponto", "enable_banking"]
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
        };
        let mut seen: Vec<String> = Vec::new();
        let mut out = Vec::new();
        for id in order {
            if seen.contains(&id) {
                continue;
            }
            seen.push(id.clone());
            let Some(known) = configured.iter().find(|c| **c == id) else {
                continue;
            };
            if regions(known, self).contains(&code) {
                out.push(*known);
            }
        }
        out
    }
}

/// `normalizeProviderId`: `stripe-fc` → `stripe_fc`.
pub fn normalize_provider_id(id: &str) -> String {
    crate::jurisdictions::js_trim(id)
        .to_lowercase()
        .replace('-', "_")
}

/// `parseProviderRouting(spec)`.
fn parse_routing(spec: &str) -> HashMap<String, Vec<String>> {
    let mut routing = HashMap::new();
    for part in spec.split(';') {
        let mut halves = part.split(':');
        let (Some(country), Some(list)) = (halves.next(), halves.next()) else {
            continue;
        };
        let country = crate::jurisdictions::js_trim(country);
        if country.is_empty() {
            continue;
        }
        routing.insert(
            country.to_uppercase(),
            list.split(',')
                .map(normalize_provider_id)
                .filter(|id| !id.is_empty())
                .collect(),
        );
    }
    routing
}

const EU_PONTO: &[&str] = &[
    "BE", "NL", "LU", "FR", "DE", "ES", "IT", "AT", "PT", "IE", "FI",
];
const EU_ENABLE: &[&str] = &[
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT",
    "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "GB",
];

fn regions(id: &str, config: &FeedConfig) -> Vec<String> {
    match id {
        "plaid" => config
            .plaid
            .as_ref()
            .and_then(|p| p.country_codes.clone())
            .unwrap_or_else(|| vec!["US".to_owned()]),
        "stripe_fc" => vec!["US".to_owned()],
        "ponto" => EU_PONTO.iter().map(|s| (*s).to_owned()).collect(),
        _ => EU_ENABLE.iter().map(|s| (*s).to_owned()).collect(),
    }
}

/// `ProviderCapabilities` of a provider.
pub fn capabilities(id: &str, config: &FeedConfig) -> Value {
    let regions = regions(id, config);
    match id {
        "plaid" => json!({
            "regions": regions, "changeCursor": true, "webhooks": true, "pendingTransactions": true,
            "maxHistoryDays": 730, "onDemandRefresh": true, "accountTypes": ["depository", "credit", "loan"],
        }),
        "stripe_fc" => json!({
            "regions": regions, "changeCursor": true, "webhooks": true, "pendingTransactions": true,
            "maxHistoryDays": 180, "onDemandRefresh": true, "accountTypes": ["depository", "credit", "loan"],
        }),
        // Webhooks with an application id, which their signatures name.
        "ponto" => json!({
            "regions": regions, "changeCursor": false, "webhooks": config.ponto_application_id.is_some(), "pendingTransactions": false,
            "maxHistoryDays": 540, "onDemandRefresh": true, "consentTtlDays": 180, "accountTypes": ["depository"],
        }),
        _ => json!({
            "regions": regions, "changeCursor": false, "webhooks": false, "pendingTransactions": false,
            "maxHistoryDays": 730, "onDemandRefresh": false, "consentTtlDays": 180, "accountTypes": ["depository", "credit"],
        }),
    }
}

// ── The provider ────────────────────────────────────────────────────────────

/// `LinkSessionInput`.
#[derive(Debug, Clone, Default)]
pub struct LinkInput {
    pub workspace_id: String,
    pub mode: String,
    pub history_days: i64,
    pub redirect_url: String,
    pub connection: Option<StoredConnection>,
    /// `{ id?, name, country }`.
    pub institution: Option<Value>,
    pub psu_type: Option<String>,
}

/// One configured provider (`createBankFeedProvider(id, config)`).
pub struct Provider<'a> {
    pub id: &'static str,
    config: &'a FeedConfig,
    http: Option<&'a OutboundHttp>,
    /// Ponto's mTLS client, when the server has one.
    ponto_http: Option<&'a OutboundHttp>,
    /// Ponto tokens refreshed during this request.
    refreshed: Mutex<HashMap<String, Value>>,
    /// Ponto accounts a sync read, so the balances that follow need no
    /// second call (None: the account left the integration).
    details: Mutex<HashMap<String, Option<Map<String, Value>>>>,
    /// The waits between looks at the synchronizations a Ponto refresh
    /// started (tests wait for nothing).
    poll_waits: Vec<u64>,
}

impl<'a> Provider<'a> {
    /// `createBankFeedProvider(id, config)`.
    pub fn create(
        id: &str,
        config: &'a FeedConfig,
        http: Option<&'a OutboundHttp>,
        ponto_http: Option<&'a OutboundHttp>,
    ) -> Result<Self, FeedError> {
        let normalized = normalize_provider_id(id);
        let (known, configured): (&'static str, bool) = match normalized.as_str() {
            "plaid" => ("plaid", config.plaid.is_some()),
            "stripe_fc" => ("stripe_fc", config.stripe.is_some()),
            "ponto" => ("ponto", config.ponto.is_some()),
            "enable_banking" => ("enable_banking", config.enable_banking.is_some()),
            _ => {
                return Err(FeedError::new(
                    id,
                    "unsupported",
                    format!("Unknown bank feed provider '{id}'"),
                ));
            }
        };
        if !configured {
            return Err(FeedError::new(
                id,
                "not_configured",
                format!("Bank feed provider '{id}' is not configured"),
            ));
        }
        Ok(Self {
            id: known,
            config,
            http,
            ponto_http,
            refreshed: Mutex::default(),
            details: Mutex::default(),
            poll_waits: PONTO_REFRESH_POLL_MS.to_vec(),
        })
    }

    /// `pendingCredentials(providerConnectionId)`: credentials rotated here
    /// that no sync result carried away yet (Ponto's refresh token works
    /// once), for a sync that failed after the refresh.
    pub fn pending_credentials(&self, provider_connection_id: &str) -> Option<Value> {
        self.refreshed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(provider_connection_id)
            .cloned()
    }

    pub fn capabilities(&self) -> Value {
        capabilities(self.id, self.config)
    }

    pub fn max_history_days(&self) -> i64 {
        self.capabilities()["maxHistoryDays"]
            .as_i64()
            .unwrap_or(730)
    }

    pub fn has_webhooks(&self) -> bool {
        self.capabilities()["webhooks"] == json!(true)
    }

    pub fn has_institution_list(&self) -> bool {
        self.id == "enable_banking"
    }

    pub fn has_refresh(&self) -> bool {
        self.id != "enable_banking"
    }

    pub async fn create_link_session(&self, input: &LinkInput) -> Result<Value, FeedError> {
        match self.id {
            "plaid" => self.plaid_link(input).await,
            "stripe_fc" => self.stripe_link(input).await,
            "ponto" => Ok(self.ponto_link(input)),
            _ => self.eb_link(input).await,
        }
    }

    pub async fn complete_link(
        &self,
        payload: &Value,
    ) -> Result<(FeedConnection, Vec<FeedAccount>), FeedError> {
        match self.id {
            "plaid" => self.plaid_complete(payload).await,
            "stripe_fc" => self.stripe_complete(payload).await,
            "ponto" => self.ponto_complete(payload).await,
            _ => self.eb_complete(payload).await,
        }
    }

    pub async fn sync_transactions(
        &self,
        stored: &StoredConnection,
        cursor: &Value,
    ) -> Result<SyncResult, FeedError> {
        match self.id {
            "plaid" => self.plaid_sync(stored, cursor).await,
            "stripe_fc" => self.stripe_sync(stored, cursor).await,
            "ponto" => self.ponto_sync(stored, cursor).await,
            _ => self.eb_sync(stored, cursor).await,
        }
    }

    pub async fn get_balances(
        &self,
        stored: &StoredConnection,
    ) -> Result<Vec<FeedBalance>, FeedError> {
        match self.id {
            "plaid" => self.plaid_balances(stored).await,
            "stripe_fc" => self.stripe_balances(stored).await,
            "ponto" => self.ponto_balances(stored).await,
            _ => self.eb_balances(stored).await,
        }
    }

    /// `refresh(connection, { customerIp })`: ask the provider to fetch fresh
    /// data from the bank. `customer_ip` is the member's address, which Ponto
    /// requires as evidence that the customer is present.
    pub async fn refresh(
        &self,
        stored: &StoredConnection,
        customer_ip: Option<&str>,
    ) -> Result<(), FeedError> {
        match self.id {
            "plaid" => self
                .plaid(
                    "/transactions/refresh",
                    json!({ "access_token": plaid_token(Some(stored))? }),
                )
                .await
                .map(|_| ()),
            "stripe_fc" => self.stripe_refresh(stored).await,
            "ponto" => self.ponto_refresh(stored, customer_ip).await,
            _ => Ok(()),
        }
    }

    pub async fn disconnect(&self, stored: &StoredConnection) -> Result<(), FeedError> {
        match self.id {
            "plaid" => match plaid_token(Some(stored)) {
                Ok(token) => match self
                    .plaid("/item/remove", json!({ "access_token": token }))
                    .await
                {
                    Ok(_) => Ok(()),
                    Err(e)
                        if e.kind == "revoked" || e.code.as_deref() == Some("ITEM_NOT_FOUND") =>
                    {
                        Ok(())
                    }
                    Err(e) => Err(e),
                },
                Err(e) => Err(e),
            },
            "stripe_fc" => self.stripe_disconnect(stored).await,
            "ponto" => self.ponto_disconnect(stored).await,
            _ => self.eb_disconnect(stored).await,
        }
    }

    pub async fn list_institutions(&self, country: &str) -> Result<Vec<Value>, FeedError> {
        let response = self
            .eb_call(
                "GET",
                "/aspsps",
                vec![pair("country", country.to_uppercase())],
                None,
            )
            .await?;
        Ok(arr(response.get("aspsps"))
            .iter()
            .filter_map(|aspsp| {
                let aspsp = rec(Some(aspsp));
                let name = st(aspsp.get("name"))?;
                Some(json!({
                    "id": name,
                    "name": name,
                    "country": st(aspsp.get("country")).unwrap_or_else(|| country.to_uppercase()),
                    "logoUrl": st(aspsp.get("logo")),
                }))
            })
            .collect())
    }
}

// ── Plaid ───────────────────────────────────────────────────────────────────

fn plaid_token(connection: Option<&StoredConnection>) -> Result<String, FeedError> {
    connection
        .and_then(|c| st(c.credentials.get("accessToken")))
        .ok_or_else(|| FeedError::new("plaid", "permanent", "Plaid connection has no access token"))
}

fn map_plaid_error(status: u16, body: &Map<String, Value>) -> Option<FeedError> {
    let code = st(body.get("error_code"))?;
    let message = format!(
        "Plaid {code}{}",
        st(body.get("error_message"))
            .map(|m| format!(": {m}"))
            .unwrap_or_default()
    );
    let kind = match code.as_str() {
        "ITEM_LOGIN_REQUIRED"
        | "ITEM_LOCKED"
        | "INVALID_CREDENTIALS"
        | "INVALID_MFA"
        | "ITEM_NO_VERIFICATION" => "reauth_required",
        "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" => "mutation_during_pagination",
        "ITEM_NOT_FOUND" | "ACCESS_NOT_GRANTED" | "USER_PERMISSION_REVOKED" => "revoked",
        "RATE_LIMIT_EXCEEDED" | "TRANSACTIONS_LIMIT" => "rate_limit",
        "INVALID_API_KEYS"
        | "INVALID_CLIENT_ID"
        | "INVALID_SECRET"
        | "UNAUTHORIZED_ENVIRONMENT" => "auth",
        "PRODUCT_NOT_READY"
        | "INTERNAL_SERVER_ERROR"
        | "PLANNED_MAINTENANCE"
        | "INSTITUTION_DOWN"
        | "INSTITUTION_NOT_RESPONDING" => "transient",
        _ => return None,
    };
    Some(FeedError {
        status: Some(status),
        code: Some(code),
        ..FeedError::new("plaid", kind, message)
    })
}

fn plaid_subtype(value: Option<&Value>) -> Option<String> {
    st(value).map(|raw| {
        let lower = crate::jurisdictions::js_trim(&raw).to_lowercase();
        let mut out = String::new();
        let mut gap = false;
        for c in lower.chars() {
            if crate::jurisdictions::is_js_space(c) || c == '-' {
                gap = true;
            } else {
                if gap {
                    out.push('_');
                }
                gap = false;
                out.push(c);
            }
        }
        if gap {
            out.push('_');
        }
        out
    })
}

fn plaid_type(value: Option<&Value>) -> Option<&'static str> {
    match st(value).as_deref() {
        Some("depository") => Some("depository"),
        Some("credit") => Some("credit"),
        Some("loan") => Some("loan"),
        _ => None,
    }
}

fn plaid_currency(balances: &Map<String, Value>) -> String {
    st(balances.get("iso_currency_code"))
        .or_else(|| st(balances.get("unofficial_currency_code")))
        .unwrap_or_else(|| "USD".to_owned())
}

fn plaid_balance(
    account: &Map<String, Value>,
    kind: &str,
    currency: &str,
    as_of: &str,
) -> Option<FeedBalance> {
    let balances = rec(account.get("balances"));
    let current = num(balances.get("current"))?;
    let account_id = st(account.get("account_id"))?;
    let minor = decimal_to_minor(current, currency).ok()?;
    Some(FeedBalance {
        account_id,
        current: if matches!(kind, "credit" | "loan") {
            if minor == 0 { 0 } else { -minor }
        } else {
            minor
        },
        currency: currency.to_owned(),
        as_of: as_of.to_owned(),
    })
}

fn plaid_transaction(raw: &Map<String, Value>) -> Option<FeedTransaction> {
    let id = st(raw.get("transaction_id"))?;
    let account_id = st(raw.get("account_id"))?;
    let amount = num(raw.get("amount"))?;
    let date = st(raw.get("date")).filter(|d| !d.is_empty())?;
    let currency = st(raw.get("iso_currency_code"))
        .or_else(|| st(raw.get("unofficial_currency_code")))
        .unwrap_or_else(|| "USD".to_owned());
    let category = rec(raw.get("personal_finance_category"));
    let minor = decimal_to_minor(amount, &currency).ok()?;
    Some(FeedTransaction {
        provider_transaction_id: id,
        pending_transaction_id: st(raw.get("pending_transaction_id")),
        account_id,
        date: normalize_date(&Value::String(date)).ok()?,
        amount_minor: if minor == 0 { 0 } else { -minor },
        currency,
        description: st(raw.get("name"))
            .or_else(|| st(raw.get("original_description")))
            .unwrap_or_default(),
        merchant_name: st(raw.get("merchant_name")),
        check_number: st(raw.get("check_number")),
        category: st(category.get("primary"))
            .filter(|p| !p.is_empty())
            .map(|primary| {
                json!({
                    "source": "plaid",
                    "primary": primary,
                    "detailed": st(category.get("detailed")),
                    "confidence": st(category.get("confidence_level")),
                })
            }),
        pending: raw.get("pending") == Some(&Value::Bool(true)),
        raw: Value::Object(raw.clone()),
    })
}

impl Provider<'_> {
    fn plaid_config(&self) -> &PlaidConfig {
        self.config.plaid.as_ref().expect("plaid is configured")
    }

    fn plaid_base(&self) -> &'static str {
        if self.plaid_config().production {
            "https://production.plaid.com"
        } else {
            "https://sandbox.plaid.com"
        }
    }

    fn plaid_countries(&self) -> Value {
        json!(
            self.plaid_config()
                .country_codes
                .clone()
                .unwrap_or_else(|| vec!["US".to_owned()])
        )
    }

    async fn plaid(&self, path: &str, body: Value) -> Result<Map<String, Value>, FeedError> {
        let config = self.plaid_config();
        let mut full = Map::new();
        full.insert("client_id".to_owned(), json!(config.client_id));
        full.insert("secret".to_owned(), json!(config.secret));
        if let Value::Object(body) = body {
            full.extend(body);
        }
        request_json(
            self.http,
            "plaid",
            None,
            &format!("{}{path}", self.plaid_base()),
            Vec::new(),
            Body::Json(Value::Object(full)),
            Some(map_plaid_error),
        )
        .await
    }

    async fn plaid_link(&self, input: &LinkInput) -> Result<Value, FeedError> {
        let config = self.plaid_config();
        let mut body = Map::new();
        body.insert("client_name".to_owned(), json!("WeldSuite"));
        body.insert("language".to_owned(), json!("en"));
        body.insert("country_codes".to_owned(), self.plaid_countries());
        body.insert(
            "user".to_owned(),
            json!({ "client_user_id": input.workspace_id }),
        );
        if let Some(webhook) = &config.webhook_url {
            body.insert("webhook".to_owned(), json!(webhook));
        }
        if let Some(redirect) = &config.redirect_uri {
            body.insert("redirect_uri".to_owned(), json!(redirect));
        }
        if input.mode == "create" {
            body.insert("products".to_owned(), json!(["transactions"]));
            body.insert(
                "transactions".to_owned(),
                json!({ "days_requested": input.history_days.clamp(30, 730) }),
            );
            body.insert(
                "account_filters".to_owned(),
                json!({ "depository": { "account_subtypes": ["all"] }, "credit": { "account_subtypes": ["all"] } }),
            );
        } else {
            body.insert(
                "access_token".to_owned(),
                json!(plaid_token(input.connection.as_ref())?),
            );
            if input.mode == "add_accounts" {
                body.insert(
                    "update".to_owned(),
                    json!({ "account_selection_enabled": true }),
                );
            }
        }
        let response = self
            .plaid("/link/token/create", Value::Object(body))
            .await?;
        let Some(token) = st(response.get("link_token")).filter(|t| !t.is_empty()) else {
            return Err(FeedError::new(
                "plaid",
                "permanent",
                "Plaid returned no link token",
            ));
        };
        Ok(
            json!({ "kind": "plaid_link", "token": token, "expiresAt": st(response.get("expiration")) }),
        )
    }

    async fn plaid_institution_name(&self, institution_id: Option<&str>) -> Option<String> {
        let id = institution_id?;
        let response = self
            .plaid(
                "/institutions/get_by_id",
                json!({ "institution_id": id, "country_codes": self.plaid_countries() }),
            )
            .await
            .ok()?;
        st(rec(response.get("institution")).get("name"))
    }

    fn plaid_accounts(
        response: &Map<String, Value>,
        institution: &(Option<String>, Option<String>),
    ) -> Vec<FeedAccount> {
        let as_of = now_iso();
        let mut out = Vec::new();
        for raw in arr(response.get("accounts")) {
            let raw = rec(Some(&raw));
            let (Some(id), Some(kind)) = (st(raw.get("account_id")), plaid_type(raw.get("type")))
            else {
                continue;
            };
            let subtype = plaid_subtype(raw.get("subtype"));
            let mask = st(raw.get("mask"));
            let balances = rec(raw.get("balances"));
            let currency = plaid_currency(&balances);
            let fingerprint = match st(raw.get("persistent_account_id")).filter(|p| !p.is_empty()) {
                Some(persistent) => persistent_account_fingerprint(&persistent),
                None => account_fingerprint(
                    institution.0.as_deref().or(institution.1.as_deref()),
                    mask.as_deref(),
                    subtype.as_deref(),
                ),
            };
            out.push(FeedAccount {
                provider_account_id: id,
                name: st(raw.get("name"))
                    .or_else(|| st(raw.get("official_name")))
                    .unwrap_or_else(|| "Account".to_owned()),
                mask,
                iban: None,
                kind: kind.to_owned(),
                subtype,
                currency: currency.clone(),
                institution_id: institution.0.clone(),
                institution_name: institution.1.clone(),
                fingerprint,
                status: None,
                balance: plaid_balance(&raw, kind, &currency, &as_of),
            });
        }
        out
    }

    async fn plaid_complete(
        &self,
        payload: &Value,
    ) -> Result<(FeedConnection, Vec<FeedAccount>), FeedError> {
        let input = rec(Some(payload));
        let stored = input
            .get("connection")
            .and_then(StoredConnection::from_value);
        let (access_token, mut item_id, cursor) =
            match st(input.get("publicToken")).filter(|t| !t.is_empty()) {
                Some(public_token) => {
                    let exchanged = self
                        .plaid(
                            "/item/public_token/exchange",
                            json!({ "public_token": public_token }),
                        )
                        .await?;
                    let token = st(exchanged.get("access_token")).unwrap_or_default();
                    let item = st(exchanged.get("item_id"));
                    if token.is_empty() || item.as_deref().is_none_or(str::is_empty) {
                        return Err(FeedError::new(
                            "plaid",
                            "permanent",
                            "Plaid token exchange returned no item",
                        ));
                    }
                    (token, item, Value::Null)
                }
                None => (
                    plaid_token(stored.as_ref())?,
                    stored.as_ref().map(|c| c.provider_connection_id.clone()),
                    stored.as_ref().map_or(Value::Null, |c| c.cursor.clone()),
                ),
            };
        let fetched = self
            .plaid("/accounts/get", json!({ "access_token": access_token }))
            .await?;
        let item = rec(fetched.get("item"));
        item_id = item_id
            .filter(|i| !i.is_empty())
            .or_else(|| st(item.get("item_id")));
        let Some(item_id) = item_id.filter(|i| !i.is_empty()) else {
            return Err(FeedError::new(
                "plaid",
                "permanent",
                "Plaid returned no item id",
            ));
        };
        let institution = rec(input.get("institution"));
        let institution_id = match institution.get("institutionId") {
            Some(v) if !v.is_null() => st(Some(v)),
            _ => st(item.get("institution_id")),
        };
        let institution_name = match institution.get("name") {
            Some(v) if !v.is_null() => st(Some(v)),
            _ => match st(item.get("institution_name")) {
                Some(name) => Some(name),
                None => self.plaid_institution_name(institution_id.as_deref()).await,
            },
        };
        let accounts = Self::plaid_accounts(
            &fetched,
            &(institution_id.clone(), institution_name.clone()),
        );
        let login_required =
            st(rec(item.get("error")).get("error_code")).as_deref() == Some("ITEM_LOGIN_REQUIRED");
        Ok((
            FeedConnection {
                provider: "plaid".to_owned(),
                provider_connection_id: item_id,
                index_keys: None,
                institution_id,
                institution_name,
                status: if login_required {
                    "reauth_required"
                } else {
                    "active"
                }
                .to_owned(),
                credentials: json!({ "accessToken": access_token }),
                cursor,
                consent_expires_at: st(item.get("consent_expiration_time")),
                metadata: None,
            },
            accounts,
        ))
    }

    async fn plaid_sync(
        &self,
        stored: &StoredConnection,
        cursor: &Value,
    ) -> Result<SyncResult, FeedError> {
        let token = plaid_token(Some(stored))?;
        let current = cursor.as_str().filter(|c| !c.is_empty());
        let mut body = Map::new();
        body.insert("access_token".to_owned(), json!(token));
        if let Some(current) = current {
            body.insert("cursor".to_owned(), json!(current));
        }
        body.insert("count".to_owned(), json!(500));
        body.insert(
            "options".to_owned(),
            json!({ "include_personal_finance_category": true }),
        );
        let response = match self.plaid("/transactions/sync", Value::Object(body)).await {
            Ok(response) => response,
            Err(e) if e.code.as_deref() == Some("PRODUCT_NOT_READY") => {
                return Ok(SyncResult {
                    next_cursor: cursor.clone(),
                    ..SyncResult::default()
                });
            }
            Err(e) => return Err(e),
        };
        let mut upserts = Vec::new();
        for raw in arr(response.get("added"))
            .into_iter()
            .chain(arr(response.get("modified")))
        {
            if let Some(tx) = plaid_transaction(&rec(Some(&raw))) {
                upserts.push(tx);
            }
        }
        let removals = arr(response.get("removed"))
            .iter()
            .filter_map(|r| st(rec(Some(r)).get("transaction_id")))
            .collect();
        let next = st(response.get("next_cursor")).filter(|c| !c.is_empty());
        Ok(SyncResult {
            upserts,
            removals,
            next_cursor: next.map_or_else(|| cursor.clone(), Value::String),
            has_more: response.get("has_more") == Some(&Value::Bool(true)),
            ..SyncResult::default()
        })
    }

    async fn plaid_balances(
        &self,
        stored: &StoredConnection,
    ) -> Result<Vec<FeedBalance>, FeedError> {
        let response = self
            .plaid(
                "/accounts/get",
                json!({ "access_token": plaid_token(Some(stored))? }),
            )
            .await?;
        let as_of = now_iso();
        Ok(arr(response.get("accounts"))
            .iter()
            .filter_map(|raw| {
                let account = rec(Some(raw));
                let kind = plaid_type(account.get("type"))?;
                let currency = plaid_currency(&rec(account.get("balances")));
                plaid_balance(&account, kind, &currency, &as_of)
            })
            .collect())
    }
}

// ── Stripe Financial Connections ────────────────────────────────────────────

fn map_stripe_error(status: u16, body: &Map<String, Value>) -> Option<FeedError> {
    let error = rec(body.get("error"));
    let code = st(error.get("code"));
    let message = format!(
        "Stripe{}{}",
        code.as_ref().map(|c| format!(" {c}")).unwrap_or_default(),
        st(error.get("message"))
            .map(|m| format!(": {m}"))
            .unwrap_or_default()
    );
    let kind = match code.as_deref() {
        Some("financial_connections_account_inactive") => "reauth_required",
        Some("financial_connections_account_refresh_too_soon" | "rate_limit") => "rate_limit",
        _ => return None,
    };
    Some(FeedError {
        status: Some(status),
        code,
        ..FeedError::new("stripe_fc", kind, message)
    })
}

fn stripe_status(raw: &Map<String, Value>) -> &'static str {
    match st(raw.get("status")).as_deref() {
        Some("disconnected") => "disconnected",
        Some("inactive") => "reauth_required",
        _ => "active",
    }
}

fn stripe_balance(raw: &Map<String, Value>) -> Option<FeedBalance> {
    let account_id = st(raw.get("id"))?;
    let balance = rec(raw.get("balance"));
    let current = rec(balance.get("current"));
    let (currency_key, minor) = current.iter().next()?;
    let minor = num(Some(minor))?;
    let credit = st(raw.get("category")).as_deref() == Some("credit");
    #[allow(clippy::cast_possible_truncation)]
    let minor = minor as i64;
    let as_of = num(balance.get("as_of"));
    Some(FeedBalance {
        account_id,
        current: if credit {
            if minor == 0 { 0 } else { -minor }
        } else {
            minor
        },
        currency: currency_key.to_uppercase(),
        as_of: as_of
            .and_then(|s| {
                #[allow(clippy::cast_possible_truncation)]
                iso_from_millis((s * 1000.0) as i64)
            })
            .unwrap_or_else(now_iso),
    })
}

fn stripe_account(raw: &Map<String, Value>) -> Option<FeedAccount> {
    let id = st(raw.get("id"))?;
    let subtype = st(raw.get("subcategory"));
    let kind = match st(raw.get("category")).as_deref() {
        Some("cash") => "depository",
        Some("credit") if matches!(subtype.as_deref(), Some("mortgage" | "line_of_credit")) => {
            "loan"
        }
        Some("credit") => "credit",
        _ => return None,
    };
    let institution_name = st(raw.get("institution_name"));
    let institution_id = institution_name
        .as_deref()
        .map(|n| super::normalize::slug(Some(n)));
    let mask = st(raw.get("last4"));
    let balance = stripe_balance(raw);
    Some(FeedAccount {
        provider_account_id: id,
        name: st(raw.get("display_name"))
            .or_else(|| institution_name.clone())
            .unwrap_or_else(|| "Account".to_owned()),
        fingerprint: account_fingerprint(
            institution_id.as_deref(),
            mask.as_deref(),
            subtype.as_deref(),
        ),
        mask,
        iban: None,
        kind: kind.to_owned(),
        subtype,
        currency: balance
            .as_ref()
            .map_or_else(|| "USD".to_owned(), |b| b.currency.clone()),
        institution_id,
        institution_name,
        status: Some(stripe_status(raw).to_owned()),
        balance,
    })
}

enum StripeLine {
    Tx(Box<FeedTransaction>),
    Removed(String),
    Skip,
}

fn stripe_transaction(raw: &Map<String, Value>) -> StripeLine {
    let Some(id) = st(raw.get("id")) else {
        return StripeLine::Skip;
    };
    let status = st(raw.get("status"));
    if status.as_deref() == Some("void") {
        return StripeLine::Removed(id);
    }
    let transitions = rec(raw.get("status_transitions"));
    let when = num(transitions.get("posted_at")).or_else(|| num(raw.get("transacted_at")));
    let (Some(account_id), Some(amount), Some(when)) =
        (st(raw.get("account")), num(raw.get("amount")), when)
    else {
        return StripeLine::Skip;
    };
    let Ok(date) = normalize_date(&json!(when)) else {
        return StripeLine::Skip;
    };
    #[allow(clippy::cast_possible_truncation)]
    let amount_minor = amount.trunc() as i64;
    StripeLine::Tx(Box::new(FeedTransaction {
        provider_transaction_id: id,
        pending_transaction_id: None,
        account_id,
        date,
        amount_minor,
        currency: st(raw.get("currency"))
            .unwrap_or_else(|| "usd".to_owned())
            .to_uppercase(),
        description: st(raw.get("description")).unwrap_or_default(),
        merchant_name: None,
        check_number: None,
        category: None,
        pending: status.as_deref() == Some("pending"),
        raw: Value::Object(raw.clone()),
    }))
}

impl Provider<'_> {
    async fn stripe(
        &self,
        method: &str,
        path: &str,
        params: Vec<(String, String)>,
        extra: Vec<(String, String)>,
    ) -> Result<Map<String, Value>, FeedError> {
        let config = self.config.stripe.as_ref().expect("stripe is configured");
        let auth =
            weldsuite_kit::cursor::btoa(&format!("{}:", config.secret_key)).unwrap_or_default();
        let mut headers = vec![
            pair("Authorization", format!("Basic {auth}")),
            pair(
                "Stripe-Version",
                config
                    .api_version
                    .clone()
                    .unwrap_or_else(|| "2025-11-17.clover".to_owned()),
            ),
        ];
        headers.extend(extra);
        let get = method == "GET";
        let url = format!(
            "https://api.stripe.com{path}{}",
            if get {
                query_string(&params)
            } else {
                String::new()
            }
        );
        request_json(
            self.http,
            "stripe_fc",
            Some(method),
            &url,
            headers,
            if get { Body::None } else { Body::Form(params) },
            Some(map_stripe_error),
        )
        .await
    }

    async fn stripe_holder(
        &self,
        workspace_id: &str,
        known: Option<String>,
    ) -> Result<String, FeedError> {
        if let Some(known) = known.filter(|k| !k.is_empty()) {
            return Ok(known);
        }
        let found = self
            .stripe(
                "GET",
                "/v1/customers/search",
                vec![
                    pair(
                        "query",
                        format!(
                            "metadata['weldsuite_workspace']:'{}'",
                            workspace_id.replace('\'', "")
                        ),
                    ),
                    pair("limit", "1"),
                ],
                Vec::new(),
            )
            .await?;
        if let Some(existing) =
            st(rec(arr(found.get("data")).first()).get("id")).filter(|i| !i.is_empty())
        {
            return Ok(existing);
        }
        let created = self
            .stripe(
                "POST",
                "/v1/customers",
                vec![
                    pair("description", format!("WeldSuite workspace {workspace_id}")),
                    pair("metadata[weldsuite_workspace]", workspace_id),
                ],
                vec![pair(
                    "Idempotency-Key",
                    format!("weldsuite-bank-feeds-customer-{workspace_id}"),
                )],
            )
            .await?;
        st(created.get("id"))
            .filter(|i| !i.is_empty())
            .ok_or_else(|| {
                FeedError::new("stripe_fc", "permanent", "Stripe returned no customer id")
            })
    }

    async fn stripe_link(&self, input: &LinkInput) -> Result<Value, FeedError> {
        let known = input
            .connection
            .as_ref()
            .and_then(|c| st(c.credentials.get("accountHolderId")));
        let customer = self.stripe_holder(&input.workspace_id, known).await?;
        let session = self
            .stripe(
                "POST",
                "/v1/financial_connections/sessions",
                vec![
                    pair("account_holder[type]", "customer"),
                    pair("account_holder[customer]", customer),
                    pair("permissions[0]", "transactions"),
                    pair("permissions[1]", "balances"),
                    pair("prefetch[0]", "transactions"),
                    pair("prefetch[1]", "balances"),
                    pair("filters[countries][0]", "US"),
                    pair("return_url", input.redirect_url.clone()),
                ],
                Vec::new(),
            )
            .await?;
        let Some(secret) = st(session.get("client_secret")).filter(|s| !s.is_empty()) else {
            return Err(FeedError::new(
                "stripe_fc",
                "permanent",
                "Stripe returned no client secret",
            ));
        };
        let mut out = Map::new();
        out.insert("kind".to_owned(), json!("stripe_fc"));
        out.insert("clientSecret".to_owned(), json!(secret));
        if let Some(id) = st(session.get("id")).filter(|i| !i.is_empty()) {
            out.insert("sessionId".to_owned(), json!(id));
        }
        Ok(Value::Object(out))
    }

    #[allow(clippy::too_many_lines)] // the worker's steps, in its order
    async fn stripe_complete(
        &self,
        payload: &Value,
    ) -> Result<(FeedConnection, Vec<FeedAccount>), FeedError> {
        let input = rec(Some(payload));
        let Some(session_id) = st(input.get("sessionId")).filter(|s| !s.is_empty()) else {
            return Err(FeedError::new(
                "stripe_fc",
                "permanent",
                "Stripe Financial Connections session id missing",
            ));
        };
        let session = self
            .stripe(
                "GET",
                &format!("/v1/financial_connections/sessions/{}", encode(&session_id)),
                Vec::new(),
                Vec::new(),
            )
            .await?;
        let first = rec(session.get("accounts"));
        let mut raw_accounts: Vec<Map<String, Value>> = arr(first.get("data"))
            .iter()
            .map(|a| rec(Some(a)))
            .collect();
        if first.get("has_more") == Some(&Value::Bool(true)) {
            let mut after = raw_accounts.last().and_then(|a| st(a.get("id")));
            for _ in 0..200 {
                let Some(start) = after.clone().filter(|s| !s.is_empty()) else {
                    break;
                };
                let next = self
                    .stripe(
                        "GET",
                        "/v1/financial_connections/accounts",
                        vec![
                            pair("session", session_id.clone()),
                            pair("limit", "100"),
                            pair("starting_after", start),
                        ],
                        Vec::new(),
                    )
                    .await?;
                let data: Vec<Map<String, Value>> =
                    arr(next.get("data")).iter().map(|a| rec(Some(a))).collect();
                after = data.last().and_then(|a| st(a.get("id")));
                raw_accounts.extend(data);
                if next.get("has_more") != Some(&Value::Bool(true)) {
                    break;
                }
            }
        }
        let mut accounts = Vec::new();
        for raw in &raw_accounts {
            let Some(mapped) = stripe_account(raw) else {
                continue;
            };
            let permissions: Vec<Option<String>> = arr(raw.get("permissions"))
                .iter()
                .map(|v| st(Some(v)))
                .collect();
            let subscribed: Vec<Option<String>> = arr(raw.get("subscriptions"))
                .iter()
                .map(|v| st(Some(v)))
                .collect();
            let transactions = Some("transactions".to_owned());
            if permissions.contains(&transactions) && !subscribed.contains(&transactions) {
                let _ = self
                    .stripe(
                        "POST",
                        &format!(
                            "/v1/financial_connections/accounts/{}/subscribe",
                            encode(&mapped.provider_account_id)
                        ),
                        vec![pair("features[0]", "transactions")],
                        Vec::new(),
                    )
                    .await;
            }
            accounts.push(mapped);
        }
        let existing = input
            .get("connection")
            .and_then(StoredConnection::from_value);
        let mut account_ids: Vec<String> = existing
            .as_ref()
            .map(|c| string_list(c.metadata.get("accountIds")))
            .unwrap_or_default();
        for account in &accounts {
            if !account_ids.contains(&account.provider_account_id) {
                account_ids.push(account.provider_account_id.clone());
            }
        }
        let customer = st(rec(session.get("account_holder")).get("customer")).or_else(|| {
            existing
                .as_ref()
                .and_then(|c| st(c.credentials.get("accountHolderId")))
        });
        let statuses: Vec<String> = accounts
            .iter()
            .map(|a| a.status.clone().unwrap_or_else(|| "active".to_owned()))
            .collect();
        Ok((
            FeedConnection {
                provider: "stripe_fc".to_owned(),
                provider_connection_id: existing
                    .as_ref()
                    .map_or(session_id, |c| c.provider_connection_id.clone()),
                index_keys: Some(account_ids.clone()),
                institution_id: accounts.first().and_then(|a| a.institution_id.clone()),
                institution_name: accounts.first().and_then(|a| a.institution_name.clone()),
                status: connection_status(&statuses).to_owned(),
                credentials: json!({ "accountHolderId": customer }),
                cursor: existing.as_ref().map_or(Value::Null, |c| c.cursor.clone()),
                consent_expires_at: None,
                metadata: Some(json!({ "accountIds": account_ids })),
            },
            accounts,
        ))
    }

    fn stripe_account_ids(stored: &StoredConnection) -> Vec<String> {
        stored
            .account_ids
            .clone()
            .unwrap_or_else(|| string_list(stored.metadata.get("accountIds")))
    }

    async fn stripe_sync(
        &self,
        stored: &StoredConnection,
        cursor: &Value,
    ) -> Result<SyncResult, FeedError> {
        let previous: Map<String, Value> = rec(rec(Some(cursor)).get("refreshIds"))
            .into_iter()
            .filter_map(|(k, v)| st(Some(&v)).map(|s| (k, Value::String(s))))
            .collect();
        let mut next = previous.clone();
        let mut upserts = Vec::new();
        let mut removals = Vec::new();
        let mut statuses = Map::new();
        for account_id in Self::stripe_account_ids(stored) {
            let path = format!("/v1/financial_connections/accounts/{}", encode(&account_id));
            let account = match self.stripe("GET", &path, Vec::new(), Vec::new()).await {
                Ok(account) => account,
                Err(e) if e.kind == "reauth_required" || e.kind == "revoked" => {
                    statuses.insert(
                        account_id.clone(),
                        json!(if e.kind == "revoked" {
                            "disconnected"
                        } else {
                            "reauth_required"
                        }),
                    );
                    continue;
                }
                Err(e) => return Err(e),
            };
            let status = stripe_status(&account);
            statuses.insert(account_id.clone(), json!(status));
            if status != "active" {
                continue;
            }
            let refresh = rec(account.get("transaction_refresh"));
            let refresh_id = st(refresh.get("id"));
            let refresh_status = st(refresh.get("status"));
            let Some(refresh_id) = refresh_id.filter(|r| !r.is_empty()) else {
                continue;
            };
            if refresh_status.as_deref() == Some("pending") {
                continue;
            }
            let last = previous.get(&account_id).and_then(Value::as_str);
            if refresh_status.as_deref() == Some("succeeded") && last == Some(refresh_id.as_str()) {
                continue;
            }
            let mut after: Option<String> = None;
            for _ in 0..200 {
                let mut params = vec![pair("account", account_id.clone()), pair("limit", "100")];
                if let Some(start) = &after {
                    params.push(pair("starting_after", start.clone()));
                }
                if let Some(last) = last {
                    params.push(pair("transaction_refresh[after]", last));
                }
                let response = self
                    .stripe(
                        "GET",
                        "/v1/financial_connections/transactions",
                        params,
                        Vec::new(),
                    )
                    .await?;
                let data: Vec<Map<String, Value>> = arr(response.get("data"))
                    .iter()
                    .map(|d| rec(Some(d)))
                    .collect();
                for raw in &data {
                    match stripe_transaction(raw) {
                        StripeLine::Tx(tx) => upserts.push(*tx),
                        StripeLine::Removed(id) => removals.push(id),
                        StripeLine::Skip => {}
                    }
                }
                if response.get("has_more") != Some(&Value::Bool(true)) || data.is_empty() {
                    break;
                }
                after = data.last().and_then(|d| st(d.get("id")));
                if after.as_deref().is_none_or(str::is_empty) {
                    break;
                }
            }
            if refresh_status.as_deref() == Some("succeeded") {
                next.insert(account_id.clone(), json!(refresh_id));
            }
        }
        Ok(SyncResult {
            upserts,
            removals,
            next_cursor: json!({ "refreshIds": next }),
            has_more: false,
            account_statuses: Some(statuses),
            credentials: None,
            consent_expires_at: None,
        })
    }

    async fn stripe_balances(
        &self,
        stored: &StoredConnection,
    ) -> Result<Vec<FeedBalance>, FeedError> {
        let mut out = Vec::new();
        for id in Self::stripe_account_ids(stored) {
            let path = format!("/v1/financial_connections/accounts/{}", encode(&id));
            match self.stripe("GET", &path, Vec::new(), Vec::new()).await {
                Ok(account) => {
                    if let Some(balance) = stripe_balance(&account) {
                        out.push(balance);
                    }
                }
                Err(e) if e.kind == "reauth_required" || e.kind == "revoked" => {}
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }

    async fn stripe_refresh(&self, stored: &StoredConnection) -> Result<(), FeedError> {
        for id in Self::stripe_account_ids(stored) {
            let path = format!("/v1/financial_connections/accounts/{}/refresh", encode(&id));
            match self
                .stripe(
                    "POST",
                    &path,
                    vec![
                        pair("features[0]", "transactions"),
                        pair("features[1]", "balance"),
                    ],
                    Vec::new(),
                )
                .await
            {
                Ok(_) => {}
                Err(e) if e.kind != "auth" && e.kind != "transient" => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    async fn stripe_disconnect(&self, stored: &StoredConnection) -> Result<(), FeedError> {
        for id in Self::stripe_account_ids(stored) {
            let path = format!(
                "/v1/financial_connections/accounts/{}/disconnect",
                encode(&id)
            );
            match self.stripe("POST", &path, Vec::new(), Vec::new()).await {
                Ok(_) => {}
                Err(e) if matches!(e.kind, "permanent" | "reauth_required" | "revoked") => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

// ── Ponto ───────────────────────────────────────────────────────────────────

const PONTO_API: &str = "https://api.ibanity.com/ponto-connect";
/// A live application's authorization page.
const PONTO_AUTHORIZE_URL: &str = "https://authorization.myponto.com/oauth2/auth";
/// A sandbox application's authorization page (`PONTO_ENV=sandbox`).
const PONTO_SANDBOX_AUTHORIZE_URL: &str = "https://sandbox-authorization.myponto.com/oauth2/auth";
/// Account information, and a refresh token (`offline_access`) so the link
/// outlives its first, 30-minute access token.
const PONTO_SCOPE: &str = "ai offline_access";
/// What "sync now" asks Ponto to fetch from the bank, per account.
const PONTO_REFRESH_SUBTYPES: [&str; 2] = ["accountDetails", "accountTransactions"];
/// The waits between looks at the synchronizations a refresh started, 15
/// seconds in all.
pub const PONTO_REFRESH_POLL_MS: [u64; 7] = [500, 1000, 1500, 2000, 3000, 3000, 4000];
/// Ponto's resource endpoints answer JSON:API.
const JSON_API: &str = "application/vnd.api+json";

/// The accounts a connection reads: the mapped ones, else every account the
/// link brought.
fn ponto_account_ids(stored: &StoredConnection) -> Vec<String> {
    stored
        .account_ids
        .clone()
        .unwrap_or_else(|| string_list(stored.metadata.get("accountIds")))
}

/// A synchronization that is done, well or not.
fn ponto_finished(synchronization: &Map<String, Value>) -> bool {
    matches!(
        st(rec(synchronization.get("attributes")).get("status")).as_deref(),
        Some("success" | "error")
    )
}

/// What an account's latest synchronization says about its bank
/// authorization: expired, invalid or revoked at the bank all need the
/// customer in Ponto (a reconnect). A technical failure is Ponto's to retry.
fn ponto_authorization_problem(account: &Map<String, Value>) -> bool {
    let latest = rec(rec(account.get("meta")).get("latestSynchronization"));
    arr(rec(latest.get("attributes")).get("errors"))
        .iter()
        .any(|error| {
            matches!(
                st(rec(Some(error)).get("code")).as_deref(),
                Some("authorizationExpired" | "authorizationInvalid" | "authorizationRevoked")
            )
        })
}

fn map_ponto_error(status: u16, body: &Map<String, Value>) -> Option<FeedError> {
    let first = rec(arr(body.get("errors")).first());
    let code = st(first.get("code")).or_else(|| st(body.get("error")));
    let detail = st(first.get("detail")).or_else(|| st(body.get("error_description")));
    let message = format!(
        "Ponto{}{}",
        code.as_ref().map(|c| format!(" {c}")).unwrap_or_default(),
        detail.map(|d| format!(": {d}")).unwrap_or_default()
    );
    let kind = match code.as_deref() {
        Some("invalid_grant" | "invalid_token" | "accessDenied") => "reauth_required",
        Some("authorizationRevoked") => "revoked",
        _ => return None,
    };
    Some(FeedError {
        status: Some(status),
        code,
        ..FeedError::new("ponto", kind, message)
    })
}

fn ponto_tokens(credentials: &Value) -> Result<Value, FeedError> {
    let access = st(credentials.get("accessToken")).filter(|t| !t.is_empty());
    let refresh = st(credentials.get("refreshToken")).filter(|t| !t.is_empty());
    match (access, refresh) {
        (Some(access), Some(refresh)) => Ok(json!({
            "accessToken": access,
            "refreshToken": refresh,
            "expiresAt": st(credentials.get("expiresAt")).unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned()),
        })),
        _ => Err(FeedError::new(
            "ponto",
            "reauth_required",
            "Ponto connection has no tokens",
        )),
    }
}

fn ponto_balance(raw: &Map<String, Value>) -> Option<FeedBalance> {
    let account_id = st(raw.get("id"))?;
    let attributes = rec(raw.get("attributes"));
    let current = num(attributes.get("currentBalance"))?;
    let currency = st(attributes.get("currency"))
        .unwrap_or_else(|| "EUR".to_owned())
        .to_uppercase();
    Some(FeedBalance {
        account_id,
        current: decimal_to_minor(current, &currency).ok()?,
        currency,
        // When Ponto last synchronized the account (`meta`; read from the
        // attributes too, where older answers had it).
        as_of: st(rec(raw.get("meta")).get("synchronizedAt"))
            .or_else(|| st(attributes.get("synchronizedAt")))
            .unwrap_or_else(now_iso),
    })
}

fn ponto_transaction(raw: &Map<String, Value>, account_id: &str) -> Option<FeedTransaction> {
    let id = st(raw.get("id"))?;
    let attributes = rec(raw.get("attributes"));
    let amount = num(attributes.get("amount"))?;
    let when = st(attributes.get("executionDate"))
        .or_else(|| st(attributes.get("valueDate")))
        .filter(|w| !w.is_empty())?;
    let currency = st(attributes.get("currency"))
        .unwrap_or_else(|| "EUR".to_owned())
        .to_uppercase();
    Some(FeedTransaction {
        provider_transaction_id: id,
        pending_transaction_id: None,
        account_id: account_id.to_owned(),
        date: normalize_date(&Value::String(when)).ok()?,
        amount_minor: decimal_to_minor(amount, &currency).ok()?,
        currency,
        description: st(attributes.get("remittanceInformation"))
            .or_else(|| st(attributes.get("description")))
            .or_else(|| st(attributes.get("counterpartName")))
            .unwrap_or_default(),
        merchant_name: st(attributes.get("counterpartName")),
        check_number: None,
        category: None,
        pending: false,
        raw: Value::Object(raw.clone()),
    })
}

fn base64url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

impl Provider<'_> {
    fn ponto_config(&self) -> &PontoConfig {
        self.config.ponto.as_ref().expect("ponto is configured")
    }

    fn ponto_client(&self) -> Option<&OutboundHttp> {
        self.ponto_http.or(self.http)
    }

    fn ponto_basic(&self) -> String {
        let config = self.ponto_config();
        format!(
            "Basic {}",
            weldsuite_kit::cursor::btoa(&format!("{}:{}", config.client_id, config.client_secret))
                .unwrap_or_default()
        )
    }

    /// One call to Ponto's API, signed when the server has a signature
    /// certificate (a live application must sign; the sandbox need not).
    async fn ponto_request(
        &self,
        method: Option<&str>,
        url: &str,
        headers: Vec<(String, String)>,
        body: Body,
    ) -> Result<Map<String, Value>, FeedError> {
        let mut request = build_request(method, url, headers, body);
        if let Some(signature) = &self.ponto_config().signature {
            sign_request(&mut request, signature, crate::http::now_ms() / 1000)?;
        }
        send_json(self.ponto_client(), "ponto", request, Some(map_ponto_error)).await
    }

    async fn ponto_token_request(
        &self,
        form: Vec<(String, String)>,
    ) -> Result<Map<String, Value>, FeedError> {
        self.ponto_request(
            Some("POST"),
            &format!("{PONTO_API}/oauth2/token"),
            vec![pair("Authorization", self.ponto_basic())],
            Body::Form(form),
        )
        .await
    }

    fn ponto_to_tokens(response: &Map<String, Value>) -> Result<Value, FeedError> {
        let access = st(response.get("access_token")).filter(|t| !t.is_empty());
        let refresh = st(response.get("refresh_token")).filter(|t| !t.is_empty());
        let (Some(access), Some(refresh)) = (access, refresh) else {
            return Err(FeedError::new(
                "ponto",
                "permanent",
                "Ponto returned no tokens",
            ));
        };
        let expires_in = num(response.get("expires_in")).unwrap_or(1800.0);
        #[allow(clippy::cast_possible_truncation)]
        let expires = crate::http::now_ms() + (expires_in * 1000.0) as i64;
        Ok(json!({
            "accessToken": access,
            "refreshToken": refresh,
            "expiresAt": iso_from_millis(expires).unwrap_or_default(),
        }))
    }

    /// `ensureTokens`: a usable access token, refreshed when about to expire.
    async fn ponto_ensure(&self, stored: &StoredConnection) -> Result<(Value, bool), FeedError> {
        if let Some(cached) = self
            .refreshed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&stored.provider_connection_id)
        {
            return Ok((cached.clone(), true));
        }
        let tokens = ponto_tokens(&stored.credentials)?;
        let expires = tokens["expiresAt"]
            .as_str()
            .and_then(crate::js::millis_of)
            .unwrap_or(0);
        if expires - crate::http::now_ms() > 60_000 {
            return Ok((tokens, false));
        }
        let next = Self::ponto_to_tokens(
            &self
                .ponto_token_request(vec![
                    pair("grant_type", "refresh_token"),
                    pair(
                        "refresh_token",
                        tokens["refreshToken"].as_str().unwrap_or_default(),
                    ),
                ])
                .await?,
        )?;
        self.refreshed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(stored.provider_connection_id.clone(), next.clone());
        Ok((next, true))
    }

    async fn ponto_get(&self, url: &str, access: &str) -> Result<Map<String, Value>, FeedError> {
        self.ponto_request(
            None,
            url,
            vec![
                pair("Accept", JSON_API),
                pair("Authorization", format!("Bearer {access}")),
            ],
            Body::None,
        )
        .await
    }

    /// One account as Ponto has it; None when it left the integration
    /// (removed in Ponto).
    async fn ponto_account_details(
        &self,
        account_id: &str,
        access: &str,
    ) -> Result<Option<Map<String, Value>>, FeedError> {
        match self
            .ponto_get(
                &format!("{PONTO_API}/accounts/{}", encode(account_id)),
                access,
            )
            .await
        {
            Ok(response) => Ok(Some(rec(response.get("data")))),
            Err(error) if error.status == Some(404) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// The PKCE verifier derived from the state (HMAC of the client secret).
    fn ponto_verifier(&self, state: &str) -> String {
        use hmac::{Hmac, KeyInit, Mac};
        let mut mac = <Hmac<sha2::Sha256> as KeyInit>::new_from_slice(
            self.ponto_config().client_secret.as_bytes(),
        )
        .expect("any key length");
        mac.update(format!("ponto-pkce|{state}").as_bytes());
        base64url(&mac.finalize().into_bytes())
    }

    fn ponto_link(&self, input: &LinkInput) -> Value {
        use sha2::Digest as _;
        let mut random = [0u8; 24];
        getrandom::fill(&mut random).expect("the operating system has a random source");
        let state = base64url(&random);
        let verifier = self.ponto_verifier(&state);
        let challenge = base64url(&sha2::Sha256::digest(verifier.as_bytes()));
        let authorize = if self.ponto_config().sandbox {
            PONTO_SANDBOX_AUTHORIZE_URL
        } else {
            PONTO_AUTHORIZE_URL
        };
        let url = format!(
            "{authorize}{}",
            query_string(&[
                pair("client_id", self.ponto_config().client_id.clone()),
                pair("redirect_uri", input.redirect_url.clone()),
                pair("response_type", "code"),
                pair("scope", PONTO_SCOPE),
                pair("state", state),
                pair("code_challenge", challenge),
                pair("code_challenge_method", "S256"),
            ])
        );
        json!({
            "kind": "redirect",
            "url": url,
            "expiresAt": iso_from_millis(crate::http::now_ms() + 600_000),
        })
    }

    async fn ponto_raw_accounts(&self, access: &str) -> Result<Vec<Map<String, Value>>, FeedError> {
        let mut out = Vec::new();
        let mut url = Some(format!(
            "{PONTO_API}/accounts{}",
            query_string(&[pair("page[limit]", "100")])
        ));
        for _ in 0..100 {
            let Some(current) = url.take() else { break };
            let response = self.ponto_get(&current, access).await?;
            out.extend(arr(response.get("data")).iter().map(|d| rec(Some(d))));
            url = st(rec(response.get("links")).get("next")).filter(|n| !n.is_empty());
        }
        Ok(out)
    }

    fn ponto_account(raw: &Map<String, Value>) -> Option<FeedAccount> {
        let id = st(raw.get("id"))?;
        let attributes = rec(raw.get("attributes"));
        let reference = st(attributes.get("reference"));
        let iban = (st(attributes.get("referenceType")).as_deref() == Some("IBAN"))
            .then(|| reference.clone())
            .flatten();
        let subtype = st(attributes.get("subtype"))
            .unwrap_or_else(|| "checking".to_owned())
            .to_lowercase();
        let institution_id = st(rec(
            rec(rec(raw.get("relationships")).get("financialInstitution")).get("data"),
        )
        .get("id"));
        Some(FeedAccount {
            provider_account_id: id,
            name: st(attributes.get("description"))
                .or_else(|| st(attributes.get("holderName")))
                .or_else(|| reference.clone())
                .unwrap_or_else(|| "Account".to_owned()),
            mask: reference.as_deref().map(|r| {
                let units: Vec<u16> = r.encode_utf16().collect();
                String::from_utf16_lossy(&units[units.len().saturating_sub(4)..])
            }),
            fingerprint: match &iban {
                Some(iban) => iban_fingerprint(iban),
                None => account_fingerprint(
                    institution_id.as_deref(),
                    reference.as_deref(),
                    Some(&subtype),
                ),
            },
            iban,
            kind: "depository".to_owned(),
            subtype: Some(subtype),
            currency: st(attributes.get("currency"))
                .unwrap_or_else(|| "EUR".to_owned())
                .to_uppercase(),
            institution_id,
            institution_name: None,
            status: None,
            balance: ponto_balance(raw),
        })
    }

    async fn ponto_complete(
        &self,
        payload: &Value,
    ) -> Result<(FeedConnection, Vec<FeedAccount>), FeedError> {
        let input = rec(Some(payload));
        let code = st(input.get("code")).filter(|c| !c.is_empty());
        let state = st(input.get("state")).filter(|c| !c.is_empty());
        let redirect = st(input.get("redirectUrl")).filter(|c| !c.is_empty());
        let (Some(code), Some(state), Some(redirect)) = (code, state, redirect) else {
            return Err(FeedError::new(
                "ponto",
                "permanent",
                "Ponto authorization response incomplete",
            ));
        };
        let tokens = Self::ponto_to_tokens(
            &self
                .ponto_token_request(vec![
                    pair("grant_type", "authorization_code"),
                    pair("code", code),
                    pair("redirect_uri", redirect),
                    pair("client_id", self.ponto_config().client_id.clone()),
                    pair("code_verifier", self.ponto_verifier(&state)),
                ])
                .await?,
        )?;
        let access = tokens["accessToken"].as_str().unwrap_or_default();
        // The Ponto organization: every webhook names it, so it routes them
        // to this connection.
        let organization_id = self.ponto_organization_id(access).await;
        let raw_accounts = self.ponto_raw_accounts(access).await?;
        let mut accounts = Vec::new();
        let mut earliest: Option<String> = None;
        for raw in &raw_accounts {
            if let Some(mapped) = Self::ponto_account(raw) {
                accounts.push(mapped);
            }
            if let Some(expires) =
                st(rec(raw.get("attributes")).get("authorizationExpirationExpectedAt"))
                    .filter(|e| !e.is_empty())
                && earliest.as_ref().is_none_or(|e| expires < *e)
            {
                earliest = Some(expires);
            }
        }
        let existing = input
            .get("connection")
            .and_then(StoredConnection::from_value);
        let provider_connection_id = existing.as_ref().map_or_else(
            || uuid::Uuid::new_v4().to_string(),
            |c| c.provider_connection_id.clone(),
        );
        let mut metadata = Map::new();
        metadata.insert(
            "accountIds".to_owned(),
            json!(
                accounts
                    .iter()
                    .map(|a| a.provider_account_id.clone())
                    .collect::<Vec<_>>()
            ),
        );
        if let Some(organization_id) = &organization_id {
            metadata.insert("organizationId".to_owned(), json!(organization_id));
        }
        Ok((
            FeedConnection {
                provider: "ponto".to_owned(),
                // The connection's own id keeps its due syncs; the
                // organization's routes the webhooks.
                index_keys: organization_id
                    .map(|organization| vec![provider_connection_id.clone(), organization]),
                provider_connection_id,
                institution_id: None,
                institution_name: Some("Ponto".to_owned()),
                status: "active".to_owned(),
                credentials: tokens,
                cursor: existing.as_ref().map_or(Value::Null, |c| c.cursor.clone()),
                consent_expires_at: earliest,
                metadata: Some(Value::Object(metadata)),
            },
            accounts,
        ))
    }

    /// The organization the token is for (`/userinfo`'s `sub`); None when
    /// Ponto does not say, which only costs the webhooks.
    async fn ponto_organization_id(&self, access: &str) -> Option<String> {
        self.ponto_get(&format!("{PONTO_API}/userinfo"), access)
            .await
            .ok()
            .and_then(|response| st(response.get("sub")))
            .filter(|sub| !sub.is_empty())
    }

    async fn ponto_sync(
        &self,
        stored: &StoredConnection,
        cursor: &Value,
    ) -> Result<SyncResult, FeedError> {
        let (tokens, changed) = self.ponto_ensure(stored).await?;
        let access = tokens["accessToken"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let today: String = now_iso().chars().take(10).collect();
        let (from, to) = re_pull_window(
            st(rec(Some(cursor)).get("through")).as_deref(),
            &today,
            stored.history_days.unwrap_or(540).min(540),
        );
        let mut upserts = Vec::new();
        let mut statuses = Map::new();
        let mut consent: Option<String> = None;
        for account_id in ponto_account_ids(stored) {
            // The account first: whether Ponto can still reach the bank for
            // it, and until when.
            let details = self.ponto_account_details(&account_id, &access).await?;
            self.details
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(account_id.clone(), details.clone());
            let Some(details) = details else {
                // Taken out of the integration in Ponto: adding it back is a
                // reconnect.
                statuses.insert(account_id, json!("reauth_required"));
                continue;
            };
            if ponto_authorization_problem(&details) {
                statuses.insert(account_id.clone(), json!("reauth_required"));
            }
            if let Some(expires) =
                st(rec(details.get("attributes")).get("authorizationExpirationExpectedAt"))
                    .filter(|e| !e.is_empty())
                && consent.as_ref().is_none_or(|c| expires < *c)
            {
                consent = Some(expires);
            }
            let mut url = Some(format!(
                "{PONTO_API}/accounts/{}/transactions{}",
                encode(&account_id),
                query_string(&[pair("page[limit]", "100")])
            ));
            let mut reached = false;
            for _ in 0..100 {
                if reached {
                    break;
                }
                let Some(current) = url.take() else { break };
                let response = self.ponto_get(&current, &access).await?;
                let data = arr(response.get("data"));
                for raw in &data {
                    let Some(tx) = ponto_transaction(&rec(Some(raw)), &account_id) else {
                        continue;
                    };
                    if tx.date < from {
                        reached = true;
                        continue;
                    }
                    if tx.date <= to {
                        upserts.push(tx);
                    }
                }
                url = if data.is_empty() {
                    None
                } else {
                    st(rec(response.get("links")).get("next")).filter(|n| !n.is_empty())
                };
            }
        }
        Ok(SyncResult {
            upserts,
            next_cursor: json!({ "through": to }),
            account_statuses: Some(statuses),
            credentials: changed.then_some(tokens),
            consent_expires_at: consent,
            ..SyncResult::default()
        })
    }

    async fn ponto_balances(
        &self,
        stored: &StoredConnection,
    ) -> Result<Vec<FeedBalance>, FeedError> {
        let mut out = Vec::new();
        for account_id in ponto_account_ids(stored) {
            // The sync just read the account; otherwise ask for it.
            let cached = self
                .details
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&account_id);
            let raw = if let Some(raw) = cached {
                raw
            } else {
                let (tokens, _) = self.ponto_ensure(stored).await?;
                let access = tokens["accessToken"].as_str().unwrap_or_default();
                self.ponto_account_details(&account_id, access).await?
            };
            if let Some(balance) = raw.as_ref().and_then(ponto_balance) {
                out.push(balance);
            }
        }
        Ok(out)
    }

    /// "Sync now": ask Ponto to fetch the balance and transactions from the
    /// bank and wait for it, so the read that follows has them. Ponto allows
    /// this only with the customer present (their IP address), at most every
    /// five minutes and 50 times a day per account; without the address
    /// nothing is asked.
    async fn ponto_refresh(
        &self,
        stored: &StoredConnection,
        customer_ip: Option<&str>,
    ) -> Result<(), FeedError> {
        let Some(customer_ip) = customer_ip.map(str::trim).filter(|ip| !ip.is_empty()) else {
            return Ok(());
        };
        let (tokens, _) = self.ponto_ensure(stored).await?;
        let access = tokens["accessToken"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let mut started = Vec::new();
        let mut refused: Option<FeedError> = None;
        for account_id in ponto_account_ids(stored) {
            for subtype in PONTO_REFRESH_SUBTYPES {
                let attempt = self
                    .ponto_request(
                        Some("POST"),
                        &format!("{PONTO_API}/synchronizations"),
                        vec![
                            pair("Accept", JSON_API),
                            pair("Authorization", format!("Bearer {access}")),
                            pair("Content-Type", JSON_API),
                        ],
                        Body::Json(json!({ "data": { "type": "synchronization", "attributes": {
                            "resourceType": "account",
                            "resourceId": account_id,
                            "subtype": subtype,
                            "customerIpAddress": customer_ip,
                        } } })),
                    )
                    .await;
                match attempt {
                    Ok(response) => {
                        let synchronization = rec(response.get("data"));
                        if let Some(id) = st(synchronization.get("id"))
                            && !ponto_finished(&synchronization)
                        {
                            started.push(id);
                        }
                    }
                    // Too soon after the last one, or the day's limit: the
                    // read takes what Ponto has.
                    Err(error) if !matches!(error.kind, "reauth_required" | "revoked") => {
                        refused.get_or_insert(error);
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        self.ponto_wait_for(started.clone(), &access).await?;
        match refused {
            Some(error) if started.is_empty() => Err(error),
            _ => Ok(()),
        }
    }

    /// Poll the synchronizations until each is done, for 15 seconds at most.
    async fn ponto_wait_for(&self, ids: Vec<String>, access: &str) -> Result<(), FeedError> {
        let mut pending = ids;
        for wait in &self.poll_waits {
            if pending.is_empty() {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(*wait)).await;
            let mut still = Vec::new();
            for id in pending {
                let response = self
                    .ponto_get(
                        &format!("{PONTO_API}/synchronizations/{}", encode(&id)),
                        access,
                    )
                    .await?;
                if !ponto_finished(&rec(response.get("data"))) {
                    still.push(id);
                }
            }
            pending = still;
        }
        Ok(())
    }

    async fn ponto_disconnect(&self, stored: &StoredConnection) -> Result<(), FeedError> {
        let Ok(tokens) = ponto_tokens(&stored.credentials) else {
            return Ok(());
        };
        match self
            .ponto_request(
                Some("POST"),
                &format!("{PONTO_API}/oauth2/revoke"),
                vec![pair("Authorization", self.ponto_basic())],
                Body::Form(vec![pair(
                    "token",
                    tokens["refreshToken"].as_str().unwrap_or_default(),
                )]),
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(e) if matches!(e.kind, "reauth_required" | "revoked" | "permanent") => Ok(()),
            Err(e) => Err(e),
        }
    }
}

// ── Enable Banking ──────────────────────────────────────────────────────────

const ENABLE_API: &str = "https://api.enablebanking.com";

fn map_eb_error(status: u16, body: &Map<String, Value>) -> Option<FeedError> {
    let message = st(body.get("message"))
        .or_else(|| st(body.get("error")))
        .unwrap_or_default();
    let code = st(body.get("error")).or_else(|| st(body.get("code")));
    let text = format!(
        "Enable Banking{}{}",
        code.as_ref().map(|c| format!(" {c}")).unwrap_or_default(),
        if message.is_empty() {
            String::new()
        } else {
            format!(": {message}")
        }
    );
    let haystack = format!("{} {message}", code.as_deref().unwrap_or_default()).to_lowercase();
    let dead = ["session", "consent", "expired", "closed", "revoked"]
        .iter()
        .any(|w| haystack.contains(w));
    let kind = if dead && matches!(status, 401 | 403 | 422) {
        "reauth_required"
    } else if matches!(status, 401 | 403) {
        "auth"
    } else {
        return None;
    };
    Some(FeedError {
        status: Some(status),
        code,
        ..FeedError::new("enable_banking", kind, text)
    })
}

impl Provider<'_> {
    fn eb_jwt(&self) -> Result<String, FeedError> {
        let config = self
            .config
            .enable_banking
            .as_ref()
            .expect("enable banking is configured");
        let pem = config.private_key.replace("\\n", "\n");
        let key = jsonwebtoken::EncodingKey::from_rsa_pem(pem.as_bytes()).map_err(|e| {
            FeedError::new(
                "enable_banking",
                "auth",
                format!("Enable Banking key unreadable: {e}"),
            )
        })?;
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
        header.kid = Some(config.app_id.clone());
        header.typ = Some("JWT".to_owned());
        let iat = crate::http::now_ms() / 1000;
        let claims = json!({ "iss": "enablebanking.com", "aud": "api.enablebanking.com", "iat": iat, "exp": iat + 3600 });
        jsonwebtoken::encode(&header, &claims, &key).map_err(|e| {
            FeedError::new(
                "enable_banking",
                "auth",
                format!("Enable Banking signing failed: {e}"),
            )
        })
    }

    async fn eb_call(
        &self,
        method: &str,
        path: &str,
        query: Vec<(String, String)>,
        json_body: Option<Value>,
    ) -> Result<Map<String, Value>, FeedError> {
        let jwt = self.eb_jwt()?;
        request_json(
            self.http,
            "enable_banking",
            Some(method),
            &format!("{ENABLE_API}{path}{}", query_string(&query)),
            vec![pair("Authorization", format!("Bearer {jwt}"))],
            json_body.map_or(Body::None, Body::Json),
            Some(map_eb_error),
        )
        .await
    }

    async fn eb_consent_days(&self, name: &str, country: &str) -> i64 {
        let found = self
            .eb_call(
                "GET",
                "/aspsps",
                vec![pair("country", country.to_uppercase())],
                None,
            )
            .await
            .ok()
            .and_then(|response| {
                arr(response.get("aspsps")).into_iter().find(|a| {
                    st(rec(Some(a)).get("name"))
                        .is_some_and(|n| n.to_lowercase() == name.to_lowercase())
                })
            });
        let seconds = found.and_then(|a| num(rec(Some(&a)).get("maximum_consent_validity")));
        match seconds {
            #[allow(clippy::cast_possible_truncation)]
            Some(s) if s > 0.0 => ((s / 86_400.0).floor() as i64).clamp(1, 180),
            _ => 90,
        }
    }

    async fn eb_link(&self, input: &LinkInput) -> Result<Value, FeedError> {
        let Some(institution) = input.institution.as_ref() else {
            return Err(FeedError::new(
                "enable_banking",
                "permanent",
                "Enable Banking needs the bank chosen up front",
            ));
        };
        let name = st(institution.get("name")).unwrap_or_default();
        let country = st(institution.get("country")).unwrap_or_default();
        let days = self.eb_consent_days(&name, &country).await;
        let mut random = [0u8; 24];
        getrandom::fill(&mut random).expect("the operating system has a random source");
        let response = self
            .eb_call(
                "POST",
                "/auth",
                Vec::new(),
                Some(json!({
                    "access": { "valid_until": iso_from_millis(crate::http::now_ms() + days * 86_400_000) },
                    "aspsp": { "name": name, "country": country.to_uppercase() },
                    "state": base64url(&random),
                    "redirect_url": input.redirect_url,
                    "psu_type": input.psu_type.clone().unwrap_or_else(|| "business".to_owned()),
                })),
            )
            .await?;
        let Some(url) = st(response.get("url")).filter(|u| !u.is_empty()) else {
            return Err(FeedError::new(
                "enable_banking",
                "permanent",
                "Enable Banking returned no authorization URL",
            ));
        };
        let mut out = Map::new();
        out.insert("kind".to_owned(), json!("redirect"));
        out.insert("url".to_owned(), json!(url));
        if let Some(id) = st(response.get("authorization_id")).filter(|i| !i.is_empty()) {
            out.insert("sessionId".to_owned(), json!(id));
        }
        Ok(Value::Object(out))
    }

    async fn eb_complete(
        &self,
        payload: &Value,
    ) -> Result<(FeedConnection, Vec<FeedAccount>), FeedError> {
        let input = rec(Some(payload));
        let Some(code) = st(input.get("code")).filter(|c| !c.is_empty()) else {
            return Err(FeedError::new(
                "enable_banking",
                "permanent",
                "Enable Banking authorization code missing",
            ));
        };
        let session = self
            .eb_call(
                "POST",
                "/sessions",
                Vec::new(),
                Some(json!({ "code": code })),
            )
            .await?;
        let Some(session_id) = st(session.get("session_id")).filter(|s| !s.is_empty()) else {
            return Err(FeedError::new(
                "enable_banking",
                "permanent",
                "Enable Banking returned no session",
            ));
        };
        let aspsp = rec(session.get("aspsp"));
        let institution_name = st(aspsp.get("name"));
        let mut accounts = Vec::new();
        for raw in arr(session.get("accounts")) {
            let raw = rec(Some(&raw));
            let Some(uid) = st(raw.get("uid")) else {
                continue;
            };
            let iban = st(rec(raw.get("account_id")).get("iban"));
            let cash = st(raw.get("cash_account_type"));
            let subtype = match cash.as_deref() {
                Some("SVGS") => "savings",
                Some("CARD") => "credit_card",
                _ => "checking",
            };
            let identification = st(raw.get("identification_hash")).filter(|i| !i.is_empty());
            accounts.push(FeedAccount {
                provider_account_id: uid,
                name: st(raw.get("name"))
                    .or_else(|| st(raw.get("details")))
                    .or_else(|| iban.clone())
                    .unwrap_or_else(|| "Account".to_owned()),
                mask: iban.as_deref().map(|i| {
                    i.chars()
                        .rev()
                        .take(4)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect()
                }),
                fingerprint: match (&iban, &identification) {
                    (Some(iban), _) if !iban.is_empty() => iban_fingerprint(iban),
                    (_, Some(hash)) => sha256_hex(&format!("acct-eb|{hash}")),
                    _ => account_fingerprint(institution_name.as_deref(), None, Some(subtype)),
                },
                iban,
                kind: if cash.as_deref() == Some("CARD") {
                    "credit"
                } else {
                    "depository"
                }
                .to_owned(),
                subtype: Some(subtype.to_owned()),
                currency: st(raw.get("currency"))
                    .unwrap_or_else(|| "EUR".to_owned())
                    .to_uppercase(),
                institution_id: institution_name.clone(),
                institution_name: institution_name.clone(),
                status: None,
                balance: None,
            });
        }
        let existing = input
            .get("connection")
            .and_then(StoredConnection::from_value);
        Ok((
            FeedConnection {
                provider: "enable_banking".to_owned(),
                provider_connection_id: session_id.clone(),
                index_keys: None,
                institution_id: institution_name.clone(),
                institution_name,
                status: "active".to_owned(),
                credentials: json!({ "sessionId": session_id }),
                cursor: existing.as_ref().map_or(Value::Null, |c| c.cursor.clone()),
                consent_expires_at: st(rec(session.get("access")).get("valid_until")),
                metadata: Some(json!({
                    "accountIds": accounts.iter().map(|a| a.provider_account_id.clone()).collect::<Vec<_>>(),
                    "country": st(aspsp.get("country")),
                })),
            },
            accounts,
        ))
    }

    async fn eb_sync(
        &self,
        stored: &StoredConnection,
        cursor: &Value,
    ) -> Result<SyncResult, FeedError> {
        let today: String = now_iso().chars().take(10).collect();
        let (from, to) = re_pull_window(
            st(rec(Some(cursor)).get("through")).as_deref(),
            &today,
            stored.history_days.unwrap_or(730).min(730),
        );
        let mut upserts = Vec::new();
        let ids = stored
            .account_ids
            .clone()
            .unwrap_or_else(|| string_list(stored.metadata.get("accountIds")));
        for uid in ids {
            let mut continuation: Option<String> = None;
            for _ in 0..100 {
                let mut query = vec![
                    pair("date_from", from.clone()),
                    pair("date_to", to.clone()),
                    pair("transaction_status", "BOOK"),
                    pair("strategy", "longest"),
                ];
                if let Some(key) = &continuation {
                    query.push(pair("continuation_key", key.clone()));
                }
                let response = self
                    .eb_call(
                        "GET",
                        &format!("/accounts/{}/transactions", encode(&uid)),
                        query,
                        None,
                    )
                    .await?;
                let mut occurrences: HashMap<String, usize> = HashMap::new();
                for raw in arr(response.get("transactions")) {
                    if let Some(tx) = eb_transaction(&rec(Some(&raw)), &uid, &mut occurrences) {
                        upserts.push(tx);
                    }
                }
                continuation = st(response.get("continuation_key")).filter(|k| !k.is_empty());
                if continuation.is_none() {
                    break;
                }
            }
        }
        Ok(SyncResult {
            upserts,
            next_cursor: json!({ "through": to }),
            ..SyncResult::default()
        })
    }

    async fn eb_balances(&self, stored: &StoredConnection) -> Result<Vec<FeedBalance>, FeedError> {
        let mut out = Vec::new();
        let ids = stored
            .account_ids
            .clone()
            .unwrap_or_else(|| string_list(stored.metadata.get("accountIds")));
        for uid in ids {
            let response = self
                .eb_call(
                    "GET",
                    &format!("/accounts/{}/balances", encode(&uid)),
                    Vec::new(),
                    None,
                )
                .await?;
            let entries: Vec<Map<String, Value>> = arr(response.get("balances"))
                .iter()
                .map(|e| rec(Some(e)))
                .collect();
            let preferred = ["CLBD", "ITBD", "XPCD", "OPBD"].iter().find_map(|kind| {
                entries
                    .iter()
                    .find(|e| st(e.get("balance_type")).as_deref() == Some(*kind))
            });
            let Some(entry) = preferred.or_else(|| entries.first()) else {
                continue;
            };
            let amount = rec(entry.get("balance_amount"));
            let Some(value) = num(amount.get("amount")) else {
                continue;
            };
            let currency = st(amount.get("currency"))
                .unwrap_or_else(|| "EUR".to_owned())
                .to_uppercase();
            let Ok(minor) = decimal_to_minor(value, &currency) else {
                continue;
            };
            let debit = st(entry.get("credit_debit_indicator")).as_deref() == Some("DBIT");
            out.push(FeedBalance {
                account_id: uid,
                current: if debit {
                    if minor == 0 { 0 } else { -minor.abs() }
                } else {
                    minor
                },
                currency,
                as_of: st(entry.get("reference_date"))
                    .filter(|d| !d.is_empty())
                    .map_or_else(now_iso, |d| format!("{d}T00:00:00.000Z")),
            });
        }
        Ok(out)
    }

    async fn eb_disconnect(&self, stored: &StoredConnection) -> Result<(), FeedError> {
        let session = st(stored.credentials.get("sessionId"))
            .unwrap_or_else(|| stored.provider_connection_id.clone());
        match self
            .eb_call(
                "DELETE",
                &format!("/sessions/{}", encode(&session)),
                Vec::new(),
                None,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(e) if matches!(e.kind, "reauth_required" | "permanent") => Ok(()),
            Err(e) => Err(e),
        }
    }
}

fn eb_transaction(
    raw: &Map<String, Value>,
    uid: &str,
    occurrences: &mut HashMap<String, usize>,
) -> Option<FeedTransaction> {
    let amount = rec(raw.get("transaction_amount"));
    let value = num(amount.get("amount"))?;
    let when = st(raw.get("booking_date"))
        .or_else(|| st(raw.get("value_date")))
        .or_else(|| st(raw.get("transaction_date")))
        .filter(|w| !w.is_empty())?;
    let currency = st(amount.get("currency"))
        .unwrap_or_else(|| "EUR".to_owned())
        .to_uppercase();
    let minor = decimal_to_minor(value.abs(), &currency).ok()?;
    let debit = st(raw.get("credit_debit_indicator")).as_deref() == Some("DBIT");
    let amount_minor = if debit {
        if minor == 0 { 0 } else { -minor }
    } else {
        minor
    };
    let remittance = arr(raw.get("remittance_information"))
        .iter()
        .filter_map(|v| st(Some(v)))
        .collect::<Vec<_>>()
        .join(" ");
    let counterparty = st(rec(raw.get(if debit { "creditor" } else { "debtor" })).get("name"));
    let description = if remittance.is_empty() {
        st(raw.get("note"))
            .filter(|n| !n.is_empty())
            .or_else(|| counterparty.clone().filter(|c| !c.is_empty()))
            .unwrap_or_default()
    } else {
        remittance
    };
    let date = normalize_date(&Value::String(when)).ok()?;
    let id = st(raw.get("entry_reference"))
        .or_else(|| st(raw.get("transaction_id")))
        .filter(|i| !i.is_empty());
    let id = id.unwrap_or_else(|| {
        let key = format!("{date}|{amount_minor}|{description}");
        let occurrence = occurrences.get(&key).copied().unwrap_or(0);
        occurrences.insert(key.clone(), occurrence + 1);
        let hash = sha256_hex(&format!("{uid}|{key}|{occurrence}"));
        format!("eb_{}", &hash[..40])
    });
    Some(FeedTransaction {
        provider_transaction_id: id,
        pending_transaction_id: None,
        account_id: uid.to_owned(),
        date,
        amount_minor,
        currency,
        description,
        merchant_name: counterparty,
        check_number: None,
        category: None,
        pending: st(raw.get("status")).as_deref() == Some("PDNG"),
        raw: Value::Object(raw.clone()),
    })
}

#[cfg(test)]
mod ponto_signing_tests {
    use std::sync::Arc;

    use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpResponse, PortError};

    use super::*;
    use crate::bank_feeds::ponto_signature::tests::{test_key, verify};

    /// Ponto's API, as far as these calls read it; every request is kept.
    #[derive(Default)]
    struct FakePonto {
        requests: Mutex<Vec<HttpRequest>>,
    }

    impl DynOutboundHttp for FakePonto {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            Box::pin(async move {
                let path = request
                    .url
                    .trim_start_matches(PONTO_API)
                    .split('?')
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                self.requests.lock().expect("requests").push(request);
                let body = match path.as_str() {
                    "/oauth2/token" => {
                        json!({ "access_token": "at-2", "refresh_token": "rt-2", "expires_in": 1800 })
                    }
                    "/accounts/acc_1" => {
                        json!({ "data": { "id": "acc_1", "attributes": { "currentBalance": 12.5, "currency": "EUR" } } })
                    }
                    _ => json!({}),
                };
                Ok(HttpResponse::new(200, body.to_string().into_bytes()))
            })
        }
    }

    fn config(key: Option<&str>) -> FeedConfig {
        FeedConfig::from_env(|name| match name {
            "PONTO_CLIENT_ID" => Some("cid".to_owned()),
            "PONTO_CLIENT_SECRET" => Some("csecret".to_owned()),
            "PONTO_SIGNATURE_CERT_ID" => key.map(|_| "cert-1".to_owned()),
            "PONTO_SIGNATURE_KEY" => key.map(str::to_owned),
            _ => None,
        })
    }

    /// A connection whose access token has expired, so a refresh comes first.
    fn stored() -> StoredConnection {
        StoredConnection {
            provider: "ponto".to_owned(),
            provider_connection_id: "conn_1".to_owned(),
            credentials: json!({ "accessToken": "at-1", "refreshToken": "rt-1", "expiresAt": "2000-01-01T00:00:00.000Z" }),
            cursor: Value::Null,
            metadata: Map::new(),
            history_days: None,
            account_ids: Some(vec!["acc_1".to_owned()]),
        }
    }

    async fn calls(config: &FeedConfig) -> Vec<HttpRequest> {
        let fake = Arc::new(FakePonto::default());
        let http = OutboundHttp(Arc::clone(&fake) as Arc<dyn DynOutboundHttp>);
        let provider = Provider::create("ponto", config, None, Some(&http)).expect("ponto");
        let balances = provider.get_balances(&stored()).await.expect("balances");
        assert_eq!(balances.len(), 1);
        provider
            .refresh(&stored(), Some("203.0.113.9"))
            .await
            .expect("refresh");
        provider.disconnect(&stored()).await.expect("disconnect");
        let requests = fake.requests.lock().expect("requests").clone();
        let paths: Vec<String> = requests
            .iter()
            .map(|r| format!("{} {}", r.method, r.url.trim_start_matches(PONTO_API)))
            .collect();
        assert_eq!(
            paths,
            [
                "POST /oauth2/token",
                "GET /accounts/acc_1",
                "POST /synchronizations",
                "POST /synchronizations",
                "POST /oauth2/revoke"
            ]
        );
        requests
    }

    #[tokio::test]
    async fn with_a_signature_certificate_every_call_is_signed() {
        let (pem, public_key) = test_key();
        let now = crate::http::now_ms() / 1000;
        for request in calls(&config(Some(&pem))).await {
            let (key_id, created) = verify(&request, &public_key);
            assert_eq!(key_id, "cert-1");
            assert!((created - now).abs() <= 60, "created is the current time");
        }
    }

    #[tokio::test]
    async fn without_one_calls_go_unsigned_as_the_sandbox_takes_them() {
        for request in calls(&config(None)).await {
            assert!(
                !request
                    .headers
                    .iter()
                    .any(|(name, _)| name == "Signature" || name == "Digest")
            );
        }
    }

    #[test]
    fn half_a_signature_configuration_signs_nothing() {
        let config = FeedConfig::from_env(|name| match name {
            "PONTO_CLIENT_ID" => Some("cid".to_owned()),
            "PONTO_CLIENT_SECRET" => Some("csecret".to_owned()),
            "PONTO_SIGNATURE_CERT_ID" => Some("cert-1".to_owned()),
            "PONTO_SIGNATURE_KEY" => Some(String::new()),
            _ => None,
        });
        assert!(config.ponto.expect("ponto").signature.is_none());
    }
}

#[cfg(test)]
mod ponto_tests {
    use std::sync::Arc;

    use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpResponse, PortError};

    use super::*;

    type Respond = Box<dyn Fn(&str, &str, &Value) -> (u16, Value) + Send + Sync>;

    /// Ponto's API answering through `respond(method, path, body)`; every
    /// request is kept.
    struct FakePonto {
        requests: Mutex<Vec<HttpRequest>>,
        respond: Respond,
    }

    impl DynOutboundHttp for FakePonto {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            Box::pin(async move {
                let path = request
                    .url
                    .trim_start_matches(PONTO_API)
                    .split('?')
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                let body = request
                    .body
                    .as_deref()
                    .and_then(|b| serde_json::from_slice(b).ok())
                    .unwrap_or(Value::Null);
                let (status, answer) = (self.respond)(&request.method, &path, &body);
                self.requests.lock().expect("requests").push(request);
                Ok(HttpResponse::new(status, answer.to_string().into_bytes()))
            })
        }
    }

    fn fake(
        respond: impl Fn(&str, &str, &Value) -> (u16, Value) + Send + Sync + 'static,
    ) -> Arc<FakePonto> {
        Arc::new(FakePonto {
            requests: Mutex::default(),
            respond: Box::new(respond),
        })
    }

    fn config(env: &'static str) -> FeedConfig {
        FeedConfig::from_env(|name| match name {
            "PONTO_CLIENT_ID" => Some("cid".to_owned()),
            "PONTO_CLIENT_SECRET" => Some("csecret".to_owned()),
            "PONTO_ENV" => Some(env.to_owned()),
            _ => None,
        })
    }

    fn stored(expires_at: &str, account_ids: &[&str]) -> StoredConnection {
        StoredConnection {
            provider: "ponto".to_owned(),
            provider_connection_id: "conn_1".to_owned(),
            credentials: json!({ "accessToken": "at-1", "refreshToken": "rt-1", "expiresAt": expires_at }),
            cursor: Value::Null,
            metadata: Map::new(),
            history_days: Some(90),
            account_ids: Some(account_ids.iter().map(|id| (*id).to_owned()).collect()),
        }
    }

    const FRESH: &str = "2999-01-01T00:00:00.000Z";
    const EXPIRED: &str = "2000-01-01T00:00:00.000Z";

    fn account(id: &str, extra: Value) -> Value {
        let mut account = json!({
            "type": "account",
            "id": id,
            "attributes": {
                "reference": "BE68539007547034", "referenceType": "IBAN", "currency": "EUR",
                "subtype": "checking", "currentBalance": 1500.5,
                "authorizationExpirationExpectedAt": "2027-04-01T00:00:00Z",
            },
        });
        if let (Some(target), Value::Object(extra)) = (account.as_object_mut(), extra) {
            target.extend(extra);
        }
        account
    }

    fn paths(fake: &FakePonto) -> Vec<String> {
        fake.requests
            .lock()
            .expect("requests")
            .iter()
            .map(|r| {
                format!(
                    "{} {}",
                    r.method,
                    r.url
                        .trim_start_matches(PONTO_API)
                        .split('?')
                        .next()
                        .unwrap_or_default()
                )
            })
            .collect()
    }

    fn provider<'a>(config: &'a FeedConfig, http: &'a OutboundHttp) -> Provider<'a> {
        let mut provider = Provider::create("ponto", config, None, Some(http)).expect("ponto");
        provider.poll_waits = vec![0; PONTO_REFRESH_POLL_MS.len()];
        provider
    }

    #[tokio::test]
    async fn the_link_asks_for_a_refresh_token_on_the_live_or_the_sandbox_page() {
        for (env, page) in [
            ("live", PONTO_AUTHORIZE_URL),
            ("sandbox", PONTO_SANDBOX_AUTHORIZE_URL),
        ] {
            let config = config(env);
            let http = OutboundHttp(fake(|_, _, _| (200, json!({}))) as Arc<dyn DynOutboundHttp>);
            let session = provider(&config, &http)
                .create_link_session(&LinkInput {
                    redirect_url: "https://app.example/cb".to_owned(),
                    ..LinkInput::default()
                })
                .await
                .expect("session");
            let url = url::Url::parse(session["url"].as_str().expect("url")).expect("a URL");
            assert_eq!(
                format!("{}{}", url.origin().ascii_serialization(), url.path()),
                page
            );
            let scope = url
                .query_pairs()
                .find(|(k, _)| k == "scope")
                .map(|(_, v)| v.into_owned());
            assert_eq!(scope.as_deref(), Some("ai offline_access"));
        }
    }

    #[tokio::test]
    async fn a_sync_reads_each_account_first_its_consent_end_and_its_authorization() {
        let lapsed = json!({ "meta": { "latestSynchronization": { "attributes": {
            "status": "error", "errors": [{ "code": "authorizationExpired" }] } } } });
        let fake = fake(move |_, path, _| match path {
            "/accounts/acc_1" => (
                200,
                json!({ "data": account("acc_1", json!({ "meta": { "synchronizedAt": "2026-10-09T06:00:00Z" } })) }),
            ),
            "/accounts/acc_2" => (200, json!({ "data": account("acc_2", lapsed.clone()) })),
            "/accounts/acc_3" => (404, json!({ "errors": [{ "code": "resourceNotFound" }] })),
            "/accounts/acc_1/transactions" | "/accounts/acc_2/transactions" => {
                (200, json!({ "data": [], "links": {} }))
            }
            _ => (500, json!({})),
        });
        let config = config("live");
        let http = OutboundHttp(Arc::clone(&fake) as Arc<dyn DynOutboundHttp>);
        let provider = provider(&config, &http);
        let stored = stored(FRESH, &["acc_1", "acc_2", "acc_3"]);

        let result = provider
            .sync_transactions(&stored, &Value::Null)
            .await
            .expect("sync");
        assert_eq!(
            result.account_statuses,
            Some(
                serde_json::from_value(
                    json!({ "acc_2": "reauth_required", "acc_3": "reauth_required" })
                )
                .expect("map")
            )
        );
        assert_eq!(
            result.consent_expires_at.as_deref(),
            Some("2027-04-01T00:00:00Z")
        );
        // The balances reuse those reads.
        let balances = provider.get_balances(&stored).await.expect("balances");
        assert_eq!(balances.len(), 2);
        assert_eq!(balances[0].as_of, "2026-10-09T06:00:00Z");
        assert_eq!(
            paths(&fake),
            [
                "GET /accounts/acc_1",
                "GET /accounts/acc_1/transactions",
                "GET /accounts/acc_2",
                "GET /accounts/acc_2/transactions",
                "GET /accounts/acc_3",
            ]
        );
        let accept = fake.requests.lock().expect("requests")[0]
            .headers
            .iter()
            .filter(|(name, _)| name == "Accept")
            .map(|(_, value)| value.clone())
            .collect::<Vec<_>>();
        assert_eq!(accept, ["application/vnd.api+json"]);
    }

    #[tokio::test]
    async fn rotated_tokens_stay_with_the_provider_when_the_sync_fails_after_the_refresh() {
        let fake = fake(|_, path, _| match path {
            "/oauth2/token" => (
                200,
                json!({ "access_token": "at-2", "refresh_token": "rt-2", "expires_in": 1800 }),
            ),
            _ => (503, json!({})),
        });
        let config = config("live");
        let http = OutboundHttp(Arc::clone(&fake) as Arc<dyn DynOutboundHttp>);
        let provider = provider(&config, &http);
        let error = provider
            .sync_transactions(&stored(EXPIRED, &["acc_1"]), &Value::Null)
            .await
            .expect_err("Ponto is down");
        assert_eq!(error.kind, "transient");
        let pending = provider
            .pending_credentials("conn_1")
            .expect("rotated tokens");
        assert_eq!(
            (
                pending["accessToken"].as_str(),
                pending["refreshToken"].as_str()
            ),
            (Some("at-2"), Some("rt-2"))
        );
        assert!(provider.pending_credentials("conn_other").is_none());
    }

    #[tokio::test]
    async fn a_refresh_needs_the_customer_and_waits_for_its_synchronizations() {
        let looks = Arc::new(Mutex::new(0));
        let counted = Arc::clone(&looks);
        let fake = fake(move |method, path, body| match (method, path) {
            ("POST", "/synchronizations") => {
                let subtype = body["data"]["attributes"]["subtype"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                (
                    200,
                    json!({ "data": { "id": format!("sync_{subtype}"), "attributes": { "status": "pending" } } }),
                )
            }
            ("GET", "/synchronizations/sync_accountDetails") => (
                200,
                json!({ "data": { "attributes": { "status": "success" } } }),
            ),
            ("GET", "/synchronizations/sync_accountTransactions") => {
                let mut looks = counted.lock().expect("looks");
                *looks += 1;
                let status = if *looks < 2 { "running" } else { "success" };
                (
                    200,
                    json!({ "data": { "attributes": { "status": status } } }),
                )
            }
            _ => (500, json!({})),
        });
        let config = config("live");
        let http = OutboundHttp(Arc::clone(&fake) as Arc<dyn DynOutboundHttp>);
        let provider = provider(&config, &http);
        let connection = stored(FRESH, &["acc_1"]);

        // Without the member's address Ponto is not asked.
        provider.refresh(&connection, None).await.expect("nothing");
        provider
            .refresh(&connection, Some(" "))
            .await
            .expect("nothing");
        assert_eq!(paths(&fake), Vec::<String>::new());

        provider
            .refresh(&connection, Some("203.0.113.9"))
            .await
            .expect("refresh");
        let requests = fake.requests.lock().expect("requests").clone();
        let asked: Vec<Value> = requests
            .iter()
            .filter(|r| r.method == "POST")
            .map(|r| {
                serde_json::from_slice::<Value>(r.body.as_deref().unwrap_or_default())
                    .expect("json")["data"]["attributes"]
                    .clone()
            })
            .collect();
        assert_eq!(
            asked,
            [
                json!({ "resourceType": "account", "resourceId": "acc_1", "subtype": "accountDetails", "customerIpAddress": "203.0.113.9" }),
                json!({ "resourceType": "account", "resourceId": "acc_1", "subtype": "accountTransactions", "customerIpAddress": "203.0.113.9" }),
            ]
        );
        assert_eq!(
            paths(&fake)[2..],
            [
                "GET /synchronizations/sync_accountDetails",
                "GET /synchronizations/sync_accountTransactions",
                "GET /synchronizations/sync_accountTransactions",
            ]
        );
    }

    #[tokio::test]
    async fn a_link_reads_the_organization_and_is_indexed_by_it_for_the_webhooks() {
        let fake = fake(|_, path, _| match path {
            "/oauth2/token" => (
                200,
                json!({ "access_token": "at-1", "refresh_token": "rt-1", "expires_in": 1800 }),
            ),
            "/userinfo" => (200, json!({ "sub": "org_ponto_1" })),
            "/accounts" => (
                200,
                json!({ "data": [account("acc_1", json!({}))], "links": {} }),
            ),
            _ => (500, json!({})),
        });
        let config = config("live");
        let http = OutboundHttp(Arc::clone(&fake) as Arc<dyn DynOutboundHttp>);
        let (connection, accounts) = provider(&config, &http)
            .complete_link(
                &json!({ "code": "c", "state": "s", "redirectUrl": "https://app.example/cb" }),
            )
            .await
            .expect("linked");
        assert_eq!(accounts.len(), 1);
        assert_eq!(
            connection.index_keys,
            Some(vec![
                connection.provider_connection_id.clone(),
                "org_ponto_1".to_owned()
            ])
        );
        assert_eq!(
            connection.metadata,
            Some(json!({ "accountIds": ["acc_1"], "organizationId": "org_ponto_1" }))
        );
        assert_eq!(
            paths(&fake),
            ["POST /oauth2/token", "GET /userinfo", "GET /accounts"]
        );

        // Webhooks only with the application id their signatures name.
        assert_eq!(capabilities("ponto", &config)["webhooks"], json!(false));
        let with_id = FeedConfig::from_env(|name| match name {
            "PONTO_CLIENT_ID" => Some("cid".to_owned()),
            "PONTO_CLIENT_SECRET" => Some("csecret".to_owned()),
            "PONTO_APPLICATION_ID" => Some("app-1".to_owned()),
            _ => None,
        });
        assert_eq!(capabilities("ponto", &with_id)["webhooks"], json!(true));
    }

    #[tokio::test]
    async fn a_refused_refresh_fails_only_when_nothing_started() {
        let fake = fake(|_, _, _| {
            (
                400,
                json!({ "errors": [{ "code": "accountRecentlySynchronized" }] }),
            )
        });
        let config = config("live");
        let http = OutboundHttp(Arc::clone(&fake) as Arc<dyn DynOutboundHttp>);
        let error = provider(&config, &http)
            .refresh(&stored(FRESH, &["acc_1"]), Some("203.0.113.9"))
            .await
            .expect_err("too soon");
        assert_eq!((error.kind, error.status), ("permanent", Some(400)));
    }
}
