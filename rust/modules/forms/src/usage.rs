//! The plan quota (`services/usage.ts`): completed responses per UTC
//! calendar month against what the workspace's plan allows, counted from
//! `form_responses.submitted_at`.

use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_core_domain::plan_limits::{
    PlanLimitTable, WorkspacePlan, load_workspace_plan, plan_limit, utc_month_range,
};
use weldsuite_db::orm;
use weldsuite_schema::tenant::form_responses;

use crate::common::{Ctx, FormsResult, iso};

/// `FORM_RESPONSE_QUOTAS`: completed responses per month by plan slug.
pub(crate) const FORM_RESPONSE_QUOTAS: &PlanLimitTable = &[
    ("free", Some(100)),
    ("starter", Some(1_000)),
    ("pro", Some(10_000)),
    ("business", None),
    ("enterprise", None),
];

/// `Usage`: `FormsUsage` and the plan it was read from.
#[derive(Debug, Clone)]
pub(crate) struct Usage {
    pub(crate) period_start: String,
    pub(crate) period_end: String,
    pub(crate) used: i64,
    pub(crate) limit: Option<i64>,
    pub(crate) workspace_plan: WorkspacePlan,
}

impl Usage {
    /// `FormsUsage` (without the plan row).
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "periodStart": self.period_start,
            "periodEnd": self.period_end,
            "used": self.used,
            "limit": self.limit,
            "plan": self.workspace_plan.slug,
        })
    }

    /// `overQuota(usage)`: a finite limit has been reached.
    pub(crate) fn over_quota(&self) -> bool {
        self.limit.is_some_and(|limit| self.used >= limit)
    }
}

fn at(ms: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

fn ms_of(at: OffsetDateTime) -> i64 {
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or_default()
}

/// `loadUsage(ctx, now)`.
pub(crate) async fn load_usage(ctx: &Ctx, now_ms: i64) -> FormsResult<Usage> {
    let (start, end) = utc_month_range(at(now_ms));
    let (start_ms, end_ms) = (ms_of(start), ms_of(end));
    let plan = load_workspace_plan(ctx.master()?, &ctx.workspace_id).await?;
    let used = form_responses::Entity::find()
        .filter(form_responses::Column::Status.eq("completed"))
        .filter(form_responses::Column::SubmittedAt.gte(at(start_ms)))
        .filter(form_responses::Column::SubmittedAt.lt(at(end_ms)))
        .count(&orm(&ctx.db))
        .await?;
    Ok(Usage {
        limit: plan_limit(FORM_RESPONSE_QUOTAS, &plan),
        period_start: iso(start_ms),
        period_end: iso(end_ms),
        used: i64::try_from(used).unwrap_or(i64::MAX),
        workspace_plan: plan,
    })
}
