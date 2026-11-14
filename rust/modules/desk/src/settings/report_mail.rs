//! Building and sending one scheduled WeldDesk report email
//! (`services/desk-report-schedules.ts`, `sendScheduledReport`, TASK-1228).
//! The routes ("send now", [`super::schedules`]) and the sweep
//! ([`crate::report_sweep`]) both call it.
//!
//! The message is `weldsuite_emails`' `desk.report` with the numbers as a CSV
//! attachment when the schedule says so, one message to all recipients, sent
//! through the worker's `SEND_EMAIL` (the `MailTransport` of the outbound
//! bindings) after the outbound mail guard reserved it (source `desk_report`,
//! WeldSuite's own sender), as the calendar's invitations are.

use std::sync::Arc;

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_emails::desk::{
    DeskReport, DeskReportAgent, DeskReportBacklog, DeskReportChart, DeskReportKpi,
    DeskReportPoint, KpiKey, overview_period_label, short_date,
};
use weldsuite_emails::{EmailBrand, EmailLocale};
use weldsuite_kit::cursor::encode_uri_component;
use weldsuite_kit::validation::js_trim;
use weldsuite_mail_domain::outbound::{
    CheckOutboundInput, MimeAttachment, OutboundKind, OutboundReservation, SendEmailParams,
    SubjectInput, check_outbound, commit_outbound, release_outbound, send_email,
};
use weldsuite_ports::MailTransport;

use super::export::{
    SavedReport, load_saved_report, overview_csv, overview_csv_filename, report_csv_filename,
    saved_report_csv,
};
use super::reports::{self, date_key};
use super::schedules::ScheduleRow;
use crate::dispatch::Outbound;

/// WeldSuite's own sending address for system mail (`SYSTEM_FROM_ADDRESS`).
const SYSTEM_SENDER: &str = "notifications@mail.weldsuite.org";

const MAX_ERROR_LENGTH: usize = 500;
const TOP_AGENTS: usize = 5;
const CHART_ROWS: usize = 10;

/// What a schedule's `lastError` says when the outbound mail guard refused
/// the send (`REPORT_HELD_BACK_MESSAGE`).
const REPORT_HELD_BACK_MESSAGE: &str = "The send was held back by the outbound mail limits. It will be tried again at the next scheduled run.";

/// `ReportSendResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SendOutcome {
    Sent,
    Failed(String),
    /// The saved report the schedule sends no longer exists.
    Gone,
}

/// What a send needs besides the schedule (`SendReportOptions`): the tenant
/// database, the workspace's Clerk org id (the link into the app), the
/// worker's env and its outbound bindings.
pub(crate) struct Mailer {
    pub(crate) db: PgPool,
    pub(crate) clerk_org_id: String,
    /// The guard and `SEND_EMAIL`.
    pub(crate) outbound: Outbound,
    /// `ENVIRONMENT`.
    pub(crate) environment: Option<String>,
    /// `PUBLIC_APP_URL`.
    pub(crate) public_app_url: Option<String>,
    /// `SYSTEM_EMAIL_FROM` (`withFromAddress`).
    pub(crate) from_override: Option<String>,
}

/// `errorText(err)`: the message to show, at most 500 UTF-16 units.
fn error_text(message: &str) -> String {
    let text = if message.is_empty() {
        "Sending failed"
    } else {
        message
    };
    let units: Vec<u16> = text.encode_utf16().take(MAX_ERROR_LENGTH).collect();
    String::from_utf16_lossy(&units)
}

/// `appBaseUrl(env)`: the platform base URL the report link starts from
/// (`PUBLIC_APP_URL`, else the app of the environment).
fn app_base_url(public_app_url: Option<&str>, environment: Option<&str>) -> String {
    if let Some(configured) = public_app_url.map(js_trim).filter(|url| !url.is_empty()) {
        return configured.to_owned();
    }
    match environment {
        Some("test") => "https://app-test.weldsuite.org",
        Some("development") => "http://localhost:3000",
        _ => "https://app.weldsuite.org",
    }
    .to_owned()
}

/// `workspaceAppUrl(baseUrl, clerkOrgId, path)`: `{base}/w/{org}{path}`.
fn workspace_app_url(base: &str, clerk_org_id: &str, path: &str) -> String {
    let base = js_trim(base).trim_end_matches('/');
    if clerk_org_id.is_empty() {
        format!("{base}{path}")
    } else {
        format!("{base}/w/{}{path}", encode_uri_component(clerk_org_id))
    }
}

/// `ReportContent`: the template's props (but the schedule's own), the CSV
/// and the in-app path of the report.
struct Content {
    props: DeskReport,
    csv_filename: String,
    csv: String,
    path: String,
}

fn number(value: &Value) -> Option<f64> {
    value.as_f64()
}

/// `overviewContent(db, schedule, locale, now)`.
async fn overview_content(
    db: &PgPool,
    schedule: &ScheduleRow,
    locale: EmailLocale,
    now: i64,
) -> Result<Content, String> {
    let overview = reports::overview(db, Some(&schedule.range), now)
        .await
        .map_err(|error| error.to_string())?;
    let range = &overview["range"];
    let key = range["key"].as_str().unwrap_or_default();
    let period_label = overview_period_label(
        range["start"].as_str().unwrap_or_default(),
        range["end"].as_str().unwrap_or_default(),
        locale,
    )
    .map_err(|error| error.to_string())?;
    let kpis = [
        ("created", KpiKey::Created),
        ("resolved", KpiKey::Resolved),
        ("firstResponseMedian", KpiKey::FirstResponseMedian),
        ("resolutionMedian", KpiKey::ResolutionMedian),
        ("slaCompliance", KpiKey::SlaCompliance),
        ("csat", KpiKey::Csat),
    ]
    .into_iter()
    .map(|(name, key)| DeskReportKpi {
        key,
        value: number(&overview["kpis"][name]["value"]),
        previous: number(&overview["kpis"][name]["previous"]),
    })
    .collect();
    let backlog = &overview["backlog"];
    let agents = overview["agents"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter(|agent| !agent["id"].is_null())
        .take(TOP_AGENTS)
        .map(|agent| DeskReportAgent {
            name: agent["name"].as_str().unwrap_or_default().to_owned(),
            resolved: number(&agent["resolved"]).unwrap_or_default(),
            csat: number(&agent["csat"]),
        })
        .collect();
    Ok(Content {
        props: DeskReport {
            report_title: None,
            period_label,
            kpis,
            backlog: Some(DeskReportBacklog {
                open: number(&backlog["open"]).unwrap_or_default(),
                unassigned: number(&backlog["unassigned"]).unwrap_or_default(),
                waiting: number(&backlog["waiting"]).unwrap_or_default(),
            }),
            agents,
            ..DeskReport::default()
        },
        csv_filename: overview_csv_filename(key, now),
        csv: overview_csv(&overview),
        path: "/welddesk/reports".to_owned(),
    })
}

/// `savedReportContent(report, locale, now)`.
fn saved_report_content(
    report: &SavedReport,
    locale: EmailLocale,
    now: i64,
) -> Result<Content, String> {
    let charts = report
        .charts
        .iter()
        .map(|chart| {
            // A breakdown lists its first rows (the biggest), a time series its latest.
            let rows = if chart.breakdown {
                &chart.points[..chart.points.len().min(CHART_ROWS)]
            } else {
                &chart.points[chart.points.len().saturating_sub(CHART_ROWS)..]
            };
            DeskReportChart {
                title: chart.title.clone(),
                rows: rows
                    .iter()
                    .map(|point| DeskReportPoint {
                        label: point["label"].as_str().unwrap_or_default().to_owned(),
                        value: number(&point["value"]).unwrap_or_default(),
                    })
                    .collect(),
            }
        })
        .collect();
    Ok(Content {
        props: DeskReport {
            report_title: Some(report.title.clone()),
            period_label: short_date(&date_key(now), locale).map_err(|error| error.to_string())?,
            charts,
            ..DeskReport::default()
        },
        csv_filename: report_csv_filename(report, now),
        csv: saved_report_csv(report),
        path: format!(
            "/welddesk/reports/custom/{}",
            encode_uri_component(&report.id)
        ),
    })
}

/// `memberName(db, userId)`: the member's name, when they have one.
async fn member_name(db: &PgPool, user_id: Option<&str>) -> Result<Option<String>, sqlx::Error> {
    let Some(user_id) = user_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let name: Option<Option<String>> =
        sqlx::query_scalar("select name from workspace_members where user_id = $1 limit 1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(name
        .flatten()
        .map(|name| js_trim(&name).to_owned())
        .filter(|name| !name.is_empty()))
}

/// `settle(env, db, reservation, sent, recipientCount)`: count what went
/// out, or give the reservation back when nothing did.
async fn settle(
    mailer: &Mailer,
    reservation: &OutboundReservation,
    sent: &[String],
    recipient_count: usize,
) {
    if sent.is_empty() {
        release_outbound(&mailer.outbound.guard, reservation).await;
    } else {
        let narrowed = (sent.len() < recipient_count).then_some(sent);
        commit_outbound(
            &mailer.outbound.guard,
            Some(&mailer.db),
            reservation,
            narrowed,
        )
        .await;
    }
}

/// Render the email and hand it to the transport: the recipients it reached,
/// or why it did not go out.
async fn transmit(
    mailer: &Mailer,
    transport: &dyn MailTransport,
    schedule: &ScheduleRow,
    content: Content,
    locale: EmailLocale,
    recipients: &[String],
) -> Result<Vec<String>, String> {
    // `mailboxes(options.to)`: trimmed, the empty ones dropped.
    let to: Vec<String> = recipients
        .iter()
        .map(|recipient| js_trim(recipient).to_owned())
        .filter(|recipient| !recipient.is_empty())
        .collect();
    if to.is_empty() {
        return Err("sendSystemEmail(desk.report): no recipients".to_owned());
    }
    let scheduled_by = member_name(&mailer.db, schedule.created_by_id.as_deref())
        .await
        .map_err(|error| error.to_string())?;
    let attachments = if schedule.attach_csv {
        vec![MimeAttachment {
            filename: content.csv_filename,
            content_type: Some("text/csv; charset=utf-8".to_owned()),
            content: content.csv.into_bytes(),
            cid: None,
        }]
    } else {
        Vec::new()
    };
    let props = DeskReport {
        schedule_name: schedule.name.clone(),
        url: workspace_app_url(
            &app_base_url(
                mailer.public_app_url.as_deref(),
                mailer.environment.as_deref(),
            ),
            &mailer.clerk_org_id,
            &content.path,
        ),
        scheduled_by,
        csv_attached: !attachments.is_empty(),
        ..content.props
    };
    let rendered =
        weldsuite_emails::desk::report(locale, &EmailBrand::weldsuite("WeldDesk"), &props)
            .map_err(|error| error.to_string())?;
    let address = mailer
        .from_override
        .as_deref()
        .map(str::trim)
        .filter(|address| !address.is_empty())
        .unwrap_or(SYSTEM_SENDER);
    let params = SendEmailParams {
        from: format!("WeldDesk <{address}>"),
        to,
        subject: rendered.subject,
        text: Some(rendered.text),
        html: Some(rendered.html),
        attachments,
        ..SendEmailParams::default()
    };
    let sent = send_email(transport, &params)
        .await
        .map_err(|error| error.to_string())?;
    // `result.rejected`: the recipients that have to verify first.
    let refused: Vec<String> = sent
        .pending_recipients
        .iter()
        .map(|recipient| recipient.to_lowercase())
        .collect();
    Ok(recipients
        .iter()
        .filter(|recipient| !refused.contains(&recipient.to_lowercase()))
        .cloned()
        .collect())
}

/// `sendScheduledReport(options)`: build the schedule's report and mail it
/// to its recipients (one message, all of them in To), with the CSV attached
/// when the schedule says so. Never fails: a failure comes back as `Failed`
/// with a message to show; a deleted saved report as `Gone`.
pub(crate) async fn send_scheduled_report(
    mailer: &Mailer,
    schedule: &ScheduleRow,
    now: i64,
) -> SendOutcome {
    let Some(transport) = mailer.outbound.transport.clone() else {
        return SendOutcome::Failed(
            "Email sending is not configured for this workspace.".to_owned(),
        );
    };
    let failed = |message: String| {
        tracing::error!(
            error = %message,
            "[DeskReports] sending schedule {} failed",
            schedule.id
        );
        SendOutcome::Failed(error_text(&message))
    };
    // `resolveEmailLocale(schedule.locale)`
    let locale = EmailLocale::resolve([Some(schedule.locale.as_str())]);
    let content = if let Some(report_id) = schedule.report_id.as_deref().filter(|id| !id.is_empty())
    {
        match load_saved_report(&mailer.db, report_id, now).await {
            Ok(Some(report)) => saved_report_content(&report, locale, now),
            Ok(None) => return SendOutcome::Gone,
            Err(error) => Err(error.to_string()),
        }
    } else {
        overview_content(&mailer.db, schedule, locale, now).await
    };
    let content = match content {
        Ok(content) => content,
        Err(message) => return failed(message),
    };

    let recipients = schedule.recipient_list();
    // The outbound mail guard (weldsuite-documentation/plans/weldmail-outbound-abuse.md): the mail goes out
    // from WeldSuite's address and carries workspace-written names and titles.
    let mut input = CheckOutboundInput::new(
        SubjectInput::Workspace {
            clerk_org_id: mailer.clerk_org_id.clone(),
            workspace_id: None,
        },
        "desk_report",
        OutboundKind::NewThread,
        SYSTEM_SENDER,
        recipients.clone(),
    );
    input.system_sender = true;
    // `content.props.reportTitle?.trim() || schedule.name`
    input.subject_line = Some(
        content
            .props
            .report_title
            .as_deref()
            .map(js_trim)
            .filter(|title| !title.is_empty())
            .unwrap_or(&schedule.name)
            .to_owned(),
    );
    input.text = Some(
        std::iter::once(schedule.name.as_str())
            .chain(
                content
                    .props
                    .charts
                    .iter()
                    .map(|chart| chart.title.as_str()),
            )
            .collect::<Vec<_>>()
            .join(" "),
    );
    let reservation = match check_outbound(&mailer.outbound.guard, Some(&mailer.db), &input).await {
        Ok(reservation) => reservation,
        Err(denied) => {
            tracing::warn!(
                "[DeskReports] schedule {} held back by the outbound guard ({})",
                schedule.id,
                denied.code().as_str()
            );
            return SendOutcome::Failed(REPORT_HELD_BACK_MESSAGE.to_owned());
        }
    };

    let delivered = match transmit(
        mailer,
        transport.as_ref(),
        schedule,
        content,
        locale,
        &recipients,
    )
    .await
    {
        Ok(delivered) => delivered,
        Err(message) => {
            settle(mailer, &reservation, &[], 0).await;
            return failed(message);
        }
    };
    settle(mailer, &reservation, &delivered, recipients.len()).await;
    if delivered.is_empty() {
        return SendOutcome::Failed("Every recipient was refused by the mail service.".to_owned());
    }
    SendOutcome::Sent
}

/// The transport a mailer sends through, for callers that build one from
/// the deployment's bindings.
pub(crate) fn outbound_of(
    bindings: &weldsuite_mail_domain::outbound::OutboundBindings,
    master: Option<PgPool>,
    cache: Option<Arc<dyn weldsuite_ports::DynCache>>,
) -> Outbound {
    Outbound {
        guard: bindings.guard(master, cache),
        transport: bindings.transport.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_base_url_is_the_configured_one_else_the_environments() {
        assert_eq!(
            app_base_url(Some("https://desk.example.test/"), Some("production")),
            "https://desk.example.test/"
        );
        assert_eq!(
            app_base_url(None, Some("production")),
            "https://app.weldsuite.org"
        );
        assert_eq!(
            app_base_url(Some("  "), Some("test")),
            "https://app-test.weldsuite.org"
        );
        assert_eq!(
            app_base_url(None, Some("development")),
            "http://localhost:3000"
        );
        assert_eq!(
            app_base_url(None, Some("weird")),
            "https://app.weldsuite.org"
        );
        assert_eq!(app_base_url(None, None), "https://app.weldsuite.org");
    }

    #[test]
    fn links_open_in_the_workspace() {
        assert_eq!(
            workspace_app_url(
                "https://app-test.weldsuite.org/",
                "org_desk_reports",
                "/welddesk/reports"
            ),
            "https://app-test.weldsuite.org/w/org_desk_reports/welddesk/reports"
        );
        assert_eq!(
            workspace_app_url("https://app.weldsuite.org", "", "/welddesk/reports"),
            "https://app.weldsuite.org/welddesk/reports"
        );
    }

    #[test]
    fn errors_are_cut_at_500() {
        assert_eq!(error_text(""), "Sending failed");
        assert_eq!(error_text("relay down"), "relay down");
        assert_eq!(error_text(&"x".repeat(600)).len(), 500);
    }
}
