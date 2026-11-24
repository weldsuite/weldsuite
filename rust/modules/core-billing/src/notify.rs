//! The billing owners' emails (ADR BILL-014): dunning (a charge failed, with
//! a pay link; a reminder halfway through the grace period; the plan ended),
//! the notice before the renewal of a plan without a payment method, and the
//! invoice of every paid charge (decision 5). The binary sends them
//! as system mail through the EU MTA (`BillingMailer`); without a mailer a
//! dunning email is logged and skipped, and an invoice email waits for one.
//!
//! The billing owners are the workspace's billing email (Settings →
//! Business) and its organization admins.

use std::collections::BTreeSet;

use sea_orm::{ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect};
use weldsuite_db::{PgPool, orm};
use weldsuite_ports::BoxFuture;
use weldsuite_schema::master::enums::MembershipStatus;
use weldsuite_schema::master::{user_workspaces, users};

use crate::{Language, Treatment};

/// Which email.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BillingMailKind {
    /// A charge failed: pay within the grace period.
    PaymentFailed,
    /// Halfway through the grace period, still unpaid.
    PaymentReminder,
    /// The grace period ran out: the workspace is on Free.
    PlanEnded,
    /// The plan renews soon and there is no payment method to charge: add
    /// one before the renewal (`ends_on`) to keep the plan.
    PaymentMethodNeeded,
}

impl BillingMailKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PaymentFailed => "billing.payment-failed",
            Self::PaymentReminder => "billing.payment-reminder",
            Self::PlanEnded => "billing.plan-ended",
            Self::PaymentMethodNeeded => "billing.payment-method-needed",
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
    /// When the plan ends if unpaid (`14 november 2026`); for
    /// [`BillingMailKind::PaymentMethodNeeded`], the renewal.
    pub ends_on: Option<String>,
    /// The billing page.
    pub billing_url: String,
    /// No payment method on file: a failed charge and its reminder ask for
    /// one (paying the open amount saves it) instead of saying a payment was
    /// refused.
    pub no_method: bool,
}

/// The invoice of a paid charge, to the billing owners: sent once per
/// invoice, right after it is issued.
#[derive(Debug, Clone)]
pub struct InvoiceMail {
    pub workspace_id: String,
    pub workspace_name: String,
    pub recipients: Vec<String>,
    pub language: Language,
    /// The invoice number in the issuer's books (`INV-0001`).
    pub number: String,
    /// The invoice date, formatted (`19 november 2026`).
    pub date: String,
    /// What was paid, VAT included, formatted (`€ 90,75`).
    pub amount: String,
    pub treatment: Treatment,
    /// The VAT on it, formatted (`€ 15,75`).
    pub tax: String,
    /// Its rate without the sign, formatted (`21`, `25,5`).
    pub rate: String,
    /// The billing page, where the invoice opens.
    pub billing_url: String,
}

/// Sends billing emails (the binary's system mail).
pub trait BillingMailer: Send + Sync {
    fn send<'a>(&'a self, mail: &'a BillingMail) -> BoxFuture<'a, Result<(), String>>;

    /// Sends the invoice email to each recipient. `Err` only when none of
    /// them took it, so it can be tried again without anyone getting it
    /// twice; a recipient refused among others is the mailer's to log.
    fn send_invoice<'a>(&'a self, mail: &'a InvoiceMail) -> BoxFuture<'a, Result<(), String>>;
}

/// The billing owners' addresses.
pub(crate) async fn recipients(
    master: &PgPool,
    workspace_id: &str,
    billing_email: Option<&str>,
) -> Result<Vec<String>, DbErr> {
    let admins: Vec<String> = user_workspaces::Entity::find()
        .select_only()
        .column(users::Column::Email)
        .join(
            JoinType::InnerJoin,
            user_workspaces::Entity::belongs_to(users::Entity)
                .from(user_workspaces::Column::UserId)
                .to(users::Column::Id)
                .into(),
        )
        .filter(user_workspaces::Column::WorkspaceId.eq(workspace_id))
        .filter(user_workspaces::Column::Status.eq(MembershipStatus::ACTIVE))
        .filter(user_workspaces::Column::Role.eq("org:admin"))
        .filter(users::Column::Email.is_not_null())
        .filter(users::Column::Email.ne(""))
        .into_tuple()
        .all(&orm(master))
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
    let symbol = if currency.eq_ignore_ascii_case("EUR") {
        "€"
    } else {
        currency
    };
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

/// A VAT rate without the sign: `21`, `25,5` (Dutch) or `25.5` (English).
pub(crate) fn rate_text(rate_bps: u32, language: Language) -> String {
    let text = crate::vat::rate_text(rate_bps);
    match language {
        Language::Nl => text.replace('.', ","),
        Language::En => text,
    }
}

/// `14 november 2026` / `14 November 2026`.
pub(crate) fn date_text(at: time::OffsetDateTime, language: Language) -> String {
    const EN: [&str; 12] = [
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
    const NL: [&str; 12] = [
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
        assert_eq!(rate_text(2100, Language::Nl), "21");
        assert_eq!(rate_text(2550, Language::Nl), "25,5");
        assert_eq!(rate_text(2550, Language::En), "25.5");
        let at = datetime!(2026-11-28 10:00:00 UTC);
        assert_eq!(date_text(at, Language::Nl), "28 november 2026");
        assert_eq!(date_text(at, Language::En), "28 November 2026");
    }
}
