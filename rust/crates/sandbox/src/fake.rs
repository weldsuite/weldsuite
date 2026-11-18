//! Test doubles: an in-memory pod API ([`FakePods`]) and an HTTP client that
//! answers from a function and records what it was sent ([`RecordingHttp`]),
//! for the Kubernetes API, the agents in the pods and `SearXNG` alike.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

use crate::error::SandboxError;
use crate::kube::{PodApi, PodInfo};

type Answer = dyn Fn(&HttpRequest) -> (u16, Value) + Send + Sync;

/// An HTTP client answering with `answer(request)` (status, JSON body).
#[derive(Clone)]
pub struct RecordingHttp {
    answer: Arc<Answer>,
    calls: Arc<Mutex<Vec<HttpRequest>>>,
}

impl RecordingHttp {
    pub fn new(answer: impl Fn(&HttpRequest) -> (u16, Value) + Send + Sync + 'static) -> Self {
        Self {
            answer: Arc::new(answer),
            calls: Arc::default(),
        }
    }

    pub fn outbound(&self) -> OutboundHttp {
        OutboundHttp(Arc::new(self.clone()))
    }

    /// Every request, in order.
    pub fn calls(&self) -> Vec<HttpRequest> {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl DynOutboundHttp for RecordingHttp {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        let (status, body) = (self.answer)(&request);
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(request);
        let body = serde_json::to_vec(&body).unwrap_or_default();
        Box::pin(std::future::ready(Ok(HttpResponse::new(status, body))))
    }
}

#[derive(Default)]
struct State {
    pods: BTreeMap<String, Value>,
    created: Vec<Value>,
    deleted: Vec<String>,
    next_ip: u8,
}

/// Pods in memory. A created pod is `Running` with an address at once,
/// unless [`FakePods::starting_with`] says otherwise.
#[derive(Clone, Default)]
pub struct FakePods {
    state: Arc<Mutex<State>>,
    start: Option<(String, Option<String>)>,
}

impl FakePods {
    /// New pods start in `phase`, their container waiting for `reason`.
    #[must_use]
    pub fn starting_with(mut self, phase: &str, reason: Option<&str>) -> Self {
        self.start = Some((phase.to_owned(), reason.map(str::to_owned)));
        self
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The manifests that were created, in order.
    pub fn created(&self) -> Vec<Value> {
        self.state().created.clone()
    }

    /// The names that were deleted, in order.
    pub fn deleted(&self) -> Vec<String> {
        self.state().deleted.clone()
    }

    /// The pods there are now.
    pub fn names(&self) -> Vec<String> {
        self.state().pods.keys().cloned().collect()
    }

    /// Moves a pod to `phase`.
    pub fn set_phase(&self, name: &str, phase: &str) {
        if let Some(pod) = self.state().pods.get_mut(name) {
            pod["status"]["phase"] = Value::String(phase.to_owned());
        }
    }

    /// Adds a sandbox pod created at `created`.
    pub fn insert(&self, name: &str, phase: &str, created: OffsetDateTime) {
        let at = created
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let pod = serde_json::json!({
            "metadata": {
                "name": name,
                "creationTimestamp": at,
                "labels": {
                    crate::kube::LABEL_NAME: crate::kube::NAME,
                    crate::kube::LABEL_MANAGED_BY: crate::kube::MANAGER,
                },
            },
            "status": { "phase": phase, "podIP": "10.244.9.9" },
        });
        self.state().pods.insert(name.to_owned(), pod);
    }
}

/// `a=b,c=d` against the pod's labels.
fn matches(pod: &Value, selector: &str) -> bool {
    selector
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .all(|pair| {
            let Some((key, value)) = pair.trim().split_once('=') else {
                return false;
            };
            pod["metadata"]["labels"][key.trim()].as_str() == Some(value.trim())
        })
}

impl PodApi for FakePods {
    fn create(&self, manifest: Value) -> BoxFuture<'_, Result<PodInfo, SandboxError>> {
        let result = (|| {
            let mut state = self.state();
            let name = manifest["metadata"]["name"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            if state.pods.contains_key(&name) {
                return Err(SandboxError::Kube(
                    409,
                    format!("pods \"{name}\" already exists"),
                ));
            }
            state.created.push(manifest.clone());
            state.next_ip = state.next_ip.wrapping_add(1);
            let mut pod = manifest;
            let (phase, reason) = self
                .start
                .clone()
                .unwrap_or_else(|| ("Running".to_owned(), None));
            pod["metadata"]["creationTimestamp"] = Value::String(
                OffsetDateTime::now_utc()
                    .format(&time::format_description::well_known::Rfc3339)
                    .unwrap_or_default(),
            );
            pod["status"] = serde_json::json!({ "phase": phase });
            if phase == "Running" {
                pod["status"]["podIP"] = Value::String(format!("10.244.0.{}", state.next_ip));
            }
            if let Some(reason) = reason {
                pod["status"]["containerStatuses"] =
                    serde_json::json!([{ "state": { "waiting": { "reason": reason } } }]);
            }
            state.pods.insert(name, pod.clone());
            PodInfo::from_json(&pod).ok_or_else(|| SandboxError::Kube(500, "bad pod".to_owned()))
        })();
        Box::pin(std::future::ready(result))
    }

    fn get<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Option<PodInfo>, SandboxError>> {
        let pod = self.state().pods.get(name).and_then(PodInfo::from_json);
        Box::pin(std::future::ready(Ok(pod)))
    }

    fn list<'a>(&'a self, selector: &'a str) -> BoxFuture<'a, Result<Vec<PodInfo>, SandboxError>> {
        let pods = self
            .state()
            .pods
            .values()
            .filter(|pod| matches(pod, selector))
            .filter_map(PodInfo::from_json)
            .collect();
        Box::pin(std::future::ready(Ok(pods)))
    }

    fn delete<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), SandboxError>> {
        let mut state = self.state();
        if state.pods.remove(name).is_some() {
            state.deleted.push(name.to_owned());
        }
        Box::pin(std::future::ready(Ok(())))
    }
}
