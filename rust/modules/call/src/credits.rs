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

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, QueryFilter,
    QuerySelect,
};
use serde_json::{Value, json};
use time::{Month, OffsetDateTime};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_schema::master::{credit_transactions as ledger, workspace_credits as wallets};
use weldsuite_schema::master::workspaces;

/// `SERVICE_CREDIT_RATES.voipCallPerMinute`.
pub(crate) const VOIP_CALL_PER_MINUTE: i64 = 3;

/// `resolveInternalWorkspaceId`: `workspaces.id` from either id of a
/// workspace.
pub(crate) async fn resolve_workspace(
    master: &PgPool,
    reference: &str,
) -> Result<Option<String>, DbErr> {
    workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .filter(
            Condition::any()
                .add(workspaces::Column::Id.eq(reference))
                .add(workspaces::Column::ClerkOrgId.eq(reference)),
        )
        .limit(1)
        .into_tuple()
        .one(&orm(master))
        .await
}

async fn find_by_key(master: &DatabaseConnection, key: &str) -> Result<Option<String>, DbErr> {
    ledger::Entity::find()
        .select_only()
        .column(ledger::Column::Id)
        .filter(ledger::Column::IdempotencyKey.eq(key))
        .limit(1)
        .into_tuple()
        .one(master)
        .await
}

/// This month's period, midnight UTC on the first to the first of the next.
fn period(now: OffsetDateTime) -> (OffsetDateTime, OffsetDateTime) {
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
    (start, end)
}

/// `new Date()` as Drizzle writes it to a `timestamptz` column (UTC, to the
/// millisecond).
fn now_tz() -> OffsetDateTime {
    utc_now().assume_utc()
}

/// An amount as the statements bind it, `$n::int`: out of range fails as
/// the cast did.
fn int(amount: i64) -> Result<i32, DbErr> {
    i32::try_from(amount).map_err(|_| DbErr::Custom("integer out of range".to_owned()))
}

/// `getOrCreateWorkspaceCredits`: the balance, creating the empty wallet on
/// first use.
async fn balance(master: &DatabaseConnection, workspace_id: &str) -> Result<i64, DbErr> {
    let read = || {
        wallets::Entity::find()
            .select_only()
            .column(wallets::Column::CurrentBalance)
            .filter(wallets::Column::WorkspaceId.eq(workspace_id))
            .limit(1)
            .into_tuple::<i32>()
    };
    if let Some(balance) = read().one(master).await? {
        return Ok(i64::from(balance));
    }
    let (start, end) = period(OffsetDateTime::now_utc());
    wallets::Entity::insert(wallets::ActiveModel {
        id: Set(generate_id("wcr")),
        workspace_id: Set(workspace_id.to_owned()),
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
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(master)
    .await?;
    Ok(read().one(master).await?.map_or(0, i64::from))
}

/// `checkCredits(db, workspaceId, amount)`: `(available, currentBalance)`.
pub(crate) async fn check(
    master: &PgPool,
    workspace_id: &str,
    amount: i64,
) -> Result<(bool, i64), DbErr> {
    let current = balance(&orm(master), workspace_id).await?;
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

/// The ledger row, unless the idempotency key is taken (`on conflict
/// (idempotency_key) do nothing`): its id, or `None`.
async fn insert(
    master: &DatabaseConnection,
    entry: &Entry<'_>,
    kind: &str,
    amount: i64,
    balance_after: i32,
) -> Result<Option<String>, DbErr> {
    let id = generate_id("ctx");
    let inserted = ledger::Entity::insert(ledger::ActiveModel {
        id: Set(id.clone()),
        workspace_id: Set(entry.workspace_id.to_owned()),
        type_: Set(kind.to_owned()),
        amount: Set(int(amount)?),
        balance_after: Set(balance_after),
        service_type: Set(Some("voip_call".to_owned())),
        reference_id: Set(Some(entry.reference_id.to_owned())),
        reference_type: Set(Some("voip_call".to_owned())),
        idempotency_key: Set(Some(entry.idempotency_key.clone())),
        description: Set(Some(entry.description.clone())),
        metadata: Set(Some(entry.metadata.clone())),
        user_id: Set(entry.user_id.map(str::to_owned)),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::column(ledger::Column::IdempotencyKey)
            .do_nothing()
            .to_owned(),
    )
    .exec_without_returning(master)
    .await?;
    Ok((inserted > 0).then_some(id))
}

/// The balance changed by `delta`, only while it is at least `covers` when
/// given: the balance after, or `None` when no wallet row matched.
async fn change(
    master: &DatabaseConnection,
    workspace_id: &str,
    delta: i64,
    covers: Option<i64>,
) -> Result<Option<i32>, DbErr> {
    let mut update = wallets::Entity::update_many()
        .col_expr(
            wallets::Column::CurrentBalance,
            sea_orm::ExprTrait::add(Expr::col(wallets::Column::CurrentBalance), int(delta)?),
        )
        .col_expr(wallets::Column::UpdatedAt, Expr::value(now_tz()))
        .filter(wallets::Column::WorkspaceId.eq(workspace_id));
    if let Some(amount) = covers {
        update = update.filter(wallets::Column::CurrentBalance.gte(int(amount)?));
    }
    let updated = update.exec_with_returning(master).await?;
    Ok(updated.first().map(|wallet| wallet.current_balance))
}

async fn add(
    master: &DatabaseConnection,
    workspace_id: &str,
    delta: i64,
) -> Result<Option<i32>, DbErr> {
    change(master, workspace_id, delta, None).await
}

/// `consumeCredits`: the transaction id, or `None` when the wallet can't
/// cover it.
pub(crate) async fn consume(master: &PgPool, entry: &Entry<'_>) -> Result<Option<String>, DbErr> {
    let master = &orm(master);
    if let Some(id) = find_by_key(master, &entry.idempotency_key).await? {
        return Ok(Some(id));
    }
    balance(master, entry.workspace_id).await?;
    // The conditional decrement: a wallet that can't cover it stays as it is.
    let Some(after) = change(
        master,
        entry.workspace_id,
        -entry.amount,
        Some(entry.amount),
    )
    .await?
    else {
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
    let master = &orm(master);
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
