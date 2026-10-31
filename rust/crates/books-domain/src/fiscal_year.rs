//! Fiscal years (`@weldsuite/books-domain/us-compliance/fiscal-year`):
//! month-based years and 52-53-week years (the year ends on the last, or the
//! nearest, weekday of an end month), named for the calendar year in which
//! they end, with their 12 periods (calendar months, or 4-4-5 week periods).

use serde_json::Value;

use crate::dates::{
    add_days, add_months, diff_days, end_of_month, format_iso, last_day_of_month, parse_iso,
    weekday_of,
};

/// `FiscalYearConfig`.
#[derive(Debug, Clone, PartialEq)]
pub enum FiscalYearConfig {
    /// `{ type: 'month', startMonth }`.
    Month { start_month: f64 },
    /// `{ type: 'fifty_two_fifty_three', endMonth, weekday, rule }`.
    FiftyTwoFiftyThree {
        end_month: f64,
        weekday: f64,
        /// `last` or `nearest`.
        rule: String,
    },
}

impl FiscalYearConfig {
    /// `type`: `month` or `fifty_two_fifty_three`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Month { .. } => "month",
            Self::FiftyTwoFiftyThree { .. } => "fifty_two_fifty_three",
        }
    }
}

/// `FiscalYear`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FiscalYear {
    pub year: i64,
    pub start: String,
    pub end: String,
    pub weeks: Option<i64>,
}

/// `FiscalPeriod`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FiscalPeriod {
    pub number: i64,
    pub quarter: i64,
    pub start: String,
    pub end: String,
    pub weeks: Option<i64>,
}

/// `fiscalYearConfigOf(entity)`: the 52-53-week config when the entity has
/// one, else the month-based year of `fiscalYearStart` (1 when unset).
pub fn fiscal_year_config_of(
    fiscal_year_start: Option<f64>,
    config: Option<&Value>,
) -> FiscalYearConfig {
    if let Some(config) = config.filter(|c| crate::js::truthy(Some(c))) {
        return FiscalYearConfig::FiftyTwoFiftyThree {
            end_month: config
                .get("endMonth")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN),
            weekday: config
                .get("weekday")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN),
            rule: config
                .get("rule")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        };
    }
    FiscalYearConfig::Month {
        start_month: fiscal_year_start.unwrap_or(1.0),
    }
}

#[allow(clippy::cast_possible_truncation)]
fn clamp_month(month: f64) -> i64 {
    let value = if month.is_finite() {
        month.trunc()
    } else {
        1.0
    };
    value.clamp(1.0, 12.0) as i64
}

#[allow(clippy::cast_possible_truncation)]
fn week_year_end(end_month: f64, weekday: f64, rule: &str, year: i64) -> Option<String> {
    let anchor = last_day_of_month(year, clamp_month(end_month));
    // `((Math.trunc(weekday) % 7) + 7) % 7`; NaN stays NaN in TypeScript.
    if !weekday.is_finite() {
        return None;
    }
    let weekday = ((weekday.trunc() as i64 % 7) + 7) % 7;
    let anchor_day = weekday_of(&anchor)?;
    if rule == "last" {
        return add_days(&anchor, -((anchor_day - weekday + 7) % 7));
    }
    let forward = (weekday - anchor_day + 7) % 7;
    add_days(&anchor, if forward <= 3 { forward } else { forward - 7 })
}

/// `fiscalYearFor(config, year)`.
pub fn fiscal_year_for(config: &FiscalYearConfig, year: i64) -> Option<FiscalYear> {
    match config {
        FiscalYearConfig::Month { start_month } => {
            let start_month = clamp_month(*start_month);
            if start_month == 1 {
                return Some(FiscalYear {
                    year,
                    start: format_iso(year, 1, 1),
                    end: format_iso(year, 12, 31),
                    weeks: None,
                });
            }
            Some(FiscalYear {
                year,
                start: format_iso(year - 1, start_month, 1),
                end: last_day_of_month(year, start_month - 1),
                weeks: None,
            })
        }
        FiscalYearConfig::FiftyTwoFiftyThree {
            end_month,
            weekday,
            rule,
        } => {
            let end = week_year_end(*end_month, *weekday, rule, year)?;
            let previous_end = week_year_end(*end_month, *weekday, rule, year - 1)?;
            let days = diff_days(&previous_end, &end)?;
            Some(FiscalYear {
                year,
                start: add_days(&previous_end, 1)?,
                end,
                weeks: Some(days / 7),
            })
        }
    }
}

const FOUR_FOUR_FIVE: [i64; 12] = [4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5];

/// `fiscalPeriods(config, fiscalYear)`: the 12 periods of a fiscal year.
pub fn fiscal_periods(config: &FiscalYearConfig, fiscal_year: i64) -> Option<Vec<FiscalPeriod>> {
    let year = fiscal_year_for(config, fiscal_year)?;
    if let FiscalYearConfig::Month { .. } = config {
        return (0..12)
            .map(|index| {
                let start = add_months(&year.start, index)?;
                Some(FiscalPeriod {
                    number: index + 1,
                    quarter: index / 3 + 1,
                    end: end_of_month(&start)?,
                    start,
                    weeks: None,
                })
            })
            .collect();
    }
    let mut lengths = FOUR_FOUR_FIVE;
    if year.weeks == Some(53) {
        lengths[11] = 6;
    }
    let mut start = year.start.clone();
    let mut periods = Vec::with_capacity(12);
    for (index, weeks) in (0_i64..).zip(lengths) {
        let end = add_days(&start, weeks * 7 - 1)?;
        let next = add_days(&end, 1)?;
        periods.push(FiscalPeriod {
            number: index + 1,
            quarter: index / 3 + 1,
            start,
            end,
            weeks: Some(weeks),
        });
        start = next;
    }
    Some(periods)
}

/// `fiscalYearRange(config, date)`: the fiscal year containing a date.
pub fn fiscal_year_range(config: &FiscalYearConfig, date: &str) -> Option<FiscalYear> {
    let p = parse_iso(date)?;
    if let FiscalYearConfig::Month { start_month } = config {
        let start_month = clamp_month(*start_month);
        let year = if start_month == 1 || p.m < start_month {
            p.y
        } else {
            p.y + 1
        };
        return fiscal_year_for(config, year);
    }
    for candidate in [p.y, p.y + 1, p.y - 1] {
        let year = fiscal_year_for(config, candidate)?;
        if date >= year.start.as_str() && date <= year.end.as_str() {
            return Some(year);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_years_are_named_for_their_end() {
        let config = FiscalYearConfig::Month { start_month: 7.0 };
        let year = fiscal_year_for(&config, 2026).unwrap();
        assert_eq!(
            (year.start.as_str(), year.end.as_str()),
            ("2025-07-01", "2026-06-30")
        );
    }

    #[test]
    fn four_four_five_periods() {
        let config = FiscalYearConfig::FiftyTwoFiftyThree {
            end_month: 12.0,
            weekday: 6.0,
            rule: "last".to_owned(),
        };
        let periods = fiscal_periods(&config, 2026).unwrap();
        assert_eq!(periods.len(), 12);
        assert_eq!(periods[2].weeks, Some(5));
    }
}
