//! What the sales tax route groups share: the day, refusals, the audit
//! trail's changes, body reading (`isoDateSchema`, `percentSchema`) and the
//! list envelope.

use serde_json::{Map, Value, json};
use weldsuite_books_domain::http::{BooksState, Caller, Refusal};
use weldsuite_books_domain::sales_tax::route_helpers::{SetupFailure, setup_error};
use weldsuite_kit::validation::{Field, Issues, Presence};

/// The request's `new Date()`: the test's own clock when a conformance test
/// fakes it (`CONFORMANCE_NOW`, which only the test harness sets), else now.
pub(crate) fn now_of(caller: &Caller, state: &BooksState) -> jiff::Timestamp {
    caller
        .env(state, "CONFORMANCE_NOW")
        .and_then(|at| at.parse::<jiff::Timestamp>().ok())
        .unwrap_or_else(jiff::Timestamp::now)
}

/// `new Date().toISOString().slice(0, 10)` on the request's clock.
pub(crate) fn today(caller: &Caller, state: &BooksState) -> String {
    let at = now_of(caller, state).to_zoned(jiff::tz::TimeZone::UTC);
    format!("{:04}-{:02}-{:02}", at.year(), at.month(), at.day())
}

/// `todayIn(timeZone)`: the request's day in a time zone (UTC when unset or
/// unknown).
pub(crate) fn today_in(caller: &Caller, state: &BooksState, zone: Option<&str>) -> String {
    let tz = zone
        .filter(|z| !z.is_empty())
        .and_then(|z| jiff::tz::TimeZone::get(z).ok())
        .unwrap_or(jiff::tz::TimeZone::UTC);
    let at = now_of(caller, state).to_zoned(tz);
    format!("{:04}-{:02}-{:02}", at.year(), at.month(), at.day())
}

/// A setup refusal (`SalesTaxSetupError`) as the route answers it.
pub(crate) fn refuse(message: impl Into<String>, status: u16) -> Refusal {
    SetupFailure::Refused(setup_error(message, status)).into()
}

/// `Object.fromEntries(Object.entries(update).filter(k !== 'updatedAt')
/// .map(([k, v]) => [k, { old: row[k], new: v }]))`.
pub(crate) fn changes(update: &Map<String, Value>, row: &Value) -> Map<String, Value> {
    update
        .iter()
        .filter(|(key, _)| key.as_str() != "updatedAt")
        .map(|(key, value)| {
            (
                key.clone(),
                json!({ "old": row.get(key).cloned().unwrap_or(Value::Null), "new": value }),
            )
        })
        .collect()
}

/// `{ ...row, ...update }`.
pub(crate) fn merged(row: &Value, update: &Map<String, Value>) -> Value {
    let mut out = row.as_object().cloned().unwrap_or_default();
    for (key, value) in update {
        out.insert(key.clone(), value.clone());
    }
    Value::Object(out)
}

/// `/^\d{4}-\d{2}-\d{2}$/`.
pub(crate) fn is_iso_date_text(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// `isoDateSchema` with `presence`.
pub(crate) fn iso_date(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<String> {
    issues.pattern(
        body,
        key,
        presence,
        None,
        None,
        is_iso_date_text,
        "Use a date as YYYY-MM-DD",
    )
}

/// `percentSchema` (a number or a numeric string, 0 to 100) with
/// `presence`: the value, and whether its refinement failed (report it with
/// [`percent_refined`] once every other field is read).
pub(crate) fn percent(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> (Field<f64>, bool) {
    match issues.string_or_number(body, key, presence) {
        Field::Set(value) => {
            let number = match &value {
                Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
                Value::String(s) => weldsuite_books_domain::js::parse_float(s),
                _ => f64::NAN,
            };
            let ok = number.is_finite() && (0.0..=100.0).contains(&number);
            (Field::Set(number), !ok)
        }
        Field::Null => (Field::Null, false),
        Field::Absent => (Field::Absent, false),
    }
}

/// The failed refinement of a [`percent`] field.
pub(crate) fn percent_refined(issues: &mut Issues, key: &str, failed: bool) {
    if failed {
        issues.custom(key, "A rate is a percentage from 0 to 100");
    }
}

/// `value.toFixed(4)`.
pub(crate) fn fixed4(value: f64) -> String {
    weldsuite_books_domain::js::to_fixed(value, 4)
}

/// Put a `Field` read into a map: set, `null`, or left out.
pub(crate) fn keep<T: serde::Serialize>(out: &mut Map<String, Value>, key: &str, field: &Field<T>) {
    match field {
        Field::Set(value) => {
            out.insert(key.to_owned(), json!(value));
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

/// `Number(text)` of a numeric column (`"6.2500"` → 6.25).
pub(crate) fn number_of(value: &Value) -> f64 {
    weldsuite_books_domain::js::numeric(value)
}

/// A JSON number as JavaScript writes it.
pub(crate) fn num(value: f64) -> Value {
    weldsuite_books_domain::js::number_value(value)
}

/// `row[key]` as a string.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_changes() {
        assert!(is_iso_date_text("2026-01-31"));
        assert!(!is_iso_date_text("2026-1-31"));
        let row = json!({ "name": "A", "updatedAt": "x" });
        let mut update = Map::new();
        update.insert("updatedAt".into(), json!("y"));
        update.insert("name".into(), json!("B"));
        assert_eq!(
            Value::Object(changes(&update, &row)),
            json!({ "name": { "old": "A", "new": "B" } })
        );
        assert_eq!(merged(&row, &update)["name"], "B");
    }
}
