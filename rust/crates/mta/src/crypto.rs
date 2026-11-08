//! The MTA's secrets, all from one key (`MTA_KEY`, 32 bytes):
//!
//! - DKIM private keys are sealed with AES-256-GCM under a key HKDF-derived
//!   for that purpose, bound (AAD) to the domain they sign for, so a row
//!   copied to another domain fails to open.
//! - VERP tags (the return path's `b+<id>-<tag>`) are a truncated
//!   HMAC-SHA256 under a second derived key.
//!
//! Ids are random, lowercase base32 (`[a-z2-7]`): safe in an address's
//! local part, a header and a URL.

use aws_lc_rs::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use aws_lc_rs::{hkdf, hmac, rand};
use base64::Engine as _;

/// Why a sealed value could not be opened, or the key is unusable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CryptoError(pub &'static str);

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for CryptoError {}

/// The keys derived from `MTA_KEY`.
#[derive(Clone)]
pub struct Keys {
    seal: [u8; 32],
    verp: hmac::Key,
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Keys(…)")
    }
}

struct Len(usize);

impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn derive(master: &[u8], info: &[u8]) -> Result<[u8; 32], CryptoError> {
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, b"weldsuite-mta");
    let prk = salt.extract(master);
    let info = [info];
    let okm = prk
        .expand(&info, Len(32))
        .map_err(|_| CryptoError("cannot derive a key"))?;
    let mut out = [0u8; 32];
    okm.fill(&mut out)
        .map_err(|_| CryptoError("cannot derive a key"))?;
    Ok(out)
}

impl Keys {
    /// From `MTA_KEY`: base64 (standard or URL-safe) of exactly 32 bytes.
    pub fn from_base64(value: &str) -> Result<Self, CryptoError> {
        let value = value.trim();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(value)
            .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value))
            .map_err(|_| CryptoError("MTA_KEY is not base64"))?;
        if bytes.len() != 32 {
            return Err(CryptoError("MTA_KEY must be 32 bytes"));
        }
        Self::from_bytes(&bytes)
    }

    pub fn from_bytes(master: &[u8]) -> Result<Self, CryptoError> {
        let seal = derive(master, b"dkim-seal")?;
        let verp = derive(master, b"verp-tag")?;
        Ok(Self {
            seal,
            verp: hmac::Key::new(hmac::HMAC_SHA256, &verp),
        })
    }

    /// `nonce || ciphertext || tag`, bound to `context`.
    pub fn seal(&self, context: &str, plain: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let key = LessSafeKey::new(
            UnboundKey::new(&AES_256_GCM, &self.seal).map_err(|_| CryptoError("bad seal key"))?,
        );
        let mut nonce = [0u8; NONCE_LEN];
        rand::fill(&mut nonce).map_err(|_| CryptoError("no randomness"))?;
        let mut in_out = plain.to_vec();
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(context.as_bytes()),
            &mut in_out,
        )
        .map_err(|_| CryptoError("cannot seal"))?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&in_out);
        Ok(out)
    }

    pub fn open(&self, context: &str, sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if sealed.len() < NONCE_LEN + 16 {
            return Err(CryptoError("sealed value too short"));
        }
        let key = LessSafeKey::new(
            UnboundKey::new(&AES_256_GCM, &self.seal).map_err(|_| CryptoError("bad seal key"))?,
        );
        let (nonce, body) = sealed.split_at(NONCE_LEN);
        let nonce =
            Nonce::try_assume_unique_for_key(nonce).map_err(|_| CryptoError("bad nonce"))?;
        let mut in_out = body.to_vec();
        let plain = key
            .open_in_place(nonce, Aad::from(context.as_bytes()), &mut in_out)
            .map_err(|_| CryptoError("cannot open the sealed value"))?;
        Ok(plain.to_vec())
    }

    /// The VERP tag for a recipient id: 16 lowercase hex characters.
    pub fn verp_tag(&self, id: &str) -> String {
        let tag = hmac::sign(&self.verp, id.as_bytes());
        hex_lower(&tag.as_ref()[..8])
    }

    /// Whether `tag` is `id`'s tag (constant time).
    pub fn verp_tag_matches(&self, id: &str, tag: &str) -> bool {
        let expected = self.verp_tag(id);
        expected.len() == tag.len()
            && expected
                .bytes()
                .zip(tag.bytes())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                == 0
    }
}

pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// A random id: `prefix` then 26 base32 characters (130 bits).
pub fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 17];
    // A failing system RNG leaves zeros; the id then still parses, and the
    // primary key refuses a duplicate.
    let _ = rand::fill(&mut bytes);
    let mut out = String::with_capacity(prefix.len() + 26);
    out.push_str(prefix);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 && out.len() < prefix.len() + 26 {
            bits -= 5;
            out.push(BASE32[((buffer >> bits) & 31) as usize] as char);
        }
    }
    out
}

/// Random bytes as lowercase hex (passwords, tokens in tests).
pub fn random_hex(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    let _ = rand::fill(&mut bytes);
    hex_lower(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> Keys {
        Keys::from_bytes(&[7u8; 32]).expect("keys")
    }

    #[test]
    fn seals_and_opens_bound_to_the_context() {
        let keys = keys();
        let sealed = keys.seal("acme.eu", b"secret").expect("seal");
        assert_eq!(keys.open("acme.eu", &sealed).expect("open"), b"secret");
        assert!(keys.open("other.eu", &sealed).is_err());
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(keys.open("acme.eu", &tampered).is_err());
    }

    #[test]
    fn verp_tags_are_stable_and_keyed() {
        let keys = keys();
        let tag = keys.verp_tag("rabc");
        assert_eq!(tag.len(), 16);
        assert!(keys.verp_tag_matches("rabc", &tag));
        assert!(!keys.verp_tag_matches("rabd", &tag));
        let other = Keys::from_bytes(&[8u8; 32]).expect("keys");
        assert_ne!(other.verp_tag("rabc"), tag);
    }

    #[test]
    fn reads_the_key_from_base64() {
        let encoded = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
        assert!(Keys::from_base64(&encoded).is_ok());
        assert!(Keys::from_base64("c2hvcnQ=").is_err());
        assert!(Keys::from_base64("not base64!").is_err());
    }

    #[test]
    fn ids_are_lowercase_base32() {
        let id = new_id("r");
        assert_eq!(id.len(), 27);
        assert!(id[1..].bytes().all(|b| BASE32.contains(&b)));
        assert_ne!(new_id("r"), id);
    }
}
