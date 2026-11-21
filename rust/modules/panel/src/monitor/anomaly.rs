//! Anomaly bands for alerts (`services/anomaly.ts`): robust statistics, so
//! one spike in the baseline does not widen the band the way a standard
//! deviation would.
//!
//! ```text
//! band = median ± k · 1.4826 · MAD
//! ```
//!
//! MAD is the median absolute deviation from the median; 1.4826 scales it to
//! a standard deviation for normally distributed data. k is 4, 3 or 2 for
//! low, medium and high sensitivity. Fewer than [`MIN_BASELINE_POINTS`]
//! points: no band (the check is skipped, never guessed).

pub(crate) const MIN_BASELINE_POINTS: usize = 7;

/// The scale that makes a MAD comparable to a standard deviation.
pub(crate) const MAD_SCALE: f64 = 1.4826;

/// `SENSITIVITY_K`.
pub(crate) fn sensitivity_k(sensitivity: &str) -> f64 {
    match sensitivity {
        "low" => 4.0,
        "high" => 2.0,
        _ => 3.0,
    }
}

/// `median(values)`: NaN without values.
pub(crate) fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        // `(a + b) / 2`, rounded as JavaScript rounds it.
        #[allow(clippy::manual_midpoint)]
        let mean = (sorted[mid - 1] + sorted[mid]) / 2.0;
        mean
    }
}

/// `medianAbsoluteDeviation(values)`.
pub(crate) fn median_absolute_deviation(values: &[f64]) -> f64 {
    let m = median(values);
    let deviations: Vec<f64> = values.iter().map(|v| (v - m).abs()).collect();
    median(&deviations)
}

/// `AnomalyBand`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct AnomalyBand {
    pub(crate) median: f64,
    /// The scaled MAD (k · 1.4826 · MAD).
    pub(crate) spread: f64,
    pub(crate) lower: f64,
    pub(crate) upper: f64,
}

/// `anomalyBand(baseline, sensitivity)`: `None` with too few finite points.
pub(crate) fn anomaly_band(baseline: &[f64], sensitivity: &str) -> Option<AnomalyBand> {
    let points: Vec<f64> = baseline.iter().copied().filter(|v| v.is_finite()).collect();
    if points.len() < MIN_BASELINE_POINTS {
        return None;
    }
    let m = median(&points);
    let spread = sensitivity_k(sensitivity) * MAD_SCALE * median_absolute_deviation(&points);
    Some(AnomalyBand {
        median: m,
        spread,
        lower: m - spread,
        upper: m + spread,
    })
}

/// `outsideBand(value, band)`: whether `value` left the band, and the edge.
pub(crate) fn outside_band(value: f64, band: &AnomalyBand) -> (bool, f64) {
    if value > band.upper {
        return (true, band.upper);
    }
    if value < band.lower {
        return (true, band.lower);
    }
    (
        false,
        if value >= band.median {
            band.upper
        } else {
            band.lower
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASELINE: [f64; 10] = [
        100.0, 102.0, 98.0, 101.0, 99.0, 103.0, 97.0, 100.0, 100.0, 101.0,
    ];

    // `anomaly.test.ts`: median and MAD.
    #[test]
    fn takes_the_middle_value_or_the_mean_of_the_two_middle_ones() {
        assert!((median(&[5.0, 1.0, 3.0]) - 3.0).abs() < f64::EPSILON);
        assert!((median(&[4.0, 1.0, 3.0, 2.0]) - 2.5).abs() < f64::EPSILON);
        assert!(median(&[]).is_nan());
    }

    #[test]
    fn measures_spread_around_the_median() {
        assert!((median_absolute_deviation(&[1.0, 2.0, 3.0, 4.0, 5.0]) - 1.0).abs() < f64::EPSILON);
        assert!(median_absolute_deviation(&[7.0, 7.0, 7.0]).abs() < f64::EPSILON);
    }

    // anomalyBand.
    #[test]
    fn is_median_plus_minus_k_mad_by_sensitivity() {
        let mad = median_absolute_deviation(&BASELINE);
        let m = median(&BASELINE);
        for (sensitivity, k) in [("low", 4.0), ("medium", 3.0), ("high", 2.0)] {
            let band = anomaly_band(&BASELINE, sensitivity).expect("band");
            assert!((band.median - m).abs() < 1e-10);
            assert!((band.spread - k * MAD_SCALE * mad).abs() < 1e-10);
            assert!((band.lower - (m - k * MAD_SCALE * mad)).abs() < 1e-10);
            assert!((band.upper - (m + k * MAD_SCALE * mad)).abs() < 1e-10);
        }
    }

    #[test]
    fn is_skipped_below_seven_points() {
        assert_eq!(MIN_BASELINE_POINTS, 7);
        assert!(anomaly_band(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], "medium").is_none());
        assert!(anomaly_band(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, f64::NAN], "medium").is_none());
        assert!(anomaly_band(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0], "medium").is_some());
    }

    #[test]
    fn is_not_widened_by_one_spike_in_the_baseline() {
        let mut spiky = BASELINE[..9].to_vec();
        spiky.push(5000.0);
        assert!(anomaly_band(&spiky, "medium").expect("band").upper < 110.0);
    }

    #[test]
    fn says_which_edge_a_value_crossed() {
        let band = anomaly_band(&BASELINE, "high").expect("band");
        assert_eq!(outside_band(150.0, &band), (true, band.upper));
        assert_eq!(outside_band(50.0, &band), (true, band.lower));
        assert!(!outside_band(100.0, &band).0);
    }

    #[test]
    fn fires_on_any_move_away_from_a_flat_baseline() {
        let band = anomaly_band(&[0.0; 7], "low").expect("band");
        assert!(outside_band(1.0, &band).0);
        assert!(!outside_band(0.0, &band).0);
    }
}
