//! The sales tax engine contract (`sales-tax/types.ts`): one request and one
//! result for every engine, the manual engine (rates the user keeps) and the
//! provider engines (Stripe Tax, Avalara AvaTax). Amounts are in the
//! document currency, rates are percentages (6.25 = 6.25%). Addresses are
//! `PostalAddress` objects as JSON (`normalizePostalAddress`'s shape).

use serde_json::{Map, Value, json};

use crate::js::number_value;

/// `TaxUse`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaxUse {
    Business,
    Personal,
}

impl TaxUse {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Business => "business",
            Self::Personal => "personal",
        }
    }

    /// `business` | `personal`, else `None`.
    pub fn parse(value: Option<&str>) -> Option<Self> {
        match value {
            Some("business") => Some(Self::Business),
            Some("personal") => Some(Self::Personal),
            _ => None,
        }
    }
}

/// `direction`: sales tax charged, or use tax accrued by the buyer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TaxDirection {
    #[default]
    Sales,
    Use,
}

/// `JurisdictionLevel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    State,
    County,
    City,
    District,
}

impl Level {
    pub const ALL: [Self; 4] = [Self::State, Self::County, Self::City, Self::District];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::State => "state",
            Self::County => "county",
            Self::City => "city",
            Self::District => "district",
        }
    }

    /// `LEVEL_RANK`.
    pub fn rank(self) -> u8 {
        match self {
            Self::State => 0,
            Self::County => 1,
            Self::City => 2,
            Self::District => 3,
        }
    }

    /// A stored level; anything else is `district` (`load.ts`'s `level()`).
    pub fn parse_or_district(value: &str) -> Self {
        match value {
            "state" => Self::State,
            "county" => Self::County,
            "city" => Self::City,
            _ => Self::District,
        }
    }
}

/// `ExemptionCertificateRef`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CertificateRef {
    pub id: String,
    /// USPS codes the certificate covers.
    pub states: Vec<String>,
    /// `resale` | `nonprofit` | `government` | `manufacturing` | `agricultural` | `other`.
    pub reason: String,
    pub certificate_number: Option<String>,
    pub form: Option<String>,
    pub issued_on: Option<String>,
    pub expires_on: Option<String>,
    pub blanket: bool,
    pub invoice_id: Option<String>,
    /// `valid` | `expired` | `pending` | `revoked`.
    pub status: String,
    pub last_used_on: Option<String>,
}

/// `SalesTaxRegistration`: an agency the entity is registered with (or
/// monitors). Tax is charged only while `registered`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Registration {
    pub agency_id: String,
    pub state_code: String,
    /// `state` | `local`.
    pub level: String,
    pub local_jurisdiction_code: Option<String>,
    /// `registered` | `pending` | `monitoring` | `closed`.
    pub status: String,
    pub registered_from: Option<String>,
    pub registered_until: Option<String>,
}

/// A hand-set tax on a line.
#[derive(Debug, Clone, PartialEq)]
pub struct Override {
    pub amount: f64,
    pub reason: String,
}

/// `SalesTaxRequestLine`.
#[derive(Debug, Clone, PartialEq)]
pub struct RequestLine {
    pub line_id: String,
    /// Net of seller discounts; tax-inclusive when `tax_included`.
    pub amount: f64,
    pub quantity: f64,
    pub tax_code: String,
    pub tax_use: TaxUse,
    pub tax_included: bool,
    pub tax_override: Option<Override>,
}

/// `SalesTaxRequest['customer']`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Customer {
    pub party_id: String,
    pub certificates: Vec<CertificateRef>,
    pub tax_use: Option<TaxUse>,
}

/// `SalesTaxRequest`.
#[derive(Debug, Clone, PartialEq)]
pub struct SalesTaxRequest {
    pub entity_id: String,
    /// `invoice` | `credit_memo` | `bill` | `estimate` | `order`.
    pub document_type: String,
    pub document_id: Option<String>,
    pub document_number: Option<String>,
    /// Tax point, `YYYY-MM-DD`.
    pub document_date: String,
    pub currency: String,
    /// The entity location or warehouse (an object; `{}` when unknown).
    pub ship_from: Value,
    /// `None` when neither the ship-to nor the bill-to has one.
    pub ship_to: Option<Value>,
    pub customer: Customer,
    pub registrations: Vec<Registration>,
    pub lines: Vec<RequestLine>,
    pub marketplace_facilitated: bool,
    pub direction: TaxDirection,
}

/// `SalesTaxDetail`: one jurisdiction's tax on a line.
#[derive(Debug, Clone, PartialEq)]
pub struct Detail {
    pub jurisdiction_code: String,
    pub jurisdiction_name: String,
    pub level: Level,
    pub state_code: String,
    pub agency_id: Option<String>,
    pub reporting_code: Option<String>,
    pub rate: f64,
    pub taxable_amount: f64,
    pub exempt_amount: f64,
    pub non_taxable_amount: f64,
    /// Rounded to the cent.
    pub tax: f64,
    /// Before rounding (at least three decimals).
    pub unrounded_tax: f64,
    pub exempt_reason: Option<String>,
    pub certificate_id: Option<String>,
}

impl Detail {
    /// The detail as JSON (`SalesTaxDetail`).
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("jurisdictionCode".into(), json!(self.jurisdiction_code));
        out.insert("jurisdictionName".into(), json!(self.jurisdiction_name));
        out.insert("level".into(), json!(self.level.as_str()));
        out.insert("stateCode".into(), json!(self.state_code));
        if let Some(agency) = &self.agency_id {
            out.insert("agencyId".into(), json!(agency));
        }
        if let Some(code) = &self.reporting_code {
            out.insert("reportingCode".into(), json!(code));
        }
        out.insert("rate".into(), number_value(self.rate));
        out.insert("taxableAmount".into(), number_value(self.taxable_amount));
        out.insert("exemptAmount".into(), number_value(self.exempt_amount));
        out.insert(
            "nonTaxableAmount".into(),
            number_value(self.non_taxable_amount),
        );
        out.insert("tax".into(), number_value(self.tax));
        out.insert("unroundedTax".into(), number_value(self.unrounded_tax));
        if let Some(reason) = &self.exempt_reason {
            out.insert("exemptReason".into(), json!(reason));
        }
        if let Some(id) = &self.certificate_id {
            out.insert("certificateId".into(), json!(id));
        }
        Value::Object(out)
    }
}

/// `SalesTaxLineResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct LineResult {
    pub line_id: String,
    pub gross_amount: f64,
    pub taxable_amount: f64,
    pub exempt_amount: f64,
    pub non_taxable_amount: f64,
    pub tax: f64,
    pub overridden: bool,
    pub override_reason: Option<String>,
    pub details: Vec<Detail>,
}

/// `SalesTaxResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct SalesTaxResult {
    /// `manual` | `stripe_tax` | `avalara`.
    pub engine: String,
    pub engine_ref: Option<String>,
    /// `toISOString()`.
    pub calculated_at: String,
    /// `origin` | `modified_origin` | `destination` | `none`.
    pub sourcing: &'static str,
    pub ship_to_state: Option<String>,
    pub ship_to_postal_code: Option<String>,
    pub lines: Vec<LineResult>,
    pub total_tax: f64,
    pub warnings: Vec<String>,
}

/// `AddressValidation`.
#[derive(Debug, Clone, PartialEq)]
pub struct AddressValidation {
    pub valid: bool,
    pub normalized: Option<Value>,
    pub messages: Option<Vec<String>>,
}

impl AddressValidation {
    /// `{ valid, normalized?, messages? }`.
    pub fn to_json(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("valid".into(), json!(self.valid));
        if let Some(normalized) = &self.normalized {
            out.insert("normalized".into(), normalized.clone());
        }
        if let Some(messages) = &self.messages {
            out.insert("messages".into(), json!(messages));
        }
        out
    }
}

/// `ReverseLine`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReverseLine {
    pub line_id: String,
    /// Positive amounts to reverse.
    pub amount: f64,
    pub tax: f64,
}

/// `ProviderRegistration`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRegistration {
    pub state_code: String,
    pub reference: String,
    pub active: bool,
}

// ---------------------------------------------------------------------------
// Manual engine data (sales_tax_* tables, loaded per entity)
// ---------------------------------------------------------------------------

/// A rate of a jurisdiction and when it applies.
#[derive(Debug, Clone, PartialEq)]
pub struct ManualRate {
    pub rate: f64,
    pub effective_from: String,
    pub effective_to: Option<String>,
}

/// `ManualJurisdiction`.
#[derive(Debug, Clone, PartialEq)]
pub struct ManualJurisdiction {
    pub id: String,
    pub agency_id: String,
    pub state_code: String,
    pub level: Level,
    pub code: Option<String>,
    pub name: String,
    pub reporting_code: Option<String>,
    pub rates: Vec<ManualRate>,
}

/// One entry of a zone's ZIP list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PostalEntry {
    Zip(String),
    Range { from: String, to: String },
    /// Anything else the JSON holds (never matches).
    Other,
}

impl PostalEntry {
    /// A stored `postal_codes` element.
    pub fn from_json(value: &Value) -> Self {
        match value {
            Value::String(zip) => Self::Zip(zip.clone()),
            Value::Object(range) => match (
                range.get("from").and_then(Value::as_str),
                range.get("to").and_then(Value::as_str),
            ) {
                (Some(from), Some(to)) => Self::Range {
                    from: from.to_owned(),
                    to: to.to_owned(),
                },
                _ => Self::Other,
            },
            _ => Self::Other,
        }
    }
}

/// `ManualZone`.
#[derive(Debug, Clone, PartialEq)]
pub struct ManualZone {
    pub id: String,
    pub agency_id: String,
    pub state_code: String,
    pub name: String,
    pub jurisdiction_ids: Vec<String>,
    pub postal_codes: Vec<PostalEntry>,
    pub is_origin: bool,
    /// Lower wins.
    pub priority: f64,
}

/// `ManualTaxabilityRule`; `applies_to_use` `None` is `any`.
#[derive(Debug, Clone, PartialEq)]
pub struct ManualRule {
    pub agency_id: String,
    pub tax_code: String,
    pub taxable: bool,
    /// 0–100.
    pub taxable_percent: f64,
    pub applies_to_use: Option<TaxUse>,
    pub rate_override: Option<f64>,
    pub effective_from: String,
    pub effective_to: Option<String>,
}

/// `ManualEngineData`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ManualData {
    pub jurisdictions: Vec<ManualJurisdiction>,
    pub zones: Vec<ManualZone>,
    pub rules: Vec<ManualRule>,
}

/// Avalara's settings (`SalesTaxEngineConfig['avalara']`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvalaraConfig {
    pub account_id: String,
    pub license_key: String,
    pub company_code: String,
    /// `sandbox` | `production`.
    pub environment: String,
}
