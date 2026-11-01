//! `formatDate` (`packages/core/emails/src/format.ts`): the long date
//! `Intl.DateTimeFormat` writes for `en-US` and `nl-NL`, in the recipient's
//! time zone.

use jiff::Timestamp;
use jiff::civil::Weekday;
use jiff::tz::TimeZone;

use crate::{EmailError, EmailLocale};

const MONTHS_EN: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const MONTHS_NL: [&str; 12] = [
    "januari",
    "februari",
    "maart",
    "april",
    "mei",
    "juni",
    "juli",
    "augustus",
    "september",
    "oktober",
    "november",
    "december",
];

fn weekday(day: Weekday, locale: EmailLocale) -> &'static str {
    let en = match day {
        Weekday::Monday => ("Monday", "maandag"),
        Weekday::Tuesday => ("Tuesday", "dinsdag"),
        Weekday::Wednesday => ("Wednesday", "woensdag"),
        Weekday::Thursday => ("Thursday", "donderdag"),
        Weekday::Friday => ("Friday", "vrijdag"),
        Weekday::Saturday => ("Saturday", "zaterdag"),
        Weekday::Sunday => ("Sunday", "zondag"),
    };
    match locale {
        EmailLocale::En => en.0,
        EmailLocale::Nl => en.1,
    }
}

/// "Monday, October 5, 2026" / "maandag 5 oktober 2026" for an ISO time in
/// the IANA zone `time_zone` (`formatDate(iso, locale, timeZone)`).
pub fn format_date(iso: &str, locale: EmailLocale, time_zone: &str) -> Result<String, EmailError> {
    let at: Timestamp = iso
        .parse()
        .map_err(|error| EmailError::Date(format!("{iso}: {error}")))?;
    let zone = TimeZone::get(time_zone)
        .map_err(|error| EmailError::Date(format!("{time_zone}: {error}")))?;
    let date = at.to_zoned(zone).date();
    let month = usize::try_from(date.month() - 1).unwrap_or(0);
    Ok(match locale {
        EmailLocale::En => format!(
            "{}, {} {}, {}",
            weekday(date.weekday(), locale),
            MONTHS_EN[month],
            date.day(),
            date.year()
        ),
        EmailLocale::Nl => format!(
            "{} {} {} {}",
            weekday(date.weekday(), locale),
            date.day(),
            MONTHS_NL[month],
            date.year()
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `Intl.DateTimeFormat` for the same inputs.
    #[test]
    fn dates_like_intl() {
        let at = "2001-02-03T12:00:00.000Z";
        assert_eq!(
            format_date(at, EmailLocale::En, "UTC").expect("date"),
            "Saturday, February 3, 2001"
        );
        assert_eq!(
            format_date(at, EmailLocale::Nl, "UTC").expect("date"),
            "zaterdag 3 februari 2001"
        );
        // Late on the 23rd in UTC is already the 24th in Amsterdam.
        let late = "2026-11-23T23:30:00.000Z";
        assert_eq!(
            format_date(late, EmailLocale::En, "Europe/Amsterdam").expect("date"),
            "Tuesday, November 24, 2026"
        );
        assert_eq!(
            format_date(late, EmailLocale::Nl, "Europe/Amsterdam").expect("date"),
            "dinsdag 24 november 2026"
        );
        assert!(format_date(at, EmailLocale::En, "Mars/Olympus").is_err());
    }
}
