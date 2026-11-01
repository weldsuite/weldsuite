//! The field types of the WeldHR request schemas
//! (`@weldsuite/app-api-client/schemas/weldhr`), as Zod reads them:
//!
//! ```ts
//! const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
//! const isoDateTime = z.string().datetime({ offset: true });
//! const id = z.string().min(1).max(30);
//! const shortText = (max) => z.string().trim().max(max);
//! const color = z.string().max(20).regex(/^#?[0-9a-zA-Z]{3,8}$/).nullable().optional();
//! ```

use serde_json::{Map, Value};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};

use crate::is_iso_date_shape;

pub(crate) type Fields = Map<String, Value>;

/// `isoDate` with `presence`.
pub(crate) fn iso_date(
    issues: &mut Issues,
    fields: &Fields,
    key: &str,
    presence: Presence,
) -> Field<String> {
    issues.pattern(
        fields,
        key,
        presence,
        None,
        None,
        is_iso_date_shape,
        "Expected YYYY-MM-DD",
    )
}

/// `isoDateTime` (`z.string().datetime({ offset: true })`) with `presence`.
pub(crate) fn iso_date_time(
    issues: &mut Issues,
    fields: &Fields,
    key: &str,
    presence: Presence,
) -> Field<String> {
    issues.text_with(
        fields,
        key,
        presence,
        Text {
            format: Some(Format::DatetimeOffset),
            ..Text::default()
        },
    )
}

/// `id` (`z.string().min(1).max(30)`) with `presence`.
pub(crate) fn id(
    issues: &mut Issues,
    fields: &Fields,
    key: &str,
    presence: Presence,
) -> Field<String> {
    issues.text(fields, key, presence, Some(1), Some(30))
}

/// `shortText(max)` (`z.string().trim().max(max)`), `.min(1)` when `required_text`.
pub(crate) fn short_text(
    issues: &mut Issues,
    fields: &Fields,
    key: &str,
    presence: Presence,
    max: usize,
    min_one: bool,
) -> Field<String> {
    issues.text_with(
        fields,
        key,
        presence,
        Text::trimmed(min_one.then_some(1), Some(max)),
    )
}

/// `z.string().max(max)` with `presence`.
pub(crate) fn text_max(
    issues: &mut Issues,
    fields: &Fields,
    key: &str,
    presence: Presence,
    max: usize,
) -> Field<String> {
    issues.text(fields, key, presence, None, Some(max))
}

/// `color`: `.nullable().optional()`.
pub(crate) fn color(issues: &mut Issues, fields: &Fields, key: &str) -> Field<String> {
    issues.pattern(
        fields,
        key,
        Presence::Nullish,
        None,
        Some(20),
        |text| {
            let body = text.strip_prefix('#').unwrap_or(text);
            (3..=8).contains(&body.len()) && body.bytes().all(|b| b.is_ascii_alphanumeric())
        },
        "Invalid",
    )
}

/// `z.number()` with bounds, with `presence`.
pub(crate) fn number(
    issues: &mut Issues,
    fields: &Fields,
    key: &str,
    presence: Presence,
    min: Option<f64>,
    max: Option<f64>,
) -> Field<f64> {
    issues.number(
        fields,
        key,
        presence,
        Number {
            coerce: false,
            int: false,
            min,
            max,
        },
    )
}

/// `z.number().int()` with bounds, with `presence`.
pub(crate) fn int(
    issues: &mut Issues,
    fields: &Fields,
    key: &str,
    presence: Presence,
    min: Option<f64>,
    max: Option<f64>,
) -> Field<f64> {
    issues.number(
        fields,
        key,
        presence,
        Number {
            coerce: false,
            int: true,
            min,
            max,
        },
    )
}

/// `(set, value)` of a `.partial()` field for `col = case when $set then $value else col end`:
/// a field the body left out keeps the column; `null` clears it.
pub(crate) fn change<T: Clone>(field: &Field<T>) -> (bool, Option<T>) {
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(value) => (true, Some(value.clone())),
    }
}

/// The JSON value a field puts into a Drizzle `.set({...input})` (absent:
/// not set), for building update objects as TypeScript spreads them.
pub(crate) fn field_json<T: serde::Serialize>(field: &Field<T>) -> Option<Value> {
    match field {
        Field::Absent => None,
        Field::Null => Some(Value::Null),
        Field::Set(value) => serde_json::to_value(value).ok(),
    }
}
