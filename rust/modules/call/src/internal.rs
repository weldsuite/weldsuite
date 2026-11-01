//! `POST /api/internal/telephony/fulfill-number`
//! (`routes/internal-telephony`): billing-worker's paid phone-number
//! fulfilment, behind the `INTERNAL_API_SECRET` bearer. Its answers keep the
//! internal `{ success, … }` contract.
//!
//! On Global the route re-reads the Stripe Checkout Session before buying
//! the number. Billing (Stripe) is Global-only, so here every fulfilment
//! that passes the bearer and the body answers as the worker does without
//! `STRIPE_SECRET_KEY`: 503, nothing bought.

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::header::AUTHORIZATION;
use http::{HeaderMap, StatusCode};
use serde_json::json;
use weldsuite_kit::validation::{Presence, Text};

use crate::{CallState, PublicCtx, validate};

/// `/^cs_\w{8,}$/`.
fn is_checkout_session_id(text: &str) -> bool {
    text.strip_prefix("cs_").is_some_and(|rest| {
        rest.len() >= 8 && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    })
}

/// `timingSafeEqualStr(a, b)`.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0_u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

fn refuse(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "error": error }))).into_response()
}

/// `POST /api/internal/telephony/fulfill-number`.
pub(crate) async fn fulfill_number(
    State(_state): State<CallState>,
    ctx: PublicCtx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(secret) = ctx.env("INTERNAL_API_SECRET") else {
        tracing::error!("[Internal API] INTERNAL_API_SECRET is not configured");
        return refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "Internal auth not configured",
        );
    };
    let Some(token) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return refuse(
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Authorization header",
        );
    };
    if !same(token, &secret) {
        return refuse(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    if let Err(response) = validate(&headers, &body, |issues, fields| {
        issues.pattern(
            fields,
            "checkoutSessionId",
            Presence::Required,
            None,
            None,
            is_checkout_session_id,
            "Invalid",
        );
        issues.text(fields, "clerkOrgId", Presence::Required, Some(1), None);
        issues.text(fields, "phoneNumber", Presence::Required, Some(1), None);
        issues.text(fields, "countryCode", Presence::Required, Some(2), Some(5));
        issues.text(fields, "numberType", Presence::Required, Some(1), None);
        for key in [
            "addressId",
            "displayName",
            "friendlyName",
            "voipPhoneNumberId",
        ] {
            issues.text_with(fields, key, Presence::Optional, Text::default());
        }
    }) {
        return *response;
    }
    tracing::warn!(
        "[Internal] Phone fulfill refused (503): Payment verification is not configured"
    );
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "success": false, "error": "Payment verification is not configured" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_session_ids_are_checked_like_the_worker() {
        assert!(is_checkout_session_id("cs_test_abcdefgh"));
        assert!(!is_checkout_session_id("cs_short"));
        assert!(!is_checkout_session_id("pi_abcdefghij"));
        assert!(same("secret", "secret"));
        assert!(!same("secret", "secreT"));
        assert!(!same("secret", "secrets"));
    }
}
