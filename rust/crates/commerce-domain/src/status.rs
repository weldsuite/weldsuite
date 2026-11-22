//! An order's lifecycle: which changes it still accepts.
//!
//! `status` moves forward only (`pending` to `confirmed` to `processing` to
//! `completed`); `cancelled` is reached through the cancel action alone.
//! `payment_status` is the payment's, `fulfillment_status` WeldStash's
//! (STASH-001/006): the rules here read it and never decide it.

/// The statuses a patch may move an order through, in order.
const FLOW: [&str; 4] = ["pending", "confirmed", "processing", "completed"];

/// What an order's editability depends on.
#[derive(Debug, Clone, Copy)]
pub struct Facts<'a> {
    pub status: &'a str,
    pub payment_status: &'a str,
    /// Some item has `fulfilled_quantity > 0`.
    pub any_fulfilled: bool,
}

/// A payment that was made: `paid` and what follows it.
#[must_use]
pub fn is_paid(payment_status: &str) -> bool {
    matches!(payment_status, "paid" | "partially_refunded" | "refunded")
}

fn closed(status: &str) -> bool {
    matches!(status, "cancelled" | "completed")
}

/// Items and customer may still change: not cancelled or completed, not
/// paid, and nothing fulfilled.
#[must_use]
pub fn editable(facts: Facts<'_>) -> bool {
    !closed(facts.status) && !is_paid(facts.payment_status) && !facts.any_fulfilled
}

/// May still be cancelled: not cancelled or completed, nothing fulfilled.
#[must_use]
pub fn cancellable(facts: Facts<'_>) -> bool {
    !closed(facts.status) && !facts.any_fulfilled
}

/// Whether a patch may take an order from `from` to `to`: the same status,
/// or further along the flow. `cancelled` is never a target here, and
/// neither `cancelled` nor `completed` is left.
#[must_use]
pub fn can_move(from: &str, to: &str) -> bool {
    if from == to {
        return FLOW.contains(&to) || to == "cancelled";
    }
    let (Some(a), Some(b)) = (
        FLOW.iter().position(|s| *s == from),
        FLOW.iter().position(|s| *s == to),
    ) else {
        return false;
    };
    b > a
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>(status: &'a str, payment: &'a str, fulfilled: bool) -> Facts<'a> {
        Facts {
            status,
            payment_status: payment,
            any_fulfilled: fulfilled,
        }
    }

    #[test]
    fn editable_until_closed_paid_or_fulfilled() {
        assert!(editable(facts("pending", "pending", false)));
        assert!(editable(facts("processing", "on_invoice", false)));
        assert!(!editable(facts("cancelled", "pending", false)));
        assert!(!editable(facts("completed", "pending", false)));
        assert!(!editable(facts("pending", "paid", false)));
        assert!(!editable(facts("pending", "refunded", false)));
        assert!(!editable(facts("pending", "pending", true)));
    }

    #[test]
    fn cancellable_ignores_payment() {
        assert!(cancellable(facts("confirmed", "paid", false)));
        assert!(!cancellable(facts("cancelled", "pending", false)));
        assert!(!cancellable(facts("completed", "paid", false)));
        assert!(!cancellable(facts("processing", "pending", true)));
    }

    #[test]
    fn status_only_moves_forward() {
        assert!(can_move("pending", "confirmed"));
        assert!(can_move("pending", "completed"));
        assert!(can_move("confirmed", "confirmed"));
        assert!(!can_move("processing", "confirmed"));
        assert!(!can_move("pending", "cancelled"));
        assert!(!can_move("completed", "pending"));
        assert!(!can_move("cancelled", "pending"));
        assert!(!can_move("pending", "shipped"));
    }
}
