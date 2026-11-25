//! WeldSign's trust services (plan `weldsuite-documentation/plans/weldsign-eidas.md`,
//! ADRs SIGN-006 and SIGN-007): who signs for a signer at the advanced or
//! qualified level, who seals the operator's documents, and who timestamps.
//!
//! One [`TrustService`] per install, chosen by `SIGN_TRUST_MODE`
//! ([`config::from_env`]):
//!
//! - `csc`: a qualified trust service provider over the Cloud Signature
//!   Consortium API v2 ([`csc::CscTrustService`]). Signers identify and
//!   authorise at the QTSP; WeldSuite sends hashes, never documents, and
//!   holds no keys.
//! - `key`: a self-hosted operator's own seal key and certificate, with any
//!   RFC 3161 TSA; seals only, no advanced or qualified signers.
//! - `local`: a throwaway CA and TSA in process ([`local::LocalTrustService`])
//!   for development and tests. Its signatures prove nothing.
//! - `off` (the default): simple signatures only, nothing sealed.
//!
//! A signer's round trip takes two redirects, because the hash to authorise
//! depends on their certificate, which is known only once they identified:
//! [`TrustService::identify_url`] → [`TrustService::identified`], then
//! [`TrustService::authorize_url`] → [`TrustService::sign_authorized`].

pub mod config;
pub mod csc;
pub mod keyfile;
pub mod local;
pub mod revocation;
pub mod tsa;

use std::fmt;

use weldsuite_pades::{Certificate, ValidationData};
use weldsuite_ports::BoxFuture;

/// Why a trust service call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustError {
    pub message: String,
    /// The signer stopped at the provider (cancelled, refused consent).
    pub cancelled: bool,
}

impl TrustError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            cancelled: false,
        }
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            cancelled: true,
        }
    }
}

impl fmt::Display for TrustError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TrustError {}

/// The levels a signer can be asked for beyond a simple signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Level {
    /// Advanced (eIDAS art. 26).
    Aes,
    /// Qualified (eIDAS art. 3(12)).
    Qes,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Aes => "aes",
            Self::Qes => "qes",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "aes" => Some(Self::Aes),
            "qes" => Some(Self::Qes),
            _ => None,
        }
    }
}

/// A certificate with the chain above it (leaf first excluded).
#[derive(Debug, Clone)]
pub struct Identity {
    pub certificate: Certificate,
    pub chain: Vec<Certificate>,
}

/// The first redirect: the signer identifies at the provider.
#[derive(Debug, Clone)]
pub struct IdentifyRequest<'a> {
    pub level: Level,
    pub redirect_uri: &'a str,
    pub state: &'a str,
    /// PKCE S256 challenge.
    pub code_challenge: &'a str,
    /// Who the sender said the signer is (a hint for the provider).
    pub signer_name: Option<&'a str>,
    pub signer_email: Option<&'a str>,
    pub locale: &'a str,
}

/// What the provider says about an identified signer.
#[derive(Debug, Clone)]
pub struct SignerCredential {
    pub credential_id: String,
    pub identity: Identity,
    /// The provider's token for this signer's session (service scope).
    pub access_token: String,
    /// How the provider identified them, when it says.
    pub identity_method: Option<String>,
}

/// The second redirect: the signer authorises one hash.
#[derive(Debug, Clone)]
pub struct AuthorizeRequest<'a> {
    pub credential: &'a SignerCredential,
    /// The data to be signed (its SHA-256 is what is authorised).
    pub data_to_be_signed: &'a [u8],
    pub redirect_uri: &'a str,
    pub state: &'a str,
    pub code_challenge: &'a str,
    /// What the signer sees at the provider ("Contract X, 3 pages").
    pub description: &'a str,
    pub locale: &'a str,
}

/// The code the provider sent back after a redirect.
#[derive(Debug, Clone)]
pub struct Callback<'a> {
    pub code: &'a str,
    pub redirect_uri: &'a str,
    pub code_verifier: &'a str,
}

/// An install's trust services.
pub trait TrustService: Send + Sync {
    /// The provider's name, shown to signers and senders.
    fn provider(&self) -> &str;

    /// Whether signers can be asked for `level`.
    fn offers(&self, level: Level) -> bool;

    /// Whether completed documents are sealed.
    fn seals(&self) -> bool;

    /// The seal's certificate and chain.
    fn seal_identity(&self) -> BoxFuture<'_, Result<Identity, TrustError>>;

    /// Sign `data_to_be_signed` with the seal (SHA-256).
    fn seal_sign<'a>(
        &'a self,
        data_to_be_signed: &'a [u8],
    ) -> BoxFuture<'a, Result<Vec<u8>, TrustError>>;

    /// A timestamp token for a SHA-256 digest; `None` without a TSA.
    fn timestamp<'a>(
        &'a self,
        digest: &'a [u8],
    ) -> BoxFuture<'a, Result<Option<Vec<u8>>, TrustError>>;

    /// Certificates, OCSP answers and CRLs to validate `chains` later (B-LT).
    fn validation_data<'a>(
        &'a self,
        chains: &'a [Vec<Certificate>],
    ) -> BoxFuture<'a, Result<ValidationData, TrustError>>;

    /// Where to send a signer to identify.
    fn identify_url(&self, request: &IdentifyRequest<'_>) -> Result<String, TrustError>;

    /// After the first redirect: the signer's credential and certificate.
    fn identified<'a>(
        &'a self,
        level: Level,
        callback: Callback<'a>,
    ) -> BoxFuture<'a, Result<SignerCredential, TrustError>>;

    /// Where to send a signer to authorise their signature.
    fn authorize_url(&self, request: &AuthorizeRequest<'_>) -> Result<String, TrustError>;

    /// After the second redirect: the signature value over the data to be signed.
    fn sign_authorized<'a>(
        &'a self,
        credential: &'a SignerCredential,
        data_to_be_signed: &'a [u8],
        callback: Callback<'a>,
    ) -> BoxFuture<'a, Result<Vec<u8>, TrustError>>;
}

/// Append `?key=value&…` (or `&…` when the URL has a query) with the values
/// percent-encoded.
pub fn with_query(url: &str, params: &[(&str, &str)]) -> String {
    let mut out = String::from(url);
    let mut first = !url.contains('?');
    for (key, value) in params {
        out.push(if first { '?' } else { '&' });
        first = false;
        out.push_str(&percent_encode(key));
        out.push('=');
        out.push_str(&percent_encode(value));
    }
    out
}

/// `application/x-www-form-urlencoded` / query encoding of one component.
pub fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// A form body from pairs.
pub fn form_body(params: &[(&str, &str)]) -> Vec<u8> {
    params
        .iter()
        .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
        .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_are_encoded() {
        assert_eq!(
            with_query(
                "https://q.example/authorize",
                &[("state", "a b"), ("x", "é/")]
            ),
            "https://q.example/authorize?state=a%20b&x=%C3%A9%2F"
        );
        assert_eq!(
            with_query("https://q.example/a?y=1", &[("z", "2")]),
            "https://q.example/a?y=1&z=2"
        );
        assert_eq!(form_body(&[("a", "1+1"), ("b", "")]), b"a=1%2B1&b=");
        assert_eq!(Level::parse("qes"), Some(Level::Qes));
        assert_eq!(Level::Aes.as_str(), "aes");
    }
}
