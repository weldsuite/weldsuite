//! The plan billing email of the EU edition (`packages/core/emails/src/templates/billing/`,
//! ADR BILL-014): a failed charge, the reminder halfway through the grace
//! period, and the plan ending on Free. The function takes the template's
//! props, picks the variant its React component would render and fills it in.

use std::collections::BTreeMap;

use minijinja::Value;

use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, render};

/// `BillingDunningKind`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum DunningKind {
    /// The charge failed: pay with the link before the plan ends.
    #[default]
    Failed,
    /// Halfway through the grace period, still unpaid.
    Reminder,
    /// The grace period ran out: the workspace is on Free.
    Ended,
}

/// `BillingDunningEmailProps`. Sent to the workspace's billing owners.
#[derive(Debug, Clone, Default)]
pub struct Dunning {
    pub kind: DunningKind,
    pub workspace_name: String,
    pub plan_name: String,
    /// The open amount, formatted (`€ 123,45`).
    pub amount: String,
    /// When the plan ends if unpaid, formatted (`28 november 2026`).
    pub ends_on: String,
    /// The pay link, or the billing page once the plan ended.
    pub url: String,
}

/// Renders `billing.dunning`.
///
/// # Errors
///
/// [`EmailError`] when the exported template cannot be rendered.
pub fn dunning(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &Dunning,
) -> Result<RenderedEmail, EmailError> {
    let flags: &[&str] = match props.kind {
        DunningKind::Failed => &[],
        DunningKind::Reminder => &["reminder"],
        DunningKind::Ended => &["ended"],
    };
    let mut values = BTreeMap::new();
    for (key, value) in [
        ("workspace_name", props.workspace_name.as_str()),
        ("plan_name", props.plan_name.as_str()),
        ("amount", props.amount.as_str()),
        ("ends_on", props.ends_on.as_str()),
        ("url", props.url.as_str()),
    ] {
        values.insert(key.to_owned(), Value::from(value));
    }
    render("billing.dunning", locale, brand, flags, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn props(kind: DunningKind) -> Dunning {
        Dunning {
            kind,
            workspace_name: "Acme <Studio>".to_owned(),
            plan_name: "Business".to_owned(),
            amount: "€ 90,75".to_owned(),
            ends_on: "28 november 2026".to_owned(),
            url: "https://app.weldsuite.eu/public/billing/pay/t".to_owned(),
        }
    }

    #[test]
    fn every_variant_renders_in_both_languages() {
        let brand = EmailBrand::weldsuite("WeldSuite");
        for kind in [
            DunningKind::Failed,
            DunningKind::Reminder,
            DunningKind::Ended,
        ] {
            for locale in [EmailLocale::En, EmailLocale::Nl] {
                let email = dunning(locale, &brand, &props(kind)).expect("renders");
                assert!(email.subject.contains("Acme <Studio>"), "{}", email.subject);
                assert!(email.html.contains("Acme &lt;Studio&gt;"), "escaped");
                assert!(
                    email
                        .html
                        .contains("https://app.weldsuite.eu/public/billing/pay/t")
                );
                assert!(!email.html.contains("⟦"), "no sentinel left");
            }
        }
        let ended = dunning(EmailLocale::Nl, &brand, &props(DunningKind::Ended)).expect("renders");
        assert!(
            ended.subject.contains("gratis abonnement"),
            "{}",
            ended.subject
        );
    }
}
