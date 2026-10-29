//! `FileStore` over the S3 API: MinIO, Garage, Ceph RGW, Hetzner Object
//! Storage or AWS. `rusty-s3` signs each request (SigV4, presigned URLs with
//! the content type and metadata among the signed headers); reqwest sends it.
//!
//! A create-only put sends `If-None-Match: *` (conditional writes: AWS S3,
//! MinIO, Ceph RGW and RustFS honour it; a store that ignores it overwrites).

use std::collections::BTreeMap;
use std::time::Duration;

use reqwest::header::{
    CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, HeaderMap, RANGE,
};
use reqwest::{Client, Method, StatusCode, Url};
use rusty_s3::actions::{DeleteObjectsResponse, ObjectIdentifier};
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use weldsuite_ports::{
    ByteRange, FileStore, ObjectInfo, PortError, PutOptions, RangedObject, Stored, StoredObject,
    is_safe_key, unsafe_key,
};

/// How long a signed request stays valid. Each one is sent at once; the margin
/// covers clock skew between the pod and the store.
const SIGNED_FOR: Duration = Duration::from_mins(5);

/// S3 accepts at most this many keys in one `DeleteObjects`.
const DELETE_BATCH: usize = 1000;

const META_PREFIX: &str = "x-amz-meta-";

/// Where one bucket is and how to sign for it.
#[derive(Clone)]
pub struct S3Options {
    /// `https://fsn1.your-objectstorage.com`, `http://minio:9000`, …
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Path-style URLs (`<endpoint>/<bucket>/<key>`), which MinIO, Garage and
    /// endpoints reached by IP need; virtual-hosted style otherwise.
    pub path_style: bool,
}

impl std::fmt::Debug for S3Options {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3Options")
            .field("endpoint", &self.endpoint)
            .field("region", &self.region)
            .field("bucket", &self.bucket)
            .field("path_style", &self.path_style)
            .finish_non_exhaustive()
    }
}

/// One S3 bucket as a [`FileStore`].
#[derive(Debug, Clone)]
pub struct S3FileStore {
    client: Client,
    bucket: Bucket,
    credentials: Credentials,
}

impl S3FileStore {
    /// Fails on a malformed endpoint; nothing is sent until the first call.
    pub fn new(options: &S3Options, client: Client) -> Result<Self, PortError> {
        let endpoint: Url = options.endpoint.parse().map_err(PortError::backend)?;
        let style = if options.path_style {
            UrlStyle::Path
        } else {
            UrlStyle::VirtualHost
        };
        let bucket = Bucket::new(
            endpoint,
            style,
            options.bucket.clone(),
            options.region.clone(),
        )
        .map_err(|error| PortError::backend(format!("S3 bucket {}: {error:?}", options.bucket)))?;
        Ok(Self {
            client,
            bucket,
            credentials: Credentials::new(
                options.access_key_id.clone(),
                options.secret_access_key.clone(),
            ),
        })
    }

    pub fn bucket_name(&self) -> &str {
        self.bucket.name()
    }

    fn check(key: &str) -> Result<(), PortError> {
        if is_safe_key(key) {
            Ok(())
        } else {
            Err(unsafe_key(key))
        }
    }

    /// Send a signed request with the signed headers, and fail on an error
    /// status other than the ones the caller handles.
    async fn send(
        &self,
        method: Method,
        url: Url,
        headers: HeaderMap,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response, PortError> {
        let mut request = self.client.request(method, url).headers(headers);
        if let Some(body) = body {
            // S3 needs a length even for an empty body (reqwest leaves it out).
            request = request.header(CONTENT_LENGTH, body.len()).body(body);
        }
        request.send().await.map_err(PortError::backend)
    }

    async fn refused(response: reqwest::Response, what: &str) -> PortError {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail: String = body.chars().take(300).collect();
        PortError::backend(format!("S3 {what}: {status}: {detail}"))
    }
}

fn header_map(pairs: impl Iterator<Item = (String, String)>) -> Result<HeaderMap, PortError> {
    let mut headers = HeaderMap::new();
    for (name, value) in pairs {
        let name =
            reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(PortError::backend)?;
        let value = reqwest::header::HeaderValue::from_str(&value).map_err(PortError::backend)?;
        headers.insert(name, value);
    }
    Ok(headers)
}

/// What the response headers say about the object.
fn info_of(headers: &HeaderMap, size: Option<u64>) -> ObjectInfo {
    let text = |value: &reqwest::header::HeaderValue| value.to_str().ok().map(str::to_owned);
    let metadata: BTreeMap<String, String> = headers
        .iter()
        .filter_map(|(name, value)| {
            let key = name.as_str().strip_prefix(META_PREFIX)?;
            Some((key.to_owned(), text(value)?))
        })
        .collect();
    ObjectInfo {
        size: size.unwrap_or_else(|| {
            headers
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok()?.parse().ok())
                .unwrap_or(0)
        }),
        content_type: headers.get(CONTENT_TYPE).and_then(text),
        content_disposition: headers.get(CONTENT_DISPOSITION).and_then(text),
        etag: etag_of(headers),
        metadata,
    }
}

/// The `ETag` header without its quotes.
fn etag_of(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(ETAG)?.to_str().ok()?;
    let value = value.strip_prefix("W/").unwrap_or(value);
    Some(value.trim_matches('"').to_owned())
}

/// `bytes <first>-<last>/<size>` from a 206's `Content-Range`.
fn content_range(headers: &HeaderMap) -> Option<(u64, u64, u64)> {
    let value = headers.get(CONTENT_RANGE)?.to_str().ok()?;
    let (span, size) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (first, last) = span.split_once('-')?;
    let (first, last): (u64, u64) = (first.trim().parse().ok()?, last.trim().parse().ok()?);
    let size = size.trim().parse().ok()?;
    (last >= first).then(|| (first, last - first + 1, size))
}

impl FileStore for S3FileStore {
    async fn put(
        &self,
        key: &str,
        bytes: Vec<u8>,
        options: &PutOptions,
    ) -> Result<Option<Stored>, PortError> {
        Self::check(key)?;
        let mut action = self.bucket.put_object(Some(&self.credentials), key);
        let mut signed = Vec::new();
        if let Some(content_type) = &options.content_type {
            signed.push(("content-type".to_owned(), content_type.clone()));
        }
        if let Some(disposition) = &options.content_disposition {
            signed.push(("content-disposition".to_owned(), disposition.clone()));
        }
        if options.create_only {
            signed.push(("if-none-match".to_owned(), "*".to_owned()));
        }
        for (name, value) in &options.metadata {
            signed.push((
                format!("{META_PREFIX}{}", name.to_ascii_lowercase()),
                value.clone(),
            ));
        }
        for (name, value) in &signed {
            action.headers_mut().insert(name.clone(), value.clone());
        }
        let url = action.sign(SIGNED_FOR);
        let response = self
            .send(
                Method::PUT,
                url,
                header_map(signed.into_iter())?,
                Some(bytes),
            )
            .await?;
        match response.status() {
            status if status.is_success() => Ok(Some(Stored {
                etag: etag_of(response.headers()),
            })),
            // The key is taken (412), or another conditional write to it is
            // in flight (409, AWS).
            StatusCode::PRECONDITION_FAILED | StatusCode::CONFLICT if options.create_only => {
                Ok(None)
            }
            _ => Err(Self::refused(response, &format!("put {key}")).await),
        }
    }

    async fn get_range(
        &self,
        key: &str,
        range: ByteRange,
    ) -> Result<Option<RangedObject>, PortError> {
        Self::check(key)?;
        let url = self
            .bucket
            .get_object(Some(&self.credentials), key)
            .sign(SIGNED_FOR);
        let headers = header_map(std::iter::once((RANGE.to_string(), range.header())))?;
        let response = self.send(Method::GET, url, headers, None).await?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(None),
            StatusCode::PARTIAL_CONTENT => {
                let headers = response.headers().clone();
                let bytes = response.bytes().await.map_err(PortError::backend)?.to_vec();
                let Some((offset, length, size)) = content_range(&headers) else {
                    return Err(PortError::backend(format!(
                        "S3 get {key}: a 206 without a Content-Range"
                    )));
                };
                Ok(Some(RangedObject {
                    info: info_of(&headers, Some(size)),
                    bytes,
                    range: Some((offset, length)),
                }))
            }
            // The store ignored the range: cut it here.
            StatusCode::OK => {
                let headers = response.headers().clone();
                let bytes = response.bytes().await.map_err(PortError::backend)?.to_vec();
                let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
                let object = StoredObject {
                    info: info_of(&headers, Some(size)),
                    bytes,
                };
                Ok(Some(RangedObject::slice(object, range)))
            }
            // Past the end: the whole object, as the default does.
            StatusCode::RANGE_NOT_SATISFIABLE => {
                Ok(self.get(key).await?.map(|object| RangedObject {
                    info: object.info,
                    bytes: object.bytes,
                    range: None,
                }))
            }
            _ => Err(Self::refused(response, &format!("get {key}")).await),
        }
    }

    async fn get(&self, key: &str) -> Result<Option<StoredObject>, PortError> {
        Self::check(key)?;
        let url = self
            .bucket
            .get_object(Some(&self.credentials), key)
            .sign(SIGNED_FOR);
        let response = self.send(Method::GET, url, HeaderMap::new(), None).await?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => {
                let headers = response.headers().clone();
                let bytes = response.bytes().await.map_err(PortError::backend)?.to_vec();
                let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
                Ok(Some(StoredObject {
                    info: info_of(&headers, Some(size)),
                    bytes,
                }))
            }
            _ => Err(Self::refused(response, &format!("get {key}")).await),
        }
    }

    async fn head(&self, key: &str) -> Result<Option<ObjectInfo>, PortError> {
        Self::check(key)?;
        let url = self
            .bucket
            .head_object(Some(&self.credentials), key)
            .sign(SIGNED_FOR);
        let response = self.send(Method::HEAD, url, HeaderMap::new(), None).await?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => Ok(Some(info_of(response.headers(), None))),
            _ => Err(Self::refused(response, &format!("head {key}")).await),
        }
    }

    async fn delete(&self, key: &str) -> Result<(), PortError> {
        Self::check(key)?;
        let url = self
            .bucket
            .delete_object(Some(&self.credentials), key)
            .sign(SIGNED_FOR);
        let response = self
            .send(Method::DELETE, url, HeaderMap::new(), None)
            .await?;
        // Deleting a missing object is a success in S3 already (204); some
        // compatible stores answer 404.
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(Self::refused(response, &format!("delete {key}")).await)
        }
    }

    async fn delete_many(&self, keys: &[String]) -> Result<(), PortError> {
        let mut unique: Vec<&String> = Vec::with_capacity(keys.len());
        for key in keys {
            Self::check(key)?;
            if !unique.contains(&key) {
                unique.push(key);
            }
        }
        for batch in unique.chunks(DELETE_BATCH) {
            let objects: Vec<ObjectIdentifier> = batch
                .iter()
                .map(|key| ObjectIdentifier::new((*key).clone()))
                .collect();
            let mut action = self
                .bucket
                .delete_objects(Some(&self.credentials), objects.iter());
            action.set_quiet(true);
            let url = action.sign(SIGNED_FOR);
            let (body, content_md5) = action.body_with_md5();
            let headers = header_map(std::iter::once(("content-md5".to_owned(), content_md5)))?;
            let response = self
                .send(Method::POST, url, headers, Some(body.into_bytes()))
                .await?;
            if !response.status().is_success() {
                return Err(Self::refused(response, "delete objects").await);
            }
            let text = response.text().await.map_err(PortError::backend)?;
            let result = DeleteObjectsResponse::parse(&text).map_err(|error| {
                PortError::backend(format!("S3 delete objects response: {error}"))
            })?;
            if let Some(failed) = result.errors.first() {
                return Err(PortError::backend(format!(
                    "S3 delete objects: {} of {} failed, first {}: {} {}",
                    result.errors.len(),
                    batch.len(),
                    failed.key,
                    failed.code,
                    failed.message
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(path_style: bool) -> S3FileStore {
        S3FileStore::new(
            &S3Options {
                endpoint: "http://minio:9000".to_owned(),
                region: "us-east-1".to_owned(),
                bucket: "weldsuite-private".to_owned(),
                access_key_id: "key".to_owned(),
                secret_access_key: "secret".to_owned(),
                path_style,
            },
            Client::new(),
        )
        .expect("a valid endpoint")
    }

    #[test]
    fn urls_follow_the_style() {
        let path = store(true);
        assert_eq!(
            path.bucket.object_url("workspaces/o/a.pdf").as_str(),
            "http://minio:9000/weldsuite-private/workspaces/o/a.pdf"
        );
        let host = store(false);
        assert_eq!(
            host.bucket.object_url("workspaces/o/a.pdf").as_str(),
            "http://weldsuite-private.minio:9000/workspaces/o/a.pdf"
        );
        assert!(
            format!(
                "{:?}",
                S3Options {
                    endpoint: String::new(),
                    region: String::new(),
                    bucket: String::new(),
                    access_key_id: "AKIA".to_owned(),
                    secret_access_key: "very-secret".to_owned(),
                    path_style: true,
                }
            )
            .find("very-secret")
            .is_none()
        );
    }

    #[test]
    fn metadata_comes_from_x_amz_meta_headers() {
        let headers = header_map(
            [
                ("content-type".to_owned(), "application/pdf".to_owned()),
                ("content-length".to_owned(), "12".to_owned()),
                ("x-amz-meta-sha256".to_owned(), "abc".to_owned()),
                ("etag".to_owned(), "\"x\"".to_owned()),
            ]
            .into_iter(),
        )
        .expect("valid headers");
        let info = info_of(&headers, None);
        assert_eq!(info.size, 12);
        assert_eq!(info.content_type.as_deref(), Some("application/pdf"));
        assert_eq!(info.metadata.len(), 1);
        assert_eq!(info.metadata.get("sha256").map(String::as_str), Some("abc"));
        assert_eq!(info.etag.as_deref(), Some("x"));
    }

    #[test]
    fn partial_content_ranges() {
        let headers = header_map(std::iter::once((
            "content-range".to_owned(),
            "bytes 2-4/10".to_owned(),
        )))
        .expect("valid headers");
        assert_eq!(content_range(&headers), Some((2, 3, 10)));
        let weak = header_map(std::iter::once(("etag".to_owned(), "W/\"abc\"".to_owned())))
            .expect("valid headers");
        assert_eq!(etag_of(&weak).as_deref(), Some("abc"));
    }

    #[tokio::test]
    async fn unsafe_keys_never_reach_the_store() {
        let store = store(true);
        assert!(store.get("a/../b").await.is_err());
        assert!(
            store
                .delete_many(&["ok/key".to_owned(), "../x".to_owned()])
                .await
                .is_err()
        );
    }
}
