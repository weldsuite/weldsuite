//! The Dutch rule sets per tax year (`nl/rules.ts`, `rules-2026.ts`,
//! `rules-2027.ts`). The tables are the TypeScript's, written to
//! `data/nl-rules.json` by `pnpm rust:payroll-fixtures`.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;

use crate::money::Cents;

#[derive(Debug, Clone, Deserialize)]
pub struct NlBrackets {
    pub a2: f64,
    pub a3: f64,
    pub b1: f64,
    pub b2: f64,
    pub b3: f64,
    pub c2: f64,
    pub c3: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NlArbeidskorting {
    pub o1: f64,
    pub o2: f64,
    pub o3: f64,
    pub a1: f64,
    pub m1: f64,
    pub m2: f64,
    pub m3: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct NlSpecialRewardColumn {
    pub without: f64,
    pub standard: f64,
    pub offset: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NlSpecialRewardRow {
    pub from: f64,
    pub below_aow: NlSpecialRewardColumn,
    pub aow1945: NlSpecialRewardColumn,
    pub aow1946: NlSpecialRewardColumn,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NlMinimumWage {
    pub from: String,
    pub per_hour: BTreeMap<String, Cents>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AowAge {
    pub years: i64,
    pub months: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AhkSide {
    pub m1: f64,
    pub a1: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ahk {
    pub g1: f64,
    pub g2: f64,
    pub below_aow: AhkSide,
    pub aow: AhkSide,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Ouk {
    pub m1: f64,
    pub g1: f64,
    pub g2: f64,
    pub a1: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ark {
    pub g1: f64,
    pub g2: f64,
    pub g3: f64,
    pub g4: f64,
    pub below_aow: NlArbeidskorting,
    pub aow: NlArbeidskorting,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WageTaxRules {
    pub lv: f64,
    pub lmax: f64,
    pub below_aow: NlBrackets,
    pub aow1945: NlBrackets,
    pub aow1946: NlBrackets,
    pub ahk: Ahk,
    pub ouk: Ouk,
    pub ark: Ark,
    pub anonymous_rate_percent: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MaxPremieloon {
    pub year: Cents,
    pub month: Cents,
    pub day: Cents,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Premiums {
    pub awf_low_percent: f64,
    pub awf_high_percent: f64,
    pub aof_low_percent: f64,
    pub aof_high_percent: f64,
    pub wko_percent: f64,
    pub whk_sector_percent: BTreeMap<String, f64>,
    pub max_premieloon: MaxPremieloon,
    pub zvw_employer_levy_percent: f64,
    pub zvw_withheld_percent: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wkr {
    pub per_km_cents: Cents,
    pub home_working_per_day_cents: Cents,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expat {
    pub salary_norm_cents: Cents,
    pub wnt_cap_cents: Cents,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NlRuleSet {
    pub year: i64,
    pub id: String,
    pub provisional: bool,
    pub unverified: Vec<String>,
    pub aow_age: AowAge,
    pub wage_tax: WageTaxRules,
    pub special_reward_table: Vec<NlSpecialRewardRow>,
    pub special_reward_table_green: Vec<NlSpecialRewardRow>,
    pub premiums: Premiums,
    pub minimum_wage: Vec<NlMinimumWage>,
    pub wkr: Wkr,
    pub expat: Expat,
    pub dga_usual_salary_cents: Cents,
}

static RULE_SETS: LazyLock<BTreeMap<String, NlRuleSet>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../data/nl-rules.json")).unwrap_or_default()
});

/// `nlRulesForYear(year)`.
pub fn nl_rules_for_year(year: i64) -> Option<&'static NlRuleSet> {
    RULE_SETS.get(&year.to_string())
}

/// `supportedNlTaxYears()`.
pub fn supported_nl_tax_years() -> Vec<i64> {
    let mut years: Vec<i64> = RULE_SETS.keys().filter_map(|k| k.parse().ok()).collect();
    years.sort_unstable();
    years
}

#[cfg(test)]
mod tests {
    #[test]
    fn loads() {
        assert_eq!(super::supported_nl_tax_years(), vec![2026, 2027]);
    }
}
