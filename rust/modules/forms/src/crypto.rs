//! Hashes, HMACs and signed tokens (`lib/crypto.ts`). A token is
//! `<base64url(json)>.<base64url(hmac)>`, byte for byte what the worker's
//! `signToken` writes for the same payload and secret, so either backend
//! accepts the other's sessions.

use aws_lc_rs::{constant_time, digest, hmac};
use base64::Engine;
use base64::alphabet;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde::Serialize;
use serde_json::Value;

/// `sha256Hex(data)`.
pub(crate) fn sha256_hex(data: &[u8]) -> String {
    hex::encode(digest::digest(&digest::SHA256, data).as_ref())
}

/// `hmacHex(secret, message)`: HMAC-SHA-256 as lowercase hex.
pub(crate) fn hmac_hex(secret: &str, message: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    hex::encode(hmac::sign(&key, message.as_bytes()).as_ref())
}

/// `base64Url(bytes)`.
pub(crate) fn base64_url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `atob` after `-`/`_` became `+`/`/`: padding optional, as `atob` takes it.
pub(crate) const LENIENT_BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// `fromBase64Url(text)`, `None` when it is not base64.
fn from_base64_url(text: &str) -> Option<Vec<u8>> {
    let standard = text.replace('-', "+").replace('_', "/");
    LENIENT_BASE64.decode(standard.trim_end_matches('=')).ok()
}

/// `safeEqual(a, b)`: constant-time comparison.
pub(crate) fn safe_equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && constant_time::verify_slices_are_equal(a.as_bytes(), b.as_bytes()).is_ok()
}

/// `signToken(secret, payload)`. `payload` serialises its keys in the order
/// the worker builds them; `JSON.stringify` and `serde_json` write the same
/// bytes for the strings and integers a token holds.
pub(crate) fn sign_token(secret: &str, payload: &impl Serialize) -> String {
    let json = serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_owned());
    let body = base64_url(json.as_bytes());
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let signature = hmac::sign(&key, body.as_bytes());
    format!("{body}.{}", base64_url(signature.as_ref()))
}

/// `verifyToken(secret, token, now)`: the payload of a token `sign_token`
/// made, `None` when it is malformed, forged or past its `exp` (ms).
pub(crate) fn verify_token(secret: &str, token: &str, now_ms: i64) -> Option<Value> {
    let mut parts = token.split('.');
    let (Some(body), Some(signature), None) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    if body.is_empty() || signature.is_empty() {
        return None;
    }
    let signature = from_base64_url(signature)?;
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    hmac::verify(&key, body.as_bytes(), &signature).ok()?;
    let bytes = from_base64_url(body)?;
    let payload: Value = serde_json::from_slice(&bytes).ok()?;
    #[allow(clippy::cast_precision_loss)]
    let now = now_ms as f64;
    match payload.get("exp").and_then(Value::as_f64) {
        Some(exp) if exp >= now => Some(payload),
        _ => None,
    }
}

/// Secure random bytes.
pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    if aws_lc_rs::rand::fill(&mut bytes).is_err() {
        tracing::error!("forms: the random source failed");
    }
    bytes
}

/// A random `u32`.
pub(crate) fn random_u32() -> u32 {
    u32::from_le_bytes(random_bytes::<4>())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[derive(Serialize)]
    struct Payload {
        org: &'static str,
        exp: i64,
    }

    /// What the worker's `signToken('session-secret', { org: 'org_1', exp: 2000 })` writes.
    #[test]
    fn tokens_round_trip_and_refuse_forgeries() {
        let token = sign_token(
            "session-secret",
            &Payload {
                org: "org_1",
                exp: 2_000,
            },
        );
        let (body, _) = token.split_once('.').expect("two parts");
        assert_eq!(body, "eyJvcmciOiJvcmdfMSIsImV4cCI6MjAwMH0");
        assert_eq!(
            verify_token("session-secret", &token, 1_000),
            Some(json!({ "org": "org_1", "exp": 2_000 }))
        );
        assert_eq!(verify_token("session-secret", &token, 3_000), None);
        assert_eq!(verify_token("other", &token, 1_000), None);
        assert_eq!(verify_token("session-secret", "abc.def", 1_000), None);
        assert_eq!(
            verify_token("session-secret", &format!("{token}.x"), 1_000),
            None
        );
    }

    #[test]
    fn hashes_match_node() {
        // createHash('sha256').update('abc').digest('hex')
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(safe_equal("abc", "abc"));
        assert!(!safe_equal("abc", "abd"));
        assert!(!safe_equal("abc", "ab"));
    }
}
