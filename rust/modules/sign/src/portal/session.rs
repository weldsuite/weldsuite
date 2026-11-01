//! Signer sessions (`packages/domains/sign/src/session.ts`): what the portal
//! sends as a bearer token once a link (and its code, when one is required)
//! was checked. HMAC-SHA-256 over a small JSON payload, bound to one
//! recipient of one envelope in one workspace and to the link that opened
//! it, valid two hours.
//!
//! The format is the TypeScript one byte for byte (`<payload>.<mac>`, both
//! base64url without padding, the payload's keys in its order), so a session
//! either backend issued is valid on the other with the same
//! `SIGN_SESSION_SECRET`.

use aws_lc_rs::hmac;
use base64::Engine;
use base64::alphabet;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde::Serialize;
use serde_json::Value;

/// Two hours, in milliseconds (`SESSION_TTL_MS`).
pub(crate) const SESSION_TTL_MS: i64 = 2 * 60 * 60 * 1000;

/// A checked session (`SignerSession`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SignerSession {
    /// Clerk org id of the workspace.
    pub(crate) org_id: String,
    pub(crate) envelope_id: String,
    pub(crate) recipient_id: String,
    /// SHA-256 of the signing link that opened the session: every request
    /// checks the link is still live, so revoking it ends the session.
    pub(crate) token_hash: String,
}

/// The payload as `JSON.stringify({ ...session, exp })` writes it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload<'a> {
    org_id: &'a str,
    envelope_id: &'a str,
    recipient_id: &'a str,
    token_hash: &'a str,
    exp: i64,
}

fn key(secret: &str) -> hmac::Key {
    hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes())
}

/// `signSession`: the token and its expiry (epoch milliseconds).
pub(crate) fn sign_session(secret: &str, session: &SignerSession, now_ms: i64) -> (String, i64) {
    let exp = now_ms + SESSION_TTL_MS;
    let payload = Payload {
        org_id: &session.org_id,
        envelope_id: &session.envelope_id,
        recipient_id: &session.recipient_id,
        token_hash: &session.token_hash,
        exp,
    };
    // A struct of strings and an integer always serialises.
    let json = serde_json::to_string(&payload).unwrap_or_default();
    let body = URL_SAFE_NO_PAD.encode(json.as_bytes());
    let mac = hmac::sign(&key(secret), body.as_bytes());
    (
        format!("{body}.{}", URL_SAFE_NO_PAD.encode(mac.as_ref())),
        exp,
    )
}

/// `atob` after `fromB64url`'s rewrite: lenient about padding and trailing
/// bits, as the forgiving base64 decode is.
const FORGIVING: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// `fromB64url`: base64url (or plain base64) to bytes.
fn from_b64url(text: &str) -> Option<Vec<u8>> {
    let standard: String = text
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    FORGIVING.decode(standard).ok()
}

/// A non-empty string field of the payload. TypeScript only checks the
/// field is truthy; any other value then fails the link check, so the
/// session is refused either way.
fn field(payload: &Value, name: &str) -> Option<String> {
    payload[name]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// `verifySession`: the session in a bearer token, or `None` when it is
/// malformed, forged or expired.
pub(crate) fn verify_session(secret: &str, token: &str, now_ms: i64) -> Option<SignerSession> {
    let mut parts = token.split('.');
    let body = parts.next().filter(|part| !part.is_empty())?;
    let mac = parts.next().filter(|part| !part.is_empty())?;
    if parts.next().is_some() {
        return None;
    }
    let mac = from_b64url(mac)?;
    hmac::verify(&key(secret), body.as_bytes(), &mac).ok()?;
    let payload: Value = serde_json::from_slice(&from_b64url(body)?).ok()?;
    let exp = payload["exp"].as_f64()?;
    #[allow(clippy::cast_precision_loss, reason = "epoch milliseconds fit an f64")]
    if exp < now_ms as f64 {
        return None;
    }
    Some(SignerSession {
        org_id: field(&payload, "orgId")?,
        envelope_id: field(&payload, "envelopeId")?,
        recipient_id: field(&payload, "recipientId")?,
        token_hash: field(&payload, "tokenHash")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> SignerSession {
        SignerSession {
            org_id: "org_1".to_owned(),
            envelope_id: "sgn_1".to_owned(),
            recipient_id: "sgr_1".to_owned(),
            token_hash: "ab".repeat(32),
        }
    }

    /// `signSession('flow-test-secret', session, 1_700_000_000_000)` in Node.
    #[test]
    fn tokens_match_typescript() {
        let (token, exp) = sign_session("flow-test-secret", &session(), 1_700_000_000_000);
        assert_eq!(exp, 1_700_007_200_000);
        let body = token.split('.').next().unwrap_or_default();
        let json = from_b64url(body).unwrap_or_default();
        assert_eq!(
            String::from_utf8(json).unwrap_or_default(),
            format!(
                r#"{{"orgId":"org_1","envelopeId":"sgn_1","recipientId":"sgr_1","tokenHash":"{}","exp":1700007200000}}"#,
                "ab".repeat(32)
            )
        );
        assert_eq!(
            token,
            concat!(
                "eyJvcmdJZCI6Im9yZ18xIiwiZW52ZWxvcGVJZCI6InNnbl8xIiwicmVjaXBpZW50SWQiOiJzZ3JfMSIsInRva2VuSGFzaCI6",
                "ImFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWIiLCJleHAi",
                "OjE3MDAwMDcyMDAwMDB9.esPs0SfwBynqF3m-rFEuHe7oZU6tMy7ttQHESHN2n1w",
            )
        );
    }

    #[test]
    fn sessions_verify_until_they_expire() {
        let (token, exp) = sign_session("s", &session(), 1_000);
        assert_eq!(verify_session("s", &token, exp), Some(session()));
        assert_eq!(verify_session("s", &token, exp + 1), None);
        assert_eq!(verify_session("other", &token, 1_000), None);
        assert_eq!(verify_session("s", &format!("{token}.x"), 1_000), None);
        assert_eq!(verify_session("s", "", 1_000), None);
        assert_eq!(verify_session("s", ".", 1_000), None);
        // A payload without its fields is refused even with a valid mac.
        let body = URL_SAFE_NO_PAD.encode(br#"{"exp":99999999999999}"#);
        let mac = hmac::sign(&key("s"), body.as_bytes());
        let forged = format!("{body}.{}", URL_SAFE_NO_PAD.encode(mac.as_ref()));
        assert_eq!(verify_session("s", &forged, 1_000), None);
    }
}
