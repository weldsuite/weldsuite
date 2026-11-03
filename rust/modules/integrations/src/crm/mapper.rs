//! `lib/engine/sync/field-mapper.ts` and `conflict-resolver.ts`: per-field
//! mappings between a provider's record and WeldSuite's, with their
//! transforms, and which side wins a conflict.

use serde_json::{Map, Value};
use weldsuite_core_domain::js::{Js, as_text, js_date, js_string, stringify};

/// `FieldMappingDefinition`.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldMapping {
    pub external_field_path: String,
    pub internal_field_path: String,
    /// `inbound` | `outbound` | `bidirectional`.
    pub direction: String,
    /// `direct` | `lookup` | `format_date` | `custom`.
    pub transform_type: String,
    pub transform_config: Option<Value>,
    pub is_required: bool,
}

impl FieldMapping {
    /// A default mapping (`getDefaultFieldMappings`).
    pub(crate) fn new(external: &str, internal: &str, direction: &str, transform: &str) -> Self {
        Self {
            external_field_path: external.to_owned(),
            internal_field_path: internal.to_owned(),
            direction: direction.to_owned(),
            transform_type: transform.to_owned(),
            transform_config: None,
            is_required: false,
        }
    }

    #[must_use]
    pub(crate) fn required(mut self) -> Self {
        self.is_required = true;
        self
    }

    #[must_use]
    pub(crate) fn lookup(mut self, table: &Value) -> Self {
        self.transform_config = Some(serde_json::json!({ "lookupTable": table.clone() }));
        self
    }
}

/// `getNestedValue(obj, path)`; `None` is `undefined`.
pub(crate) fn nested<'a>(object: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    let mut parts = path.split('.');
    let mut current = object.get(parts.next()?)?;
    for part in parts {
        match current {
            Value::Object(map) => current = map.get(part)?,
            // `typeof current !== 'object'` (or null) → undefined; an
            // array's own properties are not field paths the mappings use.
            Value::Array(items) => current = items.get(part.parse::<usize>().ok()?)?,
            _ => return None,
        }
    }
    Some(current)
}

/// `setNestedValue(obj, path, value)`: intermediate objects created (or
/// replaced when not an object). `None` stores `undefined`, which leaves the
/// key out (Drizzle skips `undefined`).
fn set_nested(object: &mut Map<String, Value>, path: &str, value: Option<Value>) {
    let parts: Vec<&str> = path.split('.').collect();
    let (last, parents) = parts.split_last().expect("split yields one part");
    let mut current = object;
    for part in parents {
        let entry = current
            .entry((*part).to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        current = entry.as_object_mut().expect("just made an object");
    }
    match value {
        Some(value) => {
            current.insert((*last).to_owned(), value);
        }
        None => {
            // `obj[key] = undefined`: the key is there, but every reader
            // (Drizzle, the spread defaults) treats it as absent.
            current.remove(*last);
        }
    }
}

/// `String(value)` for a mapping value.
fn string_of(value: Option<&Value>) -> String {
    value.map_or_else(
        || "undefined".to_owned(),
        |value| js_string(&Js::from_jsonb(value)),
    )
}

/// Whether a JavaScript value is truthy.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn lookup_table(config: Option<&Value>) -> Option<&Map<String, Value>> {
    config?.get("lookupTable")?.as_object()
}

/// `applyTransform(value, transformType, config)`.
pub(crate) fn apply_transform(
    value: Option<&Value>,
    transform_type: &str,
    config: Option<&Value>,
) -> Option<Value> {
    match transform_type {
        "lookup" => {
            let Some(table) = lookup_table(config) else {
                return value.cloned();
            };
            match table.get(&string_of(value)) {
                Some(mapped) => Some(mapped.clone()),
                None => value.cloned(),
            }
        }
        "format_date" => {
            if !truthy(value) {
                return value.cloned();
            }
            let text = as_text(&Js::from_jsonb(value.expect("truthy")));
            match js_date(&text) {
                Some(iso) => Some(Value::String(iso)),
                None => value.cloned(),
            }
        }
        _ => value.cloned(),
    }
}

/// `FieldMapper`.
#[derive(Debug, Clone)]
pub struct FieldMapper {
    inbound: Vec<FieldMapping>,
}

impl FieldMapper {
    pub fn new(mappings: &[FieldMapping]) -> Self {
        Self {
            inbound: mappings
                .iter()
                .filter(|m| m.direction == "inbound" || m.direction == "bidirectional")
                .cloned()
                .collect(),
        }
    }

    /// `mapToInternal(externalData)`.
    pub fn map_to_internal(&self, external: &Map<String, Value>) -> Map<String, Value> {
        let mut result = Map::new();
        for mapping in &self.inbound {
            let value = nested(external, &mapping.external_field_path);
            if value.is_none() && !mapping.is_required {
                continue;
            }
            let transformed = apply_transform(
                value,
                &mapping.transform_type,
                mapping.transform_config.as_ref(),
            );
            set_nested(&mut result, &mapping.internal_field_path, transformed);
        }
        result
    }

    /// `detectConflicts(internalData, externalData)`: the internal paths of
    /// the bidirectional mappings whose values differ (`JSON.stringify`).
    pub fn detect_conflicts(
        &self,
        internal: &Map<String, Value>,
        external: &Map<String, Value>,
    ) -> Vec<String> {
        let text = |value: Option<&Value>| value.map(|v| stringify(&Js::from_jsonb(v)));
        self.inbound
            .iter()
            .filter(|m| m.direction == "bidirectional")
            .filter(|mapping| {
                let internal_value = nested(internal, &mapping.internal_field_path);
                let external_value = apply_transform(
                    nested(external, &mapping.external_field_path),
                    &mapping.transform_type,
                    mapping.transform_config.as_ref(),
                );
                text(internal_value) != text(external_value.as_ref())
            })
            .map(|m| m.internal_field_path.clone())
            .collect()
    }
}

/// `ConflictResolver.resolve(internalUpdatedAt, externalUpdatedAt)`: the
/// times in milliseconds, `None` an invalid date (every comparison false).
pub(crate) fn resolve_conflict(
    strategy: &str,
    internal_updated_at: Option<i64>,
    external_updated_at: Option<i64>,
) -> &'static str {
    match strategy {
        "external_wins" => "use_external",
        "internal_wins" => "use_internal",
        "manual" => "queue_manual",
        _ => match (internal_updated_at, external_updated_at) {
            (Some(internal), Some(external)) if internal > external => "use_internal",
            _ => "use_external",
        },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn map(value: &Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn maps_nested_paths_with_transforms() {
        let mappings = vec![
            FieldMapping::new("properties.name", "companyName", "bidirectional", "direct")
                .required(),
            FieldMapping::new("properties.email", "email", "inbound", "direct").required(),
            FieldMapping::new("properties.stage", "stage", "inbound", "lookup")
                .lookup(&json!({ "closedwon": "closed_won" })),
            FieldMapping::new("properties.close", "closeDate", "inbound", "format_date"),
            FieldMapping::new("properties.gone", "gone", "inbound", "direct"),
            FieldMapping::new("x", "out", "outbound", "direct"),
        ];
        let mapper = FieldMapper::new(&mappings);
        let data = map(&json!({ "properties": {
            "name": "Acme", "stage": "closedwon", "close": "2026-10-05", "email": null
        }, "x": 1 }));
        let internal = mapper.map_to_internal(&data);
        assert_eq!(
            Value::Object(internal),
            json!({
                "companyName": "Acme",
                "email": null,
                "stage": "closed_won",
                "closeDate": "2026-10-05T00:00:00.000Z",
            })
        );
    }

    #[test]
    fn a_required_missing_value_is_left_out() {
        let mapper =
            FieldMapper::new(&[FieldMapping::new("a.b", "x.y", "inbound", "direct").required()]);
        assert_eq!(
            Value::Object(mapper.map_to_internal(&Map::new())),
            json!({ "x": {} })
        );
    }

    #[test]
    fn conflicts_compare_as_json() {
        let mapper = FieldMapper::new(&[
            FieldMapping::new("properties.name", "companyName", "bidirectional", "direct"),
            FieldMapping::new("properties.phone", "phone", "bidirectional", "direct"),
            FieldMapping::new("properties.city", "city", "inbound", "direct"),
        ]);
        let internal = map(&json!({ "companyName": "Acme", "phone": null, "city": "A" }));
        let external = map(&json!({ "properties": { "name": "Acme", "city": "B" } }));
        assert_eq!(mapper.detect_conflicts(&internal, &external), vec!["phone"]);
    }

    #[test]
    fn last_write_wins_by_time() {
        assert_eq!(
            resolve_conflict("last_write_wins", Some(2), Some(1)),
            "use_internal"
        );
        assert_eq!(resolve_conflict("", Some(1), Some(1)), "use_external");
        assert_eq!(resolve_conflict("x", Some(2), None), "use_external");
        assert_eq!(resolve_conflict("manual", None, None), "queue_manual");
    }
}
