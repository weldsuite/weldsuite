//! The one way a journal entry reaches the ledger
//! (`books-api/src/services/accounting-posting.ts`).
//!
//! Every posting (invoice, credit note, bill, payment, bank line, write-off,
//! manual entry, reversal, FX adjustment) goes through [`post_journal_entry`],
//! which refuses unbalanced entries and accounts of another entity, checks
//! closed periods and lock dates, and writes the entry, its lines, its
//! tax-ledger rows, the account balances and the caller's own statements
//! ([`AlsoWrite`]) in one transaction. It is idempotent per `postingKey`.
//!
//! Amounts are in the entity's base currency. Arithmetic is JavaScript's
//! (`f64`, `roundMoney`), so the stored amounts are the worker's to the cent.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value, json};
use sqlx::{PgConnection, PgPool};
use weldsuite_kit::generate_id;

use crate::entity_context::{SequenceType, next_entity_number};
use crate::guards::{GuardError, PostingCheck, PostingLockKind, assert_posting_allowed};
use crate::http::now;
use crate::js::{round_money, to_fixed};
use crate::tables::{JOURNAL_ENTRIES, JOURNAL_LINES, TAX_LINES};

/// Journal entry statuses that are in the ledger (a reversed entry stays,
/// next to its posted reversal).
pub const BOOKED_STATUSES: [&str; 2] = ["posted", "reversed"];

/// Why a posting failed. `Posting`, `Guard` (closed period, lock date) are
/// the user's to fix (the routes answer 400 with the message); `Database` is
/// a failure.
#[derive(Debug)]
pub enum PostError {
    /// `PostingError` (and `MissingExchangeRateError`, its subclass).
    Posting(String),
    Guard(GuardError),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for PostError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<GuardError> for PostError {
    fn from(error: GuardError) -> Self {
        match error {
            GuardError::Database(error) => Self::Database(error),
            other => Self::Guard(other),
        }
    }
}

impl std::fmt::Display for PostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Posting(message) => f.write_str(message),
            Self::Guard(error) => error.fmt(f),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl PostError {
    /// `ClosedPeriodError | LockedPeriodError | PostingError`: the message a
    /// route answers with a 400.
    pub fn user_message(&self) -> Option<String> {
        match self {
            Self::Posting(message) => Some(message.clone()),
            Self::Guard(error) => Some(error.to_string()),
            Self::Database(_) => None,
        }
    }
}

fn posting(message: impl Into<String>) -> PostError {
    PostError::Posting(message.into())
}

/// One line of a posting (`PostingLine`).
#[derive(Debug, Clone, Default)]
pub struct PostingLine {
    pub account_id: String,
    pub debit: f64,
    pub credit: f64,
    pub description: Option<String>,
    pub contact_id: Option<String>,
    pub tax_rate_id: Option<String>,
    pub tax_amount: Option<f64>,
    /// Source document currency and rate (foreign units per base unit).
    pub currency: Option<String>,
    pub exchange_rate: Option<String>,
    pub class_id: Option<String>,
    pub location_id: Option<String>,
}

/// One tax-ledger row of a posting (`PostingTaxLine`).
#[derive(Debug, Clone, Default)]
pub struct PostingTaxLine {
    pub source_line_id: Option<String>,
    /// `sales`, `purchase` or `use`.
    pub direction: String,
    pub tax_rate_id: Option<String>,
    pub tax_rate_name: Option<String>,
    pub tax_category_code: Option<String>,
    pub rate: f64,
    pub component: Option<String>,
    pub self_assessed: bool,
    pub jurisdiction_code: Option<String>,
    pub jurisdiction_level: Option<String>,
    pub state_code: Option<String>,
    /// Document-currency amounts, signed.
    pub taxable_amount: f64,
    pub tax_amount: f64,
    pub currency: String,
    pub base_taxable_amount: f64,
    pub base_tax_amount: f64,
    pub contact_id: Option<String>,
    /// US sales tax detail (`TaxLineExtra`): `tax_lines` properties applied
    /// over the common columns, in the order given.
    pub extra: Map<String, Value>,
}

/// The posted entry, for [`AlsoWrite`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Posted {
    pub journal_entry_id: String,
    pub entry_number: String,
}

/// A boxed future of the transaction's connection.
pub type WriteFuture<'c> = Pin<Box<dyn Future<Output = Result<(), sqlx::Error>> + Send + 'c>>;

/// `alsoWrite`: statements written in the same transaction as the entry.
pub type AlsoWrite =
    Box<dyn for<'c> FnOnce(&'c mut PgConnection, &'c Posted) -> WriteFuture<'c> + Send>;

/// `PostJournalEntryInput`.
#[derive(Default)]
pub struct PostJournalEntryInput {
    pub entity_id: String,
    /// The entry's date as `toISOString()` (or `YYYY-MM-DD`, read as UTC
    /// midnight).
    pub date: String,
    pub description: String,
    pub reference: Option<String>,
    pub source_type: String,
    pub source_id: Option<String>,
    pub posting_key: Option<String>,
    pub lock_kind: Option<PostingLockKind>,
    pub lines: Vec<PostingLine>,
    pub tax_lines: Vec<PostingTaxLine>,
    pub created_by: Option<String>,
    /// `isAutomatic ?? true`.
    pub is_automatic: Option<bool>,
    pub reversal_of_id: Option<String>,
    pub also_write: Vec<AlsoWrite>,
}

/// `PostedEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostedEntry {
    /// `None` when there was nothing to post (all amounts zero).
    pub journal_entry_id: Option<String>,
    pub entry_number: Option<String>,
    pub already_posted: bool,
}

/// A date as Drizzle writes a `Date`: `toISOString()`. `YYYY-MM-DD` is UTC
/// midnight.
pub fn iso_instant(date: &str) -> String {
    if date.len() == 10 {
        format!("{date}T00:00:00.000Z")
    } else {
        date.to_owned()
    }
}

struct NormalizedLine {
    line: PostingLine,
    debit: f64,
    credit: f64,
}

fn normalize_lines(lines: Vec<PostingLine>) -> Result<Vec<NormalizedLine>, PostError> {
    let mut result = Vec::new();
    for line in lines {
        let mut debit = round_money(line.debit);
        let mut credit = round_money(line.credit);
        if !debit.is_finite() || !credit.is_finite() {
            return Err(posting("Journal line amounts must be numbers"));
        }
        // A negative debit is a credit and vice versa.
        if debit < 0.0 {
            credit = round_money(credit - debit);
            debit = 0.0;
        }
        if credit < 0.0 {
            debit = round_money(debit - credit);
            credit = 0.0;
        }
        let net = round_money(debit - credit);
        if net == 0.0 {
            continue;
        }
        result.push(NormalizedLine {
            line,
            debit: if net > 0.0 { net } else { 0.0 },
            credit: if net < 0.0 { -net } else { 0.0 },
        });
    }
    Ok(result)
}

async fn find_by_posting_key(
    db: &PgPool,
    posting_key: &str,
) -> Result<Option<(String, Option<String>)>, sqlx::Error> {
    sqlx::query_as("select id, entry_number from journal_entries where posting_key = $1 limit 1")
        .bind(posting_key)
        .fetch_optional(db)
        .await
}

/// Ids in first-seen order, without duplicates (`[...new Set(ids)]`).
fn unique(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

async fn assert_accounts_belong_to_entity(
    db: &PgPool,
    entity_id: &str,
    account_ids: Vec<String>,
) -> Result<(), PostError> {
    let unique = unique(account_ids);
    if unique.is_empty() {
        return Ok(());
    }
    let found: Vec<String> = sqlx::query_scalar(
        "select id from accounts where entity_id = $1 and id = any($2) and deleted_at is null",
    )
    .bind(entity_id)
    .bind(&unique)
    .fetch_all(db)
    .await?;
    let missing: Vec<&str> = unique
        .iter()
        .filter(|id| !found.contains(id))
        .map(String::as_str)
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(posting(format!(
            "Account {} does not belong to this accounting entity",
            missing.join(", ")
        )))
    }
}

/// `assertDimensionsBelongToEntity(db, entityId, lines)`: class and
/// location ids on lines must be values of that dimension in this entity (a
/// deactivated value still counts).
pub async fn assert_dimensions_belong_to_entity(
    db: &PgPool,
    entity_id: &str,
    lines: &[(Option<String>, Option<String>)],
) -> Result<(), PostError> {
    let wanted = [
        (
            "class",
            unique(
                lines
                    .iter()
                    .filter_map(|(class, _)| class.clone())
                    .filter(|id| !id.is_empty()),
            ),
        ),
        (
            "location",
            unique(
                lines
                    .iter()
                    .filter_map(|(_, location)| location.clone())
                    .filter(|id| !id.is_empty()),
            ),
        ),
    ];
    for (dimension, ids) in wanted {
        if ids.is_empty() {
            continue;
        }
        let found: Vec<String> = sqlx::query_scalar(
            "select id from accounting_dimension_values where entity_id = $1 and dimension = $2 \
             and id = any($3) and deleted_at is null",
        )
        .bind(entity_id)
        .bind(dimension)
        .bind(&ids)
        .fetch_all(db)
        .await?;
        let missing: Vec<&str> = ids
            .iter()
            .filter(|id| !found.contains(id))
            .map(String::as_str)
            .collect();
        if !missing.is_empty() {
            let label = if dimension == "class" {
                "Class"
            } else {
                "Location"
            };
            return Err(posting(format!(
                "{label} {} does not exist in this accounting entity",
                missing.join(", ")
            )));
        }
    }
    Ok(())
}

fn opt(value: Option<&String>) -> Value {
    value.map_or(Value::Null, |v| Value::String(v.clone()))
}

/// Whether a `TaxLineExtra` amount is non-zero (`Number(x ?? 0) !== 0`).
fn extra_nonzero(extra: &Map<String, Value>, key: &str) -> bool {
    let value = extra.get(key).filter(|v| !v.is_null());
    let number = match value {
        None => 0.0,
        Some(v) => weldsuite_kit::validation::js_number_of(Some(v)),
    };
    number != 0.0
}

/// One balance update per account, net of all its lines, in first-seen
/// order (a `Map`).
fn net_by_account<'a>(lines: impl IntoIterator<Item = (&'a str, f64)>) -> Vec<(String, f64)> {
    let mut out: Vec<(String, f64)> = Vec::new();
    for (account, net) in lines {
        match out.iter_mut().find(|(id, _)| id == account) {
            Some((_, total)) => *total = round_money(*total + net),
            None => out.push((account.to_owned(), round_money(0.0 + net))),
        }
    }
    out
}

async fn apply_balances(
    conn: &mut PgConnection,
    nets: &[(String, f64)],
    at: &str,
) -> Result<(), sqlx::Error> {
    for (account_id, net) in nets {
        if *net == 0.0 {
            continue;
        }
        sqlx::query(
            "update accounts set current_balance = (coalesce(current_balance, 0)::numeric + $1::numeric), \
             updated_at = $2::timestamp where id = $3",
        )
        .bind(to_fixed(*net, 2))
        .bind(at)
        .bind(account_id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// `postJournalEntry(db, input)`.
#[allow(clippy::too_many_lines)] // one statement per step, as the worker's
pub async fn post_journal_entry(
    db: &PgPool,
    input: PostJournalEntryInput,
) -> Result<PostedEntry, PostError> {
    if let Some(key) = input.posting_key.as_deref()
        && let Some((id, number)) = find_by_posting_key(db, key).await?
    {
        return Ok(PostedEntry {
            journal_entry_id: Some(id),
            entry_number: number,
            already_posted: true,
        });
    }

    let lines = normalize_lines(input.lines)?;
    let total_debit = round_money(lines.iter().fold(0.0, |sum, l| sum + l.debit));
    let total_credit = round_money(lines.iter().fold(0.0, |sum, l| sum + l.credit));
    #[allow(clippy::float_cmp)] // `!==` on the rounded totals, as TypeScript
    if total_debit != total_credit {
        return Err(posting(format!(
            "Journal entry is not balanced. Total debit: {}, total credit: {}",
            to_fixed(total_debit, 2),
            to_fixed(total_credit, 2)
        )));
    }
    let tax_lines: Vec<PostingTaxLine> = input
        .tax_lines
        .into_iter()
        .filter(|t| {
            t.taxable_amount != 0.0
                || t.tax_amount != 0.0
                || extra_nonzero(&t.extra, "grossAmount")
                || extra_nonzero(&t.extra, "exemptAmount")
                || extra_nonzero(&t.extra, "nonTaxableAmount")
        })
        .collect();
    if lines.is_empty() && tax_lines.is_empty() {
        return Ok(PostedEntry {
            journal_entry_id: None,
            entry_number: None,
            already_posted: false,
        });
    }

    let date = iso_instant(&input.date);
    assert_posting_allowed(
        db,
        PostingCheck {
            entity_id: &input.entity_id,
            date: &date,
            kind: input.lock_kind.unwrap_or(PostingLockKind::General),
            affects_tax: !tax_lines.is_empty(),
            user_id: input.created_by.as_deref(),
        },
    )
    .await?;
    assert_accounts_belong_to_entity(
        db,
        &input.entity_id,
        lines.iter().map(|l| l.line.account_id.clone()).collect(),
    )
    .await?;
    let dims: Vec<(Option<String>, Option<String>)> = lines
        .iter()
        .map(|l| (l.line.class_id.clone(), l.line.location_id.clone()))
        .collect();
    assert_dimensions_belong_to_entity(db, &input.entity_id, &dims).await?;

    let entry_number = next_entity_number(db, &input.entity_id, SequenceType::Journal)
        .await?
        .formatted;
    let journal_entry_id = generate_id("je");
    let at = now();
    let tax_date = date.get(..10).unwrap_or(&date).to_owned();

    let mut entry = Map::new();
    for (key, value) in [
        ("id", json!(journal_entry_id)),
        ("entityId", json!(input.entity_id)),
        ("entryNumber", json!(entry_number)),
        ("date", json!(date)),
        ("status", json!("posted")),
        ("description", json!(input.description)),
        ("reference", opt(input.reference.as_ref())),
        ("totalDebit", json!(to_fixed(total_debit, 2))),
        ("totalCredit", json!(to_fixed(total_credit, 2))),
        ("sourceType", json!(input.source_type)),
        ("sourceId", opt(input.source_id.as_ref())),
        ("postingKey", opt(input.posting_key.as_ref())),
        ("reversalOfId", opt(input.reversal_of_id.as_ref())),
        ("isAutomatic", json!(input.is_automatic.unwrap_or(true))),
        ("createdBy", opt(input.created_by.as_ref())),
        ("createdAt", json!(at)),
        ("updatedAt", json!(at)),
    ] {
        entry.insert(key.to_owned(), value);
    }
    let entry_row = JOURNAL_ENTRIES.values(&entry);

    let line_rows: Vec<Map<String, Value>> = lines
        .iter()
        .enumerate()
        .map(|(index, l)| {
            let mut row = Map::new();
            for (key, value) in [
                ("id", json!(generate_id("jl"))),
                ("entityId", json!(input.entity_id)),
                ("journalEntryId", json!(journal_entry_id)),
                ("accountId", json!(l.line.account_id)),
                ("description", opt(l.line.description.as_ref())),
                ("debit", json!(to_fixed(l.debit, 2))),
                ("credit", json!(to_fixed(l.credit, 2))),
                ("taxRateId", opt(l.line.tax_rate_id.as_ref())),
                (
                    "taxAmount",
                    l.line
                        .tax_amount
                        .map_or(Value::Null, |t| json!(to_fixed(round_money(t), 2))),
                ),
                ("contactId", opt(l.line.contact_id.as_ref())),
                ("currency", opt(l.line.currency.as_ref())),
                (
                    "exchangeRate",
                    json!(
                        l.line
                            .exchange_rate
                            .clone()
                            .unwrap_or_else(|| "1".to_owned())
                    ),
                ),
                ("classId", opt(l.line.class_id.as_ref())),
                ("locationId", opt(l.line.location_id.as_ref())),
                ("baseCurrencyDebit", json!(to_fixed(l.debit, 2))),
                ("baseCurrencyCredit", json!(to_fixed(l.credit, 2))),
                ("sortOrder", json!(index)),
                ("createdAt", json!(at)),
                ("updatedAt", json!(at)),
            ] {
                row.insert(key.to_owned(), value);
            }
            JOURNAL_LINES.values(&row)
        })
        .collect();

    let tax_rows: Vec<Map<String, Value>> = tax_lines
        .iter()
        .map(|tax| {
            let mut row = Map::new();
            for (key, value) in [
                ("id", json!(generate_id("txl"))),
                ("createdAt", json!(at)),
                ("entityId", json!(input.entity_id)),
                ("sourceType", json!(input.source_type)),
                ("sourceId", opt(input.source_id.as_ref())),
                ("sourceLineId", opt(tax.source_line_id.as_ref())),
                ("journalEntryId", json!(journal_entry_id)),
                ("taxDate", json!(tax_date)),
                ("direction", json!(tax.direction)),
                ("taxRateId", opt(tax.tax_rate_id.as_ref())),
                ("taxRateName", opt(tax.tax_rate_name.as_ref())),
                ("taxCategoryCode", opt(tax.tax_category_code.as_ref())),
                ("rate", json!(to_fixed(tax.rate, 4))),
                ("component", opt(tax.component.as_ref())),
                ("selfAssessed", json!(tax.self_assessed)),
                ("jurisdictionCode", opt(tax.jurisdiction_code.as_ref())),
                ("jurisdictionLevel", opt(tax.jurisdiction_level.as_ref())),
                ("stateCode", opt(tax.state_code.as_ref())),
                (
                    "taxableAmount",
                    json!(to_fixed(round_money(tax.taxable_amount), 2)),
                ),
                ("taxAmount", json!(to_fixed(round_money(tax.tax_amount), 2))),
                ("currency", json!(tax.currency)),
                (
                    "baseTaxableAmount",
                    json!(to_fixed(round_money(tax.base_taxable_amount), 2)),
                ),
                (
                    "baseTaxAmount",
                    json!(to_fixed(round_money(tax.base_tax_amount), 2)),
                ),
                ("contactId", opt(tax.contact_id.as_ref())),
            ] {
                row.insert(key.to_owned(), value);
            }
            for (key, value) in &tax.extra {
                row.insert(key.clone(), value.clone());
            }
            TAX_LINES.values(&row)
        })
        .collect();

    let nets = net_by_account(
        lines
            .iter()
            .map(|l| (l.line.account_id.as_str(), l.debit - l.credit)),
    );
    let posted = Posted {
        journal_entry_id: journal_entry_id.clone(),
        entry_number: entry_number.clone(),
    };
    let also_write = input.also_write;
    let result = weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            JOURNAL_ENTRIES.insert_raw(&mut *conn, entry_row).await?;
            for row in line_rows {
                JOURNAL_LINES.insert_raw(&mut *conn, row).await?;
            }
            for row in tax_rows {
                TAX_LINES.insert_raw(&mut *conn, row).await?;
            }
            apply_balances(conn, &nets, &at).await?;
            for write in also_write {
                write(&mut *conn, &posted).await?;
            }
            Ok::<_, sqlx::Error>(())
        })
    })
    .await;
    if let Err(error) = result {
        // Lost a race with an identical posting: the other request's entry stands.
        if let Some(key) = input.posting_key.as_deref()
            && weldsuite_db::is_unique_violation(&error)
            && let Some((id, number)) = find_by_posting_key(db, key).await?
        {
            return Ok(PostedEntry {
                journal_entry_id: Some(id),
                entry_number: number,
                already_posted: true,
            });
        }
        return Err(error.into());
    }
    Ok(PostedEntry {
        journal_entry_id: Some(journal_entry_id),
        entry_number: Some(entry_number),
        already_posted: false,
    })
}

/// `negated(value)`: `String(-Number(value))`, `0` for zero, null kept.
fn negated(value: &Value) -> Value {
    match value {
        Value::Null => Value::Null,
        other => {
            let n = -weldsuite_kit::validation::js_number_of(Some(other));
            Value::String(crate::js::number_text(if n == 0.0 { 0.0 } else { n }))
        }
    }
}

/// The US columns of a tax-ledger row, amounts negated, for its reversal.
fn negated_tax_line_extra(tax: &Value) -> Map<String, Value> {
    let mut extra = Map::new();
    for key in [
        "agencyId",
        "jurisdictionName",
        "reportingCode",
        "grossAmount",
        "exemptAmount",
        "nonTaxableAmount",
        "exemptReason",
        "certificateId",
        "shipToState",
        "shipToPostalCode",
        "taxCode",
        "marketplaceFacilitated",
        "unroundedTaxAmount",
        "engine",
        "engineRef",
    ] {
        let value = tax.get(key).cloned().unwrap_or(Value::Null);
        let value = if matches!(
            key,
            "grossAmount" | "exemptAmount" | "nonTaxableAmount" | "unroundedTaxAmount"
        ) {
            negated(&value)
        } else {
            value
        };
        extra.insert(key.to_owned(), value);
    }
    extra
}

fn text(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn number(row: &Value, key: &str) -> f64 {
    crate::js::numeric(row.get(key).unwrap_or(&Value::Null))
}

/// `reverseJournalEntry` arguments.
#[derive(Default)]
pub struct ReverseArgs {
    pub entry_id: String,
    /// `toISOString()` of the reversal's date.
    pub date: String,
    pub created_by: Option<String>,
    pub lock_kind: Option<PostingLockKind>,
    pub description: Option<String>,
    pub posting_key: Option<String>,
    pub also_write: Vec<AlsoWrite>,
}

/// `reverseJournalEntry(db, args)`: post the mirror image of a posted entry
/// dated `date` and mark the original `reversed`. Lines swap debit and
/// credit; tax-ledger rows are negated and count in the reversal's period.
#[allow(clippy::too_many_lines)] // one statement per step, as the worker's
pub async fn reverse_journal_entry(
    db: &PgPool,
    args: ReverseArgs,
) -> Result<PostedEntry, PostError> {
    let entry: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(journal_entries),
        " from journal_entries t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(&args.entry_id)
    .fetch_optional(db)
    .await?;
    let Some(entry) = entry.map(|row| JOURNAL_ENTRIES.js(row)) else {
        return Err(posting("Journal entry not found"));
    };
    let status = text(&entry, "status");
    if status.as_deref() == Some("reversed") || crate::js::truthy(entry.get("reversedById")) {
        return Err(posting("This journal entry has already been reversed"));
    }
    if status.as_deref() != Some("posted") {
        return Err(posting("Can only reverse posted journal entries"));
    }
    let entry_id = text(&entry, "id").unwrap_or_default();
    let lines: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(journal_lines),
        " from journal_lines t where t.journal_entry_id = $1 and t.deleted_at is null"
    ))
    .bind(&entry_id)
    .fetch_all(db)
    .await?;
    let tax_rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(tax_lines),
        " from tax_lines t where t.journal_entry_id = $1"
    ))
    .bind(&entry_id)
    .fetch_all(db)
    .await?;

    let lines: Vec<PostingLine> = lines
        .into_iter()
        .map(|row| JOURNAL_LINES.js(row))
        .map(|line| PostingLine {
            account_id: text(&line, "accountId").unwrap_or_default(),
            debit: number(&line, "credit"),
            credit: number(&line, "debit"),
            description: Some(
                format!(
                    "Reversal: {}",
                    text(&line, "description").unwrap_or_default()
                )
                .trim()
                .to_owned(),
            ),
            contact_id: text(&line, "contactId"),
            tax_rate_id: text(&line, "taxRateId"),
            tax_amount: line
                .get("taxAmount")
                .filter(|v| !v.is_null())
                .map(|v| -crate::js::numeric(v)),
            currency: text(&line, "currency"),
            exchange_rate: text(&line, "exchangeRate"),
            class_id: text(&line, "classId"),
            location_id: text(&line, "locationId"),
        })
        .collect();
    let tax_lines: Vec<PostingTaxLine> = tax_rows
        .into_iter()
        .map(|row| TAX_LINES.js(row))
        .map(|tax| PostingTaxLine {
            source_line_id: text(&tax, "sourceLineId"),
            direction: text(&tax, "direction").unwrap_or_default(),
            tax_rate_id: text(&tax, "taxRateId"),
            tax_rate_name: text(&tax, "taxRateName"),
            tax_category_code: text(&tax, "taxCategoryCode"),
            rate: number(&tax, "rate"),
            component: text(&tax, "component"),
            self_assessed: tax
                .get("selfAssessed")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            jurisdiction_code: text(&tax, "jurisdictionCode"),
            jurisdiction_level: text(&tax, "jurisdictionLevel"),
            state_code: text(&tax, "stateCode"),
            taxable_amount: -number(&tax, "taxableAmount"),
            tax_amount: -number(&tax, "taxAmount"),
            currency: text(&tax, "currency").unwrap_or_default(),
            base_taxable_amount: -number(&tax, "baseTaxableAmount"),
            base_tax_amount: -number(&tax, "baseTaxAmount"),
            contact_id: text(&tax, "contactId"),
            extra: negated_tax_line_extra(&tax),
        })
        .collect();

    let number_or_id = text(&entry, "entryNumber").unwrap_or_else(|| entry_id.clone());
    let original = entry_id.clone();
    let mut also_write: Vec<AlsoWrite> = vec![Box::new(move |conn, posted| {
        Box::pin(async move {
            sqlx::query(
                "update journal_entries set status = 'reversed', reversed_by_id = $1, \
                 updated_at = $2::timestamp where id = $3",
            )
            .bind(&posted.journal_entry_id)
            .bind(now())
            .bind(&original)
            .execute(&mut *conn)
            .await?;
            Ok(())
        })
    })];
    also_write.extend(args.also_write);
    post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: text(&entry, "entityId").unwrap_or_default(),
            date: args.date,
            description: args
                .description
                .unwrap_or_else(|| format!("Reversal of {number_or_id}")),
            reference: text(&entry, "reference"),
            source_type: text(&entry, "sourceType").unwrap_or_else(|| "manual".to_owned()),
            // A manual entry has no source document; its reversal points at the entry.
            source_id: Some(text(&entry, "sourceId").unwrap_or_else(|| entry_id.clone())),
            posting_key: Some(
                args.posting_key
                    .unwrap_or_else(|| format!("reversal:{entry_id}")),
            ),
            lock_kind: Some(args.lock_kind.unwrap_or(PostingLockKind::General)),
            lines,
            tax_lines,
            created_by: args.created_by,
            is_automatic: None,
            reversal_of_id: Some(entry_id),
            also_write,
        },
    )
    .await
}

/// `postDraftJournalEntry(db, { entryId, userId })`: a manual draft entry
/// draft → posted, account balances and tax-ledger rows applied in one
/// transaction. A line that carries a tax rate holds the gross amount with
/// `taxAmount` as its tax part; credit lines count as sales tax, debit lines
/// as purchase tax. Returns the entry as read before the post, with
/// `status: 'posted'`.
#[allow(clippy::too_many_lines)]
pub async fn post_draft_journal_entry(
    db: &PgPool,
    entry_id: &str,
    user_id: Option<&str>,
) -> Result<Value, PostError> {
    let entry: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(journal_entries),
        " from journal_entries t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(entry_id)
    .fetch_optional(db)
    .await?;
    let Some(mut entry) = entry.map(|row| JOURNAL_ENTRIES.js(row)) else {
        return Err(posting("Journal entry not found"));
    };
    if text(&entry, "status").as_deref() != Some("draft") {
        return Err(posting("Can only post draft journal entries"));
    }
    let id = text(&entry, "id").unwrap_or_default();
    let entity_id = text(&entry, "entityId").unwrap_or_default();
    let lines: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(journal_lines),
        " from journal_lines t where t.journal_entry_id = $1 and t.deleted_at is null"
    ))
    .bind(&id)
    .fetch_all(db)
    .await?;
    let lines: Vec<Value> = lines.into_iter().map(|row| JOURNAL_LINES.js(row)).collect();

    let total_debit = round_money(lines.iter().fold(0.0, |sum, l| sum + number(l, "debit")));
    let total_credit = round_money(lines.iter().fold(0.0, |sum, l| sum + number(l, "credit")));
    #[allow(clippy::float_cmp)]
    if total_debit != total_credit {
        return Err(posting(format!(
            "Journal entry is not balanced. Total debit: {}, total credit: {}",
            to_fixed(total_debit, 2),
            to_fixed(total_credit, 2)
        )));
    }

    let tax_rate_ids = unique(
        lines
            .iter()
            .filter_map(|l| text(l, "taxRateId"))
            .filter(|id| !id.is_empty()),
    );
    let rates: Vec<Value> = if tax_rate_ids.is_empty() {
        Vec::new()
    } else {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            crate::books_row!(tax_rates),
            " from tax_rates t where t.entity_id = $1 and t.id = any($2)"
        ))
        .bind(&entity_id)
        .bind(&tax_rate_ids)
        .fetch_all(db)
        .await?;
        rows.into_iter()
            .map(|row| crate::tables::TAX_RATES.js(row))
            .collect()
    };
    let rate_of = |id: &str| rates.iter().find(|r| r["id"].as_str() == Some(id));
    let missing: Vec<&str> = tax_rate_ids
        .iter()
        .filter(|id| rate_of(id).is_none())
        .map(String::as_str)
        .collect();
    if !missing.is_empty() {
        return Err(posting(format!(
            "Tax rate {} does not belong to this accounting entity",
            missing.join(", ")
        )));
    }

    let date = text(&entry, "date").unwrap_or_default();
    assert_posting_allowed(
        db,
        PostingCheck {
            entity_id: &entity_id,
            date: &date,
            kind: PostingLockKind::General,
            affects_tax: !tax_rate_ids.is_empty(),
            user_id,
        },
    )
    .await?;
    assert_accounts_belong_to_entity(
        db,
        &entity_id,
        lines
            .iter()
            .map(|l| text(l, "accountId").unwrap_or_default())
            .collect(),
    )
    .await?;

    let at = now();
    let tax_date = date.get(..10).unwrap_or(&date).to_owned();
    let tax_rows: Vec<Map<String, Value>> = lines
        .iter()
        .filter(|l| crate::js::truthy(l.get("taxRateId")))
        .map(|l| {
            let rate = rate_of(l["taxRateId"].as_str().unwrap_or_default())
                .cloned()
                .unwrap_or(Value::Null);
            let debit = number(l, "debit");
            let credit = number(l, "credit");
            let tax = number(l, "taxAmount").abs();
            let taxable = round_money((credit - debit).abs() - tax);
            let mut row = Map::new();
            for (key, value) in [
                ("id", json!(generate_id("txl"))),
                ("createdAt", json!(at)),
                ("entityId", json!(entity_id)),
                ("sourceType", json!("journal")),
                ("sourceId", json!(id)),
                ("sourceLineId", l["id"].clone()),
                ("journalEntryId", json!(id)),
                ("taxDate", json!(tax_date)),
                (
                    "direction",
                    json!(if credit > debit { "sales" } else { "purchase" }),
                ),
                ("taxRateId", rate["id"].clone()),
                ("taxRateName", rate["name"].clone()),
                (
                    "taxCategoryCode",
                    rate.get("taxCategoryCode").cloned().unwrap_or(Value::Null),
                ),
                ("rate", json!(to_fixed(number(&rate, "rate"), 4))),
                ("selfAssessed", json!(false)),
                ("taxableAmount", json!(to_fixed(taxable, 2))),
                ("taxAmount", json!(to_fixed(tax, 2))),
                (
                    "currency",
                    json!(text(l, "currency").unwrap_or_else(|| "EUR".to_owned())),
                ),
                ("baseTaxableAmount", json!(to_fixed(taxable, 2))),
                ("baseTaxAmount", json!(to_fixed(tax, 2))),
                ("contactId", l["contactId"].clone()),
            ] {
                row.insert(key.to_owned(), value);
            }
            TAX_LINES.values(&row)
        })
        .collect();

    let nets = net_by_account(lines.iter().map(|l| {
        (
            l["accountId"].as_str().unwrap_or_default(),
            number(l, "debit") - number(l, "credit"),
        )
    }));
    let (debit_text, credit_text) = (to_fixed(total_debit, 2), to_fixed(total_credit, 2));
    let entry_for_tx = id.clone();
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "update journal_entries set status = 'posted', total_debit = $1::numeric, \
                 total_credit = $2::numeric, updated_at = $3::timestamp \
                 where id = $4 and status = 'draft'",
            )
            .bind(&debit_text)
            .bind(&credit_text)
            .bind(&at)
            .bind(&entry_for_tx)
            .execute(&mut *conn)
            .await?;
            for row in tax_rows {
                TAX_LINES.insert_raw(&mut *conn, row).await?;
            }
            apply_balances(conn, &nets, &at).await?;
            Ok::<_, sqlx::Error>(())
        })
    })
    .await?;
    entry["status"] = json!("posted");
    Ok(entry)
}

/// An entity's chart of accounts with lookups (`EntityAccounts`): rows as
/// Drizzle returns them.
#[derive(Debug, Clone, Default)]
pub struct EntityAccounts {
    rows: Vec<Value>,
}

impl EntityAccounts {
    pub fn rows(&self) -> &[Value] {
        &self.rows
    }

    pub fn by_id(&self, id: Option<&str>) -> Option<&Value> {
        let id = id.filter(|id| !id.is_empty())?;
        self.rows.iter().find(|a| a["id"].as_str() == Some(id))
    }

    /// The account whose `metadata.systemRole` is `role`.
    pub fn by_role(&self, role: &str) -> Option<&Value> {
        self.rows.iter().find(|a| {
            a.get("metadata")
                .and_then(|m| m.get("systemRole"))
                .and_then(Value::as_str)
                == Some(role)
        })
    }

    pub fn by_code(&self, code: &str) -> Option<&Value> {
        self.rows.iter().find(|a| a["code"].as_str() == Some(code))
    }

    /// The first active account (by code, `localeCompare`) of a subtype.
    pub fn by_subtype(&self, subtype: &str) -> Option<&Value> {
        let mut sorted: Vec<&Value> = self.rows.iter().collect();
        sorted.sort_by(|a, b| {
            crate::js::locale_compare(
                a["code"].as_str().unwrap_or_default(),
                b["code"].as_str().unwrap_or_default(),
            )
        });
        sorted.into_iter().find(|a| {
            a["subtype"].as_str() == Some(subtype) && a.get("isActive") != Some(&Value::Bool(false))
        })
    }
}

/// `loadEntityAccounts(db, entityId)`.
pub async fn load_entity_accounts(
    db: &PgPool,
    entity_id: &str,
) -> Result<EntityAccounts, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(accounts),
        " from accounts t where t.entity_id = $1 and t.deleted_at is null"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    Ok(EntityAccounts {
        rows: rows
            .into_iter()
            .map(|row| crate::tables::ACCOUNTS.js(row))
            .collect(),
    })
}

/// `accountForRole(accounts, role, fallbackCodes)`: the account for a system
/// role, else the first template code that exists.
pub fn account_for_role<'a>(
    accounts: &'a EntityAccounts,
    role: &str,
    fallback_codes: &[&str],
) -> Option<&'a Value> {
    accounts.by_role(role).or_else(|| {
        fallback_codes
            .iter()
            .find_map(|code| accounts.by_code(code))
    })
}
