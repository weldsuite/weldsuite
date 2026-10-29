//! Conformance mode for WeldSign's signer portal (`/public/sign-portal`,
//! ADR FE-017). The portal's calls sit outside the member pipeline, so the
//! test's context (`X-Weld-Conformance`, see `conformance.rs`) is read here
//! instead: the test's tenant database for every link, its master database,
//! env, buckets, and two more of its doubles the portal reaches:
//!
//! ```json
//! { "cache": "http://127.0.0.1:...",  // the test's KV namespace, over the bucket bridge
//!   "jobs": "http://127.0.0.1:..." }  // its Workflow binding (FINALIZE_ENVELOPE), when it has one
//! ```
//!
//! Without `jobs` finalizing runs in the request's background work, as the
//! workers do without the binding. The harness side is
//! `packages/core/worker-kit/src/testing/{bucket-bridge,workflow-bridge}.ts`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use weldsuite_ports::{Cache, DynFileStore, FileStore, JobRequest, Jobs, PortError, PutOptions};
use weldsuite_sign::PortalOverrides;

use crate::conformance::{HEADER, Pools};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortalContext {
    workspace_id: String,
    database_url: String,
    #[serde(default)]
    master_database_url: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    files: HashMap<String, String>,
    /// The test's KV namespace, served as a bucket.
    #[serde(default)]
    cache: Option<String>,
    /// The test's Workflow binding, as a jobs adapter.
    #[serde(default)]
    jobs: Option<String>,
}

/// Middleware on the portal's routes: the test's context, when the request
/// carries one.
pub(crate) async fn context(
    State(pools): State<Arc<Pools>>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(context) = request
        .headers()
        .get(HEADER)
        .and_then(|value| STANDARD.decode(value.as_bytes()).ok())
        .and_then(|bytes| serde_json::from_slice::<PortalContext>(&bytes).ok())
    else {
        return next.run(request).await;
    };
    let db = match pools.get(&context.database_url) {
        Ok(db) => db,
        Err(error) => return error.into_response(),
    };
    let master = match context
        .master_database_url
        .as_deref()
        .map(|url| pools.get(url))
    {
        Some(Ok(master)) => Some(master),
        Some(Err(error)) => return error.into_response(),
        None => None,
    };
    let extensions = request.extensions_mut();
    if let Some(master) = master {
        extensions.insert(weldsuite_db::MasterDb(master));
    }
    extensions.insert(weldsuite_kit::RequestEnv(Arc::new(context.env)));
    if let Some(stores) = pools.buckets.file_stores(&context.files) {
        extensions.insert(stores);
    }
    extensions.insert(PortalOverrides {
        tenant: Some((db, context.workspace_id)),
        cache: context
            .cache
            .as_deref()
            .map(|url| Arc::new(BridgedCache(pools.buckets.store(url))) as _),
        jobs: context
            .jobs
            .as_deref()
            .map(|url| Arc::new(BridgedJobs::new(url)) as _),
    });
    next.run(request).await
}

/// A KV namespace (`createMemoryKv()`) behind the bucket bridge: values are
/// the objects' bytes. Like the test's namespace it keeps a value until it
/// is deleted (TTLs are not modelled), and a counter is read, added to and
/// written back; the suite runs one request at a time.
struct BridgedCache(Arc<dyn DynFileStore>);

impl Cache for BridgedCache {
    async fn get(&self, key: &str) -> Result<Option<String>, PortError> {
        Ok(self
            .0
            .get(key)
            .await?
            .map(|object| String::from_utf8_lossy(&object.bytes).into_owned()))
    }

    async fn put(&self, key: &str, value: &str, _ttl: Option<Duration>) -> Result<(), PortError> {
        self.0
            .put(key, value.as_bytes().to_vec(), &PutOptions::default())
            .await
    }

    async fn delete(&self, key: &str) -> Result<(), PortError> {
        FileStore::delete(&*self.0, key).await
    }

    async fn increment(&self, key: &str, by: i64, ttl: Option<Duration>) -> Result<i64, PortError> {
        let current = match self.get(key).await? {
            Some(value) => value
                .parse::<i64>()
                .map_err(|_| PortError::backend(format!("cache: {key:?} is not an integer")))?,
            None => 0,
        };
        let next = current.saturating_add(by);
        self.put(key, &next.to_string(), ttl).await?;
        Ok(next)
    }
}

/// The test's Workflow binding as the jobs adapter: `POST <bridge>/start`
/// with the job; the bridge creates the instance, or restarts one that
/// failed, as a Workflows adapter would.
struct BridgedJobs {
    url: String,
    client: Client,
}

impl BridgedJobs {
    fn new(url: &str) -> Self {
        Self {
            url: url.trim_end_matches('/').to_owned(),
            client: Client::new(),
        }
    }
}

impl Jobs for BridgedJobs {
    async fn start(&self, request: JobRequest) -> Result<(), PortError> {
        let body = json!({ "name": request.name, "key": request.key, "payload": request.payload });
        let response = self
            .client
            .post(format!("{}/start", self.url))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(PortError::backend)?;
        if response.status().is_success() {
            return Ok(());
        }
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(PortError::backend(format!(
            "jobs bridge answered {status}: {text}"
        )))
    }
}
