//! Coaching, evaluation forms, evaluations, KPI definitions, KPI values and
//! milestones (`routes/weldhr/performance.ts`, `services/weldhr/performance.ts`).

use std::sync::Arc;

use axum::Router;
use serde_json::json;
use weldsuite_db::PgPool;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{HrError, HrState};

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
}

/// `ensureDefaultEvaluationForm(db)`: the starter scorecard.
pub(crate) async fn ensure_default_evaluation_form(db: &PgPool) -> Result<(), HrError> {
    let existing: Option<String> = sqlx::query_scalar("select id from hr_evaluation_forms limit 1")
        .fetch_optional(db)
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    let criteria = json!([
        { "id": "quality", "label": "Quality of work", "weight": 30, "maxScore": 5 },
        { "id": "productivity", "label": "Productivity", "weight": 25, "maxScore": 5 },
        { "id": "communication", "label": "Communication", "weight": 20, "maxScore": 5 },
        { "id": "reliability", "label": "Attendance and reliability", "weight": 15, "maxScore": 5 },
        { "id": "teamwork", "label": "Teamwork", "weight": 10, "maxScore": 5 },
    ]);
    sqlx::query(
        "insert into hr_evaluation_forms (id, name, description, criteria)
         values ('hrevf_default_scorecard', 'Quality scorecard', 'Monthly quality and performance review.', $1)
         on conflict do nothing",
    )
    .bind(criteria)
    .execute(db)
    .await?;
    Ok(())
}

/// `ensureDefaultKpis(db)`: the starter KPI definitions.
pub(crate) async fn ensure_default_kpis(db: &PgPool) -> Result<(), HrError> {
    let existing: Option<String> = sqlx::query_scalar("select id from hr_kpi_definitions limit 1")
        .fetch_optional(db)
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    sqlx::query(
        "insert into hr_kpi_definitions (id, name, unit, direction, target, description) values
             ('hrkpi_default_csat', 'CSAT', 'percent', 'higher_better', 90, 'Customer satisfaction score'),
             ('hrkpi_default_quality', 'Quality score', 'percent', 'higher_better', 85, null),
             ('hrkpi_default_aht', 'Average handle time', 'seconds', 'lower_better', 360, null),
             ('hrkpi_default_fcr', 'First contact resolution', 'percent', 'higher_better', 75, null)
         on conflict do nothing",
    )
    .execute(db)
    .await?;
    Ok(())
}
