//! `/api/team-members` (`app-api/src/routes/team-members`): the directory
//! and the managing routes, merged into one router.

mod directory;
mod manage;

use std::sync::Arc;

use axum::Router;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::CoreTeamState;

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    directory::router(gate).merge(manage::router(gate))
}
