//! `SANDBOX_*` and `SEARXNG_URL`: the install's sandbox, read once per
//! process with the server's other settings (`rust/bins/weldsuite`
//! `config.rs`). The Helm chart writes them from its `sandbox` and `searxng`
//! sections (`rust/deploy/helm/weldsuite`).
//!
//! Without `SANDBOX_ENABLED=true` there is no sandbox: the `agent-sandbox`
//! edition feature is unavailable and the sandbox and web grants
//! (`computer:use`, `browser:use`) are not offered, as before.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;

/// The namespace the sandbox pods live in, unless `SANDBOX_NAMESPACE` says
/// otherwise.
pub const DEFAULT_NAMESPACE: &str = "weldsuite-sandbox";

/// The port the agent inside a sandbox listens on.
pub const AGENT_PORT: u16 = 8080;

/// The `RuntimeClass` the pods run under unless `SANDBOX_RUNTIME_CLASS` says
/// otherwise: gVisor (`runsc`), a kernel in user space between the code and
/// the node.
pub const DEFAULT_RUNTIME_CLASS: &str = "gvisor";

/// Where the in-cluster service-account token and CA are mounted.
pub const TOKEN_FILE: &str = "/var/run/secrets/kubernetes.io/serviceaccount/token";
pub const CA_FILE: &str = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

/// The node resolvers' public resolvers (Quad9), as the Talos nodes use: the
/// pods never ask the cluster's DNS, which the network policy shuts them out
/// of.
const DEFAULT_DNS: [&str; 2] = ["9.9.9.9", "149.112.112.112"];

/// The cloud metadata service: on Hetzner it serves the server's user data,
/// which on Talos is its machine configuration. A sandbox that can reach it
/// is not isolated.
pub const METADATA_PROBE: &str = "169.254.169.254:80";

/// What one sandbox may use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// The CPU limit (`SANDBOX_CPU`, a Kubernetes quantity such as `1` or
    /// `1500m`).
    pub cpu: String,
    /// The CPU request (`SANDBOX_CPU_REQUEST`).
    pub cpu_request: String,
    /// Memory, requested and limited (`SANDBOX_MEMORY`, such as `2Gi`). The
    /// shared memory Chromium uses counts toward it.
    pub memory: String,
    /// Disk: the `/workspace` volume and the container's own writes
    /// (`SANDBOX_DISK`).
    pub disk: String,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            cpu: "1".to_owned(),
            cpu_request: "250m".to_owned(),
            memory: "2Gi".to_owned(),
            disk: "2Gi".to_owned(),
        }
    }
}

/// The install's sandbox.
#[derive(Clone, PartialEq)]
pub struct SandboxConfig {
    /// `SANDBOX_NAMESPACE`.
    pub namespace: String,
    /// `SANDBOX_IMAGE`: the sandbox image (`rust/deploy/sandbox`).
    pub image: String,
    /// `SANDBOX_IMAGE_PULL_SECRET`: a pull secret in the sandbox namespace.
    pub image_pull_secret: Option<String>,
    /// `SANDBOX_RUNTIME_CLASS`; `None` only with `none`, for a development
    /// cluster without gVisor.
    pub runtime_class: Option<String>,
    pub limits: Limits,
    /// `SANDBOX_IDLE_TIMEOUT_SECONDS`: the agent in the pod exits after this
    /// long without a request, and the pod ends.
    pub idle_timeout: Duration,
    /// `SANDBOX_MAX_LIFETIME_SECONDS`: the pod's `activeDeadlineSeconds`.
    /// Kubernetes stops it then, whatever it is doing.
    pub max_lifetime: Duration,
    /// `SANDBOX_START_TIMEOUT_SECONDS`: how long a new sandbox may take to
    /// answer.
    pub start_timeout: Duration,
    /// `SANDBOX_MAX_PER_WORKSPACE`: running sandboxes per workspace.
    pub max_per_workspace: usize,
    /// `SANDBOX_MAX_TOTAL`: running sandboxes on the install.
    pub max_total: usize,
    /// `SANDBOX_TOKEN_SECRET`: derives each pod's token
    /// ([`crate::token::pod_token`]), so every replica can talk to every pod
    /// and no token is stored.
    pub token_secret: String,
    /// `SANDBOX_NODE_SELECTOR`: a JSON object of labels the pods' nodes carry.
    pub node_selector: BTreeMap<String, String>,
    /// `SANDBOX_TOLERATIONS`: a JSON array of tolerations.
    pub tolerations: Value,
    /// `SANDBOX_DNS`: the resolvers the pods use (comma separated).
    pub dns: Vec<String>,
    /// What the isolation check tries to reach from inside a new sandbox
    /// (`host:port`): the metadata service, the Kubernetes API and
    /// `SANDBOX_EGRESS_PROBES`. Any answer is a sandbox that is not isolated.
    pub egress_probes: Vec<String>,
    /// `SANDBOX_REQUIRE_ISOLATION` (default true): refuse to hand out a
    /// sandbox until the isolation check passed. `false` only on a
    /// development cluster.
    pub require_isolation: bool,
    /// The Kubernetes API: `SANDBOX_KUBE_API_URL`, or the in-cluster
    /// `KUBERNETES_SERVICE_HOST` and port.
    pub kube_api_url: String,
    /// `SANDBOX_KUBE_TOKEN_FILE` and `SANDBOX_KUBE_CA_FILE`, for a server run
    /// outside the cluster; the mounted service account's otherwise.
    pub kube_token_file: String,
    pub kube_ca_file: String,
    /// `SEARXNG_URL`: the cluster's `SearXNG`, for `web_search`. `None`: the
    /// tool is left out.
    pub searxng_url: Option<String>,
}

impl std::fmt::Debug for SandboxConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SandboxConfig")
            .field("namespace", &self.namespace)
            .field("image", &self.image)
            .field("runtime_class", &self.runtime_class)
            .field("limits", &self.limits)
            .field("idle_timeout", &self.idle_timeout)
            .field("max_lifetime", &self.max_lifetime)
            .field("kube_api_url", &self.kube_api_url)
            .field("searxng_url", &self.searxng_url)
            .finish_non_exhaustive()
    }
}

/// A Kubernetes quantity, loosely: digits (with a dot) and an optional unit.
fn is_quantity(raw: &str) -> bool {
    let digits = raw.trim_end_matches(|c: char| c.is_ascii_alphabetic());
    let unit = &raw[digits.len()..];
    !digits.is_empty()
        && digits.chars().all(|c| c.is_ascii_digit() || c == '.')
        && ["", "m", "k", "M", "G", "T", "Ki", "Mi", "Gi", "Ti"].contains(&unit)
}

impl SandboxConfig {
    /// The sandbox, when `SANDBOX_ENABLED=true`; each wrong setting is one
    /// problem, so the server refuses to start on them.
    #[allow(clippy::too_many_lines)] // one block per setting
    pub fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        problems: &mut Vec<String>,
    ) -> Option<Self> {
        let get = |name: &str| {
            lookup(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        match get("SANDBOX_ENABLED").as_deref() {
            None | Some("false") => return None,
            Some("true") => {}
            Some(_) => {
                problems.push("SANDBOX_ENABLED must be true or false".to_owned());
                return None;
            }
        }
        let mut seconds = |name: &str, default: u64, min: u64| -> Duration {
            match get(name) {
                None => Duration::from_secs(default),
                Some(raw) => match raw.parse::<u64>() {
                    Ok(value) if value >= min => Duration::from_secs(value),
                    _ => {
                        problems.push(format!(
                            "{name} must be a whole number of seconds, at least {min}"
                        ));
                        Duration::from_secs(default)
                    }
                },
            }
        };
        let idle_timeout = seconds("SANDBOX_IDLE_TIMEOUT_SECONDS", 900, 60);
        let max_lifetime = seconds("SANDBOX_MAX_LIFETIME_SECONDS", 3600, 300);
        let start_timeout = seconds("SANDBOX_START_TIMEOUT_SECONDS", 120, 10);
        let mut count = |name: &str, default: usize| -> usize {
            match get(name) {
                None => default,
                Some(raw) => raw
                    .parse::<usize>()
                    .ok()
                    .filter(|n| *n > 0)
                    .unwrap_or_else(|| {
                        problems.push(format!("{name} must be a whole number above 0"));
                        default
                    }),
            }
        };
        let max_per_workspace = count("SANDBOX_MAX_PER_WORKSPACE", 2);
        let max_total = count("SANDBOX_MAX_TOTAL", 40);

        let image = get("SANDBOX_IMAGE").unwrap_or_else(|| {
            problems.push("SANDBOX_IMAGE is required with SANDBOX_ENABLED=true".to_owned());
            String::new()
        });
        let token_secret = get("SANDBOX_TOKEN_SECRET").unwrap_or_default();
        if token_secret.len() < 32 {
            problems.push(
                "SANDBOX_TOKEN_SECRET is required with SANDBOX_ENABLED=true (at least 32 characters, \
                 the same on every replica)"
                    .to_owned(),
            );
        }
        let defaults = Limits::default();
        let mut quantity = |name: &str, default: &str| -> String {
            let value = get(name).unwrap_or_else(|| default.to_owned());
            if !is_quantity(&value) {
                problems.push(format!(
                    "{name} must be a Kubernetes quantity (such as 1, 500m, 2Gi)"
                ));
            }
            value
        };
        let limits = Limits {
            cpu: quantity("SANDBOX_CPU", &defaults.cpu),
            cpu_request: quantity("SANDBOX_CPU_REQUEST", &defaults.cpu_request),
            memory: quantity("SANDBOX_MEMORY", &defaults.memory),
            disk: quantity("SANDBOX_DISK", &defaults.disk),
        };
        let runtime_class = match get("SANDBOX_RUNTIME_CLASS").as_deref() {
            None => Some(DEFAULT_RUNTIME_CLASS.to_owned()),
            Some("none") => None,
            Some(name) => Some(name.to_owned()),
        };
        let node_selector = match get("SANDBOX_NODE_SELECTOR") {
            None => BTreeMap::new(),
            Some(raw) => {
                serde_json::from_str::<BTreeMap<String, String>>(&raw).unwrap_or_else(|_| {
                    problems
                        .push("SANDBOX_NODE_SELECTOR must be a JSON object of strings".to_owned());
                    BTreeMap::new()
                })
            }
        };
        let tolerations = match get("SANDBOX_TOLERATIONS") {
            None => Value::Array(Vec::new()),
            Some(raw) => {
                if let Ok(list @ Value::Array(_)) = serde_json::from_str::<Value>(&raw) {
                    list
                } else {
                    problems.push("SANDBOX_TOLERATIONS must be a JSON array".to_owned());
                    Value::Array(Vec::new())
                }
            }
        };
        let list = |raw: Option<String>| -> Vec<String> {
            raw.map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
        };
        let mut dns = list(get("SANDBOX_DNS"));
        if dns.is_empty() {
            dns = DEFAULT_DNS.iter().map(|s| (*s).to_owned()).collect();
        }
        if dns.iter().any(|ip| ip.parse::<std::net::IpAddr>().is_err()) {
            problems.push("SANDBOX_DNS must be IP addresses, comma separated".to_owned());
        }

        let service = get("KUBERNETES_SERVICE_HOST").map(|host| {
            let port = get("KUBERNETES_SERVICE_PORT_HTTPS")
                .or_else(|| get("KUBERNETES_SERVICE_PORT"))
                .unwrap_or_else(|| "443".to_owned());
            let host = if host.contains(':') {
                format!("[{host}]")
            } else {
                host
            };
            (host, port)
        });
        let kube_api_url = get("SANDBOX_KUBE_API_URL")
            .or_else(|| {
                service
                    .as_ref()
                    .map(|(host, port)| format!("https://{host}:{port}"))
            })
            .unwrap_or_else(|| {
                problems.push(
                    "SANDBOX_ENABLED needs the Kubernetes API: run in the cluster \
                     (KUBERNETES_SERVICE_HOST) or set SANDBOX_KUBE_API_URL"
                        .to_owned(),
                );
                String::new()
            });
        let mut egress_probes = vec![METADATA_PROBE.to_owned()];
        if let Some((host, port)) = &service {
            egress_probes.push(format!("{host}:{port}"));
        }
        for probe in list(get("SANDBOX_EGRESS_PROBES")) {
            if probe
                .rsplit_once(':')
                .is_none_or(|(_, port)| port.parse::<u16>().is_err())
            {
                problems.push(format!("SANDBOX_EGRESS_PROBES: {probe} is not host:port"));
            } else if !egress_probes.contains(&probe) {
                egress_probes.push(probe);
            }
        }
        let require_isolation = match get("SANDBOX_REQUIRE_ISOLATION").as_deref() {
            None | Some("true") => true,
            Some("false") => false,
            Some(_) => {
                problems.push("SANDBOX_REQUIRE_ISOLATION must be true or false".to_owned());
                true
            }
        };
        let searxng_url = get("SEARXNG_URL").map(|url| url.trim_end_matches('/').to_owned());
        if let Some(url) = &searxng_url
            && url::Url::parse(url).is_err()
        {
            problems
                .push("SEARXNG_URL must be a URL (http://searxng.weldsuite.svc:8080)".to_owned());
        }

        Some(Self {
            namespace: get("SANDBOX_NAMESPACE").unwrap_or_else(|| DEFAULT_NAMESPACE.to_owned()),
            image,
            image_pull_secret: get("SANDBOX_IMAGE_PULL_SECRET"),
            runtime_class,
            limits,
            idle_timeout,
            max_lifetime,
            start_timeout,
            max_per_workspace,
            max_total,
            token_secret,
            node_selector,
            tolerations,
            dns,
            egress_probes,
            require_isolation,
            kube_api_url,
            kube_token_file: get("SANDBOX_KUBE_TOKEN_FILE")
                .unwrap_or_else(|| TOKEN_FILE.to_owned()),
            kube_ca_file: get("SANDBOX_KUBE_CA_FILE").unwrap_or_else(|| CA_FILE.to_owned()),
            searxng_url,
        })
    }

    /// A configuration for tests: every default, the fake cluster's API.
    pub fn for_tests() -> Self {
        Self {
            namespace: DEFAULT_NAMESPACE.to_owned(),
            image: "ghcr.io/weldsuite/weldsuite-sandbox:test".to_owned(),
            image_pull_secret: None,
            runtime_class: Some(DEFAULT_RUNTIME_CLASS.to_owned()),
            limits: Limits::default(),
            idle_timeout: Duration::from_mins(15),
            max_lifetime: Duration::from_hours(1),
            start_timeout: Duration::from_secs(30),
            max_per_workspace: 2,
            max_total: 40,
            token_secret: "0123456789abcdef0123456789abcdef".to_owned(),
            node_selector: BTreeMap::new(),
            tolerations: Value::Array(Vec::new()),
            dns: DEFAULT_DNS.iter().map(|s| (*s).to_owned()).collect(),
            egress_probes: vec![METADATA_PROBE.to_owned(), "10.96.0.1:443".to_owned()],
            require_isolation: true,
            kube_api_url: "https://10.96.0.1:443".to_owned(),
            kube_token_file: TOKEN_FILE.to_owned(),
            kube_ca_file: CA_FILE.to_owned(),
            searxng_url: Some("http://searxng.weldsuite.svc:8080".to_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(vars: &[(&str, &str)]) -> (Option<SandboxConfig>, Vec<String>) {
        let mut problems = Vec::new();
        let lookup = |name: &str| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        };
        let config = SandboxConfig::from_lookup(&lookup, &mut problems);
        (config, problems)
    }

    const ON: [(&str, &str); 5] = [
        ("SANDBOX_ENABLED", "true"),
        ("SANDBOX_IMAGE", "ghcr.io/weldsuite/weldsuite-sandbox:1.0.0"),
        (
            "SANDBOX_TOKEN_SECRET",
            "abcdefghijklmnopqrstuvwxyz0123456789",
        ),
        ("KUBERNETES_SERVICE_HOST", "10.96.0.1"),
        ("KUBERNETES_SERVICE_PORT", "443"),
    ];

    #[test]
    fn off_unless_enabled() {
        assert_eq!(read(&[]).0, None);
        assert_eq!(read(&[("SANDBOX_ENABLED", "false")]).0, None);
        let (none, problems) = read(&[("SANDBOX_ENABLED", "yes")]);
        assert!(none.is_none());
        assert_eq!(problems.len(), 1);
    }

    #[test]
    fn reads_the_in_cluster_api_and_defaults() {
        let (config, problems) = read(&ON);
        assert!(problems.is_empty(), "{problems:?}");
        let config = config.expect("on");
        assert_eq!(config.namespace, "weldsuite-sandbox");
        assert_eq!(config.runtime_class.as_deref(), Some("gvisor"));
        assert_eq!(config.kube_api_url, "https://10.96.0.1:443");
        assert_eq!(
            config.egress_probes,
            ["169.254.169.254:80", "10.96.0.1:443"]
        );
        assert_eq!(config.idle_timeout, Duration::from_mins(15));
        assert_eq!(config.max_lifetime, Duration::from_hours(1));
        assert_eq!(config.dns, ["9.9.9.9", "149.112.112.112"]);
        assert!(config.require_isolation);
        assert!(config.searxng_url.is_none());
        // The secret never shows in logs.
        assert!(!format!("{config:?}").contains("abcdefghijklmnop"));
    }

    #[test]
    fn needs_an_image_a_secret_and_the_api() {
        let (_, problems) = read(&[
            ("SANDBOX_ENABLED", "true"),
            ("SANDBOX_TOKEN_SECRET", "short"),
        ]);
        assert_eq!(problems.len(), 3, "{problems:?}");
    }

    #[test]
    fn checks_the_limits_and_lists() {
        let mut vars = ON.to_vec();
        vars.extend([
            ("SANDBOX_MEMORY", "lots"),
            ("SANDBOX_IDLE_TIMEOUT_SECONDS", "5"),
            ("SANDBOX_NODE_SELECTOR", "[1]"),
            ("SANDBOX_EGRESS_PROBES", "10.0.0.5:5432, nope"),
            ("SANDBOX_RUNTIME_CLASS", "none"),
            ("SEARXNG_URL", "http://searxng.weldsuite.svc:8080/"),
        ]);
        let (config, problems) = read(&vars);
        assert_eq!(problems.len(), 4, "{problems:?}");
        let config = config.expect("on");
        assert_eq!(config.runtime_class, None);
        assert!(config.egress_probes.contains(&"10.0.0.5:5432".to_owned()));
        assert_eq!(
            config.searxng_url.as_deref(),
            Some("http://searxng.weldsuite.svc:8080")
        );
    }

    #[test]
    fn quantities() {
        for ok in ["1", "500m", "2Gi", "1.5", "512Mi"] {
            assert!(is_quantity(ok), "{ok}");
        }
        for bad in ["", "Gi", "two", "1Xi", "-1"] {
            assert!(!is_quantity(bad), "{bad}");
        }
    }
}
