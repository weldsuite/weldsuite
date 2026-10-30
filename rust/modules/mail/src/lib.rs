//! WeldMail: mail-api's routes (`apps/workers/mail-api/src/index.ts`), its
//! jobs and its queue consumers, on the Kubernetes editions (ADR MAIL-010).
//!
//! One module per mail-api route group under [`routes`], each with a
//! `routes()` at its paths relative to `/api`, assembled by [`router`];
//! `/internal/outbound` (the outbound guard's staff API, a shared secret,
//! not a session) by [`internal_outbound_router`]. The README lists which
//! groups are ported; the shared mail logic is `weldsuite-mail-domain`.

#![allow(clippy::result_large_err)] // the handlers return the response a check ends with

mod caller;
pub mod consumers;
pub mod cron;
mod read_push;
pub mod scheduled;
mod routes;
pub mod send;
mod util;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use weldsuite_db::PgPool;
use weldsuite_events::EntityEventPublisher;
use weldsuite_mail_domain::outbound::OutboundBindings;
use weldsuite_mail_domain::recipients::DnsOverHttps;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynCache, DynJobs, DynSystemMail, FileStores, OutboundHttp};

pub(crate) use caller::Caller;

/// What the mail handlers share: the app's side of every binding a request
/// may override (conformance builds insert the test's).
#[derive(Clone)]
pub struct MailState {
    pub events: EntityEventPublisher,
    /// The master database (sender ownership, the outbound policies and
    /// cases, the workspace lookup).
    pub master: Option<PgPool>,
    /// `WORKSPACE_CACHE`: the sender-ownership and MX caches.
    pub cache: Option<Arc<dyn DynCache>>,
    /// Customer mail (`SEND_EMAIL`) and the outbound ledgers.
    pub outbound: OutboundBindings,
    /// `PRIVATE_STORAGE` and `STORAGE`: attachments.
    pub files: Option<FileStores>,
    /// Scheduled sends (`SEND_SCHEDULED_EMAIL`).
    pub jobs: Option<Arc<dyn DynJobs>>,
    /// System mail (`@weldsuite/emails`): the staff alerts.
    pub system_mail: Option<Arc<dyn DynSystemMail>>,
    /// Third-party HTTP: Expo push for the mobile read sync.
    pub http: Option<OutboundHttp>,
    /// DNS-over-HTTPS for the recipients' MX lookup.
    pub doh: Option<Arc<dyn DnsOverHttps>>,
    /// The worker's env values the routes read (`OUTBOUND_ADMIN_SECRET`,
    /// `ABUSE_NOTIFY_EMAIL`, …), from the process.
    pub env: Arc<HashMap<String, String>>,
}

impl std::fmt::Debug for MailState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailState")
            .field("master", &self.master.is_some())
            .field("outbound", &self.outbound)
            .finish_non_exhaustive()
    }
}

/// The env values mail-api's routes read, from the process environment.
pub fn env_from_process() -> HashMap<String, String> {
    [
        "OUTBOUND_ADMIN_SECRET",
        "ABUSE_NOTIFY_EMAIL",
        "ADMIN_CONSOLE_URL",
        "ENVIRONMENT",
        "R2_PUBLIC_URL",
        "WELDMAIL_DOMAIN",
    ]
    .into_iter()
    .filter_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| (name.to_owned(), value))
    })
    .collect()
}

/// mail-api's `/api` routes, at their paths relative to `/api`, behind the
/// session, tenant database, licence and flag layers. Each route carries
/// its `requirePermission` from `gate`.
pub fn router<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .merge(routes::mail_sending::routes(state.clone(), gate))
        .merge(routes::mail_accounts::routes(state.clone(), gate))
        .merge(routes::mail_folders::routes(state.clone(), gate))
        .merge(routes::mail_labels::routes(state.clone(), gate))
        .merge(routes::mail_signatures::routes(state.clone(), gate))
        .merge(routes::mail_attachments::routes(state.clone(), gate))
        .merge(routes::mail_drafts::routes(state.clone(), gate))
        .merge(routes::mail_snooze::routes(state.clone(), gate))
        .merge(routes::mail_threads::routes(state.clone(), gate))
        .merge(routes::mail_templates::routes(state.clone(), gate))
        .merge(routes::mail_rules::routes(state.clone(), gate))
        .merge(routes::mail_campaigns::routes(state.clone(), gate))
        .merge(routes::mail_sync::routes(state.clone(), gate))
        .merge(routes::mail_scheduled::routes(state.clone(), gate))
        .merge(routes::mail_messages::routes(state, gate))
}

/// `/internal/outbound`: the outbound guard's staff API for the admin
/// console (`OUTBOUND_ADMIN_SECRET`), outside the session layers. Relative
/// to its prefix.
pub fn internal_outbound_router<S>(state: MailState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    routes::internal_outbound::routes(state)
}
