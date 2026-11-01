//! Invoice compliance (`@weldsuite/books-domain/accounting-compliance`): the
//! buyer's VAT number, the tax categories of an invoice, the notices the law
//! wants printed, and the finalize checks (mandatory identifiers, buyer name,
//! KOR, reverse charge).

use std::collections::BTreeSet;
use std::sync::LazyLock;

use serde_json::Value;
use weldsuite_db::PgPool;

use crate::js::truthy;
use crate::jurisdictions::js_trim;

/// `data/invoice.json` (`tools/invoice-export.mts`): the invoice requirements
/// per jurisdiction and language, the compliance notices, the Intl shapes and
/// the standard PDF font metrics.
pub(crate) static INVOICE_DATA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../data/invoice.json")).unwrap_or(Value::Null)
});

/// `getAdapter(code).getInvoiceRequirements(locale)` without the number
/// formatter: `{ defaultPadding, requiredFields, requiredFooter?, labels }`.
/// `None` for a code without an adapter.
pub fn invoice_requirements(code: &str, locale: &str) -> Option<&'static Value> {
    let code = code.to_uppercase();
    let by_language = INVOICE_DATA["requirements"].get(code.as_str())?;
    let variant = match code.as_str() {
        "NL" if locale.starts_with("nl") => "nl",
        "BR" if locale.to_lowercase().starts_with("pt") => "pt",
        "NL" | "BR" => "en",
        _ => "any",
    };
    by_language.get(variant)
}

/// The adapter's own locale (`getInvoiceRequirements()` without one).
fn default_locale(code: &str) -> &'static str {
    match code {
        "NL" => "nl-NL",
        "BR" => "pt-BR",
        "IN" => "en-IN",
        _ => "en-US",
    }
}

/// A notice constant (`NL_NOTICE_KOR`, …).
pub fn notice(name: &str) -> &'static str {
    INVOICE_DATA["notices"][name].as_str().unwrap_or_default()
}

/// `buildComplianceNotices(entity, categories)`: the statements the law
/// wants printed (`entity` a row as Drizzle returns it).
pub fn build_compliance_notices(entity: &Value, categories: &BTreeSet<String>) -> Vec<String> {
    let code = entity["jurisdictionCode"].as_str().unwrap_or_default();
    let has = |c: &str| categories.contains(c);
    let mut notices = Vec::new();
    match code {
        "IN" => {
            if has("reverse_charge") {
                notices.push(notice("IN_NOTICE_REVERSE_CHARGE"));
            }
            if has("export_goods") {
                notices.push(notice("IN_NOTICE_EXPORT"));
            }
        }
        "BR" => {
            let regime = crate::jurisdictions::br::regime_of(entity["taxClassification"].as_str());
            if regime == "simples_nacional" {
                notices.push(notice("BR_NOTICE_SIMPLES"));
            }
            if regime == "mei" {
                notices.push(notice("BR_NOTICE_MEI"));
            }
            if has("export_goods") {
                notices.push(notice("BR_NOTICE_EXPORT"));
            }
            notices.push(notice("BR_NOTICE_NOT_FISCAL"));
        }
        "NL" => {
            if crate::guards::is_kor_active(
                code,
                entity.get("jurisdictionSettings"),
                crate::http::now_ms(),
            ) {
                notices.push(notice("NL_NOTICE_KOR"));
            }
            if has("eu_b2b_goods") {
                notices.push(notice("NL_NOTICE_ICL"));
            }
            if has("eu_b2b_service") {
                notices.push(notice("NL_NOTICE_REVERSE_CHARGE_EU"));
            } else if has("reverse_charge") {
                notices.push(notice("NL_NOTICE_REVERSE_CHARGE_DOMESTIC"));
            }
        }
        _ => {}
    }
    notices.into_iter().map(str::to_owned).collect()
}

/// `entityHasInvoiceAddress(entity)`: a street line and a city at least.
pub fn entity_has_invoice_address(entity: &Value) -> bool {
    crate::address::normalize_postal_address(entity.get("address"))
        .is_some_and(|a| truthy(a.get("line1")) && truthy(a.get("city")))
}

/// `CHECKED_INVOICE_FIELDS`.
const CHECKED_INVOICE_FIELDS: [&str; 5] =
    ["vatNumber", "registrationNumber", "iban", "bic", "address"];

/// `missingEntityInvoiceFieldCodes(entity, requirements)`.
pub fn missing_entity_invoice_field_codes(entity: &Value, requirements: &Value) -> Vec<String> {
    let present = |field: &str| match field {
        "vatNumber" | "registrationNumber" => truthy(entity["taxIdentifiers"].get(field)),
        "iban" | "bic" => truthy(entity["bankDetails"].get(field)),
        "address" => entity_has_invoice_address(entity),
        _ => true,
    };
    let mut required: Vec<String> = requirements["requiredFields"]
        .as_array()
        .map(|fields| {
            fields
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if !required.iter().any(|f| f == "address") {
        required.push("address".into());
    }
    required
        .into_iter()
        .filter(|field| CHECKED_INVOICE_FIELDS.contains(&field.as_str()) && !present(field))
        .collect()
}

/// What VIES said about a VAT number (`ViesResult`, the part finalize reads).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViesCheck {
    pub available: bool,
    pub valid: bool,
}

/// `checkVatNumber(db, vatNumber)`. **Boundary with the purchases area**,
/// which ports `@weldsuite/books-domain/vies` (the EU VIES service over
/// outbound HTTP, cached in `vies_checks`) and replaces this body. Until then
/// VIES reads as unavailable: a reverse-charge invoice is finalized with the
/// "could not verify" warning, as on Global while VIES is down.
#[allow(
    clippy::unused_async,
    reason = "the VIES port awaits; the signature is the boundary"
)]
pub async fn check_vat_number(_db: &PgPool, _vat_number: &str) -> ViesCheck {
    ViesCheck {
        available: false,
        valid: false,
    }
}

/// `ComplianceCheckResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ComplianceCheck {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub buyer_vat_number: Option<String>,
    pub missing_entity_fields: Vec<String>,
}

impl ComplianceCheck {
    pub fn ok(&self) -> bool {
        self.errors.is_empty()
    }
}

fn label(labels: &Value, field: &str) -> String {
    match field {
        "vatNumber" => labels["vatNumberLabel"]
            .as_str()
            .unwrap_or(field)
            .to_owned(),
        "registrationNumber" => labels["registrationLabel"]
            .as_str()
            .unwrap_or(field)
            .to_owned(),
        "iban" => "IBAN".to_owned(),
        "bic" => "BIC".to_owned(),
        "address" => "business address (street and city)".to_owned(),
        other => other.to_owned(),
    }
}

/// `validateInvoiceForFinalize(db, entity, invoice, categories)`: the
/// jurisdiction's invoice requirements, checked when an invoice is
/// finalized. `entity` and `invoice` are rows as Drizzle returns them.
pub async fn validate_invoice_for_finalize(
    db: &PgPool,
    entity: &Value,
    invoice: &Value,
    categories: &BTreeSet<String>,
) -> Result<ComplianceCheck, sqlx::Error> {
    let mut check = ComplianceCheck::default();
    let code = entity["jurisdictionCode"].as_str().unwrap_or_default();
    if crate::jurisdictions::has_adapter(code) {
        let upper = code.to_uppercase();
        let locale = entity["locale"]
            .as_str()
            .unwrap_or_else(|| default_locale(&upper));
        if let Some(requirements) = invoice_requirements(code, locale) {
            check.missing_entity_fields = missing_entity_invoice_field_codes(entity, requirements);
            let missing: Vec<String> = check
                .missing_entity_fields
                .iter()
                .map(|field| label(&requirements["labels"], field))
                .collect();
            if !missing.is_empty() {
                check.errors.push(format!(
                    "Entity is missing legally required invoice fields: {}. Add them under Settings > Entities > (this entity) > Edit before finalizing.",
                    missing.join(", ")
                ));
            }
        }
    }

    // The buyer's name is on every invoice: the document's own, else the contact's.
    if !invoice_has_buyer_name(db, invoice).await? {
        check.errors.push("The invoice has no customer name. Choose a customer (or enter the customer name) on the invoice before finalizing.".to_owned());
    }

    let tax_total = invoice["taxTotal"]
        .as_str()
        .filter(|t| !t.is_empty())
        .unwrap_or("0");
    if crate::guards::is_kor_active(
        code,
        entity.get("jurisdictionSettings"),
        crate::http::now_ms(),
    ) && crate::js::parse_float(tax_total) > 0.0
    {
        check.errors.push("This entity uses the kleineondernemersregeling (KOR) — invoices must not charge BTW. Use the exempt tax rate on all lines.".to_owned());
    }

    if invoice_uses_reverse_charge(categories) {
        let buyer = get_contact_vat_number(db, invoice["contactId"].as_str()).await?;
        match buyer.as_deref().filter(|v| !v.is_empty()) {
            None => check.errors.push("Reverse-charge / intracommunautaire invoices require the customer's VAT number on their company record.".to_owned()),
            Some(vat) => {
                let vies = check_vat_number(db, vat).await;
                if vies.available && !vies.valid {
                    check.errors.push(format!("Customer VAT number {vat} failed VIES validation — the 0% reverse-charge treatment is not allowed with an invalid number."));
                } else if !vies.available {
                    check.warnings.push(format!("VIES is currently unavailable — could not verify customer VAT number {vat}. The invoice was finalized; re-validate later."));
                }
            }
        }
        check.buyer_vat_number = buyer;
    }
    Ok(check)
}

/// `invoiceHasBuyerName(db, invoice)`.
async fn invoice_has_buyer_name(db: &PgPool, invoice: &Value) -> Result<bool, sqlx::Error> {
    if invoice["contactName"]
        .as_str()
        .is_some_and(|n| !js_trim(n).is_empty())
    {
        return Ok(true);
    }
    let Some(contact_id) = invoice["contactId"].as_str().filter(|id| !id.is_empty()) else {
        return Ok(false);
    };
    let name: Option<Option<String>> =
        sqlx::query_scalar("select display_name from parties where id = $1 limit 1")
            .bind(contact_id)
            .fetch_optional(db)
            .await?;
    Ok(name.flatten().is_some_and(|n| !js_trim(&n).is_empty()))
}

/// `getContactVatNumber(db, partyId)`: parties carry no tax ids, the
/// company row they wrap does.
pub async fn get_contact_vat_number(
    db: &PgPool,
    party_id: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    let Some(party_id) = party_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let company: Option<Option<String>> =
        sqlx::query_scalar("select company_id from parties where id = $1 limit 1")
            .bind(party_id)
            .fetch_optional(db)
            .await?;
    let Some(company_id) = company.flatten().filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let vat: Option<Option<String>> =
        sqlx::query_scalar("select vat_number from companies where id = $1 limit 1")
            .bind(company_id)
            .fetch_optional(db)
            .await?;
    Ok(vat.flatten())
}

/// `collectInvoiceTaxCategories(db, invoiceId)`: the distinct tax category
/// codes of the invoice's live lines.
pub async fn collect_invoice_tax_categories(
    db: &PgPool,
    invoice_id: &str,
) -> Result<BTreeSet<String>, sqlx::Error> {
    let codes: Vec<Option<String>> = sqlx::query_scalar(
        "select r.tax_category_code from tax_rates r where r.id in ( \
           select i.tax_rate_id from invoice_items i \
           where i.invoice_id = $1 and i.deleted_at is null and i.tax_rate_id <> '')",
    )
    .bind(invoice_id)
    .fetch_all(db)
    .await?;
    Ok(codes
        .into_iter()
        .flatten()
        .filter(|code| !code.is_empty())
        .collect())
}

/// `invoiceUsesReverseCharge(categories)`.
pub fn invoice_uses_reverse_charge(categories: &BTreeSet<String>) -> bool {
    ["reverse_charge", "eu_b2b_service", "eu_b2b_goods"]
        .iter()
        .any(|code| categories.contains(*code))
}
