//! Small shared pieces: timestamps, query strings, list envelopes, the chat
//! rate limiter (`services/chat/rate-limit.ts`).

use std::collections::HashMap;
use std::time::Duration;

use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::{List, Pagination};

use crate::access::Caller;
use crate::ChatState;

/// `new Date()` as Drizzle writes it (UTC, milliseconds).
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `Date.now()`.
pub(crate) fn now_ms() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

/// `c.req.query()`: the first value of each key.
pub(crate) fn query_map(raw: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (key, value) in form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        out.entry(key.into_owned()).or_insert_with(|| value.into_owned());
    }
    out
}

/// `Number.parseInt(raw, 10)`: `None` for NaN.
pub(crate) fn js_parse_int(raw: &str) -> Option<i64> {
    let rest = raw.trim_start();
    let (negative, rest) = match rest.as_bytes().first() {
        Some(b'-') => (true, &rest[1..]),
        Some(b'+') => (false, &rest[1..]),
        _ => (false, rest),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let value: i64 = digits.parse().unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

/// `Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100)`.
pub(crate) fn list_limit(raw: Option<&String>) -> i64 {
    raw.filter(|r| !r.is_empty())
        .map_or(25, |r| js_parse_int(r).unwrap_or(25))
        .min(100)
}

/// `list(c, rows, cursorPagination(totalCount, hasMore, cursor))`.
pub(crate) fn list_response(
    rows: Vec<Value>,
    total: i64,
    has_more: bool,
    cursor: Option<String>,
) -> Response {
    List::new(
        rows,
        Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response()
}

/// The `limit + 1` probe: the page, whether there is more, the next cursor.
pub(crate) fn page(mut rows: Vec<Value>, limit: i64) -> (Vec<Value>, bool, Option<String>) {
    let limit = usize::try_from(limit.max(0)).unwrap_or(0);
    let has_more = rows.len() > limit;
    if has_more {
        rows.truncate(limit);
    }
    let cursor = if has_more {
        rows.last()
            .and_then(|r| r["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    (rows, has_more, cursor)
}

/// A row's `createdAt` as Drizzle hands it back (milliseconds), for a
/// keyset cursor: the value the TypeScript route binds.
pub(crate) fn ms_timestamp(text: &str) -> String {
    // `::text` writes a space between date and time; `to_jsonb` a `T`.
    let iso = if text.as_bytes().get(10) == Some(&b' ') {
        format!("{}T{}", &text[..10], &text[11..])
    } else {
        text.to_owned()
    };
    weldsuite_db::js_timestamp(&iso).unwrap_or(iso)
}

/// `consumeChatRateLimit(env, key, max)`: a fixed one-minute window in the
/// workspace cache. No cache, or a cache that fails, allows the request.
pub(crate) async fn consume_rate_limit(
    caller: &Caller,
    state: &ChatState,
    key: &str,
    max: i64,
) -> bool {
    const WINDOW_MS: i64 = 60_000;
    let Some(cache) = caller.cache(state) else {
        return true;
    };
    let storage_key = format!("chat:rl:{key}");
    let run = async {
        let raw = cache.get_boxed(&storage_key).await?;
        let state: Option<Value> = raw.and_then(|text| serde_json::from_str(&text).ok());
        let state = state.filter(Value::is_object);
        let now = now_ms();
        let mut count = state
            .as_ref()
            .and_then(|s| s["count"].as_f64())
            .unwrap_or(0.0);
        let mut reset_at = state
            .as_ref()
            .and_then(|s| s["resetAt"].as_f64())
            .unwrap_or(now as f64 + WINDOW_MS as f64);
        #[allow(clippy::cast_precision_loss)]
        if now as f64 >= reset_at {
            count = 0.0;
            reset_at = (now + WINDOW_MS) as f64;
        }
        #[allow(clippy::cast_precision_loss)]
        if count >= max as f64 {
            return Ok::<bool, weldsuite_ports::PortError>(false);
        }
        count += 1.0;
        #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let ttl = ((reset_at - now as f64) / 1000.0).ceil().max(1.0) as u64;
        let text = json!({
            "count": weldsuite_chat_domain::text::js_number(count),
            "resetAt": weldsuite_chat_domain::text::js_number(reset_at),
        })
        .to_string();
        cache
            .put_boxed(&storage_key, &text, Some(Duration::from_secs(ttl)))
            .await?;
        Ok(true)
    };
    match run.await {
        Ok(allowed) => allowed,
        Err(error) => {
            tracing::error!(%error, "[chat-rate-limit] failed, allowing request");
            true
        }
    }
}
