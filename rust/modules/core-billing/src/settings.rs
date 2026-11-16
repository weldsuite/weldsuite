//! The settings that turn plan billing on (ADR BILL-014).
//!
//! | Setting | What it does |
//! |---|---|
//! | `BILLING_PROVIDER=mollie` | Turns plan billing on. Without it nothing here runs and `billing` stays in `/config.json`'s `unavailableFeatures`. |
//! | `MOLLIE_API_KEY`, `MOLLIE_API_URL`, `MOLLIE_WEBHOOK_URL` | BILL-013's: one key and one webhook for every Mollie payment. The webhook defaults to `<PUBLIC_API_URL or PUBLIC_URL>/api/webhooks/mollie`. |
//! | `BILLING_ISSUER_WORKSPACE_ID` | The workspace whose WeldBooks issues the invoices (WeldSuite B.V.'s own). |
//! | `BILLING_ISSUER_ENTITY_ID` | Its accounting entity; default: the workspace's first. |
//! | `BILLING_PAY_LINK_KEY` | Signs pay links (32 characters or more). |
//! | `BILLING_RETURN_URL` | Where checkouts return; default `<PUBLIC_APP_URL or PUBLIC_URL>/settings/billing`. |
//! | `BILLING_SELLER_COUNTRY` | The issuer entity's country, for VAT (default `NL`: WeldSuite B.V.). |
//! | `BILLING_GRACE_DAYS` | How long a past-due plan keeps working before it ends on Free (default 14). |
//!
//! `BILLING_PROVIDER=mollie` with anything missing is a start problem, so a
//! deployment never takes payments it can't confirm or invoice.

use crate::paylink::PayLinks;

/// Where the webhook is served (shared with BILL-013's top-up).
pub const WEBHOOK_PATH: &str = "/api/webhooks/mollie";

/// The default grace period of a past-due plan.
pub const DEFAULT_GRACE_DAYS: i64 = 14;

/// Plan billing's settings.
#[derive(Clone)]
pub struct BillingSettings {
    pub api_key: String,
    pub api_url: String,
    pub webhook_url: String,
    /// The billing page checkouts return to.
    pub return_url: String,
    /// The platform's origin: pay links and invoice links are under it.
    pub public_url: String,
    pub issuer_workspace_id: String,
    pub issuer_entity_id: Option<String>,
    pub pay_links: PayLinks,
    pub grace_days: i64,
    /// The seller's country (ISO alpha-2), which decides domestic VAT.
    pub seller_country: String,
}

impl std::fmt::Debug for BillingSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BillingSettings")
            .field("api_url", &self.api_url)
            .field("webhook_url", &self.webhook_url)
            .field("return_url", &self.return_url)
            .field("issuer_workspace_id", &self.issuer_workspace_id)
            .field("grace_days", &self.grace_days)
            .finish_non_exhaustive()
    }
}

fn first(lookup: &impl Fn(&str) -> Option<String>, names: &[&str]) -> Option<String> {
    names
        .iter()
        .filter_map(|name| lookup(name))
        .map(|value| value.trim().to_owned())
        .find(|value| !value.is_empty())
}

fn is_web_url(text: &str) -> bool {
    url::Url::parse(text).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

impl BillingSettings {
    /// `Ok(None)` without `BILLING_PROVIDER=mollie`; `Err` (a start problem)
    /// when it is set but something it needs is missing.
    pub fn from_lookup(lookup: &impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        match first(lookup, &["BILLING_PROVIDER"]).as_deref() {
            None => return Ok(None),
            Some("mollie") => {}
            Some(other) => {
                return Err(format!(
                    "BILLING_PROVIDER={other} is not supported (only mollie)"
                ));
            }
        }
        let mut problems = Vec::new();
        let api_key = first(lookup, &["MOLLIE_API_KEY"]).unwrap_or_else(|| {
            problems.push("MOLLIE_API_KEY");
            String::new()
        });
        let api_url = first(lookup, &["MOLLIE_API_URL"])
            .unwrap_or_else(|| weldsuite_mollie::DEFAULT_API_URL.to_owned());
        let public_url = first(lookup, &["PUBLIC_APP_URL", "PUBLIC_URL", "PLATFORM_URL"])
            .map(|url| url.trim_end_matches('/').to_owned());
        let webhook_url = first(lookup, &["MOLLIE_WEBHOOK_URL"]).or_else(|| {
            first(
                lookup,
                &["PUBLIC_API_URL", "APP_API_PUBLIC_URL", "PUBLIC_URL"],
            )
            .map(|origin| format!("{}{WEBHOOK_PATH}", origin.trim_end_matches('/')))
        });
        let return_url = first(lookup, &["BILLING_RETURN_URL"]).or_else(|| {
            public_url
                .as_ref()
                .map(|origin| format!("{origin}/settings/billing"))
        });
        let issuer = first(lookup, &["BILLING_ISSUER_WORKSPACE_ID"]);
        let pay_links = first(lookup, &["BILLING_PAY_LINK_KEY"])
            .as_deref()
            .and_then(PayLinks::new);
        let grace_days = match first(lookup, &["BILLING_GRACE_DAYS"]) {
            None => DEFAULT_GRACE_DAYS,
            Some(text) => match text.parse::<i64>() {
                Ok(days) if (1..=90).contains(&days) => days,
                _ => {
                    problems.push("BILLING_GRACE_DAYS (1 to 90)");
                    DEFAULT_GRACE_DAYS
                }
            },
        };
        let seller_country = first(lookup, &["BILLING_SELLER_COUNTRY"])
            .map_or_else(|| "NL".to_owned(), |c| c.to_ascii_uppercase());
        if seller_country.len() != 2 || !seller_country.bytes().all(|b| b.is_ascii_uppercase()) {
            problems.push("BILLING_SELLER_COUNTRY (ISO alpha-2)");
        }
        let urls_ok = [&webhook_url, &return_url, &public_url]
            .iter()
            .all(|url| url.as_deref().is_some_and(is_web_url))
            && is_web_url(&api_url);
        if !urls_ok {
            problems.push("MOLLIE_WEBHOOK_URL / BILLING_RETURN_URL / PUBLIC_URL (absolute URLs)");
        }
        if issuer.is_none() {
            problems.push("BILLING_ISSUER_WORKSPACE_ID");
        }
        if pay_links.is_none() {
            problems.push("BILLING_PAY_LINK_KEY (32 characters or more)");
        }
        if !problems.is_empty() {
            return Err(format!(
                "BILLING_PROVIDER=mollie needs {}",
                problems.join(", ")
            ));
        }
        match (webhook_url, return_url, public_url, issuer, pay_links) {
            (
                Some(webhook_url),
                Some(return_url),
                Some(public_url),
                Some(issuer),
                Some(pay_links),
            ) => Ok(Some(Self {
                api_key,
                api_url,
                webhook_url,
                return_url,
                public_url,
                issuer_workspace_id: issuer,
                issuer_entity_id: first(lookup, &["BILLING_ISSUER_ENTITY_ID"]),
                pay_links,
                grace_days,
                seller_country,
            })),
            _ => Err("BILLING_PROVIDER=mollie is not fully configured".to_owned()),
        }
    }

    /// Whether the environment turns plan billing on (the `billing`
    /// edition feature).
    pub fn configured(lookup: &impl Fn(&str) -> Option<String>) -> bool {
        matches!(Self::from_lookup(lookup), Ok(Some(_)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let vars: Vec<(String, String)> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name: &str| {
            vars.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    const FULL: &[(&str, &str)] = &[
        ("BILLING_PROVIDER", "mollie"),
        ("MOLLIE_API_KEY", "test_abc"),
        ("PUBLIC_URL", "https://app.weldsuite.eu/"),
        ("BILLING_ISSUER_WORKSPACE_ID", "ws_issuer"),
        ("BILLING_PAY_LINK_KEY", "0123456789abcdef0123456789abcdef"),
    ];

    #[test]
    fn off_without_the_provider_and_complete_with_it() {
        assert!(
            BillingSettings::from_lookup(&lookup(&[]))
                .expect("ok")
                .is_none()
        );
        let settings = BillingSettings::from_lookup(&lookup(FULL))
            .expect("valid")
            .expect("on");
        assert_eq!(
            settings.webhook_url,
            "https://app.weldsuite.eu/api/webhooks/mollie"
        );
        assert_eq!(
            settings.return_url,
            "https://app.weldsuite.eu/settings/billing"
        );
        assert_eq!(settings.public_url, "https://app.weldsuite.eu");
        assert_eq!(settings.grace_days, DEFAULT_GRACE_DAYS);
        assert!(
            !format!("{settings:?}").contains("test_abc"),
            "no key in logs"
        );
        assert!(BillingSettings::configured(&lookup(FULL)));
    }

    #[test]
    fn a_half_configured_provider_stops_the_start() {
        let error = BillingSettings::from_lookup(&lookup(&[("BILLING_PROVIDER", "mollie")]))
            .expect_err("problems");
        assert!(error.contains("MOLLIE_API_KEY"), "{error}");
        assert!(error.contains("BILLING_ISSUER_WORKSPACE_ID"), "{error}");
        assert!(error.contains("BILLING_PAY_LINK_KEY"), "{error}");
        assert!(BillingSettings::from_lookup(&lookup(&[("BILLING_PROVIDER", "stripe")])).is_err());
        let mut short_key = FULL.to_vec();
        short_key[4] = ("BILLING_PAY_LINK_KEY", "short");
        assert!(BillingSettings::from_lookup(&lookup(&short_key)).is_err());
        let mut grace = FULL.to_vec();
        grace.push(("BILLING_GRACE_DAYS", "0"));
        assert!(BillingSettings::from_lookup(&lookup(&grace)).is_err());
    }
}
