//! Field encryption (`packages/core/db/src/lib/crypto.ts`) as connect reads
//! it: integration tokens and credentials sealed with the workspace keyring
//! (`DATABASE_ENCRYPTION_KEY`, `_V2`).

use weldsuite_db::{Keyring, decrypt_field, encrypt_field};

/// `iv:ciphertext`, both non-empty hex.
fn hex_pair(value: &str) -> bool {
    let is_hex = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit());
    matches!(value.split_once(':'), Some((a, b)) if is_hex(a) && is_hex(b))
}

fn versioned(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        && hex_pair(&value[prefix.len()..])
}

/// `maybeDecryptField(value, keyring)`: the plaintext of a sealed v1/v2
/// value the keyring opens; anything else (plain text, v3, a value the
/// keyring has no key for or can't open) as it is.
pub(crate) fn maybe_decrypt(value: &str, keyring: &Keyring) -> String {
    let v2 = versioned(value, "v2:");
    let v1 = hex_pair(value);
    if !(v1 || v2) || versioned(value, "v3:") {
        return value.to_owned();
    }
    if (v2 && keyring.v2.is_none()) || (v1 && keyring.v1.is_none()) {
        return value.to_owned();
    }
    decrypt_field(value, keyring).unwrap_or_else(|_| value.to_owned())
}

/// `encryptField(value, keyring)` when the keyring has a key, else the value
/// as it is (the connect flows' `enc`).
pub(crate) fn seal_if_keyed(value: &str, keyring: &Keyring) -> Result<String, String> {
    if keyring.v1.is_none() && keyring.v2.is_none() {
        return Ok(value.to_owned());
    }
    encrypt_field(value, keyring).map_err(|error| error.to_string())
}
