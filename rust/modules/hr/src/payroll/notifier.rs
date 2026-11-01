//! Payroll emails to employees (`services/weldhr/payroll/notifier.ts`), best
//! effort: without a transport (no `SEND_EMAIL`) nothing is sent, and a
//! failed send is logged, never raised. Neither mail carries pay figures or
//! account numbers.
//!
//! - `hr.payslip-ready`: a payslip was published (on approval, to employees
//!   linked to a workspace member), with a link to My HR → Payroll.
//! - `hr.bank-changed`: the salary account changed, whoever changed it.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde_json::Value;
use weldsuite_db::{PgPool, js_row};
use weldsuite_emails::{EmailBrand, EmailLocale, SystemEmail, format_date, format_time, render, send_system_email};

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
    let app_url = caller.env("APP_URL").map(|u| u.trim().to_owned()).filter(|u| !u.is_empty());
    let base = app_url.unwrap_or_else(|| platform_url(caller.env("ENVIRONMENT").as_deref()).to_owned());
    let base = base.trim().trim_end_matches('/');
    match caller.org_id.as_deref().filter(|o| !o.is_empty()) {
        Some(org) => format!("{base}/w/{}/weldhr/me/payroll", encode_uri_component(org)),
        None => format!("{base}/weldhr/me/payroll"),
    }
}

/// `languageOf(employer)`: a Dutch employer's payslip language, else English.
pub(crate) fn language_of(employer: &Value) -> &'static str {
    if employer["country"] == "NL" {
        return if employer["nlSettings"]["payslipLanguage"] == "en" { "en" } else { "nl" };
    }
    "en"
}

fn locale_of(lang: &str) -> EmailLocale {
    EmailLocale::resolve([Some(lang)])
}

fn name_vars(name: &str) -> (bool, Option<String>) {
    let trimmed = name.trim();
    (!trimmed.is_empty(), (!trimmed.is_empty()).then(|| trimmed.to_owned()))
}

/// What `payslipReady` needs.
pub(crate) struct PayslipReady {
    pub(crate) email: String,
    pub(crate) name: String,
    pub(crate) pay_date: String,
    pub(crate) employer_name: String,
    pub(crate) lang: &'static str,
}

/// `notifier.payslipReady(args)`.
pub(crate) async fn payslip_ready(state: &HrState, url: &str, args: PayslipReady) {
    let Some(transport) = state.mail.as_deref() else {
        return;
    };
    let locale = locale_of(args.lang);
    let (has_name, name) = name_vars(&args.name);
    let url = url.trim();
    let mut flags = vec![];
    if has_name {
        flags.push("name");
    }
    if !url.is_empty() {
        flags.push("url");
    }
    let rendered = format_date(&format!("{}T12:00:00Z", args.pay_date), locale, "UTC").and_then(|date| {
        let mut vars = BTreeMap::new();
        vars.insert("recipient_name".to_owned(), name.unwrap_or_default().into());
        vars.insert("employer_name".to_owned(), args.employer_name.clone().into());
        vars.insert("pay_date".to_owned(), date.into());
        vars.insert("url".to_owned(), url.to_owned().into());
        render("hr.payslip-ready", locale, &EmailBrand::weldsuite("WeldHR"), &flags, vars)
    });
    let sent = match rendered {
        Ok(rendered) => send_system_email(transport, SystemEmail::to(rendered, EmailBrand::weldsuite("WeldHR"), &args.email))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Err(error) => Err(error.to_string()),
    };
    if let Err(error) = sent {
        tracing::warn!(%error, "[payroll] payslip email skipped");
    }
}

/// `notifier.bankChanged(args)`.
async fn bank_changed(state: &HrState, email: &str, name: &str, employer_name: &str, by_employee: bool, lang: &str) {
    let Some(transport) = state.mail.as_deref() else {
        return;
    };
    let locale = locale_of(lang);
    let (has_name, name) = name_vars(name);
    let mut flags = vec![];
    if has_name {
        flags.push("name");
    }
    if by_employee {
        flags.push("by_employee");
    }
    let now = time::OffsetDateTime::now_utc();
    let millis = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or_default();
    let iso = weldsuite_events::iso_timestamp(now);
    let when = format_date(&iso, locale, "UTC")
        .and_then(|date| format_time(millis, locale, "UTC", true).map(|time| format!("{date}, {time}")));
    let rendered = when.and_then(|when| {
        let mut vars = BTreeMap::new();
        vars.insert("recipient_name".to_owned(), name.unwrap_or_default().into());
        vars.insert("employer_name".to_owned(), employer_name.to_owned().into());
        vars.insert("when".to_owned(), when.into());
        render("hr.bank-changed", locale, &EmailBrand::weldsuite("WeldHR"), &flags, vars)
    });
    let sent = match rendered {
        Ok(rendered) => send_system_email(transport, SystemEmail::to(rendered, EmailBrand::weldsuite("WeldHR"), email))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Err(error) => Err(error.to_string()),
    };
    if let Err(error) = sent {
        tracing::warn!(%error, "[payroll] bank change email skipped");
    }
}

async fn bank_change_task(state: &HrState, db: &PgPool, employee_id: &str, by_employee: bool) -> Result<(), sqlx::Error> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("select email, first_name, last_name from hr_employees where id = $1 limit 1")
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
    let employer_name = employer.as_ref().and_then(|e| e["name"].as_str()).unwrap_or("").to_owned();
    let lang = employer.as_ref().map_or("en", language_of);
    bank_changed(state, &email, name.trim(), &employer_name, by_employee, lang).await;
    Ok(())
}

/// `notifyBankChange(c, employeeId, byEmployee)`: tell the employee their
/// bank details changed, after the response is on its way. Best effort.
pub(crate) fn notify_bank_change(state: &HrState, caller: &Caller, employee_id: &str, by_employee: bool) {
    if state.mail.is_none() {
        return;
    }
    let state_for_task = state.clone();
    let db = caller.db.clone();
    let employee_id = employee_id.to_owned();
    state.events.tracker().spawn(async move {
        if let Err(error) = bank_change_task(&state_for_task, &db, &employee_id, by_employee).await {
            tracing::error!(%error, "[payroll] bank change notification failed");
        }
    });
}
