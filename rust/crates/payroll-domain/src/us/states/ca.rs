//! California (`us/states/ca.ts`): DE 44 method B, UI with ETT, SDI.

#![allow(
    clippy::unnecessary_cast,
    clippy::cast_lossless,
    clippy::unreadable_literal
)]

use super::common::{
    PeriodType, PretaxExclusions, ProgramSpec, ScheduleRow, StateCalcInput, StateCalcResult,
    SuiRules, SuiSurcharge, YtdWriter, cert_allowances, cert_boolean, cert_extra_cents,
    cert_number, compute_program, compute_sui, d, income_tax_result, period_type_of,
    provisional_issue, record_income_tax, residence_issue, round_cents, schedule_tax,
    taxable_wages, unsupported_frequency_result, unsupported_year_result,
};
use super::pairs;
use crate::money::{Cents, js_max, percent_of};

const STATE: &str = "CA";
const RULE_SET: &str = "us-ca-2026.1";
const PIT_EXCLUSIONS: PretaxExclusions = PretaxExclusions {
    retirement401k: true,
    section125: true,
    hsa: false,
    dependent_care: true,
};
const UI_SDI_EXCLUSIONS: PretaxExclusions = PretaxExclusions {
    retirement401k: false,
    section125: true,
    hsa: false,
    dependent_care: true,
};

/// Per period type (weekly … annual).
const LOW_INCOME: [[f64; 2]; 7] = [
    [363.0, 727.0],
    [727.0, 1454.0],
    [787.0, 1575.0],
    [1575.0, 3149.0],
    [4724.0, 9448.0],
    [9448.0, 18896.0],
    [18896.0, 37791.0],
];
const STANDARD_DEDUCTION: [[f64; 2]; 7] = [
    [110.0, 219.0],
    [219.0, 439.0],
    [238.0, 476.0],
    [476.0, 951.0],
    [1427.0, 2853.0],
    [2853.0, 5706.0],
    [5706.0, 11412.0],
];
const ESTIMATED_DEDUCTION: [[f64; 10]; 7] = [
    [
        19.0, 38.0, 58.0, 77.0, 96.0, 115.0, 135.0, 154.0, 173.0, 192.0,
    ],
    [
        38.0, 77.0, 115.0, 154.0, 192.0, 231.0, 269.0, 308.0, 346.0, 385.0,
    ],
    [
        42.0, 83.0, 125.0, 167.0, 208.0, 250.0, 292.0, 333.0, 375.0, 417.0,
    ],
    [
        83.0, 167.0, 250.0, 333.0, 417.0, 500.0, 583.0, 667.0, 750.0, 833.0,
    ],
    [
        250.0, 500.0, 750.0, 1000.0, 1250.0, 1500.0, 1750.0, 2000.0, 2250.0, 2500.0,
    ],
    [
        500.0, 1000.0, 1500.0, 2000.0, 2500.0, 3000.0, 3500.0, 4000.0, 4500.0, 5000.0,
    ],
    [
        1000.0, 2000.0, 3000.0, 4000.0, 5000.0, 6000.0, 7000.0, 8000.0, 9000.0, 10000.0,
    ],
];
const EXEMPTION_CREDIT: [[f64; 10]; 7] = [
    [
        3.24, 6.47, 9.71, 12.95, 16.18, 19.42, 22.66, 25.89, 29.13, 32.37,
    ],
    [
        6.47, 12.95, 19.42, 25.89, 32.37, 38.84, 45.31, 51.78, 58.26, 64.73,
    ],
    [
        7.01, 14.03, 21.04, 28.05, 35.06, 42.08, 49.09, 56.1, 63.11, 70.13,
    ],
    [
        14.03, 28.05, 42.08, 56.1, 70.13, 84.15, 98.18, 112.2, 126.23, 140.25,
    ],
    [
        42.08, 84.15, 126.23, 168.3, 210.38, 252.45, 294.53, 336.6, 378.68, 420.75,
    ],
    [
        84.15, 168.3, 252.45, 336.6, 420.75, 504.9, 589.05, 673.2, 757.35, 841.5,
    ],
    [
        168.3, 336.6, 504.9, 673.2, 841.5, 1009.8, 1178.1, 1346.4, 1514.7, 1683.0,
    ],
];
const RATES: [f64; 10] = [1.1, 2.2, 4.4, 6.6, 8.8, 10.23, 11.33, 12.43, 13.53, 14.63];

type Raw = &'static [(f64, f64)];

/// `TAX_TABLES[period][status]`: (single, married, head of household) per
/// period type.
const TAX_TABLES: [[Raw; 3]; 7] = [
    // weekly
    [
        pairs![
            [0, 0],
            [213, 2.34],
            [505, 8.76],
            [797, 21.61],
            [1107, 42.07],
            [1399, 67.77],
            [7144, 655.48],
            [8573, 817.39],
            [14288, 1527.76],
            [19231, 2196.55]
        ],
        pairs![
            [0, 0],
            [426, 4.69],
            [1010, 17.54],
            [1594, 43.24],
            [2214, 84.16],
            [2798, 135.55],
            [14288, 1310.98],
            [17146, 1634.79],
            [19231, 1893.96],
            [28575, 3158.2]
        ],
        pairs![
            [0, 0],
            [426, 4.69],
            [1010, 17.54],
            [1302, 30.39],
            [1612, 50.85],
            [1904, 76.55],
            [9716, 875.72],
            [11659, 1095.86],
            [19231, 2037.06],
            [19431, 2064.12]
        ],
    ],
    // biweekly
    [
        pairs![
            [0, 0],
            [426, 4.69],
            [1010, 17.54],
            [1594, 43.24],
            [2214, 84.16],
            [2798, 135.55],
            [14288, 1310.98],
            [17146, 1634.79],
            [28576, 3055.54],
            [38462, 4393.12]
        ],
        pairs![
            [0, 0],
            [852, 9.37],
            [2020, 35.07],
            [3188, 86.46],
            [4428, 168.3],
            [5596, 271.08],
            [28576, 2621.93],
            [34292, 3269.55],
            [38462, 3787.88],
            [57150, 6316.37]
        ],
        pairs![
            [0, 0],
            [852, 9.37],
            [2020, 35.07],
            [2604, 60.77],
            [3224, 101.69],
            [3808, 153.08],
            [19432, 1751.42],
            [23318, 2191.7],
            [38462, 4074.1],
            [38862, 4128.22]
        ],
    ],
    // semimonthly
    [
        pairs![
            [0, 0],
            [462, 5.08],
            [1094, 18.98],
            [1727, 46.83],
            [2398, 91.12],
            [3030, 146.74],
            [15478, 1420.17],
            [18574, 1770.95],
            [30956, 3310.03],
            [41667, 4759.23]
        ],
        pairs![
            [0, 0],
            [924, 10.16],
            [2188, 37.97],
            [3454, 93.67],
            [4796, 182.24],
            [6060, 293.47],
            [30956, 2840.33],
            [37148, 3541.88],
            [41667, 4103.59],
            [61913, 6842.87]
        ],
        pairs![
            [0, 0],
            [924, 10.16],
            [2189, 37.99],
            [2822, 65.84],
            [3492, 110.06],
            [4125, 165.76],
            [21050, 1897.19],
            [25260, 2374.18],
            [41667, 4413.57],
            [42101, 4472.29]
        ],
    ],
    // monthly
    [
        pairs![
            [0, 0],
            [924, 10.16],
            [2188, 37.97],
            [3454, 93.67],
            [4796, 182.24],
            [6060, 293.47],
            [30956, 2840.33],
            [37148, 3541.88],
            [61912, 6620.05],
            [83334, 9518.45]
        ],
        pairs![
            [0, 0],
            [1848, 20.33],
            [4376, 75.95],
            [6908, 187.36],
            [9592, 364.5],
            [12120, 586.96],
            [61912, 5680.68],
            [74296, 7083.79],
            [83334, 8207.21],
            [123826, 13685.78]
        ],
        pairs![
            [0, 0],
            [1848, 20.33],
            [4378, 75.99],
            [5644, 131.69],
            [6984, 220.13],
            [8250, 331.54],
            [42100, 3794.4],
            [50520, 4748.39],
            [83334, 8827.17],
            [84202, 8944.61]
        ],
    ],
    // quarterly
    [
        pairs![
            [0, 0],
            [2770, 30.47],
            [6566, 113.98],
            [10363, 281.05],
            [14386, 546.57],
            [18181, 880.53],
            [92870, 8521.21],
            [111443, 10625.53],
            [185738, 19860.4],
            [250000, 28555.05]
        ],
        pairs![
            [0, 0],
            [5540, 60.94],
            [13132, 227.96],
            [20726, 562.1],
            [28772, 1093.14],
            [36362, 1761.06],
            [185740, 17042.43],
            [222886, 21251.07],
            [250000, 24621.34],
            [371477, 41057.18]
        ],
        pairs![
            [0, 0],
            [5543, 60.97],
            [13133, 227.95],
            [16929, 394.97],
            [20951, 660.42],
            [24748, 994.56],
            [126302, 11383.53],
            [151563, 14245.6],
            [250000, 26481.32],
            [252604, 26833.64]
        ],
    ],
    // semiannual
    [
        pairs![
            [0, 0],
            [5540, 60.94],
            [13132, 227.96],
            [20726, 562.1],
            [28772, 1093.14],
            [36362, 1761.06],
            [185740, 17042.43],
            [222886, 21251.07],
            [371476, 39720.81],
            [500000, 57110.11]
        ],
        pairs![
            [0, 0],
            [11080, 121.88],
            [26264, 455.93],
            [41452, 1124.2],
            [57544, 2186.27],
            [72724, 3522.11],
            [371480, 34084.85],
            [445772, 42502.13],
            [500000, 49242.67],
            [742954, 82114.35]
        ],
        pairs![
            [0, 0],
            [11086, 121.95],
            [26266, 455.91],
            [33858, 789.96],
            [41902, 1320.86],
            [49496, 1989.13],
            [252604, 22767.08],
            [303126, 28491.22],
            [500000, 52962.66],
            [505208, 53667.3]
        ],
    ],
    // annual
    [
        pairs![
            [0, 0],
            [11079, 121.87],
            [26264, 455.94],
            [41452, 1124.21],
            [57542, 2186.15],
            [72724, 3522.17],
            [371479, 34084.81],
            [445771, 42502.09],
            [742953, 79441.81],
            [1000000, 114220.27]
        ],
        pairs![
            [0, 0],
            [22158, 243.74],
            [52528, 911.88],
            [82904, 2248.42],
            [115084, 4372.3],
            [145448, 7044.33],
            [742958, 68169.6],
            [891542, 85004.17],
            [1000000, 98485.5],
            [1485906, 164228.58]
        ],
        pairs![
            [0, 0],
            [22173, 243.9],
            [52530, 911.75],
            [67716, 1579.93],
            [83805, 2641.8],
            [98990, 3978.08],
            [505208, 45534.18],
            [606251, 56982.35],
            [1000000, 105925.35],
            [1010417, 107334.77]
        ],
    ],
];

fn table(raw: Raw) -> Vec<ScheduleRow> {
    raw.iter()
        .enumerate()
        .map(|(i, (over, base))| ScheduleRow {
            over: d(*over),
            base_cents: d(*base),
            rate_percent: RATES[i],
        })
        .collect()
}

fn per_allowance(values: &[f64; 10], count: f64) -> Cents {
    if count <= 0.0 {
        return 0.0;
    }
    if count <= 10.0 {
        d(values[count as usize - 1])
    } else {
        count * d(values[0])
    }
}

/// `caStatus(raw)`: 0 single, 1 married, 2 head of household.
fn ca_status(raw: Option<&str>) -> usize {
    match raw {
        Some("married") => 1,
        Some("head_of_household") => 2,
        _ => 0,
    }
}

/// `caMethodB(input)`.
pub fn ca_method_b(
    period: PeriodType,
    status: usize,
    regular_allowances: f64,
    estimated_allowances: f64,
    wages: Cents,
) -> f64 {
    let p = period.index();
    let total = regular_allowances + estimated_allowances;
    let column = usize::from(status == 2 || (status == 1 && total >= 2.0));
    if wages <= d(LOW_INCOME[p][column]) {
        return 0.0;
    }
    let taxable = wages
        - per_allowance(&ESTIMATED_DEDUCTION[p], estimated_allowances)
        - d(STANDARD_DEDUCTION[p][column]);
    let tax = schedule_tax(taxable, &table(TAX_TABLES[p][status]), false)
        - per_allowance(&EXEMPTION_CREDIT[p], regular_allowances);
    js_max(0.0, tax)
}

pub(crate) fn calculate(input: &StateCalcInput<'_>) -> StateCalcResult {
    if input.tax_year != 2026 {
        return unsupported_year_result(input, STATE);
    }
    let Some(period) = period_type_of(input.periods_per_year) else {
        return unsupported_frequency_result(input, STATE, RULE_SET);
    };
    let mut ytd = YtdWriter::new(input, STATE);
    let mut issues = residence_issue(input, STATE);
    issues.extend(provisional_issue(STATE, &[]));
    let wages = taxable_wages(input, PIT_EXCLUSIONS);
    let cert = input.certificate;
    let mut income_tax = 0.0;
    let exempt = input.certificate_exempt() || cert_boolean(input, "military_spouse_exempt");
    if !exempt {
        let status = ca_status(cert.and_then(|c| c.filing_status.as_deref()));
        let regular_allowances = if cert.is_some() {
            cert_allowances(input)
        } else {
            0.0
        };
        let estimated = if cert.is_some() {
            js_max(
                0.0,
                cert_number(input, "estimated_deduction_allowances").trunc(),
            )
        } else {
            0.0
        };
        if wages.regular > 0.0 {
            income_tax = round_cents(ca_method_b(
                period,
                status,
                regular_allowances,
                estimated,
                wages.regular + wages.supplemental,
            ));
        } else if wages.supplemental > 0.0 {
            income_tax = percent_of(wages.supplemental, 10.23);
        }
        if wages.total > 0.0 {
            income_tax += cert_extra_cents(input);
        }
    }
    record_income_tax(&mut ytd, wages.total, income_tax);
    let rules = SuiRules {
        wage_base_cents: d(7000.0),
        new_employer_rate_percent: Some(3.4),
        exclusions: UI_SDI_EXCLUSIONS,
        employee: None,
        surcharges: vec![SuiSurcharge {
            code: "ca_ett",
            label_key: "us.state_program.ca_ett",
            rate_key: "ca_ett",
            default_rate_percent: 0.1,
        }],
    };
    let sui = compute_sui(input, STATE, &rules, &mut ytd);
    let sdi = compute_program(
        input,
        STATE,
        &ProgramSpec {
            code: "ca_sdi",
            label_key: "us.state_program.ca_sdi",
            wages_cents: taxable_wages(input, UI_SDI_EXCLUSIONS).total,
            wage_base_cents: None,
            employee_rate_percent: 1.3,
            employer_rate_percent: 0.0,
            employee_annual_max_cents: None,
            employee_period_max_cents: None,
        },
        &mut ytd,
    );
    income_tax_result(
        wages.total,
        income_tax,
        sui,
        vec![sdi],
        ytd,
        issues,
        RULE_SET,
    )
}
