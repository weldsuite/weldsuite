//! JavaScript semantics the routes depend on: `new Date(text)`,
//! `Date#toISOString()`, `JSON.stringify` key order and number printing,
//! and IANA zone checks as `Intl.DateTimeFormat` makes them.

use serde_json::Value;
use time::OffsetDateTime;

/// One day in milliseconds.
pub(crate) use weldsuite_calendar_domain::js_dates::DAY_MS;

// `new Date(text)`: shared with personal WeldCalendar (`weldsuite_calendar_domain::js_dates`).
pub(crate) use weldsuite_calendar_domain::js_dates::{parse_date, time_zone};

/// `new Date(millis).toISOString()`.
pub(crate) fn iso(millis: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    weldsuite_events::iso_timestamp(at)
}

/// Milliseconds of an ISO timestamp the database handed back (`toISOString`
/// form, as `js_row` writes it).
pub(crate) fn millis_of(value: &Value) -> Option<i64> {
    value.as_str().and_then(parse_date)
}

/// Now, in milliseconds (`Date.now()`).
pub(crate) fn now_ms() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}

/// Whether `Intl.DateTimeFormat` accepts `zone` (`isValidTimeZone`): an IANA
/// name (case-insensitive) or `UTC`, at most 50 characters.
pub(crate) fn is_valid_time_zone(zone: &str) -> bool {
    if zone.is_empty() || zone.encode_utf16().count() > 50 {
        return false;
    }
    time_zone(zone).is_some()
}

/// `validTimeZoneOrUndefined`.
pub(crate) fn valid_zone(zone: Option<&str>) -> Option<String> {
    zone.filter(|zone| is_valid_time_zone(zone))
        .map(str::to_owned)
}

/// A number as `JSON.stringify` and `String()` print it: integral values
/// without a fraction.
pub(crate) fn js_number(value: &serde_json::Number) -> Value {
    if value.is_i64() || value.is_u64() {
        return Value::Number(value.clone());
    }
    let float = value.as_f64().unwrap_or(f64::NAN);
    #[allow(clippy::cast_possible_truncation)]
    if float.is_finite() && float.fract() == 0.0 && float.abs() < 9.0e15 {
        return Value::from(float as i64);
    }
    Value::Number(value.clone())
}

/// A JSON value with its numbers as JavaScript writes them (for `jsonb`).
pub(crate) fn js_value(value: &Value) -> Value {
    match value {
        Value::Number(number) => js_number(number),
        Value::Array(items) => Value::Array(items.iter().map(js_value).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), js_value(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `String(value)` for what a JSON body holds.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number(number).to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// An object in JavaScript's key order (insertion order), for
/// `JSON.stringify`.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Ordered(pub(crate) Vec<(String, OrderedValue)>);

/// A JSON value whose objects keep their key order.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OrderedValue {
    Plain(Value),
    Object(Ordered),
    Array(Vec<OrderedValue>),
}

impl Ordered {
    pub(crate) fn push(&mut self, key: &str, value: OrderedValue) {
        if let Some(slot) = self.0.iter_mut().find(|(k, _)| k == key) {
            slot.1 = value;
        } else {
            self.0.push((key.to_owned(), value));
        }
    }

    pub(crate) fn plain(&mut self, key: &str, value: Value) {
        self.push(key, OrderedValue::Plain(value));
    }

    pub(crate) fn get(&self, key: &str) -> Option<&OrderedValue> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// The same object as a `serde_json` value (keys sorted; for responses,
    /// events and the database, where order does not matter).
    pub(crate) fn to_value(&self) -> Value {
        Value::Object(
            self.0
                .iter()
                .map(|(key, value)| (key.clone(), value.to_value()))
                .collect(),
        )
    }

    /// `JSON.stringify(object)`.
    pub(crate) fn stringify(&self) -> String {
        let mut out = String::from("{");
        for (index, (key, value)) in self.0.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&Value::String(key.clone()).to_string());
            out.push(':');
            out.push_str(&value.stringify());
        }
        out.push('}');
        out
    }
}

impl OrderedValue {
    pub(crate) fn to_value(&self) -> Value {
        match self {
            Self::Plain(value) => value.clone(),
            Self::Object(object) => object.to_value(),
            Self::Array(items) => Value::Array(items.iter().map(Self::to_value).collect()),
        }
    }

    fn stringify(&self) -> String {
        match self {
            Self::Plain(value) => js_value(value).to_string(),
            Self::Object(object) => object.stringify(),
            Self::Array(items) => format!(
                "[{}]",
                items
                    .iter()
                    .map(Self::stringify)
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(text: &str) -> Option<String> {
        parse_date(text).map(iso)
    }

    #[test]
    fn dates_parse_like_v8_in_utc() {
        assert_eq!(d("2030-02-30").as_deref(), Some("2030-03-02T00:00:00.000Z"));
        assert_eq!(
            d("2030-02-28T24:00").as_deref(),
            Some("2030-03-01T00:00:00.000Z")
        );
        assert_eq!(d("2030-02-28T24:00:01"), None);
        assert_eq!(
            d("2030-03-01 10:00").as_deref(),
            Some("2030-03-01T10:00:00.000Z")
        );
        assert_eq!(d("2030-03-01T10"), None);
        assert_eq!(
            d("2030-03-01t10:00z").as_deref(),
            Some("2030-03-01T10:00:00.000Z")
        );
        assert_eq!(d("2030-3-1").as_deref(), Some("2030-03-01T00:00:00.000Z"));
        assert_eq!(d("2030/03/01").as_deref(), Some("2030-03-01T00:00:00.000Z"));
        assert_eq!(d("2030").as_deref(), Some("2030-01-01T00:00:00.000Z"));
        assert_eq!(d("2030-03").as_deref(), Some("2030-03-01T00:00:00.000Z"));
        assert_eq!(
            d("+002030-03-01").as_deref(),
            Some("2030-03-01T00:00:00.000Z")
        );
        assert_eq!(
            d("2030-03-01T10:00:00.123456Z").as_deref(),
            Some("2030-03-01T10:00:00.123Z")
        );
        assert_eq!(
            d("2030-03-01T10:00:00+0100").as_deref(),
            Some("2030-03-01T09:00:00.000Z")
        );
        assert_eq!(d("2030-03-01T10:00:00+01"), None);
        assert_eq!(
            d("  2030-03-01").as_deref(),
            Some("2030-03-01T00:00:00.000Z")
        );
        assert_eq!(d("not-a-date"), None);
        assert_eq!(d("2030-13-01"), None);
        assert_eq!(d("2030-03-01T10:00:60"), None);
        assert_eq!(d("2030-03-01T25:00"), None);
        assert_eq!(d("2030-03-01T10:00:00.Z"), None);
        assert_eq!(
            d("2030-03-01T10:00Z").as_deref(),
            Some("2030-03-01T10:00:00.000Z")
        );
        assert_eq!(
            d("1969-12-31T23:59:59.999Z").as_deref(),
            Some("1969-12-31T23:59:59.999Z")
        );
    }

    #[test]
    fn zones_are_checked_like_intl() {
        assert!(is_valid_time_zone("Europe/Amsterdam"));
        assert!(is_valid_time_zone("UTC"));
        assert!(!is_valid_time_zone("Mars/Olympus"));
        assert!(!is_valid_time_zone("nope"));
        assert!(!is_valid_time_zone(""));
    }

    #[test]
    fn objects_stringify_in_insertion_order() {
        let mut object = Ordered::default();
        object.plain("id", Value::from("evt_1"));
        object.plain("title", Value::from("A"));
        object.plain("minutes", serde_json::json!(15.0));
        assert_eq!(
            object.stringify(),
            r#"{"id":"evt_1","title":"A","minutes":15}"#
        );
    }
}
