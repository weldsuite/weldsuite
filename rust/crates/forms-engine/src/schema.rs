//! `formDefinitionSchema.safeParse` and `formThemeTokensSchema.safeParse`:
//! the Zod 3 checks of `definition.ts`, with Zod's messages and paths.
//!
//! The schema is written out as a [`Z`] tree that mirrors `definition.ts`
//! line by line; [`run`] reads a JSON value with it the way Zod's
//! synchronous parse does. Issues come in Zod's order (an object's keys in
//! the schema's order, an array's checks before its items), and a union
//! behaves as Zod's: the first option that passes wins, else the first one
//! that failed only on checks ("dirty") gives its issues, else one
//! `Invalid input` issue. A change to `definition.ts` is mirrored here.

use serde::Serialize;
use serde_json::Value;
use weldsuite_kit::validation::js_url_parses;

use super::definition::CONDITION_OPERATORS;
use super::js::{is_integer, number_text, utf16_len};

/// A schema issue: where (`issue.path`) and Zod's message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SchemaIssue {
    /// Keys and indexes, as Zod's `issue.path`.
    pub path: Vec<PathSegment>,
    pub message: String,
}

/// One step of an issue's path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum PathSegment {
    Key(String),
    Index(usize),
}

impl SchemaIssue {
    /// `issue.path.join('.')`.
    pub fn path_text(&self) -> String {
        self.path
            .iter()
            .map(|segment| match segment {
                PathSegment::Key(key) => key.clone(),
                PathSegment::Index(index) => index.to_string(),
            })
            .collect::<Vec<_>>()
            .join(".")
    }

    /// A value the checks passed that serde still refused: a bug in this
    /// file's mirror of `definition.ts`, reported rather than hidden.
    pub(crate) fn unexpected(err: &serde_json::Error) -> Self {
        Self {
            path: Vec::new(),
            message: format!("Invalid input: {err}"),
        }
    }
}

/// The issues as one line, for serde's error.
pub(crate) fn describe(issues: &[SchemaIssue]) -> String {
    issues
        .iter()
        .map(|issue| format!("{}: {}", issue.path_text(), issue.message))
        .collect::<Vec<_>>()
        .join("; ")
}

/// The checks of `formDefinitionSchema`; empty when the value passes.
pub fn check_definition(value: &Value) -> Vec<SchemaIssue> {
    check(&DEFINITION, value)
}

/// The checks of `formThemeTokensSchema`; empty when the value passes.
pub fn check_theme(value: &Value) -> Vec<SchemaIssue> {
    check(&THEME, value)
}

fn check(schema: &Z, value: &Value) -> Vec<SchemaIssue> {
    let mut cx = Cx::default();
    run(&mut cx, schema, Some(value));
    cx.issues
}

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

/// `z.string()` checks.
#[derive(Clone, Copy)]
enum S {
    Min(usize),
    Max(usize),
    /// `.length(n)`.
    Len(usize),
    /// `.url()`: `new URL(value)` parses.
    Url,
    /// `.regex()`, with its own message or Zod's `Invalid`.
    Regex(fn(&str) -> bool, Option<&'static str>),
}

/// `z.number()` checks.
#[derive(Clone, Copy)]
enum N {
    Int,
    Min(f64),
    Max(f64),
    /// `.finite()`: a JSON number always is.
    Finite,
}

/// A Zod schema.
#[derive(Clone, Copy)]
enum Z {
    Str(&'static [S]),
    Num(&'static [N]),
    Bool,
    LitStr(&'static str),
    LitNum(f64),
    Enum(&'static [&'static str]),
    Arr(&'static Z, Option<usize>, Option<usize>),
    Obj(&'static [(&'static str, Z)]),
    Union(&'static [Z]),
    /// `z.discriminatedUnion(key, options)`; each option an object with
    /// `key` as a string literal.
    Disc(&'static str, &'static [Z]),
    Opt(&'static Z),
    Nul(&'static Z),
    /// `.default(…)`: absent is fine (the default always passes).
    Def(&'static Z),
}

/// A parse status: Zod's `valid`, `dirty` (checks failed) and `aborted`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum St {
    Valid,
    Dirty,
    Aborted,
}

#[derive(Default)]
struct Cx {
    path: Vec<PathSegment>,
    issues: Vec<SchemaIssue>,
}

impl Cx {
    fn issue(&mut self, message: String) {
        self.issues.push(SchemaIssue {
            path: self.path.clone(),
            message,
        });
    }

    fn within(&mut self, segment: PathSegment, f: impl FnOnce(&mut Self) -> St) -> St {
        self.path.push(segment);
        let status = f(self);
        self.path.pop();
        status
    }
}

/// Zod's `getParsedType` name of a JSON value.
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

/// `util.joinValues`: `'a' | 'b'`.
fn join_values(values: &[&str]) -> String {
    values
        .iter()
        .map(|value| format!("'{value}'"))
        .collect::<Vec<_>>()
        .join(" | ")
}

fn invalid_type(cx: &mut Cx, expected: &str, value: Option<&Value>) -> St {
    let received = parsed_type(value);
    cx.issue(if value.is_none() {
        "Required".to_owned()
    } else {
        format!("Expected {expected}, received {received}")
    });
    St::Aborted
}

fn run(cx: &mut Cx, schema: &Z, value: Option<&Value>) -> St {
    match *schema {
        Z::Str(checks) => match value {
            Some(Value::String(text)) => string(cx, checks, text),
            _ => invalid_type(cx, "string", value),
        },
        Z::Num(checks) => match value.and_then(Value::as_f64) {
            Some(number) => self::number(cx, checks, number),
            None => invalid_type(cx, "number", value),
        },
        Z::Bool => match value {
            Some(Value::Bool(_)) => St::Valid,
            _ => invalid_type(cx, "boolean", value),
        },
        Z::LitStr(literal) => {
            if value.and_then(Value::as_str) == Some(literal) {
                St::Valid
            } else {
                cx.issue(format!(
                    "Invalid literal value, expected {}",
                    Value::from(literal)
                ));
                St::Aborted
            }
        }
        Z::LitNum(literal) => {
            #[allow(clippy::float_cmp)] // `===`
            let same = value.and_then(Value::as_f64) == Some(literal);
            if same {
                St::Valid
            } else {
                cx.issue(format!(
                    "Invalid literal value, expected {}",
                    number_text(literal)
                ));
                St::Aborted
            }
        }
        Z::Enum(options) => match value {
            Some(Value::String(text)) if options.contains(&text.as_str()) => St::Valid,
            Some(Value::String(text)) => {
                cx.issue(format!(
                    "Invalid enum value. Expected {}, received '{text}'",
                    join_values(options)
                ));
                St::Aborted
            }
            _ => invalid_type(cx, &join_values(options), value),
        },
        Z::Arr(item, min, max) => array(cx, item, min, max, value),
        Z::Obj(fields) => object(cx, fields, value),
        Z::Union(options) => union(cx, options, value),
        Z::Disc(key, options) => discriminated(cx, key, options, value),
        Z::Opt(inner) | Z::Def(inner) => match value {
            None => St::Valid,
            Some(_) => run(cx, inner, value),
        },
        Z::Nul(inner) => match value {
            Some(Value::Null) => St::Valid,
            _ => run(cx, inner, value),
        },
    }
}

fn string(cx: &mut Cx, checks: &[S], text: &str) -> St {
    let length = utf16_len(text);
    let mut status = St::Valid;
    for check in checks {
        let message = match *check {
            S::Min(min) if length < min => {
                format!("String must contain at least {min} character(s)")
            }
            S::Max(max) if length > max => {
                format!("String must contain at most {max} character(s)")
            }
            S::Len(exact) if length != exact => {
                format!("String must contain exactly {exact} character(s)")
            }
            S::Url if !js_url_parses(text) => "Invalid url".to_owned(),
            S::Regex(matches, message) if !matches(text) => message.unwrap_or("Invalid").to_owned(),
            _ => continue,
        };
        cx.issue(message);
        status = St::Dirty;
    }
    status
}

fn number(cx: &mut Cx, checks: &[N], number: f64) -> St {
    let mut status = St::Valid;
    for check in checks {
        let message = match *check {
            N::Int if !is_integer(number) => "Expected integer, received float".to_owned(),
            N::Min(min) if number < min => format!(
                "Number must be greater than or equal to {}",
                number_text(min)
            ),
            N::Max(max) if number > max => {
                format!("Number must be less than or equal to {}", number_text(max))
            }
            N::Finite if !number.is_finite() => "Number must be finite".to_owned(),
            _ => continue,
        };
        cx.issue(message);
        status = St::Dirty;
    }
    status
}

fn array(
    cx: &mut Cx,
    item: &Z,
    min: Option<usize>,
    max: Option<usize>,
    value: Option<&Value>,
) -> St {
    let Some(Value::Array(items)) = value else {
        return invalid_type(cx, "array", value);
    };
    let mut status = St::Valid;
    if let Some(min) = min.filter(|min| items.len() < *min) {
        cx.issue(format!("Array must contain at least {min} element(s)"));
        status = St::Dirty;
    }
    if let Some(max) = max.filter(|max| items.len() > *max) {
        cx.issue(format!("Array must contain at most {max} element(s)"));
        status = St::Dirty;
    }
    for (index, element) in items.iter().enumerate() {
        let element_status =
            cx.within(PathSegment::Index(index), |cx| run(cx, item, Some(element)));
        status = status.max(element_status);
    }
    status
}

fn object(cx: &mut Cx, fields: &[(&'static str, Z)], value: Option<&Value>) -> St {
    let Some(Value::Object(map)) = value else {
        return invalid_type(cx, "object", value);
    };
    let mut status = St::Valid;
    for (key, schema) in fields {
        let field_status = cx.within(PathSegment::Key((*key).to_owned()), |cx| {
            run(cx, schema, map.get(*key))
        });
        status = status.max(field_status);
    }
    status
}

fn union(cx: &mut Cx, options: &[Z], value: Option<&Value>) -> St {
    let mut dirty: Option<Vec<SchemaIssue>> = None;
    for option in options {
        let outer = std::mem::take(&mut cx.issues);
        let status = run(cx, option, value);
        let issues = std::mem::replace(&mut cx.issues, outer);
        match status {
            St::Valid => return St::Valid,
            St::Dirty if dirty.is_none() => dirty = Some(issues),
            _ => {}
        }
    }
    if let Some(issues) = dirty {
        cx.issues.extend(issues);
        return St::Dirty;
    }
    cx.issue("Invalid input".to_owned());
    St::Aborted
}

/// The literal an option of a discriminated union has under `key`.
fn discriminator_of(option: &Z, key: &str) -> Option<&'static str> {
    let Z::Obj(fields) = option else {
        return None;
    };
    fields.iter().find_map(|(name, schema)| match schema {
        Z::LitStr(literal) if *name == key => Some(*literal),
        _ => None,
    })
}

fn discriminated(cx: &mut Cx, key: &'static str, options: &[Z], value: Option<&Value>) -> St {
    let Some(Value::Object(map)) = value else {
        return invalid_type(cx, "object", value);
    };
    let wanted = map.get(key).and_then(Value::as_str);
    let found = options
        .iter()
        .find(|option| wanted.is_some() && discriminator_of(option, key) == wanted);
    if let Some(option) = found {
        return run(cx, option, value);
    }
    let names: Vec<&str> = options
        .iter()
        .filter_map(|option| discriminator_of(option, key))
        .collect();
    cx.within(PathSegment::Key(key.to_owned()), |cx| {
        cx.issue(format!(
            "Invalid discriminator value. Expected {}",
            join_values(&names)
        ));
        St::Aborted
    })
}

// ---------------------------------------------------------------------------
// Regex checks of definition.ts
// ---------------------------------------------------------------------------

/// `/^[a-z][a-z0-9_]*$/`.
fn is_ref(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// `/^[a-zA-Z_][a-zA-Z0-9_]*$/`.
fn is_hidden_name(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `/^\d{4}-\d{2}-\d{2}$/`.
pub(crate) fn is_date_text(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        })
}

/// `/^#[0-9a-fA-F]{6}$/`.
fn is_color(text: &str) -> bool {
    text.len() == 7 && text.starts_with('#') && text[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

// ---------------------------------------------------------------------------
// definition.ts as a Z tree
// ---------------------------------------------------------------------------

const REF_MESSAGE: &str = "lowercase letters, digits and underscores, starting with a letter";

const ID: Z = Z::Str(&[S::Min(1), S::Max(30)]);
const REF: Z = Z::Str(&[S::Min(1), S::Max(64), S::Regex(is_ref, Some(REF_MESSAGE))]);
const TEXT: Z = Z::Str(&[S::Max(5000)]);
const TITLE: Z = Z::Str(&[S::Max(1000)]);
const URL: Z = Z::Str(&[S::Url, S::Max(2000)]);
const PLACEHOLDER: Z = Z::Opt(&Z::Str(&[S::Max(200)]));
const FLAG: Z = Z::Def(&Z::Bool);

const MEDIA: Z = Z::Obj(&[
    ("kind", Z::Enum(&["image", "video"])),
    ("url", URL),
    ("alt", Z::Opt(&Z::Str(&[S::Max(500)]))),
    (
        "placement",
        Z::Def(&Z::Enum(&[
            "above",
            "split_left",
            "split_right",
            "background",
        ])),
    ),
]);

const CHOICE: Z = Z::Obj(&[
    ("id", ID),
    ("label", Z::Str(&[S::Max(500)])),
    ("imageUrl", Z::Opt(&URL)),
    ("score", Z::Opt(&Z::Num(&[N::Finite]))),
    ("correct", Z::Opt(&Z::Bool)),
]);

const SUB_FIELD: Z = Z::Def(&Z::Obj(&[("enabled", Z::Bool), ("required", Z::Bool)]));

const SELECTIONS: Z = Z::Opt(&Z::Num(&[N::Int, N::Min(1.0)]));

/// A field block: the base keys, the `type` literal and the properties.
macro_rules! field {
    ($type:literal, $properties:expr) => {
        Z::Obj(&[
            ("id", ID),
            ("ref", REF),
            ("title", TITLE),
            ("description", Z::Opt(&TEXT)),
            ("media", Z::Opt(&MEDIA)),
            ("required", FLAG),
            ("sensitive", Z::Opt(&Z::Bool)),
            ("type", Z::LitStr($type)),
            ("properties", $properties),
        ])
    };
}

const FIELD_BLOCK: Z = Z::Disc(
    "type",
    &[
        field!(
            "short_text",
            Z::Def(&Z::Obj(&[
                ("placeholder", PLACEHOLDER),
                (
                    "maxLength",
                    Z::Opt(&Z::Num(&[N::Int, N::Min(1.0), N::Max(1000.0)]))
                ),
            ]))
        ),
        field!(
            "long_text",
            Z::Def(&Z::Obj(&[
                ("placeholder", PLACEHOLDER),
                (
                    "maxLength",
                    Z::Opt(&Z::Num(&[N::Int, N::Min(1.0), N::Max(10000.0)]))
                ),
            ]))
        ),
        field!("email", Z::Def(&Z::Obj(&[("placeholder", PLACEHOLDER)]))),
        field!(
            "phone",
            Z::Def(&Z::Obj(&[(
                "defaultCountry",
                Z::Opt(&Z::Str(&[S::Len(2)]))
            )]))
        ),
        field!(
            "number",
            Z::Def(&Z::Obj(&[
                ("min", Z::Opt(&Z::Num(&[N::Finite]))),
                ("max", Z::Opt(&Z::Num(&[N::Finite]))),
                (
                    "decimals",
                    Z::Def(&Z::Num(&[N::Int, N::Min(0.0), N::Max(6.0)]))
                ),
            ]))
        ),
        field!("website", Z::Def(&Z::Obj(&[("placeholder", PLACEHOLDER)]))),
        field!(
            "date",
            Z::Def(&Z::Obj(&[
                ("format", Z::Def(&Z::Enum(&["DMY", "MDY", "YMD"]))),
                ("min", Z::Opt(&Z::Str(&[S::Regex(is_date_text, None)]))),
                ("max", Z::Opt(&Z::Str(&[S::Regex(is_date_text, None)]))),
            ]))
        ),
        field!(
            "multiple_choice",
            Z::Obj(&[
                ("choices", Z::Arr(&CHOICE, Some(1), Some(200))),
                ("multiple", FLAG),
                ("minSelections", SELECTIONS),
                ("maxSelections", SELECTIONS),
                ("allowOther", FLAG),
                ("randomize", FLAG),
            ])
        ),
        field!(
            "dropdown",
            Z::Obj(&[
                ("choices", Z::Arr(&CHOICE, Some(1), Some(5000))),
                ("randomize", FLAG),
                ("alphabetical", FLAG),
            ])
        ),
        field!(
            "picture_choice",
            Z::Obj(&[
                ("choices", Z::Arr(&CHOICE, Some(1), Some(50))),
                ("multiple", FLAG),
                ("minSelections", SELECTIONS),
                ("maxSelections", SELECTIONS),
                ("allowOther", FLAG),
                ("randomize", FLAG),
                ("showLabels", FLAG),
            ])
        ),
        field!("yes_no", Z::Def(&Z::Obj(&[]))),
        field!("legal", Z::Def(&Z::Obj(&[]))),
        field!(
            "rating",
            Z::Def(&Z::Obj(&[
                (
                    "steps",
                    Z::Def(&Z::Num(&[N::Int, N::Min(3.0), N::Max(10.0)]))
                ),
                (
                    "shape",
                    Z::Def(&Z::Enum(&["star", "heart", "thumb", "circle"]))
                ),
            ]))
        ),
        field!(
            "opinion_scale",
            Z::Def(&Z::Obj(&[
                (
                    "start",
                    Z::Def(&Z::Union(&[Z::LitNum(0.0), Z::LitNum(1.0)]))
                ),
                ("end", Z::Def(&Z::Num(&[N::Int, N::Min(5.0), N::Max(10.0)]))),
                (
                    "labels",
                    Z::Def(&Z::Obj(&[
                        ("left", Z::Opt(&Z::Str(&[S::Max(100)]))),
                        ("center", Z::Opt(&Z::Str(&[S::Max(100)]))),
                        ("right", Z::Opt(&Z::Str(&[S::Max(100)]))),
                    ])),
                ),
            ]))
        ),
        field!(
            "nps",
            Z::Def(&Z::Obj(&[(
                "labels",
                Z::Def(&Z::Obj(&[
                    ("left", Z::Opt(&Z::Str(&[S::Max(100)]))),
                    ("right", Z::Opt(&Z::Str(&[S::Max(100)]))),
                ])),
            )]))
        ),
        field!(
            "ranking",
            Z::Obj(&[
                ("choices", Z::Arr(&CHOICE, Some(2), Some(50))),
                ("randomize", FLAG),
            ])
        ),
        field!(
            "matrix",
            Z::Obj(&[
                (
                    "rows",
                    Z::Arr(
                        &Z::Obj(&[("id", ID), ("label", Z::Str(&[S::Max(500)]))]),
                        Some(1),
                        Some(50),
                    ),
                ),
                (
                    "columns",
                    Z::Arr(
                        &Z::Obj(&[("id", ID), ("label", Z::Str(&[S::Max(200)]))]),
                        Some(2),
                        Some(20),
                    ),
                ),
                ("multiple", FLAG),
            ])
        ),
        field!(
            "file_upload",
            Z::Def(&Z::Obj(&[
                (
                    "maxFiles",
                    Z::Def(&Z::Num(&[N::Int, N::Min(1.0), N::Max(10.0)]))
                ),
                (
                    "maxSizeMb",
                    Z::Def(&Z::Num(&[N::Int, N::Min(1.0), N::Max(25.0)]))
                ),
                (
                    "accept",
                    Z::Def(&Z::Enum(&["any", "images", "documents", "pdf"]))
                ),
            ]))
        ),
        field!("signature", Z::Def(&Z::Obj(&[]))),
        field!(
            "contact_info",
            Z::Def(&Z::Obj(&[(
                "fields",
                Z::Def(&Z::Obj(&[
                    ("firstName", SUB_FIELD),
                    ("lastName", SUB_FIELD),
                    ("email", SUB_FIELD),
                    ("phone", SUB_FIELD),
                    ("company", SUB_FIELD),
                ])),
            )]))
        ),
        field!(
            "address",
            Z::Def(&Z::Obj(&[(
                "fields",
                Z::Def(&Z::Obj(&[
                    ("line1", SUB_FIELD),
                    ("line2", SUB_FIELD),
                    ("city", SUB_FIELD),
                    ("state", SUB_FIELD),
                    ("postalCode", SUB_FIELD),
                    ("country", SUB_FIELD),
                ])),
            )]))
        ),
    ],
);

const BUTTON_PROPERTIES: Z = Z::Def(&Z::Obj(&[("buttonText", Z::Opt(&Z::Str(&[S::Max(60)])))]));

const STATEMENT: Z = Z::Obj(&[
    ("id", ID),
    ("ref", REF),
    ("type", Z::LitStr("statement")),
    ("title", TITLE),
    ("description", Z::Opt(&TEXT)),
    ("media", Z::Opt(&MEDIA)),
    ("properties", BUTTON_PROPERTIES),
]);

const GROUP: Z = Z::Obj(&[
    ("id", ID),
    ("ref", REF),
    ("type", Z::LitStr("group")),
    ("title", TITLE),
    ("description", Z::Opt(&TEXT)),
    ("media", Z::Opt(&MEDIA)),
    ("properties", BUTTON_PROPERTIES),
    (
        "children",
        Z::Arr(&Z::Union(&[FIELD_BLOCK, STATEMENT]), None, Some(50)),
    ),
]);

const PAGE_BREAK: Z = Z::Obj(&[
    ("id", ID),
    ("ref", REF),
    ("type", Z::LitStr("page_break")),
    ("title", Z::Def(&TITLE)),
]);

const BLOCK: Z = Z::Union(&[FIELD_BLOCK, STATEMENT, GROUP, PAGE_BREAK]);

const WELCOME: Z = Z::Obj(&[
    ("title", TITLE),
    ("description", Z::Opt(&TEXT)),
    ("media", Z::Opt(&MEDIA)),
    ("buttonText", Z::Opt(&Z::Str(&[S::Max(60)]))),
]);

const ENDING: Z = Z::Obj(&[
    ("id", ID),
    ("ref", REF),
    ("title", TITLE),
    ("description", Z::Opt(&TEXT)),
    ("media", Z::Opt(&MEDIA)),
    ("showScore", FLAG),
    ("showAnswers", FLAG),
    ("redirectUrl", Z::Opt(&Z::Str(&[S::Max(2000)]))),
    (
        "button",
        Z::Opt(&Z::Obj(&[
            ("text", Z::Str(&[S::Max(60)])),
            ("url", Z::Str(&[S::Max(2000)])),
        ])),
    ),
]);

const HIDDEN: Z = Z::Obj(&[(
    "name",
    Z::Str(&[S::Min(1), S::Max(64), S::Regex(is_hidden_name, None)]),
)]);

const VARIABLE: Z = Z::Disc(
    "type",
    &[
        Z::Obj(&[
            ("name", REF),
            ("type", Z::LitStr("number")),
            ("initial", Z::Def(&Z::Num(&[N::Finite]))),
        ]),
        Z::Obj(&[
            ("name", REF),
            ("type", Z::LitStr("text")),
            ("initial", Z::Def(&Z::Str(&[S::Max(1000)]))),
        ]),
    ],
);

const OPERAND: Z = Z::Disc(
    "type",
    &[
        Z::Obj(&[
            ("type", Z::LitStr("field")),
            ("id", ID),
            ("rowId", Z::Opt(&ID)),
            ("part", Z::Opt(&Z::Str(&[S::Max(30)]))),
        ]),
        Z::Obj(&[
            ("type", Z::LitStr("hidden")),
            ("name", Z::Str(&[S::Max(64)])),
        ]),
        Z::Obj(&[("type", Z::LitStr("variable")), ("name", REF)]),
        Z::Obj(&[
            ("type", Z::LitStr("constant")),
            (
                "value",
                Z::Union(&[
                    Z::Str(&[S::Max(1000)]),
                    Z::Num(&[N::Finite]),
                    Z::Bool,
                    Z::Arr(&Z::Str(&[S::Max(100)]), None, Some(200)),
                ]),
            ),
        ]),
    ],
);

const OPERATOR: Z = Z::Enum(CONDITION_OPERATORS);
const GROUP_OP: Z = Z::Enum(&["and", "or"]);

const CONDITION: Z = Z::Obj(&[
    ("left", OPERAND),
    ("operator", OPERATOR),
    ("right", Z::Opt(&OPERAND)),
]);

const NESTED_GROUP: Z = Z::Obj(&[
    ("op", GROUP_OP),
    ("conditions", Z::Arr(&CONDITION, Some(1), Some(20))),
]);

const CONDITION_GROUP: Z = Z::Obj(&[
    ("op", GROUP_OP),
    (
        "conditions",
        Z::Arr(&Z::Union(&[CONDITION, NESTED_GROUP]), Some(1), Some(20)),
    ),
]);

/// Which option of a condition group's `z.union([condition, nestedGroup])`
/// Zod keeps for `value`: the first that passes, else the first that only
/// failed its checks. `true` for the condition.
pub(crate) fn reads_as_condition(value: &Value) -> bool {
    let status = |schema: &Z| run(&mut Cx::default(), schema, Some(value));
    match (status(&CONDITION), status(&NESTED_GROUP)) {
        (St::Valid, _) => true,
        (_, St::Valid) => false,
        (condition, group) => condition == St::Dirty || group != St::Dirty,
    }
}

const TARGET: Z = Z::Disc(
    "type",
    &[
        Z::Obj(&[("type", Z::LitStr("block")), ("id", ID)]),
        Z::Obj(&[("type", Z::LitStr("ending")), ("id", ID)]),
    ],
);

const CALCULATION: Z = Z::Obj(&[
    ("id", ID),
    ("when", Z::Def(&Z::Nul(&CONDITION_GROUP))),
    ("variable", REF),
    (
        "op",
        Z::Enum(&["add", "subtract", "multiply", "divide", "set"]),
    ),
    ("value", OPERAND),
]);

const JUMP: Z = Z::Obj(&[("id", ID), ("when", CONDITION_GROUP), ("to", TARGET)]);

const BLOCK_LOGIC: Z = Z::Obj(&[
    ("blockId", ID),
    (
        "calculations",
        Z::Def(&Z::Arr(&CALCULATION, None, Some(50))),
    ),
    ("jumps", Z::Def(&Z::Arr(&JUMP, None, Some(50)))),
    ("otherwise", Z::Def(&Z::Nul(&TARGET))),
]);

const ENDING_RULE: Z = Z::Obj(&[("id", ID), ("when", CONDITION_GROUP), ("endingId", ID)]);

const PRESENTATION: Z = Z::Def(&Z::Obj(&[
    ("layout", Z::Def(&Z::Enum(&["conversational", "classic"]))),
    ("language", Z::Def(&Z::Enum(&["en", "nl"]))),
    (
        "progressBar",
        Z::Def(&Z::Enum(&["percentage", "proportion", "none"])),
    ),
    ("showQuestionNumbers", FLAG),
    ("allowBack", FLAG),
]));

const DEFINITION: Z = Z::Obj(&[
    ("schemaVersion", Z::Def(&Z::LitNum(1.0))),
    ("presentation", PRESENTATION),
    ("welcome", Z::Def(&Z::Nul(&WELCOME))),
    ("blocks", Z::Arr(&BLOCK, None, Some(500))),
    ("endings", Z::Arr(&ENDING, Some(1), Some(50))),
    ("hidden", Z::Def(&Z::Arr(&HIDDEN, None, Some(50)))),
    ("variables", Z::Def(&Z::Arr(&VARIABLE, None, Some(50)))),
    ("logic", Z::Def(&Z::Arr(&BLOCK_LOGIC, None, Some(500)))),
    ("endingRules", Z::Def(&Z::Arr(&ENDING_RULE, None, Some(50)))),
]);

const COLOR: Z = Z::Def(&Z::Str(&[S::Regex(is_color, None)]));

const THEME: Z = Z::Obj(&[
    (
        "font",
        Z::Def(&Z::Enum(&[
            "inter", "system", "serif", "mono", "rounded", "grotesk",
        ])),
    ),
    (
        "colors",
        Z::Def(&Z::Obj(&[
            ("background", COLOR),
            ("question", COLOR),
            ("answer", COLOR),
            ("button", COLOR),
            ("buttonText", COLOR),
        ])),
    ),
    (
        "background",
        Z::Def(&Z::Obj(&[
            ("imageUrl", Z::Opt(&URL)),
            (
                "overlay",
                Z::Def(&Z::Num(&[N::Int, N::Min(0.0), N::Max(100.0)])),
            ),
        ])),
    ),
    ("logoUrl", Z::Opt(&URL)),
    (
        "radius",
        Z::Def(&Z::Enum(&["none", "small", "medium", "large", "full"])),
    ),
    ("alignment", Z::Def(&Z::Enum(&["left", "center"]))),
    ("fontSize", Z::Def(&Z::Enum(&["small", "medium", "large"]))),
]);

/// The field types the discriminated union knows, in its order.
#[cfg(test)]
fn field_block_types() -> Vec<&'static str> {
    let Z::Disc(key, options) = FIELD_BLOCK else {
        return Vec::new();
    };
    options
        .iter()
        .filter_map(|option| discriminator_of(option, key))
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::definition::FIELD_TYPES;
    use super::*;

    fn messages(value: &Value) -> Vec<(String, String)> {
        check_definition(value)
            .into_iter()
            .map(|issue| (issue.path_text(), issue.message))
            .collect()
    }

    #[test]
    fn the_field_union_lists_every_field_type() {
        assert_eq!(field_block_types(), FIELD_TYPES);
    }

    #[test]
    fn a_minimal_definition_passes() {
        let value =
            json!({ "blocks": [], "endings": [{ "id": "e_1", "ref": "end", "title": "Done" }] });
        assert_eq!(check_definition(&value), Vec::<SchemaIssue>::new());
    }

    #[test]
    fn issues_carry_zods_messages_and_paths() {
        let value = json!({ "blocks": [], "endings": [] });
        assert_eq!(
            messages(&value),
            [(
                "endings".to_owned(),
                "Array must contain at least 1 element(s)".to_owned()
            )]
        );
        let value = json!({ "endings": [{ "id": "", "ref": "End", "title": 3 }] });
        assert_eq!(
            messages(&value),
            [
                ("blocks".to_owned(), "Required".to_owned()),
                (
                    "endings.0.id".to_owned(),
                    "String must contain at least 1 character(s)".to_owned()
                ),
                ("endings.0.ref".to_owned(), REF_MESSAGE.to_owned()),
                (
                    "endings.0.title".to_owned(),
                    "Expected string, received number".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn unions_take_the_first_dirty_option_else_fail_as_a_whole() {
        let long = "x".repeat(1001);
        let value = json!({
            "blocks": [
                { "id": "b_1", "ref": "a", "type": "statement", "title": long },
                { "id": "b_2", "ref": "b", "type": "nope", "title": "T" },
                { "id": "b_3", "ref": "c", "type": "short_text", "title": "T", "properties": { "maxLength": 1.5 } },
            ],
            "endings": [{ "id": "e_1", "ref": "end", "title": "Done" }],
        });
        assert_eq!(
            messages(&value),
            [
                (
                    "blocks.0.title".to_owned(),
                    "String must contain at most 1000 character(s)".to_owned()
                ),
                ("blocks.1".to_owned(), "Invalid input".to_owned()),
                (
                    "blocks.2.properties.maxLength".to_owned(),
                    "Expected integer, received float".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn discriminators_and_enums_name_their_options() {
        let value = json!({
            "blocks": [],
            "endings": [{ "id": "e_1", "ref": "end", "title": "Done" }],
            "variables": [{ "name": "x", "type": "date" }],
            "presentation": { "layout": "grid" },
        });
        assert_eq!(
            messages(&value),
            [
                (
                    "presentation.layout".to_owned(),
                    "Invalid enum value. Expected 'conversational' | 'classic', received 'grid'"
                        .to_owned()
                ),
                (
                    "variables.0.type".to_owned(),
                    "Invalid discriminator value. Expected 'number' | 'text'".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn theme_checks_colors() {
        let issues = check_theme(
            &json!({ "colors": { "button": "blue" }, "background": { "overlay": 101 } }),
        );
        let found: Vec<(String, String)> = issues
            .into_iter()
            .map(|issue| (issue.path_text(), issue.message))
            .collect();
        assert_eq!(
            found,
            [
                ("colors.button".to_owned(), "Invalid".to_owned()),
                (
                    "background.overlay".to_owned(),
                    "Number must be less than or equal to 100".to_owned()
                ),
            ]
        );
    }
}
