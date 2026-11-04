//! WeldFlow's emails (`packages/core/emails/src/templates/flow/`): a status
//! report was published (`flow.status-report`) and a CRM contact is invited to
//! the client project portal (`flow.portal-invitation`). Each function takes
//! the template's props, picks the variant its React component would render
//! and fills it in. [`period_label`] writes a report period the way
//! `periodLabel` does in `format.ts`.

use std::collections::BTreeMap;

use minijinja::Value;

use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, render};

/// The overall colour of a published report (`grey`, no data, is never published).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Overall {
    #[default]
    Green,
    Amber,
    Red,
}

impl Overall {
    /// The colour as the status report stores it (`green`, `amber`, `red`).
    pub fn parse(colour: &str) -> Option<Self> {
        match colour {
            "green" => Some(Self::Green),
            "amber" => Some(Self::Amber),
            "red" => Some(Self::Red),
            _ => None,
        }
    }
}

/// `FlowStatusReportEmailProps`.
#[derive(Debug, Clone, Default)]
pub struct FlowStatusReport {
    /// The greeting name; without one the email opens without it.
    pub recipient_name: Option<String>,
    pub project_name: String,
    /// The period as the recipient reads it ([`period_label`]).
    pub period_label: String,
    pub overall: Overall,
    /// The project manager's summary; line breaks are kept.
    pub summary: String,
    pub published_by: Option<String>,
    /// Absolute link to the report (the app for members, the portal for contacts).
    pub url: String,
}

/// Render `flow.status-report` for one recipient.
pub fn status_report(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &FlowStatusReport,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    values.insert(
        "project_name".to_owned(),
        Value::from(props.project_name.as_str()),
    );
    values.insert(
        "period_label".to_owned(),
        Value::from(props.period_label.as_str()),
    );
    values.insert("summary".to_owned(), Value::from(props.summary.as_str()));
    values.insert("url".to_owned(), Value::from(props.url.as_str()));
    // `props.recipientName?.trim()`
    if let Some(name) = trimmed(props.recipient_name.as_deref()) {
        flags.push("name");
        values.insert("recipient_name".to_owned(), Value::from(name));
    }
    // `props.publishedBy?.trim()`
    if let Some(by) = trimmed(props.published_by.as_deref()) {
        flags.push("by");
        values.insert("published_by".to_owned(), Value::from(by));
    }
    match props.overall {
        Overall::Green => {}
        Overall::Amber => flags.push("amber"),
        Overall::Red => flags.push("red"),
    }
    render("flow.status-report", locale, brand, &flags, values)
}

/// `FlowPortalInvitationEmailProps`.
#[derive(Debug, Clone, Default)]
pub struct FlowPortalInvitation {
    /// The greeting name; without one the email opens without it.
    pub contact_name: Option<String>,
    pub project_name: String,
    /// The workspace member who sent the invitation.
    pub invited_by: Option<String>,
    pub workspace_name: String,
    /// Absolute link to the project in the portal.
    pub url: String,
}

/// Render `flow.portal-invitation` for one contact (callers pass the
/// workspace brand: the recipient is outside the workspace).
pub fn portal_invitation(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &FlowPortalInvitation,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    values.insert(
        "project_name".to_owned(),
        Value::from(props.project_name.as_str()),
    );
    values.insert(
        "workspace_name".to_owned(),
        Value::from(props.workspace_name.as_str()),
    );
    values.insert("url".to_owned(), Value::from(props.url.as_str()));
    // `props.contactName?.trim()`
    if let Some(name) = trimmed(props.contact_name.as_deref()) {
        flags.push("name");
        values.insert("contact_name".to_owned(), Value::from(name));
    }
    // `props.invitedBy?.trim()`
    if let Some(by) = trimmed(props.invited_by.as_deref()) {
        flags.push("by");
        values.insert("invited_by".to_owned(), Value::from(by));
    }
    render("flow.portal-invitation", locale, brand, &flags, values)
}

/// `value?.trim()`, with an empty result counting as absent.
fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// Month names of [`period_label`]: fixed tables, so the text cannot differ
/// from TypeScript's (`MONTH_NAMES` in `format.ts`).
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

/// Two ASCII digits as a number.
fn two_digits(text: &str) -> Option<u32> {
    let bytes = text.as_bytes();
    match bytes {
        [tens @ b'0'..=b'9', ones @ b'0'..=b'9'] => {
            Some(u32::from(tens - b'0') * 10 + u32::from(ones - b'0'))
        }
        _ => None,
    }
}

/// `periodLabel(locale, period)`: the ISO week `2026-W45` is `Week 45, 2026`,
/// the month `2026-11` is `November 2026` (`november 2026` in Dutch). Any
/// other text, including a week or month out of range, is returned as it is.
pub fn period_label(locale: EmailLocale, period: &str) -> String {
    let Some((year, rest)) = period.split_once('-') else {
        return period.to_owned();
    };
    if year.len() != 4 || !year.bytes().all(|b| b.is_ascii_digit()) {
        return period.to_owned();
    }
    if let Some(week) = rest.strip_prefix('W') {
        return match two_digits(week) {
            Some(number @ 1..=53) => format!("Week {number}, {year}"),
            _ => period.to_owned(),
        };
    }
    match two_digits(rest) {
        Some(month @ 1..=12) => {
            let names = match locale {
                EmailLocale::En => &MONTHS_EN,
                EmailLocale::Nl => &MONTHS_NL,
            };
            let name = names.get(month as usize - 1).copied().unwrap_or_default();
            format!("{name} {year}")
        }
        _ => period.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report() -> FlowStatusReport {
        FlowStatusReport {
            recipient_name: Some("Noor".into()),
            project_name: "Customer Portal Relaunch".into(),
            period_label: "Week 45, 2026".into(),
            overall: Overall::Amber,
            summary: "Catalogue API done.\nGo-live holds <15 Jan>.".into(),
            published_by: Some("Sanne Jansen".into()),
            url: "https://app.weldsuite.org/w/org_acme/weldflow/project/proj_1/governance".into(),
        }
    }

    #[test]
    fn a_status_report_says_the_colour_the_period_and_the_summary() {
        let brand = EmailBrand::weldsuite("WeldFlow");
        let en = status_report(EmailLocale::En, &brand, &report()).expect("renders");
        assert_eq!(
            en.subject,
            "Status report: Customer Portal Relaunch, Week 45, 2026 (At risk)"
        );
        assert!(en.text.contains("Overall status: At risk"));
        assert!(
            en.text
                .contains("Hi Noor, here is the latest status report.")
        );
        assert!(en.text.contains("Published by Sanne Jansen."));
        // The summary keeps its lines and is escaped.
        assert!(en.html.contains("Go-live holds &lt;15 Jan&gt;."));
        assert!(en.html.contains("<br"));
        assert!(
            en.html.contains(
                "https://app.weldsuite.org/w/org_acme/weldflow/project/proj_1/governance"
            )
        );

        let nl = status_report(EmailLocale::Nl, &brand, &report()).expect("renders");
        assert_eq!(
            nl.subject,
            "Statusrapport: Customer Portal Relaunch, Week 45, 2026 (In gevaar)"
        );
        assert!(nl.text.contains("Algemene status: In gevaar"));
        assert!(
            nl.text
                .contains("Goedendag Noor, hierbij het laatste statusrapport.")
        );
    }

    #[test]
    fn each_colour_has_its_own_wording_and_no_name_or_author_drops_the_lines() {
        let brand = EmailBrand::weldsuite("WeldFlow");
        for (overall, en, nl) in [
            (Overall::Green, "(On track)", "(Op schema)"),
            (Overall::Amber, "(At risk)", "(In gevaar)"),
            (Overall::Red, "(Off track)", "(Achter op schema)"),
        ] {
            let props = FlowStatusReport {
                overall,
                recipient_name: Some("  ".into()),
                published_by: None,
                ..report()
            };
            let english = status_report(EmailLocale::En, &brand, &props).expect("renders");
            assert!(english.subject.ends_with(en), "{}", english.subject);
            assert!(english.text.contains("Here is the latest status report."));
            assert!(!english.text.contains("Published by"));
            let dutch = status_report(EmailLocale::Nl, &brand, &props).expect("renders");
            assert!(dutch.subject.ends_with(nl), "{}", dutch.subject);
        }
    }

    #[test]
    fn a_workspace_brand_names_the_workspace_and_the_accent_colours_the_button() {
        let brand = EmailBrand::Workspace {
            name: "Acme Studio".into(),
            logo_url: None,
            accent_color: Some("#2563eb".into()),
        };
        let email = status_report(EmailLocale::En, &brand, &report()).expect("renders");
        assert!(email.html.contains("#2563eb"));
        assert!(email.text.contains("Acme Studio"));
        assert!(email.text.contains("Sent via WeldSuite"));
    }

    #[test]
    fn a_portal_invitation_names_the_project_the_inviter_and_the_workspace() {
        let brand = EmailBrand::Workspace {
            name: "Acme Studio".into(),
            logo_url: None,
            accent_color: None,
        };
        let props = FlowPortalInvitation {
            contact_name: Some("Femke".into()),
            project_name: "Customer Portal Relaunch".into(),
            invited_by: Some("Sanne Jansen".into()),
            workspace_name: "Acme Studio".into(),
            url: "https://projects.weldsuite.org/ws_acme/projects/proj_1".into(),
        };
        let en = portal_invitation(EmailLocale::En, &brand, &props).expect("renders");
        assert_eq!(
            en.subject,
            "You have been invited to follow Customer Portal Relaunch"
        );
        assert!(
            en.text
                .contains("Sanne Jansen invited you to follow a project")
        );
        assert!(en.text.contains("Hi Femke,"));
        assert!(en.text.contains("In the project portal of Acme Studio"));
        assert!(
            en.html
                .contains("https://projects.weldsuite.org/ws_acme/projects/proj_1")
        );

        let nl = portal_invitation(EmailLocale::Nl, &brand, &props).expect("renders");
        assert_eq!(
            nl.subject,
            "U bent uitgenodigd om Customer Portal Relaunch te volgen"
        );
        assert!(
            nl.text
                .contains("Sanne Jansen heeft u uitgenodigd om een project te volgen")
        );
        assert!(nl.text.contains("Goedendag Femke,"));

        let anonymous = FlowPortalInvitation {
            contact_name: None,
            invited_by: Some(" ".into()),
            ..props
        };
        let plain = portal_invitation(EmailLocale::En, &brand, &anonymous).expect("renders");
        assert!(
            plain
                .text
                .contains("You have been invited to follow a project")
        );
        assert!(plain.text.contains("Hi,"));
    }

    #[test]
    fn overall_reads_the_stored_colours() {
        assert_eq!(Overall::parse("green"), Some(Overall::Green));
        assert_eq!(Overall::parse("amber"), Some(Overall::Amber));
        assert_eq!(Overall::parse("red"), Some(Overall::Red));
        assert_eq!(Overall::parse("grey"), None);
    }

    #[test]
    fn a_week_is_labelled_the_same_in_both_languages() {
        for locale in [EmailLocale::En, EmailLocale::Nl] {
            assert_eq!(period_label(locale, "2026-W45"), "Week 45, 2026");
            assert_eq!(period_label(locale, "2026-W05"), "Week 5, 2026");
            assert_eq!(period_label(locale, "2026-W53"), "Week 53, 2026");
        }
    }

    #[test]
    fn a_month_is_labelled_in_the_language_of_the_reader() {
        assert_eq!(period_label(EmailLocale::En, "2026-11"), "November 2026");
        assert_eq!(period_label(EmailLocale::Nl, "2026-11"), "november 2026");
        assert_eq!(period_label(EmailLocale::En, "2026-01"), "January 2026");
        assert_eq!(period_label(EmailLocale::Nl, "2026-03"), "maart 2026");
        assert_eq!(period_label(EmailLocale::Nl, "2026-12"), "december 2026");
    }

    #[test]
    fn anything_else_is_returned_as_it_is() {
        for other in [
            "2026-W00",
            "2026-W54",
            "2026-13",
            "2026-00",
            "2026",
            "Q4",
            "",
            " 2026-W45",
            "2026-W4",
            "20266-W45",
            "2026-W45 ",
            "2026-W4a",
            "2026-1",
            "2026-W45-1",
        ] {
            assert_eq!(period_label(EmailLocale::En, other), other);
        }
    }
}
