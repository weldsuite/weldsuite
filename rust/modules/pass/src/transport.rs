//! Outbound HTTP to the deploy targets (Cloudflare's and Vercel's APIs): a
//! port of its own, so conformance mode routes the calls into the test's
//! `fetch` stub (`bins/weldsuite/src/conformance_outbound.rs`) and the
//! harness compares them as side effects.

use std::sync::Arc;
use std::time::Duration;

use weldsuite_ports::BoxFuture;

/// One request to a provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// Give up after this long (the SDK's `timeout`).
    pub timeout: Option<Duration>,
}

/// What came back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl OutboundResponse {
    /// A header's value, by case-insensitive name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Why a request got no answer: `fetch` threw, or the timeout fired.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    Failed(String),
    TimedOut,
}

/// Sends a request.
pub trait HttpTransport: Send + Sync {
    fn send(
        &self,
        request: OutboundRequest,
    ) -> BoxFuture<'_, Result<OutboundResponse, TransportError>>;
}

/// The transport a request uses in place of the app's, as a request
/// extension (conformance mode).
#[derive(Clone)]
pub struct PassHttp(pub Arc<dyn HttpTransport>);

impl std::fmt::Debug for PassHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PassHttp")
    }
}

/// [`HttpTransport`] over reqwest.
#[derive(Debug, Clone)]
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    /// # Panics
    ///
    /// When the TLS backend cannot be set up (a broken build).
    pub fn new() -> Self {
        #[allow(clippy::expect_used)]
        let client = reqwest::Client::builder()
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
    fn send(
        &self,
        request: OutboundRequest,
    ) -> BoxFuture<'_, Result<OutboundResponse, TransportError>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(|error| TransportError::Failed(error.to_string()))?;
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
            let response = outgoing.send().await.map_err(|error| {
                if error.is_timeout() {
                    TransportError::TimedOut
                } else {
                    TransportError::Failed(error.to_string())
                }
            })?;
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
                .map_err(|error| TransportError::Failed(error.to_string()))?
                .to_vec();
            Ok(OutboundResponse {
                status,
                headers,
                body,
            })
        })
    }
}
