//! Payment files, US forms and PDFs against what the TypeScript writes
//! (`tests/fixtures/{payment-files,us-forms,pdf}.json`).

use serde_json::{Value, json};
use weldsuite_payroll_domain::documents::{Lang, PayrollDocument};
use weldsuite_payroll_domain::js::{to_value, whole_numbers};
use weldsuite_payroll_domain::nacha::{NachaFileInput, build_nacha_file};
use weldsuite_payroll_domain::payslip_pdf::{
    PayslipView, page_contents, render_document_pdf, render_payslip_pdf,
};
use weldsuite_payroll_domain::sepa::{SepaSalaryBatchInput, build_sepa_salary_batch};
use weldsuite_payroll_domain::us::forms::{
    EmployeePayslips, Form941Input, UsEmployerForForms, UsFormResult, UsPayslipForForms,
    deposit_due_date, form_w2, form_w3, form940, form941, state_unemployment_report,
    state_withholding_report,
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

fn assert_same(case: &str, expected: &Value, actual: &Value) {
    if let Some(d) = diff(&whole_numbers(expected.clone()), actual, "$") {
        panic!("{case}: {d}");
    }
}

#[test]
fn payment_files() {
    let f = fixture("payment-files.json");
    for (i, case) in f["sepa"].as_array().into_iter().flatten().enumerate() {
        let input: SepaSalaryBatchInput =
            serde_json::from_value(case["input"].clone()).expect("sepa input");
        let out = build_sepa_salary_batch(&input);
        let mut actual = to_value(&out.file);
        actual["issues"] = to_value(&out.issues);
        assert_eq!(
            case["output"]["content"].as_str(),
            Some(out.file.content.as_str()),
            "sepa {i}"
        );
        assert_same(&format!("sepa {i}"), &case["output"], &actual);
    }
    for (i, case) in f["nacha"].as_array().into_iter().flatten().enumerate() {
        let input: NachaFileInput =
            serde_json::from_value(case["input"].clone()).expect("nacha input");
        let actual = match build_nacha_file(&input) {
            Ok(out) => {
                let mut v = to_value(&out.file);
                v["issues"] = to_value(&out.issues);
                v
            }
            Err(e) => json!({ "error": e.to_string() }),
        };
        assert_same(&format!("nacha {i}"), &case["output"], &actual);
    }
}

fn form_value(r: &UsFormResult) -> Value {
    let mut v = json!({
        "summary": to_value(&r.summary),
        "amountDueCents": to_value(&r.amount_due_cents),
        "dueDate": r.due_date,
        "document": to_value(&r.document),
    });
    if let Some(files) = &r.files {
        v["files"] = to_value(files);
    }
    v
}

#[test]
fn us_forms() {
    let f = fixture("us-forms.json");
    for (i, case) in f["forms"].as_array().into_iter().flatten().enumerate() {
        let employer: UsEmployerForForms =
            serde_json::from_value(case["employer"].clone()).expect("employer");
        let people: Vec<EmployeePayslips> =
            serde_json::from_value(case["people"].clone()).expect("people");
        let all: Vec<UsPayslipForForms> = people.iter().flat_map(|p| p.payslips.clone()).collect();
        let quarter = case["quarter"].as_i64().unwrap_or(1);
        let state = case["state"].as_str().unwrap_or("");
        let f941 = form941(&Form941Input {
            employer: &employer,
            tax_year: 2026,
            quarter,
            payslips: &all,
            deposits_cents: case["options941"]["depositsCents"].as_f64(),
            prior_quarter_line12_cents: case["options941"]["priorQuarterLine12Cents"].as_f64(),
        })
        .expect("941");
        assert_same(&format!("941 {i}"), &case["f941"], &form_value(&f941));
        let f940 = form940(
            &employer,
            2026,
            &all,
            case["options940"]["depositsCents"].as_f64(),
        )
        .expect("940");
        assert_same(&format!("940 {i}"), &case["f940"], &form_value(&f940));
        for (n, person) in people.iter().enumerate() {
            let w2 = form_w2(&employer, &person.employee, 2026, &person.payslips).expect("w2");
            assert_same(&format!("w2 {i}/{n}"), &case["w2"][n], &form_value(&w2));
        }
        assert_same(
            &format!("w3 {i}"),
            &case["w3"],
            &form_value(&form_w3(&employer, 2026, &people).expect("w3")),
        );
        let wh = state_withholding_report(&employer, state, 2026, quarter, &people)
            .expect("withholding");
        assert_same(
            &format!("withholding {i}"),
            &case["withholding"],
            &form_value(&wh),
        );
        let ui = state_unemployment_report(&employer, state, 2026, quarter, &people)
            .expect("unemployment");
        assert_same(
            &format!("unemployment {i}"),
            &case["unemployment"],
            &form_value(&ui),
        );
    }
    for (i, case) in f["deposits"].as_array().into_iter().flatten().enumerate() {
        let due = deposit_due_date(
            case["schedule"].as_str().unwrap_or(""),
            case["payDate"].as_str().unwrap_or(""),
            case["accumulatedCents"].as_f64(),
        );
        assert_eq!(case["due"].as_str(), due.ok().as_deref(), "deposit {i}");
    }
}

#[test]
fn pdfs() {
    let f = fixture("pdf.json");
    for (i, case) in f["docs"].as_array().into_iter().flatten().enumerate() {
        let doc: PayrollDocument = serde_json::from_value(case["doc"].clone()).expect("document");
        let pages = page_contents(&render_document_pdf(&doc));
        let expected: Vec<String> = serde_json::from_value(case["pages"].clone()).expect("pages");
        assert_eq!(expected.len(), pages.len(), "doc {i}: pages");
        for (p, (e, a)) in expected.iter().zip(&pages).enumerate() {
            if e != a {
                let at = e.chars().zip(a.chars()).take_while(|(x, y)| x == y).count();
                let start = at.saturating_sub(200);
                panic!(
                    "doc {i} page {p}: differ at {at}\nTS:   {}\nRust: {}",
                    e.chars().skip(start).take(400).collect::<String>(),
                    a.chars().skip(start).take(400).collect::<String>()
                );
            }
        }
    }
    for (i, case) in f["payslips"].as_array().into_iter().flatten().enumerate() {
        let view: PayslipView = serde_json::from_value(case["view"].clone())
            .unwrap_or_else(|e| panic!("payslip {i}: {e}"));
        let lang = if case["lang"] == "nl" {
            Lang::Nl
        } else {
            Lang::En
        };
        let pages = page_contents(&render_payslip_pdf(&view, lang));
        let expected: Vec<String> = serde_json::from_value(case["pages"].clone()).expect("pages");
        assert_eq!(expected.len(), pages.len(), "payslip {i}: pages");
        for (p, (e, a)) in expected.iter().zip(&pages).enumerate() {
            if e != a {
                let at = e.chars().zip(a.chars()).take_while(|(x, y)| x == y).count();
                let start = at.saturating_sub(200);
                panic!(
                    "payslip {i} page {p}: differ at {at}\nTS:   {}\nRust: {}",
                    e.chars().skip(start).take(400).collect::<String>(),
                    a.chars().skip(start).take(400).collect::<String>()
                );
            }
        }
    }
}
