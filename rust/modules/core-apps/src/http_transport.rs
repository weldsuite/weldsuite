//! Outbound HTTP: the app gateway's forward to external-api and the
//! lifecycle webhooks. A port of its own so conformance mode can route the
//! calls into the test's `fetch` stub (`conformance_outbound.rs`).

use std::sync::Arc;
use std::time::Duration;

use weldsuite_ports::BoxFuture;

/// One request to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// Give up after this long (an `AbortController` timer in TypeScript).
    pub timeout: Option<Duration>,
}

/// What came back. Redirects are not followed (`redirect: 'manual'`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Sends a request; `Err` is a connection-level failure (`fetch` throwing).
pub trait HttpTransport: Send + Sync {
    fn send(&self, request: OutboundRequest) -> BoxFuture<'_, Result<OutboundResponse, String>>;
}

/// The transport a request uses in place of the app's, as a request
/// extension (conformance mode).
#[derive(Clone)]
pub struct AppsHttp(pub Arc<dyn HttpTransport>);

impl std::fmt::Debug for AppsHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AppsHttp")
    }
}

/// [`HttpTransport`] over reqwest, never following redirects.
#[derive(Debug, Clone)]
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    /// A client that keeps redirects to the caller, as `redirect: 'manual'`.
    ///
    /// # Panics
    ///
    /// When the TLS backend cannot be set up (a broken build).
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("the HTTP client builds");
        Self { client }
    }
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpTransport for ReqwestTransport {
    fn send(&self, request: OutboundRequest) -> BoxFuture<'_, Result<OutboundResponse, String>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(|error| error.to_string())?;
            let mut outgoing = self.client.request(method, &request.url);
            for (name, value) in &request.headers {
                outgoing = outgoing.header(name.as_str(), value.as_str());
            }
            if let Some(body) = request.body {
                outgoing = outgoing.body(body);
            }
            if let Some(timeout) = request.timeout {
                outgoing = outgoing.timeout(timeout);
            }
            let response = outgoing.send().await.map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.as_str().to_owned(), value.to_owned()))
                })
                .collect();
            let body = response
                .bytes()
                .await
                .map_err(|error| error.to_string())?
                .to_vec();
            Ok(OutboundResponse {
                status,
                headers,
                body,
            })
        })
    }
}
