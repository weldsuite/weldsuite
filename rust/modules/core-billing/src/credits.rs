//! The plan's monthly credits (BILL-005): granted on top of the wallet on
//! every anchor of a paid plan, once per (workspace, anchor), as Global's
//! `updateSubscriptionCredits` does on `invoice.paid`. A yearly plan gets
//! them every month, not once a year. Prepaid credits are never taken.

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use serde_json::json;
use time::OffsetDateTime;
use weldsuite_db::utc_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_schema::master::{credit_transactions, workspace_credits};

use crate::period::iso;

/// `$n::timestamptz` bound from `toISOString()`: the instant, to the
/// millisecond.
fn instant(at: OffsetDateTime) -> OffsetDateTime {
    utc_timestamp(at).assume_utc()
}

/// `monthly_grant:<workspace>:<period start>`, Global's key.
pub(crate) fn grant_key(workspace_id: &str, anchor: OffsetDateTime) -> String {
    format!("monthly_grant:{workspace_id}:{}", iso(anchor))
}

/// Points the wallet's allocation at `plan_credits` and grants them for the
/// month starting at `anchor`, once. Returns the credits granted (0 when
/// already granted or the plan has none).
pub(crate) async fn grant_monthly(
    tx: &impl ConnectionTrait,
    workspace_id: &str,
    plan_credits: i64,
    anchor: OffsetDateTime,
    next_anchor: OffsetDateTime,
) -> Result<i64, DbErr> {
    use workspace_credits::Column as W;
    workspace_credits::Entity::insert(workspace_credits::ActiveModel {
        id: Set(generate_id("wcr")),
        workspace_id: Set(workspace_id.to_owned()),
        current_balance: Set(0),
        plan_credits: Set(0),
        subscribed_credits: Set(0),
        monthly_allocation: Set(0),
        rolled_over_credits: Set(0),
        rollover_cap: Set(None),
        period_start: Set(instant(anchor)),
        period_end: Set(instant(next_anchor)),
        last_reset_at: Set(None),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(tx)
    .await?;
    let credits = i32::try_from(plan_credits.max(0)).unwrap_or(i32::MAX);
    workspace_credits::Entity::update_many()
        .col_expr(W::PlanCredits, Expr::value(credits))
        .col_expr(W::SubscribedCredits, Expr::value(0))
        .col_expr(W::MonthlyAllocation, Expr::value(credits))
        .col_expr(W::PeriodStart, Expr::value(instant(anchor)))
        .col_expr(W::PeriodEnd, Expr::value(instant(next_anchor)))
        .col_expr(W::UpdatedAt, Expr::current_timestamp())
        .filter(W::WorkspaceId.eq(workspace_id))
        .exec(tx)
        .await?;
    if credits == 0 {
        return Ok(0);
    }
    let key = grant_key(workspace_id, anchor);
    let taken: Option<String> = credit_transactions::Entity::find()
        .select_only()
        .column(credit_transactions::Column::Id)
        .filter(credit_transactions::Column::IdempotencyKey.eq(&key))
        .into_tuple()
        .one(tx)
        .await?;
    if taken.is_some() {
        return Ok(0);
    }
    let balance = workspace_credits::Entity::update_many()
        .col_expr(
            W::CurrentBalance,
            sea_orm::ExprTrait::add(Expr::col(W::CurrentBalance), credits),
        )
        .col_expr(W::LastResetAt, Expr::current_timestamp())
        .col_expr(W::UpdatedAt, Expr::current_timestamp())
        .filter(W::WorkspaceId.eq(workspace_id))
        .exec_with_returning(tx)
        .await?
        .into_iter()
        .next()
        .map(|wallet| wallet.current_balance)
        .ok_or_else(|| DbErr::RecordNotFound("workspace_credits".to_owned()))?;
    credit_transactions::Entity::insert(credit_transactions::ActiveModel {
        id: Set(generate_id("ctx")),
        workspace_id: Set(workspace_id.to_owned()),
        type_: Set("monthly_allocation".to_owned()),
        amount: Set(credits),
        balance_after: Set(balance),
        idempotency_key: Set(Some(key)),
        description: Set(Some(format!("Monthly plan credits: +{credits}"))),
        metadata: Set(Some(json!({
            "reason": "period_renewal",
            "provider": "mollie",
            "planCredits": credits,
            "periodStart": iso(anchor),
            "periodEnd": iso(next_anchor),
        }))),
        ..Default::default()
    })
    .exec_without_returning(tx)
    .await?;
    Ok(i64::from(credits))
}

/// The plan ended: the allocation follows the Free plan's credits. The
/// balance is left alone.
pub(crate) async fn reset_allocation(
    tx: &impl ConnectionTrait,
    workspace_id: &str,
    free_credits: i64,
) -> Result<(), DbErr> {
    use workspace_credits::Column as W;
    let credits = i32::try_from(free_credits.max(0)).unwrap_or(i32::MAX);
    workspace_credits::Entity::update_many()
        .col_expr(W::PlanCredits, Expr::value(credits))
        .col_expr(W::SubscribedCredits, Expr::value(0))
        .col_expr(W::MonthlyAllocation, Expr::value(credits))
        .col_expr(W::UpdatedAt, Expr::current_timestamp())
        .filter(W::WorkspaceId.eq(workspace_id))
        .exec(tx)
        .await?;
    Ok(())
}
