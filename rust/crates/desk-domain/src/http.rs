//! Third-party HTTP calls the desk makes (Discord's and Slack's REST APIs)
//! as a port, so conformance builds send them through the harness's
//! outbound bridge, where they are compared as side effects.

use std::sync::Arc;

use weldsuite_ports::BoxFuture;

/// One request: `fetch(url, { method, headers, body })`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    /// In the order the TypeScript call names them.
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// The answer: its status and body text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

impl HttpResponse {
    /// `response.ok`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Sends a request; `Err` when `fetch` itself throws.
pub trait DeskHttp: Send + Sync {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, String>>;
}

/// The deployment's client.
pub type DynDeskHttp = Arc<dyn DeskHttp>;

/// A request's own client, ahead of the module's (conformance mode).
#[derive(Clone)]
pub struct RequestHttp(pub DynDeskHttp);

impl std::fmt::Debug for RequestHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestHttp")
    }
}
