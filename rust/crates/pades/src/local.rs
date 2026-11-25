//! A throwaway certificate authority and timestamp authority in process,
//! for development installs (`SIGN_TRUST_MODE=local`) and tests. It issues
//! ECDSA P-256 certificates that look like the real thing (QC statements
//! included, so the "qualified" paths run) but chain to a root nobody
//! trusts, made fresh each time the process starts. Never for production.

use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use aws_lc_rs::signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, KeyPair};
use time::{Duration, OffsetDateTime};

use crate::cms::{self, SignedDataParts};
use crate::crypto::{self, AlgorithmIdentifier, Hash};
use crate::der;
use crate::oid;
use crate::tsp::TspError;
use crate::x509::{CertError, Certificate};

/// The test TSA's policy (an OID under the documentation arc).
pub const LOCAL_TSA_POLICY: &str = "1.3.6.1.4.1.0.1";

/// A key and its certificate, with the chain above it.
pub struct LocalIdentity {
    pub certificate: Certificate,
    pub chain: Vec<Certificate>,
    key: EcdsaKeyPair,
}

impl std::fmt::Debug for LocalIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalIdentity")
            .field("subject", &self.certificate.subject.display())
            .finish_non_exhaustive()
    }
}

impl LocalIdentity {
    /// ECDSA with SHA-256 over `data`, DER encoded.
    pub fn sign(&self, data: &[u8]) -> Result<Vec<u8>, CertError> {
        self.key
            .sign(&SystemRandom::new(), data)
            .map(|signature| signature.as_ref().to_vec())
            .map_err(|_| CertError("signing failed".to_owned()))
    }
}

/// What a certificate is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// A natural person's signing certificate.
    Signer { qualified: bool },
    /// A legal person's seal certificate.
    Seal { qualified: bool },
    /// A timestamp authority.
    Tsa,
}

fn random(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    let _ = SystemRandom::new().fill(&mut bytes);
    if let Some(first) = bytes.first_mut() {
        *first &= 0x7F;
        *first |= 0x01;
    }
    bytes
}

fn new_key() -> Result<EcdsaKeyPair, CertError> {
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &SystemRandom::new())
        .map_err(|_| CertError("key generation failed".to_owned()))?;
    EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref())
        .map_err(|_| CertError("key generation failed".to_owned()))
}

fn spki(key: &EcdsaKeyPair) -> Vec<u8> {
    der::sequence([
        der::sequence([der::oid(oid::EC_PUBLIC_KEY), der::oid(oid::CURVE_P256)]),
        der::bit_string(key.public_key().as_ref()),
    ])
}

fn key_id(key: &EcdsaKeyPair) -> Vec<u8> {
    Hash::Sha1.digest(key.public_key().as_ref())
}

/// A name from `(oid, value)` pairs; the country as a `PrintableString`.
pub fn name(attributes: &[(&str, &str)]) -> Vec<u8> {
    der::sequence(attributes.iter().map(|(kind, value)| {
        let value = if *kind == oid::COUNTRY {
            der::printable_string(value)
        } else {
            der::utf8_string(value)
        };
        der::set_of(vec![der::sequence([der::oid(kind), value])])
    }))
}

fn extension(kind: &str, critical: bool, value: &[u8]) -> Vec<u8> {
    let mut parts = vec![der::oid(kind)];
    if critical {
        parts.push(der::boolean(true));
    }
    parts.push(der::octet_string(value));
    der::sequence(parts)
}

/// `KeyUsage` bits (first byte), with the count of unused bits.
fn key_usage(bits: u8, unused: u8) -> Vec<u8> {
    der::tlv(der::BIT_STRING, &[unused, bits])
}

struct Issue<'a> {
    subject: Vec<u8>,
    issuer: Vec<u8>,
    key: &'a EcdsaKeyPair,
    issuer_key: &'a EcdsaKeyPair,
    extensions: Vec<Vec<u8>>,
    days: i64,
}

fn certificate(issue: &Issue<'_>) -> Result<Certificate, CertError> {
    let now = OffsetDateTime::now_utc();
    let tbs = der::sequence([
        der::explicit(0, &der::integer(2)),
        der::integer_unsigned(&random(16)),
        der::algorithm(oid::ECDSA_SHA256, false),
        issue.issuer.clone(),
        der::sequence([
            der::utc_time(now - Duration::hours(1)),
            der::utc_time(now + Duration::days(issue.days)),
        ]),
        issue.subject.clone(),
        spki(issue.key),
        der::explicit(3, &der::sequence(issue.extensions.clone())),
    ]);
    let signature = issue
        .issuer_key
        .sign(&SystemRandom::new(), &tbs)
        .map_err(|_| CertError("signing failed".to_owned()))?;
    let cert = der::sequence([
        tbs,
        der::algorithm(oid::ECDSA_SHA256, false),
        der::bit_string(signature.as_ref()),
    ]);
    Certificate::from_der(&cert)
}

/// A root that issues test certificates.
pub struct LocalCa {
    root: LocalIdentity,
}

impl std::fmt::Debug for LocalCa {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalCa").finish_non_exhaustive()
    }
}

impl LocalCa {
    pub fn new(common_name: &str) -> Result<Self, CertError> {
        let key = new_key()?;
        let subject = name(&[
            (oid::COUNTRY, "NL"),
            (oid::ORGANIZATION, "WeldSign test CA (not trusted)"),
            (oid::COMMON_NAME, common_name),
        ]);
        let ski = key_id(&key);
        let certificate = certificate(&Issue {
            subject: subject.clone(),
            issuer: subject,
            key: &key,
            issuer_key: &key,
            extensions: vec![
                extension(
                    oid::BASIC_CONSTRAINTS,
                    true,
                    &der::sequence([der::boolean(true)]),
                ),
                extension(oid::KEY_USAGE, true, &key_usage(0x06, 1)),
                extension(oid::SUBJECT_KEY_ID, false, &der::octet_string(&ski)),
            ],
            days: 3650,
        })?;
        Ok(Self {
            root: LocalIdentity {
                certificate,
                chain: Vec::new(),
                key,
            },
        })
    }

    pub fn root(&self) -> &Certificate {
        &self.root.certificate
    }

    /// A certificate for `subject` (`(oid, value)` pairs).
    pub fn issue(
        &self,
        subject: &[(&str, &str)],
        profile: Profile,
    ) -> Result<LocalIdentity, CertError> {
        let key = new_key()?;
        let mut extensions = vec![
            extension(oid::BASIC_CONSTRAINTS, true, &der::sequence(Vec::new())),
            extension(
                oid::SUBJECT_KEY_ID,
                false,
                &der::octet_string(&key_id(&key)),
            ),
            extension(
                oid::AUTHORITY_KEY_ID,
                false,
                &der::sequence([der::tlv(der::context(0, false), &key_id(&self.root.key))]),
            ),
        ];
        let qc = |kind: &str| {
            extension(
                oid::QC_STATEMENTS,
                false,
                &der::sequence([
                    der::sequence([der::oid(oid::QC_COMPLIANCE)]),
                    der::sequence([der::oid(oid::QC_SSCD)]),
                    der::sequence([der::oid(oid::QC_TYPE), der::sequence([der::oid(kind)])]),
                ]),
            )
        };
        match profile {
            Profile::Signer { qualified } => {
                extensions.push(extension(oid::KEY_USAGE, true, &key_usage(0xC0, 6)));
                if qualified {
                    extensions.push(qc(oid::QCT_ESIGN));
                }
            }
            Profile::Seal { qualified } => {
                extensions.push(extension(oid::KEY_USAGE, true, &key_usage(0xC0, 6)));
                if qualified {
                    extensions.push(qc(oid::QCT_ESEAL));
                }
            }
            Profile::Tsa => {
                extensions.push(extension(oid::KEY_USAGE, true, &key_usage(0x80, 7)));
                extensions.push(extension(
                    oid::EXT_KEY_USAGE,
                    true,
                    &der::sequence([der::oid(oid::KP_TIME_STAMPING)]),
                ));
            }
        }
        let certificate = certificate(&Issue {
            subject: name(subject),
            issuer: self.root.certificate.subject.der.clone(),
            key: &key,
            issuer_key: &self.root.key,
            extensions,
            days: 825,
        })?;
        Ok(LocalIdentity {
            certificate,
            chain: vec![self.root.certificate.clone()],
            key,
        })
    }
}

/// A timestamp authority on a [`LocalCa`] certificate.
#[derive(Debug)]
pub struct LocalTsa {
    identity: LocalIdentity,
}

impl LocalTsa {
    pub fn new(ca: &LocalCa) -> Result<Self, CertError> {
        Ok(Self {
            identity: ca.issue(
                &[
                    (oid::COUNTRY, "NL"),
                    (oid::ORGANIZATION, "WeldSign test CA (not trusted)"),
                    (oid::COMMON_NAME, "WeldSign test TSA"),
                ],
                Profile::Tsa,
            )?,
        })
    }

    pub fn certificate(&self) -> &Certificate {
        &self.identity.certificate
    }

    /// A token for a SHA-256 `digest`.
    pub fn token(&self, digest: &[u8]) -> Result<Vec<u8>, TspError> {
        let info = der::sequence([
            der::integer(1),
            der::oid(LOCAL_TSA_POLICY),
            der::sequence([der::algorithm(oid::SHA256, true), der::octet_string(digest)]),
            der::integer_unsigned(&random(8)),
            der::generalized_time(OffsetDateTime::now_utc()),
        ]);
        let cert = &self.identity.certificate;
        let signed_attributes = cms::signed_attributes(&crypto::sha256(&info), cert, oid::TST_INFO);
        let signature = self
            .identity
            .sign(&signed_attributes)
            .map_err(|e| TspError(e.0))?;
        Ok(SignedDataParts {
            signed_attributes,
            signature_algorithm: AlgorithmIdentifier {
                oid: oid::ECDSA_SHA256.to_owned(),
                params: None,
            },
            signature,
            signer: cert.clone(),
            chain: self.identity.chain.clone(),
            unsigned_attributes: Vec::new(),
            content: Some((oid::TST_INFO.to_owned(), info)),
        }
        .encode())
    }

    /// Answer a `TimeStampReq` with a `TimeStampResp`.
    pub fn respond(&self, request: &[u8]) -> Result<Vec<u8>, TspError> {
        let req = der::parse_one(request)?.expect(der::SEQUENCE)?;
        let mut reader = req.reader();
        reader.next()?;
        let mut imprint = reader.next()?.expect(der::SEQUENCE)?.reader();
        imprint.next()?;
        let digest = imprint.next()?.expect(der::OCTET_STRING)?.content.to_vec();
        let token = self.token(&digest)?;
        Ok(der::sequence([der::sequence([der::integer(0)]), token]))
    }
}
