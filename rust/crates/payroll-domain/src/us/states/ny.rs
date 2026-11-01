//! New York (`us/states/ny.ts`): the exact-calculation method, UI with RSF,
//! paid family leave and disability.

#![allow(
    clippy::unnecessary_cast,
    clippy::cast_lossless,
    clippy::unreadable_literal
)]

use serde_json::json;

use super::common::{
    FEDERAL_INCOME_TAX_LIKE, NO_EXCLUSIONS, PeriodType, ProgramSpec, ScheduleRow, StateCalcInput,
    StateCalcResult, SuiRules, SuiSurcharge, YtdWriter, cert_allowances, cert_boolean,
    cert_extra_cents, compute_program, compute_sui, d, gross_wages, income_tax_result,
    nominal_periods, period_type_of, record_income_tax, residence_issue, round_cents, schedule_tax,
    taxable_wages, unsupported_frequency_result, unsupported_year_result,
};
use crate::money::{Cents, percent_of};
use crate::types::PayrollIssue;

const STATE: &str = "NY";
const RULE_SET: &str = "us-ny-2026.1";
const SUPPLEMENTAL_RATE_PERCENT: f64 = 11.7;

/// The table periods: weekly, biweekly, semimonthly, monthly, annual.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NyPeriod {
    Weekly,
    Biweekly,
    Semimonthly,
    Monthly,
    Annual,
}

const DEDUCTION: [[f64; 2]; 5] = [
    [142.3, 152.9],
    [284.6, 305.8],
    [308.35, 331.25],
    [616.7, 662.5],
    [7400.0, 7950.0],
];
const EXEMPTION: [f64; 5] = [19.25, 38.5, 41.65, 83.3, 1000.0];

type Lines = &'static [(f64, f64, f64)];

macro_rules! lines {
    ($([$a:expr, $r:expr, $b:expr]),* $(,)?) => { &[$(($a as f64, $r as f64, $b as f64)),*] };
}

/// `EXACT[period][status]`: (rows, methodIIIFrom in dollars); status single, married.
const EXACT: [[(Lines, f64); 2]; 5] = [
    [
        (
            lines![
                [0, 0.039, 0],
                [163, 0.044, 6.38],
                [225, 0.0515, 9.08],
                [267, 0.054, 11.27],
                [1551, 0.059, 80.58],
                [1862, 0.0703, 98.9],
                [2070, 0.0753, 113.58],
                [3032, 0.064, 186.02],
                [4142, 0.1144, 257.1],
                [5104, 0.0735, 367.13]
            ],
            20722.0,
        ),
        (
            lines![
                [0, 0.039, 0],
                [163, 0.044, 6.38],
                [225, 0.0515, 9.08],
                [267, 0.054, 11.27],
                [1551, 0.059, 80.58],
                [1862, 0.0657, 98.9],
                [2070, 0.0707, 112.6],
                [3032, 0.0801, 180.54],
                [4068, 0.064, 263.62],
                [6215, 0.1349, 401.04],
                [7177, 0.0735, 530.77],
                [20722, 0.0765, 1526.33]
            ],
            41449.0,
        ),
    ],
    [
        (
            lines![
                [0, 0.039, 0],
                [327, 0.044, 12.77],
                [450, 0.0515, 18.15],
                [535, 0.054, 22.54],
                [3102, 0.059, 161.15],
                [3723, 0.0703, 197.81],
                [4140, 0.0753, 227.15],
                [6063, 0.064, 372.04],
                [8285, 0.1144, 514.19],
                [10208, 0.0735, 734.27]
            ],
            41444.0,
        ),
        (
            lines![
                [0, 0.039, 0],
                [327, 0.044, 12.77],
                [450, 0.0515, 18.15],
                [535, 0.054, 22.54],
                [3102, 0.059, 161.15],
                [3723, 0.0657, 197.81],
                [4140, 0.0707, 225.19],
                [6063, 0.0801, 361.08],
                [8137, 0.064, 527.23],
                [12431, 0.1349, 802.08],
                [14354, 0.0735, 1061.54],
                [41444, 0.0765, 3052.65]
            ],
            82898.0,
        ),
    ],
    [
        (
            lines![
                [0, 0.039, 0],
                [354, 0.044, 13.83],
                [488, 0.0515, 19.67],
                [579, 0.054, 24.42],
                [3360, 0.059, 174.58],
                [4033, 0.0703, 214.29],
                [4485, 0.0753, 246.08],
                [6569, 0.064, 403.04],
                [8975, 0.1144, 557.04],
                [11058, 0.0735, 795.46]
            ],
            44898.0,
        ),
        (
            lines![
                [0, 0.039, 0],
                [354, 0.044, 13.83],
                [488, 0.0515, 19.67],
                [579, 0.054, 24.42],
                [3360, 0.059, 174.58],
                [4033, 0.0657, 214.29],
                [4485, 0.0707, 243.96],
                [6569, 0.0801, 391.17],
                [8815, 0.064, 571.17],
                [13467, 0.1349, 868.92],
                [15550, 0.0735, 1150.0],
                [44898, 0.0765, 3307.04]
            ],
            89806.0,
        ),
    ],
    [
        (
            lines![
                [0, 0.039, 0],
                [708, 0.044, 27.67],
                [975, 0.0515, 39.33],
                [1158, 0.054, 48.83],
                [6721, 0.059, 349.17],
                [8067, 0.0703, 428.58],
                [8971, 0.0753, 492.17],
                [13138, 0.064, 806.08],
                [17950, 0.1144, 1114.08],
                [22117, 0.0735, 1590.92]
            ],
            89796.0,
        ),
        (
            lines![
                [0, 0.039, 0],
                [708, 0.044, 27.67],
                [975, 0.0515, 39.33],
                [1158, 0.054, 48.83],
                [6721, 0.059, 349.17],
                [8067, 0.0657, 428.58],
                [8971, 0.0707, 487.92],
                [13138, 0.0801, 782.33],
                [17629, 0.064, 1142.33],
                [26933, 0.1349, 1737.83],
                [31100, 0.0735, 2300.0],
                [89796, 0.0765, 6614.08]
            ],
            179613.0,
        ),
    ],
    [
        (
            lines![
                [0, 0.039, 0],
                [8500, 0.044, 332],
                [11700, 0.0515, 472],
                [13900, 0.054, 586],
                [80650, 0.059, 4190],
                [96800, 0.0703, 5143],
                [107650, 0.0753, 5906],
                [157650, 0.064, 9673],
                [215400, 0.1144, 13369],
                [265400, 0.0735, 19091]
            ],
            1077550.0,
        ),
        (
            lines![
                [0, 0.039, 0],
                [8500, 0.044, 332],
                [11700, 0.0515, 472],
                [13900, 0.054, 586],
                [80650, 0.059, 4190],
                [96800, 0.0657, 5143],
                [107650, 0.0707, 5855],
                [157650, 0.0801, 9388],
                [211550, 0.064, 13708],
                [323200, 0.1349, 20854],
                [373200, 0.0735, 27600],
                [1077550, 0.0765, 79369]
            ],
            2155350.0,
        ),
    ],
];

fn rows(lines: Lines) -> Vec<ScheduleRow> {
    lines
        .iter()
        .map(|(at_least, rate, add)| ScheduleRow {
            over: d(*at_least),
            base_cents: d(*add),
            rate_percent: rate * 100.0,
        })
        .collect()
}

fn method_iii_rate(annualized_net_cents: Cents) -> f64 {
    if annualized_net_cents < d(5_000_000.0) {
        10.45
    } else if annualized_net_cents < d(25_000_000.0) {
        11.1
    } else {
        11.7
    }
}

/// `nyExactWithholding(input)`; `married` is the married table.
fn ny_exact_withholding(
    period: NyPeriod,
    married: bool,
    allowances: f64,
    wages_cents: Cents,
    periods_per_year: f64,
) -> f64 {
    let p = period as usize;
    let status = usize::from(married);
    let net = wages_cents - d(DEDUCTION[p][status]) - allowances * d(EXEMPTION[p]);
    if net <= 0.0 {
        return 0.0;
    }
    let (lines, method_iii_from) = EXACT[p][status];
    if net >= d(method_iii_from) {
        return (net * method_iii_rate(net * periods_per_year)) / 100.0;
    }
    schedule_tax(net, &rows(lines), true)
}

fn ny_period(periods_per_year: f64) -> Option<(NyPeriod, f64)> {
    Some(match period_type_of(periods_per_year)? {
        PeriodType::Weekly => (NyPeriod::Weekly, 1.0),
        PeriodType::Biweekly => (NyPeriod::Biweekly, 1.0),
        PeriodType::Semimonthly => (NyPeriod::Semimonthly, 1.0),
        PeriodType::Monthly => (NyPeriod::Monthly, 1.0),
        PeriodType::Annual => (NyPeriod::Annual, 1.0),
        PeriodType::Quarterly => (NyPeriod::Monthly, 3.0),
        PeriodType::Semiannual => (NyPeriod::Monthly, 6.0),
    })
}

pub(crate) fn calculate(input: &StateCalcInput<'_>) -> StateCalcResult {
    if input.tax_year != 2026 {
        return unsupported_year_result(input, STATE);
    }
    let Some((period, factor)) = ny_period(input.periods_per_year) else {
        return unsupported_frequency_result(input, STATE, RULE_SET);
    };
    let mut ytd = YtdWriter::new(input, STATE);
    let mut issues: Vec<PayrollIssue> = residence_issue(input, STATE);
    for (key, locality) in [("nyc_resident", "NYC"), ("yonkers_resident", "Yonkers")] {
        if cert_boolean(input, key) {
            issues.push(
                PayrollIssue::warning("local_tax_not_supported")
                    .with(&[("state", json!(STATE)), ("locality", json!(locality))]),
            );
        }
    }
    let wages = taxable_wages(input, FEDERAL_INCOME_TAX_LIKE);
    let cert = input.certificate;
    let mut income_tax = 0.0;
    if !input.certificate_exempt() {
        let married = cert.and_then(|c| c.filing_status.as_deref()) == Some("married");
        let allowances = if cert.is_some() {
            cert_allowances(input)
        } else {
            0.0
        };
        let withhold = |wages_cents: Cents| {
            round_cents(
                factor
                    * ny_exact_withholding(
                        period,
                        married,
                        allowances,
                        wages_cents / factor,
                        input.periods_per_year * factor,
                    ),
            )
        };
        let regular_tax = if wages.regular > 0.0 {
            withhold(wages.regular)
        } else {
            0.0
        };
        let mut supplemental_tax = 0.0;
        if wages.supplemental > 0.0 {
            supplemental_tax = if wages.regular > 0.0 && regular_tax == 0.0 {
                withhold(wages.regular + wages.supplemental) - regular_tax
            } else {
                percent_of(wages.supplemental, SUPPLEMENTAL_RATE_PERCENT)
            };
        }
        income_tax = regular_tax + supplemental_tax;
        if wages.total > 0.0 {
            income_tax += cert_extra_cents(input);
        }
    }
    record_income_tax(&mut ytd, wages.total, income_tax);
    let rules = SuiRules {
        wage_base_cents: d(17600.0),
        new_employer_rate_percent: Some(4.025),
        exclusions: NO_EXCLUSIONS,
        employee: None,
        surcharges: vec![SuiSurcharge {
            code: "ny_rsf",
            label_key: "us.state_program.ny_rsf",
            rate_key: "ny_rsf",
            default_rate_percent: 0.075,
        }],
    };
    let sui = compute_sui(input, STATE, &rules, &mut ytd);
    issues.extend(sui.issues.iter().cloned());
    let gross = gross_wages(input);
    let pfl = compute_program(
        input,
        STATE,
        &ProgramSpec {
            code: "ny_pfl",
            label_key: "us.state_program.ny_pfl",
            wages_cents: gross,
            wage_base_cents: Some(d(95348.76)),
            employee_rate_percent: input.extra_rate("ny_pfl_employee").unwrap_or(0.432),
            employer_rate_percent: 0.0,
            employee_annual_max_cents: Some(d(411.91)),
            employee_period_max_cents: None,
        },
        &mut ytd,
    );
    let dbl = compute_program(
        input,
        STATE,
        &ProgramSpec {
            code: "ny_dbl",
            label_key: "us.state_program.ny_dbl",
            wages_cents: gross,
            wage_base_cents: None,
            employee_rate_percent: input.extra_rate("ny_dbl_employee").unwrap_or(0.5),
            employer_rate_percent: 0.0,
            employee_annual_max_cents: None,
            employee_period_max_cents: Some(round_cents(
                (d(0.6) * 52.0) / nominal_periods(input.periods_per_year),
            )),
        },
        &mut ytd,
    );
    let sui = super::common::SuiOutcome {
        issues: vec![],
        ..sui
    };
    income_tax_result(
        wages.total,
        income_tax,
        sui,
        vec![pfl, dbl],
        ytd,
        issues,
        RULE_SET,
    )
}
