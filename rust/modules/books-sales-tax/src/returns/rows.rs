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

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Query as SqlQuery};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect};
use serde_json::Value;
use weldsuite_books_domain::sales_tax::worksheet::WorksheetLine;
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{invoices, payment_allocations, payments, tax_lines};

use super::common::{
    decimal_num, next_day, num_at, parse_day, parse_instant, round2, rows_json, s, start_of_day,
};
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
pub(crate) async fn rows_by_ids(db: &PgPool, ids: &[String]) -> Result<Vec<Value>, DbErr> {
    let mut out = Vec::new();
    for part in ids.chunks(ID_CHUNK) {
        let rows = tax_lines::Entity::find()
            .filter(tax_lines::Column::Id.is_in(part.iter().map(String::as_str)))
            .all(&orm(db))
            .await?;
        out.extend(rows_json(rows)?);
    }
    Ok(out)
}

async fn carried_entries(
    db: &PgPool,
    opts: &LoadRowsOptions,
    taken: &[String],
) -> Result<Vec<LoadedEntry>, DbErr> {
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
) -> Result<Vec<Value>, DbErr> {
    use tax_lines::Column;
    let mut select = tax_lines::Entity::find()
        .filter(Column::EntityId.eq(opts.entity_id.as_str()))
        .filter(Column::AgencyId.eq(opts.agency_id.as_str()))
        .filter(Column::TaxDate.gte(parse_day(&opts.period_start)?))
        .filter(Column::TaxDate.lte(parse_day(&opts.period_end)?))
        .filter(Column::Direction.is_in(LEDGER_DIRECTIONS));
    if non_invoice {
        select = select.filter(Column::SourceType.ne("invoice"));
    }
    // `tax_return_id is null or tax_return_id = any($ids)`: `any('{}')` is false.
    let mut unstamped = Condition::any().add(Column::TaxReturnId.is_null());
    if !opts.include_stamped_by.is_empty() {
        unstamped = unstamped
            .add(Column::TaxReturnId.is_in(opts.include_stamped_by.iter().map(String::as_str)));
    }
    select = select.filter(unstamped);
    if let Some(at) = &opts.created_not_after {
        select = select.filter(Column::CreatedAt.lte(parse_instant(at)?));
    }
    if let Some(at) = &opts.created_after {
        select = select.filter(Column::CreatedAt.gt(parse_instant(at)?));
    }
    rows_json(select.all(&orm(db)).await?)
}

async fn load_accrual(db: &PgPool, opts: &LoadRowsOptions) -> Result<LoadedRows, DbErr> {
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

/// Adds `amount` (a `numeric` read as text, as a number) to the invoice's total.
fn add_total(
    totals: &mut Vec<(String, f64)>,
    invoice_id: Option<String>,
    amount: Option<&BigDecimal>,
) {
    let Some(id) = invoice_id.filter(|i| !i.is_empty()) else {
        return;
    };
    let value = decimal_num(amount);
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
) -> Result<Vec<(String, f64)>, DbErr> {
    let mut totals: Vec<(String, f64)> = Vec::new();
    let parts: Vec<Option<&[String]>> = match filter.invoice_ids {
        Some(ids) => ids.chunks(ID_CHUNK).map(Some).collect(),
        None => vec![None],
    };
    let window = received_window(entity_id, filter)?;
    for part in parts {
        for (id, amount) in allocated_payments(db, window.clone(), part).await? {
            add_total(&mut totals, id, amount.as_ref());
        }
        for (id, amount) in unallocated_payments(db, window.clone(), part).await? {
            add_total(&mut totals, id, Some(&amount));
        }
    }
    Ok(totals)
}

/// The entity's live received payments dated and created in the filter's
/// window (each bound left out when the filter has none).
fn received_window(entity_id: &str, filter: &ReceivedFilter<'_>) -> Result<Condition, DbErr> {
    use payments::Column;
    let mut window = Condition::all()
        .add(Column::EntityId.eq(entity_id))
        .add(Column::DeletedAt.is_null())
        .add(Column::Type.eq("received"));
    if let Some(from) = &filter.from {
        window = window.add(Column::Date.gte(parse_instant(from)?));
    }
    if let Some(before) = &filter.before {
        window = window.add(Column::Date.lt(parse_instant(before)?));
    }
    if let Some(at) = &filter.created_not_after {
        window = window.add(Column::CreatedAt.lte(parse_instant(at)?));
    }
    if let Some(at) = &filter.created_after {
        window = window.add(Column::CreatedAt.gt(parse_instant(at)?));
    }
    Ok(window)
}

/// `sum(pa.amount)` per invoice of the live allocations of the payments in
/// `window` (`payment_allocations pa inner join payments p`), of the
/// invoices in `part` when given.
async fn allocated_payments(
    db: &PgPool,
    window: Condition,
    part: Option<&[String]>,
) -> Result<Vec<(Option<String>, Option<BigDecimal>)>, DbErr> {
    use payment_allocations::Column;
    let mut select = payment_allocations::Entity::find()
        .select_only()
        .column(Column::InvoiceId)
        .column_as(Column::Amount.sum(), "amount")
        .join(
            JoinType::InnerJoin,
            payment_allocations::Entity::belongs_to(payments::Entity)
                .from(Column::PaymentId)
                .to(payments::Column::Id)
                .into(),
        )
        .filter(window)
        .filter(Column::DeletedAt.is_null())
        .filter(Column::InvoiceId.is_not_null());
    if let Some(part) = part {
        select = select.filter(Column::InvoiceId.is_in(part.iter().map(String::as_str)));
    }
    select
        .group_by(Column::InvoiceId)
        .into_tuple()
        .all(&orm(db))
        .await
}

/// The payments in `window` made straight to an invoice (no live
/// allocations: `not exists`), of the invoices in `part` when given.
async fn unallocated_payments(
    db: &PgPool,
    window: Condition,
    part: Option<&[String]>,
) -> Result<Vec<(Option<String>, BigDecimal)>, DbErr> {
    use payments::Column;
    use sea_orm::ExprTrait as _;
    let allocations = SqlQuery::select()
        .expr(Expr::val(1))
        .from(payment_allocations::Entity)
        .and_where(
            Expr::col((
                payment_allocations::Entity,
                payment_allocations::Column::PaymentId,
            ))
            .equals((payments::Entity, Column::Id)),
        )
        .and_where(payment_allocations::Column::DeletedAt.is_null())
        .to_owned();
    let mut select = payments::Entity::find()
        .select_only()
        .columns([Column::InvoiceId, Column::Amount])
        .filter(window)
        .filter(Column::InvoiceId.is_not_null())
        .filter(Expr::not_exists(allocations));
    if let Some(part) = part {
        select = select.filter(Column::InvoiceId.is_in(part.iter().map(String::as_str)));
    }
    select.into_tuple().all(&orm(db)).await
}

fn total_of(totals: &[(String, f64)], id: &str) -> Option<f64> {
    totals.iter().find(|(k, _)| k == id).map(|(_, v)| *v)
}

/// `invoiceTotals(db, entityId, ids)`: `(id, total, creditNoteFor)`.
async fn invoice_totals(
    db: &PgPool,
    entity_id: &str,
    ids: &[String],
) -> Result<Vec<(String, f64, Option<String>)>, DbErr> {
    use invoices::Column;
    let mut out = Vec::new();
    for part in ids.chunks(ID_CHUNK) {
        let rows: Vec<(String, Option<BigDecimal>, Option<String>)> = invoices::Entity::find()
            .select_only()
            .columns([Column::Id, Column::Total, Column::CreditNoteForInvoiceId])
            .filter(Column::EntityId.eq(entity_id))
            .filter(Column::Id.is_in(part.iter().map(String::as_str)))
            .into_tuple()
            .all(&orm(db))
            .await?;
        for (id, total, credit_note_for) in rows {
            // `total::text`, read as a number.
            out.push((id, decimal_num(total.as_ref()), credit_note_for));
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
async fn load_cash(db: &PgPool, opts: &LoadRowsOptions) -> Result<LoadedRows, DbErr> {
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
            use tax_lines::Column;
            let found = tax_lines::Entity::find()
                .filter(Column::EntityId.eq(opts.entity_id.as_str()))
                .filter(Column::AgencyId.eq(opts.agency_id.as_str()))
                .filter(Column::SourceType.eq("invoice"))
                .filter(Column::SourceId.is_in(part.iter().map(String::as_str)))
                .filter(Column::Direction.is_in(LEDGER_DIRECTIONS))
                .all(&orm(db))
                .await?;
            rows.extend(rows_json(found)?);
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
) -> Result<LoadedRows, DbErr> {
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
) -> Result<LoadedRows, DbErr> {
    use tax_lines::Column;
    let return_id = s(ret, "id");
    let period_start = s(ret, "periodStart");
    let period_end = s(ret, "periodEnd");
    if super::common::reporting_basis_of(agency) != "cash" {
        let rows = tax_lines::Entity::find()
            .filter(Column::EntityId.eq(entity_id))
            .filter(Column::TaxReturnId.eq(return_id))
            .filter(Column::Direction.is_in(LEDGER_DIRECTIONS))
            .all(&orm(db))
            .await?;
        let entries: Vec<LoadedEntry> = rows_json(rows)?
            .into_iter()
            .map(|row| entry(row, period_start, period_end, 1.0, None, None))
            .collect();
        let settled = entries.iter().map(|e| s(&e.row, "id").to_owned()).collect();
        return Ok(finish(entries, settled));
    }
    let outside: Vec<String> = tax_lines::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::TaxReturnId.eq(return_id))
        .filter(
            Condition::any()
                .add(Column::TaxDate.lt(parse_day(period_start)?))
                .add(Column::TaxDate.gt(parse_day(period_end)?)),
        )
        .into_tuple()
        .all(&orm(db))
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
