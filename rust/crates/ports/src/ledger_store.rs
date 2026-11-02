//! Versioned key-value records for counters that must be checked and changed
//! atomically: the outbound mail guard's per-workspace ledger and its
//! platform budget (`weldsuite_mail_domain::outbound`). On Global these are
//! the `OutboundLedger` and `OutboundPlatformBudget` Durable Objects, whose
//! storage is a key-value map read and written by one instance at a time.
//! Here one record holds the same map (`h:<hour>` → JSON, …) plus a version:
//! a writer reads the record, decides in memory, and commits its changes
//! only if the version is still the one it read ([`LedgerStore::commit`]);
//! otherwise it reads again and decides again. The Valkey adapter
//! (`weldsuite-adapters-oss`) does the commit in one Lua script, so every
//! decision is made against the counts as they are (ADR MAIL-006, MAIL-010).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::{BoxFuture, PortError};

/// A record as read: its fields and the version to commit against (0 for
/// a record that does not exist yet).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LedgerSnapshot {
    pub version: u64,
    pub fields: HashMap<String, String>,
}

/// What a decision changed: fields to set and fields to remove.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LedgerChanges {
    pub put: Vec<(String, String)>,
    pub delete: Vec<String>,
}

impl LedgerChanges {
    pub fn is_empty(&self) -> bool {
        self.put.is_empty() && self.delete.is_empty()
    }
}

/// Versioned records by key. Object safe.
pub trait LedgerStore: Send + Sync {
    /// The record at `key` (empty, version 0, when there is none).
    fn load<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<LedgerSnapshot, PortError>>;

    /// Apply `changes` and bump the version, if the record is still at
    /// `version`; `Ok(false)` when another writer committed first. The
    /// record expires `ttl` after its last commit.
    fn commit<'a>(
        &'a self,
        key: &'a str,
        version: u64,
        changes: &'a LedgerChanges,
        ttl: Duration,
    ) -> BoxFuture<'a, Result<bool, PortError>>;
}

/// [`LedgerStore`] in this process: one replica's worth, for tests and for a
/// deployment without Valkey.
#[derive(Debug, Default)]
pub struct MemoryLedgerStore {
    records: Mutex<HashMap<String, (LedgerSnapshot, Instant)>>,
}

impl MemoryLedgerStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl LedgerStore for MemoryLedgerStore {
    fn load<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<LedgerSnapshot, PortError>> {
        let mut records = self
            .records
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let snapshot = match records.get(key) {
            Some((_, expires)) if *expires <= Instant::now() => {
                records.remove(key);
                LedgerSnapshot::default()
            }
            Some((snapshot, _)) => snapshot.clone(),
            None => LedgerSnapshot::default(),
        };
        Box::pin(std::future::ready(Ok(snapshot)))
    }

    fn commit<'a>(
        &'a self,
        key: &'a str,
        version: u64,
        changes: &'a LedgerChanges,
        ttl: Duration,
    ) -> BoxFuture<'a, Result<bool, PortError>> {
        let mut records = self
            .records
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Instant::now();
        let current = match records.get(key) {
            Some((snapshot, expires)) if *expires > now => snapshot.version,
            _ => 0,
        };
        if current != version {
            return Box::pin(std::future::ready(Ok(false)));
        }
        let entry = records
            .entry(key.to_owned())
            .or_insert_with(|| (LedgerSnapshot::default(), now + ttl));
        if entry.1 <= now {
            entry.0 = LedgerSnapshot::default();
        }
        for (field, value) in &changes.put {
            entry.0.fields.insert(field.clone(), value.clone());
        }
        for field in &changes.delete {
            entry.0.fields.remove(field);
        }
        entry.0.version = version + 1;
        entry.1 = now + ttl;
        Box::pin(std::future::ready(Ok(true)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn commits_only_against_the_version_read() {
        let store = MemoryLedgerStore::new();
        let ttl = Duration::from_secs(60);
        let first = store.load("ws:1").await.expect("load");
        assert_eq!(first.version, 0);
        let changes = LedgerChanges {
            put: vec![("h:1".to_owned(), "{}".to_owned())],
            delete: Vec::new(),
        };
        assert!(
            store
                .commit("ws:1", 0, &changes, ttl)
                .await
                .expect("commit")
        );
        // A second writer that read version 0 loses.
        assert!(
            !store
                .commit("ws:1", 0, &changes, ttl)
                .await
                .expect("commit")
        );
        let read = store.load("ws:1").await.expect("load");
        assert_eq!(read.version, 1);
        assert_eq!(read.fields.get("h:1").map(String::as_str), Some("{}"));
        let removal = LedgerChanges {
            put: Vec::new(),
            delete: vec!["h:1".to_owned()],
        };
        assert!(
            store
                .commit("ws:1", 1, &removal, ttl)
                .await
                .expect("commit")
        );
        assert!(store.load("ws:1").await.expect("load").fields.is_empty());
    }
}
