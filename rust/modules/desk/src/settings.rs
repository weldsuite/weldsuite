//! WeldDesk settings: helpdesk settings and widgets, help center settings and domains, the desk widget, desk assignment, helpdesk email addresses, helpdesk analytics.
//!
//! One submodule per desk-api route file:
//! - [`helpdesk`]: `/api/helpdesk-settings` (`routes/helpdesk-settings`)
//! - [`helpcenter`]: `/api/helpcenter-settings` (`routes/helpcenter-settings`)
//! - [`widget`]: `/api/desk/widget` (`routes/desk-widget`)
//! - [`assignment`]: `/api/desk/assignment` (`routes/desk-assignment`)
//! - [`email`]: `/api/helpdesk-email` (`routes/helpdesk-email`)
//! - [`analytics`]: `/api/helpdesk-analytics` (`routes/helpdesk-analytics`)

mod analytics;
mod assignment;
mod email;
mod helpcenter;
mod helpdesk;
#[rustfmt::skip]
mod tables;
mod widget;

use std::sync::Arc;

use axum::Router;
use serde_json::{Map, Value};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, DeskState};

/// The routes, relative to `/api`, each with its `requirePermission`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/helpdesk-settings", helpdesk::routes(gate))
        .nest("/helpcenter-settings", helpcenter::routes(gate))
        .nest("/desk/widget", widget::routes(gate))
        .nest("/desk/assignment", assignment::routes(gate))
        .nest("/helpdesk-email", email::routes(gate))
        .nest("/helpdesk-analytics", analytics::routes(gate))
}

/// `getMasterDb(c.env)`: the request's master database (conformance), else
/// the deployment's.
fn master(caller: &Caller, state: &DeskState) -> Option<PgPool> {
    caller
        .master
        .as_ref()
        .map(|master| master.0.clone())
        .or_else(|| state.master.clone())
}

/// `await c.req.json().catch(() => fallback)`: the body as JSON, whatever
/// its content type; `None` when it doesn't parse.
fn lenient_json(body: &[u8]) -> Option<Value> {
    serde_json::from_slice(body).ok()
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// A field of a flat Zod object whose fields are all `.optional()`.
#[derive(Debug, Clone, Copy)]
enum Opt {
    Bool,
    /// `z.string()`, `.max(n)` when given.
    Str(Option<usize>),
    /// `z.number()`.
    Num,
    /// `z.enum([...])`.
    Choice(&'static [&'static str]),
}

/// Read `fields` (all `.optional()`) in the schema's order into `out`: the
/// parsed object Zod hands the route, with only the keys the body had.
fn read_optional(
    issues: &mut Issues,
    body: &Map<String, Value>,
    fields: &[(&str, Opt)],
    out: &mut Map<String, Value>,
) {
    for (key, kind) in fields {
        let value = match kind {
            Opt::Bool => issues
                .boolean(body, key, Presence::Optional)
                .into_option()
                .map(Value::Bool),
            Opt::Str(max) => issues
                .text(body, key, Presence::Optional, None, *max)
                .into_option()
                .map(Value::String),
            Opt::Num => issues
                .number(
                    body,
                    key,
                    Presence::Optional,
                    weldsuite_kit::validation::Number::default(),
                )
                .into_option()
                .and(body.get(*key).cloned()),
            Opt::Choice(options) => issues
                .choice(body, key, Presence::Optional, options)
                .into_option()
                .map(Value::String),
        };
        if let Some(value) = value {
            out.insert((*key).to_owned(), value);
        }
    }
}

/// The value of a row column read as `to_jsonb(column)#>>'{}'`, as
/// Drizzle's `Date` serialises it.
fn js_stamp(text: Option<String>) -> Value {
    text.map_or(Value::Null, |text| {
        Value::String(crate::table::js_date(&text))
    })
}
