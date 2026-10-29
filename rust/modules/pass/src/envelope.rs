//! WeldPass envelope encryption, bit for bit what pass-api's `envelope.ts`
//! writes and reads (AES-256-GCM with additional authenticated data, the
//! same wire format and the same AAD strings), so either backend opens the
//! other's rows:
//!
//! ```text
//! root key  (WELDPASS_ROOT_KEY, 32 bytes hex)    wraps each vault's KEK
//! vault KEK (weldpass_projects / weldpass_vaults .kek_wrapped)  wraps each DEK
//! DEK       (per write, .dek_wrapped)            encrypts one value or item
//! ```
//!
//! Wire format `<version>:<iv-hex>:<ciphertext-hex>` (the tag is the
//! ciphertext's last 16 bytes, as Web Crypto appends it). AAD:
//!
//! - KEK: `weldpass:kek:<projectId or vaultId>`
//! - secret value / its DEK: `weldpass:value:<project>:<environment>:<key>`,
//!   `weldpass:dek:<project>:<environment>:<key>`
//! - password item / its DEK: `weldpass:item:<vault>:<item>`,
//!   `weldpass:item-dek:<vault>:<item>`
//!
//! The drift checksum is `h1:` + the first 61 hex characters of
//! HMAC-SHA256(HKDF-SHA256(KEK, salt "", info "weldpass:checksum:v1"),
//! `project \0 environment \0 key \0 plaintext`).
//!
//! Key material never reaches a log: the KEK and the root keys print as
//! `<redacted>`, and [`EnvelopeError`] carries no value.
//! `tests/fixtures/envelope-ts.json` holds ciphertexts the TypeScript code
//! sealed (opened here), `envelope-rust.json` ones this code sealed with fixed
//! randomness (opened by `envelope.vectors.test.ts` in pass-api).

use std::fmt;

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

/// Why a value would not seal or open. The message is what the TypeScript
/// `EnvelopeError` says; it never contains key material or a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeError(pub String);

impl EnvelopeError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for EnvelopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EnvelopeError {}

/// `WELDPASS_ROOT_KEY` (v1) and, during a rotation, `WELDPASS_ROOT_KEY_V2`.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct RootKeyring {
    pub v1: Option<String>,
    pub v2: Option<String>,
}

impl fmt::Debug for RootKeyring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RootKeyring")
            .field("v1", &self.v1.as_ref().map(|_| "<redacted>"))
            .field("v2", &self.v2.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl RootKeyring {
    /// `rootKeyringFromEnv`: an unset value is absent; an empty one counts
    /// as absent too (`if (keyring.v2)`), which `require_root_key` then says.
    pub fn from_values(v1: Option<&str>, v2: Option<&str>) -> Self {
        Self {
            v1: v1.map(str::to_owned),
            v2: v2.map(str::to_owned),
        }
    }

    /// `currentRootKeyVersion`: the newest key present.
    pub fn current_version(&self) -> Result<&'static str, EnvelopeError> {
        if self.v2.as_deref().is_some_and(|key| !key.is_empty()) {
            return Ok("v2");
        }
        if self.v1.as_deref().is_some_and(|key| !key.is_empty()) {
            return Ok("v1");
        }
        Err(EnvelopeError::new("WELDPASS_ROOT_KEY is not configured"))
    }

    fn require(&self, version: &str) -> Result<Key, EnvelopeError> {
        let hex = match version {
            "v2" => self.v2.as_deref(),
            "v1" => self.v1.as_deref(),
            _ => None,
        }
        .filter(|hex| !hex.is_empty())
        .ok_or_else(|| {
            EnvelopeError::new(format!(
                "Root key \"{version}\" is not available to this worker"
            ))
        })?;
        // `hex.length !== 64`: UTF-16 units, which for a hex key are bytes.
        if crate::js::utf16_len(hex) != 64 {
            return Err(EnvelopeError::new(format!(
                "Root key \"{version}\" must be 64 hex characters (32 bytes)"
            )));
        }
        Ok(Key(hex_to_bytes(hex)?))
    }
}

/// A 32-byte AES key held for one request (a KEK or a DEK). Prints as
/// `<redacted>`.
#[derive(Clone, PartialEq, Eq)]
pub struct Key(Vec<u8>);

impl fmt::Debug for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Key(<redacted>)")
    }
}

impl Key {
    /// Raw key bytes. Used by tests and fixtures only.
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub fn bytes(&self) -> &[u8] {
        &self.0
    }
}

/// Where randomness comes from: the OS, or fixed bytes in the fixture tests.
pub trait Entropy {
    fn fill(&mut self, buf: &mut [u8]);
}

/// `crypto.getRandomValues`.
pub struct OsEntropy;

impl Entropy for OsEntropy {
    fn fill(&mut self, buf: &mut [u8]) {
        // The OS generator failing leaves nothing safe to do but stop.
        #[allow(clippy::expect_used)]
        getrandom::fill(buf).expect("the OS random number generator is available");
    }
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

/// `hexToBytes`: pairs read with `Number.parseInt(pair, 16)` into a
/// `Uint8Array`, so a pair that parses only partly (`"az"`) still yields a
/// byte, as it does in TypeScript.
fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, EnvelopeError> {
    let units: Vec<u16> = hex.encode_utf16().collect();
    if units.len() % 2 != 0 {
        return Err(EnvelopeError::new("Invalid hex length"));
    }
    units
        .chunks(2)
        .map(|pair| {
            let pair = String::from_utf16_lossy(pair);
            let value = crate::js::parse_int(&pair, 16)
                .ok_or_else(|| EnvelopeError::new("Invalid hex input"))?;
            // `Uint8Array` stores ToUint8(value): modulo 256.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Ok((value.rem_euclid(256.0)) as u8)
        })
        .collect()
}

/// `^(v\d+):([0-9a-f]+):([0-9a-f]+)$`, case-insensitive.
fn split_packed(packed: &str) -> Result<(&str, &str, &str), EnvelopeError> {
    let bad = || EnvelopeError::new("Value is not in the expected envelope format");
    let mut parts = packed.splitn(3, ':');
    let (Some(version), Some(iv), Some(cipher)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(bad());
    };
    let version_ok = version.len() > 1
        && matches!(version.as_bytes()[0], b'v' | b'V')
        && version[1..].bytes().all(|b| b.is_ascii_digit());
    let hex = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit());
    if !version_ok || !hex(iv) || !hex(cipher) {
        return Err(bad());
    }
    Ok((version, iv, cipher))
}

/// `versionOf`: the version tag, lower-cased.
pub fn version_of(packed: &str) -> Result<String, EnvelopeError> {
    split_packed(packed).map(|(version, _, _)| version.to_ascii_lowercase())
}

fn cipher_for(key: &Key) -> Result<Aes256Gcm, EnvelopeError> {
    if key.0.len() != 32 {
        return Err(EnvelopeError::new(format!(
            "Expected a 32-byte AES key, got {}",
            key.0.len()
        )));
    }
    Aes256Gcm::new_from_slice(&key.0)
        .map_err(|_| EnvelopeError::new("Expected a 32-byte AES key"))
}

/// `seal`: a fresh 12-byte IV, AES-256-GCM with `aad`, packed.
fn seal(
    key: &Key,
    plaintext: &[u8],
    aad: &str,
    version: &str,
    entropy: &mut dyn Entropy,
) -> Result<String, EnvelopeError> {
    let cipher = cipher_for(key)?;
    let mut iv = [0_u8; 12];
    entropy.fill(&mut iv);
    let sealed = cipher
        .encrypt(
            &iv.into(),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| EnvelopeError::new("Encryption failed"))?;
    Ok(format!(
        "{version}:{}:{}",
        hex::encode(iv),
        hex::encode(sealed)
    ))
}

/// `open`: the version tag is not checked here; the caller picked the key.
fn open(key: &Key, packed: &str, aad: &str) -> Result<Vec<u8>, EnvelopeError> {
    let (_, iv_hex, cipher_hex) = split_packed(packed)?;
    let cipher = cipher_for(key)?;
    let iv = hex_to_bytes(iv_hex)?;
    let sealed = hex_to_bytes(cipher_hex)?;
    let failed =
        || EnvelopeError::new("Decryption failed — wrong key or the value has been tampered with");
    // Web Crypto takes any IV length; WeldPass only ever writes 12 bytes, and
    // anything else cannot be a value it sealed.
    let iv: [u8; 12] = iv.try_into().map_err(|_| failed())?;
    cipher
        .decrypt(
            &iv.into(),
            Payload {
                msg: &sealed,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| failed())
}

/// UTF-8 of a decrypted value, as `TextDecoder` reads it (invalid bytes
/// become U+FFFD).
fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

// ---------------------------------------------------------------------------
// Vault keys (KEK)
// ---------------------------------------------------------------------------

/// A fresh vault key, wrapped and ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrappedVaultKey {
    pub kek_wrapped: String,
    pub root_key_version: &'static str,
}

fn kek_aad(owner_id: &str) -> String {
    format!("weldpass:kek:{owner_id}")
}

/// `createVaultKey`: mint a KEK for a project or a password vault, wrapped
/// under the newest root key with the owner's id as AAD.
pub fn create_vault_key(
    keyring: &RootKeyring,
    owner_id: &str,
) -> Result<WrappedVaultKey, EnvelopeError> {
    create_vault_key_with(keyring, owner_id, &mut OsEntropy)
}

pub(crate) fn create_vault_key_with(
    keyring: &RootKeyring,
    owner_id: &str,
    entropy: &mut dyn Entropy,
) -> Result<WrappedVaultKey, EnvelopeError> {
    let version = keyring.current_version()?;
    let mut kek = vec![0_u8; 32];
    entropy.fill(&mut kek);
    let root = keyring.require(version)?;
    let kek_wrapped = seal(&root, &kek, &kek_aad(owner_id), version, entropy)?;
    Ok(WrappedVaultKey {
        kek_wrapped,
        root_key_version: version,
    })
}

/// `unwrapVaultKey`: the root key named by the wrapped value's tag.
pub fn unwrap_vault_key(
    keyring: &RootKeyring,
    owner_id: &str,
    kek_wrapped: &str,
) -> Result<Key, EnvelopeError> {
    let version = version_of(kek_wrapped)?;
    let root = keyring.require(&version)?;
    open(&root, kek_wrapped, &kek_aad(owner_id)).map(Key)
}

/// `rewrapVaultKey`: the same KEK under the newest root key. Root-key
/// rotation rewrites only the project and vault rows this returns for; no
/// value, DEK or item is touched, so their ciphertexts stay valid.
pub fn rewrap_vault_key(
    keyring: &RootKeyring,
    owner_id: &str,
    kek_wrapped: &str,
) -> Result<WrappedVaultKey, EnvelopeError> {
    rewrap_vault_key_with(keyring, owner_id, kek_wrapped, &mut OsEntropy)
}

pub(crate) fn rewrap_vault_key_with(
    keyring: &RootKeyring,
    owner_id: &str,
    kek_wrapped: &str,
    entropy: &mut dyn Entropy,
) -> Result<WrappedVaultKey, EnvelopeError> {
    let kek = unwrap_vault_key(keyring, owner_id, kek_wrapped)?;
    let version = keyring.current_version()?;
    let root = keyring.require(version)?;
    Ok(WrappedVaultKey {
        kek_wrapped: seal(&root, &kek.0, &kek_aad(owner_id), version, entropy)?,
        root_key_version: version,
    })
}

// ---------------------------------------------------------------------------
// Secret values (DEK)
// ---------------------------------------------------------------------------

/// Where a secret value lives; bound into its ciphertext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretLocation {
    pub project_id: String,
    pub environment_id: String,
    pub key: String,
}

impl SecretLocation {
    pub fn new(project_id: &str, environment_id: &str, key: &str) -> Self {
        Self {
            project_id: project_id.to_owned(),
            environment_id: environment_id.to_owned(),
            key: key.to_owned(),
        }
    }

    fn value_aad(&self) -> String {
        format!(
            "weldpass:value:{}:{}:{}",
            self.project_id, self.environment_id, self.key
        )
    }

    fn dek_aad(&self) -> String {
        format!(
            "weldpass:dek:{}:{}:{}",
            self.project_id, self.environment_id, self.key
        )
    }
}

/// `credentialLocation`: a provider token sits at its credential id, so it
/// cannot be moved onto another credential row.
pub fn credential_location(project_id: &str, credential_id: &str) -> SecretLocation {
    SecretLocation::new(project_id, credential_id, "__provider_token__")
}

/// A sealed value and its safe-to-show parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedSecret {
    pub ciphertext: String,
    pub dek_wrapped: String,
    pub checksum: String,
    /// `plaintext.length`, in UTF-16 code units.
    pub value_length: i32,
    pub value_hint: Option<String>,
}

/// `sealSecret`: one value under a fresh DEK.
pub fn seal_secret(
    kek: &Key,
    location: &SecretLocation,
    plaintext: &str,
) -> Result<SealedSecret, EnvelopeError> {
    seal_secret_with(kek, location, plaintext, &mut OsEntropy)
}

pub(crate) fn seal_secret_with(
    kek: &Key,
    location: &SecretLocation,
    plaintext: &str,
    entropy: &mut dyn Entropy,
) -> Result<SealedSecret, EnvelopeError> {
    let mut dek = vec![0_u8; 32];
    entropy.fill(&mut dek);
    let dek = Key(dek);
    let ciphertext = seal(
        &dek,
        plaintext.as_bytes(),
        &location.value_aad(),
        "v1",
        entropy,
    )?;
    let dek_wrapped = seal(kek, &dek.0, &location.dek_aad(), "v1", entropy)?;
    Ok(SealedSecret {
        ciphertext,
        dek_wrapped,
        checksum: checksum_for(kek, location, plaintext)?,
        value_length: i32::try_from(crate::js::utf16_len(plaintext)).unwrap_or(i32::MAX),
        value_hint: hint_for(plaintext),
    })
}

/// `openSecret`. The caller has checked `secrets:reveal`.
pub fn open_secret(
    kek: &Key,
    location: &SecretLocation,
    ciphertext: &str,
    dek_wrapped: &str,
) -> Result<String, EnvelopeError> {
    let dek = Key(open(kek, dek_wrapped, &location.dek_aad())?);
    open(&dek, ciphertext, &location.value_aad()).map(|bytes| decode(&bytes))
}

// ---------------------------------------------------------------------------
// Password manager items
// ---------------------------------------------------------------------------

/// Where a password-manager item lives; bound into its ciphertext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemLocation {
    pub vault_id: String,
    pub item_id: String,
}

impl ItemLocation {
    pub fn new(vault_id: &str, item_id: &str) -> Self {
        Self {
            vault_id: vault_id.to_owned(),
            item_id: item_id.to_owned(),
        }
    }

    fn item_aad(&self) -> String {
        format!("weldpass:item:{}:{}", self.vault_id, self.item_id)
    }

    fn dek_aad(&self) -> String {
        format!("weldpass:item-dek:{}:{}", self.vault_id, self.item_id)
    }
}

/// A sealed item: no checksum and no hint, unlike a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedItem {
    pub ciphertext: String,
    pub dek_wrapped: String,
}

/// `sealItem`: the item's JSON document under a fresh DEK.
pub fn seal_item(
    kek: &Key,
    location: &ItemLocation,
    plaintext: &str,
) -> Result<SealedItem, EnvelopeError> {
    seal_item_with(kek, location, plaintext, &mut OsEntropy)
}

pub(crate) fn seal_item_with(
    kek: &Key,
    location: &ItemLocation,
    plaintext: &str,
    entropy: &mut dyn Entropy,
) -> Result<SealedItem, EnvelopeError> {
    let mut dek = vec![0_u8; 32];
    entropy.fill(&mut dek);
    let dek = Key(dek);
    Ok(SealedItem {
        ciphertext: seal(
            &dek,
            plaintext.as_bytes(),
            &location.item_aad(),
            "v1",
            entropy,
        )?,
        dek_wrapped: seal(kek, &dek.0, &location.dek_aad(), "v1", entropy)?,
    })
}

/// `openItem`. The caller has resolved vault access.
pub fn open_item(
    kek: &Key,
    location: &ItemLocation,
    ciphertext: &str,
    dek_wrapped: &str,
) -> Result<String, EnvelopeError> {
    let dek = Key(open(kek, dek_wrapped, &location.dek_aad())?);
    open(&dek, ciphertext, &location.item_aad()).map(|bytes| decode(&bytes))
}

// ---------------------------------------------------------------------------
// Checksums and hints
// ---------------------------------------------------------------------------

const CHECKSUM_PREFIX: &str = "h1:";
const CHECKSUM_HEX_LENGTH: usize = 61;

/// `sha256Hex`: only to recognise checksums written before they were keyed.
pub fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// `checksumFor`: HMAC-SHA256 under a key derived from the KEK, over the
/// location and the plaintext.
pub fn checksum_for(
    kek: &Key,
    location: &SecretLocation,
    plaintext: &str,
) -> Result<String, EnvelopeError> {
    // `importKey('raw', kek, 'HKDF')` takes any length; HKDF with an empty
    // salt (the same as no salt) and 32 bytes out.
    let hkdf = Hkdf::<Sha256>::new(Some(&[]), &kek.0);
    let mut mac_key = [0_u8; 32];
    hkdf.expand(b"weldpass:checksum:v1", &mut mac_key)
        .map_err(|_| EnvelopeError::new("Checksum key derivation failed"))?;
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&mac_key)
        .map_err(|_| EnvelopeError::new("Checksum key derivation failed"))?;
    mac.update(
        format!(
            "{}\0{}\0{}\0{plaintext}",
            location.project_id, location.environment_id, location.key
        )
        .as_bytes(),
    );
    let digest = hex::encode(mac.finalize().into_bytes());
    Ok(format!(
        "{CHECKSUM_PREFIX}{}",
        &digest[..CHECKSUM_HEX_LENGTH]
    ))
}

/// `isLegacyChecksum`: a bare SHA-256, from before checksums were keyed.
pub fn is_legacy_checksum(stored: &str) -> bool {
    !stored.starts_with(CHECKSUM_PREFIX)
}

/// `checksumMatches`: either format.
pub fn checksum_matches(stored: &str, fresh: &str, plaintext: &str) -> bool {
    if is_legacy_checksum(stored) {
        stored == sha256_hex(plaintext)
    } else {
        stored == fresh
    }
}

/// `hintFor`: the last four characters (UTF-16 code units) of a value of at
/// least twelve.
pub fn hint_for(plaintext: &str) -> Option<String> {
    (crate::js::utf16_len(plaintext) >= 12).then(|| crate::js::utf16_tail(plaintext, 4))
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::{Value, json};

    use super::*;

    const KEY_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const KEY_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    /// Bytes from a counter: deterministic "randomness" for the fixtures.
    pub(crate) struct CountingEntropy(pub(crate) u8);

    impl Entropy for CountingEntropy {
        fn fill(&mut self, buf: &mut [u8]) {
            for byte in buf {
                *byte = self.0;
                self.0 = self.0.wrapping_add(1);
            }
        }
    }

    fn ring(v1: Option<&str>, v2: Option<&str>) -> RootKeyring {
        RootKeyring::from_values(v1, v2)
    }

    fn location() -> SecretLocation {
        SecretLocation::new("prj_1", "env_1", "DATABASE_URL")
    }

    #[test]
    fn keyring_versions() {
        assert_eq!(ring(Some(KEY_A), Some(KEY_B)).current_version(), Ok("v2"));
        assert_eq!(ring(Some(KEY_A), None).current_version(), Ok("v1"));
        assert!(ring(None, None).current_version().is_err());
        assert!(create_vault_key(&ring(Some("abc"), None), "prj_1").is_err());
    }

    #[test]
    fn round_trips_and_binds_locations() {
        let keyring = ring(Some(KEY_A), None);
        let wrapped = create_vault_key(&keyring, "prj_1").expect("vault key");
        assert_eq!(wrapped.root_key_version, "v1");
        let kek = unwrap_vault_key(&keyring, "prj_1", &wrapped.kek_wrapped).expect("kek");
        assert_eq!(kek.bytes().len(), 32);
        assert!(unwrap_vault_key(&keyring, "prj_2", &wrapped.kek_wrapped).is_err());
        assert!(unwrap_vault_key(&ring(Some(KEY_B), None), "prj_1", &wrapped.kek_wrapped).is_err());

        let sealed = seal_secret(&kek, &location(), "example-db-password").expect("seal");
        assert_eq!(
            open_secret(&kek, &location(), &sealed.ciphertext, &sealed.dek_wrapped).as_deref(),
            Ok("example-db-password")
        );
        let mut moved = location();
        moved.environment_id = "env_2".to_owned();
        assert!(open_secret(&kek, &moved, &sealed.ciphertext, &sealed.dek_wrapped).is_err());
        let mut renamed = location();
        renamed.key = "OTHER".to_owned();
        assert!(open_secret(&kek, &renamed, &sealed.ciphertext, &sealed.dek_wrapped).is_err());

        let again = seal_secret(&kek, &location(), "example-db-password").expect("seal");
        assert_ne!(again.ciphertext, sealed.ciphertext);
        assert_eq!(again.checksum, sealed.checksum);
        assert!(sealed.checksum.starts_with("h1:") && sealed.checksum.len() == 64);
        assert_eq!(sealed.value_hint.as_deref(), Some("word"));

        let item = ItemLocation::new("wpk_1", "wpi_1");
        let sealed = seal_item(&kek, &item, "{\"type\":\"note\"}").expect("seal item");
        assert_eq!(
            open_item(&kek, &item, &sealed.ciphertext, &sealed.dek_wrapped).as_deref(),
            Ok("{\"type\":\"note\"}")
        );
        let elsewhere = ItemLocation::new("wpk_2", "wpi_1");
        assert!(open_item(&kek, &elsewhere, &sealed.ciphertext, &sealed.dek_wrapped).is_err());
    }

    #[test]
    fn rewrap_keeps_the_key_and_changes_only_the_wrapping() {
        let old = ring(Some(KEY_A), None);
        let wrapped = create_vault_key(&old, "prj_1").expect("vault key");
        let kek = unwrap_vault_key(&old, "prj_1", &wrapped.kek_wrapped).expect("kek");
        let rotating = ring(Some(KEY_A), Some(KEY_B));
        let rotated = rewrap_vault_key(&rotating, "prj_1", &wrapped.kek_wrapped).expect("rewrap");
        assert_eq!(rotated.root_key_version, "v2");
        assert_eq!(version_of(&rotated.kek_wrapped).as_deref(), Ok("v2"));
        let after = unwrap_vault_key(&ring(None, Some(KEY_B)), "prj_1", &rotated.kek_wrapped)
            .expect("unwrap under v2");
        assert_eq!(after, kek);
        // A value sealed before the rotation still opens with the same KEK.
        let sealed = seal_secret(&kek, &location(), "kept").expect("seal");
        assert_eq!(
            open_secret(&after, &location(), &sealed.ciphertext, &sealed.dek_wrapped).as_deref(),
            Ok("kept")
        );
    }

    #[test]
    fn tampering_fails() {
        let kek = Key(vec![7; 32]);
        let sealed = seal_secret(&kek, &location(), "value").expect("seal");
        let mut flipped = sealed.ciphertext.clone();
        let last = flipped.pop().expect("non-empty");
        flipped.push(if last == '0' { '1' } else { '0' });
        assert!(open_secret(&kek, &location(), &flipped, &sealed.dek_wrapped).is_err());
        assert!(open_secret(&kek, &location(), "nope", &sealed.dek_wrapped).is_err());
    }

    #[test]
    fn legacy_checksums_and_hints() {
        let kek = Key(vec![9; 32]);
        let legacy = sha256_hex("value");
        assert!(is_legacy_checksum(&legacy));
        let fresh = checksum_for(&kek, &location(), "value").expect("checksum");
        assert!(!is_legacy_checksum(&fresh));
        assert!(checksum_matches(&legacy, &fresh, "value"));
        let other = checksum_for(&kek, &location(), "changed").expect("checksum");
        assert!(!checksum_matches(&legacy, &other, "changed"));
        assert!(checksum_matches(&fresh, &fresh, "value"));
        assert_eq!(hint_for("short"), None);
        assert_eq!(hint_for("sk_live_0123456789").as_deref(), Some("6789"));
    }

    #[test]
    fn root_keys_read_hex_like_parse_int() {
        // `Number.parseInt("az", 16)` is 10: the pair still yields a byte.
        let quirky = format!("az{}", "a".repeat(62));
        let bytes = ring(Some(&quirky), None).require("v1").expect("root key");
        assert_eq!(bytes.0[0], 10);
        assert!(ring(Some(&format!("zz{}", "a".repeat(62))), None).require("v1").is_err());
    }

    // ── Cross-backend vectors ──────────────────────────────────────────────

    fn fixture(text: &str) -> Value {
        serde_json::from_str(text).expect("fixture is JSON")
    }

    fn text<'a>(value: &'a Value, key: &str) -> &'a str {
        value[key].as_str().unwrap_or_default()
    }

    fn keyring_of(value: &Value) -> RootKeyring {
        RootKeyring::from_values(value["v1"].as_str(), value["v2"].as_str())
    }

    /// Ciphertexts and checksums the TypeScript `envelope.ts` produced
    /// (`tools/envelope-fixtures.mts`): every one opens here, every keyed
    /// checksum is reproduced, and every wrong-AAD case fails.
    #[test]
    fn opens_what_typescript_sealed() {
        let vectors = fixture(include_str!("../tests/fixtures/envelope-ts.json"));
        for case in vectors["vaultKeys"].as_array().expect("vaultKeys") {
            let keyring = keyring_of(&case["keyring"]);
            let kek = unwrap_vault_key(&keyring, text(case, "ownerId"), text(case, "kekWrapped"))
                .expect("TypeScript KEK opens");
            assert_eq!(hex::encode(kek.bytes()), text(case, "kekHex"));
            assert!(unwrap_vault_key(&keyring, "someone-else", text(case, "kekWrapped")).is_err());
        }
        for case in vectors["rewrapped"].as_array().expect("rewrapped") {
            let kek = unwrap_vault_key(
                &keyring_of(&case["keyring"]),
                text(case, "ownerId"),
                text(case, "kekWrapped"),
            )
            .expect("rewrapped KEK opens");
            assert_eq!(hex::encode(kek.bytes()), text(case, "kekHex"));
            assert_eq!(version_of(text(case, "kekWrapped")).as_deref(), Ok("v2"));
        }
        for case in vectors["secrets"].as_array().expect("secrets") {
            let kek = Key(hex::decode(text(case, "kekHex")).expect("hex"));
            let at = &case["location"];
            let location = SecretLocation::new(
                text(at, "projectId"),
                text(at, "environmentId"),
                text(at, "key"),
            );
            let opened = open_secret(
                &kek,
                &location,
                text(case, "ciphertext"),
                text(case, "dekWrapped"),
            )
            .expect("TypeScript secret opens");
            assert_eq!(opened, text(case, "plaintext"));
            assert_eq!(
                checksum_for(&kek, &location, &opened).expect("checksum"),
                text(case, "checksum")
            );
            assert_eq!(
                i64::from(crate::js::utf16_len(&opened) as i32),
                case["valueLength"].as_i64().unwrap_or(-1)
            );
            assert_eq!(hint_for(&opened).as_deref(), case["valueHint"].as_str());
            let mut wrong = location.clone();
            wrong.key.push('X');
            assert!(
                open_secret(&kek, &wrong, text(case, "ciphertext"), text(case, "dekWrapped"))
                    .is_err()
            );
        }
        for case in vectors["items"].as_array().expect("items") {
            let kek = Key(hex::decode(text(case, "kekHex")).expect("hex"));
            let at = &case["location"];
            let location = ItemLocation::new(text(at, "vaultId"), text(at, "itemId"));
            let opened = open_item(
                &kek,
                &location,
                text(case, "ciphertext"),
                text(case, "dekWrapped"),
            )
            .expect("TypeScript item opens");
            assert_eq!(opened, text(case, "plaintext"));
            let wrong = ItemLocation::new(text(at, "vaultId"), "wpi_other");
            assert!(
                open_item(&kek, &wrong, text(case, "ciphertext"), text(case, "dekWrapped"))
                    .is_err()
            );
        }
        for case in vectors["sha256"].as_array().expect("sha256") {
            assert_eq!(sha256_hex(text(case, "input")), text(case, "hex"));
        }
    }


    /// What this code seals with fixed randomness; `envelope-rust.json` is
    /// this output, and pass-api's `envelope.vectors.test.ts` opens it with
    /// the TypeScript code. `WELDPASS_WRITE_FIXTURES=1` rewrites the file.
    fn rust_vectors() -> Value {
        let mut entropy = CountingEntropy(1);
        let keyring = ring(Some(KEY_A), None);
        let rotating = ring(Some(KEY_A), Some(KEY_B));
        let project = create_vault_key_with(&keyring, "wpp_rust_1", &mut entropy).expect("kek");
        let kek = unwrap_vault_key(&keyring, "wpp_rust_1", &project.kek_wrapped).expect("kek");
        let rotated =
            rewrap_vault_key_with(&rotating, "wpp_rust_1", &project.kek_wrapped, &mut entropy)
                .expect("rewrap");
        let vault = create_vault_key_with(&rotating, "wpk_rust_1", &mut entropy).expect("vault");
        let vault_kek = unwrap_vault_key(&rotating, "wpk_rust_1", &vault.kek_wrapped).expect("kek");

        let mut secrets = Vec::new();
        for (environment, key, plaintext) in [
            ("wpe_rust_1", "DATABASE_URL", "postgres://u:p@h/db"),
            ("wpe_rust_1", "EMPTY", ""),
            ("wpe_rust_2", "UNICODE", "pässwörd-😀-12345"),
        ] {
            let location = SecretLocation::new("wpp_rust_1", environment, key);
            let sealed =
                seal_secret_with(&kek, &location, plaintext, &mut entropy).expect("seal secret");
            secrets.push(json!({
                "location": { "projectId": "wpp_rust_1", "environmentId": environment, "key": key },
                "plaintext": plaintext,
                "ciphertext": sealed.ciphertext,
                "dekWrapped": sealed.dek_wrapped,
                "checksum": sealed.checksum,
                "valueLength": sealed.value_length,
                "valueHint": sealed.value_hint,
            }));
        }
        let credential = credential_location("wpp_rust_1", "wpc_rust_1");
        let token = seal_secret_with(&kek, &credential, "cf-api-token", &mut entropy).expect("seal");
        secrets.push(json!({
            "location": { "projectId": "wpp_rust_1", "environmentId": "wpc_rust_1", "key": "__provider_token__" },
            "plaintext": "cf-api-token",
            "ciphertext": token.ciphertext,
            "dekWrapped": token.dek_wrapped,
            "checksum": token.checksum,
            "valueLength": token.value_length,
            "valueHint": token.value_hint,
        }));

        let mut items = Vec::new();
        for (item_id, document) in [
            (
                "wpi_rust_1",
                r#"{"type":"login","title":"GitHub","url":"https://github.com","fields":{"username":"carol","password":"hunter2","totp":"","notes":""}}"#,
            ),
            (
                "wpi_rust_2",
                r#"{"type":"note","title":"Ünïcode 😀","fields":{"content":"line one\nline two"}}"#,
            ),
        ] {
            let location = ItemLocation::new("wpk_rust_1", item_id);
            let sealed =
                seal_item_with(&vault_kek, &location, document, &mut entropy).expect("seal item");
            items.push(json!({
                "location": { "vaultId": "wpk_rust_1", "itemId": item_id },
                "plaintext": document,
                "ciphertext": sealed.ciphertext,
                "dekWrapped": sealed.dek_wrapped,
            }));
        }

        json!({
            "$comment": "Sealed by rust/modules/pass (envelope.rs, fixed randomness); opened by apps/workers/pass-api/src/services/weldpass/envelope.vectors.test.ts. Rewrite with WELDPASS_WRITE_FIXTURES=1 cargo test -p weldsuite-pass envelope.",
            "rootKeys": { "v1": KEY_A, "v2": KEY_B },
            "projects": [
                { "ownerId": "wpp_rust_1", "keyring": { "v1": KEY_A }, "kekWrapped": project.kek_wrapped, "rootKeyVersion": project.root_key_version, "kekHex": hex::encode(kek.bytes()) },
                { "ownerId": "wpp_rust_1", "keyring": { "v1": KEY_A, "v2": KEY_B }, "kekWrapped": rotated.kek_wrapped, "rootKeyVersion": rotated.root_key_version, "kekHex": hex::encode(kek.bytes()) },
                { "ownerId": "wpk_rust_1", "keyring": { "v1": KEY_A, "v2": KEY_B }, "kekWrapped": vault.kek_wrapped, "rootKeyVersion": vault.root_key_version, "kekHex": hex::encode(vault_kek.bytes()) },
            ],
            "secrets": secrets,
            "items": items,
        })
    }

    #[test]
    fn rust_vectors_are_stable() {
        let produced = rust_vectors();
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/envelope-rust.json");
        if std::env::var("WELDPASS_WRITE_FIXTURES").as_deref() == Ok("1") {
            let text = serde_json::to_string_pretty(&produced).expect("serialises") + "\n";
            std::fs::write(path, text).expect("fixture written");
        }
        let committed = fixture(include_str!("../tests/fixtures/envelope-rust.json"));
        assert_eq!(produced, committed, "envelope-rust.json is stale");
        // And they open here too.
        let kek = Key(hex::decode(text(&committed["projects"][0], "kekHex")).expect("hex"));
        for case in committed["secrets"].as_array().expect("secrets") {
            let at = &case["location"];
            let location = SecretLocation::new(
                text(at, "projectId"),
                text(at, "environmentId"),
                text(at, "key"),
            );
            assert_eq!(
                open_secret(&kek, &location, text(case, "ciphertext"), text(case, "dekWrapped"))
                    .as_deref(),
                Ok(text(case, "plaintext"))
            );
        }
    }
}
