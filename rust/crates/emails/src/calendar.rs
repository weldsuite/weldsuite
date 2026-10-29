//! WeldCalendar's attendee mail (`packages/core/emails/src/templates/calendar/event.tsx`):
//! invite, update, reschedule, cancel, removed and restored, one export per
//! kind (`calendar.event.<kind>`). The `.ics` is attached by the sender
//! ([`crate::ics`]).

use std::collections::BTreeMap;

use minijinja::Value;

use crate::when::{EndTime, format_when};
use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, render};

/// `CalendarEventKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalendarEventKind {
    Invite,
    Update,
    Reschedule,
    Cancel,
    Removed,
    Restored,
}

impl CalendarEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invite => "invite",
            Self::Update => "update",
            Self::Reschedule => "reschedule",
            Self::Cancel => "cancel",
            Self::Removed => "removed",
            Self::Restored => "restored",
        }
    }

    /// `isEndedKind`: the event is no longer the recipient's (no join or app link).
    pub fn is_ended(self) -> bool {
        matches!(self, Self::Cancel | Self::Removed)
    }
}

/// `CalendarEventEmailProps`, times already read as `new Date()` reads them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarEventEmail {
    pub kind: CalendarEventKind,
    pub organizer_name: String,
    pub title: String,
    pub description: Option<String>,
    /// The start (milliseconds); every calendar mail has one.
    pub start: i64,
    pub end: EndTime,
    /// Reschedules show the previous slot struck through.
    pub old_start: Option<i64>,
    pub old_end: EndTime,
    pub location: Option<String>,
    /// The IANA zone the times are shown in.
    pub timezone: Option<String>,
    pub all_day: bool,
    pub meeting_url: Option<String>,
    /// The link into the authenticated calendar; members only.
    pub event_url: Option<String>,
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// WeldMeet rooms live on `meet(-env).weldsuite.org` (`isWeldMeetUrl`).
fn is_weldmeet_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    let Some(rest) = host.strip_suffix(".weldsuite.org") else {
        return false;
    };
    rest == "meet"
        || rest
            .strip_prefix("meet-")
            .is_some_and(|env| !env.is_empty() && env.bytes().all(|b| b.is_ascii_lowercase()))
}

/// The zone the props name when it is valid, else UTC (`zoneOr`).
fn zone_or(zone: Option<&str>) -> &str {
    match zone {
        Some(zone)
            if !zone.is_empty()
                && zone.encode_utf16().count() <= 50
                && jiff::tz::TimeZone::get(zone).is_ok() =>
        {
            zone
        }
        _ => "UTC",
    }
}

/// Render `calendar.event` for one recipient.
pub fn event(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &CalendarEventEmail,
) -> Result<RenderedEmail, EmailError> {
    let ended = props.kind.is_ended();
    let zone = zone_or(props.timezone.as_deref());
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    values.insert(
        "organizer_name".to_owned(),
        Value::from(props.organizer_name.as_str()),
    );
    values.insert("title".to_owned(), Value::from(props.title.as_str()));
    values.insert(
        "when".to_owned(),
        Value::from(format_when(
            props.start,
            props.end,
            props.all_day,
            locale,
            zone,
        )?),
    );
    if props.kind == CalendarEventKind::Reschedule
        && let Some(old_start) = props.old_start
    {
        flags.push("was");
        values.insert(
            "was".to_owned(),
            Value::from(format_when(
                old_start,
                props.old_end,
                props.all_day,
                locale,
                zone,
            )?),
        );
    }
    if let Some(location) = trimmed(props.location.as_deref()) {
        flags.push("where");
        values.insert("where".to_owned(), Value::from(location));
    }
    if !ended {
        if let Some(description) = trimmed(props.description.as_deref()) {
            flags.push("description");
            values.insert("description".to_owned(), Value::from(description));
        }
        if let Some(url) = trimmed(props.meeting_url.as_deref()) {
            flags.push("meeting");
            if is_weldmeet_url(url) {
                flags.push("weldmeet");
            }
            values.insert("meeting_url".to_owned(), Value::from(url));
        }
        if let Some(url) = trimmed(props.event_url.as_deref()) {
            flags.push("event_url");
            values.insert("event_url".to_owned(), Value::from(url));
        }
    }
    render(
        &format!("calendar.event.{}", props.kind.as_str()),
        locale,
        brand,
        &flags,
        values,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weldmeet_links_are_recognised() {
        assert!(is_weldmeet_url("https://meet.weldsuite.org/r/abc"));
        assert!(is_weldmeet_url("https://meet-test.weldsuite.org/r/abc"));
        assert!(!is_weldmeet_url("https://zoom.us/j/1"));
        assert!(!is_weldmeet_url("not a url"));
    }
}
