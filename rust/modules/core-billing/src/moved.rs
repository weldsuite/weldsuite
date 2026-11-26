//! Workspaces that move from Global (ADR OPS-025, BILL-014). Their plan,
//! seats, cycle and period come over on the workspace row (the move maps the
//! plan to this install's). [`open_account`] then opens the billing account
//! renewals read: the seat price of the plan, the anchor and the next charge
//! on the day Global's period ends, and no Mollie customer or mandate, since
//! a card mandate can't move from Stripe. The first renewal here asks for a
//! payment method ([`crate::payment_method`]).

use sea_orm::DbErr;
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};

use crate::account::{self, Account};
use crate::period;
use crate::plans::Plan;
use crate::workspace::{RUNNING_STATUSES, Workspace};

/// What [`open_account`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MovedAccount {
    /// Renews at `next_charge_at`, `unit_amount` cents a seat.
    Opened {
        unit_amount: i64,
        next_charge_at: OffsetDateTime,
    },
    /// Nothing is charged, and why.
    NotCharged(&'static str),
}

/// Open the billing account of a workspace that moved from Global (see the
/// module docs). Safe to run again: until the workspace pays here, the
/// account is set from its row again; once it has a Mollie customer it is
/// left alone.
pub async fn open_account(
    master: &PgPool,
    workspace_id: &str,
    now: OffsetDateTime,
) -> Result<MovedAccount, DbErr> {
    let Some(workspace) = Workspace::load(master, workspace_id).await? else {
        return Err(DbErr::RecordNotFound(format!("workspace {workspace_id}")));
    };
    let plan = match &workspace.plan_id {
        Some(id) => Plan::load(master, id).await?,
        None => None,
    };
    let Some(plan) = plan.filter(|plan| !plan.is_free()) else {
        return Ok(MovedAccount::NotCharged("a free plan"));
    };
    if workspace.comp_active(now) {
        return Ok(MovedAccount::NotCharged("a complimentary plan"));
    }
    if workspace.is_partner() {
        return Ok(MovedAccount::NotCharged("billed through a partner"));
    }
    let status = workspace.subscription_status.as_deref().unwrap_or_default();
    if !RUNNING_STATUSES.contains(&status) {
        return Ok(MovedAccount::NotCharged("no running subscription"));
    }
    let Some(unit_amount) = plan.unit_amount(workspace.cycle()) else {
        return Ok(MovedAccount::NotCharged("its plan has no price in EUR"));
    };
    let Some((_, renews_at)) = workspace.period() else {
        return Ok(MovedAccount::NotCharged("no billing period"));
    };
    let account = Account::ensure(master, workspace_id).await?;
    if account.customer_id.is_some() || account.mandate_id.is_some() {
        return Ok(MovedAccount::NotCharged("it already pays here"));
    }
    account::start(
        &orm(master),
        workspace_id,
        unit_amount,
        period::anchor_day(renews_at),
        renews_at,
    )
    .await?;
    Ok(MovedAccount::Opened {
        unit_amount,
        next_charge_at: renews_at,
    })
}
