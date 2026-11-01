//! Who is asking, in which workspace, and which bindings the request uses:
//! the request's own (conformance builds insert the test's env, master
//! database, KV, buckets, transport and ledgers) ahead of the app's.

use std::sync::Arc;

use axum::extract::FromRequestParts;
use http::request::Parts;
use serde_json::Value;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_db::{MasterDb, PgPool, Tenant};
use weldsuite_events::{EventContext, publish_entity_event};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_mail_domain::outbound::{OutboundBindings, OutboundGuard, RequestOutbound};
use weldsuite_permissions::Permissions;
use weldsuite_ports::{DynCache, FileStores, OutboundHttp, RequestCache, StorageBuckets};

use crate::MailState;

/// The request's view of the worker: its env and bindings, the app's where
/// the request brings none. Also usable outside `/api` ([`Bindings`]).
#[derive(Clone, Default)]
pub(crate) struct Bindings {
    pub(crate) env: Option<RequestEnv>,
    master: Option<PgPool>,
    cache: Option<Arc<dyn DynCache>>,
    outbound: Option<OutboundBindings>,
    files: Option<FileStores>,
    http: Option<OutboundHttp>,
    buckets: Option<StorageBuckets>,
    scheduled: Option<crate::scheduled::RequestScheduledRuns>,
}

impl Bindings {
    pub(crate) fn from_parts(parts: &Parts) -> Self {
        Self {
            env: parts.extensions.get::<RequestEnv>().cloned(),
            master: parts.extensions.get::<MasterDb>().map(|m| m.0.clone()),
            cache: parts
                .extensions
                .get::<RequestCache>()
                .map(|c| Arc::clone(&c.0)),
            outbound: parts
                .extensions
                .get::<RequestOutbound>()
                .map(|o| o.0.clone()),
            files: parts.extensions.get::<FileStores>().cloned(),
            http: parts.extensions.get::<OutboundHttp>().cloned(),
            buckets: parts.extensions.get::<StorageBuckets>().cloned(),
            scheduled: parts
                .extensions
                .get::<crate::scheduled::RequestScheduledRuns>()
                .cloned(),
        }
    }

    /// An env value: the request's (conformance), else the app's.
    pub(crate) fn env_value<'a>(&'a self, state: &'a MailState, name: &str) -> Option<&'a str> {
        match &self.env {
            Some(env) => env.get(name),
            None => state.env.get(name).map(String::as_str),
        }
    }

    /// The master database: the request's in conformance builds (only what
    /// the test shares), else the app's.
    pub(crate) fn master(&self, state: &MailState) -> Option<PgPool> {
        if self.env.is_some() {
            return self.master.clone();
        }
        self.master.clone().or_else(|| state.master.clone())
    }

    pub(crate) fn cache(&self, state: &MailState) -> Option<Arc<dyn DynCache>> {
        self.cache.clone().or_else(|| state.cache.clone())
    }

    pub(crate) fn outbound(&self, state: &MailState) -> OutboundBindings {
        self.outbound
            .clone()
            .unwrap_or_else(|| state.outbound.clone())
    }

    /// Third-party HTTP (Expo push): the request's bridge in conformance
    /// builds, else the app's.
    pub(crate) fn http(&self, state: &MailState) -> Option<OutboundHttp> {
        if self.env.is_some() {
            return self.http.clone();
        }
        self.http.clone().or_else(|| state.http.clone())
    }

    /// `env.PRIVATE_STORAGE` / `env.STORAGE`, each optional: only the buckets
    /// a conformance test shares, else the app's.
    pub(crate) fn buckets(&self, state: &MailState) -> StorageBuckets {
        if self.env.is_some() {
            return self.buckets.clone().unwrap_or_default();
        }
        self.buckets
            .clone()
            .or_else(|| state.files.clone().map(Into::into))
            .unwrap_or_default()
    }

    /// The `SEND_SCHEDULED_EMAIL` binding: the test's in conformance builds
    /// (or none), else delayed jobs on the deployment's jobs port.
    pub(crate) fn scheduled_runs(
        &self,
        state: &MailState,
    ) -> Option<Arc<dyn crate::scheduled::ScheduledRuns>> {
        if let Some(runs) = &self.scheduled {
            return runs.0.clone();
        }
        if self.env.is_some() {
            return None;
        }
        state.jobs.clone().map(|jobs| {
            Arc::new(crate::scheduled::JobsScheduledRuns { jobs })
                as Arc<dyn crate::scheduled::ScheduledRuns>
        })
    }

    pub(crate) fn files(&self, state: &MailState) -> Option<FileStores> {
        self.files.clone().or_else(|| state.files.clone())
    }

    /// The outbound guard as the worker builds it from its env: the master
    /// database only when the worker has one (`DATABASE_URL_MASTER`; a test
    /// that sets none gets the guard's fail-open answers, as in TypeScript).
    pub(crate) fn guard(&self, state: &MailState) -> OutboundGuard {
        let master = match &self.env {
            Some(env) => env
                .get("DATABASE_URL_MASTER")
                .and_then(|_| self.master(state)),
            None => self.master(state),
        };
        self.outbound(state).guard(master, self.cache(state))
    }
}

/// A caller of an `/api` route.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('orgId')`.
    pub(crate) org_id: Option<String>,
    /// `c.get('workspaceId')`: `workspaces.id`.
    pub(crate) workspace_id: String,
    pub(crate) events: EventContext,
    pub(crate) bindings: Bindings,
    /// The permissions `requirePermission` resolved for the request.
    pub(crate) permissions: Option<Permissions>,
}

impl Caller {
    /// `c.get('orgId')`, or `error.orgRequired`.
    pub(crate) fn org(&self) -> Result<&str, ApiError> {
        self.org_id
            .as_deref()
            .filter(|org| !org.is_empty())
            .ok_or_else(ApiError::org_required)
    }

    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions
            .as_ref()
            .is_some_and(|permissions| permissions.has_any(&[key]))
    }

    /// `publishEntityEvent({ c, entityType, action, entityId, data })`.
    pub(crate) fn publish(
        &self,
        state: &MailState,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(&state.events, &self.events, event, entity_id, data);
    }
}

/// Behind the session and tenant database layers; without them it is a
/// routing mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let auth = parts.extensions.get::<AuthContext>();
        let tenant = parts.extensions.get::<Tenant>();
        let caller = if let (Some(auth), Some(tenant)) = (auth, tenant) {
            Ok(Self {
                db: tenant.db.clone(),
                user_id: auth.user_id.clone(),
                org_id: auth.org_id.clone(),
                workspace_id: tenant.workspace_id.clone(),
                events: EventContext::for_request(auth, tenant),
                bindings: Bindings::from_parts(parts),
                permissions: parts.extensions.get::<Permissions>().cloned(),
            })
        } else {
            tracing::error!("mail: a route without the session or tenant layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

/// The bindings of a request outside `/api` (no session).
pub(crate) struct Outside(pub(crate) Bindings);

impl<S: Send + Sync> FromRequestParts<S> for Outside {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(Ok(Self(Bindings::from_parts(parts))))
    }
}
