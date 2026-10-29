//! `/api/auth-sessions` (`app-api/src/routes/auth-sessions`): signing the
//! caller's own devices out, for Settings → Security.
//!
//! - `POST /revoke-all`: every active session of the caller but the one
//!   making the request, answered with how many were and weren't revoked.
//! - `POST /:sessionId/revoke`: one session, after checking it is the
//!   caller's.
//!
//! No permission beyond being signed in (strictly self-scoped) and no entity
//! events. Sessions live at the identity provider: the
//! [`Identity`](weldsuite_ports::Identity) port's `sessions`, `session` and
//! `revoke_session`. A provider that can't be reached (or none, or one that
//! leaves sessions to its own console) answers as the workers do when
//! Clerk's `fetch` throws: a 500.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::json;
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{Identity, IdentityError, IdentityResult, Session};

use crate::{Caller, CorePlatformState};

pub(crate) fn router<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/revoke-all", post(revoke_all))
        .route("/{session_id}/revoke", post(revoke_one))
}

fn unreachable_provider() -> IdentityError {
    IdentityError::Unavailable("no identity provider is configured".to_owned())
}

/// `listActiveSessions`.
async fn active_sessions(
    idp: Option<&dyn Identity>,
    user_id: &str,
) -> IdentityResult<Vec<Session>> {
    match idp {
        Some(idp) => idp.sessions(user_id).await,
        None => Err(unreachable_provider()),
    }
}

/// `POST /revoke-all`.
async fn revoke_all(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    let idp = caller.identity(&state);
    let failed = || {
        ApiError::internal()
            .with_message("Failed to revoke sessions")
            .into_response()
    };
    let sessions = match active_sessions(idp.as_deref(), &caller.user_id).await {
        Ok(sessions) => sessions,
        Err(error) => {
            tracing::error!(%error, "auth-sessions: failed to revoke all sessions");
            return failed();
        }
    };
    let Some(idp) = idp else {
        return failed();
    };

    let mut revoked_count = 0_u32;
    let mut failed_count = 0_u32;
    for session in sessions.iter().filter(|s| s.id != caller.session_id) {
        match idp.revoke_session(&session.id).await {
            Ok(()) => revoked_count += 1,
            // The provider answered with an error status (`!resp.ok`).
            Err(IdentityError::Rejected { .. }) => failed_count += 1,
            // `fetch` threw: the whole request fails.
            Err(error) => {
                tracing::error!(%error, "auth-sessions: failed to revoke all sessions");
                return failed();
            }
        }
    }
    Data(json!({ "revokedCount": revoked_count, "failedCount": failed_count })).into_response()
}

/// `POST /:sessionId/revoke`.
async fn revoke_one(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(session_id): Path<String>,
) -> Response {
    let failed = || {
        ApiError::internal()
            .with_message("Failed to revoke session")
            .into_response()
    };
    let Some(idp) = caller.identity(&state) else {
        tracing::error!("auth-sessions: failed to revoke session: no identity provider");
        return failed();
    };

    // Ownership check: never revoke another user's session.
    let session = match idp.session(&session_id).await {
        Ok(session) => session,
        Err(IdentityError::Rejected { status: 404, .. }) => {
            return ApiError::not_found("Session", Some(&session_id)).into_response();
        }
        Err(IdentityError::Rejected { status, .. }) => {
            tracing::error!(status, "auth-sessions: session lookup refused");
            return ApiError::internal()
                .with_message("Failed to verify session")
                .into_response();
        }
        Err(error) => {
            tracing::error!(%error, "auth-sessions: failed to revoke session");
            return failed();
        }
    };
    if session.user_id != caller.user_id {
        return ApiError::forbidden()
            .with_message("You can only revoke your own sessions")
            .into_response();
    }

    match idp.revoke_session(&session_id).await {
        Ok(()) => Data(json!({ "revoked": true, "sessionId": session_id })).into_response(),
        Err(error) => {
            tracing::error!(%error, "auth-sessions: failed to revoke session");
            failed()
        }
    }
}
