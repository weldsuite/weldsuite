//! The secrets WeldPanel keeps for a workspace (`services/secrets.ts`): a
//! Slack incoming-webhook URL (alerts, scheduled reports) and an export's
//! S3 secret access key, sealed with the repo's field encryption
//! (`encryptField`: AES-256-GCM under `DATABASE_ENCRYPTION_KEY` / `_V2`).
//! Never logged, never returned by the API, never on the entity bus.

use weldsuite_db::{Keyring, decrypt_field, encrypt_field};

/// `SecretsUnavailableError`'s message: no key is configured here.
pub(crate) const UNAVAILABLE: &str =
    "Secrets cannot be stored here: no encryption key is configured";

/// Why a secret could not be sealed or opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SecretError {
    /// `SecretsUnavailableError`.
    Unavailable,
    /// The value would not seal or open (a wrong key, a tampered value).
    Failed(String),
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => f.write_str(UNAVAILABLE),
            Self::Failed(error) => f.write_str(error),
        }
    }
}

/// `keyringFromEnv(env)`: the two keys as the environment names them.
pub(crate) fn keyring(get: impl Fn(&str) -> Option<String>) -> Keyring {
    Keyring {
        v1: get("DATABASE_ENCRYPTION_KEY").filter(|k| !k.is_empty()),
        v2: get("DATABASE_ENCRYPTION_KEY_V2").filter(|k| !k.is_empty()),
    }
}

/// `sealSecret(env, plaintext)`.
pub(crate) fn seal(keyring: &Keyring, plaintext: &str) -> Result<String, SecretError> {
    if keyring.is_empty() {
        return Err(SecretError::Unavailable);
    }
    encrypt_field(plaintext, keyring).map_err(|error| SecretError::Failed(error.to_string()))
}

/// `openSecret(env, ciphertext)`.
pub(crate) fn open(keyring: &Keyring, ciphertext: &str) -> Result<String, SecretError> {
    if keyring.is_empty() {
        return Err(SecretError::Unavailable);
    }
    decrypt_field(ciphertext, keyring).map_err(|error| SecretError::Failed(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_and_opens_with_the_configured_key_only() {
        let ring = keyring(|name| {
            (name == "DATABASE_ENCRYPTION_KEY").then(|| format!("{}1", "0".repeat(63)))
        });
        let sealed = seal(&ring, "https://hooks.slack.com/services/T/B/x").expect("sealed");
        assert!(!sealed.contains("slack"));
        assert_eq!(
            open(&ring, &sealed).as_deref(),
            Ok("https://hooks.slack.com/services/T/B/x")
        );
        assert_eq!(
            seal(&Keyring::default(), "x"),
            Err(SecretError::Unavailable)
        );
    }
}
