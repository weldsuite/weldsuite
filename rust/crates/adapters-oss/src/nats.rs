//! NATS `JetStream` as the event bus: the hub stream that replaces the
//! `ENTITY_EVENTS` queue. Each message carries `Nats-Msg-Id` = the event id,
//! so a retried publish inside the stream's duplicate window is stored once
//! (EVT-002).

use std::time::Duration;

use async_nats::jetstream::{self, message::PublishMessage, stream};
use bytes::Bytes;
use weldsuite_ports::{BusMessage, EventBus, PortError};

/// The stream entity events go to unless configured otherwise.
pub const DEFAULT_ENTITY_EVENTS_STREAM: &str = "ENTITY_EVENTS";

/// How to reach NATS.
#[derive(Clone, Default)]
pub struct NatsOptions {
    /// `nats://host:4222` (`tls://` for TLS); several, comma-separated.
    pub url: String,
    /// User and password, when the server requires them.
    pub user: Option<(String, String)>,
    /// An auth token, when the server requires one.
    pub token: Option<String>,
    /// The connection name the server shows in its monitoring.
    pub name: Option<String>,
}

impl std::fmt::Debug for NatsOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NatsOptions")
            .field("url", &self.url)
            .field("user", &self.user.as_ref().map(|(user, _)| user))
            .field("token", &self.token.as_ref().map(|_| "…"))
            .field("name", &self.name)
            .finish()
    }
}

/// [`EventBus`] on `JetStream`. `publish` returns once the stream has stored
/// the message (the publish ack).
#[derive(Clone)]
pub struct JetStreamEventBus {
    context: jetstream::Context,
}

impl JetStreamEventBus {
    /// Connects to NATS. The first connection must succeed; afterwards the
    /// client reconnects on its own.
    pub async fn connect(options: &NatsOptions) -> Result<Self, PortError> {
        let mut connect = match (&options.user, &options.token) {
            (Some((user, password)), _) => {
                async_nats::ConnectOptions::with_user_and_password(user.clone(), password.clone())
            }
            (None, Some(token)) => async_nats::ConnectOptions::with_token(token.clone()),
            (None, None) => async_nats::ConnectOptions::new(),
        }
        .connection_timeout(Duration::from_secs(5));
        if let Some(name) = &options.name {
            connect = connect.name(name);
        }
        let servers: Vec<&str> = options.url.split(',').map(str::trim).collect();
        let client = connect
            .connect(servers.as_slice())
            .await
            .map_err(PortError::backend)?;
        Ok(Self::new(jetstream::new(client)))
    }

    pub fn new(context: jetstream::Context) -> Self {
        Self { context }
    }

    /// Creates the stream when it does not exist yet; an existing stream is
    /// left as it is. For local and self-hosted installs that do not provision
    /// streams separately.
    pub async fn ensure_stream(&self, config: stream::Config) -> Result<(), PortError> {
        self.context
            .get_or_create_stream(config)
            .await
            .map(|_| ())
            .map_err(PortError::backend)
    }

    pub fn context(&self) -> &jetstream::Context {
        &self.context
    }

    /// Whether the client is connected to a server right now (readiness).
    pub fn is_connected(&self) -> bool {
        self.context.client().connection_state() == async_nats::connection::State::Connected
    }
}

/// The hub stream: every subject under `subject_prefix`, kept on disk for
/// seven days, deduplicated on the event id for two minutes.
pub fn entity_events_stream_config(name: &str, subject_prefix: &str) -> stream::Config {
    stream::Config {
        name: name.to_owned(),
        subjects: vec![format!("{subject_prefix}.>")],
        storage: stream::StorageType::File,
        max_age: Duration::from_hours(7 * 24),
        duplicate_window: Duration::from_secs(120),
        ..stream::Config::default()
    }
}

impl EventBus for JetStreamEventBus {
    async fn publish(&self, message: BusMessage) -> Result<(), PortError> {
        let publish = PublishMessage::build()
            .payload(Bytes::from(message.payload))
            .message_id(&message.id);
        let ack = self
            .context
            .send_publish(message.subject, publish)
            .await
            .map_err(PortError::backend)?;
        ack.await.map(|_| ()).map_err(PortError::backend)
    }
}
