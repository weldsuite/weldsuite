//! `portal-tokens.ts`: the building blocks of a portal's passwordless sign-in.
//! Tokens are stored hashed (SHA-256 hex); only the visitor ever sees the
//! plaintext. Codes and sessions live in the workspace cache
//! (`WORKSPACE_CACHE`) as JSON.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use weldsuite_ports::{DynCache, PortError};

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

/// The workspace cache a portal reads and writes; `None` is the worker
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

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_ports::MemoryCache;

    #[test]
    fn hashes_and_random_values() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(random_token(32).len(), 64);
        let otp = random_otp();
        assert_eq!(otp.len(), 6);
        assert!(otp.bytes().all(|b| b.is_ascii_digit()));
    }

    #[tokio::test]
    async fn stores_reads_and_deletes_json() {
        let cache: Arc<dyn DynCache> = Arc::new(MemoryCache::new());
        let kv: PortalKv = Some(cache);
        kv_put_json(&kv, "k", &serde_json::json!({ "a": 1 }), 60)
            .await
            .expect("put");
        let stored: Option<serde_json::Value> = kv_get_json(&kv, "k").await.expect("get");
        assert_eq!(stored, Some(serde_json::json!({ "a": 1 })));
        kv_delete(&kv, "k").await.expect("delete");
        let gone: Option<serde_json::Value> = kv_get_json(&kv, "k").await.expect("get");
        assert!(gone.is_none());
        // Without a cache: reads miss, writes are skipped.
        let none: PortalKv = None;
        kv_put_json(&none, "k", &1, 60).await.expect("skipped");
        let missing: Option<i32> = kv_get_json(&none, "k").await.expect("miss");
        assert!(missing.is_none());
    }
}
