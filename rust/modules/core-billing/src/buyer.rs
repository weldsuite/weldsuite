//! The customer's billing details (Settings → Business, the tenant's
//! `workspace_settings`) and the VAT they lead to.
//!
//! Stripe Checkout collected an address itself; Mollie's hosted checkout
//! doesn't. A checkout is therefore refused until the details an invoice
//! needs are there: 400 `BILLING_DETAILS_REQUIRED`, which opens the
//! platform's billing-details dialog.

use serde_json::json;
use weldsuite_db::PgPool;
use weldsuite_kit::ApiError;
use weldsuite_ports::OutboundHttp;

use crate::Language;
use crate::vat::{VatCheck, VatDecision, decide, normalize_vat_number, vat_number_matches_country};

/// What an invoice needs to know about the customer.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingDetails {
    /// The legal name, else the trading or workspace name.
    pub name: String,
    pub email: Option<String>,
    pub address_line1: String,
    #[serde(default)]
    pub address_line2: Option<String>,
    pub postal_code: String,
    pub city: String,
    #[serde(default)]
    pub state: Option<String>,
    /// ISO 3166-1 alpha-2, upper case.
    pub country: String,
    /// Normalized (`NL123456789B01`), when given.
    pub vat_number: Option<String>,
    pub language: Option<String>,
}

impl BillingDetails {
    pub fn language(&self) -> Language {
        Language::parse(self.language.as_deref())
    }
}

/// The row as stored, before the checks.
#[derive(Debug, sqlx::FromRow)]
struct Row {
    legal_name: Option<String>,
    trading_name: Option<String>,
    email: Option<String>,
    address_line_1: Option<String>,
    address_line_2: Option<String>,
    city: Option<String>,
    state: Option<String>,
    postal_code: Option<String>,
    country: Option<String>,
    vat_number: Option<String>,
    language: Option<String>,
}

fn filled(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// The details, or the fields still missing (`legalName`, `addressLine1`,
/// `postalCode`, `city`, `country`).
pub(crate) async fn load(
    tenant: &PgPool,
    workspace_name: &str,
) -> Result<Result<BillingDetails, Vec<&'static str>>, sqlx::Error> {
    let row: Option<Row> = sqlx::query_as(
        "select legal_name, trading_name, email, address_line_1, address_line_2, city, state,
                postal_code, country, vat_number, language
         from workspace_settings where deleted_at is null order by created_at limit 1",
    )
    .fetch_optional(tenant)
    .await?;
    let Some(row) = row else {
        return Ok(Err(vec!["legalName", "addressLine1", "postalCode", "city", "country"]));
    };
    let mut missing = Vec::new();
    let name = filled(row.legal_name)
        .or_else(|| filled(row.trading_name))
        .or_else(|| filled(Some(workspace_name.to_owned())));
    if name.is_none() {
        missing.push("legalName");
    }
    let address = filled(row.address_line_1);
    if address.is_none() {
        missing.push("addressLine1");
    }
    let postal = filled(row.postal_code);
    if postal.is_none() {
        missing.push("postalCode");
    }
    let city = filled(row.city);
    if city.is_none() {
        missing.push("city");
    }
    let country = filled(row.country)
        .map(|c| c.to_ascii_uppercase())
        .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_uppercase()));
    if country.is_none() {
        missing.push("country");
    }
    match (name, address, postal, city, country) {
        (Some(name), Some(address_line1), Some(postal_code), Some(city), Some(country))
            if missing.is_empty() =>
        {
            Ok(Ok(BillingDetails {
                name,
                email: filled(row.email),
                address_line1,
                address_line2: filled(row.address_line_2),
                postal_code,
                city,
                state: filled(row.state),
                country,
                vat_number: filled(row.vat_number)
                    .and_then(|raw| normalize_vat_number(&raw).map(|(_, full)| full)),
                language: filled(row.language),
            }))
        }
        _ => Ok(Err(missing)),
    }
}

/// The 400 that opens the billing-details dialog.
pub(crate) fn details_required(missing: &[&'static str]) -> ApiError {
    ApiError::new(
        http::StatusCode::BAD_REQUEST,
        "BILLING_DETAILS_REQUIRED",
        "Add your billing details (company name, address and country) before you subscribe.",
    )
    .with_details(json!({ "missing": missing }))
}

/// What VIES says about the customer's VAT number. A number of another
/// country than the billing country is invalid; VIES being down leaves a
/// number with the right prefix valid (logged), so a checkout isn't refused
/// for an outage of the EU's service.
pub(crate) async fn check_vat(http: Option<&OutboundHttp>, details: &BillingDetails) -> VatCheck {
    let Some(number) = &details.vat_number else {
        return VatCheck::None;
    };
    let Some(normalized) = weldsuite_books_domain::vies::normalize_vat_number(number) else {
        return VatCheck::Invalid;
    };
    if !vat_number_matches_country(&normalized.country_code, &details.country) {
        return VatCheck::Invalid;
    }
    match weldsuite_books_domain::vies::consult_vies(http, &normalized).await {
        Ok((_, true)) => VatCheck::Valid,
        Ok((_, false)) => VatCheck::Invalid,
        Err(reason) => {
            tracing::warn!(%reason, vat = %normalized.full, "billing: VIES unavailable, the number's format is taken as valid");
            VatCheck::Valid
        }
    }
}

/// The VAT decision for `details`, sold by an entity in `seller_country`.
pub(crate) async fn vat_for(
    http: Option<&OutboundHttp>,
    seller_country: &str,
    details: &BillingDetails,
) -> VatDecision {
    let check = check_vat(http, details).await;
    decide(seller_country, &details.country, check)
}
