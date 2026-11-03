//! `lib/present.ts`: an API answer as text an assistant can read out. Records
//! become labelled lines with their identifiers held back in an HTML comment;
//! lists one line per row; anything else indented JSON.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::js::{Order, ordered, string_of, stringify, stringify_pretty};

/// Bookkeeping columns no reader needs.
const DROPPED_FIELDS: [&str; 4] = ["deletedAt", "workspaceId", "searchVector", "tsv"];

/// Where a record's human label is looked for, in order.
const LABEL_FIELDS: [&str; 11] = [
    "name",
    "fullName",
    "title",
    "subject",
    "displayName",
    "companyName",
    "email",
    "code",
    "slug",
    "number",
    "reference",
];

/// The fields a list row shows first.
const SUMMARY_FIELDS: [&str; 25] = [
    "reference",
    "number",
    "sku",
    "status",
    "stage",
    "state",
    "priority",
    "rating",
    "type",
    "category",
    "companyName",
    "company",
    "customerName",
    "projectName",
    "assigneeName",
    "ownerName",
    "email",
    "amount",
    "total",
    "value",
    "quantity",
    "dueDate",
    "startDate",
    "closeDate",
    "source",
];

/// Parts of a composite label, left off a row that leads with the label.
const LABEL_COMPONENT_FIELDS: [&str; 5] = [
    "firstName",
    "lastName",
    "givenName",
    "familyName",
    "middleName",
];

/// Initialisms kept upper case.
const ACRONYMS: [&str; 18] = [
    "id", "sku", "sla", "url", "uri", "api", "pdf", "csv", "html", "vat", "btw", "kvk", "iban",
    "bic", "crm", "seo", "utm", "vip",
];

fn is_identifier_field(key: &str) -> bool {
    key == "id" || key.ends_with("Id") || key.ends_with("_id")
}

static ISO_TIMESTAMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}T[\d:.]+Z?").expect("regex"));
static CAMEL_BREAK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").expect("regex"));

fn is_iso_timestamp(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| ISO_TIMESTAMP.is_match(text))
}

/// `new Date(value)` for the ISO forms the API prints, as Unix
/// milliseconds; `None` is an invalid date. A time without a zone is read as
/// UTC (the workers run in UTC).
fn parse_js_date(text: &str) -> Option<i128> {
    let (date, rest) = text.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i32 = date_parts.next()?.parse().ok()?;
    let month: u8 = date_parts.next()?.parse().ok()?;
    let day: u8 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() {
        return None;
    }
    let (clock, offset_minutes) = if let Some(clock) = rest.strip_suffix('Z') {
        (clock, 0i64)
    } else if let Some(index) = rest.rfind(['+', '-']) {
        let (clock, zone) = rest.split_at(index);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let (hours, minutes) = zone[1..].split_once(':')?;
        let hours: i64 = hours.parse().ok()?;
        let minutes: i64 = minutes.parse().ok()?;
        (clock, sign * (hours * 60 + minutes))
    } else {
        (rest, 0)
    };
    let mut clock_parts = clock.split(':');
    let hour: u8 = clock_parts.next()?.parse().ok()?;
    let minute: u8 = clock_parts.next()?.parse().ok()?;
    let (second, millis): (u8, u16) = match clock_parts.next() {
        None => (0, 0),
        Some(seconds) => {
            let (whole, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
            let millis = if fraction.is_empty() {
                0
            } else {
                let digits: String = fraction.chars().chain("000".chars()).take(3).collect();
                digits.parse().ok()?
            };
            (whole.parse().ok()?, millis)
        }
    };
    if clock_parts.next().is_some() {
        return None;
    }
    let month = time::Month::try_from(month).ok()?;
    let date = time::Date::from_calendar_date(year, month, day).ok()?;
    let time = time::Time::from_hms_milli(hour, minute, second, millis).ok()?;
    let moment = time::PrimitiveDateTime::new(date, time).assume_utc();
    Some(moment.unix_timestamp_nanos() / 1_000_000 - i128::from(offset_minutes) * 60_000)
}

/// `humaniseTimestamp`: the date, and the time when it is not midnight.
fn humanise_timestamp(value: &str) -> String {
    let Some(millis) = parse_js_date(value) else {
        return value.to_owned();
    };
    let Ok(moment) = time::OffsetDateTime::from_unix_timestamp_nanos(millis * 1_000_000) else {
        return value.to_owned();
    };
    let day = format!(
        "{:04}-{:02}-{:02}",
        moment.year(),
        u8::from(moment.month()),
        moment.day()
    );
    let clock = format!("{:02}:{:02}", moment.hour(), moment.minute());
    if clock == "00:00" {
        day
    } else {
        format!("{day} {clock}")
    }
}

/// `humaniseKey`: `slaBreached` → `SLA Breached`.
fn humanise_key(key: &str) -> String {
    CAMEL_BREAK
        .replace_all(key, "$1 $2")
        .split(' ')
        .map(|word| {
            if ACRONYMS.contains(&word.to_lowercase().as_str()) {
                word.to_uppercase()
            } else {
                let mut chars = word.chars();
                match chars.next() {
                    Some(first) if first != '\n' => first.to_uppercase().chain(chars).collect(),
                    _ => word.to_owned(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

/// `renderValue`.
fn render_value(value: &Value) -> String {
    if is_iso_timestamp(value) {
        return humanise_timestamp(value.as_str().unwrap_or_default());
    }
    match value {
        Value::Bool(flag) => if *flag { "yes" } else { "no" }.to_owned(),
        Value::String(_) | Value::Number(_) => string_of(value),
        other => stringify(other, Order::Jsonb),
    }
}

/// `labelFor`: the record's best human label.
pub fn label_for(record: &Map<String, Value>) -> Option<String> {
    LABEL_FIELDS.iter().find_map(|field| {
        record
            .get(*field)
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_owned)
    })
}

/// `splitRecord`: content and identifiers, in the record's order.
/// A record's fields, in its order.
type Fields<'a> = Vec<(&'a String, &'a Value)>;

fn split_record(record: &Map<String, Value>) -> (Fields<'_>, Fields<'_>) {
    let (keys, _) = ordered(record, Order::Row);
    let mut content = Vec::new();
    let mut identifiers = Vec::new();
    for key in keys {
        let value = &record[key];
        if DROPPED_FIELDS.contains(&key.as_str()) || is_empty(value) {
            continue;
        }
        if is_identifier_field(key) {
            identifiers.push((key, value));
        } else {
            content.push((key, value));
        }
    }
    (content, identifiers)
}

/// `presentRecord`.
pub fn present_record(record: &Map<String, Value>) -> String {
    let (content, identifiers) = split_record(record);
    let label = label_for(record);
    let mut lines: Vec<String> = Vec::new();
    if let Some(label) = &label {
        lines.push(format!("## {label}"));
    }
    for (key, value) in content {
        let rendered = render_value(value);
        if label.as_deref() == Some(rendered.as_str()) {
            continue;
        }
        lines.push(format!("- {}: {rendered}", humanise_key(key)));
    }
    if !identifiers.is_empty() {
        let refs: Vec<String> = identifiers
            .iter()
            .map(|(key, value)| format!("{key}={}", string_of(value)))
            .collect();
        lines.push(String::new());
        lines.push(format!(
            "<!-- refs (internal, do not display): {} -->",
            refs.join(" ")
        ));
    }
    lines.join("\n")
}

pub(crate) fn truthy_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `presentList`.
pub fn present_list(rows: &[&Map<String, Value>], pagination: Option<&Value>) -> String {
    if rows.is_empty() {
        return "No matching records.".to_owned();
    }
    let mut lines: Vec<String> = Vec::with_capacity(rows.len() + 1);
    for (index, row) in rows.iter().enumerate() {
        let (content, identifiers) = split_record(row);
        let label = label_for(row);
        let candidates: Vec<(&String, &Value)> = content
            .into_iter()
            .filter(|(key, value)| {
                label.as_deref() != Some(render_value(value).as_str())
                    && !(label.is_some() && LABEL_COMPONENT_FIELDS.contains(&key.as_str()))
            })
            .collect();
        let mut ranked: Vec<(&String, &Value)> = SUMMARY_FIELDS
            .iter()
            .filter_map(|field| {
                candidates
                    .iter()
                    .find(|(key, _)| key.as_str() == *field)
                    .copied()
            })
            .collect();
        ranked.extend(
            candidates
                .iter()
                .filter(|(key, _)| !SUMMARY_FIELDS.contains(&key.as_str()))
                .copied(),
        );
        let describe = |(key, value): &(&String, &Value)| {
            format!("{}: {}", humanise_key(key), render_value(value))
        };
        let heading = match &label {
            Some(label) => label.clone(),
            None => ranked
                .first()
                .map_or_else(|| "Untitled record".to_owned(), describe),
        };
        let (start, end) = if label.is_some() { (0, 3) } else { (1, 4) };
        let details: Vec<String> = ranked
            .iter()
            .skip(start)
            .take(end - start)
            .map(describe)
            .collect();
        let details = details.join(", ");
        let reference = identifiers
            .iter()
            .find(|(key, _)| key.as_str() == "id")
            .map(|(_, value)| *value)
            .filter(|value| truthy_value(value))
            .map(|value| format!(" <!--id={}-->", crate::js::as_text(value)))
            .unwrap_or_default();
        let note = if details.is_empty() {
            String::new()
        } else {
            format!(" — {details}")
        };
        lines.push(format!("{}. {heading}{note}{reference}", index + 1));
    }
    let total = pagination
        .and_then(|p| p.get("totalCount"))
        .filter(|t| t.is_number());
    let header = match total {
        Some(total)
            if total.as_f64() != Some(f64::from(u32::try_from(rows.len()).unwrap_or(u32::MAX))) =>
        {
            format!("Showing {} of {}:", rows.len(), string_of(total))
        }
        _ => format!(
            "{} result{}:",
            rows.len(),
            if rows.len() == 1 { "" } else { "s" }
        ),
    };
    let has_more = pagination
        .and_then(|p| p.get("hasMore"))
        .is_some_and(truthy_value);
    let footer = if has_more {
        "\nMore results are available — ask for the next page to continue."
    } else {
        ""
    };
    let mut text = header;
    for line in lines {
        text.push('\n');
        text.push_str(&line);
    }
    text.push_str(footer);
    text
}

/// `present(payload)`.
pub fn present(payload: &Value) -> String {
    let Value::Object(envelope) = payload else {
        return stringify_pretty(payload, Order::Envelope);
    };
    let Some(data) = envelope.get("data") else {
        return stringify_pretty(payload, Order::Envelope);
    };
    match data {
        Value::Array(items) => {
            let rows: Vec<&Map<String, Value>> =
                items.iter().filter_map(Value::as_object).collect();
            if rows.len() != items.len() {
                return stringify_pretty(payload, Order::Envelope);
            }
            present_list(&rows, envelope.get("pagination"))
        }
        Value::Object(record) => present_record(record),
        _ => stringify_pretty(payload, Order::Envelope),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_and_dates_read_like_present_ts() {
        assert_eq!(humanise_key("slaBreached"), "SLA Breached");
        assert_eq!(humanise_key("sku"), "SKU");
        assert_eq!(humanise_timestamp("2026-01-02T00:00:00.000Z"), "2026-01-02");
        assert_eq!(
            humanise_timestamp("2026-01-02T10:30:00.000Z"),
            "2026-01-02 10:30"
        );
        assert_eq!(
            humanise_timestamp("2026-01-02T10:30:00+02:00"),
            "2026-01-02 08:30"
        );
    }

    #[test]
    fn a_deleted_record_reads_success() {
        assert_eq!(
            present(&json!({ "data": { "success": true } })),
            "- Success: yes"
        );
        assert_eq!(present(&json!({ "data": [] })), "No matching records.");
        assert_eq!(present(&json!([1, 2])), "[\n  1,\n  2\n]");
    }
}
