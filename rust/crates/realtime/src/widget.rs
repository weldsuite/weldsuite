//! `verifyWidgetToken` (`apps/workers/realtime-worker/src/lib/auth.ts`): the
//! HS256 token the helpdesk widget API mints for a visitor's conversation
//! room (`POST /api/realtime/token`), signed with `WIDGET_TOKEN_SECRET`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use sha2::Sha256;

/// A widget visitor, as the token names them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Visitor {
    /// `customerId || sub`.
    pub(crate) user_id: String,
    /// `customerName || 'Customer'`.
    pub(crate) user_name: String,
    /// The one conversation the token opens.
    pub(crate) conversation_id: Option<String>,
}

/// base64url, padded or not (`base64UrlToBuffer`).
fn decode(part: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok()
}

/// A non-empty string claim.
fn claim(payload: &Value, key: &str) -> Option<String> {
    payload[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// Verify `token` with `secret` at `now` (Unix seconds): the visitor, or the
/// realtime-worker's reason for refusing it.
pub(crate) fn verify(secret: Option<&str>, token: &str, now: i64) -> Result<Visitor, &'static str> {
    let parts: Vec<&str> = token.split('.').collect();
    let [header, payload, signature] = parts[..] else {
        return Err("Invalid token format");
    };
    let invalid = "Widget token signature verification failed";
    let secret = secret.filter(|secret| !secret.is_empty()).ok_or(invalid)?;
    let signature = decode(signature).ok_or(invalid)?;
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).map_err(|_| invalid)?;
    mac.update(format!("{header}.{payload}").as_bytes());
    mac.verify_slice(&signature).map_err(|_| invalid)?;
    // Decoded only after the signature holds.
    let payload: Value = decode(payload)
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or("Invalid token format")?;
    // `payload.exp && payload.exp < now`.
    #[allow(clippy::cast_precision_loss)] // seconds since 1970 fit an f64 exactly
    let now = now as f64;
    if let Some(exp) = payload["exp"].as_f64()
        && exp != 0.0
        && exp < now
    {
        return Err("Widget token expired");
    }
    Ok(Visitor {
        user_id: claim(&payload, "customerId")
            .or_else(|| claim(&payload, "sub"))
            .unwrap_or_else(|| "undefined".to_owned()),
        user_name: claim(&payload, "customerName").unwrap_or_else(|| "Customer".to_owned()),
        conversation_id: claim(&payload, "conversationId"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(secret: &str, payload: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let body = URL_SAFE_NO_PAD.encode(payload);
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).expect("key");
        mac.update(format!("{header}.{body}").as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{header}.{body}.{signature}")
    }

    #[test]
    fn a_signed_token_names_its_visitor_and_conversation() {
        let token = sign(
            "s3cret",
            r#"{"sub":"v1","customerId":"v1","customerName":"Ann","conversationId":"dconv_1","exp":200}"#,
        );
        assert_eq!(
            verify(Some("s3cret"), &token, 100),
            Ok(Visitor {
                user_id: "v1".to_owned(),
                user_name: "Ann".to_owned(),
                conversation_id: Some("dconv_1".to_owned()),
            })
        );
    }

    #[test]
    fn refusals_carry_the_workers_reasons() {
        let token = sign("s3cret", r#"{"sub":"v1","exp":50}"#);
        assert_eq!(
            verify(Some("s3cret"), &token, 100),
            Err("Widget token expired")
        );
        assert_eq!(
            verify(Some("other"), &token, 10),
            Err("Widget token signature verification failed")
        );
        assert_eq!(
            verify(None, &token, 10),
            Err("Widget token signature verification failed")
        );
        assert_eq!(
            verify(Some("s3cret"), "a.b", 10),
            Err("Invalid token format")
        );
        let fallback = verify(Some("s3cret"), &sign("s3cret", r#"{"sub":"v2"}"#), 10).expect("ok");
        assert_eq!(fallback.user_id, "v2");
        assert_eq!(fallback.user_name, "Customer");
        assert_eq!(fallback.conversation_id, None);
    }
}
