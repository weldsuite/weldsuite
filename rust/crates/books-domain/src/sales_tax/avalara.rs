//! The Avalara AvaTax engine (`sales-tax/avalara.ts`): the customer's own
//! account id and license key (HTTP Basic). `calculate` creates a temporary
//! SalesOrder (PurchaseOrder for use tax), `commit` records the finalized
//! document as a SalesInvoice, `reverse` refunds against it and `void` voids
//! it. The WeldBooks registration rule runs before any call.

use std::sync::Mutex;

use serde_json::{Map, Value, json};
use weldsuite_ports::OutboundHttp;

use super::common::{
    ResultFields, active_registrations, apply_override, build_result, certificate_for_sale,
    is_us_country, jurisdiction_code_for, state_has_no_sales_tax, untaxed_line, untaxed_result,
};
use super::dates::iso_day;
use super::errors::EngineError;
use super::provider::{
    ProviderCall, call_provider, encode_uri_component, invalid_request, to_base64,
};
use super::rounding::{from_cents, snap6, to_cents};
use super::sourcing::{decide_sourcing, state_code_of};
use super::tax_codes::to_avalara_tax_code;
use super::types::{
    AddressValidation, AvalaraConfig, CertificateRef, Detail, Level, LineResult,
    ProviderRegistration, ReverseLine, SalesTaxRequest, SalesTaxResult, TaxDirection,
};
use crate::js::{math_round, number_value};
use crate::jurisdictions::{js_trim, us};

/// `AVALARA_BASE_URL`.
fn base_url(environment: &str) -> &'static str {
    if environment == "sandbox" {
        "https://sandbox-rest.avatax.com"
    } else {
        "https://rest.avatax.com"
    }
}

/// `AVALARA_ENTITY_USE_CODE[reason]`.
pub fn entity_use_code(reason: &str) -> Option<&'static str> {
    Some(match reason {
        "resale" => "G",
        "nonprofit" => "E",
        "government" => "B",
        "manufacturing" => "I",
        "agricultural" => "H",
        "other" => "L",
        _ => return None,
    })
}

/// A committed use tax (purchase) document's ref prefix.
const PURCHASE_PREFIX: &str = "PurchaseInvoice:";

fn parse_ref(reference: &str) -> (&str, bool) {
    match reference.strip_prefix(PURCHASE_PREFIX) {
        Some(code) => (code, true),
        None => (reference, false),
    }
}

/// `mapLevel(jurisType)`: `None` for a country-level detail.
fn map_level(juris_type: Option<&str>) -> Option<Level> {
    match juris_type {
        Some("STA") => Some(Level::State),
        Some("CTY") => Some(Level::County),
        Some("CIT") => Some(Level::City),
        Some("CNT") => None,
        _ => Some(Level::District),
    }
}

/// `avalaraAddress(a)`.
fn avalara_address(a: &Value) -> Value {
    let mut out = Map::new();
    out.insert("country".into(), json!("US"));
    for key in ["line1", "line2", "city"] {
        if let Some(v) = a.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()) {
            out.insert(key.into(), json!(v));
        }
    }
    if let Some(state) = state_code_of(Some(a)) {
        out.insert("region".into(), json!(state));
    }
    if let Some(postal) = a.get("postalCode").and_then(Value::as_str).filter(|v| !v.is_empty()) {
        out.insert("postalCode".into(), json!(js_trim(postal)));
    }
    Value::Object(out)
}

/// `createAvalaraEngine(options)`.
#[derive(Debug)]
pub struct AvalaraEngine {
    pub config: AvalaraConfig,
    pub http: Option<OutboundHttp>,
    company_id: Mutex<Option<Value>>,
}

#[derive(Clone, Copy)]
enum DocType {
    SalesOrder,
    SalesInvoice,
    PurchaseOrder,
    PurchaseInvoice,
}

impl DocType {
    fn as_str(self) -> &'static str {
        match self {
            Self::SalesOrder => "SalesOrder",
            Self::SalesInvoice => "SalesInvoice",
            Self::PurchaseOrder => "PurchaseOrder",
            Self::PurchaseInvoice => "PurchaseInvoice",
        }
    }
}

impl AvalaraEngine {
    pub fn new(config: AvalaraConfig, http: Option<OutboundHttp>) -> Self {
        Self {
            config,
            http,
            company_id: Mutex::new(None),
        }
    }

    async fn call(&self, method: &'static str, path: &str, body: Option<&Value>) -> Result<Value, EngineError> {
        let authorization = format!(
            "Basic {}",
            to_base64(&format!("{}:{}", self.config.account_id, self.config.license_key))
        );
        let mut headers = vec![
            ("Authorization", authorization),
            ("Accept", "application/json".to_owned()),
            (
                "X-Avalara-Client",
                "WeldBooks; 1.0; WeldSuite; 1.0; weldsuite".to_owned(),
            ),
        ];
        if body.is_some() {
            headers.push(("Content-Type", "application/json".to_owned()));
        }
        call_provider(ProviderCall {
            provider: "Avalara AvaTax",
            method,
            url: format!("{}{path}", base_url(&self.config.environment)),
            headers,
            body: body.map(Value::to_string),
            http: self.http.as_ref(),
        })
        .await
    }

    fn company(&self) -> String {
        encode_uri_component(&self.config.company_code)
    }

    fn document_body(
        &self,
        req: &SalesTaxRequest,
        doc_type: DocType,
        commit: bool,
        date: &str,
        state: &str,
        with_certificates: bool,
    ) -> Result<Value, EngineError> {
        let certificate = if with_certificates {
            certificate_for_sale(req, state, date).0
        } else {
            None
        };
        let mut lines = Vec::new();
        for l in &req.lines {
            let tax_code = to_avalara_tax_code(&l.tax_code, l.tax_use)?;
            let mut line = Map::new();
            line.insert("number".into(), json!(l.line_id));
            line.insert("quantity".into(), number_value(l.quantity));
            line.insert("amount".into(), number_value(l.amount));
            line.insert("taxCode".into(), json!(tax_code));
            line.insert("taxIncluded".into(), json!(l.tax_included));
            line.insert("description".into(), json!(l.line_id));
            if let (true, Some(o)) = (commit, &l.tax_override) {
                line.insert(
                    "taxOverride".into(),
                    json!({ "type": "taxAmount", "taxAmount": number_value(o.amount), "reason": o.reason }),
                );
            }
            lines.push(Value::Object(line));
        }
        let mut body = Map::new();
        body.insert("type".into(), json!(doc_type.as_str()));
        body.insert("companyCode".into(), json!(self.config.company_code));
        body.insert("date".into(), json!(date));
        body.insert("customerCode".into(), json!(req.customer.party_id));
        body.insert("currencyCode".into(), json!(req.currency.to_uppercase()));
        body.insert("commit".into(), json!(commit));
        if commit {
            if let Some(code) = req.document_number.clone().or_else(|| req.document_id.clone()) {
                body.insert("code".into(), json!(code));
            }
        }
        if let Some(number) = req.document_number.as_deref().filter(|n| !n.is_empty()) {
            body.insert("purchaseOrderNo".into(), json!(number));
        }
        let empty = Value::Object(Map::new());
        body.insert(
            "addresses".into(),
            json!({
                "shipFrom": avalara_address(&req.ship_from),
                "shipTo": avalara_address(req.ship_to.as_ref().unwrap_or(&empty)),
            }),
        );
        if let Some(certificate) = certificate {
            let number = certificate
                .certificate_number
                .clone()
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| certificate.id.clone());
            body.insert("exemptionNo".into(), json!(number));
            if let Some(code) = entity_use_code(&certificate.reason) {
                body.insert("entityUseCode".into(), json!(code));
            }
        }
        body.insert("lines".into(), Value::Array(lines));
        Ok(Value::Object(body))
    }

    /// `calculate(req)`.
    pub async fn calculate(
        &self,
        req: &SalesTaxRequest,
        calculated_at: String,
    ) -> Result<SalesTaxResult, EngineError> {
        let engine = "avalara";
        let use_tax = req.direction == TaxDirection::Use;
        let Some(decision) = decide_sourcing(Some(&req.ship_from), req.ship_to.as_ref(), use_tax)
        else {
            return Ok(untaxed_result(engine, req, &["no_ship_to"], calculated_at, None));
        };
        let state = decision.taxing_state.clone();
        if req.marketplace_facilitated {
            return Ok(untaxed_result(
                engine,
                req,
                &["marketplace_facilitated"],
                calculated_at,
                Some(state),
            ));
        }
        if !is_us_country(req.ship_to.as_ref()) {
            return Ok(untaxed_result(engine, req, &[], calculated_at, None));
        }
        let date = iso_day(&req.document_date);
        let mut warnings: Vec<String> = Vec::new();
        let registered = active_registrations(&req.registrations, &state, &date);
        if !use_tax && registered.is_empty() {
            let warnings: &[&str] = if state_has_no_sales_tax(&state) {
                &[]
            } else {
                &["not_registered_in_state"]
            };
            return Ok(untaxed_result(engine, req, warnings, calculated_at, Some(state)));
        }
        if use_tax && registered.is_empty() {
            warnings.push("no_use_tax_registration".into());
        }
        let (certificate, warning) = if use_tax {
            (None, None)
        } else {
            certificate_for_sale(req, &state, &date)
        };
        if let Some(warning) = warning {
            warnings.push(warning.to_owned());
        }
        let body = self.document_body(
            req,
            if use_tax {
                DocType::PurchaseOrder
            } else {
                DocType::SalesOrder
            },
            false,
            &date,
            &state,
            !use_tax,
        )?;
        let tx = self
            .call("POST", "/api/v2/transactions/create", Some(&body))
            .await?;
        let agency_id = registered
            .iter()
            .find(|r| r.level == "state")
            .or_else(|| registered.first())
            .map(|r| r.agency_id.clone());
        let tx_lines = tx["lines"].as_array().cloned().unwrap_or_default();
        let lines = req
            .lines
            .iter()
            .map(|l| {
                // `new Map(lines.map(l => [l.lineNumber ?? '', l]))`: the last wins.
                let mapped = tx_lines
                    .iter()
                    .rev()
                    .find(|t| t["lineNumber"].as_str().unwrap_or("") == l.line_id);
                let result = match mapped {
                    Some(mapped) => map_line(
                        &l.line_id,
                        mapped,
                        &state,
                        agency_id.as_deref(),
                        certificate.as_ref(),
                        &mut warnings,
                    ),
                    None => untaxed_line(l),
                };
                match &l.tax_override {
                    Some(o) => apply_override(&result, o.amount, &o.reason).unwrap_or_else(|| {
                        warnings.push("override_not_applied".into());
                        result
                    }),
                    None => result,
                }
            })
            .collect();
        Ok(build_result(
            engine,
            req,
            ResultFields {
                sourcing: decision.sourcing,
                lines,
                warnings,
                engine_ref: tx["code"].as_str().map(str::to_owned),
                ship_to_state: Some(state),
                calculated_at,
            },
        ))
    }

    /// `commit(req)`: the finalized document as a SalesInvoice
    /// (PurchaseInvoice for use tax, its ref prefixed).
    pub async fn commit(&self, req: &SalesTaxRequest) -> Result<String, EngineError> {
        let Some(code) = req.document_number.clone().or_else(|| req.document_id.clone()) else {
            return Err(invalid_request(
                "A document number is needed to record an Avalara transaction",
            ));
        };
        let use_tax = req.direction == TaxDirection::Use;
        let Some(decision) = decide_sourcing(Some(&req.ship_from), req.ship_to.as_ref(), use_tax)
        else {
            return Err(invalid_request(
                "A ship-to address is needed to record an Avalara transaction",
            ));
        };
        let date = iso_day(&req.document_date);
        let body = self.document_body(
            req,
            if use_tax {
                DocType::PurchaseInvoice
            } else {
                DocType::SalesInvoice
            },
            true,
            &date,
            &decision.taxing_state,
            !use_tax,
        )?;
        let tx = self
            .call("POST", "/api/v2/transactions/create", Some(&body))
            .await?;
        let saved = tx["code"].as_str().map_or(code, str::to_owned);
        Ok(if use_tax {
            format!("{PURCHASE_PREFIX}{saved}")
        } else {
            saved
        })
    }

    /// `reverse(ref, lines, { documentNumber, date })`: whole lines, or one
    /// percentage of the document.
    pub async fn reverse(
        &self,
        reference: &str,
        lines: &[ReverseLine],
        document_number: &str,
        date: &str,
    ) -> Result<String, EngineError> {
        let (code, purchase) = parse_ref(reference);
        if purchase {
            return Err(invalid_request(
                "A use tax transaction cannot be refunded; void it and record it again",
            ));
        }
        let company = self.company();
        let original = self
            .call(
                "GET",
                &format!(
                    "/api/v2/companies/{company}/transactions/{}?documentType=SalesInvoice&%24include=Lines",
                    encode_uri_component(code)
                ),
                None,
            )
            .await?;
        let original_lines = original["lines"].as_array().cloned().unwrap_or_default();
        if original_lines.is_empty() {
            return Err(invalid_request(format!(
                "Avalara transaction {code} has no lines to refund"
            )));
        }
        let gross_of = |l: &Value| {
            l["lineAmount"].as_f64().unwrap_or(0.0)
                - if l["taxIncluded"].as_bool() == Some(true) {
                    l["tax"].as_f64().unwrap_or(0.0)
                } else {
                    0.0
                }
        };
        let mut ratios: Vec<(String, f64)> = Vec::new();
        for credit in lines {
            let Some(orig) = original_lines
                .iter()
                .find(|o| o["lineNumber"].as_str() == Some(credit.line_id.as_str()))
            else {
                return Err(invalid_request(format!(
                    "Line {} is not on Avalara transaction {code}",
                    credit.line_id
                )));
            };
            let base = gross_of(orig);
            let ratio = if base == 0.0 { 1.0 } else { credit.amount / base };
            match ratios.iter_mut().find(|(id, _)| *id == credit.line_id) {
                Some(slot) => slot.1 = ratio,
                None => ratios.push((credit.line_id.clone(), ratio)),
            }
        }
        let ratio_of = |id: &str| {
            ratios
                .iter()
                .find(|(line, _)| line == id)
                .map_or(0.0, |(_, r)| *r)
        };
        let whole = lines
            .iter()
            .all(|c| (ratio_of(&c.line_id) - 1.0).abs() < 0.0005);
        let first = lines.first().map_or(0.0, |c| ratio_of(&c.line_id));
        let same_ratio = lines.len() == original_lines.len()
            && lines
                .iter()
                .all(|c| (ratio_of(&c.line_id) - first).abs() < 0.0005);
        let mut refund = Map::new();
        if whole && lines.len() == original_lines.len() {
            refund.insert("refundType".into(), json!("Full"));
        } else if whole {
            refund.insert("refundType".into(), json!("Partial"));
            refund.insert(
                "refundLines".into(),
                json!(lines.iter().map(|c| c.line_id.clone()).collect::<Vec<_>>()),
            );
        } else if same_ratio {
            refund.insert("refundType".into(), json!("Percentage"));
            refund.insert(
                "refundPercentage".into(),
                number_value(math_round(first * 10000.0) / 100.0),
            );
        } else {
            return Err(invalid_request(
                "Avalara refunds whole lines or one percentage of the document; void the transaction and record it again to credit part of a line",
            ));
        }
        let mut body = Map::new();
        body.insert("refundTransactionCode".into(), json!(document_number));
        body.insert("refundDate".into(), json!(iso_day(date)));
        if let Some(original_date) = original["date"].as_str().filter(|d| !d.is_empty()) {
            body.insert("refundTaxDate".into(), json!(iso_day(original_date)));
        }
        body.insert("referenceCode".into(), json!(code));
        body.extend(refund);
        let refunded = self
            .call(
                "POST",
                &format!(
                    "/api/v2/companies/{company}/transactions/{}/refund?documentType=SalesInvoice",
                    encode_uri_component(code)
                ),
                Some(&Value::Object(body)),
            )
            .await?;
        Ok(refunded["code"]
            .as_str()
            .map_or_else(|| document_number.to_owned(), str::to_owned))
    }

    /// `void(ref)`.
    pub async fn void(&self, reference: &str) -> Result<(), EngineError> {
        let (code, purchase) = parse_ref(reference);
        self.call(
            "POST",
            &format!(
                "/api/v2/companies/{}/transactions/{}/void?documentType={}",
                self.company(),
                encode_uri_component(code),
                if purchase {
                    "PurchaseInvoice"
                } else {
                    "SalesInvoice"
                }
            ),
            Some(&json!({ "code": "DocVoided" })),
        )
        .await?;
        Ok(())
    }

    /// `validateAddress(address)`.
    pub async fn validate_address(&self, address: &Value) -> Result<AddressValidation, EngineError> {
        let mut body = avalara_address(address);
        if let Some(obj) = body.as_object_mut() {
            obj.insert("textCase".into(), json!("Mixed"));
        }
        let resolution = self
            .call("POST", "/api/v2/addresses/resolve", Some(&body))
            .await?;
        let messages: Vec<&Value> = resolution["messages"]
            .as_array()
            .map(|m| {
                m.iter()
                    .filter(|m| truthy(&m["summary"]) || truthy(&m["details"]))
                    .collect()
            })
            .unwrap_or_default();
        let failed = messages
            .iter()
            .any(|m| m["severity"].as_str() == Some("Error"));
        let first = resolution["validatedAddresses"]
            .as_array()
            .and_then(|a| a.first());
        let text: Vec<String> = messages
            .iter()
            .map(|m| {
                m["summary"]
                    .as_str()
                    .or_else(|| m["details"].as_str())
                    .unwrap_or("")
                    .to_owned()
            })
            .filter(|t| !t.is_empty())
            .collect();
        let messages = (!text.is_empty()).then_some(text);
        let Some(first) = first.filter(|_| !failed) else {
            return Ok(AddressValidation {
                valid: false,
                normalized: None,
                messages,
            });
        };
        let mut normalized = Map::new();
        for (from, to) in [
            ("line1", "line1"),
            ("line2", "line2"),
            ("city", "city"),
            ("region", "state"),
            ("postalCode", "postalCode"),
        ] {
            if let Some(v) = first[from].as_str().filter(|v| !v.is_empty()) {
                normalized.insert(to.into(), json!(v));
            }
        }
        normalized.insert(
            "country".into(),
            json!(first["country"].as_str().unwrap_or("US")),
        );
        Ok(AddressValidation {
            valid: true,
            normalized: Some(Value::Object(normalized)),
            messages,
        })
    }

    async fn resolve_company_id(&self) -> Result<Value, EngineError> {
        if let Some(id) = self.company_id.lock().ok().and_then(|g| g.clone()) {
            return Ok(id);
        }
        let filter = encode_uri_component(&format!(
            "companyCode eq '{}'",
            self.config.company_code.replace('\'', "''")
        ));
        let found = self
            .call(
                "GET",
                &format!("/api/v2/companies?%24filter={filter}&%24top=1"),
                None,
            )
            .await?;
        let id = found["value"]
            .as_array()
            .and_then(|v| v.first())
            .map(|c| c["id"].clone())
            .filter(|id| !id.is_null());
        let Some(id) = id else {
            return Err(invalid_request(format!(
                "Avalara company {} was not found",
                self.config.company_code
            )));
        };
        if let Ok(mut slot) = self.company_id.lock() {
            *slot = Some(id.clone());
        }
        Ok(id)
    }

    /// `listRegistrations()`: the company's US state nexus.
    pub async fn list_registrations(&self, today: &str) -> Result<Vec<ProviderRegistration>, EngineError> {
        let id = self.resolve_company_id().await?;
        let list = self
            .call(
                "GET",
                &format!("/api/v2/companies/{}/nexus?%24top=1000", js_text(&id)),
                None,
            )
            .await?;
        let mut out = Vec::new();
        for n in list["value"].as_array().cloned().unwrap_or_default() {
            let Some(region) = n["region"].as_str().filter(|r| !r.is_empty()) else {
                continue;
            };
            if n["country"].as_str() != Some("US") {
                continue;
            }
            if n["jurisTypeId"].as_str().unwrap_or("STA") != "STA"
                || n["nexusTypeId"].as_str() == Some("None")
            {
                continue;
            }
            let started = n["effectiveDate"]
                .as_str()
                .filter(|d| !d.is_empty())
                .is_none_or(|d| iso_day(d).as_str() <= today);
            let open = n["endDate"]
                .as_str()
                .filter(|d| !d.is_empty())
                .is_none_or(|d| iso_day(d).as_str() >= today);
            let reference = if n["id"].is_null() {
                region.to_owned()
            } else {
                js_text(&n["id"])
            };
            out.push(ProviderRegistration {
                state_code: region.to_uppercase(),
                reference,
                active: started && open,
            });
        }
        Ok(out)
    }
}

/// `String(value)` of a JSON scalar.
fn js_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n
            .as_f64()
            .map_or_else(|| n.to_string(), crate::js::number_text),
        other => other.to_string(),
    }
}

fn truthy(value: &Value) -> bool {
    crate::js::truthy(Some(value))
}

/// `mapLine(lineId, line, ctx)`.
fn map_line(
    line_id: &str,
    line: &Value,
    state: &str,
    agency_id: Option<&str>,
    certificate: Option<&CertificateRef>,
    warnings: &mut Vec<String>,
) -> LineResult {
    let tax = line["tax"].as_f64().unwrap_or(0.0);
    let inclusive = line["taxIncluded"].as_bool() == Some(true);
    let gross = from_cents(
        to_cents(line["lineAmount"].as_f64().unwrap_or(0.0))
            - if inclusive { to_cents(tax) } else { 0 },
    );
    let mut details: Vec<Detail> = Vec::new();
    for d in line["details"].as_array().cloned().unwrap_or_default() {
        let Some(level) = map_level(d["jurisType"].as_str()) else {
            continue;
        };
        let rate = math_round(d["rate"].as_f64().unwrap_or(0.0) * 100.0 * 10000.0) / 10000.0;
        let taxable = d["taxableAmount"].as_f64().unwrap_or(0.0);
        let exempt = d["exemptAmount"].as_f64().unwrap_or(0.0);
        let detail_tax = d["tax"].as_f64().unwrap_or(0.0);
        let region = d["region"].as_str();
        let name = d["jurisName"].as_str();
        let carries = exempt > 0.0 && certificate.is_some();
        details.push(Detail {
            jurisdiction_code: d["jurisCode"].as_str().map_or_else(
                || jurisdiction_code_for(region.unwrap_or(state), level.as_str(), name.unwrap_or("unknown"), None),
                str::to_owned,
            ),
            jurisdiction_name: name.or(region).unwrap_or(state).to_owned(),
            level,
            state_code: region.unwrap_or(state).to_uppercase(),
            agency_id: agency_id.filter(|a| !a.is_empty()).map(str::to_owned),
            reporting_code: d["stateAssignedNo"]
                .as_str()
                .filter(|c| !c.is_empty())
                .map(str::to_owned),
            rate,
            taxable_amount: taxable,
            exempt_amount: exempt,
            non_taxable_amount: d["nonTaxableAmount"].as_f64().unwrap_or(0.0),
            tax: detail_tax,
            unrounded_tax: if rate > 0.0 {
                snap6((taxable * rate) / 100.0)
            } else {
                detail_tax
            },
            exempt_reason: certificate.filter(|_| carries).map(|c| c.reason.clone()),
            certificate_id: certificate.filter(|_| carries).map(|c| c.id.clone()),
        });
    }
    if details.is_empty() {
        // The provider has no nexus where the entity is registered: keep the
        // sale on the ledger, untaxed.
        warnings.push("provider_nexus_missing".into());
        details.push(Detail {
            jurisdiction_code: state.to_owned(),
            jurisdiction_name: us::state(Some(state))
                .and_then(|s| s["name"].as_str())
                .unwrap_or(state)
                .to_owned(),
            level: Level::State,
            state_code: state.to_owned(),
            agency_id: agency_id.filter(|a| !a.is_empty()).map(str::to_owned),
            reporting_code: None,
            rate: 0.0,
            taxable_amount: 0.0,
            exempt_amount: 0.0,
            non_taxable_amount: gross,
            tax: 0.0,
            unrounded_tax: 0.0,
            exempt_reason: None,
            certificate_id: None,
        });
    }
    let first = &details[0];
    LineResult {
        line_id: line_id.to_owned(),
        gross_amount: gross,
        taxable_amount: first.taxable_amount,
        exempt_amount: first.exempt_amount,
        non_taxable_amount: first.non_taxable_amount,
        tax: from_cents(details.iter().map(|d| to_cents(d.tax)).sum()),
        overridden: false,
        override_reason: None,
        details,
    }
}
