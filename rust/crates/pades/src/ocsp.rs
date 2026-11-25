//! OCSP (RFC 6960), only as far as long-term validation needs it: the
//! request for one certificate, and a check that an answer is a successful
//! one saying the certificate is good, before it goes into the DSS.

use std::fmt;

use crate::crypto::Hash;
use crate::der::{self, DerError};
use crate::oid;
use crate::x509::Certificate;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OcspError(pub String);

impl fmt::Display for OcspError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ocsp: {}", self.0)
    }
}

impl std::error::Error for OcspError {}

impl From<DerError> for OcspError {
    fn from(error: DerError) -> Self {
        Self(error.0)
    }
}

/// The issuer's key as OCSP hashes it: the BIT STRING of its public key.
fn issuer_key(issuer: &Certificate) -> Result<Vec<u8>, OcspError> {
    let mut reader = der::parse_one(&issuer.spki)?
        .expect(der::SEQUENCE)?
        .reader();
    reader.next()?;
    Ok(reader.next()?.bit_string()?.to_vec())
}

/// An `OCSPRequest` for `cert`, issued by `issuer` (SHA-1 `CertID`, which
/// every responder answers).
pub fn request(cert: &Certificate, issuer: &Certificate) -> Result<Vec<u8>, OcspError> {
    let cert_id = der::sequence([
        der::algorithm(oid::SHA1, true),
        der::octet_string(&Hash::Sha1.digest(&issuer.subject.der)),
        der::octet_string(&Hash::Sha1.digest(&issuer_key(issuer)?)),
        der::integer_unsigned(&cert.serial),
    ]);
    let request = der::sequence([cert_id]);
    let tbs = der::sequence([der::sequence([request])]);
    Ok(der::sequence([tbs]))
}

/// What a responder said about the certificate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertStatus {
    Good,
    Revoked,
    Unknown,
}

/// Check an `OCSPResponse`: successful, basic, and the status of its first
/// single response.
pub fn status(response: &[u8]) -> Result<CertStatus, OcspError> {
    let mut reader = der::parse_one(response)?.expect(der::SEQUENCE)?.reader();
    let status = reader.next()?.as_u64()?;
    if status != 0 {
        return Err(OcspError(format!("the responder answered status {status}")));
    }
    let bytes = reader.next()?.expect(der::context(0, true))?;
    let mut bytes = der::parse_one(bytes.content)?
        .expect(der::SEQUENCE)?
        .reader();
    if bytes.next()?.oid()? != oid::OCSP_BASIC {
        return Err(OcspError("not a basic OCSP response".to_owned()));
    }
    let basic = bytes.next()?.expect(der::OCTET_STRING)?;
    let basic = der::parse_one(basic.content)?.expect(der::SEQUENCE)?;
    let data = basic.reader().next()?.expect(der::SEQUENCE)?;
    let mut data = data.reader();
    data.optional(der::context(0, true))?; // version
    data.next()?; // responderID
    data.next()?; // producedAt
    let responses = data.next()?.expect(der::SEQUENCE)?;
    let first = responses
        .children()?
        .into_iter()
        .next()
        .ok_or_else(|| OcspError("no single response".to_owned()))?;
    let mut single = first.reader();
    single.next()?; // certID
    let status = single.next()?;
    Ok(match status.tag {
        t if t == der::context(0, false) => CertStatus::Good,
        t if t == der::context(1, true) => CertStatus::Revoked,
        _ => CertStatus::Unknown,
    })
}
