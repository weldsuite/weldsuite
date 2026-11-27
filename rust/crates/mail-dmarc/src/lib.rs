//! DMARC for WeldMail's custom domains on the Kubernetes editions (ADR
//! MAIL-015, `weldsuite-documentation/plans/weldmail-dmarc-reports.md`).
//!
//! Pure code, no I/O:
//!
//! - [`record`]: the record a domain publishes at `_dmarc.<domain>`: its
//!   tags, whether there is exactly one (several make DMARC void, RFC 7489
//!   §6.6.3), and the record WeldMail suggests in its place, with the
//!   install's report address added and the policy kept.
//! - [`archive`]: the XML inside a report's attachment (`.xml.gz`, `.zip`
//!   or `.xml`), with size limits.
//! - [`report`]: an aggregate report (RFC 7489 appendix C, and `DMARCbis`'s
//!   namespaced form) parsed into rows.
//! - [`readiness`]: whether a domain is ready to move from `p=none` to
//!   `quarantine`, and from there to `reject`.
//! - [`sources`]: how the rows of a report are grouped into sending sources.

pub mod archive;
pub mod readiness;
pub mod record;
pub mod report;
pub mod sources;
