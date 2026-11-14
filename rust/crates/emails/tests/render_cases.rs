//! Rust renders every case the TypeScript renderer rendered: the preview
//! props of each exported template (`fixtures/render-cases.json`, written by
//! `pnpm rust:emails` with `renderEmail`). Subject, HTML and plain text must
//! match byte for byte.

use serde::Deserialize;
use serde_json::Value;
use weldsuite_emails::calendar::{CalendarEventEmail, CalendarEventKind};
use weldsuite_emails::desk::{
    DeskReport, DeskReportAgent, DeskReportBacklog, DeskReportChart, DeskReportKpi,
    DeskReportPoint, KpiKey,
};
use weldsuite_emails::flow::{FlowPortalInvitation, FlowStatusReport, Overall};
use weldsuite_emails::meet::MeetInvitation;
use weldsuite_emails::portal::PortalSignIn;
use weldsuite_emails::reach::{AccessApproved, AccessRejected, ApprovedLimits};
use weldsuite_emails::sign::{SignCompleted, SignRequest};
use weldsuite_emails::workspace::WorkspaceInvitation;
use weldsuite_emails::{
    EmailBrand, EmailLocale, EndTime, RenderedEmail, ai, auth, billing, calendar, desk, flow,
    forms, hr, meet, portal, reach, sign, workspace,
};

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

/// `Array<{ question, answer }>` (WeldForms' answers).
fn answers(value: &Value) -> Vec<forms::QuestionAnswer> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| forms::QuestionAnswer {
                    question: item["question"].as_str().unwrap_or_default().to_owned(),
                    answer: item["answer"].as_str().unwrap_or_default().to_owned(),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[allow(
    clippy::too_many_lines,
    reason = "one arm per exported template, each building its props"
)]
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
        "forms.code" => forms::code(
            locale,
            &brand,
            &s(p, "title"),
            &s(p, "code"),
            p["expiresInMinutes"]
                .as_u64()
                .and_then(|m| u32::try_from(m).ok()),
        ),
        "forms.invite" => forms::invite(
            locale,
            &brand,
            &forms::InviteProps {
                sender_name: p["senderName"].as_str().unwrap_or_default(),
                title: p["title"].as_str().unwrap_or_default(),
                subject: p["subject"].as_str(),
                message: p["message"].as_str(),
                url: p["url"].as_str().unwrap_or_default(),
                closes_at: p["closesAt"].as_str(),
                time_zone: p["timeZone"].as_str(),
                reminder: p["reminder"].as_bool().unwrap_or(false),
            },
        ),
        "forms.receipt" => forms::receipt(
            locale,
            &brand,
            &s(p, "title"),
            p["number"].as_i64(),
            &answers(&p["answers"]),
        ),
        "forms.response" => forms::response(
            locale,
            &brand,
            &s(p, "title"),
            p["number"].as_i64(),
            p["respondent"].as_str(),
            p["answers"]
                .is_array()
                .then(|| answers(&p["answers"]))
                .as_deref(),
            &s(p, "url"),
        ),
        "forms.digest" => forms::digest(
            locale,
            &brand,
            &s(p, "title"),
            &s(p, "workspaceName"),
            p["count"].as_i64().unwrap_or_default(),
            &p["responses"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| forms::DigestItem {
                            number: item["number"].as_i64(),
                            respondent: item["respondent"].as_str().map(str::to_owned),
                            summary: item["summary"].as_str().map(str::to_owned),
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
            &s(p, "url"),
        ),
        "forms.quota" => forms::quota(
            locale,
            &brand,
            &s(p, "workspaceName"),
            p["percent"]
                .as_u64()
                .and_then(|n| u8::try_from(n).ok())
                .unwrap_or_default(),
            p["used"].as_i64().unwrap_or_default(),
            p["limit"].as_i64().unwrap_or_default(),
            &s(p, "resetsAt"),
            &s(p, "url"),
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
        "desk.report" => desk::report(locale, &brand, &desk_report_props(p)),
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
        "flow.status-report" => flow::status_report(
            locale,
            &brand,
            &FlowStatusReport {
                recipient_name: opt("recipientName"),
                project_name: s(p, "projectName"),
                period_label: s(p, "periodLabel"),
                overall: p["overall"]
                    .as_str()
                    .and_then(Overall::parse)
                    .unwrap_or_default(),
                summary: s(p, "summary"),
                published_by: opt("publishedBy"),
                url: s(p, "url"),
            },
        ),
        "flow.portal-invitation" => flow::portal_invitation(
            locale,
            &brand,
            &FlowPortalInvitation {
                contact_name: opt("contactName"),
                project_name: s(p, "projectName"),
                invited_by: opt("invitedBy"),
                workspace_name: s(p, "workspaceName"),
                url: s(p, "url"),
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
        "ai.provider-enabled" => ai::provider_enabled(
            locale,
            &brand,
            &ai::ProviderEnabled {
                recipient_name: opt("recipientName"),
                workspace_name: s(p, "workspaceName"),
                provider_name: s(p, "providerName"),
                enabled_by: s(p, "enabledBy"),
                own_key: p["keySource"].as_str() == Some("own"),
                settings_url: s(p, "settingsUrl"),
            },
        ),
        "billing.dunning" => billing::dunning(
            locale,
            &brand,
            &billing::Dunning {
                kind: match p["kind"].as_str() {
                    Some("reminder") => billing::DunningKind::Reminder,
                    Some("ended") => billing::DunningKind::Ended,
                    _ => billing::DunningKind::Failed,
                },
                workspace_name: s(p, "workspaceName"),
                plan_name: s(p, "planName"),
                amount: s(p, "amount"),
                ends_on: s(p, "endsOn"),
                url: s(p, "url"),
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
        "meet.invitation" => {
            let ms = |key: &str| {
                p[key]
                    .as_str()
                    .and_then(|t| t.parse::<jiff::Timestamp>().ok())
                    .map(jiff::Timestamp::as_millisecond)
            };
            meet::invitation(
                locale,
                &brand,
                &MeetInvitation {
                    organizer_name: s(p, "organizerName"),
                    title: s(p, "title"),
                    description: opt("description"),
                    start: ms("startTime"),
                    end: ms("endTime"),
                    timezone: opt("timezone"),
                    join_url: s(p, "joinUrl"),
                },
            )
        }
        "reach.access-approved" => {
            let limits = &p["limits"];
            let count = |key: &str| limits[key].as_i64();
            reach::access_approved(
                locale,
                &brand,
                &AccessApproved {
                    recipient_name: opt("recipientName"),
                    workspace_name: s(p, "workspaceName"),
                    url: s(p, "url"),
                    limits: match (
                        count("maxDomains"),
                        count("maxMailboxes"),
                        count("maxDailySends"),
                    ) {
                        (Some(max_domains), Some(max_mailboxes), Some(max_daily_sends)) => {
                            Some(ApprovedLimits {
                                max_domains,
                                max_mailboxes,
                                max_daily_sends,
                            })
                        }
                        _ => None,
                    },
                },
            )
        }
        "reach.access-rejected" => reach::access_rejected(
            locale,
            &brand,
            &AccessRejected {
                recipient_name: opt("recipientName"),
                workspace_name: s(p, "workspaceName"),
                reason: s(p, "reason"),
                url: opt("url"),
            },
        ),
        "auth.verify-email" => auth::verify_email(
            locale,
            &s(p, "code"),
            &s(p, "url"),
            minutes(p).unwrap_or(60),
        ),
        "auth.sign-in-code" => auth::sign_in_code(locale, &s(p, "code"), minutes(p).unwrap_or(5)),
        "auth.password-reset" => auth::password_reset(
            locale,
            &s(p, "email"),
            &s(p, "code"),
            &s(p, "url"),
            minutes(p).unwrap_or(60),
        ),
        "workspace.invitation" => workspace::invitation(
            locale,
            &brand,
            &WorkspaceInvitation {
                inviter_name: s(p, "inviterName"),
                workspace_name: s(p, "workspaceName"),
                role: s(p, "role"),
                accept_url: s(p, "acceptUrl"),
                recipient_email: s(p, "recipientEmail"),
            },
        ),
        other => panic!("no Rust renderer for {other}"),
    };
    result.unwrap_or_else(|error| panic!("{} {}: {error}", case.template, case.preview))
}

/// `expiresInMinutes`, when the preview sets it.
fn minutes(p: &Value) -> Option<u32> {
    p["expiresInMinutes"]
        .as_u64()
        .and_then(|m| u32::try_from(m).ok())
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

/// A preview's `DeskReportEmailProps`.
fn desk_report_props(p: &Value) -> DeskReport {
    let opt = |key: &str| p[key].as_str().map(str::to_owned);
    let items = |key: &str| p[key].as_array().cloned().unwrap_or_default();
    DeskReport {
        schedule_name: s(p, "scheduleName"),
        report_title: opt("reportTitle"),
        period_label: s(p, "periodLabel"),
        kpis: items("kpis")
            .iter()
            .map(|kpi| DeskReportKpi {
                key: kpi["key"]
                    .as_str()
                    .and_then(KpiKey::parse)
                    .expect("a KPI key"),
                value: kpi["value"].as_f64(),
                previous: kpi["previous"].as_f64(),
            })
            .collect(),
        backlog: p["backlog"].as_object().map(|backlog| DeskReportBacklog {
            open: backlog["open"].as_f64().unwrap_or_default(),
            unassigned: backlog["unassigned"].as_f64().unwrap_or_default(),
            waiting: backlog["waiting"].as_f64().unwrap_or_default(),
        }),
        agents: items("agents")
            .iter()
            .map(|agent| DeskReportAgent {
                name: s(agent, "name"),
                resolved: agent["resolved"].as_f64().unwrap_or_default(),
                csat: agent["csat"].as_f64(),
            })
            .collect(),
        charts: items("charts")
            .iter()
            .map(|chart| DeskReportChart {
                title: s(chart, "title"),
                rows: chart["rows"]
                    .as_array()
                    .map(|rows| {
                        rows.iter()
                            .map(|row| DeskReportPoint {
                                label: s(row, "label"),
                                value: row["value"].as_f64().unwrap_or_default(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect(),
        url: s(p, "url"),
        scheduled_by: opt("scheduledBy"),
        csv_attached: p["csvAttached"].as_bool().unwrap_or(false),
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
