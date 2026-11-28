//! Payment reminders (Rust only, edition feature `books-reminders`): the
//! workflow of an entity and, for Dutch entities, the statutory collection
//! costs (WIK) and interest an optional final notice can claim.
//!
//! The workflow lives in the entity's `jurisdiction_settings.reminders`
//! (no migration), next to the keys other features keep there:
//!
//! ```json
//! { "enabled": true,
//!   "steps": [ { "level": 1, "daysAfterDue": 7, "auto": true, "template": "reminder1" } ],
//!   "statutoryCosts": { "enabled": false, "interest": true } }
//! ```
//!
//! # Statutory costs and interest (NL)
//!
//! - **Costs**: the scale of the *Besluit vergoeding voor buitengerechtelijke
//!   incassokosten* (art. 2): 15% of the first 2,500, 10% of the next 2,500,
//!   5% of the next 5,000, 1% of the next 190,000 and 0.5% of the rest,
//!   at least 40 and at most 6,775. The base is the principal still due.
//! - **B2B**: costs are due once the debtor is in default (the due date has
//!   passed), together with the *wettelijke handelsrente* (art. 6:119a BW) from
//!   the day after the due date.
//! - **B2C**: costs are only due when the debtor has had the 14-day notice
//!   (*14-dagenbrief*, art. 6:96 lid 6 BW) that states them and has not paid
//!   within 14 days after the day after receipt, so the final reminder of a
//!   consumer is that notice and claims no costs yet. Interest is the
//!   *wettelijke rente* (art. 6:119 BW), counted from the end of that term.
//! - The costs are a claim stated in the notice, not part of the invoice:
//!   nothing is booked until they are paid (see `books-sales/src/reminders.rs`).
//!
//! The default rates are today's: [`COMMERCIAL_RATE`] and
//! [`CONSUMER_RATE`], each per entity overridable in
//! `statutoryCosts.commercialRate` / `consumerRate` (percent per year).

use serde_json::{Map, Value, json};

/// The key in `jurisdiction_settings`.
pub const KEY: &str = "reminders";

/// Wettelijke handelsrente, percent per year, from 1 July 2026: the ECB's
/// main refinancing rate on that day (2.40%) plus 8 points. Source:
/// Rijksoverheid, "Hoogte wettelijke rente", and the KCBR informatieblad of
/// July 2026 (checked 2026-11-27). It changes every 1 January and 1 July.
pub const COMMERCIAL_RATE: f64 = 10.40;
/// Wettelijke rente (art. 6:119 BW), percent per year, from 1 January 2026.
/// Same sources (checked 2026-11-27).
pub const CONSUMER_RATE: f64 = 4.0;

/// The templates a step can use.
pub const STEP_TEMPLATES: [&str; 3] = ["reminder1", "reminder2", "reminder3"];

/// The most steps a workflow has.
pub const MAX_STEPS: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub level: i32,
    pub days_after_due: i64,
    /// Sent by the daily sweep; otherwise it waits in To process.
    pub auto: bool,
    pub template: String,
    /// The final notice: where the statutory costs can be claimed.
    pub final_step: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StatutoryCosts {
    pub enabled: bool,
    pub interest: bool,
    /// Percent per year.
    pub commercial_rate: f64,
    pub consumer_rate: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReminderSettings {
    pub enabled: bool,
    pub steps: Vec<Step>,
    pub statutory: StatutoryCosts,
    /// The contacts (`parties.id`) whose reminders this entity holds (see
    /// `contact_page`); kept as they are whenever the workflow is rewritten.
    pub paused_contact_ids: Vec<String>,
}

pub fn default_steps() -> Vec<Step> {
    vec![
        Step {
            level: 1,
            days_after_due: 7,
            auto: true,
            template: "reminder1".into(),
            final_step: false,
        },
        Step {
            level: 2,
            days_after_due: 21,
            auto: true,
            template: "reminder2".into(),
            final_step: false,
        },
        Step {
            level: 3,
            days_after_due: 35,
            auto: false,
            template: "reminder3".into(),
            final_step: true,
        },
    ]
}

impl Default for ReminderSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            steps: default_steps(),
            statutory: StatutoryCosts {
                enabled: false,
                interest: true,
                commercial_rate: COMMERCIAL_RATE,
                consumer_rate: CONSUMER_RATE,
            },
            paused_contact_ids: Vec::new(),
        }
    }
}

fn rate(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|r| r.is_finite() && (0.0..=100.0).contains(r))
        .unwrap_or(fallback)
}

impl ReminderSettings {
    /// Read them from an entity's `jurisdictionSettings`; anything missing or
    /// unusable is the default.
    pub fn of(jurisdiction_settings: Option<&Value>) -> Self {
        let mut settings = Self::default();
        let Some(stored) = jurisdiction_settings
            .and_then(|s| s.get(KEY))
            .filter(|v| v.is_object())
        else {
            return settings;
        };
        settings.paused_contact_ids = crate::contact_page::paused_ids_of(jurisdiction_settings);
        settings.enabled = stored
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if let Some(steps) = stored.get("steps").and_then(Value::as_array) {
            let parsed: Vec<Step> = steps.iter().filter_map(step_of).collect();
            if !parsed.is_empty() {
                settings.steps = parsed;
            }
        }
        if let Some(costs) = stored.get("statutoryCosts").filter(|v| v.is_object()) {
            settings.statutory = StatutoryCosts {
                enabled: costs
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                interest: costs
                    .get("interest")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                commercial_rate: rate(costs.get("commercialRate"), COMMERCIAL_RATE),
                consumer_rate: rate(costs.get("consumerRate"), CONSUMER_RATE),
            };
        }
        settings
    }

    pub fn to_json(&self) -> Value {
        let mut out = json!({
            "enabled": self.enabled,
            "steps": self.steps.iter().map(|s| json!({
                "level": s.level,
                "daysAfterDue": s.days_after_due,
                "auto": s.auto,
                "template": s.template,
                "final": s.final_step,
            })).collect::<Vec<_>>(),
            "statutoryCosts": {
                "enabled": self.statutory.enabled,
                "interest": self.statutory.interest,
                "commercialRate": self.statutory.commercial_rate,
                "consumerRate": self.statutory.consumer_rate,
            },
        });
        // Only when there is one, so a workflow without a pause reads as before.
        if !self.paused_contact_ids.is_empty() {
            out[crate::contact_page::PAUSED_IDS_KEY] = json!(self.paused_contact_ids);
        }
        out
    }

    pub fn step(&self, level: i32) -> Option<&Step> {
        self.steps.iter().find(|s| s.level == level)
    }

    /// The step after `level` reminders have gone out.
    pub fn next_step(&self, level: i32) -> Option<&Step> {
        self.step(level + 1)
    }

    /// The step the statutory claim belongs to: the one marked final, else
    /// the last.
    pub fn final_level(&self) -> Option<i32> {
        self.steps
            .iter()
            .find(|s| s.final_step)
            .or_else(|| self.steps.last())
            .map(|s| s.level)
    }

    /// Whether `step` carries the statutory claim.
    pub fn claims_statutory(&self, step: &Step) -> bool {
        self.statutory.enabled && Some(step.level) == self.final_level()
    }

    /// The step due for an invoice that has had `level` reminders and is
    /// `days_overdue` days past due, when the workflow is on.
    pub fn due_step(&self, level: i32, days_overdue: i64) -> Option<&Step> {
        if !self.enabled {
            return None;
        }
        self.next_step(level)
            .filter(|s| days_overdue >= s.days_after_due)
    }
}

fn step_of(value: &Value) -> Option<Step> {
    let level = i32::try_from(value.get("level")?.as_i64()?).ok()?;
    let template = value.get("template")?.as_str()?.to_owned();
    if level < 1 || !STEP_TEMPLATES.contains(&template.as_str()) {
        return None;
    }
    Some(Step {
        level,
        days_after_due: value.get("daysAfterDue")?.as_i64()?.max(0),
        auto: value.get("auto").and_then(Value::as_bool).unwrap_or(false),
        template,
        final_step: value.get("final").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// `jurisdictionSettings` with `reminders` replaced by the checked `patch`
/// (`enabled`, `steps`, `statutoryCosts`; keys not named keep their value).
/// Everything else in the settings is kept.
///
/// # Errors
///
/// The message for a body that is not a valid workflow.
pub fn merged(
    jurisdiction_settings: Option<&Value>,
    patch: &Map<String, Value>,
    nl: bool,
) -> Result<Value, String> {
    let mut all = match jurisdiction_settings {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let mut next = ReminderSettings::of(jurisdiction_settings);
    if let Some(enabled) = patch.get("enabled") {
        next.enabled = enabled.as_bool().ok_or("enabled must be true or false")?;
    }
    if let Some(steps) = patch.get("steps") {
        let list = steps.as_array().ok_or("steps must be a list")?;
        if list.is_empty() || list.len() > MAX_STEPS {
            return Err(format!("steps must hold 1 to {MAX_STEPS} steps"));
        }
        let mut parsed = Vec::new();
        for (i, raw) in list.iter().enumerate() {
            let step =
                step_of(raw).ok_or("each step needs a level, daysAfterDue and a template")?;
            if usize::try_from(step.level).ok() != Some(i + 1) {
                return Err("step levels must be 1, 2, 3 in order".into());
            }
            if parsed
                .last()
                .is_some_and(|p: &Step| p.days_after_due >= step.days_after_due)
            {
                return Err("daysAfterDue must grow from step to step".into());
            }
            if step.days_after_due > 365 {
                return Err("daysAfterDue must be at most 365".into());
            }
            parsed.push(step);
        }
        if parsed.iter().filter(|s| s.final_step).count() > 1 {
            return Err("only one step can be final".into());
        }
        next.steps = parsed;
    }
    if let Some(costs) = patch.get("statutoryCosts") {
        let costs = costs
            .as_object()
            .ok_or("statutoryCosts must be an object")?;
        if let Some(enabled) = costs.get("enabled") {
            next.statutory.enabled = enabled.as_bool().ok_or("enabled must be true or false")?;
        }
        if let Some(interest) = costs.get("interest") {
            next.statutory.interest = interest.as_bool().ok_or("interest must be true or false")?;
        }
        for (key, slot) in [
            ("commercialRate", &mut next.statutory.commercial_rate),
            ("consumerRate", &mut next.statutory.consumer_rate),
        ] {
            if let Some(value) = costs.get(key) {
                *slot = value
                    .as_f64()
                    .filter(|r| r.is_finite() && (0.0..=100.0).contains(r))
                    .ok_or_else(|| format!("{key} must be a percentage from 0 to 100"))?;
            }
        }
    }
    if next.statutory.enabled && !nl {
        return Err("Statutory collection costs apply to Dutch entities only".into());
    }
    all.insert(KEY.to_owned(), next.to_json());
    Ok(Value::Object(all))
}

// ── Statutory costs and interest ────────────────────────────────────────────

/// The tiers of the Besluit, in cents: (width of the tier, percent x 100).
const TIERS: [(i64, i64); 4] = [
    (250_000, 1500),
    (250_000, 1000),
    (500_000, 500),
    (19_000_000, 100),
];
const REST_BASIS_POINTS: i64 = 50;
const MIN_COSTS: i64 = 4_000;
const MAX_COSTS: i64 = 677_500;

/// The maximum collection costs of the Besluit for `principal_cents`, in
/// cents: 0 for nothing outstanding, else at least 40 and at most 6,775.
pub fn collection_costs_cents(principal_cents: i64) -> i64 {
    if principal_cents <= 0 {
        return 0;
    }
    let mut left = principal_cents;
    let mut basis: i128 = 0;
    for (width, bp) in TIERS {
        let part = left.min(width);
        basis += i128::from(part) * i128::from(bp);
        left -= part;
        if left == 0 {
            break;
        }
    }
    if left > 0 {
        basis += i128::from(left) * i128::from(REST_BASIS_POINTS);
    }
    // `basis` is cents x basis points; round half up to whole cents.
    let cents = i64::try_from((basis + 5_000) / 10_000).unwrap_or(MAX_COSTS);
    cents.clamp(MIN_COSTS, MAX_COSTS)
}

/// Simple interest on `principal_cents` at `percent` a year for `days`
/// (365-day year), rounded half up to the cent.
pub fn interest_cents(principal_cents: i64, percent: f64, days: i64) -> i64 {
    if principal_cents <= 0 || days <= 0 || percent <= 0.0 {
        return 0;
    }
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    let cents = (principal_cents as f64 * percent / 100.0 * days as f64 / 365.0 + 0.5).floor();
    #[allow(clippy::cast_possible_truncation)]
    {
        cents as i64
    }
}

/// Who owes: a business (B2B rules) or a consumer (B2C rules).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Debtor {
    Business,
    Consumer,
}

/// What the final notice claims, in cents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub principal: i64,
    /// What the scale allows; due only when [`Claim::costs_due`].
    pub costs: i64,
    pub interest: i64,
    /// The costs can be claimed now (B2B, or B2C after the 14-day term).
    pub costs_due: bool,
    /// This notice is the 14-day notice: it states the costs that fall due
    /// when the term ends unpaid.
    pub is_notice: bool,
}

impl Claim {
    /// What the notice asks to be paid: the principal, the interest and the
    /// costs when they are due.
    pub fn total(&self) -> i64 {
        self.principal + self.interest + if self.costs_due { self.costs } else { 0 }
    }
}

/// The days after the notice before consumer costs fall due: 14 full days
/// after the day after receipt.
pub const NOTICE_DAYS: i64 = 14;

/// The claim for `principal_cents` that is `days_overdue` days past due.
///
/// `notice_age_days` is how many days ago the consumer's 14-day notice went
/// out (`None`: not yet).
pub fn statutory_claim(
    principal_cents: i64,
    debtor: Debtor,
    days_overdue: i64,
    notice_age_days: Option<i64>,
    statutory: &StatutoryCosts,
) -> Claim {
    let costs = collection_costs_cents(principal_cents);
    match debtor {
        Debtor::Business => Claim {
            principal: principal_cents,
            costs,
            interest: if statutory.interest {
                interest_cents(principal_cents, statutory.commercial_rate, days_overdue)
            } else {
                0
            },
            costs_due: true,
            is_notice: false,
        },
        Debtor::Consumer => {
            let lapsed = notice_age_days.is_some_and(|age| age > NOTICE_DAYS);
            let interest_days = notice_age_days.map_or(0, |age| age - NOTICE_DAYS);
            Claim {
                principal: principal_cents,
                costs,
                interest: if statutory.interest {
                    interest_cents(principal_cents, statutory.consumer_rate, interest_days)
                } else {
                    0
                },
                costs_due: lapsed,
                is_notice: !lapsed,
            }
        }
    }
}

/// Cents as a decimal text: `1234` is `12.34`.
pub fn cents_text(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

/// A decimal text (`"1234.5"`) as cents, rounded half up; `None` when it is
/// not a number.
pub fn parse_cents(text: &str) -> Option<i64> {
    let value: f64 = text.trim().parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    Some((value * 100.0).round() as i64)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    fn statutory() -> StatutoryCosts {
        ReminderSettings::default().statutory
    }

    #[test]
    fn the_scale_of_the_besluit() {
        // The minimum applies to small amounts.
        assert_eq!(collection_costs_cents(10_000), 4_000);
        assert_eq!(collection_costs_cents(26_667), 4_000);
        // 15% of 1,000 = 150.
        assert_eq!(collection_costs_cents(100_000), 15_000);
        // 15% of 2,500 + 10% of 500 = 375 + 50.
        assert_eq!(collection_costs_cents(300_000), 42_500);
        // 375 + 250 + 5% of 1,000 = 50.
        assert_eq!(collection_costs_cents(600_000), 67_500);
        // 375 + 250 + 250 (5,000 at 5%) = 875 at 10,000.
        assert_eq!(collection_costs_cents(1_000_000), 87_500);
        // 200,000: 875 + 1% of 190,000 = 1,900 -> 2,775.
        assert_eq!(collection_costs_cents(20_000_000), 277_500);
        // 1,000,000: 2,775 + 0.5% of 800,000 = 4,000 -> 6,775, the cap.
        assert_eq!(collection_costs_cents(100_000_000), 677_500);
        assert_eq!(collection_costs_cents(1_000_000_000), 677_500);
        assert_eq!(collection_costs_cents(0), 0);
        assert_eq!(collection_costs_cents(-5), 0);
    }

    #[test]
    fn interest_is_simple_and_per_day() {
        // 1,000 at 10.40% for 30 days = 8.5479 -> 8.55.
        assert_eq!(interest_cents(100_000, 10.40, 30), 855);
        assert_eq!(interest_cents(100_000, 10.40, 0), 0);
        assert_eq!(interest_cents(100_000, 0.0, 30), 0);
        // A full year.
        assert_eq!(interest_cents(100_000, 4.0, 365), 4_000);
    }

    #[test]
    fn b2b_claims_costs_and_commercial_interest_at_once() {
        let claim = statutory_claim(100_000, Debtor::Business, 40, None, &statutory());
        assert!(claim.costs_due);
        assert!(!claim.is_notice);
        assert_eq!(claim.costs, 15_000);
        // 1,000 x 10.40% x 40/365 = 11.40.
        assert_eq!(claim.interest, 1_140);
        assert_eq!(claim.total(), 100_000 + 15_000 + 1_140);
        assert_eq!(cents_text(claim.total()), "1161.40");
    }

    #[test]
    fn b2c_costs_wait_for_the_14_day_notice() {
        let s = statutory();
        // The final reminder is the notice: costs stated, not claimed, no interest yet.
        let notice = statutory_claim(100_000, Debtor::Consumer, 40, None, &s);
        assert!(notice.is_notice && !notice.costs_due);
        assert_eq!(notice.costs, 15_000);
        assert_eq!(notice.interest, 0);
        assert_eq!(notice.total(), 100_000);
        // Inside the term, nothing more is due.
        let inside = statutory_claim(100_000, Debtor::Consumer, 50, Some(14), &s);
        assert!(inside.is_notice && !inside.costs_due);
        // The term lapsed: 15 days after the notice the costs and the interest from then.
        let lapsed = statutory_claim(100_000, Debtor::Consumer, 60, Some(15), &s);
        assert!(lapsed.costs_due && !lapsed.is_notice);
        assert_eq!(lapsed.interest, interest_cents(100_000, 4.0, 1));
        assert_eq!(lapsed.total(), 100_000 + 15_000 + lapsed.interest);
    }

    #[test]
    fn interest_can_be_turned_off() {
        let mut s = statutory();
        s.interest = false;
        let claim = statutory_claim(100_000, Debtor::Business, 400, None, &s);
        assert_eq!(claim.interest, 0);
    }

    #[test]
    fn money_text_round_trips() {
        assert_eq!(cents_text(5), "0.05");
        assert_eq!(cents_text(-1_250), "-12.50");
        assert_eq!(parse_cents("12.5"), Some(1_250));
        assert_eq!(parse_cents("x"), None);
    }

    #[test]
    fn nothing_stored_is_the_default_workflow() {
        let settings = ReminderSettings::of(None);
        assert!(!settings.enabled);
        assert_eq!(settings.steps.len(), 3);
        assert_eq!(settings.due_step(0, 100), None, "off: nothing is due");
        assert_eq!(settings.final_level(), Some(3));
    }

    #[test]
    fn the_next_step_is_due_after_its_days() {
        let settings = ReminderSettings {
            enabled: true,
            ..ReminderSettings::default()
        };
        assert_eq!(settings.due_step(0, 6), None);
        assert_eq!(settings.due_step(0, 7).map(|s| s.level), Some(1));
        assert_eq!(settings.due_step(1, 20), None);
        assert_eq!(settings.due_step(1, 30).map(|s| s.level), Some(2));
        // A level that skipped ahead is not repeated, and the last step ends the workflow.
        assert_eq!(settings.due_step(3, 500), None);
        assert!(!settings.step(3).is_some_and(|s| s.auto));
    }

    #[test]
    fn a_patch_is_checked_and_keeps_the_rest() {
        let stored =
            json!({ "differences": { "roundingCap": "2.00" }, "reminders": { "enabled": true } });
        let patch = json!({ "steps": [
            { "level": 1, "daysAfterDue": 5, "auto": true, "template": "reminder1" },
            { "level": 2, "daysAfterDue": 10, "auto": false, "template": "reminder3", "final": true },
        ] });
        let out = merged(Some(&stored), patch.as_object().unwrap(), true).unwrap();
        assert_eq!(out["differences"]["roundingCap"], "2.00");
        let read = ReminderSettings::of(Some(&out));
        assert!(read.enabled);
        assert_eq!(read.steps.len(), 2);
        assert_eq!(read.final_level(), Some(2));
        for bad in [
            json!({ "steps": [] }),
            json!({ "steps": [{ "level": 2, "daysAfterDue": 5, "template": "reminder1" }] }),
            json!({ "steps": [
                { "level": 1, "daysAfterDue": 9, "template": "reminder1" },
                { "level": 2, "daysAfterDue": 9, "template": "reminder2" } ] }),
            json!({ "steps": [{ "level": 1, "daysAfterDue": 5, "template": "welcome" }] }),
            json!({ "enabled": "yes" }),
            json!({ "statutoryCosts": { "commercialRate": 250 } }),
        ] {
            assert!(
                merged(None, bad.as_object().unwrap(), true).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn statutory_costs_are_for_dutch_entities_only() {
        let patch = json!({ "statutoryCosts": { "enabled": true } });
        assert!(merged(None, patch.as_object().unwrap(), false).is_err());
        let out = merged(None, patch.as_object().unwrap(), true).unwrap();
        let read = ReminderSettings::of(Some(&out));
        assert!(read.statutory.enabled);
        assert!((read.statutory.commercial_rate - COMMERCIAL_RATE).abs() < f64::EPSILON);
        assert!(read.claims_statutory(read.step(3).unwrap()));
        assert!(!read.claims_statutory(read.step(1).unwrap()));
    }
}
