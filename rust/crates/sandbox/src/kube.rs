//! The sandbox pods through the Kubernetes API: the port ([`PodApi`]), its
//! adapter over plain REST ([`KubePods`], the in-cluster service account's
//! token over [`OutboundHttp`]) and the pod each sandbox runs as
//! ([`pod_manifest`]).
//!
//! The service account may only create, read, list and delete pods in the
//! sandbox namespace (the chart's `Role`), and the namespace admits only pods
//! of the shape [`pod_manifest`] writes: gVisor, no service-account token, no
//! host access, the sandbox image (Pod Security `restricted` and the chart's
//! `ValidatingAdmissionPolicy`). So a server that is taken over can start
//! sandboxes, and nothing else.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

use crate::config::{AGENT_PORT, SandboxConfig};
use crate::error::SandboxError;
use crate::session::SessionKey;

/// The labels every sandbox pod carries.
pub const LABEL_NAME: &str = "app.kubernetes.io/name";
pub const LABEL_MANAGED_BY: &str = "app.kubernetes.io/managed-by";
pub const LABEL_WORKSPACE: &str = "weldsuite.org/sandbox-workspace";
pub const LABEL_SESSION: &str = "weldsuite.org/sandbox-session";
pub const NAME: &str = "weldsuite-sandbox";
pub const MANAGER: &str = "weldsuite";

/// Selects every sandbox pod this install manages.
pub fn all_selector() -> String {
    format!("{LABEL_NAME}={NAME},{LABEL_MANAGED_BY}={MANAGER}")
}

/// A pod as the server needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PodInfo {
    pub name: String,
    /// `Pending`, `Running`, `Succeeded`, `Failed` or `Unknown`.
    pub phase: String,
    pub ip: Option<String>,
    pub created: Option<OffsetDateTime>,
    /// Being deleted (`metadata.deletionTimestamp`).
    pub deleting: bool,
    /// Why its container is waiting or ended (`ErrImagePull`, `OOMKilled`, …).
    pub reason: Option<String>,
    pub labels: BTreeMap<String, String>,
}

impl PodInfo {
    /// From the API's JSON.
    pub fn from_json(pod: &Value) -> Option<Self> {
        let metadata = pod.get("metadata")?;
        let name = metadata.get("name")?.as_str()?.to_owned();
        let status = pod.get("status").cloned().unwrap_or(Value::Null);
        let reason = status
            .get("containerStatuses")
            .and_then(Value::as_array)
            .and_then(|list| list.first())
            .and_then(|c| c.get("state"))
            .and_then(|state| {
                state
                    .get("waiting")
                    .or_else(|| state.get("terminated"))
                    .and_then(|s| s.get("reason"))
            })
            .or_else(|| status.get("reason"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Some(Self {
            name,
            phase: status
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or("Pending")
                .to_owned(),
            ip: status
                .get("podIP")
                .and_then(Value::as_str)
                .filter(|ip| !ip.is_empty())
                .map(str::to_owned),
            created: metadata
                .get("creationTimestamp")
                .and_then(Value::as_str)
                .and_then(|at| OffsetDateTime::parse(at, &Rfc3339).ok()),
            deleting: metadata
                .get("deletionTimestamp")
                .is_some_and(|v| !v.is_null()),
            reason,
            labels: metadata
                .get("labels")
                .and_then(Value::as_object)
                .map(|labels| {
                    labels
                        .iter()
                        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                        .collect()
                })
                .unwrap_or_default(),
        })
    }

    /// Ended: its agent exited (idle) or Kubernetes stopped it (lifetime).
    pub fn finished(&self) -> bool {
        matches!(self.phase.as_str(), "Succeeded" | "Failed")
    }

    /// Running with an address, not on its way out.
    pub fn ready(&self) -> bool {
        self.phase == "Running" && self.ip.is_some() && !self.deleting
    }

    /// A container reason that will not resolve by waiting.
    pub fn stuck(&self) -> Option<&str> {
        self.reason.as_deref().filter(|reason| {
            matches!(
                *reason,
                "ErrImagePull"
                    | "ImagePullBackOff"
                    | "InvalidImageName"
                    | "CreateContainerConfigError"
                    | "CreateContainerError"
                    | "RunContainerError"
            )
        })
    }

    /// The agent's base URL.
    pub fn agent_url(&self) -> Option<String> {
        let ip = self.ip.as_deref()?;
        Some(if ip.contains(':') {
            format!("http://[{ip}]:{AGENT_PORT}")
        } else {
            format!("http://{ip}:{AGENT_PORT}")
        })
    }
}

/// The pods of the sandbox namespace (the port).
pub trait PodApi: Send + Sync {
    /// Creates the pod; [`SandboxError::Kube`] with 409 when it exists.
    fn create(&self, manifest: Value) -> BoxFuture<'_, Result<PodInfo, SandboxError>>;
    /// The pod, `None` when there is none.
    fn get<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Option<PodInfo>, SandboxError>>;
    /// The pods matching a label selector.
    fn list<'a>(&'a self, selector: &'a str) -> BoxFuture<'a, Result<Vec<PodInfo>, SandboxError>>;
    /// Deletes the pod now; a pod that is gone already is fine.
    fn delete<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), SandboxError>>;
}

/// The pod a sandbox runs as. Everything about its isolation is here, and the
/// namespace's admission policy checks the same fields (`rust/deploy/helm/
/// weldsuite/templates/sandbox.yaml`): keep them in step.
pub fn pod_manifest(
    config: &SandboxConfig,
    key: &SessionKey,
    token_digest: &str,
    now: OffsetDateTime,
) -> Value {
    let lifetime = config.max_lifetime.as_secs();
    let expires = now + time::Duration::seconds(i64::try_from(lifetime).unwrap_or(i64::MAX / 2));
    let mut spec = json!({
        "automountServiceAccountToken": false,
        "enableServiceLinks": false,
        "restartPolicy": "Never",
        "activeDeadlineSeconds": lifetime,
        "terminationGracePeriodSeconds": 5,
        "dnsPolicy": "None",
        "dnsConfig": {
            "nameservers": config.dns,
            "options": [{ "name": "ndots", "value": "1" }],
        },
        "securityContext": {
            "runAsNonRoot": true,
            "runAsUser": 1000,
            "runAsGroup": 1000,
            "fsGroup": 1000,
            "seccompProfile": { "type": "RuntimeDefault" },
        },
        "containers": [{
            "name": "sandbox",
            "image": config.image,
            "imagePullPolicy": "IfNotPresent",
            "ports": [{ "name": "agent", "containerPort": AGENT_PORT, "protocol": "TCP" }],
            "env": [
                { "name": "SANDBOX_TOKEN_SHA256", "value": token_digest },
                { "name": "SANDBOX_IDLE_TIMEOUT_SECONDS", "value": config.idle_timeout.as_secs().to_string() },
            ],
            "resources": {
                "requests": {
                    "cpu": config.limits.cpu_request,
                    "memory": config.limits.memory,
                    "ephemeral-storage": "256Mi",
                },
                "limits": {
                    "cpu": config.limits.cpu,
                    "memory": config.limits.memory,
                    "ephemeral-storage": config.limits.disk,
                },
            },
            "securityContext": {
                "allowPrivilegeEscalation": false,
                "readOnlyRootFilesystem": true,
                "privileged": false,
                "capabilities": { "drop": ["ALL"] },
            },
            "volumeMounts": [
                { "name": "workspace", "mountPath": "/workspace" },
                { "name": "home", "mountPath": "/home/sandbox" },
                { "name": "tmp", "mountPath": "/tmp" },
                { "name": "shm", "mountPath": "/dev/shm" },
            ],
        }],
        "volumes": [
            { "name": "workspace", "emptyDir": { "sizeLimit": config.limits.disk } },
            { "name": "home", "emptyDir": { "sizeLimit": "1Gi" } },
            { "name": "tmp", "emptyDir": { "sizeLimit": "1Gi" } },
            { "name": "shm", "emptyDir": { "medium": "Memory", "sizeLimit": "256Mi" } },
        ],
    });
    if let Some(map) = spec.as_object_mut() {
        if let Some(class) = &config.runtime_class {
            map.insert("runtimeClassName".to_owned(), json!(class));
        }
        if !config.node_selector.is_empty() {
            map.insert("nodeSelector".to_owned(), json!(config.node_selector));
        }
        if config.tolerations.as_array().is_some_and(|t| !t.is_empty()) {
            map.insert("tolerations".to_owned(), config.tolerations.clone());
        }
        if let Some(secret) = &config.image_pull_secret {
            map.insert("imagePullSecrets".to_owned(), json!([{ "name": secret }]));
        }
    }
    json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": key.pod_name(),
            "namespace": config.namespace,
            "labels": {
                LABEL_NAME: NAME,
                LABEL_MANAGED_BY: MANAGER,
                LABEL_WORKSPACE: key.workspace_label(),
                LABEL_SESSION: key.session_label(),
            },
            "annotations": {
                "weldsuite.org/workspace-id": key.workspace_id,
                "weldsuite.org/agent-id": key.agent_id,
                "weldsuite.org/session-id": key.session_id,
                "weldsuite.org/expires-at": expires.format(&Rfc3339).unwrap_or_default(),
            },
        },
        "spec": spec,
    })
}

/// Where the bearer token comes from: the mounted service account's file,
/// read on every call because the kubelet rotates it.
#[derive(Debug, Clone)]
pub enum Token {
    File(String),
    Static(String),
}

impl Token {
    fn read(&self) -> Result<String, SandboxError> {
        match self {
            Self::Static(token) => Ok(token.clone()),
            Self::File(path) => std::fs::read_to_string(path)
                .map(|t| t.trim().to_owned())
                .map_err(|error| {
                    SandboxError::Unreachable(format!(
                        "the service-account token {path} can't be read ({error}); the chart \
                         mounts it when sandbox.enabled is on"
                    ))
                }),
        }
    }
}

/// The pods over the Kubernetes REST API.
#[derive(Clone)]
pub struct KubePods {
    http: OutboundHttp,
    api: String,
    namespace: String,
    token: Token,
}

impl std::fmt::Debug for KubePods {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KubePods")
            .field("api", &self.api)
            .field("namespace", &self.namespace)
            .finish_non_exhaustive()
    }
}

/// The message of an API error (`Status`), or the body.
fn api_error(response: &HttpResponse) -> SandboxError {
    let body = response.json();
    let message = body.get("message").and_then(Value::as_str).map_or_else(
        || response.text().chars().take(300).collect(),
        str::to_owned,
    );
    SandboxError::Kube(response.status, message)
}

fn unreachable(error: &PortError) -> SandboxError {
    SandboxError::Unreachable(format!("kubernetes API: {error}"))
}

impl KubePods {
    pub fn new(
        http: OutboundHttp,
        api: impl Into<String>,
        namespace: impl Into<String>,
        token: Token,
    ) -> Self {
        Self {
            http,
            api: api.into().trim_end_matches('/').to_owned(),
            namespace: namespace.into(),
            token,
        }
    }

    /// The adapter for `config`, over a client that trusts only the cluster's
    /// CA (`kube_ca_file`) and gives up after 30 s.
    pub fn in_cluster(config: &SandboxConfig) -> Result<Self, SandboxError> {
        let http = http_client(&config.kube_ca_file, Duration::from_secs(30))?;
        Ok(Self::new(
            http,
            config.kube_api_url.clone(),
            config.namespace.clone(),
            Token::File(config.kube_token_file.clone()),
        ))
    }

    fn pods_url(&self) -> String {
        format!("{}/api/v1/namespaces/{}/pods", self.api, self.namespace)
    }

    fn request(
        &self,
        method: &str,
        url: String,
        body: Option<&Value>,
    ) -> Result<HttpRequest, SandboxError> {
        let token = self.token.read()?;
        let request = match body {
            Some(body) => HttpRequest::json(method, url, body),
            None => HttpRequest::empty(method, url),
        };
        Ok(request
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json"))
    }
}

impl PodApi for KubePods {
    fn create(&self, manifest: Value) -> BoxFuture<'_, Result<PodInfo, SandboxError>> {
        Box::pin(async move {
            let request = self.request("POST", self.pods_url(), Some(&manifest))?;
            let response = self.http.send(request).await.map_err(|e| unreachable(&e))?;
            if response.status == 201 || response.status == 200 {
                return PodInfo::from_json(&response.json()).ok_or_else(|| {
                    SandboxError::Kube(response.status, "no pod in the answer".to_owned())
                });
            }
            Err(api_error(&response))
        })
    }

    fn get<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Option<PodInfo>, SandboxError>> {
        Box::pin(async move {
            let request = self.request("GET", format!("{}/{name}", self.pods_url()), None)?;
            let response = self.http.send(request).await.map_err(|e| unreachable(&e))?;
            match response.status {
                200 => Ok(PodInfo::from_json(&response.json())),
                404 => Ok(None),
                _ => Err(api_error(&response)),
            }
        })
    }

    fn list<'a>(&'a self, selector: &'a str) -> BoxFuture<'a, Result<Vec<PodInfo>, SandboxError>> {
        Box::pin(async move {
            let query: String = form_urlencoded::Serializer::new(String::new())
                .append_pair("labelSelector", selector)
                .finish();
            let request = self.request("GET", format!("{}?{query}", self.pods_url()), None)?;
            let response = self.http.send(request).await.map_err(|e| unreachable(&e))?;
            if response.status != 200 {
                return Err(api_error(&response));
            }
            Ok(response
                .json()
                .get("items")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(PodInfo::from_json).collect())
                .unwrap_or_default())
        })
    }

    fn delete<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), SandboxError>> {
        Box::pin(async move {
            let body = json!({
                "apiVersion": "v1",
                "kind": "DeleteOptions",
                "gracePeriodSeconds": 0,
                "propagationPolicy": "Background",
            });
            let request =
                self.request("DELETE", format!("{}/{name}", self.pods_url()), Some(&body))?;
            let response = self.http.send(request).await.map_err(|e| unreachable(&e))?;
            match response.status {
                200 | 202 | 404 => Ok(()),
                _ => Err(api_error(&response)),
            }
        })
    }
}

/// An HTTP client that trusts only the cluster's CA.
struct KubeHttp(reqwest::Client);

impl DynOutboundHttp for KubeHttp {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(PortError::backend)?;
            let mut call = self.0.request(method, &request.url);
            for (name, value) in &request.headers {
                call = call.header(name.as_str(), value.as_str());
            }
            if let Some(body) = request.body {
                call = call.body(body);
            }
            let response = call.send().await.map_err(PortError::backend)?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(n, v)| {
                    v.to_str()
                        .ok()
                        .map(|v| (n.as_str().to_owned(), v.to_owned()))
                })
                .collect();
            let body = response.bytes().await.map_err(PortError::backend)?.to_vec();
            Ok(HttpResponse {
                status,
                body,
                headers,
            })
        })
    }
}

/// The client for the Kubernetes API: the CA in `ca_file` and nothing else.
pub fn http_client(ca_file: &str, timeout: Duration) -> Result<OutboundHttp, SandboxError> {
    let pem = std::fs::read(ca_file).map_err(|error| {
        SandboxError::Unreachable(format!("the cluster CA {ca_file} can't be read ({error})"))
    })?;
    let certificates = reqwest::Certificate::from_pem_bundle(&pem)
        .map_err(|error| SandboxError::Invalid(format!("the cluster CA {ca_file}: {error}")))?;
    let client = reqwest::Client::builder()
        .tls_certs_only(certificates)
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| SandboxError::Invalid(format!("kubernetes client: {error}")))?;
    Ok(OutboundHttp(Arc::new(KubeHttp(client))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::RecordingHttp;

    fn key() -> SessionKey {
        SessionKey::new("ws_1", "agt_1", "conv_1")
    }

    #[test]
    fn the_pod_is_isolated() {
        let config = SandboxConfig::for_tests();
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).expect("time");
        let pod = pod_manifest(&config, &key(), "digest", now);
        let spec = &pod["spec"];
        assert_eq!(spec["runtimeClassName"], "gvisor");
        assert_eq!(spec["automountServiceAccountToken"], false);
        assert_eq!(spec["enableServiceLinks"], false);
        assert_eq!(spec["dnsPolicy"], "None");
        assert_eq!(spec["activeDeadlineSeconds"], 3600);
        assert_eq!(spec["restartPolicy"], "Never");
        assert!(spec.get("hostNetwork").is_none());
        assert!(spec.get("serviceAccountName").is_none());
        let container = &spec["containers"][0];
        assert_eq!(
            container["securityContext"]["allowPrivilegeEscalation"],
            false
        );
        assert_eq!(container["securityContext"]["readOnlyRootFilesystem"], true);
        assert_eq!(
            container["securityContext"]["capabilities"]["drop"],
            json!(["ALL"])
        );
        assert_eq!(container["resources"]["limits"]["memory"], "2Gi");
        assert_eq!(container["resources"]["limits"]["ephemeral-storage"], "2Gi");
        // Only the token's digest reaches the pod.
        assert_eq!(
            container["env"][0],
            json!({ "name": "SANDBOX_TOKEN_SHA256", "value": "digest" })
        );
        assert_eq!(spec["securityContext"]["runAsNonRoot"], true);
        let labels = &pod["metadata"]["labels"];
        assert_eq!(labels[LABEL_NAME], NAME);
        assert_eq!(labels[LABEL_SESSION], key().session_label());
        assert_eq!(pod["metadata"]["name"], key().pod_name());
        assert_eq!(
            pod["metadata"]["annotations"]["weldsuite.org/expires-at"],
            "2027-01-15T09:00:00Z"
        );
        // No gVisor only where the operator said so.
        let mut dev = config;
        dev.runtime_class = None;
        assert!(
            pod_manifest(&dev, &key(), "d", now)["spec"]
                .get("runtimeClassName")
                .is_none()
        );
    }

    #[test]
    fn reads_a_pod() {
        let pod = PodInfo::from_json(&json!({
            "metadata": { "name": "sbx-1", "creationTimestamp": "2026-11-13T10:00:00Z", "labels": { "a": "b" } },
            "status": {
                "phase": "Pending",
                "containerStatuses": [{ "state": { "waiting": { "reason": "ImagePullBackOff" } } }],
            },
        }))
        .expect("pod");
        assert_eq!(pod.phase, "Pending");
        assert_eq!(pod.stuck(), Some("ImagePullBackOff"));
        assert!(!pod.ready());
        assert_eq!(pod.labels["a"], "b");
        let running = PodInfo::from_json(&json!({
            "metadata": { "name": "sbx-1" },
            "status": { "phase": "Running", "podIP": "fd00::5" },
        }))
        .expect("pod");
        assert!(running.ready());
        assert_eq!(
            running.agent_url().as_deref(),
            Some("http://[fd00::5]:8080")
        );
    }

    #[tokio::test]
    async fn speaks_the_kubernetes_api() {
        let http = RecordingHttp::new(|request| {
            let pod = json!({ "metadata": { "name": "sbx-x" }, "status": { "phase": "Pending" } });
            match (request.method.as_str(), request.url.as_str()) {
                ("POST", _) => (201, pod),
                ("GET", url) if url.contains("labelSelector") => (200, json!({ "items": [pod] })),
                ("GET", url) if url.ends_with("/gone") => (404, json!({ "message": "not found" })),
                ("GET", _) => (200, pod),
                ("DELETE", _) => (200, json!({})),
                _ => (500, json!({})),
            }
        });
        let pods = KubePods::new(
            http.outbound(),
            "https://10.96.0.1:443/",
            "weldsuite-sandbox",
            Token::Static("sa-token".to_owned()),
        );
        let created = pods.create(json!({ "kind": "Pod" })).await.expect("create");
        assert_eq!(created.name, "sbx-x");
        assert!(pods.get("gone").await.expect("get").is_none());
        assert_eq!(pods.list(&all_selector()).await.expect("list").len(), 1);
        pods.delete("sbx-x").await.expect("delete");

        let calls = http.calls();
        assert_eq!(calls[0].method, "POST");
        assert_eq!(
            calls[0].url,
            "https://10.96.0.1:443/api/v1/namespaces/weldsuite-sandbox/pods"
        );
        assert!(calls.iter().all(|c| {
            c.headers
                .iter()
                .any(|(n, v)| n == "Authorization" && v == "Bearer sa-token")
        }));
        assert_eq!(
            calls[2].url,
            "https://10.96.0.1:443/api/v1/namespaces/weldsuite-sandbox/pods?labelSelector=app.kubernetes.io%2Fname%3Dweldsuite-sandbox%2Capp.kubernetes.io%2Fmanaged-by%3Dweldsuite"
        );
        assert_eq!(calls[3].method, "DELETE");
        assert!(calls[3].url.ends_with("/pods/sbx-x"));
        let options: Value =
            serde_json::from_slice(calls[3].body.as_deref().unwrap_or_default()).expect("json");
        assert_eq!(options["gracePeriodSeconds"], 0);
    }

    #[tokio::test]
    async fn api_refusals_carry_the_message() {
        let http = RecordingHttp::new(|_| {
            (
                403,
                json!({ "message": "pods is forbidden: violates PodSecurity" }),
            )
        });
        let pods = KubePods::new(
            http.outbound(),
            "https://k",
            "ns",
            Token::Static("t".to_owned()),
        );
        let error = pods.create(json!({})).await.expect_err("refused");
        assert_eq!(
            error,
            SandboxError::Kube(403, "pods is forbidden: violates PodSecurity".to_owned())
        );
        // Never in a model's answer.
        assert!(!error.for_model().contains("PodSecurity"));
    }
}
