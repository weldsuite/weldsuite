//! New Jersey (`us/states/nj.ts`): rate tables A–E, UI/WF/SWF, TDI and FLI.

#![allow(
    clippy::unnecessary_cast,
    clippy::cast_lossless,
    clippy::unreadable_literal
)]

use serde_json::json;

use super::common::{
    NO_EXCLUSIONS, PeriodType, PretaxExclusions, ProgramSpec, ScheduleRow, StateCalcInput,
    StateCalcResult, SuiEmployee, SuiRules, SuiSurcharge, YtdWriter, cert_allowances, cert_boolean,
    cert_extra_cents, cert_string, compute_program, compute_sui, d, gross_wages, period_type_of,
    provisional_issue, record_income_tax, residence_issue, round_cents, schedule_tax,
    taxable_wages, unsupported_frequency_result, unsupported_year_result,
};
use super::pairs;
use crate::money::{Cents, js_max};
use crate::types::PayrollIssue;

const STATE: &str = "NJ";
const RULE_SET: &str = "us-nj-2026.1";
const GIT_EXCLUSIONS: PretaxExclusions = PretaxExclusions {
    retirement401k: true,
    section125: false,
    hsa: false,
    dependent_care: false,
};
const ALLOWANCE: [f64; 7] = [19.2, 38.4, 41.6, 83.3, 250.0, 500.0, 1000.0];
const EMPLOYER_WF_SWF_RATE_PERCENT: f64 = 0.1175;
const TDI_EMPLOYER_NEW_RATE_PERCENT: f64 = 0.5;

const RATES: [&[f64]; 5] = [
    &[1.5, 2.0, 3.9, 6.1, 7.0, 9.9, 11.8],
    &[1.5, 2.0, 2.7, 3.9, 6.1, 7.0, 9.9, 11.8],
    &[1.5, 2.3, 2.8, 3.5, 5.6, 6.6, 9.9, 11.8],
    &[1.5, 2.7, 3.4, 4.3, 5.6, 6.5, 9.9, 11.8],
    &[1.5, 2.0, 5.8, 6.5, 9.9, 11.8],
];

type Raw = &'static [(f64, f64)];

/// `RAW[rate][period]`: rates A–E, periods weekly … annual.
const RAW: [[Raw; 7]; 5] = [
    [
        pairs![
            [0, 0],
            [385, 5.77],
            [673, 11.54],
            [769, 15.29],
            [1442, 56.35],
            [9615, 628.46],
            [19231, 1580.38]
        ],
        pairs![
            [0, 0],
            [769, 12],
            [1346, 23],
            [1538, 31],
            [2885, 113],
            [19231, 1257],
            [38462, 3161]
        ],
        pairs![
            [0, 0],
            [833, 13],
            [1458, 25],
            [1667, 33],
            [3125, 122],
            [20833, 1362],
            [41667, 3424]
        ],
        pairs![
            [0, 0],
            [1667, 25],
            [2917, 50],
            [3333, 66],
            [6250, 244],
            [41667, 2723],
            [83333, 6848]
        ],
        pairs![
            [0, 0],
            [5000, 75],
            [8750, 150],
            [10000, 198.75],
            [18750, 732.5],
            [125000, 8170],
            [250000, 20545]
        ],
        pairs![
            [0, 0],
            [10000, 150],
            [17500, 300],
            [20000, 397.5],
            [37500, 1465],
            [250000, 16340],
            [500000, 41090]
        ],
        pairs![
            [0, 0],
            [20000, 300],
            [35000, 600],
            [40000, 795],
            [75000, 2930],
            [500000, 32680],
            [1000000, 82180]
        ],
    ],
    [
        pairs![
            [0, 0],
            [385, 5.77],
            [962, 17.31],
            [1346, 27.69],
            [1538, 35.19],
            [2885, 117.31],
            [9615, 588.46],
            [19231, 1540.38]
        ],
        pairs![
            [0, 0],
            [769, 12],
            [1923, 35],
            [2692, 55],
            [3077, 70],
            [5769, 235],
            [19231, 1177],
            [38462, 3081]
        ],
        pairs![
            [0, 0],
            [833, 12.5],
            [2083, 37.5],
            [2917, 59.99],
            [3333, 76.25],
            [6250, 254.19],
            [20833, 1275],
            [41667, 3338]
        ],
        pairs![
            [0, 0],
            [1667, 25],
            [4167, 75],
            [5833, 120],
            [6667, 153],
            [12500, 508],
            [41667, 2550],
            [83333, 6675]
        ],
        pairs![
            [0, 0],
            [5000, 75],
            [12500, 225],
            [17500, 360],
            [20000, 457.5],
            [37500, 1525],
            [125000, 7650],
            [250000, 20025]
        ],
        pairs![
            [0, 0],
            [10000, 150],
            [25000, 450],
            [35000, 720],
            [40000, 915],
            [75000, 3050],
            [250000, 15300],
            [500000, 40050]
        ],
        pairs![
            [0, 0],
            [20000, 300],
            [50000, 900],
            [70000, 1440],
            [80000, 1830],
            [150000, 6100],
            [500000, 30600],
            [1000000, 80100]
        ],
    ],
    [
        pairs![
            [0, 0],
            [385, 5.77],
            [769, 14.62],
            [962, 20],
            [1154, 26.73],
            [2885, 123.65],
            [9615, 567.88],
            [19231, 1519.81]
        ],
        pairs![
            [0, 0],
            [769, 11.54],
            [1538, 29.23],
            [1923, 40],
            [2308, 53.46],
            [5769, 247.31],
            [19231, 1135.77],
            [38462, 3039.62]
        ],
        pairs![
            [0, 0],
            [833, 12.5],
            [1667, 31.67],
            [2083, 43.33],
            [2500, 57.92],
            [6250, 267.92],
            [20833, 1230.42],
            [41667, 3292.92]
        ],
        pairs![
            [0, 0],
            [1667, 25],
            [3333, 63.33],
            [4167, 86.67],
            [5000, 115.83],
            [12500, 535.85],
            [41667, 2460.83],
            [83333, 6585.83]
        ],
        pairs![
            [0, 0],
            [5000, 75],
            [10000, 190],
            [12500, 260],
            [15000, 347.5],
            [37500, 1607.5],
            [125000, 7382.5],
            [250000, 19757.5]
        ],
        pairs![
            [0, 0],
            [10000, 150],
            [20000, 380],
            [25000, 520],
            [30000, 695],
            [75000, 3215],
            [250000, 14765],
            [500000, 39515]
        ],
        pairs![
            [0, 0],
            [20000, 300],
            [40000, 760],
            [50000, 1040],
            [60000, 1390],
            [150000, 6430],
            [500000, 29530],
            [1000000, 79030]
        ],
    ],
    [
        pairs![
            [0, 0],
            [385, 5.77],
            [769, 16.15],
            [962, 22.69],
            [1154, 30.96],
            [2885, 127.88],
            [9615, 565.38],
            [19231, 1517.31]
        ],
        pairs![
            [0, 0],
            [769, 11.54],
            [1538, 32.31],
            [1923, 45.38],
            [2308, 61.92],
            [5769, 255.77],
            [19231, 1130.77],
            [38462, 3034.62]
        ],
        pairs![
            [0, 0],
            [833, 12.5],
            [1667, 35],
            [2083, 49.17],
            [2500, 67.08],
            [6250, 277.08],
            [20833, 1225],
            [41667, 3287.5]
        ],
        pairs![
            [0, 0],
            [1667, 25],
            [3333, 70],
            [4167, 98.33],
            [5000, 134.17],
            [12500, 554.17],
            [41667, 2450],
            [83333, 6575]
        ],
        pairs![
            [0, 0],
            [5000, 75],
            [10000, 210],
            [12500, 295],
            [15000, 402.5],
            [37500, 1662.5],
            [125000, 7350],
            [250000, 19725]
        ],
        pairs![
            [0, 0],
            [10000, 150],
            [20000, 420],
            [25000, 590],
            [30000, 805],
            [75000, 3325],
            [250000, 14700],
            [500000, 39450]
        ],
        pairs![
            [0, 0],
            [20000, 300],
            [40000, 840],
            [50000, 1180],
            [60000, 1610],
            [150000, 6650],
            [500000, 29400],
            [1000000, 78900]
        ],
    ],
    [
        pairs![
            [0, 0],
            [385, 5.77],
            [673, 11.54],
            [1923, 84.04],
            [9615, 584.04],
            [19231, 1535.96]
        ],
        pairs![
            [0, 0],
            [769, 12],
            [1346, 23],
            [3846, 168],
            [19231, 1168],
            [38462, 3072]
        ],
        pairs![
            [0, 0],
            [833, 13],
            [1458, 25],
            [4167, 182],
            [20833, 1265],
            [41667, 3328]
        ],
        pairs![
            [0, 0],
            [1667, 25],
            [2917, 50],
            [8333, 364],
            [41667, 2531],
            [83333, 6656]
        ],
        pairs![
            [0, 0],
            [5000, 75],
            [8750, 150],
            [25000, 1092.5],
            [125000, 7592.5],
            [250000, 19967.5]
        ],
        pairs![
            [0, 0],
            [10000, 150],
            [17500, 300],
            [50000, 2185],
            [250000, 15185],
            [500000, 39935]
        ],
        pairs![
            [0, 0],
            [20000, 300],
            [35000, 600],
            [100000, 4370],
            [500000, 30370],
            [1000000, 79870]
        ],
    ],
];

fn table(rate: usize, period: PeriodType) -> Vec<ScheduleRow> {
    RAW[rate][period.index()]
        .iter()
        .enumerate()
        .map(|(i, (over, base))| ScheduleRow {
            over: d(*over),
            base_cents: d(*base),
            rate_percent: RATES[rate][i],
        })
        .collect()
}

/// `rateTable(input)`: 0–4 for A–E.
fn rate_table(input: &StateCalcInput<'_>) -> usize {
    if let Some(chosen) = cert_string(input, "rate_table") {
        if let Some(at) = ["A", "B", "C", "D", "E"].iter().position(|r| *r == chosen) {
            return at;
        }
    }
    match input.certificate.and_then(|c| c.filing_status.as_deref()) {
        Some("married_joint" | "head_of_household" | "qualifying_widow") => 1,
        _ => 0,
    }
}

/// `njWithholding(wagesCents, rate, period, allowances)`.
pub fn nj_withholding(wages_cents: Cents, rate: usize, period: PeriodType, allowances: f64) -> f64 {
    let subject = wages_cents - allowances * d(ALLOWANCE[period.index()]);
    schedule_tax(subject, &table(rate, period), false)
}

pub(crate) fn calculate(input: &StateCalcInput<'_>) -> StateCalcResult {
    if input.tax_year != 2026 {
        return unsupported_year_result(input, STATE);
    }
    let Some(period) = period_type_of(input.periods_per_year) else {
        return unsupported_frequency_result(input, STATE, RULE_SET);
    };
    let mut ytd = YtdWriter::new(input, STATE);
    let cert = input.certificate;
    let mut issues: Vec<PayrollIssue> = residence_issue(input, STATE);
    issues.extend(provisional_issue(
        STATE,
        if cert.is_some() {
            &[]
        } else {
            &["no NJ-W4: Rate A, no allowances"]
        },
    ));
    let wages = taxable_wages(input, GIT_EXCLUSIONS);
    let mut income_tax = 0.0;
    let exempt = input.certificate_exempt() || cert_boolean(input, "nj165_pa_resident");
    if !exempt {
        let rate = rate_table(input);
        let allowances = if cert.is_some() {
            cert_allowances(input)
        } else {
            0.0
        };
        if wages.regular > 0.0 {
            income_tax = round_cents(nj_withholding(
                wages.regular + wages.supplemental,
                rate,
                period,
                allowances,
            ));
        } else if wages.supplemental > 0.0 {
            income_tax = round_cents(nj_withholding(wages.supplemental, rate, period, 0.0));
        }
        if wages.total > 0.0 {
            income_tax += cert_extra_cents(input);
        }
    }
    record_income_tax(&mut ytd, wages.total, income_tax);
    let ui_input = StateCalcInput {
        sui_rate_percent: input
            .sui_rate_percent
            .map(|total| js_max(0.0, total - EMPLOYER_WF_SWF_RATE_PERCENT)),
        ..input.clone()
    };
    let ui_wage_base = d(44800.0);
    let rules = SuiRules {
        wage_base_cents: ui_wage_base,
        new_employer_rate_percent: Some(2.8 - EMPLOYER_WF_SWF_RATE_PERCENT),
        exclusions: NO_EXCLUSIONS,
        employee: Some(SuiEmployee {
            rate_percent: 0.425,
            wage_base_cents: Some(ui_wage_base),
        }),
        surcharges: vec![SuiSurcharge {
            code: "nj_wf_swf",
            label_key: "us.state_program.nj_wf_swf",
            rate_key: "nj_wf_swf",
            default_rate_percent: EMPLOYER_WF_SWF_RATE_PERCENT,
        }],
    };
    let sui = compute_sui(&ui_input, STATE, &rules, &mut ytd);
    issues.extend(sui.issues);
    let gross = if input.exempt_from_sui {
        0.0
    } else {
        gross_wages(input)
    };
    let worker_base = Some(d(171100.0));
    let program = |code, label_key, base, employee, employer| ProgramSpec {
        code,
        label_key,
        wages_cents: gross,
        wage_base_cents: base,
        employee_rate_percent: employee,
        employer_rate_percent: employer,
        employee_annual_max_cents: None,
        employee_period_max_cents: None,
    };
    let tdi = compute_program(
        input,
        STATE,
        &program(
            "nj_tdi",
            "us.state_program.nj_tdi",
            worker_base,
            input.extra_rate("nj_tdi_employee").unwrap_or(0.19),
            0.0,
        ),
        &mut ytd,
    );
    let tdi_employer = compute_program(
        input,
        STATE,
        &program(
            "nj_tdi_employer",
            "us.state_program.nj_tdi_employer",
            Some(ui_wage_base),
            0.0,
            input
                .extra_rate("nj_employer_tdi")
                .unwrap_or(TDI_EMPLOYER_NEW_RATE_PERCENT),
        ),
        &mut ytd,
    );
    let fli = compute_program(
        input,
        STATE,
        &program(
            "nj_fli",
            "us.state_program.nj_fli",
            worker_base,
            input.extra_rate("nj_fli_employee").unwrap_or(0.23),
            0.0,
        ),
        &mut ytd,
    );
    if input.extra_rate("nj_employer_tdi").is_none() {
        issues.push(PayrollIssue::warning("employer_incomplete").with(&[
            ("state", json!(STATE)),
            ("field", json!("nj_employer_tdi")),
            (
                "fallbackRatePercent",
                crate::js::number_value(TDI_EMPLOYER_NEW_RATE_PERCENT),
            ),
        ]));
    }
    let mut programs = vec![tdi, fli, tdi_employer];
    programs.extend(sui.programs);
    StateCalcResult {
        state_wages_cents: wages.total,
        income_tax_cents: income_tax,
        sui: sui.sui,
        programs,
        ytd_updates: ytd.updates,
        issues,
        rule_set: RULE_SET.into(),
    }
}
