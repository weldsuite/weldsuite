//! WeldAgent's sandbox (`weldsuite_sandbox`, ADR AI-012 phase 5), built once
//! per process from [`SandboxConfig`] (`config.rs` reads it with every other
//! setting): `serve` keeps it in [`AppState::sandboxes`](crate::server::AppState),
//! and `cron sandbox-cleanup` and `doctor` build theirs the same way. `None`
//! is no sandbox (no `SANDBOX_ENABLED`): `agent-sandbox` is listed in
//! `/config.json`'s `unavailableFeatures` and the sandbox and web grants are
//! not offered.
//!
//! The pods are managed through the Kubernetes API with the pod's own
//! service-account token, which the chart mounts only with `sandbox.enabled`;
//! the agents in them and `SearXNG` are reached over plain HTTP inside the
//! cluster.

use std::sync::Arc;
use std::time::Duration;

use weldsuite_ports::{OutboundHttp, PortError};
use weldsuite_sandbox::{KubePods, SandboxConfig, Sandboxes};

/// The longest one call to an agent in a pod may take: a command runs for
/// 120 s at most, and the crate cuts each call shorter where it must.
const AGENT_TIMEOUT: Duration = Duration::from_secs(180);
/// `SearXNG` asks its engines in parallel and answers within seconds.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);

/// The process's sandbox. `None` without one.
pub(crate) fn build(config: Option<&SandboxConfig>) -> Result<Option<Sandboxes>, PortError> {
    let Some(config) = config else {
        tracing::info!(
            "SANDBOX_ENABLED is not set: WeldAgent has no sandbox, computer use or browsing"
        );
        return Ok(None);
    };
    let pods = KubePods::in_cluster(config).map_err(PortError::backend)?;
    let agents = weldsuite_adapters_oss::ReqwestOutbound::new(AGENT_TIMEOUT)?;
    let search = weldsuite_adapters_oss::ReqwestOutbound::new(SEARCH_TIMEOUT)?;
    if config.searxng_url.is_none() {
        tracing::warn!(
            "SEARXNG_URL is not set: WeldAgent's web_search answers that search is not configured"
        );
    }
    if !config.require_isolation {
        tracing::warn!(
            "SANDBOX_REQUIRE_ISOLATION=false: sandboxes are handed out without checking their network \
             isolation; only for a development cluster"
        );
    }
    tracing::info!(
        namespace = %config.namespace,
        image = %config.image,
        runtime_class = config.runtime_class.as_deref().unwrap_or("(none)"),
        "WeldAgent sandbox on"
    );
    Ok(Some(Sandboxes::new(
        config.clone(),
        Arc::new(pods),
        OutboundHttp(Arc::new(agents)),
        OutboundHttp(Arc::new(search)),
    )))
}
