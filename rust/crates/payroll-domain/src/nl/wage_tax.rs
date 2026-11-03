//! Dutch wage tax (`nl/wage-tax.ts`): the period tables computed from the
//! Belastingdienst's rekenvoorschriften, the special-reward table and the
//! anonymous rate.

use crate::js::math_round;
use crate::money::{Cents, round_half_away_from_zero};
use crate::nl::rules::{NlArbeidskorting, NlBrackets, NlRuleSet, NlSpecialRewardColumn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NlAgeColumn {
    BelowAow,
    Aow1945,
    Aow1946,
}

/// `PERIOD_FACTOR`.
pub mod period_factor {
    pub const QUARTER: f64 = 4.0;
    pub const MONTH: f64 = 12.0;
    pub const FOUR_WEEKS: f64 = 13.0;
    pub const WEEK: f64 = 52.0;
    pub const DAY: f64 = 260.0;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PeriodTaxResult {
    pub tax_cents: Cents,
    pub labour_credit_cents: Cents,
    pub annual_wage: f64,
    pub table_wage_cents: Cents,
}

fn scaled(value: f64, decimals: i32) -> f64 {
    math_round(value * 10f64.powi(decimals))
}

fn brackets_for(rules: &NlRuleSet, column: NlAgeColumn) -> &NlBrackets {
    match column {
        NlAgeColumn::BelowAow => &rules.wage_tax.below_aow,
        NlAgeColumn::Aow1945 => &rules.wage_tax.aow1945,
        NlAgeColumn::Aow1946 => &rules.wage_tax.aow1946,
    }
}

fn x1_below_lmax(l: f64, br: &NlBrackets) -> f64 {
    let (mut a, mut b, mut c) = (0.0, br.b1, 0.0);
    if l > br.a3 {
        (a, b, c) = (br.a3, br.b3, br.c3);
    } else if l > br.a2 {
        (a, b, c) = (br.a2, br.b2, br.c2);
    }
    let x1 = (((l - a) * scaled(b, 2)) / 10_000.0).floor() + c;
    x1.max(0.0)
}

fn algemene_heffingskorting(l: f64, rules: &NlRuleSet, aow: bool) -> f64 {
    let ahk = &rules.wage_tax.ahk;
    let side = if aow { &ahk.aow } else { &ahk.below_aow };
    if l <= ahk.g1 {
        return side.m1;
    }
    if l > ahk.g2 {
        return 0.0;
    }
    let reduction = (((l - ahk.g1) * scaled(side.a1, 5)) / 100_000.0).floor();
    (side.m1 - reduction).max(0.0)
}

fn ouderenkorting(l: f64, rules: &NlRuleSet) -> f64 {
    let ouk = &rules.wage_tax.ouk;
    if l <= ouk.g1 {
        return ouk.m1;
    }
    if l > ouk.g2 {
        return 0.0;
    }
    let reduction = (((l - ouk.g1) * scaled(ouk.a1, 5)) / 100_000.0).floor();
    (ouk.m1 - reduction).max(0.0)
}

fn arbeidskorting(l: f64, rules: &NlRuleSet, aow: bool) -> f64 {
    let ark = &rules.wage_tax.ark;
    if l > ark.g4 || l <= 0.0 {
        return 0.0;
    }
    let p: &NlArbeidskorting = if aow { &ark.aow } else { &ark.below_aow };
    let e5 = 100_000.0;
    let pos = |n: f64| n.max(0.0);
    let t1 = (l * scaled(p.o1, 5)).min(p.m1 * e5);
    let t2 = (t1 + pos(l - ark.g1) * scaled(p.o2, 5)).min(p.m2 * e5);
    let t3 = (t2 + pos(l - ark.g2) * scaled(p.o3, 5)).min(p.m3 * e5);
    let total = t3 - pos(l - ark.g3) * scaled(p.a1, 5);
    if total <= 0.0 {
        return 0.0;
    }
    (total / e5).ceil()
}

fn annual_wage_for(period_wage_cents: Cents, factor: f64, rules: &NlRuleSet) -> (f64, bool) {
    if period_wage_cents <= 0.0 {
        return (0.0, false);
    }
    let (lv, lmax) = (rules.wage_tax.lv, rules.wage_tax.lmax);
    let table_max_cents = ((lmax * 100.0) / factor).ceil();
    if period_wage_cents <= table_max_cents {
        let annual_cents = period_wage_cents * factor;
        let steps = (annual_cents / (lv * 100.0)).floor();
        return (lmax.min(steps * lv), false);
    }
    ((period_wage_cents * factor) / 100.0, true)
}

/// `periodWageTax(periodWageCents, factor, column, applyLoonheffingskorting, rules)`.
pub fn period_wage_tax(
    period_wage_cents: Cents,
    factor: f64,
    column: NlAgeColumn,
    apply_loonheffingskorting: bool,
    rules: &NlRuleSet,
) -> PeriodTaxResult {
    let (l, above_lmax) = annual_wage_for(period_wage_cents, factor, rules);
    let table_wage_cents = ((l * 100.0) / factor - 1e-9).ceil();
    if l <= 0.0 {
        return PeriodTaxResult {
            tax_cents: 0.0,
            labour_credit_cents: 0.0,
            annual_wage: 0.0,
            table_wage_cents: 0.0,
        };
    }
    let br = brackets_for(rules, column);
    let aow = column != NlAgeColumn::BelowAow;
    if above_lmax {
        let lmax = rules.wage_tax.lmax;
        let y_annual = (((lmax - br.a3) * scaled(br.b3, 2)) / 10_000.0).floor() + br.c3;
        let y_period_cents = round_half_away_from_zero((y_annual * 100.0) / factor);
        let excess_per5 = round_half_away_from_zero(
            ((period_wage_cents * factor - lmax * 100.0) * 1_000.0) / factor,
        );
        let x_boven_cents = ((excess_per5 * scaled(br.b3, 2)) / 10_000_000.0).floor();
        return PeriodTaxResult {
            tax_cents: y_period_cents + x_boven_cents,
            labour_credit_cents: 0.0,
            annual_wage: l,
            table_wage_cents,
        };
    }
    let x1 = x1_below_lmax(l, br);
    let (mut ahk, mut ouk, mut ark) = (0.0, 0.0, 0.0);
    if apply_loonheffingskorting {
        ahk = algemene_heffingskorting(l, rules, aow);
        ouk = if aow { ouderenkorting(l, rules) } else { 0.0 };
        ark = arbeidskorting(l, rules, aow);
    }
    let x = if x1 >= ahk + ouk + ark {
        x1 - (ahk + ouk + ark)
    } else {
        let mut excess = ahk + ouk + ark - x1;
        let mut cut = |amount: f64| {
            let take = amount.min(excess);
            excess -= take;
            amount - take
        };
        ark = cut(ark);
        ouk = cut(ouk);
        ahk = cut(ahk);
        let _ = (ouk, ahk);
        0.0
    };
    PeriodTaxResult {
        tax_cents: round_half_away_from_zero((x * 100.0) / factor),
        labour_credit_cents: round_half_away_from_zero((ark * 100.0) / factor),
        annual_wage: l,
        table_wage_cents,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NlTableColour {
    White,
    Green,
}

/// `specialRewardColumn(annualWageCents, column, rules, colour)`.
pub fn special_reward_column(
    annual_wage_cents: Cents,
    column: NlAgeColumn,
    rules: &NlRuleSet,
    colour: NlTableColour,
) -> NlSpecialRewardColumn {
    let table = match colour {
        NlTableColour::Green => &rules.special_reward_table_green,
        NlTableColour::White => &rules.special_reward_table,
    };
    let euros = (annual_wage_cents.max(0.0) / 100.0).floor();
    let mut row = &table[0];
    for r in table {
        if r.from <= euros {
            row = r;
        } else {
            break;
        }
    }
    match column {
        NlAgeColumn::BelowAow => row.below_aow,
        NlAgeColumn::Aow1945 => row.aow1945,
        NlAgeColumn::Aow1946 => row.aow1946,
    }
}

/// `specialRewardPercent(annualWageCents, column, applyLoonheffingskorting, rules, colour)`.
pub fn special_reward_percent(
    annual_wage_cents: Cents,
    column: NlAgeColumn,
    apply_loonheffingskorting: bool,
    rules: &NlRuleSet,
    colour: NlTableColour,
) -> f64 {
    let c = special_reward_column(annual_wage_cents, column, rules, colour);
    if apply_loonheffingskorting {
        math_round((c.standard + c.offset) * 100.0) / 100.0
    } else {
        c.without
    }
}

/// `specialRewardTax(amountCents, percent)`.
pub fn special_reward_tax(amount_cents: Cents, percent: f64) -> Cents {
    ((amount_cents * scaled(percent, 2)) / 10_000.0 + 1e-9).floor()
}

/// `anonymousTax(amountCents, rules)`.
pub fn anonymous_tax(amount_cents: Cents, rules: &NlRuleSet) -> Cents {
    ((amount_cents * scaled(rules.wage_tax.anonymous_rate_percent, 2)) / 10_000.0 + 1e-9).floor()
}
