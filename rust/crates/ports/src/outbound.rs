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

/// A streamed answer's body, read chunk by chunk (a model's server-sent
/// events).
pub trait HttpBodyStream: Send {
    /// The next chunk; `None` at the end of the body.
    fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, PortError>>;
}

/// A streamed answer: the status and headers as soon as they arrive, the
/// body as it comes. From [`DynOutboundHttp::send_streaming`].
pub struct HttpStreamResponse {
    pub status: u16,
    /// Names lowercased, in the order received.
    pub headers: Vec<(String, String)>,
    pub body: Box<dyn HttpBodyStream>,
}

impl std::fmt::Debug for HttpStreamResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpStreamResponse")
            .field("status", &self.status)
            .field("headers", &self.headers)
            .finish_non_exhaustive()
    }
}

/// A body already read whole, handed out as one chunk.
struct BufferedBody(Option<Vec<u8>>);

impl HttpBodyStream for BufferedBody {
    fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, PortError>> {
        let chunk = self.0.take().filter(|body| !body.is_empty());
        Box::pin(std::future::ready(Ok(chunk)))
    }
}

impl HttpStreamResponse {
    /// A whole answer as a stream of one chunk.
    pub fn buffered(response: HttpResponse) -> Self {
        Self {
            status: response.status,
            headers: response.headers,
            body: Box::new(BufferedBody(Some(response.body))),
        }
    }

    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The first value of a header, by case-insensitive name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// Reads the rest of the body: the answer as [`DynOutboundHttp::send`]
    /// would have given it.
    pub async fn collect(mut self) -> Result<HttpResponse, PortError> {
        let mut body = Vec::new();
        while let Some(chunk) = self.body.next_chunk().await? {
            body.extend_from_slice(&chunk);
        }
        Ok(HttpResponse {
            status: self.status,
            body,
            headers: self.headers,
        })
    }
}

/// Sends HTTP requests to third parties.
pub trait DynOutboundHttp: Send + Sync {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>>;

    /// Sends a request whose answer is read as it arrives (a model's
    /// server-sent events). The default reads the whole answer with
    /// [`send`](Self::send) and hands it out as one chunk, so every client
    /// that can't stream (the test doubles, the conformance bridge) still
    /// answers.
    fn send_streaming(
        &self,
        request: HttpRequest,
    ) -> BoxFuture<'_, Result<HttpStreamResponse, PortError>> {
        Box::pin(async move { self.send(request).await.map(HttpStreamResponse::buffered) })
    }
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

    /// [`DynOutboundHttp::send_streaming`].
    pub async fn send_streaming(
        &self,
        request: HttpRequest,
    ) -> Result<HttpStreamResponse, PortError> {
        self.0.send_streaming(request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Whole;

    impl DynOutboundHttp for Whole {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            let mut response = HttpResponse::new(200, request.url.into_bytes());
            response
                .headers
                .push(("content-type".to_owned(), "text/event-stream".to_owned()));
            Box::pin(std::future::ready(Ok(response)))
        }
    }

    #[tokio::test]
    async fn a_client_that_cant_stream_answers_in_one_chunk() {
        let http = OutboundHttp(Arc::new(Whole));
        let mut streamed = http
            .send_streaming(HttpRequest::empty("GET", "data: hi"))
            .await
            .expect("answer");
        assert!(streamed.ok());
        assert_eq!(streamed.header("Content-Type"), Some("text/event-stream"));
        assert_eq!(
            streamed.body.next_chunk().await.expect("chunk"),
            Some(b"data: hi".to_vec())
        );
        assert_eq!(streamed.body.next_chunk().await.expect("end"), None);

        let collected = http
            .send_streaming(HttpRequest::empty("GET", "whole"))
            .await
            .expect("answer")
            .collect()
            .await
            .expect("body");
        assert_eq!(collected.text(), "whole");
        assert_eq!(collected.status, 200);
    }
}
