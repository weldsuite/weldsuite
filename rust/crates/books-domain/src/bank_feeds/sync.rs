//! Sync one bank connection into the books (`services/bank-feeds/sync.ts`):
//! posted transactions become unreconciled `bank_transactions` (source
//! `feed`), pending ones stay in `bank_feed_pending_transactions`, removals
//! soft-delete what is still unreconciled, balances land on the bank accounts.
//!
//! Idempotent by construction: a run that dies half way is run again from the
//! last stored cursor. Rows are unique on (bank account, provider, provider
//! transaction id); a lock in the connection's metadata keeps two runs from
//! overlapping.

use std::collections::HashMap;
use std::str::FromStr;

use sea_orm::ActiveValue::Set;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use time::{Date, PrimitiveDateTime};
use weldsuite_db::{OrmConn, PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    bank_accounts, bank_connections, bank_feed_pending_transactions as pending, bank_transactions,
};

use super::connections::{load_connection, stored_feed_accounts, stored_warnings, to_stored};
use super::normalize::{
    PendingCandidate, add_days, connection_status, match_pending_to_posted, minor_to_decimal,
    normalize_description, text_to_minor, transaction_fingerprint,
};
use super::{
    FeedContext, FeedError, FeedTransaction, INACTIVE_STATUSES, MAX_WARNINGS, Provider,
    SYNC_LOCK_MINUTES, ServiceError, StoredConnection, SyncResult, instant, js, now_both, stamp,
};
use crate::js::{iso_from_millis, millis_of, slice_utf16};
use crate::tables::BANK_TRANSACTIONS;

const ID_CHUNK: usize = 400;
const MAX_PAGES: usize = 200;
const MAX_RESTARTS: usize = 3;

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `SyncOutcome`.
#[derive(Debug, Clone, Default)]
pub struct SyncOutcome {
    pub connection_id: String,
    pub status: String,
    /// `not_found`, `not_active`, `in_progress` or `no_mapped_accounts`.
    pub skipped: Option<&'static str>,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub pending: usize,
    pub pending_voided: usize,
    pub possible_duplicates: usize,
    pub auto_reconciled: usize,
    pub warnings: usize,
    pub error: Option<String>,
    /// A later retry can succeed (rate limit, outage).
    pub retryable: Option<bool>,
}

impl SyncOutcome {
    fn empty(connection_id: &str, status: &str) -> Self {
        Self {
            connection_id: connection_id.to_owned(),
            status: status.to_owned(),
            ..Self::default()
        }
    }

    fn skipped(connection_id: &str, status: &str, why: &'static str) -> Self {
        Self {
            skipped: Some(why),
            ..Self::empty(connection_id, status)
        }
    }

    /// As the worker serializes it (its key order).
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("connectionId".to_owned(), json!(self.connection_id));
        out.insert("status".to_owned(), json!(self.status));
        out.insert("added".to_owned(), json!(self.added));
        out.insert("updated".to_owned(), json!(self.updated));
        out.insert("removed".to_owned(), json!(self.removed));
        out.insert("pending".to_owned(), json!(self.pending));
        out.insert("pendingVoided".to_owned(), json!(self.pending_voided));
        out.insert(
            "possibleDuplicates".to_owned(),
            json!(self.possible_duplicates),
        );
        out.insert("autoReconciled".to_owned(), json!(self.auto_reconciled));
        out.insert("warnings".to_owned(), json!(self.warnings));
        if let Some(skipped) = self.skipped {
            out.insert("skipped".to_owned(), json!(skipped));
        }
        if let Some(error) = &self.error {
            out.insert("error".to_owned(), json!(error));
        }
        if let Some(retryable) = self.retryable {
            out.insert("retryable".to_owned(), json!(retryable));
        }
        Value::Object(out)
    }
}

fn day_of(date: &str) -> String {
    date.chars().take(10).collect()
}

fn start_of_day(date: &str) -> String {
    format!("{date}T00:00:00.000Z")
}

/// A feed date (`YYYY-MM-DD`) as the `date` column reads it; text Postgres
/// would not read is refused as it would refuse it.
fn feed_day(date: &str) -> Result<Date, DbErr> {
    Date::parse(
        date,
        time::macros::format_description!("[year]-[month]-[day]"),
    )
    .map_err(|_| DbErr::Type(format!("invalid input syntax for type date: \"{date}\"")))
}

/// A decimal amount as the `numeric` column reads it.
fn decimal(amount: &str) -> Result<BigDecimal, DbErr> {
    BigDecimal::from_str(amount).map_err(|error| DbErr::Type(error.to_string()))
}

/// `coalesce(metadata, '{}'::jsonb)`.
fn metadata_or_empty() -> Expr {
    Expr::expr(Func::coalesce([
        Expr::col(bank_connections::Column::Metadata),
        Expr::val(json!({})),
    ]))
}

/// `(coalesce(metadata, '{}'::jsonb) - 'syncLockUntil') || patch`: the
/// connection's metadata with `patch` merged in and the lock dropped.
fn unlocked_metadata(patch: Value) -> Expr {
    use sea_orm::ExprTrait as _;
    sea_orm::sea_query::extension::postgres::PgExpr::concat(
        metadata_or_empty().sub("syncLockUntil"),
        Expr::val(patch),
    )
}

// ── Lock ───────────────────────────────────────────────────────────────────

async fn acquire_lock(db: &PgPool, id: &str, at: &str) -> Result<bool, DbErr> {
    use sea_orm::ExprTrait as _;
    let until = iso_from_millis(millis_of(at).unwrap_or(0) + SYNC_LOCK_MINUTES * 60_000)
        .unwrap_or_default();
    // `jsonb_set(coalesce(metadata, '{}'::jsonb), '{syncLockUntil}', to_jsonb($2::text))`.
    let locked = Func::cust("jsonb_set")
        .arg(metadata_or_empty())
        .arg(Expr::val(vec!["syncLockUntil".to_owned()]))
        .arg(Expr::val(json!(until)));
    let lock_until = || {
        sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
            Expr::col(bank_connections::Column::Metadata),
            "syncLockUntil",
        )
    };
    let free = Condition::any().add(lock_until().is_null()).add(
        lock_until()
            .cast_as("timestamptz")
            .lt(Expr::val(instant(at)?)),
    );
    let done = bank_connections::Entity::update_many()
        .col_expr(bank_connections::Column::Metadata, Expr::expr(locked))
        .filter(
            Condition::all()
                .add(bank_connections::Column::Id.eq(id))
                .add(free),
        )
        .exec(&orm(db))
        .await?;
    Ok(done.rows_affected > 0)
}

/// `releasingMetadata(patch)`: merge `patch` and drop the lock in one
/// statement.
async fn release(db: &PgPool, id: &str, patch: &Value) -> Result<(), DbErr> {
    bank_connections::Entity::update_many()
        .col_expr(
            bank_connections::Column::Metadata,
            unlocked_metadata(patch.clone()),
        )
        .filter(bank_connections::Column::Id.eq(id))
        .exec(&orm(db))
        .await
        .map(|_| ())
}

// ── Page application ───────────────────────────────────────────────────────

/// An ordered map of the mapped bank accounts by feed account id
/// (`new Map(mapped.map(...))`: a later duplicate replaces the value, the
/// key keeps its place).
#[derive(Default)]
struct ByFeedId {
    keys: Vec<String>,
    accounts: HashMap<String, Value>,
}

impl ByFeedId {
    fn insert(&mut self, key: String, account: Value) {
        if !self.accounts.contains_key(&key) {
            self.keys.push(key.clone());
        }
        self.accounts.insert(key, account);
    }

    fn get(&self, key: &str) -> Option<&Value> {
        self.accounts.get(key)
    }

    fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.keys
            .iter()
            .filter_map(|k| self.accounts.get(k).map(|a| (k, a)))
    }
}

struct Run<'a> {
    provider: &'a Provider<'a>,
    connection_id: String,
    by_feed_id: ByFeedId,
    timestamp: String,
    /// `timestamp` as the columns hold it.
    stamp: PrimitiveDateTime,
    occurrences: HashMap<String, usize>,
    pending_pool: Option<Vec<PendingCandidate>>,
    warnings: Vec<Value>,
    /// Insertion-ordered set.
    touched_accounts: Vec<String>,
}

impl Run<'_> {
    fn touch(&mut self, account_id: &str) {
        if !self.touched_accounts.iter().any(|a| a == account_id) {
            self.touched_accounts.push(account_id.to_owned());
        }
    }
}

fn minor_of(amount: &str, currency: &str) -> Option<i64> {
    text_to_minor(amount, currency).ok()
}

fn needs_update(existing: &Value, tx: &FeedTransaction) -> bool {
    minor_of(text(existing, "amount").unwrap_or_default(), &tx.currency) != Some(tx.amount_minor)
        || day_of(text(existing, "date").unwrap_or_default()) != tx.date
        || text(existing, "description").unwrap_or_default() != tx.description
        || text(existing, "merchantName") != tx.merchant_name.as_deref()
        || text(existing, "checkNumber") != tx.check_number.as_deref()
}

async fn load_pending_pool(
    db: &PgPool,
    connection_id: &str,
) -> Result<Vec<PendingCandidate>, DbErr> {
    let rows = pending::Entity::find()
        .filter(pending::Column::ConnectionId.eq(connection_id))
        .filter(pending::Column::VoidedAt.is_null())
        .all(&orm(db))
        .await?
        .into_iter()
        .map(js)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .iter()
        .map(|r| PendingCandidate {
            id: text(r, "providerTransactionId")
                .unwrap_or_default()
                .to_owned(),
            account_id: text(r, "bankAccountId").unwrap_or_default().to_owned(),
            date: text(r, "date").unwrap_or_default().to_owned(),
            amount_minor: minor_of(
                text(r, "amount").unwrap_or_default(),
                text(r, "currency").unwrap_or_default(),
            )
            .unwrap_or(i64::MIN),
            description: text(r, "description").map(str::to_owned),
        })
        .collect())
}

/// The bank transactions of `account_ids` from `provider` with these
/// provider ids, as Drizzle returns them; `live_only` skips removed ones.
async fn feed_transactions(
    db: &PgPool,
    account_ids: &[String],
    provider_id: &str,
    ids: &[String],
    live_only: bool,
) -> Result<Vec<Value>, DbErr> {
    let mut condition = Condition::all()
        .add(bank_transactions::Column::BankAccountId.is_in(account_ids.iter().map(String::as_str)))
        .add(bank_transactions::Column::FeedProvider.eq(provider_id))
        .add(
            bank_transactions::Column::ProviderTransactionId.is_in(ids.iter().map(String::as_str)),
        );
    if live_only {
        condition = condition.add(bank_transactions::Column::DeletedAt.is_null());
    }
    bank_transactions::Entity::find()
        .filter(condition)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(js)
        .collect()
}

/// `insert … onConflictDoNothing()` of one bank transaction.
struct Insert {
    row: bank_transactions::ActiveModel,
    bank_account_id: String,
    first_fingerprint: String,
    day: Date,
}

/// A JSON value as `jsonb_populate_record` writes it to a `jsonb` column:
/// `null` is SQL `NULL`.
fn jsonb(value: Option<&Value>) -> Option<Value> {
    value.filter(|v| !v.is_null()).cloned()
}

/// `applyPage(db, run, page)`.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
async fn apply_page(
    db: &PgPool,
    run: &mut Run<'_>,
    outcome: &mut SyncOutcome,
    page: &SyncResult,
) -> Result<(), DbErr> {
    let provider_id = run.provider.id;
    let timestamp = run.timestamp.clone();
    let at = run.stamp;
    let mut account_ids: Vec<String> = Vec::new();
    for (_, account) in run.by_feed_id.iter() {
        let id = text(account, "id").unwrap_or_default().to_owned();
        if !account_ids.contains(&id) {
            account_ids.push(id);
        }
    }

    // The last version of an id in a page wins; an id also "removed" was just re-sent.
    let mut order: Vec<String> = Vec::new();
    let mut latest: HashMap<String, &FeedTransaction> = HashMap::new();
    for tx in &page.upserts {
        if latest
            .insert(tx.provider_transaction_id.clone(), tx)
            .is_none()
        {
            order.push(tx.provider_transaction_id.clone());
        }
    }
    let mut removal_ids: Vec<String> = Vec::new();
    for id in &page.removals {
        if !latest.contains_key(id) && !removal_ids.contains(id) {
            removal_ids.push(id.clone());
        }
    }

    let mut posted: Vec<(&FeedTransaction, Value)> = Vec::new();
    let mut pending_rows: Vec<pending::ActiveModel> = Vec::new();
    for id in &order {
        let tx = latest[id];
        let Some(account) = run.by_feed_id.get(&tx.account_id) else {
            continue;
        };
        if let Some(from) = text(account, "feedSyncFrom").filter(|f| !f.is_empty())
            && tx.date.as_str() < from
        {
            continue;
        }
        if tx.pending {
            pending_rows.push(pending::ActiveModel {
                id: Set(generate_id("bfp")),
                entity_id: Set(text(account, "entityId").unwrap_or_default().to_owned()),
                bank_account_id: Set(text(account, "id").unwrap_or_default().to_owned()),
                connection_id: Set(run.connection_id.clone()),
                provider: Set(provider_id.to_owned()),
                provider_transaction_id: Set(tx.provider_transaction_id.clone()),
                date: Set(feed_day(&tx.date)?),
                amount: Set(decimal(&minor_to_decimal(tx.amount_minor, &tx.currency))?),
                currency: Set(tx.currency.clone()),
                description: Set(Some(tx.description.clone())),
                merchant_name: Set(tx.merchant_name.clone()),
                created_at: Set(at),
                updated_at: Set(at),
                ..Default::default()
            });
        } else {
            posted.push((tx, account.clone()));
        }
    }

    // ── Posted transactions ──
    let posted_ids: Vec<String> = posted
        .iter()
        .map(|(tx, _)| tx.provider_transaction_id.clone())
        .collect();
    let mut existing_by_key: HashMap<String, Value> = HashMap::new();
    for ids in posted_ids.chunks(ID_CHUNK) {
        let rows = feed_transactions(db, &account_ids, provider_id, ids, false).await?;
        for row in rows {
            let key = format!(
                "{}|{}",
                text(&row, "bankAccountId").unwrap_or_default(),
                text(&row, "providerTransactionId").unwrap_or_default()
            );
            existing_by_key.insert(key, row);
        }
    }

    let mut inserts: Vec<Insert> = Vec::new();
    let mut updates: Vec<(String, Map<String, Value>)> = Vec::new();
    for (tx, account) in &posted {
        let account_id = text(account, "id").unwrap_or_default().to_owned();
        let description = normalize_description(Some(&tx.description));
        let occurrence_key = format!("{account_id}|{}|{}|{description}", tx.date, tx.amount_minor);
        let occurrence = run.occurrences.get(&occurrence_key).copied().unwrap_or(0);
        run.occurrences.insert(occurrence_key, occurrence + 1);
        let fingerprint =
            transaction_fingerprint(&tx.date, tx.amount_minor, &description, occurrence);
        let first_fingerprint = if occurrence == 0 {
            fingerprint.clone()
        } else {
            transaction_fingerprint(&tx.date, tx.amount_minor, &description, 0)
        };

        let mut fields = Map::new();
        for (key, value) in [
            ("date", json!(start_of_day(&tx.date))),
            ("description", json!(tx.description)),
            (
                "amount",
                json!(minor_to_decimal(tx.amount_minor, &tx.currency)),
            ),
            ("counterpartyName", json!(tx.merchant_name)),
            ("checkNumber", json!(tx.check_number)),
            ("merchantName", json!(tx.merchant_name)),
            ("feedCategory", tx.category.clone().unwrap_or(Value::Null)),
            ("rawData", tx.raw.clone()),
            ("fingerprint", json!(fingerprint)),
        ] {
            fields.insert(key.to_owned(), value);
        }

        match existing_by_key.get(&format!("{account_id}|{}", tx.provider_transaction_id)) {
            None => {
                let day = feed_day(&tx.date)?;
                let row = bank_transactions::ActiveModel {
                    id: Set(generate_id("bt")),
                    entity_id: Set(text(account, "entityId").unwrap_or_default().to_owned()),
                    bank_account_id: Set(account_id.clone()),
                    status: Set("unreconciled".to_owned()),
                    source: Set(Some("feed".to_owned())),
                    feed_provider: Set(Some(provider_id.to_owned())),
                    provider_transaction_id: Set(Some(tx.provider_transaction_id.clone())),
                    created_at: Set(at),
                    updated_at: Set(at),
                    date: Set(day.midnight()),
                    description: Set(Some(tx.description.clone())),
                    amount: Set(decimal(&minor_to_decimal(tx.amount_minor, &tx.currency))?),
                    counterparty_name: Set(tx.merchant_name.clone()),
                    check_number: Set(tx.check_number.clone()),
                    merchant_name: Set(tx.merchant_name.clone()),
                    feed_category: Set(jsonb(tx.category.as_ref())),
                    raw_data: Set(jsonb(Some(&tx.raw))),
                    fingerprint: Set(Some(fingerprint)),
                    ..Default::default()
                };
                inserts.push(Insert {
                    row,
                    bank_account_id: account_id,
                    first_fingerprint,
                    day,
                });
            }
            Some(existing) if existing.get("deletedAt").is_some_and(|d| !d.is_null()) => {
                // Removed earlier, sent again: bring it back as it is now.
                let mut values = fields;
                values.insert("deletedAt".to_owned(), Value::Null);
                values.insert("status".to_owned(), json!("unreconciled"));
                values.insert("updatedAt".to_owned(), json!(timestamp));
                updates.push((text(existing, "id").unwrap_or_default().to_owned(), values));
                run.touch(&account_id);
                outcome.updated += 1;
            }
            Some(existing)
                if text(existing, "status") == Some("unreconciled")
                    && text(existing, "journalEntryId").is_none_or(str::is_empty)
                    && needs_update(existing, tx) =>
            {
                // Still unreconciled: the bank changed the line, follow it.
                let mut values = fields;
                values.insert("updatedAt".to_owned(), json!(timestamp));
                updates.push((text(existing, "id").unwrap_or_default().to_owned(), values));
                outcome.updated += 1;
            }
            Some(_) => {}
        }
    }

    // Lines the same account already has from a file import: flag, never merge.
    if !inserts.is_empty() {
        let mut days: Vec<Date> = inserts.iter().map(|i| i.day).collect();
        days.sort_unstable();
        let mut insert_accounts: Vec<String> = Vec::new();
        for insert in &inserts {
            if !insert_accounts.contains(&insert.bank_account_id) {
                insert_accounts.push(insert.bank_account_id.clone());
            }
        }
        let last = days[days.len() - 1]
            .with_hms_milli(23, 59, 59, 999)
            .map_err(|error| DbErr::Type(error.to_string()))?;
        let candidates = bank_transactions::Entity::find()
            .filter(
                Condition::all()
                    .add(bank_transactions::Column::BankAccountId.is_in(insert_accounts))
                    .add(bank_transactions::Column::DeletedAt.is_null())
                    .add(
                        Condition::any()
                            .add(bank_transactions::Column::Source.is_null())
                            .add(bank_transactions::Column::Source.ne("feed")),
                    )
                    .add(bank_transactions::Column::Date.gte(days[0].midnight()))
                    .add(bank_transactions::Column::Date.lte(last)),
            )
            .all(&orm(db))
            .await?;
        let currency_of = |account_id: &str| -> String {
            run.by_feed_id
                .iter()
                .filter(|(_, a)| text(a, "id") == Some(account_id))
                .last()
                .and_then(|(_, a)| text(a, "currency").map(str::to_owned))
                .unwrap_or_else(|| "USD".to_owned())
        };
        let mut imported: HashMap<String, String> = HashMap::new();
        for candidate in candidates.into_iter().map(js) {
            let candidate = candidate?;
            let account_id = text(&candidate, "bankAccountId").unwrap_or_default();
            let fingerprint = text(&candidate, "fingerprint").map_or_else(
                || {
                    let currency = currency_of(account_id);
                    transaction_fingerprint(
                        &day_of(text(&candidate, "date").unwrap_or_default()),
                        minor_of(text(&candidate, "amount").unwrap_or_default(), &currency)
                            .unwrap_or(i64::MIN),
                        &normalize_description(text(&candidate, "description")),
                        0,
                    )
                },
                str::to_owned,
            );
            imported.insert(
                format!("{account_id}|{fingerprint}"),
                text(&candidate, "id").unwrap_or_default().to_owned(),
            );
        }
        for insert in &mut inserts {
            if let Some(duplicate) = imported
                .get(&format!(
                    "{}|{}",
                    insert.bank_account_id, insert.first_fingerprint
                ))
                .filter(|d| !d.is_empty())
            {
                insert.row.possible_duplicate_of_id = Set(Some(duplicate.clone()));
                outcome.possible_duplicates += 1;
            }
        }
    }
    for insert in &inserts {
        run.touch(&insert.bank_account_id);
    }
    outcome.added += inserts.len();
    outcome.pending += pending_rows.len();

    // A posted transaction replaces its pending row: by id, by the provider's
    // link, or (providers with neither) by amount, a ten day window and wording.
    let capabilities = run.provider.capabilities();
    let guess_pending = capabilities["changeCursor"] != json!(true)
        && capabilities["pendingTransactions"] == json!(true);
    let mut replaced: Vec<String> = Vec::new();
    let mut replace = |id: &str| {
        if !replaced.iter().any(|r| r == id) {
            replaced.push(id.to_owned());
        }
    };
    for (tx, account) in &posted {
        replace(&tx.provider_transaction_id);
        if let Some(link) = tx
            .pending_transaction_id
            .as_deref()
            .filter(|l| !l.is_empty())
        {
            replace(link);
        } else if guess_pending {
            if run.pending_pool.is_none() {
                run.pending_pool = Some(load_pending_pool(db, &run.connection_id).await?);
            }
            let pool = run.pending_pool.as_mut().expect("loaded above");
            let matched = match_pending_to_posted(
                text(account, "id").unwrap_or_default(),
                &tx.date,
                tx.amount_minor,
                &tx.description,
                pool,
            )
            .map(|m| m.id.clone());
            if let Some(id) = matched {
                replace(&id);
                pool.retain(|c| c.id != id);
            }
        }
    }
    let mut pending_deletes = replaced;
    pending_deletes.extend(removal_ids.iter().cloned());

    // ── Removals ──
    let mut soft_delete: Vec<String> = Vec::new();
    for ids in removal_ids.chunks(ID_CHUNK) {
        let rows = feed_transactions(db, &account_ids, provider_id, ids, true).await?;
        for row in rows {
            if text(&row, "status") == Some("unreconciled")
                && text(&row, "journalEntryId").is_none_or(str::is_empty)
            {
                soft_delete.push(text(&row, "id").unwrap_or_default().to_owned());
            } else {
                let mut warning = Map::new();
                warning.insert("at".to_owned(), json!(timestamp));
                warning.insert("code".to_owned(), json!("removed_reconciled"));
                warning.insert(
                    "message".to_owned(),
                    json!(
                        "The bank removed a transaction that is already reconciled; it was kept."
                    ),
                );
                if let Some(id) = text(&row, "providerTransactionId") {
                    warning.insert("providerTransactionId".to_owned(), json!(id));
                }
                warning.insert(
                    "bankTransactionId".to_owned(),
                    row.get("id").cloned().unwrap_or(Value::Null),
                );
                run.warnings.push(Value::Object(warning));
            }
        }
    }
    outcome.removed += soft_delete.len();

    if inserts.is_empty()
        && updates.is_empty()
        && pending_rows.is_empty()
        && pending_deletes.is_empty()
        && soft_delete.is_empty()
    {
        return Ok(());
    }
    let mut handle = db.begin().await.map_err(weldsuite_db::orm_error)?;
    {
        let conn = OrmConn::new(&mut handle);
        write_page(&conn, inserts, updates).await?;
        for row in pending_rows {
            pending::Entity::insert(row)
                .on_conflict(
                    OnConflict::columns([
                        pending::Column::Provider,
                        pending::Column::ProviderTransactionId,
                    ])
                    .update_columns([
                        pending::Column::BankAccountId,
                        pending::Column::Date,
                        pending::Column::Amount,
                        pending::Column::Currency,
                        pending::Column::Description,
                        pending::Column::MerchantName,
                    ])
                    .value(
                        pending::Column::VoidedAt,
                        Expr::val(Option::<PrimitiveDateTime>::None),
                    )
                    .value(pending::Column::UpdatedAt, Expr::val(at))
                    .to_owned(),
                )
                .exec_without_returning(&conn)
                .await?;
        }
        for ids in pending_deletes.chunks(ID_CHUNK) {
            pending::Entity::delete_many()
                .filter(pending::Column::Provider.eq(provider_id))
                .filter(
                    pending::Column::ProviderTransactionId.is_in(ids.iter().map(String::as_str)),
                )
                .exec(&conn)
                .await?;
        }
        for ids in soft_delete.chunks(ID_CHUNK) {
            bank_transactions::Entity::update_many()
                .col_expr(bank_transactions::Column::DeletedAt, Expr::val(at))
                .col_expr(bank_transactions::Column::UpdatedAt, Expr::val(at))
                .filter(bank_transactions::Column::Id.is_in(ids.iter().map(String::as_str)))
                .exec(&conn)
                .await?;
        }
    }
    handle.commit().await.map_err(weldsuite_db::orm_error)
}

/// The page's new bank transactions (a line already there is left alone)
/// and its changed ones, inside the page's transaction.
async fn write_page(
    conn: &OrmConn<'_>,
    inserts: Vec<Insert>,
    updates: Vec<(String, Map<String, Value>)>,
) -> Result<(), DbErr> {
    for insert in inserts {
        bank_transactions::Entity::insert(insert.row)
            .on_conflict(OnConflict::new().do_nothing().to_owned())
            .exec_without_returning(conn)
            .await?;
    }
    for (id, values) in updates {
        BANK_TRANSACTIONS
            .patch_raw_on(conn, &id, BANK_TRANSACTIONS.values(&values), false)
            .await?;
    }
    Ok(())
}

// ── Entry point ────────────────────────────────────────────────────────────

enum RunError {
    Feed(FeedError),
    Other(ServiceError),
}

impl From<DbErr> for RunError {
    fn from(error: DbErr) -> Self {
        Self::Other(ServiceError::Database(error))
    }
}

impl From<FeedError> for RunError {
    fn from(error: FeedError) -> Self {
        Self::Feed(error)
    }
}

/// `SyncOptions`.
#[derive(Debug, Clone, Default)]
pub struct SyncOptions {
    /// Ask the provider to fetch fresh data from the bank first ("sync now").
    pub refresh: bool,
    /// The member's IP address, for a refresh: Ponto synchronizes only with
    /// the customer present.
    pub customer_ip: Option<String>,
}

/// `syncConnection(ctx, connectionId, { refresh })`.
pub async fn sync_connection(
    ctx: &FeedContext,
    connection_id: &str,
    refresh: bool,
) -> Result<SyncOutcome, ServiceError> {
    sync_connection_with(
        ctx,
        connection_id,
        &SyncOptions {
            refresh,
            customer_ip: None,
        },
    )
    .await
}

/// `syncConnection(ctx, connectionId, options)`.
pub async fn sync_connection_with(
    ctx: &FeedContext,
    connection_id: &str,
    options: &SyncOptions,
) -> Result<SyncOutcome, ServiceError> {
    let Some(row) = load_connection(&ctx.db, connection_id).await? else {
        return Ok(SyncOutcome::skipped(
            connection_id,
            "disconnected",
            "not_found",
        ));
    };
    let status = text(&row, "status").unwrap_or_default().to_owned();
    if status == "disconnected" || status == "revoked" {
        return Ok(SyncOutcome::skipped(connection_id, &status, "not_active"));
    }
    let provider = match ctx.provider(text(&row, "provider").unwrap_or_default()) {
        Ok(provider) => provider,
        Err(error) => {
            return Ok(SyncOutcome {
                error: Some(error.message),
                ..SyncOutcome::empty(connection_id, &status)
            });
        }
    };
    let (timestamp, at) = now_both();
    let id = text(&row, "id").unwrap_or_default().to_owned();
    if !acquire_lock(&ctx.db, &id, &timestamp).await? {
        return Ok(SyncOutcome::skipped(connection_id, &status, "in_progress"));
    }
    let mut outcome = SyncOutcome::empty(connection_id, &status);
    let now = (timestamp.as_str(), at);
    match run_sync(ctx, &provider, &row, now, &mut outcome, options).await {
        Ok(()) => Ok(outcome),
        Err(RunError::Feed(error)) => {
            keep_rotated_credentials(ctx, &provider, &row).await;
            record_failure(ctx, &row, &error, at, outcome).await
        }
        Err(RunError::Other(error)) => {
            keep_rotated_credentials(ctx, &provider, &row).await;
            let _ = release(&ctx.db, &id, &json!({})).await;
            Err(error)
        }
    }
}

/// `keepRotatedCredentials`: credentials the provider rotated before the run
/// failed (Ponto's refresh token works once), stored, or the next sync could
/// not sign in and the connection would wrongly ask for a reconnect.
async fn keep_rotated_credentials(ctx: &FeedContext, provider: &Provider<'_>, row: &Value) {
    let Some(credentials) =
        provider.pending_credentials(text(row, "providerConnectionId").unwrap_or_default())
    else {
        return;
    };
    let id = text(row, "id").unwrap_or_default();
    let stored = match ctx.seal(&credentials) {
        Ok(sealed) => bank_connections::Entity::update_many()
            .col_expr(
                bank_connections::Column::CredentialsEncrypted,
                Expr::val(sealed),
            )
            .filter(bank_connections::Column::Id.eq(id))
            .exec(&orm(&ctx.db))
            .await
            .map(|_| ())
            .map_err(|error| error.to_string()),
        Err(error) => Err(format!("{error:?}")),
    };
    if let Err(error) = stored {
        tracing::error!(connection = %id, %error, "[bank-feeds] rotated credentials not stored");
    }
}

#[allow(clippy::too_many_lines)] // the worker's steps, in its order
async fn run_sync(
    ctx: &FeedContext,
    provider: &Provider<'_>,
    row: &Value,
    (timestamp, at): (&str, PrimitiveDateTime),
    outcome: &mut SyncOutcome,
    options: &SyncOptions,
) -> Result<(), RunError> {
    let db = &ctx.db;
    let id = text(row, "id").unwrap_or_default().to_owned();
    let mapped = bank_accounts::Entity::find()
        .filter(bank_accounts::Column::FeedConnectionId.eq(id.as_str()))
        .filter(bank_accounts::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?
        .into_iter()
        .map(js)
        .collect::<Result<Vec<_>, _>>()?;
    let mapped: Vec<Value> = mapped
        .into_iter()
        .filter(|a| text(a, "feedAccountId").is_some_and(|f| !f.is_empty()))
        .collect();
    if mapped.is_empty() {
        release(db, &id, &json!({})).await?;
        outcome.skipped = Some("no_mapped_accounts");
        return Ok(());
    }

    let mut by_feed_id = ByFeedId::default();
    for account in &mapped {
        by_feed_id.insert(
            text(account, "feedAccountId")
                .unwrap_or_default()
                .to_owned(),
            account.clone(),
        );
    }
    let mut stored: StoredConnection = to_stored(ctx, row, Some(by_feed_id.keys.clone()));
    let mut credentials_update: Option<Value> = None;

    if options.refresh
        && provider.capabilities()["onDemandRefresh"] == json!(true)
        && provider.has_refresh()
        && let Err(error) = provider
            .refresh(&stored, options.customer_ip.as_deref())
            .await
    {
        // A refused refresh must not stop the read of what the provider already has.
        tracing::warn!(connection = %id, %error, "[bank-feeds] refresh failed");
    }

    let mut run = Run {
        provider,
        connection_id: id.clone(),
        by_feed_id,
        timestamp: timestamp.to_owned(),
        stamp: at,
        occurrences: HashMap::new(),
        pending_pool: None,
        warnings: Vec::new(),
        touched_accounts: Vec::new(),
    };

    let start_cursor = row.get("syncCursor").cloned().unwrap_or(Value::Null);
    let mut cursor = start_cursor.clone();
    let mut account_statuses: Map<String, Value> = Map::new();
    // The consent end the provider reports on this read, when it reports one.
    let mut consent_reported: Option<String> = None;
    let mut restarts = 0;
    let mut page = 0;
    while page < MAX_PAGES {
        let result = match provider.sync_transactions(&stored, &cursor).await {
            Ok(result) => result,
            // Plaid: data changed between pages. Every write is idempotent, so start over.
            Err(error) if error.kind == "mutation_during_pagination" && restarts < MAX_RESTARTS => {
                restarts += 1;
                cursor = start_cursor.clone();
                page = 0;
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        apply_page(db, &mut run, outcome, &result).await?;
        if let Some(statuses) = &result.account_statuses {
            for (key, value) in statuses {
                account_statuses.insert(key.clone(), value.clone());
            }
        }
        if let Some(consent) = result
            .consent_expires_at
            .as_deref()
            .and_then(crate::js::js_date)
        {
            consent_reported = Some(consent);
        }
        if let Some(credentials) = &result.credentials {
            credentials_update = Some(credentials.clone());
            stored.credentials = credentials.clone();
        }
        cursor = result.next_cursor.clone();
        if !result.has_more {
            break;
        }
        page += 1;
    }

    // Unmatched pending rows older than 14 days are void.
    let today = day_of(timestamp);
    outcome.pending_voided = void_stale_pending(db, &id, at, &add_days(&today, -14)).await?;

    update_balances(db, provider, &stored, &run.by_feed_id, at).await;

    // Status: what the provider reported per account, else a clean read clears an earlier problem.
    let feed_accounts: Vec<Value> = stored_feed_accounts(row)
        .into_iter()
        .map(|mut fa| {
            let reported = text(&fa, "providerAccountId")
                .and_then(|k| account_statuses.get(k))
                .filter(|s| s.as_str().is_some_and(|s| !s.is_empty()))
                .cloned();
            if let Some(reported) = reported {
                fa["status"] = reported;
            } else if matches!(text(&fa, "status"), Some("reauth_required" | "error")) {
                fa["status"] = json!("active");
            }
            fa
        })
        .collect();
    let mapped_statuses: Vec<String> = feed_accounts
        .iter()
        .filter(|fa| text(fa, "providerAccountId").is_some_and(|k| run.by_feed_id.get(k).is_some()))
        .map(|fa| text(fa, "status").unwrap_or_default().to_owned())
        .collect();
    let mut next_status = connection_status(&mapped_statuses).to_owned();
    let consent = consent_reported
        .as_deref()
        .or_else(|| text(row, "consentExpiresAt"))
        .and_then(millis_of);
    if next_status == "active" && consent.is_some() {
        #[allow(clippy::cast_precision_loss)]
        let days_left =
            (consent.unwrap_or(0) - millis_of(timestamp).unwrap_or(0)) as f64 / 86_400_000.0;
        if days_left <= 0.0 {
            "reauth_required".clone_into(&mut next_status);
        } else if days_left <= 14.0 {
            "expiring".clone_into(&mut next_status);
        }
    } else if next_status == "active" && text(row, "status") == Some("expiring") {
        "expiring".clone_into(&mut next_status);
    }
    for (feed_id, account) in run.by_feed_id.iter() {
        let Some(feed) = feed_accounts
            .iter()
            .find(|fa| text(fa, "providerAccountId") == Some(feed_id.as_str()))
        else {
            continue;
        };
        if feed.get("status") != account.get("feedStatus") {
            bank_accounts::Entity::update_many()
                .col_expr(
                    bank_accounts::Column::FeedStatus,
                    Expr::val(text(feed, "status")),
                )
                .col_expr(bank_accounts::Column::UpdatedAt, Expr::val(at))
                .filter(bank_accounts::Column::Id.eq(text(account, "id")))
                .exec(&orm(db))
                .await?;
        }
    }

    // Reconciliation matcher over the new lines.
    if ctx.auto_reconcile {
        for account_id in &run.touched_accounts {
            let account = mapped
                .iter()
                .find(|a| text(a, "id") == Some(account_id.as_str()));
            if account.is_some_and(|a| a.get("autoReconcile") == Some(&json!(false))) {
                continue;
            }
            match crate::bank_matching::auto_reconcile_batch(
                db,
                ctx.http.as_ref(),
                account_id,
                None,
            )
            .await
            {
                Ok((count, _)) => outcome.auto_reconciled += count,
                Err(error) => {
                    tracing::warn!(account = %account_id, %error, "[bank-feeds] auto-reconcile skipped");
                }
            }
        }
    }

    let mut warnings = stored_warnings(row);
    warnings.extend(run.warnings.iter().cloned());
    let warnings = warnings.split_off(warnings.len().saturating_sub(MAX_WARNINGS));
    outcome.warnings = run.warnings.len();
    outcome.status.clone_from(&next_status);

    let sealed = match &credentials_update {
        Some(credentials) => Some(ctx.seal(credentials).map_err(RunError::Other)?),
        None => None,
    };
    let patch = json!({
        "feedAccounts": feed_accounts,
        "warnings": warnings,
        "lastSync": {
            "at": timestamp,
            "added": outcome.added,
            "updated": outcome.updated,
            "removed": outcome.removed,
            "pending": outcome.pending,
        },
    });
    let consent_at = consent_reported.as_deref().map(stamp).transpose()?;
    store_sync(
        db,
        &id,
        &next_status,
        (timestamp, at),
        cursor,
        sealed,
        consent_at,
        patch,
    )
    .await?;

    let was_inactive = INACTIVE_STATUSES.contains(&text(row, "status").unwrap_or_default());
    let now_inactive = INACTIVE_STATUSES.contains(&next_status.as_str());
    if was_inactive && !now_inactive {
        ctx.index_set_active(&id, true, None).await?;
    } else if !was_inactive && now_inactive {
        ctx.index_set_active(
            &id,
            false,
            Some(&format!("Connection needs attention: {next_status}")),
        )
        .await?;
    }
    Ok(())
}

/// Unmatched pending rows dated before `before` are void: how many.
async fn void_stale_pending(
    db: &PgPool,
    connection_id: &str,
    at: PrimitiveDateTime,
    before: &str,
) -> Result<usize, DbErr> {
    use sea_orm::ExprTrait as _;
    let done = pending::Entity::update_many()
        .col_expr(pending::Column::VoidedAt, Expr::val(at))
        .col_expr(pending::Column::UpdatedAt, Expr::val(at))
        .filter(
            Condition::all()
                .add(pending::Column::ConnectionId.eq(connection_id))
                .add(pending::Column::VoidedAt.is_null())
                .add(Expr::col(pending::Column::Date).lt(Expr::val(before).cast_as("date"))),
        )
        .exec(&orm(db))
        .await?;
    Ok(usize::try_from(done.rows_affected).unwrap_or(usize::MAX))
}

/// The end of a run: the status, the cursor (none when the accounts were
/// remapped during the run: `resyncAt` after its start), the credentials and
/// consent the provider reported, and the metadata with `patch` merged in and
/// the lock (and a handled `resyncAt`) dropped, in one statement.
#[allow(clippy::too_many_arguments)] // the statement's parameters
async fn store_sync(
    db: &PgPool,
    id: &str,
    status: &str,
    (timestamp, at): (&str, PrimitiveDateTime),
    cursor: Value,
    sealed: Option<String>,
    consent: Option<PrimitiveDateTime>,
    patch: Value,
) -> Result<(), DbErr> {
    use sea_orm::ExprTrait as _;
    use sea_orm::sea_query::extension::postgres::PgExpr;
    let started = instant(timestamp)?;
    // `(metadata->>'resyncAt')::timestamptz > $3::timestamptz`
    let resynced = || {
        PgExpr::cast_json_field(Expr::col(bank_connections::Column::Metadata), "resyncAt")
            .cast_as("timestamptz")
            .gt(Expr::val(started))
    };
    let sync_cursor =
        Expr::case(resynced(), Expr::val(Option::<Value>::None)).finally(Expr::val(cursor));
    let kept =
        Expr::case(resynced(), metadata_or_empty()).finally(metadata_or_empty().sub("resyncAt"));
    let metadata = PgExpr::concat(Expr::expr(kept).sub("syncLockUntil"), Expr::val(patch));
    let mut update = bank_connections::Entity::update_many()
        .col_expr(bank_connections::Column::Status, Expr::val(status))
        .col_expr(
            bank_connections::Column::SyncCursor,
            Expr::expr(sync_cursor),
        )
        .col_expr(bank_connections::Column::LastSyncedAt, Expr::val(at))
        .col_expr(
            bank_connections::Column::LastError,
            Expr::val(Option::<String>::None),
        );
    if let Some(sealed) = sealed {
        update = update.col_expr(
            bank_connections::Column::CredentialsEncrypted,
            Expr::val(sealed),
        );
    }
    if let Some(consent) = consent {
        update = update.col_expr(
            bank_connections::Column::ConsentExpiresAt,
            Expr::val(consent),
        );
    }
    update
        .col_expr(bank_connections::Column::Metadata, metadata)
        .col_expr(bank_connections::Column::UpdatedAt, Expr::val(at))
        .filter(bank_connections::Column::Id.eq(id))
        .exec(&orm(db))
        .await
        .map(|_| ())
}

/// `updateBalances`: a nicety next to the transactions already stored, so
/// failures are only logged.
async fn update_balances(
    db: &PgPool,
    provider: &Provider<'_>,
    stored: &StoredConnection,
    by_feed_id: &ByFeedId,
    at: PrimitiveDateTime,
) {
    use sea_orm::ExprTrait as _;
    let balances = match provider.get_balances(stored).await {
        Ok(balances) => balances,
        Err(error) => {
            tracing::warn!(%error, "[bank-feeds] balance read failed");
            return;
        }
    };
    for balance in balances {
        let Some(account) = by_feed_id.get(&balance.account_id) else {
            continue;
        };
        let amount = minor_to_decimal(balance.current, &balance.currency);
        let numeric = || Expr::val(amount.as_str()).cast_as("numeric");
        if let Err(error) = bank_accounts::Entity::update_many()
            .col_expr(bank_accounts::Column::CurrentBalance, numeric())
            .col_expr(bank_accounts::Column::LastImportBalance, numeric())
            .col_expr(bank_accounts::Column::LastImportDate, Expr::val(at))
            .col_expr(bank_accounts::Column::UpdatedAt, Expr::val(at))
            .filter(bank_accounts::Column::Id.eq(text(account, "id")))
            .exec(&orm(db))
            .await
        {
            tracing::warn!(%error, "[bank-feeds] balance read failed");
            return;
        }
    }
}

/// `recordFailure(ctx, row, err, timestamp, outcome)`.
async fn record_failure(
    ctx: &FeedContext,
    row: &Value,
    error: &FeedError,
    at: PrimitiveDateTime,
    mut outcome: SyncOutcome,
) -> Result<SyncOutcome, ServiceError> {
    let mut status = text(row, "status").unwrap_or_default().to_owned();
    let mut retryable = false;
    match error.kind {
        "reauth_required" | "revoked" => error.kind.clone_into(&mut status),
        "rate_limit" | "transient" | "mutation_during_pagination" => retryable = true,
        _ => "error".clone_into(&mut status),
    }
    let message = slice_utf16(&error.message, 500);
    let hard = status == "reauth_required" || status == "revoked";
    let mut patch = Map::new();
    if hard {
        let accounts: Vec<Value> = stored_feed_accounts(row)
            .into_iter()
            .map(|mut fa| {
                fa["status"] = json!(status);
                fa
            })
            .collect();
        patch.insert("feedAccounts".to_owned(), Value::Array(accounts));
    }
    let id = text(row, "id").unwrap_or_default();
    let db = &orm(&ctx.db);
    bank_connections::Entity::update_many()
        .col_expr(bank_connections::Column::Status, Expr::val(status.as_str()))
        .col_expr(
            bank_connections::Column::LastError,
            Expr::val(message.as_str()),
        )
        .col_expr(
            bank_connections::Column::Metadata,
            unlocked_metadata(Value::Object(patch)),
        )
        .col_expr(bank_connections::Column::UpdatedAt, Expr::val(at))
        .filter(bank_connections::Column::Id.eq(id))
        .exec(db)
        .await?;
    if hard {
        bank_accounts::Entity::update_many()
            .col_expr(
                bank_accounts::Column::FeedStatus,
                Expr::val(status.as_str()),
            )
            .col_expr(bank_accounts::Column::UpdatedAt, Expr::val(at))
            .filter(bank_accounts::Column::FeedConnectionId.eq(id))
            .filter(bank_accounts::Column::DeletedAt.is_null())
            .exec(db)
            .await?;
        ctx.index_set_active(id, false, Some(&message)).await?;
    }
    outcome.status = status;
    outcome.error = Some(message);
    outcome.retryable = Some(retryable);
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_json_and_the_insert() {
        let outcome = SyncOutcome {
            error: Some("x".to_owned()),
            retryable: Some(false),
            ..SyncOutcome::skipped("bkc_1", "active", "in_progress")
        };
        let json = outcome.to_json();
        assert_eq!(json["connectionId"], "bkc_1");
        assert_eq!(json["skipped"], "in_progress");
        assert_eq!(json["retryable"], false);
        assert_eq!(json["pendingVoided"], 0);
        let empty = SyncOutcome::empty("bkc_1", "active").to_json();
        assert!(empty.get("skipped").is_none() && empty.get("error").is_none());
    }
}
