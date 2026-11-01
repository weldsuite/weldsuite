//! Depreciation schedules of stored assets and books
//! (`services/fixed-assets/schedules.ts`): the yearly schedule of every
//! book, the ledger book's rows by month (or by 4-4-5 period for a
//! 52-53-week entity), and the mid-quarter test over an entity's federal
//! MACRS assets.

use serde_json::Value;
use weldsuite_books_domain::dates::{add_days, add_months, diff_days};
use weldsuite_books_domain::depreciation::{
    ConventionAsset, DepreciationBasis, DepreciationIssue, DepreciationSchedule, FiscalPeriod,
    depreciation_basis, depreciation_schedule, macrs_conventions, mid_quarter_test_basis,
    monthly_schedule,
};
use weldsuite_books_domain::fiscal_year::{FiscalYearConfig, fiscal_periods, fiscal_year_range};
use weldsuite_books_domain::js::math_round;

use super::shared::{
    Conventions, as_number, effective_convention, fiscal_year_periods, fiscal_year_periods_from,
    from_cents, is_macrs_book, is_real_property_book, num, opt, text, to_cents,
    to_depreciation_asset, to_depreciation_book, years_needed,
};

/// `LedgerRowInput`: one stored depreciation amount, before it has an id.
#[derive(Debug, Clone)]
pub(crate) struct LedgerRowInput {
    pub(crate) period_start: String,
    pub(crate) period_end: String,
    pub(crate) amount: f64,
    pub(crate) accumulated: f64,
}

/// `LedgerSchedule`.
pub(crate) struct LedgerSchedule {
    pub(crate) rows: Vec<LedgerRowInput>,
    #[allow(dead_code)] // kept as TypeScript returns it
    pub(crate) basis: DepreciationBasis,
    #[allow(dead_code)]
    pub(crate) issues: Vec<DepreciationIssue>,
}

/// An asset with one of its books (`AssetWithBook`).
pub(crate) type AssetWithBook = (Value, Value);

/// `ScheduleContext`.
pub(crate) struct ScheduleContext {
    pub(crate) config: FiscalYearConfig,
    pub(crate) conventions: Conventions,
}

/// `schedulePeriods(config, asset, book)`.
pub(crate) fn schedule_periods(
    config: &FiscalYearConfig,
    asset: &Value,
    book: &Value,
) -> Vec<FiscalPeriod> {
    fiscal_year_periods_from(
        config,
        text(asset, "placedInServiceDate"),
        years_needed(num(book, "recoveryYears")),
    )
}

/// `midQuarterBasisOf(asset, book)`: cost times business use, less section
/// 179 (bonus does not reduce it).
pub(crate) fn mid_quarter_basis_of(asset: &Value, book: &Value) -> f64 {
    let domain = to_depreciation_asset(asset, None, Some(book));
    let basis = depreciation_basis(&domain, &to_depreciation_book(book, None));
    mid_quarter_test_basis(
        domain.cost,
        domain.business_use_percent.unwrap_or(100.0),
        basis.section179,
    )
}

/// `macrsConventionMap(config, rows)`: the convention of every federal
/// MACRS asset, from the mid-quarter test of the years they were placed in
/// service in.
pub(crate) fn macrs_convention_map(
    config: &FiscalYearConfig,
    rows: &[AssetWithBook],
) -> Conventions {
    let federal: Vec<&AssetWithBook> = rows
        .iter()
        .filter(|(_, book)| text(book, "book") == "federal" && is_macrs_book(book))
        .collect();
    if federal.is_empty() {
        return Conventions::new();
    }
    let years: Vec<i64> = federal
        .iter()
        .filter_map(|(asset, _)| {
            fiscal_year_range(config, text(asset, "placedInServiceDate")).map(|y| y.year)
        })
        .collect();
    let (Some(first), Some(last)) = (years.iter().min(), years.iter().max()) else {
        return Conventions::new();
    };
    let periods = fiscal_year_periods(config, *first, last - first + 1);
    let assets: Vec<ConventionAsset> = federal
        .iter()
        .map(|(asset, book)| ConventionAsset {
            id: text(asset, "id").to_owned(),
            placed_in_service_date: text(asset, "placedInServiceDate").to_owned(),
            basis: mid_quarter_basis_of(asset, book),
            real_property: is_real_property_book(book),
            disposal_date: opt(asset, "disposalDate").map(str::to_owned),
        })
        .collect();
    macrs_conventions(&assets, &periods)
}

/// `annualSchedule(asset, book, context, overrides)`: the yearly
/// depreciation of one book, under the convention the mid-quarter test gives.
pub(crate) fn annual_schedule(
    asset: &Value,
    book: &Value,
    context: &ScheduleContext,
) -> DepreciationSchedule {
    let convention = effective_convention(book, text(asset, "id"), &context.conventions);
    depreciation_schedule(
        &to_depreciation_asset(asset, None, Some(book)),
        &to_depreciation_book(book, Some(&convention)),
        &schedule_periods(&context.config, asset, book),
    )
}

fn overlap_days(a_start: &str, a_end: &str, b_start: &str, b_end: &str) -> i64 {
    let start = if a_start > b_start { a_start } else { b_start };
    let end = if a_end < b_end { a_end } else { b_end };
    if start > end {
        0
    } else {
        diff_days(start, end).unwrap_or(0) + 1
    }
}

/// `splitCents(totalCents, weights)`: the remainder goes to the last period
/// that has weight.
#[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
fn split_cents(total_cents: i64, weights: &[i64]) -> Vec<i64> {
    let sum: i64 = weights.iter().sum();
    let mut result = vec![0; weights.len()];
    if sum <= 0 {
        return result;
    }
    let mut assigned = 0;
    let mut last_weighted = 0;
    for (index, weight) in weights.iter().enumerate() {
        if *weight <= 0 {
            continue;
        }
        result[index] = ((total_cents as f64 * *weight as f64) / sum as f64).floor() as i64;
        assigned += result[index];
        last_weighted = index;
    }
    result[last_weighted] += total_cents - assigned;
    result
}

/// `periodLedgerRows(...)`: yearly amounts over a 52-53-week year's twelve
/// periods, by the days the asset is in service in each.
#[allow(clippy::cast_possible_truncation)]
fn period_ledger_rows(
    asset: &Value,
    book: &Value,
    config: &FiscalYearConfig,
    yearly: &DepreciationSchedule,
    disposal_date: Option<&str>,
) -> Vec<LedgerRowInput> {
    let service_start = text(asset, "placedInServiceDate");
    let months = math_round(num(book, "recoveryYears") * 12.0) as i64;
    let life_end = add_months(service_start, months)
        .and_then(|d| add_days(&d, -1))
        .unwrap_or_default();
    let service_end = match disposal_date {
        Some(d) if !d.is_empty() && d < life_end.as_str() => d.to_owned(),
        _ => life_end,
    };
    let mut rows = Vec::new();
    let mut accumulated = 0;
    for year in &yearly.rows {
        let Some(fiscal_year) = fiscal_year_range(config, &year.period_start) else {
            continue;
        };
        let periods = fiscal_periods(config, fiscal_year.year).unwrap_or_default();
        let mut weights: Vec<i64> = periods
            .iter()
            .map(|p| overlap_days(&p.start, &p.end, service_start, &service_end))
            .collect();
        if text(book, "method") == "expensed" || weights.iter().all(|w| *w == 0) {
            // Written off in the period it is placed in service.
            weights = periods
                .iter()
                .map(|p| {
                    i64::from(service_start >= p.start.as_str() && service_start <= p.end.as_str())
                })
                .collect();
        }
        let shares = split_cents(to_cents(year.amount), &weights);
        for (period, cents) in periods.iter().zip(shares) {
            if cents == 0 {
                continue;
            }
            accumulated += cents;
            rows.push(LedgerRowInput {
                period_start: period.start.clone(),
                period_end: period.end.clone(),
                amount: from_cents(cents),
                accumulated: from_cents(accumulated),
            });
        }
    }
    rows
}

/// `ledgerRows(asset, book, config, overrides)`: the ledger book's
/// depreciation by month (or 4-4-5 period): what `fixed_asset_depreciation`
/// holds and the monthly run posts. `disposal` overrides the asset's own
/// disposal date (`Some(None)` clears it).
pub(crate) fn ledger_rows(
    asset: &Value,
    book: &Value,
    config: &FiscalYearConfig,
    disposal: Option<Option<&str>>,
) -> LedgerSchedule {
    let domain_asset = to_depreciation_asset(asset, disposal, Some(book));
    let domain_book = to_depreciation_book(book, None);
    let periods = schedule_periods(config, asset, book);
    if matches!(config, FiscalYearConfig::Month { .. }) {
        let monthly = monthly_schedule(&domain_asset, &domain_book, &periods);
        return LedgerSchedule {
            rows: monthly
                .rows
                .into_iter()
                .map(|row| LedgerRowInput {
                    period_start: row.period_start,
                    period_end: row.period_end,
                    amount: row.amount,
                    accumulated: row.accumulated,
                })
                .collect(),
            basis: monthly.basis,
            issues: monthly.issues,
        };
    }
    let yearly = depreciation_schedule(&domain_asset, &domain_book, &periods);
    let rows = period_ledger_rows(
        asset,
        book,
        config,
        &yearly,
        domain_asset.disposal_date.as_deref(),
    );
    LedgerSchedule {
        rows,
        basis: yearly.basis,
        issues: yearly.issues,
    }
}

/// `asNumber(asset.businessUsePercent, 100)`.
pub(crate) fn business_use(asset: &Value) -> f64 {
    as_number(asset.get("businessUsePercent"), 100.0)
}
