//! Request validation that answers like `zValidator('json' | 'query', schema)`
//! (`@hono/zod-validator` 0.4 with Zod 3): a failure is `400` with the
//! `safeParse` result as the body,
//!
//! ```json
//! { "success": false, "error": { "issues": [...], "name": "ZodError" } }
//! ```
//!
//! and each issue carries Zod's own codes, fields, messages and paths. A
//! schema is read field by field, in the schema's order (Zod reports issues
//! in that order); [`Issues::nested`] and [`Issues::list`] read objects and
//! arrays inside the body with their paths. Only the rules the ported routes
//! use are here; add one when a route needs it, with a test against Zod's
//! output.

use std::sync::LazyLock;

use axum::Json;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use regex::Regex;
use serde_json::{Map, Value, json};

/// Zod's name for a JSON value's type (`getParsedType`).
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

/// `z.union([z.string(), z.number()])` failing on `value` at `path`: Zod's
/// `invalid_union`, with one `invalid_type` per option.
/// Zod's `invalid_union` issue of `z.union([z.string(), z.number()])` for
/// `value` at `path` (both options' `invalid_type`).
pub fn string_or_number_issue(path: &Value, value: Option<&Value>) -> Value {
    let received = parsed_type(value);
    let option = |expected: &str| {
        json!({ "issues": [{
            "code": "invalid_type",
            "expected": expected,
            "received": received,
            "path": path,
            "message": if received == "undefined" {
                "Required".to_owned()
            } else {
                format!("Expected {expected}, received {received}")
            },
        }], "name": "ZodError" })
    };
    json!({
        "code": "invalid_union",
        "unionErrors": [option("string"), option("number")],
        "path": path,
        "message": "Invalid input",
    })
}

/// How a field may be left out: Zod's `.optional()`, `.nullable()` and
/// `.nullish()`, or none of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Required,
    Optional,
    Nullable,
    Nullish,
}

/// A field as the schema read it. An invalid field reads as `Absent`; the
/// issue makes [`Issues::finish`] fail.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Field<T> {
    /// Left out (`undefined`).
    #[default]
    Absent,
    /// `null`.
    Null,
    Set(T),
}

impl<T> Field<T> {
    pub fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }

    /// The value, if there is one.
    pub fn as_set(&self) -> Option<&T> {
        match self {
            Self::Set(value) => Some(value),
            _ => None,
        }
    }

    /// `value ?? null`: absent and null both read as `None`.
    pub fn into_option(self) -> Option<T> {
        match self {
            Self::Set(value) => Some(value),
            _ => None,
        }
    }
}

/// A string's checks, in Zod's order: `.trim()` and `.toLowerCase()` change
/// the value first, then the format, then the length.
#[derive(Debug, Clone, Copy, Default)]
pub struct Text {
    pub trim: bool,
    pub lowercase: bool,
    pub format: Option<Format>,
    pub min: Option<usize>,
    pub max: Option<usize>,
}

impl Text {
    /// `z.string().min(min).max(max)`.
    pub const fn length(min: Option<usize>, max: Option<usize>) -> Self {
        Self {
            trim: false,
            lowercase: false,
            format: None,
            min,
            max,
        }
    }

    /// `z.string().trim().min(min).max(max)`.
    pub const fn trimmed(min: Option<usize>, max: Option<usize>) -> Self {
        Self {
            trim: true,
            lowercase: false,
            format: None,
            min,
            max,
        }
    }
}

/// String formats (`invalid_string` issues).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// `.email()`.
    Email,
    /// `.datetime({ offset: true })`.
    DatetimeOffset,
    /// `.datetime()`: UTC only (`Z`).
    Datetime,
    /// `.regex(/^\d+$/)`.
    Digits,
    /// `.url()`: what `new URL(text)` accepts ([`js_url_parses`]).
    Url,
}

/// A number's checks: `z.number()` (`z.coerce.number()` when `coerce`),
/// `.int()`, `.min()`, `.max()`.
#[derive(Debug, Clone, Copy, Default)]
pub struct Number {
    pub coerce: bool,
    pub int: bool,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

/// A failed validation: answers 400 with the `safeParse` result.
#[derive(Debug, Clone, PartialEq)]
pub struct Invalid(Vec<Value>);

impl Invalid {
    /// The issues, as Zod lists them.
    pub fn issues(&self) -> &[Value] {
        &self.0
    }

    /// Zod's `error.flatten()`: messages of root issues in `formErrors`, the
    /// rest by their first path segment in `fieldErrors`, in issue order.
    pub fn flatten(&self) -> Value {
        let mut form_errors = Vec::new();
        let mut field_errors = Map::new();
        for issue in &self.0 {
            let message = issue["message"].clone();
            match issue["path"].get(0) {
                Some(first) => {
                    let key = first
                        .as_str()
                        .map_or_else(|| first.to_string(), str::to_owned);
                    if let Value::Array(messages) = field_errors
                        .entry(key)
                        .or_insert_with(|| Value::Array(Vec::new()))
                    {
                        messages.push(message);
                    }
                }
                None => form_errors.push(message),
            }
        }
        json!({ "formErrors": form_errors, "fieldErrors": field_errors })
    }
}

impl IntoResponse for Invalid {
    fn into_response(self) -> Response {
        let body = json!({ "success": false, "error": { "issues": self.0, "name": "ZodError" } });
        (StatusCode::BAD_REQUEST, Json(body)).into_response()
    }
}

/// Collects issues while a body is read; [`Issues::finish`] turns them into
/// the 400 response.
#[derive(Debug, Default)]
pub struct Issues {
    issues: Vec<Value>,
    /// Where the fields being read sit in the body (`["fields", 2]`).
    prefix: Vec<Value>,
}

impl Issues {
    pub fn is_empty(&self) -> bool {
        self.issues.is_empty()
    }

    /// How many issues so far: where the next field's issues start, for
    /// [`Issues::custom_message`].
    pub fn count(&self) -> usize {
        self.issues.len()
    }

    /// The issues added since `from` (a [`Issues::count`]), for a
    /// refinement that runs only when none of them failed a type check.
    pub fn issues_since(&self, from: usize) -> &[Value] {
        self.issues.get(from..).unwrap_or_default()
    }

    /// A check's custom message (`.min(1, 'Name is required')`): every issue
    /// with `code` added since `from` gets `message`.
    pub fn custom_message(&mut self, from: usize, code: &str, message: &str) {
        for issue in self.issues.iter_mut().skip(from) {
            if issue["code"] == code {
                issue["message"] = Value::String(message.to_owned());
            }
        }
    }

    /// A raw issue at `key` (its `path` filled in), for a check the readers
    /// here have no rule for (a `z.union`, a `z.preprocess`).
    pub fn push_issue(&mut self, key: &str, mut issue: Value) {
        issue["path"] = self.path(key);
        self.issues.push(issue);
    }

    /// An issue whose `path` is already set, pushed as is: one Zod settles
    /// after the body's synchronous checks (an async union's result, a
    /// nested refinement), collected while the body was read.
    pub fn push_raw(&mut self, issue: Value) {
        self.issues.push(issue);
    }

    /// The path `key` is reported at.
    pub fn path_of(&self, key: &str) -> Value {
        self.path(key)
    }

    /// `Err` (a 400 response) when anything was wrong.
    pub fn finish(self) -> Result<(), Invalid> {
        if self.issues.is_empty() {
            Ok(())
        } else {
            Err(Invalid(self.issues))
        }
    }

    /// The path of `key` at the current depth; `None` is the current path
    /// itself (an array item).
    fn path_at(&self, key: Option<&str>) -> Value {
        let mut path = self.prefix.clone();
        if let Some(key) = key {
            path.push(Value::String(key.to_owned()));
        }
        Value::Array(path)
    }

    fn path(&self, key: &str) -> Value {
        self.path_at(Some(key))
    }

    fn invalid_type(&mut self, key: &str, expected: &str, value: Option<&Value>) {
        self.invalid_type_at(Some(key), expected, value);
    }

    fn invalid_type_at(&mut self, key: Option<&str>, expected: &str, value: Option<&Value>) {
        let received = parsed_type(value);
        let message = if received == "undefined" {
            "Required".to_owned()
        } else {
            format!("Expected {expected}, received {received}")
        };
        let path = self.path_at(key);
        self.issues.push(json!({
            "code": "invalid_type",
            "expected": expected,
            "received": received,
            "path": path,
            "message": message,
        }));
    }

    fn push_at(&mut self, path: &Value, expected: &str, value: &Value) {
        let received = parsed_type(Some(value));
        self.issues.push(json!({
            "code": "invalid_type",
            "expected": expected,
            "received": received,
            "path": path,
            "message": format!("Expected {expected}, received {received}"),
        }));
    }

    fn too_small(&mut self, path: &Value, kind: &str, minimum: &Value, message: &str) {
        self.issues.push(json!({
            "code": "too_small",
            "minimum": minimum,
            "type": kind,
            "inclusive": true,
            "exact": false,
            "message": message,
            "path": path,
        }));
    }

    fn too_big(&mut self, path: &Value, kind: &str, maximum: &Value, message: &str) {
        self.issues.push(json!({
            "code": "too_big",
            "maximum": maximum,
            "type": kind,
            "inclusive": true,
            "exact": false,
            "message": message,
            "path": path,
        }));
    }

    /// Absent or null, as `presence` allows: the field read so far. `None`
    /// when there is a value to check.
    fn left_out<T>(
        &mut self,
        key: Option<&str>,
        expected: &str,
        value: Option<&Value>,
        presence: Presence,
    ) -> Option<Field<T>> {
        match value {
            None => {
                if matches!(presence, Presence::Required | Presence::Nullable) {
                    self.invalid_type_at(key, expected, None);
                }
                Some(Field::Absent)
            }
            Some(Value::Null) if matches!(presence, Presence::Nullable | Presence::Nullish) => {
                Some(Field::Null)
            }
            Some(Value::Null) => {
                self.invalid_type_at(key, expected, value);
                Some(Field::Absent)
            }
            Some(_) => None,
        }
    }

    /// The body as an object (`z.object(...)`), or an issue where it sits.
    pub fn object<'a>(&mut self, body: &'a Value) -> Option<&'a Map<String, Value>> {
        if let Value::Object(map) = body {
            return Some(map);
        }
        let path = Value::Array(self.prefix.clone());
        self.push_at(&path, "object", body);
        None
    }

    /// `z.string().min(min).max(max)`, `.optional()` when `required` is false.
    pub fn string(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        required: bool,
        min: Option<usize>,
        max: Option<usize>,
    ) -> Option<String> {
        let presence = if required {
            Presence::Required
        } else {
            Presence::Optional
        };
        self.text(body, key, presence, min, max).into_option()
    }

    /// `z.string().min(min).max(max)` with `presence`.
    pub fn text(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        min: Option<usize>,
        max: Option<usize>,
    ) -> Field<String> {
        self.text_with(body, key, presence, Text::length(min, max))
    }

    /// A string with `rules`, and `presence`.
    pub fn text_with(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        rules: Text,
    ) -> Field<String> {
        self.text_at(Some(key), body.get(key), presence, rules)
    }

    /// An array item as a string with `rules` (`z.array(z.string()...)`),
    /// reported at the item's own path; `None` when invalid.
    pub fn item_text(&mut self, item: &Value, rules: Text) -> Option<String> {
        self.text_at(None, Some(item), Presence::Required, rules)
            .into_option()
    }

    /// An array item as `z.string()` with `rules` then `.regex(pattern,
    /// message)` (`z.array(z.string().min(1).regex(...))`), reported at the
    /// item's own path; `None` when invalid. As in [`Issues::pattern`],
    /// every failing check is reported.
    pub fn item_pattern(
        &mut self,
        item: &Value,
        rules: Text,
        matches: impl Fn(&str) -> bool,
        message: &str,
    ) -> Option<String> {
        let text = self.item_text(item, rules);
        if let Value::String(raw) = item
            && !matches(raw)
        {
            let path = self.path_at(None);
            self.issues.push(json!({
                "validation": "regex",
                "code": "invalid_string",
                "message": message,
                "path": path,
            }));
            return None;
        }
        text
    }

    fn text_at(
        &mut self,
        key: Option<&str>,
        value: Option<&Value>,
        presence: Presence,
        rules: Text,
    ) -> Field<String> {
        if let Some(field) = self.left_out(key, "string", value, presence) {
            return field;
        }
        let Some(Value::String(text)) = value else {
            self.invalid_type_at(key, "string", value);
            return Field::Absent;
        };
        let mut text = if rules.trim {
            js_trim(text).to_owned()
        } else {
            text.clone()
        };
        if rules.lowercase {
            text = text.to_lowercase();
        }
        let before = self.issues.len();
        if let Some(format) = rules.format
            && !format.matches(&text)
        {
            let (validation, message) = format.issue();
            let path = self.path_at(key);
            self.issues.push(json!({
                "validation": validation,
                "code": "invalid_string",
                "message": message,
                "path": path,
            }));
        }
        // Zod counts UTF-16 code units, as JavaScript's `length` does.
        let length = text.encode_utf16().count();
        if let Some(min) = rules.min
            && length < min
        {
            let path = self.path_at(key);
            self.too_small(
                &path,
                "string",
                &json!(min),
                &format!("String must contain at least {min} character(s)"),
            );
        }
        if let Some(max) = rules.max
            && length > max
        {
            let path = self.path_at(key);
            self.too_big(
                &path,
                "string",
                &json!(max),
                &format!("String must contain at most {max} character(s)"),
            );
        }
        if self.issues.len() > before {
            return Field::Absent;
        }
        Field::Set(text)
    }

    /// `z.string().min(min).max(max).regex(pattern, message)` with `presence`:
    /// Zod runs the checks in that order and reports every one that fails,
    /// so a too-short value that doesn't match gets both issues.
    #[allow(clippy::too_many_arguments)]
    pub fn pattern(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        min: Option<usize>,
        max: Option<usize>,
        matches: impl Fn(&str) -> bool,
        message: &str,
    ) -> Field<String> {
        let field = self.text_at(Some(key), body.get(key), presence, Text::length(min, max));
        if let Some(Value::String(text)) = body.get(key)
            && !matches(text)
        {
            let path = self.path(key);
            self.issues.push(json!({
                "validation": "regex",
                "code": "invalid_string",
                "message": message,
                "path": path,
            }));
            return Field::Absent;
        }
        field
    }

    /// An issue a schema reports that the helpers here don't build (a
    /// union of a string and a literal, `.positive()`, `.length(n)`), at
    /// `key` under the current path. `issue` is the rest of Zod's object.
    pub fn issue_at(&mut self, key: &str, issue: Value) {
        let mut issue = issue;
        if let Value::Object(fields) = &mut issue {
            fields.insert("path".to_owned(), self.path(key));
        }
        self.issues.push(issue);
    }

    /// `z.union([z.string(), z.number()])` with `presence`: the value as it
    /// came when it is a string or a number, else Zod's `invalid_union` with
    /// one `invalid_type` per option.
    pub fn string_or_number(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
    ) -> Field<Value> {
        let value = body.get(key);
        let nullable = matches!(presence, Presence::Nullable | Presence::Nullish);
        let optional = matches!(presence, Presence::Optional | Presence::Nullish);
        match value {
            None if optional => return Field::Absent,
            Some(Value::Null) if nullable => return Field::Null,
            _ => {}
        }
        if let Some(Value::String(_) | Value::Number(_)) = value {
            return Field::Set(value.cloned().unwrap_or(Value::Null));
        }
        let path = self.path(key);
        self.issues.push(string_or_number_issue(&path, value));
        Field::Absent
    }

    /// An array item as `z.union([z.string(), z.number()])`
    /// (`z.array(z.union([z.string(), z.number()]))`), reported at the item's
    /// own path; `None` when it is neither.
    pub fn item_string_or_number(&mut self, item: &Value) -> Option<Value> {
        if let Value::String(_) | Value::Number(_) = item {
            return Some(item.clone());
        }
        let path = self.path_at(None);
        self.issues.push(string_or_number_issue(&path, Some(item)));
        None
    }

    /// A failed `.refine(check, { message })` on `key`. Zod runs a refinement
    /// whenever the value got past its type check, even when one of its own
    /// checks failed. `zValidator` parses asynchronously, which settles a
    /// refinement after every synchronous check of the body: call this once
    /// the other fields are read, in key order.
    pub fn custom(&mut self, key: &str, message: &str) {
        let path = self.path(key);
        self.issues
            .push(json!({ "code": "custom", "message": message, "path": path }));
    }

    /// `z.object({...}).refine(check, message)` failing: a `custom` issue
    /// at the object's own path (`[]` for the body). Zod runs the refinement
    /// only when no field failed its type check (a `.min()` failing does not
    /// stop it).
    pub fn custom_here(&mut self, message: &str) {
        let path = self.path_at(None);
        self.issues
            .push(json!({ "code": "custom", "message": message, "path": path }));
    }

    /// A failed refinement deeper in the body (`ctx.addIssue` of a
    /// `.superRefine()` on a nested object or array): `path` from the
    /// current depth, settled after the synchronous checks like
    /// [`Issues::custom`].
    pub fn custom_at(&mut self, path: &[Value], message: &str) {
        let mut full = self.prefix.clone();
        full.extend(path.iter().cloned());
        self.issues
            .push(json!({ "code": "custom", "message": message, "path": Value::Array(full) }));
    }

    /// An object-level `.refine(check, { message })` that failed: a `custom`
    /// issue at the object's own path (`[]` for the body). Call it after the
    /// fields are read, as Zod settles refinements last.
    pub fn custom_root(&mut self, message: &str) {
        let path = self.path_at(None);
        self.issues
            .push(json!({ "code": "custom", "message": message, "path": path }));
    }

    /// `z.coerce.date()` with `presence` (`.optional()`: absent stays absent):
    /// `new Date(value)` as `toISOString()`. Strings are read as ISO dates
    /// (`2026-01-01`, `2026-01-01T10:00:00Z`, with an offset or fraction);
    /// other date strings JavaScript accepts are refused here. `null` is the
    /// epoch, a number milliseconds, a boolean 0 or 1 ms.
    pub fn coerce_date(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
    ) -> Field<String> {
        let value = body.get(key);
        if value.is_none() && presence != Presence::Required {
            return Field::Absent;
        }
        let millis: Option<f64> = match value {
            None | Some(Value::Object(_) | Value::Array(_)) => None,
            Some(Value::Null) => Some(0.0),
            Some(Value::Bool(flag)) => Some(if *flag { 1.0 } else { 0.0 }),
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(text)) => js_date_millis(text),
        };
        let iso = millis.and_then(iso_from_millis);
        if let Some(iso) = iso {
            return Field::Set(iso);
        }
        let path = self.path(key);
        self.issues
            .push(json!({ "code": "invalid_date", "path": path, "message": "Invalid date" }));
        Field::Absent
    }

    /// An array item as `z.string().startsWith(prefix)`, reported at the
    /// item's own path; `None` when invalid.
    pub fn item_starts_with(&mut self, item: &Value, prefix: &str) -> Option<String> {
        let Value::String(text) = item else {
            self.invalid_type_at(None, "string", Some(item));
            return None;
        };
        if text.starts_with(prefix) {
            return Some(text.clone());
        }
        let path = self.path_at(None);
        self.issues.push(json!({
            "code": "invalid_string",
            "validation": { "startsWith": prefix },
            "message": format!("Invalid input: must start with \"{prefix}\""),
            "path": path,
        }));
        None
    }

    /// `z.discriminatedUnion(key, [...])` given an object whose `key` is not
    /// one of `options` (missing included): Zod's only issue for it, at the
    /// discriminator's path. Read the union with [`Issues::nested`] (or
    /// [`Issues::object`] for a body that is the union) and call this when
    /// the discriminator does not pick an option.
    pub fn invalid_discriminator(&mut self, key: &str, options: &[&str]) {
        let expected = options
            .iter()
            .map(|o| format!("'{o}'"))
            .collect::<Vec<_>>()
            .join(" | ");
        let path = self.path(key);
        self.issues.push(json!({
            "code": "invalid_union_discriminator",
            "options": options,
            "path": path,
            "message": format!("Invalid discriminator value. Expected {expected}"),
        }));
    }

    /// A failed `.max(maximum, message)` on the number at `key`: read the
    /// number without its `max`, then call this when it is above `maximum`.
    pub fn number_too_big(&mut self, key: &str, maximum: f64, message: &str) {
        let path = self.path(key);
        self.too_big(&path, "number", &js_number_json(maximum), message);
    }

    /// `z.boolean()` with `presence`.
    pub fn boolean(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
    ) -> Field<bool> {
        let value = body.get(key);
        if let Some(field) = self.left_out(Some(key), "boolean", value, presence) {
            return field;
        }
        if let Some(Value::Bool(flag)) = value {
            return Field::Set(*flag);
        }
        self.invalid_type(key, "boolean", value);
        Field::Absent
    }

    /// `z.number().int()`, `.min(min)` when given, with `presence`.
    pub fn integer(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        min: Option<i64>,
    ) -> Field<i64> {
        #[allow(clippy::cast_precision_loss)]
        let rules = Number {
            int: true,
            min: min.map(|min| min as f64),
            ..Number::default()
        };
        self.whole_number(body, key, presence, rules)
    }

    /// An integer with `rules` (`int` is implied), and `presence`.
    pub fn whole_number(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        rules: Number,
    ) -> Field<i64> {
        let rules = Number { int: true, ..rules };
        match self.number(body, key, presence, rules) {
            // Checked as an integer of at most 2^53 above.
            #[allow(clippy::cast_possible_truncation)]
            Field::Set(number) => Field::Set(number as i64),
            Field::Null => Field::Null,
            Field::Absent => Field::Absent,
        }
    }

    /// A number with `rules`, and `presence`.
    pub fn number(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        rules: Number,
    ) -> Field<f64> {
        let value = body.get(key);
        // `z.coerce.number()` runs `Number(value)` first, `undefined` included.
        let number = if rules.coerce {
            if value.is_none() && presence != Presence::Required {
                return Field::Absent;
            }
            js_number_of(value)
        } else {
            if let Some(field) = self.left_out(Some(key), "number", value, presence) {
                return field;
            }
            let Some(Value::Number(number)) = value else {
                self.invalid_type(key, "number", value);
                return Field::Absent;
            };
            number.as_f64().unwrap_or(f64::NAN)
        };
        if number.is_nan() {
            let path = self.path(key);
            self.issues.push(json!({
                "code": "invalid_type",
                "expected": "number",
                "received": "nan",
                "path": path,
                "message": "Expected number, received nan",
            }));
            return Field::Absent;
        }
        let before = self.issues.len();
        // `Number.isInteger`; beyond 2^53 every double is one.
        if rules.int && !(number.is_finite() && number.fract() == 0.0) {
            let path = self.path(key);
            self.issues.push(json!({
                "code": "invalid_type",
                "expected": "integer",
                "received": "float",
                "message": "Expected integer, received float",
                "path": path,
            }));
        }
        if let Some(min) = rules.min
            && number < min
        {
            let path = self.path(key);
            self.too_small(
                &path,
                "number",
                &js_number_json(min),
                &format!(
                    "Number must be greater than or equal to {}",
                    js_number_text(min)
                ),
            );
        }
        if let Some(max) = rules.max
            && number > max
        {
            let path = self.path(key);
            self.too_big(
                &path,
                "number",
                &js_number_json(max),
                &format!(
                    "Number must be less than or equal to {}",
                    js_number_text(max)
                ),
            );
        }
        if self.issues.len() > before {
            return Field::Absent;
        }
        Field::Set(number)
    }

    /// `z.array(z.record(z.unknown()))` with `presence`: a list of objects.
    pub fn records(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
    ) -> Field<Vec<Value>> {
        self.list(body, key, presence, None, None, |issues, item| {
            issues.object(item).map(|_| item.clone())
        })
    }

    /// `z.array(item).min(min).max(max)` with `presence`. Zod checks the
    /// length first, then reads every item; `read` gets each item with its
    /// index already on the path, and answers `None` for an invalid one.
    pub fn list<T>(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        min: Option<usize>,
        max: Option<usize>,
        read: impl FnMut(&mut Self, &Value) -> Option<T>,
    ) -> Field<Vec<T>> {
        self.list_with(body, key, presence, (min, None), max, read)
    }

    /// [`Issues::list`] with `.min(min, message)`: `min` is the bound and,
    /// when given, the message in place of Zod's default.
    pub fn list_with<T>(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        min: (Option<usize>, Option<&str>),
        max: Option<usize>,
        mut read: impl FnMut(&mut Self, &Value) -> Option<T>,
    ) -> Field<Vec<T>> {
        let (min, min_message) = min;
        let value = body.get(key);
        if let Some(field) = self.left_out(Some(key), "array", value, presence) {
            return field;
        }
        let Some(Value::Array(items)) = value else {
            self.invalid_type(key, "array", value);
            return Field::Absent;
        };
        let before = self.issues.len();
        if let Some(min) = min
            && items.len() < min
        {
            let path = self.path(key);
            let message = min_message.map_or_else(
                || format!("Array must contain at least {min} element(s)"),
                str::to_owned,
            );
            self.too_small(&path, "array", &json!(min), &message);
        }
        if let Some(max) = max
            && items.len() > max
        {
            let path = self.path(key);
            self.too_big(
                &path,
                "array",
                &json!(max),
                &format!("Array must contain at most {max} element(s)"),
            );
        }
        let mut out = Vec::with_capacity(items.len());
        self.prefix.push(Value::String(key.to_owned()));
        for (index, item) in items.iter().enumerate() {
            self.prefix.push(json!(index));
            let read = read(self, item);
            self.prefix.pop();
            if let Some(read) = read {
                out.push(read);
            }
        }
        self.prefix.pop();
        if self.issues.len() > before {
            return Field::Absent;
        }
        Field::Set(out)
    }

    /// `z.object({...})` at `key`, with `presence`: `read` gets its fields
    /// with the key already on the path.
    pub fn nested<T>(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        read: impl FnOnce(&mut Self, &Map<String, Value>) -> T,
    ) -> Field<T> {
        let value = body.get(key);
        if let Some(field) = self.left_out(Some(key), "object", value, presence) {
            return field;
        }
        let Some(Value::Object(fields)) = value else {
            self.invalid_type(key, "object", value);
            return Field::Absent;
        };
        let before = self.issues.len();
        self.prefix.push(Value::String(key.to_owned()));
        let read = read(self, fields);
        self.prefix.pop();
        if self.issues.len() > before {
            return Field::Absent;
        }
        Field::Set(read)
    }

    /// `z.enum([...])` with `presence`.
    pub fn choice(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        options: &[&str],
    ) -> Field<String> {
        let expected = options
            .iter()
            .map(|o| format!("'{o}'"))
            .collect::<Vec<_>>()
            .join(" | ");
        let value = body.get(key);
        if let Some(field) = self.left_out(Some(key), &expected, value, presence) {
            return field;
        }
        match value {
            Some(Value::String(text)) if options.contains(&text.as_str()) => {
                Field::Set(text.clone())
            }
            Some(Value::String(text)) => {
                let path = self.path(key);
                self.issues.push(json!({
                    "received": text,
                    "code": "invalid_enum_value",
                    "options": options,
                    "path": path,
                    "message": format!("Invalid enum value. Expected {expected}, received '{text}'"),
                }));
                Field::Absent
            }
            _ => {
                self.invalid_type(key, &expected, value);
                Field::Absent
            }
        }
    }

    /// An array item as `z.enum([...])` (`z.array(z.enum([...]))`), reported
    /// at the item's own path; `None` when invalid.
    pub fn item_choice(&mut self, item: &Value, options: &[&str]) -> Option<String> {
        let expected = options
            .iter()
            .map(|o| format!("'{o}'"))
            .collect::<Vec<_>>()
            .join(" | ");
        match item {
            Value::String(text) if options.contains(&text.as_str()) => Some(text.clone()),
            Value::String(text) => {
                let path = self.path_at(None);
                self.issues.push(json!({
                    "received": text,
                    "code": "invalid_enum_value",
                    "options": options,
                    "path": path,
                    "message": format!("Invalid enum value. Expected {expected}, received '{text}'"),
                }));
                None
            }
            _ => {
                self.invalid_type_at(None, &expected, Some(item));
                None
            }
        }
    }

    /// `z.union([z.enum(options), z.literal(literal)])` with `presence`: a
    /// value that fails both is one `invalid_union` issue carrying each
    /// option's issues (`unionErrors`).
    pub fn enum_or_literal(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        options: &[&str],
        literal: &str,
    ) -> Field<String> {
        let value = body.get(key);
        match value {
            None if matches!(presence, Presence::Optional | Presence::Nullish) => {
                return Field::Absent;
            }
            Some(Value::Null) if matches!(presence, Presence::Nullable | Presence::Nullish) => {
                return Field::Null;
            }
            Some(Value::String(text)) if options.contains(&text.as_str()) || text == literal => {
                return Field::Set(text.clone());
            }
            _ => {}
        }
        let path = self.path(key);
        let mut first = Self {
            issues: Vec::new(),
            prefix: self.prefix.clone(),
        };
        first.choice(body, key, Presence::Required, options);
        let received = value.cloned().unwrap_or(Value::Null);
        let literal_issue = json!({
            "received": received,
            "code": "invalid_literal",
            "expected": literal,
            "path": path,
            "message": format!("Invalid literal value, expected {}", Value::String(literal.to_owned())),
        });
        self.issues.push(json!({
            "code": "invalid_union",
            "unionErrors": [
                { "issues": first.issues, "name": "ZodError" },
                { "issues": [literal_issue], "name": "ZodError" },
            ],
            "path": path,
            "message": "Invalid input",
        }));
        Field::Absent
    }

    /// `z.enum([...])`, required.
    pub fn one_of(
        &mut self,
        body: &Map<String, Value>,
        key: &str,
        options: &[&str],
    ) -> Option<String> {
        self.choice(body, key, Presence::Required, options)
            .into_option()
    }

    /// `z.string().min(min, message)` failing on `key`, with the schema's
    /// own message.
    pub fn string_too_small(&mut self, key: &str, min: usize, message: &str) {
        let path = self.path(key);
        self.too_small(&path, "string", &json!(min), message);
    }

    /// `z.string().max(max, message)` failing on `key`, with the schema's
    /// own message.
    pub fn string_too_big(&mut self, key: &str, max: usize, message: &str) {
        let path = self.path(key);
        self.too_big(&path, "string", &json!(max), message);
    }

    /// `z.string().length(length)` failing on `key` (a string of
    /// `actual` UTF-16 units): Zod's exact-length issue, too short or too
    /// long.
    pub fn string_length(&mut self, key: &str, length: usize, actual: usize) {
        if actual == length {
            return;
        }
        let path = self.path(key);
        let message = format!("String must contain exactly {length} character(s)");
        let (code, bound) = if actual < length {
            ("too_small", "minimum")
        } else {
            ("too_big", "maximum")
        };
        self.issues.push(json!({
            "code": code,
            bound: length,
            "type": "string",
            "inclusive": true,
            "exact": true,
            "message": message,
            "path": path,
        }));
    }

    #[cfg(test)]
    fn take(self) -> Value {
        Value::Array(self.issues)
    }
}

impl Format {
    fn issue(self) -> (&'static str, &'static str) {
        match self {
            Self::Email => ("email", "Invalid email"),
            Self::DatetimeOffset | Self::Datetime => ("datetime", "Invalid datetime"),
            Self::Digits => ("regex", "Invalid"),
            Self::Url => ("url", "Invalid url"),
        }
    }

    fn matches(self, text: &str) -> bool {
        match self {
            // Zod 3's email regex, minus its lookaheads (no leading dot, no
            // two dots in a row), which Rust's regex has no syntax for.
            Self::Email => !text.starts_with('.') && !text.contains("..") && EMAIL.is_match(text),
            Self::DatetimeOffset => DATETIME_OFFSET.is_match(text),
            Self::Datetime => DATETIME_UTC.is_match(text),
            Self::Digits => !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()),
            Self::Url => js_url_parses(text),
        }
    }
}

/// Whether `new URL(text)` (WHATWG URL, no base) would succeed, as Zod 3's
/// `.url()` checks: a scheme, and for the special schemes a valid host.
/// Covers what profile links and the like send; exotic hosts (IDNA,
/// percent-encoded labels, IPv4 shorthands) are judged by their characters.
pub fn js_url_parses(text: &str) -> bool {
    // The parser strips leading/trailing C0 controls and spaces, and every
    // tab and newline.
    let trimmed = text.trim_matches(|c: char| c <= ' ');
    let cleaned: String = trimmed
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let Some((scheme, rest)) = cleaned.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    let scheme_ok = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !scheme_ok {
        return false;
    }
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "ws" | "wss" | "ftp") {
        // `file:` and the non-special schemes take any rest.
        return true;
    }
    let after = rest.trim_start_matches(['/', '\\']);
    let authority = after
        .split(['/', '\\', '?', '#'])
        .next()
        .unwrap_or_default();
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let (host, port) = if host_port.starts_with('[') {
        match host_port.find(']') {
            Some(end) => (&host_port[..=end], &host_port[end + 1..]),
            None => return false,
        }
    } else {
        match host_port.rsplit_once(':') {
            Some((host, port)) => (host, port),
            None => (host_port, ""),
        }
    };
    let port = port.strip_prefix(':').unwrap_or(port);
    let port_ok = port.is_empty()
        || (port.bytes().all(|b| b.is_ascii_digit())
            && port.parse::<u32>().is_ok_and(|p| p <= 65535));
    if host.is_empty() || !port_ok {
        return false;
    }
    if host.starts_with('[') {
        return host.ends_with(']') && host.len() > 2;
    }
    !host.chars().any(|c| {
        c <= ' '
            || c == '\u{7f}'
            || matches!(
                c,
                '#' | '%' | '/' | ':' | '<' | '>' | '?' | '@' | '[' | '\\' | ']' | '^' | '|'
            )
    })
}

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)^([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$")
        .expect("the email pattern compiles")
});

/// Zod 3.25's date in `datetime()`, leap years checked.
const DATETIME_DATE: &str = r"((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))";
/// Zod 3.25's time in `datetime()`: optional seconds and fraction.
const DATETIME_TIME: &str = r"([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?";

/// Zod 3.25's `datetime({ offset: true })`: a date, a time, and `Z` or
/// `±hh[:]mm`.
static DATETIME_OFFSET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?-u)^{DATETIME_DATE}T{DATETIME_TIME}([+-]\d{{2}}:?\d{{2}}|Z)$"
    ))
    .expect("the datetime pattern compiles")
});

/// Zod 3.25's `datetime()`: a date, a time, and `Z` (UTC only).
static DATETIME_UTC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?-u)^{DATETIME_DATE}T{DATETIME_TIME}Z$"))
        .expect("the datetime pattern compiles")
});

/// `new Date(text).toISOString()` for an ISO date string, `None` for one
/// JavaScript would read as an invalid date (or that is not ISO).
pub fn js_date_iso(text: &str) -> Option<String> {
    js_date_millis(text).and_then(iso_from_millis)
}

/// Days from 1970-01-01 to a civil date (proleptic Gregorian).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil date of a day count from 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if month <= 2 {
            yoe + era * 400 + 1
        } else {
            yoe + era * 400
        },
        month,
        day,
    )
}

/// `Date.parse(text)` for ISO strings: `YYYY-MM-DD` (UTC) and
/// `YYYY-MM-DDTHH:MM[:SS[.fff]](Z|±HH:MM)`.
fn js_date_millis(text: &str) -> Option<f64> {
    static ISO: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$",
        )
        .expect("the ISO date pattern compiles")
    });
    let caps = ISO.captures(text)?;
    let number = |i: usize| -> i64 {
        caps.get(i)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0)
    };
    let (year, month, day) = (number(1), number(2), number(3));
    let (hour, minute, second) = (number(4), number(5), number(6));
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 24
        || minute > 59
        || second > 59
    {
        return None;
    }
    let millis: i64 = caps.get(7).map_or(0, |m| {
        let digits: String = m.as_str().chars().chain("000".chars()).take(3).collect();
        digits.parse().unwrap_or(0)
    });
    let offset_minutes = match caps.get(8).map(|m| m.as_str()) {
        None | Some("Z") => 0,
        Some(offset) => {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let hours: i64 = offset[1..3].parse().ok()?;
            let minutes: i64 = offset[4..6].parse().ok()?;
            sign * (hours * 60 + minutes)
        }
    };
    let days = days_from_civil(year, month, day);
    let total =
        ((days * 24 + hour) * 60 + minute - offset_minutes) * 60_000 + second * 1000 + millis;
    #[allow(clippy::cast_precision_loss)]
    Some(total as f64)
}

/// `new Date(ms).toISOString()`, or `None` for an invalid date.
fn iso_from_millis(millis: f64) -> Option<String> {
    if !millis.is_finite() || millis.abs() > 8.64e15 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    let millis = millis.trunc() as i64;
    let days = millis.div_euclid(86_400_000);
    let rest = millis.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second, ms) = (
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000,
    );
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z"
    ))
}

/// `String.prototype.trim()`: JavaScript's whitespace, which is Unicode
/// `White_Space` plus the BOM.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `Number(value)` for what a body or query string holds.
pub fn js_number_of(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => js_number(text),
        // `Number([x])` is `Number(String(x))`; longer arrays are NaN.
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [Value::String(text)] => js_number(text),
            [item] => js_number_of(Some(item)),
            _ => f64::NAN,
        },
    }
}

/// `Number(text)`: trimmed, empty is 0, decimal or `0x`/`0o`/`0b`, and
/// `Infinity`. Anything else is NaN.
pub fn js_number(text: &str) -> f64 {
    let text = js_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let radix = [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ]
    .into_iter()
    .find_map(|(prefix, radix)| text.strip_prefix(prefix).map(|digits| (digits, radix)));
    if let Some((digits, radix)) = radix {
        #[allow(clippy::cast_precision_loss)]
        return u64::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64);
    }
    let (sign, unsigned) = match text.as_bytes()[0] {
        b'-' => (-1.0, &text[1..]),
        b'+' => (1.0, &text[1..]),
        _ => (1.0, text),
    };
    if unsigned == "Infinity" {
        return sign * f64::INFINITY;
    }
    // Rust also reads `inf` and `NaN`; JavaScript reads only digits here.
    let numeric = unsigned
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'));
    if !numeric
        || !unsigned
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_digit() || b == b'.')
    {
        return f64::NAN;
    }
    unsigned.parse::<f64>().map_or(f64::NAN, |n| sign * n)
}

/// A bound in an issue, as JavaScript writes the number (`8`, not `8.0`).
fn js_number_json(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9.0e15 {
        json!(number as i64)
    } else {
        json!(number)
    }
}

fn js_number_text(number: f64) -> String {
    js_number_json(number).to_string()
}

/// The query string as `zValidator('query', …)` sees it: one value is a
/// string, a repeated key is an array of strings.
pub fn query_values(query: Option<&str>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        let value = Value::String(value.into_owned());
        match out.get_mut(key.as_ref()) {
            None => {
                out.insert(key.into_owned(), value);
            }
            Some(Value::Array(values)) => values.push(value),
            Some(first) => *first = Value::Array(vec![first.take(), value]),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Zod 3's output for `z.object({ priority: z.union([z.enum([...]),
    /// z.literal('normal')]).optional() })`.
    #[test]
    fn enum_or_literal_reads_like_a_zod_union() {
        let options = ["low", "medium", "high", "urgent", "critical"];
        let read = |value: Value| {
            let body = json!({ "priority": value });
            let mut issues = Issues::default();
            let field = issues.enum_or_literal(
                body.as_object().expect("object"),
                "priority",
                Presence::Optional,
                &options,
                "normal",
            );
            (field, issues.take())
        };
        assert_eq!(read(json!("normal")).0, Field::Set("normal".to_owned()));
        assert_eq!(read(json!("high")).0, Field::Set("high".to_owned()));
        assert_eq!(
            read(json!("x")).1,
            json!([{"code":"invalid_union","unionErrors":[{"issues":[{"received":"x","code":"invalid_enum_value","options":["low","medium","high","urgent","critical"],"path":["priority"],"message":"Invalid enum value. Expected 'low' | 'medium' | 'high' | 'urgent' | 'critical', received 'x'"}],"name":"ZodError"},{"issues":[{"received":"x","code":"invalid_literal","expected":"normal","path":["priority"],"message":"Invalid literal value, expected \"normal\""}],"name":"ZodError"}],"path":["priority"],"message":"Invalid input"}])
        );
        assert_eq!(
            read(json!(5)).1,
            json!([{"code":"invalid_union","unionErrors":[{"issues":[{"expected":"'low' | 'medium' | 'high' | 'urgent' | 'critical'","received":"number","code":"invalid_type","path":["priority"],"message":"Expected 'low' | 'medium' | 'high' | 'urgent' | 'critical', received number"}],"name":"ZodError"},{"issues":[{"received":5,"code":"invalid_literal","expected":"normal","path":["priority"],"message":"Invalid literal value, expected \"normal\""}],"name":"ZodError"}],"path":["priority"],"message":"Invalid input"}])
        );
        assert_eq!(
            read(Value::Null).1,
            json!([{"code":"invalid_union","unionErrors":[{"issues":[{"expected":"'low' | 'medium' | 'high' | 'urgent' | 'critical'","received":"null","code":"invalid_type","path":["priority"],"message":"Expected 'low' | 'medium' | 'high' | 'urgent' | 'critical', received null"}],"name":"ZodError"},{"issues":[{"received":null,"code":"invalid_literal","expected":"normal","path":["priority"],"message":"Invalid literal value, expected \"normal\""}],"name":"ZodError"}],"path":["priority"],"message":"Invalid input"}])
        );
    }

    /// Zod 3's output for `z.object({ values: z.array(z.union([z.string(),
    /// z.number()])) })` with a boolean item.
    #[test]
    fn union_items_read_like_zod() {
        let body = json!({ "values": ["x", 3, true] });
        let mut issues = Issues::default();
        let field = issues.list(
            body.as_object().expect("object"),
            "values",
            Presence::Required,
            None,
            None,
            Issues::item_string_or_number,
        );
        assert_eq!(field, Field::Absent);
        assert_eq!(
            issues.take(),
            json!([{"code":"invalid_union","unionErrors":[{"issues":[{"code":"invalid_type","expected":"string","received":"boolean","path":["values",2],"message":"Expected string, received boolean"}],"name":"ZodError"},{"issues":[{"code":"invalid_type","expected":"number","received":"boolean","path":["values",2],"message":"Expected number, received boolean"}],"name":"ZodError"}],"path":["values",2],"message":"Invalid input"}])
        );
        let mut issues = Issues::default();
        let body = json!({ "values": ["x", 3] });
        let field = issues.list(
            body.as_object().expect("object"),
            "values",
            Presence::Required,
            None,
            None,
            Issues::item_string_or_number,
        );
        assert_eq!(field, Field::Set(vec![json!("x"), json!(3)]));
        assert_eq!(issues.issues_since(0), &[] as &[Value]);
    }

    #[test]
    fn exact_lengths_like_zod() {
        let mut issues = Issues::default();
        issues.string_length("country", 2, 6);
        issues.string_length("country", 2, 1);
        issues.string_length("country", 2, 2);
        assert_eq!(
            issues.take(),
            json!([
                {"code":"too_big","maximum":2,"type":"string","inclusive":true,"exact":true,"message":"String must contain exactly 2 character(s)","path":["country"]},
                {"code":"too_small","minimum":2,"type":"string","inclusive":true,"exact":true,"message":"String must contain exactly 2 character(s)","path":["country"]}
            ])
        );
    }

    #[test]
    fn urls_parse_like_new_url() {
        for valid in [
            "https://ann.example",
            "https://github.com/cy?tab=1#top",
            "http://user:pw@host:8080/x",
            "mailto:bob@acme.test",
            "localhost:3000",
            "  https://a.test  ",
            "http://[::1]:80/",
            "file:///etc/hosts",
        ] {
            assert!(js_url_parses(valid), "{valid}");
        }
        for invalid in [
            "not a url",
            "example.com",
            "/relative",
            "http://",
            "https://exa mple.com",
            "http://a.test:99999",
            "http://a.test:8o",
            "1http://a.test",
            "",
        ] {
            assert!(!js_url_parses(invalid), "{invalid}");
        }
    }

    /// Issues Zod 3 produced for the same input (`safeParse`, JSON-serialised).
    /// `createObjectTemplateSchema` and `createCustomObjectSchema`: regex
    /// after the length checks, a refinement after a failed check, and an
    /// array minimum with its own message (Zod 3's issues for these bodies).
    #[test]
    fn patterns_refinements_and_list_messages_match_zod() {
        let lowercase = |text: &str| {
            text.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                && text
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        };
        let mut issues = Issues::default();
        let body = json!({ "slug": "", "fields": [] });
        let object = issues.object(&body).expect("object");
        issues.pattern(
            object,
            "slug",
            Presence::Required,
            Some(1),
            Some(24),
            lowercase,
            "Slug must start with a letter",
        );
        issues.list_with(
            object,
            "fields",
            Presence::Required,
            (Some(1), Some("Select at least one field")),
            None,
            |issues, item| issues.item_text(item, Text::length(Some(1), None)),
        );
        issues.custom("slug", "Reserved");
        assert_eq!(
            issues.take(),
            json!([
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["slug"]},
                {"validation":"regex","code":"invalid_string","message":"Slug must start with a letter","path":["slug"]},
                {"code":"too_small","minimum":1,"type":"array","inclusive":true,"exact":false,"message":"Select at least one field","path":["fields"]},
                {"code":"custom","message":"Reserved","path":["slug"]}
            ])
        );
    }

    /// `z.object({ config: z.discriminatedUnion('provider', [...]) })` given
    /// `{ config: {} }` (WeldPass's sync-target config; Zod 3's issue).
    #[test]
    fn discriminated_unions_match_zod() {
        let mut issues = Issues::default();
        let body = json!({ "config": {} });
        let object = issues.object(&body).expect("object");
        issues.nested(object, "config", Presence::Required, |issues, _| {
            issues.invalid_discriminator(
                "provider",
                &["cloudflare_workers", "cloudflare_pages", "vercel"],
            );
        });
        assert_eq!(
            issues.take(),
            json!([{"code":"invalid_union_discriminator","options":["cloudflare_workers","cloudflare_pages","vercel"],"path":["config","provider"],"message":"Invalid discriminator value. Expected 'cloudflare_workers' | 'cloudflare_pages' | 'vercel'"}])
        );
    }

    #[test]
    fn custom_messages_and_refinements_match_zod() {
        // z.object({ name: z.string().trim().min(1, 'Name is required').max(200, …),
        //            phone: z.string().refine(…, 'Enter a valid phone number') })
        let mut issues = Issues::default();
        issues.string_too_small("name", 1, "Name is required");
        issues.custom("phone", "Enter a valid phone number");
        issues.string_too_big("nick", 200, "Name must be 200 characters or fewer");
        assert_eq!(
            issues.take(),
            json!([
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"Name is required","path":["name"]},
                {"code":"custom","message":"Enter a valid phone number","path":["phone"]},
                {"code":"too_big","maximum":200,"type":"string","inclusive":true,"exact":false,"message":"Name must be 200 characters or fewer","path":["nick"]}
            ])
        );
    }

    #[test]
    fn issues_match_zod() {
        let mut issues = Issues::default();
        let body = json!({ "permission": "" });
        let object = issues.object(&body).expect("object");
        issues.string(object, "permission", true, Some(1), Some(100));
        issues.string(object, "pageLabel", false, None, Some(120));
        assert_eq!(
            issues.take(),
            json!([{"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["permission"]}])
        );

        let mut issues = Issues::default();
        let body = json!({});
        issues.string(issues_object(&body), "permission", true, None, None);
        assert_eq!(
            issues.take(),
            json!([{"code":"invalid_type","expected":"string","received":"undefined","path":["permission"],"message":"Required"}])
        );

        let mut issues = Issues::default();
        let body = json!({ "status": "x" });
        issues.one_of(issues_object(&body), "status", &["approved", "denied"]);
        assert_eq!(
            issues.take(),
            json!([{"received":"x","code":"invalid_enum_value","options":["approved","denied"],"path":["status"],"message":"Invalid enum value. Expected 'approved' | 'denied', received 'x'"}])
        );

        let mut issues = Issues::default();
        assert!(issues.object(&json!([1])).is_none());
        assert_eq!(
            issues.take()[0]["message"],
            "Expected object, received array"
        );
    }

    /// Zod 3's issues for the rules the know schemas use (run against `zod`
    /// in core-api-client; the same issues, key order aside).
    #[test]
    fn optional_nullable_numbers_and_records_match_zod() {
        let mut issues = Issues::default();
        let body = json!({});
        let fields = issues_object(&body);
        assert_eq!(
            issues.text(fields, "name", Presence::Optional, Some(1), None),
            Field::Absent
        );
        assert_eq!(
            issues.text(fields, "icon", Presence::Nullish, None, Some(3)),
            Field::Absent
        );
        issues.text(fields, "parentId", Presence::Nullable, None, None);
        assert_eq!(
            issues.take(),
            json!([{"code":"invalid_type","expected":"string","received":"undefined","path":["parentId"],"message":"Required"}])
        );

        let mut issues = Issues::default();
        let body = json!({ "description": null, "icon": "abcd", "visibility": "x", "isDefault": "yes",
            "sortOrder": 1.5, "position": -1, "parentId": 3, "contentJson": [{}, 1, null, []] });
        let fields = issues_object(&body);
        issues.text(fields, "description", Presence::Optional, None, None);
        issues.text(fields, "icon", Presence::Nullish, None, Some(3));
        issues.choice(
            fields,
            "visibility",
            Presence::Optional,
            &["open", "closed", "private"],
        );
        issues.boolean(fields, "isDefault", Presence::Optional);
        issues.integer(fields, "sortOrder", Presence::Optional, None);
        issues.integer(fields, "position", Presence::Optional, Some(0));
        issues.text(fields, "parentId", Presence::Nullable, None, None);
        issues.records(fields, "contentJson", Presence::Optional);
        assert_eq!(
            issues.take(),
            json!([
                {"code":"invalid_type","expected":"string","received":"null","path":["description"],"message":"Expected string, received null"},
                {"code":"too_big","maximum":3,"type":"string","inclusive":true,"exact":false,"message":"String must contain at most 3 character(s)","path":["icon"]},
                {"received":"x","code":"invalid_enum_value","options":["open","closed","private"],"path":["visibility"],"message":"Invalid enum value. Expected 'open' | 'closed' | 'private', received 'x'"},
                {"code":"invalid_type","expected":"boolean","received":"string","path":["isDefault"],"message":"Expected boolean, received string"},
                {"code":"invalid_type","expected":"integer","received":"float","message":"Expected integer, received float","path":["sortOrder"]},
                {"code":"too_small","minimum":0,"type":"number","inclusive":true,"exact":false,"message":"Number must be greater than or equal to 0","path":["position"]},
                {"code":"invalid_type","expected":"string","received":"number","path":["parentId"],"message":"Expected string, received number"},
                {"code":"invalid_type","expected":"object","received":"number","path":["contentJson",1],"message":"Expected object, received number"},
                {"code":"invalid_type","expected":"object","received":"null","path":["contentJson",2],"message":"Expected object, received null"},
                {"code":"invalid_type","expected":"object","received":"array","path":["contentJson",3],"message":"Expected object, received array"}
            ])
        );

        let mut issues = Issues::default();
        let body = json!({ "visibility": 3, "sortOrder": "1", "position": 2.5, "contentJson": {}, "parentId": null });
        let fields = issues_object(&body);
        issues.choice(
            fields,
            "visibility",
            Presence::Optional,
            &["open", "closed", "private"],
        );
        issues.integer(fields, "sortOrder", Presence::Optional, None);
        issues.integer(fields, "position", Presence::Optional, Some(0));
        assert_eq!(
            issues.text(fields, "parentId", Presence::Nullable, None, None),
            Field::Null
        );
        issues.records(fields, "contentJson", Presence::Optional);
        assert_eq!(
            issues.take(),
            json!([
                {"expected":"'open' | 'closed' | 'private'","received":"number","code":"invalid_type","path":["visibility"],"message":"Expected 'open' | 'closed' | 'private', received number"},
                {"code":"invalid_type","expected":"number","received":"string","path":["sortOrder"],"message":"Expected number, received string"},
                {"code":"invalid_type","expected":"integer","received":"float","message":"Expected integer, received float","path":["position"]},
                {"code":"invalid_type","expected":"array","received":"object","path":["contentJson"],"message":"Expected array, received object"}
            ])
        );

        let mut issues = Issues::default();
        let body =
            json!({ "position": 3.0, "isLocked": true, "contentJson": [{ "type": "paragraph" }] });
        let fields = issues_object(&body);
        assert_eq!(
            issues.integer(fields, "position", Presence::Optional, Some(0)),
            Field::Set(3)
        );
        assert_eq!(
            issues.boolean(fields, "isLocked", Presence::Optional),
            Field::Set(true)
        );
        assert_eq!(
            issues.records(fields, "contentJson", Presence::Required),
            Field::Set(vec![json!({ "type": "paragraph" })])
        );
        assert!(issues.is_empty());
    }

    const EMAIL_RULES: Text = Text {
        trim: true,
        lowercase: true,
        format: Some(Format::Email),
        min: None,
        max: Some(10),
    };

    /// Zod 3.25.76 on sign's string rules (scratch script against `zod` in
    /// app-api-client).
    #[test]
    fn trimmed_lowercased_and_formatted_strings_match_zod() {
        let body = json!({ "email": "  A.B@Example.COM " });
        let mut issues = Issues::default();
        issues.text_with(
            issues_object(&body),
            "email",
            Presence::Required,
            EMAIL_RULES,
        );
        assert_eq!(
            issues.take(),
            json!([{"code":"too_big","maximum":10,"type":"string","inclusive":true,"exact":false,"message":"String must contain at most 10 character(s)","path":["email"]}])
        );

        let body = json!({ "email": "not an email at all" });
        let mut issues = Issues::default();
        issues.text_with(
            issues_object(&body),
            "email",
            Presence::Required,
            EMAIL_RULES,
        );
        assert_eq!(
            issues.take(),
            json!([
                {"validation":"email","code":"invalid_string","message":"Invalid email","path":["email"]},
                {"code":"too_big","maximum":10,"type":"string","inclusive":true,"exact":false,"message":"String must contain at most 10 character(s)","path":["email"]}
            ])
        );

        for (email, ok) in [
            ("a..b@x.io", false),
            (".a@x.io", false),
            ("a@x.c", false),
            ("Ab@X.io", true),
        ] {
            let body = json!({ "email": email });
            let mut issues = Issues::default();
            let read = issues.text_with(
                issues_object(&body),
                "email",
                Presence::Required,
                Text {
                    max: None,
                    ..EMAIL_RULES
                },
            );
            assert_eq!(issues.is_empty(), ok, "{email}");
            if ok {
                assert_eq!(read, Field::Set(email.to_lowercase()));
            }
        }

        let body = json!({ "a": "   ", "b": "  abcdef ", "c": "  abc " });
        let mut issues = Issues::default();
        let fields = issues_object(&body);
        issues.text_with(
            fields,
            "a",
            Presence::Required,
            Text::trimmed(Some(1), Some(5)),
        );
        issues.text_with(
            fields,
            "b",
            Presence::Required,
            Text::trimmed(Some(1), Some(5)),
        );
        assert_eq!(
            issues.text_with(
                fields,
                "c",
                Presence::Required,
                Text::trimmed(Some(1), Some(5))
            ),
            Field::Set("abc".to_owned())
        );
        let issues = issues.take();
        assert_eq!(issues[0]["code"], "too_small");
        assert_eq!(issues[1]["code"], "too_big");
    }

    #[test]
    fn datetimes_match_zod() {
        for (at, ok) in [
            ("2026-10-29T07:00:00Z", true),
            ("2026-10-29T07:00:00.123+02:00", true),
            ("2026-10-29T07:00Z", true),
            ("2026-10-29T07:00:00+0200", true),
            ("2026-10-29T07:00:00+02", false),
            ("2026-10-29", false),
            ("2026-02-29T00:00:00Z", false),
            ("2024-02-29T00:00:00Z", true),
            ("2026-10-29T24:00:00Z", false),
            ("2026-10-29 07:00:00Z", false),
            ("2026-10-29T07:00:00.Z", false),
        ] {
            assert_eq!(Format::DatetimeOffset.matches(at), ok, "{at}");
        }
        let body = json!({ "at": "2026-10-29" });
        let mut issues = Issues::default();
        let rules = Text {
            format: Some(Format::DatetimeOffset),
            ..Text::default()
        };
        issues.text_with(issues_object(&body), "at", Presence::Nullable, rules);
        assert_eq!(
            issues.take(),
            json!([{"code":"invalid_string","validation":"datetime","message":"Invalid datetime","path":["at"]}])
        );
    }

    #[test]
    fn utc_datetimes_match_zod() {
        // z.string().datetime(), checked against Zod 3.25.
        for (at, ok) in [
            ("2026-10-29T07:00:00Z", true),
            ("2026-10-29T07:00Z", true),
            ("2026-10-29T07:00:00.123456Z", true),
            ("2024-02-29T00:00:00Z", true),
            ("2026-10-29T07:00:00.123+02:00", false),
            ("2026-10-29T07:00:00", false),
            ("2026-10-29", false),
            ("2026-02-29T00:00:00Z", false),
            ("2026-10-29T07:00:00.Z", false),
        ] {
            assert_eq!(Format::Datetime.matches(at), ok, "{at}");
        }
        let body = json!({ "expiresAt": "soon" });
        let mut issues = Issues::default();
        let rules = Text {
            format: Some(Format::Datetime),
            ..Text::default()
        };
        issues.text_with(issues_object(&body), "expiresAt", Presence::Optional, rules);
        assert_eq!(
            issues.take(),
            json!([{"code":"invalid_string","validation":"datetime","message":"Invalid datetime","path":["expiresAt"]}])
        );
    }

    #[test]
    fn numbers_and_coerced_query_numbers_match_zod() {
        let body = json!({ "d": 91, "w": 7.5, "x": -0.1 });
        let mut issues = Issues::default();
        let fields = issues_object(&body);
        let days = Number {
            int: true,
            min: Some(1.0),
            max: Some(90.0),
            ..Number::default()
        };
        issues.whole_number(fields, "d", Presence::Required, days);
        issues.number(
            fields,
            "w",
            Presence::Required,
            Number {
                min: Some(8.0),
                ..Number::default()
            },
        );
        issues.number(
            fields,
            "x",
            Presence::Required,
            Number {
                min: Some(0.0),
                ..Number::default()
            },
        );
        assert_eq!(
            issues.take(),
            json!([
                {"code":"too_big","maximum":90,"type":"number","inclusive":true,"exact":false,"message":"Number must be less than or equal to 90","path":["d"]},
                {"code":"too_small","minimum":8,"type":"number","inclusive":true,"exact":false,"message":"Number must be greater than or equal to 8","path":["w"]},
                {"code":"too_small","minimum":0,"type":"number","inclusive":true,"exact":false,"message":"Number must be greater than or equal to 0","path":["x"]}
            ])
        );

        let limit = Number {
            coerce: true,
            int: true,
            min: Some(1.0),
            max: Some(200.0),
        };
        let digits = Text {
            format: Some(Format::Digits),
            ..Text::default()
        };
        let query = query_values(Some("limit=abc&cursor=1a&search=+abcd+"));
        let mut issues = Issues::default();
        issues.text_with(
            &query,
            "search",
            Presence::Optional,
            Text::trimmed(None, Some(3)),
        );
        issues.whole_number(&query, "limit", Presence::Optional, limit);
        issues.text_with(&query, "cursor", Presence::Optional, digits);
        assert_eq!(
            issues.take(),
            json!([
                {"code":"too_big","maximum":3,"type":"string","inclusive":true,"exact":false,"message":"String must contain at most 3 character(s)","path":["search"]},
                {"code":"invalid_type","expected":"number","received":"nan","path":["limit"],"message":"Expected number, received nan"},
                {"validation":"regex","code":"invalid_string","message":"Invalid","path":["cursor"]}
            ])
        );

        for (query, expected) in [
            (
                "limit=&cursor=10",
                json!([{"code":"too_small","minimum":1,"type":"number","inclusive":true,"exact":false,"message":"Number must be greater than or equal to 1","path":["limit"]}]),
            ),
            (
                "limit=2.5",
                json!([{"code":"invalid_type","expected":"integer","received":"float","message":"Expected integer, received float","path":["limit"]}]),
            ),
            (
                "limit=1&limit=2",
                json!([{"code":"invalid_type","expected":"number","received":"nan","path":["limit"],"message":"Expected number, received nan"}]),
            ),
            (
                "limit=201",
                json!([{"code":"too_big","maximum":200,"type":"number","inclusive":true,"exact":false,"message":"Number must be less than or equal to 200","path":["limit"]}]),
            ),
        ] {
            let query = query_values(Some(query));
            let mut issues = Issues::default();
            issues.whole_number(&query, "limit", Presence::Optional, limit);
            issues.text_with(&query, "cursor", Presence::Optional, digits);
            assert_eq!(issues.take(), expected);
        }
        let query = query_values(Some("limit=0x10"));
        let mut issues = Issues::default();
        assert_eq!(
            issues.whole_number(&query, "limit", Presence::Optional, limit),
            Field::Set(16)
        );
        assert_eq!(
            issues.whole_number(&Map::new(), "limit", Presence::Optional, limit),
            Field::Absent
        );
    }

    #[test]
    fn refinements_add_a_custom_issue_after_the_string_checks() {
        // z.object({ name: z.string().trim().min(1).refine(() => false, { message: 'No' }) })
        //   .safeParse({ name: '  ' }) — the refinement still runs on the too-short string.
        let body = json!({ "name": "  " });
        let mut issues = Issues::default();
        let fields = issues_object(&body);
        issues.text_with(
            fields,
            "name",
            Presence::Required,
            Text::trimmed(Some(1), None),
        );
        issues.custom("name", "No");
        assert_eq!(
            issues.take(),
            json!([
                {
                    "code": "too_small", "minimum": 1, "type": "string", "inclusive": true,
                    "exact": false, "message": "String must contain at least 1 character(s)",
                    "path": ["name"]
                },
                { "code": "custom", "message": "No", "path": ["name"] }
            ])
        );
    }

    #[test]
    fn nested_objects_and_lists_carry_their_paths() {
        let body = json!({ "source": { "entityType": "x" }, "fields": [{ "page": -1 }, { "page": 1, "label": " abcd " }, {}] });
        let mut issues = Issues::default();
        let fields = issues_object(&body);
        issues.nested(fields, "source", Presence::Nullish, |issues, source| {
            issues.choice(
                source,
                "entityType",
                Presence::Required,
                &["file", "company"],
            );
            issues.text(source, "entityId", Presence::Required, Some(1), Some(255));
        });
        issues.list(
            fields,
            "fields",
            Presence::Required,
            None,
            Some(2),
            |issues, item| {
                let item = issues.object(item)?;
                issues.integer(item, "page", Presence::Required, Some(0));
                issues.text_with(
                    item,
                    "label",
                    Presence::Nullish,
                    Text::trimmed(None, Some(3)),
                );
                Some(())
            },
        );
        assert_eq!(
            issues.take(),
            json!([
                {"received":"x","code":"invalid_enum_value","options":["file","company"],"path":["source","entityType"],"message":"Invalid enum value. Expected 'file' | 'company', received 'x'"},
                {"code":"invalid_type","expected":"string","received":"undefined","path":["source","entityId"],"message":"Required"},
                {"code":"too_big","maximum":2,"type":"array","inclusive":true,"exact":false,"message":"Array must contain at most 2 element(s)","path":["fields"]},
                {"code":"too_small","minimum":0,"type":"number","inclusive":true,"exact":false,"message":"Number must be greater than or equal to 0","path":["fields",0,"page"]},
                {"code":"too_big","maximum":3,"type":"string","inclusive":true,"exact":false,"message":"String must contain at most 3 character(s)","path":["fields",1,"label"]},
                {"code":"invalid_type","expected":"number","received":"undefined","path":["fields",2,"page"],"message":"Required"}
            ])
        );

        let body = json!({ "source": "file", "fields": "no" });
        let mut issues = Issues::default();
        let fields = issues_object(&body);
        issues.nested(fields, "source", Presence::Nullish, |_, _| ());
        issues.list(
            fields,
            "fields",
            Presence::Required,
            None,
            Some(2),
            |_, _| Some(()),
        );
        assert_eq!(
            issues.take(),
            json!([
                {"code":"invalid_type","expected":"object","received":"string","path":["source"],"message":"Expected object, received string"},
                {"code":"invalid_type","expected":"array","received":"string","path":["fields"],"message":"Expected array, received string"}
            ])
        );
    }

    fn issues_object(body: &Value) -> &Map<String, Value> {
        body.as_object().expect("object")
    }
}

/// A body that says it is JSON but doesn't parse: Hono's validator answers
/// `400` with the text `Malformed JSON in request body`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MalformedJson;

impl IntoResponse for MalformedJson {
    fn into_response(self) -> Response {
        (StatusCode::BAD_REQUEST, "Malformed JSON in request body").into_response()
    }
}

/// What `zValidator('json', …)` validates: the parsed body when the request's
/// content type is JSON (`application/json`, `application/*+json`), else `{}`,
/// which then fails as missing fields.
pub fn json_body(content_type: Option<&str>, body: &[u8]) -> Result<Value, MalformedJson> {
    let media = content_type
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase());
    let is_json = media.as_deref().is_some_and(|media| {
        media
            .strip_prefix("application/")
            .is_some_and(|subtype| subtype == "json" || subtype.ends_with("+json"))
    });
    if !is_json {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_slice(body).map_err(|_| MalformedJson)
}

#[cfg(test)]
mod body_tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn json_bodies_like_hono() {
        assert_eq!(
            json_body(Some("application/json; charset=utf-8"), b"{\"a\":1}"),
            Ok(json!({ "a": 1 }))
        );
        assert_eq!(
            json_body(Some("application/vnd.api+json"), b"[]"),
            Ok(json!([]))
        );
        assert_eq!(json_body(Some("text/plain"), b"{\"a\":1}"), Ok(json!({})));
        assert_eq!(json_body(None, b""), Ok(json!({})));
        assert_eq!(
            json_body(Some("application/json"), b"{nope"),
            Err(MalformedJson)
        );
    }
}
