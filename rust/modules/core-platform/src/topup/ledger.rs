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

use std::str::FromStr;

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::{OrmConn, PgPool, orm, orm_error};
use weldsuite_kit::generate_id;
use weldsuite_schema::master::{credit_transactions, workspace_credits, workspaces};

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
fn period(now: OffsetDateTime) -> (OffsetDateTime, OffsetDateTime) {
    let start = now.date().replace_day(1).unwrap_or(now.date());
    let next = start
        .checked_add(time::Duration::days(32))
        .and_then(|date| date.replace_day(1).ok())
        .unwrap_or(start);
    (start.midnight().assume_utc(), next.midnight().assume_utc())
}

/// Runs `entry` in one transaction: committed when its ledger row was
/// written, rolled back otherwise (a duplicate, no workspace, an error).
async fn apply(master: &PgPool, entry: &Entry<'_>) -> Result<Applied, DbErr> {
    let mut tx = master.begin().await.map_err(orm_error)?;
    let applied = write(&OrmConn::new(&mut tx), entry).await?;
    if matches!(applied, Applied::New { .. }) {
        tx.commit().await.map_err(orm_error)?;
    } else {
        tx.rollback().await.map_err(orm_error)?;
    }
    Ok(applied)
}

/// The statements of [`apply`], in order, on its transaction.
async fn write(tx: &impl ConnectionTrait, entry: &Entry<'_>) -> Result<Applied, DbErr> {
    let taken: Option<String> = credit_transactions::Entity::find()
        .select_only()
        .column(credit_transactions::Column::Id)
        .filter(credit_transactions::Column::IdempotencyKey.eq(&entry.idempotency_key))
        .into_tuple()
        .one(tx)
        .await?;
    if taken.is_some() {
        return Ok(Applied::Duplicate);
    }
    let workspace: Option<String> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .filter(workspaces::Column::Id.eq(entry.workspace_id))
        .into_tuple()
        .one(tx)
        .await?;
    if workspace.is_none() {
        return Ok(Applied::NoWorkspace);
    }
    // `getOrCreateWorkspaceCredits`: an empty wallet for this month first.
    let (start, end) = period(OffsetDateTime::now_utc());
    let wallet = workspace_credits::ActiveModel {
        id: Set(generate_id("wcr")),
        workspace_id: Set(entry.workspace_id.to_owned()),
        current_balance: Set(0),
        plan_credits: Set(0),
        subscribed_credits: Set(0),
        monthly_allocation: Set(0),
        rolled_over_credits: Set(0),
        rollover_cap: Set(None),
        period_start: Set(start),
        period_end: Set(end),
        last_reset_at: Set(None),
        ..Default::default()
    };
    workspace_credits::Entity::insert(wallet)
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(tx)
        .await?;
    // A clawback may take the balance below zero: visible debt beats hidden
    // loss (`handleChargeRefunded`).
    let balance = workspace_credits::Entity::update_many()
        .col_expr(
            workspace_credits::Column::CurrentBalance,
            sea_orm::ExprTrait::add(
                Expr::col(workspace_credits::Column::CurrentBalance),
                sea_orm::ExprTrait::cast_as(Expr::value(entry.amount), "int"),
            ),
        )
        .col_expr(
            workspace_credits::Column::UpdatedAt,
            Expr::current_timestamp(),
        )
        .filter(workspace_credits::Column::WorkspaceId.eq(entry.workspace_id))
        .exec_with_returning(tx)
        .await?
        .into_iter()
        .next()
        .map(|wallet| wallet.current_balance)
        .ok_or_else(|| DbErr::RecordNotFound("workspace_credits".to_owned()))?;
    let inserted = credit_transactions::Entity::insert(ledger_row(entry, balance)?)
        .on_conflict(
            OnConflict::column(credit_transactions::Column::IdempotencyKey)
                .do_nothing()
                .to_owned(),
        )
        .try_insert()
        .exec(tx)
        .await?;
    match inserted {
        sea_orm::TryInsertResult::Inserted(row) => Ok(Applied::New {
            transaction_id: row.last_insert_id,
            balance_after: i64::from(balance),
        }),
        // A concurrent delivery committed the key first: undo ours.
        sea_orm::TryInsertResult::Empty | sea_orm::TryInsertResult::Conflicted => {
            Ok(Applied::Duplicate)
        }
    }
}

/// The `credit_transactions` row of `entry`, after the balance it left.
fn ledger_row(entry: &Entry<'_>, balance: i32) -> Result<credit_transactions::ActiveModel, DbErr> {
    // The balance update cast the amount to `int` already.
    let amount = i32::try_from(entry.amount).map_err(|error| DbErr::Custom(error.to_string()))?;
    let amount_paid = entry
        .amount_paid
        .as_deref()
        .map(BigDecimal::from_str)
        .transpose()
        .map_err(|error| DbErr::Custom(error.to_string()))?;
    Ok(credit_transactions::ActiveModel {
        id: Set(generate_id("ctx")),
        workspace_id: Set(entry.workspace_id.to_owned()),
        type_: Set(entry.kind.to_owned()),
        amount: Set(amount),
        balance_after: Set(balance),
        reference_id: Set(entry.reference_id.clone()),
        reference_type: Set(Some(entry.reference_type.to_owned())),
        idempotency_key: Set(Some(entry.idempotency_key.clone())),
        amount_paid: Set(amount_paid),
        currency: Set(entry.currency.clone()),
        description: Set(Some(entry.description.clone())),
        metadata: Set(Some(entry.metadata.clone())),
        user_id: Set(entry.user_id.map(str::to_owned)),
        ..Default::default()
    })
}

/// `grantCredits({ type: 'purchase', idempotencyKey })` for a paid payment:
/// the credits quoted at checkout, once per payment.
pub async fn grant_purchase(master: &PgPool, purchase: &Purchase) -> Result<Applied, DbErr> {
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
pub async fn reverse_purchase(master: &PgPool, payment_id: &str) -> Result<Reversed, DbErr> {
    let purchase: Option<(String, String, i32)> = credit_transactions::Entity::find()
        .select_only()
        .columns([
            credit_transactions::Column::Id,
            credit_transactions::Column::WorkspaceId,
            credit_transactions::Column::Amount,
        ])
        .filter(credit_transactions::Column::IdempotencyKey.eq(purchase_key(payment_id)))
        .filter(credit_transactions::Column::Type.eq("purchase"))
        .into_tuple()
        .one(&orm(master))
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
) -> Result<Option<i64>, DbErr> {
    use sea_orm::sea_query::extension::postgres::PgExpr;
    let checkout = sea_orm::ExprTrait::eq(
        PgExpr::cast_json_field(
            Expr::col(credit_transactions::Column::Metadata),
            "checkoutId",
        ),
        checkout_id,
    );
    let amount: Option<i32> = credit_transactions::Entity::find()
        .select_only()
        .column(credit_transactions::Column::Amount)
        .filter(credit_transactions::Column::WorkspaceId.eq(workspace_id))
        .filter(credit_transactions::Column::Type.eq("purchase"))
        .filter(checkout)
        .into_tuple()
        .one(&orm(master))
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
        let iso = weldsuite_events::iso_timestamp;
        let (start, end) = period(at("2026-11-13"));
        assert_eq!(
            (iso(start), iso(end)),
            (
                "2026-11-01T00:00:00.000Z".to_owned(),
                "2026-12-01T00:00:00.000Z".to_owned()
            )
        );
        assert_eq!(iso(period(at("2026-12-31")).1), "2027-01-01T00:00:00.000Z");
        assert_eq!(iso(period(at("2027-01-31")).1), "2027-02-01T00:00:00.000Z");
    }

    #[test]
    fn keys_name_the_payment() {
        assert_eq!(purchase_key("tr_1"), "mollie_payment:tr_1");
        assert_eq!(reversal_key("tr_1"), "mollie_reversal:tr_1");
    }
}
