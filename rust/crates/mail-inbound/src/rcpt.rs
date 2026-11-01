//! The `RCPT TO` check Haraka asks `weldsuite serve` for (MAIL-010):
//! `POST /internal/mail-inbound/recipients` with `{ "address": "…" }` and
//! `Authorization: Bearer <MAIL_INBOUND_SECRET>`.
//!
//! | Answer | Haraka replies |
//! |---|---|
//! | 200 `{ "accept": true, "match": "exact" \| "catch-all" }` | 250 |
//! | 404 `{ "accept": false }` | 550 5.1.1 |
//! | 503 (lookup failed, or no secret configured), 401 | 451 |

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::{Value, json};
use weldsuite_db::PgPool;

use crate::recipients::lookup_recipient;

#[derive(Clone)]
struct RcptState {
    master: PgPool,
    secret: Option<Arc<str>>,
}

/// Equal in time independent of where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        axum::Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

async fn recipients(State(state): State<RcptState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(secret) = &state.secret else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "NOT_CONFIGURED",
            "MAIL_INBOUND_SECRET is not set",
        );
    };
    let presented = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !same(presented.as_bytes(), secret.as_bytes()) {
        return error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "Invalid secret");
    }
    let address = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v["address"].as_str().map(str::to_owned))
        .filter(|a| a.contains('@'));
    let Some(address) = address else {
        return error(
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
            "address is required",
        );
    };
    match lookup_recipient(&state.master, &address).await {
        Ok(Some(matched)) => {
            axum::Json(json!({ "accept": true, "match": matched.as_str() })).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "accept": false })),
        )
            .into_response(),
        Err(err) => {
            tracing::error!(error = %err, "[MailInbound] recipient lookup failed");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "LOOKUP_FAILED",
                "Recipient lookup failed",
            )
        }
    }
}

/// The routes, relative to `/internal/mail-inbound`. `secret` is
/// `MAIL_INBOUND_SECRET`; without it every call is refused (503).
pub fn router<S>(master: PgPool, secret: Option<String>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/recipients", post(recipients))
        .with_state(RcptState {
            master,
            secret: secret.filter(|s| !s.is_empty()).map(Arc::from),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_in_constant_time() {
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"ab"));
    }
}
