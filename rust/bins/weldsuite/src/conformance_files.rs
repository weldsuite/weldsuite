//! Conformance mode's shared buckets: a [`FileStore`] over the HTTP bridge
//! the TypeScript harness serves for each of a test's R2 bindings
//! (`packages/core/worker-kit/src/testing/bucket-bridge.ts`), so Rust reads
//! and writes the objects the Hono app does.
//!
//! `GET|HEAD|PUT|DELETE /object?key=…`; the content type travels as
//! `Content-Type`, the disposition as `Content-Disposition`, custom metadata
//! as `x-meta-<name>`, the entity tag as `ETag`. A create-only put sends
//! `If-None-Match: *` and gets a 412 when the key is taken.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

use http::{HeaderMap, StatusCode};
use reqwest::{Client, Method, RequestBuilder};
use weldsuite_ports::{
    DynFileStore, FileStore, FileStores, ObjectInfo, PortError, PutOptions, StorageBuckets, Stored,
    StoredObject,
};

const META_PREFIX: &str = "x-meta-";

/// One test bucket behind the bridge.
pub(crate) struct HttpFileStore {
    base: String,
    client: Client,
}

impl HttpFileStore {
    pub(crate) fn new(base: &str, client: Client) -> Self {
        Self {
            base: base.trim_end_matches('/').to_owned(),
            client,
        }
    }

    fn request(&self, method: Method, key: &str) -> RequestBuilder {
        let key: String = form_urlencoded::byte_serialize(key.as_bytes()).collect();
        self.client
            .request(method, format!("{}/object?key={key}", self.base))
    }

    async fn send(&self, request: RequestBuilder) -> Result<reqwest::Response, PortError> {
        request.send().await.map_err(PortError::backend)
    }
}

fn status_error(status: StatusCode) -> PortError {
    PortError::backend(format!("bucket bridge answered {status}"))
}

/// Content type, custom metadata and size from the bridge's headers.
fn info_from(headers: &HeaderMap, size: Option<u64>) -> ObjectInfo {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let metadata: BTreeMap<String, String> = headers
        .iter()
        .filter_map(|(name, value)| {
            let name = name.as_str().strip_prefix(META_PREFIX)?;
            Some((name.to_owned(), value.to_str().ok()?.to_owned()))
        })
        .collect();
    ObjectInfo {
        size: size
            .or_else(|| header("content-length").and_then(|n| n.parse().ok()))
            .unwrap_or(0),
        content_type: header("content-type").map(str::to_owned),
        content_disposition: header("content-disposition").map(str::to_owned),
        etag: etag_from(headers),
        metadata,
    }
}

fn etag_from(headers: &HeaderMap) -> Option<String> {
    headers
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(|etag| etag.trim_matches('"').to_owned())
        .filter(|etag| !etag.is_empty())
}

impl FileStore for HttpFileStore {
    async fn put(
        &self,
        key: &str,
        bytes: Vec<u8>,
        options: &PutOptions,
    ) -> Result<Option<Stored>, PortError> {
        let mut request = self.request(Method::PUT, key).body(bytes);
        if let Some(content_type) = &options.content_type {
            request = request.header("content-type", content_type);
        }
        if let Some(disposition) = &options.content_disposition {
            request = request.header("content-disposition", disposition);
        }
        if options.create_only {
            request = request.header("if-none-match", "*");
        }
        for (name, value) in &options.metadata {
            request = request.header(format!("{META_PREFIX}{name}"), value);
        }
        let response = self.send(request).await?;
        match response.status() {
            status if status.is_success() => Ok(Some(Stored {
                etag: etag_from(response.headers()),
            })),
            StatusCode::PRECONDITION_FAILED if options.create_only => Ok(None),
            status => Err(status_error(status)),
        }
    }

    async fn get(&self, key: &str) -> Result<Option<StoredObject>, PortError> {
        let response = self.send(self.request(Method::GET, key)).await?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => {
                let headers = response.headers().clone();
                let bytes = response.bytes().await.map_err(PortError::backend)?.to_vec();
                let size = u64::try_from(bytes.len()).ok();
                Ok(Some(StoredObject {
                    info: info_from(&headers, size),
                    bytes,
                }))
            }
            status => Err(status_error(status)),
        }
    }

    async fn head(&self, key: &str) -> Result<Option<ObjectInfo>, PortError> {
        let response = self.send(self.request(Method::HEAD, key)).await?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => Ok(Some(info_from(response.headers(), None))),
            status => Err(status_error(status)),
        }
    }

    async fn delete(&self, key: &str) -> Result<(), PortError> {
        let response = self.send(self.request(Method::DELETE, key)).await?;
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(status_error(response.status()))
        }
    }

    async fn delete_many(&self, keys: &[String]) -> Result<(), PortError> {
        for key in keys {
            FileStore::delete(self, key).await?;
        }
        Ok(())
    }
}

/// The bridge stores by URL, made once: a test file's buckets live as long
/// as its process.
#[derive(Default)]
pub(crate) struct BucketBridges {
    stores: Mutex<HashMap<String, Arc<dyn DynFileStore>>>,
    client: Client,
}

impl BucketBridges {
    pub(crate) fn store(&self, url: &str) -> Arc<dyn DynFileStore> {
        let mut stores = self.stores.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(
            stores
                .entry(url.to_owned())
                .or_insert_with(|| Arc::new(HttpFileStore::new(url, self.client.clone()))),
        )
    }

    /// The request's buckets from the test context's `files`
    /// (`PRIVATE_STORAGE` private, `STORAGE` public); `None` without a
    /// private one, so modules keep the app state's stores.
    pub(crate) fn file_stores(&self, files: &HashMap<String, String>) -> Option<FileStores> {
        let private = self.store(files.get("PRIVATE_STORAGE")?);
        let public = files.get("STORAGE").map(|url| self.store(url));
        Some(FileStores { private, public })
    }

    /// Both buckets, each as the test has it; `None` when it has neither.
    pub(crate) fn storage_buckets(
        &self,
        files: &HashMap<String, String>,
    ) -> Option<StorageBuckets> {
        let private = files.get("PRIVATE_STORAGE").map(|url| self.store(url));
        let public = files.get("STORAGE").map(|url| self.store(url));
        (private.is_some() || public.is_some()).then_some(StorageBuckets { private, public })
    }
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Bytes;
    use axum::extract::{Query, State};
    use axum::http::HeaderMap as AxumHeaders;
    use axum::response::IntoResponse;
    use axum::routing::any;

    use super::*;

    type Objects = Arc<Mutex<HashMap<String, (Vec<u8>, Option<String>, Option<String>)>>>;

    /// A stand-in for the TypeScript bridge, over a map.
    async fn bridge(
        State(objects): State<Objects>,
        method: http::Method,
        Query(query): Query<HashMap<String, String>>,
        headers: AxumHeaders,
        body: Bytes,
    ) -> axum::response::Response {
        let key = query.get("key").cloned().unwrap_or_default();
        let mut objects = objects.lock().unwrap_or_else(PoisonError::into_inner);
        match method.as_str() {
            "PUT" => {
                let header = |name: &str| {
                    headers
                        .get(name)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned)
                };
                if header("if-none-match").as_deref() == Some("*") && objects.contains_key(&key) {
                    return StatusCode::PRECONDITION_FAILED.into_response();
                }
                objects.insert(
                    key,
                    (
                        body.to_vec(),
                        header("content-type"),
                        header("x-meta-sha256"),
                    ),
                );
                (StatusCode::NO_CONTENT, [("etag", "\"e1\"")]).into_response()
            }
            "DELETE" => {
                objects.remove(&key);
                StatusCode::NO_CONTENT.into_response()
            }
            _ => match objects.get(&key) {
                None => StatusCode::NOT_FOUND.into_response(),
                Some((bytes, content_type, sha)) => {
                    let mut response = if method == http::Method::HEAD {
                        (
                            [("content-length", bytes.len().to_string())],
                            Vec::<u8>::new(),
                        )
                            .into_response()
                    } else {
                        bytes.clone().into_response()
                    };
                    if let Some(ct) = content_type {
                        response
                            .headers_mut()
                            .insert("content-type", ct.parse().expect("header"));
                    }
                    if let Some(sha) = sha {
                        response
                            .headers_mut()
                            .insert("x-meta-sha256", sha.parse().expect("header"));
                    }
                    response
                }
            },
        }
    }

    #[tokio::test]
    async fn round_trips_through_the_bridge() {
        let objects = Objects::default();
        let app = Router::new()
            .route("/object", any(bridge))
            .with_state(Arc::clone(&objects));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        tokio::spawn(async move { axum::serve(listener, app).await });

        let bridges = BucketBridges::default();
        let files = HashMap::from([("PRIVATE_STORAGE".to_owned(), base.clone())]);
        let stores = bridges.file_stores(&files).expect("private bucket");
        assert!(stores.public.is_none());
        let store = &*stores.private;
        let key = "workspaces/org_1/weldsign/sgn_1/documents/sgd_1.pdf";

        let written = store
            .put_boxed(
                key,
                vec![1, 2, 3],
                &PutOptions::content_type("application/pdf").with_metadata("sha256", "abc"),
            )
            .await
            .expect("put")
            .expect("stored");
        assert_eq!(written.etag.as_deref(), Some("e1"));
        let once = PutOptions {
            create_only: true,
            ..PutOptions::default()
        };
        assert!(
            store
                .put_boxed(key, vec![9], &once)
                .await
                .expect("put")
                .is_none()
        );
        let object = store.get_boxed(key).await.expect("get").expect("stored");
        assert_eq!(object.bytes, vec![1, 2, 3]);
        assert_eq!(object.info.size, 3);
        assert_eq!(object.info.content_type.as_deref(), Some("application/pdf"));
        assert_eq!(
            object.info.metadata.get("sha256").map(String::as_str),
            Some("abc")
        );
        let info = store.head_boxed(key).await.expect("head").expect("stored");
        assert_eq!(info.size, 3);
        store
            .delete_many_boxed(&[key.to_owned()])
            .await
            .expect("delete");
        assert!(store.get_boxed(key).await.expect("get").is_none());
        assert!(store.head_boxed(key).await.expect("head").is_none());
        // The same URL gives the same store.
        let again = bridges.file_stores(&files).expect("private bucket");
        assert!(Arc::ptr_eq(&stores.private, &again.private));
        assert!(bridges.file_stores(&HashMap::new()).is_none());
        // A test with only the public bucket: no `FileStores`, but buckets.
        let public_only = HashMap::from([("STORAGE".to_owned(), base)]);
        assert!(bridges.file_stores(&public_only).is_none());
        let buckets = bridges.storage_buckets(&public_only).expect("buckets");
        assert!(buckets.private.is_none() && buckets.public.is_some());
        assert!(bridges.storage_buckets(&HashMap::new()).is_none());
    }
}
