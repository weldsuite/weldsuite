//! [`LedgerStore`] on Valkey: the outbound guard's ledgers (ADR MAIL-006,
//! MAIL-010). One hash per ledger, its fields the ledger's buckets and a
//! `__v` version; a commit is one Lua script that checks the version the
//! caller read, applies the changes and bumps it, atomically, so two sends
//! of one workspace never both pass a window only one of them fits.
//!
//! Connects on first use (the routes are built before the runtime has a
//! connection), and reconnects on its own (`ConnectionManager`).

use std::collections::HashMap;
use std::time::Duration;

use redis::aio::ConnectionManager;
use tokio::sync::OnceCell;
use weldsuite_ports::{BoxFuture, LedgerChanges, LedgerSnapshot, LedgerStore, PortError};

/// The version field.
const VERSION_FIELD: &str = "__v";

/// `KEYS[1]` the record; `ARGV`: version read, TTL (ms), puts (count, then
/// field/value pairs), deletes (count, then fields). Returns 1 when applied,
/// 0 when another writer committed first.
const COMMIT: &str = r"
local current = tonumber(redis.call('HGET', KEYS[1], '__v') or '0')
if current ~= tonumber(ARGV[1]) then return 0 end
local i = 3
local puts = tonumber(ARGV[i]); i = i + 1
for _ = 1, puts do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]); i = i + 2
end
local deletes = tonumber(ARGV[i]); i = i + 1
for _ = 1, deletes do
  redis.call('HDEL', KEYS[1], ARGV[i]); i = i + 1
end
redis.call('HSET', KEYS[1], '__v', current + 1)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
";

/// Ledgers on Valkey, every key under `prefix`.
pub struct ValkeyLedgerStore {
    client: redis::Client,
    connection: OnceCell<ConnectionManager>,
    prefix: String,
}

impl std::fmt::Debug for ValkeyLedgerStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ValkeyLedgerStore")
            .field("prefix", &self.prefix)
            .finish_non_exhaustive()
    }
}

impl ValkeyLedgerStore {
    /// A store on the Valkey at `url` (`redis://`, `rediss://`).
    pub fn from_url(url: &str, prefix: impl Into<String>) -> Result<Self, PortError> {
        Ok(Self {
            client: redis::Client::open(url).map_err(PortError::backend)?,
            connection: OnceCell::new(),
            prefix: prefix.into(),
        })
    }

    async fn connection(&self) -> Result<ConnectionManager, PortError> {
        self.connection
            .get_or_try_init(|| async {
                let config = redis::aio::ConnectionManagerConfig::new()
                    .set_connection_timeout(Some(Duration::from_secs(5)))
                    .set_response_timeout(Some(Duration::from_secs(2)))
                    .set_number_of_retries(3);
                ConnectionManager::new_with_config(self.client.clone(), config)
                    .await
                    .map_err(PortError::backend)
            })
            .await
            .cloned()
    }

    fn key(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }
}

impl LedgerStore for ValkeyLedgerStore {
    fn load<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<LedgerSnapshot, PortError>> {
        Box::pin(async move {
            let mut connection = self.connection().await?;
            let mut fields: HashMap<String, String> = redis::cmd("HGETALL")
                .arg(self.key(key))
                .query_async(&mut connection)
                .await
                .map_err(PortError::backend)?;
            let version = fields
                .remove(VERSION_FIELD)
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            Ok(LedgerSnapshot { version, fields })
        })
    }

    fn commit<'a>(
        &'a self,
        key: &'a str,
        version: u64,
        changes: &'a LedgerChanges,
        ttl: Duration,
    ) -> BoxFuture<'a, Result<bool, PortError>> {
        Box::pin(async move {
            let mut connection = self.connection().await?;
            // EVAL, not EVALSHA: the script is small, and it needs no script cache.
            let mut invocation = redis::cmd("EVAL");
            invocation
                .arg(COMMIT)
                .arg(1)
                .arg(self.key(key))
                .arg(version)
                .arg(u64::try_from(ttl.as_millis()).unwrap_or(u64::MAX).max(1))
                .arg(changes.put.len());
            for (field, value) in &changes.put {
                invocation.arg(field).arg(value);
            }
            invocation.arg(changes.delete.len());
            for field in &changes.delete {
                invocation.arg(field);
            }
            let applied: i64 = invocation
                .query_async(&mut connection)
                .await
                .map_err(PortError::backend)?;
            Ok(applied == 1)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against a real Valkey when `WELDSUITE_TEST_VALKEY_URL` is set.
    #[tokio::test]
    async fn commits_against_the_version_read() {
        let Ok(url) = std::env::var("WELDSUITE_TEST_VALKEY_URL") else {
            return;
        };
        let prefix = format!("test:ledger:{}:", std::process::id());
        let store = ValkeyLedgerStore::from_url(&url, prefix).expect("url");
        let ttl = Duration::from_secs(60);
        let first = store.load("ws:1").await.expect("load");
        assert_eq!(first.version, 0);
        let changes = LedgerChanges {
            put: vec![("h:1".to_owned(), "{\"r\":1}".to_owned())],
            delete: Vec::new(),
        };
        assert!(
            store
                .commit("ws:1", 0, &changes, ttl)
                .await
                .expect("commit")
        );
        assert!(
            !store
                .commit("ws:1", 0, &changes, ttl)
                .await
                .expect("commit")
        );
        let read = store.load("ws:1").await.expect("load");
        assert_eq!(read.version, 1);
        assert_eq!(
            read.fields.get("h:1").map(String::as_str),
            Some("{\"r\":1}")
        );
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
