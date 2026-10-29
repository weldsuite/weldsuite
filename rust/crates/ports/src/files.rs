//! Object storage: the port behind the workers' R2 buckets. Two stores per
//! deployment, as two buckets in TypeScript
//! (`packages/core/worker-kit/src/storage.ts`):
//!
//! - the **private** store (`PRIVATE_STORAGE`), with no public URL, for
//!   everything a member or signer must be authorised to read (WeldSign's
//!   documents, signatures and signed PDFs, ADR SIGN-004);
//! - the **public** store (`STORAGE`), for what is meant to be public
//!   (avatars, logos) and objects from before the private bucket existed
//!   ([`get_stored`]).
//!
//! Keys look the same in both (`workspaces/<workspaceId>/…`). Objects carry a
//! content type, a content disposition and string metadata (R2's
//! `httpMetadata` and `customMetadata`, S3's `Content-Type`,
//! `Content-Disposition` and `x-amz-meta-*`).

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::{BoxFuture, PortError};

/// What a stored object says about itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObjectInfo {
    pub size: u64,
    pub content_type: Option<String>,
    /// R2's `httpMetadata.contentDisposition`, S3's `Content-Disposition`.
    pub content_disposition: Option<String>,
    /// The entity tag, unquoted (R2's `etag`; `httpEtag` is it in quotes).
    pub etag: Option<String>,
    /// Lower-case keys, as S3 returns `x-amz-meta-*` headers.
    pub metadata: BTreeMap<String, String>,
}

/// An object with its bytes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredObject {
    pub info: ObjectInfo,
    pub bytes: Vec<u8>,
}

/// What to store with an object's bytes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PutOptions {
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
    pub metadata: BTreeMap<String, String>,
    /// Write only while the key is free (R2's `onlyIf: { etagDoesNotMatch:
    /// '*' }`, S3's `If-None-Match: *`). The store decides atomically, so of
    /// two writers only one wins.
    pub create_only: bool,
}

impl PutOptions {
    pub fn content_type(content_type: impl Into<String>) -> Self {
        Self {
            content_type: Some(content_type.into()),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn with_metadata(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.metadata
            .insert(key.into().to_ascii_lowercase(), value.into());
        self
    }
}

/// What a put stored.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stored {
    /// The new object's entity tag, unquoted, when the store reports one.
    pub etag: Option<String>,
}

/// Part of an object (R2's `range` option, from an HTTP `Range` header).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByteRange {
    /// `bytes=<offset>-[<last>]`: `length` bytes from `offset`, to the end
    /// when `None`.
    From { offset: u64, length: Option<u64> },
    /// `bytes=-<n>`: the last `n` bytes.
    Suffix(u64),
}

impl ByteRange {
    /// A single-range `Range` header (`bytes=0-99`, `bytes=100-`,
    /// `bytes=-100`); `None` for anything else, which is served whole.
    pub fn parse(header: &str) -> Option<Self> {
        let spec = header.trim().strip_prefix("bytes=")?.trim();
        if spec.contains(',') {
            return None;
        }
        let (start, end) = spec.split_once('-')?;
        let (start, end) = (start.trim(), end.trim());
        let number = |text: &str| -> Option<u64> {
            if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            text.parse().ok()
        };
        match (start.is_empty(), end.is_empty()) {
            (true, false) => number(end).filter(|n| *n > 0).map(Self::Suffix),
            (false, true) => number(start).map(|offset| Self::From {
                offset,
                length: None,
            }),
            (false, false) => {
                let (offset, last) = (number(start)?, number(end)?);
                (last >= offset).then(|| Self::From {
                    offset,
                    length: Some(last - offset + 1),
                })
            }
            (true, true) => None,
        }
    }

    /// The `(offset, length)` this range covers in an object of `size`
    /// bytes, cut at its end; `None` when it starts past the end.
    pub fn resolve(self, size: u64) -> Option<(u64, u64)> {
        match self {
            Self::From { offset, length } => {
                if offset >= size {
                    return None;
                }
                let available = size - offset;
                Some((offset, length.map_or(available, |l| l.min(available))))
            }
            Self::Suffix(n) => {
                if size == 0 {
                    return None;
                }
                let length = n.min(size);
                Some((size - length, length))
            }
        }
    }

    /// The `Range` header value asking for exactly this range.
    pub fn header(self) -> String {
        match self {
            Self::From {
                offset,
                length: None,
            } => format!("bytes={offset}-"),
            Self::From {
                offset,
                length: Some(length),
            } => format!(
                "bytes={offset}-{}",
                offset.saturating_add(length).saturating_sub(1)
            ),
            Self::Suffix(n) => format!("bytes=-{n}"),
        }
    }
}

/// An object read with a range.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RangedObject {
    /// The whole object's metadata (`size` is the whole object's).
    pub info: ObjectInfo,
    /// The bytes served: the range, or the whole object.
    pub bytes: Vec<u8>,
    /// `(offset, length)` when a sub-range was served; `None` for the whole
    /// object (a range the object can't satisfy is served whole).
    pub range: Option<(u64, u64)>,
}

impl RangedObject {
    /// `range` of `object`, or all of it when the range starts past its end.
    pub fn slice(object: StoredObject, range: ByteRange) -> Self {
        let size = u64::try_from(object.bytes.len()).unwrap_or(u64::MAX);
        match range.resolve(size) {
            Some((offset, length)) => {
                let start = usize::try_from(offset).unwrap_or(usize::MAX);
                let end = usize::try_from(offset.saturating_add(length)).unwrap_or(usize::MAX);
                let bytes = object.bytes.get(start..end).map(<[u8]>::to_vec);
                Self {
                    info: object.info,
                    bytes: bytes.unwrap_or_default(),
                    range: Some((offset, length)),
                }
            }
            None => Self {
                info: object.info,
                bytes: object.bytes,
                range: None,
            },
        }
    }
}

/// A key with no traversal, absolute-path or empty-segment tricks
/// (`isSafeObjectKey`). Stores refuse other keys: S3 resolves `.` and `..`
/// segments in a URL, so `a/../b` would reach another object.
pub fn is_safe_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 1000
        && !key.starts_with('/')
        && !key
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
}

/// The refusal for a key [`is_safe_key`] rejects.
pub fn unsafe_key(key: &str) -> PortError {
    PortError::backend(format!("refusing unsafe object key {key:?}"))
}

/// One bucket. A missing object is `None`, not an error; deleting one is fine.
pub trait FileStore: Send + Sync {
    /// Store `bytes` under `key`. `None` only for a
    /// [`create_only`](PutOptions::create_only) put whose key was taken.
    fn put(
        &self,
        key: &str,
        bytes: Vec<u8>,
        options: &PutOptions,
    ) -> impl Future<Output = Result<Option<Stored>, PortError>> + Send;

    fn get(
        &self,
        key: &str,
    ) -> impl Future<Output = Result<Option<StoredObject>, PortError>> + Send;

    /// Part of an object. By default the whole object is read and cut; a
    /// store that can ask for the range alone does.
    fn get_range(
        &self,
        key: &str,
        range: ByteRange,
    ) -> impl Future<Output = Result<Option<RangedObject>, PortError>> + Send {
        async move {
            Ok(self
                .get(key)
                .await?
                .map(|object| RangedObject::slice(object, range)))
        }
    }

    fn head(&self, key: &str)
    -> impl Future<Output = Result<Option<ObjectInfo>, PortError>> + Send;

    fn delete(&self, key: &str) -> impl Future<Output = Result<(), PortError>> + Send;

    /// R2's `delete([...])`: every key, in as few requests as the store
    /// allows.
    fn delete_many(&self, keys: &[String]) -> impl Future<Output = Result<(), PortError>> + Send;
}

/// Object-safe [`FileStore`], for `Arc<dyn DynFileStore>`.
pub trait DynFileStore: Send + Sync {
    fn put_boxed<'a>(
        &'a self,
        key: &'a str,
        bytes: Vec<u8>,
        options: &'a PutOptions,
    ) -> BoxFuture<'a, Result<Option<Stored>, PortError>>;
    fn get_boxed<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<StoredObject>, PortError>>;
    fn get_range_boxed<'a>(
        &'a self,
        key: &'a str,
        range: ByteRange,
    ) -> BoxFuture<'a, Result<Option<RangedObject>, PortError>>;
    fn head_boxed<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<ObjectInfo>, PortError>>;
    fn delete_boxed<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), PortError>>;
    fn delete_many_boxed<'a>(&'a self, keys: &'a [String]) -> BoxFuture<'a, Result<(), PortError>>;
}

impl<F: FileStore> DynFileStore for F {
    fn put_boxed<'a>(
        &'a self,
        key: &'a str,
        bytes: Vec<u8>,
        options: &'a PutOptions,
    ) -> BoxFuture<'a, Result<Option<Stored>, PortError>> {
        Box::pin(self.put(key, bytes, options))
    }

    fn get_boxed<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<StoredObject>, PortError>> {
        Box::pin(self.get(key))
    }

    fn get_range_boxed<'a>(
        &'a self,
        key: &'a str,
        range: ByteRange,
    ) -> BoxFuture<'a, Result<Option<RangedObject>, PortError>> {
        Box::pin(self.get_range(key, range))
    }

    fn head_boxed<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<ObjectInfo>, PortError>> {
        Box::pin(self.head(key))
    }

    fn delete_boxed<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(self.delete(key))
    }

    fn delete_many_boxed<'a>(&'a self, keys: &'a [String]) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(self.delete_many(keys))
    }
}

impl FileStore for dyn DynFileStore {
    async fn put(
        &self,
        key: &str,
        bytes: Vec<u8>,
        options: &PutOptions,
    ) -> Result<Option<Stored>, PortError> {
        self.put_boxed(key, bytes, options).await
    }

    async fn get(&self, key: &str) -> Result<Option<StoredObject>, PortError> {
        self.get_boxed(key).await
    }

    async fn get_range(
        &self,
        key: &str,
        range: ByteRange,
    ) -> Result<Option<RangedObject>, PortError> {
        self.get_range_boxed(key, range).await
    }

    async fn head(&self, key: &str) -> Result<Option<ObjectInfo>, PortError> {
        self.head_boxed(key).await
    }

    async fn delete(&self, key: &str) -> Result<(), PortError> {
        self.delete_boxed(key).await
    }

    async fn delete_many(&self, keys: &[String]) -> Result<(), PortError> {
        self.delete_many_boxed(keys).await
    }
}

impl<F: FileStore + ?Sized> FileStore for Arc<F> {
    fn put(
        &self,
        key: &str,
        bytes: Vec<u8>,
        options: &PutOptions,
    ) -> impl Future<Output = Result<Option<Stored>, PortError>> + Send {
        (**self).put(key, bytes, options)
    }

    fn get(
        &self,
        key: &str,
    ) -> impl Future<Output = Result<Option<StoredObject>, PortError>> + Send {
        (**self).get(key)
    }

    fn get_range(
        &self,
        key: &str,
        range: ByteRange,
    ) -> impl Future<Output = Result<Option<RangedObject>, PortError>> + Send {
        (**self).get_range(key, range)
    }

    fn head(
        &self,
        key: &str,
    ) -> impl Future<Output = Result<Option<ObjectInfo>, PortError>> + Send {
        (**self).head(key)
    }

    fn delete(&self, key: &str) -> impl Future<Output = Result<(), PortError>> + Send {
        (**self).delete(key)
    }

    fn delete_many(&self, keys: &[String]) -> impl Future<Output = Result<(), PortError>> + Send {
        (**self).delete_many(keys)
    }
}

/// `getStoredObject`: the private store first, then the public one, for
/// objects stored before the private bucket existed.
pub async fn get_stored(
    private: &dyn DynFileStore,
    public: Option<&dyn DynFileStore>,
    key: &str,
) -> Result<Option<StoredObject>, PortError> {
    if let Some(object) = private.get_boxed(key).await? {
        return Ok(Some(object));
    }
    match public {
        Some(public) => public.get_boxed(key).await,
        None => Ok(None),
    }
}

/// FNV-1a over `bytes`: the memory store's entity tags.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// An in-memory bucket, for tests and conformance builds.
#[derive(Debug, Default)]
pub struct MemoryFileStore {
    objects: Mutex<BTreeMap<String, StoredObject>>,
}

impl MemoryFileStore {
    fn objects(&self) -> MutexGuard<'_, BTreeMap<String, StoredObject>> {
        self.objects.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every key, sorted.
    pub fn keys(&self) -> Vec<String> {
        self.objects().keys().cloned().collect()
    }

    pub fn clear(&self) {
        self.objects().clear();
    }
}

impl FileStore for MemoryFileStore {
    fn put(
        &self,
        key: &str,
        bytes: Vec<u8>,
        options: &PutOptions,
    ) -> impl Future<Output = Result<Option<Stored>, PortError>> + Send {
        let result = if is_safe_key(key) {
            let etag = format!("{:016x}", fnv1a(&bytes));
            let info = ObjectInfo {
                size: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
                content_type: options.content_type.clone(),
                content_disposition: options.content_disposition.clone(),
                etag: Some(etag.clone()),
                metadata: options.metadata.clone(),
            };
            let mut objects = self.objects();
            if options.create_only && objects.contains_key(key) {
                Ok(None)
            } else {
                objects.insert(key.to_owned(), StoredObject { info, bytes });
                Ok(Some(Stored { etag: Some(etag) }))
            }
        } else {
            Err(unsafe_key(key))
        };
        std::future::ready(result)
    }

    fn get(
        &self,
        key: &str,
    ) -> impl Future<Output = Result<Option<StoredObject>, PortError>> + Send {
        std::future::ready(Ok(self.objects().get(key).cloned()))
    }

    fn head(
        &self,
        key: &str,
    ) -> impl Future<Output = Result<Option<ObjectInfo>, PortError>> + Send {
        std::future::ready(Ok(self
            .objects()
            .get(key)
            .map(|object| object.info.clone())))
    }

    fn delete(&self, key: &str) -> impl Future<Output = Result<(), PortError>> + Send {
        self.objects().remove(key);
        std::future::ready(Ok(()))
    }

    fn delete_many(&self, keys: &[String]) -> impl Future<Output = Result<(), PortError>> + Send {
        let keys: HashSet<&String> = keys.iter().collect();
        self.objects().retain(|key, _| !keys.contains(key));
        std::future::ready(Ok(()))
    }
}

/// The buckets a request reads and writes: the private one, and the legacy
/// public one read-only. Modules take them from the app state; conformance
/// builds insert them as a request extension instead, pointing at the test's
/// own buckets, and that wins.
#[derive(Clone)]
pub struct FileStores {
    pub private: Arc<dyn DynFileStore>,
    pub public: Option<Arc<dyn DynFileStore>>,
}

impl std::fmt::Debug for FileStores {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileStores")
            .field("public", &self.public.is_some())
            .finish_non_exhaustive()
    }
}

/// Both buckets, each optional, for the routes that check them one by one
/// as the workers check `env.PRIVATE_STORAGE` and `env.STORAGE` (the upload
/// broker writes public objects too). Conformance builds insert it as a
/// request extension whenever a test has any bucket, so a test with only
/// `STORAGE` is seen as one without the private bucket.
#[derive(Clone, Default)]
pub struct StorageBuckets {
    pub private: Option<Arc<dyn DynFileStore>>,
    pub public: Option<Arc<dyn DynFileStore>>,
}

impl From<FileStores> for StorageBuckets {
    fn from(stores: FileStores) -> Self {
        Self {
            private: Some(stores.private),
            public: stores.public,
        }
    }
}

impl std::fmt::Debug for StorageBuckets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StorageBuckets")
            .field("private", &self.private.is_some())
            .field("public", &self.public.is_some())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_like_is_safe_object_key() {
        assert!(is_safe_key("workspaces/org_1/weldsign/sge_1/sgd_1.pdf"));
        for bad in [
            "",
            "/abs",
            "a//b",
            "a/./b",
            "a/../b",
            "a/",
            "..",
            &"x".repeat(1001),
        ] {
            assert!(!is_safe_key(bad), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn the_memory_store_keeps_bytes_type_and_metadata() {
        let store = MemoryFileStore::default();
        let key = "workspaces/org_1/weldsign/sge_1/sgd_1.pdf";
        assert_eq!(store.get(key).await.expect("call"), None);
        let stored = store
            .put(
                key,
                b"%PDF".to_vec(),
                &PutOptions::content_type("application/pdf").with_metadata("SHA256", "abc"),
            )
            .await
            .expect("call")
            .expect("stored");
        let object = store.get(key).await.expect("call").expect("stored");
        assert_eq!(object.bytes, b"%PDF");
        assert_eq!(object.info.size, 4);
        assert_eq!(object.info.etag, stored.etag);
        assert_eq!(object.info.content_type.as_deref(), Some("application/pdf"));
        assert_eq!(
            object.info.metadata.get("sha256").map(String::as_str),
            Some("abc")
        );
        assert_eq!(store.head(key).await.expect("call"), Some(object.info));

        store
            .put("workspaces/org_1/b", vec![], &PutOptions::default())
            .await
            .expect("call");
        store
            .delete_many(&[key.to_owned(), "workspaces/org_1/missing".to_owned()])
            .await
            .expect("call");
        assert_eq!(store.keys(), vec!["workspaces/org_1/b".to_owned()]);
        store.delete("workspaces/org_1/b").await.expect("call");
        store.delete("workspaces/org_1/b").await.expect("call");
        assert_eq!(store.keys(), Vec::<String>::new());
        assert!(
            store
                .put("a/../b", vec![], &PutOptions::default())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn create_only_puts_write_once() {
        let store = MemoryFileStore::default();
        let key = "workspaces/org_1/uploads/a.bin";
        let once = PutOptions {
            create_only: true,
            ..PutOptions::default()
        };
        assert!(
            store
                .put(key, vec![1], &once)
                .await
                .expect("call")
                .is_some()
        );
        assert!(
            store
                .put(key, vec![2], &once)
                .await
                .expect("call")
                .is_none()
        );
        assert_eq!(
            store.get(key).await.expect("call").expect("kept").bytes,
            [1]
        );
        // Without the precondition a put replaces.
        assert!(
            store
                .put(key, vec![3], &PutOptions::default())
                .await
                .expect("call")
                .is_some()
        );
        assert_eq!(
            store.get(key).await.expect("call").expect("kept").bytes,
            [3]
        );
    }

    #[test]
    fn range_headers() {
        let from = |offset, length| ByteRange::From { offset, length };
        assert_eq!(ByteRange::parse("bytes=0-99"), Some(from(0, Some(100))));
        assert_eq!(ByteRange::parse("bytes=100-"), Some(from(100, None)));
        assert_eq!(ByteRange::parse("bytes=-5"), Some(ByteRange::Suffix(5)));
        for bad in [
            "bytes=5-1",
            "bytes=-0",
            "bytes=0-1,4-5",
            "items=0-1",
            "bytes=a-",
            "bytes=-",
        ] {
            assert_eq!(ByteRange::parse(bad), None, "{bad}");
        }
        assert_eq!(from(2, Some(100)).resolve(10), Some((2, 8)));
        assert_eq!(from(10, None).resolve(10), None);
        assert_eq!(ByteRange::Suffix(4).resolve(10), Some((6, 4)));
        assert_eq!(ByteRange::Suffix(40).resolve(10), Some((0, 10)));
        assert_eq!(from(2, Some(3)).header(), "bytes=2-4");
        assert_eq!(from(2, None).header(), "bytes=2-");
        assert_eq!(ByteRange::Suffix(4).header(), "bytes=-4");
    }

    #[tokio::test]
    async fn ranges_are_cut_from_the_whole_object_by_default() {
        let store = MemoryFileStore::default();
        let key = "workspaces/org_1/clip.mp4";
        store
            .put(key, b"0123456789".to_vec(), &PutOptions::default())
            .await
            .expect("call");
        let part = store
            .get_range(key, ByteRange::parse("bytes=2-4").expect("range"))
            .await
            .expect("call")
            .expect("stored");
        assert_eq!(
            (part.bytes.as_slice(), part.range),
            (&b"234"[..], Some((2, 3)))
        );
        assert_eq!(part.info.size, 10);
        let whole = store
            .get_range(key, ByteRange::parse("bytes=20-").expect("range"))
            .await
            .expect("call")
            .expect("stored");
        assert_eq!((whole.bytes.len(), whole.range), (10, None));
        assert!(
            store
                .get_range("workspaces/org_1/none", ByteRange::Suffix(1))
                .await
                .expect("call")
                .is_none()
        );
    }

    #[tokio::test]
    async fn stored_objects_fall_back_to_the_public_store() {
        let private = MemoryFileStore::default();
        let public = MemoryFileStore::default();
        public
            .put(
                "workspaces/org_1/old.pdf",
                b"old".to_vec(),
                &PutOptions::default(),
            )
            .await
            .expect("call");
        private
            .put(
                "workspaces/org_1/new.pdf",
                b"new".to_vec(),
                &PutOptions::default(),
            )
            .await
            .expect("call");
        let read = |key: &'static str| get_stored(&private, Some(&public), key);
        assert_eq!(
            read("workspaces/org_1/old.pdf")
                .await
                .expect("call")
                .expect("stored")
                .bytes,
            b"old"
        );
        assert_eq!(
            read("workspaces/org_1/new.pdf")
                .await
                .expect("call")
                .expect("stored")
                .bytes,
            b"new"
        );
        assert_eq!(read("workspaces/org_1/none.pdf").await.expect("call"), None);
        assert_eq!(
            get_stored(&private, None, "workspaces/org_1/old.pdf")
                .await
                .expect("call"),
            None
        );
    }
}
