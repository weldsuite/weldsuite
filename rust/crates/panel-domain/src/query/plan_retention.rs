//! How long a plan keeps events (`plan-retention.ts`).

use super::context::MAX_RETENTION_DAYS;

/// `eventRetentionDays`: 12 months on the free plan (no plan counts as
/// free), 25 months above.
pub fn event_retention_days(plan_slug: Option<&str>) -> i64 {
    match plan_slug {
        None | Some("" | "free") => 366,
        Some(_) => MAX_RETENTION_DAYS,
    }
}
