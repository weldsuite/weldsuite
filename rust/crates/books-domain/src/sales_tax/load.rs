//! What the sales tax engines need from the tenant database
//! (`sales-tax/load.ts`): the entity's engine and (decrypted) credentials,
//! its agencies as registrations, and for the manual engine its
//! jurisdictions, rates, zones and taxability rules. books-api and
//! commerce-api both call it.

use serde_json::Value;
use weldsuite_db::{Keyring, PgPool, decrypt_field};
use weldsuite_ports::OutboundHttp;

use super::engine::{Engine, EngineConfig, create_engine};
use super::errors::EngineError;
use super::provider::not_configured;
use super::types::{
    AvalaraConfig, CertificateRef, Level, ManualData, ManualJurisdiction, ManualRate, ManualRule,
    ManualZone, PostalEntry, Registration, TaxUse,
};
use crate::jurisdictions::js_trim;
use crate::tables::{
    EXEMPTION_CERTIFICATES, SALES_TAX_AGENCIES, SALES_TAX_JURISDICTION_RATES,
    SALES_TAX_JURISDICTIONS, SALES_TAX_TAXABILITY_RULES, SALES_TAX_ZONES,
};

/// Why loading failed: the engine can't be configured, or the database.
#[derive(Debug)]
pub enum LoadError {
    Engine(EngineError),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for LoadError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<EngineError> for LoadError {
    fn from(error: EngineError) -> Self {
        Self::Engine(error)
    }
}

/// `LoadedSalesTaxContext`.
#[derive(Debug)]
pub struct LoadedContext {
    pub engine: Engine,
    pub engine_id: &'static str,
    pub registrations: Vec<Registration>,
    /// The agencies' rows as Drizzle returns them.
    pub agencies: Vec<Value>,
}

/// `LoadOptions`: the keys that open `entities.sales_tax_credentials_encrypted`
/// (`None`: the stored credentials can't be read in this context) and the
/// outbound HTTP the provider engines call.
#[derive(Debug, Clone, Copy)]
pub struct LoadOptions<'a> {
    pub keyring: Option<&'a Keyring>,
    pub http: Option<&'a OutboundHttp>,
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn owned(row: &Value, key: &str) -> Option<String> {
    text(row, key).map(str::to_owned)
}

/// `num(value, fallback)`: `Number(value)`, the fallback for empty or
/// non-finite.
fn num(value: &Value, fallback: f64) -> f64 {
    match value {
        Value::Null => fallback,
        Value::String(s) if s.is_empty() => fallback,
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()).unwrap_or(fallback),
        Value::String(s) => {
            let n = weldsuite_kit::validation::js_number(s);
            if n.is_finite() { n } else { fallback }
        }
        _ => fallback,
    }
}

/// `toRegistration(agency)`.
pub fn to_registration(agency: &Value) -> Registration {
    let status = text(agency, "status").unwrap_or("");
    Registration {
        agency_id: owned(agency, "id").unwrap_or_default(),
        state_code: text(agency, "stateCode").unwrap_or("").to_uppercase(),
        level: if text(agency, "level") == Some("local") {
            "local".into()
        } else {
            "state".into()
        },
        local_jurisdiction_code: owned(agency, "localJurisdictionCode"),
        status: if ["registered", "pending", "monitoring", "closed"].contains(&status) {
            status.to_owned()
        } else {
            "monitoring".to_owned()
        },
        registered_from: owned(agency, "registeredFrom"),
        registered_until: owned(agency, "registeredUntil"),
    }
}

/// `buildManualEngineData({ jurisdictions, rates, zones, rules })` from the
/// rows as Drizzle returns them.
pub fn build_manual_engine_data(
    jurisdictions: &[Value],
    rates: &[Value],
    zones: &[Value],
    rules: &[Value],
) -> ManualData {
    ManualData {
        jurisdictions: jurisdictions
            .iter()
            .map(|j| {
                let id = owned(j, "id").unwrap_or_default();
                ManualJurisdiction {
                    rates: rates
                        .iter()
                        .filter(|r| text(r, "jurisdictionId") == Some(id.as_str()))
                        .map(|r| ManualRate {
                            rate: num(&r["rate"], 0.0),
                            effective_from: owned(r, "effectiveFrom").unwrap_or_default(),
                            effective_to: owned(r, "effectiveTo"),
                        })
                        .collect(),
                    id,
                    agency_id: owned(j, "agencyId").unwrap_or_default(),
                    state_code: text(j, "stateCode").unwrap_or("").to_uppercase(),
                    level: Level::parse_or_district(text(j, "level").unwrap_or("")),
                    code: owned(j, "code"),
                    name: owned(j, "name").unwrap_or_default(),
                    reporting_code: owned(j, "reportingCode"),
                }
            })
            .collect(),
        zones: zones
            .iter()
            .map(|z| ManualZone {
                id: owned(z, "id").unwrap_or_default(),
                agency_id: owned(z, "agencyId").unwrap_or_default(),
                state_code: text(z, "stateCode").unwrap_or("").to_uppercase(),
                name: owned(z, "name").unwrap_or_default(),
                jurisdiction_ids: z["jurisdictionIds"]
                    .as_array()
                    .map(|ids| ids.iter().filter_map(|i| i.as_str().map(str::to_owned)).collect())
                    .unwrap_or_default(),
                postal_codes: z["postalCodes"]
                    .as_array()
                    .map(|codes| codes.iter().map(PostalEntry::from_json).collect())
                    .unwrap_or_default(),
                is_origin: z["isOrigin"].as_bool() == Some(true),
                priority: z["priority"].as_f64().unwrap_or(0.0),
            })
            .collect(),
        rules: rules
            .iter()
            .map(|r| ManualRule {
                agency_id: owned(r, "agencyId").unwrap_or_default(),
                tax_code: owned(r, "taxCode").unwrap_or_default(),
                taxable: r["taxable"].as_bool() == Some(true),
                taxable_percent: num(&r["taxablePercent"], 100.0),
                applies_to_use: TaxUse::parse(text(r, "appliesToUse")),
                rate_override: if r["rateOverride"].is_null() {
                    None
                } else {
                    Some(num(&r["rateOverride"], 0.0))
                },
                effective_from: owned(r, "effectiveFrom").unwrap_or_default(),
                effective_to: owned(r, "effectiveTo"),
            })
            .collect(),
    }
}

/// `toCertificateRef(row, lastUsedOn)`.
pub fn to_certificate_ref(row: &Value, last_used_on: Option<String>) -> CertificateRef {
    let reason = text(row, "reason").unwrap_or("");
    let status = text(row, "status").unwrap_or("");
    CertificateRef {
        id: owned(row, "id").unwrap_or_default(),
        states: row["states"]
            .as_array()
            .map(|s| {
                s.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_uppercase)
                    .collect()
            })
            .unwrap_or_default(),
        reason: if [
            "resale",
            "nonprofit",
            "government",
            "manufacturing",
            "agricultural",
            "other",
        ]
        .contains(&reason)
        {
            reason.to_owned()
        } else {
            "other".to_owned()
        },
        certificate_number: owned(row, "certificateNumber"),
        form: owned(row, "form"),
        issued_on: owned(row, "issuedOn"),
        expires_on: owned(row, "expiresOn"),
        blanket: row["blanket"].as_bool() == Some(true),
        invoice_id: owned(row, "invoiceId"),
        status: if ["valid", "expired", "pending", "revoked"].contains(&status) {
            status.to_owned()
        } else {
            "pending".to_owned()
        },
        last_used_on,
    }
}

/// `readCredentials(blob, decrypt, engine)`.
fn read_credentials(
    blob: Option<&str>,
    keyring: Option<&Keyring>,
    engine: &str,
) -> Result<serde_json::Map<String, Value>, EngineError> {
    let Some(blob) = blob.filter(|b| !b.is_empty()) else {
        return Err(not_configured(format!(
            "The {engine} engine has no credentials; add them in the sales tax settings"
        )));
    };
    let unreadable = || {
        not_configured(format!(
            "The {engine} credentials could not be read; enter them again"
        ))
    };
    // `NO_CREDENTIALS`: the decrypt rejects, which the JSON.parse catch turns
    // into "could not be read".
    let keyring = keyring.ok_or_else(unreadable)?;
    let plain = decrypt_field(blob, keyring).map_err(|_| unreadable())?;
    let parsed: Value = serde_json::from_str(&plain).map_err(|_| unreadable())?;
    match parsed {
        Value::Object(map) => Ok(map),
        // `typeof [] === 'object'`: an array reads as an object without keys.
        Value::Array(_) => Ok(serde_json::Map::new()),
        _ => Err(not_configured(format!(
            "The {engine} credentials are not valid"
        ))),
    }
}

/// `text(value)`: a non-empty trimmed string.
fn credential(map: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(|s| js_trim(s).to_owned())
        .filter(|s| !s.is_empty())
}

/// The manual engine's rows of an entity: active jurisdictions, rates, zones
/// and rules (the four parallel selects of `loadSalesTaxContext`).
pub async fn load_manual_data(db: &PgPool, entity_id: &str) -> Result<ManualData, sqlx::Error> {
    let jurisdictions: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(sales_tax_jurisdictions),
        " from sales_tax_jurisdictions t where t.entity_id = $1 and t.deleted_at is null and t.is_active = true"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let rates: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(sales_tax_jurisdiction_rates),
        " from sales_tax_jurisdiction_rates t where t.entity_id = $1 and t.deleted_at is null"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let zones: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(sales_tax_zones),
        " from sales_tax_zones t where t.entity_id = $1 and t.deleted_at is null"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let rules: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(sales_tax_taxability_rules),
        " from sales_tax_taxability_rules t where t.entity_id = $1 and t.deleted_at is null"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    Ok(build_manual_engine_data(
        &SALES_TAX_JURISDICTIONS.js_rows(jurisdictions),
        &SALES_TAX_JURISDICTION_RATES.js_rows(rates),
        &SALES_TAX_ZONES.js_rows(zones),
        &SALES_TAX_TAXABILITY_RULES.js_rows(rules),
    ))
}

/// An entity's live agencies, as Drizzle returns them.
pub async fn load_agencies(db: &PgPool, entity_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(sales_tax_agencies),
        " from sales_tax_agencies t where t.entity_id = $1 and t.deleted_at is null"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    Ok(SALES_TAX_AGENCIES.js_rows(rows))
}

/// `loadSalesTaxContext(db, entityId, opts)`.
pub async fn load_sales_tax_context(
    db: &PgPool,
    entity_id: &str,
    opts: LoadOptions<'_>,
) -> Result<LoadedContext, LoadError> {
    let entity: Option<(Option<String>, Option<Value>, Option<String>)> = sqlx::query_as(
        "select sales_tax_engine, sales_tax_engine_config, sales_tax_credentials_encrypted \
         from entities where id = $1 limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some((engine, config, credentials)) = entity else {
        return Err(not_configured(format!("Accounting entity {entity_id} was not found")).into());
    };
    let requested = engine.unwrap_or_else(|| "manual".to_owned());
    let engine_id: &'static str = match requested.as_str() {
        "manual" => "manual",
        "stripe_tax" => "stripe_tax",
        "avalara" => "avalara",
        other => {
            return Err(not_configured(format!("Unknown sales tax engine \"{other}\"")).into());
        }
    };
    let agencies = load_agencies(db, entity_id).await?;
    let registrations = agencies.iter().map(to_registration).collect();
    let config = match engine_id {
        "manual" => EngineConfig::Manual(Some(load_manual_data(db, entity_id).await?)),
        "stripe_tax" => {
            let creds = read_credentials(credentials.as_deref(), opts.keyring, "Stripe Tax")?;
            let Some(api_key) = credential(&creds, "apiKey") else {
                return Err(not_configured("The Stripe Tax engine needs an API key").into());
            };
            EngineConfig::StripeTax(Some(api_key))
        }
        _ => {
            let creds = read_credentials(credentials.as_deref(), opts.keyring, "Avalara")?;
            let account_id = credential(&creds, "accountId");
            let license_key = credential(&creds, "licenseKey");
            let settings = config.unwrap_or(Value::Null);
            let company_code = settings
                .get("companyCode")
                .and_then(Value::as_str)
                .map(|s| js_trim(s).to_owned())
                .filter(|s| !s.is_empty());
            let (Some(account_id), Some(license_key)) = (account_id, license_key) else {
                return Err(not_configured(
                    "The Avalara engine needs an account id and a license key",
                )
                .into());
            };
            let Some(company_code) = company_code else {
                return Err(not_configured("The Avalara engine needs a company code").into());
            };
            EngineConfig::Avalara(Some(AvalaraConfig {
                account_id,
                license_key,
                company_code,
                environment: if settings.get("environment").and_then(Value::as_str)
                    == Some("sandbox")
                {
                    "sandbox".into()
                } else {
                    "production".into()
                },
            }))
        }
    };
    Ok(LoadedContext {
        engine: create_engine(config, opts.http.cloned())?,
        engine_id,
        registrations,
        agencies,
    })
}

/// `loadCustomerCertificates(db, entityId, partyId)`: the customer's
/// certificates, each with the tax date of its last use.
pub async fn load_customer_certificates(
    db: &PgPool,
    entity_id: &str,
    party_id: &str,
) -> Result<Vec<CertificateRef>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(exemption_certificates),
        " from exemption_certificates t where t.entity_id = $1 and t.party_id = $2 and t.deleted_at is null"
    ))
    .bind(entity_id)
    .bind(party_id)
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let rows = EXEMPTION_CERTIFICATES.js_rows(rows);
    let ids: Vec<String> = rows.iter().filter_map(|r| owned(r, "id")).collect();
    let used: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "select certificate_id, max(tax_date)::text from tax_lines \
         where entity_id = $1 and certificate_id = any($2) group by certificate_id",
    )
    .bind(entity_id)
    .bind(&ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let last = used
                .iter()
                .find(|(id, _)| id.as_deref() == text(row, "id"))
                .and_then(|(_, last)| last.clone());
            to_certificate_ref(row, last)
        })
        .collect())
}
