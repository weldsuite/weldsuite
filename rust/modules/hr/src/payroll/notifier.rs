//! Payroll emails to employees (`services/weldhr/payroll/notifier.ts`), best
//! effort: without a transport (no `SEND_EMAIL`) nothing is sent, and a
//! failed send is logged, never raised. Neither mail carries pay figures or
//! account numbers.
//!
//! - `hr.payslip-ready`: a payslip was published (on approval, to employees
//!   linked to a workspace member), with a link to My HR → Payroll.
//! - `hr.bank-changed`: the salary account changed, whoever changed it.

use std::fmt::Write as _;

use serde_json::Value;
use weldsuite_db::{PgPool, js_row};
use weldsuite_emails::{EmailBrand, EmailLocale, SystemEmail, hr, send_system_email};

use crate::{Caller, HrState};

/// `PLATFORM_URLS[env.ENVIRONMENT]`, production for anything else.
fn platform_url(environment: Option<&str>) -> &'static str {
    match environment.unwrap_or_default() {
        "development" => "http://localhost:3000",
        "test" => "https://app-test.weldsuite.org",
        _ => "https://app.weldsuite.org",
    }
}

/// `encodeURIComponent`.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `myPayrollUrl(c)`: My HR's payroll page in the payslip's workspace
/// (`workspaceAppUrl(base, orgId, '/weldhr/me/payroll')`); `APP_URL`
/// overrides the host.
pub(crate) fn my_payroll_url(caller: &Caller) -> String {
    let app_url = caller
        .env("APP_URL")
        .map(|u| u.trim().to_owned())
        .filter(|u| !u.is_empty());
    let base =
        app_url.unwrap_or_else(|| platform_url(caller.env("ENVIRONMENT").as_deref()).to_owned());
    let base = base.trim().trim_end_matches('/');
    match caller.org_id.as_deref().filter(|o| !o.is_empty()) {
        Some(org) => format!("{base}/w/{}/weldhr/me/payroll", encode_uri_component(org)),
        None => format!("{base}/weldhr/me/payroll"),
    }
}

/// `languageOf(employer)`: a Dutch employer's payslip language, else English.
pub(crate) fn language_of(employer: &Value) -> &'static str {
    if employer["country"] == "NL" {
        return if employer["nlSettings"]["payslipLanguage"] == "en" {
            "en"
        } else {
            "nl"
        };
    }
    "en"
}

fn locale_of(lang: &str) -> EmailLocale {
    EmailLocale::resolve([Some(lang)])
}

/// What `payslipReady` needs.
pub(crate) struct PayslipReady {
    pub(crate) email: String,
    pub(crate) name: String,
    pub(crate) pay_date: String,
    pub(crate) employer_name: String,
    pub(crate) lang: &'static str,
}

/// Hand a rendered email to the transport; a failure is logged.
async fn deliver(
    state: &HrState,
    to: &str,
    rendered: Result<weldsuite_emails::RenderedEmail, weldsuite_emails::EmailError>,
    what: &str,
) {
    let Some(transport) = state.mail.as_deref() else {
        return;
    };
    let sent = match rendered {
        Ok(rendered) => send_system_email(
            transport,
            SystemEmail::to(rendered, EmailBrand::weldsuite("WeldHR"), to),
        )
        .await
        .map(|_| ())
        .map_err(|e| e.to_string()),
        Err(error) => Err(error.to_string()),
    };
    if let Err(error) = sent {
        tracing::warn!(%error, "[payroll] {what} email skipped");
    }
}

/// `notifier.payslipReady(args)`.
pub(crate) async fn payslip_ready(state: &HrState, url: &str, args: PayslipReady) {
    let props = hr::PayslipReady {
        recipient_name: Some(args.name),
        employer_name: args.employer_name,
        pay_date: args.pay_date,
        url: Some(url.to_owned()),
    };
    let rendered = hr::payslip_ready(
        locale_of(args.lang),
        &EmailBrand::weldsuite("WeldHR"),
        &props,
    );
    deliver(state, &args.email, rendered, "payslip").await;
}

/// `notifier.bankChanged(args)`: the change is now, shown in UTC (the
/// worker passes no time zone).
async fn bank_changed(
    state: &HrState,
    email: &str,
    name: &str,
    employer_name: &str,
    by_employee: bool,
    lang: &str,
) {
    let props = hr::BankChanged {
        recipient_name: Some(name.to_owned()),
        employer_name: employer_name.to_owned(),
        by_employee,
        changed_at: crate::now(),
        time_zone: None,
    };
    let rendered = hr::bank_changed(locale_of(lang), &EmailBrand::weldsuite("WeldHR"), &props);
    deliver(state, email, rendered, "bank change").await;
}

async fn bank_change_task(
    state: &HrState,
    db: &PgPool,
    employee_id: &str,
    by_employee: bool,
) -> Result<(), sqlx::Error> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "select email, first_name, last_name from hr_employees where id = $1 limit 1",
    )
    .bind(employee_id)
    .fetch_optional(db)
    .await?;
    let Some((email, first, last)) = row else {
        return Ok(());
    };
    let employer: Option<Value> = sqlx::query_scalar(
        "select jsonb_build_object('name', e.name, 'country', e.country, 'nlSettings', e.nl_settings)
         from hr_payroll_profiles p join hr_payroll_employers e on e.id = p.employer_id
         where p.employee_id = $1 limit 1",
    )
    .bind(employee_id)
    .fetch_optional(db)
    .await?;
    let employer = employer.map(js_row);
    let name = format!("{first} {last}");
    let employer_name = employer
        .as_ref()
        .and_then(|e| e["name"].as_str())
        .unwrap_or("")
        .to_owned();
    let lang = employer.as_ref().map_or("en", language_of);
    bank_changed(
        state,
        &email,
        name.trim(),
        &employer_name,
        by_employee,
        lang,
    )
    .await;
    Ok(())
}

/// `notifyBankChange(c, employeeId, byEmployee)`: tell the employee their
/// bank details changed, after the response is on its way. Best effort.
pub(crate) fn notify_bank_change(
    state: &HrState,
    caller: &Caller,
    employee_id: &str,
    by_employee: bool,
) {
    if state.mail.is_none() {
        return;
    }
    let state_for_task = state.clone();
    let db = caller.db.clone();
    let employee_id = employee_id.to_owned();
    state.events.tracker().spawn(async move {
        if let Err(error) = bank_change_task(&state_for_task, &db, &employee_id, by_employee).await
        {
            tracing::error!(%error, "[payroll] bank change notification failed");
        }
    });
}
