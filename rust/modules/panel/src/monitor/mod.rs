//! WeldPanel's monitoring and data out: alerts, scheduled reports
//! (subscriptions), raw exports to the customer's S3-compatible bucket and
//! custom collector domains (panel-api's `routes/alerts`, `subscriptions`,
//! `exports`, `domains` and the services behind them), and the cron that
//! runs what is due ([`scheduled`], `weldsuite cron panel-schedule`, panel-api's
//! `scheduled.ts`).
//!
//! Every create, update and delete of an alert, subscription or export also
//! writes its row in the master `panel_schedule_registry` (ADR PANEL-010);
//! the cron reads only that table to find what is due and opens only those
//! workspaces' tenant databases (ADR DATA-008).
//!
//! What the worker's bindings are, and what they are here:
//!
//! - `SEND_EMAIL` (system mail): [`MonitorState::mail`], the `SystemMail`
//!   port (SMTP on Kubernetes), with `weldsuite-emails`' panel templates;
//! - `fetch` to a Slack webhook or the customer's store: [`MonitorState::http`],
//!   a client that connects to public addresses only (conformance: the
//!   request's outbound bridge);
//! - Cloudflare custom hostnames: [`CollectorDomains`] ([`domains`]);
//! - `DATABASE_ENCRYPTION_KEY(_V2)`: the sealed Slack URL and S3 key
//!   ([`secrets`]).

// A refusal is the ready response the worker answers, as in the other panel routes.
#![allow(clippy::result_large_err)]

mod alerts;
mod anomaly;
mod delivery;
pub mod domains;
mod exports;
mod s3;
mod schedule;
pub mod scheduled;
mod schemas;
mod secrets;
mod subscriptions;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use axum::Router;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use serde_json::Value;
use weldsuite_catalogs::permission_keys::{
    PANEL_PROJECTS_MANAGE, PANEL_REPORTS_CREATE, PANEL_REPORTS_DELETE, PANEL_REPORTS_READ,
    PANEL_REPORTS_UPDATE,
};
use weldsuite_db::{Keyring, PgPool};
use weldsuite_kit::ApiError;
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::schemas::PanelQuerySpec;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{BoxFuture, DynSystemMail, OutboundHttp};

pub use domains::{CloudflareDomains, CollectorDomains, DomainError, HostnameState};
pub use schedule::{ScheduleRow, claim_due, release_schedule};

use self::alerts::CheckPorts;
use self::delivery::{Delivered, Delivery, Message, Stored, Target};
use crate::query::{QueryDeps, QueryFailure, run_cached_query};
use crate::{Caller, PanelState, unexpected};

/// What the monitoring routes share, besides [`PanelState`].
#[derive(Clone)]
pub struct MonitorState {
    pub panel: PanelState,
    /// System mail (`SEND_EMAIL`); `None` answers "Email is not configured here".
    pub mail: Option<Arc<dyn DynSystemMail>>,
    /// Slack webhooks and the customers' stores: public addresses only.
    /// Conformance builds use the request's outbound bridge.
    pub http: Option<OutboundHttp>,
    /// Who serves custom collector domains; `None` answers 503 as Global
    /// without Cloudflare custom hostnames. Conformance builds use Cloudflare with
    /// the test's settings, through the bridge.
    pub domains: Option<Arc<dyn CollectorDomains>>,
}

impl std::fmt::Debug for MonitorState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MonitorState")
            .field("panel", &self.panel)
            .field("mail", &self.mail.is_some())
            .field("http", &self.http.is_some())
            .field("domains", &self.domains.is_some())
            .finish()
    }
}

/// `getMasterDb(c.env)`.
fn master_of(caller: &Caller, state: &MonitorState) -> Option<PgPool> {
    caller.master(&state.panel)
}

/// The request's clock (the test's when it fakes one), else the real one.
fn now_of(caller: &Caller) -> i64 {
    caller.now().unwrap_or_else(js::now_millis)
}

/// `keyringFromEnv(c.env)`.
fn keyring_of(caller: &Caller) -> Keyring {
    secrets::keyring(|name| caller.env(name))
}

/// `SecretsUnavailableError` → 503; anything else → 500 (boxed for `map_err`).
#[allow(clippy::unnecessary_box_returns)]
fn store_failure(error: secrets::SecretError) -> Box<Response> {
    Box::new(match error {
        secrets::SecretError::Unavailable => {
            ApiError::unavailable(secrets::UNAVAILABLE).into_response()
        }
        secrets::SecretError::Failed(error) => unexpected(&error, "seal a secret"),
    })
}

/// `channelsFor(c, input, existing)`: the channels as stored, or the
/// refusal (a non-member recipient, a missing channel, no key to seal with).
async fn channels_for(
    caller: &Caller,
    input: &Value,
    existing: Option<&Stored>,
) -> Result<Stored, Box<Response>> {
    match delivery::channels_problem(&caller.db, input).await {
        Ok(Some(problem)) => return Err(Box::new(ApiError::bad_request(problem).into_response())),
        Ok(None) => {}
        Err(error) => return Err(Box::new(unexpected(&error, "check channels"))),
    }
    delivery::store_channels(&keyring_of(caller), input, existing).map_err(store_failure)
}

/// The delivery context of a request, for `actor`.
fn delivery_for(caller: &Caller, state: &MonitorState, actor: &str) -> Delivery {
    Delivery {
        db: caller.db.clone(),
        clerk_org_id: caller
            .clerk_org_id
            .clone()
            .unwrap_or_else(|| caller.workspace_id.clone()),
        actor_user_id: actor.to_owned(),
        platform_url: caller.env("PLATFORM_URL"),
        keyring: keyring_of(caller),
        mail: state.mail.clone(),
        http: if caller.conformance() {
            caller.outbound.clone()
        } else {
            state.http.clone()
        },
        realtime: state.panel.realtime.clone(),
        events: state.panel.events.clone(),
        senders: None,
    }
}

/// `QueryFailure` as the message an alert or report records.
fn failure_text(failure: QueryFailure) -> String {
    match failure {
        QueryFailure::Query(message) | QueryFailure::Upstream(message) => message,
        QueryFailure::Unavailable => "Analytics queries are not configured here".to_owned(),
    }
}

/// `runCachedQuery(deps, spec)` of a parsed spec: `{ kind, result }`.
async fn run_spec(deps: &QueryDeps, spec: Value) -> Result<Value, String> {
    let typed: PanelQuerySpec =
        serde_json::from_value(spec.clone()).map_err(|error| error.to_string())?;
    run_cached_query(deps, &spec, &typed)
        .await
        .map(|entry| entry.result)
        .map_err(failure_text)
}

/// A request's query, delivery and events (`send-now`).
struct RequestPorts<'a> {
    caller: &'a Caller,
    state: &'a MonitorState,
    delivery: Delivery,
}

impl CheckPorts for RequestPorts<'_> {
    fn run(&self, spec: Value) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(async move {
            let deps = QueryDeps::new(self.caller, &self.state.panel);
            run_spec(&deps, spec).await
        })
    }

    fn deliver<'a>(
        &'a self,
        target: &'a Target,
        message: &'a Message,
    ) -> BoxFuture<'a, Vec<Delivered>> {
        Box::pin(delivery::deliver(&self.delivery, target, message))
    }

    fn publish<'a>(&'a self, _alert: &'a Value, _action: &'static str) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}

/// `/api/panel/alerts`: `panel_reports:*`, changing someone else's alert
/// also `panel_projects:manage`.
pub fn alerts_router<S, Q>(state: MonitorState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([PANEL_REPORTS_READ]);
    let update = || gate.require([PANEL_REPORTS_UPDATE]);
    Router::new()
        .route("/", get(alerts::list).route_layer(read()))
        .route(
            "/",
            post(alerts::create).route_layer(gate.require([PANEL_REPORTS_CREATE])),
        )
        .route("/{id}", get(alerts::detail).route_layer(read()))
        .route("/{id}", patch(alerts::update).route_layer(update()))
        .route(
            "/{id}",
            delete(alerts::remove).route_layer(gate.require([PANEL_REPORTS_DELETE])),
        )
        .route("/{id}/events", get(alerts::events).route_layer(read()))
        .route("/{id}/test", post(alerts::test).route_layer(update()))
        .route("/{id}/snooze", post(alerts::snooze).route_layer(update()))
        .with_state(state)
}

/// `/api/panel/subscriptions`: as alerts.
pub fn subscriptions_router<S, Q>(state: MonitorState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([PANEL_REPORTS_READ]);
    let update = || gate.require([PANEL_REPORTS_UPDATE]);
    Router::new()
        .route("/", get(subscriptions::list).route_layer(read()))
        .route(
            "/",
            post(subscriptions::create).route_layer(gate.require([PANEL_REPORTS_CREATE])),
        )
        .route("/{id}", get(subscriptions::detail).route_layer(read()))
        .route("/{id}", patch(subscriptions::update).route_layer(update()))
        .route(
            "/{id}",
            delete(subscriptions::remove).route_layer(gate.require([PANEL_REPORTS_DELETE])),
        )
        .route(
            "/{id}/send-now",
            post(subscriptions::send_now).route_layer(update()),
        )
        .with_state(state)
}

/// `/api/panel/exports`: `panel_projects:manage`.
pub fn exports_router<S, Q>(state: MonitorState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let manage = || gate.require([PANEL_PROJECTS_MANAGE]);
    Router::new()
        .route(
            "/",
            get(exports::list)
                .post(exports::create)
                .route_layer(manage()),
        )
        .route("/test", post(exports::test).route_layer(manage()))
        .route(
            "/{id}",
            get(exports::detail)
                .patch(exports::update)
                .delete(exports::remove)
                .route_layer(manage()),
        )
        .route("/{id}/runs", get(exports::runs).route_layer(manage()))
        .route("/{id}/pause", post(exports::pause).route_layer(manage()))
        .route("/{id}/resume", post(exports::resume).route_layer(manage()))
        .with_state(state)
}

/// `/api/panel/projects/:id/domains`, relative to `/api/panel/projects`, to
/// merge into [`crate::router`]: `panel_projects:manage`.
pub fn domains_router<S, Q>(state: MonitorState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let manage = || gate.require([PANEL_PROJECTS_MANAGE]);
    Router::new()
        .route(
            "/{id}/domains",
            get(domains::list)
                .post(domains::create)
                .route_layer(manage()),
        )
        .route(
            "/{id}/domains/{domain_id}/refresh",
            post(domains::refresh).route_layer(manage()),
        )
        .route(
            "/{id}/domains/{domain_id}",
            delete(domains::remove).route_layer(manage()),
        )
        .with_state(state)
}
