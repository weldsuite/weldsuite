//! OpenAPI 3.0 schemas checked against JSON values, as strictly as the native
//! apps' generated clients decode them: the type of every value, every
//! `required` property present, `null` only where the schema says
//! `nullable`, enum values within the enum. Extra properties pass unless a
//! schema says `additionalProperties: false`.
//!
//! The keywords read are listed in [`READ`]. [`Schemas::lint`] refuses any
//! other, so a schema never relies on something this checker skips.

use regex::Regex;
use serde_json::{Map, Value};

/// The schema keywords the checker reads.
const READ: &[&str] = &[
    "$ref",
    "type",
    "properties",
    "required",
    "items",
    "nullable",
    "enum",
    "allOf",
    "additionalProperties",
    "pattern",
    "format",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
];

/// Keywords that change nothing about what decodes.
const ANNOTATIONS: &[&str] = &[
    "description",
    "example",
    "title",
    "default",
    "deprecated",
    "readOnly",
    "writeOnly",
];

const TYPES: &[&str] = &["object", "array", "string", "integer", "number", "boolean"];

const FORMATS: &[&str] = &["date-time", "date", "int32", "int64", "float", "double"];

/// RFC 3339, as the generated clients' date decoders take it.
const DATE_TIME: &str = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$";
const DATE: &str = r"^\d{4}-\d{2}-\d{2}$";

/// The schemas of one OpenAPI document.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Schemas<'a> {
    root: &'a Value,
}

impl<'a> Schemas<'a> {
    pub(crate) fn new(root: &'a Value) -> Self {
        Self { root }
    }

    /// `#/components/…` in this document.
    pub(crate) fn resolve(self, reference: &str) -> Result<&'a Value, String> {
        let pointer = reference
            .strip_prefix('#')
            .ok_or_else(|| format!("`{reference}`: only references inside the file are read"))?;
        self.root
            .pointer(pointer)
            .ok_or_else(|| format!("`{reference}` points at nothing"))
    }

    /// `node` with its `$ref` followed (a schema, a response, a parameter).
    pub(crate) fn deref(self, node: &'a Value) -> Result<&'a Value, String> {
        let mut node = node;
        for _ in 0..32 {
            match node.get("$ref").and_then(Value::as_str) {
                Some(reference) => node = self.resolve(reference)?,
                None => return Ok(node),
            }
        }
        Err("a `$ref` cycle".to_owned())
    }

    /// What in `schema` itself the checker can't stand behind: a keyword it
    /// doesn't read, a reference that points at nothing, a `$ref` with
    /// siblings (OpenAPI 3.0 and the generators ignore them).
    pub(crate) fn lint(self, schema: &Value, at: &str, problems: &mut Vec<String>) {
        let Some(fields) = schema.as_object() else {
            problems.push(format!("{at}: a schema must be an object"));
            return;
        };
        if let Some(reference) = fields.get("$ref") {
            match reference.as_str() {
                Some(reference) => {
                    if let Err(error) = self.resolve(reference) {
                        problems.push(format!("{at}: {error}"));
                    }
                }
                None => problems.push(format!("{at}: `$ref` must be a string")),
            }
            if fields
                .keys()
                .any(|key| key != "$ref" && key != "description")
            {
                problems.push(format!(
                    "{at}: OpenAPI 3.0 ignores what sits next to `$ref` (so do the generators); wrap the reference in `allOf`"
                ));
            }
            return;
        }
        lint_keywords(fields, at, problems);
        if let Some(properties) = fields.get("properties") {
            match properties.as_object() {
                Some(properties) => {
                    for (name, property) in properties {
                        self.lint(property, &format!("{at}.properties.{name}"), problems);
                    }
                }
                None => problems.push(format!("{at}: `properties` must be an object")),
            }
        }
        if let Some(items) = fields.get("items") {
            self.lint(items, &format!("{at}.items"), problems);
        }
        match fields.get("additionalProperties") {
            None | Some(Value::Bool(_)) => {}
            Some(extra) => self.lint(extra, &format!("{at}.additionalProperties"), problems),
        }
        if let Some(parts) = fields.get("allOf") {
            match parts.as_array() {
                Some(parts) => {
                    for (index, part) in parts.iter().enumerate() {
                        self.lint(part, &format!("{at}.allOf[{index}]"), problems);
                    }
                }
                None => problems.push(format!("{at}: `allOf` must be a list")),
            }
        }
    }

    /// Why `value` doesn't fit `schema`, each at its path from `at`; nothing
    /// when it fits.
    pub(crate) fn check(self, schema: &Value, value: &Value, at: &str, problems: &mut Vec<String>) {
        let schema = match self.deref(schema) {
            Ok(schema) => schema,
            Err(error) => {
                problems.push(format!("{at}: {error}"));
                return;
            }
        };
        if value.is_null() {
            if schema.get("nullable") != Some(&Value::Bool(true)) {
                problems.push(format!("{at}: null, and the spec doesn't say `nullable`"));
            }
            return;
        }
        for part in schema
            .get("allOf")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            self.check(part, value, at, problems);
        }
        if let Some(kind) = schema.get("type").and_then(Value::as_str)
            && !fits_type(kind, value)
        {
            problems.push(format!(
                "{at}: {} where the spec says {kind}",
                describe(value)
            ));
            return;
        }
        if let Some(options) = schema.get("enum").and_then(Value::as_array)
            && !options.contains(value)
        {
            let options: Vec<String> = options.iter().map(Value::to_string).collect();
            problems.push(format!(
                "{at}: {value} is not in the spec's enum [{}]; both apps throw on it",
                options.join(", ")
            ));
        }
        match value {
            Value::String(text) => check_string(schema, text, at, problems),
            Value::Number(_) => check_number(schema, value, at, problems),
            Value::Array(items) => {
                check_count(
                    schema,
                    items.len(),
                    "minItems",
                    "maxItems",
                    "items",
                    at,
                    problems,
                );
                if let Some(item_schema) = schema.get("items") {
                    for (index, item) in items.iter().enumerate() {
                        self.check(item_schema, item, &format!("{at}[{index}]"), problems);
                    }
                }
            }
            Value::Object(fields) => {
                for name in schema
                    .get("required")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    if !fields.contains_key(name) {
                        problems.push(format!(
                            "{at}: `{name}` is missing, and the spec requires it"
                        ));
                    }
                }
                let properties = schema.get("properties").and_then(Value::as_object);
                for (name, field) in fields {
                    let declared = properties.and_then(|properties| properties.get(name));
                    let path = format!("{at}.{name}");
                    match (declared, schema.get("additionalProperties")) {
                        (Some(property), _) => self.check(property, field, &path, problems),
                        (None, Some(Value::Bool(false))) => problems.push(format!(
                            "{path}: not in the spec, which says `additionalProperties: false`"
                        )),
                        (None, Some(extra @ Value::Object(_))) => {
                            self.check(extra, field, &path, problems);
                        }
                        (None, _) => {}
                    }
                }
            }
            Value::Bool(_) | Value::Null => {}
        }
    }
}

/// The keywords of one schema (not `$ref`), without what it nests.
fn lint_keywords(fields: &Map<String, Value>, at: &str, problems: &mut Vec<String>) {
    for key in fields.keys() {
        if !READ.contains(&key.as_str()) && !ANNOTATIONS.contains(&key.as_str()) {
            problems.push(format!(
                "{at}: `{key}` is not read by the contract checker (weldsuite_kit::openapi_contract); teach it first"
            ));
        }
    }
    if let Some(kind) = fields.get("type")
        && !kind.as_str().is_some_and(|kind| TYPES.contains(&kind))
    {
        problems.push(format!("{at}: `type: {kind}` is not one of {TYPES:?}"));
    }
    if let Some(format) = fields.get("format")
        && !format
            .as_str()
            .is_some_and(|format| FORMATS.contains(&format))
    {
        problems.push(format!(
            "{at}: `format: {format}` is not read by the contract checker; teach it first"
        ));
    }
    if let Some(pattern) = fields.get("pattern")
        && !matches!(pattern.as_str().map(Regex::new), Some(Ok(_)))
    {
        problems.push(format!(
            "{at}: `pattern: {pattern}` is no regular expression"
        ));
    }
    if fields
        .get("nullable")
        .is_some_and(|nullable| !nullable.is_boolean())
    {
        problems.push(format!("{at}: `nullable` must be true or false"));
    }
    if fields
        .get("enum")
        .is_some_and(|options| !options.is_array())
    {
        problems.push(format!("{at}: `enum` must be a list"));
    }
    if let Some(required) = fields.get("required") {
        let names: Option<Vec<&str>> = required
            .as_array()
            .and_then(|names| names.iter().map(Value::as_str).collect());
        match (names, fields.get("properties").and_then(Value::as_object)) {
            (None, _) => problems.push(format!("{at}: `required` must be a list of names")),
            (Some(names), Some(properties)) => {
                for name in names {
                    if !properties.contains_key(name) {
                        problems.push(format!(
                            "{at}: `{name}` is required but not among the properties"
                        ));
                    }
                }
            }
            (Some(_), None) => {}
        }
    }
}

fn fits_type(kind: &str, value: &Value) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "integer" => value.is_i64() || value.is_u64(),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        _ => false,
    }
}

fn describe(value: &Value) -> String {
    let kind = match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(number) if number.is_f64() => "a decimal number",
        Value::Number(_) => "an integer",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    };
    let shown = value.to_string();
    if shown.chars().count() > 60 {
        kind.to_owned()
    } else {
        format!("{kind} ({shown})")
    }
}

fn check_string(schema: &Value, text: &str, at: &str, problems: &mut Vec<String>) {
    check_count(
        schema,
        text.chars().count(),
        "minLength",
        "maxLength",
        "characters",
        at,
        problems,
    );
    if let Some(pattern) = schema.get("pattern").and_then(Value::as_str)
        && Regex::new(pattern).is_ok_and(|pattern| !pattern.is_match(text))
    {
        problems.push(format!(
            "{at}: \"{text}\" doesn't match the pattern `{pattern}`"
        ));
    }
    let format = match schema.get("format").and_then(Value::as_str) {
        Some("date-time") => Some(("date-time", DATE_TIME)),
        Some("date") => Some(("date", DATE)),
        _ => None,
    };
    if let Some((name, pattern)) = format
        && Regex::new(pattern).is_ok_and(|pattern| !pattern.is_match(text))
    {
        problems.push(format!("{at}: \"{text}\" is not a {name}"));
    }
}

fn check_number(schema: &Value, value: &Value, at: &str, problems: &mut Vec<String>) {
    let number = value.as_f64().unwrap_or_default();
    if schema.get("format").and_then(Value::as_str) == Some("int32")
        && value.as_i64().is_none_or(|int| i32::try_from(int).is_err())
    {
        problems.push(format!("{at}: {value} doesn't fit an int32"));
    }
    if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64)
        && number < minimum
    {
        problems.push(format!("{at}: {value} is below the minimum {minimum}"));
    }
    if let Some(maximum) = schema.get("maximum").and_then(Value::as_f64)
        && number > maximum
    {
        problems.push(format!("{at}: {value} is above the maximum {maximum}"));
    }
}

fn check_count(
    schema: &Value,
    count: usize,
    min: &str,
    max: &str,
    unit: &str,
    at: &str,
    problems: &mut Vec<String>,
) {
    let count = u64::try_from(count).unwrap_or(u64::MAX);
    if let Some(least) = schema.get(min).and_then(Value::as_u64)
        && count < least
    {
        problems.push(format!("{at}: {count} {unit}, fewer than `{min}: {least}`"));
    }
    if let Some(most) = schema.get(max).and_then(Value::as_u64)
        && count > most
    {
        problems.push(format!("{at}: {count} {unit}, more than `{max}: {most}`"));
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::Schemas;

    fn document() -> Value {
        json!({
            "components": {
                "schemas": {
                    "Item": {
                        "type": "object",
                        "required": ["id", "kind", "subtitle", "count"],
                        "properties": {
                            "id": { "type": "string" },
                            "kind": { "type": "string", "enum": ["login", "note"] },
                            "subtitle": { "type": "string", "nullable": true },
                            "count": { "type": "integer" },
                            "tags": { "type": "array", "items": { "type": "string" } },
                            "code": { "type": "string", "pattern": "^\\d{6}$" },
                            "at": { "type": "string", "format": "date-time" },
                        },
                    },
                    "Revealed": {
                        "allOf": [
                            { "$ref": "#/components/schemas/Item" },
                            {
                                "type": "object",
                                "required": ["fields"],
                                "properties": { "fields": { "type": "object" } },
                            },
                        ],
                    },
                    "Cursors": {
                        "type": "object",
                        "additionalProperties": { "type": "string" },
                    },
                    "Closed": {
                        "type": "object",
                        "properties": { "a": { "type": "string" } },
                        "additionalProperties": false,
                    },
                },
            },
        })
    }

    fn problems(schema: &str, value: &Value) -> Vec<String> {
        let document = document();
        let schemas = Schemas::new(&document);
        let mut problems = Vec::new();
        schemas.check(
            &json!({ "$ref": format!("#/components/schemas/{schema}") }),
            value,
            "$",
            &mut problems,
        );
        problems
    }

    #[test]
    fn a_fitting_value_passes_and_extra_properties_are_fine() {
        let item = json!({
            "id": "wpi_1", "kind": "login", "subtitle": null, "count": 2,
            "tags": ["a"], "code": "123456", "at": "2026-11-26T10:00:00.000Z", "extra": { "x": 1 },
        });
        assert_eq!(problems("Item", &item), Vec::<String>::new());
        let mut revealed = item.clone();
        revealed["fields"] = json!({ "password": "x" });
        assert_eq!(problems("Revealed", &revealed), Vec::<String>::new());
        assert_eq!(
            problems("Cursors", &json!({ "wpk_a": "c1" })),
            Vec::<String>::new()
        );
    }

    #[test]
    fn names_each_mismatch_where_it_sits() {
        let item = json!({
            "id": null, "kind": "card", "count": 1.5,
            "tags": ["a", 2], "code": "12", "at": "yesterday",
        });
        let found = problems("Item", &item);
        for expected in [
            "$.id: null, and the spec doesn't say `nullable`",
            "$.kind: \"card\" is not in the spec's enum [\"login\", \"note\"]",
            "$: `subtitle` is missing, and the spec requires it",
            "$.count: a decimal number (1.5) where the spec says integer",
            "$.tags[1]: an integer (2) where the spec says string",
            "$.code: \"12\" doesn't match the pattern",
            "$.at: \"yesterday\" is not a date-time",
        ] {
            assert!(
                found.iter().any(|problem| problem.starts_with(expected)),
                "{expected}\nin {found:#?}"
            );
        }
        assert_eq!(found.len(), 7, "{found:#?}");
    }

    #[test]
    fn all_of_takes_every_part_and_additional_properties_their_schema() {
        let found = problems(
            "Revealed",
            &json!({ "id": "a", "kind": "note", "subtitle": "s" }),
        );
        assert!(found.contains(&"$: `count` is missing, and the spec requires it".to_owned()));
        assert!(found.contains(&"$: `fields` is missing, and the spec requires it".to_owned()));
        assert_eq!(
            problems("Cursors", &json!({ "wpk_a": 3 })),
            ["$.wpk_a: an integer (3) where the spec says string"]
        );
        assert_eq!(
            problems("Closed", &json!({ "a": "x", "b": 1 })),
            ["$.b: not in the spec, which says `additionalProperties: false`"]
        );
        assert_eq!(
            problems("Item", &Value::Null),
            ["$: null, and the spec doesn't say `nullable`"]
        );
    }

    #[test]
    fn lint_refuses_what_the_checker_does_not_read() {
        let document = json!({ "components": { "schemas": { "A": { "type": "string" } } } });
        let schemas = Schemas::new(&document);
        let mut found = Vec::new();
        for (schema, needle) in [
            (json!({ "oneOf": [] }), "`oneOf` is not read"),
            (
                json!({ "type": "string", "format": "uuid" }),
                "`format: \"uuid\"`",
            ),
            (
                json!({ "$ref": "#/components/schemas/B" }),
                "points at nothing",
            ),
            (
                json!({ "$ref": "#/components/schemas/A", "nullable": true }),
                "wrap the reference in `allOf`",
            ),
            (
                json!({ "type": "object", "required": ["b"], "properties": { "a": {} } }),
                "`b` is required but not among",
            ),
            (json!({ "type": "file" }), "`type: \"file\"`"),
            (
                json!({ "type": "string", "pattern": "(" }),
                "no regular expression",
            ),
        ] {
            found.clear();
            schemas.lint(&schema, "S", &mut found);
            assert!(
                found.iter().any(|problem| problem.contains(needle)),
                "{needle}: {found:#?}"
            );
        }
        found.clear();
        schemas.lint(
            &json!({ "allOf": [{ "$ref": "#/components/schemas/A" }], "nullable": true, "description": "ok" }),
            "S",
            &mut found,
        );
        assert_eq!(found, Vec::<String>::new());
    }
}
