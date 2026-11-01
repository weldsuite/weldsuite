#![allow(clippy::many_single_char_names)]

//! The TypeScript US engines' answers (`tests/fixtures/us-*.json`, written
//! by `pnpm rust:payroll-fixtures`) against the Rust ones.

use serde_json::{Value, json};
use weldsuite_payroll_domain::js::{to_value, whole_numbers};
use weldsuite_payroll_domain::ordered::OrderedMap;
use weldsuite_payroll_domain::us::dates::{
    annual_return_due_date, business_days_after, legal_holidays, quarterly_return_due_date,
};
use weldsuite_payroll_domain::us::federal_rules::federal_rules;
use weldsuite_payroll_domain::us::overtime::{
    HoursEntry, OvertimeInput, OvertimeResult, compute_overtime,
};
use weldsuite_payroll_domain::us::states::calculate_state;
use weldsuite_payroll_domain::us::states::common::{Pretax, StateCalcInput, StateCalcResult};
use weldsuite_payroll_domain::us::withholding::{
    SupplementalArgs, SupplementalMethod, supplemental_withholding, worksheet_1a,
};
use weldsuite_payroll_domain::{
    PayslipInput, UsStateCertificateInput, UsW4Input, Ytd, calculate_payslip,
};

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn diff(a: &Value, b: &Value, at: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
            keys.sort();
            keys.dedup();
            keys.into_iter().find_map(|k| {
                diff(
                    x.get(k).unwrap_or(&Value::Null),
                    y.get(k).unwrap_or(&Value::Null),
                    &format!("{at}.{k}"),
                )
                .or_else(|| {
                    (x.contains_key(k) != y.contains_key(k))
                        .then(|| format!("{at}.{k}: present on one side"))
                })
            })
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!("{at}: {} vs {} items", x.len(), y.len()));
            }
            x.iter()
                .zip(y)
                .enumerate()
                .find_map(|(i, (p, q))| diff(p, q, &format!("{at}[{i}]")))
        }
        (Value::Number(x), Value::Number(y)) => {
            (x.as_f64() != y.as_f64()).then(|| format!("{at}: {x} vs {y}"))
        }
        _ => (a != b).then(|| format!("{at}: {a} vs {b}")),
    }
}

fn assert_same(case: usize, expected: &Value, actual: &Value) {
    if let Some(d) = diff(&whole_numbers(expected.clone()), actual, "$") {
        panic!("case {case}: {d}");
    }
}

fn result_value<T: serde::Serialize, E: std::fmt::Display>(r: Result<T, E>) -> Value {
    match r {
        Ok(v) => to_value(&v),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

#[test]
fn us_payslips() {
    for (i, case) in fixture("us-payslips.json")
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let input: PayslipInput = serde_json::from_value(case["input"].clone())
            .unwrap_or_else(|e| panic!("case {i}: {e}"));
        assert_same(i, &case["output"], &result_value(calculate_payslip(&input)));
    }
}

fn state_result_value(r: &StateCalcResult) -> Value {
    whole_numbers(json!({
        "stateWagesCents": r.state_wages_cents,
        "incomeTaxCents": r.income_tax_cents,
        "sui": {
            "taxableWagesCents": r.sui.taxable_wages_cents,
            "grossWagesCents": r.sui.gross_wages_cents,
            "employerCents": r.sui.employer_cents,
            "employeeCents": r.sui.employee_cents,
        },
        "programs": r.programs.iter().map(|p| json!({
            "code": p.code, "labelKey": p.label_key, "wagesCents": p.wages_cents,
            "employeeCents": p.employee_cents, "employerCents": p.employer_cents,
        })).collect::<Vec<_>>(),
        "ytdUpdates": to_value(&r.ytd_updates),
        "issues": to_value(&r.issues),
        "ruleSet": r.rule_set,
    }))
}

#[test]
fn us_states() {
    for (i, case) in fixture("us-states.json")
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let v = &case["input"];
        let f = |k: &str| v[k].as_f64().unwrap_or(0.0);
        let certificate: Option<UsStateCertificateInput> =
            serde_json::from_value(v["certificate"].clone()).expect("cert");
        let w4: Option<UsW4Input> = serde_json::from_value(v["federalW4"].clone()).expect("w4");
        let extra: OrderedMap<f64> =
            serde_json::from_value(v["extraRates"].clone()).expect("extra");
        let ytd: Ytd = serde_json::from_value(v["ytd"].clone()).expect("ytd");
        let p = &v["pretax"];
        let state = v["state"].as_str().unwrap_or("").to_owned();
        let input = StateCalcInput {
            state: state.clone(),
            tax_year: v["taxYear"].as_i64().unwrap_or(0),
            pay_date: v["payDate"].as_str().unwrap_or(""),
            period_start: v["periodStart"].as_str().unwrap_or(""),
            period_end: v["periodEnd"].as_str().unwrap_or(""),
            periods_per_year: f("periodsPerYear"),
            regular_wages_cents: f("regularWagesCents"),
            supplemental_wages_cents: f("supplementalWagesCents"),
            pretax: Pretax {
                retirement401k_cents: p["retirement401kCents"].as_f64().unwrap_or(0.0),
                section125_cents: p["section125Cents"].as_f64().unwrap_or(0.0),
                hsa_cents: p["hsaCents"].as_f64().unwrap_or(0.0),
                dependent_care_cents: p["dependentCareCents"].as_f64().unwrap_or(0.0),
            },
            certificate: certificate.as_ref(),
            federal_w4: w4.as_ref(),
            sui_rate_percent: v["suiRatePercent"].as_f64(),
            extra_rates: Some(&extra),
            employee_count_estimate: v["employeeCountEstimate"].as_f64(),
            ytd: &ytd,
            residence_state: v["residenceState"].as_str(),
            exempt_from_sui: v["exemptFromSui"].as_bool().unwrap_or(false),
            fica_employee_cents: v.get("ficaEmployeeCents").and_then(Value::as_f64),
        };
        let result = calculate_state(&state, &input).expect("module");
        assert_same(i, &case["result"], &state_result_value(&result));
    }
}

fn overtime_value(r: &OvertimeResult) -> Value {
    whole_numbers(json!({
        "weeks": r.weeks.iter().map(|w| json!({
            "weekStart": w.week_start, "weekEnd": w.week_end, "hours": w.hours,
            "regularRateCents": w.regular_rate_cents, "flsaOvertimeHours": w.flsa_overtime_hours,
            "overtimeHours": w.overtime_hours, "doubleTimeHours": w.double_time_hours,
            "requiredCents": w.required_cents, "creditedCents": w.credited_cents,
            "qualifiedOvertimeCents": w.qualified_overtime_cents,
        })).collect::<Vec<_>>(),
        "lines": r.lines.iter().map(|l| json!({
            "kind": l.kind.as_str(), "hours": l.hours, "rate": l.rate, "amountCents": l.amount_cents,
        })).collect::<Vec<_>>(),
        "qualifiedOvertimeCents": r.qualified_overtime_cents,
        "carryOut": to_value(&r.carry_out),
        "settledCarryKeys": r.settled_carry_keys,
    }))
}

#[test]
fn us_federal() {
    let f = fixture("us-federal.json");
    let rules = federal_rules(2026).expect("2026 rules");
    for (i, case) in f["withholding"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let w4: UsW4Input = serde_json::from_value(case["w4"].clone()).expect("w4");
        let periods = case["periods"].as_f64().unwrap_or(0.0);
        let wages = case["wages"].as_f64().unwrap_or(0.0);
        let w = worksheet_1a(rules, &w4, wages, periods);
        let actual = json!({
            "annualWagesCents": w.annual_wages_cents, "adjustedAnnualWageCents": w.adjusted_annual_wage_cents,
            "tentativeAnnualCents": w.tentative_annual_cents, "creditsPerPeriodCents": w.credits_per_period_cents,
            "extraCents": w.extra_cents, "withholdingCents": w.withholding_cents,
        });
        assert_same(i, &case["worksheet"], &whole_numbers(actual));
        let a = &case["args"];
        let n = |k: &str| a[k].as_f64().unwrap_or(0.0);
        assert_same(
            i,
            &a["nraAdditionCents"],
            &to_value(
                &weldsuite_payroll_domain::us::withholding::nra_addition_cents(rules, &w4, periods),
            ),
        );
        let s = supplemental_withholding(&SupplementalArgs {
            rules,
            w4: &w4,
            supplemental_cents: n("supplementalCents"),
            ytd_supplemental_cents: n("ytdSupplementalCents"),
            regular_wages_cents: n("regularWagesCents"),
            nra_addition_cents: n("nraAdditionCents"),
            periods_per_year: n("periodsPerYear"),
            regular_withheld_this_year_cents: n("regularWithheldThisYearCents"),
        });
        let method = match s.method {
            SupplementalMethod::Flat => "flat",
            SupplementalMethod::Aggregate => "aggregate",
            SupplementalMethod::None => "none",
        };
        let actual = json!({
            "flatCents": s.flat_cents, "mandatoryCents": s.mandatory_cents,
            "aggregateCents": s.aggregate_cents, "method": method,
        });
        assert_same(i, &case["supplemental"], &whole_numbers(actual));
    }
    for (i, case) in f["overtime"].as_array().into_iter().flatten().enumerate() {
        let v = &case["input"];
        let entries: Vec<HoursEntry> = v["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| HoursEntry {
                date: e["date"].as_str().unwrap_or("").to_owned(),
                hours: e["hours"].as_f64().unwrap_or(0.0),
                rate_cents: e["rateCents"].as_f64().unwrap_or(0.0),
                multiplier: e["multiplier"].as_f64(),
            })
            .collect();
        let ytd: Ytd = serde_json::from_value(v["ytd"].clone()).expect("ytd");
        let result = compute_overtime(&OvertimeInput {
            entries: &entries,
            period_start: v["periodStart"].as_str().unwrap_or(""),
            period_end: v["periodEnd"].as_str().unwrap_or(""),
            workweek_start_day: v["workweekStartDay"].as_i64().unwrap_or(0),
            california: v["california"].as_bool().unwrap_or(false),
            salaried_regular_rate_cents: v["salariedRegularRateCents"].as_f64(),
            ytd: &ytd,
        })
        .expect("overtime");
        assert_same(i, &case["result"], &overtime_value(&result));
    }
    for case in f["dates"].as_array().into_iter().flatten() {
        let year = case["year"].as_i64().unwrap_or(0);
        assert_eq!(
            to_value(&legal_holidays(year).expect("holidays")),
            case["holidays"],
            "{year}"
        );
        let due: Vec<String> = (1..=4)
            .map(|q| quarterly_return_due_date(year, q).expect("due"))
            .collect();
        assert_eq!(to_value(&due), case["due"], "{year}");
        assert_eq!(
            case["annual"].as_str(),
            annual_return_due_date(year).ok().as_deref()
        );
        assert_eq!(
            case["after"].as_str(),
            business_days_after(&format!("{year}-12-22"), 3)
                .ok()
                .as_deref()
        );
    }
}
