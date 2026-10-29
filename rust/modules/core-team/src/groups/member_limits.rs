//! `/api/member-limits` (`app-api/src/routes/member-limits`): the
//! workspace's member limit from its plan (or partner licence), the seats in
//! use, and whether it is full. Every member with `general:read` may read it.

use std::sync::Arc;

use axum::Router;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::groups::seats::workspace_seat_limit;
use crate::{Caller, CoreTeamState};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route("/", get(limits).route_layer(gate.require(["general:read"])))
}

/// `GET /`.
async fn limits(
    axum::extract::State(state): axum::extract::State<CoreTeamState>,
    caller: Caller,
) -> Response {
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    match workspace_seat_limit(&caller, &state, &org_id).await {
        Ok(Some(seats)) => Data(seats.to_json()).into_response(),
        Ok(None) => ApiError::not_found("Workspace", None).into_response(),
        Err(error) => {
            tracing::error!(%error, "member limits: failed to get member limits");
            ApiError::internal()
                .with_message("Failed to get member limits")
                .into_response()
        }
    }
}
