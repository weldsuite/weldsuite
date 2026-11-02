//! `lib/tokens.ts`: HS256 JWTs. The realtime room tokens and the visitor
//! tokens this API issues, and the identity tokens a customer's server signs
//! for the widget.

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value};
use sha2::Sha256;

/// `atob` as `fromBase64Url` uses it: forgiving about the unused bits of the
/// last character, no padding (the caller already refused `=`).
const FORGIVING: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::RequireNone)
        .with_decode_allow_trailing_bits(true),
);

/// Allowed clock skew on `exp` and `nbf`, in seconds.
const SKEW_SECONDS: f64 = 60.0;

/// `JwtFailure`: why a token was refused. The identity token's refusal names
/// it (`Identity token refused (expired)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JwtFailure {
    Malformed,
    Algorithm,
    Signature,
    Expired,
    NotYetValid,
}

impl JwtFailure {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::Algorithm => "algorithm",
            Self::Signature => "signature",
            Self::Expired => "expired",
            Self::NotYetValid => "not_yet_valid",
        }
    }
}

fn mac(secret: &str) -> Hmac<Sha256> {
    // HMAC takes keys of any length; `new_from_slice` cannot fail for it.
    <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes())
        .unwrap_or_else(|_| unreachable!("HMAC accepts any key length"))
}

/// `base64Url(bytes)`: base64url without padding.
pub(crate) fn base64_url(bytes: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `fromBase64Url(text)`: `None` for anything but `[A-Za-z0-9_-]*`, or a
/// length `atob` refuses.
fn from_base64_url(text: &str) -> Option<Vec<u8>> {
    if !text
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return None;
    }
    FORGIVING.decode(text).ok()
}

/// `signJwt(secret, claims)`: a JWT, HS256, its parts base64url without
/// padding and the claims' keys in the order given.
pub(crate) fn sign_jwt(secret: &str, claims: &[(&str, Value)]) -> String {
    let header = base64_url(r#"{"alg":"HS256","typ":"JWT"}"#);
    // `JSON.stringify` of an object literal keeps its keys in order;
    // `serde_json`'s map would sort them.
    let fields: Vec<String> = claims
        .iter()
        .map(|(key, value)| format!("{}:{value}", Value::String((*key).to_owned())))
        .collect();
    let body = base64_url(format!("{{{}}}", fields.join(",")));
    let signing_input = format!("{header}.{body}");
    let mut mac = mac(secret);
    mac.update(signing_input.as_bytes());
    format!(
        "{signing_input}.{}",
        base64_url(mac.finalize().into_bytes())
    )
}

/// `JSON.parse(new TextDecoder().decode(bytes))`: invalid UTF-8 becomes
/// U+FFFD and a leading BOM is dropped, as the decoder does.
fn parse_json(bytes: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(bytes);
    serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok()
}

/// `verifyJwt(secret, token, now)`: shape, `alg`, the signature (constant
/// time), then `exp` and `nbf` with a minute of clock skew. The claims.
pub(crate) fn verify_jwt(
    secret: &str,
    token: &str,
    now: i64,
) -> Result<Map<String, Value>, JwtFailure> {
    let parts: Vec<&str> = token.split('.').collect();
    let [raw_header, raw_body, raw_signature] = parts[..] else {
        return Err(JwtFailure::Malformed);
    };
    let (Some(header), Some(body), Some(signature)) = (
        from_base64_url(raw_header),
        from_base64_url(raw_body),
        from_base64_url(raw_signature),
    ) else {
        return Err(JwtFailure::Malformed);
    };
    let (Some(header), Some(claims)) = (parse_json(&header), parse_json(&body)) else {
        return Err(JwtFailure::Malformed);
    };
    // `!header || typeof header !== 'object' || header.alg !== 'HS256'`: an
    // array is an object without an `alg`.
    let algorithm = match &header {
        Value::Object(header) => header.get("alg").and_then(Value::as_str) == Some("HS256"),
        _ => false,
    };
    if !algorithm {
        return Err(JwtFailure::Algorithm);
    }
    let Value::Object(claims) = claims else {
        return Err(JwtFailure::Malformed);
    };
    let mut mac = mac(secret);
    mac.update(format!("{raw_header}.{raw_body}").as_bytes());
    if mac.verify_slice(&signature).is_err() {
        return Err(JwtFailure::Signature);
    }
    #[allow(clippy::cast_precision_loss)] // seconds since 1970 fit an f64 exactly
    let now = now as f64;
    if claims
        .get("exp")
        .and_then(Value::as_f64)
        .is_some_and(|exp| exp + SKEW_SECONDS < now)
    {
        return Err(JwtFailure::Expired);
    }
    if claims
        .get("nbf")
        .and_then(Value::as_f64)
        .is_some_and(|nbf| nbf - SKEW_SECONDS > now)
    {
        return Err(JwtFailure::NotYetValid);
    }
    Ok(claims)
}

/// `deriveSecret(secret, label)`: a key for one purpose, the HMAC of the
/// label under a worker secret. Visitor tokens use their own key, so the
/// realtime gateway, which trusts tokens signed with `WIDGET_TOKEN_SECRET`
/// itself, can never accept one.
pub(crate) fn derive_secret(secret: &str, label: &str) -> String {
    let mut mac = mac(secret);
    mac.update(label.as_bytes());
    base64_url(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tokens_are_hs256_jwts_with_ordered_claims() {
        let token = sign_jwt("secret", &[("sub", json!("v1")), ("exp", json!(10))]);
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let payload = URL_SAFE_NO_PAD.decode(parts[1]).expect("base64url");
        assert_eq!(
            String::from_utf8(payload).expect("utf-8"),
            r#"{"sub":"v1","exp":10}"#
        );
        let mut mac = mac("secret");
        mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
        assert!(
            mac.verify_slice(&URL_SAFE_NO_PAD.decode(parts[2]).expect("sig"))
                .is_ok()
        );
    }

    #[test]
    fn verification_names_why_it_refused() {
        let now = 1_000_000;
        let good = sign_jwt("k", &[("sub", json!("a")), ("exp", json!(now + 10))]);
        assert_eq!(verify_jwt("k", &good, now).expect("valid")["sub"], "a");
        assert_eq!(verify_jwt("other", &good, now), Err(JwtFailure::Signature));
        assert_eq!(verify_jwt("k", "a.b", now), Err(JwtFailure::Malformed));
        assert_eq!(verify_jwt("k", "a!.b.c", now), Err(JwtFailure::Malformed));
        // `atob` refuses a length of 4n + 1.
        assert_eq!(
            verify_jwt("k", "e30.e30.x", now),
            Err(JwtFailure::Malformed)
        );
        let array = format!("{}.{}.xx", base64_url("[]"), base64_url("{}"));
        assert_eq!(verify_jwt("k", &array, now), Err(JwtFailure::Algorithm));
        let list = format!(
            "{}.{}.xx",
            base64_url(r#"{"alg":"HS256"}"#),
            base64_url("[1]")
        );
        assert_eq!(verify_jwt("k", &list, now), Err(JwtFailure::Malformed));
        // A minute of skew either way.
        let late = sign_jwt("k", &[("exp", json!(now - 60))]);
        assert!(verify_jwt("k", &late, now).is_ok());
        let expired = sign_jwt("k", &[("exp", json!(now - 61))]);
        assert_eq!(verify_jwt("k", &expired, now), Err(JwtFailure::Expired));
        let early = sign_jwt("k", &[("nbf", json!(now + 61))]);
        assert_eq!(verify_jwt("k", &early, now), Err(JwtFailure::NotYetValid));
    }

    #[test]
    fn derived_keys_are_the_hmac_of_the_label() {
        // createHmac('sha256', 'secret').update('label').digest('base64url')
        assert_eq!(
            derive_secret("secret", "label"),
            "ujJqroEW2CyclYNuIwxwU5RyMBECpllNIvvlGc10uas"
        );
    }
}
