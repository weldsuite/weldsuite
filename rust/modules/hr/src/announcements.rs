//! HR announcements (`routes/weldhr/announcements.ts`, `services/weldhr/announcements.ts`, `announcement-push.ts`).

use std::sync::Arc;

use axum::Router;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::HrState;

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
}
