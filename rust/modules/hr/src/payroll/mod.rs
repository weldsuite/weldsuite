//! WeldHR payroll (`routes/weldhr/payroll`, `services/weldhr/payroll`), behind the
//! `weldhr-payroll` flag, and the payroll routes of My HR (`payroll/self-service.ts`).

use std::sync::Arc;

use axum::Router;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::HrState;

/// `/api/weldhr/payroll`.
pub(crate) fn routes<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
}

/// The payroll routes of My HR, relative to `/api/weldhr/me`.
pub(crate) fn me_routes<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
}
