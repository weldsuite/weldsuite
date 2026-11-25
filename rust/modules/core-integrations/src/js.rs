//! JavaScript semantics the routes rely on: query strings as Hono reads
//! them, untyped JSON "bags", truthiness, timestamps. The same as
//! WeldConnect's (`weldsuite-connect`), which keeps its own copy.

use serde_json::Value;
use weldsuite_kit::validation::query_values;

pub(crate) use weldsuite_desk_domain::workflow::shared::{js_number, js_string};

/// `c.req.query(name)` / `c.req.query()[name]`: the first value.
pub(crate) fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    query_values(query).get(name).and_then(|value| match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => items.first().and_then(Value::as_str).map(str::to_owned),
        _ => None,
    })
}

/// A query value, an empty one read as absent (`if (q.x)`).
pub(crate) fn query_truthy(query: Option<&str>, name: &str) -> Option<String> {
    query_param(query, name).filter(|value| !value.is_empty())
}

/// `parseLimit(q.limit, fallback, max)` as a SQL bind: one more row than the
/// page, to tell whether there is a next one.
pub(crate) fn page_limit(query: Option<&str>, fallback: u32, max: u32) -> i64 {
    i64::from(weldsuite_kit::parse_limit(
        query_param(query, "limit").as_deref(),
        fallback,
        max,
    ))
}

/// A JSON array as a slice, else empty (`Array.isArray(x) ? x : []`).
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `Math.max(1, …)`-free page slicing: the first `limit` rows and whether
/// there were more.
pub(crate) fn page(mut rows: Vec<Value>, limit: i64) -> (Vec<Value>, bool) {
    let limit = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    (rows, has_more)
}

/// The cursor of a page: the last row's `key` when there are more.
pub(crate) fn next_cursor(rows: &[Value], has_more: bool, key: &str) -> Option<String> {
    if !has_more {
        return None;
    }
    rows.last().and_then(|row| match row.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    })
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// Epoch milliseconds as `toISOString()` (WeldConnect's `cron::iso`).
pub(crate) fn iso(ms: i64) -> Option<String> {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).ok()?;
    Some(weldsuite_events::iso_timestamp(at))
}
