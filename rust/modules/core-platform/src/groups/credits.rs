//! `/api/credits` (`app-api/src/routes/credits`).

use std::sync::Arc;

use axum::Router;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::CorePlatformState;

pub(crate) fn router<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
}
