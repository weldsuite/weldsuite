//! The integration workers on the Kubernetes editions:
//! `integration-webhook-worker` (third-party webhook receivers, the
//! integration Workflows) and `integration-sync-worker` (the scheduled
//! sweeps). Neither has an API module id: the receivers are public routes
//! that check their own credential (a provider's signature), mounted at the
//! worker's own paths (`/webhooks/...`) beside `/api`, and the sweeps are
//! `weldsuite cron <name>` jobs.
//!
//! Calls the workers make into other workers over service bindings
//! (`BOOKS_INTERNAL`) go through [`binding::ServiceBinding`]; the binary
//! answers them in process.
//!
//! What is here:
//! - `POST /webhooks/bank-feeds/:provider` (Plaid, Stripe Financial
//!   Connections; Ponto and Enable Banking have no webhooks) and the bank
//!   feed due sweep ([`bank_feeds`], [`bank_feed_due`]), with WeldBooks'
//!   internal bank-connection routes in process ([`books`]).

pub mod bank_feed_due;
pub mod bank_feeds;
pub mod binding;
pub mod books;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::FromRequestParts;
use http::request::Parts;
use weldsuite_db::{MasterDb, PgPool};
use weldsuite_events::EntityEventPublisher;
use weldsuite_kit::RequestEnv;
use weldsuite_ports::{DynCache, OutboundHttp, RequestCache};

pub use binding::{BindingRequest, BindingResponse, RequestBooksBinding, ServiceBinding};

/// The integration workers' handle on the app.
#[derive(Clone)]
pub struct IntegrationsState {
    pub events: EntityEventPublisher,
    /// The master database (`bank_feed_connection_index`). None in
    /// conformance builds, where the request's `MasterDb` is the test's.
    pub master: Option<PgPool>,
    /// The workspace cache (`WORKSPACE_CACHE`): Plaid's verification keys.
    /// Without one they are kept in this process.
    pub cache: Option<Arc<dyn DynCache>>,
    /// Third-party HTTP (Plaid's verification keys).
    pub http: Option<OutboundHttp>,
    /// The workers' settings by their binding name (`PLAID_*`,
    /// `STRIPE_FC_WEBHOOK_SECRET`, …), from the process environment. A
    /// request's `RequestEnv` (conformance) wins.
    pub env: Arc<HashMap<String, String>>,
    /// `BOOKS_INTERNAL`: WeldBooks' internal bank-connection routes. None
    /// while books is not served, as the worker without the binding.
    pub books: Option<Arc<dyn ServiceBinding>>,
}

impl std::fmt::Debug for IntegrationsState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IntegrationsState")
            .field("master", &self.master.is_some())
            .field("cache", &self.cache.is_some())
            .field("http", &self.http.is_some())
            .field("books", &self.books.is_some())
            .finish_non_exhaustive()
    }
}

/// The settings the integration workers read, by binding name: a name, or a
/// prefix ending in `_`.
pub const ENV_NAMES: &[&str] = &[
    "ENVIRONMENT",
    "PLAID_",
    "STRIPE_FC_",
    "PONTO_",
    "ENABLE_BANKING_",
    "BANK_FEED_PROVIDERS",
    "BANK_FEED_WEBHOOK_URL",
];

/// [`ENV_NAMES`] from the process environment.
pub fn env_from_process() -> HashMap<String, String> {
    std::env::vars()
        .filter(|(name, _)| {
            ENV_NAMES.iter().any(|wanted| {
                if wanted.ends_with('_') {
                    name.starts_with(wanted)
                } else {
                    name == wanted
                }
            })
        })
        .collect()
}

/// The public webhook receivers, at the worker's own paths.
pub fn public_router<S>(state: IntegrationsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    bank_feeds::router(state)
}

/// What a public route reads off its request: in conformance builds the
/// test's env, master database, KV namespace, HTTP client and bindings.
pub(crate) struct PublicCtx {
    pub(crate) env: Option<RequestEnv>,
    pub(crate) master: Option<PgPool>,
    pub(crate) cache: Option<Arc<dyn DynCache>>,
    pub(crate) http: Option<OutboundHttp>,
    pub(crate) books: Option<RequestBooksBinding>,
}

impl<S: Send + Sync> FromRequestParts<S> for PublicCtx {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let extensions = &parts.extensions;
        std::future::ready(Ok(Self {
            env: extensions.get::<RequestEnv>().cloned(),
            master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
            cache: extensions
                .get::<RequestCache>()
                .map(|cache| Arc::clone(&cache.0)),
            http: extensions.get::<OutboundHttp>().cloned(),
            books: extensions.get::<RequestBooksBinding>().cloned(),
        }))
    }
}

impl PublicCtx {
    /// A setting: the request's env (conformance), else the state's.
    pub(crate) fn env(&self, state: &IntegrationsState, name: &str) -> Option<String> {
        match &self.env {
            Some(env) => env.get(name).map(str::to_owned),
            None => state.env.get(name).cloned(),
        }
    }

    pub(crate) fn master(&self, state: &IntegrationsState) -> Option<PgPool> {
        if self.env.is_some() {
            self.master.clone()
        } else {
            state.master.clone()
        }
    }

    pub(crate) fn cache(&self, state: &IntegrationsState) -> Option<Arc<dyn DynCache>> {
        if self.env.is_some() {
            self.cache.clone()
        } else {
            state.cache.clone()
        }
    }

    pub(crate) fn http(&self, state: &IntegrationsState) -> Option<OutboundHttp> {
        self.http.clone().or_else(|| state.http.clone())
    }

    pub(crate) fn books(&self, state: &IntegrationsState) -> Option<Arc<dyn ServiceBinding>> {
        match &self.books {
            Some(binding) => binding.0.clone(),
            None => state.books.clone(),
        }
    }
}
