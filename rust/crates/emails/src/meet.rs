//! WeldMeet's invitation (`packages/core/emails/src/templates/meet/invitation.tsx`):
//! someone was added to a meeting and gets its public join link, with the
//! time when the meeting is scheduled.

use std::collections::BTreeMap;

use minijinja::Value;

use crate::when::{EndTime, format_when};
use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, render};

/// `MeetInvitationEmailProps`, times already read as `new Date()` reads them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MeetInvitation {
    pub organizer_name: String,
    pub title: String,
    pub description: Option<String>,
    /// The start (milliseconds), when the meeting is scheduled.
    pub start: Option<i64>,
    pub end: Option<i64>,
    /// The IANA zone the time is shown in (`zoneOr`: UTC when invalid).
    pub timezone: Option<String>,
    pub join_url: String,
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

/// Render `meet.invitation` for one invitee.
pub fn invitation(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &MeetInvitation,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    values.insert(
        "organizer_name".to_owned(),
        Value::from(props.organizer_name.as_str()),
    );
    values.insert("title".to_owned(), Value::from(props.title.as_str()));
    values.insert("join_url".to_owned(), Value::from(props.join_url.as_str()));
    if let Some(start) = props.start {
        let end = props.end.map_or(EndTime::None, EndTime::At);
        let zone = zone_or(props.timezone.as_deref());
        flags.push("when");
        values.insert(
            "when".to_owned(),
            Value::from(format_when(start, end, false, locale, zone)?),
        );
    }
    if let Some(description) = props
        .description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        flags.push("description");
        values.insert("description".to_owned(), Value::from(description));
    }
    render("meet.invitation", locale, brand, &flags, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_join_link_and_the_time() {
        let brand = EmailBrand::weldsuite("WeldMeet");
        let props = MeetInvitation {
            organizer_name: "Sanne".into(),
            title: "Design review".into(),
            description: Some("Walkthrough".into()),
            start: Some(1_791_896_400_000),
            end: Some(1_791_899_100_000),
            timezone: Some("Europe/Amsterdam".into()),
            join_url: "https://meet.weldsuite.org/ws_1/wm-abc-def-ghi".into(),
        };
        let email = invitation(EmailLocale::En, &brand, &props).expect("renders");
        assert!(email.subject.contains("Design review"));
        assert!(
            email
                .html
                .contains("https://meet.weldsuite.org/ws_1/wm-abc-def-ghi")
        );
        assert!(email.text.contains("Walkthrough"));
        let instant = MeetInvitation {
            start: None,
            end: None,
            description: None,
            ..props
        };
        assert!(invitation(EmailLocale::Nl, &brand, &instant).is_ok());
    }
}
