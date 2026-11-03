//! The jurisdiction adapters (`@weldsuite/books-domain/jurisdictions`): one
//! per supported country (NL, IN, US, BR). Their data (summaries, settings,
//! the charts of accounts and standard tax rates an entity is seeded with,
//! the US tax-line catalogs, …) is generated from the TypeScript package into
//! `data/jurisdictions.json` (`tools/export.mts`); the logic (identifier
//! checks, kind resolution, line mapping) is ported here.

pub mod br;
pub mod br_tax;
pub mod india;
pub mod nl;
pub mod us;

use std::sync::LazyLock;

use serde_json::{Value, json};

/// `data/jurisdictions.json`.
pub(crate) static DATA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../data/jurisdictions.json")).unwrap_or(Value::Null)
});

/// `TaxIdentifierValidation`: `{ valid, error?, formatted? }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaxIdValidation {
    pub valid: bool,
    pub error: Option<String>,
    pub formatted: Option<String>,
}

impl TaxIdValidation {
    pub fn ok(formatted: impl Into<String>) -> Self {
        Self {
            valid: true,
            error: None,
            formatted: Some(formatted.into()),
        }
    }

    pub fn fail(error: impl Into<String>) -> Self {
        Self {
            valid: false,
            error: Some(error.into()),
            formatted: None,
        }
    }
}

/// The identifiers an adapter checks (`TaxIdentifierType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaxIdField {
    VatNumber,
    RegistrationNumber,
    EinOrSsn,
}

impl TaxIdField {
    pub fn key(self) -> &'static str {
        match self {
            Self::VatNumber => "vatNumber",
            Self::RegistrationNumber => "registrationNumber",
            Self::EinOrSsn => "einOrSsn",
        }
    }
}

/// `listJurisdictions()`: the supported jurisdictions, as
/// `GET /api/accounting-entities/jurisdictions` lists them.
pub fn summaries() -> &'static [Value] {
    DATA["summaries"].as_array().map_or(&[], Vec::as_slice)
}

/// The codes of the registered adapters, in registry order.
pub fn codes() -> Vec<&'static str> {
    summaries()
        .iter()
        .filter_map(|s| s["code"].as_str())
        .collect()
}

/// `hasAdapter(code)`.
pub fn has_adapter(code: &str) -> bool {
    let upper = code.to_uppercase();
    codes().iter().any(|c| *c == upper)
}

/// An adapter's settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adapter {
    pub code: &'static str,
    pub name: &'static str,
    pub default_locale: &'static str,
    pub default_currency: &'static str,
    /// `recoverable` or `cost`.
    pub purchase_tax: Option<&'static str>,
    pub bad_debt_vat_relief: bool,
    /// `getInvoiceRequirements(locale).defaultPadding` (the same for every locale).
    pub default_padding: i64,
}

/// `getAdapter(code)`; `None` where TypeScript throws.
pub fn adapter(code: &str) -> Option<Adapter> {
    let upper = code.to_uppercase();
    let data = DATA["adapters"].get(upper.as_str())?;
    let text = |key: &str| data[key].as_str().unwrap_or_default();
    Some(Adapter {
        code: text("code"),
        name: text("name"),
        default_locale: text("defaultLocale"),
        default_currency: text("defaultCurrency"),
        purchase_tax: data["purchaseTax"].as_str(),
        bad_debt_vat_relief: data["badDebtVatRelief"].as_bool().unwrap_or(false),
        default_padding: data["defaultPadding"].as_i64().unwrap_or(4),
    })
}

/// `getJurisdictionFeatures(code)`: the adapter's features, all off for a
/// code without one.
pub fn features(code: Option<&str>) -> Value {
    let upper = code.map(str::to_uppercase);
    summaries()
        .iter()
        .find(|s| upper.as_deref().is_some_and(|c| s["code"].as_str() == Some(c)))
        .map_or_else(
            || {
                json!({
                    "vatReturn": false, "icp": false, "xafExport": false, "smallBusinessScheme": false,
                    "gstReturn": false, "salesTax": false, "form1099": false, "brTaxReturn": false,
                    "fiscalDocuments": false, "spedEcd": false,
                })
            },
            |s| s["features"].clone(),
        )
}

/// `templates[byKey[key]]` of a deduplicated table.
fn by_key<'a>(table: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    let index = table["byKey"].get(key)?.as_u64()?;
    table["templates"]
        .get(usize::try_from(index).ok()?)?
        .as_array()
}

/// The key of a chart or category table: `type|classification`, with the
/// values the TypeScript template would ignore read as null.
fn kind_key(code: &str, entity_type: Option<&str>, classification: Option<&str>) -> String {
    match code {
        "US" => {
            let entity_type = entity_type.filter(|t| us::is_entity_type(t));
            let classification = classification.filter(|c| us::is_tax_classification(c));
            format!(
                "{}|{}",
                entity_type.unwrap_or_default(),
                classification.unwrap_or_default()
            )
        }
        "BR" => format!(
            "|{}",
            classification
                .filter(|c| br::is_tax_regime(c))
                .unwrap_or_default()
        ),
        _ => "|".to_owned(),
    }
}

/// `adapter.getChartOfAccountsTemplate({ entityType, taxClassification })`:
/// the template rows (`code`, `name`, `type`, `subtype`, `normalSide`,
/// `isSystemAccount`, `systemRole`, `parentCode`, `taxLine`, `form1099Box`).
pub fn chart_template(
    code: &str,
    entity_type: Option<&str>,
    classification: Option<&str>,
) -> &'static [Value] {
    let upper = code.to_uppercase();
    let key = match upper.as_str() {
        "BR" => "|".to_owned(),
        _ => kind_key(&upper, entity_type, classification),
    };
    by_key(&DATA["charts"][upper.as_str()], &key).map_or(&[], Vec::as_slice)
}

/// `adapter.getStandardTaxCategories({ entityType, taxClassification })`:
/// `name`, `rate`, `type`, `taxCategoryCode`, `isDefault`, `isActive`,
/// `jurisdictionMetadata`.
pub fn tax_categories(
    code: &str,
    entity_type: Option<&str>,
    classification: Option<&str>,
) -> &'static [Value] {
    let upper = code.to_uppercase();
    let key = kind_key(&upper, entity_type, classification);
    by_key(&DATA["taxCategories"][upper.as_str()], &key).map_or(&[], Vec::as_slice)
}

/// `adapter.validateTaxIdentifier(field, value)`.
pub fn validate_tax_identifier(code: &str, field: TaxIdField, value: &str) -> TaxIdValidation {
    match (code.to_uppercase().as_str(), field) {
        ("NL", TaxIdField::VatNumber) => nl::validate_btw_number(value),
        ("NL", TaxIdField::RegistrationNumber) => nl::validate_kvk(value),
        ("IN", TaxIdField::VatNumber) => india::validate_gstin(value, None),
        ("IN", TaxIdField::RegistrationNumber) => india::validate_pan(value),
        ("US", TaxIdField::VatNumber) => us::validate_ein(value),
        ("US", TaxIdField::EinOrSsn) => us::validate_ein_or_ssn(value),
        ("US", TaxIdField::RegistrationNumber) => us::validate_state_tax_id(value),
        ("BR", TaxIdField::VatNumber) => br::validate_cnpj_or_cpf(value),
        ("BR", TaxIdField::RegistrationNumber) => br::validate_inscricao_estadual(value),
        _ => TaxIdValidation::ok(value),
    }
}

/// JavaScript's `\s` (the regex class `String.prototype.trim` also strips).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `value.trim()`.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_space)
}

/// `value.replace(/[\s<extra>]/g, '')`.
pub fn strip(value: &str, extra: &[char]) -> String {
    value
        .chars()
        .filter(|c| !is_js_space(*c) && !extra.contains(c))
        .collect()
}
