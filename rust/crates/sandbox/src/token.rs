//! Each sandbox pod's token.
//!
//! The token is `HMAC-SHA256(SANDBOX_TOKEN_SECRET, pod name)`, so every
//! replica of the server (and `consume`, and the cron jobs) can talk to every
//! pod and nothing is stored. The pod gets only the token's SHA-256
//! (`SANDBOX_TOKEN_SHA256`), so neither the pod spec nor the code running in
//! the sandbox holds a token that works anywhere.

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

/// The bearer token for the pod `pod_name`.
///
/// # Panics
///
/// Never: HMAC takes a key of any length.
pub fn pod_token(secret: &str, pod_name: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(b"weldsuite-sandbox:");
    mac.update(pod_name.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// What the pod checks a bearer token against.
pub fn token_digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// A new random secret, 32 bytes as hex: what the tests and
/// [`crate::config::SandboxConfig::for_tests`] derive tokens from, so no
/// secret is written down in the code.
///
/// # Panics
///
/// If the operating system has no random source.
pub fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    hex::encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_per_pod_and_only_its_digest_in_the_pod() {
        let secret = random_secret();
        let other = random_secret();
        assert_eq!(secret.len(), 64);
        assert_ne!(secret, other);
        let a = pod_token(&secret, "sbx-a");
        let b = pod_token(&secret, "sbx-b");
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
        assert_eq!(a, pod_token(&secret, "sbx-a"));
        assert_ne!(a, pod_token(&other, "sbx-a"));
        let digest = token_digest(&a);
        assert_eq!(digest.len(), 64);
        assert_ne!(digest, a);
    }
}
