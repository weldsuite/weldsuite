//! Project finance and earned value: the pure rules (`packages/domains/flow/src/finance.ts`,
//! design weldflow-delivery-and-portfolio.md "Finance and earned value"; ADR FLOW-019).
//!
//! Nothing here reads a database. The operations run in TypeScript's order so
//! the floating point results are the same bit for bit.

use crate::js::{civil_from_days, days_from_civil, math_round};

/// Time entry statuses that count as actual cost.
pub const COUNTED_TIME_STATUSES: [&str; 2] = ["approved", "billed"];
/// Bill statuses that are posted.
pub const COUNTED_BILL_STATUSES: [&str; 4] = ["approved", "partial", "overdue", "paid"];
/// Purchase order statuses whose unreceived lines are a commitment.
pub const COMMITTED_PO_STATUSES: [&str; 3] = ["approved", "ordered", "partial"];
/// Expense declaration statuses that count.
pub const COUNTED_DECLARATION_STATUSES: [&str; 2] = ["approved", "paid"];
/// Journal entry statuses in the ledger.
pub const COUNTED_JOURNAL_STATUSES: [&str; 2] = ["posted", "reversed"];

const DAY_MS: i64 = 86_400_000;

/// `roundMoney`: two decimals, half away from zero.
pub fn round_money(value: f64) -> f64 {
    let rounded = math_round(value.abs() * 100.0) / 100.0;
    if value < 0.0 { -rounded } else { rounded }
}

/// `(days since the epoch, weekday with Monday = 0)` of a moment.
fn day_and_weekday(ms: i64) -> (i64, i64) {
    let days = ms.div_euclid(DAY_MS);
    (days, (days + 3).rem_euclid(7))
}

/// `isoWeekKey`: the ISO week (`YYYY-Www`, UTC) a moment falls in.
pub fn iso_week_key(ms: i64) -> String {
    let (days, day) = day_and_weekday(ms);
    // The Thursday of this week decides the ISO year.
    let thursday = days + (3 - day);
    let (year, _, _) = civil_from_days(thursday);
    let jan4 = days_from_civil(year, 1, 4);
    let first_thursday = jan4 + (3 - (jan4 + 3).rem_euclid(7));
    let week = (thursday - first_thursday).div_euclid(7) + 1;
    format!("{year}-W{week:02}")
}

/// `nextWeekStartMs`: Monday 00:00 UTC of the week after the one `ms` falls in.
pub fn next_week_start_ms(ms: i64) -> i64 {
    let (days, day) = day_and_weekday(ms);
    (days + (7 - day)) * DAY_MS
}

/// `budgetShares`: each item's share of the budget by planned hours; an even
/// split when there are no hours at all.
pub fn budget_shares(hours: &[f64]) -> Vec<f64> {
    if hours.is_empty() {
        return Vec::new();
    }
    let clean: Vec<f64> = hours
        .iter()
        .map(|h| if h.is_finite() && *h > 0.0 { *h } else { 0.0 })
        .collect();
    let total: f64 = clean.iter().sum();
    #[allow(clippy::cast_precision_loss)]
    if total <= 0.0 {
        return clean.iter().map(|_| 1.0 / clean.len() as f64).collect();
    }
    clean.iter().map(|h| h / total).collect()
}

/// A task as `percentDone` reads it.
#[derive(Debug, Clone, Copy)]
pub struct DoneTask {
    pub done: bool,
    pub hours: Option<f64>,
}

/// `percentDone`: the fraction (0 to 1) of the work done, weighted by estimate.
pub fn percent_done(tasks: &[DoneTask]) -> f64 {
    if tasks.is_empty() {
        return 0.0;
    }
    let weight = |t: &DoneTask| match t.hours {
        Some(h) if h.is_finite() && h > 0.0 => h,
        _ => 0.0,
    };
    let total: f64 = tasks.iter().map(weight).sum();
    #[allow(clippy::cast_precision_loss)]
    if total <= 0.0 {
        return tasks.iter().filter(|t| t.done).count() as f64 / tasks.len() as f64;
    }
    tasks
        .iter()
        .map(|t| if t.done { weight(t) } else { 0.0 })
        .sum::<f64>()
        / total
}

/// `plannedFraction`: how much of an item's work should be done at `now`.
pub fn planned_fraction(start: Option<i64>, end: Option<i64>, now: i64) -> Option<f64> {
    if start.is_none() && end.is_none() {
        return None;
    }
    let start = start.or(end)?;
    let end = end.unwrap_or(start);
    if end <= start {
        return Some(if now >= end { 1.0 } else { 0.0 });
    }
    if now <= start {
        return Some(0.0);
    }
    if now >= end {
        return Some(1.0);
    }
    #[allow(clippy::cast_precision_loss)]
    Some((now - start) as f64 / (end - start) as f64)
}

/// An item of the earned value computation.
#[derive(Debug, Clone)]
pub struct EvmItem {
    pub id: Option<String>,
    pub planned_hours: f64,
    pub planned_start: Option<i64>,
    pub planned_end: Option<i64>,
    pub percent_done: f64,
}

/// One item's result.
#[derive(Debug, Clone, PartialEq)]
pub struct EvmItemResult {
    pub id: Option<String>,
    pub share: f64,
    pub budget: f64,
    pub planned_value: f64,
    pub earned_value: f64,
}

/// The whole result.
#[derive(Debug, Clone, PartialEq)]
pub struct EvmResult {
    pub items: Vec<EvmItemResult>,
    pub planned_value: f64,
    pub earned_value: f64,
}

/// `computeEvm`.
pub fn compute_evm(
    budget: Option<f64>,
    items: &[EvmItem],
    span_start: Option<i64>,
    span_end: Option<i64>,
    now: i64,
) -> EvmResult {
    let budget = match budget {
        Some(b) if b.is_finite() && b > 0.0 => b,
        _ => 0.0,
    };
    let hours: Vec<f64> = items.iter().map(|i| i.planned_hours).collect();
    let shares = budget_shares(&hours);
    let results: Vec<EvmItemResult> = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let item_budget = budget * shares[i];
            let has_dates = item.planned_start.is_some() || item.planned_end.is_some();
            let fraction = if has_dates {
                planned_fraction(item.planned_start, item.planned_end, now)
            } else {
                planned_fraction(span_start, span_end, now)
            };
            let done = item.percent_done.clamp(0.0, 1.0);
            EvmItemResult {
                id: item.id.clone(),
                share: shares[i],
                budget: item_budget,
                planned_value: item_budget * fraction.unwrap_or(0.0),
                earned_value: item_budget * done,
            }
        })
        .collect();
    let planned_value = results.iter().map(|r| r.planned_value).sum();
    let earned_value = results.iter().map(|r| r.earned_value).sum();
    EvmResult {
        items: results,
        planned_value,
        earned_value,
    }
}

/// `ratio`: `numerator / denominator`, none when the denominator is not positive.
pub fn ratio(numerator: f64, denominator: f64) -> Option<f64> {
    (denominator > 0.0).then(|| numerator / denominator)
}

/// `roundRatio`: two decimals.
pub fn round_ratio(value: Option<f64>) -> Option<f64> {
    value.map(|v| math_round(v * 100.0) / 100.0)
}

/// Where a forecast came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForecastSource {
    Manual,
    Cpi,
    Budget,
}

impl ForecastSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Cpi => "cpi",
            Self::Budget => "budget",
        }
    }
}

/// `forecastAtCompletion`: the manual forecast, else budget / CPI, else the
/// budget (never below what is spent and committed). `None` without a budget.
pub fn forecast_at_completion(
    budget: Option<f64>,
    actual: f64,
    committed: f64,
    cpi: Option<f64>,
    manual: Option<f64>,
) -> Option<(f64, ForecastSource)> {
    if let Some(manual) = manual {
        return Some((manual, ForecastSource::Manual));
    }
    let budget = budget.filter(|b| *b > 0.0)?;
    if let Some(cpi) = cpi.filter(|c| *c > 0.0) {
        return Some((budget / cpi, ForecastSource::Cpi));
    }
    Some((budget.max(actual + committed), ForecastSource::Budget))
}

/// `percentOf`: `part` as a percentage of `whole`, one decimal.
pub fn percent_of(part: f64, whole: Option<f64>) -> Option<f64> {
    let whole = whole.filter(|w| *w > 0.0)?;
    Some(math_round((part / whole) * 1000.0) / 10.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(text: &str) -> i64 {
        crate::js::millis_of(text).expect("a date")
    }

    #[test]
    fn iso_weeks_cross_year_borders() {
        assert_eq!(iso_week_key(ms("2026-11-02T08:00:00.000Z")), "2026-W45");
        assert_eq!(iso_week_key(ms("2026-01-01T00:00:00.000Z")), "2026-W01");
        assert_eq!(iso_week_key(ms("2027-01-01T00:00:00.000Z")), "2026-W53");
        assert_eq!(iso_week_key(ms("2024-12-30T00:00:00.000Z")), "2025-W01");
    }

    #[test]
    fn the_next_week_starts_on_monday() {
        assert_eq!(
            next_week_start_ms(ms("2026-11-04T10:00:00.000Z")),
            ms("2026-11-09T00:00:00.000Z")
        );
        assert_eq!(
            next_week_start_ms(ms("2026-11-02T00:00:00.000Z")),
            ms("2026-11-09T00:00:00.000Z")
        );
    }

    #[test]
    fn shares_follow_hours() {
        assert_eq!(budget_shares(&[10.0, 30.0]), vec![0.25, 0.75]);
        assert_eq!(budget_shares(&[0.0, 0.0]), vec![0.5, 0.5]);
        assert_eq!(budget_shares(&[]).len(), 0);
    }

    #[test]
    fn done_is_weighted_by_estimate() {
        let t = |done, hours| DoneTask { done, hours };
        assert!((percent_done(&[t(true, Some(10.0)), t(false, Some(30.0))]) - 0.25).abs() < 1e-12);
        assert!((percent_done(&[t(true, None), t(false, None)]) - 0.5).abs() < 1e-12);
        assert!(percent_done(&[]).abs() < 1e-12);
    }

    #[test]
    fn planned_fraction_is_linear() {
        assert_eq!(planned_fraction(Some(0), Some(100), 25), Some(0.25));
        assert_eq!(planned_fraction(Some(0), Some(100), -5), Some(0.0));
        assert_eq!(planned_fraction(Some(0), Some(100), 500), Some(1.0));
        assert_eq!(planned_fraction(None, Some(100), 99), Some(0.0));
        assert_eq!(planned_fraction(None, Some(100), 100), Some(1.0));
        assert_eq!(planned_fraction(None, None, 1), None);
    }

    #[test]
    fn evm_spreads_the_budget() {
        let items = [
            EvmItem {
                id: Some("a".into()),
                planned_hours: 10.0,
                planned_start: Some(0),
                planned_end: Some(100),
                percent_done: 0.5,
            },
            EvmItem {
                id: Some("b".into()),
                planned_hours: 30.0,
                planned_start: Some(0),
                planned_end: Some(200),
                percent_done: 0.0,
            },
        ];
        let result = compute_evm(Some(1000.0), &items, Some(0), Some(200), 100);
        assert_eq!(
            result.items.iter().map(|i| i.budget).collect::<Vec<_>>(),
            vec![250.0, 750.0]
        );
        assert_eq!(result.planned_value, 250.0 + 375.0);
        assert_eq!(result.earned_value, 125.0);
    }

    #[test]
    fn forecasts() {
        assert_eq!(
            forecast_at_completion(Some(1000.0), 500.0, 0.0, Some(0.5), None),
            Some((2000.0, ForecastSource::Cpi))
        );
        assert_eq!(
            forecast_at_completion(Some(1000.0), 500.0, 0.0, Some(0.5), Some(1500.0)),
            Some((1500.0, ForecastSource::Manual))
        );
        assert_eq!(
            forecast_at_completion(Some(1000.0), 900.0, 300.0, Some(0.0), None),
            Some((1200.0, ForecastSource::Budget))
        );
        assert_eq!(forecast_at_completion(None, 0.0, 0.0, None, None), None);
    }

    #[test]
    fn helpers_round() {
        assert_eq!(round_money(1.006), 1.01);
        assert_eq!(round_money(-2.346), -2.35);
        assert_eq!(ratio(1.0, 0.0), None);
        assert_eq!(percent_of(56.0, Some(100.0)), Some(56.0));
        assert_eq!(percent_of(1.0, None), None);
    }
}
