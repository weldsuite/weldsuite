//! The S3 file store against a real S3-compatible server.
//!
//! Runs when `WELDSUITE_TEST_S3_ENDPOINT` points at a throwaway MinIO (or any
//! S3 store), e.g. `http://127.0.0.1:9000`; otherwise each test returns early.
//! Credentials come from `WELDSUITE_TEST_S3_ACCESS_KEY_ID` and
//! `WELDSUITE_TEST_S3_SECRET_ACCESS_KEY` (MinIO's `minioadmin` defaults). The
//! test creates its bucket and uses a per-run key prefix.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use weldsuite_adapters_oss::{S3FileStore, S3Options};
use weldsuite_ports::{ByteRange, FileStore, PutOptions};

const BUCKET: &str = "weldsuite-test";

fn options() -> Option<S3Options> {
    let Ok(endpoint) = std::env::var("WELDSUITE_TEST_S3_ENDPOINT") else {
        eprintln!("WELDSUITE_TEST_S3_ENDPOINT is not set; skipping");
        return None;
    };
    let var =
        |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.to_owned());
    Some(S3Options {
        endpoint,
        region: var("WELDSUITE_TEST_S3_REGION", "us-east-1"),
        bucket: BUCKET.to_owned(),
        access_key_id: var("WELDSUITE_TEST_S3_ACCESS_KEY_ID", "minioadmin"),
        secret_access_key: var("WELDSUITE_TEST_S3_SECRET_ACCESS_KEY", "minioadmin"),
        path_style: true,
    })
}

/// Create the test bucket; one that exists already is fine.
async fn ensure_bucket(options: &S3Options) {
    let bucket = Bucket::new(
        options.endpoint.parse().expect("endpoint"),
        UrlStyle::Path,
        BUCKET,
        options.region.clone(),
    )
    .expect("bucket");
    let credentials = Credentials::new(
        options.access_key_id.clone(),
        options.secret_access_key.clone(),
    );
    let url = bucket
        .create_bucket(&credentials)
        .sign(Duration::from_secs(60));
    let response = reqwest::Client::new()
        .put(url)
        .header("content-length", 0)
        .send()
        .await
        .expect("create bucket");
    let status = response.status();
    assert!(
        status.is_success() || status.as_u16() == 409,
        "create bucket: {status}"
    );
}

fn prefix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("workspaces/org_test/weldsign/run{nanos}")
}

#[tokio::test]
async fn objects_round_trip_with_type_and_metadata() {
    let Some(options) = options() else { return };
    ensure_bucket(&options).await;
    let store = S3FileStore::new(&options, reqwest::Client::new()).expect("store");
    let key = format!("{}/sgd_1.pdf", prefix());

    assert_eq!(store.get(&key).await.expect("get"), None);
    assert_eq!(store.head(&key).await.expect("head"), None);

    let pdf = b"%PDF-1.7 test".to_vec();
    store
        .put(
            &key,
            pdf.clone(),
            &PutOptions::content_type("application/pdf").with_metadata("sha256", "abc123"),
        )
        .await
        .expect("put");

    let object = store.get(&key).await.expect("get").expect("stored");
    assert_eq!(object.bytes, pdf);
    assert_eq!(object.info.size, 13);
    assert_eq!(object.info.content_type.as_deref(), Some("application/pdf"));
    assert_eq!(
        object.info.metadata.get("sha256").map(String::as_str),
        Some("abc123")
    );
    let info = store.head(&key).await.expect("head").expect("stored");
    assert_eq!(info, object.info);

    // An empty object, then the delete paths.
    let empty = format!("{}/empty", prefix());
    store
        .put(&empty, Vec::new(), &PutOptions::default())
        .await
        .expect("put empty");
    assert_eq!(
        store.get(&empty).await.expect("get").expect("stored").bytes,
        b""
    );

    store.delete(&empty).await.expect("delete");
    store.delete(&empty).await.expect("delete again");
    assert_eq!(store.head(&empty).await.expect("head"), None);
}

#[tokio::test]
async fn create_only_puts_ranges_and_entity_tags() {
    let Some(options) = options() else { return };
    ensure_bucket(&options).await;
    let store = S3FileStore::new(&options, reqwest::Client::new()).expect("store");
    let key = format!("{}/upload.bin", prefix());
    let once = PutOptions {
        content_type: Some("application/octet-stream".to_owned()),
        content_disposition: Some("attachment".to_owned()),
        create_only: true,
        ..PutOptions::default()
    };
    let stored = store
        .put(&key, b"0123456789".to_vec(), &once)
        .await
        .expect("put")
        .expect("the key was free");
    assert!(stored.etag.as_deref().is_some_and(|etag| !etag.is_empty()));
    assert_eq!(
        store
            .put(&key, b"other".to_vec(), &once)
            .await
            .expect("put"),
        None
    );
    let info = store.head(&key).await.expect("head").expect("stored");
    assert_eq!(info.size, 10);
    assert_eq!(info.etag, stored.etag);
    assert_eq!(info.content_disposition.as_deref(), Some("attachment"));

    let part = store
        .get_range(&key, ByteRange::parse("bytes=2-4").expect("range"))
        .await
        .expect("get")
        .expect("stored");
    assert_eq!(part.bytes, b"234");
    assert_eq!((part.range, part.info.size), (Some((2, 3)), 10));
    let tail = store
        .get_range(&key, ByteRange::Suffix(3))
        .await
        .expect("get")
        .expect("stored");
    assert_eq!(
        (tail.bytes.as_slice(), tail.range),
        (&b"789"[..], Some((7, 3)))
    );
    let beyond = store
        .get_range(&key, ByteRange::parse("bytes=50-").expect("range"))
        .await
        .expect("get")
        .expect("stored");
    assert_eq!((beyond.bytes.len(), beyond.range), (10, None));
    store.delete(&key).await.expect("delete");
}

#[tokio::test]
async fn many_objects_go_in_one_delete() {
    let Some(options) = options() else { return };
    ensure_bucket(&options).await;
    let store = S3FileStore::new(&options, reqwest::Client::new()).expect("store");
    let prefix = prefix();
    let keys: Vec<String> = (0..5).map(|i| format!("{prefix}/sig_{i}.png")).collect();
    for key in &keys {
        store
            .put(key, vec![1, 2, 3], &PutOptions::content_type("image/png"))
            .await
            .expect("put");
    }
    let mut with_missing = keys.clone();
    with_missing.push(format!("{prefix}/never-stored"));
    with_missing.push(keys[0].clone());
    store.delete_many(&with_missing).await.expect("delete many");
    for key in &keys {
        assert_eq!(store.head(key).await.expect("head"), None, "{key}");
    }
    store.delete_many(&[]).await.expect("nothing to delete");
}
