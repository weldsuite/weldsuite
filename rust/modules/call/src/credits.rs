//! The prepaid credits wallet (`@weldsuite/credits`) as calls meter
//! against it: a pre-flight check before dialling, and the settlement of a
//! finished call, per started minute, idempotent on the call id. When the
//! wallet ran dry mid-call the settlement forces it negative (an
//! `adjustment`), as visible debt beats hidden loss.
//!
//! Without an interactive transaction (neon-http has none) the TypeScript
//! code orders its statements so the ledger stays right: dedupe on the
//! idempotency key, a conditional balance change, then the ledger insert,
//! compensating the balance when a concurrent call won the key. The same
//! statements run here.

use serde_json::{Value, json};
use time::{Month, OffsetDateTime};
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;

/// `SERVICE_CREDIT_RATES.voipCallPerMinute`.
pub(crate) const VOIP_CALL_PER_MINUTE: i64 = 3;

/// `resolveInternalWorkspaceId`: `workspaces.id` from either id of a
/// workspace.
pub(crate) async fn resolve_workspace(
    master: &PgPool,
    reference: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("select id from workspaces where id = $1 or clerk_org_id = $1 limit 1")
        .bind(reference)
        .fetch_optional(master)
        .await
}

async fn find_by_key(master: &PgPool, key: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("select id from credit_transactions where idempotency_key = $1 limit 1")
        .bind(key)
        .fetch_optional(master)
        .await
}

/// This month's period, midnight UTC on the first to the first of the next.
fn period(now: OffsetDateTime) -> (String, String) {
    let start = time::Date::from_calendar_date(now.year(), now.month(), 1)
        .unwrap_or(now.date())
        .midnight()
        .assume_utc();
    let (year, month) = if now.month() == Month::December {
        (now.year() + 1, Month::January)
    } else {
        (now.year(), now.month().next())
    };
    let end = time::Date::from_calendar_date(year, month, 1)
        .unwrap_or(now.date())
        .midnight()
        .assume_utc();
    (iso_timestamp(start), iso_timestamp(end))
}

/// `getOrCreateWorkspaceCredits`: the balance, creating the empty wallet on
/// first use.
async fn balance(master: &PgPool, workspace_id: &str) -> Result<i64, sqlx::Error> {
    let read = || {
        sqlx::query_scalar::<_, i32>(
            "select current_balance from workspace_credits where workspace_id = $1 limit 1",
        )
        .bind(workspace_id)
    };
    if let Some(balance) = read().fetch_optional(master).await? {
        return Ok(i64::from(balance));
    }
    let (start, end) = period(OffsetDateTime::now_utc());
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
    .bind(&start)
    .bind(&end)
    .execute(master)
    .await?;
    Ok(read().fetch_optional(master).await?.map_or(0, i64::from))
}

/// `checkCredits(db, workspaceId, amount)`: `(available, currentBalance)`.
pub(crate) async fn check(
    master: &PgPool,
    workspace_id: &str,
    amount: i64,
) -> Result<(bool, i64), sqlx::Error> {
    let current = balance(master, workspace_id).await?;
    Ok((current >= amount, current))
}

/// One ledger change.
pub(crate) struct Entry<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) amount: i64,
    pub(crate) idempotency_key: String,
    pub(crate) reference_id: &'a str,
    pub(crate) description: String,
    pub(crate) metadata: Value,
    pub(crate) user_id: Option<&'a str>,
}

async fn insert(
    master: &PgPool,
    entry: &Entry<'_>,
    kind: &str,
    amount: i64,
    balance_after: i32,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "insert into credit_transactions
             (id, workspace_id, type, amount, balance_after, service_type, reference_id,
              reference_type, idempotency_key, description, metadata, user_id)
         values ($1, $2, $3, $4::int, $5, 'voip_call', $6, 'voip_call', $7, $8, $9::jsonb, $10)
         on conflict (idempotency_key) do nothing
         returning id",
    )
    .bind(generate_id("ctx"))
    .bind(entry.workspace_id)
    .bind(kind)
    .bind(amount)
    .bind(balance_after)
    .bind(entry.reference_id)
    .bind(&entry.idempotency_key)
    .bind(&entry.description)
    .bind(&entry.metadata)
    .bind(entry.user_id)
    .fetch_optional(master)
    .await
}

async fn add(master: &PgPool, workspace_id: &str, delta: i64) -> Result<Option<i32>, sqlx::Error> {
    sqlx::query_scalar(
        "update workspace_credits set current_balance = current_balance + $2::int,
             updated_at = $3::timestamptz
         where workspace_id = $1
         returning current_balance",
    )
    .bind(workspace_id)
    .bind(delta)
    .bind(iso_timestamp(OffsetDateTime::now_utc()))
    .fetch_optional(master)
    .await
}

/// `consumeCredits`: the transaction id, or `None` when the wallet can't
/// cover it.
pub(crate) async fn consume(
    master: &PgPool,
    entry: &Entry<'_>,
) -> Result<Option<String>, sqlx::Error> {
    if let Some(id) = find_by_key(master, &entry.idempotency_key).await? {
        return Ok(Some(id));
    }
    balance(master, entry.workspace_id).await?;
    let updated: Option<i32> = sqlx::query_scalar(
        "update workspace_credits set current_balance = current_balance - $2::int,
             updated_at = $3::timestamptz
         where workspace_id = $1 and current_balance >= $2::int
         returning current_balance",
    )
    .bind(entry.workspace_id)
    .bind(entry.amount)
    .bind(iso_timestamp(OffsetDateTime::now_utc()))
    .fetch_optional(master)
    .await?;
    let Some(after) = updated else {
        return Ok(None);
    };
    if let Some(id) = insert(master, entry, "consumption", -entry.amount, after).await? {
        return Ok(Some(id));
    }
    // A concurrent call won the key: undo, and report the winner.
    add(master, entry.workspace_id, entry.amount).await?;
    Ok(Some(
        find_by_key(master, &entry.idempotency_key)
            .await?
            .unwrap_or_default(),
    ))
}

/// `grantCredits({ type: 'adjustment', amount: -amount })`: the forced debit.
pub(crate) async fn force_debit(master: &PgPool, entry: &Entry<'_>) -> Result<String, String> {
    if let Some(id) = find_by_key(master, &entry.idempotency_key)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(id);
    }
    balance(master, entry.workspace_id)
        .await
        .map_err(|e| e.to_string())?;
    let Some(after) = add(master, entry.workspace_id, -entry.amount)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Err(format!(
            "[credits] workspace_credits row missing for workspace {}",
            entry.workspace_id
        ));
    };
    if let Some(id) = insert(master, entry, "adjustment", -entry.amount, after)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(id);
    }
    add(master, entry.workspace_id, entry.amount)
        .await
        .map_err(|e| e.to_string())?;
    Ok(find_by_key(master, &entry.idempotency_key)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default())
}

/// Settle a finished call: `(creditsConsumed, creditTransactionId)`.
/// `metadata` is the consumption's; the forced debit records
/// `forcedSettlement` instead of `extra`.
pub(crate) async fn settle_call(
    master: &PgPool,
    workspace_id: &str,
    call_id: &str,
    duration_secs: i64,
    extra: (&str, Value),
    user_id: Option<&str>,
) -> Result<(i64, String), String> {
    let minutes = (duration_secs + 59) / 60;
    let cost = minutes * VOIP_CALL_PER_MINUTE;
    let key = format!("voip:{call_id}");
    let mut metadata = json!({ "callId": call_id, "durationSecs": duration_secs });
    metadata[extra.0] = extra.1;
    let consumption = Entry {
        workspace_id,
        amount: cost,
        idempotency_key: key.clone(),
        reference_id: call_id,
        description: format!("VoIP call ({minutes} min)"),
        metadata,
        user_id,
    };
    if let Some(id) = consume(master, &consumption)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok((cost, id));
    }
    let debit = Entry {
        workspace_id,
        amount: cost,
        idempotency_key: key,
        reference_id: call_id,
        description: format!("VoIP call ({minutes} min) — settled into negative balance"),
        metadata: json!({ "callId": call_id, "durationSecs": duration_secs, "forcedSettlement": true }),
        user_id,
    };
    let id = force_debit(master, &debit).await?;
    Ok((cost, id))
}
