//! The payroll routes' Zod schemas (`schemas/weldhr-payroll.ts`) and what a
//! plain `zValidator` makes of them: the parsed value (unknown keys
//! stripped, strings trimmed where the schema trims) or Zod's issues as the
//! 400. Zod runs every check of a field and reports each failure, in the
//! order the schema lists them; this does too.

use axum::Json;
use axum::body::Bytes;
use axum::response::IntoResponse;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_core_domain::js::number_text;

use crate::validation::{body_of, query_values};
use crate::HrError;

/// A string check, in the order the schema adds it.
#[derive(Clone, Copy)]
pub(crate) enum Check {
    Trim,
    Min(usize),
    Max(usize),
    Length(usize),
    Regex(fn(&str) -> bool, &'static str),
}

/// A schema.
#[derive(Clone)]
pub(crate) enum S {
    Str(Vec<Check>),
    Num { int: bool, min: Option<f64>, max: Option<f64> },
    Bool,
    Null,
    Enum(&'static [&'static str]),
    /// `z.literal(n)` of a number.
    NumLiteral(f64),
    Obj(Vec<(&'static str, S)>),
    Record(Box<S>, Box<S>),
    Union(Vec<S>),
    DiscUnion(&'static str, Vec<(&'static str, S)>),
    Optional(Box<S>),
    Nullable(Box<S>),
    /// `.default(value)`.
    Default(Box<S>, Value),
    /// `z.array(item)` with an optional `.max(n)`.
    Array(Box<S>, Option<usize>),
    /// `z.coerce.number()` (`.int()`, bounds): `Number(input)` first.
    CoerceNum { int: bool, min: Option<f64>, max: Option<f64> },
}

impl S {
    pub(crate) fn optional(self) -> S {
        S::Optional(Box::new(self))
    }

    pub(crate) fn nullable(self) -> S {
        S::Nullable(Box::new(self))
    }

    /// `.nullable().optional()`.
    pub(crate) fn nullish(self) -> S {
        self.nullable().optional()
    }
}

/// `z.string()` with checks.
pub(crate) fn string(checks: &[Check]) -> S {
    S::Str(checks.to_vec())
}

/// `z.string().trim().max(max)` (`shortText`).
pub(crate) fn short_text(max: usize) -> S {
    S::Str(vec![Check::Trim, Check::Max(max)])
}

/// `shortText(max).min(1)`.
pub(crate) fn short_text_required(max: usize) -> S {
    S::Str(vec![Check::Trim, Check::Max(max), Check::Min(1)])
}

/// `z.number()` with bounds.
pub(crate) fn number(min: Option<f64>, max: Option<f64>) -> S {
    S::Num { int: false, min, max }
}

/// `z.number().int()` with bounds.
pub(crate) fn int(min: Option<f64>, max: Option<f64>) -> S {
    S::Num { int: true, min, max }
}

pub(crate) fn is_iso_date_shape(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// `isoDate`.
pub(crate) fn iso_date() -> S {
    S::Str(vec![Check::Regex(is_iso_date_shape, "Expected YYYY-MM-DD")])
}

/// `id`: `z.string().min(1).max(30)`.
pub(crate) fn id() -> S {
    S::Str(vec![Check::Min(1), Check::Max(30)])
}

/// `money`, `nonNegativeMoney`, `percent`.
pub(crate) fn money() -> S {
    number(Some(-10_000_000.0), Some(10_000_000.0))
}

pub(crate) fn non_negative_money() -> S {
    number(Some(0.0), Some(10_000_000.0))
}

pub(crate) fn percent() -> S {
    number(Some(0.0), Some(100.0))
}

fn two_upper(text: &str) -> bool {
    text.len() == 2 && text.bytes().all(|b| b.is_ascii_uppercase())
}

/// `usState`.
pub(crate) fn us_state() -> S {
    S::Str(vec![Check::Regex(two_upper, "Expected a two-letter state code")])
}

pub(crate) fn year_key(text: &str) -> bool {
    text.len() == 4 && text.bytes().all(|b| b.is_ascii_digit())
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Zod's `getParsedType`.
fn parsed_type(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(n)) => {
            if n.as_f64().is_some_and(f64::is_nan) {
                "nan"
            } else {
                "number"
            }
        }
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn js_number(n: f64) -> Value {
    weldsuite_core_domain::js::number_value(n)
}

struct Ctx {
    issues: Vec<Value>,
}

impl Ctx {
    fn invalid_type(&mut self, path: &[Value], expected: &str, value: Option<&Value>) {
        let received = parsed_type(value);
        let message =
            if received == "undefined" { "Required".to_owned() } else { format!("Expected {expected}, received {received}") };
        self.issues.push(json!({
            "code": "invalid_type", "expected": expected, "received": received, "path": path, "message": message,
        }));
    }
}

fn quote_join(options: &[&str]) -> String {
    options.iter().map(|o| format!("'{o}'")).collect::<Vec<_>>().join(" | ")
}

/// The outcome of one schema on one value, as Zod's parse status: valid,
/// absent (an optional left out), dirty (issues, but the type matched: the
/// value goes on and refinements still run) or aborted.
enum Out {
    Value(Value),
    Absent,
    Dirty(Value),
    Aborted,
}

fn string_out(ctx: &mut Ctx, checks: &[Check], raw: &str, path: &[Value]) -> Out {
    let mut text = raw.to_owned();
    let before = ctx.issues.len();
    for check in checks {
        match *check {
            Check::Trim => text = weldsuite_kit::validation::js_trim(&text).to_owned(),
            Check::Min(min) => {
                if utf16_len(&text) < min {
                    ctx.issues.push(json!({
                        "code": "too_small", "minimum": min, "type": "string", "inclusive": true, "exact": false,
                        "message": format!("String must contain at least {min} character(s)"), "path": path,
                    }));
                }
            }
            Check::Max(max) => {
                if utf16_len(&text) > max {
                    ctx.issues.push(json!({
                        "code": "too_big", "maximum": max, "type": "string", "inclusive": true, "exact": false,
                        "message": format!("String must contain at most {max} character(s)"), "path": path,
                    }));
                }
            }
            Check::Length(length) => {
                let len = utf16_len(&text);
                if len > length {
                    ctx.issues.push(json!({
                        "code": "too_big", "maximum": length, "type": "string", "inclusive": true, "exact": true,
                        "message": format!("String must contain exactly {length} character(s)"), "path": path,
                    }));
                } else if len < length {
                    ctx.issues.push(json!({
                        "code": "too_small", "minimum": length, "type": "string", "inclusive": true, "exact": true,
                        "message": format!("String must contain exactly {length} character(s)"), "path": path,
                    }));
                }
            }
            Check::Regex(matches, message) => {
                if !matches(&text) {
                    ctx.issues.push(json!({ "validation": "regex", "code": "invalid_string", "message": message, "path": path }));
                }
            }
        }
    }
    if ctx.issues.len() > before { Out::Dirty(Value::String(text)) } else { Out::Value(Value::String(text)) }
}

fn number_out(ctx: &mut Ctx, int: bool, min: Option<f64>, max: Option<f64>, value: &Value, path: &[Value]) -> Out {
    let n = value.as_f64().unwrap_or(f64::NAN);
    let before = ctx.issues.len();
    if int && n.fract() != 0.0 {
        ctx.issues.push(json!({
            "code": "invalid_type", "expected": "integer", "received": "float", "path": path,
            "message": "Expected integer, received float",
        }));
    }
    if let Some(min) = min.filter(|m| n < *m) {
        ctx.issues.push(json!({
            "code": "too_small", "minimum": js_number(min), "type": "number", "inclusive": true, "exact": false,
            "message": format!("Number must be greater than or equal to {}", number_text(min)), "path": path,
        }));
    }
    if let Some(max) = max.filter(|m| n > *m) {
        ctx.issues.push(json!({
            "code": "too_big", "maximum": js_number(max), "type": "number", "inclusive": true, "exact": false,
            "message": format!("Number must be less than or equal to {}", number_text(max)), "path": path,
        }));
    }
    if ctx.issues.len() > before { Out::Dirty(value.clone()) } else { Out::Value(value.clone()) }
}

/// The fields of an object schema over `fields`.
fn object_out(ctx: &mut Ctx, shape: &[(&'static str, S)], fields: &Map<String, Value>, path: &[Value]) -> Out {
    let mut out = Map::new();
    let (mut dirty, mut aborted) = (false, false);
    for (key, schema) in shape {
        let mut at = path.to_vec();
        at.push(Value::String((*key).to_owned()));
        match parse(ctx, schema, fields.get(*key), &at) {
            Out::Value(v) => {
                out.insert((*key).to_owned(), v);
            }
            Out::Dirty(v) => {
                dirty = true;
                out.insert((*key).to_owned(), v);
            }
            Out::Absent => {}
            Out::Aborted => aborted = true,
        }
    }
    if aborted {
        Out::Aborted
    } else if dirty {
        Out::Dirty(Value::Object(out))
    } else {
        Out::Value(Value::Object(out))
    }
}

fn parse(ctx: &mut Ctx, schema: &S, value: Option<&Value>, path: &[Value]) -> Out {
    match schema {
        S::Optional(inner) => match value {
            None => Out::Absent,
            Some(_) => parse(ctx, inner, value, path),
        },
        S::Nullable(inner) => match value {
            Some(Value::Null) => Out::Value(Value::Null),
            _ => parse(ctx, inner, value, path),
        },
        S::Default(inner, default) => match value {
            None => Out::Value(default.clone()),
            Some(_) => parse(ctx, inner, value, path),
        },
        S::Null => match value {
            Some(Value::Null) => Out::Value(Value::Null),
            _ => {
                ctx.invalid_type(path, "null", value);
                Out::Aborted
            }
        },
        S::Bool => match value {
            Some(Value::Bool(b)) => Out::Value(Value::Bool(*b)),
            _ => {
                ctx.invalid_type(path, "boolean", value);
                Out::Aborted
            }
        },
        S::Str(checks) => match value {
            Some(Value::String(raw)) => string_out(ctx, checks, raw, path),
            _ => {
                ctx.invalid_type(path, "string", value);
                Out::Aborted
            }
        },
        S::CoerceNum { int, min, max } => {
            let n = match value {
                None => f64::NAN,
                Some(Value::String(text)) => weldsuite_kit::validation::js_number(text),
                Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
                Some(Value::Bool(b)) => f64::from(u8::from(*b)),
                Some(Value::Null) => 0.0,
                Some(_) => f64::NAN,
            };
            if n.is_nan() {
                ctx.issues.push(json!({
                    "code": "invalid_type", "expected": "number", "received": "nan", "path": path,
                    "message": "Expected number, received nan",
                }));
                return Out::Aborted;
            }
            number_out(ctx, *int, *min, *max, &js_number(n), path)
        }
        S::Num { int, min, max } => match value {
            Some(v @ Value::Number(_)) => number_out(ctx, *int, *min, *max, v, path),
            _ => {
                ctx.invalid_type(path, "number", value);
                Out::Aborted
            }
        },
        S::Enum(options) => match value {
            Some(Value::String(text)) if options.contains(&text.as_str()) => Out::Value(Value::String(text.clone())),
            Some(Value::String(text)) => {
                ctx.issues.push(json!({
                    "received": text, "code": "invalid_enum_value", "options": options, "path": path,
                    "message": format!("Invalid enum value. Expected {}, received '{text}'", quote_join(options)),
                }));
                Out::Aborted
            }
            _ => {
                ctx.invalid_type(path, &quote_join(options), value);
                Out::Aborted
            }
        },
        S::NumLiteral(expected) => match value {
            Some(Value::Number(n)) if n.as_f64() == Some(*expected) => Out::Value(js_number(*expected)),
            _ => {
                let mut issue = json!({
                    "code": "invalid_literal", "expected": js_number(*expected), "path": path,
                    "message": format!("Invalid literal value, expected {}", number_text(*expected)),
                });
                if let (Some(v), Some(o)) = (value, issue.as_object_mut()) {
                    o.insert("received".to_owned(), v.clone());
                }
                ctx.issues.push(issue);
                Out::Aborted
            }
        },
        S::Obj(shape) => match value {
            Some(Value::Object(fields)) => object_out(ctx, shape, fields, path),
            _ => {
                ctx.invalid_type(path, "object", value);
                Out::Aborted
            }
        },
        S::Record(key_schema, value_schema) => {
            let Some(Value::Object(fields)) = value else {
                ctx.invalid_type(path, "object", value);
                return Out::Aborted;
            };
            let mut out = Map::new();
            let (mut dirty, mut aborted) = (false, false);
            for (key, item) in fields {
                let mut at = path.to_vec();
                at.push(Value::String(key.clone()));
                let parsed_key = parse(ctx, key_schema, Some(&Value::String(key.clone())), &at);
                let parsed_value = parse(ctx, value_schema, Some(item), &at);
                match (parsed_key, parsed_value) {
                    (Out::Aborted, _) | (_, Out::Aborted) => aborted = true,
                    (Out::Value(Value::String(k)) | Out::Dirty(Value::String(k)), v) => {
                        if matches!(v, Out::Dirty(_)) {
                            dirty = true;
                        }
                        if let Out::Value(v) | Out::Dirty(v) = v {
                            out.insert(k, v);
                        }
                    }
                    _ => dirty = true,
                }
            }
            if aborted {
                Out::Aborted
            } else if dirty {
                Out::Dirty(Value::Object(out))
            } else {
                Out::Value(Value::Object(out))
            }
        }
        S::Array(item_schema, max) => {
            let Some(Value::Array(items)) = value else {
                ctx.invalid_type(path, "array", value);
                return Out::Aborted;
            };
            let mut out = vec![];
            let (mut dirty, mut aborted) = (false, false);
            for (i, item) in items.iter().enumerate() {
                let mut at = path.to_vec();
                at.push(json!(i));
                match parse(ctx, item_schema, Some(item), &at) {
                    Out::Value(v) => out.push(v),
                    Out::Dirty(v) => {
                        dirty = true;
                        out.push(v);
                    }
                    Out::Absent => out.push(Value::Null),
                    Out::Aborted => aborted = true,
                }
            }
            if let Some(max) = max.filter(|m| items.len() > *m) {
                ctx.issues.push(json!({
                    "code": "too_big", "maximum": max, "type": "array", "inclusive": true, "exact": false,
                    "message": format!("Array must contain at most {max} element(s)"), "path": path,
                }));
                dirty = true;
            }
            if aborted {
                Out::Aborted
            } else if dirty {
                Out::Dirty(Value::Array(out))
            } else {
                Out::Value(Value::Array(out))
            }
        }
        S::Union(options) => {
            let mut dirty: Option<(Vec<Value>, Value)> = None;
            let mut errors = vec![];
            for option in options {
                let mut inner = Ctx { issues: vec![] };
                match parse(&mut inner, option, value, path) {
                    Out::Value(v) => return Out::Value(v),
                    Out::Absent => return Out::Absent,
                    Out::Dirty(v) => {
                        if dirty.is_none() {
                            dirty = Some((inner.issues.clone(), v));
                        }
                    }
                    Out::Aborted => {}
                }
                errors.push(json!({ "issues": inner.issues, "name": "ZodError" }));
            }
            if let Some((issues, v)) = dirty {
                ctx.issues.extend(issues);
                return Out::Dirty(v);
            }
            ctx.issues.push(json!({ "code": "invalid_union", "unionErrors": errors, "path": path, "message": "Invalid input" }));
            Out::Aborted
        }
        S::DiscUnion(key, options) => {
            let Some(Value::Object(fields)) = value else {
                ctx.invalid_type(path, "object", value);
                return Out::Aborted;
            };
            let wanted = fields.get(*key).and_then(Value::as_str);
            match options.iter().find(|(tag, _)| Some(*tag) == wanted) {
                Some((tag, S::Obj(shape))) => {
                    let tagged = |mut out: Map<String, Value>| {
                        out.insert((*key).to_owned(), Value::String((*tag).to_owned()));
                        Value::Object(out)
                    };
                    match object_out(ctx, shape, fields, path) {
                        Out::Value(Value::Object(out)) => Out::Value(tagged(out)),
                        Out::Dirty(Value::Object(out)) => Out::Dirty(tagged(out)),
                        other => other,
                    }
                }
                Some((_, other)) => parse(ctx, other, value, path),
                None => {
                    let tags: Vec<&str> = options.iter().map(|(t, _)| *t).collect();
                    let mut at = path.to_vec();
                    at.push(Value::String((*key).to_owned()));
                    ctx.issues.push(json!({
                        "code": "invalid_union_discriminator", "options": tags, "path": at,
                        "message": format!("Invalid discriminator value. Expected {}", quote_join(&tags)),
                    }));
                    Out::Aborted
                }
            }
        }
    }
}

/// Zod's parse of `value`: the value as far as it parsed (when not
/// aborted, so refinements can run) and the issues.
pub(crate) fn parse_partial(schema: &S, value: &Value) -> (Option<Value>, Vec<Value>) {
    let mut ctx = Ctx { issues: vec![] };
    let out = match parse(&mut ctx, schema, Some(value), &[]) {
        Out::Value(v) | Out::Dirty(v) => Some(v),
        Out::Absent => Some(Value::Null),
        Out::Aborted => None,
    };
    (out, ctx.issues)
}

/// Zod's `safeParse` of `value`: the parsed value or the issues.
pub(crate) fn safe_parse(schema: &S, value: &Value) -> Result<Value, Vec<Value>> {
    match parse_partial(schema, value) {
        (Some(v), issues) if issues.is_empty() => Ok(v),
        (_, issues) => Err(issues),
    }
}

/// The 400 a plain `zValidator` answers.
pub(crate) fn zod_error(issues: Vec<Value>) -> HrError {
    let body = json!({ "success": false, "error": { "issues": issues, "name": "ZodError" } });
    HrError::from((StatusCode::BAD_REQUEST, Json(body)).into_response())
}

/// `zValidator('json', schema)`: the parsed body.
pub(crate) fn json_body(headers: &HeaderMap, body: &Bytes, schema: &S) -> Result<Value, HrError> {
    let value = body_of(headers, body)?;
    safe_parse(schema, &value).map_err(zod_error)
}

/// `zValidator('query', schema)`: the parsed query.
pub(crate) fn query(raw: Option<&str>, schema: &S) -> Result<Value, HrError> {
    let values = Value::Object(query_values(raw));
    safe_parse(schema, &values).map_err(zod_error)
}

/// A string field of a parsed object.
pub(crate) fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Whether a parsed object has `key` (set, maybe to null).
pub(crate) fn has(value: &Value, key: &str) -> bool {
    value.as_object().is_some_and(|o| o.contains_key(key))
}
