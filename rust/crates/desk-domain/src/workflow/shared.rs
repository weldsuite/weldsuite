//! `helpdesk-workflow-worker/src/lib/workflow-shared.ts`: template
//! resolution, condition evaluation, conversation id resolution, step
//! classification, and the JavaScript value semantics they rest on.
//!
//! Values are `serde_json::Value`s; JavaScript's `undefined` is `None`. One
//! known difference: `asText` of an object prints its keys sorted (as
//! `serde_json` keeps them), where TypeScript prints them in insertion order.

use serde_json::{Map, Value};
use weldsuite_core_domain::js::number_text;

// ---------------------------------------------------------------------------
// JavaScript semantics
// ---------------------------------------------------------------------------

/// `!!value`.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `a || b` on optional values: `a` when truthy, else `b`.
pub fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(a) { a } else { b }
}

/// `String(value)`.
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(n)) => number_text(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

/// `asText(value)` (`@weldsuite/text`): `String()`, except that a plain
/// object becomes JSON.
pub fn as_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => as_text(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(object @ Value::Object(_)) => json_text(object),
        other => js_string(other),
    }
}

/// `JSON.stringify(value)`, numbers printed as JavaScript prints them.
pub fn json_text(value: &Value) -> String {
    match value {
        Value::Number(n) => {
            let number = n.as_f64().unwrap_or(f64::NAN);
            if number.is_finite() {
                number_text(number)
            } else {
                "null".to_owned()
            }
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(json_text).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(key, item)| format!(
                    "{}:{}",
                    serde_json::to_string(key).unwrap_or_default(),
                    json_text(item)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

/// `Number(value)`.
pub fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => string_to_number(text),
        Some(array @ Value::Array(_)) => string_to_number(&js_string(Some(array))),
    }
}

/// `StringToNumber`: whitespace trimmed, empty is 0, decimal (with sign and
/// exponent), `0x`/`0o`/`0b` integers, `Infinity`; anything else `NaN`.
pub fn string_to_number(text: &str) -> f64 {
    let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if text.is_empty() {
        return 0.0;
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| {
                acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let mut parts = mantissa.splitn(2, '.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    let mantissa_ok = digits(whole)
        && fraction.is_none_or(digits)
        && (!whole.is_empty() || fraction.is_some_and(|f| !f.is_empty()));
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    if !mantissa_ok || !exponent_ok {
        return f64::NAN;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// `a === b` for values that came out of JSON: primitives by type and
/// value (`NaN` never equal), objects and arrays never (two separate
/// objects are not the same reference).
pub fn strict_equals(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `array.includes(value)` (`SameValueZero`: `NaN` cannot come out of JSON,
/// so it is `===`).
pub fn includes(array: &[Value], value: Option<&Value>) -> bool {
    array.iter().any(|item| strict_equals(Some(item), value))
}

/// `o && typeof o === 'object' ? o[k] : undefined`, step by step.
fn get_path<'a>(root: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(root?, |value, key| match value {
        Value::Object(map) => map.get(*key),
        Value::Array(items) => key
            .parse::<usize>()
            .ok()
            .filter(|index| index.to_string() == *key)
            .and_then(|index| items.get(index)),
        _ => None,
    })
}

// ---------------------------------------------------------------------------
// Step classification
// ---------------------------------------------------------------------------

/// `isInteractiveStep(type)`.
pub fn is_interactive_step(step_type: &str) -> bool {
    matches!(
        step_type,
        "send_choices" | "collect_input" | "collect_customer_info"
    )
}

/// The step types whose output the widget shows (`isCustomerFacing` in the
/// step executor).
pub fn is_customer_facing(step_type: &str) -> bool {
    matches!(
        step_type,
        "send_message"
            | "send_choices"
            | "collect_input"
            | "collect_customer_info"
            | "suggest_articles"
            | "ai_auto_reply"
            | "ai_agent"
    )
}

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

/// What a template may reference.
#[derive(Debug, Clone, Copy)]
pub struct Scope<'a> {
    pub previous_results: &'a Map<String, Value>,
    pub trigger_data: &'a Value,
    pub variables: &'a Map<String, Value>,
    pub contact_data: &'a Map<String, Value>,
}

const REFERENCE_PREFIXES: [&str; 4] = ["steps.", "trigger.", "variables.", "contact."];

fn is_reference(path: &str) -> bool {
    REFERENCE_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

/// `resolveReference(path, scope)`: a `steps.` / `trigger.` / `variables.` /
/// `contact.` reference; `None` (undefined) when unknown.
pub fn resolve_reference<'a>(path: &str, scope: &Scope<'a>) -> Option<&'a Value> {
    if let Some(rest) = path.strip_prefix("steps.") {
        let mut parts = rest.split('.');
        let step_id = parts.next().unwrap_or_default();
        let keys: Vec<&str> = parts.collect();
        return get_path(scope.previous_results.get(step_id), &keys);
    }
    if let Some(rest) = path.strip_prefix("trigger.") {
        let keys: Vec<&str> = rest.split('.').collect();
        return get_path(Some(scope.trigger_data), &keys);
    }
    if let Some(rest) = path.strip_prefix("variables.") {
        return scope.variables.get(rest);
    }
    if let Some(rest) = path.strip_prefix("contact.") {
        return scope.contact_data.get(rest);
    }
    None
}

/// The `{{…}}` spans of `/\{\{([^{}]+)\}\}/g`: (start, end, inner).
fn template_spans(value: &str) -> Vec<(usize, usize, &str)> {
    let bytes = value.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            let mut j = i + 2;
            while j < bytes.len() && bytes[j] != b'{' && bytes[j] != b'}' {
                j += 1;
            }
            if j > i + 2 && j + 1 < bytes.len() && bytes[j] == b'}' && bytes[j + 1] == b'}' {
                spans.push((i, j + 2, &value[i + 2..j]));
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }
    spans
}

fn resolve_string_input(value: &str, scope: &Scope<'_>) -> Value {
    if !(value.contains("{{") && value.contains("}}")) {
        return Value::String(value.to_owned());
    }
    let spans = template_spans(value);
    // A value that is exactly one template keeps the referenced value's type.
    if let [(0, end, inner)] = spans.as_slice()
        && *end == value.len()
        && let Some(found) = resolve_reference(inner.trim(), scope)
    {
        return found.clone();
    }
    let mut out = String::with_capacity(value.len());
    let mut at = 0;
    for (start, end, inner) in spans {
        out.push_str(&value[at..start]);
        if let Some(found) = resolve_reference(inner.trim(), scope) {
            out.push_str(&as_text(Some(found)));
        }
        at = end;
    }
    out.push_str(&value[at..]);
    Value::String(out)
}

fn resolve_input_value(value: &Value, scope: &Scope<'_>) -> Value {
    match value {
        Value::String(text) => resolve_string_input(text, scope),
        // Items that are objects (arrays included) resolve as records, so an
        // array inside an array becomes an object keyed by index, as
        // `Object.entries` makes it; other items stay as they are.
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| match item {
                    Value::Object(map) => Value::Object(resolve_inputs_in_scope(map, scope)),
                    Value::Array(inner) => Value::Object(resolve_inputs_in_scope(
                        &inner
                            .iter()
                            .enumerate()
                            .map(|(i, v)| (i.to_string(), v.clone()))
                            .collect(),
                        scope,
                    )),
                    other => other.clone(),
                })
                .collect(),
        ),
        Value::Object(map) => Value::Object(resolve_inputs_in_scope(map, scope)),
        other => other.clone(),
    }
}

fn resolve_inputs_in_scope(inputs: &Map<String, Value>, scope: &Scope<'_>) -> Map<String, Value> {
    inputs
        .iter()
        .map(|(key, value)| (key.clone(), resolve_input_value(value, scope)))
        .collect()
}

/// `resolveInputs(inputs, previousResults, triggerData, variables, contactData)`.
pub fn resolve_inputs(inputs: &Map<String, Value>, scope: &Scope<'_>) -> Map<String, Value> {
    resolve_inputs_in_scope(inputs, scope)
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

/// `new RegExp(pattern).test(text)`: JavaScript's default (non-Unicode)
/// mode, so `\d`, `\w` and `\s` are ASCII. A pattern the regex engine
/// cannot compile is an error (`SyntaxError` in TypeScript).
fn regex_test(pattern: &str, text: &str) -> Result<bool, String> {
    let regex = regex::bytes::RegexBuilder::new(pattern)
        .unicode(false)
        .build()
        .map_err(|error| format!("Invalid regular expression: /{pattern}/: {error}"))?;
    Ok(regex.is_match(text.as_bytes()))
}

/// `evaluateCondition(condition, previousResults, triggerData, variables, contactData)`.
/// `Err` where TypeScript throws (an invalid `matches` pattern).
pub fn evaluate_condition(
    condition: &Map<String, Value>,
    scope: &Scope<'_>,
) -> Result<bool, String> {
    let raw_field = condition.get("field");
    if !truthy(raw_field) || !truthy(condition.get("operator")) {
        return Ok(false);
    }
    let field = as_text(raw_field);
    let field_value: Option<&Value> = if is_reference(&field) {
        resolve_reference(&field, scope)
    } else {
        raw_field
    };
    let value = condition.get("value");
    let Some(operator) = condition.get("operator").and_then(Value::as_str) else {
        return Ok(false);
    };
    let compare = |test: fn(f64, f64) -> bool| test(js_number(field_value), js_number(value));
    Ok(match operator {
        "eq" | "equals" => strict_equals(field_value, value),
        "neq" | "not_equals" => !strict_equals(field_value, value),
        "gt" | "greater_than" => compare(|a, b| a > b),
        "gte" | "greater_than_or_equals" => compare(|a, b| a >= b),
        "lt" | "less_than" => compare(|a, b| a < b),
        "lte" | "less_than_or_equals" => compare(|a, b| a <= b),
        "contains" => js_string(field_value).contains(&js_string(value)),
        "starts_with" => js_string(field_value).starts_with(&js_string(value)),
        "ends_with" => js_string(field_value).ends_with(&js_string(value)),
        "exists" => !matches!(field_value, None | Some(Value::Null)),
        "not_exists" => matches!(field_value, None | Some(Value::Null)),
        "in" => matches!(value, Some(Value::Array(items)) if includes(items, field_value)),
        "not_in" => !matches!(value, Some(Value::Array(items)) if includes(items, field_value)),
        "matches" => regex_test(&js_string(value), &js_string(field_value))?,
        _ => false,
    })
}

// ---------------------------------------------------------------------------
// Conversation id resolution
// ---------------------------------------------------------------------------

/// `resolveConversationId(inputs, triggerData)`.
pub fn resolve_conversation_id(
    inputs: &Map<String, Value>,
    trigger_data: &Value,
) -> Option<String> {
    if truthy(inputs.get("conversationId")) {
        return Some(as_text(inputs.get("conversationId")));
    }
    if trigger_data.get("entityType").and_then(Value::as_str) == Some("helpdesk_conversation") {
        return Some(js_string(trigger_data.get("entityId")));
    }
    if let Some(Value::Object(data)) = trigger_data.get("data") {
        if data.contains_key("conversationId") {
            return Some(js_string(data.get("conversationId")));
        }
        if data.contains_key("id") {
            return Some(js_string(data.get("id")));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_parse_as_javascript_does() {
        for (text, expected) in [
            ("", "0"),
            ("  42 ", "42"),
            ("-1.5e2", "-150"),
            (".5", "0.5"),
            ("5.", "5"),
            ("0x1F", "31"),
            ("Infinity", "Infinity"),
        ] {
            assert_eq!(number_text(string_to_number(text)), expected, "{text}");
        }
        for text in ["abc", "1e", "-0x1", "inf", "NaN", "1 2", "."] {
            assert!(string_to_number(text).is_nan(), "{text}");
        }
        assert!(js_number(Some(&json!({}))).is_nan());
        assert_eq!(number_text(js_number(Some(&json!([7])))), "7");
    }

    #[test]
    fn templates_find_their_spans_as_the_regex_does() {
        let spans: Vec<&str> = template_spans("{{{a}}} {{b}} {{}} {{c")
            .into_iter()
            .map(|s| s.2)
            .collect();
        assert_eq!(spans, ["a", "b"]);
    }
}
