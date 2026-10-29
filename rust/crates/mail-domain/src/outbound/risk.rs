//! Workspace risk score (0–100) from the ledger's aggregates
//! (`outbound/risk.ts`). Pure.

use super::limits::{TrustLevel, thresholds};

/// `RiskInput`.
#[derive(Debug, Clone, Copy)]
pub struct RiskInput {
    pub trust_level: TrustLevel,
    pub recipients_day: i64,
    pub first_contact_day: i64,
    pub automated_day: i64,
    pub flagged_sends_day: i64,
    pub sends_day: i64,
    pub top_template_first_contact: i64,
    pub recipients_7d: i64,
    pub hard_bounces_7d: i64,
    pub complaints_7d: i64,
    pub cold_templates: i64,
    pub phishing_verdict: bool,
}

/// `RiskResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct RiskResult {
    pub score: i64,
    pub reasons: Vec<String>,
    pub hard_bounce_rate_7d: Option<f64>,
    pub complaint_rate_7d: Option<f64>,
}

#[allow(clippy::cast_precision_loss)]
fn ratio(a: i64, b: i64) -> f64 {
    a as f64 / b as f64
}

/// JavaScript's `Math.round` for non-negative values.
#[allow(clippy::cast_possible_truncation)]
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// `Number.prototype.toFixed(digits)` for the small, non-negative values here.
pub(crate) fn to_fixed(value: f64, digits: usize) -> String {
    format!("{value:.digits$}")
}

fn first_contact_share(input: &RiskInput) -> Option<(i64, String)> {
    if input.recipients_day < 20 {
        return None;
    }
    let share = ratio(input.first_contact_day, input.recipients_day);
    let points = js_round(share * 30.0);
    (points > 0).then(|| {
        (
            points,
            format!("first_contact_share:{}", to_fixed(share, 2)),
        )
    })
}

fn template_reach(input: &RiskInput) -> Option<(i64, String)> {
    let reach = input.top_template_first_contact;
    if reach < thresholds::REVIEW_FIRST_CONTACT_RECIPIENTS {
        return None;
    }
    let points = if reach >= 50 {
        30
    } else if reach >= thresholds::COLD_TEMPLATE_FIRST_CONTACT_PER_DAY {
        20
    } else {
        10
    };
    Some((points, format!("template_first_contact:{reach}")))
}

fn hard_bounces(rate: Option<f64>) -> Option<(i64, String)> {
    let rate = rate.filter(|rate| *rate > 0.02)?;
    let points = if rate > 0.1 {
        35
    } else if rate > thresholds::HARD_BOUNCE_RATE {
        25
    } else {
        10
    };
    Some((points, format!("hard_bounce_rate:{}", to_fixed(rate, 3))))
}

fn complaints(input: &RiskInput) -> Option<(i64, String)> {
    if input.complaints_7d == 0 {
        return None;
    }
    let points = if input.complaints_7d >= thresholds::COMPLAINTS_7D {
        30
    } else {
        10
    };
    Some((points, format!("complaints:{}", input.complaints_7d)))
}

fn flagged_content(input: &RiskInput) -> Option<(i64, String)> {
    (input.sends_day >= 10 && ratio(input.flagged_sends_day, input.sends_day) > 0.3)
        .then(|| (10, "flagged_content".to_owned()))
}

fn automated_first_contact(input: &RiskInput) -> Option<(i64, String)> {
    (input.recipients_day >= 20
        && ratio(input.automated_day, input.recipients_day) > 0.5
        && ratio(input.first_contact_day, input.recipients_day) > 0.5)
        .then(|| (10, "automated_first_contact".to_owned()))
}

fn cold_templates(input: &RiskInput) -> Option<(i64, String)> {
    (input.cold_templates > 0).then(|| (15, format!("cold_templates:{}", input.cold_templates)))
}

fn trust_weight(trust: TrustLevel) -> f64 {
    match trust {
        TrustLevel::New => 1.2,
        TrustLevel::Standard => 1.0,
        TrustLevel::Trusted => 0.8,
    }
}

/// `computeRisk(input)`.
pub fn compute_risk(input: &RiskInput) -> RiskResult {
    let (hard_bounce_rate_7d, complaint_rate_7d) =
        if input.recipients_7d < thresholds::HARD_BOUNCE_MIN_RECIPIENTS {
            (None, None)
        } else {
            (
                Some(ratio(input.hard_bounces_7d, input.recipients_7d)),
                Some(ratio(input.complaints_7d, input.recipients_7d)),
            )
        };
    if input.phishing_verdict {
        return RiskResult {
            score: 100,
            reasons: vec!["phishing_verdict".to_owned()],
            hard_bounce_rate_7d,
            complaint_rate_7d,
        };
    }
    let signals = [
        first_contact_share(input),
        template_reach(input),
        hard_bounces(hard_bounce_rate_7d),
        complaints(input),
        flagged_content(input),
        automated_first_contact(input),
        cold_templates(input),
    ];
    let points: i64 = signals.iter().flatten().map(|(points, _)| points).sum();
    #[allow(clippy::cast_precision_loss)]
    let raw = points as f64 * trust_weight(input.trust_level);
    RiskResult {
        score: js_round(raw).min(100),
        reasons: signals
            .into_iter()
            .flatten()
            .map(|(_, reason)| reason)
            .collect(),
        hard_bounce_rate_7d,
        complaint_rate_7d,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> RiskInput {
        RiskInput {
            trust_level: TrustLevel::Standard,
            recipients_day: 0,
            first_contact_day: 0,
            automated_day: 0,
            flagged_sends_day: 0,
            sends_day: 0,
            top_template_first_contact: 0,
            recipients_7d: 0,
            hard_bounces_7d: 0,
            complaints_7d: 0,
            cold_templates: 0,
            phishing_verdict: false,
        }
    }

    #[test]
    fn quiet_workspaces_score_zero() {
        assert_eq!(compute_risk(&input()).score, 0);
        assert_eq!(compute_risk(&input()).hard_bounce_rate_7d, None);
    }

    #[test]
    fn signals_add_up_and_trust_weighs_them() {
        let busy = RiskInput {
            trust_level: TrustLevel::New,
            recipients_day: 100,
            first_contact_day: 90,
            top_template_first_contact: 30,
            recipients_7d: 100,
            hard_bounces_7d: 8,
            ..input()
        };
        let risk = compute_risk(&busy);
        // (27 + 20 + 25) * 1.2 = 86.4
        assert_eq!(risk.score, 86);
        assert_eq!(
            risk.reasons,
            [
                "first_contact_share:0.90",
                "template_first_contact:30",
                "hard_bounce_rate:0.080"
            ]
        );
        let phishing = RiskInput {
            phishing_verdict: true,
            ..input()
        };
        assert_eq!(compute_risk(&phishing).score, 100);
    }
}
