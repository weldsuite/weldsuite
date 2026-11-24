//! Customers' own host names on the Kubernetes editions (ADR PANEL-014):
//! once a host name's DNS points at the install, a cert-manager
//! `Certificate` for it (HTTP-01 through the ingress controller) and an
//! `Ingress` that routes it, and nothing else, to the server's Service.
//! WeldPanel's collector domains (`weldsuite-panel`) and WeldCommerce's shop
//! domains (`weldsuite-commerce`) are two [`Profile`]s of the same machinery.
//!
//! Every check ([`CertManagerHosts::reconcile`]) looks the host name up over
//! DNS-over-HTTPS and, once it reaches the install's target (a CNAME chain to
//! [`Target::host`], or for an apex domain A records to
//! [`Target::apex_addresses`]), creates under one name per host name
//! ([`CertManagerHosts::object_name`]):
//!
//! - a `Certificate` for the host name from the configured issuer, into the
//!   Secret `<name>-tls`;
//! - an `Ingress` that sends the profile's paths on that host to the
//!   server's Service, with that certificate.
//!
//! | In the cluster | `status` | `ssl_status` |
//! |---|---|---|
//! | the DNS doesn't point here yet; nothing created | `pending` | none |
//! | the certificate is being issued | `pending` | `issuing` |
//! | the certificate is `Ready` | `active` | `active` |
//! | issuance failed; cert-manager's message is the error | `pending` | `failed` |
//!
//! Every object carries the profile's labels ([`Profile::labels`]), and the
//! adapter takes as its own, and deletes, only objects that carry them. The
//! chart's admission policy holds the server's service account to that.
//!
//! The Kubernetes API is plain REST with the service account's token, read
//! on every call because the kubelet rotates it, over a client that trusts
//! only the cluster's CA (the binary makes it).

use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

/// The label every object the server creates carries.
pub const MANAGED_BY: (&str, &str) = ("app.kubernetes.io/managed-by", "weldsuite");

/// The label key naming which profile made an object.
pub const COMPONENT_LABEL: &str = "app.kubernetes.io/component";

/// Cloudflare's public resolver, which the backend's other DNS checks ask.
pub const DEFAULT_DNS_RESOLVER: &str = "https://cloudflare-dns.com/dns-query";

/// The mounted service account's token.
pub const TOKEN_FILE: &str = "/var/run/secrets/kubernetes.io/serviceaccount/token";

/// `ssl_status` while cert-manager issues the certificate.
pub const SSL_ISSUING: &str = "issuing";
/// `ssl_status` once issuance failed.
pub const SSL_FAILED: &str = "failed";

/// DNS's type codes.
const TYPE_A: i64 = 1;
const TYPE_CNAME: i64 = 5;
const TYPE_TXT: i64 = 16;

/// A provider refused or could not be reached: the message, and the HTTP
/// status when it answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainError {
    pub message: String,
    pub status: Option<u16>,
}

impl std::fmt::Display for DomainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DomainError {}

/// Where a host name stands.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HostState {
    /// The name of its `Certificate` and `Ingress`.
    pub name: String,
    pub hostname: String,
    /// `pending` or `active`.
    pub status: String,
    /// `issuing`, `active` or `failed`; `None` before anything is created.
    pub ssl_status: Option<String>,
    /// Why it isn't active yet, when there is a reason to give.
    pub errors: Vec<String>,
}

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

/// How the server reaches the cluster and what its objects point at.
#[derive(Debug, Clone)]
pub struct ClusterSettings {
    /// The Kubernetes API, `https://<KUBERNETES_SERVICE_HOST>:<port>`.
    pub api_url: String,
    /// The server's namespace: where the objects go.
    pub namespace: String,
    pub token: KubeToken,
    /// The server's Service, the `Ingress`'s backend, and its port (a name
    /// or a number).
    pub service: String,
    pub service_port: String,
    /// The `Ingress` class; `None` is the cluster's default class.
    pub ingress_class: Option<String>,
    /// The cert-manager issuer and its kind (`letsencrypt`, `ClusterIssuer`).
    pub issuer: String,
    pub issuer_kind: String,
    /// The DNS-over-HTTPS endpoint host names are looked up at.
    pub dns_resolver: String,
}

impl ClusterSettings {
    /// The Kubernetes API from the variables every pod has
    /// (`KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT_HTTPS`); `None`
    /// outside a cluster.
    pub fn api_url_from_env(get: &impl Fn(&str) -> Option<String>) -> Option<String> {
        let value = |name: &str| {
            get(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let host = value("KUBERNETES_SERVICE_HOST")?;
        let port = value("KUBERNETES_SERVICE_PORT_HTTPS")
            .or_else(|| value("KUBERNETES_SERVICE_PORT"))
            .unwrap_or_else(|| "443".to_owned());
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host
        };
        Some(format!("https://{host}:{port}"))
    }
}

/// What a host name's `Ingress` routes to the server.
#[derive(Debug, Clone)]
pub enum Routes {
    /// These `(path, pathType)`s only; any other path on the host is the
    /// ingress controller's 404.
    Paths(&'static [(&'static str, &'static str)]),
    /// Every path (`/`, `Prefix`) to the given Service port instead of the
    /// cluster settings' (a listener of its own, such as the storefront edge).
    Everything { service_port: Option<String> },
}

/// Who the objects belong to, and how they are named and routed.
#[derive(Debug, Clone)]
pub struct Profile {
    /// For messages: `WeldPanel`, `WeldCommerce`.
    pub owner: &'static str,
    /// The `app.kubernetes.io/component` label value.
    pub component: &'static str,
    /// The annotation naming the host name an object is for.
    pub annotation: &'static str,
    /// The start of every object's name (`weldpanel`, `weldshop`).
    pub name_prefix: &'static str,
    /// The chart value that turns this on, named when the token is missing.
    pub chart_switch: &'static str,
    pub routes: Routes,
}

impl Profile {
    /// The labels on every object of this profile.
    pub fn labels(&self) -> [(&'static str, &'static str); 2] {
        [MANAGED_BY, (COMPONENT_LABEL, self.component)]
    }
}

/// What a customer's DNS must point at.
#[derive(Debug, Clone, Default)]
pub struct Target {
    /// The CNAME target (`collect.weldsuite.eu`, `shops.weldsuite.eu`).
    pub host: String,
    /// For an apex domain, which can't have a CNAME: the install's ingress
    /// addresses its A records must name. Empty: only CNAMEs count.
    pub apex_addresses: Vec<String>,
    /// Host names that belong to the install and are refused: these and
    /// every name under them.
    pub refused: Vec<String>,
}

/// Lower case, without a trailing dot.
pub fn normalize_host(host: &str) -> String {
    let host = host.trim().to_ascii_lowercase();
    host.strip_suffix('.').map(str::to_owned).unwrap_or(host)
}

/// `hostname` is `parent` or a name under it.
pub fn is_under(hostname: &str, parent: &str) -> bool {
    !parent.is_empty()
        && (hostname == parent
            || hostname
                .strip_suffix(parent)
                .is_some_and(|rest| rest.ends_with('.')))
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

/// Where a host name's DNS leads.
#[derive(Debug, PartialEq, Eq)]
enum Pointing {
    /// It reaches the target.
    Here,
    /// It resolves, but not to the target: why.
    Elsewhere(String),
    /// It doesn't resolve (yet).
    Nowhere,
}

/// Customers' host names through cert-manager, for one [`Profile`].
pub struct CertManagerHosts {
    settings: ClusterSettings,
    profile: Profile,
    target: Target,
    /// The Kubernetes API's client: the cluster's CA only.
    kube: OutboundHttp,
    /// The resolver's client.
    dns: OutboundHttp,
}

impl std::fmt::Debug for CertManagerHosts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CertManagerHosts")
            .field("settings", &self.settings)
            .field("profile", &self.profile.component)
            .field("target", &self.target)
            .finish_non_exhaustive()
    }
}

impl CertManagerHosts {
    pub fn new(
        mut settings: ClusterSettings,
        profile: Profile,
        mut target: Target,
        kube: OutboundHttp,
        dns: OutboundHttp,
    ) -> Self {
        settings.api_url = settings.api_url.trim_end_matches('/').to_owned();
        target.host = normalize_host(&target.host);
        target.refused = target.refused.iter().map(|h| normalize_host(h)).collect();
        Self {
            settings,
            profile,
            target,
            kube,
            dns,
        }
    }

    pub fn target(&self) -> &Target {
        &self.target
    }

    pub fn namespace(&self) -> &str {
        &self.settings.namespace
    }

    /// The name of a host name's `Certificate` and `Ingress`: readable,
    /// unique (a digest of the host name) and at most 61 characters, so
    /// cert-manager can use it as a label value.
    pub fn object_name(&self, hostname: &str) -> String {
        object_name(self.profile.name_prefix, hostname)
    }

    /// The target itself, or a name under one of the install's own domains.
    pub fn is_install_host(&self, hostname: &str) -> bool {
        hostname == self.target.host || self.target.refused.iter().any(|r| is_under(hostname, r))
    }

    fn install_host_refused(&self) -> DomainError {
        DomainError {
            message: format!(
                "This host name belongs to this install ({}); use one of your own",
                self.target.host
            ),
            status: Some(400),
        }
    }

    // ── The Kubernetes API ──────────────────────────────────────────────

    fn token(&self) -> Result<String, DomainError> {
        match &self.settings.token {
            KubeToken::Static(token) => Ok(token.clone()),
            KubeToken::File(path) => std::fs::read_to_string(path)
                .map(|token| token.trim().to_owned())
                .map_err(|error| DomainError {
                    message: format!(
                        "The service account's token {path} can't be read ({error}); the chart \
                         mounts it with {}",
                        self.profile.chart_switch
                    ),
                    status: None,
                }),
        }
    }

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
        let token = self.token()?;
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
                "A {} named {name} in {} isn't {}'s (it lacks the labels), so it was left alone",
                kind.name(),
                self.settings.namespace,
                self.profile.owner
            ),
            status: Some(409),
        }
    }

    fn is_ours(&self, object: &Value) -> bool {
        let labels = &object["metadata"]["labels"];
        self.profile
            .labels()
            .iter()
            .all(|(key, value)| labels[*key].as_str() == Some(*value))
    }

    fn label_object(&self) -> Value {
        Value::Object(
            self.profile
                .labels()
                .iter()
                .map(|(key, value)| ((*key).to_owned(), json!(value)))
                .collect::<Map<_, _>>(),
        )
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
        if self.is_ours(&found) {
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
    async fn delete_object(&self, kind: Kind, name: &str) -> Result<(), DomainError> {
        let Some(found) = self.read(kind, name).await? else {
            return Ok(());
        };
        if !self.is_ours(&found) {
            tracing::warn!(
                kind = kind.name(),
                name,
                owner = self.profile.owner,
                namespace = %self.settings.namespace,
                "[custom-domains] not deleting an object without the owner's labels"
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
            "labels": self.label_object(),
            "annotations": { self.profile.annotation: hostname },
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
                // The Secret is recognisable as the owner's too.
                "secretTemplate": {
                    "labels": self.label_object(),
                    "annotations": { self.profile.annotation: hostname },
                },
            },
        })
    }

    fn ingress(&self, name: &str, hostname: &str) -> Value {
        let port_of = |port: &str| {
            port.parse::<u16>().map_or_else(
                |_| json!({ "name": port }),
                |number| json!({ "number": number }),
            )
        };
        let backend =
            |port: &Value| json!({ "service": { "name": self.settings.service, "port": port } });
        let paths: Vec<Value> = match &self.profile.routes {
            Routes::Paths(paths) => {
                let port = port_of(&self.settings.service_port);
                paths
                    .iter()
                    .map(|(path, kind)| json!({ "path": path, "pathType": kind, "backend": backend(&port) }))
                    .collect()
            }
            Routes::Everything { service_port } => {
                let port = port_of(
                    service_port
                        .as_deref()
                        .unwrap_or(&self.settings.service_port),
                );
                vec![json!({ "path": "/", "pathType": "Prefix", "backend": backend(&port) })]
            }
        };
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

    /// The answers to `name`'s query of `kind` (`A`, `TXT`), CNAMEs of the
    /// chain included, as (type, data); host names lower case and without
    /// a trailing dot.
    async fn lookup(&self, name: &str, kind: &str) -> Result<Vec<(i64, String)>, DomainError> {
        let failed = |why: String| DomainError {
            message: format!("The DNS lookup of {name} failed: {why}"),
            status: None,
        };
        let encoded: String = url::form_urlencoded::byte_serialize(name.as_bytes()).collect();
        let request = HttpRequest::empty(
            "GET",
            format!("{}?name={encoded}&type={kind}", self.settings.dns_resolver),
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
            // NOERROR, or NXDOMAIN (the chain may still name the target).
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
                        let kind = answer["type"].as_i64().unwrap_or_default();
                        let data = answer["data"].as_str().unwrap_or_default();
                        let data = if kind == TYPE_TXT {
                            unquote_txt(data)
                        } else {
                            normalize_host(data)
                        };
                        (kind, data)
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// The TXT records of `name` (each one's strings joined), for ownership
    /// checks.
    pub async fn txt_records(&self, name: &str) -> Result<Vec<String>, DomainError> {
        Ok(self
            .lookup(name, "TXT")
            .await?
            .into_iter()
            .filter(|(kind, _)| *kind == TYPE_TXT)
            .map(|(_, data)| data)
            .collect())
    }

    async fn points_at(&self, hostname: &str) -> Result<Pointing, DomainError> {
        let answers = self.lookup(hostname, "A").await?;
        let target = self.target.host.as_str();
        let cnames: Vec<&str> = answers
            .iter()
            .filter(|(kind, _)| *kind == TYPE_CNAME)
            .map(|(_, data)| data.as_str())
            .collect();
        if cnames.contains(&target) {
            return Ok(Pointing::Here);
        }
        let addresses: Vec<&str> = answers
            .iter()
            .filter(|(kind, _)| *kind == TYPE_A)
            .map(|(_, data)| data.as_str())
            .collect();
        if cnames.is_empty()
            && !addresses.is_empty()
            && !self.target.apex_addresses.is_empty()
            && addresses
                .iter()
                .all(|a| self.target.apex_addresses.iter().any(|ours| ours == a))
        {
            return Ok(Pointing::Here);
        }
        Ok(match cnames.first() {
            Some(other) => Pointing::Elsewhere(format!(
                "{hostname} points at {other}, not at {target}: change its CNAME record"
            )),
            None if !addresses.is_empty() && self.target.apex_addresses.is_empty() => {
                Pointing::Elsewhere(format!(
                    "{hostname} has an address record, not a CNAME record pointing at {target}"
                ))
            }
            None if !addresses.is_empty() => Pointing::Elsewhere(format!(
                "{hostname} has address records other than {}: point a CNAME at {target}, or A records at those addresses",
                self.target.apex_addresses.join(", ")
            )),
            None => Pointing::Nowhere,
        })
    }

    // ── Checks ──────────────────────────────────────────────────────────

    /// Where the host name stands, moving it along: its objects created once
    /// its DNS points here, its status read from its certificate after.
    pub async fn reconcile(&self, hostname: &str) -> Result<HostState, DomainError> {
        let hostname = normalize_host(hostname);
        if self.is_install_host(&hostname) {
            return Err(self.install_host_refused());
        }
        let name = self.object_name(&hostname);
        if let Some(found) = self.read(Kind::Certificate, &name).await? {
            let certificate = self.owned(Kind::Certificate, &name, found)?;
            self.ensure(Kind::Ingress, &name, &self.ingress(&name, &hostname))
                .await?;
            return Ok(certificate_state(&name, &hostname, &certificate));
        }
        match self.points_at(&hostname).await? {
            Pointing::Here => {
                // The certificate first: a check that fails between the two
                // finds it next time and adds the route.
                let certificate = self
                    .ensure(
                        Kind::Certificate,
                        &name,
                        &self.certificate(&name, &hostname),
                    )
                    .await?;
                self.ensure(Kind::Ingress, &name, &self.ingress(&name, &hostname))
                    .await?;
                Ok(certificate_state(&name, &hostname, &certificate))
            }
            Pointing::Elsewhere(why) => Ok(HostState {
                errors: vec![why],
                ..pending(&name, &hostname)
            }),
            Pointing::Nowhere => Ok(pending(&name, &hostname)),
        }
    }

    /// Deletes the route first, so the host stops serving, then the
    /// certificate. The issued Secret stays (cert-manager keeps it unless it
    /// runs with `--enable-certificate-owner-ref`); it carries the labels.
    pub async fn remove_named(&self, name: &str) -> Result<(), DomainError> {
        self.delete_object(Kind::Ingress, name).await?;
        self.delete_object(Kind::Certificate, name).await
    }

    /// [`remove_named`](Self::remove_named) by host name.
    pub async fn remove(&self, hostname: &str) -> Result<(), DomainError> {
        let name = self.object_name(&normalize_host(hostname));
        self.remove_named(&name).await
    }
}

/// The name of a host name's objects under `prefix`: readable, unique (a
/// digest of the host name) and at most 61 characters.
pub fn object_name(prefix: &str, hostname: &str) -> String {
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
        "{prefix}-{}-{}",
        slug.trim_matches('-'),
        hex::encode(&digest[..5])
    )
}

/// The Secret the certificate is issued into.
fn secret_name(name: &str) -> String {
    format!("{name}-tls")
}

/// A TXT record's data without its quotes; several strings joined.
fn unquote_txt(data: &str) -> String {
    let data = data.trim();
    if !data.starts_with('"') {
        return data.to_owned();
    }
    data.split("\" \"")
        .map(|part| part.trim_matches('"'))
        .collect::<String>()
}

/// Waiting for the DNS: nothing in the cluster yet.
fn pending(name: &str, hostname: &str) -> HostState {
    HostState {
        name: name.to_owned(),
        hostname: hostname.to_owned(),
        status: "pending".to_owned(),
        ..HostState::default()
    }
}

/// A `Certificate`'s conditions as a host name's state: `Ready` is active,
/// `Issuing` false with reason `Failed` is failed (with cert-manager's
/// message), anything else is still issuing.
fn certificate_state(name: &str, hostname: &str, certificate: &Value) -> HostState {
    let conditions = certificate["status"]["conditions"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let condition = |kind: &str| conditions.iter().find(|c| c["type"] == kind);
    let state = pending(name, hostname);
    if condition("Ready").is_some_and(|c| c["status"] == "True") {
        return HostState {
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
        return HostState {
            ssl_status: Some(SSL_FAILED.to_owned()),
            errors: vec![message.to_owned()],
            ..state
        };
    }
    HostState {
        ssl_status: Some(SSL_ISSUING.to_owned()),
        ..state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_names_are_stable_valid_and_short() {
        let name = object_name("weldshop", "shop.example.com");
        assert_eq!(name, object_name("weldshop", "shop.example.com"));
        assert!(name.starts_with("weldshop-shop-example-com-"), "{name}");
        assert_ne!(name, object_name("weldshop", "shop-example.com"));
        let long = object_name("weldshop", &format!("{}.example.com", "a".repeat(200)));
        assert!(long.len() <= 63, "{long}");
    }

    #[test]
    fn names_under_a_domain() {
        assert!(is_under("weldsuite.eu", "weldsuite.eu"));
        assert!(is_under("app.weldsuite.eu", "weldsuite.eu"));
        assert!(!is_under("evilweldsuite.eu", "weldsuite.eu"));
        assert!(!is_under("weldsuite.eu.evil.test", "weldsuite.eu"));
        assert!(!is_under("anything", ""));
    }

    #[test]
    fn txt_data_is_unquoted() {
        assert_eq!(
            unquote_txt("\"weldcommerce-verify=abc\""),
            "weldcommerce-verify=abc"
        );
        assert_eq!(unquote_txt("\"part one\" \"part two\""), "part onepart two");
        assert_eq!(unquote_txt("plain"), "plain");
    }

    #[test]
    fn certificate_conditions_map_to_states() {
        let ready = json!({ "status": { "conditions": [{ "type": "Ready", "status": "True" }] } });
        assert_eq!(certificate_state("n", "h", &ready).status, "active");
        let failed = json!({ "status": { "conditions": [
            { "type": "Issuing", "status": "False", "reason": "Failed", "message": "rate limited" }
        ] } });
        let state = certificate_state("n", "h", &failed);
        assert_eq!(state.ssl_status.as_deref(), Some(SSL_FAILED));
        assert_eq!(state.errors, vec!["rate limited".to_owned()]);
        let issuing = json!({});
        assert_eq!(
            certificate_state("n", "h", &issuing).ssl_status.as_deref(),
            Some(SSL_ISSUING)
        );
    }
}
