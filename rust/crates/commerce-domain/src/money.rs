//! Money as whole cents. The columns are `numeric(18, 2)`, the API speaks
//! decimal strings with two decimals (`"19.99"`), and every sum or share is
//! worked out in `i128` cents so nothing rounds twice.

/// An amount in cents (a percentage in hundredths of a percent).
pub type Cents = i128;

/// The largest amount a `numeric(18, 2)` column holds, in cents.
pub const MAX_CENTS: Cents = 999_999_999_999_999_999;

/// `"19.99"`, `"20"` or `"0.5"` as cents. A third decimal rounds half up.
/// `None` for anything but a non-negative decimal below [`MAX_CENTS`].
#[must_use]
pub fn parse(text: &str) -> Option<Cents> {
    let text = text.trim();
    let (whole, fraction) = match text.split_once('.') {
        Some((whole, fraction)) => (whole, fraction),
        None => (text, ""),
    };
    let digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || !digits(whole) || !digits(fraction) || whole.len() > 18 {
        return None;
    }
    let mut cents: Cents = whole.parse::<Cents>().ok()?.checked_mul(100)?;
    let mut fraction_digits = fraction.bytes().map(|b| Cents::from(b - b'0'));
    cents += fraction_digits.next().unwrap_or(0) * 10;
    cents += fraction_digits.next().unwrap_or(0);
    if fraction_digits.next().is_some_and(|third| third >= 5) {
        cents += 1;
    }
    (cents <= MAX_CENTS).then_some(cents)
}

/// Cents as `"19.99"` (`"-1.50"` below zero).
#[must_use]
pub fn format(cents: Cents) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let magnitude = cents.unsigned_abs();
    format!("{sign}{}.{:02}", magnitude / 100, magnitude % 100)
}

/// `numerator / denominator` rounded half away from zero (`denominator > 0`).
#[must_use]
pub fn div_round(numerator: Cents, denominator: Cents) -> Cents {
    let half = denominator / 2;
    if numerator >= 0 {
        (numerator + half) / denominator
    } else {
        (numerator - half) / denominator
    }
}

/// `percent` (in hundredths: `1250` is 12.5%) of `base`, rounded to a cent.
#[must_use]
pub fn percent_of(base: Cents, percent: Cents) -> Cents {
    div_round(base * percent, 10_000)
}

/// Share `total` out over `weights` in proportion, to the cent: the largest
/// remainders get the odd cents, so the parts always add up to `total` and no
/// part exceeds its weight when `total` is at most their sum.
#[must_use]
pub fn allocate(total: Cents, weights: &[Cents]) -> Vec<Cents> {
    let sum: Cents = weights.iter().sum();
    if sum <= 0 || total <= 0 {
        return vec![0; weights.len()];
    }
    let mut parts: Vec<Cents> = weights.iter().map(|w| total * w / sum).collect();
    let mut left = total - parts.iter().sum::<Cents>();
    let mut order: Vec<usize> = (0..weights.len()).collect();
    // Largest remainder first; ties to the earlier line.
    order.sort_by(|&a, &b| {
        let ra = total * weights[a] % sum;
        let rb = total * weights[b] % sum;
        rb.cmp(&ra).then(a.cmp(&b))
    });
    for index in order {
        if left == 0 {
            break;
        }
        if weights[index] > 0 {
            parts[index] += 1;
            left -= 1;
        }
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats() {
        assert_eq!(parse("19.99"), Some(1999));
        assert_eq!(parse("20"), Some(2000));
        assert_eq!(parse("0.5"), Some(50));
        assert_eq!(parse(" 7.005 "), Some(701));
        assert_eq!(parse("7.004"), Some(700));
        assert_eq!(parse("-1"), None);
        assert_eq!(parse("1e3"), None);
        assert_eq!(parse(""), None);
        assert_eq!(parse(".5"), None);
        assert_eq!(parse("9999999999999999.99"), Some(999_999_999_999_999_999));
        assert_eq!(parse("10000000000000000"), None);
        assert_eq!(format(1999), "19.99");
        assert_eq!(format(5), "0.05");
        assert_eq!(format(0), "0.00");
        assert_eq!(format(-150), "-1.50");
    }

    #[test]
    fn rounds_half_away_from_zero() {
        assert_eq!(div_round(5, 10), 1);
        assert_eq!(div_round(4, 10), 0);
        assert_eq!(div_round(-5, 10), -1);
        // 12.5% of 10.01 is 1.25125.
        assert_eq!(percent_of(1001, 1250), 125);
        // 10% of 0.05 is half a cent.
        assert_eq!(percent_of(5, 1000), 1);
    }

    #[test]
    fn shares_add_up() {
        assert_eq!(allocate(100, &[1000, 1000, 1000]), vec![34, 33, 33]);
        assert_eq!(allocate(0, &[1, 2]), vec![0, 0]);
        assert_eq!(allocate(5, &[0, 0]), vec![0, 0]);
        let parts = allocate(999, &[333, 333, 334]);
        assert_eq!(parts.iter().sum::<Cents>(), 999);
        // The whole base goes back line for line.
        assert_eq!(allocate(700, &[200, 500]), vec![200, 500]);
        // Never more than a line holds.
        for total in 0..=30 {
            let weights = [7, 11, 12];
            let parts = allocate(total, &weights);
            assert_eq!(parts.iter().sum::<Cents>(), total);
            assert!(parts.iter().zip(weights).all(|(p, w)| *p <= w));
        }
    }
}
