//! Outbound HTTP to third parties (Expo push, APNs, a video provider's REST
//! API) with a plain HTTP client: the `fetch` a Worker calls.

use std::error::Error as StdError;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use reqwest::{Client, Identity, Method};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, PortError, is_public_ip,
};

/// [`DynOutboundHttp`] over `reqwest`, with a request timeout.
#[derive(Clone)]
pub struct ReqwestOutbound {
    client: Client,
    /// Refuse a URL whose host is a non-public IP literal (names go through
    /// [`PublicOnlyResolver`]).
    public_only: bool,
}

/// Refuses names that resolve only to non-public addresses, and drops the
/// non-public ones from a mixed answer.
struct PublicOnlyResolver;

impl reqwest::dns::Resolve for PublicOnlyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|address| is_public_ip(address.ip()))
                .collect();
            if addresses.is_empty() {
                return Err(BlockedAddress.into());
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

#[derive(Debug)]
struct BlockedAddress;

impl std::fmt::Display for BlockedAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the host resolves to a private or reserved address")
    }
}

impl StdError for BlockedAddress {}

/// Is `url`'s host an IP literal that is not public?
fn literal_is_blocked(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.parse::<IpAddr>().is_ok_and(|ip| !is_public_ip(ip))
}

impl ReqwestOutbound {
    /// A client whose requests give up after `timeout`.
    pub fn new(timeout: Duration) -> Result<Self, PortError> {
        let client = Client::builder()
            .timeout(timeout)
            .build()
            .map_err(PortError::backend)?;
        Ok(Self {
            client,
            public_only: false,
        })
    }

    /// A client for URLs a user chose (a self-managed GitLab host): it
    /// connects only to public addresses, on every redirect too, so a host
    /// cannot point it at the cluster's own services. Requests give up after
    /// `timeout`.
    pub fn public_only(timeout: Duration) -> Result<Self, PortError> {
        let client = Client::builder()
            .timeout(timeout)
            .dns_resolver(Arc::new(PublicOnlyResolver))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if literal_is_blocked(attempt.url()) {
                    attempt.error(BlockedAddress)
                } else if attempt.previous().len() >= 10 {
                    attempt.error("too many redirects")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(PortError::backend)?;
        Ok(Self {
            client,
            public_only: true,
        })
    }

    /// A client that presents a TLS client certificate (mutual TLS, as
    /// Ponto's API requires): `pem` holds the certificate chain and its
    /// private key.
    pub fn with_client_certificate(timeout: Duration, pem: &[u8]) -> Result<Self, PortError> {
        let identity = Identity::from_pem(pem).map_err(PortError::backend)?;
        let client = Client::builder()
            .timeout(timeout)
            .identity(identity)
            .build()
            .map_err(PortError::backend)?;
        Ok(Self {
            client,
            public_only: false,
        })
    }
}

impl DynOutboundHttp for ReqwestOutbound {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(async move {
            let method =
                Method::from_bytes(request.method.as_bytes()).map_err(PortError::backend)?;
            if self.public_only {
                let url = reqwest::Url::parse(&request.url).map_err(PortError::backend)?;
                if literal_is_blocked(&url) {
                    return Err(PortError::backend(BlockedAddress));
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_literals_are_blocked() {
        for blocked in [
            "https://10.0.0.12:8443/api/v4/user",
            "https://127.0.0.1/",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/",
            "https://[fd00::1]:8443/",
        ] {
            let url = reqwest::Url::parse(blocked).expect("url");
            assert!(literal_is_blocked(&url), "{blocked}");
        }
        for open in [
            "https://gitlab.example.com/api/v4/user",
            "https://93.184.216.34/",
            "https://[2606:4700::1111]/",
        ] {
            let url = reqwest::Url::parse(open).expect("url");
            assert!(!literal_is_blocked(&url), "{open}");
        }
    }

    #[tokio::test]
    async fn a_public_only_client_refuses_a_private_host() {
        let http = ReqwestOutbound::public_only(Duration::from_secs(5)).expect("client");
        for url in ["https://10.0.0.12:8443/api/v4/user", "http://localhost:9/"] {
            let result = http.send(HttpRequest::empty("GET", url)).await;
            assert!(result.is_err(), "{url}");
        }
    }
}
