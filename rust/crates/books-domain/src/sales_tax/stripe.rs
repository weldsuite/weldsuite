//! The Stripe Tax engine (`sales-tax/stripe-tax.ts`), on the customer's own
//! Stripe account (a restricted key). Calculations work without Stripe
//! payments; WeldBooks builds its returns from its own `tax_lines`, so
//! `commit` is only for customers who let Stripe file for them. The
//! WeldBooks registration rule runs first, so nothing is sent for a state the
//! entity isn't registered in.

use std::collections::HashMap;

use serde_json::Value;
use weldsuite_ports::OutboundHttp;

use super::common::{
    ResultFields, active_registrations, apply_override, build_result, certificate_for_sale,
    is_us_country, jurisdiction_code_for, state_has_no_sales_tax, untaxed_line, untaxed_result,
};
use super::dates::iso_day;
use super::errors::EngineError;
use super::provider::{
    FormValue, ProviderCall, call_provider, encode_uri_component, engine_error, form_encode,
    invalid_request,
};
use super::rounding::{from_cents, snap6, to_cents};
use super::sourcing::decide_sourcing;
use super::tax_codes::to_stripe_tax_code;
use super::types::{
    CertificateRef, Detail, Level, LineResult, ProviderRegistration, ReverseLine, SalesTaxRequest,
    SalesTaxResult, TaxDirection,
};
use crate::js::days_from_civil;
use crate::jurisdictions::{js_trim, us};

/// `STRIPE_TAX_API_VERSION`.
pub const STRIPE_TAX_API_VERSION: &str = "2025-11-17.clover";
const STRIPE_ORIGIN: &str = "https://api.stripe.com";
const TAX_DATE_WINDOW_HOURS: i64 = 47;

/// `createStripeTaxEngine({ apiKey })`.
#[derive(Debug, Clone)]
pub struct StripeEngine {
    pub api_key: String,
    pub http: Option<OutboundHttp>,
}

/// `Date.parse(`${date}T12:00:00Z`)` in milliseconds, `None` when NaN.
fn noon_millis(date: &str) -> Option<i64> {
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i64 = date.get(..4)?.parse().ok()?;
    let m: i64 = date.get(5..7)?.parse().ok()?;
    let d: i64 = date.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    if d > crate::dates::days_in_month(y, m) {
        return None;
    }
    Some((days_from_civil(y, m, 1) + d - 1) * 86_400_000 + 12 * 3_600_000)
}

/// Stripe applies a calculation's tax date only within two days of now.
fn tax_date_in_window(date: &str, now_ms: i64) -> bool {
    noon_millis(date).is_some_and(|at| (at - now_ms).abs() <= TAX_DATE_WINDOW_HOURS * 3_600_000)
}

fn map_level(level: Option<&str>) -> Level {
    match level {
        Some("county") => Level::County,
        Some("city") => Level::City,
        Some("district") => Level::District,
        _ => Level::State,
    }
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn field(key: impl Into<String>, value: Option<FormValue>) -> (String, Option<FormValue>) {
    (key.into(), value)
}

fn non_empty(value: Option<&Value>) -> Option<FormValue> {
    value
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(|v| FormValue::Text(v.to_owned()))
}

struct MapContext<'a> {
    state: &'a str,
    agency_id: &'a str,
    certificate: Option<&'a CertificateRef>,
    warnings: &'a mut Vec<String>,
    sourcings: &'a mut Vec<String>,
}

impl StripeEngine {
    async fn call(
        &self,
        method: &'static str,
        path: &str,
        body: Option<String>,
        extra: Vec<(&'static str, String)>,
    ) -> Result<Value, EngineError> {
        let mut headers = vec![
            ("Authorization", format!("Bearer {}", self.api_key)),
            ("Stripe-Version", STRIPE_TAX_API_VERSION.to_owned()),
        ];
        if body.is_some() {
            headers.push((
                "Content-Type",
                "application/x-www-form-urlencoded".to_owned(),
            ));
        }
        headers.extend(extra);
        call_provider(ProviderCall {
            provider: "Stripe Tax",
            method,
            url: format!("{STRIPE_ORIGIN}{path}"),
            headers,
            body,
            http: self.http.as_ref(),
        })
        .await
    }

    #[allow(
        clippy::too_many_lines,
        reason = "mirrors stripe-tax.ts's buildCalculation() field by field"
    )]
    fn build_calculation(
        req: &SalesTaxRequest,
        date: &str,
        exempt: bool,
        sent: &[usize],
        now_ms: i64,
    ) -> Result<String, EngineError> {
        let mut fields = vec![
            field(
                "currency",
                Some(FormValue::Text(req.currency.to_lowercase())),
            ),
            field(
                "customer_details[address_source]",
                Some(FormValue::Text("shipping".into())),
            ),
        ];
        let empty = Value::Object(serde_json::Map::new());
        let to = req.ship_to.as_ref().unwrap_or(&empty);
        let to_state = decide_sourcing(Some(&req.ship_from), req.ship_to.as_ref(), false)
            .map(|d| d.taxing_state);
        fields.push(field(
            "customer_details[address][line1]",
            non_empty(to.get("line1")),
        ));
        fields.push(field(
            "customer_details[address][line2]",
            non_empty(to.get("line2")),
        ));
        fields.push(field(
            "customer_details[address][city]",
            non_empty(to.get("city")),
        ));
        fields.push(field(
            "customer_details[address][state]",
            to_state.map(FormValue::Text),
        ));
        fields.push(field(
            "customer_details[address][postal_code]",
            to.get("postalCode")
                .and_then(Value::as_str)
                .map(|p| js_trim(p).to_owned())
                .filter(|p| !p.is_empty())
                .map(FormValue::Text),
        ));
        fields.push(field(
            "customer_details[address][country]",
            Some(FormValue::Text("US".into())),
        ));
        if exempt {
            fields.push(field(
                "customer_details[taxability_override]",
                Some(FormValue::Text("customer_exempt".into())),
            ));
        }
        let from = &req.ship_from;
        let from_state = from
            .get("state")
            .and_then(Value::as_str)
            .map(|s| js_trim(s).to_owned())
            .filter(|s| !s.is_empty());
        let from_postal = from
            .get("postalCode")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty());
        if let (Some(from_state), Some(from_postal)) = (from_state, from_postal) {
            fields.push(field(
                "ship_from_details[address][line1]",
                non_empty(from.get("line1")),
            ));
            fields.push(field(
                "ship_from_details[address][city]",
                non_empty(from.get("city")),
            ));
            fields.push(field(
                "ship_from_details[address][state]",
                Some(FormValue::Text(from_state.to_uppercase())),
            ));
            fields.push(field(
                "ship_from_details[address][postal_code]",
                Some(FormValue::Text(js_trim(from_postal).to_owned())),
            ));
            fields.push(field(
                "ship_from_details[address][country]",
                Some(FormValue::Text("US".into())),
            ));
        }
        for (n, &index) in sent.iter().enumerate() {
            let l = &req.lines[index];
            #[allow(clippy::cast_precision_loss)]
            let amount = to_cents(l.amount) as f64;
            fields.push(field(
                format!("line_items[{n}][amount]"),
                Some(FormValue::Number(amount)),
            ));
            fields.push(field(
                format!("line_items[{n}][reference]"),
                Some(FormValue::Text(l.line_id.clone())),
            ));
            fields.push(field(
                format!("line_items[{n}][tax_code]"),
                Some(FormValue::Text(to_stripe_tax_code(&l.tax_code, l.tax_use)?)),
            ));
            fields.push(field(
                format!("line_items[{n}][tax_behavior]"),
                Some(FormValue::Text(
                    if l.tax_included {
                        "inclusive"
                    } else {
                        "exclusive"
                    }
                    .into(),
                )),
            ));
            if l.quantity.fract() == 0.0 && l.quantity.is_finite() && l.quantity >= 1.0 {
                fields.push(field(
                    format!("line_items[{n}][quantity]"),
                    Some(FormValue::Number(l.quantity)),
                ));
            }
        }
        if tax_date_in_window(date, now_ms)
            && let Some(noon) = noon_millis(date)
        {
            #[allow(clippy::cast_precision_loss)]
            let seconds = noon.div_euclid(1000) as f64;
            fields.push(field("tax_date", Some(FormValue::Number(seconds))));
        }
        fields.push(field(
            "expand[0]",
            Some(FormValue::Text("line_items.data.tax_breakdown".into())),
        ));
        Ok(form_encode(&fields))
    }

    /// `calculate(req)`.
    #[allow(
        clippy::too_many_lines,
        reason = "mirrors stripe-tax.ts's calculate() step by step"
    )]
    pub async fn calculate(
        &self,
        req: &SalesTaxRequest,
        calculated_at: String,
        now_ms: i64,
    ) -> Result<SalesTaxResult, EngineError> {
        let engine = "stripe_tax";
        if req.direction == TaxDirection::Use {
            return Err(invalid_request(
                "Stripe Tax calculates sales tax only; use tax needs the manual or the Avalara engine",
            ));
        }
        let Some(decision) = decide_sourcing(Some(&req.ship_from), req.ship_to.as_ref(), false)
        else {
            return Ok(untaxed_result(
                engine,
                req,
                &["no_ship_to"],
                calculated_at,
                None,
            ));
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
        let registered = active_registrations(&req.registrations, &state, &date);
        if registered.is_empty() {
            let warnings: &[&str] = if state_has_no_sales_tax(&state) {
                &[]
            } else {
                &["not_registered_in_state"]
            };
            return Ok(untaxed_result(
                engine,
                req,
                warnings,
                calculated_at,
                Some(state),
            ));
        }
        if req.lines.iter().any(|l| l.amount < 0.0) {
            return Err(invalid_request(
                "Stripe Tax cannot calculate a negative amount; a credit memo reuses the original invoice tax",
            ));
        }

        let mut warnings: Vec<String> = Vec::new();
        let (certificate, warning) = certificate_for_sale(req, &state, &date);
        if let Some(warning) = warning {
            warnings.push(warning.to_owned());
        }
        let sent: Vec<usize> = (0..req.lines.len())
            .filter(|&i| to_cents(req.lines[i].amount) > 0)
            .collect();
        let mut results: HashMap<String, LineResult> = HashMap::new();
        let mut engine_ref = None;
        let mut sourcings: Vec<String> = Vec::new();
        if !sent.is_empty() {
            let body = Self::build_calculation(req, &date, certificate.is_some(), &sent, now_ms)?;
            let calc = self
                .call("POST", "/v1/tax/calculations", Some(body), Vec::new())
                .await?;
            engine_ref = text(&calc["id"]);
            if !tax_date_in_window(&date, now_ms) {
                warnings.push("provider_rate_date_ignored".into());
            }
            let agency_id = registered
                .iter()
                .find(|r| r.level == "state")
                .unwrap_or(&registered[0])
                .agency_id
                .clone();
            let items = calc["line_items"]["data"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for item in &items {
                let mut ctx = MapContext {
                    state: &state,
                    agency_id: &agency_id,
                    certificate: certificate.as_ref(),
                    warnings: &mut warnings,
                    sourcings: &mut sourcings,
                };
                if let Some(mapped) = map_line(item, &mut ctx) {
                    results.insert(mapped.line_id.clone(), mapped);
                }
            }
        }
        let lines = req
            .lines
            .iter()
            .map(|l| {
                let result = results
                    .get(&l.line_id)
                    .cloned()
                    .unwrap_or_else(|| untaxed_line(l));
                match &l.tax_override {
                    Some(o) => apply_override(&result, o.amount, &o.reason).unwrap_or_else(|| {
                        warnings.push("override_not_applied".into());
                        result
                    }),
                    None => result,
                }
            })
            .collect();
        let sourcing = if sourcings.is_empty() {
            decision.sourcing
        } else if sourcings.len() == 2 {
            "modified_origin"
        } else if sourcings.iter().any(|s| s == "origin") {
            "origin"
        } else {
            "destination"
        };
        Ok(build_result(
            engine,
            req,
            ResultFields {
                sourcing,
                lines,
                warnings,
                engine_ref,
                ship_to_state: Some(state),
                calculated_at,
            },
        ))
    }

    /// `commit(req, result)`: the calculation as a Stripe transaction.
    pub async fn commit(
        &self,
        req: &SalesTaxRequest,
        result: &SalesTaxResult,
    ) -> Result<String, EngineError> {
        let Some(reference) = req
            .document_number
            .clone()
            .or_else(|| req.document_id.clone())
        else {
            return Err(invalid_request(
                "A document number is needed to record a Stripe transaction",
            ));
        };
        let Some(calc) = result
            .engine_ref
            .as_deref()
            .filter(|r| r.starts_with("taxcalc_"))
        else {
            return Err(invalid_request(
                "The calculation has no Stripe reference to record",
            ));
        };
        let body = form_encode(&[
            field("calculation", Some(FormValue::Text(calc.to_owned()))),
            field("reference", Some(FormValue::Text(reference))),
        ]);
        let txn = self
            .call(
                "POST",
                "/v1/tax/transactions/create_from_calculation",
                Some(body),
                vec![("Idempotency-Key", format!("weldbooks-tax-commit-{calc}"))],
            )
            .await?;
        text(&txn["id"])
            .filter(|id| !id.is_empty())
            .ok_or_else(|| engine_error("Stripe returned no transaction id", "unreachable", true))
    }

    async fn original_line_items(&self, reference: &str) -> Result<Vec<Value>, EngineError> {
        let mut items = Vec::new();
        let mut starting_after: Option<String> = None;
        for _ in 0..20 {
            let mut query = form_urlencoded::Serializer::new(String::new());
            query.append_pair("limit", "100");
            if let Some(after) = &starting_after {
                query.append_pair("starting_after", after);
            }
            let list = self
                .call(
                    "GET",
                    &format!(
                        "/v1/tax/transactions/{}/line_items?{}",
                        encode_uri_component(reference),
                        query.finish()
                    ),
                    None,
                    Vec::new(),
                )
                .await?;
            let data = list["data"].as_array().cloned().unwrap_or_default();
            let done = list["has_more"].as_bool() != Some(true) || data.is_empty();
            starting_after = data.last().and_then(|d| text(&d["id"]));
            items.extend(data);
            if done {
                break;
            }
        }
        Ok(items)
    }

    /// `reverse(ref, lines, { documentNumber, date })`: a partial reversal.
    pub async fn reverse(
        &self,
        reference: &str,
        lines: &[ReverseLine],
        document_number: &str,
        date: &str,
    ) -> Result<String, EngineError> {
        let originals = self.original_line_items(reference).await?;
        let mut fields = vec![
            field("mode", Some(FormValue::Text("partial".into()))),
            field(
                "original_transaction",
                Some(FormValue::Text(reference.to_owned())),
            ),
            field(
                "reference",
                Some(FormValue::Text(document_number.to_owned())),
            ),
            field(
                "metadata[document_date]",
                Some(FormValue::Text(iso_day(date))),
            ),
        ];
        for (n, line) in lines.iter().enumerate() {
            let original = originals
                .iter()
                .find(|o| o["reference"].as_str() == Some(line.line_id.as_str()));
            let Some(original_id) = original
                .and_then(|o| text(&o["id"]))
                .filter(|i| !i.is_empty())
            else {
                return Err(invalid_request(format!(
                    "Line {} is not on Stripe transaction {reference}",
                    line.line_id
                )));
            };
            let tax = to_cents(line.tax);
            let inclusive =
                original.is_some_and(|o| o["tax_behavior"].as_str() == Some("inclusive"));
            let amount = to_cents(line.amount) + if inclusive { tax } else { 0 };
            #[allow(clippy::cast_precision_loss)]
            {
                fields.push(field(
                    format!("line_items[{n}][amount]"),
                    Some(FormValue::Number(-(amount as f64))),
                ));
                fields.push(field(
                    format!("line_items[{n}][amount_tax]"),
                    Some(FormValue::Number(-(tax as f64))),
                ));
            }
            fields.push(field(
                format!("line_items[{n}][original_line_item]"),
                Some(FormValue::Text(original_id)),
            ));
            fields.push(field(
                format!("line_items[{n}][reference]"),
                Some(FormValue::Text(format!(
                    "{document_number}:{}",
                    line.line_id
                ))),
            ));
        }
        let txn = self
            .call(
                "POST",
                "/v1/tax/transactions/create_reversal",
                Some(form_encode(&fields)),
                vec![(
                    "Idempotency-Key",
                    format!("weldbooks-tax-reverse-{reference}-{document_number}"),
                )],
            )
            .await?;
        text(&txn["id"])
            .filter(|id| !id.is_empty())
            .ok_or_else(|| engine_error("Stripe returned no transaction id", "unreachable", true))
    }

    /// `void(ref)`: Stripe has no void; a full reversal takes the
    /// transaction out of the filing.
    pub async fn void(&self, reference: &str) -> Result<(), EngineError> {
        let body = form_encode(&[
            field("mode", Some(FormValue::Text("full".into()))),
            field(
                "original_transaction",
                Some(FormValue::Text(reference.to_owned())),
            ),
            field(
                "reference",
                Some(FormValue::Text(format!("void-{reference}"))),
            ),
        ]);
        self.call(
            "POST",
            "/v1/tax/transactions/create_reversal",
            Some(body),
            vec![("Idempotency-Key", format!("weldbooks-tax-void-{reference}"))],
        )
        .await?;
        Ok(())
    }

    /// `listRegistrations()`: the account's active US state registrations.
    pub async fn list_registrations(&self) -> Result<Vec<ProviderRegistration>, EngineError> {
        let mut out = Vec::new();
        let mut starting_after: Option<String> = None;
        for _ in 0..20 {
            let mut query = form_urlencoded::Serializer::new(String::new());
            query.append_pair("status", "active");
            query.append_pair("limit", "100");
            if let Some(after) = &starting_after {
                query.append_pair("starting_after", after);
            }
            let list = self
                .call(
                    "GET",
                    &format!("/v1/tax/registrations?{}", query.finish()),
                    None,
                    Vec::new(),
                )
                .await?;
            let data = list["data"].as_array().cloned().unwrap_or_default();
            for r in &data {
                let us_options = &r["country_options"]["us"];
                let Some(state) = us_options["state"].as_str().filter(|s| !s.is_empty()) else {
                    continue;
                };
                if r["country"].as_str() != Some("US") {
                    continue;
                }
                if let Some(kind) = us_options["type"].as_str().filter(|t| !t.is_empty())
                    && kind != "state_sales_tax"
                {
                    continue;
                }
                out.push(ProviderRegistration {
                    state_code: state.to_uppercase(),
                    reference: text(&r["id"]).unwrap_or_default(),
                    active: r["status"].as_str() == Some("active"),
                });
            }
            let done = list["has_more"].as_bool() != Some(true) || data.is_empty();
            starting_after = data.last().and_then(|d| text(&d["id"]));
            if done {
                break;
            }
        }
        Ok(out)
    }
}

fn num(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}

#[allow(clippy::cast_possible_truncation)]
fn cents(value: &Value) -> i64 {
    num(value) as i64
}

/// `mapLine(item, ctx)`: one Stripe line item to a line result; `None` when
/// it isn't one of ours.
#[allow(clippy::too_many_lines, reason = "mirrors stripe-tax.ts's mapLine()")]
fn map_line(item: &Value, ctx: &mut MapContext<'_>) -> Option<LineResult> {
    let line_id = item["reference"]
        .as_str()
        .filter(|r| !r.is_empty())?
        .to_owned();
    let inclusive = item["tax_behavior"].as_str() == Some("inclusive");
    let amount_tax = cents(&item["amount_tax"]);
    let gross = from_cents(cents(&item["amount"]) - if inclusive { amount_tax } else { 0 });
    let breakdown = item["tax_breakdown"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    if breakdown
        .iter()
        .any(|b| b["taxability_reason"].as_str() == Some("not_collecting"))
    {
        ctx.warnings.push("not_registered_in_state".into());
        return Some(LineResult {
            line_id,
            gross_amount: gross,
            taxable_amount: 0.0,
            exempt_amount: 0.0,
            non_taxable_amount: gross,
            tax: 0.0,
            overridden: false,
            override_reason: None,
            details: Vec::new(),
        });
    }

    let exempt = ctx.certificate.is_some();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let all: Vec<Detail> = breakdown
        .iter()
        .map(|b| {
            if b["taxability_reason"].as_str() == Some("not_supported") {
                ctx.warnings.push("provider_not_supported".into());
            }
            if let Some(sourcing) = b["sourcing"].as_str().filter(|s| !s.is_empty())
                && !ctx.sourcings.iter().any(|s| s == sourcing)
            {
                ctx.sourcings.push(sourcing.to_owned());
            }
            let jurisdiction = &b["jurisdiction"];
            let level = map_level(jurisdiction["level"].as_str());
            let state_code = jurisdiction["state"]
                .as_str()
                .unwrap_or(ctx.state)
                .to_uppercase();
            let name = jurisdiction["display_name"]
                .as_str()
                .or_else(|| b["tax_rate_details"]["display_name"].as_str())
                .map_or_else(|| state_code.clone(), str::to_owned);
            // `Number(percentage_decimal ?? 0) || 0`.
            let raw = &b["tax_rate_details"]["percentage_decimal"];
            let rate = if raw.is_null() {
                0.0
            } else {
                crate::js::js_number_value(Some(raw))
            };
            let rate = if rate.is_nan() || rate == 0.0 {
                0.0
            } else {
                rate
            };
            let taxable = from_cents(cents(&b["taxable_amount"]));
            let tax = from_cents(cents(&b["amount"]));
            let customer_exempt =
                exempt || b["taxability_reason"].as_str() == Some("customer_exempt");
            let exempt_amount = if customer_exempt {
                from_cents(to_cents(gross) - to_cents(taxable)).max(0.0)
            } else {
                0.0
            };
            let non_taxable =
                from_cents(to_cents(gross) - to_cents(taxable) - to_cents(exempt_amount)).max(0.0);
            let base = jurisdiction_code_for(&state_code, level.as_str(), &name, None);
            let count = seen.get(&base).copied().unwrap_or(0);
            seen.insert(base.clone(), count + 1);
            let code = if count > 0 {
                jurisdiction_code_for(
                    &state_code,
                    level.as_str(),
                    &name,
                    Some(&crate::js::number_text(rate)),
                )
            } else {
                base
            };
            let carries = exempt_amount > 0.0 && ctx.certificate.is_some();
            Detail {
                jurisdiction_code: code,
                jurisdiction_name: name,
                level,
                state_code,
                agency_id: Some(ctx.agency_id.to_owned()),
                reporting_code: None,
                rate,
                taxable_amount: taxable,
                exempt_amount,
                non_taxable_amount: non_taxable,
                tax,
                unrounded_tax: if rate > 0.0 {
                    snap6((taxable * rate) / 100.0)
                } else {
                    tax
                },
                exempt_reason: ctx
                    .certificate
                    .filter(|_| carries)
                    .map(|c| c.reason.clone()),
                certificate_id: ctx.certificate.filter(|_| carries).map(|c| c.id.clone()),
            }
        })
        .collect();

    // A jurisdiction taxable at 0% says nothing the others don't; keep it only
    // when it is all there is.
    let informative: Vec<Detail> = all
        .iter()
        .filter(|d| {
            !(d.rate == 0.0
                && d.tax == 0.0
                && d.exempt_amount == 0.0
                && d.non_taxable_amount == 0.0)
        })
        .cloned()
        .collect();
    let mut details = if informative.is_empty() {
        all.into_iter().take(1).collect()
    } else {
        informative
    };
    if details.is_empty() {
        // Nothing came back for the line: keep it on the ledger as a sale.
        let name = us::state(Some(ctx.state))
            .and_then(|s| s["name"].as_str())
            .unwrap_or(ctx.state)
            .to_owned();
        details.push(Detail {
            jurisdiction_code: ctx.state.to_owned(),
            jurisdiction_name: name,
            level: Level::State,
            state_code: ctx.state.to_owned(),
            agency_id: Some(ctx.agency_id.to_owned()),
            reporting_code: None,
            rate: 0.0,
            taxable_amount: 0.0,
            exempt_amount: if exempt { gross } else { 0.0 },
            non_taxable_amount: if exempt { 0.0 } else { gross },
            tax: 0.0,
            unrounded_tax: 0.0,
            exempt_reason: ctx.certificate.filter(|_| exempt).map(|c| c.reason.clone()),
            certificate_id: ctx.certificate.filter(|_| exempt).map(|c| c.id.clone()),
        });
    }
    let first = &details[0];
    let tax = from_cents(details.iter().map(|d| to_cents(d.tax)).sum());
    Some(LineResult {
        line_id,
        gross_amount: gross,
        taxable_amount: first.taxable_amount,
        exempt_amount: first.exempt_amount,
        non_taxable_amount: first.non_taxable_amount,
        tax,
        overridden: false,
        override_reason: None,
        details,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tax_date_window() {
        let now = noon_millis("2026-05-01").expect("a date");
        assert!(tax_date_in_window("2026-05-02", now));
        assert!(!tax_date_in_window("2026-05-03", now));
        assert!(!tax_date_in_window("2026-02-30", now));
    }
}
