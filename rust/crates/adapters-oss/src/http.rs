//! Outbound HTTP to third parties (Expo push, APNs, a video provider's REST
//! API) with a plain HTTP client: the `fetch` a Worker calls.

use std::time::Duration;

use reqwest::{Client, Method};
use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, PortError};

/// [`DynOutboundHttp`] over `reqwest`, with a request timeout.
#[derive(Clone)]
pub struct ReqwestOutbound {
    client: Client,
}

impl ReqwestOutbound {
    /// A client whose requests give up after `timeout`.
    pub fn new(timeout: Duration) -> Result<Self, PortError> {
        let client = Client::builder()
            .timeout(timeout)
            .build()
            .map_err(PortError::backend)?;
        Ok(Self { client })
    }
}

impl DynOutboundHttp for ReqwestOutbound {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(async move {
            let method =
                Method::from_bytes(request.method.as_bytes()).map_err(PortError::backend)?;
            let mut call = self.client.request(method, &request.url);
            for (name, value) in &request.headers {
                call = call.header(name.as_str(), value.as_str());
            }
            if let Some(body) = request.body {
                call = call.body(body);
            }
            let response = call.send().await.map_err(PortError::backend)?;
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
            let body = response.bytes().await.map_err(PortError::backend)?.to_vec();
            Ok(HttpResponse {
                status,
                body,
                headers,
            })
        })
    }
}
