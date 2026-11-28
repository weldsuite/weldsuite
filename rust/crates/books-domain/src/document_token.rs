//! The token in a public document link (`https://pay.<domain>/d/<token>`,
//! ADR BOOKS-014): stateless and signed, so no table holds it.
//!
//! `base64url(json {v, ws, t, id, n}) "." base64url(HMAC-SHA256)`: the
//! workspace (`ws`, `workspaces.id`) leads the public route to its tenant
//! database, `t` is `invoice` or `quote`, `id` the document and `n` a nonce.
//! The nonce is what revokes a link: the document keeps its current nonce
//! (an invoice in `email_history`, a quote derived from `sent_at`,
//! [`quote_nonce`]) and a token whose nonce no longer matches answers 404.
//!
//! The signing secret is `BOOKS_DOCUMENT_TOKEN_SECRET`, else derived from the
//! install's field encryption key ([`secret`]), so a Kubernetes install needs
//! no new setting. The alphabet is `A-Za-z0-9_-` and one `.`, which is what
//! the pay portal accepts as a plausible token (8 to 256 characters).

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use weldsuite_db::Keyring;

/// The token format this build writes and reads.
pub const VERSION: u8 = 1;

/// What a token says (the field names are the wire format).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentToken {
    pub v: u8,
    /// `workspaces.id`.
    pub ws: String,
    /// `invoice` or `quote`.
    pub t: String,
    pub id: String,
    /// The document's nonce at signing.
    pub n: String,
}

impl DocumentToken {
    pub fn new(workspace_id: &str, kind: &str, id: &str, nonce: &str) -> Self {
        Self {
            v: VERSION,
            ws: workspace_id.to_owned(),
            t: kind.to_owned(),
            id: id.to_owned(),
            n: nonce.to_owned(),
        }
    }
}

/// Why a token is refused. The public routes answer all of them with the
/// same 404.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenError {
    Malformed,
    BadSignature,
    UnknownVersion,
}

fn mac(secret: &[u8], input: &[u8]) -> Hmac<Sha256> {
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(secret).expect("HMAC takes a key of any length");
    mac.update(input);
    mac
}

/// The token text for `token`.
///
/// # Panics
///
/// Never in practice: a token of strings always serializes.
pub fn sign(secret: &[u8], token: &DocumentToken) -> String {
    let payload =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(token).expect("a token of strings serializes"));
    let signature = URL_SAFE_NO_PAD.encode(mac(secret, payload.as_bytes()).finalize().into_bytes());
    format!("{payload}.{signature}")
}

/// What a token says, when `secret` signed it (checked in constant time).
///
/// # Errors
///
/// [`TokenError`] for anything that is not a token this secret signed.
pub fn verify(secret: &[u8], text: &str) -> Result<DocumentToken, TokenError> {
    if text.len() > 512 {
        return Err(TokenError::Malformed);
    }
    let (payload, signature) = text.split_once('.').ok_or(TokenError::Malformed)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| TokenError::Malformed)?;
    mac(secret, payload.as_bytes())
        .verify_slice(&signature)
        .map_err(|_| TokenError::BadSignature)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| TokenError::Malformed)?;
    let token: DocumentToken = serde_json::from_slice(&bytes).map_err(|_| TokenError::Malformed)?;
    if token.v != VERSION {
        return Err(TokenError::UnknownVersion);
    }
    Ok(token)
}

/// A fresh nonce: 12 random bytes, base64url.
///
/// # Panics
///
/// When the operating system has no random source.
pub fn new_nonce() -> String {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// A quote has no column to keep a nonce in, so its nonce follows the time
/// it was first e-mailed (`sent_at`): clearing `sent_at` revokes the link, a
/// later send makes a new one.
pub fn quote_nonce(secret: &[u8], quote_id: &str, sent_at_millis: i64) -> String {
    let digest = mac(
        secret,
        format!("quote-link|{quote_id}|{sent_at_millis}").as_bytes(),
    )
    .finalize()
    .into_bytes();
    URL_SAFE_NO_PAD.encode(&digest[..12])
}

/// The signing secret: `configured` (`BOOKS_DOCUMENT_TOKEN_SECRET`) when set,
/// else derived from the field encryption key (never the key itself). `None`
/// when the install has neither, and then no link can be made.
pub fn secret(configured: Option<&str>, keyring: &Keyring) -> Option<Vec<u8>> {
    if let Some(configured) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(configured.as_bytes().to_vec());
    }
    let key = keyring
        .v2
        .as_deref()
        .or(keyring.v1.as_deref())
        .filter(|k| !k.is_empty())?;
    Some(
        mac(key.as_bytes(), b"weldbooks/document-token/v1")
            .finalize()
            .into_bytes()
            .to_vec(),
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"a-test-secret";

    #[test]
    fn a_signed_token_reads_back_and_fits_the_portal() {
        let token = DocumentToken::new(
            "ws_abcdefghijkl",
            "invoice",
            "inv_abcdefghijklmnopqrstu",
            &new_nonce(),
        );
        let text = sign(SECRET, &token);
        assert_eq!(verify(SECRET, &text), Ok(token));
        assert!((8..=256).contains(&text.len()), "{}", text.len());
        assert!(
            text.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        );
    }

    #[test]
    fn a_tampered_or_foreign_token_is_refused() {
        let token = DocumentToken::new("ws_a", "quote", "quote_1", "n1");
        let text = sign(SECRET, &token);
        assert_eq!(verify(b"another", &text), Err(TokenError::BadSignature));
        // Another document under the first one's signature.
        let other = sign(
            SECRET,
            &DocumentToken::new("ws_a", "quote", "quote_2", "n1"),
        );
        let (payload, _) = other.split_once('.').unwrap();
        let (_, signature) = text.split_once('.').unwrap();
        assert_eq!(
            verify(SECRET, &format!("{payload}.{signature}")),
            Err(TokenError::BadSignature)
        );
        assert_eq!(verify(SECRET, "nodot"), Err(TokenError::Malformed));
        assert_eq!(verify(SECRET, "a.b"), Err(TokenError::Malformed));
        assert_eq!(verify(SECRET, "YQ.YQ"), Err(TokenError::BadSignature));
        assert_eq!(verify(SECRET, ""), Err(TokenError::Malformed));
        assert_eq!(verify(SECRET, &"x".repeat(600)), Err(TokenError::Malformed));
    }

    #[test]
    fn an_unknown_version_is_refused() {
        let mut token = DocumentToken::new("ws_a", "invoice", "inv_1", "n");
        token.v = 9;
        assert_eq!(
            verify(SECRET, &sign(SECRET, &token)),
            Err(TokenError::UnknownVersion)
        );
    }

    #[test]
    fn a_quote_nonce_follows_its_sent_time() {
        let a = quote_nonce(SECRET, "quote_1", 1_000);
        assert_eq!(a, quote_nonce(SECRET, "quote_1", 1_000));
        assert_ne!(a, quote_nonce(SECRET, "quote_1", 2_000));
        assert_ne!(a, quote_nonce(SECRET, "quote_2", 1_000));
    }

    #[test]
    fn the_secret_is_configured_or_derived_never_the_key() {
        let keyring = Keyring {
            v1: Some("k1".into()),
            v2: None,
        };
        assert_eq!(secret(Some(" s "), &keyring), Some(b"s".to_vec()));
        let derived = secret(None, &keyring).unwrap();
        assert_ne!(derived, b"k1".to_vec());
        assert_eq!(Some(derived), secret(Some(""), &keyring));
        assert_eq!(secret(None, &Keyring::default()), None);
    }
}
