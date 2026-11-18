//! Global's replays bucket (`weldsuite-panel-replays`, ADR PANEL-005) inside
//! this install's panel bucket (`S3_BUCKET_PANEL`, ADR EVT-019), which also
//! holds the Iceberg tables under `lake/`.
//!
//! Keys stay Global's, so `replay_chunks_v1.r2_key` and every reader that
//! takes a key from it are the same on both editions; only where they land
//! in the bucket differs: recording chunks (`<tier>/<workspace>/…`, the
//! tier `30d`, `90d` or `keep`) under `replays/`, heatmap snapshots
//! (`snapshots/…`) where they are.

use std::sync::Arc;

use weldsuite_ports::{
    ByteRange, DynFileStore, FileStore, ListedObject, ObjectInfo, PortError, PutOptions,
    RangedObject, Stored, StoredObject,
};

const RECORDINGS: &str = "replays/";
const SNAPSHOTS: &str = "snapshots/";

/// The replays bucket's objects in the panel bucket.
pub struct PanelBucketReplays {
    bucket: Arc<dyn DynFileStore>,
}

impl PanelBucketReplays {
    pub fn new(bucket: Arc<dyn DynFileStore>) -> Self {
        Self { bucket }
    }

    /// The panel bucket's key of a replays-bucket key.
    pub fn key(key: &str) -> String {
        if key.starts_with(SNAPSHOTS) {
            key.to_owned()
        } else {
            format!("{RECORDINGS}{key}")
        }
    }
}

impl FileStore for PanelBucketReplays {
    async fn put(
        &self,
        key: &str,
        bytes: Vec<u8>,
        options: &PutOptions,
    ) -> Result<Option<Stored>, PortError> {
        self.bucket.put_boxed(&Self::key(key), bytes, options).await
    }

    async fn get(&self, key: &str) -> Result<Option<StoredObject>, PortError> {
        self.bucket.get_boxed(&Self::key(key)).await
    }

    async fn get_range(
        &self,
        key: &str,
        range: ByteRange,
    ) -> Result<Option<RangedObject>, PortError> {
        self.bucket.get_range_boxed(&Self::key(key), range).await
    }

    async fn head(&self, key: &str) -> Result<Option<ObjectInfo>, PortError> {
        self.bucket.head_boxed(&Self::key(key)).await
    }

    async fn delete(&self, key: &str) -> Result<(), PortError> {
        self.bucket.delete_boxed(&Self::key(key)).await
    }

    async fn delete_many(&self, keys: &[String]) -> Result<(), PortError> {
        let keys: Vec<String> = keys.iter().map(|key| Self::key(key)).collect();
        self.bucket.delete_many_boxed(&keys).await
    }

    /// The objects under `prefix`: snapshots for a `snapshots/` prefix,
    /// recording chunks for any other, with the replays bucket's keys.
    async fn list(&self, prefix: &str) -> Result<Vec<ListedObject>, PortError> {
        let listed = self.bucket.list_boxed(&Self::key(prefix)).await?;
        Ok(listed
            .into_iter()
            .map(|mut object| {
                if let Some(key) = object.key.strip_prefix(RECORDINGS) {
                    object.key = key.to_owned();
                }
                object
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use weldsuite_ports::MemoryFileStore;

    use super::*;

    #[tokio::test]
    async fn recordings_go_under_replays_and_snapshots_stay() {
        let bucket = Arc::new(MemoryFileStore::default());
        let replays = PanelBucketReplays::new(Arc::clone(&bucket) as Arc<dyn DynFileStore>);
        let chunk = "30d/ws_1/pnp_1/2026-10-27/s-1/0.json.gz";
        let snapshot = "snapshots/ws_1/pnp_1/pnh_products/mobile.json.gz";
        for key in [chunk, snapshot] {
            replays
                .put(key, b"\x1f\x8b".to_vec(), &PutOptions::default())
                .await
                .expect("stored");
        }
        assert_eq!(
            bucket.keys(),
            [format!("replays/{chunk}"), snapshot.to_owned()]
        );
        assert!(replays.get(chunk).await.expect("read").is_some());
        assert_eq!(
            replays
                .list("30d/ws_1/")
                .await
                .expect("listed")
                .into_iter()
                .map(|object| object.key)
                .collect::<Vec<_>>(),
            [chunk]
        );
        replays.delete(chunk).await.expect("deleted");
        assert_eq!(bucket.keys(), [snapshot]);
    }
}
