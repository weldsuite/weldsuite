//! Federal rules per tax year (`us/federal-rules.ts`, `federal-2026.ts`),
//! written to `data/us-federal.json` by `pnpm rust:payroll-fixtures`.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;

use crate::money::Cents;
use crate::types::FilingStatus;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithholdingRow {
    pub at_least_cents: Cents,
    pub base_cents: Cents,
    pub rate_percent: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WithholdingSchedule {
    pub single: Vec<WithholdingRow>,
    pub married_jointly: Vec<WithholdingRow>,
    pub head_of_household: Vec<WithholdingRow>,
}

impl WithholdingSchedule {
    pub fn get(&self, status: FilingStatus) -> &[WithholdingRow] {
        match status {
            FilingStatus::Single => &self.single,
            FilingStatus::MarriedJointly => &self.married_jointly,
            FilingStatus::HeadOfHousehold => &self.head_of_household,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithholdingRules {
    pub standard: WithholdingSchedule,
    pub step2_checked: WithholdingSchedule,
    pub line1g_married_jointly_cents: Cents,
    pub line1g_other_cents: Cents,
    pub allowance_cents: Cents,
    pub nra_addition_pre2020: BTreeMap<String, Cents>,
    pub nra_addition2020: BTreeMap<String, Cents>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Supplemental {
    pub flat_rate_percent: f64,
    pub mandatory_rate_percent: f64,
    pub mandatory_threshold_cents: Cents,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialSecurity {
    pub rate_percent: f64,
    pub wage_base_cents: Cents,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Medicare {
    pub rate_percent: f64,
    pub additional_rate_percent: f64,
    pub additional_threshold_cents: Cents,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Futa {
    pub gross_rate_percent: f64,
    pub max_credit_percent: f64,
    pub wage_base_cents: Cents,
    pub credit_reduction_pending: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Retirement {
    pub elective_deferral_cents: Cents,
    pub catch_up50_cents: Cents,
    pub catch_up60_to63_cents: Cents,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hsa {
    pub self_only_cents: Cents,
    pub family_cents: Cents,
    pub catch_up55_cents: Cents,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FederalRules {
    pub tax_year: i64,
    pub rule_set: String,
    pub provisional: bool,
    pub provisional_items: Vec<String>,
    pub withholding: WithholdingRules,
    pub supplemental: Supplemental,
    pub social_security: SocialSecurity,
    pub medicare: Medicare,
    pub futa: Futa,
    pub retirement: Retirement,
    pub hsa: Hsa,
    pub dependent_care_exclusion_cents: Cents,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FederalData {
    rules: BTreeMap<String, FederalRules>,
    futa_credit_reduction: BTreeMap<String, BTreeMap<String, f64>>,
}

static DATA: LazyLock<FederalData> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../data/us-federal.json")).unwrap_or_default()
});

/// `federalRules(taxYear)`.
pub fn federal_rules(tax_year: i64) -> Option<&'static FederalRules> {
    DATA.rules.get(&tax_year.to_string())
}

/// `SUPPORTED_FEDERAL_YEARS`.
pub fn supported_federal_years() -> Vec<i64> {
    DATA.rules.keys().filter_map(|k| k.parse().ok()).collect()
}

/// `futaCreditReductionPercent(taxYear, state)`.
pub fn futa_credit_reduction_percent(tax_year: i64, state: Option<&str>) -> f64 {
    let Some(state) = state.filter(|s| !s.is_empty()) else {
        return 0.0;
    };
    DATA.futa_credit_reduction
        .get(&tax_year.to_string())
        .and_then(|states| states.get(&state.to_uppercase()))
        .copied()
        .unwrap_or(0.0)
}

/// `FUTA_CREDIT_REDUCTION[taxYear]`: state → percent.
pub fn futa_credit_reduction_table(tax_year: i64) -> Option<&'static BTreeMap<String, f64>> {
    DATA.futa_credit_reduction.get(&tax_year.to_string())
}
