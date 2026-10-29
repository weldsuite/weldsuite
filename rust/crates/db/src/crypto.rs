//! Opening `workspaces.database_url` (`packages/core/db/src/lib/crypto.ts`).
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
//! The backend only reads these; writing stays with workspace provisioning.

use std::fmt;

use aws_lc_rs::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};

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
}
