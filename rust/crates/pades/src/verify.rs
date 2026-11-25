//! Checking the signatures in a PDF: each one's byte range digest, its CMS
//! signature, its timestamps, and the chain its certificate sits in. This
//! is not a full ETSI EN 319 102-1 validation (no trusted lists, no
//! revocation checks); it is what WeldSign uses to check what it was handed
//! before keeping it, and what the tests assert. EU DSS does the full
//! validation in CI.

use time::OffsetDateTime;

use crate::cms;
use crate::pdf::{self, PdfResult};
use crate::tsp::{self, Timestamp};
use crate::x509::{self, Certificate};

/// What one signature or document timestamp turned out to be.
#[derive(Debug, Clone)]
pub struct SignatureReport {
    pub field_name: Option<String>,
    pub document_timestamp: bool,
    /// The signer's certificate (the TSA's for a document timestamp).
    pub signer: Option<Certificate>,
    /// From the signer up, as far as the certificates in the file reach.
    pub chain: Vec<Certificate>,
    /// A signature timestamp, or the document timestamp itself.
    pub timestamp: Option<Timestamp>,
    /// Where the revision it signs ends.
    pub covers: usize,
    /// The bytes it covers are unchanged and the signature verifies.
    pub intact: bool,
    pub error: Option<String>,
}

impl SignatureReport {
    /// A qualified certificate with its key in a QSCD.
    pub fn qualified(&self) -> bool {
        self.signer
            .as_ref()
            .is_some_and(Certificate::qualified_with_qscd)
    }

    /// When it was made: the timestamp, else nothing provable.
    pub fn time(&self) -> Option<OffsetDateTime> {
        self.timestamp.as_ref().map(|t| t.time)
    }
}

fn check(bytes: &[u8], found: &pdf::FoundSignature) -> Result<SignatureReport, String> {
    let mut report = SignatureReport {
        field_name: found.field_name.clone(),
        document_timestamp: found.document_timestamp,
        signer: None,
        chain: Vec::new(),
        timestamp: None,
        covers: found.covers(),
        intact: false,
        error: None,
    };
    if found.document_timestamp {
        let timestamp = tsp::verify_token(&found.contents, |hash| {
            found.digest(bytes, hash).unwrap_or_default()
        })
        .map_err(|e| e.to_string())?;
        report.signer = Some(timestamp.tsa.clone());
        report.chain = x509::chain_of(&timestamp.tsa, &timestamp.certificates);
        report.timestamp = Some(timestamp);
        report.intact = true;
        return Ok(report);
    }
    let data = cms::parse_signed_data(&found.contents).map_err(|e| e.to_string())?;
    let signer = data.signers.first().ok_or_else(|| "no signer".to_owned())?;
    let cert = signer
        .certificate(&data.certificates)
        .cloned()
        .ok_or_else(|| "the signer's certificate is not in the signature".to_owned())?;
    let digest = found
        .digest(bytes, signer.digest)
        .map_err(|e| e.to_string())?;
    signer.verify(&cert, &digest).map_err(|e| e.to_string())?;
    report.chain = x509::chain_of(&cert, &data.certificates);
    report.signer = Some(cert);
    if let Some(token) = signer.timestamp_tokens().first() {
        let timestamp = tsp::verify_token(token, |hash| hash.digest(&signer.signature))
            .map_err(|e| e.to_string())?;
        report.timestamp = Some(timestamp);
    }
    report.intact = true;
    Ok(report)
}

/// Every signature in `bytes`, oldest first, each checked.
pub fn verify_pdf(bytes: &[u8]) -> PdfResult<Vec<SignatureReport>> {
    let found = pdf::find_signatures(bytes)?;
    Ok(found
        .iter()
        .map(|found| {
            check(bytes, found).unwrap_or_else(|error| SignatureReport {
                field_name: found.field_name.clone(),
                document_timestamp: found.document_timestamp,
                signer: None,
                chain: Vec::new(),
                timestamp: None,
                covers: found.covers(),
                intact: false,
                error: Some(error),
            })
        })
        .collect())
}
