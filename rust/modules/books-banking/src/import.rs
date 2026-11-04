//! Writing parsed statement lines to `bank_transactions`
//! (`accounting-bank-import`). Every line gets an id (the bank's own FITID
//! where the file has one, else a hash of its date, amount and text) and is
//! a duplicate when the account already holds a line with the same id,
//! amount and date. Importing never touches reconciled lines.
//!
//! The way back: [`delete_lines`] removes lines that were never booked
//! (unreconciled or excluded), one at a time or a whole import batch, and
//! takes their amounts back out of the account balance.

use std::collections::HashSet;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::http::now;
use weldsuite_books_domain::js::{js_number_value, math_round, slice_utf16, to_fixed};
use weldsuite_books_domain::posting::iso_instant;
use weldsuite_books_domain::tables::BANK_TRANSACTIONS;
use weldsuite_kit::generate_id;

use crate::parsers::{Txn, occurrence_counter, synthetic_external_id};

const LOOKUP_CHUNK: usize = 300;

/// `clip(value, max)`: empty is null, longer is cut (UTF-16 units).
fn clip(value: Option<&str>, max: usize) -> Value {
    match value {
        None | Some("") => Value::Null,
        Some(text) => Value::String(slice_utf16(text, max)),
    }
}

/// `withExternalIds(transactions)`: lines without an id get a stable one.
pub(crate) fn with_external_ids(transactions: &[Txn]) -> Vec<(Txn, String)> {
    let mut next = occurrence_counter();
    transactions
        .iter()
        .map(|txn| {
            if let Some(id) = txn.external_id.as_deref().filter(|id| !id.is_empty()) {
                return (txn.clone(), id.to_owned());
            }
            let amount = to_fixed(txn.amount, 2);
            let parts = [
                Some(txn.date.as_str()),
                Some(amount.as_str()),
                Some(txn.description.as_str()),
                txn.counterparty_name.as_deref(),
                txn.check_number.as_deref(),
            ];
            let key = parts
                .iter()
                .map(|p| p.unwrap_or_default().to_lowercase())
                .collect::<Vec<_>>()
                .join("|");
            let occurrence = next(&key);
            (
                txn.clone(),
                synthetic_external_id("imp", &parts, occurrence),
            )
        })
        .collect()
}

/// `duplicateKey(externalId, amount, date)`.
fn duplicate_key(external_id: &str, amount: f64, day: &str) -> String {
    let day: String = day.chars().take(10).collect();
    format!("{external_id}|{}|{day}", to_fixed(amount, 2))
}

/// `findExistingImports(db, bankAccountId, lines)`.
async fn existing(
    db: &PgPool,
    bank_account_id: &str,
    ids: &[String],
) -> Result<HashSet<String>, sqlx::Error> {
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    let mut known = HashSet::new();
    for chunk in unique.chunks(LOOKUP_CHUNK) {
        let rows: Vec<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
            "select external_id, amount::text, to_jsonb(date) #>> '{}' from bank_transactions \
             where bank_account_id = $1 and external_id = any($2) and deleted_at is null",
        )
        .bind(bank_account_id)
        .bind(chunk)
        .fetch_all(db)
        .await?;
        for (external, amount, date) in rows {
            let Some(external) = external.filter(|e| !e.is_empty()) else {
                continue;
            };
            let amount = js_number_value(amount.map(Value::String).as_ref());
            let day = date
                .as_deref()
                .and_then(weldsuite_db::js_timestamp)
                .unwrap_or_default();
            known.insert(duplicate_key(&external, amount, &day));
        }
    }
    Ok(known)
}

/// `countDuplicates(db, bankAccountId, transactions)`: lines of a file the
/// account already holds.
pub(crate) async fn count_duplicates(
    db: &PgPool,
    bank_account_id: &str,
    transactions: &[Txn],
) -> Result<usize, sqlx::Error> {
    let lines = with_external_ids(transactions);
    let ids: Vec<String> = lines.iter().map(|(_, id)| id.clone()).collect();
    let known = existing(db, bank_account_id, &ids).await?;
    Ok(lines
        .iter()
        .filter(|(txn, id)| known.contains(&duplicate_key(id, txn.amount, &txn.date)))
        .count())
}

/// What an import wrote (`ImportCounts`).
pub(crate) struct ImportCounts {
    pub(crate) imported: usize,
    pub(crate) duplicates: usize,
    /// The imported lines' amounts added up, for files that carry no closing
    /// balance.
    pub(crate) net: f64,
}

/// `importParsedTransactions(db, args)`: insert the lines the account does
/// not hold yet, as unreconciled `import` transactions.
pub(crate) async fn import_transactions(
    db: &PgPool,
    entity_id: &str,
    bank_account_id: &str,
    batch_id: &str,
    transactions: &[Txn],
) -> Result<ImportCounts, sqlx::Error> {
    let lines = with_external_ids(transactions);
    let ids: Vec<String> = lines.iter().map(|(_, id)| id.clone()).collect();
    let mut known = existing(db, bank_account_id, &ids).await?;
    let stamp = now();
    let mut fresh: Vec<Map<String, Value>> = Vec::new();
    let mut duplicates = 0;
    for (txn, external_id) in &lines {
        let key = duplicate_key(external_id, txn.amount, &txn.date);
        if known.contains(&key) {
            duplicates += 1;
            continue;
        }
        known.insert(key);
        let mut row = Map::new();
        let mut put = |prop: &str, value: Value| BANK_TRANSACTIONS.set(&mut row, prop, value);
        put("id", json!(generate_id("bt")));
        put("entityId", json!(entity_id));
        put("bankAccountId", json!(bank_account_id));
        put("date", json!(iso_instant(&txn.date)));
        put(
            "valueDate",
            txn.value_date
                .as_deref()
                .filter(|v| !v.is_empty())
                .map_or(Value::Null, |v| json!(iso_instant(v))),
        );
        put("description", json!(txn.description));
        put("amount", json!(to_fixed(txn.amount, 2)));
        put(
            "runningBalance",
            txn.running_balance
                .map_or(Value::Null, |b| json!(to_fixed(b, 2))),
        );
        put(
            "counterpartyName",
            clip(txn.counterparty_name.as_deref(), 255),
        );
        put(
            "counterpartyIban",
            clip(txn.counterparty_iban.as_deref(), 34),
        );
        put("counterpartyBic", clip(txn.counterparty_bic.as_deref(), 11));
        put("reference", clip(txn.reference.as_deref(), 255));
        put("transactionCode", clip(txn.transaction_code.as_deref(), 20));
        put("checkNumber", clip(txn.check_number.as_deref(), 30));
        put("endToEndId", clip(txn.end_to_end_id.as_deref(), 255));
        put("mandateId", clip(txn.mandate_id.as_deref(), 255));
        put("importBatchId", json!(batch_id));
        put("externalId", clip(Some(external_id), 255));
        put("status", json!("unreconciled"));
        put("source", json!("import"));
        put("rawData", txn.raw_data.clone().unwrap_or(Value::Null));
        put("createdAt", json!(stamp));
        put("updatedAt", json!(stamp));
        fresh.push(row);
    }
    let imported = fresh.len();
    let net = sum_amounts(fresh.iter().map(|row| row.get("amount")));
    // Drizzle sends each chunk of 100 as one insert: all or nothing per chunk.
    for chunk in fresh.chunks(100) {
        let mut tx = db.begin().await?;
        for row in chunk {
            BANK_TRANSACTIONS.insert_raw(&mut *tx, row.clone()).await?;
        }
        tx.commit().await?;
    }
    Ok(ImportCounts {
        imported,
        duplicates,
        net,
    })
}

/// `sumAmounts(rows)`: added up in whole cents.
fn sum_amounts<'a>(amounts: impl Iterator<Item = Option<&'a Value>>) -> f64 {
    let cents = amounts.fold(0.0, |total, amount| {
        total + math_round(js_number_value(amount) * 100.0)
    });
    cents / 100.0
}

/// `lineDeleteBlocker(line)`: why a line can't be deleted. Only lines that
/// were never booked (unreconciled or excluded) go; a bank feed's would come
/// back on the next sync, so they are excluded instead.
pub(crate) fn line_delete_blocker(line: &Value) -> Option<&'static str> {
    let status = line
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(status, "unreconciled" | "excluded") {
        return Some("reconciled");
    }
    let source = line
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("import");
    if !matches!(source, "import" | "manual") {
        return Some("feed");
    }
    None
}

/// Which lines [`delete_lines`] removes (`DeleteLinesScope`): one line, or
/// every line of an import batch, whose status then follows.
pub(crate) enum DeleteScope<'a> {
    Line(&'a str),
    ImportBatch(&'a str),
}

/// The statement of [`delete_lines`], scoped by `$where` with `$batch` (a
/// CTE or nothing) after the balance update. `$1` is the scope id, `$2` now.
macro_rules! delete_lines_sql {
    ($where:literal, $batch:literal) => {
        concat!(
            "with gone as (
               update bank_transactions set deleted_at = $2::timestamp, updated_at = $2::timestamp
               where ", $where, " and deleted_at is null
                 and status in ('unreconciled', 'excluded')
                 and coalesce(source, 'import') in ('import', 'manual')
               returning id, bank_account_id, amount
             ), balances as (
               update bank_accounts a
               set current_balance = coalesce(a.current_balance, 0)::numeric - g.total, updated_at = $2::timestamp
               from (select bank_account_id, sum(amount) as total from gone group by bank_account_id) g
               where a.id = g.bank_account_id and g.total <> 0
             )", $batch, "
             select id from gone"
        )
    };
}

/// `deleteBankLines(db, lines, scope)`: soft-delete the deletable lines in
/// `scope` and take their amounts back out of their accounts' balances;
/// undoing an import also marks the batch undone. One statement does all of
/// it, and the deletable check runs in its WHERE, so a request that loses a
/// race with another delete or a reconcile deletes nothing. `lines` is the
/// caller's read of the scope. The deleted lines, and how many were left in
/// place (reconciled, or from a bank feed).
pub(crate) async fn delete_lines(
    db: &PgPool,
    lines: Vec<Value>,
    scope: DeleteScope<'_>,
) -> Result<(Vec<Value>, usize), sqlx::Error> {
    let (query, id) = match scope {
        DeleteScope::Line(id) => (delete_lines_sql!("id = $1", ""), id),
        DeleteScope::ImportBatch(id) => (
            delete_lines_sql!(
                "import_batch_id = $1",
                ", batch as (
                   update bank_import_batches
                   set status = case when exists (
                         select 1 from bank_transactions
                         where import_batch_id = $1 and deleted_at is null
                           and id not in (select id from gone)
                       ) then 'partly_undone' else 'undone' end,
                       updated_at = $2::timestamp
                   where id = $1
                 )"
            ),
            id,
        ),
    };
    let gone: HashSet<String> = sqlx::query_scalar(query)
        .bind(id)
        .bind(now())
        .fetch_all(db)
        .await?
        .into_iter()
        .collect();
    let kept = lines
        .iter()
        .filter(|line| line_delete_blocker(line).is_some())
        .count();
    let deleted = lines
        .into_iter()
        .filter(|line| {
            line.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| gone.contains(id))
        })
        .collect();
    Ok((deleted, kept))
}
