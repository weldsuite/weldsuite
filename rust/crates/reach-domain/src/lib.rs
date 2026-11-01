//! `@weldsuite/reach-domain` (`packages/domains/reach`): WeldReach's
//! campaigns, enrollments, prospects, lists, suppressions, the reply inbox,
//! the overview, the sending window, template rendering and the warmup pool,
//! as reach-api and the public API (external-api, mcp-server) share them on
//! Global.
//!
//! Every function takes the tenant pool and reaches the outside world only
//! through the ports in this file ([`EventSink`] for entity events,
//! [`DuePort`] for the send sweep's due index) and the ones its module hands
//! it (outbound HTTP for DNS-over-HTTPS, the SMTP transport). Refusals are
//! [`ReachError`]s, which each route turns into the standard error envelope.

// JavaScript numbers (millisecond clocks, ratios, `Math.round`) are
// mirrored on purpose, and the ported functions keep the TypeScript shape.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::too_many_lines,
    clippy::similar_names,
    clippy::struct_excessive_bools,
    clippy::fn_params_excessive_bools,
    clippy::too_many_arguments,
    clippy::option_option,
    clippy::type_complexity
)]

pub mod access;
pub mod campaigns;
pub mod credentials;
pub mod dns;
pub mod domains;
pub mod enrollments;
pub mod error;
pub mod inbox;
pub mod lists;
pub mod mailboxes;
pub mod outbound;
pub mod overview;
pub mod prospects;
pub mod render;
pub mod schemas;
pub mod send_window;
pub mod smtp;
pub mod suppressions;
pub mod text;
pub mod validation;
pub mod warmup;
pub mod warmup_pool;

use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_ports::BoxFuture;

pub use error::{ReachError, ReachResult};

/// One entity event a domain function wants published (`ReachEvent`).
#[derive(Debug, Clone)]
pub struct ReachEvent {
    pub event: EventName,
    pub entity_id: String,
    pub data: Value,
    pub changes: Option<Map<String, Value>>,
}

impl ReachEvent {
    pub fn new(event: EventName, entity_id: impl Into<String>, data: Value) -> Self {
        Self {
            event,
            entity_id: entity_id.into(),
            data,
            changes: None,
        }
    }
}

/// Where entity events go (`ReachEventSink`). Called after the write.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: ReachEvent);
}

/// A sink that drops every event (`noEvents`).
#[derive(Debug, Clone, Copy, Default)]
pub struct NoEvents;

impl EventSink for NoEvents {
    fn emit(&self, _event: ReachEvent) {}
}

/// Wake the send sweep (`ReachDuePort`): this workspace has outreach due at
/// `at` (never in the past). The module maps it to the due index.
pub trait DuePort: Send + Sync {
    fn due(&self, at: OffsetDateTime) -> BoxFuture<'_, ()>;
}

/// `new Date()`: now, to the millisecond, as JavaScript keeps it.
pub fn now() -> OffsetDateTime {
    let now = OffsetDateTime::now_utc();
    now.replace_nanosecond(u32::from(now.millisecond()) * 1_000_000)
        .unwrap_or(now)
}

/// The conformance clock (`CONFORMANCE_NOW`), else [`now`].
pub fn now_or(fixed: Option<&str>) -> OffsetDateTime {
    fixed.and_then(parse_iso).unwrap_or_else(now)
}

/// `date.toISOString()`.
pub fn iso(at: OffsetDateTime) -> String {
    weldsuite_events::iso_timestamp(at)
}

/// An ISO timestamp (as `to_jsonb` and `toISOString()` write them).
pub fn parse_iso(text: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()
}

/// Milliseconds since the epoch (`date.getTime()`).
pub fn epoch_ms(at: OffsetDateTime) -> i64 {
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or_default()
}

/// The instant `ms` milliseconds after the epoch (`new Date(ms)`).
pub fn from_epoch_ms(ms: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// `to_jsonb` rows as Drizzle returns them (camelCase, ISO timestamps).
pub fn js_rows(rows: Vec<Value>) -> Vec<Value> {
    rows.into_iter().map(weldsuite_db::js_row).collect()
}

/// A text column of a row (`row.key`), `None` when null or missing.
pub fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// A text column of a row, `""` when null.
pub fn text_or_empty<'a>(row: &'a Value, key: &str) -> &'a str {
    text(row, key).unwrap_or_default()
}

/// A whole-number column of a row (0 when null).
pub fn int(row: &Value, key: &str) -> i64 {
    row.get(key)
        .and_then(|value| value.as_i64().or_else(|| value.as_f64().map(|f| f as i64)))
        .unwrap_or_default()
}

/// A column of a row as it is (`null` when missing).
pub fn field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// `{ ...row }` with the given keys removed (`omitSensitive`, a `{ id }` pick).
pub fn without(row: &Value, keys: &[&str]) -> Value {
    match row {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| !keys.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `[...new Set(values)]`: first occurrences, in order.
pub fn unique<T: PartialEq + Clone>(values: &[T]) -> Vec<T> {
    let mut out: Vec<T> = Vec::with_capacity(values.len());
    for value in values {
        if !out.contains(value) {
            out.push(value.clone());
        }
    }
    out
}

/// `str.slice(0, max)` in UTF-16 units, as JavaScript cuts strings.
pub fn js_slice(text: &str, max: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for ch in text.chars() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        out.push(ch);
    }
    out
}

/// `str.length` in UTF-16 units.
pub fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}
