//! Sending domains: a DKIM key per domain, sealed at rest, and the pools
//! allowed to sign with it. The server registers a customer's domain through
//! the API (`pools: ["customer"]`); operators register the system domain with
//! `weldsuite mta domains add <domain> --pool system`.
//!
//! A domain that is a subdomain of a registered one (`mail.acme.eu` under
//! `acme.eu`) signs with the parent's key (`d=acme.eu`), which DMARC's
//! relaxed alignment accepts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::crypto::Keys;
use crate::dkim::{self, Signer};
use crate::store::{DomainRow, Store, StoreError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DkimRecord {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub value: String,
}

/// A domain as the API answers it (the contract's `Domain`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainView {
    pub domain: String,
    pub selector: String,
    pub algorithm: String,
    pub public_key: String,
    pub dkim: DkimRecord,
    pub pools: Vec<String>,
    pub created_at: String,
}

impl From<&DomainRow> for DomainView {
    fn from(row: &DomainRow) -> Self {
        Self {
            domain: row.domain.clone(),
            selector: row.selector.clone(),
            algorithm: row.algorithm.clone(),
            public_key: row.public_key.clone(),
            dkim: DkimRecord {
                name: format!("{}._domainkey.{}", row.selector, row.domain),
                kind: "TXT",
                value: dkim::record_value(&row.public_key),
            },
            pools: row.pools.clone(),
            created_at: row.created_at.clone(),
        }
    }
}

#[derive(Debug)]
pub enum DomainError {
    Invalid(String),
    Store(StoreError),
    Key(String),
}

impl std::fmt::Display for DomainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) | Self::Key(message) => f.write_str(message),
            Self::Store(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for DomainError {}

impl From<StoreError> for DomainError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// A plausible domain name: dotted labels of letters, digits and hyphens.
pub fn valid_domain(domain: &str) -> bool {
    let domain = domain.trim_end_matches('.');
    domain.len() <= 253
        && domain.contains('.')
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

/// `ws<yyyymm>`, the month the key was made.
fn selector() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!("ws{:04}{:02}", now.year(), u8::from(now.month()))
}

/// Registers `domain` (idempotent): `(view, created)`.
pub async fn register(
    store: &Store,
    keys: &Keys,
    domain: &str,
    pools: &[String],
) -> Result<(DomainView, bool), DomainError> {
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if !valid_domain(&domain) {
        return Err(DomainError::Invalid(format!("not a domain: {domain}")));
    }
    if let Some(row) = store.domain(&domain).await? {
        return Ok((DomainView::from(&row), false));
    }
    let (private, public) = dkim::generate_rsa().map_err(|e| DomainError::Key(e.to_string()))?;
    let sealed = keys
        .seal(&domain, &private)
        .map_err(|e| DomainError::Key(e.to_string()))?;
    let pools: Vec<String> = pools
        .iter()
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    let created = store
        .insert_domain(&domain, &selector(), &sealed, &public, &pools)
        .await?;
    let row = store
        .domain(&domain)
        .await?
        .ok_or_else(|| DomainError::Invalid("domain vanished".into()))?;
    Ok((DomainView::from(&row), created))
}

/// The domains to try for a From domain: itself, then each parent with at
/// least two labels.
fn candidates(domain: &str) -> Vec<String> {
    let labels: Vec<&str> = domain.split('.').collect();
    (0..labels.len().saturating_sub(1))
        .map(|start| labels[start..].join("."))
        .collect()
}

type CachedSigner = (Instant, Option<(Arc<Signer>, Vec<String>)>);

/// Signers by From domain, cached for a minute (a removed domain stops
/// signing within that).
#[derive(Debug)]
pub struct Signers {
    store: Store,
    keys: Keys,
    cache: Mutex<HashMap<String, CachedSigner>>,
}

const SIGNER_TTL: Duration = Duration::from_secs(60);

impl Signers {
    pub fn new(store: Store, keys: Keys) -> Self {
        Self {
            store,
            keys,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// The signer for mail from `from_domain` in `pool`, or `None` when no
    /// registered domain covers it for that pool.
    pub async fn for_domain(
        &self,
        from_domain: &str,
        pool: &str,
    ) -> Result<Option<Arc<Signer>>, DomainError> {
        let from_domain = from_domain.to_ascii_lowercase();
        let cached = {
            let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
            cache
                .get(&from_domain)
                .filter(|(at, _)| at.elapsed() < SIGNER_TTL)
                .map(|(_, value)| value.clone())
        };
        let entry = if let Some(entry) = cached {
            entry
        } else {
            self.load(from_domain).await?
        };
        Ok(entry.and_then(|(signer, pools)| {
            (pools.is_empty() || pools.iter().any(|p| p == pool)).then_some(signer)
        }))
    }

    /// Looks up the registered domain covering `from_domain` (itself or a
    /// parent), opens its key and caches the result, a miss included.
    async fn load(
        &self,
        from_domain: String,
    ) -> Result<Option<(Arc<Signer>, Vec<String>)>, DomainError> {
        let mut found = None;
        for candidate in candidates(&from_domain) {
            if let Some(row) = self.store.domain(&candidate).await? {
                let private = self
                    .keys
                    .open(&row.domain, &row.sealed_key)
                    .map_err(|e| DomainError::Key(format!("{}: {e}", row.domain)))?;
                let signer = Signer::new(&row.domain, &row.selector, &private)
                    .map_err(|e| DomainError::Key(e.to_string()))?;
                found = Some((Arc::new(signer), row.pools));
                break;
            }
        }
        let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        if cache.len() > 5000 {
            cache.clear();
        }
        cache.insert(from_domain, (Instant::now(), found.clone()));
        Ok(found)
    }

    /// Forgets a domain (after it was removed or changed).
    pub fn forget(&self, domain: &str) {
        let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        let domain = domain.to_ascii_lowercase();
        cache.retain(|key, _| key != &domain && !key.ends_with(&format!(".{domain}")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_domains_and_lists_parents() {
        assert!(valid_domain("acme.eu"));
        assert!(valid_domain("mail.acme-group.co.uk."));
        assert!(!valid_domain("localhost"));
        assert!(!valid_domain("-bad.eu"));
        assert!(!valid_domain("a b.eu"));
        assert_eq!(candidates("mail.acme.eu"), vec!["mail.acme.eu", "acme.eu"]);
        assert_eq!(candidates("acme.eu"), vec!["acme.eu"]);
        assert!(selector().starts_with("ws20"));
        assert_eq!(selector().len(), 8);
    }
}
