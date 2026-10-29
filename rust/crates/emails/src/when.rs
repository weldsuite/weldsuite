//! `formatTime`, `formatWhen` and friends (`packages/core/emails/src/format.ts`):
//! times as `Intl.DateTimeFormat` writes them for `en-US` and `nl-NL`, in the
//! recipient's zone, the zone written once at the end of a range.

use std::sync::LazyLock;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use jiff::Zoned;

use crate::zone_names::ZONE_NAMES;
use crate::{EmailError, EmailLocale, format_date};

/// An instant in a zone, with the zone's name as given.
struct At {
    zoned: Zoned,
    zone: String,
}

/// The zone `Intl` would format in: an IANA name or an offset (`+01:00`).
fn zone_of(name: &str) -> Result<TimeZone, EmailError> {
    if let Some(minutes) = offset_minutes(name) {
        return jiff::tz::Offset::from_seconds(minutes * 60)
            .map(TimeZone::fixed)
            .map_err(|error| EmailError::Date(format!("{name}: {error}")));
    }
    TimeZone::get(name).map_err(|error| EmailError::Date(format!("{name}: {error}")))
}

/// `±HH[:MM]` / `±HHMM` in minutes.
fn offset_minutes(name: &str) -> Option<i32> {
    let sign = match name.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let rest = &name[1..];
    let (hours, minutes) = match rest.len() {
        2 => (rest, "00"),
        4 => rest.split_at(2),
        5 if rest.as_bytes()[2] == b':' => (&rest[..2], &rest[3..]),
        _ => return None,
    };
    let hours: i32 = hours.parse().ok()?;
    let minutes: i32 = minutes.parse().ok()?;
    Some(sign * (hours * 60 + minutes))
}

fn at(millis: i64, zone: &str) -> Result<At, EmailError> {
    let timestamp = Timestamp::from_millisecond(millis)
        .map_err(|error| EmailError::Date(format!("{millis}: {error}")))?;
    Ok(At {
        zoned: timestamp.to_zoned(zone_of(zone)?),
        zone: zone.to_owned(),
    })
}

/// `timeZoneName: 'short'`: the locale's abbreviation where it has one,
/// else `GMT`, `GMT+2`, `GMT+5:30`.
fn zone_name(at: &At, locale: EmailLocale) -> String {
    let offset = at.zoned.offset().seconds() / 60;
    let named = ZONE_NAMES
        .iter()
        .find(|(zone, minutes, _, _)| zone.eq_ignore_ascii_case(&at.zone) && *minutes == offset)
        .map(|(_, _, en, nl)| match locale {
            EmailLocale::En => *en,
            EmailLocale::Nl => *nl,
        })
        .filter(|name| !name.is_empty());
    if let Some(name) = named {
        return name.to_owned();
    }
    if offset == 0 {
        return "GMT".to_owned();
    }
    let sign = if offset < 0 { '-' } else { '+' };
    let (hours, minutes) = (offset.abs() / 60, offset.abs() % 60);
    if minutes == 0 {
        format!("GMT{sign}{hours}")
    } else {
        format!("GMT{sign}{hours}:{minutes:02}")
    }
}

/// `hour: 'numeric', minute: '2-digit'`: `3:00 PM` / `15:00`.
fn clock(at: &At, locale: EmailLocale) -> String {
    let (hour, minute) = (at.zoned.hour(), at.zoned.minute());
    match locale {
        EmailLocale::En => {
            let suffix = if hour < 12 { "AM" } else { "PM" };
            let twelve = match hour % 12 {
                0 => 12,
                h => h,
            };
            format!("{twelve}:{minute:02} {suffix}")
        }
        EmailLocale::Nl => format!("{hour:02}:{minute:02}"),
    }
}

fn long_date(millis: i64, locale: EmailLocale, zone: &str) -> Result<String, EmailError> {
    let timestamp = Timestamp::from_millisecond(millis)
        .map_err(|error| EmailError::Date(format!("{millis}: {error}")))?;
    format_date(&timestamp.to_string(), locale, zone)
}

/// `formatTime(iso, locale, timeZone, withZone)`.
pub fn format_time(millis: i64, locale: EmailLocale, zone: &str, with_zone: bool) -> Result<String, EmailError> {
    let at = at(millis, zone)?;
    let time = clock(&at, locale);
    Ok(if with_zone {
        format!("{time} {}", zone_name(&at, locale))
    } else {
        time
    })
}

/// `formatDateTime`: `Wednesday, July 1, 2026 at 11:00 PM GMT+2` /
/// `woensdag 1 juli 2026 om 23:00 CEST`.
fn format_date_time(millis: i64, locale: EmailLocale, zone: &str, with_zone: bool) -> Result<String, EmailError> {
    let date = long_date(millis, locale, zone)?;
    let time = format_time(millis, locale, zone, with_zone)?;
    let joiner = match locale {
        EmailLocale::En => "at",
        EmailLocale::Nl => "om",
    };
    Ok(format!("{date} {joiner} {time}"))
}

/// The calendar day in `zone` (`sameDay`).
fn same_day(a: i64, b: i64, zone: &str) -> Result<bool, EmailError> {
    Ok(at(a, zone)?.zoned.date() == at(b, zone)?.zoned.date())
}

/// `dates.allDay` in each locale (`{date} (all day)`).
static ALL_DAY: LazyLock<(String, String)> = LazyLock::new(|| {
    let read = |json: &str| {
        serde_json::from_str::<serde_json::Value>(json)
            .ok()
            .and_then(|strings| strings["dates"]["allDay"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "{date}".to_owned())
    };
    (
        read(include_str!("../../../catalogs/emails/strings.en.json")),
        read(include_str!("../../../catalogs/emails/strings.nl.json")),
    )
});

/// An end time as `formatWhen` reads it: none (absent or `''`), an instant,
/// or a value `new Date()` can't read (which makes the formatting throw).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndTime {
    None,
    At(i64),
    Invalid,
}

/// `formatWhen({ start, end, allDay, locale, timeZone })`: one line saying
/// when something happens.
pub fn format_when(
    start: i64,
    end: EndTime,
    all_day: bool,
    locale: EmailLocale,
    zone: &str,
) -> Result<String, EmailError> {
    let end = match end {
        EndTime::None => None,
        EndTime::At(end) => Some(end),
        EndTime::Invalid => return Err(EmailError::Date("RangeError: Invalid time value".to_owned())),
    };
    if all_day {
        let days = match end {
            Some(end) if !same_day(start, end, zone)? => format!(
                "{} – {}",
                long_date(start, locale, zone)?,
                long_date(end, locale, zone)?
            ),
            _ => long_date(start, locale, zone)?,
        };
        let template = match locale {
            EmailLocale::En => &ALL_DAY.0,
            EmailLocale::Nl => &ALL_DAY.1,
        };
        return Ok(template.replace("{date}", &days));
    }
    let Some(end) = end else {
        return format_date_time(start, locale, zone, true);
    };
    if same_day(start, end, zone)? {
        return Ok(format!(
            "{} – {}",
            format_date_time(start, locale, zone, false)?,
            format_time(end, locale, zone, true)?
        ));
    }
    Ok(format!(
        "{} – {}",
        format_date_time(start, locale, zone, true)?,
        format_date_time(end, locale, zone, true)?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(iso: &str) -> i64 {
        iso.parse::<Timestamp>().expect("iso").as_millisecond()
    }

    /// Node's `Intl.DateTimeFormat` (and `formatWhen`) for the same inputs.
    #[test]
    fn times_like_intl() {
        let start = ms("2026-07-01T21:00:00Z");
        let end = ms("2026-07-01T21:30:00Z");
        assert_eq!(
            format_when(start, EndTime::None, false, EmailLocale::En, "Europe/Amsterdam").expect("when"),
            "Wednesday, July 1, 2026 at 11:00 PM GMT+2"
        );
        assert_eq!(
            format_when(start, EndTime::None, false, EmailLocale::Nl, "Europe/Amsterdam").expect("when"),
            "woensdag 1 juli 2026 om 23:00 CEST"
        );
        assert_eq!(
            format_when(start, EndTime::At(end), false, EmailLocale::En, "UTC").expect("when"),
            "Wednesday, July 1, 2026 at 9:00 PM – 9:30 PM UTC"
        );
        assert_eq!(
            format_time(ms("2026-01-01T09:05:00Z"), EmailLocale::En, "America/New_York", true).expect("time"),
            "4:05 AM EST"
        );
        assert_eq!(
            format_time(ms("2026-01-01T09:05:00Z"), EmailLocale::Nl, "Asia/Kolkata", true).expect("time"),
            "14:35 GMT+5:30"
        );
        assert_eq!(
            format_time(ms("2026-01-01T09:05:00Z"), EmailLocale::En, "Europe/London", true).expect("time"),
            "9:05 AM GMT"
        );
        assert_eq!(
            format_when(start, EndTime::At(end), true, EmailLocale::En, "UTC").expect("when"),
            "Wednesday, July 1, 2026 (all day)"
        );
        assert!(format_when(start, EndTime::Invalid, false, EmailLocale::En, "UTC").is_err());
    }
}
