//! Federal legal holidays and filing due dates (`us/dates.ts`).

use std::collections::BTreeSet;

use crate::PayrollError;
use crate::js::{int_of, last_day_of_month, slice};
use crate::periods::{add_days, weekday};

fn ymd(year: i64, month: i64, day: i64) -> String {
    format!("{year}-{month:02}-{day:02}")
}

fn nth_weekday(year: i64, month: i64, dow: i64, n: i64) -> Result<String, PayrollError> {
    if n > 0 {
        let first = ymd(year, month, 1);
        let offset = (dow - weekday(&first)? + 7).rem_euclid(7);
        return add_days(&first, offset + (n - 1) * 7);
    }
    let last = ymd(year, month, last_day_of_month(year, month));
    let back = (weekday(&last)? - dow + 7).rem_euclid(7);
    add_days(&last, -back)
}

fn observed(date: &str) -> Result<String, PayrollError> {
    match weekday(date)? {
        6 => add_days(date, -1),
        0 => add_days(date, 1),
        _ => Ok(date.to_owned()),
    }
}

/// `legalHolidays(year)`, sorted.
pub fn legal_holidays(year: i64) -> Result<Vec<String>, PayrollError> {
    let fixed = |y: i64| -> Result<Vec<String>, PayrollError> {
        [(1, 1), (4, 16), (6, 19), (7, 4), (11, 11), (12, 25)]
            .iter()
            .map(|(m, d)| observed(&ymd(y, *m, *d)))
            .collect()
    };
    let prefix = format!("{year}-");
    let mut days = fixed(year)?;
    days.extend(
        fixed(year + 1)?
            .into_iter()
            .filter(|d| d.starts_with(&prefix)),
    );
    days.push(nth_weekday(year, 1, 1, 3)?);
    days.push(nth_weekday(year, 2, 1, 3)?);
    days.push(nth_weekday(year, 5, 1, -1)?);
    days.push(nth_weekday(year, 9, 1, 1)?);
    days.push(nth_weekday(year, 10, 1, 2)?);
    days.push(nth_weekday(year, 11, 4, 4)?);
    if (year - 1).rem_euclid(4) == 0 {
        let inauguration = ymd(year, 1, 20);
        days.push(if weekday(&inauguration)? == 0 {
            add_days(&inauguration, 1)?
        } else {
            inauguration
        });
    }
    let set: BTreeSet<String> = days
        .into_iter()
        .filter(|d| d.starts_with(&prefix))
        .collect();
    Ok(set.into_iter().collect())
}

/// `isLegalHoliday(date)`.
pub fn is_legal_holiday(date: &str) -> Result<bool, PayrollError> {
    let year = int_of(slice(date, 0, 4));
    Ok(legal_holidays(year)?.iter().any(|d| d == date))
}

/// `isBusinessDay(date)`.
pub fn is_business_day(date: &str) -> Result<bool, PayrollError> {
    let d = weekday(date)?;
    Ok(d != 0 && d != 6 && !is_legal_holiday(date)?)
}

/// `onOrNextBusinessDay(date)`.
pub fn on_or_next_business_day(date: &str) -> Result<String, PayrollError> {
    let mut d = date.to_owned();
    while !is_business_day(&d)? {
        d = add_days(&d, 1)?;
    }
    Ok(d)
}

/// `businessDaysAfter(date, n)`.
pub fn business_days_after(date: &str, n: i64) -> Result<String, PayrollError> {
    let mut d = date.to_owned();
    let mut count = 0;
    while count < n {
        d = add_days(&d, 1)?;
        if is_business_day(&d)? {
            count += 1;
        }
    }
    Ok(d)
}

/// `lastDayOfMonth(year, month)` as a date.
pub fn last_day_of_month_date(year: i64, month: i64) -> String {
    ymd(year, month, last_day_of_month(year, month))
}

/// `quarterBounds(year, quarter)`.
pub fn quarter_bounds(year: i64, quarter: i64) -> (String, String) {
    let first_month = (quarter - 1) * 3 + 1;
    (
        ymd(year, first_month, 1),
        last_day_of_month_date(year, first_month + 2),
    )
}

/// `quarterlyReturnDueDate(year, quarter)`.
pub fn quarterly_return_due_date(year: i64, quarter: i64) -> Result<String, PayrollError> {
    let month = quarter * 3 + 1;
    on_or_next_business_day(&if month > 12 {
        last_day_of_month_date(year + 1, 1)
    } else {
        last_day_of_month_date(year, month)
    })
}

/// `annualReturnDueDate(taxYear)`.
pub fn annual_return_due_date(tax_year: i64) -> Result<String, PayrollError> {
    on_or_next_business_day(&ymd(tax_year + 1, 1, 31))
}
