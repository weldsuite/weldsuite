//! The wallet writes of a Mollie top-up: the purchase a paid payment grants,
//! and the clawback of a payment refunded or charged back in full. The same
//! rows `grantCredits` writes for Global's Stripe top-ups
//! (`packages/core/credits/src/index.ts`, called by
//! `billing-worker/src/routes/webhooks.ts`: `handleCreditTopupCheckout` and
//! `handleChargeRefunded`): the master `workspace_credits` balance and one
//! `credit_transactions` row, deduplicated on its idempotency key.
//!
//! Each write runs in one transaction (the TypeScript code on neon-http has
//! none and compensates instead): the balance change and the ledger row
//! commit together, and a second delivery of the same payment, even a
//! concurrent one, finds the key taken and changes nothing.
//!
//! The wallet's other writes (consumption, refunds) are
//! `weldsuite_social_domain::credits`, moving to `weldsuite-core-domain`; this
//! grant moves next to them once that wallet takes a typed grant.

use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use super::mollie::Money;

/// What a paid payment buys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Purchase {
    /// Mollie's `tr_…`.
    pub payment_id: String,
    /// The checkout that created it (`ctp_…`).
    pub checkout_id: Option<String>,
    pub workspace_id: String,
    pub package_id: Option<String>,
    /// Who started the checkout.
    pub user_id: Option<String>,
    /// The credits quoted at checkout.
    pub credits: i64,
    /// What was paid.
    pub amount: Money,
}

impl Purchase {
    /// The idempotency key of its ledger row: one grant per payment.
    pub fn idempotency_key(&self) -> String {
        purchase_key(&self.payment_id)
    }
}

/// `mollie_payment:tr_…`.
pub fn purchase_key(payment_id: &str) -> String {
    format!("mollie_payment:{payment_id}")
}

/// `mollie_reversal:tr_…`.
pub fn reversal_key(payment_id: &str) -> String {
    format!("mollie_reversal:{payment_id}")
}

/// What a write did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Applied {
    /// Written: the ledger row and the balance after it.
    New {
        transaction_id: String,
        balance_after: i64,
    },
    /// The key was taken already: nothing changed.
    Duplicate,
    /// The workspace is gone: nothing to credit.
    NoWorkspace,
}

/// One ledger row and its balance change.
struct Entry<'a> {
    workspace_id: &'a str,
    kind: &'static str,
    amount: i64,
    idempotency_key: String,
    reference_id: Option<String>,
    reference_type: &'static str,
    amount_paid: Option<String>,
    currency: Option<String>,
    description: String,
    metadata: Value,
    user_id: Option<&'a str>,
}

/// The first instants of this UTC month and the next, for a new wallet row.
fn period(now: OffsetDateTime) -> (String, String) {
    let start = now.date().replace_day(1).unwrap_or(now.date());
    let next = start
        .checked_add(time::Duration::days(32))
        .and_then(|date| date.replace_day(1).ok())
        .unwrap_or(start);
    let iso = |date: time::Date| {
        format!(
            "{:04}-{:02}-01T00:00:00.000Z",
            date.year(),
            u8::from(date.month())
        )
    };
    (iso(start), iso(next))
}

async fn apply(master: &PgPool, entry: &Entry<'_>) -> Result<Applied, sqlx::Error> {
    let mut tx = master.begin().await?;
    let taken: Option<String> =
        sqlx::query_scalar("select id from credit_transactions where idempotency_key = $1 limit 1")
            .bind(&entry.idempotency_key)
            .fetch_optional(&mut *tx)
            .await?;
    if taken.is_some() {
        tx.rollback().await?;
        return Ok(Applied::Duplicate);
    }
    let workspace: Option<String> =
        sqlx::query_scalar("select id from workspaces where id = $1 limit 1")
            .bind(entry.workspace_id)
            .fetch_optional(&mut *tx)
            .await?;
    if workspace.is_none() {
        tx.rollback().await?;
        return Ok(Applied::NoWorkspace);
    }
    // `getOrCreateWorkspaceCredits`: an empty wallet for this month first.
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
    .bind(entry.workspace_id)
    .bind(&start)
    .bind(&end)
    .execute(&mut *tx)
    .await?;
    // A clawback may take the balance below zero: visible debt beats hidden
    // loss (`handleChargeRefunded`).
    let balance: i32 = sqlx::query_scalar(
        "update workspace_credits set current_balance = current_balance + $2::int,
             updated_at = now()
         where workspace_id = $1
         returning current_balance",
    )
    .bind(entry.workspace_id)
    .bind(entry.amount)
    .fetch_one(&mut *tx)
    .await?;
    let inserted: Option<String> = sqlx::query_scalar(
        "insert into credit_transactions
             (id, workspace_id, type, amount, balance_after, reference_id, reference_type,
              idempotency_key, amount_paid, currency, description, metadata, user_id)
         values ($1, $2, $3, $4::int, $5, $6, $7, $8, $9::numeric, $10, $11, $12::jsonb, $13)
         on conflict (idempotency_key) do nothing
         returning id",
    )
    .bind(generate_id("ctx"))
    .bind(entry.workspace_id)
    .bind(entry.kind)
    .bind(entry.amount)
    .bind(balance)
    .bind(entry.reference_id.as_deref())
    .bind(entry.reference_type)
    .bind(&entry.idempotency_key)
    .bind(entry.amount_paid.as_deref())
    .bind(entry.currency.as_deref())
    .bind(&entry.description)
    .bind(&entry.metadata)
    .bind(entry.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(transaction_id) = inserted {
        tx.commit().await?;
        Ok(Applied::New {
            transaction_id,
            balance_after: i64::from(balance),
        })
    } else {
        // A concurrent delivery committed the key first: undo ours.
        tx.rollback().await?;
        Ok(Applied::Duplicate)
    }
}

/// `grantCredits({ type: 'purchase', idempotencyKey })` for a paid payment:
/// the credits quoted at checkout, once per payment.
pub async fn grant_purchase(master: &PgPool, purchase: &Purchase) -> Result<Applied, sqlx::Error> {
    let mut metadata = json!({
        "provider": "mollie",
        "paymentId": purchase.payment_id,
    });
    if let Some(package) = &purchase.package_id {
        metadata["packageId"] = json!(package);
    }
    if let Some(checkout) = &purchase.checkout_id {
        metadata["checkoutId"] = json!(checkout);
    }
    apply(
        master,
        &Entry {
            workspace_id: &purchase.workspace_id,
            kind: "purchase",
            amount: purchase.credits,
            idempotency_key: purchase.idempotency_key(),
            // `packageId?.slice(0, 30)`.
            reference_id: purchase
                .package_id
                .as_ref()
                .map(|id| id.chars().take(30).collect()),
            reference_type: "credit_package",
            amount_paid: Some(purchase.amount.value()),
            currency: Some(purchase.amount.currency.clone()),
            description: format!("Credit topup: +{} credits", purchase.credits),
            metadata,
            user_id: purchase.user_id.as_deref(),
        },
    )
    .await
}

/// What a reversal did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reversed {
    /// The purchase's credits were taken back.
    ClawedBack(Applied),
    /// Nothing was granted for the payment, so nothing is taken back.
    NothingGranted,
}

/// A payment refunded or charged back in full: the credits it granted are
/// taken back (`handleChargeRefunded`'s clawback), once.
pub async fn reverse_purchase(master: &PgPool, payment_id: &str) -> Result<Reversed, sqlx::Error> {
    let purchase: Option<(String, String, i32)> = sqlx::query_as(
        "select id, workspace_id, amount from credit_transactions
         where idempotency_key = $1 and type = 'purchase' limit 1",
    )
    .bind(purchase_key(payment_id))
    .fetch_optional(master)
    .await?;
    let Some((transaction_id, workspace_id, amount)) =
        purchase.filter(|(_, _, amount)| *amount > 0)
    else {
        return Ok(Reversed::NothingGranted);
    };
    let applied = apply(
        master,
        &Entry {
            workspace_id: &workspace_id,
            kind: "adjustment",
            amount: -i64::from(amount),
            idempotency_key: reversal_key(payment_id),
            reference_id: Some(transaction_id.clone()),
            reference_type: "credit_transaction",
            amount_paid: None,
            currency: None,
            description: format!("Topup refunded — clawback of {amount} credits"),
            metadata: json!({
                "provider": "mollie",
                "paymentId": payment_id,
                "purchaseTransactionId": transaction_id,
            }),
            user_id: None,
        },
    )
    .await?;
    Ok(Reversed::ClawedBack(applied))
}

/// The credits a checkout granted, once its payment was settled.
pub async fn granted_for_checkout(
    master: &PgPool,
    workspace_id: &str,
    checkout_id: &str,
) -> Result<Option<i64>, sqlx::Error> {
    let amount: Option<i32> = sqlx::query_scalar(
        "select amount from credit_transactions
         where workspace_id = $1 and type = 'purchase' and metadata->>'checkoutId' = $2
         limit 1",
    )
    .bind(workspace_id)
    .bind(checkout_id)
    .fetch_optional(master)
    .await?;
    Ok(amount.map(i64::from))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_wallets_start_this_calendar_month() {
        let at = |text: &str| {
            let format = time::macros::format_description!("[year]-[month]-[day]");
            time::Date::parse(text, format)
                .expect("a date")
                .midnight()
                .assume_utc()
        };
        assert_eq!(
            period(at("2026-11-13")),
            (
                "2026-11-01T00:00:00.000Z".to_owned(),
                "2026-12-01T00:00:00.000Z".to_owned()
            )
        );
        assert_eq!(period(at("2026-12-31")).1, "2027-01-01T00:00:00.000Z");
        assert_eq!(period(at("2027-01-31")).1, "2027-02-01T00:00:00.000Z");
    }

    #[test]
    fn keys_name_the_payment() {
        assert_eq!(purchase_key("tr_1"), "mollie_payment:tr_1");
        assert_eq!(reversal_key("tr_1"), "mollie_reversal:tr_1");
    }
}
