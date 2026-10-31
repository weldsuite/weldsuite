//! Sealing and opening `workspaces.database_url`
//! (`packages/core/db/src/lib/crypto.ts`).
//!
//! AES-256-GCM, hex-encoded, in three formats:
//!
//! - v1 `iv:ciphertext` with the legacy key (`DATABASE_ENCRYPTION_KEY`);
//! - v2 `v2:iv:ciphertext` with `DATABASE_ENCRYPTION_KEY_V2`;
//! - v3 `v3:iv:ciphertext` with the v2 key and the additional data
//!   `workspaces:<id>:database_url`, so a value copied onto another
//!   workspace's row fails instead of routing that tenant to the wrong
//!   database.
//!
//! Requests only open these. Writing is for workspace provisioning (the
//! `DatabaseProvisioner` adapter), which seals exactly what
//! `encryptWorkspaceDatabaseUrl` does: v3 when AAD writes are on
//! (`FIELD_ENCRYPTION_AAD_WRITES`) and a v2 key exists, else v2 with a v2 key,
//! else v1. The ciphertext is the WebCrypto layout (a random 96-bit IV, then
//! the ciphertext with the 128-bit tag appended), in lowercase hex.

use std::fmt;

use aws_lc_rs::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use aws_lc_rs::rand::{SecureRandom, SystemRandom};

/// `DATABASE_ENCRYPTION_KEY` (v1) and `DATABASE_ENCRYPTION_KEY_V2`, 64 hex
/// characters each.
#[derive(Clone, Default)]
pub struct Keyring {
    pub v1: Option<String>,
    pub v2: Option<String>,
}

impl fmt::Debug for Keyring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Keyring")
            .field("v1", &self.v1.as_ref().map(|_| "<set>"))
            .field("v2", &self.v2.as_ref().map(|_| "<set>"))
            .finish()
    }
}

impl Keyring {
    pub fn is_empty(&self) -> bool {
        self.v1.is_none() && self.v2.is_none()
    }
}

/// Why a stored value could not be opened. Never contains the value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecryptError {
    /// Not one of the three formats.
    UnknownFormat,
    /// The keyring lacks the key the format needs.
    MissingKey(&'static str),
    /// A key that is not 32 bytes of hex.
    BadKey,
    /// Wrong key, tampered value, or (v3) sealed for another workspace.
    AuthenticationFailed,
}

impl fmt::Display for DecryptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownFormat => f.write_str("value is not in a recognized encrypted format"),
            Self::MissingKey(version) => write!(f, "value is {version} but the keyring has no key for it"),
            Self::BadKey => f.write_str("encryption key is not 64 hex characters"),
            Self::AuthenticationFailed => f.write_str(
                "authentication failed (value sealed for another workspace, tampered with, or wrong key)",
            ),
        }
    }
}

impl std::error::Error for DecryptError {}

/// The additional data a v3 `database_url` is bound to.
pub fn workspace_database_url_aad(workspace_id: &str) -> String {
    format!("workspaces:{workspace_id}:database_url")
}

/// `iv:ciphertext`, both non-empty hex.
fn split_hex_pair(value: &str) -> Option<(&str, &str)> {
    let (iv, ciphertext) = value.split_once(':')?;
    let is_hex = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit());
    (is_hex(iv) && is_hex(ciphertext)).then_some((iv, ciphertext))
}

fn open(pair: (&str, &str), hex_key: &str, aad: &[u8]) -> Result<String, DecryptError> {
    let key_bytes = hex::decode(hex_key).map_err(|_| DecryptError::BadKey)?;
    let key = UnboundKey::new(&AES_256_GCM, &key_bytes).map_err(|_| DecryptError::BadKey)?;
    let key = LessSafeKey::new(key);
    let iv = hex::decode(pair.0).map_err(|_| DecryptError::UnknownFormat)?;
    let nonce =
        Nonce::try_assume_unique_for_key(&iv).map_err(|_| DecryptError::AuthenticationFailed)?;
    let mut in_out = hex::decode(pair.1).map_err(|_| DecryptError::UnknownFormat)?;
    let plaintext = key
        .open_in_place(nonce, Aad::from(aad), &mut in_out)
        .map_err(|_| DecryptError::AuthenticationFailed)?;
    String::from_utf8(plaintext.to_vec()).map_err(|_| DecryptError::AuthenticationFailed)
}

/// Open a stored `workspaces.database_url` of the row whose id is
/// `workspace_id` (`decryptWorkspaceDatabaseUrl`).
pub fn decrypt_workspace_database_url(
    value: &str,
    workspace_id: &str,
    keyring: &Keyring,
) -> Result<String, DecryptError> {
    if let Some(rest) = value.strip_prefix("v3:") {
        let pair = split_hex_pair(rest).ok_or(DecryptError::UnknownFormat)?;
        let key = keyring
            .v2
            .as_deref()
            .ok_or(DecryptError::MissingKey("v3"))?;
        if workspace_id.is_empty() {
            return Err(DecryptError::AuthenticationFailed);
        }
        return open(
            pair,
            key,
            workspace_database_url_aad(workspace_id).as_bytes(),
        );
    }
    if let Some(rest) = value.strip_prefix("v2:") {
        let pair = split_hex_pair(rest).ok_or(DecryptError::UnknownFormat)?;
        let key = keyring
            .v2
            .as_deref()
            .ok_or(DecryptError::MissingKey("v2"))?;
        return open(pair, key, &[]);
    }
    let pair = split_hex_pair(value).ok_or(DecryptError::UnknownFormat)?;
    let key = keyring
        .v1
        .as_deref()
        .ok_or(DecryptError::MissingKey("v1"))?;
    open(pair, key, &[])
}

/// Open a field sealed by [`encrypt_field`] (`decryptField`): `v2:iv:ciphertext`
/// with the v2 key, `iv:ciphertext` with the v1 key. A v3 value is refused:
/// without its additional data it could never authenticate.
pub fn decrypt_field(value: &str, keyring: &Keyring) -> Result<String, DecryptError> {
    if value.starts_with("v3:") {
        return Err(DecryptError::UnknownFormat);
    }
    if let Some(rest) = value.strip_prefix("v2:") {
        let pair = split_hex_pair(rest).ok_or(DecryptError::UnknownFormat)?;
        let key = keyring
            .v2
            .as_deref()
            .ok_or(DecryptError::MissingKey("v2"))?;
        return open(pair, key, &[]);
    }
    let pair = split_hex_pair(value).ok_or(DecryptError::UnknownFormat)?;
    let key = keyring
        .v1
        .as_deref()
        .ok_or(DecryptError::MissingKey("v1"))?;
    open(pair, key, &[])
}

/// Why a value could not be sealed. Never contains the value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncryptError {
    /// The keyring has no key at all.
    NoKey,
    /// A key that is not 32 bytes of hex.
    BadKey,
    /// v3 needs the id of the row the value is sealed for.
    MissingWorkspaceId,
    /// The system random number generator failed.
    Random,
}

impl fmt::Display for EncryptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoKey => f.write_str("the keyring has no keys"),
            Self::BadKey => f.write_str("encryption key is not 64 hex characters"),
            Self::MissingWorkspaceId => {
                f.write_str("a workspace id is required to seal a v3 value")
            }
            Self::Random => f.write_str("the random number generator failed"),
        }
    }
}

impl std::error::Error for EncryptError {}

/// `iv:ciphertext` in lowercase hex: AES-256-GCM of `plaintext` under
/// `hex_key` and `aad`, with the given IV (`encryptRaw` with a chosen IV).
fn seal_with_iv(
    plaintext: &str,
    hex_key: &str,
    aad: &[u8],
    iv: [u8; NONCE_LEN],
) -> Result<String, EncryptError> {
    let key_bytes = hex::decode(hex_key).map_err(|_| EncryptError::BadKey)?;
    let key = UnboundKey::new(&AES_256_GCM, &key_bytes).map_err(|_| EncryptError::BadKey)?;
    let key = LessSafeKey::new(key);
    let mut in_out = plaintext.as_bytes().to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(iv),
        Aad::from(aad),
        &mut in_out,
    )
    .map_err(|_| EncryptError::BadKey)?;
    Ok(format!("{}:{}", hex::encode(iv), hex::encode(in_out)))
}

/// `encryptRaw`: a fresh random IV for every value.
fn seal(plaintext: &str, hex_key: &str, aad: &[u8]) -> Result<String, EncryptError> {
    let mut iv = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut iv)
        .map_err(|_| EncryptError::Random)?;
    seal_with_iv(plaintext, hex_key, aad, iv)
}

/// Seal a field with the newest key (`encryptField`): `v2:iv:ciphertext`
/// with a v2 key, else the legacy `iv:ciphertext` with the v1 key. Never v3.
pub fn encrypt_field(plaintext: &str, keyring: &Keyring) -> Result<String, EncryptError> {
    if let Some(key) = keyring.v2.as_deref() {
        return Ok(format!("v2:{}", seal(plaintext, key, &[])?));
    }
    if let Some(key) = keyring.v1.as_deref() {
        return seal(plaintext, key, &[]);
    }
    Err(EncryptError::NoKey)
}

/// Seal a workspace's tenant connection string
/// (`encryptWorkspaceDatabaseUrl`). With `aad_writes`
/// (`FIELD_ENCRYPTION_AAD_WRITES` on) and a v2 key: `v3:iv:ciphertext`,
/// bound to `workspace_id`. Otherwise exactly what [`encrypt_field`] writes,
/// so nothing changes until the switch is on.
pub fn encrypt_workspace_database_url(
    database_url: &str,
    workspace_id: &str,
    keyring: &Keyring,
    aad_writes: bool,
) -> Result<String, EncryptError> {
    if aad_writes && let Some(key) = keyring.v2.as_deref() {
        if workspace_id.is_empty() {
            return Err(EncryptError::MissingWorkspaceId);
        }
        let aad = workspace_database_url_aad(workspace_id);
        return Ok(format!("v3:{}", seal(database_url, key, aad.as_bytes())?));
    }
    encrypt_field(database_url, keyring)
}

/// `FIELD_ENCRYPTION_AAD_WRITES` is on for `1` and `true` (any case,
/// trimmed), off otherwise (`aadWritesEnabled`).
pub fn aad_writes_enabled(flag: Option<&str>) -> bool {
    flag.map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| value == "1" || value == "true")
}

/// The connection string of a workspace row (`resolveDatabaseUrl` without
/// the Neon API fallback, which the Kubernetes editions have no use for): a
/// plaintext `postgres://` URL as is, an encrypted one opened.
pub fn resolve_database_url(
    stored: &str,
    workspace_id: &str,
    keyring: &Keyring,
) -> Result<String, DecryptError> {
    if stored.starts_with("postgresql://") || stored.starts_with("postgres://") {
        return Ok(stored.to_owned());
    }
    decrypt_workspace_database_url(stored, workspace_id, keyring)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    /// Sealed by WebCrypto, as the TypeScript side does.
    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../tests/fixtures/database-url-ciphertexts.json"
        ))
        .expect("fixture parses")
    }

    fn keyring(v: &Value) -> Keyring {
        Keyring {
            v1: v["v1Key"].as_str().map(str::to_owned),
            v2: v["v2Key"].as_str().map(str::to_owned),
        }
    }

    #[test]
    fn opens_every_format() {
        let v = vectors();
        let keys = keyring(&v);
        let url = v["url"].as_str().expect("url");
        for format in ["v1", "v2", "v3"] {
            let sealed = v[format].as_str().expect("vector");
            assert_eq!(
                resolve_database_url(sealed, "ws_1", &keys).as_deref(),
                Ok(url),
                "{format}"
            );
        }
        assert_eq!(
            resolve_database_url(url, "ws_1", &Keyring::default()).as_deref(),
            Ok(url)
        );
    }

    #[test]
    fn v3_is_bound_to_its_workspace() {
        let v = vectors();
        let sealed = v["v3"].as_str().expect("vector");
        assert_eq!(
            decrypt_workspace_database_url(sealed, "ws_2", &keyring(&v)),
            Err(DecryptError::AuthenticationFailed)
        );
    }

    #[test]
    fn refuses_missing_keys_and_junk() {
        let v = vectors();
        let only_v1 = Keyring {
            v1: v["v1Key"].as_str().map(str::to_owned),
            v2: None,
        };
        assert_eq!(
            decrypt_workspace_database_url(v["v2"].as_str().expect("v2"), "ws_1", &only_v1),
            Err(DecryptError::MissingKey("v2"))
        );
        assert_eq!(
            decrypt_workspace_database_url("mysql://nope", "ws_1", &keyring(&v)),
            Err(DecryptError::UnknownFormat)
        );
        let wrong = Keyring {
            v1: Some("33".repeat(32)),
            v2: None,
        };
        assert_eq!(
            decrypt_workspace_database_url(v["v1"].as_str().expect("v1"), "ws_1", &wrong),
            Err(DecryptError::AuthenticationFailed)
        );
    }

    /// The IV of a stored value, as the bytes `seal_with_iv` takes.
    fn iv_of(sealed: &str) -> [u8; NONCE_LEN] {
        let pair = sealed
            .strip_prefix("v2:")
            .or_else(|| sealed.strip_prefix("v3:"))
            .unwrap_or(sealed);
        let (iv, _) = pair.split_once(':').expect("iv:ciphertext");
        hex::decode(iv)
            .expect("hex iv")
            .try_into()
            .expect("12-byte iv")
    }

    /// Re-seal each vector of `v` with its own IV: the exact string Rust
    /// writes for that IV.
    fn reseal(v: &Value, workspace_id: &str) -> [(String, String); 3] {
        let url = v["url"].as_str().expect("url");
        let v1_key = v["v1Key"].as_str().expect("v1 key");
        let v2_key = v["v2Key"].as_str().expect("v2 key");
        let aad = workspace_database_url_aad(workspace_id);
        let sealed = |format: &str| v[format].as_str().expect("vector").to_owned();
        [
            (
                sealed("v1"),
                seal_with_iv(url, v1_key, &[], iv_of(&sealed("v1"))).expect("v1"),
            ),
            (
                sealed("v2"),
                format!(
                    "v2:{}",
                    seal_with_iv(url, v2_key, &[], iv_of(&sealed("v2"))).expect("v2")
                ),
            ),
            (
                sealed("v3"),
                format!(
                    "v3:{}",
                    seal_with_iv(url, v2_key, aad.as_bytes(), iv_of(&sealed("v3"))).expect("v3")
                ),
            ),
        ]
    }

    /// Given WebCrypto's IVs, Rust writes WebCrypto's ciphertexts byte for
    /// byte, so whatever Rust seals the TypeScript workers open.
    #[test]
    fn seals_exactly_what_webcrypto_seals() {
        for (typescript, rust) in reseal(&vectors(), "ws_1") {
            assert_eq!(rust, typescript);
        }
    }

    /// Values sealed by Rust, which `crypto.test.ts` opens with the
    /// TypeScript code ("opens values the Rust backend sealed").
    #[test]
    fn the_rust_sealed_fixture_is_what_rust_writes() {
        let v: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/database-url-rust-sealed.json"
        ))
        .expect("fixture parses");
        let workspace_id = v["workspaceId"].as_str().expect("workspace id");
        for (fixture, rust) in reseal(&v, workspace_id) {
            assert_eq!(fixture, rust);
            assert_eq!(
                decrypt_workspace_database_url(&fixture, workspace_id, &keyring(&v)).as_deref(),
                Ok(v["url"].as_str().expect("url"))
            );
        }
    }

    #[test]
    fn seals_what_encrypt_workspace_database_url_seals() {
        let v = vectors();
        let keys = keyring(&v);
        let url = v["url"].as_str().expect("url");

        // The switch on with a v2 key: v3, bound to the workspace.
        let v3 = encrypt_workspace_database_url(url, "ws_a", &keys, true).expect("v3");
        assert!(v3.starts_with("v3:"), "{v3}");
        assert!(!v3.contains("postgres"));
        assert_eq!(
            decrypt_workspace_database_url(&v3, "ws_a", &keys).as_deref(),
            Ok(url)
        );
        assert_eq!(
            decrypt_workspace_database_url(&v3, "ws_b", &keys),
            Err(DecryptError::AuthenticationFailed)
        );
        // A fresh IV every time.
        assert_ne!(
            v3,
            encrypt_workspace_database_url(url, "ws_a", &keys, true).expect("v3")
        );

        // The switch off: v2, which opens for any row.
        let v2 = encrypt_workspace_database_url(url, "ws_a", &keys, false).expect("v2");
        assert!(v2.starts_with("v2:"), "{v2}");
        assert_eq!(
            decrypt_workspace_database_url(&v2, "ws_b", &keys).as_deref(),
            Ok(url)
        );

        // The switch on without a v2 key: what encryptField writes (v1).
        let only_v1 = Keyring {
            v1: keys.v1.clone(),
            v2: None,
        };
        let v1 = encrypt_workspace_database_url(url, "ws_a", &only_v1, true).expect("v1");
        assert!(split_hex_pair(&v1).is_some(), "{v1}");
        assert_eq!(
            decrypt_workspace_database_url(&v1, "ws_a", &only_v1).as_deref(),
            Ok(url)
        );

        assert_eq!(
            encrypt_workspace_database_url(url, "ws_a", &Keyring::default(), true),
            Err(EncryptError::NoKey)
        );
        assert_eq!(
            encrypt_workspace_database_url(url, "", &keys, true),
            Err(EncryptError::MissingWorkspaceId)
        );
        let bad = Keyring {
            v1: None,
            v2: Some("zz".to_owned()),
        };
        assert_eq!(encrypt_field(url, &bad), Err(EncryptError::BadKey));
    }

    #[test]
    fn aad_writes_follow_the_typescript_switch() {
        for on in ["1", "true", "TRUE", " 1 ", " True "] {
            assert!(aad_writes_enabled(Some(on)), "{on:?}");
        }
        for off in [
            None,
            Some(""),
            Some("0"),
            Some("false"),
            Some("yes"),
            Some("on"),
            Some("2"),
        ] {
            assert!(!aad_writes_enabled(off), "{off:?}");
        }
    }
}
