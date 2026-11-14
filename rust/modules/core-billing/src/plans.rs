//! The plans and their prices on the EU edition.
//!
//! Prices are the EU master's own `plans` rows, in EUR, excluding VAT
//! (`rust/deploy/hetzner/TEST-CLUSTER.md`, "Prices"; staff edit them on the
//! admin console's Plans page): `price_monthly` per seat per month on
//! monthly billing, `price_yearly` per seat per year (0: twelve months at the
//! monthly price). A paid plan priced at 0 is sold through sales ("On
//! request"). Global's per-country price list (BILL-007) is not read here
//! (ADR BILL-014, simpler first version). The amount is charged as is: there
//! are no price objects at Mollie.

use serde_json::{Value, json};
use sqlx::FromRow;
use weldsuite_db::PgPool;
use weldsuite_mollie::Money;

use crate::period::Cycle;

/// The currency plans are sold in: SEPA Direct Debit is EUR only, and a
/// plan priced in another currency is refused, never converted.
pub(crate) const CURRENCY: &str = "EUR";

/// A `plans` row, numerics as text.
#[allow(clippy::struct_excessive_bools)] // the table's flags
#[derive(Debug, Clone, FromRow)]
pub(crate) struct Plan {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) slug: String,
    pub(crate) description: Option<String>,
    pub(crate) price_monthly: String,
    pub(crate) price_yearly: String,
    pub(crate) currency: String,
    pub(crate) included_users: Option<i32>,
    pub(crate) monthly_credits: Option<i32>,
    pub(crate) features: Option<Value>,
    pub(crate) max_users: Option<i32>,
    pub(crate) max_custom_domains: Option<i32>,
    pub(crate) remove_branding: bool,
    pub(crate) is_active: bool,
    pub(crate) is_default: bool,
    pub(crate) has_api_access: bool,
    pub(crate) sort_order: i32,
    pub(crate) badge: Option<String>,
}

macro_rules! columns {
    () => {
        "id, name, slug, description, price_monthly::text as price_monthly,
    price_yearly::text as price_yearly, currency,
    included_users, monthly_credits, features, max_users, max_custom_domains, remove_branding,
    is_active, is_default, has_api_access, sort_order, badge"
    };
}

fn cents(text: &str) -> i64 {
    Money::parse(CURRENCY, text).map_or(0, |money| money.cents)
}

impl Plan {
    pub(crate) async fn load(master: &PgPool, id: &str) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as(concat!("select ", columns!(), " from plans where id = $1 limit 1"))
        .bind(id)
        .fetch_optional(master)
        .await
    }

    /// The Free plan new workspaces start on (`slug = 'free'`).
    pub(crate) async fn free(master: &PgPool) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as(concat!("select ", columns!(), " from plans where slug = 'free' and deleted_at is null limit 1"))
        .fetch_optional(master)
        .await
    }

    /// Active plans in ladder order (Free included).
    pub(crate) async fn active(master: &PgPool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as(concat!("select ", columns!(), " from plans where is_active and deleted_at is null order by sort_order"))
        .fetch_all(master)
        .await
    }

    pub(crate) fn is_free(&self) -> bool {
        self.slug == "free"
    }

    /// Per seat per month, cents.
    pub(crate) fn monthly_cents(&self) -> i64 {
        cents(&self.price_monthly)
    }

    /// Per seat per year, cents: `price_yearly`, else twelve months.
    pub(crate) fn yearly_cents(&self) -> i64 {
        match cents(&self.price_yearly) {
            0 => self.monthly_cents() * 12,
            yearly => yearly,
        }
    }

    /// The seat price for `cycle`, in cents before VAT, when this plan is
    /// sold by checkout: in EUR and priced.
    pub(crate) fn unit_amount(&self, cycle: Cycle) -> Option<i64> {
        if self.is_free() || !self.currency.eq_ignore_ascii_case(CURRENCY) {
            return None;
        }
        let amount = match cycle {
            Cycle::Monthly => self.monthly_cents(),
            Cycle::Yearly => self.yearly_cents(),
        };
        (amount > 0).then_some(amount)
    }

    /// Sold through sales: a paid plan without a price.
    pub(crate) fn on_request(&self) -> bool {
        !self.is_free() && self.monthly_cents() == 0
    }

    pub(crate) fn features(&self) -> Value {
        self.features.clone().unwrap_or_else(|| json!({}))
    }

    /// `GET /plans` row (app-api's shape).
    pub(crate) fn list_json(&self) -> Value {
        let on_request = self.on_request();
        let money = |cents: i64| format!("{}.{:02}", cents / 100, cents % 100);
        json!({
            "id": self.id,
            "name": self.name,
            "slug": self.slug,
            "description": self.description,
            "priceMonthly": if on_request { Value::Null } else { json!(money(self.monthly_cents())) },
            "priceYearly": if on_request { Value::Null } else { json!(money(self.yearly_cents())) },
            "currency": self.currency,
            "pricePerUser": if on_request || self.is_free() { Value::Null } else { json!(money(self.monthly_cents())) },
            "priceOnRequest": on_request,
            "includedUsers": self.included_users,
            "maxUsers": self.max_users,
            "features": self.features(),
            "monthlyCredits": self.monthly_credits,
            "isDefault": self.is_default,
            "hasApiAccess": self.has_api_access,
            "badge": self.badge,
            "sortOrder": self.sort_order,
            "stripePriceIdMonthly": Value::Null,
            "stripePriceIdYearly": Value::Null,
            "partnerManaged": Value::Null,
        })
    }

    /// `GET /plans-page` row (app-api's shape, prices in cents).
    pub(crate) fn page_json(&self) -> Value {
        let features = self.features();
        let on_request = self.on_request();
        let (monthly, yearly) = if on_request {
            (0, 0)
        } else {
            (self.monthly_cents(), self.yearly_cents())
        };
        let flag = |key: &str| features.get(key).and_then(Value::as_bool).unwrap_or(false);
        let number = |key: &str| features.get(key).cloned().unwrap_or(Value::Null);
        json!({
            "id": self.id,
            "name": self.name,
            "slug": self.slug,
            "description": self.description,
            "monthlyPrice": monthly,
            "yearlyPrice": yearly,
            "currency": self.currency,
            "pricePerSeat": if self.is_free() { 0 } else { monthly },
            "priceOnRequest": on_request,
            "isPerSeatPricing": !self.is_free(),
            "includedUsers": self.included_users,
            "maxMembers": self.max_users,
            "emailsPerMonth": features.get("emailsPerMonth").and_then(Value::as_i64).unwrap_or(0),
            "aiCreditsPerMonth": features.get("aiCreditsPerMonth").and_then(Value::as_i64).unwrap_or(0),
            "monthlyCredits": self.monthly_credits,
            "isDefault": self.is_default,
            "isActive": self.is_active,
            "hasApiAccess": self.has_api_access,
            "badge": self.badge,
            "displayOrder": self.sort_order,
            "highlighted": self.slug == "scale" || self.slug == "business" || self.badge.is_some(),
            "requiresContact": on_request,
            "maxDomains": number("maxDomains"),
            "maxEmailAccounts": number("maxEmailAccounts"),
            "maxCustomDomains": self.max_custom_domains.map_or_else(|| number("maxCustomDomains"), |n| json!(n)),
            "taskExecutions": number("taskExecutions"),
            "removeBranding": self.remove_branding || flag("removeBranding"),
            "prioritySupport": flag("prioritySupport"),
            "customEmailDomain": flag("customEmailDomain"),
            "sso": flag("sso"),
            "customIntegrations": flag("customIntegrations"),
            "stripePriceIdMonthly": Value::Null,
            "stripePriceIdYearly": Value::Null,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(slug: &str, monthly: &str, yearly: &str, currency: &str) -> Plan {
        Plan {
            id: format!("plan_{slug}"),
            name: slug.to_owned(),
            slug: slug.to_owned(),
            description: None,
            price_monthly: monthly.to_owned(),
            price_yearly: yearly.to_owned(),
            currency: currency.to_owned(),
            included_users: Some(0),
            monthly_credits: Some(0),
            features: None,
            max_users: None,
            max_custom_domains: None,
            remove_branding: false,
            is_active: true,
            is_default: false,
            has_api_access: false,
            sort_order: 1,
            badge: None,
        }
    }

    #[test]
    fn eu_prices_follow_the_rows() {
        // Starter: €12 a month, €120 a year (TEST-CLUSTER.md).
        let starter = plan("starter", "12.00", "120.00", "EUR");
        assert_eq!(starter.unit_amount(Cycle::Monthly), Some(1200));
        assert_eq!(starter.unit_amount(Cycle::Yearly), Some(12_000));
        // No annual price: twelve months.
        let business = plan("business", "25.00", "0", "EUR");
        assert_eq!(business.unit_amount(Cycle::Yearly), Some(30_000));
        // Free, on request and other currencies are never checked out.
        assert_eq!(plan("free", "0", "0", "EUR").unit_amount(Cycle::Monthly), None);
        let enterprise = plan("enterprise", "0", "0", "EUR");
        assert!(enterprise.on_request());
        assert_eq!(enterprise.unit_amount(Cycle::Monthly), None);
        assert_eq!(plan("pro", "25.00", "0", "USD").unit_amount(Cycle::Monthly), None);
        assert_eq!(starter.page_json()["monthlyPrice"], 1200);
        assert_eq!(enterprise.page_json()["requiresContact"], true);
        assert_eq!(starter.list_json()["priceYearly"], "120.00");
    }
}
