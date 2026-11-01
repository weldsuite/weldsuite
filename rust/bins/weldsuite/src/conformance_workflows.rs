//! Conformance mode's Workflow bindings: the test's `EXECUTE_SEQUENCE`,
//! `SEND_SCHEDULED_EMAIL` and `WELDDATA_ENRICH` (fakes
//! with `create` and `get`) over HTTP, served by
//! `packages/core/worker-kit/src/testing/workflow-bridge.ts`
//! (`POST /rpc { binding, method, id, args }`). The sequence routes then
//! start and wake runs on the same fake as the TypeScript run, and both
//! runs' calls are compared. A test without the binding gets none, as the
//! worker then skips the trigger.

use std::collections::HashMap;
use std::sync::Arc;

use reqwest::Client;
use serde_json::{Value, json};
use weldsuite_crm::{RunStart, SequenceRuns};
use weldsuite_ports::BoxFuture;

/// One Workflow binding through the bridge.
struct BridgedWorkflow {
    bridge: String,
    binding: &'static str,
    client: Client,
}

impl BridgedWorkflow {
    /// One call; `Err` with the fake's message when it threw.
    async fn call(&self, method: &str, id: &str, args: Value) -> Result<(), String> {
        self.call_as(method, Value::from(id), args).await
    }

    /// One call under `id` as recorded (`null` for an instance created
    /// without one).
    async fn call_as(&self, method: &str, id: Value, args: Value) -> Result<(), String> {
        let response = self
            .client
            .post(format!("{}/rpc", self.bridge))
            .header("content-type", "application/json")
            .body(
                json!({ "binding": self.binding, "method": method, "id": id, "args": args })
                    .to_string(),
            )
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response.status().is_success() {
            return Ok(());
        }
        let text = response.text().await.unwrap_or_default();
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        Err(body["error"]
            .as_str()
            .unwrap_or("workflow call failed")
            .to_owned())
    }
}

impl SequenceRuns for BridgedWorkflow {
    /// `binding.create({ id, params })`; on a failure, `binding.get(id)`
    /// tells a run that is already there from one that is not.
    fn start<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, RunStart> {
        Box::pin(async move {
            let created = self
                .call("create", id, json!({ "id": id, "params": params }))
                .await;
            match created {
                Ok(()) => RunStart::Triggered,
                Err(error) => match self.call("get", id, Value::Null).await {
                    Ok(()) => RunStart::Exists,
                    Err(_) => RunStart::Failed(error),
                },
            }
        })
    }

    /// `(await binding.get(id)).sendEvent({ type, payload: {} })`.
    fn wake<'a>(&'a self, id: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            if self.call("get", id, Value::Null).await.is_err() {
                return false;
            }
            let event = json!({
                "type": weldsuite_crm::SEQUENCE_RESUME_EVENT,
                "payload": {},
            });
            self.call("sendEvent", id, event).await.is_ok()
        })
    }
}

impl BridgedWorkflow {
    /// One call, answering the bridge's `result` (`{ id }` for a `create`).
    async fn call_for_result(&self, method: &str, id: Value, args: Value) -> Result<Value, String> {
        let response = self
            .client
            .post(format!("{}/rpc", self.bridge))
            .header("content-type", "application/json")
            .body(
                json!({ "binding": self.binding, "method": method, "id": id, "args": args })
                    .to_string(),
            )
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let ok = response.status().is_success();
        let text = response.text().await.unwrap_or_default();
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if ok {
            return Ok(body["result"].clone());
        }
        Err(body["error"]
            .as_str()
            .unwrap_or("workflow call failed")
            .to_owned())
    }
}

impl weldsuite_connect::WorkflowRuns for BridgedWorkflow {
    /// `binding.create({ params })`: the instance id the fake answered.
    fn create<'a>(&'a self, params: &'a Value) -> BoxFuture<'a, Result<String, String>> {
        weldsuite_connect::WorkflowRuns::start(self, None, params)
    }

    /// `binding.create({ id, params })` (`{ params }` without an id).
    fn start<'a>(
        &'a self,
        id: Option<&'a str>,
        params: &'a Value,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let (recorded, args) = match id {
                Some(id) => (Value::from(id), json!({ "id": id, "params": params })),
                None => (Value::Null, json!({ "params": params })),
            };
            let result = self.call_for_result("create", recorded, args).await?;
            Ok(result["id"].as_str().unwrap_or_default().to_owned())
        })
    }

    /// `(await binding.get(id)).terminate()`.
    fn terminate<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.call("get", id, Value::Null).await?;
            self.call("terminate", id, Value::Null).await
        })
    }

    /// `(await binding.get(id)).sendEvent({ type, payload })`.
    fn send_event<'a>(
        &'a self,
        id: &'a str,
        event_type: &'a str,
        payload: &'a Value,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.call("get", id, Value::Null).await?;
            self.call(
                "sendEvent",
                id,
                json!({ "type": event_type, "payload": payload }),
            )
            .await
        })
    }
}

impl weldsuite_connect::ProjectSyncRuns for BridgedWorkflow {
    /// `binding.create({ id, params })`.
    fn create<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(self.call("create", id, json!({ "id": id, "params": params })))
    }
}

impl weldsuite_data::EnrichRuns for BridgedWorkflow {
    /// `binding.create(options)`, without an instance id.
    fn create<'a>(&'a self, options: &'a Value) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(self.call_as("create", Value::Null, options.clone()))
    }
}

impl weldsuite_mail::scheduled::ScheduledRuns for BridgedWorkflow {
    /// `binding.create({ id, params })`; the instance id is the one asked for.
    fn create<'a>(
        &'a self,
        id: &'a str,
        params: &'a Value,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            self.call("create", id, json!({ "id": id, "params": params }))
                .await
                .map(|()| id.to_owned())
        })
    }

    /// `(await binding.get(id)).terminate()`, best effort.
    fn terminate<'a>(&'a self, id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if self.call("get", id, Value::Null).await.is_ok() {
                let _ = self.call("terminate", id, Value::Null).await;
            }
        })
    }
}

/// The bridged Workflow bindings, one HTTP client per process.
#[derive(Default)]
pub(crate) struct WorkflowBridges {
    client: Client,
}

impl WorkflowBridges {
    /// The test's `SEND_SCHEDULED_EMAIL`, from `{ SEND_SCHEDULED_EMAIL: url }`.
    pub(crate) fn scheduled_runs(
        &self,
        workflows: &HashMap<String, String>,
    ) -> Option<Arc<dyn weldsuite_mail::scheduled::ScheduledRuns>> {
        workflows.get("SEND_SCHEDULED_EMAIL").map(|bridge| {
            Arc::new(BridgedWorkflow {
                bridge: bridge.trim_end_matches('/').to_owned(),
                binding: "SEND_SCHEDULED_EMAIL",
                client: self.client.clone(),
            }) as Arc<dyn weldsuite_mail::scheduled::ScheduledRuns>
        })
    }

    /// The test's `WELDDATA_ENRICH`, from `{ WELDDATA_ENRICH: url }`.
    pub(crate) fn enrich_runs(
        &self,
        workflows: &HashMap<String, String>,
    ) -> Option<Arc<dyn weldsuite_data::EnrichRuns>> {
        workflows.get("WELDDATA_ENRICH").map(|bridge| {
            Arc::new(BridgedWorkflow {
                bridge: bridge.trim_end_matches('/').to_owned(),
                binding: "WELDDATA_ENRICH",
                client: self.client.clone(),
            }) as Arc<dyn weldsuite_data::EnrichRuns>
        })
    }

    /// The test's `EXECUTE_WORKFLOW`, from `{ EXECUTE_WORKFLOW: url }`.
    pub(crate) fn execute_runs(
        &self,
        workflows: &HashMap<String, String>,
    ) -> Option<Arc<dyn weldsuite_connect::WorkflowRuns>> {
        workflows.get("EXECUTE_WORKFLOW").map(|bridge| {
            Arc::new(BridgedWorkflow {
                bridge: bridge.trim_end_matches('/').to_owned(),
                binding: "EXECUTE_WORKFLOW",
                client: self.client.clone(),
            }) as Arc<dyn weldsuite_connect::WorkflowRuns>
        })
    }

    /// The test's `GITHUB_PROJECT_SYNC`, from `{ GITHUB_PROJECT_SYNC: url }`.
    pub(crate) fn project_sync_runs(
        &self,
        workflows: &HashMap<String, String>,
    ) -> Option<Arc<dyn weldsuite_connect::ProjectSyncRuns>> {
        workflows.get("GITHUB_PROJECT_SYNC").map(|bridge| {
            Arc::new(BridgedWorkflow {
                bridge: bridge.trim_end_matches('/').to_owned(),
                binding: "GITHUB_PROJECT_SYNC",
                client: self.client.clone(),
            }) as Arc<dyn weldsuite_connect::ProjectSyncRuns>
        })
    }

    /// The test's `EXECUTE_SEQUENCE`, from `{ EXECUTE_SEQUENCE: url }`.
    pub(crate) fn sequence_runs(
        &self,
        workflows: &HashMap<String, String>,
    ) -> Option<Arc<dyn SequenceRuns>> {
        workflows.get("EXECUTE_SEQUENCE").map(|bridge| {
            Arc::new(BridgedWorkflow {
                bridge: bridge.trim_end_matches('/').to_owned(),
                binding: "EXECUTE_SEQUENCE",
                client: self.client.clone(),
            }) as Arc<dyn SequenceRuns>
        })
    }
}
