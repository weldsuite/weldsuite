//! When alerts, scheduled reports and raw exports run, and the master
//! `panel_schedule_registry` that tells `weldsuite cron panel-schedule`
//! which are due across workspaces without opening every tenant database
//! (`services/schedule.ts`, ADR PANEL-010, the DATA-009 pattern).
//!
//! The tenant row stays the source of truth. Every create, update and
//! delete of an alert, subscription or export writes its registry row
//! ([`upsert_schedule`], [`delete_schedule`]); the cron claims due rows with
//! a lock ([`claim_due`]), runs them, and writes the next run
//! ([`release_schedule`]).
//!
//! Times are computed in the object's time zone, as `Intl` does, so a
//! daylight-saving change moves a 09:00 report with the clock, not with UTC.

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_panel_domain::js;

pub(crate) const MINUTE: i64 = 60_000;
pub(crate) const HOUR: i64 = 60 * MINUTE;
pub(crate) const DAY: i64 = 24 * HOUR;

/// How long a claimed row stays locked (`LOCK_MS`).
pub(crate) const LOCK_MS: i64 = 10 * MINUTE;
/// Most rows one cron invocation claims (`MAX_CLAIM`).
pub(crate) const MAX_CLAIM: i64 = 50;

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/// A calendar day (`LocalDate`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LocalDate {
    pub(crate) year: i64,
    pub(crate) month: i64,
    pub(crate) day: i64,
}

/// A wall-clock time (`localParts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LocalParts {
    pub(crate) year: i64,
    pub(crate) month: i64,
    pub(crate) day: i64,
    pub(crate) hour: i64,
    pub(crate) minute: i64,
    pub(crate) second: i64,
}

impl LocalParts {
    pub(crate) fn date(self) -> LocalDate {
        LocalDate {
            year: self.year,
            month: self.month,
            day: self.day,
        }
    }
}

/// The zone `name` names; an unknown one reads as UTC (the schemas refuse
/// unknown zones before they are stored).
fn zone(name: &str) -> jiff::tz::TimeZone {
    js::time_zone(name).unwrap_or(jiff::tz::TimeZone::UTC)
}

/// `localParts(at, timeZone)`: the wall-clock time `at` shows in the zone.
pub(crate) fn local_parts(at: i64, time_zone: &str) -> LocalParts {
    let shifted = at + js::offset_seconds(&zone(time_zone), at) * 1000;
    let p = js::date_parts(shifted);
    LocalParts {
        year: p.year,
        month: p.month,
        day: p.day,
        hour: p.hour,
        minute: p.minute,
        second: p.second,
    }
}

/// `offsetMinutes(timeZone, at)`: minutes east of UTC.
pub(crate) fn offset_minutes(time_zone: &str, at: i64) -> i64 {
    let p = local_parts(at, time_zone);
    let as_utc = js::date_utc(p.year, p.month - 1, p.day)
        + p.hour * HOUR
        + p.minute * MINUTE
        + p.second * 1000;
    let floored = at.div_euclid(1000) * 1000;
    let diff = as_utc - floored;
    // `Math.round(diff / MINUTE)`.
    (diff + MINUTE / 2).div_euclid(MINUTE)
}

/// `Date.UTC(date.year, date.month - 1, date.day, hour)`.
fn utc_hour(date: LocalDate, hour: i64) -> i64 {
    js::date_utc(date.year, date.month - 1, date.day) + hour * HOUR
}

/// `zonedInstant(date, hour, timeZone)`: the instant the wall clock shows
/// `hour`:00 on `date`. An hour lost to spring-forward lands just after the
/// gap; an hour that happens twice is its first occurrence; `hour` may run
/// over into the next day.
pub(crate) fn zoned_instant(date: LocalDate, hour: i64, time_zone: &str) -> i64 {
    let utc = utc_hour(date, hour);
    let mut offset = offset_minutes(time_zone, utc);
    let mut result = utc - offset * MINUTE;
    let second = offset_minutes(time_zone, result);
    if second != offset {
        offset = second;
        result = utc - offset * MINUTE;
    }
    let earlier = result - HOUR;
    let p = local_parts(earlier, time_zone);
    let want = js::date_parts(utc);
    if p.hour == want.hour && p.day == want.day && p.month == want.month {
        result = earlier;
    }
    result
}

/// `addDays(date, days)`.
pub(crate) fn add_days(date: LocalDate, days: i64) -> LocalDate {
    let p = js::date_parts(js::date_utc(date.year, date.month - 1, date.day + days));
    LocalDate {
        year: p.year,
        month: p.month,
        day: p.day,
    }
}

/// `weekdayOf(date)`: 0 is Sunday.
pub(crate) fn weekday_of(date: LocalDate) -> i64 {
    js::date_parts(js::date_utc(date.year, date.month - 1, date.day)).weekday
}

/// `formatLocalDate(date)`: `YYYY-MM-DD`.
pub(crate) fn format_local_date(date: LocalDate) -> String {
    format!("{}-{:02}-{:02}", date.year, date.month, date.day)
}

// ---------------------------------------------------------------------------
// Next runs
// ---------------------------------------------------------------------------

/// A scheduled report's schedule (`PanelSubscriptionSchedule`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SubscriptionSchedule {
    pub(crate) frequency: String,
    pub(crate) hour: i64,
    pub(crate) weekday: Option<i64>,
    pub(crate) month_day: Option<i64>,
    pub(crate) timezone: String,
}

impl SubscriptionSchedule {
    /// `panelSubscriptionScheduleSchema.safeParse(value)`, as the stored JSON
    /// reads (already validated on write); `None` when it does not parse.
    pub(crate) fn parse(value: &Value) -> Option<Self> {
        let parsed = weldsuite_zod::parse_issues(&super::schemas::SCHEDULE, value).ok()?;
        let body = parsed.body;
        // The schema allows whole numbers from 0 to 28 only.
        #[allow(clippy::cast_possible_truncation)]
        let int = |key: &str| body.get(key).and_then(Value::as_f64).map(|n| n as i64);
        Some(Self {
            frequency: body.get("frequency")?.as_str()?.to_owned(),
            hour: int("hour")?,
            weekday: int("weekday"),
            month_day: int("monthDay"),
            timezone: body
                .get("timezone")
                .and_then(Value::as_str)
                .unwrap_or("UTC")
                .to_owned(),
        })
    }
}

/// `nextSubscriptionRun(schedule, after)`: the first time after `after`
/// the schedule sends.
pub(crate) fn next_subscription_run(schedule: &SubscriptionSchedule, after: i64) -> i64 {
    let tz = if schedule.timezone.is_empty() {
        "UTC"
    } else {
        schedule.timezone.as_str()
    };
    let today = local_parts(after, tz).date();
    for i in 0..=62 {
        let date = add_days(today, i);
        if schedule.frequency == "weekly" && Some(weekday_of(date)) != schedule.weekday {
            continue;
        }
        if schedule.frequency == "monthly" && Some(date.day) != schedule.month_day {
            continue;
        }
        let at = zoned_instant(date, schedule.hour, tz);
        if at > after {
            return at;
        }
    }
    after + DAY
}

/// `ALERT_LAG_MS`: the wait after an interval ends before it is checked.
pub(crate) fn alert_lag(interval: &str) -> i64 {
    if interval == "hourly" {
        5 * MINUTE
    } else {
        15 * MINUTE
    }
}

/// `nextAlertCheck(interval, timeZone, after)`: shortly after the next local
/// hour, day or week (Monday) starts.
pub(crate) fn next_alert_check(interval: &str, time_zone: &str, after: i64) -> i64 {
    let p = local_parts(after, time_zone);
    let boundary = match interval {
        "hourly" => zoned_instant(p.date(), p.hour + 1, time_zone),
        "daily" => zoned_instant(add_days(p.date(), 1), 0, time_zone),
        _ => {
            let iso_dow = (weekday_of(p.date()) + 6) % 7;
            zoned_instant(add_days(p.date(), 7 - iso_dow), 0, time_zone)
        }
    };
    boundary + alert_lag(interval)
}

/// `EXPORT_LAG_MS`: rows received in the last 15 minutes wait.
pub(crate) const EXPORT_LAG_MS: i64 = 15 * MINUTE;

/// `nextExportRun(frequency, after)`: after the next hour or UTC midnight,
/// plus the lag.
pub(crate) fn next_export_run(frequency: &str, after: i64) -> i64 {
    let boundary = if frequency == "hourly" {
        after.div_euclid(HOUR) * HOUR + HOUR
    } else {
        after.div_euclid(DAY) * DAY + DAY
    };
    boundary + EXPORT_LAG_MS + 5 * MINUTE
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/// A claimed registry row (`PanelScheduleRegistryRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleRow {
    pub id: String,
    pub workspace_id: String,
    /// `alert`, `subscription` or `export`.
    pub kind: String,
    pub object_id: String,
    pub next_run_at: i64,
    pub locked_until: Option<i64>,
}

fn timestamp(millis: i64) -> String {
    js::iso_string(millis)
}

fn millis_of(text: Option<String>) -> Option<i64> {
    text.and_then(|text| {
        weldsuite_db::js_row(serde_json::json!({ "t": text }))["t"]
            .as_str()
            .and_then(js::parse_iso)
    })
}

/// `upsertSchedule(masterDb, { workspaceId, kind, objectId, nextRunAt })`:
/// `None` removes the row (disabled, paused, deleted).
pub(crate) async fn upsert_schedule(
    master: &PgPool,
    workspace_id: &str,
    kind: &str,
    object_id: &str,
    next_run_at: Option<i64>,
) -> Result<(), sqlx::Error> {
    let Some(next) = next_run_at else {
        return delete_schedule(master, kind, object_id).await;
    };
    let now = js::now_millis();
    sqlx::query(
        "insert into panel_schedule_registry (id, workspace_id, kind, object_id, next_run_at)
         values ($1, $2, $3, $4, $5::timestamptz)
         on conflict (kind, object_id) do update
           set workspace_id = $2, next_run_at = $5::timestamptz, updated_at = $6::timestamptz",
    )
    .bind(weldsuite_kit::generate_id("pnsr"))
    .bind(workspace_id)
    .bind(kind)
    .bind(object_id)
    .bind(timestamp(next))
    .bind(timestamp(now))
    .execute(master)
    .await?;
    Ok(())
}

/// `deleteSchedule(masterDb, { kind, objectId })`.
pub(crate) async fn delete_schedule(
    master: &PgPool,
    kind: &str,
    object_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("delete from panel_schedule_registry where kind = $1 and object_id = $2")
        .bind(kind)
        .bind(object_id)
        .execute(master)
        .await?;
    Ok(())
}

/// `nextRunsOf(masterDb, kind, objectIds)`: when each is next due (ISO).
pub(crate) async fn next_runs_of(
    master: &PgPool,
    kind: &str,
    object_ids: &[String],
) -> Result<Vec<(String, String)>, sqlx::Error> {
    if object_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "select object_id, to_jsonb(next_run_at) #>> '{}' from panel_schedule_registry
         where kind = $1 and object_id = any($2)",
    )
    .bind(kind)
    .bind(object_ids)
    .fetch_all(master)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, at)| millis_of(at).map(|at| (id, js::iso_string(at))))
        .collect())
}

fn schedule_row(row: Value) -> Option<ScheduleRow> {
    let row = weldsuite_db::js_row(row);
    let text = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(ScheduleRow {
        id: text("id")?,
        workspace_id: text("workspaceId")?,
        kind: text("kind")?,
        object_id: text("objectId")?,
        next_run_at: text("nextRunAt").as_deref().and_then(js::parse_iso)?,
        locked_until: text("lockedUntil").as_deref().and_then(js::parse_iso),
    })
}

/// `claimDue(masterDb, now, limit)`: up to `limit` due rows whose lock is
/// free or ran out, oldest first, each locked until `now + LOCK_MS`. One
/// statement: the `select … for update skip locked` keeps two invocations
/// from taking the same row, and the outer condition is checked again on
/// the locked row. The select is a CTE, which Postgres runs once; as an
/// `in (…)` subquery the planner may run it again and take more than
/// `limit` rows.
pub async fn claim_due(
    master: &PgPool,
    now: i64,
    limit: i64,
) -> Result<Vec<ScheduleRow>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "with due as (
             select id from panel_schedule_registry
              where next_run_at <= $1::timestamptz
                and (locked_until is null or locked_until < $1::timestamptz)
              order by next_run_at asc
              limit $3
              for update skip locked)
         update panel_schedule_registry t
            set locked_until = $2::timestamptz, updated_at = $1::timestamptz
           from due
          where t.id = due.id
            and t.next_run_at <= $1::timestamptz
            and (t.locked_until is null or t.locked_until < $1::timestamptz)
        returning to_jsonb(t)",
    )
    .bind(timestamp(now))
    .bind(timestamp(now + LOCK_MS))
    .bind(limit)
    .fetch_all(master)
    .await?;
    Ok(rows.into_iter().filter_map(schedule_row).collect())
}

/// `releaseSchedule(masterDb, row, nextRunAt)`: hands a claimed row back with
/// its next run, or removes it (`None`), only while this run still holds
/// the lock.
pub async fn release_schedule(
    master: &PgPool,
    row: &ScheduleRow,
    next_run_at: Option<i64>,
) -> Result<(), sqlx::Error> {
    let held = row.locked_until.map(timestamp);
    match next_run_at {
        None => {
            sqlx::query(
                "delete from panel_schedule_registry
                  where id = $1 and locked_until is not distinct from $2::timestamptz",
            )
            .bind(&row.id)
            .bind(held)
            .execute(master)
            .await?;
        }
        Some(next) => {
            sqlx::query(
                "update panel_schedule_registry
                    set next_run_at = $3::timestamptz, locked_until = null, updated_at = $4::timestamptz
                  where id = $1 and locked_until is not distinct from $2::timestamptz",
            )
            .bind(&row.id)
            .bind(held)
            .bind(timestamp(next))
            .bind(timestamp(js::now_millis()))
            .execute(master)
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AMS: &str = "Europe/Amsterdam";
    const NY: &str = "America/New_York";

    fn at(iso: &str) -> i64 {
        js::parse_iso(iso).expect("iso")
    }

    fn iso(millis: i64) -> String {
        js::iso_string(millis)
    }

    fn day(year: i64, month: i64, day: i64) -> LocalDate {
        LocalDate { year, month, day }
    }

    fn schedule(frequency: &str, hour: i64, timezone: &str) -> SubscriptionSchedule {
        SubscriptionSchedule {
            frequency: frequency.to_owned(),
            hour,
            weekday: None,
            month_day: None,
            timezone: timezone.to_owned(),
        }
    }

    // `schedule.test.ts`: zonedInstant.
    #[test]
    fn turns_a_wall_clock_hour_into_the_instant_winter_and_summer() {
        assert_eq!(
            iso(zoned_instant(day(2026, 1, 15), 9, AMS)),
            "2026-01-15T08:00:00.000Z"
        );
        assert_eq!(
            iso(zoned_instant(day(2026, 7, 15), 9, AMS)),
            "2026-07-15T07:00:00.000Z"
        );
        assert_eq!(
            iso(zoned_instant(day(2026, 7, 15), 9, NY)),
            "2026-07-15T13:00:00.000Z"
        );
        assert_eq!(
            iso(zoned_instant(day(2026, 7, 15), 9, "UTC")),
            "2026-07-15T09:00:00.000Z"
        );
    }

    #[test]
    fn puts_an_hour_lost_to_spring_forward_just_after_the_gap() {
        assert_eq!(
            iso(zoned_instant(day(2026, 3, 29), 2, AMS)),
            "2026-03-29T01:00:00.000Z"
        );
        assert_eq!(local_parts(at("2026-03-29T01:00:00Z"), AMS).hour, 3);
    }

    #[test]
    fn takes_the_first_of_an_hour_that_happens_twice() {
        assert_eq!(
            iso(zoned_instant(day(2026, 10, 25), 2, AMS)),
            "2026-10-25T00:00:00.000Z"
        );
    }

    #[test]
    fn lets_the_hour_run_over_into_the_next_day() {
        assert_eq!(
            iso(zoned_instant(day(2026, 11, 16), 24, "UTC")),
            "2026-11-17T00:00:00.000Z"
        );
    }

    // nextSubscriptionRun.
    #[test]
    fn daily_today_at_the_hour_if_still_ahead_else_tomorrow() {
        let s = schedule("daily", 9, AMS);
        assert_eq!(
            iso(next_subscription_run(&s, at("2026-11-16T07:00:00Z"))),
            "2026-11-16T08:00:00.000Z"
        );
        assert_eq!(
            iso(next_subscription_run(&s, at("2026-11-16T08:00:00Z"))),
            "2026-11-17T08:00:00.000Z"
        );
    }

    #[test]
    fn keeps_nine_local_across_the_spring_and_autumn_changes() {
        let s = schedule("daily", 9, AMS);
        assert_eq!(
            iso(next_subscription_run(&s, at("2026-03-28T09:00:00Z"))),
            "2026-03-29T07:00:00.000Z"
        );
        assert_eq!(
            iso(next_subscription_run(&s, at("2026-10-24T08:00:00Z"))),
            "2026-10-25T08:00:00.000Z"
        );
        let ny = schedule("daily", 9, NY);
        assert_eq!(
            iso(next_subscription_run(&ny, at("2026-03-07T15:00:00Z"))),
            "2026-03-08T13:00:00.000Z"
        );
    }

    #[test]
    fn weekly_the_next_given_weekday() {
        let friday = SubscriptionSchedule {
            weekday: Some(5),
            ..schedule("weekly", 17, "UTC")
        };
        assert_eq!(
            iso(next_subscription_run(&friday, at("2026-11-16T12:00:00Z"))),
            "2026-11-20T17:00:00.000Z"
        );
        let monday = SubscriptionSchedule {
            weekday: Some(1),
            ..schedule("weekly", 8, "UTC")
        };
        assert_eq!(
            iso(next_subscription_run(&monday, at("2026-11-16T09:00:00Z"))),
            "2026-11-23T08:00:00.000Z"
        );
    }

    #[test]
    fn monthly_the_given_day_of_this_month_or_the_next() {
        let first = SubscriptionSchedule {
            month_day: Some(1),
            ..schedule("monthly", 6, AMS)
        };
        assert_eq!(
            iso(next_subscription_run(&first, at("2026-11-16T12:00:00Z"))),
            "2026-12-01T05:00:00.000Z"
        );
        let twenty_eighth = SubscriptionSchedule {
            month_day: Some(28),
            ..schedule("monthly", 6, "UTC")
        };
        assert_eq!(
            iso(next_subscription_run(
                &twenty_eighth,
                at("2026-01-29T00:00:00Z")
            )),
            "2026-02-28T06:00:00.000Z"
        );
    }

    // nextAlertCheck.
    #[test]
    fn hourly_five_minutes_after_the_next_hour() {
        assert_eq!(
            iso(next_alert_check(
                "hourly",
                "UTC",
                at("2026-11-16T10:07:00Z")
            )),
            "2026-11-16T11:05:00.000Z"
        );
        assert_eq!(
            iso(next_alert_check(
                "hourly",
                "Asia/Kolkata",
                at("2026-11-16T10:07:00Z")
            )),
            "2026-11-16T10:35:00.000Z"
        );
    }

    #[test]
    fn daily_fifteen_minutes_after_the_next_local_midnight() {
        assert_eq!(
            iso(next_alert_check("daily", AMS, at("2026-11-16T10:00:00Z"))),
            "2026-11-16T23:15:00.000Z"
        );
    }

    #[test]
    fn weekly_fifteen_minutes_after_the_next_local_monday() {
        assert_eq!(
            iso(next_alert_check("weekly", AMS, at("2026-11-18T10:00:00Z"))),
            "2026-11-22T23:15:00.000Z"
        );
        assert_eq!(
            iso(next_alert_check(
                "weekly",
                "UTC",
                at("2026-11-16T12:00:00Z")
            )),
            "2026-11-23T00:15:00.000Z"
        );
    }

    // nextExportRun.
    #[test]
    fn exports_run_after_the_next_hour_or_midnight_plus_the_lag() {
        assert_eq!(
            iso(next_export_run("hourly", at("2026-11-16T10:07:00Z"))),
            "2026-11-16T11:20:00.000Z"
        );
        assert_eq!(
            iso(next_export_run("daily", at("2026-11-16T10:07:00Z"))),
            "2026-11-17T00:20:00.000Z"
        );
    }
}
