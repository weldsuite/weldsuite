//! Which tax-ledger rows a return's worksheet is built from
//! (`services/sales-tax-returns/rows.ts`).
//!
//! Accrual agencies: the agency's rows dated in the period that no filed
//! return has stamped yet, plus the rows stamped by the return itself (or the
//! returns it amends) and rows carried forward from an earlier period.
//! Cash-basis agencies: an invoice's rows count in the period its payments
//! are dated, in proportion to the payments; credit memos, write-offs and
//! reversals on their tax date, in proportion to the share of the original
//! invoice paid by the end of the period; every other row on its tax date.

use serde_json::Value;
use weldsuite_books_domain::sales_tax::worksheet::WorksheetLine;
use weldsuite_books_domain::tables::TAX_LINES;
use weldsuite_db::PgPool;

use super::common::{next_day, num, num_at, round2, s, start_of_day};
use crate::common::text;

/// Source types that reduce an earlier sale.
const ADJUSTING_SOURCES: [&str; 4] = ["credit_note", "reversal", "write_off", "bad_debt"];
const LEDGER_DIRECTIONS: [&str; 2] = ["sales", "use"];
const ID_CHUNK: usize = 2000;

/// `LoadRowsOptions`.
#[derive(Debug, Clone, Default)]
pub(crate) struct LoadRowsOptions {
    pub entity_id: String,
    pub agency_id: String,
    pub period_start: String,
    pub period_end: String,
    pub cash: bool,
    pub include_stamped_by: Vec<String>,
    pub carried_ids: Vec<String>,
    /// `createdNotAfter` as `toISOString()`.
    pub created_not_after: Option<String>,
    pub created_after: Option<String>,
}

/// `LoadedEntry`.
#[derive(Debug, Clone)]
pub(crate) struct LoadedEntry {
    pub row: Value,
    pub line: WorksheetLine,
    pub scale: f64,
    pub carried: bool,
}

/// `LoadedRows`.
#[derive(Debug, Clone, Default)]
pub(crate) struct LoadedRows {
    pub entries: Vec<LoadedEntry>,
    pub settled_ids: Vec<String>,
    pub carried_ids: Vec<String>,
}

impl LoadedRows {
    pub(crate) fn lines(&self) -> Vec<WorksheetLine> {
        self.entries.iter().map(|e| e.line.clone()).collect()
    }
}

fn owned(row: &Value, key: &str) -> Option<String> {
    text(row, key).map(str::to_owned)
}

/// `toWorksheetLine(row, { scale, taxDate })`.
pub(crate) fn to_worksheet_line(row: &Value, scale: f64, tax_date: Option<&str>) -> WorksheetLine {
    #[allow(clippy::float_cmp)] // `scale === 1`
    let whole = scale == 1.0;
    let scaled = |key: &str| {
        if whole {
            num_at(row, key)
        } else {
            round2(num_at(row, key) * scale)
        }
    };
    let optional = |key: &str| (!row[key].is_null()).then(|| scaled(key));
    let direction = s(row, "direction");
    WorksheetLine {
        tax_rate_id: s(row, "taxRateId").to_owned(),
        tax_category_code: s(row, "taxCategoryCode").to_owned(),
        taxable_amount: scaled("taxableAmount"),
        tax_amount: scaled("taxAmount"),
        direction: if direction == "sales" {
            "sales".to_owned()
        } else {
            "purchase".to_owned()
        },
        self_assessed: row["selfAssessed"].as_bool().unwrap_or(false),
        kind: if direction == "use" {
            "use".to_owned()
        } else {
            "sales".to_owned()
        },
        agency_id: owned(row, "agencyId"),
        state_code: owned(row, "stateCode"),
        jurisdiction_code: owned(row, "jurisdictionCode"),
        jurisdiction_name: owned(row, "jurisdictionName"),
        jurisdiction_level: owned(row, "jurisdictionLevel"),
        reporting_code: owned(row, "reportingCode"),
        rate: num_at(row, "rate"),
        gross_amount: optional("grossAmount"),
        exempt_amount: optional("exemptAmount"),
        non_taxable_amount: optional("nonTaxableAmount"),
        exempt_reason: owned(row, "exemptReason"),
        tax_code: owned(row, "taxCode"),
        ship_to_state: owned(row, "shipToState"),
        marketplace_facilitated: row["marketplaceFacilitated"].as_bool().unwrap_or(false),
        source_type: s(row, "sourceType").to_owned(),
        source_id: owned(row, "sourceId"),
        source_line_id: owned(row, "sourceLineId"),
        certificate_id: owned(row, "certificateId"),
        tax_date: tax_date.unwrap_or(s(row, "taxDate")).to_owned(),
    }
}

fn entry(
    row: Value,
    start: &str,
    end: &str,
    scale: f64,
    carried: Option<bool>,
    tax_date: Option<&str>,
) -> LoadedEntry {
    let date = s(&row, "taxDate");
    let outside = date < start || date > end;
    let tax_date = tax_date
        .unwrap_or(if outside { start } else { date })
        .to_owned();
    LoadedEntry {
        line: to_worksheet_line(&row, scale, Some(&tax_date)),
        scale,
        carried: carried.unwrap_or(outside),
        row,
    }
}

fn finish(entries: Vec<LoadedEntry>, settled_ids: Vec<String>) -> LoadedRows {
    let carried_ids = entries
        .iter()
        .filter(|e| e.carried)
        .map(|e| s(&e.row, "id").to_owned())
        .collect();
    LoadedRows {
        entries,
        settled_ids,
        carried_ids,
    }
}

fn stamp_matches(row: &Value, include: &[String]) -> bool {
    match text(row, "taxReturnId") {
        None => true,
        Some(id) => include.iter().any(|i| i == id),
    }
}

/// Tax-ledger rows by id, in chunks.
pub(crate) async fn rows_by_ids(db: &PgPool, ids: &[String]) -> Result<Vec<Value>, sqlx::Error> {
    let mut out = Vec::new();
    for part in ids.chunks(ID_CHUNK) {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(tax_lines),
            " from tax_lines t where t.id = any($1)"
        ))
        .bind(part)
        .fetch_all(db)
        .await?;
        out.extend(TAX_LINES.js_rows(rows));
    }
    Ok(out)
}

async fn carried_entries(
    db: &PgPool,
    opts: &LoadRowsOptions,
    taken: &[String],
) -> Result<Vec<LoadedEntry>, sqlx::Error> {
    let mut ids: Vec<String> = Vec::new();
    for id in &opts.carried_ids {
        if !ids.contains(id) && !taken.contains(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(rows_by_ids(db, &ids)
        .await?
        .into_iter()
        .filter(|row| {
            s(row, "agencyId") == opts.agency_id
                && text(row, "agencyId").is_some()
                && LEDGER_DIRECTIONS.contains(&s(row, "direction"))
                && stamp_matches(row, &opts.include_stamped_by)
        })
        .map(|row| {
            entry(
                row,
                &opts.period_start,
                &opts.period_end,
                1.0,
                Some(true),
                Some(&opts.period_start),
            )
        })
        .collect())
}

/// The period's rows of the agency (`tax_date` in the period, not stamped by
/// another return, inside the created window); `non_invoice` leaves out
/// invoices (cash basis).
async fn dated_rows(
    db: &PgPool,
    opts: &LoadRowsOptions,
    non_invoice: bool,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(tax_lines),
        " from tax_lines t where t.entity_id = $1 and t.agency_id = $2 \
         and t.tax_date >= $3::date and t.tax_date <= $4::date \
         and t.direction in ('sales', 'use') \
         and ($5::boolean is false or t.source_type <> 'invoice') \
         and (t.tax_return_id is null or t.tax_return_id = any($6)) \
         and ($7::timestamp is null or t.created_at <= $7::timestamp) \
         and ($8::timestamp is null or t.created_at > $8::timestamp)"
    ))
    .bind(&opts.entity_id)
    .bind(&opts.agency_id)
    .bind(&opts.period_start)
    .bind(&opts.period_end)
    .bind(non_invoice)
    .bind(&opts.include_stamped_by)
    .bind(&opts.created_not_after)
    .bind(&opts.created_after)
    .fetch_all(db)
    .await?;
    Ok(TAX_LINES.js_rows(rows))
}

async fn load_accrual(db: &PgPool, opts: &LoadRowsOptions) -> Result<LoadedRows, sqlx::Error> {
    let rows = dated_rows(db, opts, false).await?;
    let mut entries: Vec<LoadedEntry> = rows
        .into_iter()
        .map(|row| entry(row, &opts.period_start, &opts.period_end, 1.0, None, None))
        .collect();
    let taken: Vec<String> = entries.iter().map(|e| s(&e.row, "id").to_owned()).collect();
    entries.extend(carried_entries(db, opts, &taken).await?);
    let settled = entries.iter().map(|e| s(&e.row, "id").to_owned()).collect();
    Ok(finish(entries, settled))
}

/// `receivedByInvoice` filter.
#[derive(Debug, Clone, Default)]
pub(crate) struct ReceivedFilter<'a> {
    pub invoice_ids: Option<&'a [String]>,
    pub from: Option<String>,
    pub before: Option<String>,
    pub created_not_after: Option<String>,
    pub created_after: Option<String>,
}

fn add_total(totals: &mut Vec<(String, f64)>, invoice_id: Option<String>, amount: &Value) {
    let Some(id) = invoice_id.filter(|i| !i.is_empty()) else {
        return;
    };
    let value = num(amount);
    match totals.iter_mut().find(|(k, _)| *k == id) {
        Some(entry) => entry.1 += value,
        None => totals.push((id, value)),
    }
}

/// `receivedByInvoice(db, entityId, filter)`: payments received per invoice,
/// dated in `[from, before)`, in the order the queries found them.
pub(crate) async fn received_by_invoice(
    db: &PgPool,
    entity_id: &str,
    filter: &ReceivedFilter<'_>,
) -> Result<Vec<(String, f64)>, sqlx::Error> {
    let mut totals: Vec<(String, f64)> = Vec::new();
    let parts: Vec<Option<&[String]>> = match filter.invoice_ids {
        Some(ids) => ids.chunks(ID_CHUNK).map(Some).collect(),
        None => vec![None],
    };
    for part in parts {
        let allocated: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
            "select pa.invoice_id, sum(pa.amount)::text from payment_allocations pa \
             inner join payments p on p.id = pa.payment_id \
             where p.entity_id = $1 and p.deleted_at is null and p.type = 'received' \
             and ($2::timestamp is null or p.date >= $2::timestamp) \
             and ($3::timestamp is null or p.date < $3::timestamp) \
             and ($4::timestamp is null or p.created_at <= $4::timestamp) \
             and ($5::timestamp is null or p.created_at > $5::timestamp) \
             and pa.deleted_at is null and pa.invoice_id is not null \
             and ($6::text[] is null or pa.invoice_id = any($6)) \
             group by pa.invoice_id",
        )
        .bind(entity_id)
        .bind(&filter.from)
        .bind(&filter.before)
        .bind(&filter.created_not_after)
        .bind(&filter.created_after)
        .bind(part)
        .fetch_all(db)
        .await?;
        for (id, amount) in allocated {
            add_total(&mut totals, id, &amount.map_or(Value::Null, Value::String));
        }
        let legacy: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
            "select p.invoice_id, p.amount::text from payments p \
             where p.entity_id = $1 and p.deleted_at is null and p.type = 'received' \
             and ($2::timestamp is null or p.date >= $2::timestamp) \
             and ($3::timestamp is null or p.date < $3::timestamp) \
             and ($4::timestamp is null or p.created_at <= $4::timestamp) \
             and ($5::timestamp is null or p.created_at > $5::timestamp) \
             and p.invoice_id is not null \
             and not exists (select 1 from payment_allocations pa where pa.payment_id = p.id and pa.deleted_at is null) \
             and ($6::text[] is null or p.invoice_id = any($6))",
        )
        .bind(entity_id)
        .bind(&filter.from)
        .bind(&filter.before)
        .bind(&filter.created_not_after)
        .bind(&filter.created_after)
        .bind(part)
        .fetch_all(db)
        .await?;
        for (id, amount) in legacy {
            add_total(&mut totals, id, &amount.map_or(Value::Null, Value::String));
        }
    }
    Ok(totals)
}

fn total_of(totals: &[(String, f64)], id: &str) -> Option<f64> {
    totals.iter().find(|(k, _)| k == id).map(|(_, v)| *v)
}

/// `invoiceTotals(db, entityId, ids)`: `(id, total, creditNoteFor)`.
async fn invoice_totals(
    db: &PgPool,
    entity_id: &str,
    ids: &[String],
) -> Result<Vec<(String, f64, Option<String>)>, sqlx::Error> {
    let mut out = Vec::new();
    for part in ids.chunks(ID_CHUNK) {
        let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "select id, total::text, credit_note_for_invoice_id from invoices \
             where entity_id = $1 and id = any($2)",
        )
        .bind(entity_id)
        .bind(part)
        .fetch_all(db)
        .await?;
        for (id, total, credit_note_for) in rows {
            out.push((
                id,
                num(&total.map_or(Value::Null, Value::String)),
                credit_note_for,
            ));
        }
    }
    Ok(out)
}

fn unique(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

#[allow(clippy::too_many_lines, reason = "mirrors rows.ts's loadCash()")]
async fn load_cash(db: &PgPool, opts: &LoadRowsOptions) -> Result<LoadedRows, sqlx::Error> {
    let start = start_of_day(&opts.period_start);
    let after = start_of_day(&next_day(&opts.period_end));
    let mut entries: Vec<LoadedEntry> = Vec::new();
    let mut settled: Vec<String> = Vec::new();

    // (A) invoices: counted in proportion to the payments of the period.
    let in_period = received_by_invoice(
        db,
        &opts.entity_id,
        &ReceivedFilter {
            from: Some(start.clone()),
            before: Some(after.clone()),
            created_not_after: opts.created_not_after.clone(),
            created_after: opts.created_after.clone(),
            ..ReceivedFilter::default()
        },
    )
    .await?;
    let invoice_ids: Vec<String> = in_period.iter().map(|(id, _)| id.clone()).collect();
    if !invoice_ids.is_empty() {
        let totals = invoice_totals(db, &opts.entity_id, &invoice_ids).await?;
        let before = received_by_invoice(
            db,
            &opts.entity_id,
            &ReceivedFilter {
                invoice_ids: Some(&invoice_ids),
                before: Some(start.clone()),
                created_not_after: opts.created_not_after.clone(),
                ..ReceivedFilter::default()
            },
        )
        .await?;
        let mut shares: Vec<(String, f64, bool)> = Vec::new();
        for (id, paid_now) in &in_period {
            let total = totals
                .iter()
                .find(|(i, _, _)| i == id)
                .map_or(0.0, |(_, t, _)| *t);
            if total <= 0.0 {
                continue;
            }
            let paid_before = total_of(&before, id).unwrap_or(0.0).min(total);
            let counted = paid_now.min((total - paid_before).max(0.0));
            if counted <= 0.0 {
                continue;
            }
            shares.push((
                id.clone(),
                counted / total,
                paid_before + counted >= total - 0.005,
            ));
        }
        let share_ids: Vec<String> = shares.iter().map(|(id, _, _)| id.clone()).collect();
        let mut rows: Vec<Value> = Vec::new();
        for part in share_ids.chunks(ID_CHUNK) {
            let found: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                weldsuite_books_domain::books_row!(tax_lines),
                " from tax_lines t where t.entity_id = $1 and t.agency_id = $2 \
                 and t.source_type = 'invoice' and t.source_id = any($3) \
                 and t.direction in ('sales', 'use')"
            ))
            .bind(&opts.entity_id)
            .bind(&opts.agency_id)
            .bind(part)
            .fetch_all(db)
            .await?;
            rows.extend(TAX_LINES.js_rows(found));
        }
        for row in rows {
            let Some((_, scale, is_settled)) = shares
                .iter()
                .find(|(id, _, _)| id == s(&row, "sourceId"))
                .cloned()
            else {
                continue;
            };
            let id = s(&row, "id").to_owned();
            entries.push(entry(
                row,
                &opts.period_start,
                &opts.period_end,
                scale,
                Some(false),
                Some(&opts.period_end),
            ));
            if is_settled {
                settled.push(id);
            }
        }
    }

    // (B) credit memos and the like, (C) everything else: on their tax date.
    let dated = dated_rows(db, opts, true).await?;
    let is_adjusting = |row: &Value| {
        ADJUSTING_SOURCES.contains(&s(row, "sourceType")) && s(row, "direction") != "use"
    };
    let adjusting: Vec<&Value> = dated.iter().filter(|r| is_adjusting(r)).collect();
    let source_ids = unique(adjusting.iter().filter_map(|r| {
        text(r, "sourceId")
            .filter(|i| !i.is_empty())
            .map(str::to_owned)
    }));
    let source_totals = invoice_totals(db, &opts.entity_id, &source_ids).await?;
    let original_of = |row: &Value| -> Option<String> {
        if s(row, "sourceType") == "credit_note" {
            source_totals
                .iter()
                .find(|(id, _, _)| id == s(row, "sourceId"))
                .and_then(|(_, _, of)| of.clone())
        } else {
            text(row, "sourceId").map(str::to_owned)
        }
    };
    let original_ids = unique(
        adjusting
            .iter()
            .filter_map(|r| original_of(r).filter(|i| !i.is_empty())),
    );
    let original_totals = invoice_totals(db, &opts.entity_id, &original_ids).await?;
    let paid_through = received_by_invoice(
        db,
        &opts.entity_id,
        &ReceivedFilter {
            invoice_ids: Some(&original_ids),
            before: Some(after.clone()),
            ..ReceivedFilter::default()
        },
    )
    .await?;
    for row in dated {
        let mut scale = 1.0;
        if is_adjusting(&row) {
            let original = original_of(&row).filter(|i| !i.is_empty());
            let total = original.as_deref().map_or(0.0, |id| {
                original_totals
                    .iter()
                    .find(|(i, _, _)| i == id)
                    .map_or(0.0, |(_, t, _)| *t)
            });
            match original.as_deref() {
                Some(id) if total > 0.0 => {
                    scale = (total_of(&paid_through, id).unwrap_or(0.0) / total).min(1.0);
                }
                Some(_) => scale = 0.0,
                None => {}
            }
        }
        if scale <= 0.0 {
            continue;
        }
        let id = s(&row, "id").to_owned();
        entries.push(entry(
            row,
            &opts.period_start,
            &opts.period_end,
            scale,
            None,
            None,
        ));
        settled.push(id);
    }

    let taken: Vec<String> = entries.iter().map(|e| s(&e.row, "id").to_owned()).collect();
    let carried = carried_entries(db, opts, &taken).await?;
    settled.extend(carried.iter().map(|e| s(&e.row, "id").to_owned()));
    entries.extend(carried);
    Ok(finish(entries, settled))
}

/// `loadWorksheetRows(db, opts)`.
pub(crate) async fn load_worksheet_rows(
    db: &PgPool,
    opts: &LoadRowsOptions,
) -> Result<LoadedRows, sqlx::Error> {
    if opts.cash {
        load_cash(db, opts).await
    } else {
        load_accrual(db, opts).await
    }
}

/// `loadFiledRows(db, args)`: the rows a filed return counted.
pub(crate) async fn load_filed_rows(
    db: &PgPool,
    entity_id: &str,
    agency: &Value,
    ret: &Value,
) -> Result<LoadedRows, sqlx::Error> {
    let return_id = s(ret, "id");
    let period_start = s(ret, "periodStart");
    let period_end = s(ret, "periodEnd");
    if super::common::reporting_basis_of(agency) != "cash" {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(tax_lines),
            " from tax_lines t where t.entity_id = $1 and t.tax_return_id = $2 \
             and t.direction in ('sales', 'use')"
        ))
        .bind(entity_id)
        .bind(return_id)
        .fetch_all(db)
        .await?;
        let entries: Vec<LoadedEntry> = TAX_LINES
            .js_rows(rows)
            .into_iter()
            .map(|row| entry(row, period_start, period_end, 1.0, None, None))
            .collect();
        let settled = entries.iter().map(|e| s(&e.row, "id").to_owned()).collect();
        return Ok(finish(entries, settled));
    }
    let outside: Vec<String> = sqlx::query_scalar(
        "select id from tax_lines where entity_id = $1 and tax_return_id = $2 \
         and (tax_date < $3::date or tax_date > $4::date)",
    )
    .bind(entity_id)
    .bind(return_id)
    .bind(period_start)
    .bind(period_end)
    .fetch_all(db)
    .await?;
    load_cash(
        db,
        &LoadRowsOptions {
            entity_id: entity_id.to_owned(),
            agency_id: s(agency, "id").to_owned(),
            period_start: period_start.to_owned(),
            period_end: period_end.to_owned(),
            cash: true,
            include_stamped_by: vec![return_id.to_owned()],
            carried_ids: outside,
            created_not_after: text(ret, "filedAt").map(str::to_owned),
            created_after: None,
        },
    )
    .await
}
