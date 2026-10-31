//! WeldHR shared plumbing (`services/weldhr/shared.ts`): date helpers (all
//! HR dates are `YYYY-MM-DD` strings), people lookups and the audit writer.

use std::collections::HashMap;

use serde_json::Value;
use time::{Date, Month, OffsetDateTime};
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;

use crate::HrError;

/// `new Date()` as Drizzle writes it to a `timestamp` column: UTC with
/// milliseconds. Bind it as text with `::timestamp` (or `::timestamptz`).
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `todayIso()`: today as `YYYY-MM-DD` in UTC.
pub(crate) fn today_iso() -> String {
    iso_date(OffsetDateTime::now_utc().date())
}

/// `YYYY-MM-DD`.
pub(crate) fn iso_date(date: Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// A `YYYY-MM-DD` string as a date; `None` when it isn't one.
pub(crate) fn parse_date(text: &str) -> Option<Date> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i32 = text.get(0..4)?.parse().ok()?;
    let month: u8 = text.get(5..7)?.parse().ok()?;
    let day: u8 = text.get(8..10)?.parse().ok()?;
    Date::from_calendar_date(year, Month::try_from(month).ok()?, day).ok()
}

/// `/^\d{4}-\d{2}-\d{2}$/.test(value)`: the shape only, as the routes check
/// their query dates.
pub(crate) fn is_iso_date_shape(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

/// `addDays(isoDate, days)`: `new Date(`${isoDate}T00:00:00Z`)` moved by
/// `days`, as `YYYY-MM-DD`. JavaScript rolls an out-of-range day over
/// (`2026-02-30` is March 2nd); so does this.
pub(crate) fn add_days(iso: &str, days: i64) -> String {
    match js_date(iso) {
        Some(date) => iso_date(date + time::Duration::days(days)),
        None => "Invalid Date".to_owned(),
    }
}

/// `new Date(`${iso}T00:00:00Z`)`'s day, with JavaScript's rollover of an
/// out-of-range day of the month (1 to 31).
pub(crate) fn js_date(iso: &str) -> Option<Date> {
    if let Some(date) = parse_date(iso) {
        return Some(date);
    }
    if !is_iso_date_shape(iso) {
        return None;
    }
    let year: i32 = iso.get(0..4)?.parse().ok()?;
    let month: u8 = iso.get(5..7)?.parse().ok()?;
    let day: i64 = iso.get(8..10)?.parse().ok()?;
    if !(1..=31).contains(&day) {
        return None;
    }
    let first = Date::from_calendar_date(year, Month::try_from(month).ok()?, 1).ok()?;
    Some(first + time::Duration::days(day - 1))
}

/// `assertDateOrder(start, end, what)`.
pub(crate) fn assert_date_order(
    start: Option<&str>,
    end: Option<&str>,
    what: &str,
) -> Result<(), HrError> {
    if let (Some(start), Some(end)) = (start, end)
        && !start.is_empty()
        && !end.is_empty()
        && end < start
    {
        return Err(HrError::validation(format!(
            "{what}: end date is before start date"
        )));
    }
    Ok(())
}

/// `workingDaysBetween(start, end)`: Mon–Fri days in `[start, end]`.
pub(crate) fn working_days_between(start: &str, end: &str) -> i64 {
    if end < start {
        return 0;
    }
    let (Some(mut cursor), Some(last)) = (js_date(start), js_date(end)) else {
        return 0;
    };
    let mut count = 0;
    while cursor <= last {
        let weekday = cursor.weekday();
        if weekday != time::Weekday::Saturday && weekday != time::Weekday::Sunday {
            count += 1;
        }
        cursor += time::Duration::days(1);
    }
    count
}

/// `yearOf(isoDate)`.
pub(crate) fn year_of(iso: &str) -> i32 {
    iso.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0)
}

/// `employedShareOfYear(year, startDate, endDate)`.
#[allow(clippy::cast_precision_loss)]
pub(crate) fn employed_share_of_year(year: i32, start: Option<&str>, end: Option<&str>) -> f64 {
    let first = format!("{year:04}-01-01");
    let last = format!("{year:04}-12-31");
    let from = match start {
        Some(start) if !start.is_empty() && start > first.as_str() => start.to_owned(),
        _ => first.clone(),
    };
    let to = match end {
        Some(end) if !end.is_empty() && end < last.as_str() => end.to_owned(),
        _ => last.clone(),
    };
    if to < from {
        return 0.0;
    }
    let day_count = |a: &str, b: &str| -> f64 {
        match (js_date(a), js_date(b)) {
            (Some(a), Some(b)) => ((b - a).whole_days() + 1) as f64,
            _ => f64::NAN,
        }
    };
    day_count(&from, &to) / day_count(&first, &last)
}

// ---------------------------------------------------------------------------
// People lookups
// ---------------------------------------------------------------------------

/// `memberNames(db, userIds)`: workspace member display names
/// (`name || email || userId`) by Clerk user id; `portal:` ids are skipped.
pub(crate) async fn member_names(
    db: &PgPool,
    user_ids: &[Option<&str>],
) -> Result<HashMap<String, String>, HrError> {
    let mut ids: Vec<String> = Vec::new();
    for id in user_ids.iter().flatten() {
        if !id.is_empty() && !id.starts_with("portal:") && !ids.iter().any(|known| known == id) {
            ids.push((*id).to_owned());
        }
    }
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select user_id, name, email from workspace_members where user_id = any($1)",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    for (user_id, name, email) in rows {
        let label = name
            .filter(|name| !name.is_empty())
            .or_else(|| email.filter(|email| !email.is_empty()))
            .unwrap_or_else(|| user_id.clone());
        out.insert(user_id, label);
    }
    Ok(out)
}

/// `companyNames(db, companyIds)`: CRM company display names by id.
pub(crate) async fn company_names(
    db: &PgPool,
    company_ids: &[Option<&str>],
) -> Result<HashMap<String, String>, HrError> {
    let mut ids: Vec<String> = Vec::new();
    for id in company_ids.iter().flatten() {
        if !id.is_empty() && !ids.iter().any(|known| known == id) {
            ids.push((*id).to_owned());
        }
    }
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, String)> =
        sqlx::query_as("select id, display_name from companies where id = any($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?;
    out.extend(rows);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/// `recordHrAudit(db, { actorId, action, employeeId, metadata, ip })`. The
/// metadata is written as the route builds it (`{}` when it has none).
pub(crate) async fn record_hr_audit(
    db: &PgPool,
    actor_id: &str,
    action: &str,
    employee_id: Option<&str>,
    metadata: Value,
    ip: Option<&str>,
) -> Result<(), HrError> {
    sqlx::query(
        "insert into hr_audit_events (id, actor_id, action, employee_id, metadata, ip)
         values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(generate_id("hraud"))
    .bind(actor_id)
    .bind(action)
    .bind(employee_id)
    .bind(metadata)
    .bind(ip)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_like_javascript() {
        assert_eq!(add_days("2026-02-27", 2), "2026-03-01");
        assert_eq!(add_days("2026-02-30", 0), "2026-03-02");
        assert_eq!(add_days("2026-12-31", 1), "2027-01-01");
        assert_eq!(working_days_between("2026-10-30", "2026-11-02"), 2);
        assert!((employed_share_of_year(2026, Some("2026-07-01"), None) - 184.0 / 365.0).abs() < 1e-12);
        assert!(is_iso_date_shape("2026-13-45"));
        assert!(parse_date("2026-13-45").is_none());
    }
}
