//! The manual sales tax engine (`manual-engine.ts`): rates, zones and
//! taxability rules the user keeps. Per line and per agency it works out the
//! taxable, exempt and non-taxable parts, multiplies the taxable part by each
//! jurisdiction's rate at the tax point and rounds per the state's rule. Tax
//! is charged only where the entity is registered on the document date.
//!
//! Sales only (orders never ask for use tax), without hand-set overrides.

use super::rounding::{TaxCell, from_cents, round_tax_cells, snap6, to_cents};
use super::{
    Detail, LineResult, Registration, RequestLine, Side, TaxRequest, TaxResult, TaxUse, Zone,
    active_registrations, build_result, certificate_for_sale, decide_sourcing, in_range,
    is_us_country, iso_day, pick_destination_zone, pick_origin_zone, spread_tax,
    state_has_no_sales_tax, untaxed_line, untaxed_result, zip5_of,
};

const LEVELS: [&str; 4] = ["state", "county", "city", "district"];

fn level_rank(level: &str) -> usize {
    LEVELS.iter().position(|l| *l == level).unwrap_or(3)
}

/// A rate and when it applies.
#[derive(Debug, Clone)]
#[allow(clippy::struct_field_names)] // `rate`, as the data names it
pub(crate) struct Rate {
    pub(crate) rate: f64,
    pub(crate) effective_from: String,
    pub(crate) effective_to: Option<String>,
}

/// `ManualJurisdiction`.
#[derive(Debug, Clone)]
pub(crate) struct Jurisdiction {
    pub(crate) id: String,
    pub(crate) agency_id: String,
    pub(crate) state_code: String,
    pub(crate) level: &'static str,
    pub(crate) code: Option<String>,
    pub(crate) name: String,
    pub(crate) rates: Vec<Rate>,
}

/// `ManualTaxabilityRule`; `applies_to_use` `None` is `any`.
#[derive(Debug, Clone)]
pub(crate) struct Rule {
    pub(crate) agency_id: String,
    pub(crate) tax_code: String,
    pub(crate) taxable: bool,
    pub(crate) taxable_percent: f64,
    pub(crate) applies_to_use: Option<TaxUse>,
    pub(crate) rate_override: Option<f64>,
    pub(crate) effective_from: String,
    pub(crate) effective_to: Option<String>,
}

/// `ManualEngineData`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Data {
    pub(crate) jurisdictions: Vec<Jurisdiction>,
    pub(crate) zones: Vec<Zone>,
    pub(crate) rules: Vec<Rule>,
}

/// `createManualEngine(data)`.
pub(crate) struct Engine {
    data: Data,
}

/// The rate in force on the tax point; `None` when the jurisdiction has none that day.
fn rate_at(jurisdiction: &Jurisdiction, date: &str) -> Option<f64> {
    let mut rates: Vec<&Rate> = jurisdiction
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
    rules: &[&'a Rule],
    tax_code: &str,
    tax_use: TaxUse,
    date: &str,
) -> Option<&'a Rule> {
    let code = weldsuite_kit::validation::js_trim(tax_code).to_lowercase();
    let mut found: Vec<&Rule> = rules
        .iter()
        .copied()
        .filter(|r| {
            weldsuite_kit::validation::js_trim(&r.tax_code).to_lowercase() == code
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
    jurisdiction: &'a Jurisdiction,
    rate: f64,
}

struct AgencyPlan<'a> {
    agency_id: String,
    jurisdictions: Vec<Planned<'a>>,
    rules: Vec<&'a Rule>,
}

struct AgencyLine<'p, 'a> {
    plan: &'p AgencyPlan<'a>,
    rates: Vec<f64>,
    taxable_cents: i64,
    exempt_cents: i64,
    non_taxable_cents: i64,
}

struct LineWork<'p, 'a> {
    line: &'p RequestLine,
    fixed_tax_cents: Option<i64>,
    agencies: Vec<AgencyLine<'p, 'a>>,
    exempt: Option<(String, String)>,
}

/// Tax before rounding, at full precision.
fn exact_tax(taxable_cents: i64, rate_percent: f64) -> f64 {
    (from_cents(taxable_cents) * rate_percent) / 100.0
}

fn sum(values: &[f64]) -> f64 {
    values.iter().fold(0.0, |a, b| a + b)
}

/// A rule's override replaces the agency's combined rate; the
/// jurisdictions keep their shares of it.
fn effective_rates(plan: &AgencyPlan<'_>, rate_override: Option<f64>) -> Vec<f64> {
    let rates: Vec<f64> = plan.jurisdictions.iter().map(|j| j.rate).collect();
    let Some(rate_override) = rate_override else {
        return rates;
    };
    let total = sum(&rates);
    if total <= 0.0 {
        return rates
            .iter()
            .enumerate()
            .map(|(i, _)| if i == 0 { snap6(rate_override) } else { 0.0 })
            .collect();
    }
    rates
        .iter()
        .map(|r| snap6((r * rate_override) / total))
        .collect()
}

fn clamp_percent(value: f64) -> f64 {
    if !value.is_finite() {
        return 100.0;
    }
    value.clamp(0.0, 100.0)
}

impl Engine {
    pub(crate) fn new(data: Data) -> Self {
        Self { data }
    }

    /// The jurisdictions of one agency that apply to this sale, by
    /// sourcing level, and whether a zone was missing.
    fn plan_agency<'a>(
        &'a self,
        agency_id: &str,
        req: &TaxRequest,
        date: &str,
        level_source: [Side; 4],
    ) -> (Vec<Planned<'a>>, bool) {
        let zones: Vec<&'a Zone> = self
            .data
            .zones
            .iter()
            .filter(|z| z.agency_id == agency_id)
            .collect();
        let all: Vec<&'a Jurisdiction> = self
            .data
            .jurisdictions
            .iter()
            .filter(|j| j.agency_id == agency_id)
            .collect();
        let dest_zip = zip5_of(req.ship_to.as_ref());
        let origin_zip = zip5_of(req.ship_from.as_ref());
        let origin_zone = pick_origin_zone(&zones, origin_zip.as_deref());
        let destination_zone = pick_destination_zone(&zones, dest_zip.as_deref());

        let mut picked: Vec<&'a Jurisdiction> = Vec::new();
        // `picked.set(j.id, j)`: a known id keeps its place.
        let pick = |j: &'a Jurisdiction, picked: &mut Vec<&'a Jurisdiction>| match picked
            .iter()
            .position(|p| p.id == j.id)
        {
            Some(i) => picked[i] = j,
            None => picked.push(j),
        };
        let mut zone_missing = false;
        for (index, level) in LEVELS.iter().enumerate() {
            let zone = match level_source[index] {
                Side::Origin => origin_zone,
                Side::Destination => destination_zone,
            };
            if let Some(zone) = zone {
                for id in &zone.jurisdiction_ids {
                    // `byId` keeps the last jurisdiction with an id.
                    if let Some(j) = self.data.jurisdictions.iter().rev().find(|j| &j.id == id)
                        && j.agency_id == agency_id
                        && j.level == *level
                    {
                        pick(j, &mut picked);
                    }
                }
            } else {
                zone_missing = true;
                if *level == "state" {
                    for j in all.iter().copied().filter(|j| j.level == "state") {
                        pick(j, &mut picked);
                    }
                }
            }
        }

        let needs_zones = !zones.is_empty() || all.iter().any(|j| j.level != "state");
        let mut planned: Vec<Planned<'a>> = picked
            .into_iter()
            .filter_map(|j| {
                rate_at(j, date).map(|rate| Planned {
                    jurisdiction: j,
                    rate,
                })
            })
            .collect();
        planned.sort_by_key(|p| level_rank(p.jurisdiction.level));
        (planned, zone_missing && needs_zones)
    }

    /// `engine.calculate(req)`; `calculated_at` is `now().toISOString()`.
    #[allow(clippy::too_many_lines)] // the TypeScript function, step by step
    pub(crate) fn calculate(&self, req: &TaxRequest, calculated_at: String) -> TaxResult {
        let date = iso_day(&req.document_date);
        let Some(decision) = decide_sourcing(req.ship_from.as_ref(), req.ship_to.as_ref()) else {
            return untaxed_result(req, &["no_ship_to"], calculated_at, None);
        };
        let state = decision.taxing_state.clone();
        if req.marketplace_facilitated {
            return untaxed_result(
                req,
                &["marketplace_facilitated"],
                calculated_at,
                Some(state),
            );
        }
        if !is_us_country(req.ship_to.as_ref()) {
            return untaxed_result(req, &[], calculated_at, None);
        }

        let registered = active_registrations(&req.registrations, &state, &date);
        if registered.is_empty() {
            let warnings: &[&str] = if state_has_no_sales_tax(&state) {
                &[]
            } else {
                &["not_registered_in_state"]
            };
            return untaxed_result(req, warnings, calculated_at, Some(state));
        }
        let agency_ids = order_agencies(&registered, &req.registrations);

        let mut warnings: Vec<String> = Vec::new();
        let mut plans: Vec<AgencyPlan<'_>> = Vec::new();
        let mut zone_missing = false;
        for agency_id in agency_ids {
            let (jurisdictions, missing) =
                self.plan_agency(&agency_id, req, &date, decision.level_source);
            zone_missing = zone_missing || missing;
            if jurisdictions.is_empty() {
                continue;
            }
            plans.push(AgencyPlan {
                rules: self
                    .data
                    .rules
                    .iter()
                    .filter(|r| r.agency_id == agency_id)
                    .collect(),
                agency_id,
                jurisdictions,
            });
        }
        if zone_missing {
            warnings.push("zone_not_found".to_owned());
            warnings.push("address_unverified".to_owned());
        }
        if plans.is_empty() {
            warnings.push("rates_not_configured".to_owned());
            return build_result(
                req,
                decision.sourcing,
                req.lines.iter().map(untaxed_line).collect(),
                &warnings,
                Some(state),
                calculated_at,
            );
        }

        let (certificate, warning) = certificate_for_sale(req, &state, &date);
        if let Some(warning) = warning {
            warnings.push(warning.to_owned());
        }
        let certificate = certificate.map(|c| (c.reason.clone(), c.id.clone()));

        let work: Vec<LineWork<'_, '_>> = req
            .lines
            .iter()
            .map(|line| work_line(line, &plans, &date, certificate.as_ref()))
            .collect();

        // Rounding groups: every line that has no fixed tax.
        let mut cells: Vec<TaxCell> = Vec::new();
        let mut refs: Vec<(usize, usize, usize)> = Vec::new();
        for (li, w) in work.iter().enumerate() {
            if w.fixed_tax_cents.is_some() {
                continue;
            }
            for (ai, a) in w.agencies.iter().enumerate() {
                for (ji, j) in a.plan.jurisdictions.iter().enumerate() {
                    cells.push(TaxCell {
                        jurisdiction_key: j.jurisdiction.id.clone(),
                        unrounded: exact_tax(a.taxable_cents, a.rates[ji]),
                    });
                    refs.push((li, ai, ji));
                }
            }
        }
        let rounded = round_tax_cells(&cells);
        let cents_of = |li: usize, ai: usize, ji: usize| {
            refs.iter()
                .position(|r| *r == (li, ai, ji))
                .map_or(0, |k| rounded[k])
        };

        let lines: Vec<LineResult> = work
            .iter()
            .enumerate()
            .map(|(li, w)| {
                let flat: Vec<(&AgencyLine<'_, '_>, usize, usize)> = w
                    .agencies
                    .iter()
                    .enumerate()
                    .flat_map(|(ai, a)| (0..a.plan.jurisdictions.len()).map(move |ji| (a, ai, ji)))
                    .collect();
                let parts: Vec<i64> = match w.fixed_tax_cents {
                    Some(fixed) => spread_tax(
                        fixed,
                        &flat
                            .iter()
                            .map(|(a, _, ji)| exact_tax(a.taxable_cents, a.rates[*ji]))
                            .collect::<Vec<_>>(),
                        &flat
                            .iter()
                            .map(|(a, _, ji)| a.rates[*ji])
                            .collect::<Vec<_>>(),
                    ),
                    None => flat
                        .iter()
                        .map(|(_, ai, ji)| cents_of(li, *ai, *ji))
                        .collect(),
                };
                let details: Vec<Detail> = flat
                    .iter()
                    .enumerate()
                    .map(|(k, (a, _, ji))| {
                        let j = a.plan.jurisdictions[*ji].jurisdiction;
                        let exempt = a.exempt_cents > 0;
                        let (exempt_reason, certificate_id) = match (&w.exempt, exempt) {
                            (Some((reason, id)), true) => (Some(reason.clone()), Some(id.clone())),
                            _ => (None, None),
                        };
                        Detail {
                            jurisdiction_code: j.code.clone().unwrap_or_else(|| j.id.clone()),
                            jurisdiction_name: j.name.clone(),
                            level: j.level,
                            state_code: j.state_code.to_uppercase(),
                            agency_id: Some(a.plan.agency_id.clone()),
                            rate: a.rates[*ji],
                            taxable_amount: from_cents(a.taxable_cents),
                            tax: from_cents(parts[k]),
                            exempt_reason,
                            certificate_id,
                        }
                    })
                    .collect();
                let primary = &w.agencies[0];
                LineResult {
                    line_id: w.line.line_id.clone(),
                    taxable_amount: from_cents(primary.taxable_cents),
                    exempt_amount: from_cents(primary.exempt_cents),
                    non_taxable_amount: from_cents(primary.non_taxable_cents),
                    tax: from_cents(parts.iter().sum()),
                    details,
                }
            })
            .collect();

        build_result(
            req,
            decision.sourcing,
            lines,
            &warnings,
            Some(state),
            calculated_at,
        )
    }
}

/// `orderAgencies`: the registered agencies once each, state-level first.
fn order_agencies(registered: &[&Registration], registrations: &[Registration]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for r in registered {
        if !ids.contains(&r.agency_id) {
            ids.push(r.agency_id.clone());
        }
    }
    // `new Map(registrations.map(...))`: the last registration of an agency wins.
    let local = |id: &str| {
        registrations
            .iter()
            .rev()
            .find(|r| r.agency_id == id)
            .is_some_and(|r| r.local)
    };
    ids.sort_by_key(|id| local(id));
    ids
}

fn work_line<'p, 'a>(
    line: &'p RequestLine,
    plans: &'p [AgencyPlan<'a>],
    date: &str,
    certificate: Option<&(String, String)>,
) -> LineWork<'p, 'a> {
    let never_taxed = line.tax_code == "non_taxable";
    let amount_cents = to_cents(line.amount);

    let prelim: Vec<(&AgencyPlan<'a>, f64, Vec<f64>)> = plans
        .iter()
        .map(|plan| {
            let rule = if never_taxed {
                None
            } else {
                rule_at(&plan.rules, &line.tax_code, line.tax_use, date)
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
            (plan, share, rates)
        })
        .collect();

    // A tax-inclusive price holds the tax: back it out so net + tax = the price.
    let mut gross_cents = amount_cents;
    let mut fixed_tax_cents = None;
    if line.tax_included {
        let factor = if certificate.is_some() {
            0.0
        } else {
            prelim
                .iter()
                .fold(0.0, |total, (_, share, rates)| total + share * sum(rates))
                / 100.0
        };
        gross_cents = to_cents(from_cents(amount_cents) / (1.0 + factor));
        fixed_tax_cents = Some(amount_cents - gross_cents);
    }

    let agencies: Vec<AgencyLine<'p, 'a>> = prelim
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
        fixed_tax_cents,
        agencies,
        exempt: certificate.filter(|_| exempted).cloned(),
    }
}
