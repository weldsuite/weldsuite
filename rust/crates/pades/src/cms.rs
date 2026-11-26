//! CMS signed data (RFC 5652) in the CAdES baseline shape PAdES wants
//! (ETSI EN 319 122-1): detached, SHA-256, signed attributes `content-type`,
//! `message-digest` and `signing-certificate-v2`, no `signing-time` (PAdES
//! keeps the claimed time in the signature dictionary's `/M`), and an
//! optional signature timestamp as an unsigned attribute (B-T).
//!
//! The signature value is made elsewhere (a QTSP, the seal credential, the
//! local test CA), so building is two steps: [`signed_attributes`] gives the
//! bytes to be signed, [`SignedDataParts::encode`] wraps the value.

use std::fmt;

use crate::crypto::{self, AlgorithmIdentifier, Hash};
use crate::der::{self, DerError, Reader};
use crate::oid;
use crate::x509::{CertError, Certificate};

/// Why signed data could not be read or does not verify.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CmsError(pub String);

impl fmt::Display for CmsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "cms: {}", self.0)
    }
}

impl std::error::Error for CmsError {}

impl From<DerError> for CmsError {
    fn from(error: DerError) -> Self {
        Self(error.0)
    }
}

impl From<CertError> for CmsError {
    fn from(error: CertError) -> Self {
        Self(error.0)
    }
}

impl From<crypto::CryptoError> for CmsError {
    fn from(error: crypto::CryptoError) -> Self {
        Self(error.0)
    }
}

fn attribute(kind: &str, value: Vec<u8>) -> Vec<u8> {
    der::sequence([der::oid(kind), der::set_of(vec![value])])
}

/// `SigningCertificateV2` naming `cert` by its SHA-256 and issuer and serial.
fn signing_certificate_v2(cert: &Certificate) -> Vec<u8> {
    // GeneralNames { directoryName [4] EXPLICIT Name }
    let issuer = der::sequence([der::explicit(4, &cert.issuer.der)]);
    let issuer_serial = der::sequence([issuer, der::integer_unsigned(&cert.serial)]);
    // hashAlgorithm is left out: SHA-256 is its default.
    let cert_id = der::sequence([der::octet_string(&crypto::sha256(&cert.der)), issuer_serial]);
    der::sequence([der::sequence([cert_id])])
}

/// The signed attributes for content whose SHA-256 is `content_digest`,
/// signed by `cert`, of content type `content_type` (id-data for a PDF,
/// id-ct-`TSTInfo` for a timestamp token). The SET encoding: what is hashed
/// and signed.
pub fn signed_attributes(content_digest: &[u8], cert: &Certificate, content_type: &str) -> Vec<u8> {
    der::set_of(vec![
        attribute(oid::CONTENT_TYPE, der::oid(content_type)),
        attribute(oid::MESSAGE_DIGEST, der::octet_string(content_digest)),
        attribute(oid::SIGNING_CERTIFICATE_V2, signing_certificate_v2(cert)),
    ])
}

/// The unsigned attribute holding a signature timestamp token.
pub fn signature_timestamp_attribute(token: &[u8]) -> Vec<u8> {
    attribute(oid::SIGNATURE_TIMESTAMP, token.to_vec())
}

/// Everything a `SignedData` is built from.
#[derive(Debug, Clone)]
pub struct SignedDataParts {
    /// The SET from [`signed_attributes`].
    pub signed_attributes: Vec<u8>,
    pub signature_algorithm: AlgorithmIdentifier,
    pub signature: Vec<u8>,
    pub signer: Certificate,
    /// The rest of the chain (issuers), without the signer.
    pub chain: Vec<Certificate>,
    /// Encoded attributes, e.g. [`signature_timestamp_attribute`].
    pub unsigned_attributes: Vec<Vec<u8>>,
    /// Encapsulated content (`eContentType`, `eContent`); `None` for detached
    /// id-data, as a PDF signature is.
    pub content: Option<(String, Vec<u8>)>,
}

impl SignedDataParts {
    /// The `ContentInfo` with the `SignedData`.
    pub fn encode(&self) -> Vec<u8> {
        let digest_algorithm = der::algorithm(oid::SHA256, false);
        let encapsulated = match &self.content {
            Some((kind, content)) => der::sequence([
                der::oid(kind),
                der::explicit(0, &der::octet_string(content)),
            ]),
            None => der::sequence([der::oid(oid::DATA)]),
        };
        let mut certs = vec![self.signer.der.clone()];
        certs.extend(self.chain.iter().map(|c| c.der.clone()));
        certs.dedup();
        let certificates = der::tlv(der::context(0, true), &der::set_content(certs));

        // [0] IMPLICIT SignedAttributes: the SET's content under another tag.
        let signed = der::parse_one(&self.signed_attributes)
            .map(|set| set.content.to_vec())
            .unwrap_or_default();
        let mut signer_info = vec![
            der::integer(1),
            der::sequence([
                self.signer.issuer.der.clone(),
                der::integer_unsigned(&self.signer.serial),
            ]),
            digest_algorithm.clone(),
            der::tlv(der::context(0, true), &signed),
            self.signature_algorithm.to_der(),
            der::octet_string(&self.signature),
        ];
        if !self.unsigned_attributes.is_empty() {
            signer_info.push(der::tlv(
                der::context(1, true),
                &der::set_content(self.unsigned_attributes.clone()),
            ));
        }
        let signed_data = der::sequence([
            der::integer(if self.content.is_some() { 3 } else { 1 }),
            der::set_of(vec![digest_algorithm]),
            encapsulated,
            certificates,
            der::set_of(vec![der::sequence(signer_info)]),
        ]);
        der::sequence([der::oid(oid::SIGNED_DATA), der::explicit(0, &signed_data)])
    }
}

/// One signer of parsed signed data.
#[derive(Debug, Clone)]
pub struct SignerInfo {
    pub issuer_der: Vec<u8>,
    pub serial: Vec<u8>,
    pub digest: Hash,
    /// The signed attributes as the SET that was signed.
    pub signed_attributes: Option<Vec<u8>>,
    pub message_digest: Option<Vec<u8>>,
    pub content_type: Option<String>,
    pub signature_algorithm: AlgorithmIdentifier,
    pub signature: Vec<u8>,
    /// `(oid, values)` of the unsigned attributes.
    pub unsigned_attributes: Vec<(String, Vec<Vec<u8>>)>,
}

impl SignerInfo {
    /// The signer's certificate among `certs`.
    pub fn certificate<'a>(&self, certs: &'a [Certificate]) -> Option<&'a Certificate> {
        certs
            .iter()
            .find(|c| c.issuer.der == self.issuer_der && c.serial == self.serial)
    }

    /// Timestamp tokens on the signature value (B-T).
    pub fn timestamp_tokens(&self) -> Vec<&[u8]> {
        self.unsigned_attributes
            .iter()
            .filter(|(kind, _)| kind == oid::SIGNATURE_TIMESTAMP)
            .flat_map(|(_, values)| values.iter().map(Vec::as_slice))
            .collect()
    }

    /// Check the signature: the content digest in the attributes is
    /// `content_digest`, and `cert` signed the attributes.
    pub fn verify(&self, cert: &Certificate, content_digest: &[u8]) -> Result<(), CmsError> {
        let Some(attributes) = &self.signed_attributes else {
            return Err(CmsError("no signed attributes".to_owned()));
        };
        if self.message_digest.as_deref() != Some(content_digest) {
            return Err(CmsError(
                "the content does not match the signed digest".to_owned(),
            ));
        }
        crypto::verify(
            &cert.spki,
            &self.signature_algorithm,
            Some(self.digest),
            attributes,
            &self.signature,
        )?;
        Ok(())
    }
}

/// Parsed signed data.
#[derive(Debug, Clone)]
pub struct SignedData {
    pub certificates: Vec<Certificate>,
    pub signers: Vec<SignerInfo>,
    pub content_type: String,
    /// Encapsulated content, when there is any (a timestamp's `TSTInfo`).
    pub content: Option<Vec<u8>>,
}

fn read_signer(tlv: der::Tlv<'_>) -> Result<SignerInfo, CmsError> {
    let mut reader = tlv.expect(der::SEQUENCE)?.reader();
    reader.next()?; // version
    let sid = reader.next()?;
    let (issuer_der, serial) = if sid.tag == der::SEQUENCE {
        let mut sid = sid.reader();
        let issuer = sid.next()?.raw.to_vec();
        let serial = sid.next()?.unsigned_bytes().to_vec();
        (issuer, serial)
    } else {
        return Err(CmsError(
            "signers named by key identifier are not supported".to_owned(),
        ));
    };
    let digest_algorithm = crypto::AlgorithmIdentifier::read(reader.next()?)?;
    let digest = Hash::from_oid(&digest_algorithm.oid)
        .ok_or_else(|| CmsError(format!("unsupported digest {}", digest_algorithm.oid)))?;
    let mut signed_attributes = None;
    let mut message_digest = None;
    let mut content_type = None;
    if let Some(attributes) = reader.optional(der::context(0, true))? {
        let mut as_set = attributes.raw.to_vec();
        as_set[0] = der::SET;
        signed_attributes = Some(as_set);
        for attribute in attributes.children()? {
            let mut parts = attribute.reader();
            let kind = parts.next()?.oid()?;
            let values = parts.next()?.children()?;
            let Some(value) = values.first() else {
                continue;
            };
            match kind.as_str() {
                oid::MESSAGE_DIGEST => message_digest = Some(value.content.to_vec()),
                oid::CONTENT_TYPE => content_type = Some(value.oid()?),
                _ => {}
            }
        }
    }
    let signature_algorithm = crypto::AlgorithmIdentifier::read(reader.next()?)?;
    let signature = reader.next()?.expect(der::OCTET_STRING)?.content.to_vec();
    let mut unsigned_attributes = Vec::new();
    if let Some(attributes) = reader.optional(der::context(1, true))? {
        for attribute in attributes.children()? {
            let mut parts = attribute.reader();
            let kind = parts.next()?.oid()?;
            let values = parts
                .next()?
                .children()?
                .into_iter()
                .map(|v| v.raw.to_vec())
                .collect();
            unsigned_attributes.push((kind, values));
        }
    }
    Ok(SignerInfo {
        issuer_der,
        serial,
        digest,
        signed_attributes,
        message_digest,
        content_type,
        signature_algorithm,
        signature,
        unsigned_attributes,
    })
}

/// Read a `ContentInfo` holding `SignedData`.
pub fn parse_signed_data(bytes: &[u8]) -> Result<SignedData, CmsError> {
    let len = der::element_len(bytes)?;
    let info = der::parse_one(&bytes[..len])?.expect(der::SEQUENCE)?;
    let mut reader = info.reader();
    if reader.next()?.oid()? != oid::SIGNED_DATA {
        return Err(CmsError("not signed data".to_owned()));
    }
    let wrapper = reader.next()?.expect(der::context(0, true))?;
    let signed = der::parse_one(wrapper.content)?.expect(der::SEQUENCE)?;
    let mut reader: Reader<'_> = signed.reader();
    reader.next()?; // version
    reader.next()?; // digest algorithms
    let mut encapsulated = reader.next()?.expect(der::SEQUENCE)?.reader();
    let content_type = encapsulated.next()?.oid()?;
    let content = match encapsulated.optional(der::context(0, true))? {
        Some(explicit) => Some(der::parse_one(explicit.content)?.content.to_vec()),
        None => None,
    };
    let mut certificates = Vec::new();
    if let Some(certs) = reader.optional(der::context(0, true))? {
        for cert in certs.children()? {
            if cert.tag == der::SEQUENCE {
                certificates.push(Certificate::from_der(cert.raw)?);
            }
        }
    }
    reader.optional(der::context(1, true))?; // CRLs
    let signers = reader
        .next()?
        .expect(der::SET)?
        .children()?
        .into_iter()
        .map(read_signer)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SignedData {
        certificates,
        signers,
        content_type,
        content,
    })
}
