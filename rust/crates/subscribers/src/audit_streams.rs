//! Audit log streams: pushing a workspace's audit events to its SIEM (Splunk
//! HEC or any HTTPS collector that takes JSON),
//! `packages/domains/core/src/audit-streams.ts`.
//!
//! [`crate::AuditSubscriber`] calls [`flush_audit_log_streams`] a few seconds
//! after it has written a batch of audit rows (see the settle window below);
//! `POST /api/audit-log-streams/:id/test` calls
//! [`AuditStreamSender::send_test`], which the window does not concern.
//! Delivery reads `audit_logs` forward from the stream's cursor, so it is
//! ordered and at-least-once: the cursor moves only after a 2xx, a failed
//! batch is sent again, and a destination that was down catches up. Two
//! flushes of one workspace at the same time can deliver a batch twice (the
//! cursor update is compare-and-swap, so it never goes back).
//!
//! The cursor `(cursor_created_at, cursor_id)` has milliseconds, as the
//! JavaScript `Date` that writes it on Global, while `audit_logs.created_at`
//! has microseconds. Comparing a truncated cursor against the full value
//! would select the row the cursor stands on again and again, so rows are
//! compared and ordered on `date_trunc('milliseconds', created_at)` and then
//! `id`; an index-friendly `created_at >= cursor` prefilter narrows the scan
//! first.
//!
//! A cursor over `created_at` is only safe over rows that can no longer gain
//! an older neighbour. `created_at` is the database's `now()`, the time the
//! insert's transaction started, not the time it committed, and the audit
//! consumer writes from several workers at once: a row can become visible
//! after a later one (or, inside one millisecond, after one with a higher
//! id) was already sent, and a cursor that had moved past it would never
//! send it. So a flush reads only rows older than the settle window
//! (`created_at < now - AUDIT_STREAM_SETTLE`): by then every insert that took
//! an earlier timestamp has committed. Younger rows wait for a later flush
//! and the cursor never passes them, which is why the subscriber flushes a
//! little after the window has passed rather than straight after its writes.
//!
//! The wire formats are the worker's byte for byte: an event is
//! `JSON.stringify` of `{ id, timestamp, workspaceId, action, entityType,
//! entityId, description, actor, source, changes, ipAddress }`, `changes`
//! with its keys in the order JavaScript reads them from the column.
//!
//! Nothing here fails into the caller, and the token never reaches a log, an
//! error excerpt or a result.
//!
//! On Kubernetes the consumer runs next to private services, so beside the
//! URL check of [`crate::safe_url`] the client resolves names itself and
//! refuses the ones that point at a private address, like outbound webhooks
//! do (`crate::webhooks`), unless the deployment allows private networks
//! (`WEBHOOK_ALLOW_PRIVATE_NETWORKS`).

use std::error::Error as StdError;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sea_orm::sea_query::{Expr, Func, Order};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{Keyring, PgPool, decrypt_field, orm};
use weldsuite_ports::{BoxFuture, HttpRequest, OutboundHttp, PortError};
use weldsuite_schema::tenant::{audit_log_streams, audit_logs};

use crate::js::{self, Json};
use crate::safe_url::{PRIVATE_ADDRESS, check_safe_url};
use crate::webhooks::{BlockedAddress, PublicOnlyResolver, literal_is_blocked};

/// Rows in one request.
pub const AUDIT_STREAM_BATCH_SIZE: usize = 200;
/// Requests per stream in one flush; the rest waits for the next flush.
pub const AUDIT_STREAM_MAX_REQUESTS_PER_FLUSH: usize = 5;
/// Timeout of one request to the destination.
pub const AUDIT_STREAM_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Consecutive failed deliveries after which the platform switches a stream
/// off.
pub const AUDIT_STREAM_DISABLE_AFTER_FAILURES: i32 = 20;
/// How old a row must be before a flush reads it
/// (`AUDIT_STREAM_SETTLE_MS`). An insert takes its `created_at` when its
/// transaction starts and shows up when it commits; past this window no row
/// with an earlier `created_at` is still on its way.
pub const AUDIT_STREAM_SETTLE: Duration = Duration::from_secs(5);

const BACKOFF_BASE_MS: i64 = 60_000;
const BACKOFF_MAX_MS: i64 = 60 * 60_000;
const ERROR_EXCERPT_CHARS: usize = 200;
const DEFAULT_SPLUNK_HOST: &str = "weldsuite";
const DEFAULT_SPLUNK_SOURCE: &str = "weldsuite:audit";
const DEFAULT_SPLUNK_SOURCETYPE: &str = "_json";
const UNDECRYPTABLE_TOKEN: &str = "The stored token cannot be decrypted; enter it again";

// ============================================================================
// Event and request builders (pure)
// ============================================================================

/// An `audit_logs` row as delivery reads it (`AuditStreamRow`): no `data`
/// snapshot, and of the metadata only `workspaceId` and `source`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuditStreamRow {
    pub id: String,
    /// `created_at` cut to the millisecond, as `toISOString()` writes it
    /// (`2026-11-01T10:00:00.123Z`).
    pub created_at: String,
    pub entity_type: String,
    pub entity_id: String,
    pub action: String,
    pub description: String,
    /// The `changes` column as JSON text; `None` for SQL null.
    pub changes: Option<String>,
    pub performed_by: Option<String>,
    pub performed_by_name: Option<String>,
    pub ip_address: Option<String>,
    /// `metadata.workspaceId`, when it is a non-empty string
    /// (`metadataString`).
    pub workspace_id: Option<String>,
    /// `metadata.source`, when it is a non-empty string.
    pub source: Option<String>,
}

/// What is sent for one audit row (`AuditStreamEvent`): the event as
/// `JSON.stringify` writes it, and its instant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditStreamEvent {
    json: String,
    /// `new Date(event.timestamp).getTime()`; `None` for an invalid date.
    epoch_ms: Option<i64>,
}

impl AuditStreamEvent {
    /// `JSON.stringify(event)`.
    pub fn json(&self) -> &str {
        &self.json
    }
}

/// `JSON.stringify(value ?? null)` of an optional string.
fn nullable(value: Option<&str>) -> String {
    value.map_or_else(|| "null".to_owned(), js::quote)
}

/// `Date.parse(iso)` of an instant written as `toISOString()` writes it.
fn epoch_millis(iso: &str) -> Option<i64> {
    let at = OffsetDateTime::parse(iso, &Rfc3339).ok()?;
    i64::try_from(at.unix_timestamp_nanos().div_euclid(1_000_000)).ok()
}

/// The event `{ id, timestamp, workspaceId, action, entityType, entityId,
/// description, actor, source, changes, ipAddress }`, keys in that order.
struct EventFields<'a> {
    id: &'a str,
    timestamp: &'a str,
    workspace_id: Option<&'a str>,
    action: &'a str,
    entity_type: &'a str,
    entity_id: &'a str,
    description: &'a str,
    actor_id: Option<&'a str>,
    actor_name: Option<&'a str>,
    source: Option<&'a str>,
    /// `changes` as JavaScript writes it, `null` included.
    changes: String,
    ip_address: Option<&'a str>,
}

impl EventFields<'_> {
    fn event(&self) -> AuditStreamEvent {
        let json = format!(
            "{{\"id\":{},\"timestamp\":{},\"workspaceId\":{},\"action\":{},\"entityType\":{},\
             \"entityId\":{},\"description\":{},\"actor\":{{\"id\":{},\"name\":{}}},\"source\":{},\
             \"changes\":{},\"ipAddress\":{}}}",
            js::quote(self.id),
            js::quote(self.timestamp),
            nullable(self.workspace_id),
            js::quote(self.action),
            js::quote(self.entity_type),
            js::quote(self.entity_id),
            js::quote(self.description),
            nullable(self.actor_id),
            nullable(self.actor_name),
            nullable(self.source),
            self.changes,
            nullable(self.ip_address),
        );
        AuditStreamEvent {
            json,
            epoch_ms: epoch_millis(self.timestamp),
        }
    }
}

/// `buildAuditStreamEvent(row, workspaceId)`. `workspace_id` is used when the
/// row carries no `metadata.workspaceId`.
pub fn build_audit_stream_event(
    row: &AuditStreamRow,
    workspace_id: Option<&str>,
) -> AuditStreamEvent {
    // `row.changes ?? null`, as `JSON.parse` read the column.
    let changes = row
        .changes
        .as_deref()
        .and_then(Json::parse)
        .map_or_else(|| "null".to_owned(), |changes| changes.stringify());
    EventFields {
        id: &row.id,
        timestamp: &row.created_at,
        workspace_id: row.workspace_id.as_deref().or(workspace_id),
        action: &row.action,
        entity_type: &row.entity_type,
        entity_id: &row.entity_id,
        description: &row.description,
        actor_id: row.performed_by.as_deref(),
        actor_name: row.performed_by_name.as_deref(),
        source: row.source.as_deref(),
        changes,
        ip_address: row.ip_address.as_deref(),
    }
    .event()
}

/// `buildTestAuditStreamEvent(now, workspaceId)`: the one synthetic event of
/// "send a test".
pub fn build_test_audit_stream_event(
    now: OffsetDateTime,
    workspace_id: Option<&str>,
) -> AuditStreamEvent {
    EventFields {
        id: "audit_test",
        timestamp: &weldsuite_events::iso_timestamp(now),
        workspace_id,
        action: "test",
        entity_type: "audit_log_stream",
        entity_id: "audit_log_stream_test",
        description: "Test event from WeldSuite: this audit log stream is reachable.",
        actor_id: None,
        actor_name: Some("WeldSuite"),
        source: Some("system"),
        changes: "null".to_owned(),
        ip_address: None,
    }
    .event()
}

/// Where a stream sends (`AuditStreamDestination`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuditStreamDestination<'a> {
    /// `splunk_hec` or `http`.
    pub kind: &'a str,
    pub url: &'a str,
    /// The `settings` column as JSON text; `None` for SQL null.
    pub settings: Option<&'a str>,
}

/// One request to a destination (`AuditStreamRequest`): the headers in the
/// order the worker sets them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditStreamRequest {
    pub body: String,
    pub headers: Vec<(String, String)>,
}

/// `epochSeconds(iso)` as `JSON.stringify` writes it: epoch seconds with
/// milliseconds, the HEC `time` field (`Number((ms / 1000).toFixed(3))`).
fn epoch_seconds(epoch_ms: Option<i64>) -> String {
    let Some(epoch_ms) = epoch_ms else {
        return "null".to_owned();
    };
    let sign = if epoch_ms < 0 { "-" } else { "" };
    let magnitude = epoch_ms.unsigned_abs();
    format!("{sign}{}.{:03}", magnitude / 1000, magnitude % 1000)
        .parse::<f64>()
        .map_or_else(|_| "null".to_owned(), js::number_text)
}

/// `buildAuditStreamRequest(stream, token, events)`: the request for a batch
/// of events.
///
///  - `splunk_hec`: `Authorization: Splunk <token>`, one HEC envelope per
///    event `{ time, host, source, sourcetype, index?, event }`, joined with
///    newlines.
///  - `http`: `Content-Type: application/json` and `{ "events": [...] }`, or
///    with `format: 'ndjson'` one event per line as `application/x-ndjson`;
///    the token, when there is one, goes in `settings.authHeader ??
///    'Authorization'` exactly as the member typed it.
pub fn build_audit_stream_request(
    stream: &AuditStreamDestination<'_>,
    token: Option<&str>,
    events: &[AuditStreamEvent],
) -> AuditStreamRequest {
    // `stream.settings ?? {}`.
    let settings = stream
        .settings
        .and_then(Json::parse)
        .unwrap_or(Json::Object(Vec::new()));
    // `settings[key] || fallback`.
    let setting = |key: &str| settings.get(key).filter(|value| value.truthy());
    let token = token.filter(|token| !token.is_empty());
    let content_type = |value: &str| vec![("Content-Type".to_owned(), value.to_owned())];

    if stream.kind == "splunk_hec" {
        let mut headers = content_type("application/json");
        if let Some(token) = token {
            headers.push(("Authorization".to_owned(), format!("Splunk {token}")));
        }
        let or_default = |key: &str, fallback: &str| {
            setting(key).map_or_else(|| js::quote(fallback), Json::stringify)
        };
        let host = or_default("host", DEFAULT_SPLUNK_HOST);
        let source = or_default("source", DEFAULT_SPLUNK_SOURCE);
        let sourcetype = or_default("sourcetype", DEFAULT_SPLUNK_SOURCETYPE);
        let index = setting("index").map_or_else(String::new, |index| {
            format!("\"index\":{},", index.stringify())
        });
        let body = events
            .iter()
            .map(|event| {
                format!(
                    "{{\"time\":{},\"host\":{host},\"source\":{source},\
                     \"sourcetype\":{sourcetype},{index}\"event\":{}}}",
                    epoch_seconds(event.epoch_ms),
                    event.json,
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        return AuditStreamRequest { body, headers };
    }

    let ndjson = matches!(settings.get("format"), Some(Json::String(format)) if format == "ndjson");
    let mut headers = content_type(if ndjson {
        "application/x-ndjson"
    } else {
        "application/json"
    });
    if let Some(token) = token {
        // `headers[settings.authHeader || 'Authorization'] = token`.
        let name = match setting("authHeader") {
            Some(Json::String(name)) => name.clone(),
            Some(other) => other.stringify(),
            None => "Authorization".to_owned(),
        };
        match headers.iter_mut().find(|(existing, _)| *existing == name) {
            Some(header) => token.clone_into(&mut header.1),
            None => headers.push((name, token.to_owned())),
        }
    }
    let events: Vec<&str> = events.iter().map(AuditStreamEvent::json).collect();
    let body = if ndjson {
        events.join("\n")
    } else {
        format!("{{\"events\":[{}]}}", events.join(","))
    };
    AuditStreamRequest { body, headers }
}

/// `auditStreamBackoffMs(failures)`: the wait after the Nth consecutive
/// failure, `min(60 s × 2^failures, 1 h)`.
pub fn audit_stream_backoff_ms(consecutive_failures: i32) -> i64 {
    let exponent = u32::try_from(consecutive_failures.clamp(0, 30)).unwrap_or(0);
    BACKOFF_BASE_MS
        .saturating_mul(1_i64 << exponent)
        .min(BACKOFF_MAX_MS)
}

// ============================================================================
// Sending
// ============================================================================

/// What a destination answered to one request, or why it could not be asked
/// (`AuditStreamSendResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditStreamSendResult {
    pub ok: bool,
    pub status: Option<u16>,
    /// Short and free of the token; `None` when ok.
    pub error: Option<String>,
    pub duration_ms: u64,
}

/// `scrub(text, token)`: the token removed from text that came from the
/// destination or the network stack, whitespace collapsed, cut to the
/// excerpt's length.
fn scrub(text: &str, token: Option<&str>) -> String {
    let without = match token.filter(|token| !token.is_empty()) {
        Some(token) => text.replace(token, "***"),
        None => text.to_owned(),
    };
    // `.replaceAll(/\s+/g, ' ')`
    let mut collapsed = String::with_capacity(without.len());
    let mut in_run = false;
    for c in without.chars() {
        if js::is_js_space(c) {
            if !in_run {
                collapsed.push(' ');
            }
            in_run = true;
        } else {
            collapsed.push(c);
            in_run = false;
        }
    }
    js::slice_to(js::trim(&collapsed), ERROR_EXCERPT_CHARS)
}

/// `openToken(tokenEncrypted, keyring)`: the collector's token, `None` for a
/// stream without one, or why it cannot be read.
fn open_token(
    token_encrypted: Option<&str>,
    keyring: &Keyring,
) -> Result<Option<String>, &'static str> {
    match token_encrypted.filter(|sealed| !sealed.is_empty()) {
        None => Ok(None),
        Some(sealed) => decrypt_field(sealed, keyring)
            .map(Some)
            .map_err(|_| UNDECRYPTABLE_TOKEN),
    }
}

/// One POST to a destination.
#[derive(Debug, Clone, Copy)]
pub struct StreamCall<'a> {
    pub url: &'a str,
    pub headers: &'a [(String, String)],
    pub body: &'a str,
}

/// What the destination answered. A redirect is an answer too: it is never
/// followed, since it would carry the token to another host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamAnswer {
    pub status: u16,
    /// The answer's text, for the excerpt of a refusal (empty when it could
    /// not be read; not read at all for a 2xx).
    pub text: String,
}

/// Why a request got no answer (`fetch` throwing).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamFailure {
    /// The request ran into [`AUDIT_STREAM_REQUEST_TIMEOUT`].
    TimedOut,
    /// The error's message.
    Failed(String),
}

/// What carries a request to a destination: [`AuditStreamHttp`] on the
/// Kubernetes editions, [`OutboundStreamHttp`] where a request's outbound
/// HTTP port must carry the call (conformance builds compare it through the
/// outbound bridge).
pub trait StreamTransport: Send + Sync {
    fn post<'a>(
        &'a self,
        call: StreamCall<'a>,
    ) -> BoxFuture<'a, Result<StreamAnswer, StreamFailure>>;
}

/// The HTTP client audit log streams go out through: no redirects, ten
/// seconds, and public addresses only unless private networks are allowed.
#[derive(Clone)]
pub struct AuditStreamHttp {
    client: reqwest::Client,
    allow_private: bool,
}

impl std::fmt::Debug for AuditStreamHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuditStreamHttp")
            .field("allow_private", &self.allow_private)
            .finish_non_exhaustive()
    }
}

impl AuditStreamHttp {
    /// `allow_private`: deliver to private addresses too (tests, and a
    /// self-hosted install that collects on its own network).
    pub fn new(allow_private: bool) -> Result<Self, reqwest::Error> {
        let mut builder = reqwest::Client::builder()
            .timeout(AUDIT_STREAM_REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none());
        if !allow_private {
            builder = builder.dns_resolver(Arc::new(PublicOnlyResolver));
        }
        Ok(Self {
            client: builder.build()?,
            allow_private,
        })
    }

    async fn send(&self, call: StreamCall<'_>) -> Result<StreamAnswer, StreamFailure> {
        let failed = |message: String| StreamFailure::Failed(message);
        let url = reqwest::Url::parse(call.url).map_err(|error| failed(error.to_string()))?;
        if !self.allow_private && literal_is_blocked(&url) {
            return Err(failed(PRIVATE_ADDRESS.to_owned()));
        }
        let mut request = self.client.post(url);
        for (name, value) in call.headers {
            request = request.header(name.as_str(), value.as_str());
        }
        let response = request
            .body(call.body.to_owned())
            .send()
            .await
            .map_err(describe)?;
        let status = response.status().as_u16();
        let text = if response.status().is_success() {
            String::new()
        } else {
            response.text().await.unwrap_or_default()
        };
        Ok(StreamAnswer { status, text })
    }
}

/// A failed request as the result words it. Never the URL: it can carry a
/// secret in its path or query.
fn describe(error: reqwest::Error) -> StreamFailure {
    if error.is_timeout() {
        return StreamFailure::TimedOut;
    }
    let mut source: Option<&(dyn StdError + 'static)> = Some(&error);
    while let Some(current) = source {
        if current.downcast_ref::<BlockedAddress>().is_some() {
            return StreamFailure::Failed(PRIVATE_ADDRESS.to_owned());
        }
        source = current.source();
    }
    StreamFailure::Failed(error.without_url().to_string())
}

impl StreamTransport for AuditStreamHttp {
    fn post<'a>(
        &'a self,
        call: StreamCall<'a>,
    ) -> BoxFuture<'a, Result<StreamAnswer, StreamFailure>> {
        Box::pin(self.send(call))
    }
}

/// Requests through an [`OutboundHttp`] port: the request
/// [`AuditStreamHttp`] sends, answered by whatever the port reaches.
#[derive(Clone)]
pub struct OutboundStreamHttp(pub OutboundHttp);

impl std::fmt::Debug for OutboundStreamHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OutboundStreamHttp")
    }
}

impl StreamTransport for OutboundStreamHttp {
    fn post<'a>(
        &'a self,
        call: StreamCall<'a>,
    ) -> BoxFuture<'a, Result<StreamAnswer, StreamFailure>> {
        Box::pin(async move {
            let request = HttpRequest {
                method: "POST".to_owned(),
                url: call.url.to_owned(),
                headers: call.headers.to_vec(),
                body: Some(call.body.as_bytes().to_vec()),
            };
            let sent = tokio::time::timeout(AUDIT_STREAM_REQUEST_TIMEOUT, self.0.send(request));
            match sent.await {
                Err(_) => Err(StreamFailure::TimedOut),
                Ok(Ok(response)) => Ok(StreamAnswer {
                    status: response.status,
                    text: response.text(),
                }),
                // `err.message`, without the port's own prefix.
                Ok(Err(PortError::Backend(error))) => Err(StreamFailure::Failed(error.to_string())),
                Ok(Err(error)) => Err(StreamFailure::Failed(error.to_string())),
            }
        })
    }
}

/// Sends events to destinations: the transport and whether the private-network
/// URL check is skipped (`AuditStreamSendOptions`).
#[derive(Clone)]
pub struct AuditStreamSender {
    transport: Arc<dyn StreamTransport>,
    allow_private: bool,
}

impl std::fmt::Debug for AuditStreamSender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuditStreamSender")
            .field("allow_private", &self.allow_private)
            .finish_non_exhaustive()
    }
}

impl AuditStreamSender {
    /// Over [`AuditStreamHttp`]. `allow_private` skips the private-network
    /// checks, of the URL and of the address it resolves to
    /// (`WEBHOOK_ALLOW_PRIVATE_NETWORKS`).
    pub fn new(allow_private: bool) -> Result<Self, reqwest::Error> {
        Ok(Self {
            transport: Arc::new(AuditStreamHttp::new(allow_private)?),
            allow_private,
        })
    }

    /// Over an [`OutboundHttp`] port, with the URL check on.
    pub fn over(http: OutboundHttp) -> Self {
        Self::with_transport(Arc::new(OutboundStreamHttp(http)), false)
    }

    /// Over any transport (tests bring their own).
    pub fn with_transport(transport: Arc<dyn StreamTransport>, allow_private: bool) -> Self {
        Self {
            transport,
            allow_private,
        }
    }

    /// `post(stream, token, events, options)`: one request; never fails.
    async fn post(
        &self,
        stream: &AuditStreamDestination<'_>,
        token: Option<&str>,
        events: &[AuditStreamEvent],
    ) -> AuditStreamSendResult {
        let started = Instant::now();
        let failed = |status: Option<u16>, error: String| AuditStreamSendResult {
            ok: false,
            status,
            error: Some(error),
            duration_ms: elapsed(started),
        };
        if !self.allow_private
            && let Err(reason) = check_safe_url(stream.url)
        {
            return failed(None, reason.to_owned());
        }
        let request = build_audit_stream_request(stream, token, events);
        let call = StreamCall {
            url: stream.url,
            headers: &request.headers,
            body: &request.body,
        };
        match self.transport.post(call).await {
            Ok(answer) if (200..300).contains(&answer.status) => AuditStreamSendResult {
                ok: true,
                status: Some(answer.status),
                error: None,
                duration_ms: elapsed(started),
            },
            Ok(answer) => {
                let excerpt = scrub(&js::slice_to(&answer.text, ERROR_EXCERPT_CHARS * 2), token);
                let error = if excerpt.is_empty() {
                    format!("HTTP {}", answer.status)
                } else {
                    format!("HTTP {}: {excerpt}", answer.status)
                };
                failed(Some(answer.status), error)
            }
            Err(StreamFailure::TimedOut) => failed(
                None,
                format!(
                    "Timed out after {} s",
                    AUDIT_STREAM_REQUEST_TIMEOUT.as_secs()
                ),
            ),
            Err(StreamFailure::Failed(message)) if message.is_empty() => {
                failed(None, "Request failed".to_owned())
            }
            Err(StreamFailure::Failed(message)) => {
                failed(None, format!("Request failed: {}", scrub(&message, token)))
            }
        }
    }

    /// `sendAuditLogStreamTest(stream, { keyring, workspaceId, now })`: one
    /// synthetic test event to a destination now. Touches no cursor and no
    /// counter; the answer is what `POST /:id/test` returns.
    pub async fn send_test(
        &self,
        stream: &AuditStreamDestination<'_>,
        token_encrypted: Option<&str>,
        keyring: &Keyring,
        workspace_id: Option<&str>,
        now: OffsetDateTime,
    ) -> AuditStreamSendResult {
        let started = Instant::now();
        let token = match open_token(token_encrypted, keyring) {
            Ok(token) => token,
            Err(error) => {
                return AuditStreamSendResult {
                    ok: false,
                    status: None,
                    error: Some(error.to_owned()),
                    duration_ms: elapsed(started),
                };
            }
        };
        let event = build_test_audit_stream_event(now, workspace_id);
        self.post(stream, token.as_deref(), std::slice::from_ref(&event))
            .await
    }
}

fn elapsed(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

// ============================================================================
// Flushing
// ============================================================================

/// What a flush needs besides the database and the sender
/// (`FlushAuditLogStreamsOptions`).
#[derive(Debug, Clone, Copy)]
pub struct FlushOptions<'a> {
    pub keyring: &'a Keyring,
    /// Used for events whose row carries no `metadata.workspaceId`.
    pub workspace_id: Option<&'a str>,
    /// The time of the flush, read to the millisecond as the worker's
    /// `Date`: rows younger than `now - AUDIT_STREAM_SETTLE` are left for a
    /// later one.
    pub now: OffsetDateTime,
}

/// How a stream's flush ended. `Idle`: nothing to send; `Backoff`: still
/// waiting after a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushOutcome {
    Delivered,
    Idle,
    Backoff,
    Failed,
}

impl FlushOutcome {
    /// The worker's name for it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Delivered => "delivered",
            Self::Idle => "idle",
            Self::Backoff => "backoff",
            Self::Failed => "failed",
        }
    }
}

/// One stream's flush (`FlushStreamResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlushStreamResult {
    pub stream_id: String,
    pub outcome: FlushOutcome,
    pub delivered: usize,
    pub error: Option<String>,
}

/// A timestamp cut to the millisecond (`date_trunc('milliseconds', …)`), as
/// the JavaScript `Date` the worker reads it as.
fn millis(at: PrimitiveDateTime) -> PrimitiveDateTime {
    at.replace_millisecond(at.millisecond()).unwrap_or(at)
}

/// A timestamp column cut to the millisecond, as `toISOString()` writes the
/// `Date` the worker reads it as.
fn iso_millis(at: PrimitiveDateTime) -> String {
    weldsuite_events::iso_timestamp(at.assume_utc())
}

/// Where a stream's cursor stands, as a flush knows it (`cursor`,
/// `current`).
#[derive(Debug, Clone)]
struct Cursor {
    /// `cursor_created_at ?? created_at`, to the millisecond (`cursorOf`).
    at: PrimitiveDateTime,
    /// Whether `cursor_created_at` is set (a stream that never delivered
    /// may have none).
    has_at: bool,
    id: Option<String>,
}

/// An active stream, as a flush reads it.
struct StoredStream {
    id: String,
    kind: String,
    url: String,
    token_encrypted: Option<String>,
    /// `settings` as Postgres prints the jsonb.
    settings: Option<String>,
    consecutive_failures: i32,
    /// `last_attempt_at`, to the millisecond.
    last_attempt_at: Option<String>,
    cursor: Cursor,
}

/// id, type, url, token, `settings::text`, consecutive failures, last
/// attempt, created at, cursor created at, cursor id.
type StoredStreamRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    i32,
    Option<PrimitiveDateTime>,
    PrimitiveDateTime,
    Option<PrimitiveDateTime>,
    Option<String>,
);

/// The workspace's active streams.
async fn active_streams(db: &PgPool) -> Result<Vec<StoredStream>, DbErr> {
    use audit_log_streams::Column;
    use sea_orm::ExprTrait as _;
    let rows: Vec<StoredStreamRow> = audit_log_streams::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::Type,
            Column::Url,
            Column::TokenEncrypted,
        ])
        .expr(Expr::col((audit_log_streams::Entity, Column::Settings)).cast_as("text"))
        .columns([
            Column::ConsecutiveFailures,
            Column::LastAttemptAt,
            Column::CreatedAt,
            Column::CursorCreatedAt,
            Column::CursorId,
        ])
        .filter(Column::Status.eq(ACTIVE))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| StoredStream {
            id: row.0,
            kind: row.1,
            url: row.2,
            token_encrypted: row.3,
            settings: row.4,
            consecutive_failures: row.5,
            last_attempt_at: row.6.map(iso_millis),
            cursor: Cursor {
                at: millis(row.8.unwrap_or(row.7)),
                has_at: row.8.is_some(),
                id: row.9,
            },
        })
        .collect())
}

/// `audit_log_streams.status` of a stream that delivers.
const ACTIVE: &str = "active";

/// id, created at, entity type, entity id, action, description,
/// `changes::text`, performed by, performed by name, ip address, metadata.
type AuditRow = (
    String,
    PrimitiveDateTime,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<Value>,
);

/// `metadataString`: a metadata field when it is a non-empty string.
fn metadata_string(metadata: Option<&Value>, key: &str) -> Option<String> {
    metadata
        .and_then(|metadata| metadata.get(key))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// `readBatch(db, cursor, settledBefore)`: the rows strictly after the
/// cursor in `(ms(created_at), id)` order, oldest first, that are older than
/// `settled_before` (the time of the flush cut to the millisecond, less the
/// settle window), each with its `created_at` to the millisecond. The bound
/// is cut to the millisecond, so it never splits the rows of one: a
/// millisecond is read whole or not at all, and the cursor cannot stop
/// between two rows it orders by id.
async fn read_batch(
    db: &PgPool,
    cursor: &Cursor,
    settled_before: PrimitiveDateTime,
) -> Result<Vec<(PrimitiveDateTime, AuditStreamRow)>, DbErr> {
    use audit_logs::Column;
    use sea_orm::ExprTrait as _;
    let col = |column: Column| Expr::col((audit_logs::Entity, column));
    let ms = || {
        Expr::from(
            Func::cust("date_trunc")
                .arg("milliseconds")
                .arg(col(Column::CreatedAt)),
        )
    };
    let after = match &cursor.id {
        None => ms().gt(cursor.at),
        Some(id) => Expr::tuple([ms(), col(Column::Id)])
            .gt(Expr::tuple([Expr::val(cursor.at), Expr::val(id.as_str())])),
    };
    let rows: Vec<AuditRow> = audit_logs::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::CreatedAt,
            Column::EntityType,
            Column::EntityId,
            Column::Action,
            Column::Description,
        ])
        .expr(col(Column::Changes).cast_as("text"))
        .columns([
            Column::PerformedBy,
            Column::PerformedByName,
            Column::IpAddress,
            Column::Metadata,
        ])
        .filter(
            Condition::all()
                .add(Column::CreatedAt.gte(cursor.at))
                .add(Column::CreatedAt.lt(settled_before))
                .add(after),
        )
        .order_by(ms(), Order::Asc)
        .order_by(Column::Id, Order::Asc)
        .limit(u64::try_from(AUDIT_STREAM_BATCH_SIZE).unwrap_or(u64::MAX))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let metadata = row.10.as_ref();
            let row_at = AuditStreamRow {
                id: row.0,
                created_at: iso_millis(row.1),
                entity_type: row.2,
                entity_id: row.3,
                action: row.4,
                description: row.5,
                changes: row.6,
                performed_by: row.7,
                performed_by_name: row.8,
                ip_address: row.9,
                workspace_id: metadata_string(metadata, "workspaceId"),
                source: metadata_string(metadata, "source"),
            };
            (millis(row.1), row_at)
        })
        .collect())
}

/// A failed delivery: the error, one more failure, and the stream switched
/// off at [`AUDIT_STREAM_DISABLE_AFTER_FAILURES`].
async fn record_failure(
    db: &PgPool,
    stream_id: &str,
    now: PrimitiveDateTime,
    error: &str,
    failures: i32,
) -> Result<(), DbErr> {
    use audit_log_streams::Column;
    let mut update = audit_log_streams::Entity::update_many()
        .col_expr(Column::LastAttemptAt, Expr::value(now))
        .col_expr(Column::LastError, Expr::value(error.to_owned()))
        .col_expr(Column::ConsecutiveFailures, Expr::value(failures));
    // `status = case when … then 'disabled' else status end`
    if failures >= AUDIT_STREAM_DISABLE_AFTER_FAILURES {
        update = update.col_expr(Column::Status, Expr::value("disabled"));
    }
    update
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(stream_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// The cursor moved past a delivered batch (`to`), if it still stands where
/// this flush read it (`from`, `sameCursor`). Whether it moved.
async fn move_cursor(
    db: &PgPool,
    stream_id: &str,
    from: &Cursor,
    to: &Cursor,
    delivered: usize,
    now: PrimitiveDateTime,
) -> Result<bool, DbErr> {
    use audit_log_streams::Column;
    use sea_orm::ExprTrait as _;
    let same_at = if from.has_at {
        Column::CursorCreatedAt.eq(from.at)
    } else {
        Column::CursorCreatedAt.is_null()
    };
    let same_id = match &from.id {
        None => Column::CursorId.is_null(),
        Some(id) => Column::CursorId.eq(id.as_str()),
    };
    let delivered_count = Expr::col((audit_log_streams::Entity, Column::DeliveredCount))
        .add(i32::try_from(delivered).unwrap_or(i32::MAX));
    let moved = audit_log_streams::Entity::update_many()
        .col_expr(Column::CursorCreatedAt, Expr::value(to.at))
        .col_expr(Column::CursorId, Expr::value(to.id.clone()))
        .col_expr(Column::LastDeliveredAt, Expr::value(now))
        .col_expr(Column::LastAttemptAt, Expr::value(now))
        .col_expr(Column::LastError, Expr::value(None::<String>))
        .col_expr(Column::ConsecutiveFailures, Expr::value(0))
        .col_expr(Column::DeliveredCount, delivered_count)
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(
            Condition::all()
                .add(Column::Id.eq(stream_id))
                .add(same_at)
                .add(same_id),
        )
        .exec(&orm(db))
        .await?;
    Ok(moved.rows_affected > 0)
}

/// `flushStream(db, stream, options, now)`.
async fn flush_stream(
    db: &PgPool,
    sender: &AuditStreamSender,
    stream: &StoredStream,
    options: &FlushOptions<'_>,
) -> Result<FlushStreamResult, DbErr> {
    let mut result = FlushStreamResult {
        stream_id: stream.id.clone(),
        outcome: FlushOutcome::Idle,
        delivered: 0,
        error: None,
    };
    let now = weldsuite_events::iso_timestamp(options.now);
    let now_at = weldsuite_db::utc_timestamp(options.now);

    // Still waiting after a failure.
    if stream.consecutive_failures > 0
        && let Some(last) = stream.last_attempt_at.as_deref().and_then(epoch_millis)
        && let Some(now_ms) = epoch_millis(&now)
        && now_ms - last < audit_stream_backoff_ms(stream.consecutive_failures)
    {
        result.outcome = FlushOutcome::Backoff;
        return Ok(result);
    }

    let token = open_token(stream.token_encrypted.as_deref(), options.keyring);
    let destination = AuditStreamDestination {
        kind: &stream.kind,
        url: &stream.url,
        settings: stream.settings.as_deref(),
    };
    // The cursor as this flush knows it (`cursor`, `current`).
    let mut cursor = stream.cursor.clone();
    let mut consecutive_failures = stream.consecutive_failures;

    for _ in 0..AUDIT_STREAM_MAX_REQUESTS_PER_FLUSH {
        let batch = read_batch(db, &cursor, now_at - AUDIT_STREAM_SETTLE).await?;
        let Some((last_at, last)) = batch.last() else {
            break;
        };
        let events: Vec<AuditStreamEvent> = batch
            .iter()
            .map(|(_, row)| build_audit_stream_event(row, options.workspace_id))
            .collect();
        let failure = match &token {
            Ok(token) => {
                let sent = sender.post(&destination, token.as_deref(), &events).await;
                (!sent.ok).then(|| sent.error.unwrap_or_default())
            }
            Err(error) => Some((*error).to_owned()),
        };

        if let Some(error) = failure {
            let failures = consecutive_failures + 1;
            record_failure(db, &stream.id, now_at, &error, failures).await?;
            result.outcome = FlushOutcome::Failed;
            result.error = Some(error);
            return Ok(result);
        }

        let delivered = Cursor {
            at: *last_at,
            has_at: true,
            id: Some(last.id.clone()),
        };
        let moved = move_cursor(db, &stream.id, &cursor, &delivered, batch.len(), now_at).await?;
        result.outcome = FlushOutcome::Delivered;
        result.delivered += batch.len();
        // Another flush moved the cursor under us: leave it to that flush.
        if !moved {
            break;
        }
        cursor = delivered;
        consecutive_failures = 0;
        if batch.len() < AUDIT_STREAM_BATCH_SIZE {
            break;
        }
    }
    Ok(result)
}

/// `hasActiveAuditLogStreams(db)`: whether the workspace behind `db` has a
/// stream to deliver to. One small query, so a caller can skip the wait for
/// the settle window when there is none. A failed query reads as "none" (the
/// streams keep their cursor and catch up on a later flush).
pub async fn has_active_audit_log_streams(db: &PgPool) -> bool {
    audit_log_streams::Entity::find()
        .select_only()
        .column(audit_log_streams::Column::Id)
        .filter(audit_log_streams::Column::Status.eq(ACTIVE))
        .into_tuple::<String>()
        .one(&orm(db))
        .await
        .is_ok_and(|found| found.is_some())
}

/// `flushAuditLogStreams(db, options)`: deliver what has settled in
/// `audit_logs` (rows older than [`AUDIT_STREAM_SETTLE`]) to every active
/// stream of the workspace behind `db`. A failure of one stream never
/// touches another; nothing fails into the caller. Cheap when the workspace
/// has no streams: one small query.
pub async fn flush_audit_log_streams(
    db: &PgPool,
    sender: &AuditStreamSender,
    options: &FlushOptions<'_>,
) -> Vec<FlushStreamResult> {
    let Ok(streams) = active_streams(db).await else {
        return Vec::new();
    };
    let mut results = Vec::with_capacity(streams.len());
    for stream in streams {
        let result = flush_stream(db, sender, &stream, options)
            .await
            .unwrap_or_else(|_| FlushStreamResult {
                stream_id: stream.id.clone(),
                outcome: FlushOutcome::Failed,
                delivered: 0,
                error: Some("Delivery failed".to_owned()),
            });
        results.push(result);
    }
    results
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    const TOKEN: &str = "tok-super-secret-123";

    fn row() -> AuditStreamRow {
        AuditStreamRow {
            id: "audit_1".to_owned(),
            created_at: "2026-11-01T10:00:00.123Z".to_owned(),
            entity_type: "customer".to_owned(),
            entity_id: "cus_1".to_owned(),
            action: "updated".to_owned(),
            description: "Customer updated".to_owned(),
            changes: Some(r#"{"name": {"to": "B", "from": "A"}}"#.to_owned()),
            performed_by: Some("user_1".to_owned()),
            performed_by_name: Some("Ann".to_owned()),
            ip_address: Some("10.1.1.1".to_owned()),
            workspace_id: Some("ws_1".to_owned()),
            source: Some("user".to_owned()),
        }
    }

    const EVENT: &str = r#"{"id":"audit_1","timestamp":"2026-11-01T10:00:00.123Z","workspaceId":"ws_1","action":"updated","entityType":"customer","entityId":"cus_1","description":"Customer updated","actor":{"id":"user_1","name":"Ann"},"source":"user","changes":{"name":{"to":"B","from":"A"}},"ipAddress":"10.1.1.1"}"#;

    fn destination<'a>(kind: &'a str, settings: Option<&'a str>) -> AuditStreamDestination<'a> {
        AuditStreamDestination {
            kind,
            url: "https://s.example.com/in",
            settings,
        }
    }

    fn header(name: &str, value: &str) -> (String, String) {
        (name.to_owned(), value.to_owned())
    }

    #[test]
    fn an_event_is_what_json_stringify_writes() {
        assert_eq!(build_audit_stream_event(&row(), None).json(), EVENT);

        // Nothing the row lacks is made up; the fallback workspace fills in.
        let bare = AuditStreamRow {
            changes: None,
            performed_by: None,
            performed_by_name: None,
            ip_address: None,
            workspace_id: None,
            source: None,
            description: "Line 1\n\"quoted\" \u{1f600} \u{7}".to_owned(),
            ..row()
        };
        assert_eq!(
            build_audit_stream_event(&bare, Some("org_9")).json(),
            r#"{"id":"audit_1","timestamp":"2026-11-01T10:00:00.123Z","workspaceId":"org_9","action":"updated","entityType":"customer","entityId":"cus_1","description":"Line 1\n\"quoted\" 😀 \u0007","actor":{"id":null,"name":null},"source":null,"changes":null,"ipAddress":null}"#
        );
        assert!(
            build_audit_stream_event(&bare, None)
                .json()
                .contains(r#""workspaceId":null"#)
        );
    }

    #[test]
    fn changes_keep_javascripts_key_order_and_numbers() {
        // As Postgres prints `jsonb`: keys by length, numbers as stored.
        let changes = r#"{"10": {"to": 1.0, "from": 1e3}, "2": null, "tags": ["a", {"z": true, "b": 12345678901234567890}], "amount": {"to": 1200.50, "from": -0.0}}"#;
        let event = build_audit_stream_event(
            &AuditStreamRow {
                changes: Some(changes.to_owned()),
                ..row()
            },
            None,
        );
        assert!(event.json().contains(
            r#""changes":{"2":null,"10":{"to":1,"from":1000},"tags":["a",{"z":true,"b":12345678901234567000}],"amount":{"to":1200.5,"from":0}},"#
        ));
        // A column holding JSON `null` reads as null.
        let null = build_audit_stream_event(
            &AuditStreamRow {
                changes: Some("null".to_owned()),
                ..row()
            },
            None,
        );
        assert!(null.json().contains(r#""changes":null,"#));
    }

    #[test]
    fn the_test_event_is_the_workers() {
        let now = OffsetDateTime::parse("2026-11-09T08:30:00.25Z", &Rfc3339).expect("a date");
        assert_eq!(
            build_test_audit_stream_event(now, Some("ws_test")).json(),
            r#"{"id":"audit_test","timestamp":"2026-11-09T08:30:00.250Z","workspaceId":"ws_test","action":"test","entityType":"audit_log_stream","entityId":"audit_log_stream_test","description":"Test event from WeldSuite: this audit log stream is reachable.","actor":{"id":null,"name":"WeldSuite"},"source":"system","changes":null,"ipAddress":null}"#
        );
    }

    #[test]
    fn splunk_hec_sends_one_envelope_per_line() {
        let events = [
            build_audit_stream_event(&row(), None),
            build_audit_stream_event(
                &AuditStreamRow {
                    id: "audit_2".to_owned(),
                    ..row()
                },
                None,
            ),
        ];
        let request =
            build_audit_stream_request(&destination("splunk_hec", None), Some(TOKEN), &events);
        assert_eq!(
            request.headers,
            [
                header("Content-Type", "application/json"),
                header("Authorization", "Splunk tok-super-secret-123"),
            ]
        );
        let lines: Vec<&str> = request.body.split('\n').collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[0],
            format!(
                r#"{{"time":1793527200.123,"host":"weldsuite","source":"weldsuite:audit","sourcetype":"_json","event":{EVENT}}}"#
            )
        );

        let custom = build_audit_stream_request(
            &destination(
                "splunk_hec",
                Some(r#"{"host": "h", "index": "sec", "source": "s", "sourcetype": "st"}"#),
            ),
            None,
            &events[..1],
        );
        assert_eq!(custom.headers, [header("Content-Type", "application/json")]);
        assert_eq!(
            custom.body,
            format!(
                r#"{{"time":1793527200.123,"host":"h","source":"s","sourcetype":"st","index":"sec","event":{EVENT}}}"#
            )
        );
        // An empty setting falls back to the default (`||`).
        let empty = build_audit_stream_request(
            &destination("splunk_hec", Some(r#"{"host": "", "index": ""}"#)),
            Some(""),
            &events[..1],
        );
        assert!(empty.body.contains(r#""host":"weldsuite""#));
        assert!(!empty.body.contains("index"));
        assert_eq!(empty.headers, [header("Content-Type", "application/json")]);
    }

    #[test]
    fn http_sends_a_document_or_lines() {
        let events = [
            build_audit_stream_event(&row(), None),
            build_audit_stream_event(&row(), None),
        ];
        let json = build_audit_stream_request(&destination("http", None), Some(TOKEN), &events);
        assert_eq!(
            json.headers,
            [
                header("Content-Type", "application/json"),
                header("Authorization", TOKEN),
            ]
        );
        assert_eq!(json.body, format!(r#"{{"events":[{EVENT},{EVENT}]}}"#));

        let ndjson = build_audit_stream_request(
            &destination(
                "http",
                Some(r#"{"format": "ndjson", "authHeader": "X-Api-Key"}"#),
            ),
            Some(TOKEN),
            &events,
        );
        assert_eq!(
            ndjson.headers,
            [
                header("Content-Type", "application/x-ndjson"),
                header("X-Api-Key", TOKEN),
            ]
        );
        assert_eq!(ndjson.body, format!("{EVENT}\n{EVENT}"));

        let open = build_audit_stream_request(&destination("http", Some("null")), None, &events);
        assert_eq!(open.headers, [header("Content-Type", "application/json")]);
    }

    #[test]
    fn the_hec_time_is_epoch_seconds_with_milliseconds() {
        assert_eq!(epoch_seconds(Some(1_793_527_200_123)), "1793527200.123");
        assert_eq!(epoch_seconds(Some(1_793_527_200_000)), "1793527200");
        assert_eq!(epoch_seconds(Some(1_793_527_200_100)), "1793527200.1");
        assert_eq!(epoch_seconds(Some(0)), "0");
        assert_eq!(epoch_seconds(Some(-1)), "-0.001");
        assert_eq!(epoch_seconds(None), "null");
        assert_eq!(
            epoch_millis("2026-11-01T10:00:00.123Z"),
            Some(1_793_527_200_123)
        );
        assert_eq!(epoch_millis("yesterday"), None);
    }

    #[test]
    fn backoff_doubles_to_an_hour() {
        let waits: Vec<i64> = [1, 2, 3, 5, 6, 20, 40]
            .into_iter()
            .map(audit_stream_backoff_ms)
            .collect();
        assert_eq!(
            waits,
            [
                120_000, 240_000, 480_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000
            ]
        );
    }

    #[test]
    fn excerpts_lose_the_token_and_their_whitespace() {
        assert_eq!(
            scrub(
                "  Invalid\ttoken tok-super-secret-123 \n\n seen: tok-super-secret-123 ",
                Some(TOKEN)
            ),
            "Invalid token *** seen: ***"
        );
        assert_eq!(scrub("a  b", None), "a b");
        assert_eq!(scrub(&"x".repeat(300), Some("")).len(), 200);
    }

    /// One request a transport was handed.
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Sent {
        url: String,
        headers: Vec<(String, String)>,
        body: String,
    }

    /// Answers every call with one answer and keeps what was sent.
    struct Recorder {
        answer: Result<StreamAnswer, StreamFailure>,
        calls: Mutex<Vec<Sent>>,
    }

    impl Recorder {
        fn answering(answer: Result<StreamAnswer, StreamFailure>) -> Arc<Self> {
            Arc::new(Self {
                answer,
                calls: Mutex::new(Vec::new()),
            })
        }

        fn status(status: u16, text: &str) -> Arc<Self> {
            Self::answering(Ok(StreamAnswer {
                status,
                text: text.to_owned(),
            }))
        }

        fn calls(&self) -> Vec<Sent> {
            self.calls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }

    impl StreamTransport for Recorder {
        fn post<'a>(
            &'a self,
            call: StreamCall<'a>,
        ) -> BoxFuture<'a, Result<StreamAnswer, StreamFailure>> {
            self.calls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(Sent {
                    url: call.url.to_owned(),
                    headers: call.headers.to_vec(),
                    body: call.body.to_owned(),
                });
            Box::pin(std::future::ready(self.answer.clone()))
        }
    }

    fn keyring() -> Keyring {
        Keyring {
            v1: None,
            v2: Some("a".repeat(64)),
        }
    }

    async fn test_of(
        transport: Arc<Recorder>,
        url: &str,
        token: Option<&str>,
    ) -> AuditStreamSendResult {
        let keys = keyring();
        let sealed = token.map(|token| weldsuite_db::encrypt_field(token, &keys).expect("sealed"));
        let now = OffsetDateTime::parse("2026-11-09T08:30:00Z", &Rfc3339).expect("a date");
        AuditStreamSender::with_transport(transport, false)
            .send_test(
                &AuditStreamDestination {
                    kind: "splunk_hec",
                    url,
                    settings: None,
                },
                sealed.as_deref(),
                &keys,
                Some("ws_1"),
                now,
            )
            .await
    }

    #[tokio::test]
    async fn a_test_sends_one_event_with_the_stored_token() {
        let transport = Recorder::status(200, "{\"text\":\"Success\"}");
        let url = "https://splunk.example.com:8088/services/collector/event";
        let result = test_of(Arc::clone(&transport), url, Some(TOKEN)).await;
        assert!(result.ok);
        assert_eq!(result.status, Some(200));
        assert_eq!(result.error, None);
        let calls = transport.calls();
        assert_eq!(calls.len(), 1);
        let sent = &calls[0];
        assert_eq!(sent.url, url);
        assert_eq!(
            sent.headers[1],
            header("Authorization", "Splunk tok-super-secret-123")
        );
        assert!(
            sent.body
                .starts_with(r#"{"time":1794213000,"host":"weldsuite""#)
        );
        assert!(
            sent.body
                .contains(r#""action":"test","entityType":"audit_log_stream""#)
        );
    }

    #[tokio::test]
    async fn a_refusal_is_reported_without_the_token() {
        let refused = test_of(
            Recorder::status(401, "Invalid token tok-super-secret-123"),
            "https://s.example.com/in",
            Some(TOKEN),
        )
        .await;
        assert!(!refused.ok);
        assert_eq!(refused.status, Some(401));
        assert_eq!(
            refused.error.as_deref(),
            Some("HTTP 401: Invalid token ***")
        );

        let bare = test_of(
            Recorder::status(503, " \n "),
            "https://s.example.com/in",
            None,
        )
        .await;
        assert_eq!(bare.error.as_deref(), Some("HTTP 503"));

        // A redirect is never followed: it is the answer.
        let moved = test_of(Recorder::status(302, ""), "https://s.example.com/in", None).await;
        assert_eq!((moved.ok, moved.status), (false, Some(302)));
        assert_eq!(moved.error.as_deref(), Some("HTTP 302"));
    }

    #[tokio::test]
    async fn failures_read_like_the_workers() {
        let unreachable = test_of(
            Recorder::answering(Err(StreamFailure::Failed(
                "ECONNREFUSED tok-super-secret-123".to_owned(),
            ))),
            "https://s.example.com/in",
            Some(TOKEN),
        )
        .await;
        assert_eq!(unreachable.status, None);
        assert_eq!(
            unreachable.error.as_deref(),
            Some("Request failed: ECONNREFUSED ***")
        );

        let silent = test_of(
            Recorder::answering(Err(StreamFailure::Failed(String::new()))),
            "https://s.example.com/in",
            None,
        )
        .await;
        assert_eq!(silent.error.as_deref(), Some("Request failed"));

        let slow = test_of(
            Recorder::answering(Err(StreamFailure::TimedOut)),
            "https://s.example.com/in",
            None,
        )
        .await;
        assert_eq!(slow.error.as_deref(), Some("Timed out after 10 s"));
    }

    #[tokio::test]
    async fn an_unsafe_url_or_an_unreadable_token_is_never_sent() {
        let transport = Recorder::status(200, "");
        let private = test_of(Arc::clone(&transport), "https://10.1.2.3/in", None).await;
        assert_eq!(
            private.error.as_deref(),
            Some("The URL points at a private or local address")
        );
        let plain = test_of(Arc::clone(&transport), "http://s.example.com/in", None).await;
        assert_eq!(
            plain.error.as_deref(),
            Some("The URL must start with https://")
        );

        let now = OffsetDateTime::parse("2026-11-09T08:30:00Z", &Rfc3339).expect("a date");
        let sealed_elsewhere = AuditStreamSender::with_transport(transport.clone(), false)
            .send_test(
                &destination("http", None),
                Some("v2:00:00"),
                &keyring(),
                None,
                now,
            )
            .await;
        assert_eq!(
            sealed_elsewhere.error.as_deref(),
            Some("The stored token cannot be decrypted; enter it again")
        );
        assert_eq!(transport.calls(), Vec::new());

        // With private networks allowed the URL is not judged.
        let allowed = AuditStreamSender::with_transport(transport.clone(), true)
            .send_test(
                &AuditStreamDestination {
                    kind: "http",
                    url: "https://10.1.2.3/in",
                    settings: None,
                },
                None,
                &keyring(),
                None,
                now,
            )
            .await;
        assert!(allowed.ok);
        assert_eq!(transport.calls().len(), 1);
    }

    #[tokio::test]
    async fn the_client_refuses_a_private_literal_and_follows_no_redirect() {
        let http = AuditStreamHttp::new(false).expect("a client");
        let refused = http
            .post(StreamCall {
                url: "https://127.0.0.1:1/in",
                headers: &[],
                body: "{}",
            })
            .await;
        assert_eq!(
            refused,
            Err(StreamFailure::Failed(PRIVATE_ADDRESS.to_owned()))
        );
        let resolved = http
            .post(StreamCall {
                url: "https://localhost:1/in",
                headers: &[],
                body: "{}",
            })
            .await;
        assert_eq!(
            resolved,
            Err(StreamFailure::Failed(PRIVATE_ADDRESS.to_owned()))
        );
    }
}
