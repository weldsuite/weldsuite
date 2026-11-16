//! The plan's monthly credits (BILL-005): granted on top of the wallet on
//! every anchor of a paid plan, once per (workspace, anchor), as Global's
//! `updateSubscriptionCredits` does on `invoice.paid`. A yearly plan gets
//! them every month, not once a year. Prepaid credits are never taken.

use serde_json::json;
use time::OffsetDateTime;
use weldsuite_kit::generate_id;

use crate::period::iso;

/// `monthly_grant:<workspace>:<period start>`, Global's key.
pub(crate) fn grant_key(workspace_id: &str, anchor: OffsetDateTime) -> String {
    format!("monthly_grant:{workspace_id}:{}", iso(anchor))
}

/// Points the wallet's allocation at `plan_credits` and grants them for the
/// month starting at `anchor`, once. Returns the credits granted (0 when
/// already granted or the plan has none).
pub(crate) async fn grant_monthly(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    plan_credits: i64,
    anchor: OffsetDateTime,
    next_anchor: OffsetDateTime,
) -> Result<i64, sqlx::Error> {
    sqlx::query(
        "insert into workspace_credits
             (id, workspace_id, current_balance, plan_credits, subscribed_credits,
              monthly_allocation, rolled_over_credits, rollover_cap, period_start, period_end,
              last_reset_at)
         values ($1, $2, 0, 0, 0, 0, 0, null, $3::timestamptz, $4::timestamptz, null)
         on conflict do nothing",
    )
    .bind(generate_id("wcr"))
    .bind(workspace_id)
    .bind(iso(anchor))
    .bind(iso(next_anchor))
    .execute(&mut *tx)
    .await?;
    let credits = i32::try_from(plan_credits.max(0)).unwrap_or(i32::MAX);
    sqlx::query(
        "update workspace_credits set plan_credits = $2, subscribed_credits = 0,
             monthly_allocation = $2, period_start = $3::timestamptz, period_end = $4::timestamptz,
             updated_at = now()
         where workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(credits)
    .bind(iso(anchor))
    .bind(iso(next_anchor))
    .execute(&mut *tx)
    .await?;
    if credits == 0 {
        return Ok(0);
    }
    let key = grant_key(workspace_id, anchor);
    let taken: Option<String> =
        sqlx::query_scalar("select id from credit_transactions where idempotency_key = $1")
            .bind(&key)
            .fetch_optional(&mut *tx)
            .await?;
    if taken.is_some() {
        return Ok(0);
    }
    let balance: i32 = sqlx::query_scalar(
        "update workspace_credits set current_balance = current_balance + $2,
             last_reset_at = now(), updated_at = now()
         where workspace_id = $1 returning current_balance",
    )
    .bind(workspace_id)
    .bind(credits)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "insert into credit_transactions
             (id, workspace_id, type, amount, balance_after, idempotency_key, description, metadata)
         values ($1, $2, 'monthly_allocation', $3, $4, $5, $6, $7::jsonb)",
    )
    .bind(generate_id("ctx"))
    .bind(workspace_id)
    .bind(credits)
    .bind(balance)
    .bind(&key)
    .bind(format!("Monthly plan credits: +{credits}"))
    .bind(json!({
        "reason": "period_renewal",
        "provider": "mollie",
        "planCredits": credits,
        "periodStart": iso(anchor),
        "periodEnd": iso(next_anchor),
    }))
    .execute(&mut *tx)
    .await?;
    Ok(i64::from(credits))
}

/// The plan ended: the allocation follows the Free plan's credits. The
/// balance is left alone.
pub(crate) async fn reset_allocation(
    tx: &mut sqlx::PgConnection,
    workspace_id: &str,
    free_credits: i64,
) -> Result<(), sqlx::Error> {
    let credits = i32::try_from(free_credits.max(0)).unwrap_or(i32::MAX);
    sqlx::query(
        "update workspace_credits set plan_credits = $2, subscribed_credits = 0,
             monthly_allocation = $2, updated_at = now()
         where workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(credits)
    .execute(&mut *tx)
    .await?;
    Ok(())
}
