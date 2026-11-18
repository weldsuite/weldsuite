//! Conformance mode's WeldPanel bindings: the test's streams
//! (`PANEL_EVENTS`, `PANEL_REPLAY_CHUNKS`) through the harness's pipeline
//! bridge (`packages/core/worker-kit/src/testing/pipeline-bridge.ts`,
//! `POST /send { binding, records }`), its `PANEL_SALT`, `PANEL_USAGE` and
//! `PANEL_PROJECT` Durable Object namespaces through the ledger bridge
//! (`ledger-bridge.ts`, `POST /rpc { binding, name, method, args }`), its
//! rate-limiting bindings through the rate-limit bridge
//! (`rate-limit-bridge.ts`, `POST /limit { binding, key }`) and its
//! `PANEL_REPLAYS` bucket through the bucket bridge, so both backends hash
//! with the same salt, count on the same objects, read and change the same
//! project state, store in the same bucket and write to the same fakes. The
//! bridge records every `PANEL_PROJECT` call, and both backends' calls are
//! compared.

use std::collections::HashMap;
use std::sync::Arc;

use reqwest::Client;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use weldsuite_panel::project_state::{
    DeleteGroupInput, EraseInput, Erasure, Group, GroupOpsInput, GroupOpsResult, GroupsPage,
    Identified, IdentifyInput, ListGroupsInput, ListPeopleInput, Live, LiveTouch, PeopleOpsInput,
    PeoplePage, Person,
};
use weldsuite_panel::{
    EventSink, Limit, PanelProjectState, ProjectRef, RateLimiter, RequestCollector, SaltSource,
    UsageCounter,
};
use weldsuite_ports::{BoxFuture, DynFileStore, PortError};

/// The panel bindings of one test.
#[derive(Default)]
pub(crate) struct PanelBridges {
    client: Client,
}

/// Where the test's panel bindings are served.
pub(crate) struct PanelBindings<'a> {
    pub(crate) ledgers: &'a HashMap<String, String>,
    pub(crate) pipelines: &'a HashMap<String, String>,
    pub(crate) rate_limits: &'a HashMap<String, String>,
    /// Its `PANEL_REPLAYS` bucket, over the bucket bridge.
    pub(crate) replays: Option<Arc<dyn DynFileStore>>,
}

impl PanelBridges {
    /// The test's streams, namespaces, bucket and limits, each one it binds.
    pub(crate) fn collector(&self, bindings: PanelBindings<'_>) -> RequestCollector {
        let namespace = |binding: &'static str| {
            bindings.ledgers.get(binding).map(|bridge| Namespace {
                bridge: bridge.trim_end_matches('/').to_owned(),
                binding,
                client: self.client.clone(),
            })
        };
        let stream = |binding: &'static str| {
            bindings.pipelines.get(binding).map(|bridge| {
                Arc::new(Stream {
                    bridge: bridge.trim_end_matches('/').to_owned(),
                    binding,
                    client: self.client.clone(),
                }) as Arc<dyn EventSink>
            })
        };
        let limits = (!bindings.rate_limits.is_empty()).then(|| {
            Arc::new(Limiter {
                bridges: bindings
                    .rate_limits
                    .iter()
                    .map(|(binding, bridge)| {
                        (binding.clone(), bridge.trim_end_matches('/').to_owned())
                    })
                    .collect(),
                client: self.client.clone(),
            }) as Arc<dyn RateLimiter>
        });
        RequestCollector {
            salt: namespace("PANEL_SALT").map(|ns| Arc::new(ns) as Arc<dyn SaltSource>),
            usage: namespace("PANEL_USAGE").map(|ns| Arc::new(ns) as Arc<dyn UsageCounter>),
            sink: stream("PANEL_EVENTS"),
            chunks: stream("PANEL_REPLAY_CHUNKS"),
            replays: bindings.replays,
            limits,
            // `PANEL_PROJECT`, when the test binds it.
            project_state: self.project_state(bindings.ledgers).0,
        }
    }
}

impl PanelBridges {
    /// The test's `PANEL_PROJECT` namespace as the project state, or none
    /// when the test binds none (queries then answer 503, as panel-api does).
    pub(crate) fn project_state(
        &self,
        ledgers: &HashMap<String, String>,
    ) -> weldsuite_panel::RequestProjectState {
        weldsuite_panel::RequestProjectState(ledgers.get("PANEL_PROJECT").map(|bridge| {
            Arc::new(Namespace {
                bridge: bridge.trim_end_matches('/').to_owned(),
                binding: "PANEL_PROJECT",
                client: self.client.clone(),
            }) as Arc<dyn PanelProjectState>
        }))
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
            self.call(workspace_id, "add", json!([day, events, workspace_id]))
                .await
                .map(|_| ())
        })
    }

    fn add_recordings<'a>(
        &'a self,
        workspace_id: &'a str,
        day: &'a str,
        recordings: u64,
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            self.call(
                workspace_id,
                "addRecordings",
                json!([day, recordings, workspace_id]),
            )
            .await
            .map(|_| ())
        })
    }
}

impl Namespace {
    /// `stub[method](...args)` on the project's object (named by the
    /// project id, as `projectObjectStub` names it), its answer read as `T`
    /// (`undefined` and `null` both read as `null`).
    async fn rpc<T: DeserializeOwned>(
        &self,
        project: ProjectRef<'_>,
        method: &str,
        args: Value,
    ) -> Result<T, PortError> {
        let result = self.call(project.project_id, method, args).await?;
        serde_json::from_value(result).map_err(PortError::Json)
    }
}

/// A value as an RPC argument.
fn arg<T: Serialize + ?Sized>(value: &T) -> Result<Value, PortError> {
    serde_json::to_value(value).map_err(PortError::Json)
}

/// `PANEL_PROJECT`: each method as `PanelProjectObjectApi` names it, with
/// its arguments in order.
impl PanelProjectState for Namespace {
    fn identify<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a IdentifyInput,
    ) -> BoxFuture<'a, Result<Identified, PortError>> {
        Box::pin(async move { self.rpc(project, "identify", json!([arg(input)?])).await })
    }

    fn apply_people_ops<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a PeopleOpsInput,
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            self.rpc::<Value>(project, "applyPeopleOps", json!([arg(input)?]))
                .await
                .map(|_| ())
        })
    }

    fn touch_live<'a>(
        &'a self,
        project: ProjectRef<'a>,
        touches: &'a [LiveTouch],
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            self.rpc::<Value>(project, "touchLive", json!([arg(touches)?]))
                .await
                .map(|_| ())
        })
    }

    fn get_person<'a>(
        &'a self,
        project: ProjectRef<'a>,
        user_id_or_anon_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<Person>, PortError>> {
        Box::pin(async move {
            self.rpc(project, "getPerson", json!([user_id_or_anon_id]))
                .await
        })
    }

    fn list_people<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a ListPeopleInput,
    ) -> BoxFuture<'a, Result<PeoplePage, PortError>> {
        Box::pin(async move { self.rpc(project, "listPeople", json!([arg(input)?])).await })
    }

    fn find_by_email<'a>(
        &'a self,
        project: ProjectRef<'a>,
        email: &'a str,
    ) -> BoxFuture<'a, Result<Vec<Person>, PortError>> {
        Box::pin(async move { self.rpc(project, "findByEmail", json!([email])).await })
    }

    fn live<'a>(&'a self, project: ProjectRef<'a>) -> BoxFuture<'a, Result<Live, PortError>> {
        Box::pin(async move { self.rpc(project, "live", json!([])).await })
    }

    fn erase<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a EraseInput,
    ) -> BoxFuture<'a, Result<Erasure, PortError>> {
        Box::pin(async move { self.rpc(project, "erase", json!([arg(input)?])).await })
    }

    fn erased_ids<'a>(
        &'a self,
        project: ProjectRef<'a>,
    ) -> BoxFuture<'a, Result<Vec<String>, PortError>> {
        Box::pin(async move {
            self.rpc::<Option<Vec<String>>>(project, "erasedIds", json!([]))
                .await
                .map(Option::unwrap_or_default)
        })
    }

    fn has_identified_users<'a>(
        &'a self,
        project: ProjectRef<'a>,
    ) -> BoxFuture<'a, Result<bool, PortError>> {
        Box::pin(async move {
            self.rpc::<Option<bool>>(project, "hasIdentifiedUsers", json!([]))
                .await
                .map(Option::unwrap_or_default)
        })
    }

    fn clear_erased<'a>(
        &'a self,
        project: ProjectRef<'a>,
        ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            self.rpc::<Value>(project, "clearErased", json!([ids]))
                .await
                .map(|_| ())
        })
    }

    fn apply_group_ops<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a GroupOpsInput,
    ) -> BoxFuture<'a, Result<GroupOpsResult, PortError>> {
        Box::pin(async move {
            self.rpc(project, "applyGroupOps", json!([arg(input)?]))
                .await
        })
    }

    fn ensure_group_types<'a>(
        &'a self,
        project: ProjectRef<'a>,
        types: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<String>, PortError>> {
        Box::pin(async move { self.rpc(project, "ensureGroupTypes", json!([types])).await })
    }

    fn group_types<'a>(
        &'a self,
        project: ProjectRef<'a>,
    ) -> BoxFuture<'a, Result<Vec<String>, PortError>> {
        Box::pin(async move { self.rpc(project, "groupTypes", json!([])).await })
    }

    fn release_group_type<'a>(
        &'a self,
        project: ProjectRef<'a>,
        group_type: &'a str,
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            self.rpc::<Value>(project, "releaseGroupType", json!([group_type]))
                .await
                .map(|_| ())
        })
    }

    fn get_group<'a>(
        &'a self,
        project: ProjectRef<'a>,
        group_type: &'a str,
        group_key: &'a str,
    ) -> BoxFuture<'a, Result<Option<Group>, PortError>> {
        Box::pin(async move {
            self.rpc(project, "getGroup", json!([group_type, group_key]))
                .await
        })
    }

    fn list_groups<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a ListGroupsInput,
    ) -> BoxFuture<'a, Result<GroupsPage, PortError>> {
        Box::pin(async move { self.rpc(project, "listGroups", json!([arg(input)?])).await })
    }

    fn delete_group<'a>(
        &'a self,
        project: ProjectRef<'a>,
        input: &'a DeleteGroupInput,
    ) -> BoxFuture<'a, Result<bool, PortError>> {
        Box::pin(async move { self.rpc(project, "deleteGroup", json!([arg(input)?])).await })
    }
}

/// One of the test's streams.
struct Stream {
    bridge: String,
    binding: &'static str,
    client: Client,
}

impl EventSink for Stream {
    fn send<'a>(&'a self, rows: &'a [Value]) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            let response = self
                .client
                .post(format!("{}/send", self.bridge))
                .header("content-type", "application/json")
                .body(json!({ "binding": self.binding, "records": rows }).to_string())
                .send()
                .await
                .map_err(PortError::backend)?;
            if response.status().is_success() {
                Ok(())
            } else {
                Err(PortError::backend(format!(
                    "the {} stream answered {}",
                    self.binding,
                    response.status()
                )))
            }
        })
    }
}

impl PanelBridges {
    /// The test's `PANEL_MAINTENANCE` queue (served by the pipeline bridge,
    /// one message per call), or none when the test binds none.
    pub(crate) fn erasure_queue(
        &self,
        pipelines: &HashMap<String, String>,
    ) -> weldsuite_panel::RequestErasureQueue {
        weldsuite_panel::RequestErasureQueue(pipelines.get("PANEL_MAINTENANCE").map(|bridge| {
            Arc::new(Stream {
                bridge: bridge.trim_end_matches('/').to_owned(),
                binding: "PANEL_MAINTENANCE",
                client: self.client.clone(),
            }) as Arc<dyn weldsuite_panel::ErasureQueue>
        }))
    }

    /// The test's `PANEL_REPLAYS` bucket over the bucket bridge, its deletes
    /// sent as R2's `delete(keys)`: one call per batch, as panel-api makes.
    pub(crate) fn replays(
        &self,
        bridge: &str,
        store: Arc<dyn DynFileStore>,
    ) -> Arc<dyn DynFileStore> {
        Arc::new(BatchDeletes {
            bridge: bridge.trim_end_matches('/').to_owned(),
            store,
            client: self.client.clone(),
        })
    }
}

impl weldsuite_panel::ErasureQueue for Stream {
    fn send<'a>(
        &'a self,
        message: &'a weldsuite_panel::EraseMessage,
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            let record = serde_json::to_value(message).map_err(PortError::Json)?;
            EventSink::send(self, std::slice::from_ref(&record)).await
        })
    }
}

/// A bucket over the bucket bridge whose `delete_many` is one
/// `POST /delete-many` (the stub's `delete(keys)`), as R2 deletes a batch.
struct BatchDeletes {
    bridge: String,
    store: Arc<dyn DynFileStore>,
    client: Client,
}

impl weldsuite_ports::FileStore for BatchDeletes {
    async fn put(
        &self,
        key: &str,
        bytes: Vec<u8>,
        options: &weldsuite_ports::PutOptions,
    ) -> Result<Option<weldsuite_ports::Stored>, PortError> {
        self.store.put_boxed(key, bytes, options).await
    }

    async fn get(&self, key: &str) -> Result<Option<weldsuite_ports::StoredObject>, PortError> {
        self.store.get_boxed(key).await
    }

    async fn get_range(
        &self,
        key: &str,
        range: weldsuite_ports::ByteRange,
    ) -> Result<Option<weldsuite_ports::RangedObject>, PortError> {
        self.store.get_range_boxed(key, range).await
    }

    async fn head(&self, key: &str) -> Result<Option<weldsuite_ports::ObjectInfo>, PortError> {
        self.store.head_boxed(key).await
    }

    async fn delete(&self, key: &str) -> Result<(), PortError> {
        self.store.delete_boxed(key).await
    }

    async fn delete_many(&self, keys: &[String]) -> Result<(), PortError> {
        if keys.is_empty() {
            return Ok(());
        }
        let response = self
            .client
            .post(format!("{}/delete-many", self.bridge))
            .header("content-type", "application/json")
            .body(json!({ "keys": keys }).to_string())
            .send()
            .await
            .map_err(PortError::backend)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(PortError::backend(format!(
                "the bucket answered {} to a batch delete",
                response.status()
            )))
        }
    }

    async fn list(&self, prefix: &str) -> Result<Vec<weldsuite_ports::ListedObject>, PortError> {
        self.store.list_boxed(prefix).await
    }
}

/// The test's rate-limiting bindings, by name; one it doesn't bind lets
/// every request through, as the worker without it does.
struct Limiter {
    bridges: HashMap<String, String>,
    client: Client,
}

impl RateLimiter for Limiter {
    fn limit<'a>(&'a self, limit: Limit, key: &'a str) -> BoxFuture<'a, Result<bool, PortError>> {
        Box::pin(async move {
            let Some(bridge) = self.bridges.get(limit.binding()) else {
                return Ok(true);
            };
            let response = self
                .client
                .post(format!("{bridge}/limit"))
                .header("content-type", "application/json")
                .body(json!({ "binding": limit.binding(), "key": key }).to_string())
                .send()
                .await
                .map_err(PortError::backend)?;
            let status = response.status();
            let text = response.text().await.map_err(PortError::backend)?;
            let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if !status.is_success() {
                return Err(PortError::backend(
                    body["error"]
                        .as_str()
                        .unwrap_or("the rate limiter threw")
                        .to_owned(),
                ));
            }
            body["success"]
                .as_bool()
                .ok_or_else(|| PortError::backend("the rate limiter answered no outcome"))
        })
    }
}

impl PanelBridges {
    /// The workspace behind a public share link: what the test's
    /// `getWorkspaceContextForOrg` answers (through the workspace bridge),
    /// with its tenant database, the one such a test hands out.
    pub(crate) fn share_workspaces(
        &self,
        db: weldsuite_db::PgPool,
        workspace_id: &str,
        bridge: Option<&str>,
    ) -> weldsuite_panel::RequestWorkspaceTenants {
        weldsuite_panel::RequestWorkspaceTenants(Arc::new(TestWorkspaces {
            db,
            workspace_id: workspace_id.to_owned(),
            bridge: bridge.map(|bridge| bridge.trim_end_matches('/').to_owned()),
            client: self.client.clone(),
        }))
    }

    /// The test's `PANEL_SHARE_RATE_LIMIT`, or none (nothing is limited, as
    /// the Worker without the binding).
    pub(crate) fn share_rate_limit(
        &self,
        ledgers: &HashMap<String, String>,
    ) -> weldsuite_panel::RequestShareRateLimit {
        weldsuite_panel::RequestShareRateLimit(ledgers.get("PANEL_SHARE_RATE_LIMIT").map(
            |bridge| {
                Arc::new(Namespace {
                    bridge: bridge.trim_end_matches('/').to_owned(),
                    binding: "PANEL_SHARE_RATE_LIMIT",
                    client: self.client.clone(),
                }) as Arc<dyn weldsuite_panel::ShareRateLimit>
            },
        ))
    }
}

/// `PANEL_SHARE_RATE_LIMIT.limit({ key })`: a rate-limiting binding, served
/// by the ledger bridge without a name.
impl weldsuite_panel::ShareRateLimit for Namespace {
    fn limit<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, PortError>> {
        Box::pin(async move {
            let outcome = self.call("", "limit", json!([{ "key": key }])).await?;
            Ok(outcome["success"].as_bool().unwrap_or(true))
        })
    }
}

/// The test's workspaces, as its share-link routes open them.
struct TestWorkspaces {
    db: weldsuite_db::PgPool,
    /// The context's workspace: the only one there is without the bridge.
    workspace_id: String,
    bridge: Option<String>,
    client: Client,
}

impl weldsuite_panel::WorkspaceTenants for TestWorkspaces {
    fn open<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<weldsuite_panel::OpenedWorkspace>, PortError>> {
        Box::pin(async move {
            let opened = |suspended: bool| {
                Some(weldsuite_panel::OpenedWorkspace {
                    db: self.db.clone(),
                    suspended,
                })
            };
            let Some(bridge) = &self.bridge else {
                return Ok((workspace_id == self.workspace_id)
                    .then(|| opened(false))
                    .flatten());
            };
            let response = self
                .client
                .post(format!("{bridge}/workspace"))
                .header("content-type", "application/json")
                .body(json!({ "reference": workspace_id }).to_string())
                .send()
                .await
                .map_err(PortError::backend)?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            let text = response.text().await.map_err(PortError::backend)?;
            let body: Value = serde_json::from_str(&text).map_err(PortError::Json)?;
            Ok(opened(body["suspended"].as_bool() == Some(true)))
        })
    }
}
