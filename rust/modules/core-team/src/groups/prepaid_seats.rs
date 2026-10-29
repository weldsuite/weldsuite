//! `/api/prepaid-seats` (`app-api/src/routes/prepaid-seats`): the seats the
//! workspace has paid for (the plan's included users plus purchased seats,
//! or a partner licence's cap), the seats in use (members from the identity
//! provider plus pending seat invitations), what is left, and whether
//! another member fits. Every member with `general:read` may read it, as
//! for `/api/member-limits`.

use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Value, json};
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::groups::seats::{accurate_member_count, identity, pending_seat_invitations};
use crate::{Caller, CoreTeamState};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route(
        "/",
        get(prepaid).route_layer(gate.require(["general:read"])),
    )
}

/// `GET /`.
async fn prepaid(State(state): State<CoreTeamState>, caller: Caller) -> Response {
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    match prepaid_seats(&caller, &state, &org_id).await {
        Ok(Some(seats)) => Data(seats).into_response(),
        Ok(None) => ApiError::not_found("Workspace", None).into_response(),
        Err(error) => {
            tracing::error!(%error, "prepaid seats: failed to get prepaid seats");
            ApiError::internal()
                .with_message("Failed to get prepaid seats")
                .into_response()
        }
    }
}

/// `workspaces`: id, plan, purchased seats, billing mode.
type WorkspaceRow = (String, Option<String>, Option<i32>, String);

/// The body, or `None` when no workspace has the org.
async fn prepaid_seats(
    caller: &Caller,
    state: &CoreTeamState,
    org_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let master = caller.master(state);
    let workspace: Option<WorkspaceRow> = sqlx::query_as(
        "select id, plan_id, purchased_seats, billing_mode::text from workspaces
         where clerk_org_id = $1",
    )
    .bind(org_id)
    .fetch_optional(&master)
    .await?;
    let Some((workspace_id, plan_id, purchased_seats, billing_mode)) = workspace else {
        return Ok(None);
    };

    // A partner-managed workspace has no prepaid seats: its licence's cap is
    // the limit (none = unlimited).
    if billing_mode == "partner" {
        let licence: Option<Option<i32>> =
            sqlx::query_scalar("select max_seats from workspace_licences where workspace_id = $1")
                .bind(&workspace_id)
                .fetch_optional(&master)
                .await?;
        let used = used_seats(caller, state, org_id, &workspace_id).await?;
        let Some(max_seats) = licence.flatten().map(i64::from) else {
            return Ok(Some(json!({
                "prepaidSeats": used,
                "usedSeats": used,
                "availableSeats": 0,
                "canAddMore": true,
            })));
        };
        let available = (max_seats - used).max(0);
        return Ok(Some(json!({
            "prepaidSeats": max_seats,
            "usedSeats": used,
            "availableSeats": available,
            "canAddMore": available > 0,
        })));
    }

    let mut included_users = 1;
    if let Some(plan_id) = plan_id.filter(|id| !id.is_empty()) {
        let plan: Option<Option<i32>> =
            sqlx::query_scalar("select included_users from plans where id = $1")
                .bind(plan_id)
                .fetch_optional(&master)
                .await?;
        if let Some(included) = plan {
            included_users = i64::from(included.unwrap_or(1));
        }
    }
    let prepaid = included_users + i64::from(purchased_seats.unwrap_or(0));
    let used = used_seats(caller, state, org_id, &workspace_id).await?;
    let available = (prepaid - used).max(0);
    Ok(Some(json!({
        "prepaidSeats": prepaid,
        "usedSeats": used,
        "availableSeats": available,
        "canAddMore": available > 0,
    })))
}

/// Members plus pending invitations: the identity provider counts both
/// against its cap.
async fn used_seats(
    caller: &Caller,
    state: &CoreTeamState,
    org_id: &str,
    workspace_id: &str,
) -> Result<i64, sqlx::Error> {
    let idp = identity(caller, state);
    let members = accurate_member_count(caller, state, &*idp, org_id, workspace_id).await?;
    let pending = pending_seat_invitations(&*idp, org_id).await;
    Ok(members + pending.unwrap_or(0))
}
