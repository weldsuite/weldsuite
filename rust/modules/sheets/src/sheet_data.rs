//! What a connected table lists (`@weldsuite/app-api-client/schemas/sheet-data`):
//! the objects and their fields (`rust/catalogs/sheet-data.json`, exported by
//! `pnpm rust:catalogs`), `sheetDataDefinitionSchema` as Zod reads it, and
//! `checkSheetDataDefinition`.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    object_keys: Vec<String>,
    objects: HashMap<String, Object>,
    filter_ops: Vec<String>,
    filter_ops_by_type: HashMap<String, Vec<String>>,
    max_rows: u32,
    max_columns: usize,
    max_filters: usize,
}

#[derive(Debug, Deserialize)]
struct Object {
    permission: String,
    fields: Vec<FieldDef>,
}

#[derive(Debug, Deserialize)]
struct FieldDef {
    key: String,
    #[serde(rename = "type")]
    kind: String,
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../catalogs/sheet-data.json"))
            .unwrap_or_else(|error| panic!("rust/catalogs/sheet-data.json does not read: {error}"))
    })
}

/// `SHEET_DATA_OBJECT_KEYS`, in order.
pub(crate) fn object_keys() -> Vec<&'static str> {
    catalog().object_keys.iter().map(String::as_str).collect()
}

/// The permission listing `object_type` needs (`SHEET_DATA_OBJECTS[o].permission`).
pub(crate) fn permission_of(object_type: &str) -> Option<&'static str> {
    catalog()
        .objects
        .get(object_type)
        .map(|object| object.permission.as_str())
}

/// The connected-table refresh schedules (`SHEET_DATA_REFRESH`).
pub(crate) const REFRESH: [&str; 3] = ["manual", "hourly", "daily"];

/// Zod issues that stop a parse (`INVALID`) rather than leave it dirty: a
/// value of the wrong type (an integer check's `invalid_type` excepted), an
/// enum or union that matched nothing.
pub(crate) fn aborts(issue: &Value) -> bool {
    match issue["code"].as_str() {
        Some("invalid_type") => issue["expected"] != "integer",
        Some("invalid_enum_value" | "invalid_union" | "invalid_literal") => true,
        _ => false,
    }
}

/// `fieldKey`: `z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/).max(64)`, at
/// `key` of `fields` (or the current path when `key` is `None`, an array item).
fn field_key(
    issues: &mut Issues,
    fields: Option<&Map<String, Value>>,
    key: Option<&str>,
    item: &Value,
) {
    let text = match (fields, key) {
        (Some(fields), Some(key)) => issues
            .text_with(fields, key, Presence::Required, Text::length(None, None))
            .into_option(),
        _ => issues.item_text(item, Text::length(None, None)),
    };
    let Some(text) = text else { return };
    let mut chars = text.chars();
    let matches = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric());
    let push = |issues: &mut Issues, issue: Value| match key {
        Some(key) => issues.issue_at(key, issue),
        None => issues.issue_here(issue),
    };
    if !matches {
        push(
            issues,
            json!({ "validation": "regex", "code": "invalid_string", "message": "Invalid" }),
        );
    }
    if text.encode_utf16().count() > 64 {
        push(
            issues,
            json!({
                "code": "too_big", "maximum": 64, "type": "string", "inclusive": true,
                "exact": false, "message": "String must contain at most 64 character(s)",
            }),
        );
    }
}

/// `filterValue`: `z.union([z.string().max(1000), z.number().finite(),
/// z.boolean(), z.null()])`, optional, at `value` of `fields`.
fn filter_value(issues: &mut Issues, fields: &Map<String, Value>) {
    match fields.get("value") {
        None | Some(Value::Null | Value::Number(_) | Value::Bool(_)) => {}
        Some(Value::String(text)) => {
            if text.encode_utf16().count() > 1000 {
                issues.issue_at(
                    "value",
                    json!({
                        "code": "too_big", "maximum": 1000, "type": "string", "inclusive": true,
                        "exact": false, "message": "String must contain at most 1000 character(s)",
                    }),
                );
            }
        }
        Some(other) => {
            let path = issues.path_of("value");
            let received = match other {
                Value::Array(_) => "array",
                _ => "object",
            };
            let option = |expected: &str| {
                json!({ "issues": [{
                    "code": "invalid_type", "expected": expected, "received": received,
                    "path": path, "message": format!("Expected {expected}, received {received}"),
                }], "name": "ZodError" })
            };
            issues.issue_at(
                "value",
                json!({
                    "code": "invalid_union",
                    "unionErrors": [option("string"), option("number"), option("boolean"), option("null")],
                    "message": "Invalid input",
                }),
            );
        }
    }
}

/// A definition as Zod hands it on: `headers` trimmed, `filters` defaulted,
/// unknown keys left out.
fn parsed_definition(fields: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    out.insert(
        "columns".into(),
        fields.get("columns").cloned().unwrap_or_default(),
    );
    let headers = fields
        .get("headers")
        .and_then(Value::as_array)
        .map(|headers| {
            headers
                .iter()
                .map(|h| {
                    json!(weldsuite_kit::validation::js_trim(
                        h.as_str().unwrap_or_default()
                    ))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    out.insert("headers".into(), Value::Array(headers));
    let filters = fields
        .get("filters")
        .and_then(Value::as_array)
        .map(|filters| {
            filters
                .iter()
                .map(|filter| {
                    let mut item = Map::new();
                    item.insert("field".into(), filter["field"].clone());
                    item.insert("op".into(), filter["op"].clone());
                    if let Some(value) = filter.get("value") {
                        item.insert("value".into(), js_value(value));
                    }
                    Value::Object(item)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    out.insert("filters".into(), Value::Array(filters));
    if let Some(sort) = fields.get("sort").and_then(Value::as_object) {
        let mut item = Map::new();
        item.insert("field".into(), sort["field"].clone());
        if let Some(descending) = sort.get("descending") {
            item.insert("descending".into(), descending.clone());
        }
        out.insert("sort".into(), Value::Object(item));
    }
    out.insert("limit".into(), js_value(&fields["limit"]));
    Value::Object(out)
}

/// A number as JavaScript holds it: an integral value is written as an integer.
fn js_value(value: &Value) -> Value {
    match value.as_f64() {
        Some(number)
            if value.is_f64()
                && number.fract() == 0.0
                && number.abs() < 9_007_199_254_740_992.0 =>
        {
            #[allow(clippy::cast_possible_truncation)]
            let integral = number as i64;
            json!(integral)
        }
        _ => value.clone(),
    }
}

/// `sheetDataDefinitionSchema` at `key` of `body`, with `presence`.
pub(crate) struct ReadDefinition {
    /// The parsed definition, when it parsed without an issue.
    pub(crate) value: Option<Value>,
    /// Its raw object when the parse did not abort (refinements run on it).
    pub(crate) raw: Option<Map<String, Value>>,
    /// The schema's own refinement (`superRefine`) issues: Zod settles them
    /// after the body's synchronous checks.
    pub(crate) refined: Vec<Value>,
}

pub(crate) fn definition(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<ReadDefinition> {
    let before = issues.count();
    let mut raw = None;
    let read = issues.nested(body, key, presence, |issues, fields| {
        raw = Some(fields.clone());
        let catalog = catalog();
        issues.list(
            fields,
            "columns",
            Presence::Required,
            Some(1),
            Some(catalog.max_columns),
            |issues, item| {
                field_key(issues, None, None, item);
                Some(())
            },
        );
        issues.list(
            fields,
            "headers",
            Presence::Required,
            Some(1),
            Some(catalog.max_columns),
            |issues, item| issues.item_text(item, Text::trimmed(Some(1), Some(255))),
        );
        let ops: Vec<&str> = catalog.filter_ops.iter().map(String::as_str).collect();
        issues.list(
            fields,
            "filters",
            Presence::Optional,
            None,
            Some(catalog.max_filters),
            |issues, item| {
                let fields = issues.object(item)?;
                field_key(issues, Some(fields), Some("field"), item);
                issues.choice(fields, "op", Presence::Required, &ops);
                filter_value(issues, fields);
                Some(())
            },
        );
        issues.nested(fields, "sort", Presence::Optional, |issues, sort| {
            field_key(issues, Some(sort), Some("field"), &Value::Null);
            issues.boolean(sort, "descending", Presence::Optional);
        });
        issues.number(
            fields,
            "limit",
            Presence::Required,
            Number {
                int: true,
                min: Some(1.0),
                max: Some(f64::from(catalog.max_rows)),
                ..Number::default()
            },
        );
    });
    match read {
        Field::Absent if issues.count() == before => return Field::Absent,
        Field::Null => return Field::Null,
        _ => {}
    }
    let Some(fields) = raw else {
        return Field::Absent;
    };
    if issues.issues_since(before).iter().any(aborts) {
        return Field::Set(ReadDefinition {
            value: None,
            raw: None,
            refined: Vec::new(),
        });
    }
    // The schema's `superRefine`, on what parsed.
    let mut refined = Vec::new();
    let path = |field: &str| {
        let mut path = issues.path_of(key);
        if let Value::Array(segments) = &mut path {
            segments.push(json!(field));
        }
        path
    };
    let columns = string_items(&fields["columns"]);
    let unique: HashSet<&String> = columns.iter().collect();
    if unique.len() != columns.len() {
        refined.push(json!({ "code": "custom", "path": path("columns"), "message": "Each field can be a column only once" }));
    }
    if fields["headers"].as_array().map_or(0, Vec::len) != columns.len() {
        refined.push(json!({ "code": "custom", "path": path("headers"), "message": "Every column needs exactly one header" }));
    }
    let clean = issues.count() == before && refined.is_empty();
    Field::Set(ReadDefinition {
        value: clean.then(|| parsed_definition(&fields)),
        raw: Some(fields),
        refined,
    })
}

fn string_items(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| item.as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// `checkSheetDataDefinition(objectType, def)`: `None` when the definition
/// fits the object, else the reason.
pub(crate) fn check_definition(object_type: &str, def: &Map<String, Value>) -> Option<String> {
    let catalog = catalog();
    let Some(object) = catalog.objects.get(object_type) else {
        return Some(format!("Unknown object '{object_type}'"));
    };
    let fields: HashMap<&str, &FieldDef> = object
        .fields
        .iter()
        .map(|field| (field.key.as_str(), field))
        .collect();
    let columns = string_items(&def["columns"]);
    if columns.is_empty() {
        return Some("Pick at least one column".into());
    }
    if columns.len() > catalog.max_columns {
        return Some(format!("At most {} columns", catalog.max_columns));
    }
    if columns.iter().collect::<HashSet<_>>().len() != columns.len() {
        return Some("Each field can be a column only once".into());
    }
    if def["headers"].as_array().map_or(0, Vec::len) != columns.len() {
        return Some("Every column needs exactly one header".into());
    }
    if let Some(unknown) = columns.iter().find(|c| !fields.contains_key(c.as_str())) {
        return Some(format!("Unknown field '{unknown}' on {object_type}"));
    }
    for filter in def
        .get("filters")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        let name = filter["field"].as_str().unwrap_or_default();
        let op = filter["op"].as_str().unwrap_or_default();
        let Some(field) = fields.get(name) else {
            return Some(format!("Unknown filter field '{name}' on {object_type}"));
        };
        let fits = catalog
            .filter_ops_by_type
            .get(&field.kind)
            .is_some_and(|ops| ops.iter().any(|o| o == op));
        if !fits {
            return Some(format!(
                "Filter '{op}' does not fit the {} field '{}'",
                field.kind, field.key
            ));
        }
        let needs_value = op != "empty" && op != "notEmpty";
        if needs_value && filter.get("value").is_none_or(Value::is_null) {
            return Some(format!("Filter on '{}' needs a value", field.key));
        }
    }
    if let Some(sort) = def.get("sort").filter(|sort| !sort.is_null()) {
        let name = sort["field"].as_str().unwrap_or_default();
        if !fields.contains_key(name) {
            return Some(format!("Unknown sort field '{name}' on {object_type}"));
        }
    }
    let limit = def["limit"].as_f64().unwrap_or(f64::NAN);
    if !(limit.fract() == 0.0 && limit >= 1.0 && limit <= f64::from(catalog.max_rows)) {
        return Some(format!(
            "The limit must be between 1 and {}",
            catalog.max_rows
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn the_catalog_reads() {
        assert_eq!(object_keys().first(), Some(&"companies"));
        assert_eq!(permission_of("companies"), Some("companies:read"));
        assert_eq!(permission_of("nope"), None);
    }

    #[test]
    fn definitions_are_checked_against_the_object() {
        let good = def(
            json!({ "columns": ["name", "leadScore"], "headers": ["A", "B"], "filters": [], "limit": 10 }),
        );
        assert_eq!(check_definition("companies", &good), None);
        let unknown =
            def(json!({ "columns": ["nope"], "headers": ["Nope"], "filters": [], "limit": 10 }));
        assert_eq!(
            check_definition("companies", &unknown).as_deref(),
            Some("Unknown field 'nope' on companies")
        );
        let filter = def(
            json!({ "columns": ["name"], "headers": ["A"], "filters": [{ "field": "name", "op": "gt", "value": "x" }], "limit": 10 }),
        );
        assert_eq!(
            check_definition("companies", &filter).as_deref(),
            Some("Filter 'gt' does not fit the text field 'name'")
        );
        let limit = def(json!({ "columns": ["name"], "headers": ["A"], "limit": 1.5 }));
        assert_eq!(
            check_definition("companies", &limit).as_deref(),
            Some("The limit must be between 1 and 10000")
        );
    }
}
