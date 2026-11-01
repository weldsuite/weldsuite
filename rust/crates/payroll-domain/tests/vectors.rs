//! The TypeScript engines' answers (`tests/fixtures`, written by
//! `pnpm rust:payroll-fixtures`) against the Rust ones.

use serde_json::{Value, json};
use weldsuite_payroll_domain::js::{to_value, whole_numbers};
use weldsuite_payroll_domain::money::{from_cents, to_cents};
use weldsuite_payroll_domain::nl::annual_statement::{NlAnnualStatementInput, nl_annual_statement};
use weldsuite_payroll_domain::nl::loonaangifte::{
    LoonaangifteInput, betalingskenmerk, build_loonaangifte, is_valid_bsn,
    loonaangifte_summary_document, sum_nl_filing_data,
};
use weldsuite_payroll_domain::nl::rules::nl_rules_for_year;
use weldsuite_payroll_domain::nl::wage_tax::{
    NlAgeColumn, NlTableColour, period_wage_tax, special_reward_percent,
};
use weldsuite_payroll_domain::periods::{
    PayDateRule, PayScheduleSpec, age_on, next_period_to_run, period_containing, quarter_of,
    weekdays_between,
};
use weldsuite_payroll_domain::{
    FilingData, NlFilingData, PayFrequency, PayrollCountry, PayslipInput, calculate_payslip,
};

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The first place two JSON values differ.
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

#[test]
fn money() {
    for (i, case) in fixture("money.json")
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let v = case["value"].as_f64().unwrap_or(0.0);
        assert_same(i, &case["toCents"], &to_value(&to_cents(v)));
        let cents = weldsuite_payroll_domain::js::math_round(v * 100.0);
        assert_eq!(
            case["fromCents"].as_str(),
            Some(from_cents(cents).as_str()),
            "case {i}"
        );
    }
}

fn spec_of(value: &Value) -> PayScheduleSpec {
    let rule = &value["payDateRule"];
    PayScheduleSpec {
        frequency: PayFrequency::parse(value["frequency"].as_str().unwrap_or(""))
            .unwrap_or(PayFrequency::Monthly),
        anchor_date: value["anchorDate"].as_str().unwrap_or("").to_owned(),
        pay_date_rule: match rule["kind"].as_str() {
            Some("day_of_month") => PayDateRule::DayOfMonth {
                day: rule["day"].as_f64().unwrap_or(0.0),
            },
            Some("offset_after_end") => PayDateRule::OffsetAfterEnd {
                days: rule["days"].as_f64().unwrap_or(0.0),
            },
            _ => PayDateRule::LastBusinessDay,
        },
    }
}

fn result_value<T: serde::Serialize, E: std::fmt::Display>(r: Result<T, E>) -> Value {
    match r {
        Ok(v) => to_value(&v),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

#[test]
fn periods() {
    let f = fixture("periods.json");
    for (i, case) in f["cases"].as_array().into_iter().flatten().enumerate() {
        let spec = spec_of(&case["spec"]);
        let country = if case["country"] == "NL" {
            PayrollCountry::Nl
        } else {
            PayrollCountry::Us
        };
        let date = case["date"].as_str().unwrap_or("");
        assert_same(
            i,
            &case["containing"],
            &result_value(period_containing(&spec, country, date)),
        );
        let last = case["last"].is_object().then_some((date, date));
        assert_same(
            i,
            &case["next"],
            &result_value(next_period_to_run(&spec, country, last)),
        );
    }
    for (i, case) in f["dates"].as_array().into_iter().flatten().enumerate() {
        let (a, b) = (
            case["a"].as_str().unwrap_or(""),
            case["b"].as_str().unwrap_or(""),
        );
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        assert_eq!(
            case["weekdays"].as_i64(),
            weekdays_between(lo, hi).ok(),
            "case {i}"
        );
        assert_eq!(case["age"].as_i64(), age_on(a, b).ok(), "case {i}");
        assert_eq!(case["quarter"].as_i64(), Some(quarter_of(b)), "case {i}");
    }
}

fn column_of(value: &Value) -> NlAgeColumn {
    match value.as_str() {
        Some("aow1945") => NlAgeColumn::Aow1945,
        Some("aow1946") => NlAgeColumn::Aow1946,
        _ => NlAgeColumn::BelowAow,
    }
}

#[test]
fn nl_wage_tax() {
    for (i, case) in fixture("nl-wage-tax.json")
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let rules = nl_rules_for_year(case["year"].as_i64().unwrap_or(0)).expect("rules");
        let (factor, wage) = (
            case["factor"].as_f64().unwrap_or(0.0),
            case["wage"].as_f64().unwrap_or(0.0),
        );
        let column = column_of(&case["column"]);
        let lhk = case["lhk"].as_bool().unwrap_or(false);
        let r = period_wage_tax(wage, factor, column, lhk, rules);
        let actual = json!({
            "taxCents": r.tax_cents, "labourCreditCents": r.labour_credit_cents,
            "annualWage": r.annual_wage, "tableWageCents": r.table_wage_cents,
        });
        assert_same(i, &case["result"], &whole_numbers(actual));
        let white = special_reward_percent(wage * 12.0, column, lhk, rules, NlTableColour::White);
        let green = special_reward_percent(wage * 12.0, column, lhk, rules, NlTableColour::Green);
        assert_same(i, &case["white"], &to_value(&white));
        assert_same(i, &case["green"], &to_value(&green));
    }
}

#[test]
fn nl_payslips() {
    for (i, case) in fixture("nl-payslips.json")
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

fn nl_filing(value: &Value) -> NlFilingData {
    match serde_json::from_value::<FilingData>(value.clone()) {
        Ok(FilingData::Nl(f)) => *f,
        other => panic!("not NL filing data: {other:?}"),
    }
}

#[test]
fn nl_loonaangifte() {
    let f = fixture("nl-loonaangifte.json");
    for (i, case) in f["cases"].as_array().into_iter().flatten().enumerate() {
        let input: LoonaangifteInput = serde_json::from_value(case["input"].clone())
            .unwrap_or_else(|e| panic!("case {i}: {e}"));
        let result = build_loonaangifte(&input);
        let actual = json!({
            "file": to_value(&result.file),
            "summary": to_value(&result.summary),
            "amountDueCents": to_value(&result.amount_due_cents),
            "issues": to_value(&result.issues),
        });
        assert_eq!(
            case["result"]["file"]["content"].as_str(),
            Some(result.file.content.as_str()),
            "case {i}: file"
        );
        assert_same(i, &case["result"], &actual);
        let en = loonaangifte_summary_document(
            &result,
            &input,
            weldsuite_payroll_domain::documents::Lang::En,
        );
        let nl = loonaangifte_summary_document(
            &result,
            &input,
            weldsuite_payroll_domain::documents::Lang::Nl,
        );
        assert_same(i, &case["summaryEn"], &to_value(&en));
        assert_same(i, &case["summaryNl"], &to_value(&nl));
    }
    for (i, case) in f["kenmerken"].as_array().into_iter().flatten().enumerate() {
        let k = betalingskenmerk(
            case["loonheffingennummer"].as_str().unwrap_or(""),
            case["taxYear"].as_i64().unwrap_or(0),
            case["month"].as_i64().unwrap_or(0),
        );
        assert_eq!(case["kenmerk"].as_str(), k.as_deref(), "kenmerk {i}");
    }
    for case in f["bsns"].as_array().into_iter().flatten() {
        assert_eq!(
            case["valid"].as_bool(),
            Some(is_valid_bsn(case["bsn"].as_str())),
            "{case}"
        );
    }
    for (i, case) in f["sums"].as_array().into_iter().flatten().enumerate() {
        let items: Vec<NlFilingData> = case["items"]
            .as_array()
            .into_iter()
            .flatten()
            .map(nl_filing)
            .collect();
        let sum = sum_nl_filing_data(&items).expect("sum");
        assert_same(i, &case["sum"], &to_value(&FilingData::Nl(Box::new(sum))));
    }
    for (i, case) in f["annual"].as_array().into_iter().flatten().enumerate() {
        let input: NlAnnualStatementInput = serde_json::from_value(case["input"].clone())
            .unwrap_or_else(|e| panic!("annual {i}: {e}"));
        assert_same(
            i,
            &case["document"],
            &to_value(&nl_annual_statement(&input)),
        );
    }
}
