//! Who and where an event comes from: what `publishEntityEvent` reads off
//! the Hono context (`c.get('clerkOrgId') ?? c.get('workspaceId')`,
//! `c.get('userId')`), or what `publishEntityEventRaw` takes as parameters.

use axum::extract::FromRequestParts;
use http::request::Parts;
use weldsuite_auth::AuthContext;
use weldsuite_db::Tenant;
use weldsuite_kit::ApiError;

use crate::envelope::EventSource;

/// The `metadata` an event is stamped with, apart from the time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventContext {
    /// The workspace id on the wire. Events keep the Clerk org id until their
    /// consumers move to `workspaces.id` (phase 2b of
    /// `docs/plans/workspace-id-standardization.md`); every consumer resolves
    /// either.
    pub workspace_id: String,
    /// The Clerk user id, or `system`.
    pub user_id: String,
    pub source: EventSource,
}

impl EventContext {
    /// A context for code without a request (`publishEntityEventRaw`, which
    /// defaults to [`EventSource::System`]).
    pub fn new(
        workspace_id: impl Into<String>,
        user_id: impl Into<String>,
        source: EventSource,
    ) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            user_id: user_id.into(),
            source,
        }
    }

    /// The context of a signed-in request: the Clerk org id when the
    /// workspace has one, else `workspaces.id`; source `api`.
    pub fn for_request(auth: &AuthContext, tenant: &Tenant) -> Self {
        Self::from_ids(
            &tenant.workspace_id,
            tenant.clerk_org_id.as_deref(),
            &auth.user_id,
        )
    }

    /// [`for_request`](Self::for_request) from plain ids.
    pub fn from_ids(workspace_id: &str, clerk_org_id: Option<&str>, user_id: &str) -> Self {
        Self::new(
            clerk_org_id.unwrap_or(workspace_id),
            user_id,
            EventSource::Api,
        )
    }

    #[must_use]
    pub fn with_source(mut self, source: EventSource) -> Self {
        self.source = source;
        self
    }
}

/// Handlers take [`EventContext`] as an argument behind the session and
/// `workspace_db` middleware; without them it is a routing mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for EventContext {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let auth = parts.extensions.get::<AuthContext>();
        let tenant = parts.extensions.get::<Tenant>();
        let context = if let (Some(auth), Some(tenant)) = (auth, tenant) {
            Ok(Self::for_request(auth, tenant))
        } else {
            tracing::error!(
                "events: EventContext extracted on a route without the session and workspace middleware"
            );
            Err(ApiError::internal())
        };
        std::future::ready(context)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_org_id_wins_over_the_workspace_id() {
        let with_org = EventContext::from_ids("ws_1", Some("org_1"), "user_1");
        assert_eq!(with_org.workspace_id, "org_1");
        assert_eq!(with_org.source, EventSource::Api);
        let without = EventContext::from_ids("ws_1", None, "user_1");
        assert_eq!(without.workspace_id, "ws_1");
    }
}
