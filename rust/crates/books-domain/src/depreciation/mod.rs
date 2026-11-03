//! Fixed asset depreciation for the book, federal and state books
//! (`@weldsuite/books-domain/us-compliance/depreciation`).
//!
//! Book methods: straight line (with salvage value) and declining balance,
//! with a full-month, mid-month or half-year convention. Tax methods: MACRS
//! GDS (the Publication 946 tables, or straight line), MACRS ADS, section 179
//! and bonus depreciation. The tables and the yearly figures are in
//! [`tables`].
//!
//! Time model: each fiscal period counts as 12 "months" on an axis; an asset
//! is in service from the point its convention puts it for its life, and the
//! depreciation of a year is the part of that interval inside it. Amounts are
//! JavaScript numbers, rounded to cents the way the TypeScript does.

pub mod tables;

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::dates::{add_days, add_months, diff_days, end_of_month, is_iso_date, parse_iso};
use crate::js::{math_round, number_text, number_value};
pub use tables::{
    BonusDepreciation, Section179Allowance, Section179Parameters, bonus_depreciation_percent,
    bonus_eligible, de_minimis_applies, de_minimis_threshold, section_179_allowance,
    section_179_parameters,
};

/// `FiscalPeriod`: a fiscal year as a depreciation period.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FiscalPeriod {
    pub label: String,
    /// First day, `YYYY-MM-DD`.
    pub start: String,
    /// Last day, inclusive.
    pub end: String,
}

/// `DepreciationAsset`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DepreciationAsset {
    pub cost: f64,
    pub salvage_value: Option<f64>,
    /// 0 to 100; `None` is 100.
    pub business_use_percent: Option<f64>,
    pub acquisition_date: String,
    pub placed_in_service_date: String,
    pub disposal_date: Option<String>,
    pub listed_property: bool,
}

/// `DepreciationBook`. Methods (`straight_line`, `declining_balance`,
/// `macrs_gds`, `macrs_ads`, `expensed`, `none`) and conventions
/// (`half_year`, `mid_quarter`, `mid_month`, `full_month`) are the stored
/// strings.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DepreciationBook {
    pub method: String,
    pub convention: String,
    pub recovery_years: f64,
    pub section_179_amount: Option<f64>,
    pub bonus_percent: Option<f64>,
    /// 2 (200%, the default) or 1.5.
    pub declining_balance_factor: Option<f64>,
    pub straight_line: bool,
    pub ads_recovery_years: Option<f64>,
}

/// `DepreciationIssue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepreciationIssue {
    /// `error` or `warning`.
    pub severity: &'static str,
    pub code: &'static str,
    pub message: String,
}

impl DepreciationIssue {
    pub fn json(&self) -> Value {
        json!({ "severity": self.severity, "code": self.code, "message": self.message })
    }
}

fn warning(code: &'static str, message: impl Into<String>) -> DepreciationIssue {
    DepreciationIssue {
        severity: "warning",
        code,
        message: message.into(),
    }
}

/// `DepreciationBasis`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct DepreciationBasis {
    pub cost: f64,
    pub business_use_percent: f64,
    pub base_cost: f64,
    pub salvage: f64,
    pub section179: f64,
    pub bonus: f64,
    pub depreciable_basis: f64,
    pub total_depreciable: f64,
}

impl DepreciationBasis {
    pub fn json(&self) -> Value {
        json!({
            "cost": number_value(self.cost),
            "businessUsePercent": number_value(self.business_use_percent),
            "baseCost": number_value(self.base_cost),
            "salvage": number_value(self.salvage),
            "section179": number_value(self.section179),
            "bonus": number_value(self.bonus),
            "depreciableBasis": number_value(self.depreciable_basis),
            "totalDepreciable": number_value(self.total_depreciable),
        })
    }
}

/// `DepreciationRow`: one fiscal year of a schedule.
#[derive(Debug, Clone, PartialEq)]
pub struct DepreciationRow {
    pub label: String,
    pub period_start: String,
    pub period_end: String,
    pub amount: f64,
    pub regular: f64,
    pub section179: f64,
    pub bonus: f64,
    pub accumulated: f64,
    pub remaining: f64,
}

impl DepreciationRow {
    pub fn json(&self) -> Value {
        json!({
            "label": self.label,
            "periodStart": self.period_start,
            "periodEnd": self.period_end,
            "amount": number_value(self.amount),
            "regular": number_value(self.regular),
            "section179": number_value(self.section179),
            "bonus": number_value(self.bonus),
            "accumulated": number_value(self.accumulated),
            "remaining": number_value(self.remaining),
        })
    }
}

/// `DepreciationSchedule`.
#[derive(Debug, Clone, PartialEq)]
pub struct DepreciationSchedule {
    pub method: String,
    pub convention: String,
    pub recovery_years: f64,
    pub basis: DepreciationBasis,
    pub rows: Vec<DepreciationRow>,
    pub issues: Vec<DepreciationIssue>,
}

/// `MonthlyDepreciationRow`.
#[derive(Debug, Clone, PartialEq)]
pub struct MonthlyRow {
    /// `YYYY-MM`.
    pub label: String,
    pub period_start: String,
    pub period_end: String,
    pub amount: f64,
    pub accumulated: f64,
    pub remaining: f64,
}

/// `MonthlySchedule`.
#[derive(Debug, Clone, PartialEq)]
pub struct MonthlySchedule {
    pub method: String,
    pub convention: String,
    pub basis: DepreciationBasis,
    pub rows: Vec<MonthlyRow>,
    pub issues: Vec<DepreciationIssue>,
}

// ---------------------------------------------------------------------------
// The axis

fn month_aligned(period: &FiscalPeriod) -> bool {
    let (Some(start), Some(end)) = (parse_iso(&period.start), parse_iso(&period.end)) else {
        return false;
    };
    if start.d != 1 || end_of_month(&period.end).as_deref() != Some(period.end.as_str()) {
        return false;
    }
    end.y * 12 + end.m - (start.y * 12 + start.m) + 1 == 12
}

#[derive(Debug, Clone, Copy)]
struct Position {
    index: usize,
    /// 0 to 11 within the year.
    month: i64,
    /// 1 to 4.
    quarter: i64,
}

struct Axis<'a> {
    periods: &'a [FiscalPeriod],
    aligned: Vec<bool>,
}

impl<'a> Axis<'a> {
    fn new(periods: &'a [FiscalPeriod]) -> Self {
        Self {
            periods,
            aligned: periods.iter().map(month_aligned).collect(),
        }
    }

    fn all_aligned(&self) -> bool {
        self.aligned.iter().all(|a| *a)
    }

    fn valid(&self) -> bool {
        for (i, p) in self.periods.iter().enumerate() {
            if !is_iso_date(&p.start) || !is_iso_date(&p.end) || p.end < p.start {
                return false;
            }
            if i > 0 && p.start <= self.periods[i - 1].end {
                return false;
            }
        }
        !self.periods.is_empty()
    }

    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    fn locate(&self, date: &str) -> Option<Position> {
        let index = self
            .periods
            .iter()
            .position(|p| date >= p.start.as_str() && date <= p.end.as_str())?;
        let period = &self.periods[index];
        let month = if self.aligned[index] {
            let s = parse_iso(&period.start)?;
            let d = parse_iso(date)?;
            d.y * 12 + d.m - (s.y * 12 + s.m)
        } else {
            let total = diff_days(&period.start, &period.end)? + 1;
            let offset = diff_days(&period.start, date)?;
            let raw = ((offset as f64 / total as f64) * 12.0).floor();
            (raw.min(11.0)) as i64
        };
        Some(Position {
            index,
            month,
            quarter: month.div_euclid(3) + 1,
        })
    }
}

/// The point on the axis (in months) where a convention counts an event.
#[allow(clippy::cast_precision_loss)]
fn anchor(convention: &str, position: Position) -> f64 {
    let base = 12.0 * position.index as f64;
    match convention {
        "half_year" => base + 6.0,
        "mid_quarter" => base + 3.0 * (position.quarter - 1) as f64 + 1.5,
        "mid_month" => base + position.month as f64 + 0.5,
        "full_month" => base + position.month as f64,
        _ => f64::NAN,
    }
}

fn overlap(a1: f64, a2: f64, b1: f64, b2: f64) -> f64 {
    (a2.min(b2) - a1.max(b1)).max(0.0)
}

/// `round2(value)`: cents, nudged away from zero so 0.005 rounds up.
pub fn round2(value: f64) -> f64 {
    math_round(value * 100.0 + if value >= 0.0 { 1e-9 } else { -1e-9 }) / 100.0
}

/// `toLocaleString('en-US')` of a number: grouped thousands, at most three
/// decimals.
pub fn en_us(value: f64) -> String {
    if !value.is_finite() {
        return number_text(value);
    }
    let fixed = crate::js::to_fixed(value, 3);
    let (negative, fixed) = fixed
        .strip_prefix('-')
        .map_or((false, fixed.as_str()), |rest| (true, rest));
    let (whole, fraction) = fixed.split_once('.').unwrap_or((fixed, ""));
    let fraction = fraction.trim_end_matches('0');
    let mut grouped = String::new();
    for (i, ch) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let mut out = String::new();
    if negative && (whole != "0" || !fraction.is_empty()) {
        out.push('-');
    }
    out.push_str(&grouped);
    if !fraction.is_empty() {
        out.push('.');
        out.push_str(fraction);
    }
    out
}

// ---------------------------------------------------------------------------
// Rules

#[allow(clippy::float_cmp)] // the classes are exact
fn real_property_gds(years: f64) -> bool {
    years == 27.5 || years == 39.0
}

#[allow(clippy::float_cmp)] // the classes are exact
fn real_property_ads(years: f64) -> bool {
    [27.5, 30.0, 31.5, 39.0, 40.0].contains(&years)
}

fn is_macrs(method: &str) -> bool {
    method == "macrs_gds" || method == "macrs_ads"
}

/// `requiresAds(asset)`: listed property used 50% or less for business.
pub fn requires_ads(listed_property: bool, business_use_percent: Option<f64>) -> bool {
    listed_property && business_use_percent.unwrap_or(100.0) <= 50.0
}

#[derive(Debug, Clone)]
struct Effective {
    method: String,
    convention: String,
    recovery_years: f64,
    section179: f64,
    bonus_percent: f64,
    factor: f64,
    straight_line: bool,
}

#[allow(clippy::too_many_lines)] // the rules, in the order TypeScript applies them
fn resolve_book(
    asset: &DepreciationAsset,
    book: &DepreciationBook,
    issues: &mut Vec<DepreciationIssue>,
) -> Effective {
    let mut method = book.method.clone();
    let mut recovery_years = book.recovery_years;
    let mut section179 = book.section_179_amount.unwrap_or(0.0);
    let mut bonus_percent = book.bonus_percent.unwrap_or(0.0);
    let mut convention = book.convention.clone();
    let business_use = asset.business_use_percent.unwrap_or(100.0);

    let macrs = is_macrs(&method);
    if macrs && requires_ads(asset.listed_property, asset.business_use_percent) {
        if method == "macrs_gds" {
            "macrs_ads".clone_into(&mut method);
            if let Some(ads) = book.ads_recovery_years {
                recovery_years = ads;
            } else {
                issues.push(warning(
                    "ads_life_assumed",
                    "Listed property used 50% or less for business must use ADS; no ADS life was given, so the GDS class is used",
                ));
            }
            issues.push(warning(
                "ads_required",
                "Listed property used 50% or less for business must use ADS",
            ));
        }
        if section179 > 0.0 {
            issues.push(warning(
                "section_179_not_allowed",
                "Section 179 is not allowed on property used 50% or less for business",
            ));
            section179 = 0.0;
        }
        if bonus_percent > 0.0 {
            issues.push(warning(
                "bonus_not_allowed",
                "Bonus depreciation is not allowed on property that must use ADS",
            ));
            bonus_percent = 0.0;
        }
    } else if macrs && section179 > 0.0 && business_use <= 50.0 {
        issues.push(warning(
            "section_179_not_allowed",
            "Section 179 needs more than 50% business use",
        ));
        section179 = 0.0;
    }
    if !macrs {
        if section179 > 0.0 {
            issues.push(warning(
                "section_179_not_allowed",
                "Section 179 and bonus depreciation only apply to MACRS books",
            ));
        }
        if bonus_percent > 0.0 {
            issues.push(warning(
                "bonus_not_allowed",
                "Section 179 and bonus depreciation only apply to MACRS books",
            ));
        }
        section179 = 0.0;
        bonus_percent = 0.0;
    } else if method == "macrs_gds" && bonus_percent > 0.0 && !bonus_eligible(recovery_years) {
        issues.push(warning(
            "bonus_not_allowed",
            format!(
                "Property with a {}-year recovery period does not qualify for bonus depreciation",
                number_text(recovery_years)
            ),
        ));
        bonus_percent = 0.0;
    }

    if method == "macrs_gds" || method == "macrs_ads" {
        let real = if method == "macrs_gds" {
            real_property_gds(recovery_years)
        } else {
            real_property_ads(recovery_years)
        };
        let wanted = if real {
            "mid_month"
        } else if convention == "mid_quarter" {
            "mid_quarter"
        } else {
            "half_year"
        };
        if convention != wanted {
            let what = if method == "macrs_gds" {
                format!("{}-year MACRS property", number_text(recovery_years))
            } else {
                format!("ADS {}-year property", number_text(recovery_years))
            };
            issues.push(warning(
                "convention_changed",
                format!(
                    "{what} uses the {} convention",
                    wanted.replacen('_', "-", 1)
                ),
            ));
            wanted.clone_into(&mut convention);
        }
    }

    Effective {
        method,
        convention,
        recovery_years,
        section179,
        bonus_percent,
        factor: book.declining_balance_factor.unwrap_or(2.0),
        straight_line: book.straight_line,
    }
}

/// `depreciationBasis(asset, book)`: what is spread over the years and what
/// is deducted at once.
pub fn depreciation_basis(asset: &DepreciationAsset, book: &DepreciationBook) -> DepreciationBasis {
    basis_of(asset, &resolve_book(asset, book, &mut Vec::new()), book)
}

fn basis_of(
    asset: &DepreciationAsset,
    effective: &Effective,
    book: &DepreciationBook,
) -> DepreciationBasis {
    let business_use_percent = asset.business_use_percent.unwrap_or(100.0);
    let base_cost = round2((asset.cost * business_use_percent) / 100.0);
    if !is_macrs(&effective.method) {
        let salvage = if book.method == "straight_line" || book.method == "declining_balance" {
            base_cost.min(round2(asset.salvage_value.unwrap_or(0.0)))
        } else {
            0.0
        };
        let depreciable_basis = round2(base_cost - salvage);
        return DepreciationBasis {
            cost: asset.cost,
            business_use_percent,
            base_cost,
            salvage,
            section179: 0.0,
            bonus: 0.0,
            depreciable_basis,
            total_depreciable: depreciable_basis,
        };
    }
    let section179 = round2(effective.section179.min(base_cost));
    let bonus = round2(((base_cost - section179) * effective.bonus_percent) / 100.0);
    let depreciable_basis = round2(base_cost - section179 - bonus);
    DepreciationBasis {
        cost: asset.cost,
        business_use_percent,
        base_cost,
        salvage: 0.0,
        section179,
        bonus,
        depreciable_basis,
        total_depreciable: base_cost,
    }
}

// ---------------------------------------------------------------------------
// The engine

struct Plan<'a> {
    axis: Axis<'a>,
    effective: Effective,
    basis: DepreciationBasis,
    pis: Position,
    start: f64,
    life_end: f64,
    end: f64,
    disposal_index: Option<usize>,
    disposal_point: Option<f64>,
}

fn table_percentages(effective: &Effective, pis: Position) -> Option<Vec<f64>> {
    if effective.method != "macrs_gds" || effective.straight_line {
        return None;
    }
    let years = effective.recovery_years;
    if real_property_gds(years) {
        return tables::macrs_real_property_percentages(years, pis.month + 1);
    }
    if !tables::MACRS_TABLE_CLASSES.contains(&years) {
        return None;
    }
    if effective.convention == "mid_quarter" {
        tables::macrs_mid_quarter(pis.quarter, years).map(<[f64]>::to_vec)
    } else {
        tables::macrs_half_year(years).map(<[f64]>::to_vec)
    }
}

#[allow(clippy::float_cmp)] // the classes are exact
fn gds_supported(years: f64) -> bool {
    [3.0, 5.0, 7.0, 10.0, 15.0, 20.0, 25.0, 27.5, 39.0].contains(&years)
}

#[allow(clippy::too_many_lines)] // the checks, in the order TypeScript makes them
fn make_plan<'a>(
    asset: &DepreciationAsset,
    book: &DepreciationBook,
    periods: &'a [FiscalPeriod],
    issues: &mut Vec<DepreciationIssue>,
) -> Option<Plan<'a>> {
    let mut error = |code: &'static str, message: String| {
        issues.push(DepreciationIssue {
            severity: "error",
            code,
            message,
        });
    };
    if !asset.cost.is_finite() || asset.cost <= 0.0 {
        error(
            "invalid_amount",
            "The cost must be greater than zero".to_owned(),
        );
        return None;
    }
    let business_use = asset.business_use_percent.unwrap_or(100.0);
    if !business_use.is_finite() || !(0.0..=100.0).contains(&business_use) {
        error(
            "invalid_amount",
            "Business use is 0 to 100 percent".to_owned(),
        );
        return None;
    }
    if asset.salvage_value.unwrap_or(0.0) < 0.0 {
        error(
            "invalid_amount",
            "Salvage value cannot be negative".to_owned(),
        );
        return None;
    }
    if !is_iso_date(&asset.placed_in_service_date)
        || !is_iso_date(&asset.acquisition_date)
        || asset
            .disposal_date
            .as_deref()
            .is_some_and(|d| !is_iso_date(d))
    {
        error("invalid_dates", "Dates must be YYYY-MM-DD".to_owned());
        return None;
    }
    let axis = Axis::new(periods);
    if !axis.valid() {
        error(
            "invalid_periods",
            "Fiscal periods must be valid, in order and not overlap".to_owned(),
        );
        return None;
    }
    let needs_life = book.method != "expensed" && book.method != "none";
    if needs_life && book.recovery_years.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        error(
            "unsupported_recovery_period",
            "The recovery period must be greater than zero".to_owned(),
        );
        return None;
    }

    let mut effective = resolve_book(asset, book, issues);
    if effective.method == "macrs_gds" && !gds_supported(effective.recovery_years) {
        issues.push(DepreciationIssue {
            severity: "error",
            code: "unsupported_recovery_period",
            message: format!(
                "{}-year property has no GDS table here",
                number_text(effective.recovery_years)
            ),
        });
        return None;
    }

    let Some(pis) = axis.locate(&asset.placed_in_service_date) else {
        issues.push(DepreciationIssue {
            severity: "error",
            code: "placed_in_service_outside_periods",
            message: "The fiscal periods do not include the placed-in-service date".to_owned(),
        });
        return None;
    };
    if effective.section179 > 0.0
        && let Some(limit) = parse_iso(&periods[pis.index].start)
            .and_then(|start| section_179_parameters(start.y))
            .map(|p| p.limit)
        && effective.section179 > limit
    {
        issues.push(warning(
            "section_179_reduced",
            format!("Section 179 is limited to {} for the year", en_us(limit)),
        ));
        effective.section179 = limit;
    }
    let basis = basis_of(asset, &effective, book);
    let start = anchor(&effective.convention, pis);
    let life_end = start
        + 12.0
            * if needs_life {
                effective.recovery_years
            } else {
                0.0
            };

    let mut disposal_index = None;
    let mut disposal_point = None;
    if let Some(disposal) = asset.disposal_date.as_deref().filter(|d| !d.is_empty()) {
        if disposal < asset.placed_in_service_date.as_str() {
            issues.push(DepreciationIssue {
                severity: "error",
                code: "disposal_before_service",
                message: "The asset was disposed of before it was placed in service".to_owned(),
            });
            return None;
        }
        if let Some(at) = axis.locate(disposal) {
            disposal_index = Some(at.index);
            disposal_point = Some(anchor(&effective.convention, at));
        }
    }
    let end = disposal_point.map_or(life_end, |point| life_end.min(point));
    Some(Plan {
        axis,
        effective,
        basis,
        pis,
        start,
        life_end,
        end,
        disposal_index,
        disposal_point,
    })
}

/// Exact (unrounded) regular depreciation per fiscal period.
#[allow(clippy::cast_precision_loss)]
fn exact_amounts(plan: &Plan<'_>, salvage_for_db: f64) -> Vec<f64> {
    let count = plan.axis.periods.len();
    let mut amounts = vec![0.0; count];
    let effective = &plan.effective;
    let basis = &plan.basis;
    let pis = plan.pis;
    let life = effective.recovery_years;

    if effective.method == "none" {
        return amounts;
    }
    if effective.method == "expensed" {
        amounts[pis.index] = basis.depreciable_basis;
        return amounts;
    }

    if let Some(table) = table_percentages(effective, pis) {
        for (i, amount) in amounts.iter_mut().enumerate().skip(pis.index) {
            let percent = table.get(i - pis.index).copied().unwrap_or(0.0);
            let mut exact = (basis.depreciable_basis * percent) / 100.0;
            if let (Some(index), Some(point)) = (plan.disposal_index, plan.disposal_point) {
                if i > index {
                    exact = 0.0;
                } else if i == index {
                    exact = if i == pis.index {
                        0.0
                    } else {
                        (exact * (point - 12.0 * i as f64)) / 12.0
                    };
                }
            }
            *amount = exact;
        }
        return amounts;
    }

    if effective.method == "declining_balance" {
        let rate = effective.factor / life;
        let mut accumulated = 0.0;
        for (i, amount) in amounts.iter_mut().enumerate().skip(pis.index) {
            let year_start = 12.0 * i as f64;
            let weight = overlap(year_start, year_start + 12.0, plan.start, plan.end);
            if weight == 0.0 {
                if year_start > plan.end {
                    break;
                }
                continue;
            }
            let nbv = basis.base_cost - accumulated;
            let remaining_years = (plan.life_end - plan.start.max(year_start)) / 12.0;
            let db = nbv * rate * (weight / 12.0);
            let sl = ((nbv - salvage_for_db) / remaining_years) * (weight / 12.0);
            let value = db.max(sl).min(nbv - salvage_for_db);
            *amount = value.max(0.0);
            accumulated += *amount;
        }
        return amounts;
    }

    // Straight line: book, ADS, and GDS straight line.
    let per_month = basis.depreciable_basis / (12.0 * life);
    for (i, amount) in amounts.iter_mut().enumerate().skip(pis.index) {
        let year_start = 12.0 * i as f64;
        *amount = per_month * overlap(year_start, year_start + 12.0, plan.start, plan.end);
    }
    amounts
}

#[allow(clippy::cast_precision_loss)]
fn complete(plan: &Plan<'_>) -> bool {
    plan.disposal_index.is_none() && plan.life_end <= 12.0 * plan.axis.periods.len() as f64 + 1e-9
}

/// `depreciationSchedule(asset, book, periods)`: the deduction per fiscal
/// period over the asset's life; section 179 and bonus in the first row; the
/// last row closes the schedule to the cent.
pub fn depreciation_schedule(
    asset: &DepreciationAsset,
    book: &DepreciationBook,
    periods: &[FiscalPeriod],
) -> DepreciationSchedule {
    let mut issues = Vec::new();
    let Some(plan) = make_plan(asset, book, periods, &mut issues) else {
        let business_use = asset.business_use_percent.unwrap_or(100.0);
        let base_cost = round2((asset.cost * business_use) / 100.0);
        return DepreciationSchedule {
            method: book.method.clone(),
            convention: book.convention.clone(),
            recovery_years: book.recovery_years,
            basis: DepreciationBasis {
                cost: asset.cost,
                business_use_percent: business_use,
                base_cost,
                ..DepreciationBasis::default()
            },
            rows: Vec::new(),
            issues,
        };
    };
    let exact = exact_amounts(&plan, plan.basis.salvage);
    let basis = plan.basis;
    let pis = plan.pis;
    let none = plan.effective.method == "none";

    let mut last = pis.index;
    for (i, value) in exact.iter().enumerate() {
        if *value > 1e-9 {
            last = last.max(i);
        }
    }
    let complete = complete(&plan);
    let mut rows = Vec::new();
    let mut cumulative_exact = 0.0;
    let mut accumulated = 0.0;
    for (i, exact) in exact.iter().enumerate().take(last + 1).skip(pis.index) {
        let first = i == pis.index;
        let section179 = if first { basis.section179 } else { 0.0 };
        let bonus = if first { basis.bonus } else { 0.0 };
        cumulative_exact += exact + section179 + bonus;
        let reached_end = i == last && complete && !none;
        let cumulative = round2(if reached_end {
            basis.total_depreciable
        } else {
            cumulative_exact
        });
        let amount = round2(cumulative - accumulated);
        accumulated = round2(accumulated + amount);
        let period = &plan.axis.periods[i];
        rows.push(DepreciationRow {
            label: period.label.clone(),
            period_start: period.start.clone(),
            period_end: period.end.clone(),
            amount,
            regular: round2(amount - section179 - bonus),
            section179,
            bonus,
            accumulated,
            remaining: round2(basis.total_depreciable - accumulated),
        });
    }
    if none {
        rows.clear();
    }
    if !none && plan.disposal_index.is_none() && !complete {
        issues.push(warning(
            "periods_end_before_fully_depreciated",
            "The fiscal periods end before the asset is fully depreciated; add more years",
        ));
    }
    DepreciationSchedule {
        method: plan.effective.method.clone(),
        convention: plan.effective.convention.clone(),
        recovery_years: plan.effective.recovery_years,
        basis,
        rows,
        issues,
    }
}

/// `monthlySchedule(asset, book, periods)`: the same depreciation by calendar
/// month, for the book that posts to the ledger.
#[allow(clippy::cast_precision_loss)]
pub fn monthly_schedule(
    asset: &DepreciationAsset,
    book: &DepreciationBook,
    periods: &[FiscalPeriod],
) -> MonthlySchedule {
    let empty = |issues: Vec<DepreciationIssue>| MonthlySchedule {
        method: book.method.clone(),
        convention: book.convention.clone(),
        basis: depreciation_basis(asset, book),
        rows: Vec::new(),
        issues,
    };
    let axis = Axis::new(periods);
    if axis.valid() && !axis.all_aligned() {
        return empty(vec![DepreciationIssue {
            severity: "error",
            code: "monthly_requires_month_periods",
            message: "Monthly depreciation needs fiscal years made of whole calendar months"
                .to_owned(),
        }]);
    }
    let mut issues = Vec::new();
    let Some(plan) = make_plan(asset, book, periods, &mut issues) else {
        return empty(issues);
    };
    let exact = exact_amounts(&plan, plan.basis.salvage);
    let basis = plan.basis;
    let pis = plan.pis;

    // (period index, month, exact amount)
    let mut months: Vec<(usize, i64, f64)> = Vec::new();
    for (i, year_amount) in exact.iter().enumerate().skip(pis.index) {
        let weights: Vec<f64> = (0..12)
            .map(|j| {
                let at = 12.0 * i as f64 + f64::from(j);
                overlap(at, at + 1.0, plan.start, plan.end)
            })
            .collect();
        let total = weights.iter().fold(0.0, |sum, w| sum + w);
        for (j, weight) in weights.iter().enumerate() {
            let j = i64::try_from(j).unwrap_or(0);
            let mut amount = 0.0;
            if total > 0.0 {
                amount = (year_amount * weight) / total;
            } else if i == pis.index && j == pis.month {
                amount = *year_amount;
            }
            if i == pis.index && j == pis.month {
                amount += basis.section179 + basis.bonus;
            }
            months.push((i, j, amount));
        }
    }
    let first_non_zero = months.iter().position(|m| m.2 > 1e-9).unwrap_or(0);
    let last_non_zero = months.iter().rposition(|m| m.2 > 1e-9);

    let complete = complete(&plan);
    let none = plan.effective.method == "none";
    let mut rows = Vec::new();
    let mut cumulative_exact = 0.0;
    let mut accumulated = 0.0;
    if let Some(last_non_zero) = last_non_zero {
        for (index, (period, month, exact)) in months.iter().enumerate().take(last_non_zero + 1) {
            cumulative_exact += exact;
            if index < first_non_zero {
                continue;
            }
            let reached_end = index == last_non_zero && complete && !none;
            let cumulative = round2(if reached_end {
                basis.total_depreciable
            } else {
                cumulative_exact
            });
            let amount = round2(cumulative - accumulated);
            accumulated = round2(accumulated + amount);
            let start = add_months(&plan.axis.periods[*period].start, *month).unwrap_or_default();
            rows.push(MonthlyRow {
                label: start.chars().take(7).collect(),
                period_end: end_of_month(&start).unwrap_or_default(),
                period_start: start,
                amount,
                accumulated,
                remaining: round2(basis.total_depreciable - accumulated),
            });
        }
    }
    if none {
        rows.clear();
    }
    MonthlySchedule {
        method: plan.effective.method.clone(),
        convention: plan.effective.convention.clone(),
        basis,
        rows,
        issues,
    }
}

/// `disposalYearFraction(convention, disposalDate, period, placedInServiceDate)`:
/// the share of a year's depreciation allowed in the year of disposal;
/// `None` when the date is outside the period (TypeScript throws).
pub fn disposal_year_fraction(
    convention: &str,
    disposal_date: &str,
    period: &FiscalPeriod,
    placed_in_service_date: Option<&str>,
) -> Option<f64> {
    if placed_in_service_date
        .is_some_and(|pis| pis >= period.start.as_str() && pis <= period.end.as_str())
    {
        return Some(0.0);
    }
    let periods = [period.clone()];
    let position = Axis::new(&periods).locate(disposal_date)?;
    Some(anchor(convention, position) / 12.0)
}

// ---------------------------------------------------------------------------
// Mid-quarter test

/// `MidQuarterTestAsset`.
#[derive(Debug, Clone, PartialEq)]
pub struct MidQuarterTestAsset {
    pub id: String,
    pub placed_in_service_date: String,
    pub basis: f64,
    pub real_property: bool,
    pub disposed_in_same_year: bool,
}

/// `MidQuarterTestResult`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MidQuarterTestResult {
    pub applies: bool,
    pub total_basis: f64,
    pub last_quarter_basis: f64,
    pub last_quarter_share: f64,
    pub quarter_basis: [f64; 4],
}

/// `midQuarterTestBasis(cost, businessUsePercent, section179)`.
pub fn mid_quarter_test_basis(cost: f64, business_use_percent: f64, section179: f64) -> f64 {
    round2(((cost * business_use_percent) / 100.0 - section179).max(0.0))
}

/// `midQuarterTest(assets, period)`: more than 40% of the year's basis placed
/// in service in the last quarter.
#[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
pub fn mid_quarter_test(
    assets: &[MidQuarterTestAsset],
    period: &FiscalPeriod,
) -> MidQuarterTestResult {
    let periods = [period.clone()];
    let axis = Axis::new(&periods);
    let mut cents = [0_i64; 4];
    for asset in assets {
        if asset.real_property || asset.disposed_in_same_year {
            continue;
        }
        let Some(position) = axis.locate(&asset.placed_in_service_date) else {
            continue;
        };
        let q = usize::try_from(position.quarter - 1).unwrap_or(0).min(3);
        cents[q] += math_round(asset.basis * 100.0) as i64;
    }
    let total = cents.iter().sum::<i64>();
    let last = cents[3];
    MidQuarterTestResult {
        applies: total > 0 && last * 10 > total * 4,
        total_basis: total as f64 / 100.0,
        last_quarter_basis: last as f64 / 100.0,
        last_quarter_share: if total > 0 {
            last as f64 / total as f64
        } else {
            0.0
        },
        quarter_basis: cents.map(|c| c as f64 / 100.0),
    }
}

/// `ConventionAsset`.
#[derive(Debug, Clone, PartialEq)]
pub struct ConventionAsset {
    pub id: String,
    pub placed_in_service_date: String,
    pub basis: f64,
    pub real_property: bool,
    pub disposal_date: Option<String>,
}

/// `macrsConventions(assets, periods)`: real property mid-month; personal
/// property mid-quarter in a year that fails the test, half-year otherwise.
pub fn macrs_conventions(
    assets: &[ConventionAsset],
    periods: &[FiscalPeriod],
) -> HashMap<String, &'static str> {
    let mut result = HashMap::new();
    let axis = Axis::new(periods);
    let verdict: Vec<bool> = periods
        .iter()
        .map(|period| {
            let test: Vec<MidQuarterTestAsset> = assets
                .iter()
                .map(|asset| MidQuarterTestAsset {
                    id: asset.id.clone(),
                    placed_in_service_date: asset.placed_in_service_date.clone(),
                    basis: asset.basis,
                    real_property: asset.real_property,
                    disposed_in_same_year: asset.disposal_date.as_deref().is_some_and(|d| {
                        !d.is_empty() && d >= period.start.as_str() && d <= period.end.as_str()
                    }),
                })
                .collect();
            mid_quarter_test(&test, period).applies
        })
        .collect();
    for asset in assets {
        let Some(position) = axis.locate(&asset.placed_in_service_date) else {
            continue;
        };
        let convention = if asset.real_property {
            "mid_month"
        } else if verdict[position.index] {
            "mid_quarter"
        } else {
            "half_year"
        };
        result.insert(asset.id.clone(), convention);
    }
    result
}

// ---------------------------------------------------------------------------
// Disposal

/// `DisposalGain`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisposalGain {
    pub adjusted_basis: f64,
    pub gain_or_loss: f64,
    /// `gain`, `loss` or `none`.
    pub result: &'static str,
    pub ordinary_recapture: f64,
    pub unrecaptured_section_1250: f64,
    pub remaining_gain: f64,
}

/// `gainOnDisposal(cost, accumulated, proceeds, { propertyType })`;
/// `section_1250` is real property.
pub fn gain_on_disposal(
    cost: f64,
    accumulated: f64,
    proceeds: f64,
    section_1250: bool,
) -> DisposalGain {
    let adjusted_basis = round2(cost - accumulated);
    let gain_or_loss = round2(proceeds - adjusted_basis);
    let gain = gain_or_loss.max(0.0);
    let recapture = gain.min(round2(accumulated).max(0.0));
    DisposalGain {
        adjusted_basis,
        gain_or_loss,
        result: if gain_or_loss > 0.0 {
            "gain"
        } else if gain_or_loss < 0.0 {
            "loss"
        } else {
            "none"
        },
        ordinary_recapture: if section_1250 { 0.0 } else { recapture },
        unrecaptured_section_1250: if section_1250 { recapture } else { 0.0 },
        remaining_gain: round2(gain - recapture),
    }
}

/// `calendarFiscalYears(firstYear, count)`.
pub fn calendar_fiscal_years(first_year: i64, count: i64) -> Vec<FiscalPeriod> {
    (0..count)
        .map(|i| FiscalPeriod {
            label: (first_year + i).to_string(),
            start: format!("{}-01-01", first_year + i),
            end: format!("{}-12-31", first_year + i),
        })
        .collect()
}

/// `fiscalYearsFrom(firstStart, count)`: 12-month years from the first of a
/// month, labelled by the year they end in; `None` when `firstStart` is not
/// the first of a month.
pub fn fiscal_years_from(first_start: &str, count: i64) -> Option<Vec<FiscalPeriod>> {
    if parse_iso(first_start)?.d != 1 {
        return None;
    }
    (0..count)
        .map(|i| {
            let start = add_months(first_start, 12 * i)?;
            let end = add_days(&add_months(&start, 12)?, -1)?;
            Some(FiscalPeriod {
                label: format!("FY{}", parse_iso(&end)?.y),
                start,
                end,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(cost: f64, pis: &str) -> DepreciationAsset {
        DepreciationAsset {
            cost,
            acquisition_date: pis.to_owned(),
            placed_in_service_date: pis.to_owned(),
            ..DepreciationAsset::default()
        }
    }

    fn book(method: &str, convention: &str, years: f64) -> DepreciationBook {
        DepreciationBook {
            method: method.to_owned(),
            convention: convention.to_owned(),
            recovery_years: years,
            ..DepreciationBook::default()
        }
    }

    fn amounts(schedule: &DepreciationSchedule) -> Vec<f64> {
        schedule.rows.iter().map(|r| r.amount).collect()
    }

    #[test]
    fn macrs_half_year_and_mid_quarter() {
        let periods = calendar_fiscal_years(2026, 9);
        let s = depreciation_schedule(
            &asset(10_000.0, "2026-03-10"),
            &book("macrs_gds", "half_year", 5.0),
            &periods,
        );
        assert_eq!(
            amounts(&s),
            vec![2000.0, 3200.0, 1920.0, 1152.0, 1152.0, 576.0]
        );
        let q = depreciation_schedule(
            &asset(10_000.0, "2026-03-10"),
            &book("macrs_gds", "mid_quarter", 5.0),
            &periods,
        );
        assert_eq!(q.rows[0].amount, 3500.0);
        let total: f64 = q.rows.iter().map(|r| r.amount).sum();
        assert!((total - 10_000.0).abs() < 1e-6);
    }

    #[test]
    fn section_179_then_bonus_then_macrs() {
        let periods = calendar_fiscal_years(2024, 11);
        let mut b = book("macrs_gds", "half_year", 7.0);
        b.section_179_amount = Some(20_000.0);
        b.bonus_percent = Some(60.0);
        let s = depreciation_schedule(&asset(50_000.0, "2024-06-15"), &b, &periods);
        assert_eq!(s.basis.depreciable_basis, 12_000.0);
        assert_eq!(s.rows[0].section179, 20_000.0);
        assert_eq!(s.rows[0].bonus, 18_000.0);
        assert_eq!(s.rows[0].regular, 1714.8);
        assert_eq!(s.rows[0].amount, 39_714.8);
    }

    #[test]
    fn straight_line_full_month_monthly() {
        let periods = calendar_fiscal_years(2026, 8);
        let m = monthly_schedule(
            &asset(10_000.0, "2026-03-15"),
            &book("straight_line", "full_month", 5.0),
            &periods,
        );
        assert_eq!(m.rows.len(), 60);
        assert_eq!(m.rows[0].period_start, "2026-03-01");
        assert_eq!(m.rows[0].amount, 166.67);
        assert_eq!(m.rows[59].period_end, "2031-02-28");
        assert_eq!(m.rows[59].accumulated, 10_000.0);
    }

    #[test]
    fn listed_property_goes_to_ads() {
        let periods = calendar_fiscal_years(2026, 9);
        let mut a = asset(40_000.0, "2026-02-01");
        a.business_use_percent = Some(40.0);
        a.listed_property = true;
        let mut b = book("macrs_gds", "half_year", 5.0);
        b.bonus_percent = Some(100.0);
        let s = depreciation_schedule(&a, &b, &periods);
        assert_eq!(s.method, "macrs_ads");
        assert!(s.issues.iter().any(|i| i.code == "ads_required"));
        assert_eq!(s.basis.bonus, 0.0);
    }

    #[test]
    fn mid_quarter_test_and_gain() {
        let period = &calendar_fiscal_years(2026, 1)[0];
        let assets = [
            MidQuarterTestAsset {
                id: "a".into(),
                placed_in_service_date: "2026-03-10".into(),
                basis: 10_000.0,
                real_property: false,
                disposed_in_same_year: false,
            },
            MidQuarterTestAsset {
                id: "b".into(),
                placed_in_service_date: "2026-12-05".into(),
                basis: 30_000.0,
                real_property: false,
                disposed_in_same_year: false,
            },
        ];
        let result = mid_quarter_test(&assets, period);
        assert!(result.applies);
        assert_eq!(result.last_quarter_share, 0.75);
        let gain = gain_on_disposal(10_000.0, 10_000.0, 5_000.0, false);
        assert_eq!(
            (gain.gain_or_loss, gain.ordinary_recapture, gain.result),
            (5_000.0, 5_000.0, "gain")
        );
    }

    #[test]
    fn en_us_numbers() {
        assert_eq!(en_us(1_220_000.0), "1,220,000");
        assert_eq!(en_us(2_400.0), "2,400");
        assert_eq!(en_us(1234.5678), "1,234.568");
        assert_eq!(en_us(-0.5), "-0.5");
        assert_eq!(en_us(999.0), "999");
    }
}
