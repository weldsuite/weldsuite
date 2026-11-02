//! The RFC 5545 `.ics` attached to calendar, meeting and booking mail
//! (`packages/core/emails/src/ics.ts`, `buildIcs` / `icsAttachment`).

use jiff::Timestamp;
use weldsuite_ports::MailAttachment;

/// A time as the builder gets it: what `new Date(value)` makes of a request's
/// string. `Empty` is `''` (falsy, but not nullish).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IcsTime {
    Missing,
    Empty,
    Invalid,
    At(i64),
}

impl IcsTime {
    fn present(self) -> bool {
        matches!(self, Self::Invalid | Self::At(_))
    }
}

/// A person on the invite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IcsPerson {
    pub email: String,
    pub name: Option<String>,
}

/// `IcsEvent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IcsEvent {
    pub uid: String,
    /// `REQUEST`, `CANCEL` or `PUBLISH`.
    pub method: String,
    pub sequence: i64,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start: IcsTime,
    pub end: IcsTime,
    pub all_day: bool,
    /// The zone that resolves an all-day event's calendar day; a valid one.
    pub timezone: Option<String>,
    pub organizer: Option<IcsPerson>,
    pub attendees: Vec<IcsPerson>,
    pub url: Option<String>,
    pub meeting_url: Option<String>,
    pub product: String,
}

/// Why the builder failed: an Invalid Date (`toISOString` throws).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IcsError;

impl std::fmt::Display for IcsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RangeError: Invalid time value")
    }
}

impl std::error::Error for IcsError {}

fn instant(time: IcsTime) -> Result<i64, IcsError> {
    match time {
        IcsTime::At(ms) => Ok(ms),
        _ => Err(IcsError),
    }
}

/// `20261001T210000Z`.
fn utc_stamp(ms: i64) -> Result<String, IcsError> {
    let at = Timestamp::from_millisecond(ms).map_err(|_| IcsError)?;
    Ok(at.strftime("%Y%m%dT%H%M%SZ").to_string())
}

/// The calendar day in `zone`, plus `plus_days`, as `YYYYMMDD`.
fn date_only(ms: i64, zone: &str, plus_days: i64) -> Result<String, IcsError> {
    let at = Timestamp::from_millisecond(ms).map_err(|_| IcsError)?;
    let tz = jiff::tz::TimeZone::get(zone).unwrap_or(jiff::tz::TimeZone::UTC);
    let date = at.to_zoned(tz).date();
    let date = date
        .checked_add(jiff::Span::new().days(plus_days))
        .map_err(|_| IcsError)?;
    Ok(date.strftime("%Y%m%d").to_string())
}

fn escape_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push_str("\\n");
            }
            '\n' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out
}

fn param_value(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| {
            if matches!(c, '"' | '\r' | '\n') {
                ' '
            } else {
                c
            }
        })
        .collect();
    format!("\"{cleaned}\"")
}

fn mailto(email: &str) -> String {
    let cleaned: String = email
        .chars()
        .filter(|c| !(c.is_whitespace() || matches!(c, ';' | ':' | ',' | '"' | '<' | '>')))
        .collect();
    format!("mailto:{cleaned}")
}

const MAX_OCTETS: usize = 75;

/// Fold a content line at 75 octets without splitting a character.
fn fold(line: &str) -> String {
    if line.len() <= MAX_OCTETS {
        return line.to_owned();
    }
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut limit = MAX_OCTETS;
    for c in line.chars() {
        if current.len() + c.len_utf8() > limit {
            parts.push(std::mem::take(&mut current));
            limit = MAX_OCTETS - 1;
        }
        current.push(c);
    }
    parts.push(current);
    parts.join("\r\n ")
}

/// `js_trim` of an optional string, empty as `None`.
fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(|v| v.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// `buildIcs(event)`, with `now` for DTSTAMP.
pub fn build_ics(event: &IcsEvent, now_ms: i64) -> Result<String, IcsError> {
    let cancelled = event.method == "CANCEL";
    let join_url = if cancelled {
        None
    } else {
        trimmed(event.meeting_url.as_deref())
    };
    let url = trimmed(event.url.as_deref()).or_else(|| join_url.clone());
    let product: String = event
        .product
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '.' | '-'))
        .collect();
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_owned(),
        "VERSION:2.0".to_owned(),
        format!("PRODID:-//WeldSuite//{product}//EN"),
        "CALSCALE:GREGORIAN".to_owned(),
        format!("METHOD:{}", event.method),
        "BEGIN:VEVENT".to_owned(),
        format!("UID:{}", event.uid),
        format!("DTSTAMP:{}", utc_stamp(now_ms)?),
        format!("SEQUENCE:{}", event.sequence),
        format!("SUMMARY:{}", escape_text(&event.title)),
    ];
    if let Some(organizer) = event.organizer.as_ref().filter(|o| !o.email.is_empty()) {
        let cn = trimmed(organizer.name.as_deref())
            .map(|name| format!(";CN={}", param_value(&name)))
            .unwrap_or_default();
        lines.push(format!("ORGANIZER{cn}:{}", mailto(&organizer.email)));
    }
    for attendee in event.attendees.iter().filter(|a| !a.email.is_empty()) {
        let cn = trimmed(attendee.name.as_deref())
            .map(|name| format!(";CN={}", param_value(&name)))
            .unwrap_or_default();
        lines.push(format!(
            "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE{cn}:{}",
            mailto(&attendee.email)
        ));
    }
    if event.start.present() {
        let start = instant(event.start)?;
        if event.all_day {
            let zone = event.timezone.as_deref().unwrap_or("UTC");
            lines.push(format!("DTSTART;VALUE=DATE:{}", date_only(start, zone, 0)?));
            // `event.end ?? event.start`: an empty end is not nullish.
            let end = match event.end {
                IcsTime::Missing => start,
                other => instant(other)?,
            };
            lines.push(format!("DTEND;VALUE=DATE:{}", date_only(end, zone, 1)?));
        } else {
            lines.push(format!("DTSTART:{}", utc_stamp(start)?));
            if let IcsTime::At(end) = event.end
                && end > start
            {
                lines.push(format!("DTEND:{}", utc_stamp(end)?));
            }
        }
    }
    let description = [
        trimmed(event.description.as_deref()),
        join_url.as_ref().map(|url| format!("Join: {url}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    if !description.is_empty() {
        lines.push(format!("DESCRIPTION:{}", escape_text(&description)));
    }
    if let Some(location) = trimmed(event.location.as_deref()).or_else(|| join_url.clone()) {
        lines.push(format!("LOCATION:{}", escape_text(&location)));
    }
    let no_breaks = |text: &str| text.replace(['\r', '\n'], "");
    if let Some(url) = &url {
        lines.push(format!("URL:{}", no_breaks(url)));
    }
    if let Some(join) = &join_url {
        lines.push(format!("X-GOOGLE-CONFERENCE:{}", no_breaks(join)));
    }
    lines.push(format!(
        "STATUS:{}",
        if cancelled { "CANCELLED" } else { "CONFIRMED" }
    ));
    lines.push("END:VEVENT".to_owned());
    lines.push("END:VCALENDAR".to_owned());
    let folded: Vec<String> = lines.iter().map(|line| fold(line)).collect();
    Ok(format!("{}\r\n", folded.join("\r\n")))
}

/// `icsAttachment(event)`: `invite.ics`, the METHOD in the content type.
pub fn ics_attachment(event: &IcsEvent, now_ms: i64) -> Result<MailAttachment, IcsError> {
    Ok(MailAttachment {
        filename: "invite.ics".to_owned(),
        content_type: format!("text/calendar; method={}; charset=UTF-8", event.method),
        content: build_ics(event, now_ms)?.into_bytes(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invites_are_built_like_build_ics() {
        let event = IcsEvent {
            uid: "evt_1@weldsuite.org".to_owned(),
            method: "REQUEST".to_owned(),
            sequence: 0,
            title: "Planning, Q4; part 1".to_owned(),
            description: Some("Line 1\nLine 2".to_owned()),
            location: None,
            start: IcsTime::At(1_917_810_000_000),
            end: IcsTime::At(1_917_813_600_000),
            all_day: false,
            timezone: Some("Europe/Amsterdam".to_owned()),
            organizer: Some(IcsPerson {
                email: "host@acme.test".to_owned(),
                name: Some("Host".to_owned()),
            }),
            attendees: vec![IcsPerson {
                email: "guest@example.com".to_owned(),
                name: None,
            }],
            url: None,
            meeting_url: Some("https://meet.weldsuite.org/r/abc".to_owned()),
            product: "WeldCalendar".to_owned(),
        };
        let ics = build_ics(&event, 1_700_000_000_000).expect("ics");
        assert!(ics.contains("SUMMARY:Planning\\, Q4\\; part 1\r\n"));
        assert!(ics.contains("DTSTART:20301009T210000Z\r\nDTEND:20301009T220000Z\r\n"));
        assert!(
            ics.contains("DESCRIPTION:Line 1\\nLine 2\\n\\nJoin: https://meet.weldsuite.org/r/abc")
        );
        assert!(ics.contains("LOCATION:https://meet.weldsuite.org/r/abc\r\n"));
        assert!(ics.contains("ORGANIZER;CN=\"Host\":mailto:host@acme.test\r\n"));
        assert!(ics.ends_with("STATUS:CONFIRMED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"));
        let all_day = IcsEvent {
            all_day: true,
            end: IcsTime::Empty,
            ..event
        };
        assert!(build_ics(&all_day, 0).is_err());
    }
}
