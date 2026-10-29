//! The managing half of `/api/team-members`, with the identity provider: `/sync`, `/invite`, `PATCH /:id`, `DELETE /:id`, `/:id/resend-invite`. Not ported yet.

use std::sync::Arc;

use axum::Router;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::CoreTeamState;

pub(crate) fn router<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
}
