//! Reading X.509 certificates: who they name, who issued them, their key,
//! where to ask about revocation, and whether they are qualified (the eIDAS
//! QC statements).

use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use time::OffsetDateTime;

use crate::crypto::{self, AlgorithmIdentifier, CryptoError};
use crate::der::{self, DerError, Tlv};
use crate::oid;

/// Why a certificate could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertError(pub String);

impl fmt::Display for CertError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "certificate: {}", self.0)
    }
}

impl std::error::Error for CertError {}

impl From<DerError> for CertError {
    fn from(error: DerError) -> Self {
        Self(error.0)
    }
}

/// A distinguished name: its DER (to compare and to copy) and its attributes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Name {
    pub der: Vec<u8>,
    /// `(oid, value)` in order.
    pub attributes: Vec<(String, String)>,
}

impl Name {
    fn read(tlv: Tlv<'_>) -> Result<Self, DerError> {
        let tlv = tlv.expect(der::SEQUENCE)?;
        let mut attributes = Vec::new();
        for rdn in tlv.children()? {
            for atv in rdn.expect(der::SET)?.children()? {
                let mut reader = atv.expect(der::SEQUENCE)?.reader();
                let kind = reader.next()?.oid()?;
                let value = reader.next()?.text();
                attributes.push((kind, value));
            }
        }
        Ok(Self {
            der: tlv.raw.to_vec(),
            attributes,
        })
    }

    /// The first value of an attribute.
    pub fn get(&self, oid: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(kind, _)| kind == oid)
            .map(|(_, value)| value.as_str())
    }

    /// What a person reads: the common name, else given name and surname,
    /// else the organisation.
    pub fn display(&self) -> String {
        if let Some(cn) = self.get(oid::COMMON_NAME) {
            return cn.to_owned();
        }
        let person = [self.get(oid::GIVEN_NAME), self.get(oid::SURNAME)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        if !person.is_empty() {
            return person;
        }
        self.get(oid::ORGANIZATION).unwrap_or_default().to_owned()
    }
}

/// What the extensions say that WeldSign uses.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "each flag is one certificate extension or QC statement"
)]
pub struct Extensions {
    pub is_ca: bool,
    pub ext_key_usage: Vec<String>,
    pub ocsp_urls: Vec<String>,
    pub ca_issuer_urls: Vec<String>,
    pub crl_urls: Vec<String>,
    pub subject_key_id: Option<Vec<u8>>,
    pub authority_key_id: Option<Vec<u8>>,
    pub policies: Vec<String>,
    /// `QcCompliance`: an EU qualified certificate.
    pub qc_compliance: bool,
    /// `QcSSCD`: its key is in a qualified signature or seal creation device.
    pub qc_sscd: bool,
    /// `QcType`: e-signature, e-seal or website.
    pub qc_types: Vec<String>,
    pub ocsp_no_check: bool,
}

/// A parsed certificate. The DER is kept: it is what goes into CMS and the DSS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Certificate {
    pub der: Vec<u8>,
    tbs: Vec<u8>,
    signature_algorithm: AlgorithmIdentifier,
    signature: Vec<u8>,
    pub serial: Vec<u8>,
    pub issuer: Name,
    pub subject: Name,
    pub not_before: OffsetDateTime,
    pub not_after: OffsetDateTime,
    /// The `SubjectPublicKeyInfo`, DER.
    pub spki: Vec<u8>,
    pub extensions: Extensions,
}

fn uris(general_names: Tlv<'_>) -> Result<Vec<String>, DerError> {
    Ok(general_names
        .children()?
        .into_iter()
        // uniformResourceIdentifier [6] IMPLICIT IA5String
        .filter(|name| name.tag == der::context(6, false))
        .map(|name| name.text())
        .collect())
}

fn read_extensions(tlv: Tlv<'_>) -> Result<Extensions, DerError> {
    let mut out = Extensions::default();
    for extension in tlv.expect(der::SEQUENCE)?.children()? {
        let mut reader = extension.expect(der::SEQUENCE)?.reader();
        let id = reader.next()?.oid()?;
        reader.optional(der::BOOLEAN)?;
        let value = reader.next()?.expect(der::OCTET_STRING)?;
        let inner = der::parse_one(value.content)?;
        match id.as_str() {
            oid::BASIC_CONSTRAINTS => {
                out.is_ca = inner
                    .reader()
                    .optional(der::BOOLEAN)?
                    .is_some_and(|b| b.as_bool());
            }
            oid::EXT_KEY_USAGE => {
                for usage in inner.children()? {
                    out.ext_key_usage.push(usage.oid()?);
                }
            }
            oid::SUBJECT_KEY_ID => out.subject_key_id = Some(inner.content.to_vec()),
            oid::AUTHORITY_KEY_ID => {
                out.authority_key_id = inner
                    .reader()
                    .optional(der::context(0, false))?
                    .map(|id| id.content.to_vec());
            }
            oid::AUTHORITY_INFO_ACCESS => {
                for access in inner.children()? {
                    let mut reader = access.reader();
                    let method = reader.next()?.oid()?;
                    let location = reader.next()?;
                    if location.tag != der::context(6, false) {
                        continue;
                    }
                    match method.as_str() {
                        oid::AD_OCSP => out.ocsp_urls.push(location.text()),
                        oid::AD_CA_ISSUERS => out.ca_issuer_urls.push(location.text()),
                        _ => {}
                    }
                }
            }
            oid::CRL_DISTRIBUTION_POINTS => {
                for point in inner.children()? {
                    let Some(name) = point.reader().optional(der::context(0, true))? else {
                        continue;
                    };
                    // fullName [0] GeneralNames
                    if let Some(full) = name.reader().optional(der::context(0, true))? {
                        out.crl_urls.extend(uris(full)?);
                    }
                }
            }
            oid::CERTIFICATE_POLICIES => {
                for policy in inner.children()? {
                    out.policies.push(policy.reader().next()?.oid()?);
                }
            }
            oid::QC_STATEMENTS => {
                for statement in inner.children()? {
                    let mut reader = statement.reader();
                    match reader.next()?.oid()?.as_str() {
                        oid::QC_COMPLIANCE => out.qc_compliance = true,
                        oid::QC_SSCD => out.qc_sscd = true,
                        oid::QC_TYPE => {
                            if let Some(types) = reader.optional(der::SEQUENCE)? {
                                for kind in types.children()? {
                                    out.qc_types.push(kind.oid()?);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            oid::OCSP_NOCHECK => out.ocsp_no_check = true,
            _ => {}
        }
    }
    Ok(out)
}

impl Certificate {
    pub fn from_der(bytes: &[u8]) -> Result<Self, CertError> {
        let cert = der::parse_one(bytes)?.expect(der::SEQUENCE)?;
        let mut outer = cert.reader();
        let tbs = outer.next()?.expect(der::SEQUENCE)?;
        let signature_algorithm = AlgorithmIdentifier::read(outer.next()?)?;
        let signature = outer.next()?.bit_string()?.to_vec();

        let mut reader = tbs.reader();
        reader.optional(der::context(0, true))?;
        let serial = reader
            .next()?
            .expect(der::INTEGER)?
            .unsigned_bytes()
            .to_vec();
        reader.next()?; // signature algorithm, again
        let issuer = Name::read(reader.next()?)?;
        let mut validity = reader.next()?.expect(der::SEQUENCE)?.reader();
        let not_before = validity.next()?.time()?;
        let not_after = validity.next()?.time()?;
        let subject = Name::read(reader.next()?)?;
        let spki = reader.next()?.expect(der::SEQUENCE)?.raw.to_vec();
        reader.optional(der::context(1, false))?;
        reader.optional(der::context(2, false))?;
        let extensions = match reader.optional(der::context(3, true))? {
            Some(wrapper) => read_extensions(der::parse_one(wrapper.content)?)?,
            None => Extensions::default(),
        };
        Ok(Self {
            der: bytes.to_vec(),
            tbs: tbs.raw.to_vec(),
            signature_algorithm,
            signature,
            serial,
            issuer,
            subject,
            not_before,
            not_after,
            spki,
            extensions,
        })
    }

    /// Every certificate in a PEM text, in order.
    pub fn from_pem(pem: &str) -> Result<Vec<Self>, CertError> {
        let mut out = Vec::new();
        let mut body: Option<String> = None;
        for line in pem.lines().map(str::trim) {
            if line.starts_with("-----BEGIN CERTIFICATE") {
                body = Some(String::new());
            } else if line.starts_with("-----END CERTIFICATE") {
                let text = body.take().unwrap_or_default();
                let bytes = STANDARD
                    .decode(text.as_bytes())
                    .map_err(|e| CertError(format!("pem: {e}")))?;
                out.push(Self::from_der(&bytes)?);
            } else if let Some(text) = body.as_mut() {
                text.push_str(line);
            }
        }
        Ok(out)
    }

    /// The certificate as PEM.
    pub fn to_pem(&self) -> String {
        let text = STANDARD.encode(&self.der);
        let mut out = String::from("-----BEGIN CERTIFICATE-----\n");
        for chunk in text.as_bytes().chunks(64) {
            out.push_str(&String::from_utf8_lossy(chunk));
            out.push('\n');
        }
        out.push_str("-----END CERTIFICATE-----\n");
        out
    }

    /// Whether `issuer` signed this certificate.
    pub fn verify_issued_by(&self, issuer: &Certificate) -> Result<(), CryptoError> {
        if self.issuer.der != issuer.subject.der {
            return Err(CryptoError("issuer name does not match".to_owned()));
        }
        crypto::verify(
            &issuer.spki,
            &self.signature_algorithm,
            None,
            &self.tbs,
            &self.signature,
        )
    }

    pub fn is_self_issued(&self) -> bool {
        self.issuer.der == self.subject.der
    }

    pub fn valid_at(&self, at: OffsetDateTime) -> bool {
        self.not_before <= at && at <= self.not_after
    }

    /// An EU qualified certificate (`QcCompliance`).
    pub fn qualified(&self) -> bool {
        self.extensions.qc_compliance
    }

    /// Qualified, with its key in a QSCD: what a qualified signature or seal needs.
    pub fn qualified_with_qscd(&self) -> bool {
        self.extensions.qc_compliance && self.extensions.qc_sscd
    }

    /// The serial number as uppercase hex.
    pub fn serial_hex(&self) -> String {
        self.serial.iter().fold(
            String::with_capacity(self.serial.len() * 2),
            |mut out, b| {
                use std::fmt::Write as _;
                let _ = write!(out, "{b:02X}");
                out
            },
        )
    }
}

/// Order `certs` from `leaf` up to the last issuer present (or a self-issued
/// root), each one verified as issued by the next. Stops at the first gap.
pub fn chain_of(leaf: &Certificate, certs: &[Certificate]) -> Vec<Certificate> {
    let mut chain = vec![leaf.clone()];
    while chain.len() < 10 {
        let current = chain.last().cloned().unwrap_or_else(|| leaf.clone());
        if current.is_self_issued() {
            break;
        }
        let Some(issuer) = certs.iter().find(|candidate| {
            candidate.der != current.der && current.verify_issued_by(candidate).is_ok()
        }) else {
            break;
        };
        chain.push(issuer.clone());
    }
    chain
}
