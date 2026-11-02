//! The caller of a `/v1` request: the session a `wsk_` key or a `wsat_` app
//! token opens (`ApiKeySession` in `apps/workers/external-api/src/types.ts`),
//! the scope rule (`lib/scopes.ts`) and the extractor the routes read it with.

use axum::extract::{FromRequestParts, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use http::request::Parts;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use weldsuite_catalogs::entity_events::EventName;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_events::{EntityEventPublisher, EventContext, publish_entity_event};
use weldsuite_kit::ApiError;

/// Whose key it is: a member's own (`personal`), the workspace's
/// (`workspace`), or an installed app's token (`app`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyType {
    Personal,
    Workspace,
    App,
}

/// The validated session (`ApiKeySession`): what the key may do, in which
/// workspace, and the workspace's plan tier and restrictions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSession {
    /// The key's id (the token's id for an app token).
    pub key_id: String,
    pub key_type: KeyType,
    /// `workspaces.id`.
    pub workspace_id: String,
    /// The owner of a personal key; `None` for workspace keys and app tokens.
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    /// `free`, `business`, `scale` or `enterprise`.
    #[serde(default = "free_tier")]
    pub tier: String,
    /// The workspace's identity-provider organization id.
    #[serde(default)]
    pub clerk_org_id: Option<String>,
    /// Apps a partner-managed workspace is licensed for; `None` is unrestricted.
    #[serde(default)]
    pub licensed_apps: Option<Vec<String>>,
    #[serde(default)]
    pub read_only: bool,
    /// `partner_suspended`, `licence_inactive` or `database_move`.
    #[serde(default)]
    pub read_only_reason: Option<String>,
    /// An app token's app, by id and code, and the install it was minted for.
    #[serde(default)]
    pub app_id: Option<String>,
    #[serde(default)]
    pub app_code: Option<String>,
    #[serde(default)]
    pub install_id: Option<String>,
}

fn free_tier() -> String {
    "free".to_owned()
}

impl ApiSession {
    /// The actor of the request: the key's owner, else the key itself
    /// (`session.userId ?? session.keyId`), as entity events record it.
    pub fn actor(&self) -> &str {
        self.user_id.as_deref().unwrap_or(&self.key_id)
    }

    pub fn has_scope(&self, required: &str) -> bool {
        has_scope(&self.scopes, required)
    }
}

/// Scopes a key holds only when granted by name: neither `*` nor
/// `<namespace>:*` covers them (ADR API-011).
pub const NAMED_ONLY_SCOPES: [&str; 2] = ["mail_messages:send", "reach_inbox:reply"];

/// `hasScope(scopes, required)`: the scope itself, `*` (except a named-only
/// scope) or `<namespace>:*`.
pub fn has_scope<S: AsRef<str>>(scopes: &[S], required: &str) -> bool {
    let holds = |scope: &str| scopes.iter().any(|held| held.as_ref() == scope);
    if holds(required) {
        return true;
    }
    if NAMED_ONLY_SCOPES.contains(&required) {
        return false;
    }
    if holds("*") {
        return true;
    }
    let namespace = required.split(':').next().unwrap_or_default();
    !namespace.is_empty() && holds(&format!("{namespace}:*"))
}

/// `error.unauthorized(c, message)`.
pub(crate) fn unauthorized(message: &str) -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", message)
}

/// `error.forbidden(c, message)`.
pub(crate) fn forbidden(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "FORBIDDEN", message)
}

/// The error handler's answer to anything unexpected.
pub(crate) fn internal() -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR",
        "An internal server error occurred",
    )
}

/// `error.internal(c, message)`: a route's own 500.
pub(crate) fn internal_with(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", message)
}

/// `error.badRequest(c, message)`.
pub(crate) fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "BAD_REQUEST", message)
}

/// `error.notFound(c, resource, id)`.
pub(crate) fn not_found(resource: &str, id: &str) -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        format!("{resource} with ID '{id}' not found"),
    )
}

/// `error.notFound(c, resource)` without an id.
pub(crate) fn not_found_plain(resource: &str) -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        format!("{resource} not found"),
    )
}

/// `error.conflict(c, message)`.
pub(crate) fn conflict(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "CONFLICT", message)
}

/// A database failure as the error handler answers it: a moved workspace
/// database is a retryable 503, anything else the generic 500.
pub(crate) fn database_error(error: &sqlx::Error) -> ApiError {
    if weldsuite_db::pg_errors::classify_moved_database_error(error).is_some() {
        return ApiError::workspace_moving();
    }
    tracing::error!(%error, "external-api: unhandled database error");
    internal()
}

/// `requireScope(scope)` as a route layer: no session is 401, a key without
/// the scope 403 `Missing required scope: <scope>`.
pub(crate) async fn require_scope(
    State(scope): State<&'static str>,
    request: Request,
    next: Next,
) -> Response {
    match request.extensions().get::<ApiSession>() {
        None => unauthorized("Unauthorized").into_response(),
        Some(session) if !session.has_scope(scope) => {
            forbidden(format!("Missing required scope: {scope}")).into_response()
        }
        Some(_) => next.run(request).await,
    }
}

/// Who is asking: the key's session and the workspace's tenant database.
pub(crate) struct Key {
    pub(crate) session: ApiSession,
    pub(crate) db: PgPool,
    pub(crate) tenant: Tenant,
    pub(crate) events: EventContext,
}

impl Key {
    /// `publishEntityEvent({ c, entityType, action, entityId, data })`, as
    /// the key's actor.
    pub(crate) fn publish(
        &self,
        publisher: &EntityEventPublisher,
        event: EventName,
        entity_id: &str,
        data: &Value,
    ) {
        publish_entity_event(publisher, &self.events, event, entity_id, data);
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Key {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let session = parts.extensions.get::<ApiSession>().cloned();
        let tenant = parts.extensions.get::<Tenant>().cloned();
        let key = match (session, tenant) {
            (Some(session), Some(tenant)) => Ok(Self {
                events: EventContext::from_ids(
                    &tenant.workspace_id,
                    tenant.clerk_org_id.as_deref(),
                    session.actor(),
                ),
                db: tenant.db.clone(),
                tenant,
                session,
            }),
            (None, _) => Err(unauthorized("Unauthorized")),
            (Some(_), None) => {
                tracing::error!("external-api: a /v1 route without the tenant database");
                Err(internal())
            }
        };
        std::future::ready(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_follow_has_scope() {
        assert!(has_scope(&["crm:read"], "crm:read"));
        assert!(!has_scope(&["crm:read"], "crm:write"));
        assert!(has_scope(&["*"], "tickets:write"));
        assert!(has_scope(&["tickets:*"], "tickets:write"));
        assert!(!has_scope(&["tickets:*"], "people:read"));
        // Named-only scopes need their own grant.
        assert!(!has_scope(&["*"], "mail_messages:send"));
        assert!(!has_scope(&["mail_messages:*"], "mail_messages:send"));
        assert!(has_scope(&["mail_messages:send"], "mail_messages:send"));
        assert!(!has_scope::<&str>(&[], "people:read"));
    }

    #[test]
    fn sessions_read_the_typescript_shape() {
        let session: ApiSession = serde_json::from_value(serde_json::json!({
            "keyId": "key_test",
            "keyType": "workspace",
            "workspaceId": "ws_test",
            "userId": null,
            "scopes": ["*"],
            "tier": "enterprise",
            "databaseUrl": null,
            "licensedApps": null,
        }))
        .expect("session");
        assert_eq!(session.key_type, KeyType::Workspace);
        assert_eq!(session.actor(), "key_test");
        assert!(!session.read_only);
    }
}
