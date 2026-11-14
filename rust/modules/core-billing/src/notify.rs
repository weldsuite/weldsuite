//! The billing owners' emails (ADR BILL-014, dunning): a charge failed (with
//! a pay link), a reminder halfway through the grace period, and the plan
//! ended. The binary sends them as system mail through the EU MTA
//! (`BillingMailer`); without a mailer they are logged and skipped.
//!
//! The billing owners are the workspace's billing email (Settings →
//! Business) and its organization admins.

use std::collections::BTreeSet;

use weldsuite_db::PgPool;
use weldsuite_ports::BoxFuture;

use crate::Language;

/// Which email.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BillingMailKind {
    /// A charge failed: pay within the grace period.
    PaymentFailed,
    /// Halfway through the grace period, still unpaid.
    PaymentReminder,
    /// The grace period ran out: the workspace is on Free.
    PlanEnded,
}

impl BillingMailKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PaymentFailed => "billing.payment-failed",
            Self::PaymentReminder => "billing.payment-reminder",
            Self::PlanEnded => "billing.plan-ended",
        }
    }
}

/// One email to the billing owners.
#[derive(Debug, Clone)]
pub struct BillingMail {
    pub kind: BillingMailKind,
    pub workspace_id: String,
    pub workspace_name: String,
    pub recipients: Vec<String>,
    pub language: Language,
    pub plan_name: String,
    /// The open amount, formatted (`€ 123,45`).
    pub amount: Option<String>,
    pub pay_url: Option<String>,
    /// When the plan ends if unpaid (`14 november 2026`).
    pub ends_on: Option<String>,
    /// The billing page.
    pub billing_url: String,
}

/// Sends billing emails (the binary's system mail).
pub trait BillingMailer: Send + Sync {
    fn send<'a>(&'a self, mail: &'a BillingMail) -> BoxFuture<'a, Result<(), String>>;
}

/// The billing owners' addresses.
pub(crate) async fn recipients(
    master: &PgPool,
    workspace_id: &str,
    billing_email: Option<&str>,
) -> Result<Vec<String>, sqlx::Error> {
    let admins: Vec<String> = sqlx::query_scalar(
        "select u.email from user_workspaces uw join users u on u.id = uw.user_id
         where uw.workspace_id = $1 and uw.status = 'ACTIVE' and uw.role = 'org:admin'
           and u.email is not null and u.email <> ''",
    )
    .bind(workspace_id)
    .fetch_all(master)
    .await?;
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for email in billing_email.into_iter().map(str::to_owned).chain(admins) {
        let key = email.trim().to_ascii_lowercase();
        if key.contains('@') && seen.insert(key) {
            out.push(email.trim().to_owned());
        }
    }
    Ok(out)
}

/// `€ 1.234,56` (Dutch) or `€1,234.56` (English).
pub(crate) fn money_text(cents: i64, currency: &str, language: Language) -> String {
    let symbol = if currency.eq_ignore_ascii_case("EUR") { "€" } else { currency };
    let whole = (cents / 100).to_string();
    let mut grouped = String::new();
    let (group, decimal) = match language {
        Language::Nl => ('.', ','),
        Language::En => (',', '.'),
    };
    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index).is_multiple_of(3) {
            grouped.push(group);
        }
        grouped.push(digit);
    }
    let fraction = cents.rem_euclid(100);
    match language {
        Language::Nl => format!("{symbol} {grouped}{decimal}{fraction:02}"),
        Language::En => format!("{symbol}{grouped}{decimal}{fraction:02}"),
    }
}

/// `14 november 2026` / `14 November 2026`.
pub(crate) fn date_text(at: time::OffsetDateTime, language: Language) -> String {
    const EN: [&str; 12] = [
        "January", "February", "March", "April", "May", "June", "July", "August", "September",
        "October", "November", "December",
    ];
    const NL: [&str; 12] = [
        "januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september",
        "oktober", "november", "december",
    ];
    let month = usize::from(u8::from(at.month())) - 1;
    let name = match language {
        Language::Nl => NL[month],
        Language::En => EN[month],
    };
    format!("{} {name} {}", at.day(), at.year())
}

/// Sends `mail` when a mailer is configured; a failure is logged.
pub(crate) async fn send(mailer: Option<&std::sync::Arc<dyn BillingMailer>>, mail: &BillingMail) {
    if mail.recipients.is_empty() {
        tracing::warn!(workspace = %mail.workspace_id, kind = mail.kind.as_str(), "billing: no billing owner to email");
        return;
    }
    let Some(mailer) = mailer else {
        tracing::warn!(workspace = %mail.workspace_id, kind = mail.kind.as_str(), "billing: no mailer, email skipped");
        return;
    };
    if let Err(error) = mailer.send(mail).await {
        tracing::error!(%error, workspace = %mail.workspace_id, kind = mail.kind.as_str(), "billing: email not sent");
    }
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    #[test]
    fn amounts_and_dates_read_per_language() {
        assert_eq!(money_text(123_456, "EUR", Language::Nl), "€ 1.234,56");
        assert_eq!(money_text(123_456, "EUR", Language::En), "€1,234.56");
        assert_eq!(money_text(5, "EUR", Language::En), "€0.05");
        let at = datetime!(2026-11-28 10:00:00 UTC);
        assert_eq!(date_text(at, Language::Nl), "28 november 2026");
        assert_eq!(date_text(at, Language::En), "28 November 2026");
    }
}
