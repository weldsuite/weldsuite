//! US employer returns and reports from final payslips (`us/forms.ts`):
//! Forms 941, 940, W-2 and W-3, the state withholding and unemployment
//! reports, and deposit due dates.

use serde::Deserialize;

use crate::PayrollError;
use crate::documents::{
    DocumentField, DocumentSection, GeneratedFile, Lang, PayrollDocument, group_thousands,
};
use crate::js::{int_of, math_round, number_text, slice, to_fixed};
use crate::money::{js_max, round_half_away_from_zero};
use crate::ordered::OrderedMap;
use crate::periods::{add_days, weekday};
use crate::types::{UsFederalFiling, UsFilingData};
use crate::us::dates::{
    annual_return_due_date, business_days_after, on_or_next_business_day, quarter_bounds,
    quarterly_return_due_date,
};
use crate::us::federal_rules::{federal_rules, futa_credit_reduction_table};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsPayslipForForms {
    pub payslip_id: String,
    pub employee_id: String,
    pub pay_date: String,
    pub filing_data: UsFilingData,
    #[serde(default)]
    pub period_start: Option<String>,
    #[serde(default)]
    pub period_end: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsEmployerStateAccounts {
    #[serde(default)]
    pub withholding_account_number: Option<String>,
    #[serde(default)]
    pub sui_account_number: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsEmployerForForms {
    pub name: String,
    pub ein: Option<String>,
    pub address: Vec<String>,
    pub deposit_schedule: String,
    pub states: OrderedMap<UsEmployerStateAccounts>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsEmployeeForForms {
    pub employee_id: String,
    pub name: String,
    pub ssn: Option<String>,
    pub address: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EmployeePayslips {
    pub employee: UsEmployeeForForms,
    pub payslips: Vec<UsPayslipForForms>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsFormResult {
    pub summary: OrderedMap<f64>,
    pub amount_due_cents: f64,
    pub due_date: String,
    pub document: PayrollDocument,
    pub files: Option<Vec<GeneratedFile>>,
}

/// `usd(cents)`: `$1,234.56`.
pub fn usd(cents: f64) -> String {
    let sign = if cents < 0.0 { "-" } else { "" };
    let abs = math_round(cents).abs();
    let dollars = group_thousands(&number_text((abs / 100.0).floor()), ',');
    format!("{sign}${dollars}.{:0>2}", number_text(abs % 100.0))
}

fn decimal(cents: f64) -> String {
    let sign = if cents < 0.0 { "-" } else { "" };
    let abs = math_round(cents).abs();
    format!(
        "{sign}{}.{:0>2}",
        number_text((abs / 100.0).floor()),
        number_text(abs % 100.0)
    )
}

fn digits(text: &str) -> String {
    text.chars().filter(char::is_ascii_digit).collect()
}

/// `maskSsn(ssn)`.
pub fn mask_ssn(ssn: Option<&str>) -> String {
    let Some(ssn) = ssn.filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let d = digits(ssn);
    if d.len() >= 4 {
        format!("XXX-XX-{}", &d[d.len() - 4..])
    } else {
        "XXX-XX-XXXX".into()
    }
}

fn format_ssn(ssn: Option<&str>) -> String {
    let Some(ssn) = ssn.filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let d = digits(ssn);
    if d.len() == 9 {
        format!("{}-{}-{}", &d[..3], &d[3..5], &d[5..])
    } else {
        ssn.to_owned()
    }
}

fn format_ein(ein: Option<&str>) -> String {
    let Some(ein) = ein.filter(|e| !e.is_empty()) else {
        return "Applied for".into();
    };
    let d = digits(ein);
    if d.len() == 9 {
        format!("{}-{}", &d[..2], &d[2..])
    } else {
        ein.to_owned()
    }
}

fn csv_cell(v: &str) -> String {
    if v.contains(['"', ',', '\n']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_owned()
    }
}

fn csv(rows: &[Vec<String>]) -> String {
    let lines: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(","))
        .collect();
    format!("{}\n", lines.join("\n"))
}

fn rate(cents: f64, factor: f64) -> f64 {
    round_half_away_from_zero(cents * factor)
}

fn sum_by<T>(items: &[T], f: impl Fn(&T) -> f64) -> f64 {
    items.iter().fold(0.0, |s, i| s + f(i))
}

fn in_range(date: &str, start: &str, end: &str) -> bool {
    date >= start && date <= end
}

fn field(label: &str, value: impl Into<String>, emphasis: bool) -> DocumentField {
    let f = DocumentField::new(label, value);
    if emphasis { f.emphasised() } else { f }
}

fn employer_block(employer: &UsEmployerForForms) -> Vec<String> {
    let mut out = vec![
        employer.name.clone(),
        format!("EIN {}", format_ein(employer.ein.as_deref())),
    ];
    out.extend(employer.address.iter().cloned());
    out
}

fn liability941(p: &UsPayslipForForms) -> f64 {
    let f = &p.filing_data.federal;
    f.federal_income_tax
        + f.ss_tax_employee
        + f.ss_tax_employer
        + f.medicare_tax_employee
        + f.medicare_tax_employer
        + f.additional_medicare_tax
}

/// `reconcile(values, target)`: rounding differences on the last non-zero entries.
fn reconcile(values: &[f64], target: f64) -> Vec<f64> {
    let mut out = values.to_vec();
    let mut diff = target - out.iter().fold(0.0, |s, v| s + v);
    let mut i = out.len();
    while i > 0 && diff != 0.0 {
        i -= 1;
        if out[i] == 0.0 && i > 0 {
            continue;
        }
        let next = js_max(0.0, out[i] + diff);
        diff -= next - out[i];
        out[i] = next;
    }
    out
}

/// `depositDueDate(schedule, payDate, options)`.
pub fn deposit_due_date(
    schedule: &str,
    pay_date: &str,
    accumulated_cents: Option<f64>,
) -> Result<String, PayrollError> {
    if accumulated_cents.unwrap_or(0.0) >= 10_000_000.0 {
        return business_days_after(pay_date, 1);
    }
    if schedule == "monthly" {
        let year = int_of(slice(pay_date, 0, 4));
        let month = int_of(slice(pay_date, 5, 7));
        let next = if month == 12 {
            format!("{}-01-15", year + 1)
        } else {
            format!("{year}-{:02}-15", month + 1)
        };
        return on_or_next_business_day(&next);
    }
    let d = weekday(pay_date)?;
    let closes_on = if (3..=5).contains(&d) { 5 } else { 2 };
    let close = add_days(pay_date, (closes_on - d + 7).rem_euclid(7))?;
    business_days_after(&close, 3)
}

/// `futaDepositDueDate(taxYear, quarter)`.
pub fn futa_deposit_due_date(tax_year: i64, quarter: i64) -> Result<String, PayrollError> {
    quarterly_return_due_date(tax_year, quarter)
}

fn fed(slips: &[&UsPayslipForForms], f: impl Fn(&UsFederalFiling) -> f64) -> f64 {
    slips.iter().fold(0.0, |s, p| s + f(&p.filing_data.federal))
}

fn sorted_utf16(mut items: Vec<String>) -> Vec<String> {
    items.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    items
}

fn document(
    title: String,
    subtitle: String,
    from: Vec<String>,
    to: Option<Vec<String>>,
    sections: Vec<DocumentSection>,
    footer: Option<Vec<String>>,
) -> PayrollDocument {
    PayrollDocument {
        title,
        subtitle: Some(subtitle),
        language: Lang::En,
        from: Some(from),
        to,
        sections,
        footer,
        watermark: None,
    }
}

pub struct Form941Input<'a> {
    pub employer: &'a UsEmployerForForms,
    pub tax_year: i64,
    pub quarter: i64,
    pub payslips: &'a [UsPayslipForForms],
    pub deposits_cents: Option<f64>,
    pub prior_quarter_line12_cents: Option<f64>,
}

/// `form941(input)`.
pub fn form941(input: &Form941Input<'_>) -> Result<UsFormResult, PayrollError> {
    let (employer, tax_year, quarter) = (input.employer, input.tax_year, input.quarter);
    let (start, end) = quarter_bounds(tax_year, quarter);
    let slips: Vec<&UsPayslipForForms> = input
        .payslips
        .iter()
        .filter(|p| in_range(&p.pay_date, &start, &end))
        .collect();
    let last_month = quarter * 3;
    let twelfth = format!("{tax_year}-{last_month:02}-12");
    let month_prefix = slice(&twelfth, 0, 8).to_owned();
    let mut employees: Vec<&str> = vec![];
    for p in &slips {
        let counts = match (
            p.period_start.as_deref().filter(|s| !s.is_empty()),
            p.period_end.as_deref().filter(|s| !s.is_empty()),
        ) {
            (Some(s), Some(e)) => in_range(&twelfth, s, e),
            _ => p.pay_date.starts_with(&month_prefix),
        };
        if counts && !employees.contains(&p.employee_id.as_str()) {
            employees.push(&p.employee_id);
        }
    }
    let line1 = employees.len() as f64;
    let line2 = fed(&slips, |f| f.fit_wages);
    let line3 = fed(&slips, |f| f.federal_income_tax);
    let line5a_wages = fed(&slips, |f| f.ss_wages);
    let line5b_wages = fed(&slips, |f| f.ss_tips);
    let line5c_wages = fed(&slips, |f| f.medicare_wages);
    let line5d_wages = fed(&slips, |f| f.additional_medicare_wages);
    let line5a_tax = rate(line5a_wages, 0.124);
    let line5b_tax = rate(line5b_wages, 0.124);
    let line5c_tax = rate(line5c_wages, 0.029);
    let line5d_tax = rate(line5d_wages, 0.009);
    let line4 = if line2 > 0.0 && line5a_wages + line5b_wages + line5c_wages == 0.0 {
        1.0
    } else {
        0.0
    };
    let line5e = line5a_tax + line5b_tax + line5c_tax + line5d_tax;
    let line5f = 0.0;
    let line6 = line3 + line5e + line5f;
    let withheld = fed(&slips, |f| {
        f.ss_tax_employee + f.medicare_tax_employee + f.additional_medicare_tax
    });
    let employee_share = rate(line5a_wages, 0.062)
        + rate(line5b_wages, 0.062)
        + rate(line5c_wages, 0.0145)
        + line5d_tax;
    let line7 = withheld - employee_share;
    let (line8, line9, line11) = (0.0, 0.0, 0.0);
    let line10 = line6 + line7 + line8 + line9;
    let line12 = js_max(0.0, line10 - line11);
    let line13 = input.deposits_cents.unwrap_or(line12);
    let line14 = js_max(0.0, line12 - line13);
    let line15 = js_max(0.0, line13 - line12);
    let de_minimis = line12 < 250_000.0
        || input
            .prior_quarter_line12_cents
            .is_some_and(|p| p < 250_000.0);
    let line16_box = if de_minimis {
        1
    } else if employer.deposit_schedule == "monthly" {
        2
    } else {
        3
    };
    let mut months = [0.0; 3];
    let mut daily: Vec<(String, f64)> = vec![];
    for p in &slips {
        let m = int_of(slice(&p.pay_date, 5, 7)) - (quarter - 1) * 3 - 1;
        if let Some(slot) = usize::try_from(m).ok().and_then(|m| months.get_mut(m)) {
            *slot += liability941(p);
        }
        match daily.iter_mut().find(|(d, _)| *d == p.pay_date) {
            Some((_, v)) => *v += liability941(p),
            None => daily.push((p.pay_date.clone(), liability941(p))),
        }
    }
    let monthly = reconcile(&months, line12);
    let days = sorted_utf16(daily.iter().map(|(d, _)| d.clone()).collect());
    let day_values: Vec<f64> = days
        .iter()
        .map(|d| daily.iter().find(|(k, _)| k == d).map_or(0.0, |(_, v)| *v))
        .collect();
    let daily_values = reconcile(&day_values, line12);
    let mut summary = OrderedMap::new();
    for (k, v) in [
        ("line1", line1),
        ("line2", line2),
        ("line3", line3),
        ("line4", line4),
        ("line5a_wages", line5a_wages),
        ("line5a_tax", line5a_tax),
        ("line5b_wages", line5b_wages),
        ("line5b_tax", line5b_tax),
        ("line5c_wages", line5c_wages),
        ("line5c_tax", line5c_tax),
        ("line5d_wages", line5d_wages),
        ("line5d_tax", line5d_tax),
        ("line5e", line5e),
        ("line5f", line5f),
        ("line6", line6),
        ("line7", line7),
        ("line8", line8),
        ("line9", line9),
        ("line10", line10),
        ("line11", line11),
        ("line12", line12),
        ("line13", line13),
        ("line14", line14),
        ("line15", line15),
        ("line16_box", f64::from(line16_box)),
        ("line16_month1", monthly[0]),
        ("line16_month2", monthly[1]),
        ("line16_month3", monthly[2]),
        ("line16_total", monthly[0] + monthly[1] + monthly[2]),
    ] {
        summary.insert(k, v);
    }
    let mut schedule_b: Vec<Vec<String>> = vec![];
    for (i, d) in days.iter().enumerate() {
        let m = int_of(slice(d, 5, 7)) - (quarter - 1) * 3;
        summary.insert(
            format!("scheduleB_m{m}_d{}", int_of(slice(d, 8, 10))),
            daily_values[i],
        );
        schedule_b.push(vec![d.clone(), usd(daily_values[i])]);
    }
    let due_date = quarterly_return_due_date(tax_year, quarter)?;
    let mut sections = vec![
        DocumentSection::Fields {
            title: Some("Part 1: Answer these questions for this quarter".into()),
            fields: vec![
                field(
                    "1 Number of employees who received wages for the pay period including the 12th",
                    number_text(line1),
                    false,
                ),
                field("2 Wages, tips, and other compensation", usd(line2), false),
                field("3 Federal income tax withheld", usd(line3), false),
                field(
                    "4 No wages subject to social security or Medicare tax",
                    if line4 != 0.0 { "Yes" } else { "No" },
                    false,
                ),
                field(
                    "5a Taxable social security wages × 0.124",
                    format!("{} → {}", usd(line5a_wages), usd(line5a_tax)),
                    false,
                ),
                field(
                    "5b Taxable social security tips × 0.124",
                    format!("{} → {}", usd(line5b_wages), usd(line5b_tax)),
                    false,
                ),
                field(
                    "5c Taxable Medicare wages & tips × 0.029",
                    format!("{} → {}", usd(line5c_wages), usd(line5c_tax)),
                    false,
                ),
                field(
                    "5d Wages & tips subject to Additional Medicare Tax × 0.009",
                    format!("{} → {}", usd(line5d_wages), usd(line5d_tax)),
                    false,
                ),
                field(
                    "5e Total social security and Medicare taxes",
                    usd(line5e),
                    false,
                ),
                field("5f Section 3121(q) Notice and Demand", usd(line5f), false),
                field("6 Total taxes before adjustments", usd(line6), false),
                field(
                    "7 Current quarter’s adjustment for fractions of cents",
                    usd(line7),
                    false,
                ),
                field(
                    "8 Current quarter’s adjustment for sick pay",
                    usd(line8),
                    false,
                ),
                field(
                    "9 Current quarter’s adjustments for tips and group-term life insurance",
                    usd(line9),
                    false,
                ),
                field("10 Total taxes after adjustments", usd(line10), false),
                field(
                    "11 Qualified small business payroll tax credit for increasing research activities",
                    usd(line11),
                    false,
                ),
                field(
                    "12 Total taxes after adjustments and nonrefundable credits",
                    usd(line12),
                    true,
                ),
                field("13 Total deposits for this quarter", usd(line13), false),
                field("14 Balance due", usd(line14), true),
                field("15 Overpayment", usd(line15), false),
            ],
        },
        DocumentSection::Fields {
            title: Some("Part 2: Deposit schedule and tax liability for this quarter".into()),
            fields: match line16_box {
                1 => vec![field(
                    "16",
                    "Line 12 is less than $2,500 (or the prior quarter’s was): no deposit record is required.",
                    false,
                )],
                2 => vec![
                    field(
                        "16 Monthly schedule depositor — Month 1",
                        usd(monthly[0]),
                        false,
                    ),
                    field("Month 2", usd(monthly[1]), false),
                    field("Month 3", usd(monthly[2]), false),
                    field(
                        "Total liability for quarter",
                        usd(monthly[0] + monthly[1] + monthly[2]),
                        true,
                    ),
                ],
                _ => vec![field(
                    "16 Semiweekly schedule depositor",
                    "Complete Schedule B (Form 941) with the daily liabilities below.",
                    false,
                )],
            },
        },
    ];
    if line16_box == 3 {
        sections.push(DocumentSection::Table {
            title: Some("Schedule B (Form 941): tax liability by pay date".into()),
            columns: vec!["Pay date".into(), "Tax liability".into()],
            align_right: Some(vec![1]),
            rows: schedule_b,
            totals: Some(vec![
                "Total liability for the quarter".into(),
                usd(daily_values.iter().fold(0.0, |s, v| s + v)),
            ]),
        });
    }
    sections.push(DocumentSection::Text {
        title: None,
        paragraphs: vec![
            format!("Due {due_date}. If all taxes for the quarter were deposited on time, the return may be filed by the 10th day of the second month after the quarter."),
            "Prepared by WeldSuite from final payslips. The employer reviews, signs and files the return and makes the deposits through EFTPS.".into(),
        ],
    });
    Ok(UsFormResult {
        summary,
        amount_due_cents: line14,
        due_date,
        document: document(
            "Form 941 — Employer’s Quarterly Federal Tax Return".into(),
            format!("Quarter {quarter}, {tax_year}"),
            employer_block(employer),
            None,
            sections,
            Some(vec!["Worksheet for Form 941; transcribe onto the official form or file electronically through an IRS e-file provider.".into()]),
        ),
        files: None,
    })
}

/// `form940(input)`.
pub fn form940(
    employer: &UsEmployerForForms,
    tax_year: i64,
    payslips: &[UsPayslipForForms],
    deposits_cents: Option<f64>,
) -> Result<UsFormResult, PayrollError> {
    let rules = federal_rules(tax_year)
        .or_else(|| federal_rules(2026))
        .ok_or_else(|| PayrollError::new("No federal rules"))?;
    let net_rate = (rules.futa.gross_rate_percent - rules.futa.max_credit_percent) / 100.0;
    let prefix = format!("{tax_year}-");
    let slips: Vec<&UsPayslipForForms> = payslips
        .iter()
        .filter(|p| p.pay_date.starts_with(&prefix))
        .collect();
    let mut states: Vec<String> = vec![];
    for p in &slips {
        for (st, s) in p.filing_data.states.iter() {
            if (s.sui_gross_wages > 0.0 || s.sui_wages > 0.0) && !states.contains(st) {
                states.push(st.clone());
            }
        }
    }
    let reduction_rates = futa_credit_reduction_table(tax_year);
    let reduction_of = |st: &str| reduction_rates.and_then(|r| r.get(st).copied());
    let line3 = fed(&slips, |f| f.futa_gross_wages);
    let line4 = fed(&slips, |f| f.futa_exempt_wages.unwrap_or(0.0));
    let line7 = fed(&slips, |f| f.futa_wages);
    let line5 = js_max(0.0, line3 - line4 - line7);
    let line6 = line4 + line5;
    let line8 = rate(line7, net_rate);
    let excluded_from_sui = slips.iter().fold(0.0, |s, p| {
        let st = p
            .filing_data
            .federal
            .futa_state
            .clone()
            .flatten()
            .filter(|s| !s.is_empty());
        let state = st.as_deref().and_then(|st| p.filing_data.states.get(st));
        s + if state.is_some_and(|s| s.sui_gross_wages == 0.0) {
            p.filing_data.federal.futa_wages
        } else {
            0.0
        }
    });
    let line9 = if line7 > 0.0 && excluded_from_sui == line7 {
        rate(line7, rules.futa.max_credit_percent / 100.0)
    } else {
        0.0
    };
    let line10 = 0.0;
    let mut schedule_a: Vec<(String, f64)> = vec![];
    for p in &slips {
        let Some(st) = p
            .filing_data
            .federal
            .futa_state
            .clone()
            .flatten()
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if !reduction_of(&st).is_some_and(|r| r > 0.0) {
            continue;
        }
        if p.filing_data
            .states
            .get(&st)
            .is_some_and(|s| s.sui_gross_wages == 0.0)
        {
            continue;
        }
        match schedule_a.iter_mut().find(|(k, _)| *k == st) {
            Some((_, w)) => *w += p.filing_data.federal.futa_wages,
            None => schedule_a.push((st, p.filing_data.federal.futa_wages)),
        }
    }
    let mut schedule_a_rows = vec![];
    let mut line11 = 0.0;
    let mut sorted_a = schedule_a.clone();
    sorted_a.sort_by(|a, b| {
        format!("{},{}", a.0, number_text(a.1))
            .encode_utf16()
            .cmp(format!("{},{}", b.0, number_text(b.1)).encode_utf16())
    });
    for (st, wages) in &sorted_a {
        let r = reduction_of(st).unwrap_or(f64::NAN) / 100.0;
        let reduction = rate(*wages, r);
        line11 += reduction;
        schedule_a_rows.push(vec![
            st.clone(),
            usd(*wages),
            to_fixed(r, 3),
            usd(reduction),
        ]);
    }
    let line12 = line8 + line9 + line10 + line11;
    let line13 = deposits_cents.unwrap_or(line12);
    let line14 = js_max(0.0, line12 - line13);
    let line15 = js_max(0.0, line13 - line12);
    let mut quarters = [0.0; 4];
    for p in &slips {
        let q = (int_of(slice(&p.pay_date, 5, 7)) - 1).div_euclid(3);
        let f = &p.filing_data.federal;
        if let Some(slot) = usize::try_from(q).ok().and_then(|q| quarters.get_mut(q)) {
            *slot += f.futa_tax - f.futa_credit_reduction.unwrap_or(0.0);
        }
    }
    quarters[3] += line11;
    let part5 = if line12 > 50_000.0 {
        reconcile(&quarters, line12)
    } else {
        vec![0.0; 4]
    };
    let mut summary = OrderedMap::new();
    for (k, v) in [
        ("line1b", if states.len() > 1 { 1.0 } else { 0.0 }),
        ("line2", if line11 > 0.0 { 1.0 } else { 0.0 }),
        ("line3", line3),
        ("line4", line4),
        ("line5", line5),
        ("line6", line6),
        ("line7", line7),
        ("line8", line8),
        ("line9", line9),
        ("line10", line10),
        ("line11", line11),
        ("line12", line12),
        ("line13", line13),
        ("line14", line14),
        ("line15", line15),
        ("line16a", part5[0]),
        ("line16b", part5[1]),
        ("line16c", part5[2]),
        ("line16d", part5[3]),
        ("line17", part5.iter().fold(0.0, |s, v| s + v)),
    ] {
        summary.insert(k, v);
    }
    for (st, wages) in &schedule_a {
        summary.insert(format!("scheduleA_{st}_wages"), *wages);
        summary.insert(
            format!("scheduleA_{st}_reduction"),
            rate(*wages, reduction_of(st).unwrap_or(f64::NAN) / 100.0),
        );
    }
    let due_date = annual_return_due_date(tax_year)?;
    let state_list = sorted_utf16(states);
    let mut sections = vec![
        DocumentSection::Fields {
            title: Some("Part 1: About your return".into()),
            fields: vec![
                field(
                    "1a One state only",
                    if state_list.len() == 1 {
                        state_list[0].clone()
                    } else {
                        String::new()
                    },
                    false,
                ),
                field(
                    "1b More than one state (Schedule A required)",
                    if state_list.len() > 1 {
                        format!("Yes: {}", state_list.join(", "))
                    } else {
                        "No".into()
                    },
                    false,
                ),
                field(
                    "2 Wages paid in a credit reduction state (Schedule A required)",
                    if line11 > 0.0 { "Yes" } else { "No" },
                    false,
                ),
            ],
        },
        DocumentSection::Fields {
            title: Some("Part 2: FUTA tax before adjustments".into()),
            fields: vec![
                field("3 Total payments to all employees", usd(line3), false),
                field("4 Payments exempt from FUTA tax", usd(line4), false),
                field(
                    "5 Total of payments made to each employee in excess of $7,000",
                    usd(line5),
                    false,
                ),
                field("6 Subtotal (line 4 + line 5)", usd(line6), false),
                field("7 Total taxable FUTA wages", usd(line7), false),
                field(
                    "8 FUTA tax before adjustments (line 7 × 0.006)",
                    usd(line8),
                    false,
                ),
            ],
        },
        DocumentSection::Fields {
            title: Some("Part 3: Adjustments".into()),
            fields: vec![
                field(
                    "9 All taxable FUTA wages excluded from state unemployment tax (line 7 × 0.054)",
                    usd(line9),
                    false,
                ),
                field(
                    "10 Some wages excluded, or state unemployment tax paid late",
                    usd(line10),
                    false,
                ),
                field("11 Credit reduction (Schedule A)", usd(line11), false),
            ],
        },
        DocumentSection::Fields {
            title: Some("Part 4: Your FUTA tax and balance due or overpayment".into()),
            fields: vec![
                field("12 Total FUTA tax after adjustments", usd(line12), true),
                field("13 FUTA tax deposited for the year", usd(line13), false),
                field("14 Balance due", usd(line14), true),
                field("15 Overpayment", usd(line15), false),
            ],
        },
    ];
    if line12 > 50_000.0 {
        let names = ["1st", "2nd", "3rd", "4th"];
        let letters = ["a", "b", "c", "d"];
        sections.push(DocumentSection::Table {
            title: Some("Part 5: FUTA tax liability by quarter".into()),
            columns: vec!["Quarter".into(), "Liability".into()],
            align_right: Some(vec![1]),
            rows: part5
                .iter()
                .enumerate()
                .map(|(i, v)| vec![format!("16{} {} quarter", letters[i], names[i]), usd(*v)])
                .collect(),
            totals: Some(vec![
                "17 Total tax liability for the year".into(),
                usd(part5.iter().fold(0.0, |s, v| s + v)),
            ]),
        });
    }
    if !schedule_a_rows.is_empty() {
        sections.push(DocumentSection::Table {
            title: Some("Schedule A (Form 940): credit reduction".into()),
            columns: vec![
                "State".into(),
                "FUTA taxable wages".into(),
                "Reduction rate".into(),
                "Credit reduction".into(),
            ],
            align_right: Some(vec![1, 2, 3]),
            rows: schedule_a_rows,
            totals: Some(vec![
                "Total credit reduction".into(),
                String::new(),
                String::new(),
                usd(line11),
            ]),
        });
    }
    sections.push(DocumentSection::Text {
        title: None,
        paragraphs: vec![
            format!("Due {due_date}. If all FUTA tax was deposited when due, the return may be filed by the 10th day of the following month."),
            "Line 10 (wages partly excluded from state unemployment tax, or state tax paid late) is not computed: check it with your state unemployment payments before filing.".into(),
            "Prepared by WeldSuite from final payslips. The employer reviews, signs and files the return and deposits FUTA tax through EFTPS.".into(),
        ],
    });
    Ok(UsFormResult {
        summary,
        amount_due_cents: line14,
        due_date,
        document: document(
            "Form 940 — Employer’s Annual Federal Unemployment (FUTA) Tax Return".into(),
            tax_year.to_string(),
            employer_block(employer),
            None,
            sections,
            Some(vec!["Worksheet for Form 940; transcribe onto the official form or file electronically through an IRS e-file provider.".into()]),
        ),
        files: None,
    })
}

struct W2Totals {
    box1: f64,
    box2: f64,
    box3: f64,
    box4: f64,
    box5: f64,
    box6: f64,
    box7: f64,
    box10: f64,
    box12: OrderedMap<f64>,
    statutory_employee: bool,
    retirement_plan: bool,
    states: OrderedMap<(f64, f64)>,
}

fn w2_totals(payslips: &[&UsPayslipForForms]) -> W2Totals {
    let mut t = W2Totals {
        box1: 0.0,
        box2: 0.0,
        box3: 0.0,
        box4: 0.0,
        box5: 0.0,
        box6: 0.0,
        box7: 0.0,
        box10: 0.0,
        box12: OrderedMap::new(),
        statutory_employee: false,
        retirement_plan: false,
        states: OrderedMap::new(),
    };
    for p in payslips {
        let f = &p.filing_data.federal;
        t.box1 += f.fit_wages;
        t.box2 += f.federal_income_tax;
        t.box3 += f.ss_wages;
        t.box4 += f.ss_tax_employee;
        t.box5 += f.medicare_wages;
        t.box6 += f.medicare_tax_employee + f.additional_medicare_tax;
        t.box7 += f.ss_tips;
        t.box10 += f.dependent_care;
        for (code, cents) in f.box12.iter() {
            let prev = t.box12.get(code).copied().unwrap_or(0.0);
            t.box12.insert(code.clone(), prev + cents);
        }
        t.statutory_employee = t.statutory_employee || f.statutory_employee == Some(true);
        t.retirement_plan = t.retirement_plan || f.retirement_plan == Some(true);
        for (st, s) in p.filing_data.states.iter() {
            let (w, x) = t.states.get(st).copied().unwrap_or((0.0, 0.0));
            t.states
                .insert(st.clone(), (w + s.state_wages, x + s.state_income_tax));
        }
    }
    t
}

const BOX12_ORDER: [&str; 33] = [
    "A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N", "P", "Q", "R", "S", "T", "V",
    "W", "Y", "Z", "AA", "BB", "DD", "EE", "FF", "GG", "HH", "II", "TA", "TP", "TT",
];
const DEFERRED_COMP_CODES: [&str; 10] = ["D", "E", "F", "G", "H", "S", "Y", "AA", "BB", "EE"];

fn box12_codes(box12: &OrderedMap<f64>) -> Vec<(String, f64)> {
    let mut codes: Vec<(String, f64)> = box12
        .iter()
        .filter(|(_, v)| **v != 0.0)
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    let index = |code: &str| BOX12_ORDER.iter().position(|c| *c == code).unwrap_or(99);
    codes.sort_by_key(|(code, _)| index(code));
    codes
}

fn state_table_rows(
    employer: &UsEmployerForForms,
    state_codes: &[String],
    states: &OrderedMap<(f64, f64)>,
) -> Vec<Vec<String>> {
    state_codes
        .iter()
        .map(|st| {
            let (wages, tax) = states.get(st).copied().unwrap_or((0.0, 0.0));
            vec![
                st.clone(),
                employer
                    .states
                    .get(st)
                    .and_then(|s| s.withholding_account_number.clone())
                    .unwrap_or_default(),
                usd(wages),
                usd(tax),
            ]
        })
        .collect()
}

/// `formW2(input)`.
pub fn form_w2(
    employer: &UsEmployerForForms,
    employee: &UsEmployeeForForms,
    tax_year: i64,
    payslips: &[UsPayslipForForms],
) -> Result<UsFormResult, PayrollError> {
    let prefix = format!("{tax_year}-");
    let slips: Vec<&UsPayslipForForms> = payslips
        .iter()
        .filter(|p| p.pay_date.starts_with(&prefix) && p.employee_id == employee.employee_id)
        .collect();
    let t = w2_totals(&slips);
    let codes = box12_codes(&t.box12);
    let mut summary = OrderedMap::new();
    for (k, v) in [
        ("box1", t.box1),
        ("box2", t.box2),
        ("box3", t.box3),
        ("box4", t.box4),
        ("box5", t.box5),
        ("box6", t.box6),
        ("box7", t.box7),
        ("box8", 0.0),
        ("box10", t.box10),
        ("box11", 0.0),
        (
            "box13_statutory",
            if t.statutory_employee { 1.0 } else { 0.0 },
        ),
        (
            "box13_retirement",
            if t.retirement_plan { 1.0 } else { 0.0 },
        ),
        ("box13_sick_pay", 0.0),
    ] {
        summary.insert(k, v);
    }
    for (code, cents) in &codes {
        summary.insert(format!("box12_{code}"), *cents);
    }
    let state_codes = sorted_utf16(t.states.keys().cloned().collect());
    for st in &state_codes {
        let (wages, tax) = t.states.get(st).copied().unwrap_or((0.0, 0.0));
        summary.insert(format!("box16_{st}"), wages);
        summary.insert(format!("box17_{st}"), tax);
    }
    let due_date = annual_return_due_date(tax_year)?;
    let mut employer_line = vec![employer.name.clone()];
    employer_line.extend(employer.address.iter().cloned());
    let mut employee_line = vec![employee.name.clone()];
    employee_line.extend(employee.address.iter().cloned());
    let mut sections = vec![
        DocumentSection::Fields {
            title: Some("Employee and employer".into()),
            fields: vec![
                field(
                    "a Employee’s social security number",
                    mask_ssn(employee.ssn.as_deref()),
                    false,
                ),
                field(
                    "b Employer identification number (EIN)",
                    format_ein(employer.ein.as_deref()),
                    false,
                ),
                field(
                    "c Employer’s name and address",
                    employer_line.join(", "),
                    false,
                ),
                field(
                    "e/f Employee’s name and address",
                    employee_line.join(", "),
                    false,
                ),
            ],
        },
        DocumentSection::Fields {
            title: Some("Wages and taxes".into()),
            fields: vec![
                field("1 Wages, tips, other compensation", usd(t.box1), true),
                field("2 Federal income tax withheld", usd(t.box2), true),
                field("3 Social security wages", usd(t.box3), false),
                field("4 Social security tax withheld", usd(t.box4), false),
                field("5 Medicare wages and tips", usd(t.box5), false),
                field("6 Medicare tax withheld", usd(t.box6), false),
                field("7 Social security tips", usd(t.box7), false),
                field("8 Allocated tips", usd(0.0), false),
                field("10 Dependent care benefits", usd(t.box10), false),
                field("11 Nonqualified plans", usd(0.0), false),
            ],
        },
        DocumentSection::Table {
            title: Some("12 Codes".into()),
            columns: vec!["Code".into(), "Amount".into()],
            align_right: Some(vec![1]),
            rows: codes
                .iter()
                .map(|(code, cents)| vec![code.clone(), usd(*cents)])
                .collect(),
            totals: None,
        },
        DocumentSection::Fields {
            title: Some("13 Checkboxes".into()),
            fields: vec![
                field(
                    "Statutory employee",
                    if t.statutory_employee { "X" } else { "" },
                    false,
                ),
                field(
                    "Retirement plan",
                    if t.retirement_plan { "X" } else { "" },
                    false,
                ),
                field("Third-party sick pay", "", false),
            ],
        },
        DocumentSection::Table {
            title: Some("State".into()),
            columns: vec![
                "15 State".into(),
                "Employer’s state ID number".into(),
                "16 State wages, tips, etc.".into(),
                "17 State income tax".into(),
            ],
            align_right: Some(vec![2, 3]),
            rows: state_table_rows(employer, &state_codes, &t.states),
            totals: None,
        },
    ];
    let mut notes = vec![];
    if codes.len() > 4 {
        notes.push("More than four box 12 codes: on paper, issue a second Form W-2 for the remaining codes (W-2 instructions, \"Multiple forms\").".to_owned());
    }
    if t.box12.get("TP").is_some_and(|v| *v != 0.0 && !v.is_nan()) {
        notes.push("Code TP (cash tips) requires the Treasury Tipped Occupation Code in box 14b; enter it before furnishing this form.".to_owned());
    }
    notes.push(format!("Furnish to the employee and file with the SSA (Copy A, with Form W-3) by {due_date}. Copy A must show the full SSN."));
    sections.push(DocumentSection::Text {
        title: None,
        paragraphs: notes,
    });
    Ok(UsFormResult {
        summary,
        amount_due_cents: 0.0,
        due_date,
        document: document(
            "Form W-2 Wage and Tax Statement".into(),
            format!("{tax_year} — Copies B, C and 2 for the employee"),
            employer_block(employer),
            Some(employee_line),
            sections,
            Some(vec![
                "This information is being furnished to the Internal Revenue Service.".into(),
            ]),
        ),
        files: None,
    })
}

/// `formW3(input)`.
pub fn form_w3(
    employer: &UsEmployerForForms,
    tax_year: i64,
    employees: &[EmployeePayslips],
) -> Result<UsFormResult, PayrollError> {
    let prefix = format!("{tax_year}-");
    let mut all: Vec<&UsPayslipForForms> = vec![];
    let mut form_count = 0;
    for e in employees {
        let slips: Vec<&UsPayslipForForms> = e
            .payslips
            .iter()
            .filter(|p| p.pay_date.starts_with(&prefix) && p.employee_id == e.employee.employee_id)
            .collect();
        if slips.is_empty() {
            continue;
        }
        form_count += 1;
        all.extend(slips);
    }
    let t = w2_totals(&all);
    let box12a = DEFERRED_COMP_CODES
        .iter()
        .fold(0.0, |s, c| s + t.box12.get(c).copied().unwrap_or(0.0));
    let state_codes = sorted_utf16(t.states.keys().cloned().collect());
    let mut summary = OrderedMap::new();
    for (k, v) in [
        ("boxC", f64::from(form_count)),
        ("box1", t.box1),
        ("box2", t.box2),
        ("box3", t.box3),
        ("box4", t.box4),
        ("box5", t.box5),
        ("box6", t.box6),
        ("box7", t.box7),
        ("box8", 0.0),
        ("box10", t.box10),
        ("box11", 0.0),
        ("box12a", box12a),
        ("box13", 0.0),
        ("box14", 0.0),
    ] {
        summary.insert(k, v);
    }
    for st in &state_codes {
        let (wages, tax) = t.states.get(st).copied().unwrap_or((0.0, 0.0));
        summary.insert(format!("box16_{st}"), wages);
        summary.insert(format!("box17_{st}"), tax);
    }
    let due_date = annual_return_due_date(tax_year)?;
    let sections = vec![
        DocumentSection::Fields {
            title: Some("Transmittal".into()),
            fields: vec![
                field("b Kind of payer", "941", false),
                field("c Total number of Forms W-2", form_count.to_string(), false),
                field("e Employer identification number (EIN)", format_ein(employer.ein.as_deref()), false),
                field("f Employer’s name", employer.name.clone(), false),
            ],
        },
        DocumentSection::Fields {
            title: Some("Totals".into()),
            fields: vec![
                field("1 Wages, tips, other compensation", usd(t.box1), true),
                field("2 Federal income tax withheld", usd(t.box2), true),
                field("3 Social security wages", usd(t.box3), false),
                field("4 Social security tax withheld", usd(t.box4), false),
                field("5 Medicare wages and tips", usd(t.box5), false),
                field("6 Medicare tax withheld", usd(t.box6), false),
                field("7 Social security tips", usd(t.box7), false),
                field("10 Dependent care benefits", usd(t.box10), false),
                field("12a Deferred compensation (codes D–H, S, Y, AA, BB, EE)", usd(box12a), false),
            ],
        },
        DocumentSection::Table {
            title: Some("State totals".into()),
            columns: vec!["15 State".into(), "Employer’s state ID number".into(), "16 State wages".into(), "17 State income tax".into()],
            align_right: Some(vec![2, 3]),
            rows: state_table_rows(employer, &state_codes, &t.states),
            totals: None,
        },
        DocumentSection::Text {
            title: None,
            paragraphs: vec![
                format!("File Copy A of every Form W-2 with this transmittal with the SSA by {due_date}. Employers filing 10 or more information returns must e-file (SSA Business Services Online)."),
                "Totals must equal the sum of the four Forms 941 for the year (wages, income tax, social security and Medicare).".into(),
            ],
        },
    ];
    Ok(UsFormResult {
        summary,
        amount_due_cents: 0.0,
        due_date,
        document: document(
            "Form W-3 Transmittal of Wage and Tax Statements".into(),
            tax_year.to_string(),
            employer_block(employer),
            None,
            sections,
            None,
        ),
        files: None,
    })
}

struct StateRow<'a> {
    employee: &'a UsEmployeeForForms,
    gross: f64,
    state_wages: f64,
    tax: f64,
    sui_gross: f64,
    sui_taxable: f64,
    sui_employee: f64,
    sui_employer: f64,
}

fn state_rows<'a>(
    employees: &'a [EmployeePayslips],
    state: &str,
    tax_year: i64,
    quarter: i64,
) -> Vec<StateRow<'a>> {
    let (start, end) = quarter_bounds(tax_year, quarter);
    let mut rows = vec![];
    for e in employees {
        let slips: Vec<&UsPayslipForForms> = e
            .payslips
            .iter()
            .filter(|p| {
                in_range(&p.pay_date, &start, &end)
                    && p.employee_id == e.employee.employee_id
                    && p.filing_data.states.contains_key(state)
            })
            .collect();
        if slips.is_empty() {
            continue;
        }
        let st = |f: fn(&crate::types::UsStateFiling) -> f64| {
            slips.iter().fold(0.0, |s, p| {
                s + p.filing_data.states.get(state).map_or(0.0, f)
            })
        };
        rows.push(StateRow {
            employee: &e.employee,
            gross: slips
                .iter()
                .fold(0.0, |s, p| s + p.filing_data.federal.futa_gross_wages),
            state_wages: st(|s| s.state_wages),
            tax: st(|s| s.state_income_tax),
            sui_gross: st(|s| s.sui_gross_wages),
            sui_taxable: st(|s| s.sui_wages),
            sui_employee: st(|s| s.sui_employee_tax),
            sui_employer: st(|s| s.sui_employer_tax),
        });
    }
    rows.sort_by(|a, b| {
        a.employee
            .name
            .encode_utf16()
            .cmp(b.employee.name.encode_utf16())
    });
    rows
}

/// `stateWithholdingReport(input)`.
pub fn state_withholding_report(
    employer: &UsEmployerForForms,
    state: &str,
    tax_year: i64,
    quarter: i64,
    employees: &[EmployeePayslips],
) -> Result<UsFormResult, PayrollError> {
    let state = state.to_uppercase();
    let rows = state_rows(employees, &state, tax_year, quarter);
    let (gross, wages, tax) = (
        sum_by(&rows, |r| r.gross),
        sum_by(&rows, |r| r.state_wages),
        sum_by(&rows, |r| r.tax),
    );
    let account = employer
        .states
        .get(&state)
        .and_then(|s| s.withholding_account_number.clone())
        .unwrap_or_default();
    let due_date = quarterly_return_due_date(tax_year, quarter)?;
    let mut csv_rows = vec![vec![
        "employee_id".into(),
        "name".into(),
        "ssn".into(),
        "gross_wages".into(),
        "state_wages".into(),
        "state_tax_withheld".into(),
    ]];
    for r in &rows {
        csv_rows.push(vec![
            r.employee.employee_id.clone(),
            r.employee.name.clone(),
            format_ssn(r.employee.ssn.as_deref()),
            decimal(r.gross),
            decimal(r.state_wages),
            decimal(r.tax),
        ]);
    }
    csv_rows.push(vec![
        String::new(),
        "TOTAL".into(),
        String::new(),
        decimal(gross),
        decimal(wages),
        decimal(tax),
    ]);
    let file = GeneratedFile {
        file_name: format!(
            "{}-withholding-{tax_year}-q{quarter}.csv",
            state.to_lowercase()
        ),
        content_type: "text/csv".into(),
        content: csv(&csv_rows),
    };
    let mut summary = OrderedMap::new();
    summary.insert("employees", rows.len() as f64);
    summary.insert("gross", gross);
    summary.insert("stateWages", wages);
    summary.insert("stateTax", tax);
    let mut from = employer_block(employer);
    if !account.is_empty() {
        from.push(format!("{state} withholding account {account}"));
    }
    Ok(UsFormResult {
        summary,
        amount_due_cents: tax,
        due_date: due_date.clone(),
        document: document(
            format!("{state} income tax withholding — quarterly report"),
            format!("Quarter {quarter}, {tax_year}"),
            from,
            None,
            vec![
                DocumentSection::Table {
                    title: None,
                    columns: vec![
                        "Employee".into(),
                        "SSN".into(),
                        "Gross wages".into(),
                        "State wages".into(),
                        "State tax withheld".into(),
                    ],
                    align_right: Some(vec![2, 3, 4]),
                    rows: rows
                        .iter()
                        .map(|r| {
                            vec![
                                r.employee.name.clone(),
                                mask_ssn(r.employee.ssn.as_deref()),
                                usd(r.gross),
                                usd(r.state_wages),
                                usd(r.tax),
                            ]
                        })
                        .collect(),
                    totals: Some(vec![
                        "Total".into(),
                        String::new(),
                        usd(gross),
                        usd(wages),
                        usd(tax),
                    ]),
                },
                DocumentSection::Text {
                    title: None,
                    paragraphs: vec![format!(
                        "File with {state} by {due_date} (verify the state's own deadline and deposit schedule). The CSV next to this report has full SSNs for filing."
                    )],
                },
            ],
            None,
        ),
        files: Some(vec![file]),
    })
}

/// `stateUnemploymentReport(input)`.
pub fn state_unemployment_report(
    employer: &UsEmployerForForms,
    state: &str,
    tax_year: i64,
    quarter: i64,
    employees: &[EmployeePayslips],
) -> Result<UsFormResult, PayrollError> {
    let state = state.to_uppercase();
    let rows = state_rows(employees, &state, tax_year, quarter);
    let gross = sum_by(&rows, |r| r.sui_gross);
    let taxable = sum_by(&rows, |r| r.sui_taxable);
    let employee = sum_by(&rows, |r| r.sui_employee);
    let employer_part = sum_by(&rows, |r| r.sui_employer);
    let account = employer
        .states
        .get(&state)
        .and_then(|s| s.sui_account_number.clone())
        .unwrap_or_default();
    let due_date = quarterly_return_due_date(tax_year, quarter)?;
    let mut csv_rows = vec![vec![
        "employee_id".into(),
        "name".into(),
        "ssn".into(),
        "gross_wages".into(),
        "taxable_wages".into(),
        "employee_contribution".into(),
        "employer_contribution".into(),
    ]];
    for r in &rows {
        csv_rows.push(vec![
            r.employee.employee_id.clone(),
            r.employee.name.clone(),
            format_ssn(r.employee.ssn.as_deref()),
            decimal(r.sui_gross),
            decimal(r.sui_taxable),
            decimal(r.sui_employee),
            decimal(r.sui_employer),
        ]);
    }
    csv_rows.push(vec![
        String::new(),
        "TOTAL".into(),
        String::new(),
        decimal(gross),
        decimal(taxable),
        decimal(employee),
        decimal(employer_part),
    ]);
    let file = GeneratedFile {
        file_name: format!(
            "{}-unemployment-{tax_year}-q{quarter}.csv",
            state.to_lowercase()
        ),
        content_type: "text/csv".into(),
        content: csv(&csv_rows),
    };
    let mut summary = OrderedMap::new();
    summary.insert("employees", rows.len() as f64);
    summary.insert("grossWages", gross);
    summary.insert("taxableWages", taxable);
    summary.insert("excessWages", gross - taxable);
    summary.insert("employeeContributions", employee);
    summary.insert("employerContributions", employer_part);
    let mut from = employer_block(employer);
    if !account.is_empty() {
        from.push(format!("{state} UI account {account}"));
    }
    Ok(UsFormResult {
        summary,
        amount_due_cents: employee + employer_part,
        due_date: due_date.clone(),
        document: document(
            format!("{state} unemployment insurance — quarterly wage report"),
            format!("Quarter {quarter}, {tax_year}"),
            from,
            None,
            vec![
                DocumentSection::Table {
                    title: None,
                    columns: vec![
                        "Employee".into(),
                        "SSN".into(),
                        "Gross wages".into(),
                        "Taxable wages".into(),
                        "Employee".into(),
                        "Employer".into(),
                    ],
                    align_right: Some(vec![2, 3, 4, 5]),
                    rows: rows
                        .iter()
                        .map(|r| {
                            vec![
                                r.employee.name.clone(),
                                mask_ssn(r.employee.ssn.as_deref()),
                                usd(r.sui_gross),
                                usd(r.sui_taxable),
                                usd(r.sui_employee),
                                usd(r.sui_employer),
                            ]
                        })
                        .collect(),
                    totals: Some(vec![
                        "Total".into(),
                        String::new(),
                        usd(gross),
                        usd(taxable),
                        usd(employee),
                        usd(employer_part),
                    ]),
                },
                DocumentSection::Text {
                    title: None,
                    paragraphs: vec![format!(
                        "File and pay with {state} by {due_date}. The CSV next to this report has full SSNs for filing."
                    )],
                },
            ],
            None,
        ),
        files: Some(vec![file]),
    })
}
