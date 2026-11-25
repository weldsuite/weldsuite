//! Logius Digipoort over WUS: the channel WeldBooks files the Dutch
//! BTW-aangifte, the Opgaaf ICP (Belastingdienst) and the jaarrekening (KvK)
//! through, on the EU and self-hosted editions.
//!
//! - [`config`]: the install's connection from the environment (one
//!   PKIoverheid certificate per install, which sends for every workspace).
//! - [`client`]: `aanleveren` and `getStatussenProces`, signed
//!   ([`envelope`], [`signature`], written as exclusive-canonical XML by
//!   [`xml`]) and sent over mutual TLS.
//! - [`status`]: what a delivery's statuses mean for the filing, the record
//!   a filing keeps, and when to look again.
//! - [`profile`]: the protocol constants with their sources.
//!
//! Without a configured connection the callers keep the TypeScript worker's
//! behaviour without its certificate binding: a simulated submission.

#![allow(
    clippy::doc_markdown,
    reason = "the docs use Dutch and Logius terms (PKIoverheid, KvK, berichtsoort) as words"
)]

pub mod client;
pub mod config;
pub mod envelope;
pub mod profile;
pub mod signature;
pub mod status;
pub mod xml;

pub use client::{Delivered, Delivery, Digipoort, DigipoortError, Identity, StatusEntry};
pub use config::{ConfigError, DigipoortConfig, Mode};
pub use status::{Assessment, Outcome, assess};

/// The due-index kind (`weldsuite_db::due_index`) of workspaces with a
/// delivery whose statuses are still open: `weldsuite cron digipoort-status`
/// opens only those tenants.
pub const SWEEP_KIND: &str = "digipoort_status";

/// The omzetbelastingnummer as Digipoort identifies the belanghebbende: no
/// "NL" prefix, no spaces or dots, upper case (`001000044B37`).
pub fn fiscal_number(vat_number: &str) -> String {
    let compact: String = vat_number
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_uppercase();
    compact
        .strip_prefix("NL")
        .map_or_else(|| compact.clone(), str::to_owned)
}

#[cfg(test)]
mod tests {
    #[test]
    fn strips_the_country_prefix() {
        assert_eq!(super::fiscal_number("NL001000044B37"), "001000044B37");
        assert_eq!(super::fiscal_number("nl 0010.00044.b37"), "001000044B37");
        assert_eq!(super::fiscal_number("001000044B37"), "001000044B37");
    }
}
