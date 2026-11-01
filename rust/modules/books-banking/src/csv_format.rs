//! `csvFormatSchema` (`services/bank-parsers/csv-format-schema.ts`): the
//! explicit CSV layout the import endpoints and
//! `bank_accounts.import_settings.csv` accept, read the way Zod reads it.

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};

/// Issues Zod settles after the body's synchronous checks
/// (`zValidator` parses asynchronously): a failed union's (its options run
/// as promises) and a failed refinement's. Collected while the body is read
/// (with their full paths), reported by [`Deferred::settle`] at the end.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Deferred {
    unions: Vec<Value>,
    /// Unions that failed every option (the others came back "dirty").
    failed: usize,
    refinements: Vec<Value>,
}

impl Deferred {
    /// A union that failed every option.
    pub(crate) fn union(&mut self, issue: Value) {
        self.failed += 1;
        self.unions.push(issue);
    }

    /// A union whose matching option failed a check (Zod's "dirty"
    /// result): its issues, settled with the unions'.
    fn dirty(&mut self, issues: impl IntoIterator<Item = Value>) {
        self.unions.extend(issues);
    }

    /// A refinement that failed, at `path` (full).
    pub(crate) fn refinement(&mut self, path: &Value, message: &str) {
        self.refinements
            .push(json!({ "code": "custom", "message": message, "path": path }));
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.unions.is_empty() && self.refinements.is_empty()
    }

    fn unions(&self) -> usize {
        self.failed
    }

    /// Report them: the unions first, then the refinements.
    pub(crate) fn settle(self, issues: &mut Issues) {
        for issue in self.unions.into_iter().chain(self.refinements) {
            issues.push_raw(issue);
        }
    }
}

/// Zod's `ZodParsedType` of a JSON value (`undefined` when absent).
fn parsed_type(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn type_issue(path: &Value, expected: &str, value: Option<&Value>) -> Value {
    let received = parsed_type(value);
    let message = if received == "undefined" {
        "Required".to_owned()
    } else {
        format!("Expected {expected}, received {received}")
    };
    json!({
        "code": "invalid_type",
        "expected": expected,
        "received": received,
        "path": path,
        "message": message,
    })
}

/// `z.union([z.string().min(1).max(100), z.number().int().min(0).max(200)])`
/// at `key`: the value as it came, or the issues. A string or a number is
/// checked by its own option (a failing check there is Zod's "dirty"
/// result, reported as is); anything else fails both options.
fn column_ref(
    issues: &mut Issues,
    deferred: &mut Deferred,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Option<Value> {
    let value = body.get(key);
    if matches!(value, Some(Value::String(_) | Value::Number(_))) {
        // The matching option, read on its own; its issues settle later.
        let mut scratch = Issues::default();
        let read = match value {
            Some(Value::String(_)) => scratch
                .text_with(
                    body,
                    key,
                    Presence::Required,
                    Text::length(Some(1), Some(100)),
                )
                .into_option()
                .map(Value::String),
            _ => scratch
                .number(
                    body,
                    key,
                    Presence::Required,
                    Number {
                        coerce: false,
                        int: true,
                        min: Some(0.0),
                        max: Some(200.0),
                    },
                )
                .into_option()
                .and(value.cloned()),
        };
        return match scratch.finish() {
            Ok(()) => read,
            Err(invalid) => {
                let path = issues.path_of(key);
                deferred.dirty(invalid.issues().iter().cloned().map(|mut issue| {
                    issue["path"] = path.clone();
                    issue
                }));
                None
            }
        };
    }
    match value {
        None if presence == Presence::Optional => None,
        value => {
            let path = issues.path_of(key);
            deferred.union(json!({
                "code": "invalid_union",
                "unionErrors": [
                    { "issues": [type_issue(&path, "string", value)], "name": "ZodError" },
                    { "issues": [type_issue(&path, "number", value)], "name": "ZodError" },
                ],
                "path": path,
                "message": "Invalid input",
            }));
            None
        }
    }
}

/// Issue codes that abort a value in Zod (a refinement on the object then
/// does not run); the others only make it "dirty".
fn aborts(issue: &Value) -> bool {
    matches!(
        issue["code"].as_str(),
        Some("invalid_type" | "invalid_enum_value" | "invalid_union")
    ) && issue["expected"] != "integer"
}

/// `csvFormatSchema` at `key` with `presence`: the parsed layout (only the
/// schema's keys, in its order) and the refinements to settle last.
#[allow(clippy::too_many_lines)] // one field after another, as the schema lists them
pub(crate) fn read(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    deferred: &mut Deferred,
) -> Field<Value> {
    let start = issues.count();
    let unions_before = deferred.unions();
    let base = issues.path_of(key);
    let read = issues.nested(body, key, presence, |issues, fields| {
        let mut out = Map::new();
        let mut put = |name: &str, value: Option<Value>| {
            if let Some(value) = value {
                out.insert(name.to_owned(), value);
            }
        };
        put(
            "dateFormat",
            issues
                .choice(
                    fields,
                    "dateFormat",
                    Presence::Required,
                    &["MDY", "DMY", "YMD"],
                )
                .into_option()
                .map(Value::String),
        );
        put(
            "decimalSeparator",
            issues
                .choice(fields, "decimalSeparator", Presence::Required, &[".", ","])
                .into_option()
                .map(Value::String),
        );
        put(
            "thousandsSeparator",
            issues
                .choice(
                    fields,
                    "thousandsSeparator",
                    Presence::Required,
                    &[",", ".", " ", ""],
                )
                .into_option()
                .map(Value::String),
        );
        put(
            "negativeStyle",
            issues
                .choice(
                    fields,
                    "negativeStyle",
                    Presence::Required,
                    &[
                        "minus",
                        "parentheses",
                        "debit_credit_columns",
                        "trailing_minus",
                    ],
                )
                .into_option()
                .map(Value::String),
        );
        let unions = deferred.unions();
        let columns = issues.nested(fields, "columns", Presence::Required, |issues, cols| {
            let mut columns = Map::new();
            for (name, presence) in [
                ("date", Presence::Required),
                ("description", Presence::Required),
                ("amount", Presence::Optional),
                ("debit", Presence::Optional),
                ("credit", Presence::Optional),
                ("checkNumber", Presence::Optional),
                ("payee", Presence::Optional),
                ("reference", Presence::Optional),
            ] {
                if let Some(value) = column_ref(issues, deferred, cols, name, presence) {
                    columns.insert(name.to_owned(), value);
                }
            }
            Value::Object(columns)
        });
        if deferred.unions() == unions {
            put("columns", columns.into_option());
        }
        put(
            "hasHeader",
            issues
                .boolean(fields, "hasHeader", Presence::Required)
                .into_option()
                .map(Value::Bool),
        );
        put(
            "skipRows",
            issues
                .number(
                    fields,
                    "skipRows",
                    Presence::Required,
                    Number {
                        coerce: false,
                        int: true,
                        min: Some(0.0),
                        max: Some(100.0),
                    },
                )
                .into_option()
                .and_then(|_| fields.get("skipRows").cloned()),
        );
        put(
            "delimiter",
            issues
                .choice(
                    fields,
                    "delimiter",
                    Presence::Optional,
                    &[",", ";", "\t", "|"],
                )
                .into_option()
                .map(Value::String),
        );
        Value::Object(out)
    });

    // The two refinements run when nothing aborted the object.
    let raw = body.get(key).and_then(Value::as_object);
    let aborted =
        deferred.unions() > unions_before || issues.issues_since(start).iter().any(aborts);
    let mut refined = false;
    if let Some(raw) = raw
        && !aborted
    {
        let cols = raw.get("columns").and_then(Value::as_object);
        let has = |name: &str| cols.is_some_and(|c| c.contains_key(name));
        if !(has("amount") || has("debit") || has("credit")) {
            refined = true;
            deferred.refinement(
                &path_with(&base, &["columns", "amount"]),
                "Pick an amount column, or a debit and a credit column",
            );
        }
        if raw.get("decimalSeparator") == raw.get("thousandsSeparator") {
            refined = true;
            deferred.refinement(
                &path_with(&base, &["thousandsSeparator"]),
                "The decimal and thousands separators must differ",
            );
        }
    }
    if refined || aborted {
        Field::Absent
    } else {
        read
    }
}

fn path_with(base: &Value, rest: &[&str]) -> Value {
    let mut path = base.as_array().cloned().unwrap_or_default();
    path.extend(
        rest.iter()
            .map(|segment| Value::String((*segment).to_owned())),
    );
    Value::Array(path)
}

/// `csvFormatSchema.safeParse(value).success`: a remembered layout that
/// still reads, as the parsed object.
pub(crate) fn parse_stored(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    let mut issues = Issues::default();
    let mut wrapper = Map::new();
    wrapper.insert("csv".to_owned(), value.clone());
    let mut deferred = Deferred::default();
    let field = read(
        &mut issues,
        &wrapper,
        "csv",
        Presence::Required,
        &mut deferred,
    );
    if !deferred.is_empty() || issues.finish().is_err() {
        return None;
    }
    field.into_option()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> Value {
        json!({
            "dateFormat": "MDY",
            "decimalSeparator": ".",
            "thousandsSeparator": ",",
            "negativeStyle": "minus",
            "columns": { "date": "Date", "description": 1, "amount": "Amount", "extra": 3 },
            "hasHeader": true,
            "skipRows": 0,
            "other": "dropped",
        })
    }

    #[test]
    fn a_valid_layout_keeps_only_the_schema_keys() {
        let parsed = parse_stored(Some(&layout())).expect("valid");
        assert_eq!(parsed.get("other"), None);
        assert_eq!(parsed["columns"].get("extra"), None);
        assert_eq!(parsed["columns"]["description"], json!(1));
    }

    #[test]
    fn refinements_wait_for_the_end() {
        let mut bad = layout();
        bad["columns"] = json!({ "date": "Date", "description": "Text" });
        bad["thousandsSeparator"] = json!(".");
        let mut issues = Issues::default();
        let body = json!({ "csv": bad });
        let mut deferred = Deferred::default();
        let field = read(
            &mut issues,
            body.as_object().expect("object"),
            "csv",
            Presence::Required,
            &mut deferred,
        );
        assert!(field.is_absent());
        assert_eq!(deferred.refinements.len(), 2);
        assert_eq!(
            deferred.refinements[0]["path"],
            json!(["csv", "columns", "amount"])
        );
        assert_eq!(
            deferred.refinements[1]["path"],
            json!(["csv", "thousandsSeparator"])
        );
        assert!(parse_stored(Some(&bad)).is_none());
    }

    #[test]
    fn a_type_error_skips_the_refinements() {
        let mut bad = layout();
        bad["columns"] = json!({ "date": true, "description": "Text" });
        bad["thousandsSeparator"] = json!(".");
        let mut issues = Issues::default();
        let body = json!({ "csv": bad });
        let mut deferred = Deferred::default();
        read(
            &mut issues,
            body.as_object().expect("object"),
            "csv",
            Presence::Required,
            &mut deferred,
        );
        assert_eq!(deferred.refinements, Vec::<Value>::new());
        assert_eq!(deferred.unions(), 1);
    }
}
