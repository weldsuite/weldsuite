//! WeldReach's access decisions (`packages/core/emails/src/templates/reach/`):
//! staff approved or rejected a workspace's request for WeldReach. Sent by
//! `weldsuite admin access` (ADR SEC-014), as the admin console sends them on
//! Global (`apps/web/admin/lib/app-access-email.ts`).

use std::collections::BTreeMap;

use minijinja::Value;

use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, render};

/// `ReachAccessApprovedEmailProps['limits']`: the limits staff set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApprovedLimits {
    pub max_domains: i64,
    pub max_mailboxes: i64,
    pub max_daily_sends: i64,
}

/// `ReachAccessApprovedEmailProps`.
#[derive(Debug, Clone, Default)]
pub struct AccessApproved {
    pub recipient_name: Option<String>,
    pub workspace_name: String,
    /// Where WeldReach opens, e.g. `https://app.weldsuite.org/weldreach`.
    pub url: String,
    /// Without them the email leaves out the sentence about the limits.
    pub limits: Option<ApprovedLimits>,
}

/// `ReachAccessRejectedEmailProps`.
#[derive(Debug, Clone, Default)]
pub struct AccessRejected {
    pub recipient_name: Option<String>,
    pub workspace_name: String,
    /// Why, as the reviewer wrote it.
    pub reason: String,
    /// The app store page of WeldReach, where the request can be filed again.
    /// Without one the email has no button.
    pub url: Option<String>,
}

/// `n.toLocaleString(intlLocale(locale))` for a whole number: digits grouped
/// by three, with `,` in en-US and `.` in nl-NL.
pub fn format_count(n: i64, locale: EmailLocale) -> String {
    let separator = match locale {
        EmailLocale::En => ',',
        EmailLocale::Nl => '.',
    };
    let digits = n.unsigned_abs().to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if n < 0 {
        grouped.push('-');
    }
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(separator);
        }
        grouped.push(digit);
    }
    grouped
}

/// `props.recipientName?.trim()`, when not empty.
fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

pub fn access_approved(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &AccessApproved,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    values.insert(
        "workspace_name".to_owned(),
        Value::from(props.workspace_name.as_str()),
    );
    values.insert("url".to_owned(), Value::from(props.url.as_str()));
    if let Some(name) = trimmed(props.recipient_name.as_deref()) {
        flags.push("name");
        values.insert("recipient_name".to_owned(), Value::from(name));
    }
    if let Some(limits) = props.limits {
        flags.push("limits");
        for (key, n) in [
            ("domains", limits.max_domains),
            ("mailboxes", limits.max_mailboxes),
            ("sends", limits.max_daily_sends),
        ] {
            values.insert(key.to_owned(), Value::from(format_count(n, locale)));
        }
    }
    render("reach.access-approved", locale, brand, &flags, values)
}

pub fn access_rejected(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &AccessRejected,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    values.insert(
        "workspace_name".to_owned(),
        Value::from(props.workspace_name.as_str()),
    );
    // `props.reason.trim()`
    values.insert("reason".to_owned(), Value::from(props.reason.trim()));
    if let Some(name) = trimmed(props.recipient_name.as_deref()) {
        flags.push("name");
        values.insert("recipient_name".to_owned(), Value::from(name));
    }
    // `props.url?.trim() || undefined`
    if let Some(url) = trimmed(props.url.as_deref()) {
        flags.push("url");
        values.insert("url".to_owned(), Value::from(url));
    }
    render("reach.access-rejected", locale, brand, &flags, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_are_grouped_per_locale() {
        assert_eq!(format_count(300, EmailLocale::En), "300");
        assert_eq!(format_count(1000, EmailLocale::En), "1,000");
        assert_eq!(format_count(1_000_000, EmailLocale::En), "1,000,000");
        assert_eq!(format_count(12_345, EmailLocale::Nl), "12.345");
        assert_eq!(format_count(0, EmailLocale::Nl), "0");
    }
}
