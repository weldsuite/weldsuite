//! Risk rules (`@weldsuite/flow-domain/risk`): score, band, review interval
//! and input checks of the RAID log's risks (design:
//! weldflow-project-control.md, "Data model").
//!
//! ```text
//! score = probability × impact, both whole numbers from 1 to 5
//!
//! Band      Scores   Review every
//! Low       1–4      90 days
//! Medium    5–9      30 days
//! High      10–16    14 days
//! Critical  20–25    7 days
//! ```
//!
//! Where TypeScript throws a `RangeError` (a rating or score off the scale),
//! these answer `None`: the database's checks keep such values out.

use serde_json::Value;

pub const RATING_MIN: i64 = 1;
pub const RATING_MAX: i64 = 5;
pub const MAX_RISK_SCORE: i64 = RATING_MAX * RATING_MAX;

const DAY_MS: i64 = 86_400_000;

/// A risk band (`RISK_BANDS`, in that order).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RiskBand {
    Low,
    Medium,
    High,
    Critical,
}

/// `RISK_BANDS`.
pub const RISK_BANDS: [&str; 4] = ["low", "medium", "high", "critical"];

impl RiskBand {
    pub const ALL: [Self; 4] = [Self::Low, Self::Medium, Self::High, Self::Critical];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|band| band.as_str() == text)
    }

    /// `RISK_BAND_RANGES[band]`: the scores of the band, both ends included.
    /// 17–19 cannot occur (no two ratings multiply to them); critical starts
    /// at 17 only so that no integer score falls between two bands.
    pub const fn range(self) -> (i64, i64) {
        match self {
            Self::Low => (1, 4),
            Self::Medium => (5, 9),
            Self::High => (10, 16),
            Self::Critical => (17, MAX_RISK_SCORE),
        }
    }

    /// `DEFAULT_REVIEW_INTERVAL_DAYS[band]`.
    pub const fn default_review_interval_days(self) -> i64 {
        match self {
            Self::Critical => 7,
            Self::High => 14,
            Self::Medium => 30,
            Self::Low => 90,
        }
    }
}

/// `isRating(value)`: a whole number from 1 to 5.
pub fn is_rating(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.fract() == 0.0 && (1.0..=5.0).contains(&n))
}

/// `ratingError(field, value)`: the 400 message for a bad probability or
/// impact, or `None` when it is fine.
pub fn rating_error(field: &str, value: &Value) -> Option<String> {
    (!is_rating(value))
        .then(|| format!("{field} must be a whole number from {RATING_MIN} to {RATING_MAX}"))
}

fn rating(value: i64) -> bool {
    (RATING_MIN..=RATING_MAX).contains(&value)
}

/// `riskScore(probability, impact)`: `None` off the 1–5 scale.
pub fn risk_score(probability: i64, impact: i64) -> Option<i64> {
    (rating(probability) && rating(impact)).then_some(probability * impact)
}

/// `riskBand(score)`: `None` outside 1–25.
pub fn risk_band(score: i64) -> Option<RiskBand> {
    if !(1..=MAX_RISK_SCORE).contains(&score) {
        return None;
    }
    Some(if score <= RiskBand::Low.range().1 {
        RiskBand::Low
    } else if score <= RiskBand::Medium.range().1 {
        RiskBand::Medium
    } else if score <= RiskBand::High.range().1 {
        RiskBand::High
    } else {
        RiskBand::Critical
    })
}

/// `reviewIntervalDays(band, override)`: the risk's own interval when it
/// has one, else the band's default.
pub fn review_interval_days(band: RiskBand, own: Option<i64>) -> i64 {
    own.unwrap_or_else(|| band.default_review_interval_days())
}

/// `nextReviewAt(from, band, override)` in epoch milliseconds: `from` plus
/// the review interval, in whole days.
pub fn next_review_at_ms(from_ms: i64, band: RiskBand, own: Option<i64>) -> i64 {
    from_ms + review_interval_days(band, own) * DAY_MS
}

/// `movedIntoCritical(previousScore, nextScore)`: the move puts a risk into
/// the critical band from a lower one.
pub fn moved_into_critical(previous_score: i64, next_score: i64) -> bool {
    risk_band(next_score) == Some(RiskBand::Critical)
        && risk_band(previous_score) != Some(RiskBand::Critical)
}

/// `residualPairError(residualProbability, residualImpact)`: only one of the
/// two is set (a null is "not assessed").
pub fn residual_pair_error(
    residual_probability: Option<i64>,
    residual_impact: Option<i64>,
) -> Option<&'static str> {
    (residual_probability.is_some() != residual_impact.is_some())
        .then_some("residualProbability and residualImpact must be set together")
}

/// One cell of the 5×5 matrix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MatrixCell {
    pub probability: i64,
    pub impact: i64,
    pub count: i64,
}

/// `buildRiskMatrix(counts)`: 25 cells, probability then impact ascending,
/// with the counts given filled in and every other cell at 0.
pub fn build_risk_matrix(counts: &[MatrixCell]) -> Vec<MatrixCell> {
    let mut cells = Vec::with_capacity(25);
    for probability in RATING_MIN..=RATING_MAX {
        for impact in RATING_MIN..=RATING_MAX {
            let count = counts
                .iter()
                .find(|cell| cell.probability == probability && cell.impact == impact)
                .map_or(0, |cell| cell.count);
            cells.push(MatrixCell {
                probability,
                impact,
                count,
            });
        }
    }
    cells
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::js::{iso_from_millis, millis_of};

    #[test]
    fn score_multiplies_probability_by_impact() {
        assert_eq!(risk_score(1, 1), Some(1));
        assert_eq!(risk_score(2, 3), Some(6));
        assert_eq!(risk_score(5, 5), Some(25));
        assert_eq!(risk_score(0, 3), None);
        assert_eq!(risk_score(3, 6), None);
    }

    #[test]
    fn every_possible_score_has_its_band() {
        let mut seen = std::collections::BTreeMap::new();
        for p in 1..=5 {
            for i in 1..=5 {
                seen.insert(p * i, risk_band(p * i).map(RiskBand::as_str));
            }
        }
        let expected: Vec<(i64, &str)> = vec![
            (1, "low"),
            (2, "low"),
            (3, "low"),
            (4, "low"),
            (5, "medium"),
            (6, "medium"),
            (8, "medium"),
            (9, "medium"),
            (10, "high"),
            (12, "high"),
            (15, "high"),
            (16, "high"),
            (20, "critical"),
            (25, "critical"),
        ];
        assert_eq!(
            seen.into_iter()
                .map(|(score, band)| (score, band.unwrap_or_default()))
                .collect::<Vec<_>>(),
            expected
        );
    }

    #[test]
    fn band_edges_hold_and_leave_no_gap() {
        assert_eq!(risk_band(4), Some(RiskBand::Low));
        assert_eq!(risk_band(5), Some(RiskBand::Medium));
        assert_eq!(risk_band(9), Some(RiskBand::Medium));
        assert_eq!(risk_band(10), Some(RiskBand::High));
        assert_eq!(risk_band(16), Some(RiskBand::High));
        assert_eq!(risk_band(20), Some(RiskBand::Critical));
        assert_eq!(risk_band(0), None);
        assert_eq!(risk_band(26), None);
        for score in 1..=25 {
            let bands = RiskBand::ALL
                .iter()
                .filter(|band| {
                    let (min, max) = band.range();
                    score >= min && score <= max
                })
                .count();
            assert_eq!(bands, 1, "score {score}");
        }
        assert_eq!(
            RiskBand::ALL.map(RiskBand::as_str),
            RISK_BANDS,
            "RISK_BANDS order"
        );
    }

    #[test]
    fn review_interval_is_the_risks_own_or_the_bands() {
        assert_eq!(
            RiskBand::ALL.map(RiskBand::default_review_interval_days),
            [90, 30, 14, 7]
        );
        assert_eq!(review_interval_days(RiskBand::High, None), 14);
        assert_eq!(review_interval_days(RiskBand::High, Some(3)), 3);
        let from = millis_of("2026-11-03T09:00:00.000Z").expect("date");
        let at = |band, own| iso_from_millis(next_review_at_ms(from, band, own));
        assert_eq!(
            at(RiskBand::Critical, None).as_deref(),
            Some("2026-11-10T09:00:00.000Z")
        );
        assert_eq!(
            at(RiskBand::Low, None).as_deref(),
            Some("2027-02-01T09:00:00.000Z")
        );
        assert_eq!(
            at(RiskBand::Medium, Some(2)).as_deref(),
            Some("2026-11-05T09:00:00.000Z")
        );
    }

    #[test]
    fn only_a_move_from_below_into_critical_escalates() {
        assert!(moved_into_critical(16, 20));
        assert!(moved_into_critical(1, 25));
        assert!(!moved_into_critical(20, 25));
        assert!(!moved_into_critical(25, 20));
        assert!(!moved_into_critical(25, 16));
        assert!(!moved_into_critical(4, 9));
    }

    #[test]
    fn ratings_and_residual_pairs_are_checked() {
        let checked: Vec<bool> = [
            json!(0),
            json!(1),
            json!(5),
            json!(6),
            json!(2.5),
            json!("3"),
            Value::Null,
        ]
        .iter()
        .map(is_rating)
        .collect();
        assert_eq!(checked, [false, true, true, false, false, false, false]);
        assert_eq!(rating_error("probability", &json!(3)), None);
        assert_eq!(
            rating_error("impact", &json!(6)).as_deref(),
            Some("impact must be a whole number from 1 to 5")
        );
        assert_eq!(residual_pair_error(None, None), None);
        assert_eq!(residual_pair_error(Some(2), Some(3)), None);
        assert_eq!(
            residual_pair_error(Some(2), None),
            Some("residualProbability and residualImpact must be set together")
        );
        assert_eq!(
            residual_pair_error(None, Some(3)),
            Some("residualProbability and residualImpact must be set together")
        );
    }

    #[test]
    fn the_matrix_has_25_cells_in_order() {
        let cells = build_risk_matrix(&[MatrixCell {
            probability: 3,
            impact: 4,
            count: 2,
        }]);
        assert_eq!(cells.len(), 25);
        assert_eq!(
            cells[0],
            MatrixCell {
                probability: 1,
                impact: 1,
                count: 0
            }
        );
        assert_eq!((cells[1].probability, cells[1].impact), (1, 2));
        assert_eq!((cells[24].probability, cells[24].impact), (5, 5));
        assert_eq!(
            cells
                .iter()
                .find(|c| c.probability == 3 && c.impact == 4)
                .map(|c| c.count),
            Some(2)
        );
        assert_eq!(cells.iter().map(|c| c.count).sum::<i64>(), 2);
    }
}
