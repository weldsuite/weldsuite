//! Pay periods and pay dates (`periods.ts`).

use crate::PayrollError;
use crate::js::{
    days_from_civil, format_days, int_of, last_day_of_month, math_round, parse_days, slice,
    weekday_of,
};
use crate::types::{PayFrequency, PayPeriod, PayrollCountry};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PayDateRule {
    DayOfMonth { day: f64 },
    OffsetAfterEnd { days: f64 },
    LastBusinessDay,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PayScheduleSpec {
    pub frequency: PayFrequency,
    pub anchor_date: String,
    pub pay_date_rule: PayDateRule,
}

/// `PERIODS_PER_YEAR`.
pub fn periods_per_year(frequency: PayFrequency) -> i64 {
    match frequency {
        PayFrequency::Monthly => 12,
        PayFrequency::Semimonthly => 24,
        PayFrequency::FourWeekly => 13,
        PayFrequency::Biweekly => 26,
        PayFrequency::Weekly => 52,
    }
}

fn block_days(frequency: PayFrequency) -> i64 {
    match frequency {
        PayFrequency::FourWeekly => 28,
        PayFrequency::Biweekly => 14,
        _ => 7,
    }
}

/// `addDays(iso, days)`.
pub fn add_days(iso: &str, days: i64) -> Result<String, PayrollError> {
    Ok(format_days(parse_days(iso)? + days))
}

/// `daysBetween(from, to)`.
pub fn days_between(from: &str, to: &str) -> Result<i64, PayrollError> {
    Ok(parse_days(to)? - parse_days(from)?)
}

fn ymd(year: i64, month: i64, day: i64) -> String {
    format!("{year}-{month:02}-{day:02}")
}

/// `weekday(iso)`: 0 = Sunday.
pub fn weekday(iso: &str) -> Result<i64, PayrollError> {
    Ok(weekday_of(parse_days(iso)?))
}

fn previous_weekday_if_weekend(iso: &str) -> Result<String, PayrollError> {
    match weekday(iso)? {
        6 => add_days(iso, -1),
        0 => add_days(iso, -2),
        _ => Ok(iso.to_owned()),
    }
}

/// `weekdaysBetween(start, end)`, both inclusive. The TypeScript walks the
/// days as strings; a rolled-over string (`2026-02-30`) compares as text.
pub fn weekdays_between(start: &str, end: &str) -> Result<i64, PayrollError> {
    if end < start {
        return Ok(0);
    }
    let mut count = 0;
    let mut cursor = start.to_owned();
    while cursor.as_str() <= end {
        let day = weekday(&cursor)?;
        if day != 0 && day != 6 {
            count += 1;
        }
        cursor = add_days(&cursor, 1)?;
    }
    Ok(count)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Bounds {
    pub start: String,
    pub end: String,
}

fn year_month(days: i64) -> (i64, i64, i64) {
    crate::js::civil_from_days(days)
}

fn bounds_containing(spec: &PayScheduleSpec, date: &str) -> Result<Bounds, PayrollError> {
    let (year, month, day) = year_month(parse_days(date)?);
    Ok(match spec.frequency {
        PayFrequency::Monthly => Bounds {
            start: ymd(year, month, 1),
            end: ymd(year, month, last_day_of_month(year, month)),
        },
        PayFrequency::Semimonthly => {
            if day <= 15 {
                Bounds {
                    start: ymd(year, month, 1),
                    end: ymd(year, month, 15),
                }
            } else {
                Bounds {
                    start: ymd(year, month, 16),
                    end: ymd(year, month, last_day_of_month(year, month)),
                }
            }
        }
        other => {
            let block = block_days(other);
            let offset = days_between(&spec.anchor_date, date)?;
            let index = offset.div_euclid(block);
            let start = add_days(&spec.anchor_date, index * block)?;
            let end = add_days(&start, block - 1)?;
            Bounds { start, end }
        }
    })
}

fn bounds_after(spec: &PayScheduleSpec, bounds: &Bounds) -> Result<Bounds, PayrollError> {
    bounds_containing(spec, &add_days(&bounds.end, 1)?)
}

/// `Math.trunc` of a rule's number, as an integer.
#[allow(clippy::cast_possible_truncation)]
fn trunc_int(n: f64) -> i64 {
    n.trunc() as i64
}

/// `payDateFor(spec, bounds)`.
pub fn pay_date_for(spec: &PayScheduleSpec, bounds: &Bounds) -> Result<String, PayrollError> {
    let (year, month, _) = year_month(parse_days(&bounds.end)?);
    let date = match spec.pay_date_rule {
        PayDateRule::DayOfMonth { day } => {
            if spec.frequency == PayFrequency::Monthly {
                let d = trunc_int(day).max(1).min(last_day_of_month(year, month));
                ymd(year, month, d)
            } else {
                bounds.end.clone()
            }
        }
        PayDateRule::OffsetAfterEnd { days } => add_days(&bounds.end, trunc_int(days))?,
        PayDateRule::LastBusinessDay => ymd(year, month, last_day_of_month(year, month)),
    };
    previous_weekday_if_weekend(&date)
}

fn tax_year_of(country: PayrollCountry, bounds: &Bounds, pay_date: &str) -> i64 {
    match country {
        PayrollCountry::Nl => int_of(slice(&bounds.start, 0, 4)),
        PayrollCountry::Us => int_of(slice(pay_date, 0, 4)),
    }
}

fn first_bounds_of_year(
    spec: &PayScheduleSpec,
    country: PayrollCountry,
    year: i64,
) -> Result<Bounds, PayrollError> {
    let mut bounds = bounds_containing(spec, &format!("{}-12-01", year - 1))?;
    for _ in 0..80 {
        if tax_year_of(country, &bounds, &pay_date_for(spec, &bounds)?) >= year {
            return Ok(bounds);
        }
        bounds = bounds_after(spec, &bounds)?;
    }
    Err(PayrollError::new(
        "Could not find the first pay period of the year",
    ))
}

fn to_period(
    spec: &PayScheduleSpec,
    country: PayrollCountry,
    bounds: Bounds,
) -> Result<PayPeriod, PayrollError> {
    let pay_date = pay_date_for(spec, &bounds)?;
    let tax_year = tax_year_of(country, &bounds, &pay_date);
    let period_number = if country == PayrollCountry::Nl && spec.frequency == PayFrequency::Monthly
    {
        int_of(slice(&bounds.start, 5, 7))
    } else {
        let mut number = 1;
        let mut cursor = first_bounds_of_year(spec, country, tax_year)?;
        while cursor.start < bounds.start {
            cursor = bounds_after(spec, &cursor)?;
            number += 1;
        }
        number
    };
    Ok(PayPeriod {
        start: bounds.start,
        end: bounds.end,
        pay_date,
        frequency: spec.frequency,
        tax_year,
        period_number,
        periods_per_year: periods_per_year(spec.frequency),
    })
}

/// `periodContaining(spec, country, date)`.
pub fn period_containing(
    spec: &PayScheduleSpec,
    country: PayrollCountry,
    date: &str,
) -> Result<PayPeriod, PayrollError> {
    to_period(spec, country, bounds_containing(spec, date)?)
}

/// `periodAfter(spec, country, period)`.
pub fn period_after(
    spec: &PayScheduleSpec,
    country: PayrollCountry,
    start: &str,
    end: &str,
) -> Result<PayPeriod, PayrollError> {
    let bounds = Bounds {
        start: start.to_owned(),
        end: end.to_owned(),
    };
    to_period(spec, country, bounds_after(spec, &bounds)?)
}

/// `firstPeriod(spec, country)`.
pub fn first_period(
    spec: &PayScheduleSpec,
    country: PayrollCountry,
) -> Result<PayPeriod, PayrollError> {
    period_containing(spec, country, &spec.anchor_date)
}

/// `nextPeriodToRun(spec, country, lastRunPeriod)`.
pub fn next_period_to_run(
    spec: &PayScheduleSpec,
    country: PayrollCountry,
    last_run: Option<(&str, &str)>,
) -> Result<PayPeriod, PayrollError> {
    match last_run {
        Some((start, end)) => period_after(spec, country, start, end),
        None => first_period(spec, country),
    }
}

/// `quarterOf(iso)`.
pub fn quarter_of(iso: &str) -> i64 {
    (int_of(slice(iso, 5, 7)) - 1).div_euclid(3) + 1
}

/// `ageOn(dateOfBirth, onDate)`.
pub fn age_on(date_of_birth: &str, on_date: &str) -> Result<i64, PayrollError> {
    let (by, bm, bd) = year_month(parse_days(date_of_birth)?);
    let (dy, dm, dd) = year_month(parse_days(on_date)?);
    let mut age = dy - by;
    if dm < bm || (dm == bm && dd < bd) {
        age -= 1;
    }
    Ok(age)
}

/// `Math.round(ms / 86_400_000)` between two dates; kept for callers that
/// mirror `daysBetween` on day numbers.
pub fn round_days(ms: f64) -> f64 {
    math_round(ms / 86_400_000.0)
}

/// Day number of `YYYY-MM-DD` (for callers comparing dates).
pub fn day_number(year: i64, month: i64, day: i64) -> i64 {
    days_from_civil(year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monthly_nl() {
        let spec = PayScheduleSpec {
            frequency: PayFrequency::Monthly,
            anchor_date: "2026-01-01".into(),
            pay_date_rule: PayDateRule::DayOfMonth { day: 25.0 },
        };
        let p = period_containing(&spec, PayrollCountry::Nl, "2026-03-10").expect("period");
        assert_eq!(p.start, "2026-03-01");
        assert_eq!(p.end, "2026-03-31");
        assert_eq!(p.pay_date, "2026-03-25");
        assert_eq!(p.period_number, 3);
    }
}
