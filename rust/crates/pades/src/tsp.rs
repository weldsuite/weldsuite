//! RFC 3161 timestamps: the request WeldSign sends a TSA, the token it
//! gets back, and checking a token against the digest it should cover.

use std::fmt;

use time::OffsetDateTime;

use crate::cms::{self, CmsError};
use crate::crypto::{AlgorithmIdentifier, Hash};
use crate::der::{self, DerError};
use crate::oid;
use crate::x509::Certificate;

/// Why a timestamp could not be had or does not hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TspError(pub String);

impl fmt::Display for TspError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "timestamp: {}", self.0)
    }
}

impl std::error::Error for TspError {}

impl From<DerError> for TspError {
    fn from(error: DerError) -> Self {
        Self(error.0)
    }
}

impl From<CmsError> for TspError {
    fn from(error: CmsError) -> Self {
        Self(error.0)
    }
}

/// A `TimeStampReq` for a SHA-256 `digest`, asking for the TSA's certificate.
pub fn request(digest: &[u8], nonce: &[u8]) -> Vec<u8> {
    der::sequence([
        der::integer(1),
        der::sequence([der::algorithm(oid::SHA256, true), der::octet_string(digest)]),
        der::integer_unsigned(nonce),
        der::boolean(true),
    ])
}

/// The token out of a `TimeStampResp`; an error when the TSA refused.
pub fn token_from_response(response: &[u8]) -> Result<Vec<u8>, TspError> {
    let len = der::element_len(response)?;
    let mut reader = der::parse_one(&response[..len])?
        .expect(der::SEQUENCE)?
        .reader();
    let status_info = reader.next()?.expect(der::SEQUENCE)?;
    let status = status_info.reader().next()?.as_u64()?;
    // 0 granted, 1 granted with modifications.
    if status > 1 {
        let text = status_info
            .children()?
            .get(1)
            .and_then(|free| free.children().ok())
            .and_then(|texts| texts.first().map(der::Tlv::text))
            .unwrap_or_default();
        return Err(TspError(format!(
            "the TSA refused (status {status}) {text}"
        )));
    }
    let token = reader
        .next()
        .map_err(|_| TspError("the answer holds no token".to_owned()))?;
    Ok(token.raw.to_vec())
}

/// What a checked token says.
#[derive(Debug, Clone)]
pub struct Timestamp {
    pub time: OffsetDateTime,
    pub serial: Vec<u8>,
    pub policy: String,
    /// The TSA's certificate.
    pub tsa: Certificate,
    /// Every certificate in the token.
    pub certificates: Vec<Certificate>,
}

/// Check a token: it is signed by the TSA certificate it carries, and its
/// message imprint is the digest of the timestamped data, which
/// `digest_of` computes with the algorithm the imprint names.
pub fn verify_token(
    token: &[u8],
    digest_of: impl Fn(Hash) -> Vec<u8>,
) -> Result<Timestamp, TspError> {
    let data = cms::parse_signed_data(token)?;
    if data.content_type != oid::TST_INFO {
        return Err(TspError("not a timestamp token".to_owned()));
    }
    let content = data
        .content
        .as_deref()
        .ok_or_else(|| TspError("the token has no TSTInfo".to_owned()))?;
    let info = der::parse_one(content)?.expect(der::SEQUENCE)?;
    let mut reader = info.reader();
    reader.next()?; // version
    let policy = reader.next()?.oid()?;
    let mut imprint = reader.next()?.expect(der::SEQUENCE)?.reader();
    let algorithm = AlgorithmIdentifier::read(imprint.next()?)?;
    let hash = Hash::from_oid(&algorithm.oid)
        .ok_or_else(|| TspError(format!("unsupported imprint digest {}", algorithm.oid)))?;
    let imprinted = imprint.next()?.expect(der::OCTET_STRING)?.content.to_vec();
    let serial = reader.next()?.unsigned_bytes().to_vec();
    let time = reader.next()?.time()?;
    if imprinted != digest_of(hash) {
        return Err(TspError("the token is for different data".to_owned()));
    }
    let signer = data
        .signers
        .first()
        .ok_or_else(|| TspError("the token has no signer".to_owned()))?;
    let tsa = signer
        .certificate(&data.certificates)
        .cloned()
        .ok_or_else(|| TspError("the token does not carry its TSA certificate".to_owned()))?;
    signer.verify(&tsa, &signer.digest.digest(content))?;
    Ok(Timestamp {
        time,
        serial,
        policy,
        tsa,
        certificates: data.certificates,
    })
}
