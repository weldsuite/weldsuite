//! WeldPanel's usage notice (`packages/core/emails/src/templates/panel/usage.tsx`):
//! a workspace's events or recordings are at 80% or all of the plan's
//! allowance, or the credit wallet can't pay for more and data is being
//! dropped. Sent to the workspace's owners by the usage settlement
//! (`apps/workers/panel-api/src/services/usage-mail.ts`).

use std::collections::BTreeMap;

use minijinja::Value;

use crate::reach::format_count;
use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, format_date, render};

/// `PanelUsageEmailKind`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum UsageKind {
    /// 80% of an allowance.
    #[default]
    Near,
    /// All of an allowance.
    Full,
    /// The wallet can't pay the next block: no new recordings.
    ReplayBlocked,
    /// And events are past the grace: new events are dropped.
    EventsBlocked,
}

impl UsageKind {
    /// The kind's name in `PanelUsageEmailKind`.
    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "near" => Some(Self::Near),
            "full" => Some(Self::Full),
            "replay_blocked" => Some(Self::ReplayBlocked),
            "events_blocked" => Some(Self::EventsBlocked),
            _ => None,
        }
    }

    /// The exported variant's flag (`near` has none).
    fn flag(self) -> Option<&'static str> {
        match self {
            Self::Near => None,
            Self::Full => Some("full"),
            Self::ReplayBlocked => Some("replay_blocked"),
            Self::EventsBlocked => Some("events_blocked"),
        }
    }
}

/// One meter: `{ used, allowance }`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Meter {
    pub used: i64,
    pub allowance: i64,
}

/// `PanelUsageEmailProps`.
#[derive(Debug, Clone, Default)]
pub struct PanelUsage {
    pub workspace_name: String,
    pub kind: UsageKind,
    pub events: Meter,
    pub recordings: Meter,
    /// ISO time the month's count starts again (start of next month, UTC).
    pub resets_at: String,
    /// Where the usage is shown.
    pub url: String,
}

/// Renders `panel.usage`. The figures are grouped as
/// `new Intl.NumberFormat(locale).format(n)` groups them (`41,000`,
/// `41.000`), the date as `formatDate(resetsAt, locale, 'UTC')`.
///
/// # Errors
///
/// [`EmailError`] when `resets_at` is not a time, or the exported template
/// can't be rendered.
pub fn usage(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &PanelUsage,
) -> Result<RenderedEmail, EmailError> {
    let flags: Vec<&str> = props.kind.flag().into_iter().collect();
    let mut values = BTreeMap::new();
    values.insert(
        "workspace_name".to_owned(),
        Value::from(props.workspace_name.as_str()),
    );
    values.insert("url".to_owned(), Value::from(props.url.as_str()));
    values.insert(
        "resets_date".to_owned(),
        Value::from(format_date(&props.resets_at, locale, "UTC")?),
    );
    for (key, n) in [
        ("events_used", props.events.used),
        ("events_allowance", props.events.allowance),
        ("recordings_used", props.recordings.used),
        ("recordings_allowance", props.recordings.allowance),
    ] {
        values.insert(key.to_owned(), Value::from(format_count(n, locale)));
    }
    render("panel.usage", locale, brand, &flags, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn props(kind: UsageKind) -> PanelUsage {
        PanelUsage {
            workspace_name: "Acme <Staffing>".to_owned(),
            kind,
            events: Meter {
                used: 41_000,
                allowance: 50_000,
            },
            recordings: Meter {
                used: 12,
                allowance: 500,
            },
            resets_at: "2026-12-01T00:00:00.000Z".to_owned(),
            url: "https://app.test/w/org_1/weldpanel/settings?tab=usage".to_owned(),
        }
    }

    #[test]
    fn every_kind_renders_in_both_languages() {
        let brand = EmailBrand::weldsuite("WeldPanel");
        for kind in [
            UsageKind::Near,
            UsageKind::Full,
            UsageKind::ReplayBlocked,
            UsageKind::EventsBlocked,
        ] {
            for locale in [EmailLocale::En, EmailLocale::Nl] {
                let email = usage(locale, &brand, &props(kind)).expect("renders");
                assert!(
                    email.subject.contains("Acme <Staffing>"),
                    "{}",
                    email.subject
                );
                assert!(!email.html.contains('⟦') && !email.text.contains('⟦'));
                assert!(email.html.contains("tab=usage"));
            }
        }
    }

    #[test]
    fn subjects_and_figures_follow_the_kind_and_the_language() {
        let brand = EmailBrand::weldsuite("WeldPanel");
        let near = usage(EmailLocale::En, &brand, &props(UsageKind::Near)).expect("near");
        assert_eq!(
            near.subject,
            "Acme <Staffing> has used 80% of its WeldPanel allowance"
        );
        assert!(near.html.contains("41,000 of 50,000"));
        assert!(near.text.contains("Events: 41,000 of 50,000"));
        assert!(near.text.contains("Tuesday, December 1, 2026"));
        let dropped = usage(EmailLocale::En, &brand, &props(UsageKind::EventsBlocked))
            .expect("events_blocked");
        assert_eq!(
            dropped.subject,
            "WeldPanel is dropping events for Acme <Staffing>"
        );
        assert!(dropped.text.contains("cannot be recovered"));
        let dutch = usage(EmailLocale::Nl, &brand, &props(UsageKind::Full)).expect("nl");
        assert!(dutch.html.contains("41.000"), "{}", dutch.html);
        assert_eq!(
            UsageKind::parse("replay_blocked"),
            Some(UsageKind::ReplayBlocked)
        );
        assert_eq!(UsageKind::parse("other"), None);
    }
}
