//! Field encryption (`packages/core/db/src/lib/crypto.ts`) as the connectors
//! read it: stored connector credentials and the sales tax engines'
//! credentials, sealed with the workspace keyring
//! (`DATABASE_ENCRYPTION_KEY`, `_V2`).
//!
//! [`maybe_decrypt`] and [`seal_if_keyed`] are the integration routes' and
//! the workflow engine's reading: integration tokens and credentials
//! (`workflow_integrations`, the CRM connections).

use weldsuite_db::{Keyring, decrypt_workspace_database_url, encrypt_field};

/// `iv:ciphertext`, both non-empty hex.
fn hex_pair(value: &str) -> bool {
    let is_hex = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit());
    matches!(value.split_once(':'), Some((a, b)) if is_hex(a) && is_hex(b))
}

fn is_v3(value: &str) -> bool {
    value.strip_prefix("v3:").is_some_and(hex_pair)
}

fn is_v2(value: &str) -> bool {
    value.strip_prefix("v2:").is_some_and(hex_pair)
}

/// `decryptField(value, keyring)`: a v1 or v2 value opened with its key;
/// anything else is an error (a v3 value needs its AAD).
pub fn decrypt_field(value: &str, keyring: &Keyring) -> Result<String, String> {
    if is_v3(value) {
        return Err(
            "decryptField: value is v3 (AAD-bound), open it with decryptWorkspaceDatabaseUrl()"
                .to_owned(),
        );
    }
    if is_v2(value) {
        if keyring.v2.is_none() {
            return Err("decryptField: value is v2 but keyring has no v2 key".to_owned());
        }
    } else if hex_pair(value) {
        if keyring.v1.is_none() {
            return Err("decryptField: value is v1 but keyring has no v1 key".to_owned());
        }
    } else {
        return Err("decryptField: value is not in a recognized encrypted format".to_owned());
    }
    decrypt_workspace_database_url(value, "", keyring).map_err(|error| error.to_string())
}

/// `maybeDecryptField(value, keyring)`: the plaintext of a sealed v1/v2
/// value the keyring opens; anything else (plain text, v3, a value the
/// keyring has no key for or can't open) as it is.
pub fn maybe_decrypt_field(value: &str, keyring: &Keyring) -> String {
    let v2 = is_v2(value);
    let v1 = hex_pair(value);
    if !(v1 || v2) || is_v3(value) {
        return value.to_owned();
    }
    if (v2 && keyring.v2.is_none()) || (v1 && keyring.v1.is_none()) {
        return value.to_owned();
    }
    decrypt_field(value, keyring).unwrap_or_else(|_| value.to_owned())
}

/// A `prefix` followed by `iv:ciphertext`, the prefix in any case.
fn versioned(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        && hex_pair(&value[prefix.len()..])
}

/// `maybeDecryptField(value, keyring)` as the integration routes and the
/// workflow engine read it: the plaintext of a sealed v1/v2 value the
/// keyring opens; anything else (plain text, v3, a value the keyring has no
/// key for or can't open) as it is. The version prefix matches in any case
/// and the value opens through [`weldsuite_db::decrypt_field`].
pub fn maybe_decrypt(value: &str, keyring: &Keyring) -> String {
    let v2 = versioned(value, "v2:");
    let v1 = hex_pair(value);
    if !(v1 || v2) || versioned(value, "v3:") {
        return value.to_owned();
    }
    if (v2 && keyring.v2.is_none()) || (v1 && keyring.v1.is_none()) {
        return value.to_owned();
    }
    weldsuite_db::decrypt_field(value, keyring).unwrap_or_else(|_| value.to_owned())
}

/// `encryptField(value, keyring)` when the keyring has a key, else the value
/// as it is (the connect flows' `enc`).
pub fn seal_if_keyed(value: &str, keyring: &Keyring) -> Result<String, String> {
    if keyring.v1.is_none() && keyring.v2.is_none() {
        return Ok(value.to_owned());
    }
    encrypt_field(value, keyring).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_values_pass_through() {
        let keyring = Keyring::default();
        assert_eq!(maybe_decrypt_field("shpat_test", &keyring), "shpat_test");
        assert_eq!(maybe_decrypt_field("ab:cd", &keyring), "ab:cd");
        assert!(decrypt_field("plain", &keyring).is_err());
        let key = "0".repeat(64);
        let keyring = Keyring {
            v1: Some(key),
            v2: None,
        };
        let sealed = weldsuite_db::encrypt_field("secret", &keyring).expect("sealed");
        assert_eq!(maybe_decrypt_field(&sealed, &keyring), "secret");
        assert_eq!(decrypt_field(&sealed, &keyring).expect("open"), "secret");
    }
}
