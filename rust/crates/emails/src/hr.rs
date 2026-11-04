//! WeldHR's payroll emails (`packages/core/emails/src/templates/hr/`): each
//! function takes the template's props, picks the variant its React
//! component would render and fills it in. Neither carries pay figures or
//! account numbers.

use std::collections::BTreeMap;

use minijinja::Value;

use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, format_date, format_time, render};

/// `HrPayslipReadyEmailProps`: a payslip was published.
#[derive(Debug, Clone, Default)]
pub struct PayslipReady {
    pub recipient_name: Option<String>,
    pub employer_name: String,
    /// The pay date, `YYYY-MM-DD`.
    pub pay_date: String,
    /// Where to read it (My HR); without one the email only says it is ready.
    pub url: Option<String>,
}

pub fn payslip_ready(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &PayslipReady,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    values.insert(
        "employer_name".to_owned(),
        Value::from(props.employer_name.as_str()),
    );
    // `formatDate(`${payDate}T12:00:00Z`, locale, 'UTC')`
    let date = format_date(&format!("{}T12:00:00Z", props.pay_date), locale, "UTC")?;
    values.insert("pay_date".to_owned(), Value::from(date));
    // `props.recipientName?.trim()`
    if let Some(name) = props
        .recipient_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        flags.push("name");
        values.insert("recipient_name".to_owned(), Value::from(name));
    }
    // `props.url?.trim() || undefined`
    if let Some(url) = props
        .url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        flags.push("url");
        values.insert("url".to_owned(), Value::from(url));
    }
    render("hr.payslip-ready", locale, brand, &flags, values)
}

/// `HrBankChangedEmailProps`: the salary account was changed.
#[derive(Debug, Clone, Default)]
pub struct BankChanged {
    pub recipient_name: Option<String>,
    pub employer_name: String,
    /// The employee changed them (My HR), not HR.
    pub by_employee: bool,
    /// ISO time of the change.
    pub changed_at: String,
    pub time_zone: Option<String>,
}

pub fn bank_changed(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &BankChanged,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    values.insert(
        "employer_name".to_owned(),
        Value::from(props.employer_name.as_str()),
    );
    // `zoneOr(props.timeZone)`: a valid zone, else UTC.
    let zone = props
        .time_zone
        .as_deref()
        .filter(|z| !z.is_empty() && jiff::tz::TimeZone::get(z).is_ok())
        .unwrap_or("UTC");
    let millis = props
        .changed_at
        .parse::<jiff::Timestamp>()
        .map_err(|error| EmailError::Date(format!("{}: {error}", props.changed_at)))?
        .as_millisecond();
    let when = format!(
        "{}, {}",
        format_date(&props.changed_at, locale, zone)?,
        format_time(millis, locale, zone, true)?
    );
    values.insert("when".to_owned(), Value::from(when));
    if let Some(name) = props
        .recipient_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        flags.push("name");
        values.insert("recipient_name".to_owned(), Value::from(name));
    }
    if props.by_employee {
        flags.push("by_employee");
    }
    render("hr.bank-changed", locale, brand, &flags, values)
}
