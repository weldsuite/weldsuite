//! Depreciation tables and yearly parameters
//! (`@weldsuite/books-domain/us-compliance/depreciation-tables`).
//!
//! MACRS percentages are IRS Publication 946 Appendix A: A-1 (half-year), A-2
//! to A-5 (mid-quarter, by the quarter placed in service), A-6 (27.5-year
//! residential rental) and A-7a (39-year nonresidential real property), both
//! mid-month. The section 179, bonus and de minimis figures are data keyed by
//! date; review them every December with the other yearly figures.

/// Recovery periods with percentage tables for personal property.
pub const MACRS_TABLE_CLASSES: [f64; 6] = [3.0, 5.0, 7.0, 10.0, 15.0, 20.0];

const HALF_YEAR_3: [f64; 4] = [33.33, 44.45, 14.81, 7.41];
const HALF_YEAR_5: [f64; 6] = [20.0, 32.0, 19.2, 11.52, 11.52, 5.76];
const HALF_YEAR_7: [f64; 8] = [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46];
const HALF_YEAR_10: [f64; 11] = [
    10.0, 18.0, 14.4, 11.52, 9.22, 7.37, 6.55, 6.55, 6.56, 6.55, 3.28,
];
const HALF_YEAR_15: [f64; 16] = [
    5.0, 9.5, 8.55, 7.7, 6.93, 6.23, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 2.95,
];
const HALF_YEAR_20: [f64; 21] = [
    3.75, 7.219, 6.677, 6.177, 5.713, 5.285, 4.888, 4.522, 4.462, 4.461, 4.462, 4.461, 4.462,
    4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 2.231,
];

const Q1_3: [f64; 4] = [58.33, 27.78, 12.35, 1.54];
const Q1_5: [f64; 6] = [35.0, 26.0, 15.6, 11.01, 11.01, 1.38];
const Q1_7: [f64; 8] = [25.0, 21.43, 15.31, 10.93, 8.75, 8.74, 8.75, 1.09];
const Q1_10: [f64; 11] = [
    17.5, 16.5, 13.2, 10.56, 8.45, 6.76, 6.55, 6.55, 6.56, 6.55, 0.82,
];
const Q1_15: [f64; 16] = [
    8.75, 9.13, 8.21, 7.39, 6.65, 5.99, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 0.74,
];
const Q1_20: [f64; 21] = [
    6.563, 7.0, 6.482, 5.996, 5.546, 5.13, 4.746, 4.459, 4.459, 4.459, 4.459, 4.46, 4.459, 4.46,
    4.459, 4.46, 4.459, 4.46, 4.459, 4.46, 0.565,
];
const Q2_3: [f64; 4] = [41.67, 38.89, 14.14, 5.3];
const Q2_5: [f64; 6] = [25.0, 30.0, 18.0, 11.37, 11.37, 4.26];
const Q2_7: [f64; 8] = [17.85, 23.47, 16.76, 11.97, 8.87, 8.87, 8.87, 3.34];
const Q2_10: [f64; 11] = [
    12.5, 17.5, 14.0, 11.2, 8.96, 7.17, 6.55, 6.55, 6.56, 6.55, 2.46,
];
const Q2_15: [f64; 16] = [
    6.25, 9.38, 8.44, 7.59, 6.83, 6.15, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 2.21,
];
const Q2_20: [f64; 21] = [
    4.688, 7.148, 6.612, 6.116, 5.658, 5.233, 4.841, 4.478, 4.463, 4.463, 4.463, 4.463, 4.463,
    4.463, 4.462, 4.463, 4.462, 4.463, 4.462, 4.463, 1.673,
];
const Q3_3: [f64; 4] = [25.0, 50.0, 16.67, 8.33];
const Q3_5: [f64; 6] = [15.0, 34.0, 20.4, 12.24, 11.3, 7.06];
const Q3_7: [f64; 8] = [10.71, 25.51, 18.22, 13.02, 9.3, 8.85, 8.86, 5.53];
const Q3_10: [f64; 11] = [
    7.5, 18.5, 14.8, 11.84, 9.47, 7.58, 6.55, 6.55, 6.56, 6.55, 4.1,
];
const Q3_15: [f64; 16] = [
    3.75, 9.63, 8.66, 7.8, 7.02, 6.31, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 3.69,
];
const Q3_20: [f64; 21] = [
    2.813, 7.289, 6.742, 6.237, 5.769, 5.336, 4.936, 4.566, 4.46, 4.46, 4.46, 4.46, 4.461, 4.46,
    4.461, 4.46, 4.461, 4.46, 4.461, 4.46, 2.788,
];
const Q4_3: [f64; 4] = [8.33, 61.11, 20.37, 10.19];
const Q4_5: [f64; 6] = [5.0, 38.0, 22.8, 13.68, 10.94, 9.58];
const Q4_7: [f64; 8] = [3.57, 27.55, 19.68, 14.06, 10.04, 8.73, 8.73, 7.64];
const Q4_10: [f64; 11] = [
    2.5, 19.5, 15.6, 12.48, 9.98, 7.99, 6.55, 6.55, 6.56, 6.55, 5.74,
];
const Q4_15: [f64; 16] = [
    1.25, 9.88, 8.89, 8.0, 7.2, 6.48, 5.9, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.17,
];
const Q4_20: [f64; 21] = [
    0.938, 7.43, 6.872, 6.357, 5.88, 5.439, 5.031, 4.654, 4.458, 4.458, 4.458, 4.458, 4.458, 4.458,
    4.458, 4.458, 4.458, 4.459, 4.458, 4.459, 3.901,
];

/// `MACRS_HALF_YEAR[class]`: Table A-1; index 0 is the first recovery year.
#[allow(clippy::float_cmp)] // the classes are exact
pub fn macrs_half_year(class: f64) -> Option<&'static [f64]> {
    let tables: [&'static [f64]; 6] = [
        &HALF_YEAR_3,
        &HALF_YEAR_5,
        &HALF_YEAR_7,
        &HALF_YEAR_10,
        &HALF_YEAR_15,
        &HALF_YEAR_20,
    ];
    let index = MACRS_TABLE_CLASSES.iter().position(|c| *c == class)?;
    Some(tables[index])
}

/// `MACRS_MID_QUARTER[quarter][class]`: Tables A-2 to A-5.
#[allow(clippy::float_cmp)] // the classes are exact
pub fn macrs_mid_quarter(quarter: i64, class: f64) -> Option<&'static [f64]> {
    let row: [&'static [f64]; 6] = match quarter {
        1 => [&Q1_3, &Q1_5, &Q1_7, &Q1_10, &Q1_15, &Q1_20],
        2 => [&Q2_3, &Q2_5, &Q2_7, &Q2_10, &Q2_15, &Q2_20],
        3 => [&Q3_3, &Q3_5, &Q3_7, &Q3_10, &Q3_15, &Q3_20],
        4 => [&Q4_3, &Q4_5, &Q4_7, &Q4_10, &Q4_15, &Q4_20],
        _ => return None,
    };
    let index = MACRS_TABLE_CLASSES.iter().position(|c| *c == class)?;
    Some(row[index])
}

/// First-year percentage of 27.5-year property by month placed in service.
const RESIDENTIAL_FIRST_YEAR: [f64; 12] = [
    3.485, 3.182, 2.879, 2.576, 2.273, 1.97, 1.667, 1.364, 1.061, 0.758, 0.455, 0.152,
];

fn round3(value: f64) -> f64 {
    crate::js::math_round(value * 1000.0) / 1000.0
}

/// Table A-6: 27.5-year residential rental property, mid-month.
fn residential_rental_percentages(month: usize) -> Vec<f64> {
    let first = RESIDENTIAL_FIRST_YEAR[month - 1];
    let early = month <= 6;
    let mut rows = vec![first];
    for year in 2..=27 {
        if year <= 9 {
            rows.push(3.636);
        } else if year % 2 == 0 {
            rows.push(if early { 3.637 } else { 3.636 });
        } else {
            rows.push(if early { 3.636 } else { 3.637 });
        }
    }
    // `rows.reduce((sum, value) => sum + value, 0)`, left to right.
    let used = rows.iter().fold(0.0, |sum, value| sum + value);
    if early {
        rows.push(round3(100.0 - used));
        rows.push(0.0);
    } else {
        rows.push(3.636);
        rows.push(round3(100.0 - used - 3.636));
    }
    rows
}

const NONRESIDENTIAL_FIRST_YEAR: [f64; 12] = [
    2.461, 2.247, 2.033, 1.819, 1.605, 1.391, 1.177, 0.963, 0.749, 0.535, 0.321, 0.107,
];
const NONRESIDENTIAL_LAST_YEAR: [f64; 12] = [
    0.107, 0.321, 0.535, 0.749, 0.963, 1.177, 1.391, 1.605, 1.819, 2.033, 2.247, 2.461,
];

/// `macrsRealPropertyPercentages(recoveryYears, month)`: mid-month
/// percentages of real property by recovery year for the month (1 to 12) it
/// was placed in service; `None` for a month out of range.
pub fn macrs_real_property_percentages(recovery_years: f64, month: i64) -> Option<Vec<f64>> {
    let month = usize::try_from(month)
        .ok()
        .filter(|m| (1..=12).contains(m))?;
    #[allow(clippy::float_cmp)] // the classes are exact
    if recovery_years == 27.5 {
        return Some(residential_rental_percentages(month));
    }
    let mut rows = vec![NONRESIDENTIAL_FIRST_YEAR[month - 1]];
    rows.extend(std::iter::repeat_n(2.564, 38));
    rows.push(NONRESIDENTIAL_LAST_YEAR[month - 1]);
    Some(rows)
}

// ---------------------------------------------------------------------------
// Section 179

/// `Section179Parameters`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Section179Parameters {
    pub tax_year: i64,
    pub limit: f64,
    pub phase_out_threshold: f64,
    pub suv_cap: f64,
}

/// `SECTION_179_PARAMETERS`.
pub const SECTION_179_PARAMETERS: [Section179Parameters; 9] = [
    s179(2018, 1_000_000.0, 2_500_000.0, 25_000.0),
    s179(2019, 1_020_000.0, 2_550_000.0, 25_500.0),
    s179(2020, 1_040_000.0, 2_590_000.0, 25_900.0),
    s179(2021, 1_050_000.0, 2_620_000.0, 26_200.0),
    s179(2022, 1_080_000.0, 2_700_000.0, 27_000.0),
    s179(2023, 1_160_000.0, 2_890_000.0, 28_900.0),
    s179(2024, 1_220_000.0, 3_050_000.0, 30_500.0),
    s179(2025, 2_500_000.0, 4_000_000.0, 31_300.0),
    s179(2026, 2_560_000.0, 4_090_000.0, 32_000.0),
];

const fn s179(
    tax_year: i64,
    limit: f64,
    phase_out_threshold: f64,
    suv_cap: f64,
) -> Section179Parameters {
    Section179Parameters {
        tax_year,
        limit,
        phase_out_threshold,
        suv_cap,
    }
}

/// `section179Parameters(taxYear)`: years after the last known one use the
/// latest figures.
pub fn section_179_parameters(tax_year: i64) -> Option<Section179Parameters> {
    let first = SECTION_179_PARAMETERS[0];
    if tax_year < first.tax_year {
        return None;
    }
    SECTION_179_PARAMETERS
        .iter()
        .rev()
        .find(|row| row.tax_year <= tax_year)
        .copied()
}

/// `Section179Allowance`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Section179Allowance {
    pub parameters: Section179Parameters,
    pub dollar_limit: f64,
    pub phase_out_reduction: f64,
    pub allowable: f64,
}

/// `section179Allowance(taxYear, totalPlacedInService, businessIncomeLimit)`.
pub fn section_179_allowance(
    tax_year: i64,
    total_placed_in_service: f64,
    business_income_limit: Option<f64>,
) -> Option<Section179Allowance> {
    let parameters = section_179_parameters(tax_year)?;
    let phase_out_reduction = (total_placed_in_service - parameters.phase_out_threshold).max(0.0);
    let dollar_limit = (parameters.limit - phase_out_reduction).max(0.0);
    let allowable =
        business_income_limit.map_or(dollar_limit, |limit| dollar_limit.min(limit).max(0.0));
    Some(Section179Allowance {
        parameters,
        dollar_limit,
        phase_out_reduction,
        allowable,
    })
}

// ---------------------------------------------------------------------------
// Bonus depreciation

/// OBBBA: 100% bonus for property acquired after this date.
pub const OBBBA_BONUS_CUTOFF: &str = "2025-01-19";
/// The TCJA's 100% bonus started with property acquired after this date.
pub const TCJA_BONUS_START: &str = "2017-09-27";

/// `BonusDepreciation`: the percentage and the rule (`obbba_100`, `tcja_40`, …).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BonusDepreciation {
    pub percent: f64,
    pub rule: &'static str,
}

/// `bonusDepreciationPercent({ acquisitionDate, placedInServiceDate, reducedElection })`.
pub fn bonus_depreciation_percent(
    acquisition_date: &str,
    placed_in_service_date: &str,
    reduced_election: bool,
) -> BonusDepreciation {
    let bonus = |percent: f64, rule: &'static str| BonusDepreciation { percent, rule };
    if acquisition_date > OBBBA_BONUS_CUTOFF && placed_in_service_date > OBBBA_BONUS_CUTOFF {
        return if reduced_election {
            bonus(40.0, "obbba_reduced_election")
        } else {
            bonus(100.0, "obbba_100")
        };
    }
    if acquisition_date <= TCJA_BONUS_START {
        return bonus(0.0, "not_modeled");
    }
    // `Number(placedInServiceDate.slice(0, 4))`.
    let year = crate::js::js_number_value(Some(&serde_json::Value::String(
        placed_in_service_date.chars().take(4).collect(),
    )));
    if placed_in_service_date <= TCJA_BONUS_START {
        return bonus(0.0, "not_modeled");
    }
    if year <= 2022.0 {
        return bonus(100.0, "tcja_100");
    }
    #[allow(clippy::float_cmp)] // whole years
    {
        if year == 2023.0 {
            return bonus(80.0, "tcja_80");
        }
        if year == 2024.0 {
            return bonus(60.0, "tcja_60");
        }
        if year == 2025.0 {
            return bonus(40.0, "tcja_40");
        }
        if year == 2026.0 {
            return bonus(20.0, "tcja_20");
        }
    }
    bonus(0.0, "tcja_0")
}

/// `bonusEligible(recoveryYears)`: a GDS recovery period of 20 years or less,
/// or 25-year water utility property.
#[allow(clippy::float_cmp)] // the classes are exact
pub fn bonus_eligible(recovery_years: f64) -> bool {
    recovery_years <= 20.0 || recovery_years == 25.0
}

// ---------------------------------------------------------------------------
// De minimis safe harbor

/// `DE_MINIMIS_SAFE_HARBOR`: `(effectiveFrom, withoutAfs, withAfs)`.
const DE_MINIMIS_SAFE_HARBOR: [(&str, f64, f64); 1] = [("2016-01-01", 2_500.0, 5_000.0)];

/// `deMinimisThreshold(date, hasAfs)`.
pub fn de_minimis_threshold(date: &str, has_afs: bool) -> Option<f64> {
    let current = DE_MINIMIS_SAFE_HARBOR
        .iter()
        .rev()
        .find(|(from, _, _)| *from <= date)?;
    Some(if has_afs { current.2 } else { current.1 })
}

/// `deMinimisApplies(amount, date, hasAfs)`.
pub fn de_minimis_applies(amount: f64, date: &str, has_afs: bool) -> bool {
    de_minimis_threshold(date, has_afs).is_some_and(|threshold| amount <= threshold)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sum(rows: &[f64]) -> f64 {
        (rows.iter().sum::<f64>() * 1000.0).round() / 1000.0
    }

    #[test]
    fn every_table_row_sums_to_100() {
        for class in MACRS_TABLE_CLASSES {
            assert!((sum(macrs_half_year(class).expect("class")) - 100.0).abs() < 0.02);
            for quarter in 1..=4 {
                let rows = macrs_mid_quarter(quarter, class).expect("class");
                assert!((sum(rows) - 100.0).abs() < 0.02, "{quarter} {class}");
            }
        }
        for month in 1..=12 {
            for years in [27.5, 39.0] {
                let rows = macrs_real_property_percentages(years, month).expect("month");
                assert!((sum(&rows) - 100.0).abs() < 0.0015, "{years} {month}");
            }
        }
        assert!(macrs_real_property_percentages(39.0, 13).is_none());
    }

    #[test]
    fn bonus_follows_the_cutoffs() {
        assert_eq!(
            bonus_depreciation_percent("2025-01-20", "2025-02-01", false).percent,
            100.0
        );
        assert_eq!(
            bonus_depreciation_percent("2025-01-20", "2025-02-01", true).percent,
            40.0
        );
        assert_eq!(
            bonus_depreciation_percent("2025-01-10", "2025-02-01", false).percent,
            40.0
        );
        assert_eq!(
            bonus_depreciation_percent("2023-02-01", "2023-02-15", false).percent,
            80.0
        );
        assert_eq!(
            bonus_depreciation_percent("2017-09-01", "2018-02-15", false).rule,
            "not_modeled"
        );
        assert_eq!(
            bonus_depreciation_percent("2024-01-01", "2027-02-15", false).rule,
            "tcja_0"
        );
    }

    #[test]
    fn section_179_and_de_minimis() {
        assert_eq!(
            section_179_parameters(2024).map(|p| p.limit),
            Some(1_220_000.0)
        );
        assert_eq!(section_179_parameters(2030).map(|p| p.tax_year), Some(2026));
        assert!(section_179_parameters(2017).is_none());
        let allowance = section_179_allowance(2024, 3_100_000.0, None).expect("year");
        assert_eq!(allowance.phase_out_reduction, 50_000.0);
        assert_eq!(allowance.dollar_limit, 1_170_000.0);
        assert_eq!(de_minimis_threshold("2026-05-01", true), Some(5_000.0));
        assert_eq!(de_minimis_threshold("2015-05-01", true), None);
        assert!(de_minimis_applies(2_500.0, "2026-05-01", false));
        assert!(!de_minimis_applies(2_600.0, "2026-05-01", false));
    }
}
