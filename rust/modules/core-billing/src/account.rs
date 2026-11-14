//! `billing_accounts`: the Mollie side of a paying workspace (ADR BILL-014).

use sqlx::FromRow;
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use crate::period::{Cycle, iso, parse_iso};

/// One row, timestamps as ISO text.
#[derive(Debug, Clone, FromRow)]
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

macro_rules! columns {
    () => {
        "id, customer_id, mandate_id,
    unit_amount, currency, anchor_day,
    to_char(next_charge_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as next_charge_at,
    scheduled_plan_id, scheduled_seats, scheduled_cycle,
    to_char(past_due_since, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as past_due_since,
    past_due_payment_id"
    };
}

/// A change waiting for the period end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Scheduled {
    pub(crate) plan_id: Option<String>,
    pub(crate) seats: Option<i64>,
    pub(crate) cycle: Option<Cycle>,
}

impl Account {
    pub(crate) async fn load(
        master: &PgPool,
        workspace_id: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as(concat!(
            "select ",
            columns!(),
            " from billing_accounts where workspace_id = $1"
        ))
        .bind(workspace_id)
        .fetch_optional(master)
        .await
    }

    /// Locks the row for the rest of `tx`.
    pub(crate) async fn lock(
        tx: &mut sqlx::PgConnection,
        workspace_id: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as(concat!(
            "select ",
            columns!(),
            " from billing_accounts where workspace_id = $1 for update"
        ))
        .bind(workspace_id)
        .fetch_optional(&mut *tx)
        .await
    }

    /// The account of `workspace_id`, created empty on first use.
    pub(crate) async fn ensure(master: &PgPool, workspace_id: &str) -> Result<Self, sqlx::Error> {
        sqlx::query(
            "insert into billing_accounts (id, workspace_id, provider) values ($1, $2, 'mollie')
             on conflict (workspace_id) do nothing",
        )
        .bind(generate_id("bac"))
        .bind(workspace_id)
        .execute(master)
        .await?;
        sqlx::query_as(concat!(
            "select ",
            columns!(),
            " from billing_accounts where workspace_id = $1"
        ))
        .bind(workspace_id)
        .fetch_one(master)
        .await
    }

    pub(crate) async fn set_customer(
        master: &PgPool,
        workspace_id: &str,
        customer_id: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "update billing_accounts set customer_id = $2, updated_at = now()
             where workspace_id = $1 and customer_id is null",
        )
        .bind(workspace_id)
        .bind(customer_id)
        .execute(master)
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
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    mandate_id: &str,
    method: Option<&str>,
    label: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update billing_accounts set mandate_id = $2, mandate_method = $3, mandate_label = $4,
             updated_at = now()
         where workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(mandate_id)
    .bind(method)
    .bind(label)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// After a first payment: the seat price, the anchor and the next charge;
/// nothing scheduled, nothing past due.
pub(crate) async fn start(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    unit_amount: i64,
    anchor_day: u8,
    next_charge_at: OffsetDateTime,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update billing_accounts set unit_amount = $2, anchor_day = $3, next_charge_at = $4::timestamp,
             scheduled_plan_id = null, scheduled_seats = null, scheduled_cycle = null,
             past_due_since = null, past_due_payment_id = null, dunning_reminded_at = null,
             updated_at = now()
         where workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(i32::try_from(unit_amount).unwrap_or(i32::MAX))
    .bind(i16::from(anchor_day))
    .bind(iso(next_charge_at))
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// The seat price the running period bills (a plan change).
pub(crate) async fn set_unit_amount(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    unit_amount: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update billing_accounts set unit_amount = $2, updated_at = now() where workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(i32::try_from(unit_amount).unwrap_or(i32::MAX))
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// What waits for the period end (`None` everywhere clears it).
pub(crate) async fn schedule(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    scheduled: Option<&Scheduled>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update billing_accounts set scheduled_plan_id = $2, scheduled_seats = $3,
             scheduled_cycle = $4, updated_at = now()
         where workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(scheduled.and_then(|s| s.plan_id.clone()))
    .bind(
        scheduled
            .and_then(|s| s.seats)
            .map(|n| i32::try_from(n).unwrap_or(i32::MAX)),
    )
    .bind(scheduled.and_then(|s| s.cycle).map(Cycle::as_str))
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// The next anchor the renewal job charges on (`None`: nothing to charge).
pub(crate) async fn set_next_charge(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    next_charge_at: Option<OffsetDateTime>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update billing_accounts set next_charge_at = $2::timestamp, updated_at = now()
         where workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(next_charge_at.map(iso))
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// Past due on `payment_row_id` since `since` (kept when already past due).
pub(crate) async fn set_past_due(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    payment_row_id: &str,
    since: OffsetDateTime,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update billing_accounts set past_due_since = coalesce(past_due_since, $3::timestamp),
             past_due_payment_id = $2, updated_at = now()
         where workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(payment_row_id)
    .bind(iso(since))
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// The open charge was paid (or dropped): nothing past due any more.
pub(crate) async fn clear_past_due(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update billing_accounts set past_due_since = null, past_due_payment_id = null,
             dunning_reminded_at = null, updated_at = now()
         where workspace_id = $1",
    )
    .bind(workspace_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// The subscription ended: no more charges, nothing scheduled or past due.
/// The customer and mandate stay for a later checkout.
pub(crate) async fn end(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update billing_accounts set next_charge_at = null, unit_amount = null,
             scheduled_plan_id = null, scheduled_seats = null, scheduled_cycle = null,
             past_due_since = null, past_due_payment_id = null, dunning_reminded_at = null,
             updated_at = now()
         where workspace_id = $1",
    )
    .bind(workspace_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}
