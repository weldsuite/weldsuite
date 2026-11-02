//! Zod 3 schemas as data, and the parser that reads a body with them the way
//! `zValidator` does (`safeParseAsync`).
//!
//! The public API validates its bodies with the client packages' Zod schemas
//! (`@weldsuite/core-api-client/schemas/*`, `@weldsuite/app-api-client`).
//! `tools/generate.mts` walks those schemas and writes each one as a [`Z`]
//! tree (`schemas_gen.rs`); what a schema computes in JavaScript
//! (`.refine`, `.transform`, `z.preprocess`) is a hook in `hooks.rs`.
//!
//! Issues come out as Zod's: same codes, fields, paths and messages. Their
//! order follows the async parse: every synchronous check in key order
//! first, then refinements, preprocessed fields, unions and object-level
//! refinements, each settling a few microtasks later (`tier`).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use axum::response::{IntoResponse, Response};
use regex::Regex;
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Format, Issues, js_coerce_date, js_number, js_trim};

/// A check's own message (`.min(1, 'Name is required')`), else Zod's.
pub(crate) type Msg = Option<&'static str>;

/// `z.string()` checks, in the schema's order.
#[derive(Debug, Clone, Copy)]
pub(crate) enum S {
    Min(usize, Msg),
    Max(usize, Msg),
    Len(usize, Msg),
    Email(Msg),
    Url(Msg),
    Uuid(Msg),
    /// `.datetime()` (`offset`: `.datetime({ offset: true })`).
    Datetime {
        offset: bool,
        msg: Msg,
    },
    /// `.regex(pattern)`: a JavaScript pattern Rust's regex reads alike.
    Regex(&'static str, Msg),
    StartsWith(&'static str, Msg),
    EndsWith(&'static str, Msg),
    Trim,
    Lower,
    Upper,
}

/// `z.number()` checks, in the schema's order.
#[derive(Debug, Clone, Copy)]
pub(crate) enum N {
    Int(Msg),
    /// `.min(n)` / `.gte(n)` (inclusive) and `.positive()` / `.gt(n)`.
    Min(f64, bool, Msg),
    Max(f64, bool, Msg),
    Finite(Msg),
}

/// What a `z.object()` does with keys it doesn't know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Keys {
    Strip,
    Passthrough,
    Strict,
}

/// A `z.literal()`.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Lit {
    Str(&'static str),
    Num(f64),
    Bool(bool),
}

/// `.refine()` / `.superRefine()`: checks the parsed value (absent is
/// `None`) and adds issues at the value's path.
pub(crate) type RefineFn = fn(Option<&Value>, &mut Hook);
/// `.transform()`: the parsed value in, the output out.
pub(crate) type TransformFn = fn(Option<Value>) -> Option<Value>;
/// `z.preprocess()`: the raw value in, what the inner schema reads out.
pub(crate) type PreprocessFn = fn(Option<&Value>) -> Option<Value>;

/// A Zod schema.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Z {
    Str(&'static [S]),
    /// `z.coerce.string()`.
    CoerceStr(&'static [S]),
    Num(&'static [N]),
    /// `z.coerce.number()`.
    CoerceNum(&'static [N]),
    Bool,
    /// `z.coerce.boolean()`.
    CoerceBool,
    /// `z.date()`: never valid from JSON.
    Date,
    /// `z.coerce.date()`.
    CoerceDate,
    Enum(&'static [&'static str], Msg),
    Lit(Lit),
    /// `z.any()` / `z.unknown()`.
    Any,
    Null,
    /// `z.array(item)` with `.min()` and `.max()`.
    Arr(&'static Z, Option<(usize, Msg)>, Option<(usize, Msg)>),
    /// `z.record(value)` (string keys).
    Rec(&'static Z),
    Obj(&'static [(&'static str, Z)], Keys),
    Union(&'static [Z]),
    /// `z.discriminatedUnion(key, options)`; each option an object.
    Disc(&'static str, &'static [Z]),
    Opt(&'static Z),
    Nul(&'static Z),
    /// `.default(value)` (the value as JSON).
    Def(&'static Z, &'static str),
    Refine(&'static Z, RefineFn),
    Transform(&'static Z, TransformFn),
    Pre(PreprocessFn, &'static Z),
}

/// What a refinement hook sees: where the value sits, and the issues it adds.
pub(crate) struct Hook {
    path: Vec<Value>,
    issues: Vec<Value>,
}

impl Hook {
    /// `ctx.addIssue({ code: 'custom', message })` / a failed `.refine(…, message)`.
    pub(crate) fn fail(&mut self, message: &str) {
        self.fail_at(&[], message);
    }

    /// A custom issue at `path` below the value (`.superRefine` with `path`).
    pub(crate) fn fail_at(&mut self, path: &[Value], message: &str) {
        let mut full = self.path.clone();
        full.extend(path.iter().cloned());
        self.issues
            .push(json!({ "code": "custom", "message": message, "path": full }));
    }
}

/// Zod's parse status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum St {
    Valid,
    Dirty,
    Aborted,
}

/// One parse: the issues with the microtask tier each settles at, the path,
/// and where `Date`s came out.
#[derive(Default)]
struct Ctx {
    issues: Vec<(u8, Value)>,
    path: Vec<Value>,
    tier: u8,
    dates: Vec<Vec<Value>>,
}

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

/// A number as JavaScript writes it (`8`, not `8.0`).
pub(crate) fn js_number_value(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9.0e15 {
        json!(number as i64)
    } else {
        serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
    }
}

fn js_number_text(number: f64) -> String {
    js_number_value(number).to_string()
}

/// `joinValues(options, " | ")`.
fn join_options(options: &[&str]) -> String {
    options
        .iter()
        .map(|o| format!("'{o}'"))
        .collect::<Vec<_>>()
        .join(" | ")
}

fn uuid_matches(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn regex_matches(pattern: &'static str, text: &str) -> bool {
    static CACHE: LazyLock<Mutex<HashMap<&'static str, Regex>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let regex = cache
        .entry(pattern)
        .or_insert_with(|| Regex::new(pattern).expect("a schema pattern compiles"));
    regex.is_match(text)
}

impl Ctx {
    fn push(&mut self, mut issue: Value, message: String) {
        if let Value::Object(fields) = &mut issue {
            fields.insert("path".into(), Value::Array(self.path.clone()));
            fields.insert("message".into(), Value::String(message));
        }
        self.issues.push((self.tier, issue));
    }

    fn invalid_type(&mut self, expected: &str, value: Option<&Value>) {
        let received = parsed_type(value);
        let message = if received == "undefined" {
            "Required".to_owned()
        } else {
            format!("Expected {expected}, received {received}")
        };
        self.push(
            json!({ "code": "invalid_type", "expected": expected, "received": received }),
            message,
        );
    }

    fn at<T>(&mut self, segment: Value, run: impl FnOnce(&mut Self) -> T) -> T {
        self.path.push(segment);
        let out = run(self);
        self.path.pop();
        out
    }

    #[allow(
        clippy::too_many_lines,
        clippy::match_same_arms,
        clippy::single_match_else
    )]
    fn parse(&mut self, z: &Z, value: Option<&Value>) -> (St, Option<Value>) {
        match *z {
            Z::Str(checks) => match value {
                Some(Value::String(text)) => self.string(checks, text.clone()),
                other => {
                    self.invalid_type("string", other);
                    (St::Aborted, None)
                }
            },
            Z::CoerceStr(checks) => {
                let text = match value {
                    None => "undefined".to_owned(),
                    Some(Value::Null) => "null".to_owned(),
                    Some(Value::String(text)) => text.clone(),
                    Some(Value::Bool(flag)) => flag.to_string(),
                    Some(Value::Number(n)) => js_number_text(n.as_f64().unwrap_or(f64::NAN)),
                    Some(Value::Array(_)) => String::new(),
                    Some(Value::Object(_)) => "[object Object]".to_owned(),
                };
                self.string(checks, text)
            }
            Z::Num(checks) => match value {
                Some(Value::Number(n)) => self.number(checks, n.as_f64().unwrap_or(f64::NAN)),
                other => {
                    self.invalid_type("number", other);
                    (St::Aborted, None)
                }
            },
            Z::CoerceNum(checks) => {
                let number = match value {
                    None => f64::NAN,
                    Some(Value::Null) => 0.0,
                    Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
                    Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
                    Some(Value::String(text)) => js_number(text),
                    Some(Value::Array(items)) => match items.as_slice() {
                        [] => 0.0,
                        [Value::String(text)] => js_number(text),
                        [Value::Number(n)] => n.as_f64().unwrap_or(f64::NAN),
                        _ => f64::NAN,
                    },
                    Some(Value::Object(_)) => f64::NAN,
                };
                self.number(checks, number)
            }
            Z::Bool => match value {
                Some(Value::Bool(flag)) => (St::Valid, Some(Value::Bool(*flag))),
                other => {
                    self.invalid_type("boolean", other);
                    (St::Aborted, None)
                }
            },
            Z::CoerceBool => {
                let flag = match value {
                    None | Some(Value::Null) => false,
                    Some(Value::Bool(flag)) => *flag,
                    Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
                    Some(Value::String(text)) => !text.is_empty(),
                    Some(Value::Array(_) | Value::Object(_)) => true,
                };
                (St::Valid, Some(Value::Bool(flag)))
            }
            Z::Date => {
                self.invalid_type("date", value);
                (St::Aborted, None)
            }
            Z::CoerceDate => match js_coerce_date(value) {
                Some(iso) => {
                    self.dates.push(self.path.clone());
                    (St::Valid, Some(Value::String(iso)))
                }
                None => {
                    self.push(json!({ "code": "invalid_date" }), "Invalid date".to_owned());
                    (St::Aborted, None)
                }
            },
            Z::Enum(options, msg) => self.enumeration(options, msg, value),
            Z::Lit(lit) => {
                let ok = match (lit, value) {
                    (Lit::Str(s), Some(Value::String(t))) => s == t,
                    (Lit::Num(n), Some(Value::Number(v))) => v.as_f64() == Some(n),
                    (Lit::Bool(b), Some(Value::Bool(v))) => b == *v,
                    _ => false,
                };
                if ok {
                    return (St::Valid, value.cloned());
                }
                let expected = match lit {
                    Lit::Str(s) => json!(s),
                    Lit::Num(n) => js_number_value(n),
                    Lit::Bool(b) => json!(b),
                };
                let message = format!("Invalid literal value, expected {expected}");
                self.push(
                    json!({ "received": value.cloned().unwrap_or(Value::Null), "code": "invalid_literal", "expected": expected }),
                    message,
                );
                (St::Aborted, None)
            }
            Z::Any => (St::Valid, value.cloned()),
            Z::Null => match value {
                Some(Value::Null) => (St::Valid, Some(Value::Null)),
                other => {
                    self.invalid_type("null", other);
                    (St::Aborted, None)
                }
            },
            Z::Arr(item, min, max) => self.array(item, min, max, value),
            Z::Rec(item) => match value {
                Some(Value::Object(fields)) => {
                    let mut status = St::Valid;
                    let mut out = Map::new();
                    for (key, field) in fields {
                        let (st, parsed) = self.at(json!(key), |ctx| ctx.parse(item, Some(field)));
                        status = status.max(st);
                        if let Some(parsed) = parsed {
                            out.insert(key.clone(), parsed);
                        }
                    }
                    if status == St::Aborted {
                        return (St::Aborted, None);
                    }
                    (status, Some(Value::Object(out)))
                }
                other => {
                    self.invalid_type("object", other);
                    (St::Aborted, None)
                }
            },
            Z::Obj(shape, keys) => self.object(shape, keys, value),
            Z::Union(options) => self.union(options, value),
            Z::Disc(key, options) => {
                let Some(Value::Object(fields)) = value else {
                    self.invalid_type("object", value);
                    return (St::Aborted, None);
                };
                let wanted = fields.get(key);
                let mut names: Vec<&'static str> = Vec::new();
                let mut chosen = None;
                for option in options {
                    if let Z::Obj(shape, _) = option
                        && let Some((_, Z::Lit(Lit::Str(name)))) =
                            shape.iter().find(|(field, _)| field == &key)
                    {
                        names.push(name);
                        if wanted.and_then(Value::as_str) == Some(*name) {
                            chosen = Some(option);
                        }
                    }
                }
                match chosen {
                    Some(option) => self.parse(option, value),
                    None => {
                        let message = format!(
                            "Invalid discriminator value. Expected {}",
                            join_options(&names)
                        );
                        self.at(json!(key), |ctx| {
                            ctx.push(
                                json!({ "code": "invalid_union_discriminator", "options": names }),
                                message,
                            );
                        });
                        (St::Aborted, None)
                    }
                }
            }
            Z::Opt(inner) => match value {
                None => (St::Valid, None),
                Some(_) => self.parse(inner, value),
            },
            Z::Nul(inner) => match value {
                Some(Value::Null) => (St::Valid, Some(Value::Null)),
                _ => self.parse(inner, value),
            },
            Z::Def(inner, default) => match value {
                None => {
                    let fallback: Value = serde_json::from_str(default).unwrap_or(Value::Null);
                    self.parse(inner, Some(&fallback))
                }
                Some(_) => self.parse(inner, value),
            },
            Z::Refine(inner, check) => {
                let (status, parsed) = self.parse(inner, value);
                if status == St::Aborted {
                    return (St::Aborted, None);
                }
                let mut hook = Hook {
                    path: self.path.clone(),
                    issues: Vec::new(),
                };
                check(parsed.as_ref(), &mut hook);
                let tier = self.tier.saturating_add(settle_delay(inner));
                let failed = !hook.issues.is_empty();
                self.issues
                    .extend(hook.issues.into_iter().map(|issue| (tier, issue)));
                (if failed { St::Dirty } else { status }, parsed)
            }
            Z::Transform(inner, transform) => {
                let (status, parsed) = self.parse(inner, value);
                if status != St::Valid {
                    return (status, parsed);
                }
                (St::Valid, transform(parsed))
            }
            Z::Pre(preprocess, inner) => {
                let processed = preprocess(value);
                let tier = self.tier;
                self.tier = tier.saturating_add(1);
                let out = self.parse(inner, processed.as_ref());
                self.tier = tier;
                out
            }
        }
    }

    fn string(&mut self, checks: &[S], mut text: String) -> (St, Option<Value>) {
        let mut status = St::Valid;
        let length = |text: &str| text.encode_utf16().count();
        for check in checks {
            let failed: Option<(Value, String)> = match *check {
                S::Trim => {
                    text = js_trim(&text).to_owned();
                    None
                }
                S::Lower => {
                    text = text.to_lowercase();
                    None
                }
                S::Upper => {
                    text = text.to_uppercase();
                    None
                }
                S::Min(min, msg) => (length(&text) < min).then(|| {
                    (
                        json!({ "code": "too_small", "minimum": min, "type": "string", "inclusive": true, "exact": false }),
                        msg.map_or_else(|| format!("String must contain at least {min} character(s)"), str::to_owned),
                    )
                }),
                S::Max(max, msg) => (length(&text) > max).then(|| {
                    (
                        json!({ "code": "too_big", "maximum": max, "type": "string", "inclusive": true, "exact": false }),
                        msg.map_or_else(|| format!("String must contain at most {max} character(s)"), str::to_owned),
                    )
                }),
                S::Len(len, msg) => {
                    let actual = length(&text);
                    (actual != len).then(|| {
                        let (code, bound) = if actual < len {
                            ("too_small", "minimum")
                        } else {
                            ("too_big", "maximum")
                        };
                        (
                            json!({ "code": code, bound: len, "type": "string", "inclusive": true, "exact": true }),
                            msg.map_or_else(|| format!("String must contain exactly {len} character(s)"), str::to_owned),
                        )
                    })
                }
                S::Email(msg) => format_issue(Format::Email, &text, msg),
                S::Url(msg) => format_issue(Format::Url, &text, msg),
                S::Datetime { offset, msg } => format_issue(
                    if offset {
                        Format::DatetimeOffset
                    } else {
                        Format::Datetime
                    },
                    &text,
                    msg,
                ),
                S::Uuid(msg) => (!uuid_matches(&text)).then(|| {
                    (
                        json!({ "validation": "uuid", "code": "invalid_string" }),
                        msg.unwrap_or("Invalid uuid").to_owned(),
                    )
                }),
                S::Regex(pattern, msg) => (!regex_matches(pattern, &text)).then(|| {
                    (
                        json!({ "validation": "regex", "code": "invalid_string" }),
                        msg.unwrap_or("Invalid").to_owned(),
                    )
                }),
                S::StartsWith(prefix, msg) => (!text.starts_with(prefix)).then(|| {
                    (
                        json!({ "code": "invalid_string", "validation": { "startsWith": prefix } }),
                        msg.map_or_else(|| format!("Invalid input: must start with \"{prefix}\""), str::to_owned),
                    )
                }),
                S::EndsWith(suffix, msg) => (!text.ends_with(suffix)).then(|| {
                    (
                        json!({ "code": "invalid_string", "validation": { "endsWith": suffix } }),
                        msg.map_or_else(|| format!("Invalid input: must end with \"{suffix}\""), str::to_owned),
                    )
                }),
            };
            if let Some((issue, message)) = failed {
                self.push(issue, message);
                status = St::Dirty;
            }
        }
        (status, Some(Value::String(text)))
    }

    fn number(&mut self, checks: &[N], number: f64) -> (St, Option<Value>) {
        if number.is_nan() {
            self.push(
                json!({ "code": "invalid_type", "expected": "number", "received": "nan" }),
                "Expected number, received nan".to_owned(),
            );
            return (St::Aborted, None);
        }
        let mut status = St::Valid;
        for check in checks {
            let failed: Option<(Value, String)> = match *check {
                N::Int(msg) => (!(number.is_finite() && number.fract() == 0.0)).then(|| {
                    (
                        json!({ "code": "invalid_type", "expected": "integer", "received": "float" }),
                        msg.unwrap_or("Expected integer, received float").to_owned(),
                    )
                }),
                N::Min(min, inclusive, msg) => {
                    let low = if inclusive { number < min } else { number <= min };
                    low.then(|| {
                        let words = if inclusive {
                            "greater than or equal to "
                        } else {
                            "greater than "
                        };
                        (
                            json!({ "code": "too_small", "minimum": js_number_value(min), "type": "number", "inclusive": inclusive, "exact": false }),
                            msg.map_or_else(|| format!("Number must be {words}{}", js_number_text(min)), str::to_owned),
                        )
                    })
                }
                N::Max(max, inclusive, msg) => {
                    let high = if inclusive { number > max } else { number >= max };
                    high.then(|| {
                        let words = if inclusive {
                            "less than or equal to"
                        } else {
                            "less than"
                        };
                        (
                            json!({ "code": "too_big", "maximum": js_number_value(max), "type": "number", "inclusive": inclusive, "exact": false }),
                            msg.map_or_else(|| format!("Number must be {words} {}", js_number_text(max)), str::to_owned),
                        )
                    })
                }
                N::Finite(msg) => (!number.is_finite()).then(|| {
                    (
                        json!({ "code": "not_finite" }),
                        msg.unwrap_or("Number must be finite").to_owned(),
                    )
                }),
            };
            if let Some((issue, message)) = failed {
                self.push(issue, message);
                status = St::Dirty;
            }
        }
        (status, Some(js_number_value(number)))
    }

    fn enumeration(
        &mut self,
        options: &'static [&'static str],
        msg: Msg,
        value: Option<&Value>,
    ) -> (St, Option<Value>) {
        let expected = join_options(options);
        match value {
            Some(Value::String(text)) if options.contains(&text.as_str()) => {
                (St::Valid, Some(Value::String(text.clone())))
            }
            Some(Value::String(text)) => {
                let message = msg.map_or_else(
                    || format!("Invalid enum value. Expected {expected}, received '{text}'"),
                    str::to_owned,
                );
                self.push(
                    json!({ "received": text, "code": "invalid_enum_value", "options": options }),
                    message,
                );
                (St::Aborted, None)
            }
            other => {
                self.invalid_type(&expected, other);
                if let (Some(msg), Some((_, issue))) = (msg, self.issues.last_mut()) {
                    issue["message"] = json!(msg);
                }
                (St::Aborted, None)
            }
        }
    }

    fn array(
        &mut self,
        item: &Z,
        min: Option<(usize, Msg)>,
        max: Option<(usize, Msg)>,
        value: Option<&Value>,
    ) -> (St, Option<Value>) {
        let Some(Value::Array(items)) = value else {
            self.invalid_type("array", value);
            return (St::Aborted, None);
        };
        let mut status = St::Valid;
        if let Some((min, msg)) = min
            && items.len() < min
        {
            self.push(
                json!({ "code": "too_small", "minimum": min, "type": "array", "inclusive": true, "exact": false }),
                msg.map_or_else(|| format!("Array must contain at least {min} element(s)"), str::to_owned),
            );
            status = St::Dirty;
        }
        if let Some((max, msg)) = max
            && items.len() > max
        {
            self.push(
                json!({ "code": "too_big", "maximum": max, "type": "array", "inclusive": true, "exact": false }),
                msg.map_or_else(|| format!("Array must contain at most {max} element(s)"), str::to_owned),
            );
            status = St::Dirty;
        }
        let mut out = Vec::with_capacity(items.len());
        for (index, entry) in items.iter().enumerate() {
            let (st, parsed) = self.at(json!(index), |ctx| ctx.parse(item, Some(entry)));
            status = status.max(st);
            out.push(parsed.unwrap_or(Value::Null));
        }
        if status == St::Aborted {
            return (St::Aborted, None);
        }
        (status, Some(Value::Array(out)))
    }

    fn object(
        &mut self,
        shape: &[(&'static str, Z)],
        keys: Keys,
        value: Option<&Value>,
    ) -> (St, Option<Value>) {
        let Some(Value::Object(fields)) = value else {
            self.invalid_type("object", value);
            return (St::Aborted, None);
        };
        let mut status = St::Valid;
        let mut out = Map::new();
        for (key, field) in shape {
            let input = fields.get(*key);
            let (st, parsed) = self.at(json!(key), |ctx| ctx.parse(field, input));
            status = status.max(st);
            // An `undefined` output is left out, as `JSON.stringify` and
            // Drizzle's `values()` both skip it.
            if let Some(parsed) = parsed {
                out.insert((*key).to_owned(), parsed);
            }
        }
        let extra: Vec<&String> = fields
            .keys()
            .filter(|key| !shape.iter().any(|(known, _)| known == key))
            .collect();
        match keys {
            Keys::Passthrough => {
                for key in extra {
                    out.insert(key.clone(), fields[key].clone());
                }
            }
            Keys::Strict if !extra.is_empty() => {
                let names = extra
                    .iter()
                    .map(|k| format!("'{k}'"))
                    .collect::<Vec<_>>()
                    .join(", ");
                self.push(
                    json!({ "code": "unrecognized_keys", "keys": extra }),
                    format!("Unrecognized key(s) in object: {names}"),
                );
                status = status.max(St::Dirty);
            }
            Keys::Strip | Keys::Strict => {}
        }
        if status == St::Aborted {
            return (St::Aborted, None);
        }
        (status, Some(Value::Object(out)))
    }

    fn union(&mut self, options: &[Z], value: Option<&Value>) -> (St, Option<Value>) {
        let mut results = Vec::with_capacity(options.len());
        for option in options {
            let mut child = Self {
                path: self.path.clone(),
                ..Self::default()
            };
            let (status, parsed) = child.parse(option, value);
            if status == St::Valid {
                self.dates.extend(child.dates);
                return (St::Valid, parsed);
            }
            results.push((status, parsed, child));
        }
        let tier = self.tier.saturating_add(3);
        if let Some(index) = results.iter().position(|(st, _, _)| *st == St::Dirty) {
            let (status, parsed, mut child) = results.swap_remove(index);
            self.dates.append(&mut child.dates);
            self.issues
                .extend(child.sorted().into_iter().map(|issue| (tier, issue)));
            return (status, parsed);
        }
        let union_errors: Vec<Value> = results
            .into_iter()
            .map(|(_, _, child)| json!({ "issues": child.sorted(), "name": "ZodError" }))
            .collect();
        let mut issue = json!({ "code": "invalid_union", "unionErrors": union_errors });
        issue["path"] = Value::Array(self.path.clone());
        issue["message"] = json!("Invalid input");
        self.issues.push((tier, issue));
        (St::Aborted, None)
    }

    /// The issues in the order they settle.
    fn sorted(self) -> Vec<Value> {
        let mut issues = self.issues;
        issues.sort_by_key(|(tier, _)| *tier);
        issues.into_iter().map(|(_, issue)| issue).collect()
    }
}

/// How many microtasks after the synchronous checks a refinement on `inner`
/// settles: an object resolves its fields one `await` at a time, a union
/// after its options.
fn settle_delay(inner: &Z) -> u8 {
    match inner {
        Z::Obj(..) | Z::Disc(..) => 20,
        Z::Union(..) => 6,
        Z::Opt(inner) | Z::Nul(inner) | Z::Def(inner, _) => settle_delay(inner),
        _ => 1,
    }
}

fn format_issue(format: Format, text: &str, msg: Msg) -> Option<(Value, String)> {
    if format.is_match(text) {
        return None;
    }
    let (validation, message) = format.issue_parts();
    Some((
        json!({ "validation": validation, "code": "invalid_string" }),
        msg.unwrap_or(message).to_owned(),
    ))
}

/// A body as the schema parsed it.
#[derive(Debug, Clone, Default)]
pub(crate) struct Parsed {
    /// The output: only the schema's keys (or every key, passthrough), in its
    /// order, defaults filled in.
    pub(crate) body: Map<String, Value>,
    /// The top-level keys that hold a `Date` (`z.coerce.date()`), which
    /// Drizzle writes to a timestamp column as is.
    pub(crate) dates: Vec<String>,
}

impl Parsed {
    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        self.body.get(key)
    }

    /// The text at `key`, if it is a non-empty string (`if (body.x)`).
    pub(crate) fn text(&self, key: &str) -> Option<&str> {
        self.body
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    }
}

/// `schema.safeParseAsync(value)`: the parsed output, or the 400 response
/// `zValidator` answers with.
pub(crate) fn parse(schema: &Z, value: &Value) -> Result<Parsed, Response> {
    let mut ctx = Ctx::default();
    let (status, out) = ctx.parse(schema, Some(value));
    let dates: Vec<String> = ctx
        .dates
        .iter()
        .filter_map(|path| match path.as_slice() {
            [Value::String(key)] => Some(key.clone()),
            _ => None,
        })
        .collect();
    if status != St::Valid || !ctx.issues.is_empty() {
        let mut issues = Issues::default();
        for issue in ctx.sorted() {
            issues.push_raw(issue);
        }
        return match issues.finish() {
            Err(invalid) => Err(invalid.into_response()),
            Ok(()) => Ok(Parsed::default()),
        };
    }
    let body = match out {
        Some(Value::Object(body)) => body,
        _ => Map::new(),
    };
    Ok(Parsed { body, dates })
}

/// `zValidator('json', schema)`: the request's JSON body (Hono reads a
/// non-JSON content type as `{}`, a malformed one is a 400) parsed.
pub(crate) fn json(schema: &Z, headers: &http::HeaderMap, body: &[u8]) -> Result<Parsed, Response> {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let value = weldsuite_kit::validation::json_body(content_type, body)
        .map_err(IntoResponse::into_response)?;
    parse(schema, &value)
}

/// `zValidator('query', schema)`: the query string (a repeated key is an
/// array) parsed.
pub(crate) fn query(schema: &Z, raw: Option<&str>) -> Result<Parsed, Response> {
    let values = weldsuite_kit::validation::query_values(raw);
    parse(schema, &Value::Object(values))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PERSON: Z = Z::Obj(
        &[
            ("name", Z::Str(&[S::Min(1, None), S::Max(5, None)])),
            (
                "age",
                Z::Opt(&Z::Num(&[N::Int(None), N::Min(0.0, true, None)])),
            ),
            ("kind", Z::Def(&Z::Enum(&["a", "b"], None), "\"a\"")),
            ("when", Z::Opt(&Z::CoerceDate)),
        ],
        Keys::Strip,
    );

    fn issues(response: Response) -> Value {
        assert_eq!(response.status(), http::StatusCode::BAD_REQUEST);
        let body = futures_body(response);
        body["error"]["issues"].clone()
    }

    fn futures_body(response: Response) -> Value {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body");
            serde_json::from_slice(&bytes).expect("json")
        })
    }

    #[test]
    fn valid_bodies_strip_and_default() {
        let parsed = parse(
            &PERSON,
            &json!({ "name": "Ann", "extra": 1, "when": "2026-01-02" }),
        )
        .expect("valid");
        assert_eq!(
            Value::Object(parsed.body),
            json!({ "name": "Ann", "kind": "a", "when": "2026-01-02T00:00:00.000Z" })
        );
        assert_eq!(parsed.dates, vec!["when".to_owned()]);
    }

    #[test]
    fn issues_read_like_zod() {
        let response =
            parse(&PERSON, &json!({ "name": "", "age": 1.5, "kind": "c" })).expect_err("invalid");
        let issues = issues(response);
        assert_eq!(issues[0]["code"], "too_small");
        assert_eq!(issues[0]["path"], json!(["name"]));
        assert_eq!(issues[1]["message"], "Expected integer, received float");
        assert_eq!(
            issues[2]["message"],
            "Invalid enum value. Expected 'a' | 'b', received 'c'"
        );
        let response = parse(&PERSON, &json!("text")).expect_err("not an object");
        assert_eq!(
            issues(response)[0]["message"],
            "Expected object, received string"
        );
    }

    #[test]
    fn unions_nest_their_options() {
        const EITHER: Z = Z::Obj(&[("v", Z::Union(&[Z::Str(&[]), Z::Num(&[])]))], Keys::Strip);
        let issues = issues(parse(&EITHER, &json!({ "v": true })).expect_err("invalid"));
        assert_eq!(issues[0]["code"], "invalid_union");
        assert_eq!(
            issues[0]["unionErrors"][1]["issues"][0]["expected"],
            "number"
        );
    }
}
