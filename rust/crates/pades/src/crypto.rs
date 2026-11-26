//! Digests and signature checks on `aws-lc-rs`, chosen by the algorithm
//! identifiers certificates and CMS carry.

use std::fmt;

use aws_lc_rs::digest;
use aws_lc_rs::signature::{self, UnparsedPublicKey, VerificationAlgorithm};

use crate::der::{self, Reader};
use crate::oid;

/// Why a signature or key could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CryptoError(pub String);

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "crypto: {}", self.0)
    }
}

impl std::error::Error for CryptoError {}

/// The digests WeldSign reads; it writes SHA-256.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hash {
    Sha1,
    Sha256,
    Sha384,
    Sha512,
}

impl Hash {
    pub fn from_oid(dotted: &str) -> Option<Self> {
        match dotted {
            oid::SHA1 => Some(Self::Sha1),
            oid::SHA256 => Some(Self::Sha256),
            oid::SHA384 => Some(Self::Sha384),
            oid::SHA512 => Some(Self::Sha512),
            _ => None,
        }
    }

    pub fn oid(self) -> &'static str {
        match self {
            Self::Sha1 => oid::SHA1,
            Self::Sha256 => oid::SHA256,
            Self::Sha384 => oid::SHA384,
            Self::Sha512 => oid::SHA512,
        }
    }

    pub fn digest(self, data: &[u8]) -> Vec<u8> {
        let algorithm = match self {
            Self::Sha1 => &digest::SHA1_FOR_LEGACY_USE_ONLY,
            Self::Sha256 => &digest::SHA256,
            Self::Sha384 => &digest::SHA384,
            Self::Sha512 => &digest::SHA512,
        };
        digest::digest(algorithm, data).as_ref().to_vec()
    }

    /// A digest over several slices, in order (a signature's byte ranges).
    pub fn digest_parts(self, parts: &[&[u8]]) -> Vec<u8> {
        let algorithm = match self {
            Self::Sha1 => &digest::SHA1_FOR_LEGACY_USE_ONLY,
            Self::Sha256 => &digest::SHA256,
            Self::Sha384 => &digest::SHA384,
            Self::Sha512 => &digest::SHA512,
        };
        let mut context = digest::Context::new(algorithm);
        for part in parts {
            context.update(part);
        }
        context.finish().as_ref().to_vec()
    }
}

/// SHA-256, the digest WeldSign signs with.
pub fn sha256(data: &[u8]) -> Vec<u8> {
    Hash::Sha256.digest(data)
}

/// An `AlgorithmIdentifier`: its OID and the DER of its parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlgorithmIdentifier {
    pub oid: String,
    pub params: Option<Vec<u8>>,
}

impl AlgorithmIdentifier {
    pub fn read(tlv: der::Tlv<'_>) -> Result<Self, der::DerError> {
        let mut reader = tlv.expect(der::SEQUENCE)?.reader();
        let oid = reader.next()?.oid()?;
        let params = if reader.is_empty() {
            None
        } else {
            Some(reader.next()?.raw.to_vec())
        };
        Ok(Self { oid, params })
    }

    pub fn to_der(&self) -> Vec<u8> {
        let mut content = der::oid(&self.oid);
        if let Some(params) = &self.params {
            content.extend_from_slice(params);
        }
        der::tlv(der::SEQUENCE, &content)
    }
}

/// The key types WeldSign verifies with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    Rsa,
    EcP256,
    EcP384,
    Other,
}

/// The kind of the key in a `SubjectPublicKeyInfo`.
pub fn key_kind(spki: &[u8]) -> KeyKind {
    let read = || -> Result<KeyKind, der::DerError> {
        let mut reader = der::parse_one(spki)?.expect(der::SEQUENCE)?.reader();
        let algorithm = AlgorithmIdentifier::read(reader.next()?)?;
        Ok(match algorithm.oid.as_str() {
            oid::RSA_ENCRYPTION | oid::RSASSA_PSS => KeyKind::Rsa,
            oid::EC_PUBLIC_KEY => {
                let curve = algorithm
                    .params
                    .as_deref()
                    .and_then(|p| der::parse_one(p).ok())
                    .and_then(|p| p.oid().ok());
                match curve.as_deref() {
                    Some(oid::CURVE_P256) => KeyKind::EcP256,
                    Some(oid::CURVE_P384) => KeyKind::EcP384,
                    _ => KeyKind::Other,
                }
            }
            _ => KeyKind::Other,
        })
    };
    read().unwrap_or(KeyKind::Other)
}

/// The hash of an RSASSA-PSS parameter block (SHA-1 when absent, as RFC 4055 says).
fn pss_hash(params: Option<&[u8]>) -> Hash {
    let read = || -> Option<Hash> {
        let tlv = der::parse_one(params?).ok()?;
        let mut reader = Reader::new(tlv.content);
        let hash = reader.optional(der::context(0, true)).ok()??;
        let algorithm = AlgorithmIdentifier::read(der::parse_one(hash.content).ok()?).ok()?;
        Hash::from_oid(&algorithm.oid)
    };
    read().unwrap_or(Hash::Sha1)
}

/// Check `signature` over `message` with the key in `spki`, the way
/// `algorithm` says. `digest` is the digest algorithm a CMS signer named,
/// for the identifiers that leave it out (`rsaEncryption`, a bare
/// `ecPublicKey`).
pub fn verify(
    spki: &[u8],
    algorithm: &AlgorithmIdentifier,
    digest: Option<Hash>,
    message: &[u8],
    signature: &[u8],
) -> Result<(), CryptoError> {
    let kind = key_kind(spki);
    let hash = match algorithm.oid.as_str() {
        oid::SHA256_WITH_RSA | oid::ECDSA_SHA256 => Hash::Sha256,
        oid::SHA384_WITH_RSA | oid::ECDSA_SHA384 => Hash::Sha384,
        oid::SHA512_WITH_RSA | oid::ECDSA_SHA512 => Hash::Sha512,
        oid::RSASSA_PSS => pss_hash(algorithm.params.as_deref()),
        oid::RSA_ENCRYPTION | oid::EC_PUBLIC_KEY => digest.unwrap_or(Hash::Sha256),
        other => {
            return Err(CryptoError(format!(
                "unsupported signature algorithm {other}"
            )));
        }
    };
    let pss = algorithm.oid == oid::RSASSA_PSS;
    let verifier: &'static dyn VerificationAlgorithm = match (kind, hash, pss) {
        (KeyKind::Rsa, Hash::Sha256, false) => &signature::RSA_PKCS1_2048_8192_SHA256,
        (KeyKind::Rsa, Hash::Sha384, false) => &signature::RSA_PKCS1_2048_8192_SHA384,
        (KeyKind::Rsa, Hash::Sha512, false) => &signature::RSA_PKCS1_2048_8192_SHA512,
        (KeyKind::Rsa, Hash::Sha256, true) => &signature::RSA_PSS_2048_8192_SHA256,
        (KeyKind::Rsa, Hash::Sha384, true) => &signature::RSA_PSS_2048_8192_SHA384,
        (KeyKind::Rsa, Hash::Sha512, true) => &signature::RSA_PSS_2048_8192_SHA512,
        (KeyKind::EcP256, Hash::Sha256, _) => &signature::ECDSA_P256_SHA256_ASN1,
        (KeyKind::EcP256, Hash::Sha384, _) => &signature::ECDSA_P256_SHA384_ASN1,
        (KeyKind::EcP384, Hash::Sha256, _) => &signature::ECDSA_P384_SHA256_ASN1,
        (KeyKind::EcP384, Hash::Sha384, _) => &signature::ECDSA_P384_SHA384_ASN1,
        _ => {
            return Err(CryptoError(format!(
                "unsupported key and digest: {kind:?} with {hash:?}"
            )));
        }
    };
    UnparsedPublicKey::new(verifier, spki)
        .verify(message, signature)
        .map_err(|_| CryptoError("the signature does not verify".to_owned()))
}

/// The signature algorithm WeldSign writes for a key: SHA-256 with RSA
/// (PKCS #1 v1.5) or ECDSA with SHA-256.
pub fn signature_algorithm_for(spki: &[u8]) -> AlgorithmIdentifier {
    match key_kind(spki) {
        KeyKind::EcP256 | KeyKind::EcP384 => AlgorithmIdentifier {
            oid: oid::ECDSA_SHA256.to_owned(),
            params: None,
        },
        _ => AlgorithmIdentifier {
            oid: oid::SHA256_WITH_RSA.to_owned(),
            params: Some(der::null()),
        },
    }
}
