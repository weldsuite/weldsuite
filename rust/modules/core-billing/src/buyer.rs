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
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
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
        return Ok(Err(vec![
            "legalName",
            "addressLine1",
            "postalCode",
            "city",
            "country",
        ]));
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
/// country than the billing country is invalid. While VIES can't be reached
/// the number counts as unchecked, so VAT is charged (domestic or OSS) rather
/// than reverse-charged on a number nobody verified: WeldSuite would owe that
/// VAT. The next charge checks it again.
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
            tracing::warn!(%reason, vat = %normalized.full, "billing: VIES unavailable, VAT is charged on this charge");
            VatCheck::Invalid
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

/// `GET /vat`: the billing details the next charge would use and the VAT
/// they lead to, so the checkout summary can show the VAT number and the
/// rate before the customer is sent to Mollie. The same decision a
/// checkout makes a moment later (`vat_for`); VIES is asked again then.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VatPreview {
    /// What a checkout would still refuse with `BILLING_DETAILS_REQUIRED`;
    /// empty when the details are complete.
    pub(crate) missing: Vec<&'static str>,
    pub(crate) country: Option<String>,
    pub(crate) vat_number: Option<String>,
    /// `none` (no number), `valid` (VIES accepts it) or `invalid` (VIES
    /// rejects it, it belongs to another country than the billing address,
    /// or VIES couldn't be asked: VAT is charged in each case).
    pub(crate) vat_number_status: &'static str,
    /// Null until the details are complete.
    pub(crate) vat: Option<VatDecision>,
}

/// The preview for loaded details (`load`) and what VIES said (`check_vat`).
pub(crate) fn preview(
    details: Result<BillingDetails, Vec<&'static str>>,
    seller_country: &str,
    check: VatCheck,
) -> VatPreview {
    match details {
        Err(missing) => VatPreview {
            missing,
            country: None,
            vat_number: None,
            vat_number_status: "none",
            vat: None,
        },
        Ok(details) => VatPreview {
            missing: Vec::new(),
            vat: Some(decide(seller_country, &details.country, check)),
            vat_number_status: match check {
                VatCheck::None => "none",
                VatCheck::Valid => "valid",
                VatCheck::Invalid => "invalid",
            },
            country: Some(details.country),
            vat_number: details.vat_number,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vat::Treatment;

    fn details(country: &str, vat_number: Option<&str>) -> BillingDetails {
        BillingDetails {
            name: "Acme".to_owned(),
            address_line1: "Main 1".to_owned(),
            postal_code: "1000".to_owned(),
            city: "Brussels".to_owned(),
            country: country.to_owned(),
            vat_number: vat_number.map(str::to_owned),
            ..BillingDetails::default()
        }
    }

    #[test]
    fn an_eu_business_with_a_number_vies_accepts_is_reverse_charged() {
        let preview = preview(
            Ok(details("BE", Some("BE0123456789"))),
            "NL",
            VatCheck::Valid,
        );
        assert_eq!(preview.vat_number_status, "valid");
        assert_eq!(preview.vat_number.as_deref(), Some("BE0123456789"));
        let vat = preview.vat.expect("a decision");
        assert_eq!(vat.treatment, Treatment::ReverseCharge);
        assert_eq!(vat.rate_bps, 0);
    }

    #[test]
    fn a_dutch_business_pays_dutch_vat_with_or_without_a_number() {
        let preview = preview(
            Ok(details("NL", Some("NL123456789B01"))),
            "NL",
            VatCheck::Valid,
        );
        let vat = preview.vat.expect("a decision");
        assert_eq!(vat.treatment, Treatment::Domestic);
        assert_eq!(vat.rate_bps, 2100);
    }

    #[test]
    fn a_number_vies_rejects_pays_the_customer_country_rate() {
        let preview = preview(
            Ok(details("DE", Some("DE123456789"))),
            "NL",
            VatCheck::Invalid,
        );
        assert_eq!(preview.vat_number_status, "invalid");
        let vat = preview.vat.expect("a decision");
        assert_eq!(vat.treatment, Treatment::Oss);
        assert_eq!(vat.rate_bps, 1900);
    }

    #[test]
    fn missing_details_have_no_vat_yet() {
        let preview = preview(Err(vec!["addressLine1", "country"]), "NL", VatCheck::None);
        assert_eq!(preview.missing, vec!["addressLine1", "country"]);
        assert_eq!(preview.vat, None);
        assert_eq!(preview.vat_number_status, "none");
    }

    #[test]
    fn the_answer_is_camel_case_with_snake_case_treatments() {
        let value = serde_json::to_value(preview(
            Ok(details("BE", Some("BE0123456789"))),
            "NL",
            VatCheck::Valid,
        ))
        .expect("serializes");
        assert_eq!(value["vatNumberStatus"], "valid");
        assert_eq!(value["vat"]["treatment"], "reverse_charge");
        assert_eq!(value["vat"]["rateBps"], 0);
        assert_eq!(value["vat"]["country"], "BE");
    }
}
