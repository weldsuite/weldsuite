//! Plan limits (`@weldsuite/core-domain/plan-limits`): what a workspace's
//! plan allows, read from a small table per feature instead of one meter per
//! feature. A module keeps a table from plan slug to limit (`None` =
//! unlimited) and asks [`plan_limit`]; WeldForms' is its monthly response
//! quota.

use serde_json::Value;
use sqlx::PgPool;
use time::{Date, Month, OffsetDateTime, Time};

/// The plan a workspace is on (`WorkspacePlan`).
#[derive(Debug, Clone, PartialEq)]
pub struct WorkspacePlan {
    /// `plans.id`; `None` for a workspace on no plan at all.
    pub id: Option<String>,
    /// `plans.slug` (`free`, `starter`, …); `None` without a plan.
    pub slug: Option<String>,
    pub name: String,
    pub features: Value,
    /// Charges a price (monthly or per user): paid plans are never held to
    /// the free tier's numbers.
    pub paid: bool,
    /// The plan may switch off WeldSuite branding (`plans.remove_branding`).
    pub remove_branding: bool,
}

impl WorkspacePlan {
    /// `NO_PLAN`: no plan and no default plan.
    pub fn none() -> Self {
        Self {
            id: None,
            slug: None,
            name: "Free".to_owned(),
            features: Value::Object(serde_json::Map::new()),
            paid: false,
            remove_branding: false,
        }
    }
}

/// A module's limit per plan slug; `None` = unlimited.
pub type PlanLimitTable = [(&'static str, Option<i64>)];

type PlanRow = (
    String,
    String,
    String,
    Option<Value>,
    bool,
    bool,
    Option<bool>,
);

/// `price_monthly > 0 or price_per_user > 0`, as `Number(...) > 0` reads them.
const PLAN_COLUMNS: &str = "id, slug, name, features, \
     coalesce(price_monthly, 0) > 0 as paid_monthly, \
     coalesce(price_per_user, 0) > 0 as paid_per_user, \
     remove_branding";

fn to_plan(row: PlanRow) -> WorkspacePlan {
    let (id, slug, name, features, paid_monthly, paid_per_user, remove_branding) = row;
    WorkspacePlan {
        id: Some(id),
        slug: Some(slug),
        name,
        features: features.unwrap_or_else(|| Value::Object(serde_json::Map::new())),
        paid: paid_monthly || paid_per_user,
        remove_branding: remove_branding == Some(true),
    }
}

/// `loadWorkspacePlan(master, workspaceId)`: the plan a workspace
/// (`workspaces.id`) is on: its own, else the default plan, else none.
pub async fn load_workspace_plan(
    master: &PgPool,
    workspace_id: &str,
) -> Result<WorkspacePlan, sqlx::Error> {
    let plan_id: Option<Option<String>> =
        sqlx::query_scalar("select plan_id from workspaces where id = $1 limit 1")
            .bind(workspace_id)
            .fetch_optional(master)
            .await?;
    if let Some(plan_id) = plan_id.flatten() {
        let own: Option<PlanRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select {PLAN_COLUMNS} from plans where id = $1 limit 1"
        )))
        .bind(&plan_id)
        .fetch_optional(master)
        .await?;
        if let Some(own) = own {
            return Ok(to_plan(own));
        }
    }
    let fallback: Option<PlanRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {PLAN_COLUMNS} from plans where is_default = true limit 1"
    )))
    .fetch_optional(master)
    .await?;
    Ok(fallback.map_or_else(WorkspacePlan::none, to_plan))
}

/// `planLimit(table, plan)`: a slug in the table wins; a plan the table does
/// not list is unlimited when it is paid, and gets the `free` row otherwise.
pub fn plan_limit(table: &PlanLimitTable, plan: &WorkspacePlan) -> Option<i64> {
    let row = |slug: &str| table.iter().find(|(key, _)| *key == slug).map(|(_, v)| *v);
    if let Some(limit) = plan.slug.as_deref().and_then(row) {
        return limit;
    }
    if plan.paid {
        return None;
    }
    row("free").flatten()
}

/// `utcMonthRange(now)`: the UTC calendar month containing `now`, `[start, end)`.
pub fn utc_month_range(now: OffsetDateTime) -> (OffsetDateTime, OffsetDateTime) {
    let now = now.to_offset(time::UtcOffset::UTC);
    let first = |year: i32, month: Month| {
        Date::from_calendar_date(year, month, 1)
            .map_or(now, |date| date.with_time(Time::MIDNIGHT).assume_utc())
    };
    let start = first(now.year(), now.month());
    let (year, month) = match now.month() {
        Month::December => (now.year() + 1, Month::January),
        month => (now.year(), month.next()),
    };
    (start, first(year, month))
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUOTAS: &PlanLimitTable = &[
        ("free", Some(100)),
        ("starter", Some(1_000)),
        ("pro", Some(10_000)),
        ("business", None),
    ];

    fn plan(slug: Option<&str>, paid: bool) -> WorkspacePlan {
        WorkspacePlan {
            slug: slug.map(str::to_owned),
            paid,
            ..WorkspacePlan::none()
        }
    }

    #[test]
    fn limits_follow_plan_limit() {
        assert_eq!(plan_limit(QUOTAS, &plan(Some("pro"), true)), Some(10_000));
        assert_eq!(plan_limit(QUOTAS, &plan(Some("business"), true)), None);
        assert_eq!(plan_limit(QUOTAS, &plan(Some("custom"), true)), None);
        assert_eq!(plan_limit(QUOTAS, &plan(Some("custom"), false)), Some(100));
        assert_eq!(plan_limit(QUOTAS, &plan(None, false)), Some(100));
    }

    fn utc(year: i32, month: Month, day: u8, hour: u8) -> OffsetDateTime {
        Date::from_calendar_date(year, month, day)
            .expect("a date")
            .with_hms(hour, 0, 0)
            .expect("a time")
            .assume_utc()
    }

    #[test]
    fn month_ranges_are_utc_calendar_months() {
        let (start, end) = utc_month_range(utc(2026, Month::December, 15, 10));
        assert_eq!(start, utc(2026, Month::December, 1, 0));
        assert_eq!(end, utc(2027, Month::January, 1, 0));
    }
}
