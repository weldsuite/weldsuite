//! A table of a Zod object schema's fields, read with
//! [`weldsuite_kit::validation::Issues`] in the schema's key order.
//!
//! The CRM schemas are long, flat `z.object({...})`s of strings, numbers,
//! booleans, enums and arrays of strings; describing each as one [`Spec`]
//! keeps the port next to the TypeScript schema line by line. The result is
//! the parsed body as Zod hands it to the route: only the keys the body set
//! (or a `.default()` filled), in the schema's order, unknown keys stripped.

use serde_json::{Map, Value};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};

/// A field's type and checks.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Kind {
    /// `z.string()` with `.min()`/`.max()` (and `.trim()`).
    Str(Text),
    /// `z.string().email()`.
    Email,
    /// `z.string().datetime()` (UTC `Z` only).
    Datetime,
    /// `z.number()` with its checks (`.int()`, `.min()`, `.max()`).
    Num(Number),
    /// `z.boolean()`.
    Bool,
    /// `z.enum([...])`.
    Enum(&'static [&'static str]),
    /// `z.unknown()` / `z.any()`: anything, `null` included.
    Unknown,
    /// `z.array(z.string()...)`, with the item's and the array's length checks.
    StrArray {
        item: Text,
        min: Option<usize>,
        max: Option<usize>,
    },
    /// `z.record(z.unknown())` / `z.record(z.string(), z.unknown())`.
    Record,
    /// `z.union([z.string(), z.number()])`.
    StrOrNum,
}

/// One field of the schema.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Spec {
    pub(crate) key: &'static str,
    pub(crate) kind: Kind,
    pub(crate) presence: Presence,
    /// `.default(value)`, as JSON text: filled in when the field is absent.
    pub(crate) default: Option<&'static str>,
}

impl Spec {
    pub(crate) const fn new(key: &'static str, kind: Kind, presence: Presence) -> Self {
        Self {
            key,
            kind,
            presence,
            default: None,
        }
    }

    pub(crate) const fn with_default(mut self, json: &'static str) -> Self {
        self.default = Some(json);
        self
    }
}

/// `z.string()` with optional `.min()`/`.max()`.
pub(crate) const fn s(min: Option<usize>, max: Option<usize>) -> Kind {
    Kind::Str(Text::length(min, max))
}

/// `z.number().int()` with optional `.min()`/`.max()`.
pub(crate) const fn int(min: Option<f64>, max: Option<f64>) -> Kind {
    Kind::Num(Number {
        coerce: false,
        int: true,
        min,
        max,
    })
}

/// `z.array(z.string())`.
pub(crate) const STRINGS: Kind = Kind::StrArray {
    item: Text::length(None, None),
    min: None,
    max: None,
};

/// Shorthands for the presences.
pub(crate) const REQ: Presence = Presence::Required;
pub(crate) const OPT: Presence = Presence::Optional;
pub(crate) const NULLISH: Presence = Presence::Nullish;

/// `.partial()`: every field optional, a `.nullable()` one nullish, and no
/// defaults (`ZodOptional` answers `undefined` before the default runs).
pub(crate) fn partial(specs: &[Spec]) -> Vec<Spec> {
    specs
        .iter()
        .map(|spec| Spec {
            presence: match spec.presence {
                Presence::Required | Presence::Optional => Presence::Optional,
                Presence::Nullable | Presence::Nullish => Presence::Nullish,
            },
            default: None,
            ..*spec
        })
        .collect()
}

/// `.extend({...})`: a key the base has keeps its place with the new spec;
/// new keys go at the end.
pub(crate) fn extend(base: &[Spec], extra: &[Spec]) -> Vec<Spec> {
    let mut out: Vec<Spec> = base.to_vec();
    for spec in extra {
        if let Some(existing) = out.iter_mut().find(|s| s.key == spec.key) {
            *existing = *spec;
        } else {
            out.push(*spec);
        }
    }
    out
}

/// `.pick({...})`, in the base schema's order.
pub(crate) fn pick(base: &[Spec], keys: &[&str]) -> Vec<Spec> {
    base.iter()
        .filter(|spec| keys.contains(&spec.key))
        .copied()
        .collect()
}

fn put<T>(out: &mut Map<String, Value>, key: &str, field: Field<T>, to: impl FnOnce(T) -> Value) {
    match field {
        Field::Absent => {}
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Set(value) => {
            out.insert(key.to_owned(), to(value));
        }
    }
}

/// A number as JavaScript holds it: whole numbers as integers.
pub(crate) fn number_value(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        Value::from(number as i64)
    } else {
        serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
    }
}

/// Read every field of `specs` off `body`.
///
/// `zValidator` parses asynchronously, so issues settle in tiers: the plain
/// checks of every field in key order, then refinements on a plain field,
/// then unions (`invalid_union`), then refinements on a union. [`read`]
/// reads the plain fields and then the unions; a schema with refinements
/// calls [`read_sync`], its plain refinements, [`read_unions`], then the
/// union ones.
pub(crate) fn read(
    issues: &mut Issues,
    body: &Map<String, Value>,
    specs: &[Spec],
) -> Map<String, Value> {
    let mut out = read_sync(issues, body, specs);
    for (key, value) in read_unions(issues, body, specs) {
        out.insert(key, value);
    }
    out
}

/// The fields of `specs` other than unions.
pub(crate) fn read_sync(
    issues: &mut Issues,
    body: &Map<String, Value>,
    specs: &[Spec],
) -> Map<String, Value> {
    read_tier(issues, body, specs, false)
}

/// The union fields of `specs` (`z.union([...])`).
pub(crate) fn read_unions(
    issues: &mut Issues,
    body: &Map<String, Value>,
    specs: &[Spec],
) -> Map<String, Value> {
    read_tier(issues, body, specs, true)
}

fn read_tier(
    issues: &mut Issues,
    body: &Map<String, Value>,
    specs: &[Spec],
    unions: bool,
) -> Map<String, Value> {
    let mut out = Map::new();
    for spec in specs {
        if matches!(spec.kind, Kind::StrOrNum) != unions {
            continue;
        }
        let before = out.len();
        read_one(issues, body, spec, &mut out);
        if out.len() == before
            && !body.contains_key(spec.key)
            && let Some(default) = spec.default
        {
            out.insert(
                spec.key.to_owned(),
                serde_json::from_str(default).unwrap_or(Value::Null),
            );
        }
    }
    out
}

fn read_one(
    issues: &mut Issues,
    body: &Map<String, Value>,
    spec: &Spec,
    out: &mut Map<String, Value>,
) {
    let key = spec.key;
    let presence = spec.presence;
    match spec.kind {
        Kind::Str(rules) => {
            let field = issues.text_with(body, key, presence, rules);
            put(out, key, field, Value::String);
        }
        Kind::Email => {
            let rules = Text {
                format: Some(Format::Email),
                ..Text::default()
            };
            let field = issues.text_with(body, key, presence, rules);
            put(out, key, field, Value::String);
        }
        Kind::Datetime => {
            let rules = Text {
                format: Some(Format::Datetime),
                ..Text::default()
            };
            let field = issues.text_with(body, key, presence, rules);
            put(out, key, field, Value::String);
        }
        Kind::Num(rules) => {
            let field = issues.number(body, key, presence, rules);
            put(out, key, field, number_value);
        }
        Kind::Bool => {
            let field = issues.boolean(body, key, presence);
            put(out, key, field, Value::Bool);
        }
        Kind::Enum(options) => {
            let field = issues.choice(body, key, presence, options);
            put(out, key, field, Value::String);
        }
        Kind::Unknown => {
            // `z.unknown()` accepts anything, `undefined` included.
            if let Some(value) = body.get(key) {
                out.insert(key.to_owned(), value.clone());
            }
        }
        Kind::StrArray { item, min, max } => {
            let field = issues.list(body, key, presence, min, max, |issues, value| {
                issues.item_text(value, item)
            });
            put(out, key, field, |items| {
                Value::Array(items.into_iter().map(Value::String).collect())
            });
        }
        Kind::StrOrNum => {
            let field = issues.string_or_number(body, key, presence);
            put(out, key, field, |value| value);
        }
        Kind::Record => {
            let field = issues.nested(body, key, presence, |_, fields| fields.clone());
            put(out, key, field, Value::Object);
        }
    }
}

/// A `.refine(check, { message })` on `key`, run when the field got past its
/// type check (a failed length check doesn't stop it; a wrong type does).
/// Call after every field was read: its issue comes last.
pub(crate) fn refine(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    typed: impl Fn(Option<&Value>) -> bool,
    check: impl Fn(Option<&Value>) -> bool,
    message: &str,
) {
    let value = body.get(key);
    if typed(value) && !check(value) {
        issues.custom(key, message);
    }
}
