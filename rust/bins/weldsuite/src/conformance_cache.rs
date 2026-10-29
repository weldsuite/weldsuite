//! Conformance mode's shared cache: the test's `WORKSPACE_CACHE` KV namespace,
//! served over HTTP by the harness (`packages/core/worker-kit/src/testing/
//! kv-bridge.ts`), as the [`Cache`] port. Rust's routes then read and write
//! the entries the TypeScript routes do, and the harness undoes one run's
//! writes before the other runs.
//!
//! `GET|PUT|DELETE {bridge}/kv?key=…[&ttl=…]`; a missing key is a 404.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use reqwest::{Client, StatusCode};
use weldsuite_ports::{Cache, DynCache, PortError};

/// One test KV namespace behind the harness's bridge.
pub(crate) struct BridgedCache {
    bridge: String,
    client: Client,
}

impl BridgedCache {
    fn url(&self, key: &str, ttl: Option<Duration>) -> String {
        let encoded: String = form_urlencoded::byte_serialize(key.as_bytes()).collect();
        match ttl {
            Some(ttl) => format!("{}/kv?key={encoded}&ttl={}", self.bridge, ttl.as_secs()),
            None => format!("{}/kv?key={encoded}", self.bridge),
        }
    }
}

fn failed(status: StatusCode) -> PortError {
    PortError::backend(format!("the KV bridge answered {status}"))
}

impl Cache for BridgedCache {
    async fn get(&self, key: &str) -> Result<Option<String>, PortError> {
        let response = self
            .client
            .get(self.url(key, None))
            .send()
            .await
            .map_err(PortError::backend)?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => {
                Ok(Some(response.text().await.map_err(PortError::backend)?))
            }
            status => Err(failed(status)),
        }
    }

    async fn put(&self, key: &str, value: &str, ttl: Option<Duration>) -> Result<(), PortError> {
        let response = self
            .client
            .put(self.url(key, ttl))
            .body(value.to_owned())
            .send()
            .await
            .map_err(PortError::backend)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(failed(response.status()))
        }
    }

    async fn delete(&self, key: &str) -> Result<(), PortError> {
        let response = self
            .client
            .delete(self.url(key, None))
            .send()
            .await
            .map_err(PortError::backend)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(failed(response.status()))
        }
    }
}

/// The bridged namespaces by bridge URL, made once per test process.
#[derive(Default)]
pub(crate) struct CacheBridges {
    caches: Mutex<HashMap<String, Arc<dyn DynCache>>>,
    client: Client,
}

impl CacheBridges {
    /// The test KV namespace behind `bridge`.
    pub(crate) fn cache(&self, bridge: &str) -> Arc<dyn DynCache> {
        let mut caches = self.caches.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(caches.entry(bridge.to_owned()).or_insert_with(|| {
            Arc::new(BridgedCache {
                bridge: bridge.trim_end_matches('/').to_owned(),
                client: self.client.clone(),
            })
        }))
    }
}
