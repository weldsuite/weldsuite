//! Shifts, attendance, leave types, allowances and requests (`routes/weldhr/time.ts`, `services/weldhr/time.ts`).

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

/// `ensureDefaultLeaveTypes(db)`.
pub(crate) async fn ensure_default_leave_types(
    _db: &weldsuite_db::PgPool,
) -> Result<(), crate::HrError> {
    Ok(())
}
