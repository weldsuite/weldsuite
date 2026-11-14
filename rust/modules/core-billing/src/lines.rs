//! What a charge bills: its lines, the VAT on them and the total Mollie
//! takes. A charge becomes one WeldBooks invoice once it is paid, with the
//! same lines (ADR BILL-014).

use serde::{Deserialize, Serialize};

use crate::vat::{VatDecision, vat_of};

/// What a line is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    /// The plan for a whole period: seats × the seat price.
    Plan,
    /// The rest of the running period after more seats or a dearer plan.
    Proration,
    /// A monthly add-on (WeldReach inboxes).
    Addon,
}

/// One line, in cents, before VAT.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub kind: LineKind,
    pub description: String,
    pub quantity: i64,
    /// Per unit, before VAT. For a proration line: per unit for the part of
    /// the period it covers.
    pub unit_amount: i64,
    /// `quantity × unit_amount`, before VAT (a proration line rounds the
    /// total, not the unit).
    pub amount: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_end: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    /// The add-on (`weldreach_inbox`), for an add-on line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addon: Option<String>,
}

/// A charge: its lines, the VAT decision and the totals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Charge {
    pub currency: String,
    pub lines: Vec<Line>,
    pub vat: VatDecision,
    /// Before VAT.
    pub net: i64,
    pub tax: i64,
    /// What Mollie charges.
    pub gross: i64,
}

impl Charge {
    /// Totals the lines and adds the VAT (on the total, rounded once).
    pub fn new(currency: &str, lines: Vec<Line>, vat: VatDecision) -> Self {
        let net: i64 = lines.iter().map(|line| line.amount).sum();
        let tax = vat_of(net, vat.rate_bps);
        Self {
            currency: currency.to_owned(),
            lines,
            vat,
            net,
            tax,
            gross: net + tax,
        }
    }

    /// Nothing to charge.
    pub fn is_empty(&self) -> bool {
        self.gross <= 0
    }

    /// What the customer sees on Mollie's checkout and their statement.
    pub fn description(&self, brand: &str) -> String {
        match self.lines.as_slice() {
            [] => brand.to_owned(),
            [line] => format!("{brand}: {}", line.description),
            [line, rest @ ..] => format!("{brand}: {} (+{} more)", line.description, rest.len()),
        }
    }
}

/// `Business, 3 seats, monthly`.
pub fn plan_description(plan_name: &str, seats: i64, cycle: &str, dutch: bool) -> String {
    match (dutch, seats == 1, cycle) {
        (true, true, "yearly") => format!("{plan_name}, 1 gebruiker, jaarlijks"),
        (true, true, _) => format!("{plan_name}, 1 gebruiker, maandelijks"),
        (true, false, "yearly") => format!("{plan_name}, {seats} gebruikers, jaarlijks"),
        (true, false, _) => format!("{plan_name}, {seats} gebruikers, maandelijks"),
        (false, true, "yearly") => format!("{plan_name}, 1 seat, yearly"),
        (false, true, _) => format!("{plan_name}, 1 seat, monthly"),
        (false, false, "yearly") => format!("{plan_name}, {seats} seats, yearly"),
        (false, false, _) => format!("{plan_name}, {seats} seats, monthly"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vat::{Treatment, VatCheck, decide};

    fn line(amount: i64) -> Line {
        Line {
            kind: LineKind::Plan,
            description: "Business, 3 seats, monthly".to_owned(),
            quantity: 3,
            unit_amount: amount / 3,
            amount,
            period_start: None,
            period_end: None,
            plan_id: Some("plan_business".to_owned()),
            addon: None,
        }
    }

    #[test]
    fn totals_add_vat_once_on_the_whole() {
        let charge = Charge::new("EUR", vec![line(7500), line(3333)], decide("NL", "NL", VatCheck::None));
        assert_eq!(charge.net, 10_833);
        assert_eq!(charge.tax, 2275);
        assert_eq!(charge.gross, 13_108);
        assert_eq!(
            charge.description("WeldSuite"),
            "WeldSuite: Business, 3 seats, monthly (+1 more)"
        );
        let reverse = Charge::new("EUR", vec![line(7500)], decide("NL", "BE", VatCheck::Valid));
        assert_eq!(reverse.vat.treatment, Treatment::ReverseCharge);
        assert_eq!(reverse.gross, 7500);
        assert!(Charge::new("EUR", Vec::new(), decide("NL", "NL", VatCheck::None)).is_empty());
    }

    #[test]
    fn line_json_round_trips() {
        let charge = Charge::new("EUR", vec![line(7500)], decide("NL", "DE", VatCheck::None));
        let json = serde_json::to_value(&charge).expect("json");
        assert_eq!(json["vat"]["treatment"], "oss");
        assert_eq!(json["lines"][0]["kind"], "plan");
        assert_eq!(json["lines"][0]["planId"], "plan_business");
        let back: Charge = serde_json::from_value(json).expect("back");
        assert_eq!(back, charge);
        assert_eq!(plan_description("Business", 1, "yearly", true), "Business, 1 gebruiker, jaarlijks");
    }
}
