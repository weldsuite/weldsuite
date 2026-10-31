//! Sales tax rounding (`sales-tax/rounding.ts`): everything that decides a
//! cent is computed on whole cents, so binary floating point never moves a
//! half cent.

/// Absorbs binary floating point error (0.285 is 0.28499999999999998)
/// without moving a real half cent.
const EPSILON: f64 = 1e-9;

/// `toCents(value)`: dollars to whole cents, half away from zero.
pub fn to_cents(value: f64) -> i64 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    #[allow(clippy::cast_possible_truncation)]
    let cents = (value.abs() * 100.0 + 0.5 + EPSILON).floor() as i64;
    if cents == 0 {
        return 0;
    }
    if value < 0.0 { -cents } else { cents }
}

/// `fromCents(cents)`.
#[allow(clippy::cast_precision_loss)]
pub fn from_cents(cents: i64) -> f64 {
    if cents == 0 {
        0.0
    } else {
        cents as f64 / 100.0
    }
}

/// `roundHalfUp(value, decimals)`: half away from zero.
pub fn round_half_up(value: f64, decimals: i32) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return 0.0;
    }
    let factor = 10f64.powi(decimals.clamp(0, 8));
    let rounded = (value.abs() * factor + 0.5 + EPSILON).floor() / factor;
    if rounded == 0.0 {
        return 0.0;
    }
    if value < 0.0 { -rounded } else { rounded }
}

/// `allocateCents(totalCents, weights)`: split a whole-cent total over
/// weights with the largest-remainder method, so the parts add up exactly.
/// Equal shares when every weight is zero; ties go to the earlier entry.
#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
pub fn allocate_cents(total_cents: i64, weights: &[f64]) -> Vec<i64> {
    let n = weights.len();
    if n == 0 {
        return Vec::new();
    }
    let sign = if total_cents < 0 { -1 } else { 1 };
    let total = total_cents.unsigned_abs() as f64;
    let mut w: Vec<f64> = weights.iter().map(|x| x.abs()).collect();
    let mut sum: f64 = w.iter().sum();
    if sum <= 0.0 {
        w = vec![1.0; n];
        sum = n as f64;
    }
    let shares: Vec<f64> = w.iter().map(|x| (total * x) / sum).collect();
    let mut floors: Vec<i64> = shares.iter().map(|s| (s + 1e-9).floor() as i64).collect();
    let mut remainder = total as i64 - floors.iter().sum::<i64>();
    let mut order: Vec<(usize, f64)> = shares
        .iter()
        .enumerate()
        .map(|(index, s)| (index, s - (s + 1e-9).floor()))
        .collect();
    // `b.frac - a.frac || a.index - b.index`: a stable sort on the fraction.
    order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut k = 0;
    while remainder > 0 && k < order.len() * 2 {
        floors[order[k % order.len()].0] += 1;
        remainder -= 1;
        k += 1;
    }
    // Never hand out more than the total.
    let mut k = order.len();
    while remainder < 0 && k > 0 {
        k -= 1;
        let index = order[k].0;
        if floors[index] > 0 {
            floors[index] -= 1;
            remainder += 1;
        }
    }
    floors
        .into_iter()
        .map(|f| if f == 0 { 0 } else { sign * f })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cents_round_half_away_from_zero() {
        assert_eq!(to_cents(0.285), 29);
        assert_eq!(to_cents(-0.285), -29);
        assert_eq!(to_cents(1.004), 100);
        assert!((from_cents(-150) + 1.5).abs() < f64::EPSILON);
        assert!((round_half_up(2.345, 2) - 2.35).abs() < 1e-12);
        assert!((round_half_up(-2.345, 2) + 2.35).abs() < 1e-12);
    }

    #[test]
    fn allocation_adds_up_with_ties_to_the_earlier_entry() {
        assert_eq!(allocate_cents(100, &[1.0, 1.0, 1.0]), vec![34, 33, 33]);
        assert_eq!(allocate_cents(-100, &[1.0, 1.0, 1.0]), vec![-34, -33, -33]);
        assert_eq!(allocate_cents(10, &[0.0, 0.0]), vec![5, 5]);
        assert_eq!(allocate_cents(7, &[]), Vec::<i64>::new());
        assert_eq!(allocate_cents(1001, &[300.0, 700.0]), vec![300, 701]);
    }
}
