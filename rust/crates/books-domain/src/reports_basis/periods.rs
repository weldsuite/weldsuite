//! Date ranges and columns of the financial reports
//! (`services/accounting-report-periods.ts`): fiscal-year defaults,
//! comparative columns (prior period, prior year) and month / quarter
//! columns. Dates are `YYYY-MM-DD`, inclusive on both ends.

use serde_json::{Value, json};

use super::ReportInputError;
use crate::dates::{add_days, add_months, diff_days, end_of_month, is_iso_date, parse_iso};
use crate::fiscal_year::{
    FiscalYearConfig, fiscal_periods, fiscal_year_config_of, fiscal_year_for, fiscal_year_range,
};

/// `DateRange`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateRange {
    pub from: String,
    pub to: String,
}

impl DateRange {
    pub fn json(&self) -> Value {
        json!({ "from": self.from, "to": self.to })
    }
}

/// `ReportColumn`: `from` is `None` on point-in-time columns (balance sheet).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportColumn {
    pub key: String,
    pub label: String,
    pub from: Option<String>,
    pub to: String,
}

impl ReportColumn {
    pub fn json(&self) -> Value {
        json!({ "key": self.key, "label": self.label, "from": self.from, "to": self.to })
    }
}

/// `CompareMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareMode {
    PriorPeriod,
    PriorYear,
}

impl CompareMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PriorPeriod => "prior_period",
            Self::PriorYear => "prior_year",
        }
    }
}

/// `PeriodsMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeriodsMode {
    Months,
    Quarters,
}

/// The fiscal-year fields of an entity row (`fiscalYearStart`,
/// `fiscalYearConfig`): `fiscalConfigOf(entity)`.
pub fn fiscal_config_of(entity: &Value) -> FiscalYearConfig {
    fiscal_year_config_of(
        entity.get("fiscalYearStart").and_then(Value::as_f64),
        entity.get("fiscalYearConfig"),
    )
}

fn broken(what: &str) -> ReportInputError {
    // TypeScript computes on NaN here; every caller passes validated dates.
    ReportInputError::new(format!("Invalid date '{what}'"))
}

/// `todayFor(entity, now)`: today in the entity's time zone (UTC when it
/// has none, or one `Intl` doesn't know).
pub fn today_for(timezone: Option<&str>, now_ms: i64) -> String {
    let instant = jiff::Timestamp::from_millisecond(now_ms).unwrap_or(jiff::Timestamp::UNIX_EPOCH);
    let zone = timezone
        .filter(|tz| !tz.is_empty())
        .map_or(Ok(jiff::tz::TimeZone::UTC), jiff::tz::TimeZone::get)
        .unwrap_or(jiff::tz::TimeZone::UTC);
    let date = instant.to_zoned(zone).date();
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        date.month(),
        date.day()
    )
}

/// `requireIsoDate(value, name)`: a full ISO timestamp from older clients
/// counts as its day.
pub fn require_iso_date(value: &str, name: &str) -> Result<String, ReportInputError> {
    let day = if crate::js::utf16_len(value) > 10 {
        crate::js::slice_utf16(value, 10)
    } else {
        value.to_owned()
    };
    if !is_iso_date(&day) {
        return Err(ReportInputError::new(format!(
            "{name} must be a date (YYYY-MM-DD)"
        )));
    }
    Ok(day)
}

/// `fiscalYearContaining(entity, date)`.
pub fn fiscal_year_containing(entity: &Value, date: &str) -> Result<DateRange, ReportInputError> {
    let range = fiscal_year_range(&fiscal_config_of(entity), date).ok_or_else(|| broken(date))?;
    Ok(DateRange {
        from: range.start,
        to: range.end,
    })
}

/// `fiscalYearNamed(entity, year)`: named for the calendar year it ends in.
pub fn fiscal_year_named(entity: &Value, year: i64) -> Result<DateRange, ReportInputError> {
    let range =
        fiscal_year_for(&fiscal_config_of(entity), year).ok_or_else(|| broken(&year.to_string()))?;
    Ok(DateRange {
        from: range.start,
        to: range.end,
    })
}

/// `resolvePeriod(entity, query, today)`: explicit dates win, a missing end
/// is today, a missing start the start of the fiscal year the end falls in.
pub fn resolve_period(
    entity: &Value,
    from: Option<&str>,
    to: Option<&str>,
    today: &str,
) -> Result<DateRange, ReportInputError> {
    let to = match to.filter(|v| !v.is_empty()) {
        Some(value) => require_iso_date(value, "to")?,
        None => today.to_owned(),
    };
    let from = match from.filter(|v| !v.is_empty()) {
        Some(value) => require_iso_date(value, "from")?,
        None => fiscal_year_containing(entity, &to)?.from,
    };
    if from > to {
        return Err(ReportInputError::new("from must be on or before to"));
    }
    Ok(DateRange { from, to })
}

fn is_whole_months(range: &DateRange) -> bool {
    range.from.ends_with("-01") && end_of_month(&range.to).as_deref() == Some(range.to.as_str())
}

/// `priorPeriod(range)` (`us-compliance/fiscal-year`): the range of the same
/// length right before.
pub fn prior_period_of(range: &DateRange) -> Result<DateRange, ReportInputError> {
    let fail = || broken(&range.from);
    if is_whole_months(range) {
        let s = parse_iso(&range.from).ok_or_else(fail)?;
        let e = parse_iso(&range.to).ok_or_else(fail)?;
        let months = (e.y * 12 + e.m) - (s.y * 12 + s.m) + 1;
        let end = add_months(&range.to, -months).ok_or_else(fail)?;
        return Ok(DateRange {
            from: add_months(&range.from, -months).ok_or_else(fail)?,
            to: end_of_month(&end).ok_or_else(fail)?,
        });
    }
    let length = diff_days(&range.from, &range.to).ok_or_else(fail)? + 1;
    Ok(DateRange {
        from: add_days(&range.from, -length).ok_or_else(fail)?,
        to: add_days(&range.from, -1).ok_or_else(fail)?,
    })
}

/// `priorYear(range, config)`: the same range a year earlier; 52 weeks back
/// on a 52-53-week year.
pub fn prior_year_of(entity: &Value, range: &DateRange) -> Result<DateRange, ReportInputError> {
    let fail = || broken(&range.from);
    if let FiscalYearConfig::FiftyTwoFiftyThree { .. } = fiscal_config_of(entity) {
        return Ok(DateRange {
            from: add_days(&range.from, -364).ok_or_else(fail)?,
            to: add_days(&range.to, -364).ok_or_else(fail)?,
        });
    }
    let from = add_months(&range.from, -12).ok_or_else(fail)?;
    let to = add_months(&range.to, -12).ok_or_else(fail)?;
    if is_whole_months(range) {
        return Ok(DateRange {
            from,
            to: end_of_month(&to).ok_or_else(fail)?,
        });
    }
    Ok(DateRange { from, to })
}

/// `parseCompare(value)`.
pub fn parse_compare(value: Option<&str>) -> Result<Option<CompareMode>, ReportInputError> {
    match value {
        None | Some("") => Ok(None),
        Some("prior_period") => Ok(Some(CompareMode::PriorPeriod)),
        Some("prior_year") => Ok(Some(CompareMode::PriorYear)),
        Some(_) => Err(ReportInputError::new(
            "compare must be 'prior_period' or 'prior_year'",
        )),
    }
}

/// `parsePeriods(value)`.
pub fn parse_periods(value: Option<&str>) -> Result<Option<PeriodsMode>, ReportInputError> {
    match value {
        None | Some("") => Ok(None),
        Some("months") => Ok(Some(PeriodsMode::Months)),
        Some("quarters") => Ok(Some(PeriodsMode::Quarters)),
        Some(_) => Err(ReportInputError::new(
            "periods must be 'months' or 'quarters'",
        )),
    }
}

fn range_label(from: &str, to: &str) -> String {
    if from == to {
        from.to_owned()
    } else {
        format!("{from} to {to}")
    }
}

/// `periodColumns(entity, range, compare)`: the range, plus the comparison
/// range when asked for.
pub fn period_columns(
    entity: &Value,
    range: &DateRange,
    compare: Option<CompareMode>,
) -> Result<Vec<ReportColumn>, ReportInputError> {
    let mut columns = vec![ReportColumn {
        key: "current".to_owned(),
        label: range_label(&range.from, &range.to),
        from: Some(range.from.clone()),
        to: range.to.clone(),
    }];
    if let Some(compare) = compare {
        let prior = match compare {
            CompareMode::PriorYear => prior_year_of(entity, range)?,
            CompareMode::PriorPeriod => prior_period_of(range)?,
        };
        columns.push(ReportColumn {
            key: "prior".to_owned(),
            label: range_label(&prior.from, &prior.to),
            from: Some(prior.from),
            to: prior.to,
        });
    }
    Ok(columns)
}

/// `pointInTimeColumns(asOf, compare, periodStart)`: everything up to a
/// date, and up to the comparison date.
pub fn point_in_time_columns(
    as_of: &str,
    compare: Option<CompareMode>,
    period_start: Option<&str>,
) -> Result<Vec<ReportColumn>, ReportInputError> {
    let fail = || broken(as_of);
    let mut columns = vec![ReportColumn {
        key: "current".to_owned(),
        label: as_of.to_owned(),
        from: None,
        to: as_of.to_owned(),
    }];
    if let Some(compare) = compare {
        let month_end = end_of_month(as_of).ok_or_else(fail)?;
        let back = |months: i64| -> Result<String, ReportInputError> {
            let moved = add_months(as_of, months).ok_or_else(fail)?;
            if as_of == month_end {
                end_of_month(&moved).ok_or_else(fail)
            } else {
                Ok(moved)
            }
        };
        let prior = match (compare, period_start) {
            (CompareMode::PriorYear, _) => back(-12)?,
            (CompareMode::PriorPeriod, Some(start)) => add_days(start, -1).ok_or_else(fail)?,
            (CompareMode::PriorPeriod, None) => back(-1)?,
        };
        columns.push(ReportColumn {
            key: "prior".to_owned(),
            label: prior.clone(),
            from: None,
            to: prior,
        });
    }
    Ok(columns)
}

/// `splitColumns(entity, range, mode)`: a column per fiscal month or quarter
/// across the range, clipped at its ends, plus `total`.
pub fn split_columns(
    entity: &Value,
    range: &DateRange,
    mode: PeriodsMode,
) -> Result<Vec<ReportColumn>, ReportInputError> {
    let config = fiscal_config_of(entity);
    let first_year = fiscal_year_range(&config, &range.from)
        .ok_or_else(|| broken(&range.from))?
        .year;
    let last_year = fiscal_year_range(&config, &range.to)
        .ok_or_else(|| broken(&range.to))?
        .year;
    if last_year - first_year > 5 {
        return Err(ReportInputError::new(
            "That range has too many columns; choose a shorter range",
        ));
    }
    let mut blocks: Vec<(String, String, String)> = Vec::new();
    for year in first_year..=last_year {
        let periods = fiscal_periods(&config, year).ok_or_else(|| broken(&range.from))?;
        match mode {
            PeriodsMode::Months => {
                for p in &periods {
                    let key = if config.kind() == "month" {
                        p.start.chars().take(7).collect()
                    } else {
                        format!("{year}-P{:02}", p.number)
                    };
                    blocks.push((key, p.start.clone(), p.end.clone()));
                }
            }
            PeriodsMode::Quarters => {
                for quarter in 1..=4 {
                    let members: Vec<_> = periods.iter().filter(|p| p.quarter == quarter).collect();
                    let (Some(first), Some(last)) = (members.first(), members.last()) else {
                        continue;
                    };
                    blocks.push((
                        format!("{year}-Q{quarter}"),
                        first.start.clone(),
                        last.end.clone(),
                    ));
                }
            }
        }
    }
    let mut columns: Vec<ReportColumn> = blocks
        .into_iter()
        .filter(|(_, from, to)| *to >= range.from && *from <= range.to)
        .map(|(key, from, to)| {
            let from = if from < range.from {
                range.from.clone()
            } else {
                from
            };
            let to = if to > range.to { range.to.clone() } else { to };
            ReportColumn {
                key,
                label: range_label(&from, &to),
                from: Some(from),
                to,
            }
        })
        .collect();
    columns.push(ReportColumn {
        key: "total".to_owned(),
        label: range_label(&range.from, &range.to),
        from: Some(range.from.clone()),
        to: range.to.clone(),
    });
    Ok(columns)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entity(start: i64) -> Value {
        json!({ "fiscalYearStart": start, "fiscalYearConfig": null })
    }

    #[test]
    fn prior_ranges_follow_the_months() {
        let quarter = DateRange {
            from: "2026-04-01".to_owned(),
            to: "2026-06-30".to_owned(),
        };
        assert_eq!(
            prior_period_of(&quarter).expect("a range"),
            DateRange {
                from: "2026-01-01".to_owned(),
                to: "2026-03-31".to_owned()
            }
        );
        let leap = DateRange {
            from: "2024-02-01".to_owned(),
            to: "2024-02-29".to_owned(),
        };
        assert_eq!(
            prior_year_of(&entity(1), &leap).expect("a range"),
            DateRange {
                from: "2023-02-01".to_owned(),
                to: "2023-02-28".to_owned()
            }
        );
    }

    #[test]
    fn quarters_follow_the_fiscal_year() {
        let range = DateRange {
            from: "2025-07-01".to_owned(),
            to: "2026-06-30".to_owned(),
        };
        let columns = split_columns(&entity(7), &range, PeriodsMode::Quarters).expect("columns");
        let keys: Vec<&str> = columns.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(
            keys,
            ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4", "total"]
        );
        assert_eq!(columns[0].to, "2025-09-30");
    }

    #[test]
    fn dates_are_checked() {
        assert_eq!(
            require_iso_date("2026-07-31T10:00:00Z", "to").as_deref(),
            Ok("2026-07-31")
        );
        assert!(require_iso_date("2026-13-01", "to").is_err());
        assert_eq!(today_for(Some("Not/AZone"), 0), "1970-01-01");
        assert_eq!(today_for(Some("Asia/Tokyo"), 0), "1970-01-01");
        assert_eq!(today_for(Some("America/New_York"), 0), "1969-12-31");
    }
}
