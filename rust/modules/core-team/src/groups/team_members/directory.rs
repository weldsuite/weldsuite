//! The directory half of `/api/team-members`: `/me`, the list, one member, per-member permissions and apps, and `/user/:userId/*` (profile, notes, common, activity). Not ported yet.

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
