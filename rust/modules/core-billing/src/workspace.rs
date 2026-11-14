//! A workspace's billing state on `workspaces`: what every other reader of
//! the plan (seat check, limits, lock gate) reads too.

use serde_json::{Value, json};
use sqlx::FromRow;
use time::OffsetDateTime;
use weldsuite_db::PgPool;

use crate::period::{Cycle, iso, parse_iso};

/// The columns billing reads, timestamps as ISO text.
#[derive(Debug, Clone, FromRow)]
pub(crate) struct Workspace {
    pub(crate) id: String,
    pub(crate) clerk_org_id: Option<String>,
    pub(crate) name: String,
    pub(crate) plan_id: Option<String>,
    pub(crate) purchased_seats: i32,
    pub(crate) subscription_status: Option<String>,
    pub(crate) subscription_cycle: Option<String>,
    pub(crate) period_start: Option<String>,
    pub(crate) period_end: Option<String>,
    pub(crate) cancel_at_period_end: bool,
    pub(crate) billing_mode: String,
    pub(crate) is_active: bool,
    pub(crate) paid_plan_required: bool,
    pub(crate) trial_expired_at: Option<String>,
    pub(crate) scheduled_deletion_at: Option<String>,
    pub(crate) comp_granted_at: Option<String>,
    pub(crate) comp_ends_at: Option<String>,
}

macro_rules! columns {
    () => {
        "id, clerk_org_id, name, plan_id, purchased_seats, subscription_status,
    subscription_cycle,
    to_char(subscription_current_period_start, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as period_start,
    to_char(subscription_current_period_end, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as period_end,
    subscription_cancel_at_period_end as cancel_at_period_end, billing_mode, is_active,
    paid_plan_required,
    to_char(trial_expired_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as trial_expired_at,
    to_char(scheduled_deletion_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as scheduled_deletion_at,
    to_char(comp_granted_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as comp_granted_at,
    to_char(comp_ends_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as comp_ends_at"
    };
}

/// Statuses in which a plan subscription still runs and bills.
pub(crate) const RUNNING_STATUSES: &[&str] = &["active", "trialing", "past_due"];

impl Workspace {
    /// By `workspaces.id` or Clerk org id.
    pub(crate) async fn load(
        master: &PgPool,
        reference: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as(concat!(
            "select ",
            columns!(),
            " from workspaces where id = $1 or clerk_org_id = $1 limit 1"
        ))
        .bind(reference)
        .fetch_optional(master)
        .await
    }

    /// Locks the row for the rest of `tx`.
    pub(crate) async fn lock(
        tx: &mut sqlx::PgConnection,
        id: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as(concat!(
            "select ",
            columns!(),
            " from workspaces where id = $1 for update"
        ))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
    }

    pub(crate) fn cycle(&self) -> Cycle {
        self.subscription_cycle
            .as_deref()
            .and_then(Cycle::parse)
            .unwrap_or(Cycle::Monthly)
    }

    pub(crate) fn period(&self) -> Option<(OffsetDateTime, OffsetDateTime)> {
        Some((
            parse_iso(self.period_start.as_deref()?)?,
            parse_iso(self.period_end.as_deref()?)?,
        ))
    }

    /// A paid subscription runs: a running status and a period that hasn't
    /// ended.
    pub(crate) fn has_running_subscription(&self, now: OffsetDateTime) -> bool {
        RUNNING_STATUSES.contains(&self.subscription_status.as_deref().unwrap_or_default())
            && self.period().is_some_and(|(_, end)| end > now)
    }

    /// BILL-011: an admin-granted comp is in force.
    pub(crate) fn comp_active(&self, now: OffsetDateTime) -> bool {
        self.comp_granted_at.is_some()
            && self
                .comp_ends_at
                .as_deref()
                .and_then(parse_iso)
                .is_none_or(|ends| ends > now)
    }

    pub(crate) fn is_partner(&self) -> bool {
        self.billing_mode == "partner"
    }

    /// The organization the identity provider knows it by.
    pub(crate) fn organization(&self) -> &str {
        self.clerk_org_id.as_deref().unwrap_or(&self.id)
    }

    /// `mapSubscription(workspace, plan, usedSeats)` of app-api.
    pub(crate) fn subscription_json(
        &self,
        plan: Option<&crate::plans::Plan>,
        used_seats: i64,
    ) -> Value {
        json!({
            "id": self.id,
            "planId": plan.map(|p| p.id.clone()),
            "planName": plan.map_or("Free", |p| p.name.as_str()),
            "planSlug": plan.map_or("free", |p| p.slug.as_str()),
            "status": self.subscription_status.clone().unwrap_or_else(|| {
                if self.is_active { "active" } else { "canceled" }.to_owned()
            }),
            "cycle": self.subscription_cycle.clone().unwrap_or_else(|| "monthly".to_owned()),
            "purchasedSeats": self.purchased_seats,
            "usedSeats": used_seats,
            "currentPeriodStart": self.period_start,
            "currentPeriodEnd": self.period_end,
            "cancelAtPeriodEnd": self.cancel_at_period_end,
            "stripeCustomerId": Value::Null,
            "stripeSubscriptionId": Value::Null,
            "paidPlanRequired": self.paid_plan_required,
            "trialExpiredAt": self.trial_expired_at,
            "scheduledDeletionAt": self.scheduled_deletion_at,
            "isLocked": self.scheduled_deletion_at.is_some(),
        })
    }
}

/// Active members of the workspace in master (`user_workspaces`).
pub(crate) async fn active_members(
    master: &PgPool,
    workspace_id: &str,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "select count(*) from user_workspaces where workspace_id = $1 and status = 'ACTIVE'",
    )
    .bind(workspace_id)
    .fetch_one(master)
    .await
}

/// Starts (or changes) the paid subscription on `workspaces`: plan, seats,
/// status, cycle and period, and clears the trial paywall (BILL-004:
/// "adding a paid subscription clears both back to null"; an admin's
/// scheduled deletion stays).
#[allow(clippy::too_many_arguments)] // one per column
pub(crate) async fn set_subscription(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    plan_id: &str,
    seats: i64,
    status: &str,
    cycle: Cycle,
    period: (OffsetDateTime, OffsetDateTime),
    now: OffsetDateTime,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update workspaces set plan_id = $2, purchased_seats = $3, subscription_status = $4,
             subscription_cycle = $5,
             subscription_current_period_start = $6::timestamp,
             subscription_current_period_end = $7::timestamp,
             subscription_cancel_at_period_end = false,
             trial_expired_at = null,
             scheduled_deletion_at = case when deletion_requested_by is null then null
                                          else scheduled_deletion_at end,
             updated_at = $8::timestamp
         where id = $1",
    )
    .bind(workspace_id)
    .bind(plan_id)
    .bind(i32::try_from(seats).unwrap_or(i32::MAX))
    .bind(status)
    .bind(cycle.as_str())
    .bind(iso(period.0))
    .bind(iso(period.1))
    .bind(iso(now))
    .execute(&mut *tx)
    .await?;
    Ok(())
}
