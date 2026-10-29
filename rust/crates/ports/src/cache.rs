//! Key/value cache with expiry: the port behind what the workers keep in the
//! `WORKSPACE_CACHE` KV namespace (`packages/core/worker-kit/src/db.ts`,
//! `app-access.ts`). Values are strings, as in KV; [`CacheExt`] adds the
//! `get(key, 'json')` / `put(key, JSON.stringify(v))` pair.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::{BoxFuture, PortError};

/// A shared cache. A missing key and an expired one are the same: `None`.
pub trait Cache: Send + Sync {
    fn get(&self, key: &str) -> impl Future<Output = Result<Option<String>, PortError>> + Send;

    /// Stores `value`; `ttl` of `None` keeps it until it is deleted or evicted.
    fn put(
        &self,
        key: &str,
        value: &str,
        ttl: Option<Duration>,
    ) -> impl Future<Output = Result<(), PortError>> + Send;

    fn delete(&self, key: &str) -> impl Future<Output = Result<(), PortError>> + Send;
}

/// JSON on top of any [`Cache`].
pub trait CacheExt: Cache {
    /// The value under `key`, parsed. A value that no longer parses is an
    /// error, not a miss, so a changed shape shows up in the logs.
    fn get_json<T: DeserializeOwned>(
        &self,
        key: &str,
    ) -> impl Future<Output = Result<Option<T>, PortError>> + Send {
        async move {
            match self.get(key).await? {
                Some(text) => Ok(Some(serde_json::from_str(&text)?)),
                None => Ok(None),
            }
        }
    }

    fn put_json<T: Serialize + Sync>(
        &self,
        key: &str,
        value: &T,
        ttl: Option<Duration>,
    ) -> impl Future<Output = Result<(), PortError>> + Send {
        async move {
            let text = serde_json::to_string(value)?;
            self.put(key, &text, ttl).await
        }
    }
}

impl<C: Cache + ?Sized> CacheExt for C {}

/// Object-safe [`Cache`], for `Arc<dyn DynCache>`.
pub trait DynCache: Send + Sync {
    fn get_boxed<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, PortError>>;
    fn put_boxed<'a>(
        &'a self,
        key: &'a str,
        value: &'a str,
        ttl: Option<Duration>,
    ) -> BoxFuture<'a, Result<(), PortError>>;
    fn delete_boxed<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), PortError>>;
}

impl<C: Cache> DynCache for C {
    fn get_boxed<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, PortError>> {
        Box::pin(self.get(key))
    }

    fn put_boxed<'a>(
        &'a self,
        key: &'a str,
        value: &'a str,
        ttl: Option<Duration>,
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(self.put(key, value, ttl))
    }

    fn delete_boxed<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(self.delete(key))
    }
}

impl Cache for dyn DynCache {
    async fn get(&self, key: &str) -> Result<Option<String>, PortError> {
        self.get_boxed(key).await
    }

    async fn put(&self, key: &str, value: &str, ttl: Option<Duration>) -> Result<(), PortError> {
        self.put_boxed(key, value, ttl).await
    }

    async fn delete(&self, key: &str) -> Result<(), PortError> {
        self.delete_boxed(key).await
    }
}

impl<C: Cache + ?Sized> Cache for Arc<C> {
    fn get(&self, key: &str) -> impl Future<Output = Result<Option<String>, PortError>> + Send {
        (**self).get(key)
    }

    fn put(
        &self,
        key: &str,
        value: &str,
        ttl: Option<Duration>,
    ) -> impl Future<Output = Result<(), PortError>> + Send {
        (**self).put(key, value, ttl)
    }

    fn delete(&self, key: &str) -> impl Future<Output = Result<(), PortError>> + Send {
        (**self).delete(key)
    }
}

/// The cache a request uses in place of the app's, as a request extension:
/// conformance mode hands each request the test's own KV namespace.
#[derive(Clone)]
pub struct RequestCache(pub Arc<dyn DynCache>);

impl std::fmt::Debug for RequestCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestCache")
    }
}

/// In-process [`Cache`]: the test double, and enough for a single replica
/// that has no Valkey. Expired entries are dropped when read.
#[derive(Debug, Default)]
pub struct MemoryCache {
    entries: Mutex<HashMap<String, (String, Option<Instant>)>>,
}

impl MemoryCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every live key and value, sorted by key: what a test asserts on.
    pub fn snapshot(&self) -> Vec<(String, String)> {
        let now = Instant::now();
        let mut live: Vec<_> = self
            .lock()
            .iter()
            .filter(|(_, (_, expires))| expires.is_none_or(|at| at > now))
            .map(|(key, (value, _))| (key.clone(), value.clone()))
            .collect();
        live.sort();
        live
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, (String, Option<Instant>)>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Cache for MemoryCache {
    fn get(&self, key: &str) -> impl Future<Output = Result<Option<String>, PortError>> + Send {
        let mut entries = self.lock();
        let value = match entries.get(key) {
            Some((_, Some(expires))) if *expires <= Instant::now() => {
                entries.remove(key);
                None
            }
            Some((value, _)) => Some(value.clone()),
            None => None,
        };
        std::future::ready(Ok(value))
    }

    fn put(
        &self,
        key: &str,
        value: &str,
        ttl: Option<Duration>,
    ) -> impl Future<Output = Result<(), PortError>> + Send {
        let expires = ttl.map(|ttl| Instant::now() + ttl);
        self.lock()
            .insert(key.to_owned(), (value.to_owned(), expires));
        std::future::ready(Ok(()))
    }

    fn delete(&self, key: &str) -> impl Future<Output = Result<(), PortError>> + Send {
        self.lock().remove(key);
        std::future::ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_cache_round_trips_and_expires() {
        let cache = MemoryCache::new();
        cache.put("a", "1", None).await.expect("put");
        cache
            .put("b", "2", Some(Duration::ZERO))
            .await
            .expect("put");
        assert_eq!(cache.get("a").await.expect("get").as_deref(), Some("1"));
        assert_eq!(cache.get("b").await.expect("get"), None);
        assert_eq!(cache.snapshot(), vec![("a".to_owned(), "1".to_owned())]);
        cache.delete("a").await.expect("delete");
        assert_eq!(cache.get("a").await.expect("get"), None);
    }

    #[tokio::test]
    async fn json_helpers_work_through_a_dyn_cache() {
        let cache: Arc<dyn DynCache> = Arc::new(MemoryCache::new());
        cache
            .put_json("ws", &serde_json::json!({ "id": "ws_1" }), None)
            .await
            .expect("put");
        let value: Option<serde_json::Value> = cache.get_json("ws").await.expect("get");
        assert_eq!(value, Some(serde_json::json!({ "id": "ws_1" })));
        cache.put("bad", "{", None).await.expect("put");
        assert!(cache.get_json::<serde_json::Value>("bad").await.is_err());
    }
}
