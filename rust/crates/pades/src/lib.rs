//! PAdES for WeldSign (plan `weldsuite-documentation/plans/weldsign-eidas.md`,
//! ADRs SIGN-006 to SIGN-009): electronic signatures, seals and timestamps
//! inside PDFs, at the baseline levels of ETSI EN 319 142-1.
//!
//! Pure and synchronous: no network, no storage. Whoever holds a key (a QTSP
//! over the CSC API, the install's seal, [`local`] in tests) signs the bytes
//! this crate hands out, and a TSA stamps the digests it names.
//!
//! - [`der`], [`x509`], [`crypto`]: reading and writing the ASN.1 involved,
//!   and checking signatures with `aws-lc-rs`.
//! - [`cms`]: CAdES signed data; [`tsp`]: RFC 3161; [`ocsp`]: RFC 6960.
//! - [`pdf`]: incremental revisions, form fields, signature placeholders,
//!   the DSS, and finding signatures again.
//! - [`signing`]: the steps from B-B to B-LTA; [`verify`]: checking a file.

pub mod cms;
pub mod crypto;
pub mod der;
pub mod local;
pub mod ocsp;
pub mod oid;
pub mod pdf;
pub mod signing;
pub mod tsp;
pub mod verify;
pub mod x509;

pub use crypto::Hash;
pub use pdf::{FieldKind, ObjectSink, PdfError, Prepared, Revision, SignatureKind, SignatureSpec};
pub use signing::{
    DOCUMENT_TIMESTAMP_SIZE, PendingSignature, SIGNATURE_SIZE, ValidationData, add_validation_data,
    prepare_document_timestamp, prepare_signature,
};
pub use verify::{SignatureReport, verify_pdf};
pub use x509::Certificate;
