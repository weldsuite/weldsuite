//! The manual sales tax engine (`sales-tax/manual-engine.ts`): rates, zones
//! and taxability rules the user keeps. Per line and per agency it works out
//! the taxable, exempt and non-taxable parts, multiplies the taxable part by
//! each jurisdiction's rate at the tax point and rounds per the state's rule.
//! Tax is charged only where the entity is registered on the document date.

use std::collections::{HashMap, HashSet};

use super::common::{
    ResultFields, active_registrations, build_result, certificate_for_sale, is_us_country,
    spread_tax, state_has_no_sales_tax, untaxed_line, untaxed_result,
};
use super::dates::{in_range, iso_day};
use super::rounding::{TaxCell, from_cents, round_tax_cells, rounding_for, snap6, to_cents};
use super::sourcing::{SourcingDecision, decide_sourcing, zip5_of};
use super::types::{
    Detail, Level, LineResult, ManualData, ManualJurisdiction, ManualRule, ManualZone,
    Registration, RequestLine, SalesTaxRequest, SalesTaxResult, TaxDirection, TaxUse,
};
use super::zones::{pick_destination_zone, pick_origin_zone};
use crate::jurisdictions::js_trim;

/// `createManualEngine(data)`.
#[derive(Debug, Clone, Default)]
pub struct ManualEngine {
    data: ManualData,
}

/// The rate in force on the tax point; `None` when the jurisdiction has none
/// that day (the latest start wins).
fn rate_at(jurisdiction: &ManualJurisdiction, date: &str) -> Option<f64> {
    let mut rates: Vec<_> = jurisdiction
        .rates
        .iter()
        .filter(|r| in_range(date, Some(&r.effective_from), r.effective_to.as_deref()))
        .collect();
    rates.sort_by(|a, b| b.effective_from.cmp(&a.effective_from));
    rates.first().map(|r| r.rate)
}

/// The rule for a tax code and use on the tax point: one for the use beats
/// `any`, a later one beats an earlier.
fn rule_at<'a>(
    rules: &[&'a ManualRule],
    tax_code: &str,
    tax_use: TaxUse,
    date: &str,
) -> Option<&'a ManualRule> {
    let code = js_trim(tax_code).to_lowercase();
    let mut found: Vec<&ManualRule> = rules
        .iter()
        .copied()
        .filter(|r| {
            js_trim(&r.tax_code).to_lowercase() == code
                && r.applies_to_use.is_none_or(|u| u == tax_use)
                && in_range(date, Some(&r.effective_from), r.effective_to.as_deref())
        })
        .collect();
    found.sort_by(|a, b| {
        b.applies_to_use
            .is_some()
            .cmp(&a.applies_to_use.is_some())
            .then_with(|| b.effective_from.cmp(&a.effective_from))
    });
    found.first().copied()
}

struct Planned<'a> {
    jurisdiction: &'a ManualJurisdiction,
    rate: f64,
}

struct AgencyPlan<'a> {
    /// Details carry this agency id (use tax: only while registered).
    report_agency_id: Option<String>,
    jurisdictions: Vec<Planned<'a>>,
    rules: Vec<&'a ManualRule>,
}

struct AgencyLine {
    plan: usize,
    rates: Vec<f64>,
    taxable_cents: i64,
    exempt_cents: i64,
    non_taxable_cents: i64,
}

struct LineWork<'r> {
    line: &'r RequestLine,
    gross_cents: i64,
    /// Tax decided up front (tax-inclusive price, user override).
    fixed_tax_cents: Option<i64>,
    agencies: Vec<AgencyLine>,
    exempt: Option<(String, String)>,
}

/// Tax before rounding, at full precision.
fn exact_tax(taxable_cents: i64, rate_percent: f64) -> f64 {
    (from_cents(taxable_cents) * rate_percent) / 100.0
}

fn sum(values: &[f64]) -> f64 {
    values.iter().fold(0.0, |a, b| a + b)
}

/// A rule's override replaces the agency's combined rate; the jurisdictions
/// keep their shares of it.
fn effective_rates(plan: &AgencyPlan<'_>, rate_override: Option<f64>) -> Vec<f64> {
    let rates: Vec<f64> = plan.jurisdictions.iter().map(|j| j.rate).collect();
    let Some(rate_override) = rate_override else {
        return rates;
    };
    let total = sum(&rates);
    if total <= 0.0 {
        return (0..rates.len())
            .map(|i| if i == 0 { snap6(rate_override) } else { 0.0 })
            .collect();
    }
    rates
        .iter()
        .map(|r| snap6((r * rate_override) / total))
        .collect()
}

fn clamp_percent(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        100.0
    }
}

/// State-level registrations first, so the line summary reads the state
/// agency (`orderAgencies`, a stable sort of the unique ids).
fn order_agencies(agency_ids: Vec<String>, registrations: &[Registration]) -> Vec<String> {
    // `new Map(registrations.map(r => [r.agencyId, r.level]))`: the last wins.
    let mut level: HashMap<&str, &str> = HashMap::new();
    for r in registrations {
        level.insert(r.agency_id.as_str(), r.level.as_str());
    }
    let mut seen = HashSet::new();
    let mut ids: Vec<String> = agency_ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    ids.sort_by_key(|id| u8::from(level.get(id.as_str()) == Some(&"local")));
    ids
}

impl ManualEngine {
    pub fn new(data: ManualData) -> Self {
        Self { data }
    }

    fn jurisdictions_of(&self, agency_id: &str) -> Vec<&ManualJurisdiction> {
        self.data
            .jurisdictions
            .iter()
            .filter(|j| j.agency_id == agency_id)
            .collect()
    }

    /// The jurisdictions of one agency that apply to this sale, by sourcing
    /// level, and whether a zone was missing where one was needed.
    fn plan_agency<'a>(
        &'a self,
        agency_id: &str,
        req: &SalesTaxRequest,
        date: &str,
        decision: &SourcingDecision,
    ) -> (Vec<Planned<'a>>, bool) {
        let zones: Vec<&ManualZone> = self
            .data
            .zones
            .iter()
            .filter(|z| z.agency_id == agency_id)
            .collect();
        let all = self.jurisdictions_of(agency_id);
        let dest_zip = zip5_of(req.ship_to.as_ref());
        let origin_zip = zip5_of(Some(&req.ship_from));
        let origin_zone = pick_origin_zone(&zones, origin_zip.as_deref());
        let destination_zone = pick_destination_zone(&zones, dest_zip.as_deref());

        // Picked in insertion order (a `Map` keyed by id).
        let mut picked: Vec<&ManualJurisdiction> = Vec::new();
        let put = |j: &'a ManualJurisdiction, picked: &mut Vec<&'a ManualJurisdiction>| {
            if let Some(slot) = picked.iter_mut().find(|p| p.id == j.id) {
                *slot = j;
            } else {
                picked.push(j);
            }
        };
        let mut zone_missing = false;
        for (index, level) in Level::ALL.iter().enumerate() {
            let zone = match decision.level_source[index] {
                super::sourcing::Side::Origin => origin_zone,
                super::sourcing::Side::Destination => destination_zone,
            };
            if let Some(zone) = zone {
                for id in &zone.jurisdiction_ids {
                    if let Some(j) = self.by_id(id)
                        && j.agency_id == agency_id
                        && j.level == *level
                    {
                        put(j, &mut picked);
                    }
                }
            } else {
                zone_missing = true;
                if *level == Level::State {
                    for j in all.iter().filter(|j| j.level == Level::State) {
                        put(j, &mut picked);
                    }
                }
            }
        }

        let needs_zones = !zones.is_empty() || all.iter().any(|j| j.level != Level::State);
        let mut jurisdictions: Vec<Planned<'a>> = picked
            .into_iter()
            .filter_map(|j| {
                rate_at(j, date).map(|rate| Planned {
                    jurisdiction: j,
                    rate,
                })
            })
            .collect();
        jurisdictions.sort_by_key(|p| p.jurisdiction.level.rank());
        (jurisdictions, zone_missing && needs_zones)
    }

    /// `index.byId.get(id)`: the last jurisdiction with that id.
    fn by_id(&self, id: &str) -> Option<&ManualJurisdiction> {
        self.data.jurisdictions.iter().rev().find(|j| j.id == id)
    }

    /// `engine.calculate(req)` at `calculated_at`.
    #[allow(
        clippy::too_many_lines,
        reason = "mirrors manual-engine.ts's calculate() step by step"
    )]
    pub fn calculate(&self, req: &SalesTaxRequest, calculated_at: String) -> SalesTaxResult {
        let engine = "manual";
        let use_tax = req.direction == TaxDirection::Use;
        let date = iso_day(&req.document_date);

        let Some(decision) = decide_sourcing(Some(&req.ship_from), req.ship_to.as_ref(), use_tax)
        else {
            return untaxed_result(engine, req, &["no_ship_to"], calculated_at, None);
        };
        let state = decision.taxing_state.clone();
        if req.marketplace_facilitated {
            return untaxed_result(
                engine,
                req,
                &["marketplace_facilitated"],
                calculated_at,
                Some(state),
            );
        }
        if !is_us_country(req.ship_to.as_ref()) {
            return untaxed_result(engine, req, &[], calculated_at, None);
        }

        let mut warnings: Vec<String> = Vec::new();
        let registered = active_registrations(&req.registrations, &state, &date);
        let registered_ids: HashSet<&str> =
            registered.iter().map(|r| r.agency_id.as_str()).collect();
        let agency_ids: Vec<String> = if use_tax {
            // `new Set` over the jurisdictions in index order.
            let mut in_state: Vec<String> = Vec::new();
            for j in &self.data.jurisdictions {
                if j.state_code.to_uppercase() == state && !in_state.contains(&j.agency_id) {
                    in_state.push(j.agency_id.clone());
                }
            }
            if registered.is_empty() {
                warnings.push("no_use_tax_registration".into());
            }
            if in_state.is_empty() {
                warnings.push("rates_not_configured".into());
                return build_result(
                    engine,
                    req,
                    ResultFields {
                        sourcing: "none",
                        lines: req.lines.iter().map(untaxed_line).collect(),
                        warnings,
                        engine_ref: None,
                        ship_to_state: Some(state),
                        calculated_at,
                    },
                );
            }
            in_state
        } else {
            if registered.is_empty() {
                let warnings: &[&str] = if state_has_no_sales_tax(&state) {
                    &[]
                } else {
                    &["not_registered_in_state"]
                };
                return untaxed_result(engine, req, warnings, calculated_at, Some(state));
            }
            registered.iter().map(|r| r.agency_id.clone()).collect()
        };
        let agency_ids = order_agencies(agency_ids, &req.registrations);

        let mut plans: Vec<AgencyPlan<'_>> = Vec::new();
        let mut zone_missing = false;
        for agency_id in &agency_ids {
            let (jurisdictions, missing) = self.plan_agency(agency_id, req, &date, &decision);
            zone_missing = zone_missing || missing;
            if jurisdictions.is_empty() {
                continue;
            }
            plans.push(AgencyPlan {
                report_agency_id: if use_tax && !registered_ids.contains(agency_id.as_str()) {
                    None
                } else {
                    Some(agency_id.clone())
                },
                jurisdictions,
                rules: self
                    .data
                    .rules
                    .iter()
                    .filter(|r| &r.agency_id == agency_id)
                    .collect(),
            });
        }
        if zone_missing {
            warnings.push("zone_not_found".into());
            warnings.push("address_unverified".into());
        }
        if plans.is_empty() {
            warnings.push("rates_not_configured".into());
            return build_result(
                engine,
                req,
                ResultFields {
                    sourcing: decision.sourcing,
                    lines: req.lines.iter().map(untaxed_line).collect(),
                    warnings,
                    engine_ref: None,
                    ship_to_state: Some(state),
                    calculated_at,
                },
            );
        }

        // Exemption certificate: sales only.
        let mut certificate: Option<(String, String)> = None;
        if !use_tax {
            let (found, warning) = certificate_for_sale(req, &state, &date);
            if let Some(found) = found {
                certificate = Some((found.reason, found.id));
            }
            if let Some(warning) = warning {
                warnings.push(warning.to_owned());
            }
        }

        let work: Vec<LineWork<'_>> = req
            .lines
            .iter()
            .map(|line| work_line(line, &plans, &date, certificate.as_ref()))
            .collect();

        // Rounding groups: every line without a fixed tax.
        let rounding = rounding_for(Some(&state));
        let mut cells: Vec<TaxCell> = Vec::new();
        let mut refs: Vec<(usize, usize, usize)> = Vec::new();
        for (li, w) in work.iter().enumerate() {
            if w.fixed_tax_cents.is_some() {
                continue;
            }
            for (ai, a) in w.agencies.iter().enumerate() {
                for (ji, j) in plans[a.plan].jurisdictions.iter().enumerate() {
                    cells.push(TaxCell {
                        line_id: w.line.line_id.clone(),
                        jurisdiction_key: j.jurisdiction.id.clone(),
                        unrounded: exact_tax(a.taxable_cents, a.rates[ji]),
                    });
                    refs.push((li, ai, ji));
                }
            }
        }
        let rounded = round_tax_cells(&cells, rounding);
        let tax_cents: HashMap<(usize, usize, usize), i64> =
            refs.into_iter().zip(rounded).collect();

        let lines = work
            .iter()
            .enumerate()
            .map(|(li, w)| {
                let flat: Vec<(&AgencyLine, usize, usize)> = w
                    .agencies
                    .iter()
                    .enumerate()
                    .flat_map(|(ai, a)| {
                        (0..plans[a.plan].jurisdictions.len()).map(move |ji| (a, ai, ji))
                    })
                    .collect();
                let parts: Vec<i64> = if let Some(fixed) = w.fixed_tax_cents {
                    let unrounded: Vec<f64> = flat
                        .iter()
                        .map(|(a, _, ji)| exact_tax(a.taxable_cents, a.rates[*ji]))
                        .collect();
                    let rates: Vec<f64> = flat.iter().map(|(a, _, ji)| a.rates[*ji]).collect();
                    spread_tax(fixed, &unrounded, &rates)
                } else {
                    flat.iter()
                        .map(|(_, ai, ji)| tax_cents.get(&(li, *ai, *ji)).copied().unwrap_or(0))
                        .collect()
                };
                let details = flat
                    .iter()
                    .zip(&parts)
                    .map(|((a, _, ji), part)| {
                        let plan = &plans[a.plan];
                        let j = plan.jurisdictions[*ji].jurisdiction;
                        let exempt = a.exempt_cents > 0;
                        let unrounded = exact_tax(a.taxable_cents, a.rates[*ji]);
                        Detail {
                            jurisdiction_code: j.code.clone().unwrap_or_else(|| j.id.clone()),
                            jurisdiction_name: j.name.clone(),
                            level: j.level,
                            state_code: j.state_code.to_uppercase(),
                            agency_id: plan.report_agency_id.clone().filter(|a| !a.is_empty()),
                            reporting_code: j.reporting_code.clone().filter(|c| !c.is_empty()),
                            rate: a.rates[*ji],
                            taxable_amount: from_cents(a.taxable_cents),
                            exempt_amount: from_cents(a.exempt_cents),
                            non_taxable_amount: from_cents(a.non_taxable_cents),
                            tax: from_cents(*part),
                            unrounded_tax: if w.fixed_tax_cents.is_some() {
                                snap6(from_cents(*part))
                            } else {
                                snap6(unrounded)
                            },
                            exempt_reason: w
                                .exempt
                                .as_ref()
                                .filter(|_| exempt)
                                .map(|e| e.0.clone()),
                            certificate_id: w
                                .exempt
                                .as_ref()
                                .filter(|_| exempt)
                                .map(|e| e.1.clone()),
                        }
                    })
                    .collect();
                let primary = &w.agencies[0];
                LineResult {
                    line_id: w.line.line_id.clone(),
                    gross_amount: from_cents(w.gross_cents),
                    taxable_amount: from_cents(primary.taxable_cents),
                    exempt_amount: from_cents(primary.exempt_cents),
                    non_taxable_amount: from_cents(primary.non_taxable_cents),
                    tax: from_cents(parts.iter().sum()),
                    overridden: w.line.tax_override.is_some(),
                    override_reason: w.line.tax_override.as_ref().map(|o| o.reason.clone()),
                    details,
                }
            })
            .collect();

        build_result(
            engine,
            req,
            ResultFields {
                sourcing: decision.sourcing,
                lines,
                warnings,
                engine_ref: None,
                ship_to_state: Some(state),
                calculated_at,
            },
        )
    }
}

fn work_line<'r>(
    line: &'r RequestLine,
    plans: &[AgencyPlan<'_>],
    date: &str,
    certificate: Option<&(String, String)>,
) -> LineWork<'r> {
    let tax_use = line.tax_use;
    let never_taxed = line.tax_code == "non_taxable";
    let amount_cents = to_cents(line.amount);
    let override_cents = line.tax_override.as_ref().map_or(0, |o| to_cents(o.amount));

    let prelim: Vec<(usize, f64, Vec<f64>)> = plans
        .iter()
        .enumerate()
        .map(|(index, plan)| {
            let rule = if never_taxed {
                None
            } else {
                rule_at(&plan.rules, &line.tax_code, tax_use, date)
            };
            let share = if never_taxed {
                0.0
            } else {
                match rule {
                    Some(rule) if rule.taxable => clamp_percent(rule.taxable_percent) / 100.0,
                    Some(_) => 0.0,
                    None => 1.0,
                }
            };
            let rates = effective_rates(
                plan,
                rule.filter(|r| r.taxable).and_then(|r| r.rate_override),
            );
            (index, share, rates)
        })
        .collect();

    // A tax-inclusive price holds the tax: back it out so net + tax = the price.
    let mut gross_cents = amount_cents;
    let mut fixed_tax_cents = None;
    if line.tax_included {
        if line.tax_override.is_some() {
            gross_cents = amount_cents - override_cents;
        } else {
            let factor = if certificate.is_some() {
                0.0
            } else {
                prelim
                    .iter()
                    .fold(0.0, |sum, (_, share, rates)| sum + share * self::sum(rates))
                    / 100.0
            };
            gross_cents = to_cents(from_cents(amount_cents) / (1.0 + factor));
        }
        fixed_tax_cents = Some(amount_cents - gross_cents);
    } else if line.tax_override.is_some() {
        fixed_tax_cents = Some(override_cents);
    }

    let agencies: Vec<AgencyLine> = prelim
        .into_iter()
        .map(|(plan, share, rates)| {
            let taxable_part = to_cents(from_cents(gross_cents) * share);
            let exempt = if certificate.is_some() && taxable_part != 0 {
                taxable_part
            } else {
                0
            };
            AgencyLine {
                plan,
                rates,
                taxable_cents: taxable_part - exempt,
                exempt_cents: exempt,
                non_taxable_cents: gross_cents - taxable_part,
            }
        })
        .collect();
    let exempted = agencies.iter().any(|a| a.exempt_cents != 0);
    LineWork {
        line,
        gross_cents,
        fixed_tax_cents,
        agencies,
        exempt: certificate.filter(|_| exempted).cloned(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::types::{Customer, ManualRate, Override, PostalEntry};
    use super::*;

    fn jurisdiction(id: &str, level: Level, rate: f64) -> ManualJurisdiction {
        ManualJurisdiction {
            id: id.into(),
            agency_id: "agy_tx".into(),
            state_code: "TX".into(),
            level,
            code: Some(format!("TX-{id}")),
            name: id.into(),
            reporting_code: None,
            rates: vec![ManualRate {
                rate,
                effective_from: "2020-01-01".into(),
                effective_to: None,
            }],
        }
    }

    fn engine() -> ManualEngine {
        ManualEngine::new(ManualData {
            jurisdictions: vec![
                jurisdiction("state", Level::State, 6.25),
                jurisdiction("city", Level::City, 2.0),
            ],
            zones: vec![ManualZone {
                id: "z".into(),
                agency_id: "agy_tx".into(),
                state_code: "TX".into(),
                name: "Austin".into(),
                jurisdiction_ids: vec!["state".into(), "city".into()],
                postal_codes: vec![PostalEntry::Zip("78701".into())],
                is_origin: true,
                priority: 0.0,
            }],
            rules: vec![],
        })
    }

    fn request(lines: Vec<RequestLine>) -> SalesTaxRequest {
        SalesTaxRequest {
            entity_id: "ent".into(),
            document_type: "invoice".into(),
            document_id: None,
            document_number: None,
            document_date: "2026-05-01".into(),
            currency: "USD".into(),
            ship_from: json!({ "state": "TX", "postalCode": "78701" }),
            ship_to: Some(json!({ "state": "TX", "postalCode": "78701" })),
            customer: Customer::default(),
            registrations: vec![Registration {
                agency_id: "agy_tx".into(),
                state_code: "TX".into(),
                level: "state".into(),
                status: "registered".into(),
                ..Registration::default()
            }],
            lines,
            marketplace_facilitated: false,
            direction: TaxDirection::Sales,
        }
    }

    fn line(id: &str, amount: f64) -> RequestLine {
        RequestLine {
            line_id: id.into(),
            amount,
            quantity: 1.0,
            tax_code: "general".into(),
            tax_use: TaxUse::Business,
            tax_included: false,
            tax_override: None,
        }
    }

    #[test]
    fn origin_sale_is_taxed_per_jurisdiction() {
        let result = engine().calculate(
            &request(vec![line("l1", 100.0), line("l2", 33.33)]),
            "t".into(),
        );
        assert_eq!(result.sourcing, "origin");
        assert!(
            (result.total_tax - 11.0).abs() < 1e-9,
            "{}",
            result.total_tax
        );
        assert_eq!(result.lines[0].details.len(), 2);
        assert!((result.lines[0].tax - 8.25).abs() < 1e-9);
        assert_eq!(result.warnings, Vec::<String>::new());
    }

    #[test]
    fn inclusive_price_and_override() {
        let mut inclusive = line("l1", 108.25);
        inclusive.tax_included = true;
        let mut overridden = line("l2", 100.0);
        overridden.tax_override = Some(Override {
            amount: 1.0,
            reason: "x".into(),
        });
        let result = engine().calculate(&request(vec![inclusive, overridden]), "t".into());
        assert!((result.lines[0].gross_amount - 100.0).abs() < 1e-9);
        assert!((result.lines[0].tax - 8.25).abs() < 1e-9);
        assert!((result.lines[1].tax - 1.0).abs() < 1e-9);
        assert!(result.lines[1].overridden);
    }

    #[test]
    fn not_registered_is_untaxed() {
        let mut req = request(vec![line("l1", 10.0)]);
        req.ship_to = Some(json!({ "state": "NV", "postalCode": "89501" }));
        let result = engine().calculate(&req, "t".into());
        assert_eq!(result.warnings, vec!["not_registered_in_state".to_owned()]);
        assert_eq!(result.sourcing, "none");
        req.ship_to = Some(json!({ "state": "OR", "postalCode": "97201" }));
        assert_eq!(
            engine().calculate(&req, "t".into()).warnings,
            Vec::<String>::new()
        );
    }
}
