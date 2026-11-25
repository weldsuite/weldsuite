//! Booking-page slot availability (`services/calendar-slots.ts`): the page's
//! windows for one date (its override, else the weekly availability), walked
//! in `duration` steps, each slot available unless it (with buffers) overlaps
//! an event of the owner, falls inside the minimum notice, lies beyond the
//! booking horizon, or the day already has its maximum of bookings.

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, Condition, EntityTrait, PaginatorTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{calendar_bookings, calendar_events as events};

use crate::events::{millis_at, timestamp_at};
use crate::js::{DAY_MS, iso, parse_date, time_zone};
use crate::{Outcome, Refusal, text};

const DAY_NAMES: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

fn invalid(message: String) -> Refusal {
    Refusal::Internal(message)
}

/// The zone's offset at an instant, in milliseconds (`zoneOffsetMs`).
fn zone_offset_ms(instant: i64, zone: &jiff::tz::TimeZone) -> Outcome<i64> {
    let at =
        jiff::Timestamp::from_millisecond(instant).map_err(|error| invalid(error.to_string()))?;
    Ok(i64::from(zone.to_offset(at).seconds()) * 1000)
}

/// A wall-clock time in `zone` as an instant (`fromZonedTime`): the offset
/// read twice so a DST change resolves to the right side.
fn from_zoned_time(wall_clock: &str, zone: &jiff::tz::TimeZone) -> Outcome<i64> {
    let naive = parse_date(&format!("{wall_clock}Z"))
        .ok_or_else(|| invalid(format!("Invalid wall-clock timestamp: {wall_clock}")))?;
    let first = naive - zone_offset_ms(naive, zone)?;
    Ok(naive - zone_offset_ms(first, zone)?)
}

/// The weekday of a calendar date (`weekdayNameForDate`).
fn weekday_name(date: &str) -> Outcome<&'static str> {
    let at = parse_date(&format!("{date}T00:00:00Z"))
        .ok_or_else(|| invalid(format!("Invalid date: {date}")))?;
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    let day = (at.div_euclid(DAY_MS) + 4).rem_euclid(7) as usize;
    Ok(DAY_NAMES[day])
}

/// The calendar date after `date` (`nextDate`).
fn next_date(date: &str) -> Outcome<String> {
    let at = parse_date(&format!("{date}T00:00:00Z"))
        .ok_or_else(|| invalid(format!("Invalid date: {date}")))?;
    Ok(iso(at + DAY_MS)[..10].to_owned())
}

/// `${value}` in a template string.
fn template(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::String(text) => text.clone(),
        other => crate::js::js_string(other),
    }
}

/// The owner's busy events that overlap `[day_start, day_end)`: confirmed
/// or tentative, organised by them or on one of their calendars, an event
/// without an end taking 30 minutes. Their `(start, end)`.
async fn busy_events(
    db: &PgPool,
    owner: &str,
    owned_calendars: Vec<String>,
    day_start: i64,
    day_end: i64,
) -> Result<Vec<(PrimitiveDateTime, Option<PrimitiveDateTime>)>, sea_orm::DbErr> {
    // `coalesce(end_time, start_time + interval '30 minutes')`.
    let ends_at = Func::coalesce([
        Expr::col(events::Column::EndTime),
        sea_orm::ExprTrait::add(
            Expr::col(events::Column::StartTime),
            sea_orm::ExprTrait::cast_as(Expr::value("30 minutes"), "interval"),
        ),
    ]);
    events::Entity::find()
        .select_only()
        .columns([events::Column::StartTime, events::Column::EndTime])
        .filter(events::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(events::Column::OrganizerId.eq(owner))
                .add(events::Column::CalendarId.is_in(owned_calendars)),
        )
        .filter(events::Column::Status.is_in(["confirmed", "tentative"]))
        .filter(events::Column::StartTime.lt(timestamp_at(day_end)))
        .filter(sea_orm::ExprTrait::gt(ends_at, timestamp_at(day_start)))
        .into_tuple()
        .all(&orm(db))
        .await
}

/// A nullable integer column as a number.
fn number(value: &Value) -> Option<f64> {
    value.as_f64()
}

/// `computeAvailableSlots` for a page row, on `date` (`YYYY-MM-DD`, page zone).
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
pub(crate) async fn available_slots(
    db: &PgPool,
    page: &Value,
    date: &str,
    now: i64,
) -> Outcome<Vec<Value>> {
    let availability = match &page["availability"] {
        Value::Null => Value::Object(serde_json::Map::new()),
        other => other.clone(),
    };
    let zone_name = page["timezone"]
        .as_str()
        .filter(|z| !z.is_empty())
        .unwrap_or("UTC")
        .to_owned();
    let override_slots = page["dateOverrides"]
        .as_array()
        .and_then(|list| list.iter().find(|o| o["date"].as_str() == Some(date)))
        .map(|o| o["slots"].clone());
    let day_slots = match override_slots {
        Some(slots) => slots,
        None => availability
            .get(weekday_name(date)?)
            .cloned()
            .filter(|v| !v.is_null())
            .unwrap_or(Value::Array(Vec::new())),
    };
    let ranges: Vec<Value> = match &day_slots {
        Value::Array(list) => list.clone(),
        Value::String(text) if text.is_empty() => Vec::new(),
        _ => return Err(invalid("day slots are not a list".to_owned())),
    };
    if ranges.is_empty() {
        return Ok(Vec::new());
    }

    let zone = time_zone(&zone_name).ok_or_else(|| {
        invalid(format!(
            "RangeError: Invalid time zone specified: {zone_name}"
        ))
    })?;
    let day_start = from_zoned_time(&format!("{date}T00:00:00"), &zone)?;
    let day_end = from_zoned_time(&format!("{}T00:00:00", next_date(date)?), &zone)?;

    let owner = text(page, "ownerId");
    let owned_calendars = crate::access::owned_calendar_ids(db, owner).await?;
    let events = busy_events(db, owner, owned_calendars, day_start, day_end).await?;
    let busy: Vec<(i64, i64)> = events
        .into_iter()
        .map(|(start, end)| {
            let start = millis_at(start);
            let end = end.map_or(start + 30 * 60_000, millis_at);
            (start, end)
        })
        .collect();

    let Some(duration) = number(&page["duration"]) else {
        return Err(invalid("duration is not a number".to_owned()));
    };
    if duration <= 0.0 {
        // TypeScript walks forever (until the runtime stops it).
        return Err(invalid("duration must be positive".to_owned()));
    }
    #[allow(clippy::cast_possible_truncation)]
    let duration_ms = (duration * 60_000.0) as i64;
    #[allow(clippy::cast_possible_truncation)]
    let minutes =
        |key: &str, fallback: f64| (number(&page[key]).unwrap_or(fallback) * 60_000.0) as i64;
    let buffer_before = minutes("bufferBefore", 0.0);
    let buffer_after = minutes("bufferAfter", 0.0);
    let min_notice = minutes("minNotice", 60.0);
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    let beyond_horizon = number(&page["maxAdvance"])
        .is_some_and(|days| day_start > now + (days * DAY_MS as f64) as i64);

    let mut day_full = false;
    if let Some(cap) = number(&page["maxBookingsPerDay"]).filter(|cap| *cap > 0.0) {
        let count = calendar_bookings::Entity::find()
            .filter(calendar_bookings::Column::BookingPageId.eq(text(page, "id")))
            .filter(calendar_bookings::Column::DeletedAt.is_null())
            .filter(calendar_bookings::Column::Status.ne("cancelled"))
            .filter(calendar_bookings::Column::StartTime.gte(timestamp_at(day_start)))
            .filter(calendar_bookings::Column::StartTime.lt(timestamp_at(day_end)))
            .count(&orm(db))
            .await?;
        #[allow(clippy::cast_precision_loss)]
        {
            day_full = count as f64 >= cap;
        }
    }

    let mut slots = Vec::new();
    for range in &ranges {
        let range_start =
            from_zoned_time(&format!("{date}T{}:00", template(&range["start"])), &zone)?;
        let range_end = from_zoned_time(&format!("{date}T{}:00", template(&range["end"])), &zone)?;
        let mut current = range_start;
        while current + duration_ms <= range_end {
            let slot_start = current;
            let slot_end = current + duration_ms;
            let buffered_start = slot_start - buffer_before;
            let buffered_end = slot_end + buffer_after;
            let conflict = busy
                .iter()
                .any(|(start, end)| buffered_start < *end && buffered_end > *start);
            let too_soon = slot_start - now < min_notice;
            slots.push(json!({
                "start": iso(slot_start),
                "end": iso(slot_end),
                "available": !conflict && !too_soon && !beyond_horizon && !day_full,
            }));
            current += duration_ms;
        }
    }
    Ok(slots)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_clock_times_resolve_in_the_zone() {
        let amsterdam = time_zone("Europe/Amsterdam").expect("zone");
        // Summer: UTC+2.
        let at = from_zoned_time("2030-07-01T10:00:00", &amsterdam).ok();
        assert_eq!(at.map(iso).as_deref(), Some("2030-07-01T08:00:00.000Z"));
        // Winter: UTC+1.
        let at = from_zoned_time("2030-01-01T10:00:00", &amsterdam).ok();
        assert_eq!(at.map(iso).as_deref(), Some("2030-01-01T09:00:00.000Z"));
        assert_eq!(weekday_name("2030-12-25").ok(), Some("wednesday"));
        assert_eq!(next_date("2030-12-31").ok().as_deref(), Some("2031-01-01"));
    }
}
