//! WeldDesk team and workflows: helpdesk contacts, the WeldAgent conversation
//! records, helpdesk workflows (`routes/helpdesk-contacts`,
//! `routes/helpdesk-weldagent`, `routes/helpdesk-workflows`). Agents and
//! departments are [`crate::library`] and [`crate::departments`].

mod contacts;
mod weldagent;
mod workflows;

use std::sync::Arc;

use axum::Router;
use serde_json::{Value, json};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::DeskState;

/// The routes, relative to `/api`, each with its `requirePermission`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/helpdesk-contacts", contacts::routes(gate))
        .nest("/helpdesk-weldagent", weldagent::routes(gate))
        .nest("/helpdesk-workflows", workflows::routes(gate))
}

/// A JavaScript number as `JSON.stringify` writes it: `NaN` and `Infinity`
/// are `null`, whole numbers have no fraction.
fn js_number(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        #[allow(clippy::cast_possible_truncation)]
        return json!(value as i64);
    }
    json!(value)
}

/// `String(value)` for a JavaScript number, as a driver sends it as a
/// statement parameter.
fn js_number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value.fract() == 0.0 && value.abs() < 1e21 {
        #[allow(clippy::cast_possible_truncation)]
        return format!("{}", value as i64);
    }
    format!("{value}")
}

/// `text.substring(0, end)`: UTF-16 code units, as JavaScript counts them.
fn js_substring(text: &str, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(end).collect();
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_read_like_javascript() {
        assert_eq!(js_number(f64::NAN), Value::Null);
        assert_eq!(js_number(f64::INFINITY), Value::Null);
        assert_eq!(js_number(2.0), json!(2));
        assert_eq!(js_number(2.5), json!(2.5));
        assert_eq!(js_number_text(-25.0), "-25");
        assert_eq!(js_number_text(2.5), "2.5");
        assert_eq!(js_number_text(f64::INFINITY), "Infinity");
        assert_eq!(js_substring("abc", 2), "ab");
        assert_eq!(js_substring("ab", 5), "ab");
    }
}
