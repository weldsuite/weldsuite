//! The Dutch payslip engine (`nl/calculate.ts`), line for line.

use serde_json::{Map, Value, json};

use crate::PayrollError;
use crate::js::{int_of, is_integer, last_day_of_month, math_round, number_of, slice};
use crate::money::{Cents, js_max, js_min, round_half_away_from_zero as round, to_cents};
use crate::nl::rules::{NlRuleSet, nl_rules_for_year};
use crate::nl::wage_tax::{
    NlAgeColumn, NlTableColour, anonymous_tax, period_factor, period_wage_tax,
    special_reward_percent, special_reward_tax,
};
use crate::nl::ytd::{keys, ytd_value};
use crate::periods::{age_on, days_between, weekdays_between};
use crate::types::{
    CompensationPeriod, ComponentInput, Contract, FilingData, Insured, NlAmounts, NlFilingData,
    NlPayslipInput, PayFrequency, PayType, PayrollIssue, PayslipLine, PayslipResult, RateLevel,
    RunInput, Section, Ytd, ZvwKind,
};

const B_LB: &str = "nl.loon_lb";
const B_SV: &str = "nl.loon_sv";
const B_ZVW: &str = "nl.loon_zvw";
const B_BB: &str = "nl.loon_bb";

const NL_CODES: &[&str] = &[
    "hours.regular",
    "hours.overtime",
    "hours.unpaid_leave",
    "bonus",
    "commission",
    "allowance.taxable",
    "reimbursement",
    "deduction.net",
    "advance",
    "nl.travel_allowance",
    "nl.home_working_allowance",
    "nl.company_car",
    "nl.pension_employee",
    "nl.pension_employer",
    "nl.thirteenth_month",
    "nl.leave_payout",
    "nl.holiday_allowance_payout",
    "nl.sick_pay",
    "nl.transition_payment",
];

#[derive(Debug, Clone)]
struct Item {
    code: String,
    label: Option<String>,
    quantity: Option<f64>,
    rate: Option<f64>,
    amount_cents: Option<Cents>,
    params: Map<String, Value>,
}

fn from_component(c: &ComponentInput) -> Item {
    Item {
        code: c.code.clone(),
        label: c.label.clone().flatten(),
        quantity: None,
        rate: None,
        amount_cents: c.amount_cents,
        params: c.params.clone(),
    }
}

fn from_input(i: &RunInput) -> Item {
    Item {
        code: i.code.clone(),
        label: i.label.clone().flatten(),
        quantity: i.quantity,
        rate: i.rate,
        amount_cents: i.amount_cents,
        params: Map::new(),
    }
}

/// `num(params, key)`: a finite number, or text that is one.
pub(crate) fn num(params: &Map<String, Value>, key: &str) -> Option<f64> {
    let n = match params.get(key)? {
        Value::Number(n) => n.as_f64()?,
        Value::String(text) if text.is_empty() => return None,
        Value::String(text) => number_of(text),
        _ => return None,
    };
    n.is_finite().then_some(n)
}

/// `addYearsMonths(iso, years, months)`: the day clamped to the month's end.
pub(crate) fn add_years_months(iso: &str, years: i64, months: i64) -> String {
    let y = int_of(slice(iso, 0, 4));
    let m = int_of(slice(iso, 5, 7));
    let d = int_of(slice(iso, 8, 10));
    let total = (y + years) * 12 + (m - 1) + months;
    let ny = total.div_euclid(12);
    let nm = total.rem_euclid(12) + 1;
    let last = last_day_of_month(ny, nm);
    format!("{ny}-{nm:02}-{:02}", d.min(last))
}

/// `nlAowDate(dateOfBirth, rules)`.
pub fn nl_aow_date(date_of_birth: &str, rules: &NlRuleSet) -> String {
    add_years_months(date_of_birth, rules.aow_age.years, rules.aow_age.months)
}

/// `nlAgeColumn(dateOfBirth, payDate, rules)`.
pub fn nl_age_column(date_of_birth: &str, pay_date: &str, rules: &NlRuleSet) -> NlAgeColumn {
    let aow = nl_aow_date(date_of_birth, rules);
    if pay_date < format!("{}01", slice(&aow, 0, 8)).as_str() {
        return NlAgeColumn::BelowAow;
    }
    if int_of(slice(date_of_birth, 0, 4)) <= 1945 {
        NlAgeColumn::Aow1945
    } else {
        NlAgeColumn::Aow1946
    }
}

fn rate_level(low: bool) -> RateLevel {
    if low { RateLevel::Low } else { RateLevel::High }
}

fn empty_filing(input: &NlPayslipInput) -> NlFilingData {
    NlFilingData {
        table_code: "012".into(),
        apply_loonheffingskorting: input.nl.apply_loonheffingskorting,
        anonymous: input.nl.anonymous,
        insured: Insured {
            ww: input.nl.insured_ww,
            zw: input.nl.insured_zw,
            wao: input.nl.insured_wao,
        },
        awf_rate: RateLevel::High,
        aof_rate: rate_level(input.employer.aof_small_employer),
        zvw: ZvwKind::EmployerLevy,
        contract: Contract {
            written: input.nl.written_contract,
            indefinite: input.nl.indefinite_contract,
            on_call: input.nl.on_call,
        },
        amounts: NlAmounts::default(),
        hours_paid: 0.0,
        sv_days: 0.0,
        contract_hours_per_week: None,
        is_dga: None,
        incidental_income_reduction: None,
    }
}

fn blocked_result(
    input: &NlPayslipInput,
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
        filing_data: FilingData::Nl(Box::new(empty_filing(input))),
        issues,
        rule_set: rule_set.to_owned(),
    }
}

/// The optional keys `earning(...)`'s `extra` spreads onto a line.
#[derive(Default)]
struct Extra {
    label: Option<Option<String>>,
    quantity: Option<Option<f64>>,
    rate: Option<Option<f64>>,
}

/// JavaScript truthiness of an optional number (`!extra.quantity`).
fn truthy(n: Option<Option<f64>>) -> bool {
    matches!(n, Some(Some(q)) if q != 0.0 && !q.is_nan())
}

fn bases(list: &[&str]) -> Vec<String> {
    list.iter().map(|b| (*b).to_owned()).collect()
}

fn line(code: &str, section: Section, label_key: &str, amount: Cents) -> PayslipLine {
    PayslipLine::new(code, section, label_key, amount)
}

fn n(value: f64) -> Value {
    crate::js::number_value(value)
}

#[allow(clippy::too_many_lines)]
pub fn calculate_nl_payslip(input: &NlPayslipInput) -> Result<PayslipResult, PayrollError> {
    let period = &input.period;
    let employee = &input.employee;
    let employer = &input.employer;
    let nl = &input.nl;
    let mut issues: Vec<PayrollIssue> = vec![];
    let Some(rules) = nl_rules_for_year(period.tax_year) else {
        let issue =
            PayrollIssue::error("unsupported_tax_year").with(&[("year", json!(period.tax_year))]);
        return Ok(blocked_result(input, vec![issue], "nl-none"));
    };
    if period.frequency != PayFrequency::Monthly {
        let issue = PayrollIssue::error("unsupported_frequency")
            .with(&[("frequency", json!(period.frequency.as_str()))]);
        return Ok(blocked_result(input, vec![issue], &rules.id));
    }
    if rules.provisional {
        issues.push(PayrollIssue::warning("provisional_rules").with(&[
            ("ruleSet", json!(rules.id)),
            ("unverified", json!(rules.unverified.join(", "))),
        ]));
    }
    let ytd = &input.ytd;
    if ytd.is_empty() {
        issues.push(PayrollIssue::warning("first_payslip"));
    }

    let emp_start = match &employee.start_date {
        Some(s) if s.as_str() > period.start.as_str() => s.clone(),
        _ => period.start.clone(),
    };
    let emp_end = match &employee.end_date {
        Some(e) if e.as_str() < period.end.as_str() => e.clone(),
        _ => period.end.clone(),
    };
    let employed = emp_start <= emp_end;
    let partial = employed && (emp_start != period.start || emp_end != period.end);
    if partial {
        issues.push(
            PayrollIssue::warning("partial_period")
                .with(&[("from", json!(emp_start)), ("to", json!(emp_end))]),
        );
    }
    let period_weekdays = weekdays_between(&period.start, &period.end)? as f64;
    let employed_weekdays = if employed {
        weekdays_between(&emp_start, &emp_end)? as f64
    } else {
        0.0
    };
    let proration = if !employed {
        0.0
    } else if partial {
        if period_weekdays > 0.0 {
            employed_weekdays / period_weekdays
        } else {
            0.0
        }
    } else {
        1.0
    };
    let calendar_fraction = if employed {
        (days_between(&emp_start, &emp_end)? as f64 + 1.0)
            / (days_between(&period.start, &period.end)? as f64 + 1.0)
    } else {
        0.0
    };
    let ends_this_period = employee
        .end_date
        .as_deref()
        .is_some_and(|e| !e.is_empty() && e >= period.start.as_str() && e <= period.end.as_str());

    let dob = employee.date_of_birth.as_deref().filter(|d| !d.is_empty());
    if dob.is_none() {
        issues.push(PayrollIssue::error("missing_date_of_birth"));
    }
    let aow_date = dob.map(|d| nl_aow_date(d, rules));
    let aow_month_start = aow_date.as_deref().map(|a| format!("{}01", slice(a, 0, 8)));
    let aow_reached = aow_month_start
        .as_deref()
        .is_some_and(|m| !m.is_empty() && period.pay_date.as_str() >= m);
    let column = if !aow_reached {
        NlAgeColumn::BelowAow
    } else if int_of(slice(dob.unwrap_or(""), 0, 4)) <= 1945 {
        NlAgeColumn::Aow1945
    } else {
        NlAgeColumn::Aow1946
    };
    let age_at_end = match dob {
        Some(d) => Some(age_on(d, &period.end)?),
        None => None,
    };
    let age_at_start = match dob {
        Some(d) => Some(age_on(d, &period.start)?),
        None => None,
    };

    let is_dga = nl.is_dga;
    let aow_before_period = aow_date
        .as_deref()
        .is_some_and(|a| !a.is_empty() && a <= period.start.as_str());
    let insured = Insured {
        ww: !is_dga && nl.insured_ww && !aow_before_period,
        zw: !is_dga && nl.insured_zw,
        wao: !is_dga && nl.insured_wao && !aow_before_period,
    };
    let sv_applies = insured.ww || insured.zw || insured.wao;
    let premiums_apply = !is_dga && !aow_reached;
    let anonymous = nl.anonymous;
    if anonymous {
        issues.push(PayrollIssue::warning("anonymous_rate"));
    }
    let apply_lhk = nl.apply_loonheffingskorting && !anonymous;

    let comp = input.compensation.as_ref();
    let contract_hours = nl
        .contract_hours_per_week
        .or_else(|| comp.and_then(|c| c.hours_per_week));
    let hours_per_week = comp
        .and_then(|c| c.hours_per_week)
        .or(nl.contract_hours_per_week);
    let usual_days =
        nl.usual_work_days_per_week
            .unwrap_or(if contract_hours.is_some_and(|h| h >= 36.0) {
                5.0
            } else {
                4.0
            });
    let full_timer = usual_days >= 5.0;
    let day_table_period = partial && full_timer && employed_weekdays > 0.0;

    let mut monthly_salary_cents: Option<f64> = None;
    let mut hourly_rate_cents: Option<f64> = None;
    match comp {
        None => {
            if employed {
                issues.push(PayrollIssue::error("missing_compensation"));
            }
        }
        Some(c) => {
            let amt = c.amount * 100.0;
            // `hoursPerWeek ? … : null`: 0 and NaN are falsy.
            let hours_truthy = hours_per_week.filter(|h| *h != 0.0 && !h.is_nan());
            let per_month_from_hours = hours_truthy.map(|h| (h * 52.0) / 12.0);
            if c.pay_type == PayType::Salary {
                monthly_salary_cents = match c.period {
                    CompensationPeriod::Month => Some(amt),
                    CompensationPeriod::Year => Some(amt / 12.0),
                    CompensationPeriod::Week => Some((amt * 52.0) / 12.0),
                    CompensationPeriod::Hour => per_month_from_hours.map(|p| amt * p),
                };
                if let (Some(m), Some(p)) = (monthly_salary_cents, per_month_from_hours) {
                    if p != 0.0 && !p.is_nan() {
                        hourly_rate_cents = Some(m / p);
                    }
                }
            } else if c.period == CompensationPeriod::Hour {
                hourly_rate_cents = Some(amt);
            } else if let Some(h) = hours_truthy {
                hourly_rate_cents = Some(match c.period {
                    CompensationPeriod::Week => amt / h,
                    CompensationPeriod::Month => (amt * 12.0) / 52.0 / h,
                    _ => amt / 52.0 / h,
                });
            }
            if monthly_salary_cents.is_none() && hourly_rate_cents.is_none() {
                issues.push(
                    PayrollIssue::error("missing_compensation")
                        .with(&[("field", json!("hoursPerWeek"))]),
                );
            }
        }
    }

    let items: Vec<Item> = input
        .components
        .iter()
        .map(from_component)
        .chain(input.inputs.iter().map(from_input))
        .collect();
    for it in &items {
        if !NL_CODES.contains(&it.code.as_str()) {
            issues.push(
                PayrollIssue::error("unsupported_component").with(&[("code", json!(it.code))]),
            );
        }
    }
    let items_of =
        |code: &str| -> Vec<Item> { items.iter().filter(|i| i.code == code).cloned().collect() };
    let need_hourly = |it: &Item, issues: &mut Vec<PayrollIssue>| -> Option<f64> {
        if hourly_rate_cents.is_none() {
            issues.push(PayrollIssue::error("missing_compensation").with(&[
                ("field", json!("hourlyRate")),
                ("component", json!(it.code)),
            ]));
        }
        hourly_rate_cents
    };

    let mut lines: Vec<PayslipLine> = vec![];
    let period_bases: &[&str] = if sv_applies {
        &[B_LB, B_SV, B_ZVW]
    } else {
        &[B_LB, B_ZVW]
    };
    let bb_bases: Vec<&str> = period_bases.iter().copied().chain([B_BB]).collect();
    let earning = |lines: &mut Vec<PayslipLine>,
                   code: &str,
                   label_key: &str,
                   amount: Cents,
                   extra: Extra,
                   special: bool| {
        if amount == 0.0 && !truthy(extra.quantity) {
            return;
        }
        let mut l = line(code, Section::Earning, label_key, amount);
        l.bases = Some(bases(if special { &bb_bases } else { period_bases }));
        l.label = extra.label;
        l.quantity = extra.quantity;
        l.rate = extra.rate;
        lines.push(l);
    };

    let mut qualifying_wage = 0.0;
    let mut pensionable_wage = 0.0;
    let mut hours_paid = 0.0;
    let mut overtime_wage = 0.0;
    let mut incidental: Option<String> = None;

    if let Some(c) = comp {
        if employed {
            if c.pay_type == PayType::Salary {
                if let Some(monthly) = monthly_salary_cents {
                    let salary = round(monthly * proration);
                    let quantity = if partial {
                        Some(math_round(proration * 10_000.0) / 10_000.0)
                    } else {
                        None
                    };
                    earning(
                        &mut lines,
                        "nl.salary",
                        "nl.salary",
                        salary,
                        Extra {
                            quantity: Some(quantity),
                            ..Extra::default()
                        },
                        false,
                    );
                    qualifying_wage += salary;
                    pensionable_wage += salary;
                    if let Some(h) = contract_hours.filter(|h| *h != 0.0 && !h.is_nan()) {
                        hours_paid += ((h * 52.0) / 12.0) * proration;
                    }
                }
            } else {
                let regular = items_of("hours.regular");
                for it in &regular {
                    let q = it.quantity.unwrap_or(0.0);
                    let rate = match it.rate {
                        Some(r) => Some(r * 100.0),
                        None => hourly_rate_cents,
                    };
                    let amount = it
                        .amount_cents
                        .unwrap_or_else(|| rate.map_or(0.0, |r| round(q * r)));
                    earning(
                        &mut lines,
                        "nl.hours_regular",
                        "nl.hours_regular",
                        amount,
                        Extra {
                            quantity: Some(Some(q)),
                            rate: Some(rate.map(|r| r / 100.0)),
                            label: Some(it.label.clone()),
                        },
                        false,
                    );
                    qualifying_wage += amount;
                    pensionable_wage += amount;
                    hours_paid += q;
                }
                if regular.is_empty() {
                    issues.push(PayrollIssue::warning("no_hours"));
                }
            }
        }
    }

    for it in items_of("hours.overtime") {
        let q = it.quantity.unwrap_or(0.0);
        let pct = it.rate.unwrap_or(100.0);
        let amount = match it.amount_cents {
            Some(a) => a,
            None => need_hourly(&it, &mut issues).map_or(0.0, |h| round((q * h * pct) / 100.0)),
        };
        earning(
            &mut lines,
            "hours.overtime",
            "nl.overtime",
            amount,
            Extra {
                quantity: Some(Some(q)),
                rate: Some(Some(pct)),
                label: Some(it.label.clone()),
            },
            false,
        );
        overtime_wage += amount;
        qualifying_wage += amount;
        hours_paid += q;
    }

    for it in items_of("hours.unpaid_leave") {
        let q = it.quantity.unwrap_or(0.0);
        let amount = match it.amount_cents {
            Some(a) => a.abs(),
            None => need_hourly(&it, &mut issues).map_or(0.0, |h| round(q * h)),
        };
        earning(
            &mut lines,
            "hours.unpaid_leave",
            "nl.unpaid_leave",
            -amount,
            Extra {
                quantity: Some(Some(q)),
                label: Some(it.label.clone()),
                ..Extra::default()
            },
            false,
        );
        qualifying_wage -= amount;
        pensionable_wage -= amount;
        hours_paid -= q;
        if amount > 0.0 {
            incidental = Some("O".into());
        }
    }

    for it in items_of("nl.sick_pay") {
        let q = it.quantity.unwrap_or(0.0);
        let pct = it.rate.unwrap_or(100.0);
        if pct < 70.0 {
            issues.push(
                PayrollIssue::warning("sick_pay_below_statutory").with(&[("percent", n(pct))]),
            );
        }
        if pct >= 100.0 {
            continue;
        }
        let reduction = match it.amount_cents {
            Some(a) => a.abs(),
            None => need_hourly(&it, &mut issues)
                .map_or(0.0, |h| round((q * h * (100.0 - pct)) / 100.0)),
        };
        earning(
            &mut lines,
            "nl.sick_pay",
            "nl.sick_pay_reduction",
            -reduction,
            Extra {
                quantity: Some(Some(q)),
                rate: Some(Some(pct)),
                label: Some(it.label.clone()),
            },
            false,
        );
        qualifying_wage -= reduction;
        pensionable_wage -= reduction;
        if reduction > 0.0 && incidental.is_none() {
            incidental = Some("Z".into());
        }
    }

    for it in items_of("allowance.taxable") {
        let amount = it.amount_cents.unwrap_or(0.0);
        earning(
            &mut lines,
            "allowance.taxable",
            "nl.allowance_taxable",
            amount,
            Extra {
                label: Some(it.label.clone()),
                ..Extra::default()
            },
            false,
        );
        qualifying_wage += amount;
    }

    let mut bb_white = 0.0;
    let mut special_rewards_paid = 0.0;
    for (code, label_key) in [
        ("bonus", "nl.bonus"),
        ("commission", "nl.commission"),
        ("nl.thirteenth_month", "nl.thirteenth_month"),
    ] {
        for it in items_of(code) {
            let amount = it.amount_cents.unwrap_or(0.0);
            earning(
                &mut lines,
                code,
                label_key,
                amount,
                Extra {
                    label: Some(it.label.clone()),
                    ..Extra::default()
                },
                true,
            );
            bb_white += amount;
            special_rewards_paid += amount;
            if code == "commission" {
                qualifying_wage += amount;
            }
        }
    }

    for it in items_of("nl.leave_payout") {
        let q = it.quantity.unwrap_or(0.0);
        let amount = match it.amount_cents {
            Some(a) => a,
            None => {
                let rate = match it.rate {
                    Some(r) => Some(r * 100.0),
                    None => need_hourly(&it, &mut issues),
                };
                rate.map_or(0.0, |r| round(q * r))
            }
        };
        let quantity = if q != 0.0 && !q.is_nan() {
            Some(q)
        } else {
            None
        };
        earning(
            &mut lines,
            "nl.leave_payout",
            "nl.leave_payout",
            amount,
            Extra {
                quantity: Some(quantity),
                label: Some(it.label.clone()),
                ..Extra::default()
            },
            true,
        );
        bb_white += amount;
        special_rewards_paid += amount;
        qualifying_wage += amount;
        hours_paid += q;
    }

    let mut tax_free_allowances = 0.0;
    let mut travel_tax_free = 0.0;
    for it in items_of("nl.travel_allowance") {
        let km = num(&it.params, "km_per_day");
        let days = num(&it.params, "days_per_month").or(it.quantity);
        let limit = match (km, days) {
            (Some(k), Some(d)) => Some(round(k * d * rules.wkr.per_km_cents)),
            _ => None,
        };
        let amount = it.amount_cents.or(limit).unwrap_or(0.0);
        let free = limit.map_or(amount, |l| js_min(amount, l));
        if free != 0.0 {
            let mut l = line(
                "nl.travel_allowance",
                Section::Reimbursement,
                "nl.travel_allowance",
                free,
            );
            l.label = Some(it.label.clone());
            l.quantity = Some(match (km, days) {
                (Some(k), Some(d)) => Some(k * d),
                _ => None,
            });
            l.rate = Some(limit.map(|_| rules.wkr.per_km_cents / 100.0));
            lines.push(l);
        }
        if amount - free != 0.0 {
            earning(
                &mut lines,
                "nl.travel_allowance_taxable",
                "nl.travel_allowance_taxable",
                amount - free,
                Extra::default(),
                false,
            );
        }
        if km.is_some() {
            travel_tax_free += free;
        }
        tax_free_allowances += free;
    }

    for it in items_of("nl.home_working_allowance") {
        let days = it
            .quantity
            .or_else(|| num(&it.params, "days_per_month"))
            .or_else(|| num(&it.params, "days"))
            .unwrap_or(0.0);
        let limit = round(days * rules.wkr.home_working_per_day_cents);
        let amount = match (it.amount_cents, it.rate) {
            (Some(a), _) => a,
            (None, Some(r)) => round(days * r * 100.0),
            (None, None) => limit,
        };
        let free = js_min(amount, limit);
        if free != 0.0 {
            let mut l = line(
                "nl.home_working_allowance",
                Section::Reimbursement,
                "nl.home_working_allowance",
                free,
            );
            l.label = Some(it.label.clone());
            l.quantity = Some(Some(days));
            l.rate = Some(Some(rules.wkr.home_working_per_day_cents / 100.0));
            lines.push(l);
        }
        if amount - free != 0.0 {
            earning(
                &mut lines,
                "nl.home_working_allowance_taxable",
                "nl.home_working_allowance_taxable",
                amount - free,
                Extra::default(),
                false,
            );
        }
        tax_free_allowances += free;
    }

    let hap = if employer.holiday_allowance_percent.is_finite() {
        employer.holiday_allowance_percent
    } else {
        8.0
    };
    let accrual = if employed {
        round((qualifying_wage * hap) / 100.0)
    } else {
        0.0
    };
    let opening_known = ytd.contains_key(keys::HOLIDAY_ALLOWANCE_OPENING);
    let opening = if opening_known {
        ytd_value(ytd, keys::HOLIDAY_ALLOWANCE_OPENING)
    } else {
        nl.holiday_allowance_opening_balance_cents.unwrap_or(0.0)
    };
    let balance_before = opening + ytd_value(ytd, keys::HOLIDAY_ALLOWANCE_ACCRUED)
        - ytd_value(ytd, keys::HOLIDAY_ALLOWANCE_PAID);
    let mut holiday_paid = 0.0;
    let mut holiday_paid_period = 0.0;
    for it in items_of("nl.holiday_allowance_payout") {
        let amount = it.amount_cents.unwrap_or(0.0);
        earning(
            &mut lines,
            "nl.holiday_allowance_payout",
            "nl.holiday_allowance",
            amount,
            Extra {
                label: Some(it.label.clone()),
                ..Extra::default()
            },
            true,
        );
        holiday_paid += amount;
        bb_white += amount;
    }
    let month = int_of(slice(&period.start, 5, 7));
    match employer.holiday_allowance_payout_month {
        None => {
            holiday_paid_period = accrual;
            earning(
                &mut lines,
                "nl.holiday_allowance",
                "nl.holiday_allowance",
                accrual,
                Extra {
                    rate: Some(Some(hap)),
                    ..Extra::default()
                },
                false,
            );
            holiday_paid += accrual;
        }
        Some(payout_month) => {
            let due = month == payout_month || ends_this_period;
            let balance = balance_before + accrual - holiday_paid;
            if due && balance > 0.0 {
                earning(
                    &mut lines,
                    "nl.holiday_allowance",
                    "nl.holiday_allowance",
                    balance,
                    Extra::default(),
                    true,
                );
                holiday_paid += balance;
                bb_white += balance;
            }
            if accrual != 0.0 {
                let mut l = line(
                    "nl.holiday_allowance_accrued",
                    Section::Info,
                    "nl.holiday_allowance_accrued",
                    accrual,
                );
                l.rate = Some(Some(hap));
                lines.push(l);
            }
        }
    }
    special_rewards_paid += holiday_paid - holiday_paid_period;
    let _ = bb_white;

    let mut transition = 0.0;
    for it in items_of("nl.transition_payment") {
        let amount = it.amount_cents.unwrap_or(0.0);
        if amount == 0.0 {
            continue;
        }
        let mut l = line(
            "nl.transition_payment",
            Section::Earning,
            "nl.transition_payment",
            amount,
        );
        l.label = Some(it.label.clone());
        l.bases = Some(bases(&[B_LB, B_ZVW, B_BB]));
        lines.push(l);
        transition += amount;
    }

    let mut car_value = 0.0;
    let mut car_contribution = 0.0;
    for it in items_of("nl.company_car") {
        let list = to_cents(num(&it.params, "list_price").unwrap_or(0.0));
        let pct = num(&it.params, "percent").unwrap_or(0.0);
        let ze_cap = num(&it.params, "zero_emission_cap");
        let ze_pct = num(&it.params, "zero_emission_percent");
        let annual = match (ze_cap, ze_pct) {
            (Some(cap), Some(zp)) => {
                let capped = js_min(list, to_cents(cap));
                (capped * zp) / 100.0 + (js_max(0.0, list - capped) * pct) / 100.0
            }
            _ => (list * pct) / 100.0,
        };
        let value = round((annual / 12.0) * calendar_fraction);
        let contribution = to_cents(num(&it.params, "employee_contribution").unwrap_or(0.0));
        if value != 0.0 {
            let mut l = line("nl.company_car", Section::Info, "nl.company_car", value);
            l.label = Some(it.label.clone());
            l.bases = Some(bases(period_bases));
            l.rate = Some(Some(pct));
            lines.push(l);
        }
        let room = ytd_value(ytd, keys::COMPANY_CAR_VALUE) + car_value + value
            - ytd_value(ytd, keys::COMPANY_CAR_CONTRIBUTION)
            - car_contribution;
        let deductible = js_max(0.0, js_min(contribution, room));
        if deductible > 0.0 {
            let mut l = line(
                "nl.company_car_contribution",
                Section::Deduction,
                "nl.company_car_contribution",
                -deductible,
            );
            l.bases = Some(bases(period_bases));
            lines.push(l);
        }
        if contribution - deductible > 0.0 {
            lines.push(line(
                "nl.company_car_contribution",
                Section::Deduction,
                "nl.company_car_contribution",
                -(contribution - deductible),
            ));
        }
        car_value += value;
        car_contribution += deductible;
    }

    let pension_amount = |it: &Item| -> f64 {
        if let Some(a) = it.amount_cents {
            return a;
        }
        let pct = num(&it.params, "percent").unwrap_or(0.0);
        let franchise = to_cents(num(&it.params, "franchise_per_year").unwrap_or(0.0));
        let base = js_max(0.0, pensionable_wage - (franchise / 12.0) * proration);
        round((base * pct) / 100.0)
    };
    let mut pension_employee = 0.0;
    for it in items_of("nl.pension_employee") {
        let amount = pension_amount(&it);
        if amount != 0.0 {
            let mut l = line(
                "nl.pension_employee",
                Section::Deduction,
                "nl.pension_employee",
                -amount,
            );
            l.label = Some(it.label.clone());
            l.bases = Some(bases(period_bases));
            l.rate = Some(num(&it.params, "percent"));
            lines.push(l);
        }
        pension_employee += amount;
    }
    let mut pension_employer = 0.0;
    for it in items_of("nl.pension_employer") {
        let amount = pension_amount(&it);
        if amount != 0.0 {
            let mut l = line(
                "nl.pension_employer",
                Section::Employer,
                "nl.pension_employer",
                amount,
            );
            l.label = Some(it.label.clone());
            l.rate = Some(num(&it.params, "percent"));
            lines.push(l);
        }
        pension_employer += amount;
    }

    let mut expat_allowance = 0.0;
    let expat_pct = nl.expat_ruling_percent.unwrap_or(0.0);
    if expat_pct > 0.0 {
        let cash_period: f64 = lines
            .iter()
            .filter(|l| l.section == Section::Earning && l.has_base(B_LB) && !l.has_base(B_BB))
            .map(|l| l.amount_cents)
            .fold(0.0, |a, b| a + b);
        let cash_bb = bb_white;
        let mut part_period = round((cash_period * expat_pct) / 100.0);
        let mut part_bb = round((cash_bb * expat_pct) / 100.0);
        let share = if employed { proration } else { 0.0 };
        let norm_period = (rules.expat.salary_norm_cents / 12.0) * share;
        if cash_period - part_period < norm_period {
            part_period = js_max(0.0, (cash_period - norm_period).floor());
            issues.push(
                PayrollIssue::warning("expat_salary_norm")
                    .with(&[("normCents", n(rules.expat.salary_norm_cents))]),
            );
        }
        let cap = round(
            ((rules.expat.wnt_cap_cents * expat_pct) / 100.0 / 12.0)
                * if employed { share } else { 1.0 },
        );
        part_period = js_min(part_period, cap);
        part_bb = js_max(0.0, js_min(part_bb, cap - part_period));
        if part_period > 0.0 {
            let mut l = line(
                "nl.expat_allowance",
                Section::Info,
                "nl.expat_allowance",
                -part_period,
            );
            l.rate = Some(Some(expat_pct));
            l.bases = Some(bases(period_bases));
            lines.push(l);
        }
        if part_bb > 0.0 {
            let mut l = line(
                "nl.expat_allowance_special",
                Section::Info,
                "nl.expat_allowance",
                -part_bb,
            );
            l.rate = Some(Some(expat_pct));
            l.bases = Some(bases(&bb_bases));
            lines.push(l);
        }
        expat_allowance = part_period + part_bb;
        tax_free_allowances += expat_allowance;
    }

    for it in items_of("reimbursement") {
        let amount = it.amount_cents.unwrap_or(0.0);
        if amount != 0.0 {
            let mut l = line(
                "reimbursement",
                Section::Reimbursement,
                "nl.reimbursement",
                amount,
            );
            l.label = Some(it.label.clone());
            lines.push(l);
        }
    }
    for it in items_of("advance") {
        let amount = it.amount_cents.unwrap_or(0.0);
        let section = if amount > 0.0 {
            Some(Section::Reimbursement)
        } else if amount < 0.0 {
            Some(Section::Deduction)
        } else {
            None
        };
        if let Some(section) = section {
            let mut l = line("advance", section, "nl.advance", amount);
            l.label = Some(it.label.clone());
            lines.push(l);
        }
    }
    for it in items_of("deduction.net") {
        let amount = it.amount_cents.unwrap_or(0.0).abs();
        if amount != 0.0 {
            let mut l = line(
                "deduction.net",
                Section::Deduction,
                "nl.deduction_net",
                -amount,
            );
            l.label = Some(it.label.clone());
            lines.push(l);
        }
    }

    let base_sum = |lines: &[PayslipLine], base: &str| -> f64 {
        lines
            .iter()
            .filter(|l| l.has_base(base))
            .map(|l| l.amount_cents)
            .fold(0.0, |a, b| a + b)
    };
    let loon_lb = base_sum(&lines, B_LB);
    let loon_bb_all = base_sum(&lines, B_BB);
    let loon_sv = if sv_applies {
        base_sum(&lines, B_SV)
    } else {
        0.0
    };
    let loon_zvw = base_sum(&lines, B_ZVW);
    let period_wage = loon_lb - loon_bb_all;
    let has_period_wage = employed || period_wage != 0.0;

    let mut period_tax = 0.0;
    let mut labour_credit = 0.0;
    let mut bb_tax = 0.0;
    let mut bb_percent: Option<f64> = None;
    let mut transition_tax = 0.0;
    let mut transition_percent: Option<f64> = None;
    let mut table_code = "012";
    let annual_wage_for_bb = || -> Cents {
        if let Some(previous) = nl.previous_year_annual_wage_cents {
            return previous;
        }
        let scale = if proration > 0.0 { proration } else { 1.0 };
        let full_month = period_wage / scale;
        let holiday_year = if employer.holiday_allowance_payout_month.is_some() {
            ((qualifying_wage / scale) * 12.0 * hap) / 100.0
        } else {
            0.0
        };
        let one_off = loon_bb_all - (holiday_paid - holiday_paid_period);
        round(full_month * 12.0 + holiday_year + one_off)
    };
    if anonymous {
        table_code = "940";
        period_tax = anonymous_tax(loon_lb, rules);
    } else {
        if has_period_wage && period_wage > 0.0 {
            if day_table_period {
                let per_day = round(period_wage / employed_weekdays);
                let r = period_wage_tax(per_day, period_factor::DAY, column, apply_lhk, rules);
                period_tax = r.tax_cents * employed_weekdays;
                labour_credit = r.labour_credit_cents * employed_weekdays;
                table_code = "015";
            } else {
                let r =
                    period_wage_tax(period_wage, period_factor::MONTH, column, apply_lhk, rules);
                period_tax = r.tax_cents;
                labour_credit = r.labour_credit_cents;
            }
        } else if loon_bb_all != 0.0 {
            table_code = "010";
        }
        let annual = if loon_bb_all != 0.0 {
            annual_wage_for_bb()
        } else {
            0.0
        };
        let white_bb = loon_bb_all - transition;
        if white_bb != 0.0 {
            let percent =
                special_reward_percent(annual, column, apply_lhk, rules, NlTableColour::White);
            bb_percent = Some(percent);
            bb_tax = special_reward_tax(white_bb, percent);
        }
        if transition != 0.0 {
            let percent =
                special_reward_percent(annual, column, apply_lhk, rules, NlTableColour::Green);
            transition_percent = Some(percent);
            transition_tax = special_reward_tax(transition, percent);
        }
    }
    let wage_tax = period_tax + bb_tax + transition_tax;
    if period_tax != 0.0 {
        let mut l = line("nl.wage_tax", Section::Tax, "nl.wage_tax", -period_tax);
        l.rate = Some(if anonymous {
            Some(rules.wage_tax.anonymous_rate_percent)
        } else {
            None
        });
        lines.push(l);
    }
    if bb_tax != 0.0 {
        let mut l = line(
            "nl.wage_tax_special",
            Section::Tax,
            "nl.wage_tax_special",
            -bb_tax,
        );
        l.rate = Some(bb_percent);
        lines.push(l);
    }
    if transition_tax != 0.0 {
        let mut l = line(
            "nl.wage_tax_transition",
            Section::Tax,
            "nl.wage_tax_special",
            -transition_tax,
        );
        l.rate = Some(transition_percent);
        lines.push(l);
    }
    if labour_credit != 0.0 {
        lines.push(line(
            "nl.labour_credit",
            Section::Info,
            "nl.labour_credit",
            labour_credit,
        ));
    }

    let p = &rules.premiums;
    let period_max = if !has_period_wage || !employed {
        0.0
    } else if day_table_period {
        employed_weekdays * p.max_premieloon.day
    } else {
        p.max_premieloon.month
    };
    let mut new_ytd: Ytd = ytd.clone();
    let vcr = |new_ytd: &mut Ytd,
               applies: bool,
               wage_key: &str,
               max_key: &str,
               base_key: &str,
               wage: Cents,
               floor_at_zero: bool|
     -> Cents {
        if !applies {
            return 0.0;
        }
        let cum_wage = ytd_value(ytd, wage_key) + wage;
        let cum_max = ytd_value(ytd, max_key) + period_max;
        let mut base = if anonymous {
            cum_wage
        } else {
            js_min(cum_wage, cum_max)
        };
        if floor_at_zero {
            base = js_max(0.0, base);
        }
        let aanwas = base - ytd_value(ytd, base_key);
        new_ytd.insert(wage_key, cum_wage);
        new_ytd.insert(max_key, cum_max);
        new_ytd.insert(base_key, base);
        aanwas
    };
    let premium = |base: Cents, percent: f64| -> Cents {
        ((base * math_round(percent * 100.0)) / 10_000.0 + 1e-9).floor()
    };
    let awf_low = (nl.written_contract && nl.indefinite_contract && !nl.on_call)
        || (age_at_start.is_some_and(|a| a < 21) && round(hours_paid) <= 52.0);
    let awf_base = vcr(
        &mut new_ytd,
        premiums_apply && insured.ww,
        keys::AWF_CUM_WAGE,
        keys::AWF_CUM_MAX,
        keys::AWF_CUM_BASE,
        loon_sv,
        false,
    );
    let aof_base = vcr(
        &mut new_ytd,
        premiums_apply && insured.wao,
        keys::AOF_CUM_WAGE,
        keys::AOF_CUM_MAX,
        keys::AOF_CUM_BASE,
        loon_sv,
        false,
    );
    let whk_applies = premiums_apply && (insured.wao || insured.zw);
    let whk_base = vcr(
        &mut new_ytd,
        whk_applies,
        keys::WHK_CUM_WAGE,
        keys::WHK_CUM_MAX,
        keys::WHK_CUM_BASE,
        loon_sv,
        false,
    );
    let awf_rate = if awf_low {
        p.awf_low_percent
    } else {
        p.awf_high_percent
    };
    let aof_rate = if employer.aof_small_employer {
        p.aof_low_percent
    } else {
        p.aof_high_percent
    };
    let awf_premium = premium(awf_base, awf_rate);
    let aof_premium = premium(aof_base, aof_rate);
    let wko_premium = premium(aof_base, p.wko_percent);
    let mut whk_percent = employer.whk_rate_percent;
    if whk_percent.is_none() && employer.aof_small_employer {
        if let Some(sector) = employer.sector_code {
            whk_percent = p.whk_sector_percent.get(&sector.to_string()).copied();
        }
    }
    if whk_applies && whk_percent.is_none() {
        issues.push(
            PayrollIssue::error("employer_incomplete").with(&[("field", json!("whkRatePercent"))]),
        );
    }
    let whk_premium = whk_percent.map_or(0.0, |pct| premium(whk_base, pct));

    if nl.written_contract
        && nl.indefinite_contract
        && !nl.on_call
        && insured.ww
        && ends_this_period
    {
        if let (Some(start), Some(end)) = (
            employee.start_date.as_deref().filter(|s| !s.is_empty()),
            employee.end_date.as_deref().filter(|e| !e.is_empty()),
        ) {
            if end < add_years_months(start, 0, 2).as_str() {
                issues.push(
                    PayrollIssue::warning("awf_revision_required")
                        .with(&[("startDate", json!(start)), ("endDate", json!(end))]),
                );
            }
        }
    }

    let zvw_applies = has_period_wage || loon_zvw != 0.0;
    let zvw_base = vcr(
        &mut new_ytd,
        zvw_applies,
        keys::ZVW_CUM_WAGE,
        keys::ZVW_CUM_MAX,
        keys::ZVW_CUM_BASE,
        loon_zvw,
        true,
    );
    let zvw_percent = if is_dga {
        p.zvw_withheld_percent
    } else {
        p.zvw_employer_levy_percent
    };
    let zvw_amount = premium(zvw_base, zvw_percent);
    let mut transition_zvw_base = 0.0;
    let mut transition_zvw = 0.0;
    if transition != 0.0 && zvw_applies {
        let cum_wage_regular = ytd_value(ytd, keys::ZVW_CUM_WAGE) + loon_zvw - transition;
        let cum_max = ytd_value(ytd, keys::ZVW_CUM_MAX) + period_max;
        let regular_base = js_max(
            0.0,
            if anonymous {
                cum_wage_regular
            } else {
                js_min(cum_wage_regular, cum_max)
            },
        ) - ytd_value(ytd, keys::ZVW_CUM_BASE);
        transition_zvw_base = zvw_base - regular_base;
        transition_zvw = zvw_amount - premium(regular_base, zvw_percent);
    }
    let zvw_withheld = if is_dga { zvw_amount } else { 0.0 };
    let zvw_levy = if is_dga { 0.0 } else { zvw_amount };
    if zvw_withheld != 0.0 {
        let mut l = line(
            "nl.zvw_contribution",
            Section::Tax,
            "nl.zvw_contribution",
            -zvw_withheld,
        );
        l.rate = Some(Some(zvw_percent));
        lines.push(l);
    }
    let employer_line =
        |lines: &mut Vec<PayslipLine>, code: &str, amount: Cents, rate: Option<f64>| {
            if amount != 0.0 {
                let mut l = line(code, Section::Employer, code, amount);
                l.rate = Some(rate);
                lines.push(l);
            }
        };
    employer_line(&mut lines, "nl.awf_premium", awf_premium, Some(awf_rate));
    employer_line(&mut lines, "nl.aof_premium", aof_premium, Some(aof_rate));
    employer_line(
        &mut lines,
        "nl.wko_premium",
        wko_premium,
        Some(p.wko_percent),
    );
    employer_line(&mut lines, "nl.whk_premium", whk_premium, whk_percent);
    employer_line(
        &mut lines,
        "nl.zvw_employer_levy",
        zvw_levy,
        Some(p.zvw_employer_levy_percent),
    );

    if let (false, Some(age), Some(hourly), true) =
        (is_dga, age_at_end, hourly_rate_cents, employed)
    {
        if age >= 15 {
            let entry = rules
                .minimum_wage
                .iter()
                .rev()
                .find(|w| w.from.as_str() <= period.start.as_str())
                .unwrap_or(&rules.minimum_wage[0]);
            let key = age.min(21).to_string();
            let minimum = entry.per_hour.get(&key).copied().unwrap_or(f64::NAN);
            let mut l = line("nl.minimum_wage", Section::Info, "nl.minimum_wage", minimum);
            l.quantity = Some(None);
            l.rate = Some(Some(minimum / 100.0));
            lines.push(l);
            if round(hourly) < minimum {
                issues.push(PayrollIssue::error("below_minimum_wage").with(&[
                    ("hourlyCents", n(round(hourly))),
                    ("minimumCents", n(minimum)),
                    ("age", json!(age)),
                ]));
            }
        }
    }
    if is_dga {
        if let Some(monthly) = monthly_salary_cents {
            if monthly * 12.0 < rules.dga_usual_salary_cents {
                issues.push(PayrollIssue::warning("dga_usual_salary").with(&[
                    ("annualCents", n(round(monthly * 12.0))),
                    ("minimumCents", n(rules.dga_usual_salary_cents)),
                ]));
            }
        }
    }

    let by_section = |section: Section| -> f64 {
        lines
            .iter()
            .filter(|l| l.section == section)
            .map(|l| l.amount_cents)
            .fold(0.0, |a, b| a + b)
    };
    let gross_cents = by_section(Section::Earning);
    let employee_taxes_cents = -by_section(Section::Tax);
    let employee_deductions_cents = -by_section(Section::Deduction);
    let reimbursements_cents = by_section(Section::Reimbursement);
    let net_cents =
        gross_cents - employee_taxes_cents - employee_deductions_cents + reimbursements_cents;
    let employer_taxes_cents = awf_premium + aof_premium + wko_premium + whk_premium + zvw_levy;
    let employer_cost_cents =
        gross_cents + employer_taxes_cents + pension_employer + reimbursements_cents;
    if net_cents < 0.0 {
        issues.push(PayrollIssue::error("negative_net_pay").with(&[("netCents", n(net_cents))]));
    } else if net_cents == 0.0 && gross_cents != 0.0 {
        issues.push(PayrollIssue::warning("net_pay_zero"));
    }

    let sv_days = if sv_applies { employed_weekdays } else { 0.0 };
    let hours_paid_rounded = round(hours_paid);
    let cash_wage = gross_cents - expat_allowance;
    let in_kind_wage = car_value - car_contribution;
    let contract_wage = match comp {
        Some(c) => round(if c.pay_type == PayType::Salary {
            monthly_salary_cents.unwrap_or(0.0)
        } else {
            hourly_rate_cents.unwrap_or(0.0) * ((contract_hours.unwrap_or(0.0) * 52.0) / 12.0)
        }),
        None => 0.0,
    };
    let mut amounts = NlAmounts {
        loon_lb_ph: loon_lb,
        loon_sv,
        premieloon_awf: awf_base,
        premieloon_aof: aof_base,
        premieloon_whk: whk_base,
        loon_zvw: zvw_base,
        loon_tabel_bijzondere_beloningen: loon_bb_all,
        wage_tax,
        labour_credit,
        awf_premium,
        aof_premium,
        wko_premium,
        whk_premium,
        zvw_employer_levy: zvw_levy,
        zvw_withheld,
        holiday_allowance_paid: holiday_paid,
        holiday_allowance_accrued: accrual,
        company_car_value: car_value,
        company_car_employee_contribution: car_contribution,
        pension_employee,
        tax_free_allowances,
        cash_wage: Some(cash_wage),
        in_kind_wage: Some(in_kind_wage),
        overtime_wage: Some(overtime_wage),
        travel_allowance_tax_free: Some(travel_tax_free),
        contract_wage: Some(contract_wage),
        ..NlAmounts::default()
    };
    if transition != 0.0 {
        amounts.transition_payment = Some(transition);
        amounts.transition_payment_wage_tax = Some(transition_tax);
        amounts.transition_payment_loon_zvw = Some(transition_zvw_base);
        amounts.transition_payment_zvw = Some(transition_zvw);
    }
    let filing_data = NlFilingData {
        table_code: table_code.to_owned(),
        apply_loonheffingskorting: apply_lhk,
        anonymous,
        insured,
        awf_rate: rate_level(awf_low),
        aof_rate: rate_level(employer.aof_small_employer),
        zvw: if is_dga {
            ZvwKind::Withheld
        } else if zvw_applies {
            ZvwKind::EmployerLevy
        } else {
            ZvwKind::None
        },
        contract: Contract {
            written: nl.written_contract,
            indefinite: nl.indefinite_contract,
            on_call: nl.on_call,
        },
        amounts,
        hours_paid: hours_paid_rounded,
        sv_days,
        contract_hours_per_week: Some(contract_hours),
        is_dga: Some(is_dga),
        incidental_income_reduction: Some(incidental),
    };

    if !opening_known {
        new_ytd.insert(keys::HOLIDAY_ALLOWANCE_OPENING, opening);
    }
    let mut add = |key: &str, value: f64| {
        let current = ytd_value(&new_ytd, key);
        new_ytd.insert(key, current + value);
    };
    add(keys::LOON_LB_PH, loon_lb);
    add(keys::LOON_BB, loon_bb_all);
    add(keys::LOON_SV, loon_sv);
    add(keys::LOON_ZVW, loon_zvw);
    add(keys::CASH_WAGE, cash_wage);
    add(keys::IN_KIND_WAGE, in_kind_wage);
    add(keys::GROSS, gross_cents);
    add(keys::NET, net_cents);
    add(keys::WAGE_TAX, wage_tax);
    add(keys::LABOUR_CREDIT, labour_credit);
    add(keys::ZVW_WITHHELD, zvw_withheld);
    add(keys::ZVW_EMPLOYER_LEVY, zvw_levy);
    add(keys::AWF_PREMIUM, awf_premium);
    add(keys::AOF_PREMIUM, aof_premium);
    add(keys::WKO_PREMIUM, wko_premium);
    add(keys::WHK_PREMIUM, whk_premium);
    add(keys::HOLIDAY_ALLOWANCE_ACCRUED, accrual);
    add(keys::HOLIDAY_ALLOWANCE_PAID, holiday_paid);
    add(keys::SPECIAL_REWARDS, special_rewards_paid);
    add(keys::TRANSITION_PAYMENT, transition);
    add(keys::PENSION_EMPLOYEE, pension_employee);
    add(keys::PENSION_EMPLOYER, pension_employer);
    add(keys::COMPANY_CAR_VALUE, car_value);
    add(keys::COMPANY_CAR_CONTRIBUTION, car_contribution);
    add(keys::TAX_FREE_ALLOWANCES, tax_free_allowances);
    add(keys::EXPAT_ALLOWANCE, expat_allowance);
    add(keys::TRAVEL_ALLOWANCE_TAX_FREE, travel_tax_free);
    add(keys::OVERTIME_WAGE, overtime_wage);
    add(keys::HOURS_PAID_X100, round(hours_paid * 100.0));
    add(keys::SV_DAYS, sv_days);
    add(
        keys::MONTHS_EMPLOYED_X10000,
        round(calendar_fraction * 10_000.0),
    );
    add(keys::EMPLOYER_COST, employer_cost_cents);

    let _ = is_integer;
    Ok(PayslipResult {
        lines,
        gross_cents,
        taxable_wage_cents: loon_lb,
        employee_taxes_cents,
        employee_deductions_cents,
        reimbursements_cents,
        net_cents,
        employer_taxes_cents,
        employer_cost_cents,
        ytd: new_ytd,
        filing_data: FilingData::Nl(Box::new(filing_data)),
        issues,
        rule_set: rules.id.clone(),
    })
}
