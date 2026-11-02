//! The gateway's settings, from environment variables like the rest of the
//! server (`REALTIME_*`).

use std::fmt;
use std::time::Duration;

/// Limits and settings of the WebSocket gateway.
#[derive(Clone)]
pub struct GatewayConfig {
    /// `REALTIME_PUBLIC_URL`: the WebSocket URL `/config.json` gives the
    /// frontends (`wss://app.example.eu/ws`). Unset: the origin the request
    /// for `/config.json` came to, with `/ws`.
    pub public_url: Option<String>,
    /// `REALTIME_MAX_CONNECTIONS`: open sockets per pod; more are refused
    /// with 503 and the client retries (on another pod, through the Service).
    pub max_connections: usize,
    /// `REALTIME_MAX_CONNECTIONS_PER_USER`: open sockets per person per pod,
    /// against a client stuck in a reconnect loop.
    pub max_connections_per_user: usize,
    /// `REALTIME_MAX_SUBSCRIPTIONS`: topics one hub connection may hold.
    pub max_subscriptions: usize,
    /// `REALTIME_MAX_MESSAGE_BYTES`: the largest message a client may send
    /// (Cloudflare's WebSocket limit, 1 MiB, by default).
    pub max_message_bytes: usize,
    /// `REALTIME_SEND_QUEUE`: messages waiting for a slow client before it
    /// is disconnected (it reconnects and replays from its cursor).
    pub send_queue: usize,
    /// A socket that has sent nothing (not even its 25 s ping) for this long
    /// is closed with 4000, as the `WorkspaceHub`'s sweep does.
    pub stale_after: Duration,
    /// How often the gateway looks for silent sockets.
    pub stale_check: Duration,
    /// How often presence left behind by dead pods is settled per hub.
    pub sweep_every: Duration,
    /// A write to a client that takes longer than this drops it.
    pub write_timeout: Duration,
    /// How long a hub or room with nobody left keeps its subscription, so a
    /// reload does not unsubscribe and subscribe again.
    pub linger: Duration,
    /// `REALTIME_INTERNAL_SECRET`: what `/publish/*` and `/internal/*`
    /// callers send in `x-internal-secret`. Unset: both refuse every request.
    pub internal_secret: Option<String>,
    /// `WIDGET_TOKEN_SECRET`: verifies the helpdesk widget visitors' room
    /// tokens (the widget API signs them with the same value). Unset: every
    /// visitor is refused.
    pub widget_token_secret: Option<String>,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            public_url: None,
            max_connections: 20_000,
            max_connections_per_user: 100,
            max_subscriptions: 2_000,
            max_message_bytes: 1024 * 1024,
            send_queue: 1_024,
            stale_after: Duration::from_mins(2),
            stale_check: Duration::from_secs(30),
            sweep_every: Duration::from_mins(1),
            write_timeout: Duration::from_secs(10),
            linger: Duration::from_secs(30),
            internal_secret: None,
            widget_token_secret: None,
        }
    }
}

impl fmt::Debug for GatewayConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GatewayConfig")
            .field("public_url", &self.public_url)
            .field("max_connections", &self.max_connections)
            .field("max_connections_per_user", &self.max_connections_per_user)
            .field("max_subscriptions", &self.max_subscriptions)
            .field("max_message_bytes", &self.max_message_bytes)
            .field("send_queue", &self.send_queue)
            .field(
                "internal_secret",
                &self.internal_secret.as_ref().map(|_| "<set>"),
            )
            .field(
                "widget_token_secret",
                &self.widget_token_secret.as_ref().map(|_| "<set>"),
            )
            .finish_non_exhaustive()
    }
}

impl GatewayConfig {
    /// Read the `REALTIME_*` variables through `lookup`, adding what is wrong
    /// to `problems`.
    pub fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        problems: &mut Vec<String>,
    ) -> Self {
        let defaults = Self::default();
        let mut count = |name: &str, default: usize| -> usize {
            match lookup(name) {
                None => default,
                Some(raw) => match raw.parse::<usize>() {
                    Ok(value) if value > 0 => value,
                    _ => {
                        problems.push(format!("{name} must be a positive whole number"));
                        default
                    }
                },
            }
        };
        let max_connections = count("REALTIME_MAX_CONNECTIONS", defaults.max_connections);
        let max_connections_per_user = count(
            "REALTIME_MAX_CONNECTIONS_PER_USER",
            defaults.max_connections_per_user,
        );
        let max_subscriptions = count("REALTIME_MAX_SUBSCRIPTIONS", defaults.max_subscriptions);
        let max_message_bytes = count("REALTIME_MAX_MESSAGE_BYTES", defaults.max_message_bytes);
        let send_queue = count("REALTIME_SEND_QUEUE", defaults.send_queue);
        let public_url = lookup("REALTIME_PUBLIC_URL").filter(|url| !url.trim().is_empty());
        if let Some(url) = &public_url
            && !(url.starts_with("wss://") || url.starts_with("ws://"))
        {
            problems.push("REALTIME_PUBLIC_URL must be a ws:// or wss:// URL".to_owned());
        }
        Self {
            public_url,
            max_connections,
            max_connections_per_user,
            max_subscriptions,
            max_message_bytes,
            send_queue,
            internal_secret: lookup("REALTIME_INTERNAL_SECRET").filter(|s| !s.is_empty()),
            widget_token_secret: lookup("WIDGET_TOKEN_SECRET").filter(|s| !s.is_empty()),
            ..defaults
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn read(vars: &[(&str, &str)]) -> (GatewayConfig, Vec<String>) {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let mut problems = Vec::new();
        let config = GatewayConfig::from_lookup(&|name| vars.get(name).cloned(), &mut problems);
        (config, problems)
    }

    #[test]
    fn defaults_and_overrides() {
        let (config, problems) = read(&[]);
        assert_eq!(problems, Vec::<String>::new());
        assert_eq!(config.max_message_bytes, 1024 * 1024);
        assert!(config.internal_secret.is_none());

        let (config, problems) = read(&[
            ("REALTIME_MAX_CONNECTIONS", "5"),
            ("REALTIME_PUBLIC_URL", "wss://app.example.eu/ws"),
            ("REALTIME_INTERNAL_SECRET", "s3cret"),
        ]);
        assert_eq!(problems, Vec::<String>::new());
        assert_eq!(config.max_connections, 5);
        assert_eq!(
            config.public_url.as_deref(),
            Some("wss://app.example.eu/ws")
        );
        assert!(!format!("{config:?}").contains("s3cret"));
    }

    #[test]
    fn bad_values_are_problems() {
        let (_, problems) = read(&[
            ("REALTIME_SEND_QUEUE", "0"),
            ("REALTIME_PUBLIC_URL", "https://app.example.eu"),
        ]);
        assert_eq!(problems.len(), 2, "{problems:?}");
    }
}
