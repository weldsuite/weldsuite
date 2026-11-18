//! Custom collector domains on the Kubernetes editions (ADR PANEL-014): the
//! [`CollectorDomains`] adapter over cert-manager and the ingress controller,
//! through the Kubernetes API in the server's own namespace
//! ([`CertManagerDomains`]). Global's is Cloudflare's custom hostnames
//! ([`super::domains::CloudflareDomains`]).
//!
//! The customer points a CNAME at the install's collector host
//! (`PANEL_COLLECTOR_HOST`, `collect.weldsuite.eu` on the EU edition).
//! HTTP-01 needs that CNAME in place before a certificate can be issued, so
//! nothing is created in the cluster until it is: every check (the
//! registration itself, the refresh route and the `panel-schedule` sweep
//! every 10 minutes) looks the host name up over DNS-over-HTTPS, as the
//! backend's other DNS checks do, and once its CNAME chain reaches the
//! collector host creates, under one name per host name ([`object_name`]):
//!
//! - a cert-manager `Certificate` for the host name from the chart's issuer
//!   (the `letsencrypt` `ClusterIssuer`, HTTP-01 through Traefik), into the
//!   Secret `<name>-tls`;
//! - an `Ingress` (the chart's class) that sends the collector's paths on
//!   that host, and nothing else, to the server's Service, with that
//!   certificate.
//!
//! The statuses map onto panel-api's, so the platform reads them as it reads
//! Cloudflare's:
//!
//! | In the cluster | `status` | `sslStatus` |
//! |---|---|---|
//! | no CNAME to the collector host yet; nothing created | `pending` | none |
//! | the certificate is being issued | `pending` | `issuing` |
//! | the certificate is `Ready` | `active` | `active` |
//! | issuance failed; cert-manager's message is the `lastError` | `failed` | `failed` |
//!
//! Deleting a domain deletes its `Ingress` and its `Certificate`. Every
//! object the adapter creates carries [`LABELS`], and it takes as its own,
//! and deletes, only objects that carry them: an object of the same name
//! without them is left alone (a check reports it; a delete passes it by).
//! The chart's Role can't express that, since RBAC matches kinds,
//! namespaces and names but never labels; the chart's admission policy
//! holds the server's service account to it.
//!
//! The Kubernetes API is plain REST with the service account's token, read
//! on every call because the kubelet rotates it, over a client that trusts
//! only the cluster's CA (the binary makes it, as for WeldAgent's sandbox).

use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};
use weldsuite_ports::{BoxFuture, HttpRequest, HttpResponse, OutboundHttp};

use super::domains::{CollectorDomains, DomainError, HostnameState};

/// The labels on every object the adapter creates. It reads as its own, and
/// deletes, only objects that carry all of them.
pub const LABELS: [(&str, &str); 2] = [
    ("app.kubernetes.io/managed-by", "weldsuite"),
    ("app.kubernetes.io/component", "panel-collector-domain"),
];

/// The annotation naming the host name an object is for.
pub const HOSTNAME_ANNOTATION: &str = "weldsuite.org/panel-hostname";

/// Cloudflare's public resolver, which the backend's other DNS checks ask.
pub const DEFAULT_DNS_RESOLVER: &str = "https://cloudflare-dns.com/dns-query";

/// The mounted service account's token.
pub const TOKEN_FILE: &str = "/var/run/secrets/kubernetes.io/serviceaccount/token";

/// What a customer's host name serves: the collector's routes at the root of
/// a host (`collector::root_router`), as `(path, pathType)`. Keep in step
/// with it. Any other path on the host is the ingress controller's 404, so
/// the host never serves the platform.
pub const COLLECTOR_PATHS: [(&str, &str); 9] = [
    ("/s.js", "Exact"),
    ("/rec.js", "Exact"),
    ("/v.js", "Exact"),
    ("/c/", "Prefix"),
    ("/e", "Exact"),
    ("/r", "Exact"),
    ("/snap", "Exact"),
    ("/v1/track", "Exact"),
    ("/v1/import", "Exact"),
];

/// DNS's type codes for A and CNAME records.
const TYPE_A: i64 = 1;
const TYPE_CNAME: i64 = 5;

/// `sslStatus` while cert-manager issues the certificate.
pub const SSL_ISSUING: &str = "issuing";
/// `sslStatus` once issuance failed (`domain_status_of` reads it as `failed`).
pub const SSL_FAILED: &str = "failed";

/// Where the bearer token for the Kubernetes API comes from.
#[derive(Clone)]
pub enum KubeToken {
    /// A file, read on every call: the mounted service account's token,
    /// which the kubelet rotates.
    File(String),
    /// A fixed token (tests).
    Static(String),
}

impl std::fmt::Debug for KubeToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::File(path) => f.debug_tuple("File").field(path).finish(),
            Self::Static(_) => f.write_str("Static(..)"),
        }
    }
}

impl KubeToken {
    fn read(&self) -> Result<String, DomainError> {
        match self {
            Self::Static(token) => Ok(token.clone()),
            Self::File(path) => std::fs::read_to_string(path)
                .map(|token| token.trim().to_owned())
                .map_err(|error| DomainError {
                    message: format!(
                        "The service account's token {path} can't be read ({error}); the chart \
                         mounts it with config.panel.customDomains.enabled"
                    ),
                    status: None,
                }),
        }
    }
}

/// How the adapter reaches the cluster and what it creates there.
#[derive(Debug, Clone)]
pub struct CertManagerSettings {
    /// The Kubernetes API, `https://<KUBERNETES_SERVICE_HOST>:<port>`.
    pub api_url: String,
    /// The server's namespace: where the objects go.
    pub namespace: String,
    pub token: KubeToken,
    /// What customers point their CNAME at (`collect.weldsuite.eu`).
    pub collector_host: String,
    /// The server's Service, the `Ingress`'s backend, and its port (a name
    /// or a number).
    pub service: String,
    pub service_port: String,
    /// The `Ingress` class; `None` is the cluster's default class.
    pub ingress_class: Option<String>,
    /// The cert-manager issuer and its kind (`letsencrypt`, `ClusterIssuer`).
    pub issuer: String,
    pub issuer_kind: String,
    /// The DNS-over-HTTPS endpoint the CNAME is looked up at.
    pub dns_resolver: String,
}

impl CertManagerSettings {
    /// From the environment the chart writes (`config.panel.customDomains`):
    ///
    /// | Variable | |
    /// |---|---|
    /// | `PANEL_CUSTOM_DOMAINS` | `cert-manager` turns the adapter on; unset, there is none (503) |
    /// | `PANEL_COLLECTOR_HOST` | the CNAME target (required) |
    /// | `PANEL_DOMAINS_NAMESPACE`, `PANEL_DOMAINS_SERVICE` | the server's namespace and Service (required) |
    /// | `PANEL_DOMAINS_SERVICE_PORT` | the Service's port, by name or number (default `http`) |
    /// | `PANEL_DOMAINS_INGRESS_CLASS` | the `Ingress` class (default: the cluster's default class) |
    /// | `PANEL_DOMAINS_ISSUER`, `PANEL_DOMAINS_ISSUER_KIND` | the issuer (default `letsencrypt`, a `ClusterIssuer`) |
    /// | `PANEL_DNS_RESOLVER` | the DNS-over-HTTPS endpoint (default Cloudflare's) |
    /// | `KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT_HTTPS` | the API, as every pod has them |
    ///
    /// `Ok(None)` without `PANEL_CUSTOM_DOMAINS`; an error names what else
    /// is missing.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let value = |name: &str| {
            get(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        match value("PANEL_CUSTOM_DOMAINS").as_deref() {
            None => return Ok(None),
            Some("cert-manager") => {}
            Some(other) => {
                return Err(format!(
                    "PANEL_CUSTOM_DOMAINS must be cert-manager, not {other:?}"
                ));
            }
        }
        let required = |name: &str| {
            value(name).ok_or_else(|| format!("PANEL_CUSTOM_DOMAINS=cert-manager needs {name}"))
        };
        let collector_host = normalize_host(&required("PANEL_COLLECTOR_HOST")?);
        if !collector_host.contains('.') {
            return Err(format!(
                "PANEL_COLLECTOR_HOST must be a host name such as collect.example.com, not {collector_host:?}"
            ));
        }
        let host = value("KUBERNETES_SERVICE_HOST").ok_or_else(|| {
            "PANEL_CUSTOM_DOMAINS=cert-manager needs the Kubernetes API: run in the cluster \
             (KUBERNETES_SERVICE_HOST)"
                .to_owned()
        })?;
        let port = value("KUBERNETES_SERVICE_PORT_HTTPS")
            .or_else(|| value("KUBERNETES_SERVICE_PORT"))
            .unwrap_or_else(|| "443".to_owned());
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host
        };
        Ok(Some(Self {
            api_url: format!("https://{host}:{port}"),
            namespace: required("PANEL_DOMAINS_NAMESPACE")?,
            token: KubeToken::File(TOKEN_FILE.to_owned()),
            collector_host,
            service: required("PANEL_DOMAINS_SERVICE")?,
            service_port: value("PANEL_DOMAINS_SERVICE_PORT").unwrap_or_else(|| "http".to_owned()),
            ingress_class: value("PANEL_DOMAINS_INGRESS_CLASS"),
            issuer: value("PANEL_DOMAINS_ISSUER").unwrap_or_else(|| "letsencrypt".to_owned()),
            issuer_kind: value("PANEL_DOMAINS_ISSUER_KIND")
                .unwrap_or_else(|| "ClusterIssuer".to_owned()),
            dns_resolver: value("PANEL_DNS_RESOLVER")
                .unwrap_or_else(|| DEFAULT_DNS_RESOLVER.to_owned()),
        }))
    }
}

/// Lower case, without a trailing dot.
fn normalize_host(host: &str) -> String {
    let host = host.trim().to_ascii_lowercase();
    host.strip_suffix('.').map(str::to_owned).unwrap_or(host)
}

/// The name of a host name's `Certificate` and `Ingress`: readable, unique
/// (a digest of the host name) and at most 61 characters, so cert-manager
/// can use it as a label value.
pub fn object_name(hostname: &str) -> String {
    let digest = Sha256::digest(hostname.as_bytes());
    let mut slug: String = hostname
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    slug.truncate(40);
    format!(
        "weldpanel-{}-{}",
        slug.trim_matches('-'),
        hex::encode(&digest[..5])
    )
}

/// The Secret the certificate is issued into.
fn secret_name(name: &str) -> String {
    format!("{name}-tls")
}

/// Carries every one of [`LABELS`].
fn is_ours(object: &Value) -> bool {
    let labels = &object["metadata"]["labels"];
    LABELS
        .iter()
        .all(|(key, value)| labels[*key].as_str() == Some(*value))
}

fn labels() -> Value {
    Value::Object(
        LABELS
            .iter()
            .map(|(key, value)| ((*key).to_owned(), json!(value)))
            .collect::<Map<_, _>>(),
    )
}

/// The two kinds the adapter manages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Certificate,
    Ingress,
}

impl Kind {
    fn api(self) -> &'static str {
        match self {
            Self::Certificate => "apis/cert-manager.io/v1",
            Self::Ingress => "apis/networking.k8s.io/v1",
        }
    }

    fn plural(self) -> &'static str {
        match self {
            Self::Certificate => "certificates",
            Self::Ingress => "ingresses",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Certificate => "Certificate",
            Self::Ingress => "Ingress",
        }
    }
}

/// Where a host name's CNAME leads.
#[derive(Debug, PartialEq, Eq)]
enum Pointing {
    /// Its CNAME chain reaches the collector host.
    Collector,
    /// It resolves, but not through the collector host: why, for `lastError`.
    Elsewhere(String),
    /// It doesn't resolve (yet).
    Nowhere,
}

/// Custom collector domains through cert-manager (ADR PANEL-014).
pub struct CertManagerDomains {
    settings: CertManagerSettings,
    /// The Kubernetes API's client: the cluster's CA only.
    kube: OutboundHttp,
    /// The resolver's client.
    dns: OutboundHttp,
}

impl std::fmt::Debug for CertManagerDomains {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CertManagerDomains")
            .field("settings", &self.settings)
            .finish_non_exhaustive()
    }
}

impl CertManagerDomains {
    pub fn new(mut settings: CertManagerSettings, kube: OutboundHttp, dns: OutboundHttp) -> Self {
        settings.api_url = settings.api_url.trim_end_matches('/').to_owned();
        settings.collector_host = normalize_host(&settings.collector_host);
        Self {
            settings,
            kube,
            dns,
        }
    }

    /// The collector host, or a name under the install's own domain (what
    /// the collector host is under, `weldsuite.eu` for
    /// `collect.weldsuite.eu`): never a customer's.
    fn is_own_host(&self, hostname: &str) -> bool {
        let collector = self.settings.collector_host.as_str();
        if hostname == collector {
            return true;
        }
        collector
            .split_once('.')
            .map(|(_, parent)| parent)
            .filter(|parent| parent.contains('.'))
            .is_some_and(|parent| {
                hostname == parent
                    || hostname
                        .strip_suffix(parent)
                        .is_some_and(|rest| rest.ends_with('.'))
            })
    }

    fn own_host_refused(&self) -> DomainError {
        DomainError {
            message: format!(
                "This host name belongs to this install ({}); use one of your own",
                self.settings.collector_host
            ),
            status: Some(400),
        }
    }

    // ── The Kubernetes API ──────────────────────────────────────────────

    fn url(&self, kind: Kind, name: Option<&str>) -> String {
        let collection = format!(
            "{}/{}/namespaces/{}/{}",
            self.settings.api_url,
            kind.api(),
            self.settings.namespace,
            kind.plural()
        );
        match name {
            Some(name) => format!("{collection}/{name}"),
            None => collection,
        }
    }

    async fn call(
        &self,
        method: &str,
        url: String,
        body: Option<&Value>,
    ) -> Result<HttpResponse, DomainError> {
        let token = self.settings.token.read()?;
        let request = match body {
            Some(body) => HttpRequest::json(method, url, body),
            None => HttpRequest::empty(method, url),
        }
        .header("authorization", format!("Bearer {token}"))
        .header("accept", "application/json");
        self.kube.send(request).await.map_err(|error| DomainError {
            message: format!("The Kubernetes API could not be reached: {error}"),
            status: None,
        })
    }

    /// An answer the API refused, with its `Status` message.
    fn refused(&self, kind: Kind, name: &str, response: &HttpResponse) -> DomainError {
        let body = response.json();
        let message = body["message"].as_str().map_or_else(
            || response.text().chars().take(300).collect(),
            str::to_owned,
        );
        DomainError {
            message: format!(
                "Kubernetes refused the {} {name} in {}: {message}",
                kind.name(),
                self.settings.namespace
            ),
            status: Some(response.status),
        }
    }

    fn not_ours(&self, kind: Kind, name: &str) -> DomainError {
        DomainError {
            message: format!(
                "A {} named {name} in {} isn't WeldPanel's (it lacks the labels), so it was left alone",
                kind.name(),
                self.settings.namespace
            ),
            status: Some(409),
        }
    }

    /// The object, `None` when there is none.
    async fn read(&self, kind: Kind, name: &str) -> Result<Option<Value>, DomainError> {
        let response = self.call("GET", self.url(kind, Some(name)), None).await?;
        match response.status {
            200 => Ok(Some(response.json())),
            404 => Ok(None),
            _ => Err(self.refused(kind, name, &response)),
        }
    }

    fn owned(&self, kind: Kind, name: &str, found: Value) -> Result<Value, DomainError> {
        if is_ours(&found) {
            Ok(found)
        } else {
            Err(self.not_ours(kind, name))
        }
    }

    /// The object, created from `manifest` when there is none; an error,
    /// never the object, when one of that name isn't ours.
    async fn ensure(&self, kind: Kind, name: &str, manifest: &Value) -> Result<Value, DomainError> {
        if let Some(found) = self.read(kind, name).await? {
            return self.owned(kind, name, found);
        }
        let response = self
            .call("POST", self.url(kind, None), Some(manifest))
            .await?;
        match response.status {
            200..=202 => Ok(response.json()),
            // Made since the read (another pod's check): it will do if it's ours.
            409 => match self.read(kind, name).await? {
                Some(found) => self.owned(kind, name, found),
                None => Err(self.refused(kind, name, &response)),
            },
            _ => Err(self.refused(kind, name, &response)),
        }
    }

    /// Deletes the object when it is ours; one that is gone, or isn't ours,
    /// is passed by.
    async fn remove(&self, kind: Kind, name: &str) -> Result<(), DomainError> {
        let Some(found) = self.read(kind, name).await? else {
            return Ok(());
        };
        if !is_ours(&found) {
            tracing::warn!(
                kind = kind.name(),
                name,
                namespace = %self.settings.namespace,
                "[panel] not deleting an object without WeldPanel's labels"
            );
            return Ok(());
        }
        let body = json!({
            "apiVersion": "v1",
            "kind": "DeleteOptions",
            "propagationPolicy": "Background",
            // Only the object just read, never one made in its place since.
            "preconditions": { "uid": found["metadata"]["uid"] },
        });
        let response = self
            .call("DELETE", self.url(kind, Some(name)), Some(&body))
            .await?;
        match response.status {
            200 | 202 | 404 => Ok(()),
            _ => Err(self.refused(kind, name, &response)),
        }
    }

    // ── What is created ─────────────────────────────────────────────────

    fn metadata(&self, name: &str, hostname: &str) -> Value {
        json!({
            "name": name,
            "namespace": self.settings.namespace,
            "labels": labels(),
            "annotations": { HOSTNAME_ANNOTATION: hostname },
        })
    }

    fn certificate(&self, name: &str, hostname: &str) -> Value {
        json!({
            "apiVersion": "cert-manager.io/v1",
            "kind": "Certificate",
            "metadata": self.metadata(name, hostname),
            "spec": {
                "secretName": secret_name(name),
                "dnsNames": [hostname],
                "issuerRef": {
                    "group": "cert-manager.io",
                    "kind": self.settings.issuer_kind,
                    "name": self.settings.issuer,
                },
                "privateKey": { "rotationPolicy": "Always" },
                // The Secret is recognisable as WeldPanel's too.
                "secretTemplate": {
                    "labels": labels(),
                    "annotations": { HOSTNAME_ANNOTATION: hostname },
                },
            },
        })
    }

    fn ingress(&self, name: &str, hostname: &str) -> Value {
        let port = self.settings.service_port.parse::<u16>().map_or_else(
            |_| json!({ "name": self.settings.service_port }),
            |number| json!({ "number": number }),
        );
        let paths: Vec<Value> = COLLECTOR_PATHS
            .iter()
            .map(|(path, kind)| {
                json!({
                    "path": path,
                    "pathType": kind,
                    "backend": { "service": { "name": self.settings.service, "port": port } },
                })
            })
            .collect();
        let mut spec = json!({
            "tls": [{ "hosts": [hostname], "secretName": secret_name(name) }],
            "rules": [{ "host": hostname, "http": { "paths": paths } }],
        });
        if let Some(class) = &self.settings.ingress_class {
            spec["ingressClassName"] = json!(class);
        }
        json!({
            "apiVersion": "networking.k8s.io/v1",
            "kind": "Ingress",
            "metadata": self.metadata(name, hostname),
            "spec": spec,
        })
    }

    // ── DNS ─────────────────────────────────────────────────────────────

    /// The answers to `name`'s A query, CNAMEs of the chain included, as
    /// (type, data) with the data lower case and without a trailing dot.
    async fn lookup(&self, name: &str) -> Result<Vec<(i64, String)>, DomainError> {
        let failed = |why: String| DomainError {
            message: format!("The DNS lookup of {name} failed: {why}"),
            status: None,
        };
        let encoded: String = url::form_urlencoded::byte_serialize(name.as_bytes()).collect();
        let request = HttpRequest::empty(
            "GET",
            format!("{}?name={encoded}&type=A", self.settings.dns_resolver),
        )
        .header("accept", "application/dns-json");
        let response = self
            .dns
            .send(request)
            .await
            .map_err(|error| failed(error.to_string()))?;
        if !response.ok() {
            return Err(failed(format!("status {}", response.status)));
        }
        let body = response.json();
        match body["Status"].as_i64() {
            // NOERROR, or NXDOMAIN (the chain may still name the collector host).
            Some(0 | 3) => {}
            Some(code) => return Err(failed(format!("response code {code}"))),
            None => return Err(failed("not a DNS answer".to_owned())),
        }
        Ok(body["Answer"]
            .as_array()
            .map(|answers| {
                answers
                    .iter()
                    .map(|answer| {
                        (
                            answer["type"].as_i64().unwrap_or_default(),
                            normalize_host(answer["data"].as_str().unwrap_or_default()),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn points_at(&self, hostname: &str) -> Result<Pointing, DomainError> {
        let answers = self.lookup(hostname).await?;
        let target = self.settings.collector_host.as_str();
        let cnames: Vec<&str> = answers
            .iter()
            .filter(|(kind, _)| *kind == TYPE_CNAME)
            .map(|(_, data)| data.as_str())
            .collect();
        if cnames.contains(&target) {
            return Ok(Pointing::Collector);
        }
        Ok(match cnames.first() {
            Some(other) => Pointing::Elsewhere(format!(
                "{hostname} points at {other}, not at {target}: change its CNAME record"
            )),
            None if answers.iter().any(|(kind, _)| *kind == TYPE_A) => {
                Pointing::Elsewhere(format!(
                    "{hostname} has an address record, not a CNAME record pointing at {target}"
                ))
            }
            None => Pointing::Nowhere,
        })
    }

    // ── Checks ──────────────────────────────────────────────────────────

    /// Where the host name stands, moving it along: its objects created once
    /// its CNAME points here, its status read from its certificate after.
    async fn reconcile(&self, name: &str, hostname: &str) -> Result<HostnameState, DomainError> {
        if self.is_own_host(hostname) {
            return Err(self.own_host_refused());
        }
        if let Some(found) = self.read(Kind::Certificate, name).await? {
            let certificate = self.owned(Kind::Certificate, name, found)?;
            self.ensure(Kind::Ingress, name, &self.ingress(name, hostname))
                .await?;
            return Ok(certificate_state(name, hostname, &certificate));
        }
        match self.points_at(hostname).await? {
            Pointing::Collector => {
                // The certificate first: a check that fails between the two
                // finds it next time and adds the route.
                let certificate = self
                    .ensure(Kind::Certificate, name, &self.certificate(name, hostname))
                    .await?;
                self.ensure(Kind::Ingress, name, &self.ingress(name, hostname))
                    .await?;
                Ok(certificate_state(name, hostname, &certificate))
            }
            Pointing::Elsewhere(why) => Ok(HostnameState {
                errors: vec![why],
                ..pending(name, hostname)
            }),
            Pointing::Nowhere => Ok(pending(name, hostname)),
        }
    }
}

/// Waiting for the CNAME: nothing in the cluster yet.
fn pending(name: &str, hostname: &str) -> HostnameState {
    HostnameState {
        id: name.to_owned(),
        hostname: hostname.to_owned(),
        status: "pending".to_owned(),
        ..HostnameState::default()
    }
}

/// A `Certificate`'s conditions as a host name's state: `Ready` is active,
/// `Issuing` false with reason `Failed` is failed (with cert-manager's
/// message), anything else is still issuing.
fn certificate_state(name: &str, hostname: &str, certificate: &Value) -> HostnameState {
    let conditions = certificate["status"]["conditions"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let condition = |kind: &str| conditions.iter().find(|c| c["type"] == kind);
    let state = pending(name, hostname);
    if condition("Ready").is_some_and(|c| c["status"] == "True") {
        return HostnameState {
            status: "active".to_owned(),
            ssl_status: Some("active".to_owned()),
            ..state
        };
    }
    if let Some(issuing) =
        condition("Issuing").filter(|c| c["status"] == "False" && c["reason"] == "Failed")
    {
        let message = issuing["message"]
            .as_str()
            .filter(|m| !m.is_empty())
            .unwrap_or("cert-manager could not issue the certificate");
        return HostnameState {
            ssl_status: Some(SSL_FAILED.to_owned()),
            errors: vec![message.to_owned()],
            ..state
        };
    }
    HostnameState {
        ssl_status: Some(SSL_ISSUING.to_owned()),
        ..state
    }
}

impl CollectorDomains for CertManagerDomains {
    fn cname_target(&self) -> &str {
        &self.settings.collector_host
    }

    /// Registers the host name and checks it at once: when its CNAME is
    /// already in place, issuance starts now rather than at the next sweep.
    /// A check that fails leaves it pending, with why, for the sweep.
    fn create<'a>(
        &'a self,
        hostname: &'a str,
        _metadata: &'a [(&'a str, String)],
    ) -> BoxFuture<'a, Result<HostnameState, DomainError>> {
        Box::pin(async move {
            if self.is_own_host(hostname) {
                return Err(self.own_host_refused());
            }
            let name = object_name(hostname);
            Ok(match self.reconcile(&name, hostname).await {
                Ok(state) => state,
                Err(error) => HostnameState {
                    errors: vec![error.message],
                    ..pending(&name, hostname)
                },
            })
        })
    }

    fn get<'a>(
        &'a self,
        id: &'a str,
        hostname: &'a str,
    ) -> BoxFuture<'a, Result<Option<HostnameState>, DomainError>> {
        Box::pin(async move { self.reconcile(id, hostname).await.map(Some) })
    }

    /// Deletes the route first, so the host stops serving, then the
    /// certificate. The issued Secret stays (cert-manager keeps it unless
    /// it runs with `--enable-certificate-owner-ref`); it carries the labels.
    fn delete<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), DomainError>> {
        Box::pin(async move {
            self.remove(Kind::Ingress, id).await?;
            self.remove(Kind::Certificate, id).await
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex, PoisonError};

    use axum::Router;
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::response::{IntoResponse, Response};
    use http::{HeaderMap, Method, StatusCode, Uri};
    use weldsuite_ports::{DynOutboundHttp, PortError};

    use super::super::domains::domain_status_of;
    use super::*;

    const TOKEN: &str = "sa-token";
    const NAMESPACE: &str = "weldsuite";
    const HOST: &str = "stats.example.com";

    /// A fake Kubernetes API and DNS-over-HTTPS resolver on one local port:
    /// objects by (plural, name), the DNS answers by name, and every call.
    #[derive(Default)]
    struct Cluster {
        objects: Mutex<BTreeMap<(String, String), Value>>,
        dns: Mutex<BTreeMap<String, Value>>,
        calls: Mutex<Vec<(String, String)>>,
        uids: Mutex<u32>,
    }

    impl Cluster {
        fn object(&self, plural: &str, name: &str) -> Option<Value> {
            self.objects
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&(plural.to_owned(), name.to_owned()))
                .cloned()
        }

        fn put(&self, plural: &str, name: &str, object: Value) {
            self.objects
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert((plural.to_owned(), name.to_owned()), object);
        }

        fn cname(&self, name: &str, target: &str) {
            self.dns.lock().unwrap_or_else(PoisonError::into_inner).insert(
                name.to_owned(),
                json!({ "Status": 0, "Answer": [
                    { "name": format!("{name}."), "type": 5, "TTL": 300, "data": format!("{target}.") },
                    { "name": format!("{target}."), "type": 1, "TTL": 300, "data": "203.0.113.10" },
                ] }),
            );
        }

        /// What cert-manager would write on the certificate.
        fn conditions(&self, name: &str, conditions: &Value) {
            let mut objects = self.objects.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(certificate) =
                objects.get_mut(&("certificates".to_owned(), name.to_owned()))
            {
                certificate["status"] = json!({ "conditions": conditions });
            }
        }

        /// The calls that changed something (POST, PUT, PATCH, DELETE).
        fn writes(&self) -> Vec<(String, String)> {
            self.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .iter()
                .filter(|(method, _)| method != "GET")
                .cloned()
                .collect()
        }
    }

    fn answer(status: StatusCode, body: &Value) -> Response {
        (status, axum::Json(body.clone())).into_response()
    }

    async fn serve(
        State(cluster): State<Arc<Cluster>>,
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        let path = uri.path().to_owned();
        cluster
            .calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((method.to_string(), path.clone()));
        if path == "/dns-query" {
            let name = uri
                .query()
                .unwrap_or_default()
                .split('&')
                .find_map(|pair| pair.strip_prefix("name="))
                .unwrap_or_default()
                .to_owned();
            let found = cluster
                .dns
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&name)
                .cloned();
            return answer(StatusCode::OK, &found.unwrap_or(json!({ "Status": 3 })));
        }
        let bearer = format!("Bearer {TOKEN}");
        if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(bearer.as_str()) {
            return answer(
                StatusCode::UNAUTHORIZED,
                &json!({ "message": "Unauthorized" }),
            );
        }
        // /apis/<group>/<version>/namespaces/<ns>/<plural>[/<name>]
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        if parts.len() < 6
            || parts[0] != "apis"
            || parts[3] != "namespaces"
            || parts[4] != NAMESPACE
        {
            return answer(StatusCode::NOT_FOUND, &json!({ "message": "no such path" }));
        }
        let plural = parts[5].to_owned();
        let named = parts.get(6).map(|name| (*name).to_owned());
        match (method.as_str(), named) {
            ("POST", None) => {
                let mut object: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let name = object["metadata"]["name"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                if cluster.object(&plural, &name).is_some() {
                    return answer(
                        StatusCode::CONFLICT,
                        &json!({ "reason": "AlreadyExists", "message": format!("{plural} \"{name}\" already exists") }),
                    );
                }
                let uid = {
                    let mut uids = cluster.uids.lock().unwrap_or_else(PoisonError::into_inner);
                    *uids += 1;
                    format!("uid-{}", *uids)
                };
                object["metadata"]["uid"] = json!(uid);
                object["metadata"]["resourceVersion"] = json!("1");
                cluster.put(&plural, &name, object.clone());
                answer(StatusCode::CREATED, &object)
            }
            ("GET", Some(name)) => match cluster.object(&plural, &name) {
                Some(object) => answer(StatusCode::OK, &object),
                None => answer(
                    StatusCode::NOT_FOUND,
                    &json!({ "reason": "NotFound", "message": format!("{plural} \"{name}\" not found") }),
                ),
            },
            ("DELETE", Some(name)) => {
                let Some(object) = cluster.object(&plural, &name) else {
                    return answer(StatusCode::NOT_FOUND, &json!({ "message": "not found" }));
                };
                let options: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let wanted = &options["preconditions"]["uid"];
                if !wanted.is_null() && *wanted != object["metadata"]["uid"] {
                    return answer(
                        StatusCode::CONFLICT,
                        &json!({ "message": "Precondition failed: UID in precondition does not match" }),
                    );
                }
                cluster
                    .objects
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&(plural, name));
                answer(
                    StatusCode::OK,
                    &json!({ "kind": "Status", "status": "Success" }),
                )
            }
            _ => answer(
                StatusCode::METHOD_NOT_ALLOWED,
                &json!({ "message": "not here" }),
            ),
        }
    }

    struct Reqwest(reqwest::Client);

    impl DynOutboundHttp for Reqwest {
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
                let body = response.bytes().await.map_err(PortError::backend)?.to_vec();
                Ok(HttpResponse::new(status, body))
            })
        }
    }

    /// The fake cluster on a local port, and the adapter pointed at it.
    async fn start() -> (Arc<Cluster>, CertManagerDomains) {
        let cluster = Arc::new(Cluster::default());
        let app = Router::new()
            .fallback(serve)
            .with_state(Arc::clone(&cluster));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move { axum::serve(listener, app).await });
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client");
        let http = OutboundHttp(Arc::new(Reqwest(client)));
        let settings = CertManagerSettings {
            api_url: format!("http://{address}/"),
            namespace: NAMESPACE.to_owned(),
            token: KubeToken::Static(TOKEN.to_owned()),
            collector_host: "Collect.WeldSuite.eu.".to_owned(),
            service: "weldsuite".to_owned(),
            service_port: "http".to_owned(),
            ingress_class: Some("traefik".to_owned()),
            issuer: "letsencrypt".to_owned(),
            issuer_kind: "ClusterIssuer".to_owned(),
            dns_resolver: format!("http://{address}/dns-query"),
        };
        (
            cluster,
            CertManagerDomains::new(settings, http.clone(), http),
        )
    }

    #[tokio::test]
    async fn creates_the_certificate_and_route_once_the_cname_points_here() {
        let (cluster, domains) = start().await;
        let name = object_name(HOST);

        // Registered before the CNAME exists: pending, nothing in the cluster.
        let created = domains.create(HOST, &[]).await.expect("create");
        assert_eq!(created.id, name);
        assert_eq!(domain_status_of(&created), "pending");
        assert_eq!(created.ssl_status, None);
        assert!(created.errors.is_empty(), "{:?}", created.errors);
        assert!(cluster.writes().is_empty(), "{:?}", cluster.writes());
        assert_eq!(domains.cname_target(), "collect.weldsuite.eu");

        // The CNAME is in place: the sweep creates both objects.
        cluster.cname(HOST, "collect.weldsuite.eu");
        let issuing = domains
            .get(&name, HOST)
            .await
            .expect("check")
            .expect("state");
        assert_eq!(domain_status_of(&issuing), "pending");
        assert_eq!(issuing.ssl_status.as_deref(), Some(SSL_ISSUING));

        let certificate = cluster.object("certificates", &name).expect("certificate");
        assert_eq!(certificate["spec"]["dnsNames"], json!([HOST]));
        assert_eq!(
            certificate["spec"]["secretName"],
            json!(format!("{name}-tls"))
        );
        assert_eq!(
            certificate["spec"]["issuerRef"],
            json!({ "group": "cert-manager.io", "kind": "ClusterIssuer", "name": "letsencrypt" })
        );
        assert!(is_ours(&certificate));
        assert_eq!(
            certificate["metadata"]["annotations"][HOSTNAME_ANNOTATION],
            json!(HOST)
        );

        let ingress = cluster.object("ingresses", &name).expect("ingress");
        assert!(is_ours(&ingress));
        assert_eq!(ingress["spec"]["ingressClassName"], "traefik");
        assert_eq!(
            ingress["spec"]["tls"],
            json!([{ "hosts": [HOST], "secretName": format!("{name}-tls") }])
        );
        let rule = &ingress["spec"]["rules"][0];
        assert_eq!(rule["host"], HOST);
        let paths = rule["http"]["paths"].as_array().expect("paths");
        assert_eq!(paths.len(), COLLECTOR_PATHS.len());
        assert!(paths.iter().all(|p| p["backend"]
            == json!({ "service": { "name": "weldsuite", "port": { "name": "http" } } })));
        assert!(
            paths
                .iter()
                .any(|p| p["path"] == "/s.js" && p["pathType"] == "Exact")
        );
        assert!(
            paths
                .iter()
                .any(|p| p["path"] == "/c/" && p["pathType"] == "Prefix")
        );
        assert!(
            paths.iter().all(|p| p["path"] != "/"),
            "the platform is never served"
        );

        // Checking again creates nothing new.
        let writes = cluster.writes().len();
        domains.get(&name, HOST).await.expect("check again");
        assert_eq!(cluster.writes().len(), writes);
    }

    #[tokio::test]
    async fn status_follows_the_certificate_until_it_is_ready() {
        let (cluster, domains) = start().await;
        let name = object_name(HOST);
        cluster.cname(HOST, "collect.weldsuite.eu");
        // Already pointing when registered: issuance starts at once.
        let created = domains.create(HOST, &[]).await.expect("create");
        assert_eq!(created.ssl_status.as_deref(), Some(SSL_ISSUING));
        assert!(cluster.object("certificates", &name).is_some());

        cluster.conditions(
            &name,
            &json!([
                { "type": "Ready", "status": "False", "reason": "DoesNotExist" },
                { "type": "Issuing", "status": "True", "reason": "DoesNotExist" },
            ]),
        );
        let state = domains
            .get(&name, HOST)
            .await
            .expect("check")
            .expect("state");
        assert_eq!(domain_status_of(&state), "pending");
        assert_eq!(state.ssl_status.as_deref(), Some(SSL_ISSUING));

        cluster.conditions(
            &name,
            &json!([{ "type": "Ready", "status": "True", "reason": "Ready" }]),
        );
        let state = domains
            .get(&name, HOST)
            .await
            .expect("check")
            .expect("state");
        assert_eq!(domain_status_of(&state), "active");
        assert_eq!(state.ssl_status.as_deref(), Some("active"));
        assert!(state.errors.is_empty(), "{:?}", state.errors);

        // A route deleted by hand comes back with the next check.
        cluster
            .objects
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&("ingresses".to_owned(), name.clone()));
        domains.get(&name, HOST).await.expect("check");
        assert!(cluster.object("ingresses", &name).is_some());
    }

    #[tokio::test]
    async fn a_failed_issuance_is_failed_with_cert_managers_reason() {
        let (cluster, domains) = start().await;
        let name = object_name(HOST);
        cluster.cname(HOST, "collect.weldsuite.eu");
        domains.create(HOST, &[]).await.expect("create");
        let why = "The certificate request has failed to complete and will be retried: order is in \"invalid\" state";
        cluster.conditions(
            &name,
            &json!([
                { "type": "Ready", "status": "False", "reason": "DoesNotExist" },
                { "type": "Issuing", "status": "False", "reason": "Failed", "message": why },
            ]),
        );
        let state = domains
            .get(&name, HOST)
            .await
            .expect("check")
            .expect("state");
        assert_eq!(domain_status_of(&state), "failed");
        assert_eq!(state.ssl_status.as_deref(), Some(SSL_FAILED));
        assert_eq!(state.errors, vec![why.to_owned()]);
    }

    #[tokio::test]
    async fn a_cname_elsewhere_stays_pending_with_why() {
        let (cluster, domains) = start().await;
        cluster.cname(HOST, "cname.vercel-dns.com");
        let state = domains.create(HOST, &[]).await.expect("create");
        assert_eq!(domain_status_of(&state), "pending");
        assert_eq!(
            state.errors,
            vec![format!(
                "{HOST} points at cname.vercel-dns.com, not at collect.weldsuite.eu: change its CNAME record"
            )]
        );
        assert!(cluster.writes().is_empty(), "{:?}", cluster.writes());
        // A chain through another name to the collector host is fine.
        cluster
            .dns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                HOST.to_owned(),
                json!({ "Status": 0, "Answer": [
                { "type": 5, "data": "edge.example.net." },
                { "type": 5, "data": "collect.weldsuite.eu." },
                { "type": 1, "data": "203.0.113.10" },
            ] }),
            );
        let state = domains
            .get(&object_name(HOST), HOST)
            .await
            .expect("check")
            .expect("state");
        assert_eq!(state.ssl_status.as_deref(), Some(SSL_ISSUING));
    }

    #[tokio::test]
    async fn deleting_removes_the_route_and_the_certificate() {
        let (cluster, domains) = start().await;
        let name = object_name(HOST);
        cluster.cname(HOST, "collect.weldsuite.eu");
        domains.create(HOST, &[]).await.expect("create");
        assert!(cluster.object("ingresses", &name).is_some());

        domains.delete(&name).await.expect("delete");
        assert!(cluster.object("ingresses", &name).is_none());
        assert!(cluster.object("certificates", &name).is_none());
        let deletes: Vec<String> = cluster
            .writes()
            .into_iter()
            .filter(|(method, _)| method == "DELETE")
            .map(|(_, path)| path)
            .collect();
        assert_eq!(
            deletes,
            vec![
                format!("/apis/networking.k8s.io/v1/namespaces/{NAMESPACE}/ingresses/{name}"),
                format!("/apis/cert-manager.io/v1/namespaces/{NAMESPACE}/certificates/{name}"),
            ]
        );
        // Gone already: still removed.
        domains.delete(&name).await.expect("delete again");
        // Never created (the CNAME never came): nothing to do.
        domains
            .delete(&object_name("other.example.com"))
            .await
            .expect("delete");
    }

    #[tokio::test]
    async fn never_touches_objects_without_its_labels() {
        let (cluster, domains) = start().await;
        let name = object_name(HOST);
        cluster.cname(HOST, "collect.weldsuite.eu");
        let foreign = |kind: &str| {
            json!({
                "kind": kind,
                "metadata": { "name": name, "namespace": NAMESPACE, "uid": "theirs",
                              "labels": { "app.kubernetes.io/managed-by": "Helm" } },
                "spec": { "dnsNames": ["app.weldsuite.eu"] },
            })
        };
        cluster.put("certificates", &name, foreign("Certificate"));
        cluster.put("ingresses", &name, foreign("Ingress"));

        // A check reports it and changes nothing.
        let error = domains.get(&name, HOST).await.expect_err("not ours");
        assert!(
            error.message.contains("isn't WeldPanel's"),
            "{}",
            error.message
        );
        // A registration stays pending, with why.
        let state = domains.create(HOST, &[]).await.expect("create");
        assert_eq!(domain_status_of(&state), "pending");
        assert!(
            state.errors[0].contains("isn't WeldPanel's"),
            "{:?}",
            state.errors
        );
        // Our certificate beside someone else's Ingress: the route is refused.
        cluster.put(
            "certificates",
            &name,
            json!({ "metadata": { "name": name, "uid": "ours", "labels": labels() } }),
        );
        let error = domains.get(&name, HOST).await.expect_err("not ours");
        assert!(error.message.contains("Ingress"), "{}", error.message);
        // A delete passes it by.
        cluster.put("certificates", &name, foreign("Certificate"));
        domains.delete(&name).await.expect("delete");

        assert!(cluster.writes().is_empty(), "{:?}", cluster.writes());
        assert_eq!(
            cluster.object("certificates", &name),
            Some(foreign("Certificate"))
        );
        assert_eq!(cluster.object("ingresses", &name), Some(foreign("Ingress")));
    }

    #[tokio::test]
    async fn refuses_the_installs_own_host_names() {
        let (cluster, domains) = start().await;
        for own in [
            "collect.weldsuite.eu",
            "weldsuite.eu",
            "app.weldsuite.eu",
            "x.test.weldsuite.eu",
        ] {
            let error = domains.create(own, &[]).await.expect_err(own);
            assert_eq!(error.status, Some(400), "{own}");
            assert!(domains.get(&object_name(own), own).await.is_err(), "{own}");
        }
        for theirs in [
            "stats.example.com",
            "weldsuite.eu.example.com",
            "notweldsuite.eu",
        ] {
            domains.create(theirs, &[]).await.expect(theirs);
        }
        assert!(cluster.writes().is_empty(), "{:?}", cluster.writes());
    }

    #[tokio::test]
    async fn api_refusals_and_dns_failures_carry_the_reason() {
        let (cluster, mut domains) = start().await;
        cluster.cname(HOST, "collect.weldsuite.eu");
        domains.settings.token = KubeToken::Static("wrong".to_owned());
        let error = domains
            .get(&object_name(HOST), HOST)
            .await
            .expect_err("refused");
        assert_eq!(error.status, Some(401));
        assert!(error.message.contains("Unauthorized"), "{}", error.message);

        domains.settings.token = KubeToken::Static(TOKEN.to_owned());
        domains.settings.dns_resolver = format!("{}/nowhere", domains.settings.api_url);
        let error = domains
            .get(&object_name(HOST), HOST)
            .await
            .expect_err("no resolver");
        assert!(
            error
                .message
                .starts_with("The DNS lookup of stats.example.com failed"),
            "{}",
            error.message
        );
        // A registration is kept all the same, for the sweep.
        let state = domains.create(HOST, &[]).await.expect("create");
        assert_eq!(domain_status_of(&state), "pending");
        assert_eq!(state.errors.len(), 1);
    }

    #[test]
    fn object_names_are_stable_valid_and_short() {
        let name = object_name("stats.example.com");
        assert_eq!(name, object_name("stats.example.com"));
        assert!(name.starts_with("weldpanel-stats-example-com-"), "{name}");
        assert_ne!(name, object_name("stats-example.com"));
        let long = object_name(&format!("{}.example.com", "a".repeat(200)));
        assert!(long.len() <= 63, "{long}");
        for name in [name, long] {
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{name}"
            );
        }
    }

    #[test]
    fn settings_come_from_the_charts_environment() {
        let read = |vars: &'static [(&'static str, &'static str)]| {
            CertManagerSettings::from_env(|name| {
                vars.iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| (*value).to_owned())
            })
        };
        assert!(read(&[]).expect("off").is_none());
        assert!(
            read(&[("PANEL_COLLECTOR_HOST", "collect.weldsuite.eu")])
                .expect("off without the switch")
                .is_none()
        );
        assert!(read(&[("PANEL_CUSTOM_DOMAINS", "cloudflare")]).is_err());
        let error = read(&[("PANEL_CUSTOM_DOMAINS", "cert-manager")]).expect_err("no host");
        assert!(error.contains("PANEL_COLLECTOR_HOST"), "{error}");
        let error = read(&[
            ("PANEL_CUSTOM_DOMAINS", "cert-manager"),
            ("PANEL_COLLECTOR_HOST", "collect.weldsuite.eu"),
        ])
        .expect_err("not in a cluster");
        assert!(error.contains("KUBERNETES_SERVICE_HOST"), "{error}");

        let settings = read(&[
            ("PANEL_CUSTOM_DOMAINS", "cert-manager"),
            ("PANEL_COLLECTOR_HOST", "Collect.WeldSuite.eu."),
            ("KUBERNETES_SERVICE_HOST", "fd00::1"),
            ("KUBERNETES_SERVICE_PORT", "6443"),
            ("PANEL_DOMAINS_NAMESPACE", "weldsuite"),
            ("PANEL_DOMAINS_SERVICE", "weldsuite"),
            ("PANEL_DOMAINS_INGRESS_CLASS", "traefik"),
        ])
        .expect("valid")
        .expect("on");
        assert_eq!(settings.api_url, "https://[fd00::1]:6443");
        assert_eq!(settings.collector_host, "collect.weldsuite.eu");
        assert_eq!(settings.service_port, "http");
        assert_eq!(settings.ingress_class.as_deref(), Some("traefik"));
        assert_eq!(settings.issuer, "letsencrypt");
        assert_eq!(settings.issuer_kind, "ClusterIssuer");
        assert_eq!(settings.dns_resolver, DEFAULT_DNS_RESOLVER);
        assert!(matches!(settings.token, KubeToken::File(ref path) if path == TOKEN_FILE));
    }
}
