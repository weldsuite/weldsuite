//! A bucket's objects, from Global's R2 into the install's object storage,
//! with their keys unchanged ([`copy_bucket`]): both backends store a
//! workspace's files under the same keys (`workspaces/<organization id>/…`),
//! so a stored key opens on the install as it did on Global.
//!
//! An object already there with the same size is left alone, so the copy
//! runs again cheaply: incremental passes before the window, a last one
//! inside it.

use std::collections::BTreeMap;

use futures_util::StreamExt as _;
use serde::Serialize;
use weldsuite_ports::{DynFileStore, ListedObject, PutOptions};

use crate::ImportError;

/// Objects copied at once.
const CONCURRENCY: usize = 8;

/// What [`copy_bucket`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesReport {
    /// Objects the source lists under the prefix.
    pub objects: usize,
    pub bytes: u64,
    /// Copied now (or, in a dry run, to copy).
    pub copied: usize,
    pub copied_bytes: u64,
    /// Already there with the same size.
    pub present: usize,
    /// Objects that failed, with why (the first hundred).
    pub failed: Vec<String>,
    pub failed_count: usize,
    pub dry_run: bool,
}

/// Copy every object under `prefix` (`""`: the whole bucket) from `source`
/// to `target`. `dry_run` lists and compares only.
pub async fn copy_bucket(
    source: &dyn DynFileStore,
    target: &dyn DynFileStore,
    prefix: &str,
    dry_run: bool,
) -> Result<FilesReport, ImportError> {
    let listed = source
        .list_boxed(prefix)
        .await
        .map_err(|error| ImportError::failed("listing the source bucket", error))?;
    let present: BTreeMap<String, u64> = target
        .list_boxed(prefix)
        .await
        .map_err(|error| ImportError::failed("listing the target bucket", error))?
        .into_iter()
        .map(|object| (object.key, object.size))
        .collect();
    let mut report = FilesReport {
        objects: listed.len(),
        bytes: listed.iter().map(|object| object.size).sum(),
        dry_run,
        ..FilesReport::default()
    };
    let (todo, there): (Vec<ListedObject>, Vec<ListedObject>) = listed
        .into_iter()
        .partition(|object| present.get(&object.key) != Some(&object.size));
    report.present = there.len();
    if dry_run {
        report.copied = todo.len();
        report.copied_bytes = todo.iter().map(|object| object.size).sum();
        return Ok(report);
    }
    let mut results = futures_util::stream::iter(todo)
        .map(|object| async move {
            let result = copy_object(source, target, &object.key).await;
            (object, result)
        })
        .buffer_unordered(CONCURRENCY);
    while let Some((object, result)) = results.next().await {
        match result {
            Ok(()) => {
                report.copied += 1;
                report.copied_bytes += object.size;
            }
            Err(error) => {
                report.failed_count += 1;
                if report.failed.len() < 100 {
                    report.failed.push(format!("{}: {error}", object.key));
                }
            }
        }
    }
    Ok(report)
}

/// One object, with its content type, disposition and metadata.
async fn copy_object(
    source: &dyn DynFileStore,
    target: &dyn DynFileStore,
    key: &str,
) -> Result<(), String> {
    let Some(object) = source
        .get_boxed(key)
        .await
        .map_err(|error| error.to_string())?
    else {
        // Deleted since the listing: nothing to copy.
        return Ok(());
    };
    let options = PutOptions {
        content_type: object.info.content_type,
        content_disposition: object.info.content_disposition,
        metadata: object.info.metadata,
        create_only: false,
    };
    target
        .put_boxed(key, object.bytes, &options)
        .await
        .map(drop)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use weldsuite_ports::MemoryFileStore;

    use super::*;

    async fn put(store: &MemoryFileStore, key: &str, bytes: &[u8]) {
        store
            .put_boxed(key, bytes.to_vec(), &PutOptions::content_type("image/png"))
            .await
            .expect("put");
    }

    #[tokio::test]
    async fn copies_what_is_missing_or_differs_and_keeps_the_keys() {
        let source = MemoryFileStore::default();
        let target = MemoryFileStore::default();
        put(&source, "workspaces/org_1/a.png", b"aaaa").await;
        put(&source, "workspaces/org_1/b.png", b"bb").await;
        put(&source, "workspaces/org_2/c.png", b"c").await;
        put(&target, "workspaces/org_1/a.png", b"aaaa").await;
        put(&target, "workspaces/org_1/b.png", b"old!").await;

        let dry = copy_bucket(&source, &target, "workspaces/org_1/", true)
            .await
            .expect("dry run");
        assert_eq!((dry.objects, dry.present, dry.copied), (2, 1, 1));
        let stale = target
            .get_boxed("workspaces/org_1/b.png")
            .await
            .expect("get")
            .expect("there");
        assert_eq!(stale.bytes, b"old!", "a dry run writes nothing");

        let report = copy_bucket(&source, &target, "", false)
            .await
            .expect("copy");
        assert_eq!(report.objects, 3);
        assert_eq!(report.present, 1);
        assert_eq!(report.copied, 2);
        assert_eq!(report.copied_bytes, 3);
        assert_eq!(report.failed_count, 0);
        let copied = target
            .get_boxed("workspaces/org_2/c.png")
            .await
            .expect("get")
            .expect("copied");
        assert_eq!(copied.bytes, b"c");
        assert_eq!(copied.info.content_type.as_deref(), Some("image/png"));

        let again = copy_bucket(&source, &target, "", false)
            .await
            .expect("again");
        assert_eq!((again.present, again.copied), (3, 0));
    }
}
