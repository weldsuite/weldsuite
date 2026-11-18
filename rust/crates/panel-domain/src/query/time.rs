//! Date ranges (`time.ts`): presets and custom days turned into a half-open
//! UTC interval `[from, to)`, clamped to the plan's retention (25 months at
//! most), with the timezone's offset for bucketing.
//!
//! Buckets are cut in the spec's timezone by shifting `ts` by one fixed
//! offset (the zone's offset at the end of the range). Instants are epoch
//! milliseconds, as JavaScript's `Date` holds them.

use serde_json::Value;

use super::context::{MAX_RETENTION_DAYS, PanelQueryContext};
use super::sql::{PanelQueryError, QueryResult};
use crate::js::{self, DAY_MS};
use crate::schemas::{DatePreset, DateRange, Interval};

/// A half-open UTC interval `[from, to)` in epoch milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeBounds {
    pub from: i64,
    pub to: i64,
}

/// A spec's range against the clock, the timezone and the retention floor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRange {
    pub from: i64,
    pub to: i64,
    pub timezone: String,
    /// Minutes east of UTC at the end of the range.
    pub offset_minutes: i64,
    pub clamped_to_retention: bool,
    /// The earliest instant any query may read (now minus retention).
    pub floor: i64,
    pub now: i64,
}

impl ResolvedRange {
    /// `from` and `to`.
    pub fn bounds(&self) -> TimeBounds {
        TimeBounds {
            from: self.from,
            to: self.to,
        }
    }
}

/// `queryNow`: the context's clock, else now.
pub fn query_now(ctx: &PanelQueryContext) -> i64 {
    ctx.now.unwrap_or_else(js::now_millis)
}

/// `retentionFloor`: now minus the plan's retention (1 to 762 days).
pub fn retention_floor(ctx: &PanelQueryContext) -> i64 {
    let days = ctx
        .retention_days
        .floor()
        .max(1.0)
        .min(MAX_RETENTION_DAYS as f64);
    query_now(ctx) - (days as i64) * DAY_MS
}

fn zone(timezone: &str) -> QueryResult<jiff::tz::TimeZone> {
    js::time_zone(timezone).ok_or_else(|| {
        PanelQueryError::new(format!(
            "Unknown timezone: {}",
            js::slice_utf16(timezone, 0, 64)
        ))
    })
}

/// `offsetMinutesAt`: minutes east of UTC that `timezone` is at `at`.
pub fn offset_minutes_at(timezone: &str, at: i64) -> QueryResult<i64> {
    if timezone == "UTC" {
        return Ok(0);
    }
    let zone = zone(timezone)?;
    // `Intl` gives the wall clock to the second.
    let seconds = js::offset_seconds(&zone, at.div_euclid(1000) * 1000);
    Ok(js::math_round(seconds as f64 / 60.0) as i64)
}

/// `[y, m, d]` of a `YYYY-MM-DD` day (`ymd.split('-').map(Number)`).
fn ymd_parts(ymd: &str) -> QueryResult<(i64, i64, i64)> {
    let mut parts = ymd.split('-').map(js::string_to_number);
    let mut next = || {
        parts
            .next()
            .filter(|n| n.is_finite())
            .map(|n| n.trunc() as i64)
    };
    match (next(), next(), next()) {
        (Some(y), Some(m), Some(d)) => Ok((y, m, d)),
        _ => Err(PanelQueryError::new("Invalid date")),
    }
}

/// `dayStart`: the instant a calendar day (`YYYY-MM-DD`) starts in `timezone`.
pub fn day_start(ymd: &str, timezone: &str) -> QueryResult<i64> {
    let (y, m, d) = ymd_parts(ymd)?;
    let utc = js::date_utc(y, m - 1, d);
    let mut offset = offset_minutes_at(timezone, utc)?;
    let mut result = utc - offset * 60_000;
    let second = offset_minutes_at(timezone, result)?;
    if second != offset {
        offset = second;
        result = utc - offset * 60_000;
    }
    Ok(result)
}

/// `localDay`: `YYYY-MM-DD` of `at` in `timezone`.
pub fn local_day(at: i64, timezone: &str) -> QueryResult<String> {
    let zone = zone(timezone)?;
    let wall = at.div_euclid(1000) * 1000 + js::offset_seconds(&zone, at) * 1000;
    Ok(js::iso_day(wall))
}

/// `addDays`: the day `days` after `ymd`.
pub fn add_days(ymd: &str, days: i64) -> QueryResult<String> {
    let (y, m, d) = ymd_parts(ymd)?;
    Ok(js::iso_day(js::date_utc(y, m - 1, d + days)))
}

/// `addMonths`: the first day of the month `months` after `ymd`'s.
pub fn add_months(ymd: &str, months: i64) -> QueryResult<String> {
    let (y, m, _) = ymd_parts(ymd)?;
    Ok(js::iso_day(js::date_utc(y, m - 1 + months, 1)))
}

fn preset_days(preset: DatePreset) -> i64 {
    match preset {
        DatePreset::Today => 1,
        DatePreset::Days7 => 7,
        DatePreset::Days90 => 90,
        DatePreset::Days30 | DatePreset::Months12 => 30,
    }
}

/// `resolveRange`: a spec's range against the clock, the timezone and the
/// retention floor. Always bounded.
pub fn resolve_range(
    range: &DateRange,
    timezone: &str,
    ctx: &PanelQueryContext,
) -> QueryResult<ResolvedRange> {
    zone(timezone)?;
    let now = query_now(ctx);
    let floor = retention_floor(ctx);
    let today = local_day(now, timezone)?;

    let (mut from, mut to) = match range {
        DateRange::Preset { preset } => {
            let from = if *preset == DatePreset::Months12 {
                let (y, m, d) = ymd_parts(&today)?;
                day_start(&js::iso_day(js::date_utc(y - 1, m - 1, d)), timezone)?
            } else {
                day_start(&add_days(&today, 1 - preset_days(*preset))?, timezone)?
            };
            (from, now)
        }
        DateRange::Custom { from, to } => {
            let start = day_start(from, timezone)?;
            let end = day_start(&add_days(to, 1)?, timezone)?;
            (start, end.min(now))
        }
    };

    let mut clamped = false;
    if from < floor {
        from = floor;
        clamped = true;
    }
    if to > now {
        to = now;
    }
    if to < from {
        to = from;
    }
    Ok(ResolvedRange {
        from,
        to,
        timezone: timezone.to_owned(),
        offset_minutes: offset_minutes_at(timezone, to)?,
        clamped_to_retention: clamped,
        floor,
        now,
    })
}

/// `previousBounds`: the same length ending where `current` starts.
pub fn previous_bounds(current: TimeBounds, floor: i64) -> TimeBounds {
    let length = (current.to - current.from).max(1);
    let to = current.from;
    TimeBounds {
        from: (to - length).max(floor),
        to,
    }
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

/// `bucketSql`: `column` cut into `interval` buckets in the range's timezone.
pub fn bucket_sql(column: &str, interval: Interval, offset_minutes: i64) -> String {
    if offset_minutes == 0 {
        format!("date_trunc('{interval}', {column})")
    } else {
        format!("date_trunc('{interval}', {column} + INTERVAL '{offset_minutes} minutes')")
    }
}

/// `bucketLabel` of a text: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:00` by the hour.
pub fn bucket_label_text(text: &str, interval: Interval) -> String {
    let day = js::slice_utf16(text, 0, 10);
    if interval == Interval::Hour {
        let hour = js::slice_utf16(text, 11, 13);
        let hour = if hour.is_empty() {
            "00".to_owned()
        } else {
            hour
        };
        return format!("{day}T{hour}:00");
    }
    day
}

/// `bucketLabel`: a bucket value from the engine (`2026-11-01T00:00:00`,
/// `2026-11-01 00:00:00`) as a label.
pub fn bucket_label(value: Option<&Value>, interval: Interval) -> String {
    let text = match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js::value_text(value),
    };
    bucket_label_text(&text, interval)
}

/// `bucketLabels`: every bucket label from `bounds.from` to `bounds.to`, so
/// empty buckets show as zero.
pub fn bucket_labels(bounds: TimeBounds, interval: Interval, offset_minutes: i64) -> Vec<String> {
    let shift = offset_minutes * 60_000;
    let start = bounds.from + shift;
    let end = bounds.to + shift;
    let day = start - start.rem_euclid(DAY_MS);
    let mut cursor = match interval {
        Interval::Hour => start - start.rem_euclid(3_600_000),
        Interval::Day => day,
        Interval::Week => day - ((js::date_parts(day).weekday + 6) % 7) * DAY_MS,
        Interval::Month => {
            let p = js::date_parts(day);
            js::date_utc(p.year, p.month - 1, 1)
        }
    };
    let limit = end.max(start + 1);
    let mut labels = Vec::new();
    let mut guard = 0;
    while cursor < limit && guard < 5000 {
        labels.push(bucket_label_text(&js::iso_string(cursor), interval));
        cursor = match interval {
            Interval::Hour => cursor + 3_600_000,
            Interval::Day => cursor + DAY_MS,
            Interval::Week => cursor + 7 * DAY_MS,
            Interval::Month => {
                let p = js::date_parts(cursor);
                js::date_utc(p.year, p.month, p.day)
                    + ((p.hour * 60 + p.minute) * 60 + p.second) * 1000
                    + p.millis
            }
        };
        guard += 1;
    }
    labels
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> PanelQueryContext {
        PanelQueryContext {
            workspace_id: "ws_1".to_owned(),
            project_id: "pnp_1".to_owned(),
            retention_days: 365.0,
            now: js::parse_iso("2026-11-14T12:00:00Z"),
            ..PanelQueryContext::default()
        }
    }

    fn custom(from: &str, to: &str) -> DateRange {
        DateRange::Custom {
            from: from.to_owned(),
            to: to.to_owned(),
        }
    }

    #[test]
    fn resolves_presets_in_the_timezone() {
        let today = resolve_range(
            &DateRange::Preset {
                preset: DatePreset::Today,
            },
            "Europe/Amsterdam",
            &ctx(),
        )
        .expect("range");
        assert_eq!(js::iso_string(today.from), "2026-11-13T23:00:00.000Z");
        let week = resolve_range(
            &DateRange::Preset {
                preset: DatePreset::Days7,
            },
            "UTC",
            &ctx(),
        )
        .expect("range");
        assert_eq!(js::iso_string(week.from), "2026-11-08T00:00:00.000Z");
        assert_eq!(Some(week.to), ctx().now);
    }

    #[test]
    fn includes_the_whole_last_day_and_clamps_to_retention() {
        let range =
            resolve_range(&custom("2026-11-01", "2026-11-03"), "UTC", &ctx()).expect("range");
        assert_eq!(js::iso_string(range.from), "2026-11-01T00:00:00.000Z");
        assert_eq!(js::iso_string(range.to), "2026-11-04T00:00:00.000Z");
        let short = PanelQueryContext {
            retention_days: 30.0,
            ..ctx()
        };
        let old = resolve_range(&custom("2020-01-01", "2020-01-31"), "UTC", &short).expect("range");
        assert!(old.clamped_to_retention);
        assert!(old.to >= old.from);
    }

    #[test]
    fn refuses_an_unknown_timezone() {
        let err =
            resolve_range(&DateRange::default(), "Mars/Olympus", &ctx()).expect_err("refused");
        assert!(err.message.contains("Unknown timezone"));
    }

    #[test]
    fn lists_every_bucket_weeks_from_monday() {
        let later = PanelQueryContext {
            now: js::parse_iso("2026-11-30T00:00:00Z"),
            ..ctx()
        };
        let range =
            resolve_range(&custom("2026-11-04", "2026-11-18"), "UTC", &later).expect("range");
        assert_eq!(
            bucket_labels(range.bounds(), Interval::Week, 0),
            ["2026-11-02", "2026-11-09", "2026-11-16"]
        );
        assert_eq!(
            bucket_labels(range.bounds(), Interval::Month, 0),
            ["2026-11-01"]
        );
        assert_eq!(bucket_labels(range.bounds(), Interval::Day, 0).len(), 15);
    }
}
