//! Conformance mode's shared KV: a [`Cache`] over the HTTP bridge the
//! TypeScript harness serves for a test's KV namespace binding
//! (`packages/core/worker-kit/src/testing/kv-bridge.ts`), so Rust reads and
//! writes the keys the Hono app does (upload tokens in `WORKSPACE_CACHE`).
//!
//! `GET /value?key=…` (the value as text; 404 when missing),
//! `PUT /value?key=…&ttl=<seconds>` (the body is the value; `ttl` is KV's
//! `expirationTtl`, left out for no expiry), `DELETE /value?key=…`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use http::StatusCode;
use reqwest::{Client, Method, RequestBuilder};
use weldsuite_ports::{Cache, DynCache, PortError, RequestCache};

/// One test KV namespace behind the bridge.
pub(crate) struct HttpCache {
    base: String,
    client: Client,
}

impl HttpCache {
    pub(crate) fn new(base: &str, client: Client) -> Self {
        Self {
            base: base.trim_end_matches('/').to_owned(),
            client,
        }
    }

    fn request(&self, method: Method, key: &str, ttl: Option<Duration>) -> RequestBuilder {
        let key: String = form_urlencoded::byte_serialize(key.as_bytes()).collect();
        let ttl = ttl.map_or_else(String::new, |ttl| format!("&ttl={}", ttl.as_secs().max(1)));
        self.client
            .request(method, format!("{}/value?key={key}{ttl}", self.base))
    }
}

fn status_error(status: StatusCode) -> PortError {
    PortError::backend(format!("kv bridge answered {status}"))
}

impl Cache for HttpCache {
    async fn get(&self, key: &str) -> Result<Option<String>, PortError> {
        let response = self
            .request(Method::GET, key, None)
            .send()
            .await
            .map_err(PortError::backend)?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => {
                Ok(Some(response.text().await.map_err(PortError::backend)?))
            }
            status => Err(status_error(status)),
        }
    }

    async fn put(&self, key: &str, value: &str, ttl: Option<Duration>) -> Result<(), PortError> {
        let response = self
            .request(Method::PUT, key, ttl)
            .body(value.to_owned())
            .send()
            .await
            .map_err(PortError::backend)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(status_error(response.status()))
        }
    }

    async fn delete(&self, key: &str) -> Result<(), PortError> {
        let response = self
            .request(Method::DELETE, key, None)
            .send()
            .await
            .map_err(PortError::backend)?;
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(status_error(response.status()))
        }
    }

    /// KV has no atomic add: read, add and write back, with `ttl` as the
    /// write's `expirationTtl`, as a TypeScript counter on KV does. The
    /// harness runs one request at a time, so nothing races.
    async fn increment(&self, key: &str, by: i64, ttl: Option<Duration>) -> Result<i64, PortError> {
        let current = match self.get(key).await? {
            Some(text) => text.parse::<i64>().map_err(|_| {
                PortError::backend(format!(
                    "kv bridge: the value under {key:?} is not an integer"
                ))
            })?,
            None => 0,
        };
        let next = current.saturating_add(by);
        self.put(key, &next.to_string(), ttl).await?;
        Ok(next)
    }
}

/// The bridge caches by URL, made once.
#[derive(Default)]
pub(crate) struct KvBridges {
    caches: Mutex<HashMap<String, Arc<dyn DynCache>>>,
    client: Client,
}

impl KvBridges {
    /// The request's cache from the test context's `kv`
    /// (`{ WORKSPACE_CACHE: url }`); `None` when the test has no KV.
    pub(crate) fn request_cache(&self, kv: &HashMap<String, String>) -> Option<RequestCache> {
        let url = kv.get("WORKSPACE_CACHE")?;
        let mut caches = self.caches.lock().unwrap_or_else(PoisonError::into_inner);
        let cache = caches
            .entry(url.clone())
            .or_insert_with(|| Arc::new(HttpCache::new(url, self.client.clone())));
        Some(RequestCache(Arc::clone(cache)))
    }
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::extract::{Query, State};
    use axum::response::IntoResponse;
    use axum::routing::any;

    use super::*;

    type Values = Arc<Mutex<HashMap<String, (String, Option<String>)>>>;

    /// A stand-in for the TypeScript bridge, over a map.
    async fn bridge(
        State(values): State<Values>,
        method: http::Method,
        Query(query): Query<HashMap<String, String>>,
        body: String,
    ) -> axum::response::Response {
        let key = query.get("key").cloned().unwrap_or_default();
        let mut values = values.lock().unwrap_or_else(PoisonError::into_inner);
        match method.as_str() {
            "PUT" => {
                values.insert(key, (body, query.get("ttl").cloned()));
                StatusCode::NO_CONTENT.into_response()
            }
            "DELETE" => {
                values.remove(&key);
                StatusCode::NO_CONTENT.into_response()
            }
            _ => match values.get(&key) {
                Some((value, _)) => value.clone().into_response(),
                None => StatusCode::NOT_FOUND.into_response(),
            },
        }
    }

    #[tokio::test]
    async fn round_trips_through_the_bridge() {
        let values = Values::default();
        let app = Router::new()
            .route("/value", any(bridge))
            .with_state(Arc::clone(&values));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        tokio::spawn(async move { axum::serve(listener, app).await });

        let bridges = KvBridges::default();
        assert!(bridges.request_cache(&HashMap::new()).is_none());
        let kv = HashMap::from([("WORKSPACE_CACHE".to_owned(), base)]);
        let RequestCache(cache) = bridges.request_cache(&kv).expect("a cache");
        let key = "upload:upl_a/b c";
        assert_eq!(cache.get_boxed(key).await.expect("get"), None);
        cache
            .put_boxed(key, r#"{"fileKey":"k"}"#, Some(Duration::from_secs(600)))
            .await
            .expect("put");
        assert_eq!(
            cache.get_boxed(key).await.expect("get").as_deref(),
            Some(r#"{"fileKey":"k"}"#)
        );
        assert_eq!(
            values
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(key)
                .and_then(|(_, ttl)| ttl.clone())
                .as_deref(),
            Some("600")
        );
        cache.delete_boxed(key).await.expect("delete");
        assert_eq!(cache.get_boxed(key).await.expect("get"), None);
        // Counters: a missing key counts as 0; a non-integer is an error.
        let counter = "mail:count";
        assert_eq!(
            cache.increment_boxed(counter, 2, None).await.expect("add"),
            2
        );
        assert_eq!(
            cache
                .increment_boxed(counter, -5, Some(Duration::from_secs(60)))
                .await
                .expect("add"),
            -3
        );
        assert_eq!(
            cache.get_boxed(counter).await.expect("get").as_deref(),
            Some("-3")
        );
        cache
            .put_boxed(key, r#"{"fileKey":"k"}"#, None)
            .await
            .expect("put");
        assert!(cache.increment_boxed(key, 1, None).await.is_err());
        // The same URL gives the same cache.
        let RequestCache(again) = bridges.request_cache(&kv).expect("a cache");
        assert!(Arc::ptr_eq(&cache, &again));
    }
}
