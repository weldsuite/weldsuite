//! Rust renders every case the TypeScript renderer rendered: the preview
//! props of each exported template (`fixtures/render-cases.json`, written by
//! `pnpm rust:emails` with `renderEmail`). Subject, HTML and plain text must
//! match byte for byte.

use serde::Deserialize;
use serde_json::Value;
use weldsuite_emails::calendar::{CalendarEventEmail, CalendarEventKind};
use weldsuite_emails::portal::PortalSignIn;
use weldsuite_emails::sign::{SignCompleted, SignRequest};
use weldsuite_emails::{EmailBrand, EmailLocale, EndTime, RenderedEmail, calendar, hr, portal, sign};

#[derive(Deserialize)]
struct Case {
    template: String,
    preview: String,
    locale: String,
    brand: Value,
    props: Value,
    expected: Expected,
}

#[derive(Deserialize)]
struct Expected {
    subject: String,
    html: String,
    text: String,
}

fn brand(value: &Value) -> EmailBrand {
    let text = |key: &str| value[key].as_str().map(str::to_owned);
    match value["kind"].as_str() {
        Some("workspace") => EmailBrand::Workspace {
            name: text("name").unwrap_or_default(),
            logo_url: text("logoUrl"),
            accent_color: text("accentColor"),
        },
        _ => EmailBrand::WeldSuite {
            module: text("module"),
        },
    }
}

fn s(props: &Value, key: &str) -> String {
    props[key].as_str().unwrap_or_default().to_owned()
}

fn list(props: &Value, key: &str) -> Vec<String> {
    props[key]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn render(case: &Case) -> RenderedEmail {
    let locale = if case.locale == "nl" {
        EmailLocale::Nl
    } else {
        EmailLocale::En
    };
    let brand = brand(&case.brand);
    let p = &case.props;
    let opt = |key: &str| p[key].as_str().map(str::to_owned);
    let result = match case.template.as_str() {
        "sign.request" => sign::request(
            locale,
            &brand,
            &SignRequest {
                sender_name: s(p, "senderName"),
                title: s(p, "title"),
                message: opt("message"),
                url: s(p, "url"),
                expires_at: opt("expiresAt"),
                time_zone: opt("timeZone"),
                reminder: p["reminder"].as_bool().unwrap_or(false),
            },
        ),
        "sign.code" => sign::code(
            locale,
            &brand,
            &s(p, "title"),
            &s(p, "code"),
            p["expiresInMinutes"]
                .as_u64()
                .and_then(|m| u32::try_from(m).ok()),
        ),
        "sign.completed" => sign::completed(
            locale,
            &brand,
            &SignCompleted {
                title: s(p, "title"),
                signers: list(p, "signers"),
                attached: p["attached"].as_bool().unwrap_or(false),
                url: opt("url"),
                for_sender: p["forSender"].as_bool().unwrap_or(false),
            },
        ),
        "sign.declined" => sign::declined(
            locale,
            &brand,
            &s(p, "title"),
            &s(p, "declinedBy"),
            &s(p, "reason"),
            &s(p, "url"),
        ),
        "sign.voided" => sign::voided(
            locale,
            &brand,
            &s(p, "senderName"),
            &s(p, "title"),
            &s(p, "reason"),
        ),
        "sign.expired" => sign::expired(
            locale,
            &brand,
            &s(p, "title"),
            &list(p, "unsigned"),
            &s(p, "url"),
        ),
        "calendar.event" => calendar::event(locale, &brand, &calendar_props(p)),
        "portal.sign-in" => portal::sign_in(
            locale,
            &brand,
            &PortalSignIn {
                portal_name: s(p, "portalName"),
                code: s(p, "code"),
                url: opt("url"),
                expires_in_minutes: p["expiresInMinutes"]
                    .as_u64()
                    .and_then(|m| u32::try_from(m).ok()),
            },
        ),
        "hr.payslip-ready" => hr::payslip_ready(
            locale,
            &brand,
            &hr::PayslipReady {
                recipient_name: opt("recipientName"),
                employer_name: s(p, "employerName"),
                pay_date: s(p, "payDate"),
                url: opt("url"),
            },
        ),
        "hr.bank-changed" => hr::bank_changed(
            locale,
            &brand,
            &hr::BankChanged {
                recipient_name: opt("recipientName"),
                employer_name: s(p, "employerName"),
                by_employee: p["byEmployee"].as_bool().unwrap_or(false),
                changed_at: s(p, "changedAt"),
                time_zone: opt("timeZone"),
            },
        ),
        other => panic!("no Rust renderer for {other}"),
    };
    result.unwrap_or_else(|error| panic!("{} {}: {error}", case.template, case.preview))
}

fn millis(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|iso| iso.parse::<jiff::Timestamp>().ok())
        .map(jiff::Timestamp::as_millisecond)
}

fn end_time(value: &Value) -> EndTime {
    millis(value).map_or(EndTime::None, EndTime::At)
}

/// A preview's `CalendarEventEmailProps`.
fn calendar_props(p: &Value) -> CalendarEventEmail {
    let opt = |key: &str| p[key].as_str().map(str::to_owned);
    let kind = match p["kind"].as_str() {
        Some("update") => CalendarEventKind::Update,
        Some("reschedule") => CalendarEventKind::Reschedule,
        Some("cancel") => CalendarEventKind::Cancel,
        Some("removed") => CalendarEventKind::Removed,
        Some("restored") => CalendarEventKind::Restored,
        _ => CalendarEventKind::Invite,
    };
    CalendarEventEmail {
        kind,
        organizer_name: s(p, "organizerName"),
        title: s(p, "title"),
        description: opt("description"),
        start: millis(&p["startTime"]).unwrap_or_default(),
        end: end_time(&p["endTime"]),
        old_start: millis(&p["oldStartTime"]),
        old_end: end_time(&p["oldEndTime"]),
        location: opt("location"),
        timezone: opt("timezone"),
        all_day: p["allDay"].as_bool().unwrap_or(false),
        meeting_url: opt("meetingUrl"),
        event_url: opt("eventUrl"),
    }
}

/// The first byte where two strings differ, with some context.
fn difference(expected: &str, actual: &str) -> String {
    let at = expected
        .bytes()
        .zip(actual.bytes())
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| expected.len().min(actual.len()));
    let start = at.saturating_sub(80);
    let context = |s: &str| {
        s.get(start..(at + 80).min(s.len()))
            .unwrap_or("")
            .to_owned()
    };
    format!(
        "at byte {at}:\n  expected …{}…\n  actual   …{}…",
        context(expected),
        context(actual)
    )
}

#[test]
fn rust_renders_what_typescript_renders() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("fixtures/render-cases.json")).expect("cases parse");
    assert!(!cases.is_empty());
    let mut failures = Vec::new();
    for case in &cases {
        let actual = render(case);
        let label = format!("{} {} ({})", case.template, case.preview, case.locale);
        for (part, expected, actual) in [
            ("subject", &case.expected.subject, &actual.subject),
            ("text", &case.expected.text, &actual.text),
            ("html", &case.expected.html, &actual.html),
        ] {
            if expected != actual {
                failures.push(format!("{label} {part} {}", difference(expected, actual)));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
