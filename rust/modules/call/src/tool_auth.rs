//! The Telnyx AI assistant's tool tokens (`lib/desk-phone-tool-auth.ts`):
//! Telnyx calls the `lookup_crm` tool as a plain HTTPS POST without its
//! Ed25519 signature, so the assistant carries a short-lived bearer token,
//! `<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`, keyed by
//! `TELNYX_API_KEY`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use sha2::Sha256;

use crate::js::Ordered;

/// A token lives a day.
const TOKEN_TTL_SECONDS: i64 = 24 * 60 * 60;

/// `DeskPhoneToolClaims`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Claims {
    /// The workspace's Clerk org id.
    pub(crate) org: String,
    /// The voice agent.
    pub(crate) aid: String,
    pub(crate) call: Option<String>,
    pub(crate) conv: Option<String>,
}

fn mac(secret: &str) -> Hmac<Sha256> {
    <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes())
        .unwrap_or_else(|_| unreachable!("HMAC accepts any key length"))
}

/// `signDeskPhoneToolToken(secret, claims, nowSeconds)`.
pub(crate) fn sign(secret: &str, claims: &Claims, now_seconds: i64) -> String {
    let mut payload = Ordered::new()
        .with("v", 1)
        .with("org", claims.org.as_str())
        .with("aid", claims.aid.as_str())
        .with("exp", now_seconds + TOKEN_TTL_SECONDS);
    if let Some(call) = claims.call.as_deref().filter(|c| !c.is_empty()) {
        payload = payload.with("call", call);
    }
    if let Some(conv) = claims.conv.as_deref().filter(|c| !c.is_empty()) {
        payload = payload.with("conv", conv);
    }
    let body = URL_SAFE_NO_PAD.encode(payload.stringify());
    let mut signer = mac(secret);
    signer.update(body.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(signer.finalize().into_bytes());
    format!("{body}.{signature}")
}

/// `base64UrlDecode(input)`: `-`/`_` mapped back, padded, then `atob`.
fn decode(input: &str) -> Option<Vec<u8>> {
    let standard = input.replace('-', "+").replace('_', "/");
    crate::js::atob(&standard)
}

/// `verifyDeskPhoneToolToken(secret, token, nowSeconds)`: the claims of a
/// token this deployment signed and that has not expired.
pub(crate) fn verify(secret: &str, token: &str, now_seconds: i64) -> Option<Claims> {
    let parts: Vec<&str> = token.split('.').collect();
    let [body, signature] = parts.as_slice() else {
        return None;
    };
    if body.is_empty() || signature.is_empty() {
        return None;
    }
    let given = decode(signature)?;
    let mut checker = mac(secret);
    checker.update(body.as_bytes());
    checker.verify_slice(&given).ok()?;
    let bytes = decode(body)?;
    let parsed: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    if parsed["v"] != 1 {
        return None;
    }
    let org = parsed["org"].as_str()?.to_owned();
    let aid = parsed["aid"].as_str()?.to_owned();
    let exp = parsed["exp"].as_f64()?;
    #[allow(clippy::cast_precision_loss)]
    if exp < now_seconds as f64 {
        return None;
    }
    let text = |key: &str| match &parsed[key] {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    };
    Some(Claims {
        org,
        aid,
        call: text("call"),
        conv: text("conv"),
    })
}

/// `bearerTokenFromHeader(header)`: `/^Bearer\s+(\S+)/i` of the trimmed value.
pub(crate) fn bearer_token(header: Option<&str>) -> Option<String> {
    let trimmed = weldsuite_kit::validation::js_trim(header?);
    let prefix = trimmed.get(..6)?;
    if !prefix.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let rest = &trimmed[6..];
    let after = rest.trim_start_matches(|c: char| c.is_whitespace());
    if after.len() == rest.len() {
        return None;
    }
    let token: String = after.chars().take_while(|c| !c.is_whitespace()).collect();
    (!token.is_empty()).then_some(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_round_trip_and_expire() {
        let claims = Claims {
            org: "org_1".to_owned(),
            aid: "dva_1".to_owned(),
            call: Some("vcall_1".to_owned()),
            conv: None,
        };
        let token = sign("telnyx-key", &claims, 1_800_000_000);
        // The TypeScript signer's output for the same claims and time.
        assert_eq!(
            token.split('.').next(),
            Some(
                "eyJ2IjoxLCJvcmciOiJvcmdfMSIsImFpZCI6ImR2YV8xIiwiZXhwIjoxODAwMDg2NDAwLCJjYWxsIjoidmNhbGxfMSJ9"
            )
        );
        assert_eq!(verify("telnyx-key", &token, 1_800_000_000), Some(claims));
        assert_eq!(verify("other-key", &token, 1_800_000_000), None);
        assert_eq!(verify("telnyx-key", &token, 1_800_086_401), None);
        assert_eq!(verify("telnyx-key", "nope", 1_800_000_000), None);
        assert_eq!(
            bearer_token(Some("  bearer abc def")),
            Some("abc".to_owned())
        );
        assert_eq!(bearer_token(Some("Bearerabc")), None);
        assert_eq!(bearer_token(None), None);
    }
}
