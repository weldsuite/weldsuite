//! Federal income tax withholding (`us/withholding.ts`): Publication 15-T
//! worksheet 1A and supplemental wages.

use crate::money::{Cents, js_max, js_min, round_half_away_from_zero};
use crate::types::{FilingStatus, UsW4Input};
use crate::us::federal_rules::{FederalRules, WithholdingRow};

/// `nominalPeriodsPerYear(periodsPerYear)`.
pub fn nominal_periods_per_year(periods_per_year: f64) -> f64 {
    if periods_per_year == 53.0 {
        52.0
    } else if periods_per_year == 27.0 {
        26.0
    } else {
        periods_per_year
    }
}

/// `annualScheduleTax(adjustedAnnualCents, rows)`.
pub fn annual_schedule_tax(adjusted_annual_cents: f64, rows: &[WithholdingRow]) -> f64 {
    if adjusted_annual_cents <= 0.0 {
        return 0.0;
    }
    let mut found: Option<&WithholdingRow> = None;
    for r in rows {
        if adjusted_annual_cents >= r.at_least_cents {
            found = Some(r);
        } else {
            break;
        }
    }
    match found {
        Some(m) => {
            m.base_cents + ((adjusted_annual_cents - m.at_least_cents) * m.rate_percent) / 100.0
        }
        None => 0.0,
    }
}

/// `effectiveW4(w4)`: a missing W-4 is a 2026 single one.
pub fn effective_w4(w4: Option<&UsW4Input>) -> UsW4Input {
    w4.cloned().unwrap_or(UsW4Input {
        form_year: 2026,
        filing_status: FilingStatus::Single,
        multiple_jobs: false,
        dependents_amount: 0.0,
        other_income: 0.0,
        deductions: 0.0,
        extra_withholding: 0.0,
        exempt: false,
        allowances: None,
        nonresident_alien: false,
    })
}

/// `isPre2020W4(w4)`.
pub fn is_pre2020_w4(w4: &UsW4Input) -> bool {
    w4.form_year < 2020
}

fn dollars_to_cents(n: f64) -> Cents {
    if n.is_finite() {
        round_half_away_from_zero(n * 100.0)
    } else {
        0.0
    }
}

/// `nraAdditionCents(rules, w4, periodsPerYear)`.
pub fn nra_addition_cents(rules: &FederalRules, w4: &UsW4Input, periods_per_year: f64) -> Cents {
    if !w4.nonresident_alien {
        return 0.0;
    }
    let table = if is_pre2020_w4(w4) {
        &rules.withholding.nra_addition_pre2020
    } else {
        &rules.withholding.nra_addition2020
    };
    let periods = nominal_periods_per_year(periods_per_year);
    if let Some(per_period) = table.get(&crate::js::number_text(periods)) {
        return *per_period;
    }
    round_half_away_from_zero(table.get("1").copied().unwrap_or(f64::NAN) / periods)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WithholdingWorksheet {
    pub annual_wages_cents: f64,
    pub adjusted_annual_wage_cents: f64,
    pub tentative_annual_cents: f64,
    pub credits_per_period_cents: f64,
    pub extra_cents: Cents,
    pub withholding_cents: Cents,
}

/// `worksheet1A(rules, w4, wagesCents, periodsPerYear)`.
pub fn worksheet_1a(
    rules: &FederalRules,
    w4: &UsW4Input,
    wages_cents: Cents,
    periods_per_year: f64,
) -> WithholdingWorksheet {
    let periods = nominal_periods_per_year(periods_per_year);
    let line1c = js_max(0.0, wages_cents) * periods;
    let adjusted;
    let schedule: &[WithholdingRow];
    let mut credits = 0.0;
    if is_pre2020_w4(w4) {
        let allowances = js_max(0.0, w4.allowances.unwrap_or(0.0).trunc());
        adjusted = js_max(0.0, line1c - allowances * rules.withholding.allowance_cents);
        let status = if w4.filing_status == FilingStatus::MarriedJointly {
            FilingStatus::MarriedJointly
        } else {
            FilingStatus::Single
        };
        schedule = rules.withholding.standard.get(status);
    } else {
        let line1e = line1c + dollars_to_cents(w4.other_income);
        let line1g = if w4.multiple_jobs {
            0.0
        } else if w4.filing_status == FilingStatus::MarriedJointly {
            rules.withholding.line1g_married_jointly_cents
        } else {
            rules.withholding.line1g_other_cents
        };
        let line1h = dollars_to_cents(w4.deductions) + line1g;
        adjusted = js_max(0.0, line1e - line1h);
        let table = if w4.multiple_jobs {
            &rules.withholding.step2_checked
        } else {
            &rules.withholding.standard
        };
        schedule = table.get(w4.filing_status);
        credits = dollars_to_cents(w4.dependents_amount);
    }
    let line2g = annual_schedule_tax(adjusted, schedule);
    let line2h = line2g / periods;
    let line3b = js_max(0.0, credits) / periods;
    let line3c = js_max(0.0, line2h - line3b);
    let extra = js_max(0.0, dollars_to_cents(w4.extra_withholding));
    WithholdingWorksheet {
        annual_wages_cents: line1c,
        adjusted_annual_wage_cents: adjusted,
        tentative_annual_cents: line2g,
        credits_per_period_cents: line3b,
        extra_cents: extra,
        withholding_cents: round_half_away_from_zero(line3c) + extra,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupplementalMethod {
    Flat,
    Aggregate,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SupplementalWithholding {
    pub flat_cents: Cents,
    pub mandatory_cents: Cents,
    pub aggregate_cents: Cents,
    pub method: SupplementalMethod,
}

pub struct SupplementalArgs<'a> {
    pub rules: &'a FederalRules,
    pub w4: &'a UsW4Input,
    pub supplemental_cents: Cents,
    pub ytd_supplemental_cents: Cents,
    pub regular_wages_cents: Cents,
    pub nra_addition_cents: Cents,
    pub periods_per_year: f64,
    pub regular_withheld_this_year_cents: Cents,
}

/// `supplementalWithholding(args)`.
pub fn supplemental_withholding(args: &SupplementalArgs<'_>) -> SupplementalWithholding {
    let rules = args.rules;
    let w4 = args.w4;
    let supplemental = args.supplemental_cents;
    let none = |mandatory: f64, method| SupplementalWithholding {
        flat_cents: 0.0,
        mandatory_cents: mandatory,
        aggregate_cents: 0.0,
        method,
    };
    if supplemental <= 0.0 {
        return none(0.0, SupplementalMethod::None);
    }
    let threshold = rules.supplemental.mandatory_threshold_cents;
    let before = js_max(0.0, args.ytd_supplemental_cents);
    let over_threshold = js_max(0.0, js_min(supplemental, before + supplemental - threshold));
    let under_threshold = supplemental - over_threshold;
    let mandatory = round_half_away_from_zero(
        (over_threshold * rules.supplemental.mandatory_rate_percent) / 100.0,
    );
    if under_threshold <= 0.0 {
        return none(mandatory, SupplementalMethod::Flat);
    }
    if w4.exempt {
        return none(mandatory, SupplementalMethod::None);
    }
    if args.regular_withheld_this_year_cents > 0.0 {
        return SupplementalWithholding {
            flat_cents: round_half_away_from_zero(
                (under_threshold * rules.supplemental.flat_rate_percent) / 100.0,
            ),
            mandatory_cents: mandatory,
            aggregate_cents: 0.0,
            method: SupplementalMethod::Flat,
        };
    }
    let no_extra = UsW4Input {
        extra_withholding: 0.0,
        ..w4.clone()
    };
    let regular_base = args.regular_wages_cents + args.nra_addition_cents;
    let combined = worksheet_1a(
        rules,
        &no_extra,
        regular_base + under_threshold,
        args.periods_per_year,
    )
    .withholding_cents;
    let alone =
        worksheet_1a(rules, &no_extra, regular_base, args.periods_per_year).withholding_cents;
    SupplementalWithholding {
        flat_cents: 0.0,
        mandatory_cents: mandatory,
        aggregate_cents: js_max(0.0, combined - alone),
        method: SupplementalMethod::Aggregate,
    }
}
