//! Outbound HTTP to third-party APIs (Expo push, APNs, a video provider's
//! REST API): the `fetch` a Worker calls. A port so conformance builds can
//! send each call through the test harness's outbound bridge, where the
//! test's own `fetch` stub answers it and the calls both backends made are
//! compared; the Kubernetes editions use a plain HTTP client.
//!
//! Reach it through the request's [`OutboundHttp`] extension when there is
//! one (conformance), else the app's.

use std::sync::Arc;

use crate::{BoxFuture, PortError};

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
