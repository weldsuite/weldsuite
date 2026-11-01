//! `LiveKit`'s webhook deliveries (`WebhookReceiver` of `livekit-server-sdk`):
//! the server POSTs each event as JSON (`Content-Type:
//! application/webhook+json`) with an `Authorization` header holding an
//! HS256 JWT signed with the API secret, issued by the API key, whose
//! `sha256` claim is the base64 SHA-256 of the body. A delivery is accepted
//! only when all three hold.
//!
//! Events (`WebhookEvent`): `room_started`, `room_finished`,
//! `participant_joined`, `participant_left`, `track_*`, `egress_*`,
//! `ingress_*`; each carries a unique `id`, `createdAt` (Unix seconds), the
//! `room` (`name`, `sid`) and, for participant events, the `participant`
//! (`identity`, `sid`, `name`, `joinedAt`).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Why a delivery was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebhookRejected {
    /// No `Authorization` header.
    MissingToken,
    /// The token is not signed by this API key pair, or has expired.
    BadToken,
    /// The token does not cover this body.
    BodyMismatch,
    /// The body is not a JSON object.
    BadBody,
}

impl std::fmt::Display for WebhookRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::MissingToken => "authorization header is empty",
            Self::BadToken => "invalid webhook token",
            Self::BodyMismatch => "sha256 checksum of body does not match",
            Self::BadBody => "webhook body is not a JSON object",
        })
    }
}

impl std::error::Error for WebhookRejected {}

#[derive(Deserialize)]
struct Claims {
    #[serde(default)]
    sha256: Option<String>,
}

/// Verify a delivery and return its event. `authorization` is the header as
/// sent (a bare JWT; a `Bearer ` prefix is tolerated).
pub fn verify_livekit_webhook(
    api_key: &str,
    api_secret: &str,
    body: &[u8],
    authorization: Option<&str>,
) -> Result<Value, WebhookRejected> {
    let token = authorization
        .map(str::trim)
        .map(|header| header.strip_prefix("Bearer ").unwrap_or(header).trim())
        .filter(|token| !token.is_empty())
        .ok_or(WebhookRejected::MissingToken)?;
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&[api_key]);
    validation.validate_aud = false;
    let claims = decode::<Claims>(
        token,
        &DecodingKey::from_secret(api_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| WebhookRejected::BadToken)?
    .claims;
    let hash = STANDARD.encode(Sha256::digest(body));
    if claims.sha256.as_deref() != Some(hash.as_str()) {
        return Err(WebhookRejected::BodyMismatch);
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(event @ Value::Object(_)) => Ok(event),
        _ => Err(WebhookRejected::BadBody),
    }
}

#[cfg(test)]
mod tests {
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde_json::json;

    use super::*;

    const KEY: &str = "APIkey";
    const SECRET: &str = "a-long-enough-secret-for-hs256-signing";

    fn token(issuer: &str, secret: &str, body: &[u8]) -> String {
        let claims = json!({
            "iss": issuer,
            "sha256": STANDARD.encode(Sha256::digest(body)),
            "exp": 4_102_444_800_i64,
        });
        encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("signs")
    }

    #[test]
    fn accepts_a_signed_delivery() {
        let body = br#"{"event":"room_finished","id":"EV_1","room":{"name":"ws-1"}}"#;
        let event =
            verify_livekit_webhook(KEY, SECRET, body, Some(&token(KEY, SECRET, body))).expect("ok");
        assert_eq!(event["event"], "room_finished");
    }

    #[test]
    fn refuses_what_it_cannot_trust() {
        let body = br#"{"event":"room_finished"}"#;
        assert_eq!(
            verify_livekit_webhook(KEY, SECRET, body, None),
            Err(WebhookRejected::MissingToken)
        );
        assert_eq!(
            verify_livekit_webhook(KEY, SECRET, body, Some(&token("other", SECRET, body))),
            Err(WebhookRejected::BadToken)
        );
        assert_eq!(
            verify_livekit_webhook(
                KEY,
                SECRET,
                body,
                Some(&token(KEY, "another-long-enough-secret-value", body))
            ),
            Err(WebhookRejected::BadToken)
        );
        assert_eq!(
            verify_livekit_webhook(
                KEY,
                SECRET,
                br#"{"event":"x"}"#,
                Some(&token(KEY, SECRET, body))
            ),
            Err(WebhookRejected::BodyMismatch)
        );
    }
}
