//! The signed `state` of the GitHub App install redirect
//! (`@weldsuite/connect-domain/github/install-state`): an HS256 JWT, valid
//! ten minutes. WeldConnect's install flow and WeldMerge's both sign and
//! verify it here, so either callback accepts a state the other issued.
//!
//! The secret is the worker's `CLERK_SECRET_KEY`, else `INTERNAL_API_SECRET`
//! on a deployment without Clerk ([`state_secret`]). `workspaceId` is
//! whatever ref the issuer holds (`ws_…` or the Clerk org id). A state is
//! single use: its nonce is kept in KV when it is issued
//! ([`remember_install_nonce`]) and taken when it is redeemed
//! ([`consume_install_nonce`]).

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;

/// How long a state is valid (`signInstallStateJwt`'s default).
pub const INSTALL_STATE_TTL_SECONDS: i64 = 600;

/// The key a state is signed with: `CLERK_SECRET_KEY`, as on Global (so
/// either backend opens the other's state), else `INTERNAL_API_SECRET`.
pub fn state_secret(clerk_secret_key: Option<&str>, internal_api_secret: Option<&str>) -> String {
    clerk_secret_key
        .filter(|key| !key.is_empty())
        .or_else(|| internal_api_secret.filter(|key| !key.is_empty()))
        .unwrap_or_default()
        .to_owned()
}

fn unix_now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

fn hmac(secret: &str, input: &str) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes())
        .expect("HMAC takes a key of any length");
    mac.update(input.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// `signInstallStateJwt(payload, secret)`: the claims (`workspaceId`,
/// `userId`, `returnTo?`, `projectId?`, `nonce`) plus `iat` and `exp` (ten
/// minutes), in that order.
pub fn sign_install_state(claims: &Map<String, Value>, secret: &str) -> String {
    let now = unix_now();
    let mut claims = claims.clone();
    claims.insert("iat".into(), json!(now));
    claims.insert("exp".into(), json!(now + INSTALL_STATE_TTL_SECONDS));
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(Value::Object(claims).to_string());
    let input = format!("{header}.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(hmac(secret, &input));
    format!("{input}.{signature}")
}

/// base64url as `atob` reads it after padding: padding optional.
fn base64url(input: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(input.trim_end_matches('=')).ok()
}

/// `verifyInstallStateJwt(token, secret)`: the claims of a state this key
/// signed that has not expired; `None` for anything else.
pub fn verify_install_state(token: &str, secret: &str) -> Option<Map<String, Value>> {
    if secret.is_empty() {
        return None;
    }
    let parts: Vec<&str> = token.split('.').collect();
    let [header, payload, signature] = parts.as_slice() else {
        return None;
    };
    let signature = base64url(signature)?;
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(format!("{header}.{payload}").as_bytes());
    mac.verify_slice(&signature).ok()?;
    let claims: Value = serde_json::from_slice(&base64url(payload)?).ok()?;
    let claims = claims.as_object()?.clone();
    // `claims.exp < now`: a missing or non-numeric `exp` never compares less.
    #[allow(clippy::cast_precision_loss)]
    let now = unix_now() as f64;
    if claims
        .get("exp")
        .and_then(Value::as_f64)
        .is_some_and(|exp| exp < now)
    {
        return None;
    }
    Some(claims)
}

/// `installStateNonce()`: 32 random hex characters.
pub fn install_state_nonce() -> String {
    weldsuite_kit::random_string(32, "0123456789abcdef")
}

/// `installNonceKey(nonce)`: the KV key of an issued state's nonce.
pub fn install_nonce_key(nonce: &str) -> String {
    format!("merge_install_nonce:{nonce}")
}

/// `rememberInstallNonce(kv, nonce, workspaceId)`: keeps the nonce of a
/// state just issued for the state's lifetime. Both install routes share
/// `WORKSPACE_CACHE`, so either setup redirect consumes the other's.
///
/// # Errors
///
/// The cache fails.
pub async fn remember_install_nonce(
    cache: &dyn weldsuite_ports::DynCache,
    nonce: &str,
    workspace_id: &str,
) -> Result<(), weldsuite_ports::PortError> {
    let ttl = std::time::Duration::from_secs(INSTALL_STATE_TTL_SECONDS.unsigned_abs());
    cache
        .put_boxed(&install_nonce_key(nonce), workspace_id, Some(ttl))
        .await
}

/// `consumeInstallNonce(kv, nonce)`: takes the nonce of a state being
/// redeemed; `false` when it was never issued, already used or expired
/// (`error=state_expired`). A state is good for one setup redirect.
///
/// # Errors
///
/// The cache fails.
pub async fn consume_install_nonce(
    cache: &dyn weldsuite_ports::DynCache,
    nonce: Option<&str>,
) -> Result<bool, weldsuite_ports::PortError> {
    let Some(nonce) = nonce.filter(|n| !n.is_empty()) else {
        return Ok(false);
    };
    let key = install_nonce_key(nonce);
    if cache.get_boxed(&key).await?.is_none() {
        return Ok(false);
    }
    cache.delete_boxed(&key).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_state_verifies_with_its_key_only() {
        let mut claims = Map::new();
        claims.insert("workspaceId".into(), json!("ws_alpha"));
        claims.insert("userId".into(), json!("user_a"));
        claims.insert("nonce".into(), json!(install_state_nonce()));
        let token = sign_install_state(&claims, "secret");
        let verified = verify_install_state(&token, "secret").expect("verifies");
        assert_eq!(verified["workspaceId"], "ws_alpha");
        assert!(verified["exp"].as_i64() > verified["iat"].as_i64());
        assert!(verify_install_state(&token, "other").is_none());
        assert!(verify_install_state("not.a.jwt", "secret").is_none());
        assert!(verify_install_state(&token, "").is_none());
    }

    #[test]
    fn the_secret_falls_back_to_the_internal_one() {
        assert_eq!(state_secret(Some("sk"), Some("int")), "sk");
        assert_eq!(state_secret(Some(""), Some("int")), "int");
        assert_eq!(state_secret(None, None), "");
    }
}
