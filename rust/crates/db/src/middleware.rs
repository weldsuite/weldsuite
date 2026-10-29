//! `workspaceDbMiddleware`: the signed-in organization's tenant database on
//! the request.

use std::sync::Arc;

use axum::extract::{FromRequestParts, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use http::request::Parts;
use weldsuite_auth::AuthContext;
use weldsuite_kit::ApiError;

use crate::workspaces::{Tenant, WorkspaceError, Workspaces};

/// Middleware: `axum::middleware::from_fn_with_state(workspaces, workspace_db)`,
/// after the session middleware. Puts the [`Tenant`] in the request
/// extensions; answers 403 `ORG_REQUIRED` without an active organization and
/// 403 `WORKSPACE_SUSPENDED` for a workspace scheduled for deletion.
pub async fn workspace_db(
    State(workspaces): State<Arc<Workspaces>>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(org_id) = request
        .extensions()
        .get::<AuthContext>()
        .and_then(|auth| auth.org_id.clone())
    else {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            "ORG_REQUIRED",
            "This endpoint requires an active organization.",
        )
        .into_response();
    };

    let tenant = match workspaces.tenant(&org_id).await {
        Ok(tenant) => tenant,
        Err(error) => {
            if matches!(error, WorkspaceError::NotFound) {
                tracing::warn!(%error, "workspace: no workspace for the session's organization");
            } else {
                tracing::error!(%error, "workspace: resolving the tenant database failed");
            }
            return ApiError::internal().into_response();
        }
    };

    if tenant.suspended {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            "WORKSPACE_SUSPENDED",
            "This workspace has been suspended and is scheduled for deletion.",
        )
        .into_response();
    }

    request.extensions_mut().insert(tenant);
    next.run(request).await
}

/// Handlers take [`Tenant`] as an argument behind [`workspace_db`]; without
/// it there is none, which is a routing mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for Tenant {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(parts.extensions.get::<Self>().cloned().ok_or_else(|| {
            tracing::error!("workspace: Tenant extracted on a route without workspace_db");
            ApiError::internal()
        }))
    }
}
