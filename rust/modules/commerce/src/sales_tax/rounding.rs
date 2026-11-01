//! `@weldsuite/books-domain/sales-tax/rounding` (what commerce reads of it):
//! dollars to whole cents half away from zero, the largest-remainder split,
//! and the invoice-level per-jurisdiction rounding every US state uses
//! (`us/states.ts` gives each of them the SST rule).

/// Absorbs binary floating point error (0.285 is 0.28499999999999998)
/// without moving a real half cent.
const EPSILON: f64 = 1e-9;

/// `toCents(value)`: dollars to whole cents, half away from zero.
#[allow(clippy::cast_possible_truncation)] // whole cents of money amounts
pub(crate) fn to_cents(value: f64) -> i64 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    let cents = (value.abs() * 100.0 + 0.5 + EPSILON).floor();
    if cents == 0.0 {
        return 0;
    }
    let cents = cents as i64;
    if value < 0.0 { -cents } else { cents }
}

/// `fromCents(cents)`.
#[allow(clippy::cast_precision_loss)] // whole cents of money amounts
pub(crate) fn from_cents(cents: i64) -> f64 {
    if cents == 0 {
        0.0
    } else {
        cents as f64 / 100.0
    }
}

/// `snap6(value)`: six decimals, the precision `tax_lines` stores.
pub(crate) fn snap6(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    let micro = crate::js::math_round(value * 1_000_000.0);
    if micro == 0.0 {
        0.0
    } else {
        micro / 1_000_000.0
    }
}

/// `allocateCents(totalCents, weights)`: the largest-remainder split, so
/// the parts add up to the total exactly; equal shares when every weight is
/// zero, ties to the earlier entry.
#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
pub(crate) fn allocate_cents(total_cents: i64, weights: &[f64]) -> Vec<i64> {
    let n = weights.len();
    if n == 0 {
        return Vec::new();
    }
    let sign = if total_cents < 0 { -1 } else { 1 };
    let total = total_cents.abs() as f64;
    let mut w: Vec<f64> = weights.iter().map(|x| x.abs()).collect();
    let mut sum = w.iter().fold(0.0, |a, b| a + b);
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
    order.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    let mut k = 0;
    while remainder > 0 && k < order.len() * 2 {
        floors[order[k % order.len()].0] += 1;
        remainder -= 1;
        k += 1;
    }
    let mut k = order.len();
    while remainder < 0 && k > 0 {
        k -= 1;
        let idx = order[k].0;
        if floors[idx] > 0 {
            floors[idx] -= 1;
            remainder += 1;
        }
    }
    floors
        .into_iter()
        .map(|f| if f == 0 { 0 } else { sign * f })
        .collect()
}

/// A (line, jurisdiction) cell of a document's tax (`TaxCell`).
pub(crate) struct TaxCell {
    pub(crate) jurisdiction_key: String,
    pub(crate) unrounded: f64,
}

/// `roundTaxCells(cells, { level: 'invoice', scope: 'per_jurisdiction' })`:
/// one rounding per jurisdiction over the whole document, the difference
/// on the jurisdiction's last line. Whole cents in cell order.
pub(crate) fn round_tax_cells(cells: &[TaxCell]) -> Vec<i64> {
    let mut out = vec![0; cells.len()];
    let mut groups: Vec<(&str, Vec<usize>)> = Vec::new();
    for (i, cell) in cells.iter().enumerate() {
        match groups
            .iter_mut()
            .find(|(key, _)| *key == cell.jurisdiction_key)
        {
            Some((_, list)) => list.push(i),
            None => groups.push((&cell.jurisdiction_key, vec![i])),
        }
    }
    for (_, indexes) in groups {
        let total = to_cents(indexes.iter().fold(0.0, |s, i| s + cells[*i].unrounded));
        let mut assigned = 0;
        for (k, cell_index) in indexes.iter().enumerate() {
            if k == indexes.len() - 1 {
                out[*cell_index] = total - assigned;
            } else {
                out[*cell_index] = to_cents(cells[*cell_index].unrounded);
                assigned += out[*cell_index];
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_like_the_books_domain() {
        assert_eq!(to_cents(0.285), 29);
        assert_eq!(to_cents(-1.005), -101);
        assert_eq!(to_cents(8.25), 825);
        assert!((from_cents(908) - 9.08).abs() < f64::EPSILON);
        assert_eq!(allocate_cents(100, &[1.0, 1.0, 1.0]), vec![34, 33, 33]);
        assert_eq!(allocate_cents(-5, &[0.0, 0.0]), vec![-3, -2]);
        assert!((snap6(1.234_567_89) - 1.234_568).abs() < 1e-12);
        let cells = [
            TaxCell {
                jurisdiction_key: "a".into(),
                unrounded: 0.004,
            },
            TaxCell {
                jurisdiction_key: "a".into(),
                unrounded: 0.004,
            },
        ];
        assert_eq!(round_tax_cells(&cells), vec![0, 1]);
    }
}
