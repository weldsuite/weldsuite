//! Valkey (Redis protocol) for the cache and for realtime publish. One
//! [`ConnectionManager`] per process serves both; it reconnects on its own.

use std::time::Duration;

use redis::AsyncCommands;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use weldsuite_ports::{Cache, PortError, RealtimeMessage, RealtimePublisher};

/// Connects to Valkey at `url` (`redis://`, or `rediss://` for TLS; user and
/// password in the URL). Fails when the first connection fails, so a bad URL
/// stops the server at startup instead of at the first request.
pub async fn connect_valkey(url: &str) -> Result<ConnectionManager, PortError> {
    let client = redis::Client::open(url).map_err(PortError::backend)?;
    let config = ConnectionManagerConfig::new()
        .set_connection_timeout(Some(Duration::from_secs(5)))
        .set_response_timeout(Some(Duration::from_secs(2)))
        .set_number_of_retries(3);
    ConnectionManager::new_with_config(client, config)
        .await
        .map_err(PortError::backend)
}

/// [`Cache`] on Valkey: `GET`, `SET … PX`, `DEL`. Every key gets `prefix`, so
/// several deployments (or the test suite) can share one Valkey.
#[derive(Clone)]
pub struct ValkeyCache {
    connection: ConnectionManager,
    prefix: String,
}

impl ValkeyCache {
    pub fn new(connection: ConnectionManager, prefix: impl Into<String>) -> Self {
        Self {
            connection,
            prefix: prefix.into(),
        }
    }

    fn key(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }
}

impl Cache for ValkeyCache {
    async fn get(&self, key: &str) -> Result<Option<String>, PortError> {
        let mut connection = self.connection.clone();
        connection
            .get(self.key(key))
            .await
            .map_err(PortError::backend)
    }

    async fn put(&self, key: &str, value: &str, ttl: Option<Duration>) -> Result<(), PortError> {
        let mut command = redis::cmd("SET");
        command.arg(self.key(key)).arg(value);
        if let Some(ttl) = ttl {
            // At least 1 ms: `PX 0` is an error, and a zero TTL means "gone".
            let millis = u64::try_from(ttl.as_millis()).unwrap_or(u64::MAX).max(1);
            command.arg("PX").arg(millis);
        }
        let mut connection = self.connection.clone();
        command
            .query_async::<()>(&mut connection)
            .await
            .map_err(PortError::backend)
    }

    async fn delete(&self, key: &str) -> Result<(), PortError> {
        let mut connection = self.connection.clone();
        connection
            .del::<_, ()>(self.key(key))
            .await
            .map_err(PortError::backend)
    }
}

/// [`RealtimePublisher`] on Valkey pub/sub: `PUBLISH <prefix><channel>
/// <payload JSON>`. The WebSocket gateway subscribes to the same channels
/// (`<prefix>workspace:*` and the room prefixes).
#[derive(Clone)]
pub struct ValkeyRealtime {
    connection: ConnectionManager,
    prefix: String,
}

impl ValkeyRealtime {
    pub fn new(connection: ConnectionManager, prefix: impl Into<String>) -> Self {
        Self {
            connection,
            prefix: prefix.into(),
        }
    }

    /// The Valkey channel a message goes to.
    pub fn channel(&self, message: &RealtimeMessage) -> String {
        format!("{}{}", self.prefix, message.channel)
    }
}

impl RealtimePublisher for ValkeyRealtime {
    async fn publish(&self, message: &RealtimeMessage) -> Result<(), PortError> {
        let payload = serde_json::to_string(&message.payload)?;
        let mut connection = self.connection.clone();
        connection
            .publish::<_, _, ()>(self.channel(message), payload)
            .await
            .map_err(PortError::backend)
    }
}
