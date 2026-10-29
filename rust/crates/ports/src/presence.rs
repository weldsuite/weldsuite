//! Live presence: who in a workspace has a connection open, as the realtime
//! hub knows it (`RealtimePublisher#getPresence`, the realtime-worker's
//! `GET /internal/presence`). The WebSocket gateway of the Kubernetes
//! editions answers it; conformance builds read the test's `REALTIME`
//! binding through the harness. Reach it through the request's
//! [`PresenceReader`] extension when there is one, else the app's.

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::{BoxFuture, PortError};

/// Reads live presence.
pub trait DynPresence: Send + Sync {
    /// `userId → LivePresence` (`online`, `away`, `busy`) for the members
    /// with a connection open, of `user_ids` (all when empty). An error
    /// means "unknown", not "nobody is connected".
    fn presence<'a>(
        &'a self,
        workspace_id: &'a str,
        user_ids: &'a [String],
    ) -> BoxFuture<'a, Result<Map<String, Value>, PortError>>;
}

/// The presence source a request reads.
#[derive(Clone)]
pub struct PresenceReader(pub Arc<dyn DynPresence>);

impl std::fmt::Debug for PresenceReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PresenceReader")
    }
}
