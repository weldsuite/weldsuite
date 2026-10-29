//! Object storage: the port behind the workers' R2 buckets. Two stores per
//! deployment, as two buckets in TypeScript
//! (`packages/core/worker-kit/src/storage.ts`):
//!
//! - the **private** store (`PRIVATE_STORAGE`), with no public URL, for
//!   everything a member or signer must be authorised to read (WeldSign's
//!   documents, signatures and signed PDFs, ADR SIGN-004);
//! - the **public** store (`STORAGE`), read by modules only for objects from
//!   before the private bucket existed ([`get_stored`]).
//!
//! Keys look the same in both (`workspaces/<workspaceId>/…`). Objects carry a
//! content type and string metadata (R2's `httpMetadata.contentType` and
//! `customMetadata`, S3's `Content-Type` and `x-amz-meta-*`).

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::{BoxFuture, PortError};

/// What a stored object says about itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObjectInfo {
    pub size: u64,
    pub content_type: Option<String>,
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
    pub metadata: BTreeMap<String, String>,
}

impl PutOptions {
    pub fn content_type(content_type: impl Into<String>) -> Self {
        Self {
            content_type: Some(content_type.into()),
            metadata: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn with_metadata(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.metadata
            .insert(key.into().to_ascii_lowercase(), value.into());
        self
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
    fn put(
        &self,
        key: &str,
        bytes: Vec<u8>,
        options: &PutOptions,
    ) -> impl Future<Output = Result<(), PortError>> + Send;

    fn get(
        &self,
        key: &str,
    ) -> impl Future<Output = Result<Option<StoredObject>, PortError>> + Send;

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
    ) -> BoxFuture<'a, Result<(), PortError>>;
    fn get_boxed<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<StoredObject>, PortError>>;
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
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(self.put(key, bytes, options))
    }

    fn get_boxed<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, Result<Option<StoredObject>, PortError>> {
        Box::pin(self.get(key))
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
    async fn put(&self, key: &str, bytes: Vec<u8>, options: &PutOptions) -> Result<(), PortError> {
        self.put_boxed(key, bytes, options).await
    }

    async fn get(&self, key: &str) -> Result<Option<StoredObject>, PortError> {
        self.get_boxed(key).await
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
    ) -> impl Future<Output = Result<(), PortError>> + Send {
        (**self).put(key, bytes, options)
    }

    fn get(
        &self,
        key: &str,
    ) -> impl Future<Output = Result<Option<StoredObject>, PortError>> + Send {
        (**self).get(key)
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
    ) -> impl Future<Output = Result<(), PortError>> + Send {
        let result = if is_safe_key(key) {
            let info = ObjectInfo {
                size: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
                content_type: options.content_type.clone(),
                metadata: options.metadata.clone(),
            };
            self.objects()
                .insert(key.to_owned(), StoredObject { info, bytes });
            Ok(())
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
        store
            .put(
                key,
                b"%PDF".to_vec(),
                &PutOptions::content_type("application/pdf").with_metadata("SHA256", "abc"),
            )
            .await
            .expect("call");
        let object = store.get(key).await.expect("call").expect("stored");
        assert_eq!(object.bytes, b"%PDF");
        assert_eq!(object.info.size, 4);
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
