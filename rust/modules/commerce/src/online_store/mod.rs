//! WeldCommerce's online store (storefronts plan,
//! `weldsuite-documentation/plans/weldcommerce-storefronts.md`): a shop per
//! storefront sales channel, built in the platform's editor and rendered by
//! WeldSuite, or built by the merchant and uploaded as a static site.
//!
//! - `/api/online-store/sites/*` ([`sites`], [`content`], [`deployments`]):
//!   the site, its draft document, published versions, content pages,
//!   menus, redirects and static deployments (member session, `websites:*`).
//! - `/api/storefront-hosts/*` ([`hosts`]): free addresses and custom
//!   domains, mirrored into the master `storefront_hosts` ([`registry`]).
//! - `/public/storefront/*` ([`renderer`]): the published document for the
//!   storefront renderer, with the install's renderer secret.
//! - The storefront edge ([`edge`]), on a listener of its own: every shop
//!   host's traffic, resolved by host.
//!
//! New code here queries through the SeaORM entities (DATA-019).

pub mod config;
pub(crate) mod content;
pub(crate) mod deployments;
pub(crate) mod document;
pub mod edge;
pub(crate) mod hosts;
pub(crate) mod registry;
pub mod renderer;
pub(crate) mod sites;
pub(crate) mod tokens;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_kit::ApiError;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

pub use config::OnlineStoreConfig;
pub use deployments::{DeployState, deploy_router};
pub use hosts::sweep_hosts;

use crate::CommerceState;

/// `/api/online-store/*`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .merge(sites::routes(gate))
        .merge(content::routes(gate))
        .merge(deployments::routes(gate))
}

/// `/api/storefront-hosts/*`.
pub(crate) fn host_routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    hosts::routes(gate)
}

/// 400 `VALIDATION_ERROR` with `details.fields` (path → message).
pub(crate) fn invalid(problems: &[(String, String)]) -> Response {
    let fields: Map<String, Value> = problems
        .iter()
        .map(|(path, message)| (path.clone(), json!(message)))
        .collect();
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "VALIDATION_ERROR",
        "The request is not valid",
    )
    .with_details(json!({ "fields": fields }))
    .into_response()
}

/// One field's 400.
pub(crate) fn invalid_field(path: &str, message: &str) -> Response {
    invalid(&[(path.to_owned(), message.to_owned())])
}

pub(crate) fn conflict(code: &'static str, message: &str, details: Option<Value>) -> Response {
    let error = ApiError::new(StatusCode::CONFLICT, code, message);
    match details {
        Some(details) => error.with_details(details).into_response(),
        None => error.into_response(),
    }
}

pub(crate) fn not_found(resource: &str, id: &str) -> Response {
    ApiError::not_found(resource, Some(id)).into_response()
}

/// 503 `FEATURE_UNAVAILABLE`: the install isn't set up for this.
pub(crate) fn unavailable(message: &str) -> Response {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "FEATURE_UNAVAILABLE",
        message,
    )
    .into_response()
}

/// 500 after logging what failed.
pub(crate) fn failed(error: &dyn std::fmt::Display, message: &str) -> Response {
    crate::internal(error, message)
}

/// The JSON object a request carries (an empty body is `{}`), or its 400.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
pub(crate) fn body_object(
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Map<String, Value>, Response> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Map::new());
    }
    let json = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| v.starts_with("application/json"));
    if !json {
        return Err(invalid_field("body", "Send JSON"));
    }
    // Parsed by the kit's body reader, as every other commerce route's body
    // (`crate::validate`); a body without a content type is read as JSON.
    match weldsuite_kit::validation::json_body(Some("application/json"), body) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err(invalid_field("body", "Must be a JSON object")),
    }
}

/// An optional trimmed text field of at most `max` characters; `Err` with
/// the problem.
#[allow(
    clippy::option_option,
    reason = "absent, cleared and set are three different answers"
)]
pub(crate) fn optional_text(
    body: &Map<String, Value>,
    key: &str,
    max: usize,
) -> Result<Option<Option<String>>, (String, String)> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(text)) => {
            let text = text.trim();
            if text.chars().count() > max {
                Err((key.to_owned(), format!("At most {max} characters")))
            } else if text.is_empty() {
                Ok(Some(None))
            } else {
                Ok(Some(Some(text.to_owned())))
            }
        }
        Some(_) => Err((key.to_owned(), "Must be text".to_owned())),
    }
}

/// A timestamp as the API writes it.
pub(crate) fn iso(at: time::PrimitiveDateTime) -> String {
    weldsuite_events::iso_timestamp(at.assume_utc())
}
