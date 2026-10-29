//! `GET /api/me/permissions` (`app-api/src/routes/me/index.ts`): the caller's
//! effective permissions in this workspace, for clients that gate their UI.
//! Every member may read their own.

use axum::extract::State;
use serde_json::json;
use weldsuite_auth::AuthContext;
use weldsuite_db::{Tenant, TenantPermissionQueries};
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::resolve_effective_permissions;

use crate::server::{AppEnforcedOverride, AppState};

pub(crate) async fn permissions(
    State(state): State<AppState>,
    enforced: Option<axum::Extension<AppEnforcedOverride>>,
    auth: AuthContext,
    tenant: Tenant,
) -> Result<Data<serde_json::Value>, ApiError> {
    let app_enforced = enforced.map_or(state.permissions_app_enforce, |e| e.0.0);
    let queries = TenantPermissionQueries::new(tenant.db.clone());
    let resolved = resolve_effective_permissions(&queries, &auth.user_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "me: resolving permissions failed");
            ApiError::internal().with_message("Failed to fetch permissions")
        })?;
    Ok(Data(json!({
        "permissions": resolved.permissions,
        "denies": resolved.denies,
        "appEnforced": app_enforced,
        "role": resolved.role,
        "roleId": resolved.role_id,
        "isOwner": resolved.is_owner,
    })))
}
