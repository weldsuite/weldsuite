//! Virus scanning of files: the port behind WeldMail's inbound attachment
//! scan (`weldsuite-mail-inbound`'s `threats`). On Kubernetes it is clamd
//! (`ClamdScanner` in `weldsuite-adapters-oss`, the chart's `clamav`
//! Deployment). Global never scanned attachments.
//!
//! Object safe from the start, like [`crate::Identity`]: state holds an
//! `Arc<dyn VirusScanner>`.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use crate::{BoxFuture, PortError};

/// What the scanner said about one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanVerdict {
    /// Nothing found.
    Clean,
    /// Malware, by the scanner's signature name (`Win.Test.EICAR_HDB-1`).
    Infected { signature: String },
    /// The scanner answered but could not scan this file (a limit, a
    /// format it cannot read). Retrying would give the same answer.
    Unscannable { reason: String },
}

/// Scans files. `Err` means the scanner could not be reached or broke off:
/// the caller keeps the file locked and asks again later.
pub trait VirusScanner: Send + Sync {
    fn scan<'a>(&'a self, bytes: &'a [u8]) -> BoxFuture<'a, Result<ScanVerdict, PortError>>;
}

/// The EICAR test file: every scanner reports it, and [`FakeScanner`] does too.
pub const EICAR: &[u8] = br"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/// [`VirusScanner`] double: infected when the bytes hold [`EICAR`], clean
/// otherwise; unreachable while [`FakeScanner::set_available`] says so.
/// Counts its scans.
#[derive(Debug)]
pub struct FakeScanner {
    available: AtomicBool,
    scans: AtomicUsize,
}

impl Default for FakeScanner {
    fn default() -> Self {
        Self {
            available: AtomicBool::new(true),
            scans: AtomicUsize::new(0),
        }
    }
}

impl FakeScanner {
    /// The signature [`FakeScanner`] reports for [`EICAR`] (clamd's name).
    pub const EICAR_SIGNATURE: &'static str = "Eicar-Signature";

    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the next scans reach the "scanner".
    pub fn set_available(&self, available: bool) {
        self.available.store(available, Ordering::SeqCst);
    }

    /// How many scans were asked for, reachable or not.
    pub fn scans(&self) -> usize {
        self.scans.load(Ordering::SeqCst)
    }
}

impl VirusScanner for FakeScanner {
    fn scan<'a>(&'a self, bytes: &'a [u8]) -> BoxFuture<'a, Result<ScanVerdict, PortError>> {
        self.scans.fetch_add(1, Ordering::SeqCst);
        let result = if !self.available.load(Ordering::SeqCst) {
            Err(PortError::backend("scanner unavailable"))
        } else if bytes.windows(EICAR.len()).any(|w| w == EICAR) {
            Ok(ScanVerdict::Infected {
                signature: Self::EICAR_SIGNATURE.to_owned(),
            })
        } else {
            Ok(ScanVerdict::Clean)
        };
        Box::pin(std::future::ready(result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_double_finds_eicar_and_can_be_down() {
        let scanner = FakeScanner::new();
        let mut file = b"hello ".to_vec();
        file.extend_from_slice(EICAR);
        assert_eq!(
            scanner.scan(&file).await.ok(),
            Some(ScanVerdict::Infected {
                signature: FakeScanner::EICAR_SIGNATURE.to_owned()
            })
        );
        assert_eq!(scanner.scan(b"fine").await.ok(), Some(ScanVerdict::Clean));
        scanner.set_available(false);
        assert!(scanner.scan(b"fine").await.is_err());
        assert_eq!(scanner.scans(), 3);
    }
}
