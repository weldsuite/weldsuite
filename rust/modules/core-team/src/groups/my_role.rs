//! `/api/my-role` (`app-api/src/routes/my-role`): the caller's workspace
//! role and whether it lets them manage members and roles. Ungated: every
//! member may read their own. The permissions are resolved from the member
//! row, as the route does, not taken from the request.

use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::json;
use weldsuite_db::TenantPermissionQueries;
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{
    PermissionGate, PermissionQueries, has_app_permission, resolve_effective_permissions,
};

use crate::{Caller, CoreTeamState};

pub(crate) fn router<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route("/", get(my_role))
}

/// `GET /`.
async fn my_role(State(_state): State<CoreTeamState>, caller: Caller) -> Response {
    if caller.org_id.is_none() {
        return ApiError::org_required().into_response();
    }
    let role: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
        "select role from workspace_members where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(&caller.user_id)
    .fetch_optional(&caller.db)
    .await;
    let role = match role {
        Ok(Some(role)) => role,
        Ok(None) => {
            return Data(
                json!({ "role": null, "canManageMembers": false, "canManageRoles": false }),
            )
            .into_response();
        }
        Err(error) => return failed(&error),
    };
    let role = Some(role.to_uppercase())
        .filter(|role| !role.is_empty())
        .unwrap_or_else(|| "MEMBER".to_owned());
    let queries = TenantPermissionQueries::new(caller.db.clone());
    match resolve_effective_permissions(&queries, &caller.user_id).await {
        Ok(resolved) => Data(json!({
            "role": role,
            "canManageMembers": has_app_permission(&resolved, "team:update", None),
            "canManageRoles": has_app_permission(&resolved, "roles:update", None),
        }))
        .into_response(),
        Err(error) => failed(&error),
    }
}

fn failed(error: &dyn std::fmt::Display) -> Response {
    tracing::error!(%error, "my role: failed to fetch my role");
    ApiError::internal()
        .with_message("Failed to fetch role")
        .into_response()
}
