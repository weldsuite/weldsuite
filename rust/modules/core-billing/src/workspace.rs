//! A workspace's billing state on `workspaces`: what every other reader of
//! the plan (seat check, limits, lock gate) reads too.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, PaginatorTrait,
    QueryFilter, QuerySelect,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_schema::master::enums::MembershipStatus;
use weldsuite_schema::master::{user_workspaces, workspaces};

use crate::period::{Cycle, iso, parse_iso};

/// A `timestamp` column as `to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
/// prints it: `new Date().toISOString()` of the UTC wall-clock time.
pub(crate) fn iso_text(at: PrimitiveDateTime) -> String {
    iso(at.assume_utc())
}

/// The columns billing reads, timestamps as ISO text.
#[derive(Debug, Clone)]
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

/// Those columns as stored.
#[derive(Debug, FromQueryResult)]
struct Row {
    id: String,
    clerk_org_id: Option<String>,
    name: String,
    plan_id: Option<String>,
    purchased_seats: i32,
    subscription_status: Option<String>,
    subscription_cycle: Option<String>,
    subscription_current_period_start: Option<PrimitiveDateTime>,
    subscription_current_period_end: Option<PrimitiveDateTime>,
    subscription_cancel_at_period_end: bool,
    billing_mode: String,
    is_active: bool,
    paid_plan_required: bool,
    trial_expired_at: Option<PrimitiveDateTime>,
    scheduled_deletion_at: Option<PrimitiveDateTime>,
    comp_granted_at: Option<PrimitiveDateTime>,
    comp_ends_at: Option<PrimitiveDateTime>,
}

impl From<Row> for Workspace {
    fn from(row: Row) -> Self {
        Self {
            id: row.id,
            clerk_org_id: row.clerk_org_id,
            name: row.name,
            plan_id: row.plan_id,
            purchased_seats: row.purchased_seats,
            subscription_status: row.subscription_status,
            subscription_cycle: row.subscription_cycle,
            period_start: row.subscription_current_period_start.map(iso_text),
            period_end: row.subscription_current_period_end.map(iso_text),
            cancel_at_period_end: row.subscription_cancel_at_period_end,
            billing_mode: row.billing_mode,
            is_active: row.is_active,
            paid_plan_required: row.paid_plan_required,
            trial_expired_at: row.trial_expired_at.map(iso_text),
            scheduled_deletion_at: row.scheduled_deletion_at.map(iso_text),
            comp_granted_at: row.comp_granted_at.map(iso_text),
            comp_ends_at: row.comp_ends_at.map(iso_text),
        }
    }
}

/// `select <the columns> from workspaces`.
fn select() -> sea_orm::Select<workspaces::Entity> {
    use workspaces::Column as W;
    workspaces::Entity::find().select_only().columns([
        W::Id,
        W::ClerkOrgId,
        W::Name,
        W::PlanId,
        W::PurchasedSeats,
        W::SubscriptionStatus,
        W::SubscriptionCycle,
        W::SubscriptionCurrentPeriodStart,
        W::SubscriptionCurrentPeriodEnd,
        W::SubscriptionCancelAtPeriodEnd,
        W::BillingMode,
        W::IsActive,
        W::PaidPlanRequired,
        W::TrialExpiredAt,
        W::ScheduledDeletionAt,
        W::CompGrantedAt,
        W::CompEndsAt,
    ])
}

/// Statuses in which a plan subscription still runs and bills.
pub(crate) const RUNNING_STATUSES: &[&str] = &["active", "trialing", "past_due"];

impl Workspace {
    /// By `workspaces.id` or Clerk org id.
    pub(crate) async fn load(master: &PgPool, reference: &str) -> Result<Option<Self>, DbErr> {
        let row = select()
            .filter(
                Condition::any()
                    .add(workspaces::Column::Id.eq(reference))
                    .add(workspaces::Column::ClerkOrgId.eq(reference)),
            )
            .into_model::<Row>()
            .one(&orm(master))
            .await?;
        Ok(row.map(Self::from))
    }

    /// Locks the row for the rest of `tx`.
    pub(crate) async fn lock(tx: &impl ConnectionTrait, id: &str) -> Result<Option<Self>, DbErr> {
        let row = select()
            .filter(workspaces::Column::Id.eq(id))
            .lock_exclusive()
            .into_model::<Row>()
            .one(tx)
            .await?;
        Ok(row.map(Self::from))
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
pub(crate) async fn active_members(master: &PgPool, workspace_id: &str) -> Result<i64, DbErr> {
    let count = user_workspaces::Entity::find()
        .filter(user_workspaces::Column::WorkspaceId.eq(workspace_id))
        .filter(user_workspaces::Column::Status.eq(MembershipStatus::ACTIVE))
        .count(&orm(master))
        .await?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
}

/// Starts (or changes) the paid subscription on `workspaces`: plan, seats,
/// status, cycle and period, and clears the trial paywall (BILL-004:
/// "adding a paid subscription clears both back to null"; an admin's
/// scheduled deletion stays).
#[allow(clippy::too_many_arguments)] // one per column
pub(crate) async fn set_subscription(
    tx: &impl ConnectionTrait,
    workspace_id: &str,
    plan_id: &str,
    seats: i64,
    status: &str,
    cycle: Cycle,
    period: (OffsetDateTime, OffsetDateTime),
    now: OffsetDateTime,
) -> Result<(), DbErr> {
    use workspaces::Column as W;
    workspaces::Entity::update_many()
        .col_expr(W::PlanId, Expr::value(plan_id.to_owned()))
        .col_expr(
            W::PurchasedSeats,
            Expr::value(i32::try_from(seats).unwrap_or(i32::MAX)),
        )
        .col_expr(W::SubscriptionStatus, Expr::value(status.to_owned()))
        .col_expr(W::SubscriptionCycle, Expr::value(cycle.as_str()))
        .col_expr(
            W::SubscriptionCurrentPeriodStart,
            Expr::value(utc_timestamp(period.0)),
        )
        .col_expr(
            W::SubscriptionCurrentPeriodEnd,
            Expr::value(utc_timestamp(period.1)),
        )
        .col_expr(W::SubscriptionCancelAtPeriodEnd, Expr::value(false))
        .col_expr(W::TrialExpiredAt, Expr::null())
        .col_expr(
            W::ScheduledDeletionAt,
            Expr::case(W::DeletionRequestedBy.is_null(), Expr::null())
                .finally(Expr::col(W::ScheduledDeletionAt))
                .into(),
        )
        .col_expr(W::UpdatedAt, Expr::value(utc_timestamp(now)))
        .filter(W::Id.eq(workspace_id))
        .exec(tx)
        .await?;
    Ok(())
}
