//! What every financial report reads (books-api `services/accounting-reports-basis.ts`
//! and `services/accounting-report-periods.ts`): the [`ledger`] on accrual or
//! cash basis, and the [`periods`] (fiscal-year defaults, comparative and
//! month / quarter columns).
//!
//! Dates are whole days (`YYYY-MM-DD`) at the edges and instants (epoch
//! milliseconds, JavaScript's `Date`) inside a ledger.

pub mod ledger;
pub mod periods;

pub use ledger::{
    AggregateOptions, AggregateRow, Basis, Ledger, LedgerAccount, LedgerFilters, LedgerLine,
    LedgerRange, UNAPPLIED_EXPENSE_ACCOUNT_ID, UNAPPLIED_INCOME_ACCOUNT_ID, create_ledger,
    parse_basis, resolve_basis,
};
pub use periods::{
    CompareMode, DateRange, PeriodsMode, ReportColumn, fiscal_year_containing, fiscal_year_named,
    parse_compare, parse_periods, period_columns, point_in_time_columns, prior_period_of,
    prior_year_of, require_iso_date, resolve_period, split_columns, today_for,
};

/// `ReportInputError`: a bad request parameter (the routes answer 400 with
/// its message).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportInputError(pub String);

impl ReportInputError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for ReportInputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ReportInputError {}

/// Which edge of a whole day a `YYYY-MM-DD` stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Start,
    End,
}

/// `parseReportDate(value, edge)`: `YYYY-MM-DD` is a whole day (UTC),
/// anything else an instant; epoch milliseconds.
pub fn parse_report_date(value: &str, edge: Edge) -> Result<i64, ReportInputError> {
    let date_only = value.len() == 10
        && value.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    let millis = if date_only {
        let time = match edge {
            Edge::Start => "00:00:00.000",
            Edge::End => "23:59:59.999",
        };
        crate::js::js_date_millis(&format!("{value}T{time}Z"))
    } else {
        crate::js::js_date_millis(value)
    };
    millis.ok_or_else(|| ReportInputError(format!("Invalid date '{value}'")))
}

/// `date.toISOString()`, for binding an instant to a `timestamp` column.
pub fn iso(millis: i64) -> String {
    crate::js::iso_from_millis(millis).unwrap_or_default()
}

/// `isoDay(date)`: `toISOString().slice(0, 10)`.
pub fn iso_day(millis: i64) -> String {
    iso(millis).chars().take(10).collect()
}

/// `money(value)` of the report builders: rounded to cents, `-0.00` never.
pub fn money(value: f64) -> String {
    let rounded = crate::js::round_money(value);
    crate::js::to_fixed(if rounded.abs() < 0.005 { 0.0 } else { rounded }, 2)
}

/// `a.localeCompare(b, 'en', { numeric: true })`: digit runs compare by value.
pub fn numeric_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use icu_collator::options::CollatorOptions;
    use icu_collator::preferences::CollationNumericOrdering;
    use icu_collator::{CollatorBorrowed, CollatorPreferences};
    static COLLATOR: std::sync::LazyLock<Option<CollatorBorrowed<'static>>> =
        std::sync::LazyLock::new(|| {
            let mut prefs = CollatorPreferences::default();
            prefs.numeric_ordering = Some(CollationNumericOrdering::True);
            CollatorBorrowed::try_new(prefs, CollatorOptions::default()).ok()
        });
    COLLATOR
        .as_ref()
        .map_or_else(|| a.cmp(b), |collator| collator.compare(a, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_dates_are_whole_days() {
        let start = parse_report_date("2026-07-01", Edge::Start).expect("a date");
        let end = parse_report_date("2026-07-01", Edge::End).expect("a date");
        assert_eq!(iso(start), "2026-07-01T00:00:00.000Z");
        assert_eq!(iso(end), "2026-07-01T23:59:59.999Z");
        assert_eq!(
            parse_report_date("nope", Edge::Start),
            Err(ReportInputError::new("Invalid date 'nope'"))
        );
    }

    #[test]
    fn money_never_prints_minus_zero() {
        assert_eq!(money(-0.001), "0.00");
        assert_eq!(money(10.0), "10.00");
        assert_eq!(money(-12.5), "-12.50");
    }

    #[test]
    fn codes_sort_numerically() {
        assert_eq!(numeric_compare("2", "10"), std::cmp::Ordering::Less);
        assert_eq!(numeric_compare("1300", "1300"), std::cmp::Ordering::Equal);
    }
}
