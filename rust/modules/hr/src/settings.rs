//! The My HR switches (`routes/weldhr/settings.ts`, `services/weldhr/settings.ts`).

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
