//! The prepaid credits wallet (`@weldsuite/credits`), what social publishing
//! meters against: the master database's `workspace_credits` row and its
//! `credit_transactions` ledger, scoped by `workspaces.id`.
//!
//! Without an interactive transaction (neon-http has none) the TypeScript
//! code orders its statements so the ledger stays right: dedupe on the
//! idempotency key, a conditional balance change, then the ledger insert,
//! compensating the balance when a concurrent call won the key. The same
//! statements run here.

use serde_json::Value;
use time::{Month, OffsetDateTime};
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;

/// `SERVICE_CREDIT_RATES.socialPostPerPlatform`.
pub const SOCIAL_POST_PER_PLATFORM: i64 = 2;

/// Why a credits call failed.
#[derive(Debug)]
pub enum CreditsError {
    /// The arguments were refused (`[credits] amount must be …`).
    Invalid(String),
    Database(sqlx::Error),
}

impl std::fmt::Display for CreditsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl From<sqlx::Error> for CreditsError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// `resolveInternalWorkspaceId`: `workspaces.id` from either id of a
/// workspace (its own or its Clerk org id).
pub async fn resolve_internal_workspace_id(
    master: &PgPool,
    reference: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("select id from workspaces where id = $1 or clerk_org_id = $1 limit 1")
        .bind(reference)
        .fetch_optional(master)
        .await
}

async fn find_by_idempotency_key(
    master: &PgPool,
    key: &str,
) -> Result<Option<(String, i32)>, sqlx::Error> {
    sqlx::query_as(
        "select id, balance_after from credit_transactions where idempotency_key = $1 limit 1",
    )
    .bind(key)
    .fetch_optional(master)
    .await
}

/// The first day of `month` (and the one after) at midnight UTC.
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

/// `getOrCreateWorkspaceCredits`: the wallet's balance, creating the row
/// (empty, this month's period) on first use.
async fn wallet_balance(master: &PgPool, workspace_id: &str) -> Result<i32, sqlx::Error> {
    let existing: Option<i32> = sqlx::query_scalar(
        "select current_balance from workspace_credits where workspace_id = $1 limit 1",
    )
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    if let Some(balance) = existing {
        return Ok(balance);
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
    let balance: Option<i32> = sqlx::query_scalar(
        "select current_balance from workspace_credits where workspace_id = $1 limit 1",
    )
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    Ok(balance.unwrap_or(0))
}

/// One ledger change.
#[derive(Debug, Clone)]
pub struct LedgerEntry<'a> {
    pub workspace_id: &'a str,
    pub amount: i64,
    pub service_type: Option<&'a str>,
    pub idempotency_key: Option<String>,
    pub reference_id: Option<&'a str>,
    pub reference_type: Option<&'a str>,
    pub description: Option<String>,
    pub metadata: Option<Value>,
}

/// What a consumption did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Consumed {
    Ok { transaction_id: String },
    Insufficient { current_balance: i64, required: i64 },
}

/// The ledger row; `None` when a concurrent call won the idempotency key.
async fn insert_transaction(
    master: &PgPool,
    entry: &LedgerEntry<'_>,
    kind: &str,
    amount: i64,
    balance_after: i32,
    description: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "insert into credit_transactions
             (id, workspace_id, type, amount, balance_after, service_type, reference_id,
              reference_type, idempotency_key, description, metadata)
         values ($1, $2, $3, $4::int, $5, $6, $7, $8, $9, $10, $11::jsonb)
         on conflict (idempotency_key) do nothing
         returning id",
    )
    .bind(generate_id("ctx"))
    .bind(entry.workspace_id)
    .bind(kind)
    .bind(amount)
    .bind(balance_after)
    .bind(entry.service_type)
    .bind(entry.reference_id)
    .bind(entry.reference_type)
    .bind(entry.idempotency_key.as_deref())
    .bind(description)
    .bind(entry.metadata.as_ref())
    .fetch_optional(master)
    .await
}

/// Undo a balance change after losing the idempotency race.
async fn compensate(master: &PgPool, workspace_id: &str, delta: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update workspace_credits set current_balance = current_balance + $2::int,
             updated_at = $3::timestamptz
         where workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(delta)
    .bind(iso_timestamp(OffsetDateTime::now_utc()))
    .execute(master)
    .await?;
    Ok(())
}

/// `consumeCredits`: take `amount` from the wallet unless that would
/// overdraw it, and record the consumption.
pub async fn consume_credits(
    master: &PgPool,
    entry: &LedgerEntry<'_>,
) -> Result<Consumed, CreditsError> {
    if entry.amount <= 0 {
        return Err(CreditsError::Invalid(format!(
            "[credits] amount must be a positive integer, got {}",
            entry.amount
        )));
    }
    if let Some(key) = &entry.idempotency_key
        && let Some((id, _)) = find_by_idempotency_key(master, key).await?
    {
        return Ok(Consumed::Ok { transaction_id: id });
    }
    let balance = wallet_balance(master, entry.workspace_id).await?;
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
    let Some(new_balance) = updated else {
        return Ok(Consumed::Insufficient {
            current_balance: i64::from(balance),
            required: entry.amount,
        });
    };
    let description = entry
        .description
        .clone()
        .unwrap_or_else(|| format!("{} consumption", entry.service_type.unwrap_or("undefined")));
    let inserted = insert_transaction(
        master,
        entry,
        "consumption",
        -entry.amount,
        new_balance,
        &description,
    )
    .await?;
    match (inserted, &entry.idempotency_key) {
        (Some(id), _) => Ok(Consumed::Ok { transaction_id: id }),
        (None, Some(key)) => {
            compensate(master, entry.workspace_id, entry.amount).await?;
            let winner = find_by_idempotency_key(master, key).await?;
            Ok(Consumed::Ok {
                transaction_id: winner.map(|(id, _)| id).unwrap_or_default(),
            })
        }
        (None, None) => Ok(Consumed::Ok {
            transaction_id: String::new(),
        }),
    }
}

/// `refundCredits` (`grantCredits` of type `refund`): give `amount` back
/// and record it. The transaction id.
pub async fn refund_credits(
    master: &PgPool,
    entry: &LedgerEntry<'_>,
) -> Result<String, CreditsError> {
    if entry.amount == 0 {
        return Err(CreditsError::Invalid(format!(
            "[credits] grant amount must be a non-zero integer, got {}",
            entry.amount
        )));
    }
    if entry.amount < 0 {
        return Err(CreditsError::Invalid(
            "[credits] negative grants are only allowed for adjustments (got type=refund)"
                .to_owned(),
        ));
    }
    if let Some(key) = &entry.idempotency_key
        && let Some((id, _)) = find_by_idempotency_key(master, key).await?
    {
        return Ok(id);
    }
    wallet_balance(master, entry.workspace_id).await?;
    let updated: Option<i32> = sqlx::query_scalar(
        "update workspace_credits set current_balance = current_balance + $2::int,
             updated_at = $3::timestamptz
         where workspace_id = $1
         returning current_balance",
    )
    .bind(entry.workspace_id)
    .bind(entry.amount)
    .bind(iso_timestamp(OffsetDateTime::now_utc()))
    .fetch_optional(master)
    .await?;
    let Some(new_balance) = updated else {
        return Err(CreditsError::Invalid(format!(
            "[credits] workspace_credits row missing for workspace {}",
            entry.workspace_id
        )));
    };
    let description = entry
        .description
        .clone()
        .unwrap_or_else(|| format!("refund of {} credits", entry.amount));
    let inserted = insert_transaction(
        master,
        entry,
        "refund",
        entry.amount,
        new_balance,
        &description,
    )
    .await?;
    match (inserted, &entry.idempotency_key) {
        (Some(id), _) => Ok(id),
        (None, Some(key)) => {
            compensate(master, entry.workspace_id, -entry.amount).await?;
            let winner = find_by_idempotency_key(master, key).await?;
            Ok(winner.map(|(id, _)| id).unwrap_or_default())
        }
        (None, None) => Ok(String::new()),
    }
}
