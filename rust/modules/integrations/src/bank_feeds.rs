//! `POST /webhooks/bank-feeds/:provider` (integration-webhook-worker's
//! `bank-feeds/webhook.ts`, the verification of `@weldsuite/bank-feeds`'
//! `webhook.ts` and each provider's `parseWebhook`).
//!
//! Public (no session): each provider signs its deliveries its own way, and
//! a bad signature is a 401. Stripe Financial Connections: HMAC-SHA256 in
//! `Stripe-Signature` with the endpoint's `STRIPE_FC_WEBHOOK_SECRET`. Plaid:
//! an ES256 JWT in `Plaid-Verification` whose key is fetched from Plaid by
//! its `kid` and cached an hour. Ponto and Enable Banking have no
//! account-information webhooks (refused, 401). A verified delivery is
//! answered 200 straight away; the work (the master
//! `bank_feed_connection_index` lookup by the provider's connection id, then
//! WeldBooks' `/internal/bank-connections/events` over `BOOKS_INTERNAL`)
//! runs in the background, as in `waitUntil`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine as _;
use hmac::{KeyInit, Mac};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use weldsuite_books_domain::bank_feeds::{FeedConfig, providers::normalize_provider_id};
use weldsuite_db::PgPool;
use weldsuite_ports::{DynCache, HttpRequest, OutboundHttp};

use crate::binding::{BindingRequest, ServiceBinding};
use crate::{IntegrationsState, PublicCtx};

pub const STRIPE_SIGNATURE_TOLERANCE_SECONDS: f64 = 300.0;
pub const PLAID_WEBHOOK_MAX_AGE_SECONDS: f64 = 300.0;
pub const PLAID_KEY_CACHE_TTL_SECONDS: u64 = 3600;

pub(crate) fn router<S>(state: IntegrationsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/webhooks/bank-feeds/{provider}", post(webhook))
        .with_state(state)
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// The providers a webhook can be for, once configured
/// (`createWebhookProvider`): Stripe FC needs no API key for this.
fn webhook_provider(id: &str, config: &FeedConfig) -> Option<&'static str> {
    match id {
        "stripe_fc" => Some("stripe_fc"),
        "plaid" => config.plaid.as_ref().map(|_| "plaid"),
        "ponto" => config.ponto.as_ref().map(|_| "ponto"),
        "enable_banking" => config.enable_banking.as_ref().map(|_| "enable_banking"),
        _ => None,
    }
}

async fn webhook(
    State(state): State<IntegrationsState>,
    Path(provider): Path<String>,
    ctx: PublicCtx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let provider_id = normalize_provider_id(&provider);
    let config = FeedConfig::from_env(|name| ctx.env(&state, name));
    let Some(provider) = webhook_provider(&provider_id, &config) else {
        // Unknown provider, or its credentials are not configured here.
        return error(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            "Unknown bank feed provider",
        );
    };
    let raw = String::from_utf8_lossy(&body).into_owned();
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let now = now_millis();
    let parsed = match provider {
        "stripe_fc" => {
            let secret = ctx
                .env(&state, "STRIPE_FC_WEBHOOK_SECRET")
                .filter(|s| !s.is_empty());
            match secret {
                Some(secret)
                    if verify_stripe_signature(&raw, header("stripe-signature"), &secret, now) =>
                {
                    Ok(serde_json::from_str::<Value>(&raw)
                        .map(|event| stripe_fc_events(&as_record(&event)))
                        .unwrap_or_default())
                }
                _ => Err("Invalid Stripe signature"),
            }
        }
        "plaid" => {
            let plaid = config.plaid.as_ref().expect("plaid is configured");
            let keys = PlaidKeys {
                base_url: if plaid.production {
                    "https://production.plaid.com"
                } else {
                    "https://sandbox.plaid.com"
                },
                client_id: &plaid.client_id,
                secret: &plaid.secret,
                cache: ctx.cache(&state),
                http: ctx.http(&state),
            };
            match verify_plaid_webhook(&raw, header("plaid-verification"), &keys, now).await {
                Ok(()) => Ok(serde_json::from_str::<Value>(&raw)
                    .map(|payload| plaid_events(&as_record(&payload)))
                    .unwrap_or_default()),
                Err(reason) => Err(reason),
            }
        }
        // Ponto and Enable Banking: polled, never pushed.
        _ => Err("webhooks are not enabled; connections are polled"),
    };
    let events = match parsed {
        Ok(events) => events,
        Err(reason) => {
            tracing::warn!("[BankFeedWebhook] rejected {provider} delivery: {reason}");
            return error(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Invalid signature",
            );
        }
    };

    if !events.is_empty() {
        let master = ctx.master(&state);
        let books = ctx.books(&state);
        let count = events.len();
        let events = events.clone();
        state.events.tracker().spawn(async move {
            let result =
                dispatch_bank_feed_events(provider, &events, master.as_ref(), books.as_deref())
                    .await;
            tracing::info!(
                "[BankFeedWebhook] {provider}: {count} events, forwarded {}, unknown {}, failed {}",
                result.forwarded,
                result.unknown,
                result.failed
            );
        });
    }
    (
        StatusCode::OK,
        Json(json!({ "received": true, "events": events.len() })),
    )
        .into_response()
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/// What a dispatch did (`dispatchBankFeedEvents`' result).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DispatchResult {
    pub forwarded: usize,
    pub unknown: usize,
    pub failed: usize,
}

/// The master index row for the id the provider's webhook carries.
async fn lookup(
    master: &PgPool,
    provider: &str,
    provider_connection_id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    sqlx::query_as::<_, (String, String)>(
        "select connection_id, clerk_org_id from bank_feed_connection_index \
         where provider = $1 and provider_connection_id = $2 limit 1",
    )
    .bind(provider)
    .bind(provider_connection_id)
    .fetch_optional(master)
    .await
}

/// Group events by the connection id the provider used and hand each group
/// to WeldBooks (`dispatchBankFeedEvents`).
pub async fn dispatch_bank_feed_events(
    provider: &str,
    events: &[Value],
    master: Option<&PgPool>,
    books: Option<&dyn ServiceBinding>,
) -> DispatchResult {
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for event in events {
        let id = event
            .get("providerConnectionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        match groups.iter_mut().find(|(key, _)| *key == id) {
            Some((_, group)) => group.push(event.clone()),
            None => groups.push((id, vec![event.clone()])),
        }
    }
    let mut result = DispatchResult::default();
    for (provider_connection_id, group) in groups {
        let outcome: Result<bool, String> = async {
            let master = master.ok_or("the master database is not configured")?;
            let hit = lookup(master, provider, &provider_connection_id)
                .await
                .map_err(|e| e.to_string())?;
            let Some((connection_id, clerk_org_id)) = hit else {
                tracing::warn!(
                    "[BankFeedWebhook] no connection for {provider}:{provider_connection_id}"
                );
                return Ok(false);
            };
            let books = books.ok_or("BOOKS_INTERNAL service binding is not configured")?;
            let body = json!({
                "connectionId": connection_id,
                "provider": provider,
                "providerConnectionId": provider_connection_id,
                "events": group,
            });
            let response = books
                .fetch(BindingRequest {
                    method: "POST".to_owned(),
                    path: "/internal/bank-connections/events".to_owned(),
                    workspace_key: clerk_org_id,
                    body: Some(body.to_string()),
                })
                .await?;
            if !response.ok() {
                return Err(format!("books-api answered {}", response.status));
            }
            Ok(true)
        }
        .await;
        match outcome {
            Ok(true) => result.forwarded += 1,
            Ok(false) => result.unknown += 1,
            Err(error) => {
                result.failed += 1;
                tracing::error!(
                    "[BankFeedWebhook] forward failed for {provider}:{provider_connection_id}: {error}"
                );
            }
        }
    }
    result
}

// ── Events ──────────────────────────────────────────────────────────────────

fn as_record(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// `asString`: a string, or a finite number as JavaScript prints it.
fn as_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Number(n)) => n
            .as_f64()
            .filter(|n| n.is_finite())
            .map(weldsuite_books_domain::js::number_text),
        _ => None,
    }
}

/// `asNumber`: a finite number, or a numeric string.
fn as_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64().filter(|n| n.is_finite()),
        Some(Value::String(text)) => js_numeric(text),
        _ => None,
    }
}

/// `typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))`.
fn js_numeric(text: &str) -> Option<f64> {
    if weldsuite_kit::validation::js_trim(text).is_empty() {
        return None;
    }
    Some(weldsuite_kit::validation::js_number(text)).filter(|n| n.is_finite())
}

/// `plaidEventsFromWebhook`: unknown deliveries map to nothing.
pub fn plaid_events(payload: &Map<String, Value>) -> Vec<Value> {
    let (Some(item_id), Some(kind), Some(code)) = (
        as_string(payload.get("item_id")).filter(|s| !s.is_empty()),
        as_string(payload.get("webhook_type")).filter(|s| !s.is_empty()),
        as_string(payload.get("webhook_code")).filter(|s| !s.is_empty()),
    ) else {
        return Vec::new();
    };
    match kind.as_str() {
        "TRANSACTIONS" => {
            let sync = [
                "SYNC_UPDATES_AVAILABLE",
                "INITIAL_UPDATE",
                "HISTORICAL_UPDATE",
                "DEFAULT_UPDATE",
                "TRANSACTIONS_REMOVED",
            ];
            if sync.contains(&code.as_str()) {
                vec![json!({ "type": "sync_available", "providerConnectionId": item_id })]
            } else {
                Vec::new()
            }
        }
        "ITEM" => {
            let error = payload.get("error").map(as_record).unwrap_or_default();
            match code.as_str() {
                "ERROR" => {
                    if as_string(error.get("error_code")).as_deref() == Some("ITEM_LOGIN_REQUIRED")
                    {
                        vec![json!({
                            "type": "reauth_required",
                            "providerConnectionId": item_id,
                            "message": as_string(error.get("error_message")),
                        })]
                    } else {
                        vec![json!({
                            "type": "error",
                            "providerConnectionId": item_id,
                            "message": as_string(error.get("error_code"))
                                .unwrap_or_else(|| "Plaid item error".to_owned()),
                        })]
                    }
                }
                "PENDING_EXPIRATION" | "PENDING_DISCONNECT" => vec![json!({
                    "type": "expiring",
                    "providerConnectionId": item_id,
                    "expiresAt": as_string(payload.get("consent_expiration_time")),
                })],
                "USER_PERMISSION_REVOKED" => {
                    vec![json!({ "type": "revoked", "providerConnectionId": item_id })]
                }
                "USER_ACCOUNT_REVOKED" => {
                    let mut event = Map::new();
                    event.insert("type".to_owned(), json!("disconnected"));
                    event.insert("providerConnectionId".to_owned(), json!(item_id));
                    if let Some(account) =
                        as_string(payload.get("account_id")).filter(|s| !s.is_empty())
                    {
                        event.insert("accountIds".to_owned(), json!([account]));
                    }
                    vec![Value::Object(event)]
                }
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}

/// `stripeFcEventsFromWebhook`: only `financial_connections.account.*`.
pub fn stripe_fc_events(event: &Map<String, Value>) -> Vec<Value> {
    let kind = as_string(event.get("type")).filter(|s| !s.is_empty());
    let account = event
        .get("data")
        .map(as_record)
        .unwrap_or_default()
        .get("object")
        .map(as_record)
        .unwrap_or_default();
    let account_id = as_string(account.get("id")).filter(|s| !s.is_empty());
    let (Some(kind), Some(account_id)) = (kind, account_id) else {
        return Vec::new();
    };
    if !kind.starts_with("financial_connections.account.") {
        return Vec::new();
    }
    let event = |kind: &str| {
        vec![json!({
            "type": kind,
            "providerConnectionId": account_id,
            "accountIds": [account_id],
        })]
    };
    match kind.as_str() {
        "financial_connections.account.refreshed_transactions" => {
            let refresh = account
                .get("transaction_refresh")
                .map(as_record)
                .unwrap_or_default();
            if as_string(refresh.get("status")).as_deref() == Some("succeeded") {
                event("sync_available")
            } else {
                Vec::new()
            }
        }
        // A relink makes the account active again; the next sync reads the status back.
        "financial_connections.account.reactivated" => event("sync_available"),
        "financial_connections.account.deactivated" => event("reauth_required"),
        "financial_connections.account.disconnected" => event("disconnected"),
        "financial_connections.account.upcoming_deactivation" => event("expiring"),
        _ => Vec::new(),
    }
}

// ── Verification ────────────────────────────────────────────────────────────

fn now_millis() -> f64 {
    #[allow(clippy::cast_precision_loss)]
    let millis = (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as f64;
    millis
}

/// Byte-wise equality without an early exit (`timingSafeEqual`).
fn timing_safe_equal(a: &str, b: &str) -> bool {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    let mut diff = x.len() ^ y.len();
    for i in 0..x.len().max(y.len()) {
        diff |= usize::from(x.get(i).copied().unwrap_or(0) ^ y.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

fn hmac_sha256_hex(secret: &str, message: &str) -> String {
    let mut mac =
        hmac::Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key");
    mac.update(message.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn sha256_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

/// `verifyStripeSignature`: HMAC-SHA256 of `${t}.${payload}`, any `v1`
/// candidate may match, the timestamp within five minutes of `now` (ms).
pub fn verify_stripe_signature(
    payload: &str,
    header: Option<&str>,
    secret: &str,
    now: f64,
) -> bool {
    let Some(header) = header.filter(|h| !h.is_empty()) else {
        return false;
    };
    if secret.is_empty() {
        return false;
    }
    let mut timestamp = None;
    let mut candidates = Vec::new();
    for part in header.split(',') {
        let mut pieces = weldsuite_kit::validation::js_trim(part).split('=');
        let name = pieces.next().unwrap_or_default();
        let value = pieces.collect::<Vec<_>>().join("=");
        if name == "t" {
            timestamp = js_numeric(&value);
        } else if name == "v1" && !value.is_empty() {
            candidates.push(value);
        }
    }
    let Some(timestamp) = timestamp else {
        return false;
    };
    if candidates.is_empty() {
        return false;
    }
    let now_seconds = (now / 1000.0).floor();
    if (now_seconds - timestamp).abs() > STRIPE_SIGNATURE_TOLERANCE_SECONDS {
        return false;
    }
    let expected = hmac_sha256_hex(
        secret,
        &format!(
            "{}.{payload}",
            weldsuite_books_domain::js::number_text(timestamp)
        ),
    );
    candidates.iter().fold(false, |ok, candidate| {
        timing_safe_equal(candidate, &expected) || ok
    })
}

/// `fromBase64Url`: padded and decoded as `atob` does (either alphabet).
fn from_base64_url(value: &str) -> Option<Vec<u8>> {
    let normalized: String = value
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );
    engine.decode(normalized.trim_end_matches('=')).ok()
}

/// `decodeJwtPart`: the part as a JSON object (`{}` for any other JSON
/// value); `None` when it is not JSON at all.
fn decode_jwt_part(part: &str) -> Option<Map<String, Value>> {
    let bytes = from_base64_url(part)?;
    let text = String::from_utf8_lossy(&bytes);
    serde_json::from_str::<Value>(&text)
        .ok()
        .map(|value| as_record(&value))
}

/// Where Plaid's verification keys come from: the cache, else
/// `/webhook_verification_key/get`.
pub struct PlaidKeys<'a> {
    pub base_url: &'a str,
    pub client_id: &'a str,
    pub secret: &'a str,
    pub cache: Option<Arc<dyn DynCache>>,
    pub http: Option<OutboundHttp>,
}

/// The process's key cache when the server has no shared cache
/// (`memoryKeyCache`).
fn memory_keys() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static KEYS: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    KEYS.get_or_init(Mutex::default)
}

impl PlaidKeys<'_> {
    async fn cached(&self, key: &str) -> Option<String> {
        match &self.cache {
            Some(cache) => cache.get_boxed(key).await.ok().flatten(),
            None => {
                let mut keys = memory_keys().lock().unwrap_or_else(PoisonError::into_inner);
                match keys.get(key) {
                    Some((value, expires)) if *expires > Instant::now() => Some(value.clone()),
                    Some(_) => {
                        keys.remove(key);
                        None
                    }
                    None => None,
                }
            }
        }
    }

    async fn store(&self, key: &str, value: &str) {
        let ttl = Duration::from_secs(PLAID_KEY_CACHE_TTL_SECONDS);
        match &self.cache {
            Some(cache) => {
                if let Err(error) = cache.put_boxed(key, value, Some(ttl)).await {
                    tracing::warn!(%error, "[BankFeedWebhook] Plaid key not cached");
                }
            }
            None => {
                memory_keys()
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(key.to_owned(), (value.to_owned(), Instant::now() + ttl));
            }
        }
    }

    /// `createPlaidKeyResolver(...)(kid)`: the JWK, cached or fetched.
    async fn resolve(&self, kid: &str) -> Result<Map<String, Value>, String> {
        let cache_key = format!("bank-feeds:plaid-wvk:{}:{kid}", self.base_url);
        if let Some(cached) = self.cached(&cache_key).await
            && let Ok(Value::Object(key)) = serde_json::from_str::<Value>(&cached)
        {
            return Ok(key);
        }
        let http = self
            .http
            .as_ref()
            .ok_or("plaid request failed: network error")?;
        let body = json!({ "client_id": self.client_id, "secret": self.secret, "key_id": kid });
        let request = HttpRequest {
            method: "POST".to_owned(),
            url: format!("{}/webhook_verification_key/get", self.base_url),
            headers: vec![
                ("Accept".to_owned(), "application/json".to_owned()),
                ("Content-Type".to_owned(), "application/json".to_owned()),
            ],
            body: Some(body.to_string().into_bytes()),
        };
        let response = http
            .send(request)
            .await
            .map_err(|error| format!("plaid request failed: {error}"))?;
        if !response.ok() {
            return Err(format!("plaid responded {}", response.status));
        }
        let parsed = response.json();
        let key = parsed.get("key").map(as_record).unwrap_or_default();
        let text = |name: &str| as_string(key.get(name));
        // `JSON.stringify(resolved)`: the keys in this order, undefined ones left out.
        let mut fields: Vec<(&str, Value)> = Vec::new();
        if let Some(alg) = text("alg") {
            fields.push(("alg", json!(alg)));
        }
        fields.push((
            "crv",
            json!(text("crv").unwrap_or_else(|| "P-256".to_owned())),
        ));
        fields.push(("kid", json!(text("kid").unwrap_or_else(|| kid.to_owned()))));
        fields.push(("kty", json!(text("kty").unwrap_or_else(|| "EC".to_owned()))));
        if let Some(usage) = text("use") {
            fields.push(("use", json!(usage)));
        }
        fields.push(("x", json!(text("x").unwrap_or_default())));
        fields.push(("y", json!(text("y").unwrap_or_default())));
        if let Some(created) = as_number(key.get("created_at")) {
            fields.push(("created_at", js_number_value(created)));
        }
        fields.push((
            "expired_at",
            as_number(key.get("expired_at")).map_or(Value::Null, js_number_value),
        ));
        let serialized = format!(
            "{{{}}}",
            fields
                .iter()
                .map(|(name, value)| format!("{}:{value}", json!(name)))
                .collect::<Vec<_>>()
                .join(",")
        );
        self.store(&cache_key, &serialized).await;
        Ok(fields
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect())
    }
}

/// A number as JSON prints it from JavaScript (integers without `.0`).
fn js_number_value(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9.007_199_254_740_992e15 {
        json!(number as i64)
    } else {
        json!(number)
    }
}

/// The ES256 signature over `signing_input` with the JWK's point.
fn es256_valid(jwk: &Map<String, Value>, signing_input: &str, signature: &str) -> bool {
    let text = |name: &str| jwk.get(name).and_then(Value::as_str);
    if text("kty") != Some("EC") || text("crv") != Some("P-256") {
        return false;
    }
    let (Some(x), Some(y), Some(signature)) = (
        text("x").and_then(from_base64_url),
        text("y").and_then(from_base64_url),
        from_base64_url(signature),
    ) else {
        return false;
    };
    if x.len() != 32 || y.len() != 32 {
        return false;
    }
    let mut point = Vec::with_capacity(65);
    point.push(0x04);
    point.extend_from_slice(&x);
    point.extend_from_slice(&y);
    aws_lc_rs::signature::UnparsedPublicKey::new(
        &aws_lc_rs::signature::ECDSA_P256_SHA256_FIXED,
        point,
    )
    .verify(signing_input.as_bytes(), &signature)
    .is_ok()
}

/// `verifyPlaidWebhook`: an ES256 JWT, its key by `kid`, `iat` at most five
/// minutes away from `now` (ms), and `request_body_sha256` the body's hash.
/// `Err` carries why it failed (logged only: every failure is a 401).
pub async fn verify_plaid_webhook(
    body: &str,
    header: Option<&str>,
    keys: &PlaidKeys<'_>,
    now: f64,
) -> Result<(), &'static str> {
    let header = header
        .filter(|h| !h.is_empty())
        .ok_or("Missing Plaid-Verification header")?;
    let parts: Vec<&str> = header.split('.').collect();
    let [encoded_header, encoded_claims, encoded_signature] = parts.as_slice() else {
        return Err("Malformed webhook token");
    };
    if encoded_header.is_empty() || encoded_claims.is_empty() || encoded_signature.is_empty() {
        return Err("Malformed webhook token");
    }
    let token_header = decode_jwt_part(encoded_header).ok_or("Malformed webhook token")?;
    let kid = as_string(token_header.get("kid")).filter(|k| !k.is_empty());
    let Some(kid) = kid.filter(|_| token_header.get("alg") == Some(&json!("ES256"))) else {
        return Err("Unsupported webhook token");
    };
    let jwk = keys
        .resolve(&kid)
        .await
        .map_err(|_| "Webhook verification key unavailable")?;
    let now_seconds = (now / 1000.0).floor();
    if let Some(expired_at) = jwk.get("expired_at").and_then(Value::as_f64)
        && expired_at < now_seconds
    {
        return Err("Webhook verification key expired");
    }
    if !es256_valid(
        &jwk,
        &format!("{encoded_header}.{encoded_claims}"),
        encoded_signature,
    ) {
        return Err("Invalid webhook signature");
    }
    let claims = decode_jwt_part(encoded_claims).ok_or("Malformed webhook token")?;
    let iat = as_number(claims.get("iat"));
    let max_age = PLAID_WEBHOOK_MAX_AGE_SECONDS;
    match iat {
        Some(iat) if now_seconds - iat <= max_age && iat - now_seconds <= max_age => {}
        _ => return Err("Webhook token expired"),
    }
    let claimed = as_string(claims.get("request_body_sha256")).filter(|c| !c.is_empty());
    match claimed {
        Some(claimed) if timing_safe_equal(&sha256_hex(body), &claimed.to_lowercase()) => Ok(()),
        _ => Err("Webhook body does not match its token"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stripe_signatures_check_the_hmac_and_the_time() {
        let payload = r#"{"id":"evt_1"}"#;
        let now = 1_790_000_000_000.0;
        let signature = hmac_sha256_hex("whsec", &format!("1790000000.{payload}"));
        let header = format!("t=1790000000,v1=bad, v1={signature}");
        assert!(verify_stripe_signature(
            payload,
            Some(&header),
            "whsec",
            now
        ));
        assert!(!verify_stripe_signature(
            payload,
            Some(&header),
            "other",
            now
        ));
        assert!(!verify_stripe_signature(
            payload,
            Some(&header),
            "whsec",
            now + 301_000.0
        ));
        assert!(!verify_stripe_signature(payload, None, "whsec", now));
        assert!(!verify_stripe_signature(
            payload,
            Some("v1=abc"),
            "whsec",
            now
        ));
    }

    #[test]
    fn plaid_deliveries_become_feed_events() {
        let events = plaid_events(&as_record(&json!({
            "item_id": "item_1", "webhook_type": "ITEM", "webhook_code": "USER_ACCOUNT_REVOKED",
        })));
        assert_eq!(
            events,
            vec![json!({ "type": "disconnected", "providerConnectionId": "item_1" })]
        );
        let events = plaid_events(&as_record(&json!({
            "item_id": "item_1", "webhook_type": "ITEM", "webhook_code": "ERROR",
            "error": { "error_code": "ITEM_LOGIN_REQUIRED" },
        })));
        assert_eq!(
            events,
            vec![
                json!({ "type": "reauth_required", "providerConnectionId": "item_1", "message": null })
            ]
        );
        assert!(
            plaid_events(&as_record(
                &json!({ "item_id": "i", "webhook_type": "AUTH", "webhook_code": "X" })
            ))
            .is_empty()
        );
    }

    #[test]
    fn base64_url_decodes_as_atob_does() {
        assert_eq!(from_base64_url("aGk").as_deref(), Some(&b"hi"[..]));
        assert_eq!(from_base64_url("aGk=").as_deref(), Some(&b"hi"[..]));
        assert_eq!(from_base64_url("-_8").as_deref(), Some(&[0xfb, 0xff][..]));
        assert!(from_base64_url("a").is_none());
    }
}
