//! Coaching, evaluation forms, evaluations, KPIs, KPI values and milestones (`routes/weldhr/performance.ts`, `services/weldhr/performance.ts`).

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

/// `ensureDefaultEvaluationForm(db)`.
pub(crate) async fn ensure_default_evaluation_form(
    _db: &weldsuite_db::PgPool,
) -> Result<(), crate::HrError> {
    Ok(())
}

/// `ensureDefaultKpis(db)`.
pub(crate) async fn ensure_default_kpis(_db: &weldsuite_db::PgPool) -> Result<(), crate::HrError> {
    Ok(())
}
