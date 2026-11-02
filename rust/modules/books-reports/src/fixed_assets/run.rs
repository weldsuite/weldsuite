//! Posting the stored depreciation of the ledger book
//! (`services/fixed-assets/depreciation-run.ts`): one entry per period per
//! entity, a pair of lines per asset, keyed by the period and a hash of the
//! row ids so a rerun or a concurrent run posts each period once. A period
//! the posting service refuses (lock date, closed period) is skipped and
//! reported; the rest of the run goes on. `run_monthly_depreciation` is what
//! the daily sweep calls.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use weldsuite_books_domain::dates::{end_of_month, is_iso_date};
use weldsuite_books_domain::guards::PostingLockKind;
use weldsuite_books_domain::http::now;
use weldsuite_books_domain::js::{locale_compare, number_value};
use weldsuite_books_domain::posting::{
    AlsoWrite, PostError, PostJournalEntryInput, PostingLine, post_journal_entry,
};
use weldsuite_books_domain::tables::{FIXED_ASSET_BOOKS, FIXED_ASSET_DEPRECIATION, FIXED_ASSETS};

use super::shared::{Fail, bad, from_cents, num, opt, present, text, to_cents};

/// `PostedPeriod`.
#[derive(Debug, Clone)]
pub struct PostedPeriod {
    pub period_end: String,
    pub journal_entry_id: String,
    pub entry_number: Option<String>,
    pub amount: f64,
    pub assets: usize,
    pub already_posted: bool,
}

impl PostedPeriod {
    pub(crate) fn json(&self) -> Value {
        json!({
            "periodEnd": self.period_end,
            "journalEntryId": self.journal_entry_id,
            "entryNumber": self.entry_number,
            "amount": number_value(self.amount),
            "assets": self.assets,
            "alreadyPosted": self.already_posted,
        })
    }
}

/// `SkippedPeriod`.
#[derive(Debug, Clone)]
pub struct SkippedPeriod {
    pub period_end: String,
    pub assets: usize,
    pub amount: f64,
    pub reason: String,
}

/// `DepreciationRunResult`.
#[derive(Debug, Clone, Default)]
pub struct RunResult {
    pub through: String,
    pub posted: Vec<PostedPeriod>,
    pub skipped: Vec<SkippedPeriod>,
    pub fully_depreciated_asset_ids: Vec<String>,
    pub total_posted: f64,
}

impl RunResult {
    pub(crate) fn json(&self) -> Value {
        json!({
            "through": self.through,
            "posted": self.posted.iter().map(PostedPeriod::json).collect::<Vec<_>>(),
            "skipped": self.skipped.iter().map(|s| json!({
                "periodEnd": s.period_end,
                "assets": s.assets,
                "amount": number_value(s.amount),
                "reason": s.reason,
            })).collect::<Vec<_>>(),
            "fullyDepreciatedAssetIds": self.fully_depreciated_asset_ids,
            "totalPosted": number_value(self.total_posted),
        })
    }
}

/// `PendingRow`: an unposted row with its asset and book.
#[derive(Debug, Clone)]
pub(crate) struct Pending {
    pub(crate) row: Value,
    pub(crate) asset: Value,
    pub(crate) book: Value,
}

/// `lastCompletedMonthEnd(today)`: the end of last month.
pub fn last_completed_month_end(today: &str) -> String {
    let start: String = format!("{}-01", today.chars().take(7).collect::<String>());
    weldsuite_books_domain::dates::add_days(&start, -1).unwrap_or_default()
}

fn hash_ids(ids: &[String]) -> String {
    let mut sorted: Vec<&str> = ids.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    let digest = Sha256::digest(sorted.join(",").as_bytes());
    digest.iter().take(8).fold(String::new(), |mut out, b| {
        use std::fmt::Write as _;
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// `loadPendingRows(db, { entityId, through, assetId })`: unposted rows of
/// the ledger book up to `through`, by period, asset and id.
pub(crate) async fn load_pending_rows(
    db: &PgPool,
    entity_id: &str,
    through: &str,
    asset_id: Option<&str>,
) -> Result<Vec<Pending>, sqlx::Error> {
    let rows: Vec<(Value, Value, Value)> = sqlx::query_as(concat!(
        "select (select ",
        weldsuite_books_domain::books_row!(fixed_asset_depreciation),
        " from fixed_asset_depreciation t where t.id = d.id), (select ",
        weldsuite_books_domain::books_row!(fixed_assets),
        " from fixed_assets t where t.id = a.id), (select ",
        weldsuite_books_domain::books_row!(fixed_asset_books),
        " from fixed_asset_books t where t.id = b.id) \
         from fixed_asset_depreciation d \
         inner join fixed_asset_books b on d.book_id = b.id \
         inner join fixed_assets a on d.asset_id = a.id \
         where d.entity_id = $1 and d.journal_entry_id is null and d.period_end <= $2::date \
         and b.posts_to_ledger = true and a.deleted_at is null and d.amount > 0 \
         and ($3::text is null or d.asset_id = $3)"
    ))
    .bind(entity_id)
    .bind(through)
    .bind(asset_id)
    .fetch_all(db)
    .await?;
    let mut pending: Vec<Pending> = rows
        .into_iter()
        .map(|(row, asset, book)| Pending {
            row: FIXED_ASSET_DEPRECIATION.js(row),
            asset: FIXED_ASSETS.js(asset),
            book: FIXED_ASSET_BOOKS.js(book),
        })
        .collect();
    let label = |p: &Pending| {
        present(&p.asset, "assetNumber")
            .or_else(|| opt(&p.asset, "assetNumber"))
            .unwrap_or_else(|| text(&p.asset, "name"))
            .to_owned()
    };
    pending.sort_by(|a, b| {
        locale_compare(text(&a.row, "periodEnd"), text(&b.row, "periodEnd"))
            .then_with(|| locale_compare(&label(a), &label(b)))
            .then_with(|| locale_compare(text(&a.row, "id"), text(&b.row, "id")))
    });
    Ok(pending)
}

fn describe_period(period_start: &str, period_end: &str) -> String {
    let same_month = period_start.get(..7) == period_end.get(..7);
    if same_month && end_of_month(period_start).as_deref() == Some(period_end) {
        format!("Depreciation {}", &period_start[..7])
    } else {
        format!("Depreciation {period_start} to {period_end}")
    }
}

/// Class and location of one journal line, by its position.
#[derive(Debug, Clone)]
pub(crate) struct LineDimension {
    pub(crate) index: usize,
    pub(crate) class_id: Option<String>,
    pub(crate) location_id: Option<String>,
}

/// `depreciationLines(items)`: debit expense, credit accumulated
/// depreciation, per asset; the dimensions of an asset with a class or a
/// location.
pub(crate) fn depreciation_lines(items: &[Pending]) -> (Vec<PostingLine>, Vec<LineDimension>) {
    let mut lines = Vec::new();
    let mut dimensions = Vec::new();
    for Pending { row, asset, .. } in items {
        let label = match present(asset, "assetNumber") {
            Some(number) => format!("{number} {}", text(asset, "name")),
            None => text(asset, "name").to_owned(),
        };
        let amount = num(row, "amount");
        lines.push(PostingLine {
            account_id: text(asset, "depreciationExpenseAccountId").to_owned(),
            debit: amount,
            description: Some(format!("Depreciation {label}")),
            ..PostingLine::default()
        });
        lines.push(PostingLine {
            account_id: text(asset, "accumulatedDepreciationAccountId").to_owned(),
            credit: amount,
            description: Some(format!("Accumulated depreciation {label}")),
            ..PostingLine::default()
        });
        let class_id = present(asset, "classId").map(str::to_owned);
        let location_id = present(asset, "locationId").map(str::to_owned);
        if class_id.is_some() || location_id.is_some() {
            for index in [lines.len() - 2, lines.len() - 1] {
                dimensions.push(LineDimension {
                    index,
                    class_id: opt(asset, "classId").map(str::to_owned),
                    location_id: opt(asset, "locationId").map(str::to_owned),
                });
            }
        }
    }
    (lines, dimensions)
}

/// `dimensionStatements(h, journalEntryId, dimensions)`: class and location
/// on the entry's lines by position (`sort_order`), grouped by value.
pub(crate) async fn write_dimensions(
    conn: &mut sqlx::PgConnection,
    journal_entry_id: &str,
    dimensions: &[LineDimension],
) -> Result<(), sqlx::Error> {
    let mut groups: Vec<(Option<String>, Option<String>, Vec<i32>)> = Vec::new();
    for dimension in dimensions {
        let index = i32::try_from(dimension.index).unwrap_or(i32::MAX);
        if let Some(group) = groups.iter_mut().find(|(class, location, _)| {
            class.as_deref().unwrap_or_default()
                == dimension.class_id.as_deref().unwrap_or_default()
                && location.as_deref().unwrap_or_default()
                    == dimension.location_id.as_deref().unwrap_or_default()
        }) {
            group.2.push(index);
        } else {
            groups.push((
                dimension.class_id.clone(),
                dimension.location_id.clone(),
                vec![index],
            ));
        }
    }
    for (class_id, location_id, indexes) in groups {
        sqlx::query(
            "update journal_lines set class_id = $1, location_id = $2 \
             where journal_entry_id = $3 and sort_order = any($4)",
        )
        .bind(class_id)
        .bind(location_id)
        .bind(journal_entry_id)
        .bind(indexes)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

async fn last_period_end_by_book(
    db: &PgPool,
    book_ids: &[String],
) -> Result<HashMap<String, String>, sqlx::Error> {
    if book_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select book_id, to_char(max(period_end), 'YYYY-MM-DD') from fixed_asset_depreciation \
         where book_id = any($1) group by book_id",
    )
    .bind(book_ids)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

/// `RunArgs`.
#[derive(Debug, Clone, Default)]
pub(crate) struct RunArgs {
    pub(crate) entity_id: String,
    pub(crate) through: String,
    pub(crate) user_id: Option<String>,
    pub(crate) asset_id: Option<String>,
    /// Mark an asset `fully_depreciated` when its last row is posted
    /// (`finishAssets`, default true; the disposal catch-up turns it off).
    pub(crate) keep_active: bool,
}

/// `runDepreciation(db, args)`.
#[allow(clippy::too_many_lines)] // one period after the other, as the service
pub(crate) async fn run_depreciation(db: &PgPool, args: &RunArgs) -> Result<RunResult, Fail> {
    if !is_iso_date(&args.through) {
        return Err(bad("through must be a date (YYYY-MM-DD)"));
    }
    let mut result = RunResult {
        through: args.through.clone(),
        ..RunResult::default()
    };
    let pending =
        load_pending_rows(db, &args.entity_id, &args.through, args.asset_id.as_deref()).await?;
    if pending.is_empty() {
        return Ok(result);
    }
    let mut book_ids: Vec<String> = Vec::new();
    for item in &pending {
        let id = text(&item.book, "id").to_owned();
        if !book_ids.contains(&id) {
            book_ids.push(id);
        }
    }
    let last_ends = last_period_end_by_book(db, &book_ids).await?;

    let mut by_period: BTreeMap<String, Vec<Pending>> = BTreeMap::new();
    for item in pending {
        by_period
            .entry(text(&item.row, "periodEnd").to_owned())
            .or_default()
            .push(item);
    }

    let mut total_posted = 0_i64;
    for (period_end, items) in by_period {
        let total: i64 = items.iter().map(|p| to_cents(num(&p.row, "amount"))).sum();
        let (lines, dimensions) = depreciation_lines(&items);
        let row_ids: Vec<String> = items
            .iter()
            .map(|p| text(&p.row, "id").to_owned())
            .collect();
        let finishing: Vec<String> = if args.keep_active {
            Vec::new()
        } else {
            items
                .iter()
                .filter(|p| {
                    last_ends.get(text(&p.book, "id")).map(String::as_str)
                        == Some(text(&p.row, "periodEnd"))
                })
                .map(|p| text(&p.asset, "id").to_owned())
                .collect()
        };
        let at = now();

        let write_rows = row_ids.clone();
        let write_finishing = finishing.clone();
        let write_at = at.clone();
        let also: AlsoWrite = Box::new(move |conn, entry| {
            Box::pin(async move {
                sqlx::query(
                    "update fixed_asset_depreciation set journal_entry_id = $1 \
                     where id = any($2) and journal_entry_id is null",
                )
                .bind(&entry.journal_entry_id)
                .bind(&write_rows)
                .execute(&mut *conn)
                .await?;
                write_dimensions(conn, &entry.journal_entry_id, &dimensions).await?;
                if !write_finishing.is_empty() {
                    sqlx::query(
                        "update fixed_assets set status = 'fully_depreciated', updated_at = $1::timestamp \
                         where id = any($2) and status = 'active'",
                    )
                    .bind(&write_at)
                    .bind(&write_finishing)
                    .execute(&mut *conn)
                    .await?;
                }
                Ok(())
            })
        });
        let posted = post_journal_entry(
            db,
            PostJournalEntryInput {
                entity_id: args.entity_id.clone(),
                date: period_end.clone(),
                description: describe_period(text(&items[0].row, "periodStart"), &period_end),
                source_type: "fixed_asset_depreciation".to_owned(),
                posting_key: Some(format!(
                    "fixed_asset:dep:{period_end}:{}",
                    hash_ids(&row_ids)
                )),
                lock_kind: Some(PostingLockKind::General),
                created_by: args.user_id.clone(),
                is_automatic: Some(true),
                lines,
                also_write: vec![also],
                ..PostJournalEntryInput::default()
            },
        )
        .await;
        let posted = match posted {
            Ok(posted) => posted,
            Err(PostError::Database(error)) => return Err(Fail::Database(error)),
            Err(other) => {
                result.skipped.push(SkippedPeriod {
                    period_end,
                    assets: items.len(),
                    amount: from_cents(total),
                    reason: other.to_string(),
                });
                continue;
            }
        };
        let Some(journal_entry_id) = posted.journal_entry_id else {
            continue;
        };
        if posted.already_posted {
            // Another run (or an earlier attempt) wrote the entry; make sure its rows point at it.
            sqlx::query(
                "update fixed_asset_depreciation set journal_entry_id = $1 \
                 where id = any($2) and journal_entry_id is null",
            )
            .bind(&journal_entry_id)
            .bind(&row_ids)
            .execute(db)
            .await?;
            if !finishing.is_empty() {
                sqlx::query(
                    "update fixed_assets set status = 'fully_depreciated', updated_at = $1::timestamp \
                     where id = any($2) and status = 'active'",
                )
                .bind(&at)
                .bind(&finishing)
                .execute(db)
                .await?;
            }
        } else {
            total_posted += total;
            result.fully_depreciated_asset_ids.extend(finishing);
        }
        result.posted.push(PostedPeriod {
            period_end,
            journal_entry_id,
            entry_number: posted.entry_number,
            amount: from_cents(total),
            assets: items.len(),
            already_posted: posted.already_posted,
        });
    }
    result.total_posted = from_cents(total_posted);
    Ok(result)
}

/// One entity's run (`EntityDepreciationRun`).
#[derive(Debug, Clone)]
pub struct EntityRun {
    pub entity_id: String,
    pub run: RunResult,
}

/// `runMonthlyDepreciation(db, { entityId, through })`: post the due
/// depreciation of one entity, or of every entity that has some. A locked
/// period is skipped inside the run, never an error.
pub async fn run_monthly_depreciation(
    db: &PgPool,
    entity_id: Option<&str>,
    through: &str,
) -> Result<Vec<EntityRun>, String> {
    let entity_ids: Vec<String> = if let Some(id) = entity_id {
        vec![id.to_owned()]
    } else {
        let mut ids: Vec<String> = sqlx::query_scalar(
            "select distinct entity_id from fixed_asset_depreciation \
             where journal_entry_id is null and period_end <= $1::date",
        )
        .bind(through)
        .fetch_all(db)
        .await
        .map_err(|error| error.to_string())?;
        ids.sort();
        ids
    };
    let mut results = Vec::new();
    for entity_id in entity_ids {
        let run = run_depreciation(
            db,
            &RunArgs {
                entity_id: entity_id.clone(),
                through: through.to_owned(),
                ..RunArgs::default()
            },
        )
        .await
        .map_err(|error| format!("{error:?}"))?;
        if !run.posted.is_empty() || !run.skipped.is_empty() {
            results.push(EntityRun { entity_id, run });
        }
    }
    Ok(results)
}
