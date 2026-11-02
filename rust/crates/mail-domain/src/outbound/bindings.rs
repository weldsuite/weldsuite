//! The bindings a send path reaches the outside through: the transport and
//! the ledgers. A module keeps the deployment's in its state; a request may
//! carry its own ([`RequestOutbound`]), which wins: conformance builds insert
//! the test's (its `SEND_EMAIL` stub and `OUTBOUND_LEDGER` namespace through
//! the harness's bridges, or none when the test has none, as the worker
//! then runs without them).

use std::sync::Arc;

use weldsuite_db::PgPool;
use weldsuite_ports::{DynCache, MailTransport};

use super::guard::{Backstop, OutboundGuard};
use super::ledger::{OutboundLedger, PlatformBudget};

/// `SEND_EMAIL`, `OUTBOUND_LEDGER`, `OUTBOUND_PLATFORM` and
/// `OUTBOUND_BACKSTOP`, each optional as in a worker's env.
#[derive(Clone, Default)]
pub struct OutboundBindings {
    pub transport: Option<Arc<dyn MailTransport>>,
    pub ledger: Option<Arc<dyn OutboundLedger>>,
    pub platform: Option<Arc<dyn PlatformBudget>>,
    pub backstop: Option<Arc<dyn Backstop>>,
}

impl std::fmt::Debug for OutboundBindings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutboundBindings")
            .field("transport", &self.transport.is_some())
            .field("ledger", &self.ledger.is_some())
            .field("platform", &self.platform.is_some())
            .field("backstop", &self.backstop.is_some())
            .finish()
    }
}

impl OutboundBindings {
    /// The guard over these bindings, the master database (sender ownership)
    /// and the ownership cache.
    pub fn guard(&self, master: Option<PgPool>, cache: Option<Arc<dyn DynCache>>) -> OutboundGuard {
        OutboundGuard {
            ledger: self.ledger.clone(),
            platform: self.platform.clone(),
            backstop: self.backstop.clone(),
            master,
            cache,
        }
    }
}

/// A request's own bindings, ahead of the module's (a request extension).
#[derive(Clone, Debug, Default)]
pub struct RequestOutbound(pub OutboundBindings);
