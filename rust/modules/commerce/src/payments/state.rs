//! The signed `state` of the Mollie Connect redirect: HMAC-SHA256 over the
//! claims (workspace, user, where to return to), valid ten minutes. The
//! callback is public, so this is what says whose connection it is.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;

/// How long a state is valid.
const TTL_SECONDS: i64 = 600;

fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

fn mac(secret: &str) -> Option<Hmac<Sha256>> {
    <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).ok()
}

/// `payload.signature`, both base64url; the claims plus `exp`.
pub(crate) fn sign(secret: &str, claims: &Map<String, Value>) -> Option<String> {
    let mut claims = claims.clone();
    claims.insert("exp".to_owned(), json!(now() + TTL_SECONDS));
    let payload = URL_SAFE_NO_PAD.encode(Value::Object(claims).to_string());
    let mut mac = mac(secret)?;
    mac.update(payload.as_bytes());
    Some(format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}

/// The claims of a state this secret signed that has not expired.
pub(crate) fn verify(secret: &str, token: &str) -> Option<Map<String, Value>> {
    if secret.is_empty() {
        return None;
    }
    let (payload, signature) = token.split_once('.')?;
    let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
    let mut mac = mac(secret)?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature).ok()?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    let claims = claims.as_object()?.clone();
    (claims.get("exp").and_then(Value::as_i64)? >= now()).then_some(claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key made at run time from random bytes: the tests depend on no
    /// fixed secret.
    fn key() -> String {
        weldsuite_kit::portal::tokens::random_token(32)
    }

    fn claims() -> Map<String, Value> {
        let mut claims = Map::new();
        claims.insert("workspaceId".to_owned(), json!("ws_1"));
        claims.insert("userId".to_owned(), json!("user_1"));
        claims
    }

    #[test]
    fn a_state_round_trips_under_its_secret_only() {
        let secret = key();
        let token = sign(&secret, &claims()).expect("signed");
        let back = verify(&secret, &token).expect("verified");
        assert_eq!(back["workspaceId"], "ws_1");
        assert!(verify(&key(), &token).is_none());
        let no_key = String::new();
        assert!(verify(&no_key, &token).is_none());
    }

    #[test]
    fn a_tampered_or_expired_state_is_refused() {
        let secret = key();
        let token = sign(&secret, &claims()).expect("signed");
        let (payload, signature) = token.split_once('.').expect("two parts");
        let forged = URL_SAFE_NO_PAD.encode(r#"{"workspaceId":"ws_2","exp":99999999999}"#);
        assert!(verify(&secret, &format!("{forged}.{signature}")).is_none());
        assert!(verify(&secret, payload).is_none());
        let mut old = claims();
        old.insert("exp".to_owned(), json!(1));
        let payload = URL_SAFE_NO_PAD.encode(Value::Object(old).to_string());
        let mut mac = mac(&secret).expect("mac");
        mac.update(payload.as_bytes());
        let expired = format!(
            "{payload}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        );
        assert!(verify(&secret, &expired).is_none());
    }
}
