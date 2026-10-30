//! The signed-in person behind an onboarding request, and the request's
//! overrides (conformance mode) of the state's ports.

use std::sync::Arc;

use axum::extract::FromRequestParts;
use http::request::Parts;
use weldsuite_auth::AuthContext;
use weldsuite_db::{MasterDb, PgPool, Tenant};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_ports::{Identity, IdentityProvider};

use crate::OnboardingState;

/// `c.get('userId')` and `c.get('orgId')` after `clerkMiddleware()`, with
/// what conformance mode puts on the request: the test's master and tenant
/// databases, its Clerk stub and its env.
pub struct OnboardingCaller {
    /// `None` for an empty user id (`!userId`).
    pub user_id: Option<String>,
    /// The session's active organization, if any.
    pub org_id: Option<String>,
    master: Option<PgPool>,
    tenant: Option<PgPool>,
    identity: Option<Arc<dyn Identity>>,
    env: Option<RequestEnv>,
}

impl OnboardingCaller {
    /// The master database.
    pub fn master(&self, state: &OnboardingState) -> PgPool {
        self.master.clone().unwrap_or_else(|| state.master.clone())
    }

    /// The identity provider, if any.
    pub fn identity(&self, state: &OnboardingState) -> Option<Arc<dyn Identity>> {
        self.identity.clone().or_else(|| state.identity.clone())
    }

    /// An env value: the request's (conformance mode), else the process's.
    pub fn setting(&self, name: &str) -> Option<String> {
        self.env
            .as_ref()
            .and_then(|env| env.get(name))
            .map(str::to_owned)
            .or_else(|| std::env::var(name).ok())
    }

    /// `getTenantDbForWorkspace(env, org)`.
    pub async fn tenant_db(&self, state: &OnboardingState, org: &str) -> Result<PgPool, String> {
        match &self.tenant {
            Some(db) => Ok(db.clone()),
            None => (state.tenants)(org.to_owned()).await,
        }
    }
}

impl<S: Send + Sync> FromRequestParts<S> for OnboardingCaller {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let caller = if let Some(auth) = parts.extensions.get::<AuthContext>() {
            Ok(Self {
                user_id: Some(auth.user_id.clone()).filter(|id| !id.is_empty()),
                org_id: auth.org_id.clone().filter(|id| !id.is_empty()),
                master: parts.extensions.get::<MasterDb>().map(|m| m.0.clone()),
                tenant: parts.extensions.get::<Tenant>().map(|t| t.db.clone()),
                identity: parts
                    .extensions
                    .get::<IdentityProvider>()
                    .map(|p| Arc::clone(&p.0)),
                env: parts.extensions.get::<RequestEnv>().cloned(),
            })
        } else {
            tracing::error!("onboarding: a route without the session layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}
