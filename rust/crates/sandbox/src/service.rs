//! [`Sandboxes`]: a sandbox per agent conversation or run, created on first
//! use, reused while it lives, and cleaned up.
//!
//! - **Create or reuse** ([`Sandboxes::acquire`]): the pod's name follows from
//!   the session ([`SessionKey::pod_name`]), so every replica finds the same
//!   pod. A finished pod (its agent exited after the idle timeout, or
//!   Kubernetes stopped it at the hard lifetime) is replaced. Limits per
//!   workspace and per install hold before a new pod is created.
//! - **Isolation check, fail closed**: before the first sandbox of a process
//!   (and hourly after) is handed out, the agent in it tries to reach the
//!   metadata service and the Kubernetes API ([`SandboxConfig::egress_probes`]).
//!   If anything answers, the cluster is not enforcing the namespace's network
//!   policy: the pod is deleted and no sandbox is handed out for five minutes,
//!   then it is checked again.
//! - **Lifetime**: the agent in the pod exits after `SANDBOX_IDLE_TIMEOUT_SECONDS`
//!   without a request; `activeDeadlineSeconds` stops the pod at
//!   `SANDBOX_MAX_LIFETIME_SECONDS` whatever it does. [`Sandboxes::cleanup`]
//!   (`weldsuite cron sandbox-cleanup`) deletes what is left: finished pods,
//!   pods past their lifetime and pods that never started.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use time::OffsetDateTime;
use tokio::time::Instant;
use weldsuite_ports::OutboundHttp;

use crate::agent::AgentClient;
use crate::config::SandboxConfig;
use crate::error::SandboxError;
use crate::kube::{LABEL_WORKSPACE, PodApi, PodInfo, all_selector, pod_manifest};
use crate::search::SearchClient;
use crate::session::SessionKey;
use crate::token::{pod_token, token_digest};

/// How long a passed isolation check holds before the next sandbox checks
/// again.
const VERIFIED_FOR: Duration = Duration::from_secs(3600);
/// How long after a failed check no sandbox is handed out.
const RETRY_AFTER: Duration = Duration::from_secs(300);
/// How long a deleted pod may take to go.
const GONE_WITHIN: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
enum Isolation {
    Unchecked,
    Verified(Instant),
    Failed(Instant, Vec<String>),
}

/// A running sandbox: its pod and the agent in it.
#[derive(Debug, Clone)]
pub struct Sandbox {
    pub name: String,
    pub agent: AgentClient,
}

/// What [`Sandboxes::cleanup`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CleanupReport {
    pub checked: usize,
    /// Pod name and why it went: `finished`, `expired`, `stuck`.
    pub deleted: Vec<(String, &'static str)>,
    pub failed: usize,
}

impl CleanupReport {
    pub fn to_json(&self) -> Value {
        json!({
            "checked": self.checked,
            "deleted": self.deleted.len(),
            "finished": self.deleted.iter().filter(|(_, why)| *why == "finished").count(),
            "expired": self.deleted.iter().filter(|(_, why)| *why == "expired").count(),
            "stuck": self.deleted.iter().filter(|(_, why)| *why == "stuck").count(),
            "failed": self.failed,
        })
    }
}

struct Inner {
    config: SandboxConfig,
    pods: Arc<dyn PodApi>,
    agent_http: OutboundHttp,
    search: Option<SearchClient>,
    isolation: Mutex<Isolation>,
    /// One start at a time per pod in this process.
    starting: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    poll: Duration,
}

/// The install's sandboxes. Cheap to clone.
#[derive(Clone)]
pub struct Sandboxes {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Sandboxes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Sandboxes")
            .field("namespace", &self.inner.config.namespace)
            .finish_non_exhaustive()
    }
}

impl Sandboxes {
    /// The service: `pods` for the Kubernetes API, `agent_http` to reach the
    /// agents in the pods, `search_http` for `SearXNG` (`config.searxng_url`).
    pub fn new(
        config: SandboxConfig,
        pods: Arc<dyn PodApi>,
        agent_http: OutboundHttp,
        search_http: OutboundHttp,
    ) -> Self {
        let search = config
            .searxng_url
            .as_ref()
            .map(|url| SearchClient::new(search_http, url.clone()));
        Self {
            inner: Arc::new(Inner {
                config,
                pods,
                agent_http,
                search,
                isolation: Mutex::new(Isolation::Unchecked),
                starting: Mutex::default(),
                poll: Duration::from_millis(500),
            }),
        }
    }

    /// The same service polling every `poll` (tests).
    #[must_use]
    pub fn with_poll_interval(self, poll: Duration) -> Self {
        let shared = &self.inner;
        Self {
            inner: Arc::new(Inner {
                config: shared.config.clone(),
                pods: Arc::clone(&shared.pods),
                agent_http: shared.agent_http.clone(),
                search: shared.search.clone(),
                isolation: Mutex::new(Isolation::Unchecked),
                starting: Mutex::default(),
                poll,
            }),
        }
    }

    pub fn config(&self) -> &SandboxConfig {
        &self.inner.config
    }

    /// The cluster's `SearXNG`, when `SEARXNG_URL` is set.
    pub fn search(&self) -> Option<&SearchClient> {
        self.inner.search.as_ref()
    }

    fn handle(&self, pod: &PodInfo) -> Option<Sandbox> {
        let base = pod.agent_url()?;
        Some(Sandbox {
            name: pod.name.clone(),
            agent: AgentClient::new(
                self.inner.agent_http.clone(),
                base,
                pod_token(&self.inner.config.token_secret, &pod.name),
            ),
        })
    }

    fn start_lock(&self, name: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut starting = self
            .inner
            .starting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if starting.len() > 1024 {
            starting.retain(|_, lock| Arc::strong_count(lock) > 1);
        }
        Arc::clone(starting.entry(name.to_owned()).or_default())
    }

    fn isolation(&self) -> Isolation {
        self.inner
            .isolation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn set_isolation(&self, state: Isolation) {
        *self
            .inner
            .isolation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = state;
    }

    /// The session's sandbox, started when it has none.
    ///
    /// # Errors
    ///
    /// [`SandboxError::NotIsolated`] while the isolation check fails, the
    /// limits, and the API's or the pod's failures.
    pub async fn acquire(&self, key: &SessionKey) -> Result<Sandbox, SandboxError> {
        if let Isolation::Failed(at, reached) = self.isolation()
            && at.elapsed() < RETRY_AFTER
        {
            return Err(SandboxError::NotIsolated(reached));
        }
        let name = key.pod_name();
        let lock = self.start_lock(&name);
        let _started = lock.lock().await;
        let pod = match self.inner.pods.get(&name).await? {
            Some(pod) if pod.ready() => match self.handle(&pod) {
                // A running sandbox whose agent answers is used as it is.
                Some(sandbox) if sandbox.agent.health().await.is_ok() => {
                    self.ensure_isolated(&sandbox).await?;
                    return Ok(sandbox);
                }
                // Its agent just exited (idle) while the pod still shows
                // Running: replace it.
                _ => self.replace(key, false).await?,
            },
            Some(pod) if pod.finished() || pod.deleting => self.replace(key, pod.deleting).await?,
            Some(_) => self.wait_ready(&name).await?,
            None => self.start(key).await?,
        };
        let sandbox = self
            .handle(&pod)
            .ok_or_else(|| SandboxError::StartFailed("the pod has no address".to_owned()))?;
        self.wait_agent(&sandbox).await?;
        self.ensure_isolated(&sandbox).await?;
        Ok(sandbox)
    }

    /// Deletes the session's pod (unless it is on its way out already), waits
    /// until it is gone and starts a new one.
    async fn replace(&self, key: &SessionKey, deleting: bool) -> Result<PodInfo, SandboxError> {
        let name = key.pod_name();
        if !deleting {
            self.inner.pods.delete(&name).await?;
        }
        self.wait_gone(&name).await?;
        self.start(key).await
    }

    /// Every sandbox pod of the install (`weldsuite doctor`: the API and the
    /// service account's rights answer).
    pub async fn pods(&self) -> Result<Vec<PodInfo>, SandboxError> {
        self.inner.pods.list(&all_selector()).await
    }

    /// The session's sandbox if it runs; never starts one.
    pub async fn existing(&self, key: &SessionKey) -> Result<Option<Sandbox>, SandboxError> {
        Ok(self
            .inner
            .pods
            .get(&key.pod_name())
            .await?
            .filter(PodInfo::ready)
            .and_then(|pod| self.handle(&pod)))
    }

    /// Ends the session's sandbox now (a run that finished).
    pub async fn release(&self, key: &SessionKey) -> Result<(), SandboxError> {
        self.inner.pods.delete(&key.pod_name()).await
    }

    async fn start(&self, key: &SessionKey) -> Result<PodInfo, SandboxError> {
        let config = &self.inner.config;
        let pods = self.inner.pods.list(&all_selector()).await?;
        let active: Vec<&PodInfo> = pods
            .iter()
            .filter(|p| !p.finished() && !p.deleting)
            .collect();
        let workspace = key.workspace_label();
        let mine = active
            .iter()
            .filter(|p| p.labels.get(LABEL_WORKSPACE) == Some(&workspace))
            .count();
        if mine >= config.max_per_workspace {
            return Err(SandboxError::WorkspaceLimit(config.max_per_workspace));
        }
        if active.len() >= config.max_total {
            tracing::warn!(
                limit = config.max_total,
                "[sandbox] the install runs its maximum of sandboxes"
            );
            return Err(SandboxError::InstallLimit(config.max_total));
        }
        let name = key.pod_name();
        let token = pod_token(&config.token_secret, &name);
        let manifest = pod_manifest(
            config,
            key,
            &token_digest(&token),
            OffsetDateTime::now_utc(),
        );
        match self.inner.pods.create(manifest).await {
            // Another replica started it a moment ago.
            Ok(_) | Err(SandboxError::Kube(409, _)) => {}
            Err(error) => {
                tracing::error!(%error, pod = %name, "[sandbox] the pod was refused");
                return Err(error);
            }
        }
        tracing::info!(pod = %name, workspace = %key.workspace_id, "[sandbox] started");
        self.wait_ready(&name).await
    }

    async fn wait_ready(&self, name: &str) -> Result<PodInfo, SandboxError> {
        let deadline = Instant::now() + self.inner.config.start_timeout;
        loop {
            match self.inner.pods.get(name).await? {
                None => return Err(SandboxError::StartFailed("the pod went away".to_owned())),
                Some(pod) if pod.ready() => return Ok(pod),
                Some(pod) if pod.finished() => {
                    let why = pod.reason.clone().unwrap_or(pod.phase.clone());
                    let _ = self.inner.pods.delete(name).await;
                    return Err(SandboxError::StartFailed(why));
                }
                Some(pod) => {
                    if let Some(reason) = pod.stuck() {
                        let reason = reason.to_owned();
                        let _ = self.inner.pods.delete(name).await;
                        tracing::error!(pod = %name, %reason, "[sandbox] the pod can't start");
                        return Err(SandboxError::StartFailed(reason));
                    }
                }
            }
            if Instant::now() >= deadline {
                let _ = self.inner.pods.delete(name).await;
                return Err(SandboxError::Timeout("starting the sandbox"));
            }
            tokio::time::sleep(self.inner.poll).await;
        }
    }

    async fn wait_agent(&self, sandbox: &Sandbox) -> Result<(), SandboxError> {
        let deadline = Instant::now() + self.inner.config.start_timeout;
        loop {
            match sandbox.agent.health().await {
                Ok(_) => return Ok(()),
                Err(SandboxError::Agent(401 | 403, _)) => {
                    return Err(SandboxError::StartFailed(
                        "the sandbox refused the token (is SANDBOX_TOKEN_SECRET the same on every replica?)"
                            .to_owned(),
                    ));
                }
                Err(_) if Instant::now() < deadline => tokio::time::sleep(self.inner.poll).await,
                Err(error) => {
                    let _ = self.inner.pods.delete(&sandbox.name).await;
                    return Err(error);
                }
            }
        }
    }

    async fn wait_gone(&self, name: &str) -> Result<(), SandboxError> {
        let deadline = Instant::now() + GONE_WITHIN;
        while self.inner.pods.get(name).await?.is_some() {
            if Instant::now() >= deadline {
                return Err(SandboxError::Timeout("replacing a finished sandbox"));
            }
            tokio::time::sleep(self.inner.poll).await;
        }
        Ok(())
    }

    async fn ensure_isolated(&self, sandbox: &Sandbox) -> Result<(), SandboxError> {
        if !self.inner.config.require_isolation {
            return Ok(());
        }
        if let Isolation::Verified(at) = self.isolation()
            && at.elapsed() < VERIFIED_FOR
        {
            return Ok(());
        }
        let reached = sandbox
            .agent
            .reachable(&self.inner.config.egress_probes)
            .await?;
        if reached.is_empty() {
            self.set_isolation(Isolation::Verified(Instant::now()));
            return Ok(());
        }
        let error = SandboxError::NotIsolated(reached.clone());
        tracing::error!(%error, "[sandbox] isolation check failed: no sandbox is handed out");
        self.set_isolation(Isolation::Failed(Instant::now(), reached));
        let _ = self.inner.pods.delete(&sandbox.name).await;
        Err(error)
    }

    /// `weldsuite doctor`: starts a sandbox of its own, asks what it can
    /// reach, and deletes it. Empty is isolated.
    pub async fn check_isolation(&self) -> Result<Vec<String>, SandboxError> {
        let key = SessionKey::new(
            "doctor",
            "doctor",
            OffsetDateTime::now_utc().unix_timestamp().to_string(),
        );
        let name = key.pod_name();
        let pod = self.start(&key).await?;
        let result = async {
            let sandbox = self
                .handle(&pod)
                .ok_or_else(|| SandboxError::StartFailed("the pod has no address".to_owned()))?;
            self.wait_agent(&sandbox).await?;
            sandbox
                .agent
                .reachable(&self.inner.config.egress_probes)
                .await
        }
        .await;
        let _ = self.inner.pods.delete(&name).await;
        result
    }

    /// Deletes the sandboxes that are done: finished (idle exit, lifetime),
    /// past their lifetime (belt and braces) or never started.
    pub async fn cleanup(&self, now: OffsetDateTime) -> Result<CleanupReport, SandboxError> {
        let config = &self.inner.config;
        let lifetime = time::Duration::try_from(config.max_lifetime + Duration::from_secs(120))
            .unwrap_or(time::Duration::MAX);
        let start =
            time::Duration::try_from(config.start_timeout * 2).unwrap_or(time::Duration::MAX);
        let pods = self.inner.pods.list(&all_selector()).await?;
        let mut report = CleanupReport {
            checked: pods.len(),
            ..CleanupReport::default()
        };
        for pod in pods {
            if pod.deleting {
                continue;
            }
            let age = pod
                .created
                .map_or(time::Duration::ZERO, |created| now - created);
            let why = if pod.finished() {
                "finished"
            } else if age > lifetime {
                "expired"
            } else if pod.stuck().is_some() || (pod.phase == "Pending" && age > start) {
                "stuck"
            } else {
                continue;
            };
            match self.inner.pods.delete(&pod.name).await {
                Ok(()) => report.deleted.push((pod.name, why)),
                Err(error) => {
                    tracing::warn!(%error, pod = %pod.name, "[sandbox] cleanup could not delete");
                    report.failed += 1;
                }
            }
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{FakePods, RecordingHttp};

    fn service(pods: &FakePods, agent: &RecordingHttp) -> Sandboxes {
        Sandboxes::new(
            SandboxConfig::for_tests(),
            Arc::new(pods.clone()),
            agent.outbound(),
            agent.outbound(),
        )
        .with_poll_interval(Duration::from_millis(1))
    }

    fn isolated_agent() -> RecordingHttp {
        RecordingHttp::new(|request| {
            if request.url.ends_with("/v1/selftest/egress") {
                (200, json!({ "reachable": [] }))
            } else {
                (200, json!({ "ok": true }))
            }
        })
    }

    #[tokio::test]
    async fn starts_once_and_reuses() {
        let pods = FakePods::default();
        let agent = isolated_agent();
        let sandboxes = service(&pods, &agent);
        let key = SessionKey::new("ws_1", "agt_1", "conv_1");
        let first = sandboxes.acquire(&key).await.expect("start");
        let again = sandboxes.acquire(&key).await.expect("reuse");
        assert_eq!(first.name, again.name);
        assert_eq!(pods.created().len(), 1);
        // The token is the pod's own, and the pod got only its digest.
        let manifest = &pods.created()[0];
        let digest = manifest["spec"]["containers"][0]["env"][0]["value"]
            .as_str()
            .expect("digest");
        let token = pod_token(&SandboxConfig::for_tests().token_secret, &first.name);
        assert_eq!(digest, token_digest(&token));
        // The isolation check ran once, on the first sandbox.
        let checks = agent
            .calls()
            .iter()
            .filter(|c| c.url.ends_with("/selftest/egress"))
            .count();
        assert_eq!(checks, 1);
    }

    #[tokio::test]
    async fn fails_closed_when_the_network_policy_is_not_enforced() {
        let pods = FakePods::default();
        let agent = RecordingHttp::new(|request| {
            if request.url.ends_with("/v1/selftest/egress") {
                (200, json!({ "reachable": ["169.254.169.254:80"] }))
            } else {
                (200, json!({ "ok": true }))
            }
        });
        let sandboxes = service(&pods, &agent);
        let key = SessionKey::new("ws_1", "agt_1", "conv_1");
        let refused = sandboxes.acquire(&key).await.expect_err("not isolated");
        assert_eq!(
            refused,
            SandboxError::NotIsolated(vec!["169.254.169.254:80".to_owned()])
        );
        // The pod is gone, and the next call doesn't even start one.
        assert_eq!(pods.names(), Vec::<String>::new());
        assert!(matches!(
            sandboxes.acquire(&key).await,
            Err(SandboxError::NotIsolated(_))
        ));
        assert_eq!(pods.created().len(), 1);
    }

    #[tokio::test]
    async fn the_check_can_be_waived_on_a_development_cluster() {
        let pods = FakePods::default();
        let agent = RecordingHttp::new(|_| (200, json!({ "reachable": ["10.96.0.1:443"] })));
        let mut config = SandboxConfig::for_tests();
        config.require_isolation = false;
        let sandboxes = Sandboxes::new(
            config,
            Arc::new(pods.clone()),
            agent.outbound(),
            agent.outbound(),
        )
        .with_poll_interval(Duration::from_millis(1));
        sandboxes
            .acquire(&SessionKey::new("ws", "a", "s"))
            .await
            .expect("waived");
    }

    #[tokio::test]
    async fn holds_the_limits() {
        let pods = FakePods::default();
        let agent = isolated_agent();
        let sandboxes = service(&pods, &agent);
        sandboxes
            .acquire(&SessionKey::new("ws_1", "a", "1"))
            .await
            .expect("one");
        sandboxes
            .acquire(&SessionKey::new("ws_1", "a", "2"))
            .await
            .expect("two");
        assert_eq!(
            sandboxes
                .acquire(&SessionKey::new("ws_1", "a", "3"))
                .await
                .expect_err("third"),
            SandboxError::WorkspaceLimit(2)
        );
        // Another workspace still gets one.
        sandboxes
            .acquire(&SessionKey::new("ws_2", "a", "1"))
            .await
            .expect("other workspace");
        // A finished pod doesn't count.
        pods.set_phase(&SessionKey::new("ws_1", "a", "1").pod_name(), "Succeeded");
        sandboxes
            .acquire(&SessionKey::new("ws_1", "a", "3"))
            .await
            .expect("room again");
    }

    #[tokio::test]
    async fn replaces_a_finished_sandbox() {
        let pods = FakePods::default();
        let agent = isolated_agent();
        let sandboxes = service(&pods, &agent);
        let key = SessionKey::new("ws_1", "agt_1", "conv_1");
        sandboxes.acquire(&key).await.expect("start");
        pods.set_phase(&key.pod_name(), "Succeeded");
        sandboxes.acquire(&key).await.expect("again");
        assert_eq!(pods.created().len(), 2);
        assert_eq!(pods.deleted(), [key.pod_name()]);
    }

    #[tokio::test]
    async fn replaces_a_running_pod_whose_agent_exited() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let exited = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&exited);
        let pods = FakePods::default();
        let agent = RecordingHttp::new(move |request| {
            if flag.load(Ordering::SeqCst) && request.url.starts_with("http://10.244.0.1:") {
                (503, json!({}))
            } else if request.url.ends_with("/v1/selftest/egress") {
                (200, json!({ "reachable": [] }))
            } else {
                (200, json!({ "ok": true }))
            }
        });
        let sandboxes = service(&pods, &agent);
        let key = SessionKey::new("ws_1", "agt_1", "conv_1");
        let first = sandboxes.acquire(&key).await.expect("start");
        assert_eq!(first.agent.base(), "http://10.244.0.1:8080");
        exited.store(true, Ordering::SeqCst);
        let second = sandboxes.acquire(&key).await.expect("replaced");
        assert_eq!(second.agent.base(), "http://10.244.0.2:8080");
        assert_eq!(pods.deleted(), [key.pod_name()]);
    }

    #[tokio::test]
    async fn a_pod_that_cannot_start_is_removed() {
        let pods = FakePods::default().starting_with("Pending", Some("ImagePullBackOff"));
        let agent = isolated_agent();
        let sandboxes = service(&pods, &agent);
        let key = SessionKey::new("ws_1", "agt_1", "conv_1");
        assert_eq!(
            sandboxes.acquire(&key).await.expect_err("stuck"),
            SandboxError::StartFailed("ImagePullBackOff".to_owned())
        );
        assert_eq!(pods.names(), Vec::<String>::new());
    }

    #[tokio::test]
    async fn cleanup_deletes_what_is_done() {
        let pods = FakePods::default();
        let agent = isolated_agent();
        let sandboxes = service(&pods, &agent);
        let now = OffsetDateTime::now_utc();
        let hour = time::Duration::hours(1);
        pods.insert("sbx-running", "Running", now - time::Duration::minutes(5));
        pods.insert(
            "sbx-idle-exit",
            "Succeeded",
            now - time::Duration::minutes(20),
        );
        pods.insert("sbx-killed", "Failed", now - hour);
        pods.insert("sbx-old", "Running", now - hour * 2);
        pods.insert("sbx-never", "Pending", now - time::Duration::minutes(10));
        pods.insert("sbx-new", "Pending", now - time::Duration::seconds(10));
        let report = sandboxes.cleanup(now).await.expect("cleanup");
        assert_eq!(report.checked, 6);
        let mut deleted = report.deleted.clone();
        deleted.sort_unstable();
        assert_eq!(
            deleted,
            [
                ("sbx-idle-exit".to_owned(), "finished"),
                ("sbx-killed".to_owned(), "finished"),
                ("sbx-never".to_owned(), "stuck"),
                ("sbx-old".to_owned(), "expired"),
            ]
        );
        let mut left = pods.names();
        left.sort_unstable();
        assert_eq!(left, ["sbx-new", "sbx-running"]);
        assert_eq!(report.to_json()["finished"], 2);
    }

    #[tokio::test]
    async fn doctor_checks_in_a_throwaway_sandbox() {
        let pods = FakePods::default();
        let agent = RecordingHttp::new(|request| {
            if request.url.ends_with("/v1/selftest/egress") {
                (200, json!({ "reachable": ["10.96.0.1:443"] }))
            } else {
                (200, json!({ "ok": true }))
            }
        });
        let sandboxes = service(&pods, &agent);
        assert_eq!(
            sandboxes.check_isolation().await.expect("check"),
            ["10.96.0.1:443"]
        );
        assert_eq!(pods.names(), Vec::<String>::new());
    }
}
