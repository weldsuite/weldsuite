//! `billing_accounts`: the Mollie side of a paying workspace (ADR BILL-014).

use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_kit::generate_id;
use weldsuite_schema::master::billing_accounts::{self, Column};

use crate::period::{Cycle, parse_iso};
use crate::workspace::iso_text;

/// One row, timestamps as ISO text.
#[derive(Debug, Clone)]
pub(crate) struct Account {
    pub(crate) id: String,
    pub(crate) customer_id: Option<String>,
    pub(crate) mandate_id: Option<String>,
    pub(crate) unit_amount: Option<i32>,
    pub(crate) currency: String,
    pub(crate) anchor_day: Option<i16>,
    pub(crate) next_charge_at: Option<String>,
    pub(crate) scheduled_plan_id: Option<String>,
    pub(crate) scheduled_seats: Option<i32>,
    pub(crate) scheduled_cycle: Option<String>,
    pub(crate) past_due_since: Option<String>,
    pub(crate) past_due_payment_id: Option<String>,
}

impl From<billing_accounts::Model> for Account {
    /// The columns billing reads, timestamps as
    /// `to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` printed them.
    fn from(row: billing_accounts::Model) -> Self {
        Self {
            id: row.id,
            customer_id: row.customer_id,
            mandate_id: row.mandate_id,
            unit_amount: row.unit_amount,
            currency: row.currency,
            anchor_day: row.anchor_day,
            next_charge_at: row.next_charge_at.map(iso_text),
            scheduled_plan_id: row.scheduled_plan_id,
            scheduled_seats: row.scheduled_seats,
            scheduled_cycle: row.scheduled_cycle,
            past_due_since: row.past_due_since.map(iso_text),
            past_due_payment_id: row.past_due_payment_id,
        }
    }
}

/// `update billing_accounts set …, updated_at = now() where workspace_id = $1`.
fn update(workspace_id: &str) -> sea_orm::UpdateMany<billing_accounts::Entity> {
    billing_accounts::Entity::update_many()
        .col_expr(Column::UpdatedAt, Expr::current_timestamp())
        .filter(Column::WorkspaceId.eq(workspace_id))
}

/// A change waiting for the period end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Scheduled {
    pub(crate) plan_id: Option<String>,
    pub(crate) seats: Option<i64>,
    pub(crate) cycle: Option<Cycle>,
}

impl Account {
    pub(crate) async fn load(master: &PgPool, workspace_id: &str) -> Result<Option<Self>, DbErr> {
        let row = billing_accounts::Entity::find()
            .filter(Column::WorkspaceId.eq(workspace_id))
            .one(&orm(master))
            .await?;
        Ok(row.map(Self::from))
    }

    /// Locks the row for the rest of `tx`.
    pub(crate) async fn lock(
        tx: &impl ConnectionTrait,
        workspace_id: &str,
    ) -> Result<Option<Self>, DbErr> {
        let row = billing_accounts::Entity::find()
            .filter(Column::WorkspaceId.eq(workspace_id))
            .lock_exclusive()
            .one(tx)
            .await?;
        Ok(row.map(Self::from))
    }

    /// The account of `workspace_id`, created empty on first use.
    pub(crate) async fn ensure(master: &PgPool, workspace_id: &str) -> Result<Self, DbErr> {
        let db = orm(master);
        billing_accounts::Entity::insert(billing_accounts::ActiveModel {
            id: Set(generate_id("bac")),
            workspace_id: Set(workspace_id.to_owned()),
            provider: Set("mollie".to_owned()),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(Column::WorkspaceId)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(&db)
        .await?;
        billing_accounts::Entity::find()
            .filter(Column::WorkspaceId.eq(workspace_id))
            .one(&db)
            .await?
            .map(Self::from)
            .ok_or_else(|| DbErr::RecordNotFound("billing_accounts".to_owned()))
    }

    pub(crate) async fn set_customer(
        master: &PgPool,
        workspace_id: &str,
        customer_id: &str,
    ) -> Result<(), DbErr> {
        update(workspace_id)
            .col_expr(Column::CustomerId, Expr::value(customer_id.to_owned()))
            .filter(Column::CustomerId.is_null())
            .exec(&orm(master))
            .await?;
        Ok(())
    }

    pub(crate) fn next_charge(&self) -> Option<OffsetDateTime> {
        self.next_charge_at.as_deref().and_then(parse_iso)
    }

    pub(crate) fn past_due_since(&self) -> Option<OffsetDateTime> {
        self.past_due_since.as_deref().and_then(parse_iso)
    }

    pub(crate) fn anchor(&self) -> u8 {
        self.anchor_day
            .and_then(|day| u8::try_from(day).ok())
            .filter(|day| (1..=28).contains(day))
            .unwrap_or(1)
    }

    pub(crate) fn scheduled(&self) -> Option<Scheduled> {
        let scheduled = Scheduled {
            plan_id: self.scheduled_plan_id.clone(),
            seats: self.scheduled_seats.map(i64::from),
            cycle: self.scheduled_cycle.as_deref().and_then(Cycle::parse),
        };
        (scheduled.plan_id.is_some() || scheduled.seats.is_some() || scheduled.cycle.is_some())
            .then_some(scheduled)
    }

    /// Whether renewals can be charged without the customer.
    pub(crate) fn can_charge(&self) -> bool {
        self.customer_id.is_some() && self.mandate_id.is_some()
    }
}

/// The mandate renewals charge from now on.
pub(crate) async fn set_mandate(
    tx: &impl ConnectionTrait,
    workspace_id: &str,
    mandate_id: &str,
    method: Option<&str>,
    label: Option<&str>,
) -> Result<(), DbErr> {
    update(workspace_id)
        .col_expr(Column::MandateId, Expr::value(mandate_id.to_owned()))
        .col_expr(
            Column::MandateMethod,
            Expr::value(method.map(str::to_owned)),
        )
        .col_expr(Column::MandateLabel, Expr::value(label.map(str::to_owned)))
        .exec(tx)
        .await?;
    Ok(())
}

/// After a first payment: the seat price, the anchor and the next charge;
/// nothing scheduled, nothing past due.
pub(crate) async fn start(
    tx: &impl ConnectionTrait,
    workspace_id: &str,
    unit_amount: i64,
    anchor_day: u8,
    next_charge_at: OffsetDateTime,
) -> Result<(), DbErr> {
    update(workspace_id)
        .col_expr(
            Column::UnitAmount,
            Expr::value(i32::try_from(unit_amount).unwrap_or(i32::MAX)),
        )
        .col_expr(Column::AnchorDay, Expr::value(i16::from(anchor_day)))
        .col_expr(
            Column::NextChargeAt,
            Expr::value(utc_timestamp(next_charge_at)),
        )
        .col_expr(Column::ScheduledPlanId, Expr::null())
        .col_expr(Column::ScheduledSeats, Expr::null())
        .col_expr(Column::ScheduledCycle, Expr::null())
        .col_expr(Column::PastDueSince, Expr::null())
        .col_expr(Column::PastDuePaymentId, Expr::null())
        .col_expr(Column::DunningRemindedAt, Expr::null())
        .exec(tx)
        .await?;
    Ok(())
}

/// The seat price the running period bills (a plan change).
pub(crate) async fn set_unit_amount(
    tx: &impl ConnectionTrait,
    workspace_id: &str,
    unit_amount: i64,
) -> Result<(), DbErr> {
    update(workspace_id)
        .col_expr(
            Column::UnitAmount,
            Expr::value(i32::try_from(unit_amount).unwrap_or(i32::MAX)),
        )
        .exec(tx)
        .await?;
    Ok(())
}

/// What waits for the period end (`None` everywhere clears it).
pub(crate) async fn schedule(
    tx: &impl ConnectionTrait,
    workspace_id: &str,
    scheduled: Option<&Scheduled>,
) -> Result<(), DbErr> {
    update(workspace_id)
        .col_expr(
            Column::ScheduledPlanId,
            Expr::value(scheduled.and_then(|s| s.plan_id.clone())),
        )
        .col_expr(
            Column::ScheduledSeats,
            Expr::value(
                scheduled
                    .and_then(|s| s.seats)
                    .map(|n| i32::try_from(n).unwrap_or(i32::MAX)),
            ),
        )
        .col_expr(
            Column::ScheduledCycle,
            Expr::value(
                scheduled
                    .and_then(|s| s.cycle)
                    .map(|cycle| cycle.as_str().to_owned()),
            ),
        )
        .exec(tx)
        .await?;
    Ok(())
}

/// The next anchor the renewal job charges on (`None`: nothing to charge).
pub(crate) async fn set_next_charge(
    tx: &impl ConnectionTrait,
    workspace_id: &str,
    next_charge_at: Option<OffsetDateTime>,
) -> Result<(), DbErr> {
    update(workspace_id)
        .col_expr(
            Column::NextChargeAt,
            Expr::value(next_charge_at.map(utc_timestamp)),
        )
        .exec(tx)
        .await?;
    Ok(())
}

/// Past due on `payment_row_id` since `since` (kept when already past due).
///
/// `dunning_reminded_at` holds, before an account is past due, the renewal
/// its billing owners were warned about for want of a payment method (one
/// email per renewal, `renewals::warn_without_payment_method`); while past
/// due, when they were reminded halfway through the grace period. Going past
/// due clears the first, so the reminder still goes out.
pub(crate) async fn set_past_due(
    tx: &impl ConnectionTrait,
    workspace_id: &str,
    payment_row_id: &str,
    since: OffsetDateTime,
) -> Result<(), DbErr> {
    update(workspace_id)
        .col_expr(
            Column::PastDueSince,
            Expr::from(Func::coalesce([
                Expr::col(Column::PastDueSince),
                Expr::value(utc_timestamp(since)),
            ])),
        )
        .col_expr(
            Column::PastDuePaymentId,
            Expr::value(payment_row_id.to_owned()),
        )
        // `case when past_due_since is null then null else dunning_reminded_at end`
        .col_expr(
            Column::DunningRemindedAt,
            Expr::case(Column::PastDueSince.is_null(), Expr::null())
                .finally(Expr::col(Column::DunningRemindedAt))
                .into(),
        )
        .exec(tx)
        .await?;
    Ok(())
}

/// The open charge was paid (or dropped): nothing past due any more.
pub(crate) async fn clear_past_due(
    tx: &impl ConnectionTrait,
    workspace_id: &str,
) -> Result<(), DbErr> {
    update(workspace_id)
        .col_expr(Column::PastDueSince, Expr::null())
        .col_expr(Column::PastDuePaymentId, Expr::null())
        .col_expr(Column::DunningRemindedAt, Expr::null())
        .exec(tx)
        .await?;
    Ok(())
}

/// The subscription ended: no more charges, nothing scheduled or past due.
/// The customer and mandate stay for a later checkout.
pub(crate) async fn end(tx: &impl ConnectionTrait, workspace_id: &str) -> Result<(), DbErr> {
    update(workspace_id)
        .col_expr(Column::NextChargeAt, Expr::null())
        .col_expr(Column::UnitAmount, Expr::null())
        .col_expr(Column::ScheduledPlanId, Expr::null())
        .col_expr(Column::ScheduledSeats, Expr::null())
        .col_expr(Column::ScheduledCycle, Expr::null())
        .col_expr(Column::PastDueSince, Expr::null())
        .col_expr(Column::PastDuePaymentId, Expr::null())
        .col_expr(Column::DunningRemindedAt, Expr::null())
        .exec(tx)
        .await?;
    Ok(())
}
