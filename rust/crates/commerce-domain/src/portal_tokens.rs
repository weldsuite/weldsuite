//! `portal-tokens.ts`: the B2B commerce portal's magic-link / OTP challenges
//! and buyer sessions in the workspace cache (`WORKSPACE_CACHE`). Tokens are
//! stored hashed (SHA-256 hex); only the buyer ever sees the plaintext.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use weldsuite_ports::{DynCache, PortError};

pub const OTP_TTL_SECONDS: u64 = 15 * 60;
pub const SESSION_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
/// Wrong guesses a challenge survives before it is invalidated.
pub const MAX_VERIFY_ATTEMPTS: u32 = 8;
/// Failed verify calls per 15 minutes per buyer email (OTP path).
pub const VERIFY_RATE_LIMIT_EMAIL_MAX: u32 = 20;
/// Failed verify calls per 15 minutes per workspace.
pub const VERIFY_RATE_LIMIT_WORKSPACE_MAX: u32 = 200;

/// A sign-in challenge, keyed by workspace and email. Fields in the order
/// `JSON.stringify` writes them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalChallenge {
    pub token_hash: String,
    pub otp_hash: String,
    pub email: String,
    pub workspace_id: String,
    #[serde(default)]
    pub access_ids: Vec<String>,
    #[serde(default)]
    pub attempts: u32,
}

/// A buyer session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalSession {
    pub workspace_id: String,
    pub person_id: String,
    pub company_id: String,
    pub party_id: String,
    pub access_id: String,
    pub email: String,
}

/// The company picker of an email with access to several companies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalPicker {
    pub workspace_id: String,
    pub email: String,
    #[serde(default)]
    pub access_ids: Vec<String>,
}

/// The reverse index of a magic-link token (`cportal:tok:<hash>`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenIndex {
    pub email: String,
}

/// `commercePortalOrigin(env)`: `COMMERCE_PORTAL_URL` without a trailing
/// slash, else the default per `ENVIRONMENT`.
pub fn commerce_portal_origin(portal_url: Option<&str>, environment: Option<&str>) -> String {
    if let Some(url) = portal_url.filter(|u| !u.is_empty()) {
        return url.strip_suffix('/').unwrap_or(url).to_owned();
    }
    match environment {
        Some("production") => "https://orders.weldsuite.org".to_owned(),
        Some("test") => "https://orders-test.weldsuite.org".to_owned(),
        _ => "http://localhost:3021".to_owned(),
    }
}

/// `email.trim().toLowerCase()`.
pub fn normalize_email(email: &str) -> String {
    weldsuite_kit::validation::js_trim(email).to_lowercase()
}

pub fn otp_kv_key(workspace_id: &str, email: &str) -> String {
    format!("cportal:otp:{workspace_id}:{}", normalize_email(email))
}

pub fn session_kv_key(token_hash: &str) -> String {
    format!("cportal:sess:{token_hash}")
}

pub fn picker_kv_key(token_hash: &str) -> String {
    format!("cportal:pick:{token_hash}")
}

pub fn token_kv_key(token_hash: &str) -> String {
    format!("cportal:tok:{token_hash}")
}

/// `sha256Hex(value)`.
pub fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// `randomToken(bytes)`: random bytes as lowercase hex.
///
/// # Panics
///
/// When the operating system has no random source.
pub fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("the operating system has a random source");
    hex::encode(buffer)
}

const OTP_MODULUS: u64 = 1_000_000;
const UINT32_VALUES: u64 = 0x1_0000_0000;
/// Draws at or above this are discarded, so all 10^6 codes are equally likely.
pub const OTP_REJECTION_LIMIT: u64 = UINT32_VALUES - (UINT32_VALUES % OTP_MODULUS);

/// `randomOtp()`: a uniformly random 6-digit code, by rejection sampling.
///
/// # Panics
///
/// When the operating system has no random source, or it never produces a
/// usable value in 32 draws.
pub fn random_otp() -> String {
    for _ in 0..32 {
        let mut draw = [0u8; 4];
        getrandom::fill(&mut draw).expect("the operating system has a random source");
        let value = u64::from(u32::from_le_bytes(draw));
        if value < OTP_REJECTION_LIMIT {
            return format!("{:06}", value % OTP_MODULUS);
        }
    }
    panic!("Random source did not produce a usable value");
}

/// The workspace cache the portal reads and writes; `None` is the worker
/// without `WORKSPACE_CACHE` (reads miss, writes are skipped).
pub type PortalKv = Option<Arc<dyn DynCache>>;

/// `kvGetJson(env, key)`: the value parsed; a value that is not JSON fails
/// as `JSON.parse` does.
pub async fn kv_get_json<T: serde::de::DeserializeOwned>(
    kv: &PortalKv,
    key: &str,
) -> Result<Option<T>, PortError> {
    let Some(kv) = kv else {
        return Ok(None);
    };
    match kv.get_boxed(key).await? {
        Some(text) => Ok(Some(serde_json::from_str(&text)?)),
        None => Ok(None),
    }
}

/// `kvPutJson(env, key, value, ttl)`.
pub async fn kv_put_json<T: Serialize + Sync>(
    kv: &PortalKv,
    key: &str,
    value: &T,
    ttl_seconds: u64,
) -> Result<(), PortError> {
    let Some(kv) = kv else {
        return Ok(());
    };
    let text = serde_json::to_string(value)?;
    kv.put_boxed(key, &text, Some(Duration::from_secs(ttl_seconds)))
        .await
}

/// `kvDelete(env, key)`.
pub async fn kv_delete(kv: &PortalKv, key: &str) -> Result<(), PortError> {
    let Some(kv) = kv else {
        return Ok(());
    };
    kv.delete_boxed(key).await
}

/// `storeChallenge(env, challenge, email)`: the challenge under workspace +
/// email, and the magic-link token's reverse index.
pub async fn store_challenge(
    kv: &PortalKv,
    challenge: &PortalChallenge,
    email: &str,
) -> Result<(), PortError> {
    let normalized = normalize_email(email);
    kv_put_json(
        kv,
        &otp_kv_key(&challenge.workspace_id, &normalized),
        challenge,
        OTP_TTL_SECONDS,
    )
    .await?;
    kv_put_json(
        kv,
        &token_kv_key(&challenge.token_hash),
        &TokenIndex { email: normalized },
        OTP_TTL_SECONDS,
    )
    .await
}

/// `deleteChallenge(env, challenge)`.
pub async fn delete_challenge(kv: &PortalKv, challenge: &PortalChallenge) -> Result<(), PortError> {
    kv_delete(kv, &otp_kv_key(&challenge.workspace_id, &challenge.email)).await?;
    kv_delete(kv, &token_kv_key(&challenge.token_hash)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_ports::MemoryCache;

    #[test]
    fn hashes_keys_and_origins() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(otp_kv_key("ws_1", " A@B.c "), "cportal:otp:ws_1:a@b.c");
        assert_eq!(random_token(32).len(), 64);
        let otp = random_otp();
        assert_eq!(otp.len(), 6);
        assert!(otp.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(
            commerce_portal_origin(Some("https://x.test/"), Some("production")),
            "https://x.test"
        );
        assert_eq!(
            commerce_portal_origin(None, Some("production")),
            "https://orders.weldsuite.org"
        );
        assert_eq!(
            commerce_portal_origin(Some(""), Some("test")),
            "https://orders-test.weldsuite.org"
        );
        assert_eq!(commerce_portal_origin(None, None), "http://localhost:3021");
    }

    #[tokio::test]
    async fn stores_and_deletes_a_challenge() {
        let cache: Arc<dyn DynCache> = Arc::new(MemoryCache::new());
        let kv: PortalKv = Some(cache);
        let challenge = PortalChallenge {
            token_hash: "t".into(),
            otp_hash: "o".into(),
            email: "a@b.c".into(),
            workspace_id: "ws".into(),
            access_ids: vec!["cpa_1".into()],
            attempts: 0,
        };
        store_challenge(&kv, &challenge, "A@B.c").await.expect("ok");
        let stored: Option<PortalChallenge> =
            kv_get_json(&kv, "cportal:otp:ws:a@b.c").await.expect("ok");
        assert_eq!(stored, Some(challenge.clone()));
        let text = kv
            .as_ref()
            .expect("ok")
            .get_boxed("cportal:otp:ws:a@b.c")
            .await
            .expect("ok")
            .expect("ok");
        assert_eq!(
            text,
            r#"{"tokenHash":"t","otpHash":"o","email":"a@b.c","workspaceId":"ws","accessIds":["cpa_1"],"attempts":0}"#
        );
        delete_challenge(&kv, &challenge).await.expect("ok");
        let gone: Option<PortalChallenge> =
            kv_get_json(&kv, "cportal:otp:ws:a@b.c").await.expect("ok");
        assert!(gone.is_none());
        let index: Option<TokenIndex> = kv_get_json(&kv, "cportal:tok:t").await.expect("ok");
        assert!(index.is_none());
    }
}
