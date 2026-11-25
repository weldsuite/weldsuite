//! Putting signatures, timestamps and validation material into a PDF, in
//! the order PAdES baseline levels need them:
//!
//! - **B-B**: [`prepare_signature`] gives the bytes to be signed (the CMS
//!   signed attributes); whoever holds the key signs them;
//!   [`PendingSignature::finish`] builds the CMS and embeds it.
//! - **B-T**: a timestamp token over the signature value, passed to `finish`.
//! - **B-LT**: [`add_validation_data`] stores certificates, OCSP answers and
//!   CRLs in the DSS.
//! - **B-LTA**: [`prepare_document_timestamp`] and a token over its digest.

use crate::cms::{self, SignedDataParts};
use crate::crypto::{self, Hash};
use crate::oid;
use crate::pdf::{PdfError, PdfResult, Prepared, Revision, SignatureSpec};
use crate::x509::Certificate;

/// Bytes reserved for a signer's or seal's CMS: the chain and a timestamp
/// token with its own chain fit with room to spare.
pub const SIGNATURE_SIZE: usize = 32 * 1024;
/// Bytes reserved for a document timestamp token.
pub const DOCUMENT_TIMESTAMP_SIZE: usize = 16 * 1024;

/// A signature waiting for its value.
#[derive(Debug, Clone)]
pub struct PendingSignature {
    pub prepared: Prepared,
    /// The CMS signed attributes: what the key signs.
    pub signed_attributes: Vec<u8>,
    pub signer: Certificate,
    pub chain: Vec<Certificate>,
}

impl PendingSignature {
    /// The data to be signed.
    pub fn data_to_be_signed(&self) -> &[u8] {
        &self.signed_attributes
    }

    /// Its SHA-256: what a remote signing service (CSC `signHash`) signs.
    pub fn hash_to_be_signed(&self) -> Vec<u8> {
        crypto::sha256(&self.signed_attributes)
    }

    /// Wrap the signature value (and a timestamp token over it) in CMS and
    /// write it into the file.
    pub fn finish(self, signature: &[u8], timestamp_token: Option<&[u8]>) -> PdfResult<Vec<u8>> {
        crypto::verify(
            &self.signer.spki,
            &crypto::signature_algorithm_for(&self.signer.spki),
            Some(Hash::Sha256),
            &self.signed_attributes,
            signature,
        )
        .map_err(|e| PdfError(format!("the returned signature does not verify: {e}")))?;
        let cms = SignedDataParts {
            signature_algorithm: crypto::signature_algorithm_for(&self.signer.spki),
            signed_attributes: self.signed_attributes,
            signature: signature.to_vec(),
            signer: self.signer,
            chain: self.chain,
            unsigned_attributes: timestamp_token
                .map(|token| vec![cms::signature_timestamp_attribute(token)])
                .unwrap_or_default(),
            content: None,
        }
        .encode();
        self.prepared.embed(&cms)
    }
}

/// Start a CAdES signature by `signer` (with `chain` above it) in a new
/// revision of `revision`.
pub fn prepare_signature(
    revision: Revision,
    spec: &SignatureSpec,
    signer: &Certificate,
    chain: &[Certificate],
) -> PdfResult<PendingSignature> {
    let prepared = revision.sign(spec)?;
    let digest = prepared.digest(Hash::Sha256);
    let signed_attributes = cms::signed_attributes(&digest, signer, oid::DATA);
    Ok(PendingSignature {
        prepared,
        signed_attributes,
        signer: signer.clone(),
        chain: chain.to_vec(),
    })
}

/// The digest a signature timestamp covers: SHA-256 of the signature value.
pub fn signature_timestamp_digest(signature: &[u8]) -> Vec<u8> {
    crypto::sha256(signature)
}

/// Start a document timestamp; embed the TSA's token for
/// `prepared.digest(Hash::Sha256)` with [`Prepared::embed`].
pub fn prepare_document_timestamp(revision: Revision, field_name: &str) -> PdfResult<Prepared> {
    revision.sign(&SignatureSpec {
        field_name: field_name.to_owned(),
        field: None,
        kind: crate::pdf::SignatureKind::DocumentTimestamp,
        contents_size: DOCUMENT_TIMESTAMP_SIZE,
    })
}

/// Validation material for the DSS.
#[derive(Debug, Clone, Default)]
pub struct ValidationData {
    pub certificates: Vec<Vec<u8>>,
    pub ocsps: Vec<Vec<u8>>,
    pub crls: Vec<Vec<u8>>,
}

impl ValidationData {
    pub fn is_empty(&self) -> bool {
        self.certificates.is_empty() && self.ocsps.is_empty() && self.crls.is_empty()
    }
}

/// Append the DSS (B-LT).
pub fn add_validation_data(pdf: Vec<u8>, data: &ValidationData) -> PdfResult<Vec<u8>> {
    if data.is_empty() {
        return Ok(pdf);
    }
    let mut revision = Revision::open(pdf)?;
    revision.add_dss(&data.certificates, &data.ocsps, &data.crls)?;
    revision.write()
}
