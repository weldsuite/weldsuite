//! The prepaid credits wallet (`@weldsuite/credits`): the master database's
//! `workspace_credits` row and its `credit_transactions` ledger, scoped by
//! `workspaces.id`. Social publishing, calls, meetings, WeldMerge and AI
//! (`weldsuite-ai`'s billing) meter against it; the writes moved here from
//! `weldsuite-social-domain`, which still re-exports them.
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

impl std::error::Error for CreditsError {}

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

/// What [`check_credits`] found (`CheckCreditsResult`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreditCheck {
    pub available: bool,
    pub current_balance: i64,
    pub required: i64,
    /// `required - current_balance` when not available, else 0.
    pub shortfall: i64,
}

impl CreditCheck {
    /// The verdict for a wallet holding `current_balance` asked for `required`.
    pub fn of(current_balance: i64, required: i64) -> Self {
        let available = current_balance >= required;
        Self {
            available,
            current_balance,
            required,
            shortfall: if available {
                0
            } else {
                required - current_balance
            },
        }
    }
}

/// The type of a [`grant_credits`] ledger row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantKind {
    /// Credits given back for a consumption that didn't happen.
    Refund,
    /// A correction; the only kind that may be negative (a charge the wallet
    /// couldn't cover, booked as debt).
    Adjustment,
    /// Credits given for free (onboarding, support).
    Bonus,
}

impl GrantKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Refund => "refund",
            Self::Adjustment => "adjustment",
            Self::Bonus => "bonus",
        }
    }
}

/// The ledger row; `None` when a concurrent call won the idempotency key.
async fn insert_transaction(
    master: &PgPool,
    entry: &LedgerEntry<'_>,
    kind: &str,
    amount: i64,
    balance_after: i32,
    description: &str,
    user_id: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "insert into credit_transactions
             (id, workspace_id, type, amount, balance_after, service_type, reference_id,
              reference_type, idempotency_key, description, metadata, user_id)
         values ($1, $2, $3, $4::int, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
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
    .bind(user_id)
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

/// `checkCredits`: whether the wallet holds at least `amount`, creating the
/// empty wallet on first use.
pub async fn check_credits(
    master: &PgPool,
    workspace_id: &str,
    amount: i64,
) -> Result<CreditCheck, CreditsError> {
    if amount <= 0 {
        return Err(CreditsError::Invalid(format!(
            "[credits] amount must be a positive integer, got {amount}"
        )));
    }
    let balance = wallet_balance(master, workspace_id).await?;
    Ok(CreditCheck::of(i64::from(balance), amount))
}

/// `consumeCredits`: take `amount` from the wallet unless that would
/// overdraw it, and record the consumption.
pub async fn consume_credits(
    master: &PgPool,
    entry: &LedgerEntry<'_>,
) -> Result<Consumed, CreditsError> {
    consume_credits_by(master, entry, None).await
}

/// [`consume_credits`], recording the member who caused it (`userId`).
pub async fn consume_credits_by(
    master: &PgPool,
    entry: &LedgerEntry<'_>,
    user_id: Option<&str>,
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
        user_id,
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

/// `grantCredits`: add `amount` to the wallet (or, for an
/// [`GrantKind::Adjustment`], take it: a negative amount books debt, letting
/// the balance go below zero) and record it. The transaction id.
pub async fn grant_credits(
    master: &PgPool,
    entry: &LedgerEntry<'_>,
    kind: GrantKind,
    user_id: Option<&str>,
) -> Result<String, CreditsError> {
    if entry.amount == 0 {
        return Err(CreditsError::Invalid(format!(
            "[credits] grant amount must be a non-zero integer, got {}",
            entry.amount
        )));
    }
    if entry.amount < 0 && kind != GrantKind::Adjustment {
        return Err(CreditsError::Invalid(format!(
            "[credits] negative grants are only allowed for adjustments (got type={})",
            kind.as_str()
        )));
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
        .unwrap_or_else(|| format!("{} of {} credits", kind.as_str(), entry.amount));
    let inserted = insert_transaction(
        master,
        entry,
        kind.as_str(),
        entry.amount,
        new_balance,
        &description,
        user_id,
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

/// `refundCredits` (`grantCredits` of type `refund`): give `amount` back
/// and record it. The transaction id.
pub async fn refund_credits(
    master: &PgPool,
    entry: &LedgerEntry<'_>,
) -> Result<String, CreditsError> {
    grant_credits(master, entry, GrantKind::Refund, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_reports_the_shortfall() {
        assert_eq!(
            CreditCheck::of(3, 1),
            CreditCheck {
                available: true,
                current_balance: 3,
                required: 1,
                shortfall: 0
            }
        );
        assert_eq!(
            CreditCheck::of(-4, 1),
            CreditCheck {
                available: false,
                current_balance: -4,
                required: 1,
                shortfall: 5
            }
        );
    }

    #[test]
    fn the_period_runs_to_the_first_of_next_month() {
        let december = time::Date::from_calendar_date(2026, Month::December, 14)
            .expect("date")
            .midnight()
            .assume_utc();
        let (start, end) = period(december);
        assert_eq!(start, "2026-12-01T00:00:00.000Z");
        assert_eq!(end, "2027-01-01T00:00:00.000Z");
    }

    #[test]
    fn grant_kinds_name_the_ledger_types() {
        assert_eq!(GrantKind::Refund.as_str(), "refund");
        assert_eq!(GrantKind::Adjustment.as_str(), "adjustment");
        assert_eq!(GrantKind::Bonus.as_str(), "bonus");
    }
}
