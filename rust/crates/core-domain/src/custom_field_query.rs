//! Sorting and filtering a list by a custom field
//! (`@weldsuite/core-domain/custom-field-query`): a grid sorts by
//! `custom:<slug>` and filters with `customFilter=<slug>:<value>`, both
//! answered from `custom_field_values` in SQL.
//!
//! The SQL lives in each list query (sqlx takes literal SQL only); this
//! module turns a definition and a raw value into what those queries bind.

use serde_json::Value;

use crate::custom_field_values::{Column, Definition};
use crate::js::js_date;

/// `CUSTOM_FIELD_KEY_PREFIX`.
pub const CUSTOM_FIELD_KEY_PREFIX: &str = "custom:";

/// `parseCustomFieldKey(key)`: the slug of a `custom:<slug>` key.
pub fn parse_custom_field_key(key: Option<&str>) -> Option<&str> {
    key?.strip_prefix(CUSTOM_FIELD_KEY_PREFIX)
        .filter(|slug| !slug.is_empty())
}

/// A sort by a custom field: the definition and the value column's kind.
#[derive(Debug, Clone)]
pub struct CustomSort {
    pub field_id: String,
    /// [`Column::kind`].
    pub kind: &'static str,
}

impl CustomSort {
    pub fn of(definition: &Definition) -> Self {
        Self {
            field_id: definition.id.clone(),
            kind: Column::of(&definition.field_type).kind(),
        }
    }
}

/// The parameters of `customFieldFilter(entityType, id, def, rawValue)`: the
/// value column's kind and the value the predicate compares, one of which is
/// set (`v.value_number = n`, `v.value_date::date = d::timestamp::date`,
/// `v.value_bool = b`, `v.value_json @> j`, `v.value_ref = r`,
/// `v.value_text ilike p`).
#[derive(Debug, Clone, Default)]
pub struct CustomFilter {
    pub field_id: String,
    pub kind: &'static str,
    pub number: Option<f64>,
    pub date: Option<String>,
    pub flag: Option<bool>,
    pub json: Option<Value>,
    pub reference: Option<String>,
    pub pattern: Option<String>,
}

/// `customFieldFilter(...)` for a raw query-string value; `None` when the
/// value can't be read as the field's type (the filter then matches
/// nothing, as TypeScript's `null` does).
pub fn custom_field_filter(definition: &Definition, raw: &str) -> Option<CustomFilter> {
    let column = Column::of(&definition.field_type);
    let mut filter = CustomFilter {
        field_id: definition.id.clone(),
        kind: column.kind(),
        ..CustomFilter::default()
    };
    match column {
        Column::Number => {
            let number = weldsuite_kit::validation::js_number(raw);
            if number.is_nan() {
                return None;
            }
            filter.number = Some(number);
        }
        Column::Date => filter.date = Some(js_date(raw)?),
        Column::Bool => {
            filter.flag = Some(match raw {
                "true" => true,
                "false" => false,
                _ => return None,
            });
        }
        Column::Json => filter.json = Some(Value::Array(vec![Value::String(raw.to_owned())])),
        Column::Ref => filter.reference = Some(raw.to_owned()),
        Column::Text => filter.pattern = Some(format!("%{raw}%")),
    }
    Some(filter)
}
