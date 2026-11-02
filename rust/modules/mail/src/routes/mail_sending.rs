//! `/api/mail-sending` (`routes/mail-sending/index.ts`): the workspace's own
//! view of its outbound sending limits (the WeldMail "Sending limits" card
//! and the restriction banner).
//!
//!   `GET /api/mail-sending/usage` → `{ data: OutboundUsage | null }`, null
//!   when the outbound guard isn't reachable in this deployment.

use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use weldsuite_catalogs::permission_keys::ACCOUNTS_READ;
use weldsuite_kit::{ApiError, Data};
use weldsuite_mail_domain::outbound::{SubjectInput, get_outbound_usage};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, MailState};

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/mail-sending/usage",
            get(usage).route_layer(gate.require([ACCOUNTS_READ])),
        )
        .with_state(state)
}

/// `GET /usage`.
async fn usage(State(state): State<MailState>, caller: Caller) -> Response {
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.into_response(),
    };
    let guard = caller.bindings.guard(&state);
    let subject = SubjectInput::Workspace {
        clerk_org_id: org,
        workspace_id: None,
    };
    match get_outbound_usage(&guard, &subject).await {
        Ok(usage) => Data(usage).into_response(),
        Err(error) => {
            tracing::error!(%error, "[mail-sending] usage failed");
            ApiError::internal()
                .with_message("Failed to load sending limits")
                .into_response()
        }
    }
}
