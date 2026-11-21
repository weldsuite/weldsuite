//! An order's amounts: the pure sums.
//!
//! `subtotal` is quantity times unit price before any discount;
//! `discount_total` the item discounts; `total` is
//! `subtotal - discount_total + shipping_total + tax_total`. Phase 2 computes
//! no VAT, so `tax_total` is zero and an item's `total` is
//! `quantity * unit_price - discount`.

use crate::money::Cents;

/// A line as the totals see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Line {
    pub quantity: i64,
    pub unit_price: Cents,
    /// The share of the order's discount this line carries.
    pub discount: Cents,
}

impl Line {
    /// Before discount: `quantity * unit_price`.
    #[must_use]
    pub fn gross(&self) -> Cents {
        Cents::from(self.quantity) * self.unit_price
    }

    /// The item's `total`: `gross - discount`.
    #[must_use]
    pub fn total(&self) -> Cents {
        self.gross() - self.discount
    }
}

/// The order's amounts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Totals {
    pub subtotal: Cents,
    pub discount_total: Cents,
    pub shipping_total: Cents,
    pub tax_total: Cents,
    pub total: Cents,
}

/// `lines` and the (already discounted) `shipping` as order amounts.
#[must_use]
pub fn totals(lines: &[Line], shipping: Cents) -> Totals {
    let subtotal: Cents = lines.iter().map(Line::gross).sum();
    let discount_total: Cents = lines.iter().map(|l| l.discount).sum();
    let tax_total = 0;
    Totals {
        subtotal,
        discount_total,
        shipping_total: shipping,
        tax_total,
        total: subtotal - discount_total + shipping + tax_total,
    }
}

/// `(item_count, total_quantity)` for `quantities`.
#[must_use]
pub fn counts(quantities: &[i64]) -> (i64, i64) {
    (
        i64::try_from(quantities.len()).unwrap_or(i64::MAX),
        quantities.iter().sum(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_up() {
        let lines = [
            Line {
                quantity: 2,
                unit_price: 1999,
                discount: 400,
            },
            Line {
                quantity: 1,
                unit_price: 500,
                discount: 0,
            },
        ];
        assert_eq!(lines[0].total(), 3598);
        let t = totals(&lines, 495);
        assert_eq!(t.subtotal, 4498);
        assert_eq!(t.discount_total, 400);
        assert_eq!(t.shipping_total, 495);
        assert_eq!(t.tax_total, 0);
        assert_eq!(t.total, 4593);
        assert_eq!(counts(&[2, 1]), (2, 3));
    }
}
