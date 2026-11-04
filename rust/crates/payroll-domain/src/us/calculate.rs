//! The US payslip engine (`us/calculate.ts`), line for line.

use serde_json::{Map, Value, json};

use crate::PayrollError;
use crate::js::{math_round, number_of, number_text};
use crate::money::{Cents, js_max, js_min, percent_of, round_half_away_from_zero};
use crate::ordered::OrderedMap;
use crate::periods::{add_days, age_on, weekdays_between};
use crate::types::{
    CompensationInput, CompensationPeriod, FilingData, FlsaStatus, PayFrequency, PayType,
    PayrollIssue, PayslipLine, PayslipResult, ProgramFiling, Section, UsFederalFiling,
    UsFilingData, UsPayslipInput, UsStateFiling,
};
use crate::us::federal_rules::{FederalRules, federal_rules, futa_credit_reduction_percent};
use crate::us::overtime::{
    HoursEntry, OvertimeInput, OvertimeKind, compute_overtime, workweek_start,
};
use crate::us::states::common::{Pretax, StateCalcInput};
use crate::us::states::{
    calculate_state, state_income_tax_label_key, state_sui_employee_label_key,
    state_sui_employer_label_key,
};
use crate::us::withholding::{
    SupplementalArgs, effective_w4, nra_addition_cents, supplemental_withholding, worksheet_1a,
};
use crate::us::ytd::keys;

const FICA_BASES: [&str; 4] = [
    "us.fit_wages",
    "us.ss_wages",
    "us.medicare_wages",
    "us.futa_wages",
];
const TIP_BASES: [&str; 4] = [
    "us.fit_wages",
    "us.ss_tips",
    "us.medicare_wages",
    "us.futa_wages",
];

const US_CODES: &[&str] = &[
    "hours.regular",
    "hours.overtime",
    "hours.unpaid_leave",
    "hours.paid_leave",
    "bonus",
    "commission",
    "allowance.taxable",
    "reimbursement",
    "deduction.net",
    "advance",
    "us.tips_cash",
    "us.401k",
    "us.roth_401k",
    "us.401k_employer_match",
    "us.section125_health",
    "us.employer_health",
    "us.hsa",
    "us.dependent_care",
];

#[derive(Debug, Clone)]
struct Item {
    code: String,
    label: Option<String>,
    quantity: Option<f64>,
    rate: Option<f64>,
    amount_cents: Option<Cents>,
    work_date: Option<String>,
    params: Map<String, Value>,
}

fn items_of(input: &UsPayslipInput) -> Vec<Item> {
    let components = input.components.iter().map(|c| Item {
        code: c.code.clone(),
        label: c.label.clone().flatten(),
        quantity: None,
        rate: None,
        amount_cents: c.amount_cents,
        work_date: None,
        params: c.params.clone(),
    });
    let inputs = input.inputs.iter().map(|i| Item {
        code: i.code.clone(),
        label: i.label.clone().flatten(),
        quantity: i.quantity,
        rate: i.rate,
        amount_cents: i.amount_cents,
        work_date: i.work_date.clone(),
        params: Map::new(),
    });
    components.chain(inputs).collect()
}

/// `num(v)`.
fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64().filter(|x| x.is_finite()),
        Value::String(s) if !crate::js::js_trim(s).is_empty() => {
            Some(number_of(s)).filter(|x| x.is_finite())
        }
        _ => None,
    }
}

fn annual_cents(comp: &CompensationInput) -> f64 {
    let amount = comp.amount * 100.0;
    match comp.period {
        CompensationPeriod::Year => amount,
        CompensationPeriod::Month => amount * 12.0,
        CompensationPeriod::Week => amount * 52.0,
        CompensationPeriod::Hour => amount * comp.hours_per_week.unwrap_or(40.0) * 52.0,
    }
}

/// `comp.hoursPerWeek && comp.hoursPerWeek > 0 ? comp.hoursPerWeek : 40`.
fn usual_hours(comp: &CompensationInput) -> f64 {
    comp.hours_per_week.filter(|h| *h > 0.0).unwrap_or(40.0)
}

fn hourly_rate_cents(comp: Option<&CompensationInput>) -> Option<f64> {
    let comp = comp?;
    if !comp.amount.is_finite() {
        return None;
    }
    if comp.period == CompensationPeriod::Hour {
        return Some(comp.amount * 100.0);
    }
    Some(annual_cents(comp) / (usual_hours(comp) * 52.0))
}

fn salary_per_period_cents(comp: &CompensationInput, input: &UsPayslipInput) -> f64 {
    let f = input.period.frequency;
    let amount = comp.amount * 100.0;
    match (comp.period, f) {
        (CompensationPeriod::Week, PayFrequency::Weekly)
        | (CompensationPeriod::Month, PayFrequency::Monthly) => amount,
        (CompensationPeriod::Week, PayFrequency::Biweekly) => amount * 2.0,
        (CompensationPeriod::Month, PayFrequency::Semimonthly) => amount / 2.0,
        _ => annual_cents(comp) / input.period.periods_per_year as f64,
    }
}

/// `employmentFactor(input)`: (factor, worked, total), `None` for a full period.
fn employment_factor(input: &UsPayslipInput) -> Result<Option<(f64, i64, i64)>, PayrollError> {
    let (start, end) = (input.period.start.as_str(), input.period.end.as_str());
    let from = match input.employee.start_date.as_deref() {
        Some(s) if !s.is_empty() && s > start => s,
        _ => start,
    };
    let to = match input.employee.end_date.as_deref() {
        Some(e) if !e.is_empty() && e < end => e,
        _ => end,
    };
    if from == start && to == end {
        return Ok(None);
    }
    let total = weekdays_between(start, end)?;
    let worked = if from > to {
        0
    } else {
        weekdays_between(from, to)?
    };
    let factor = if total > 0 {
        worked as f64 / total as f64
    } else {
        0.0
    };
    Ok(Some((factor, worked, total)))
}

fn elective_deferral_limit(
    rules: &FederalRules,
    input: &UsPayslipInput,
) -> Result<Cents, PayrollError> {
    let base = rules.retirement.elective_deferral_cents;
    let Some(dob) = input
        .employee
        .date_of_birth
        .as_deref()
        .filter(|d| !d.is_empty())
    else {
        return Ok(base);
    };
    let age = age_on(dob, &format!("{}-12-31", input.period.tax_year))?;
    Ok(if (60..=63).contains(&age) {
        base + rules.retirement.catch_up60_to63_cents
    } else if age >= 50 {
        base + rules.retirement.catch_up50_cents
    } else {
        base
    })
}

fn cumulative_tax(this_cents: Cents, ytd_base: Cents, ytd_tax: Cents, rate_percent: f64) -> Cents {
    if this_cents <= 0.0 {
        return 0.0;
    }
    let simple = percent_of(this_cents, rate_percent);
    let cumulative = percent_of(ytd_base + this_cents, rate_percent) - ytd_tax;
    if (cumulative - simple).abs() <= 1.0 && cumulative >= 0.0 {
        cumulative
    } else {
        simple
    }
}

fn empty_filing() -> UsFilingData {
    UsFilingData {
        federal: UsFederalFiling::default(),
        states: OrderedMap::new(),
        qualified_overtime_premium: 0.0,
        hours_worked: 0.0,
    }
}

fn blocked_result(
    input: &UsPayslipInput,
    issues: Vec<PayrollIssue>,
    rule_set: &str,
) -> PayslipResult {
    PayslipResult {
        lines: vec![],
        gross_cents: 0.0,
        taxable_wage_cents: 0.0,
        employee_taxes_cents: 0.0,
        employee_deductions_cents: 0.0,
        reimbursements_cents: 0.0,
        net_cents: 0.0,
        employer_taxes_cents: 0.0,
        employer_cost_cents: 0.0,
        ytd: input.ytd.clone(),
        filing_data: FilingData::Us(Box::new(empty_filing())),
        issues,
        rule_set: rule_set.to_owned(),
    }
}

fn overtime_label(kind: OvertimeKind) -> &'static str {
    match kind {
        OvertimeKind::OvertimePremium => "us.overtime_premium",
        OvertimeKind::DoubleTimePremium => "us.double_time_premium",
        OvertimeKind::Overtime => "us.overtime",
        OvertimeKind::DoubleTime => "us.double_time",
    }
}

fn round2(n: f64) -> f64 {
    math_round(n * 100.0) / 100.0
}

#[allow(clippy::unnecessary_wraps)] // the `bases` field is optional
fn bases(list: &[&str]) -> Option<Vec<String>> {
    Some(list.iter().map(|b| (*b).to_owned()).collect())
}

fn line(code: &str, section: Section, label_key: &str, amount: Cents) -> PayslipLine {
    PayslipLine::new(code, section, label_key, amount)
}

fn federal(mut l: PayslipLine) -> PayslipLine {
    l.jurisdiction = Some(Some("federal".into()));
    l
}

/// `qty || null`.
fn truthy(q: f64) -> Option<f64> {
    (q != 0.0 && !q.is_nan()).then_some(q)
}

fn n(v: f64) -> Value {
    crate::js::number_value(v)
}

struct RateGroup {
    key: f64,
    hours: f64,
    cents: Cents,
    label: Option<String>,
}

/// `calculateUsPayslip(input)`.
pub fn calculate_us_payslip(input: &UsPayslipInput) -> Result<PayslipResult, PayrollError> {
    let mut issues: Vec<PayrollIssue> = vec![];
    let period = &input.period;
    let Some(rules) = federal_rules(period.tax_year) else {
        let issue =
            PayrollIssue::error("unsupported_tax_year").with(&[("year", json!(period.tax_year))]);
        return Ok(blocked_result(input, vec![issue], "us-none"));
    };
    if period.frequency == PayFrequency::FourWeekly {
        let issue = PayrollIssue::error("unsupported_frequency")
            .with(&[("frequency", json!(period.frequency.as_str()))]);
        return Ok(blocked_result(input, vec![issue], &rules.rule_set));
    }
    if rules.provisional {
        issues.push(
            PayrollIssue::warning("provisional_rules")
                .with(&[("items", json!(rules.provisional_items.join(", ")))]),
        );
    }
    let mut lines: Vec<PayslipLine> = vec![];
    let mut ytd = input.ytd.clone();
    let ytd_of = |key: &str| -> Cents { input.ytd.get(key).copied().unwrap_or(0.0) };
    let comp = input.compensation.as_ref();
    let salaried = comp.is_some_and(|c| c.pay_type == PayType::Salary);
    let nonexempt = input.us.flsa_status == FlsaStatus::Nonexempt;
    let work_state = input
        .us
        .work_state
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_uppercase);
    let california = work_state.as_deref() == Some("CA");
    let base_rate = hourly_rate_cents(comp);
    let items = items_of(input);

    let mut salary_cents = 0.0;
    let mut hourly_cents = 0.0;
    let mut overtime_cents = 0.0;
    let mut manual_overtime_cents = 0.0;
    let mut paid_leave_cents = 0.0;
    let mut unpaid_leave_cents = 0.0;
    let mut allowance_cents = 0.0;
    let mut bonus_cents = 0.0;
    let mut commission_cents = 0.0;
    let mut tips_cents = 0.0;
    let mut reimbursement_cents = 0.0;
    let mut advance_cents = 0.0;
    let mut deduction_net_cents = 0.0;
    let mut hours_worked = 0.0;

    if comp.is_none()
        && items
            .iter()
            .any(|i| i.code == "hours.regular" && i.rate.is_none() && i.amount_cents.is_none())
    {
        issues.push(PayrollIssue::error("missing_compensation"));
    }
    if let (true, Some(c)) = (salaried, comp) {
        let partial = employment_factor(input)?;
        let full = salary_per_period_cents(c, input);
        salary_cents = round_half_away_from_zero(match partial {
            Some((factor, _, _)) => full * factor,
            None => full,
        });
        if let Some((_, worked, total)) = partial {
            issues.push(
                PayrollIssue::warning("partial_period")
                    .with(&[("workedDays", json!(worked)), ("periodDays", json!(total))]),
            );
        }
        if salary_cents > 0.0 {
            let mut l = federal(line(
                "us.salary",
                Section::Earning,
                "us.salary",
                salary_cents,
            ));
            l.bases = bases(&FICA_BASES);
            lines.push(l);
        }
    }

    let mut hourly_by_rate: Vec<RateGroup> = vec![];
    let mut overtime_entries: Vec<HoursEntry> = vec![];
    let single_workweek = period.frequency == PayFrequency::Weekly
        && workweek_start(&period.start, input.employer.workweek_start_day)? == period.start;
    let dated_or_null = |date: &Option<String>| -> Option<String> {
        date.clone()
            .or_else(|| single_workweek.then(|| period.start.clone()))
    };
    let salaried_regular_rate = match (salaried, comp) {
        (true, Some(c)) => {
            Some(annual_cents(c) / 52.0 / if california { 40.0 } else { usual_hours(c) })
        }
        _ => None,
    };
    for item in &items {
        if !US_CODES.contains(&item.code.as_str()) {
            issues.push(
                PayrollIssue::error("unsupported_component").with(&[("code", json!(item.code))]),
            );
            continue;
        }
        let qty = item.quantity.unwrap_or(0.0);
        match item.code.as_str() {
            "hours.regular" => {
                hours_worked += qty;
                let rate_cents = match item.rate {
                    Some(r) => Some(r * 100.0),
                    None if salaried => salaried_regular_rate,
                    None => base_rate,
                };
                let date = dated_or_null(&item.work_date).filter(|d| !d.is_empty());
                if let (true, Some(date), true, Some(rate)) =
                    (nonexempt, date, qty > 0.0, rate_cents)
                {
                    overtime_entries.push(HoursEntry {
                        date,
                        hours: qty,
                        rate_cents: rate,
                        multiplier: None,
                    });
                }
                if salaried || (rate_cents.is_none() && item.amount_cents.is_none()) {
                    continue;
                }
                let cents = item.amount_cents.unwrap_or_else(|| {
                    round_half_away_from_zero(qty * rate_cents.unwrap_or(f64::NAN))
                });
                let key = rate_cents.unwrap_or(-1.0);
                let same = |k: f64| k == key || (k.is_nan() && key.is_nan());
                match hourly_by_rate.iter_mut().find(|g| same(g.key)) {
                    Some(group) => {
                        group.hours += qty;
                        group.cents += cents;
                    }
                    None => hourly_by_rate.push(RateGroup {
                        key,
                        hours: qty,
                        cents,
                        label: item.label.clone(),
                    }),
                }
                hourly_cents += cents;
            }
            "hours.overtime" => {
                hours_worked += qty;
                let multiplier = item.rate.unwrap_or(150.0) / 100.0;
                let rate_cents = if salaried {
                    salaried_regular_rate
                } else {
                    base_rate
                };
                let cents = item.amount_cents.unwrap_or_else(|| {
                    rate_cents.map_or(0.0, |r| round_half_away_from_zero(qty * r * multiplier))
                });
                let date = dated_or_null(&item.work_date).filter(|d| !d.is_empty());
                if let (true, Some(date), true, Some(rate)) =
                    (nonexempt, date, qty > 0.0, rate_cents)
                {
                    overtime_entries.push(HoursEntry {
                        date,
                        hours: qty,
                        rate_cents: rate,
                        multiplier: Some(multiplier),
                    });
                }
                manual_overtime_cents += cents;
                let mut l = federal(line(
                    "hours.overtime",
                    Section::Earning,
                    "us.overtime_manual",
                    cents,
                ));
                l.label = Some(item.label.clone());
                l.quantity = Some(truthy(qty));
                l.rate = Some(rate_cents.map(|r| round2((r * multiplier) / 100.0)));
                l.bases = bases(&FICA_BASES);
                lines.push(l);
            }
            "hours.paid_leave" => {
                let rate_cents = item.rate.map(|r| r * 100.0).or(base_rate);
                let cents = if salaried {
                    item.amount_cents.unwrap_or(0.0)
                } else {
                    item.amount_cents.unwrap_or_else(|| {
                        rate_cents.map_or(0.0, |r| round_half_away_from_zero(qty * r))
                    })
                };
                paid_leave_cents += cents;
                let section = if cents != 0.0 {
                    Section::Earning
                } else {
                    Section::Info
                };
                let mut l = federal(line("hours.paid_leave", section, "us.paid_leave", cents));
                l.label = Some(item.label.clone());
                l.quantity = Some(truthy(qty));
                l.rate = Some(if salaried {
                    None
                } else {
                    rate_cents.map(|r| round2(r / 100.0))
                });
                l.bases = if cents != 0.0 {
                    bases(&FICA_BASES)
                } else {
                    None
                };
                lines.push(l);
            }
            "hours.unpaid_leave" => {
                let rate_cents = item.rate.map(|r| r * 100.0).or(base_rate);
                let cents = if salaried {
                    js_min(
                        salary_cents - unpaid_leave_cents,
                        item.amount_cents.unwrap_or_else(|| {
                            rate_cents.map_or(0.0, |r| round_half_away_from_zero(qty * r))
                        }),
                    )
                } else {
                    0.0
                };
                unpaid_leave_cents += js_max(0.0, cents);
                let section = if cents > 0.0 {
                    Section::Earning
                } else {
                    Section::Info
                };
                let mut l = federal(line(
                    "hours.unpaid_leave",
                    section,
                    "us.unpaid_leave",
                    if cents > 0.0 { -cents } else { 0.0 },
                ));
                l.label = Some(item.label.clone());
                l.quantity = Some(truthy(qty));
                l.rate = Some(if salaried {
                    rate_cents.map(|r| round2(r / 100.0))
                } else {
                    None
                });
                l.bases = if cents > 0.0 {
                    bases(&FICA_BASES)
                } else {
                    None
                };
                lines.push(l);
            }
            "bonus" | "commission" | "allowance.taxable" => {
                let cents = item.amount_cents.unwrap_or(0.0);
                if cents == 0.0 {
                    continue;
                }
                let label_key = match item.code.as_str() {
                    "bonus" => {
                        bonus_cents += cents;
                        "us.bonus"
                    }
                    "commission" => {
                        commission_cents += cents;
                        "us.commission"
                    }
                    _ => {
                        allowance_cents += cents;
                        "us.allowance_taxable"
                    }
                };
                let mut l = federal(line(&item.code, Section::Earning, label_key, cents));
                l.label = Some(item.label.clone());
                l.bases = bases(&FICA_BASES);
                lines.push(l);
            }
            "us.tips_cash" => {
                let cents = item.amount_cents.unwrap_or(0.0);
                if cents == 0.0 {
                    continue;
                }
                tips_cents += cents;
                let mut l = federal(line(
                    "us.tips_cash",
                    Section::Earning,
                    "us.tips_cash",
                    cents,
                ));
                l.label = Some(item.label.clone());
                l.bases = bases(&TIP_BASES);
                lines.push(l);
            }
            "reimbursement" | "advance" => {
                let cents = item.amount_cents.unwrap_or(0.0);
                if cents == 0.0 {
                    continue;
                }
                if item.code == "reimbursement" {
                    reimbursement_cents += cents;
                } else {
                    advance_cents += cents;
                }
                let mut l = line(
                    &item.code,
                    Section::Reimbursement,
                    &format!("us.{}", item.code),
                    cents,
                );
                l.label = Some(item.label.clone());
                lines.push(l);
            }
            "deduction.net" => {
                let cents = item.amount_cents.unwrap_or(0.0).abs();
                if cents == 0.0 {
                    continue;
                }
                deduction_net_cents += cents;
                let mut l = line(
                    "deduction.net",
                    Section::Deduction,
                    "us.deduction_net",
                    -cents,
                );
                l.label = Some(item.label.clone());
                lines.push(l);
            }
            _ => {}
        }
    }
    hourly_by_rate.sort_by(|a, b| {
        a.key
            .partial_cmp(&b.key)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for group in &hourly_by_rate {
        let mut l = federal(line(
            "hours.regular",
            Section::Earning,
            "us.regular_hours",
            group.cents,
        ));
        l.label = Some(group.label.clone());
        l.quantity = Some(Some(round2(group.hours)));
        l.rate = Some((group.key >= 0.0).then(|| round2(group.key / 100.0)));
        l.bases = bases(&FICA_BASES);
        lines.push(l);
    }
    if comp.is_some_and(|c| c.pay_type == PayType::Hourly)
        && hourly_cents == 0.0
        && manual_overtime_cents == 0.0
        && paid_leave_cents == 0.0
    {
        issues.push(PayrollIssue::warning("no_hours"));
    }

    let mut qualified_overtime_cents = 0.0;
    if nonexempt {
        let ot = compute_overtime(&OvertimeInput {
            entries: &overtime_entries,
            period_start: &period.start,
            period_end: &period.end,
            workweek_start_day: input.employer.workweek_start_day,
            california,
            salaried_regular_rate_cents: if salaried {
                salaried_regular_rate
            } else {
                None
            },
            ytd: &input.ytd,
        })?;
        let mut merged: Vec<(String, PayslipLine)> = vec![];
        for l in &ot.lines {
            overtime_cents += l.amount_cents;
            let rate_shown = l.rate.map(round2);
            let key = format!(
                "{}|{}",
                l.kind.as_str(),
                rate_shown.map(number_text).unwrap_or_default()
            );
            if let Some((_, prev)) = merged.iter_mut().find(|(k, _)| *k == key) {
                prev.amount_cents += l.amount_cents;
                let previous = prev.quantity.flatten();
                prev.quantity = Some(match (previous, l.hours) {
                    (Some(p), Some(h)) => Some(round2(p + h)),
                    _ => None,
                });
                continue;
            }
            let mut out = line(
                "hours.overtime",
                Section::Earning,
                overtime_label(l.kind),
                l.amount_cents,
            );
            out.quantity = Some(l.hours);
            out.rate = Some(rate_shown);
            out.bases = bases(&FICA_BASES);
            let double = matches!(
                l.kind,
                OvertimeKind::DoubleTime | OvertimeKind::DoubleTimePremium
            );
            out.jurisdiction = Some(Some(
                if california && double {
                    "CA"
                } else {
                    "federal"
                }
                .to_owned(),
            ));
            merged.push((key, out));
        }
        lines.extend(merged.into_iter().map(|(_, l)| l));
        qualified_overtime_cents = ot.qualified_overtime_cents;
        for key in &ot.settled_carry_keys {
            ytd.remove(key);
        }
        for (key, value) in ot.carry_out.iter() {
            ytd.insert(key.clone(), *value);
        }
    }

    let supplemental_cents = bonus_cents + commission_cents;
    let gross_cents = salary_cents - unpaid_leave_cents
        + hourly_cents
        + overtime_cents
        + manual_overtime_cents
        + paid_leave_cents
        + allowance_cents
        + supplemental_cents
        + tips_cents;
    let regular_gross_cents = gross_cents - supplemental_cents;
    let wages_ex_tips_cents = gross_cents - tips_cents;
    let sum_amount = |code: &str| -> Cents {
        items
            .iter()
            .filter(|i| i.code == code)
            .fold(0.0, |s, i| s + js_max(0.0, i.amount_cents.unwrap_or(0.0)))
    };
    let percent_param = |code: &str, key: &str| -> Option<f64> {
        items
            .iter()
            .find(|i| i.code == code && i.amount_cents.is_none())
            .and_then(|i| num(i.params.get(key)))
    };
    let requested = |code: &str| -> Cents {
        sum_amount(code)
            + percent_param(code, "percent").map_or(0.0, |pct| percent_of(wages_ex_tips_cents, pct))
    };
    let deferral_room = js_max(
        0.0,
        elective_deferral_limit(rules, input)? - ytd_of(keys::K401) - ytd_of(keys::ROTH401K),
    );
    let k401_cents = js_min(
        js_min(requested("us.401k"), deferral_room),
        js_max(0.0, wages_ex_tips_cents),
    );
    let roth401k_cents = js_min(
        js_min(requested("us.roth_401k"), deferral_room - k401_cents),
        js_max(0.0, wages_ex_tips_cents - k401_cents),
    );
    let section125_cents = sum_amount("us.section125_health");
    let hsa_cents = sum_amount("us.hsa");
    let dependent_care_cents = sum_amount("us.dependent_care");
    let ytd_dependent_care = ytd_of(keys::DEPENDENT_CARE);
    let exclusion = rules.dependent_care_exclusion_cents;
    let dependent_care_excluded_cents =
        js_min(ytd_dependent_care + dependent_care_cents, exclusion)
            - js_min(ytd_dependent_care, exclusion);
    let deferral_total = k401_cents + roth401k_cents;
    let mut employer_match_cents = sum_amount("us.401k_employer_match");
    if let Some(match_percent) = percent_param("us.401k_employer_match", "match_percent") {
        let matched = match percent_param("us.401k_employer_match", "match_limit_percent") {
            Some(limit) => js_min(deferral_total, percent_of(wages_ex_tips_cents, limit)),
            None => deferral_total,
        };
        employer_match_cents += percent_of(matched, match_percent);
    }
    let employer_health_cents = sum_amount("us.employer_health");
    let mut push_deduction = |code: &str, label_key: &str, cents: Cents, base_list: &[&str]| {
        if cents > 0.0 {
            let mut l = federal(line(code, Section::Deduction, label_key, -cents));
            l.bases = bases(base_list);
            lines.push(l);
        }
    };
    push_deduction("us.401k", "us.401k", k401_cents, &["us.fit_wages"]);
    push_deduction("us.roth_401k", "us.roth_401k", roth401k_cents, &[]);
    push_deduction(
        "us.section125_health",
        "us.section125_health",
        section125_cents,
        &FICA_BASES,
    );
    push_deduction("us.hsa", "us.hsa", hsa_cents, &FICA_BASES);
    push_deduction(
        "us.dependent_care",
        "us.dependent_care",
        dependent_care_cents,
        if dependent_care_excluded_cents > 0.0 {
            &FICA_BASES
        } else {
            &[]
        },
    );
    let pretax_fit = k401_cents + section125_cents + hsa_cents + dependent_care_excluded_cents;
    let pretax_fica = section125_cents + hsa_cents + dependent_care_excluded_cents;
    let fit_wages_cents = js_max(0.0, gross_cents - pretax_fit);
    let regular_fit_cents = js_max(0.0, regular_gross_cents - pretax_fit);
    let supplemental_fit_cents = js_max(
        0.0,
        supplemental_cents - js_max(0.0, pretax_fit - regular_gross_cents),
    );
    let ss_wages_subject = js_max(0.0, wages_ex_tips_cents - pretax_fica);
    let tips_subject = js_max(
        0.0,
        tips_cents - js_max(0.0, pretax_fica - wages_ex_tips_cents),
    );
    let fica_subject = ss_wages_subject + tips_subject;
    let w4 = effective_w4(input.us.w4.as_ref());
    if input.us.w4.is_none() {
        issues.push(PayrollIssue::warning("w4_missing_default_single"));
    }
    let periods_per_year = period.periods_per_year as f64;
    let mut fit_regular_cents = 0.0;
    let mut fit_supplemental_cents = 0.0;
    if !input.us.statutory_employee {
        let nra = nra_addition_cents(rules, &w4, periods_per_year);
        if !w4.exempt && regular_fit_cents > 0.0 {
            fit_regular_cents = worksheet_1a(rules, &w4, regular_fit_cents + nra, periods_per_year)
                .withholding_cents;
        }
        let supp = supplemental_withholding(&SupplementalArgs {
            rules,
            w4: &w4,
            supplemental_cents: supplemental_fit_cents,
            ytd_supplemental_cents: ytd_of(keys::SUPPLEMENTAL_WAGES),
            regular_wages_cents: regular_fit_cents,
            nra_addition_cents: nra,
            periods_per_year,
            regular_withheld_this_year_cents: ytd_of(keys::FIT_REGULAR) + fit_regular_cents,
        });
        fit_supplemental_cents = supp.flat_cents + supp.mandatory_cents + supp.aggregate_cents;
    }
    let fit_cents = fit_regular_cents + fit_supplemental_cents;
    if fit_cents > 0.0 {
        lines.push(federal(line(
            "us.fit",
            Section::Tax,
            "us.federal_income_tax",
            -fit_cents,
        )));
    }

    let mut ss_wages_cents = 0.0;
    let mut ss_tips_cents = 0.0;
    let mut ss_employee_cents = 0.0;
    let mut ss_employer_cents = 0.0;
    let mut medicare_wages_cents = 0.0;
    let mut medicare_employee_cents = 0.0;
    let mut medicare_employer_cents = 0.0;
    let mut additional_medicare_wages_cents = 0.0;
    let mut additional_medicare_cents = 0.0;
    if !input.us.exempt_fica {
        let base = rules.social_security.wage_base_cents;
        let ytd_ss_base = ytd_of(keys::SS_WAGES) + ytd_of(keys::SS_TIPS);
        let room = js_max(0.0, base - ytd_ss_base);
        ss_wages_cents = js_min(ss_wages_subject, room);
        ss_tips_cents = js_min(tips_subject, room - ss_wages_cents);
        let ss_taxed = ss_wages_cents + ss_tips_cents;
        if ytd_ss_base < base && ytd_ss_base + ss_taxed >= base && ss_taxed > 0.0 {
            issues.push(
                PayrollIssue::warning("ss_wage_base_reached").with(&[("wageBaseCents", n(base))]),
            );
        }
        let rate = rules.social_security.rate_percent;
        ss_employee_cents = cumulative_tax(ss_taxed, ytd_ss_base, ytd_of(keys::SS_EMPLOYEE), rate);
        ss_employer_cents = cumulative_tax(ss_taxed, ytd_ss_base, ytd_of(keys::SS_EMPLOYER), rate);
        medicare_wages_cents = fica_subject;
        let ytd_medicare = ytd_of(keys::MEDICARE_WAGES);
        let medicare_rate = rules.medicare.rate_percent;
        medicare_employee_cents = cumulative_tax(
            medicare_wages_cents,
            ytd_medicare,
            ytd_of(keys::MEDICARE_EMPLOYEE),
            medicare_rate,
        );
        medicare_employer_cents = cumulative_tax(
            medicare_wages_cents,
            ytd_medicare,
            ytd_of(keys::MEDICARE_EMPLOYER),
            medicare_rate,
        );
        let threshold = rules.medicare.additional_threshold_cents;
        additional_medicare_wages_cents = js_max(
            0.0,
            js_min(
                medicare_wages_cents,
                ytd_medicare + medicare_wages_cents - threshold,
            ),
        );
        if additional_medicare_wages_cents > 0.0 {
            additional_medicare_cents = cumulative_tax(
                additional_medicare_wages_cents,
                ytd_of(keys::ADDITIONAL_MEDICARE_WAGES),
                ytd_of(keys::ADDITIONAL_MEDICARE),
                rules.medicare.additional_rate_percent,
            );
            if ytd_medicare <= threshold {
                issues.push(
                    PayrollIssue::warning("additional_medicare_started")
                        .with(&[("thresholdCents", n(threshold))]),
                );
            }
        }
    }
    let push_tax = |lines: &mut Vec<PayslipLine>,
                    code: &str,
                    label_key: &str,
                    cents: Cents,
                    section: Section,
                    jurisdiction: &str| {
        if cents != 0.0 {
            let mut l = line(
                code,
                section,
                label_key,
                if section == Section::Tax {
                    -cents
                } else {
                    cents
                },
            );
            l.jurisdiction = Some(Some(jurisdiction.to_owned()));
            lines.push(l);
        }
    };
    push_tax(
        &mut lines,
        "us.ss",
        "us.social_security",
        ss_employee_cents,
        Section::Tax,
        "federal",
    );
    push_tax(
        &mut lines,
        "us.medicare",
        "us.medicare",
        medicare_employee_cents,
        Section::Tax,
        "federal",
    );
    push_tax(
        &mut lines,
        "us.addl_medicare",
        "us.additional_medicare",
        additional_medicare_cents,
        Section::Tax,
        "federal",
    );

    let futa_gross_cents = js_max(0.0, gross_cents);
    let futa_exempt_cents = if input.us.exempt_futa {
        futa_gross_cents
    } else {
        js_min(futa_gross_cents, pretax_fica)
    };
    let futa_subject = futa_gross_cents - futa_exempt_cents;
    let futa_wages_cents = js_min(
        futa_subject,
        js_max(0.0, rules.futa.wage_base_cents - ytd_of(keys::FUTA_WAGES)),
    );
    let credit_reduction = futa_credit_reduction_percent(period.tax_year, work_state.as_deref());
    let futa_net_cents = percent_of(
        futa_wages_cents,
        rules.futa.gross_rate_percent - rules.futa.max_credit_percent,
    );
    let futa_credit_reduction_cents = percent_of(futa_wages_cents, credit_reduction);
    let futa_cents = futa_net_cents + futa_credit_reduction_cents;
    if let Some(state) = work_state.as_deref() {
        if futa_wages_cents > 0.0
            && credit_reduction == 0.0
            && rules
                .futa
                .credit_reduction_pending
                .iter()
                .any(|s| s == state)
        {
            issues.push(PayrollIssue::warning("provisional_rules").with(&[
                ("item", json!("futa_credit_reduction")),
                ("state", json!(state)),
            ]));
        }
    }
    push_tax(
        &mut lines,
        "us.ss_employer",
        "us.social_security_employer",
        ss_employer_cents,
        Section::Employer,
        "federal",
    );
    push_tax(
        &mut lines,
        "us.medicare_employer",
        "us.medicare_employer",
        medicare_employer_cents,
        Section::Employer,
        "federal",
    );
    push_tax(
        &mut lines,
        "us.futa",
        "us.futa",
        futa_cents,
        Section::Employer,
        "federal",
    );

    let mut filing = empty_filing();
    let mut state_employee_tax_cents = 0.0;
    let mut state_employer_tax_cents = 0.0;
    let mut rule_set = rules.rule_set.clone();
    match work_state.as_deref() {
        None => issues.push(PayrollIssue::error("missing_work_state")),
        Some(state) => {
            let state_input = StateCalcInput {
                state: state.to_owned(),
                tax_year: period.tax_year,
                pay_date: &period.pay_date,
                period_start: &period.start,
                period_end: &period.end,
                periods_per_year,
                regular_wages_cents: regular_gross_cents,
                supplemental_wages_cents: supplemental_cents,
                pretax: Pretax {
                    retirement401k_cents: k401_cents,
                    section125_cents,
                    hsa_cents,
                    dependent_care_cents: dependent_care_excluded_cents,
                },
                certificate: input.us.state_certificates.get(state),
                federal_w4: input.us.w4.as_ref(),
                sui_rate_percent: input
                    .employer
                    .sui_rate_percent
                    .get(state)
                    .copied()
                    .flatten(),
                extra_rates: input.employer.extra_rates.get(state),
                employee_count_estimate: input.employer.employee_count_estimate,
                ytd: &input.ytd,
                residence_state: input.us.residence_state.as_deref(),
                exempt_from_sui: input.us.exempt_sui.unwrap_or(input.us.exempt_futa),
                fica_employee_cents: Some(ss_employee_cents + medicare_employee_cents),
            };
            match calculate_state(state, &state_input) {
                None => issues.push(
                    PayrollIssue::error("unsupported_state").with(&[("state", json!(state))]),
                ),
                Some(res) => {
                    issues.extend(res.issues.iter().cloned());
                    rule_set = format!("{}/{}", rules.rule_set, res.rule_set);
                    push_tax(
                        &mut lines,
                        "us.state_income_tax",
                        &state_income_tax_label_key(state),
                        res.income_tax_cents,
                        Section::Tax,
                        state,
                    );
                    push_tax(
                        &mut lines,
                        "us.sui_employee",
                        &state_sui_employee_label_key(state),
                        res.sui.employee_cents,
                        Section::Tax,
                        state,
                    );
                    push_tax(
                        &mut lines,
                        "us.sui_employer",
                        &state_sui_employer_label_key(state),
                        res.sui.employer_cents,
                        Section::Employer,
                        state,
                    );
                    let mut programs: OrderedMap<ProgramFiling> = OrderedMap::new();
                    for p in &res.programs {
                        let code = format!("us.state_program.{}", p.code);
                        if p.employee_cents != 0.0 {
                            let mut l = line(&code, Section::Tax, &p.label_key, -p.employee_cents);
                            l.jurisdiction = Some(Some(state.to_owned()));
                            lines.push(l);
                        }
                        if p.employer_cents != 0.0 {
                            let mut l =
                                line(&code, Section::Employer, &p.label_key, p.employer_cents);
                            l.jurisdiction = Some(Some(state.to_owned()));
                            lines.push(l);
                        }
                        let prev = programs.get(&p.code).cloned().unwrap_or_default();
                        programs.insert(
                            p.code.clone(),
                            ProgramFiling {
                                wages: prev.wages + p.wages_cents,
                                employee: prev.employee + p.employee_cents,
                                employer: prev.employer + p.employer_cents,
                            },
                        );
                        state_employee_tax_cents += p.employee_cents;
                        state_employer_tax_cents += p.employer_cents;
                    }
                    state_employee_tax_cents += res.income_tax_cents + res.sui.employee_cents;
                    state_employer_tax_cents += res.sui.employer_cents;
                    filing.states.insert(
                        state.to_owned(),
                        UsStateFiling {
                            state_wages: res.state_wages_cents,
                            state_income_tax: res.income_tax_cents,
                            sui_wages: res.sui.taxable_wages_cents,
                            sui_gross_wages: res.sui.gross_wages_cents,
                            sui_employer_tax: res.sui.employer_cents,
                            sui_employee_tax: res.sui.employee_cents,
                            programs,
                        },
                    );
                    for (key, value) in res.ytd_updates.iter() {
                        ytd.insert(key.clone(), *value);
                    }
                }
            }
        }
    }
    if employer_match_cents > 0.0 {
        lines.push(line(
            "us.401k_employer_match",
            Section::Employer,
            "us.401k_employer_match",
            employer_match_cents,
        ));
    }
    if employer_health_cents > 0.0 {
        lines.push(line(
            "us.employer_health",
            Section::Employer,
            "us.employer_health",
            employer_health_cents,
        ));
    }
    if tips_cents > 0.0 {
        lines.push(line(
            "us.tips_cash",
            Section::Deduction,
            "us.tips_received",
            -tips_cents,
        ));
    }
    if qualified_overtime_cents > 0.0 {
        lines.push(federal(line(
            "us.qualified_overtime",
            Section::Info,
            "us.qualified_overtime",
            qualified_overtime_cents,
        )));
    }

    let employee_taxes_cents = fit_cents
        + ss_employee_cents
        + medicare_employee_cents
        + additional_medicare_cents
        + state_employee_tax_cents;
    let employee_deductions_cents = k401_cents
        + roth401k_cents
        + section125_cents
        + hsa_cents
        + dependent_care_cents
        + deduction_net_cents
        + tips_cents;
    let reimbursements_cents = reimbursement_cents + advance_cents;
    let net_cents =
        gross_cents - employee_taxes_cents - employee_deductions_cents + reimbursements_cents;
    let employer_taxes_cents =
        ss_employer_cents + medicare_employer_cents + futa_cents + state_employer_tax_cents;
    let employer_cost_cents = gross_cents - tips_cents
        + employer_taxes_cents
        + employer_match_cents
        + employer_health_cents
        + reimbursements_cents;
    if net_cents < 0.0 {
        issues.push(PayrollIssue::error("negative_net_pay").with(&[("netCents", n(net_cents))]));
    } else if net_cents == 0.0 && gross_cents > 0.0 {
        issues.push(PayrollIssue::warning("net_pay_zero"));
    }

    let mut add_ytd = |key: &str, cents: Cents| {
        if cents != 0.0 {
            let current = ytd.get(key).copied().unwrap_or(0.0);
            ytd.insert(key, current + cents);
        }
    };
    add_ytd(keys::GROSS, gross_cents);
    add_ytd(keys::FIT_WAGES, fit_wages_cents);
    add_ytd(keys::FIT, fit_cents);
    add_ytd(keys::FIT_REGULAR, fit_regular_cents);
    add_ytd(keys::SUPPLEMENTAL_WAGES, supplemental_fit_cents);
    add_ytd(keys::SS_WAGES, ss_wages_cents);
    add_ytd(keys::SS_TIPS, ss_tips_cents);
    add_ytd(keys::SS_EMPLOYEE, ss_employee_cents);
    add_ytd(keys::SS_EMPLOYER, ss_employer_cents);
    add_ytd(keys::MEDICARE_WAGES, medicare_wages_cents);
    add_ytd(keys::MEDICARE_EMPLOYEE, medicare_employee_cents);
    add_ytd(keys::MEDICARE_EMPLOYER, medicare_employer_cents);
    add_ytd(
        keys::ADDITIONAL_MEDICARE_WAGES,
        additional_medicare_wages_cents,
    );
    add_ytd(keys::ADDITIONAL_MEDICARE, additional_medicare_cents);
    add_ytd(keys::FUTA_WAGES, futa_wages_cents);
    add_ytd(keys::FUTA, futa_cents);
    add_ytd(keys::FUTA_GROSS_WAGES, futa_gross_cents);
    add_ytd(keys::FUTA_EXEMPT_WAGES, futa_exempt_cents);
    add_ytd(keys::K401, k401_cents);
    add_ytd(keys::ROTH401K, roth401k_cents);
    add_ytd(keys::SECTION125, section125_cents);
    add_ytd(keys::HSA, hsa_cents);
    add_ytd(keys::DEPENDENT_CARE, dependent_care_cents);
    add_ytd(keys::EMPLOYER401K, employer_match_cents);
    add_ytd(keys::EMPLOYER_HEALTH, employer_health_cents);
    add_ytd(keys::TIPS, tips_cents);
    add_ytd(keys::QUALIFIED_OVERTIME, qualified_overtime_cents);
    add_ytd(keys::NET, net_cents);

    let mut box12: OrderedMap<Cents> = OrderedMap::new();
    for (code, cents) in [
        ("D", k401_cents),
        ("AA", roth401k_cents),
        ("W", hsa_cents),
        ("DD", employer_health_cents + section125_cents),
        ("TT", qualified_overtime_cents),
        ("TP", tips_cents),
    ] {
        if cents > 0.0 {
            box12.insert(code, cents);
        }
    }
    filing.federal = UsFederalFiling {
        fit_wages: fit_wages_cents,
        federal_income_tax: fit_cents,
        ss_wages: ss_wages_cents,
        ss_tax_employee: ss_employee_cents,
        ss_tax_employer: ss_employer_cents,
        medicare_wages: medicare_wages_cents,
        medicare_tax_employee: medicare_employee_cents,
        medicare_tax_employer: medicare_employer_cents,
        additional_medicare_wages: additional_medicare_wages_cents,
        additional_medicare_tax: additional_medicare_cents,
        futa_gross_wages: futa_gross_cents,
        futa_wages: futa_wages_cents,
        futa_tax: futa_cents,
        ss_tips: ss_tips_cents,
        box12,
        dependent_care: dependent_care_cents,
        futa_exempt_wages: Some(futa_exempt_cents),
        futa_state: Some(work_state.clone()),
        futa_credit_reduction: Some(futa_credit_reduction_cents),
        supplemental_wages: Some(supplemental_cents),
        statutory_employee: Some(input.us.statutory_employee),
        retirement_plan: Some(input.us.retirement_plan),
    };
    filing.qualified_overtime_premium = qualified_overtime_cents;
    filing.hours_worked = round2(hours_worked);
    Ok(PayslipResult {
        lines,
        gross_cents,
        taxable_wage_cents: fit_wages_cents,
        employee_taxes_cents,
        employee_deductions_cents,
        reimbursements_cents,
        net_cents,
        employer_taxes_cents,
        employer_cost_cents,
        ytd,
        filing_data: FilingData::Us(Box::new(filing)),
        issues,
        rule_set,
    })
}

/// `workweekEnd(date, workweekStartDay)`.
pub fn workweek_end(date: &str, workweek_start_day: i64) -> Result<String, PayrollError> {
    add_days(&workweek_start(date, workweek_start_day)?, 6)
}
