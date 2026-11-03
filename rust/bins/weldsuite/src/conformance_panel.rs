//! Conformance mode's WeldPanel collector bindings: the test's events
//! stream (`PANEL_EVENTS`) through the harness's pipeline bridge
//! (`packages/core/worker-kit/src/testing/pipeline-bridge.ts`,
//! `POST /send { binding, records }`), and its `PANEL_SALT` and
//! `PANEL_USAGE` Durable Object namespaces through the ledger bridge
//! (`ledger-bridge.ts`, `POST /rpc { binding, name, method, args }`), so
//! both backends hash with the same salt, count on the same objects and
//! write to the same fake.

use std::collections::HashMap;
use std::sync::Arc;

use reqwest::Client;
use serde_json::{Value, json};
use weldsuite_panel::{EventSink, RequestCollector, SaltSource, UsageCounter};
use weldsuite_ports::{BoxFuture, PortError};

/// The panel bindings of one test.
#[derive(Default)]
pub(crate) struct PanelBridges {
    client: Client,
}

impl PanelBridges {
    /// The test's stream and namespaces, each one it binds.
    pub(crate) fn collector(
        &self,
        ledgers: &HashMap<String, String>,
        pipelines: &HashMap<String, String>,
    ) -> RequestCollector {
        let namespace = |binding: &'static str| {
            ledgers.get(binding).map(|bridge| Namespace {
                bridge: bridge.trim_end_matches('/').to_owned(),
                binding,
                client: self.client.clone(),
            })
        };
        RequestCollector {
            salt: namespace("PANEL_SALT").map(|ns| Arc::new(ns) as Arc<dyn SaltSource>),
            usage: namespace("PANEL_USAGE").map(|ns| Arc::new(ns) as Arc<dyn UsageCounter>),
            sink: pipelines.get("PANEL_EVENTS").map(|bridge| {
                Arc::new(Stream {
                    bridge: bridge.trim_end_matches('/').to_owned(),
                    client: self.client.clone(),
                }) as Arc<dyn EventSink>
            }),
        }
    }
}

/// One Durable Object namespace through the ledger bridge.
struct Namespace {
    bridge: String,
    binding: &'static str,
    client: Client,
}

impl Namespace {
    async fn call(&self, name: &str, method: &str, args: Value) -> Result<Value, PortError> {
        let response = self
            .client
            .post(format!("{}/rpc", self.bridge))
            .header("content-type", "application/json")
            .body(
                json!({ "binding": self.binding, "name": name, "method": method, "args": args })
                    .to_string(),
            )
            .send()
            .await
            .map_err(PortError::backend)?;
        let status = response.status();
        let text = response.text().await.map_err(PortError::backend)?;
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !status.is_success() {
            let message = body["error"]
                .as_str()
                .unwrap_or("the stub threw")
                .to_owned();
            return Err(PortError::backend(message));
        }
        Ok(body["result"].clone())
    }
}

impl SaltSource for Namespace {
    fn today(&self, _now_ms: i64) -> BoxFuture<'_, Result<String, PortError>> {
        Box::pin(async move {
            let result = self.call("global", "today", json!([])).await?;
            result["salt"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| PortError::backend("PanelSalt.today() answered no salt"))
        })
    }
}

impl UsageCounter for Namespace {
    fn add<'a>(
        &'a self,
        workspace_id: &'a str,
        day: &'a str,
        events: u64,
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            self.call(workspace_id, "add", json!([day, events]))
                .await
                .map(|_| ())
        })
    }
}

/// The test's `PANEL_EVENTS` stream.
struct Stream {
    bridge: String,
    client: Client,
}

impl EventSink for Stream {
    fn send<'a>(&'a self, rows: &'a [Value]) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            let response = self
                .client
                .post(format!("{}/send", self.bridge))
                .header("content-type", "application/json")
                .body(json!({ "binding": "PANEL_EVENTS", "records": rows }).to_string())
                .send()
                .await
                .map_err(PortError::backend)?;
            if response.status().is_success() {
                Ok(())
            } else {
                Err(PortError::backend(format!(
                    "the events stream answered {}",
                    response.status()
                )))
            }
        })
    }
}
