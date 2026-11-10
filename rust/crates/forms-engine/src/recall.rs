//! Recall: answers, hidden values and variables inside titles, descriptions,
//! endings, redirect URLs and emails (`recall.ts`).

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::{Map, Value};
use weldsuite_kit::cursor::encode_uri_component;

use super::blocks::find_field_by_ref;
use super::definition::FormDefinition;
use super::display::{display_answer, format_number};
use super::js::JS_SPACE_CLASS;

/// `{{field:ref}}`, `{{hidden:name}}`, `{{var:name}}`; white space inside
/// the braces is allowed.
static RECALL_RE: LazyLock<Regex> = LazyLock::new(|| {
    let space = format!("[{JS_SPACE_CLASS}]*");
    Regex::new(&format!(
        r"\{{\{{{space}(field|hidden|var):([A-Za-z0-9_]+){space}\}}\}}"
    ))
    .expect("the recall pattern compiles")
});

/// What recall reads: raw answers by field id, hidden values by name,
/// variables by name (numbers and text).
#[derive(Debug, Clone, Copy, Default)]
pub struct RecallContext<'a> {
    pub answers: Option<&'a Map<String, Value>>,
    pub hidden: Option<&'a Map<String, Value>>,
    pub variables: Option<&'a Map<String, Value>>,
}

/// What a recall token refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecallKind {
    Field,
    Hidden,
    Var,
}

impl RecallKind {
    fn parse(kind: &str) -> Option<Self> {
        match kind {
            "field" => Some(Self::Field),
            "hidden" => Some(Self::Hidden),
            "var" => Some(Self::Var),
            _ => None,
        }
    }
}

/// The text of one recall token; empty when it refers to nothing.
pub fn recall_value(
    kind: RecallKind,
    name: &str,
    def: &FormDefinition,
    ctx: RecallContext<'_>,
) -> String {
    match kind {
        RecallKind::Field => find_field_by_ref(def, name).map_or_else(String::new, |field| {
            display_answer(
                field,
                ctx.answers.and_then(|answers| answers.get(&field.id)),
            )
        }),
        RecallKind::Hidden => match ctx.hidden.and_then(|hidden| hidden.get(name)) {
            Some(Value::String(value)) => value.clone(),
            _ => String::new(),
        },
        RecallKind::Var => match ctx.variables.and_then(|variables| variables.get(name)) {
            Some(Value::Number(number)) => number.as_f64().map(format_number).unwrap_or_default(),
            Some(Value::String(value)) => value.clone(),
            _ => String::new(),
        },
    }
}

/// Fills the recall tokens of a text; unknown references become an empty
/// string. `encode` URL-encodes each value (`encodeURIComponent`), for
/// redirect URLs.
pub fn recall(text: &str, def: &FormDefinition, ctx: RecallContext<'_>, encode: bool) -> String {
    RECALL_RE
        .replace_all(text, |captures: &Captures<'_>| {
            let kind = RecallKind::parse(&captures[1]).unwrap_or(RecallKind::Var);
            let value = recall_value(kind, &captures[2], def, ctx);
            if encode {
                encode_uri_component(&value)
            } else {
                value
            }
        })
        .into_owned()
}

/// The refs, hidden names and variable names a text recalls, in order.
pub fn recall_tokens(text: &str) -> Vec<(RecallKind, String)> {
    RECALL_RE
        .captures_iter(text)
        .filter_map(|captures| Some((RecallKind::parse(&captures[1])?, captures[2].to_owned())))
        .collect()
}
