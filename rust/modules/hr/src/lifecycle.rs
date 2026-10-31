//! Checklist templates and on- and offboarding checklists (`routes/weldhr/lifecycle.ts`, `services/weldhr/lifecycle.ts`).

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

/// `ensureDefaultTemplates(db)`.
pub(crate) async fn ensure_default_templates(
    _db: &weldsuite_db::PgPool,
) -> Result<(), crate::HrError> {
    Ok(())
}
