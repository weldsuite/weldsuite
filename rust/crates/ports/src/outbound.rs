//! Outbound HTTP to third-party APIs (Expo push, APNs, a video provider's
//! REST API): the `fetch` a Worker calls. A port so conformance builds can
//! send each call through the test harness's outbound bridge, where the
//! test's own `fetch` stub answers it and the calls both backends made are
//! compared; the Kubernetes editions use a plain HTTP client.
//!
//! Reach it through the request's [`OutboundHttp`] extension when there is
//! one (conformance), else the app's.

use std::net::IpAddr;
use std::sync::Arc;

use crate::{BoxFuture, PortError};

/// A globally routable address: not loopback, private, link-local, shared
/// (100.64/10), benchmarking, documentation, multicast, unspecified, reserved
/// or unique-local. What an outbound client that takes a user's URL (a
/// webhook, a self-managed GitLab host) may connect to, since the pod sits
/// next to the cluster's own services.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || first == 0x2001 && v6.segments()[1] == 0x0db8)
        }
    }
}

/// One request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    /// In the order the caller set them; names as written.
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

impl HttpRequest {
    /// A JSON request: `content-type: application/json` and the body.
    pub fn json(method: &str, url: impl Into<String>, body: &serde_json::Value) -> Self {
        Self {
            method: method.to_owned(),
            url: url.into(),
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: Some(body.to_string().into_bytes()),
        }
    }

    /// A request without a body.
    pub fn empty(method: &str, url: impl Into<String>) -> Self {
        Self {
            method: method.to_owned(),
            url: url.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    #[must_use]
    pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_owned(), value.into()));
        self
    }
}

/// One answer. A connection failure is an `Err` from [`DynOutboundHttp::send`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
    /// The answer's headers, names lowercased, in the order received. Empty
    /// where an adapter or a double does not report them.
    pub headers: Vec<(String, String)>,
}

impl HttpResponse {
    /// An answer without headers.
    pub fn new(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            body,
            headers: Vec::new(),
        }
    }

    /// The first value of a header (`response.headers.get(name)`), by
    /// case-insensitive name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The body as text (lossy).
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// The body as JSON, `Null` when it isn't.
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

/// Sends HTTP requests to third parties.
pub trait DynOutboundHttp: Send + Sync {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>>;
}

/// The outbound HTTP client a request uses (a request extension in
/// conformance builds, the app's otherwise).
#[derive(Clone)]
pub struct OutboundHttp(pub Arc<dyn DynOutboundHttp>);

impl std::fmt::Debug for OutboundHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OutboundHttp")
    }
}

impl OutboundHttp {
    pub async fn send(&self, request: HttpRequest) -> Result<HttpResponse, PortError> {
        self.0.send(request).await
    }
}
