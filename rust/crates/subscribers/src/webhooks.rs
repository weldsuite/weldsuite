//! Outbound customer webhooks: `entity-webhooks-consumer.ts` in
//! integration-webhook-worker and `webhook-delivery.ts` in
//! `@weldsuite/entity-events`.
//!
//! For each event, the active `external_webhooks` subscribed to
//! `<entityType>.<action>` (or a legacy name for it, `customer.created` for
//! `company.created`) get a signed POST:
//!
//! - body `{ id, type, workspaceId, timestamp, data }`, `id` the event id,
//!   `workspaceId` the organization id;
//! - headers `Content-Type: application/json`, `X-WeldSuite-Signature` (HMAC
//!   SHA-256 of the body with the webhook's secret, hex), `X-WeldSuite-Event`,
//!   then the webhook's own headers;
//! - one immediate retry on a network error or a 5xx, then a
//!   `webhook_deliveries` row and the webhook's counters (auto-disabled after
//!   20 failures in a row);
//! - a failed delivery is due again a minute later: the workspace goes into
//!   the due index (`webhook_retry`, the master database's
//!   `workspace_due_index`, where Global uses D1) and
//!   [`run_webhook_retry_sweep`] retries it with exponential backoff, up to
//!   five attempts in all.
//!
//! An event id that already has a delivery row for a webhook is not sent
//! again (EVT-002). On Kubernetes, unlike on Workers, the consumer runs next
//! to private services, so a webhook URL that resolves to a loopback,
//! private, link-local or otherwise non-public address is refused unless the
//! deployment allows private networks.

use std::error::Error as StdError;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use aws_lc_rs::hmac;
use futures_util::future::join_all;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events;
use weldsuite_db::PgPool;
use weldsuite_db::due_index::{mark_due, run_sweep};
use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition};

use crate::event::HubEvent;
use crate::js;
use crate::tenants::Tenants;

const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);
const AUTO_DISABLE_THRESHOLD: i32 = 20;
const MAX_RETRY_ATTEMPTS: i32 = 5;
/// One minute, doubled per later attempt (`RETRY_BASE_DELAY_MS`).
const RETRY_BASE_DELAY_MS: i64 = 60_000;
const RESPONSE_BODY_CAPTURE_LIMIT: usize = 2000;
const ERROR_MESSAGE_CAPTURE_LIMIT: usize = 500;
/// The due-index kind for failed deliveries.
pub const WEBHOOK_RETRY_KIND: &str = "webhook_retry";
/// How often the retry sweep looks at a workspace with pending retries
/// (`TENANT_WORK_INTERVAL_MS`).
pub const WEBHOOK_RETRY_INTERVAL: Duration = Duration::from_mins(10);
/// What `fetch` reports when the timeout aborts it.
const ABORTED: &str = "This operation was aborted";

/// `LEGACY_WEBHOOK_ENTITY_ALIASES`: legacy entity type → the one that
/// publishes in its place.
const LEGACY_WEBHOOK_ENTITY_ALIASES: [(&str, &str); 2] =
    [("customer", "company"), ("contact", "person")];

/// `legacyWebhookEventNames(eventType)`: `company.created` →
/// `["customer.created"]`, for actions the legacy entity listed.
pub fn legacy_webhook_event_names(event_type: &str) -> Vec<String> {
    let Some((entity_type, action)) = event_type.split_once('.') else {
        return Vec::new();
    };
    LEGACY_WEBHOOK_ENTITY_ALIASES
        .iter()
        .filter(|(_, current)| *current == entity_type)
        .filter(|(legacy, _)| {
            entity_events::ALL
                .iter()
                .any(|(name, actions)| name == legacy && actions.contains(&action))
        })
        .map(|(legacy, _)| format!("{legacy}.{action}"))
        .collect()
}

/// `subscribedWebhookEventName(subscribed, eventType)`.
pub fn subscribed_webhook_event_name(subscribed: &[String], event_type: &str) -> Option<String> {
    if subscribed.iter().any(|name| name == event_type) {
        return Some(event_type.to_owned());
    }
    legacy_webhook_event_names(event_type)
        .into_iter()
        .find(|name| subscribed.contains(name))
}

/// `signWebhookPayload(secret, body)`: HMAC-SHA256, hex.
pub fn sign_webhook_payload(secret: &str, body: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    hex::encode(hmac::sign(&key, body.as_bytes()).as_ref())
}

/// A webhook as the delivery needs it.
#[derive(Debug, Clone, PartialEq)]
pub struct WebhookRow {
    pub id: String,
    pub url: String,
    pub secret: String,
    pub headers: Option<Value>,
    pub status: String,
    pub consecutive_failures: Option<i32>,
    pub events: Vec<String>,
}

impl WebhookRow {
    fn from_json(row: &Value) -> Self {
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        Self {
            id: text("id"),
            url: text("url"),
            secret: text("secret"),
            headers: row.get("headers").filter(|h| !h.is_null()).cloned(),
            status: text("status"),
            consecutive_failures: row
                .get("consecutive_failures")
                .and_then(Value::as_i64)
                .and_then(|n| i32::try_from(n).ok()),
            events: row
                .get("events")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// One HTTP attempt (`DeliveryAttemptResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub body: Option<String>,
    pub duration_ms: i32,
    pub error: Option<String>,
}

/// The HTTP client webhooks go out through.
#[derive(Clone)]
pub struct WebhookHttp {
    client: reqwest::Client,
    allow_private: bool,
}

impl std::fmt::Debug for WebhookHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookHttp")
            .field("allow_private", &self.allow_private)
            .finish_non_exhaustive()
    }
}

/// Refuses names that resolve only to non-public addresses.
struct PublicOnlyResolver;

impl reqwest::dns::Resolve for PublicOnlyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|address| is_public(address.ip()))
                .collect();
            if addresses.is_empty() {
                return Err(BlockedAddress.into());
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

#[derive(Debug)]
struct BlockedAddress;

impl std::fmt::Display for BlockedAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the webhook URL resolves to a private or reserved address")
    }
}

impl StdError for BlockedAddress {}

/// A globally routable address: not loopback, private, link-local, shared
/// (100.64/10), documentation, multicast, unspecified or unique-local.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || first == 0x2001 && v6.segments()[1] == 0x0db8)
        }
    }
}

/// Is `url`'s host an IP literal that is not public? (Names go through the
/// resolver; literals never do.)
fn literal_is_blocked(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(v4)) => !is_public(IpAddr::V4(v4)),
        Some(url::Host::Ipv6(v6)) => !is_public(IpAddr::V6(v6)),
        _ => false,
    }
}

impl WebhookHttp {
    /// `allow_private`: deliver to private addresses too (tests, and a
    /// self-hosted install whose webhooks target its own network).
    pub fn new(allow_private: bool) -> Result<Self, reqwest::Error> {
        let mut builder = reqwest::Client::builder()
            .timeout(DELIVERY_TIMEOUT)
            .user_agent(concat!("WeldSuite-Webhooks/", env!("CARGO_PKG_VERSION")));
        if allow_private {
            builder = builder.redirect(reqwest::redirect::Policy::limited(20));
        } else {
            builder = builder.dns_resolver(Arc::new(PublicOnlyResolver)).redirect(
                reqwest::redirect::Policy::custom(|attempt| {
                    if literal_is_blocked(attempt.url()) {
                        attempt.error(BlockedAddress)
                    } else if attempt.previous().len() >= 20 {
                        attempt.error("too many redirects")
                    } else {
                        attempt.follow()
                    }
                }),
            );
        }
        Ok(Self {
            client: builder.build()?,
            allow_private,
        })
    }

    /// `attemptDelivery`: sign, POST, normalise. Never fails.
    pub async fn attempt(
        &self,
        webhook: &WebhookRow,
        body: &str,
        event_type: &str,
    ) -> AttemptResult {
        let started = Instant::now();
        let elapsed =
            |started: Instant| i32::try_from(started.elapsed().as_millis()).unwrap_or(i32::MAX);
        match self.send(webhook, body, event_type).await {
            Ok((status, text)) => {
                let ok = (200..300).contains(&status);
                AttemptResult {
                    ok,
                    status: Some(status),
                    body: Some(js::slice_to(&text, RESPONSE_BODY_CAPTURE_LIMIT)),
                    duration_ms: elapsed(started),
                    error: (!ok).then(|| format!("HTTP {status}")),
                }
            }
            Err(error) => AttemptResult {
                ok: false,
                status: None,
                body: None,
                duration_ms: elapsed(started),
                error: Some(error),
            },
        }
    }

    async fn send(
        &self,
        webhook: &WebhookRow,
        body: &str,
        event_type: &str,
    ) -> Result<(u16, String), String> {
        let url =
            reqwest::Url::parse(&webhook.url).map_err(|error| format!("Invalid URL: {error}"))?;
        if !self.allow_private && literal_is_blocked(&url) {
            return Err(BlockedAddress.to_string());
        }
        let mut request = self
            .client
            .post(url)
            .header("Content-Type", "application/json")
            .header(
                "X-WeldSuite-Signature",
                sign_webhook_payload(&webhook.secret, body),
            )
            .header("X-WeldSuite-Event", event_type);
        if let Some(Value::Object(headers)) = &webhook.headers {
            for (name, value) in headers {
                let value = match value {
                    Value::String(text) => text.clone(),
                    other => js::string_of(other),
                };
                request = request.header(name.as_str(), value);
            }
        }
        let response = request
            .body(body.to_owned())
            .send()
            .await
            .map_err(describe)?;
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        Ok((status, text))
    }
}

/// A failed `fetch`'s message.
fn describe(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return ABORTED.to_owned();
    }
    let mut source: Option<&(dyn StdError + 'static)> = Some(&error);
    while let Some(current) = source {
        if current.downcast_ref::<BlockedAddress>().is_some() {
            return BlockedAddress.to_string();
        }
        source = current.source();
    }
    error.without_url().to_string()
}

/// `generateDeliveryId()`: `whd_` + 16 hex characters.
fn delivery_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    format!("whd_{}", hex::encode(bytes))
}

fn iso(at: OffsetDateTime) -> String {
    weldsuite_events::iso_timestamp(at)
}

fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// `applyDeliveryOutcome`: the webhook's counters after an attempt.
async fn apply_delivery_outcome(
    db: &PgPool,
    webhook: &WebhookRow,
    success: bool,
    error_message: Option<&str>,
) -> Result<(), sqlx::Error> {
    let now = iso(OffsetDateTime::now_utc());
    if success {
        sqlx::query(
            "update external_webhooks set last_delivered_at = $2::timestamptz, \
             total_deliveries = total_deliveries + 1, consecutive_failures = 0, \
             updated_at = $2::timestamptz where id = $1",
        )
        .bind(&webhook.id)
        .bind(&now)
        .execute(db)
        .await?;
        return Ok(());
    }
    let next_failures = webhook.consecutive_failures.unwrap_or(0) + 1;
    let disable = next_failures >= AUTO_DISABLE_THRESHOLD && webhook.status != "disabled";
    sqlx::query(
        "update external_webhooks set last_failed_at = $2::timestamptz, last_failure_reason = $3, \
         total_deliveries = total_deliveries + 1, total_failures = total_failures + 1, \
         consecutive_failures = $4, status = $5, updated_at = $2::timestamptz where id = $1",
    )
    .bind(&webhook.id)
    .bind(&now)
    .bind(error_message.map(|message| js::slice_to(message, ERROR_MESSAGE_CAPTURE_LIMIT)))
    .bind(next_failures)
    .bind(if disable {
        "disabled"
    } else {
        webhook.status.as_str()
    })
    .execute(db)
    .await?;
    Ok(())
}

/// `hasExistingWebhookDelivery`.
async fn has_existing_delivery(
    db: &PgPool,
    webhook_id: &str,
    event_id: &str,
) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from webhook_deliveries where webhook_id = $1 and event_id = $2 limit 1",
    )
    .bind(webhook_id)
    .bind(event_id)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

/// One delivery row.
struct NewDelivery<'a> {
    webhook_id: &'a str,
    event_type: &'a str,
    event_id: &'a str,
    payload: &'a str,
    status: &'a str,
    attempt: &'a AttemptResult,
    attempt_number: i32,
    next_retry_at: Option<String>,
    max_retries: i32,
    created_at: &'a str,
}

async fn insert_delivery(db: &PgPool, row: NewDelivery<'_>) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into webhook_deliveries (id, webhook_id, event_type, event_id, payload, status, \
         response_status, response_body, response_time_ms, attempt_number, next_retry_at, \
         max_retries, error_message, created_at, delivered_at) \
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13, \
         $14::timestamptz, $15::timestamptz)",
    )
    .bind(delivery_id())
    .bind(row.webhook_id)
    .bind(row.event_type)
    .bind(row.event_id)
    .bind(row.payload)
    .bind(row.status)
    .bind(row.attempt.status.map(i32::from))
    .bind(row.attempt.body.as_deref())
    .bind(row.attempt.duration_ms)
    .bind(row.attempt_number)
    .bind(row.next_retry_at)
    .bind(row.max_retries)
    .bind(row.attempt.error.as_deref())
    .bind(row.created_at)
    .bind(row.attempt.ok.then_some(row.created_at))
    .execute(db)
    .await?;
    Ok(())
}

/// What `deliverWebhookEvent` needs.
#[derive(Debug, Clone, Copy)]
pub struct DeliverInput<'a> {
    pub webhook: &'a WebhookRow,
    /// The idempotency key: the entity event id.
    pub event_id: &'a str,
    /// Dotted, `customer.created`.
    pub event_type: &'a str,
    pub workspace_id: &'a str,
    /// The entity as raw JSON.
    pub data_json: &'a str,
}

/// `deliverWebhookEvent`: whether it was delivered (a duplicate counts as
/// delivered).
pub async fn deliver_webhook_event(
    db: &PgPool,
    http: &WebhookHttp,
    input: DeliverInput<'_>,
) -> Result<bool, sqlx::Error> {
    if has_existing_delivery(db, &input.webhook.id, input.event_id).await? {
        tracing::info!(
            event_id = input.event_id,
            webhook_id = input.webhook.id,
            "webhooks: skipping duplicate event"
        );
        return Ok(true);
    }
    let timestamp = iso(OffsetDateTime::now_utc());
    // `JSON.stringify(payload)`, with `data` as published.
    let body = format!(
        "{{\"id\":{},\"type\":{},\"workspaceId\":{},\"timestamp\":{},\"data\":{}}}",
        quote(input.event_id),
        quote(input.event_type),
        quote(input.workspace_id),
        quote(&timestamp),
        input.data_json,
    );
    let mut attempt = http.attempt(input.webhook, &body, input.event_type).await;
    let mut attempt_number = 1;
    if !attempt.ok && attempt.status.is_none_or(|status| status >= 500) {
        attempt = http.attempt(input.webhook, &body, input.event_type).await;
        attempt_number = 2;
    }
    let now = OffsetDateTime::now_utc();
    let next_retry_at =
        (!attempt.ok).then(|| iso(now + time::Duration::milliseconds(RETRY_BASE_DELAY_MS)));
    let created_at = iso(now);
    insert_delivery(
        db,
        NewDelivery {
            webhook_id: &input.webhook.id,
            event_type: input.event_type,
            event_id: input.event_id,
            payload: &body,
            status: if attempt.ok { "delivered" } else { "failed" },
            attempt: &attempt,
            attempt_number,
            next_retry_at,
            max_retries: MAX_RETRY_ATTEMPTS,
            created_at: &created_at,
        },
    )
    .await?;
    apply_delivery_outcome(db, input.webhook, attempt.ok, attempt.error.as_deref()).await?;
    Ok(attempt.ok)
}

/// What `dispatchWebhookDeliveries` reports.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DispatchResult {
    pub matched: usize,
    pub failed: usize,
}

/// `dispatchWebhookDeliveries`: deliver to every active webhook subscribed
/// to `<entityType>.<action>`. A lookup failure is logged and counts as no
/// match; a delivery that fails, or errors, counts as failed.
pub async fn dispatch_webhook_deliveries(
    db: &PgPool,
    http: &WebhookHttp,
    workspace_id: &str,
    event: &HubEvent,
) -> DispatchResult {
    let event_type = format!("{}.{}", event.entity_type, event.action);
    let mut names = vec![event_type.clone()];
    names.extend(legacy_webhook_event_names(&event_type));
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(w) from external_webhooks w \
         where w.status = 'active' and w.deleted_at is null \
         and exists (select 1 from unnest($1::text[]) as n(name) where w.events @> jsonb_build_array(n.name))",
    )
    .bind(&names)
    .fetch_all(db)
    .await;
    let webhooks: Vec<WebhookRow> = match rows {
        Ok(rows) => rows.iter().map(WebhookRow::from_json).collect(),
        Err(error) => {
            tracing::error!(%error, "webhooks: failed to look up subscriptions");
            return DispatchResult::default();
        }
    };
    if webhooks.is_empty() {
        return DispatchResult::default();
    }
    let data_json = event.data_json_or_empty_object();
    let outcomes = join_all(webhooks.iter().map(|webhook| {
        let delivered_as = subscribed_webhook_event_name(&webhook.events, &event_type)
            .unwrap_or_else(|| event_type.clone());
        async move {
            deliver_webhook_event(
                db,
                http,
                DeliverInput {
                    webhook,
                    event_id: &event.id,
                    event_type: &delivered_as,
                    workspace_id,
                    data_json,
                },
            )
            .await
        }
    }))
    .await;
    let failed = outcomes
        .iter()
        .filter(|outcome| match outcome {
            Ok(delivered) => !delivered,
            Err(error) => {
                tracing::error!(%error, "webhooks: delivery failed");
                true
            }
        })
        .count();
    DispatchResult {
        matched: webhooks.len(),
        failed,
    }
}

/// What one retry pass did (`RetryFailedWebhookDeliveriesResult`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RetryResult {
    pub attempted: usize,
    pub succeeded: usize,
}

/// `hasPendingWebhookRetries`.
pub async fn has_pending_webhook_retries(db: &PgPool) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select d.id from webhook_deliveries d \
         inner join external_webhooks w on d.webhook_id = w.id \
         where d.status in ('failed', 'retrying') and w.deleted_at is null and w.status = 'active' \
         and d.next_retry_at is not null and d.attempt_number < d.max_retries limit 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

/// `retryFailedWebhookDeliveries`: retry up to 50 due deliveries, each as a
/// new attempt row with exponential backoff, until `max_retries` attempts.
pub async fn retry_failed_webhook_deliveries(
    db: &PgPool,
    http: &WebhookHttp,
) -> Result<RetryResult, sqlx::Error> {
    let now = iso(OffsetDateTime::now_utc());
    let due: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(d), to_jsonb(w) from webhook_deliveries d \
         inner join external_webhooks w on d.webhook_id = w.id \
         where d.status in ('failed', 'retrying') and w.deleted_at is null and w.status = 'active' \
         and d.next_retry_at <= $1::timestamptz and d.attempt_number < d.max_retries limit 50",
    )
    .bind(&now)
    .fetch_all(db)
    .await?;
    let mut result = RetryResult {
        attempted: due.len(),
        succeeded: 0,
    };
    for (delivery, webhook) in due {
        let webhook = WebhookRow::from_json(&webhook);
        let text = |key: &str| {
            delivery
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let number = |key: &str| {
            delivery
                .get(key)
                .and_then(Value::as_i64)
                .and_then(|n| i32::try_from(n).ok())
        };
        let payload = delivery.get("payload").cloned().unwrap_or(Value::Null);
        let event_type = text("event_type");
        // `{ ...payload, timestamp: now }`.
        let mut body = match &payload {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        body.insert(
            "timestamp".to_owned(),
            json!(iso(OffsetDateTime::now_utc())),
        );
        let body = Value::Object(body).to_string();
        let attempt = http.attempt(&webhook, &body, &event_type).await;

        let next_attempt = number("attempt_number").unwrap_or(1) + 1;
        let max_retries = number("max_retries").unwrap_or(MAX_RETRY_ATTEMPTS);
        let exhausted = next_attempt >= max_retries;
        let backoff_ms =
            RETRY_BASE_DELAY_MS * 2i64.pow(u32::try_from(next_attempt - 1).unwrap_or(0));
        let retry_now = OffsetDateTime::now_utc();
        let status = if attempt.ok {
            "delivered"
        } else if exhausted {
            "failed"
        } else {
            "retrying"
        };
        let created_at = iso(retry_now);
        insert_delivery(
            db,
            NewDelivery {
                webhook_id: &webhook.id,
                event_type: &event_type,
                event_id: &text("event_id"),
                payload: &payload.to_string(),
                status,
                attempt: &attempt,
                attempt_number: next_attempt,
                next_retry_at: (!attempt.ok && !exhausted)
                    .then(|| iso(retry_now + time::Duration::milliseconds(backoff_ms))),
                max_retries,
                created_at: &created_at,
            },
        )
        .await?;
        sqlx::query("update webhook_deliveries set next_retry_at = null where id = $1")
            .bind(text("id"))
            .execute(db)
            .await?;
        apply_delivery_outcome(db, &webhook, attempt.ok, attempt.error.as_deref()).await?;
        if attempt.ok {
            result.succeeded += 1;
        }
    }
    Ok(result)
}

/// One tick of the retry sweep (`runWebhookRetrySweep`): every workspace in
/// the due index with kind `webhook_retry`, retried, then due again in ten
/// minutes while it has pending retries, or dropped.
pub async fn run_webhook_retry_sweep(
    master: &PgPool,
    tenants: &dyn Tenants,
    http: &WebhookHttp,
) -> weldsuite_db::due_index::SweepResult {
    let now = OffsetDateTime::now_utc();
    let interval =
        time::Duration::try_from(WEBHOOK_RETRY_INTERVAL).unwrap_or(time::Duration::minutes(10));
    let result = run_sweep(
        master,
        WEBHOOK_RETRY_KIND,
        now,
        500,
        Some(interval),
        |workspace_id, now| async move {
            let tenant = tenants
                .tenant(&workspace_id)
                .await
                .map_err(|error| error.to_string())?;
            let retried = retry_failed_webhook_deliveries(&tenant.db, http)
                .await
                .map_err(|error| error.to_string())?;
            let pending = has_pending_webhook_retries(&tenant.db)
                .await
                .map_err(|error| error.to_string())?;
            tracing::info!(
                workspace_id,
                attempted = retried.attempted,
                succeeded = retried.succeeded,
                pending,
                "webhooks: retry sweep"
            );
            Ok::<_, String>(pending.then_some(now + interval))
        },
    )
    .await;
    if result.due > 0 {
        tracing::info!(
            due = result.due,
            processed = result.processed,
            failed = result.failed,
            "webhooks: retry sweep done"
        );
    }
    result
}

/// The webhooks subscriber.
#[derive(Clone)]
pub struct WebhooksSubscriber {
    tenants: Arc<dyn Tenants>,
    /// For the due index; `None` skips scheduling retries (tests).
    master: Option<PgPool>,
    http: WebhookHttp,
}

impl std::fmt::Debug for WebhooksSubscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhooksSubscriber")
            .field("http", &self.http)
            .finish_non_exhaustive()
    }
}

impl WebhooksSubscriber {
    pub fn new(tenants: Arc<dyn Tenants>, master: Option<PgPool>, http: WebhookHttp) -> Self {
        Self {
            tenants,
            master,
            http,
        }
    }

    /// `handleEntityWebhookMessage`.
    pub async fn handle_one(&self, delivery: &Delivery) -> Disposition {
        let event = match HubEvent::parse(&delivery.payload) {
            Ok(event) => event,
            Err(error) => {
                tracing::error!(%error, subject = delivery.subject, "webhooks: not an entity event; dropped");
                return Disposition::Ack;
            }
        };
        let key = event.metadata.workspace_id.as_str();
        if key.is_empty() {
            tracing::warn!(
                event_id = event.id,
                "webhooks: skipping event, missing workspaceId"
            );
            return Disposition::Ack;
        }
        let tenant = match self.tenants.tenant(key).await {
            Ok(tenant) => tenant,
            Err(error) => {
                return Disposition::retry(format!("cannot resolve the workspace: {error}"));
            }
        };
        // The payload names the organization (`resolveWorkspaceForEvent`).
        let org = if key.starts_with("org_") {
            key.to_owned()
        } else if let Some(org) = tenant.clerk_org_id.clone() {
            org
        } else {
            return Disposition::retry(format!("Workspace missing clerkOrgId: {key}"));
        };
        let result = dispatch_webhook_deliveries(&tenant.db, &self.http, &org, &event).await;
        if result.failed > 0
            && let Some(master) = &self.master
        {
            let due = OffsetDateTime::now_utc() + time::Duration::milliseconds(RETRY_BASE_DELAY_MS);
            mark_due(master, WEBHOOK_RETRY_KIND, &tenant.workspace_id, due).await;
        }
        Disposition::Ack
    }

    pub fn http(&self) -> &WebhookHttp {
        &self.http
    }
}

impl BatchHandler for WebhooksSubscriber {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(batch.len());
            for delivery in batch {
                out.push(self.handle_one(delivery).await);
            }
            out
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_names() {
        assert_eq!(
            legacy_webhook_event_names("company.created"),
            vec!["customer.created"]
        );
        assert_eq!(
            legacy_webhook_event_names("person.updated"),
            vec!["contact.updated"]
        );
        assert_eq!(
            legacy_webhook_event_names("ticket.created"),
            Vec::<String>::new()
        );
        let subscribed = vec!["customer.created".to_owned()];
        assert_eq!(
            subscribed_webhook_event_name(&subscribed, "company.created").as_deref(),
            Some("customer.created")
        );
        assert_eq!(
            subscribed_webhook_event_name(&subscribed, "company.deleted"),
            None
        );
    }

    #[test]
    fn signatures_are_hmac_sha256_hex() {
        // `crypto.subtle.sign('HMAC', key('secret'), 'body')`.
        assert_eq!(
            sign_webhook_payload("secret", "body"),
            "dc46983557fea127b43af721467eb9b3fde2338fe3e14f51952aa8478c13d355"
        );
    }

    #[test]
    fn private_addresses_are_not_public() {
        for blocked in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(!is_public(blocked.parse().expect("ip")), "{blocked}");
        }
        for open in ["93.184.216.34", "2606:4700::1111"] {
            assert!(is_public(open.parse().expect("ip")), "{open}");
        }
    }
}
