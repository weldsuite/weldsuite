//! The realtime WebSocket gateway in `serve` (`weldsuite-realtime`): started
//! when Valkey is configured, mounted next to the API, closed on shutdown,
//! and named in `/config.json` so the frontends find it.
//!
//! The gateway's routes (`/ws…`, `/publish/*`, `/internal/presence`) are
//! merged outside the request-logging layer: a socket's URL carries the
//! session token (`?token=`), which must not reach the logs or traces.

use std::sync::Arc;

use axum::Router;
use axum::http::HeaderMap;
use weldsuite_realtime::Gateway;

use crate::config::Config;
use crate::server::AppState;

/// What `/config.json` says about realtime.
#[derive(Debug, Clone, Default)]
pub(crate) struct PublicRealtime {
    /// The gateway runs (Valkey is configured).
    enabled: bool,
    /// `REALTIME_PUBLIC_URL`, when set.
    url: Option<Arc<str>>,
}

impl PublicRealtime {
    pub(crate) fn from_config(config: &Config) -> Self {
        Self {
            enabled: !cfg!(feature = "conformance") && config.infra.valkey_url.is_some(),
            url: config.realtime.public_url.as_deref().map(Arc::from),
        }
    }

    /// The gateway's WebSocket URL for `/config.json`: `REALTIME_PUBLIC_URL`,
    /// else the origin the request came to (as the ingress forwarded it),
    /// with `/ws`. `None` without a gateway.
    pub(crate) fn url(&self, headers: &HeaderMap) -> Option<String> {
        if !self.enabled {
            return None;
        }
        if let Some(url) = &self.url {
            return Some(url.to_string());
        }
        let first = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(',').next())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let host = first("x-forwarded-host").or_else(|| first("host"))?;
        if !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
        {
            return None;
        }
        let scheme = match first("x-forwarded-proto") {
            Some(proto) if proto.eq_ignore_ascii_case("https") => "wss",
            _ => "ws",
        };
        Some(format!("{scheme}://{host}/ws"))
    }
}

/// Start the gateway when Valkey is configured (never in conformance
/// builds, which connect to nothing).
pub(crate) async fn start(
    config: &Config,
    state: &AppState,
) -> Result<Option<Arc<Gateway>>, Box<dyn std::error::Error>> {
    if cfg!(feature = "conformance") {
        return Ok(None);
    }
    let Some(url) = &config.infra.valkey_url else {
        tracing::warn!("VALKEY_URL is not set: the realtime gateway is off");
        return Ok(None);
    };
    let directory = Arc::new(weldsuite_realtime::DbDirectory::new(Arc::clone(
        &state.workspaces,
    )));
    let auth: Arc<dyn weldsuite_realtime::Authenticator> = state.verifier.clone();
    let gateway = Gateway::start(
        config.realtime.clone(),
        auth,
        directory,
        url,
        &config.infra.valkey_realtime_prefix,
    )
    .await?;
    Ok(Some(gateway))
}

/// The server's router with the gateway's routes, when it runs.
pub(crate) fn mount(router: Router, gateway: Option<&Arc<Gateway>>) -> Router {
    match gateway {
        Some(gateway) => router.merge(weldsuite_realtime::router(Arc::clone(gateway))),
        None => router,
    }
}

/// On shutdown: close the sockets (1012) so clients reconnect to another pod.
pub(crate) async fn stop(gateway: Option<&Arc<Gateway>>) {
    if let Some(gateway) = gateway {
        gateway.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(*name, value.parse().expect("header"));
        }
        headers
    }

    #[test]
    fn the_url_follows_the_request_origin() {
        let realtime = PublicRealtime {
            enabled: true,
            url: None,
        };
        assert_eq!(
            realtime
                .url(&headers(&[
                    ("host", "app.example.eu"),
                    ("x-forwarded-proto", "https")
                ]))
                .as_deref(),
            Some("wss://app.example.eu/ws")
        );
        assert_eq!(
            realtime
                .url(&headers(&[
                    ("host", "weldsuite:8080"),
                    ("x-forwarded-host", "app.example.eu, proxy"),
                    ("x-forwarded-proto", "https,http"),
                ]))
                .as_deref(),
            Some("wss://app.example.eu/ws")
        );
        assert_eq!(
            realtime
                .url(&headers(&[("host", "localhost:8080")]))
                .as_deref(),
            Some("ws://localhost:8080/ws")
        );
        assert_eq!(realtime.url(&headers(&[("host", "a/b")])), None);
        assert_eq!(realtime.url(&HeaderMap::new()), None);

        let fixed = PublicRealtime {
            enabled: true,
            url: Some(Arc::from("wss://rt.example.eu/ws")),
        };
        assert_eq!(
            fixed.url(&headers(&[("host", "x")])).as_deref(),
            Some("wss://rt.example.eu/ws")
        );
        assert_eq!(
            PublicRealtime::default().url(&headers(&[("host", "x")])),
            None
        );
    }
}
