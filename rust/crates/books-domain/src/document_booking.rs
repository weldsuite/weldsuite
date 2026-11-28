//! What booking an inbox document needs that is plain arithmetic (Rust only,
//! edition feature `books-receipts`): which bank lines could have paid a
//! document, and how a tax-inclusive amount on a receipt becomes the
//! exclusive unit price a bill line carries.
//!
//! The scoring reuses the matcher's helpers ([`crate::bank_matching`]): the
//! name similarity, the amount tolerance (exact, or within 2%), the IBAN
//! comparison. A document is not a bill yet, so what it says comes from its
//! OCR result or from the booking form, not from a bills row.

use serde_json::Value;

use crate::bank_matching::{name_confidence, name_similarity};
use crate::dates::{add_days, diff_days, is_iso_date};
use crate::identifiers::normalize_iban;
use crate::js::{math_round, parse_float, round_money};

/// Days before the document's date a payment may be dated (a till receipt is
/// paid the day it is printed; a card payment may post the day before).
pub const DAYS_BEFORE: i64 = 3;
/// Days after the document's date a payment may be dated.
pub const DAYS_AFTER: i64 = 30;

/// What a document says that a bank line can be compared with.
#[derive(Debug, Clone, Default)]
pub struct DocumentFacts {
    /// The gross amount (what the bank line carries), positive.
    pub amount: Option<f64>,
    /// The document's date, `yyyy-mm-dd`.
    pub date: Option<String>,
    /// The supplier's IBAN as printed on the document or kept on the contact.
    pub iban: Option<String>,
    pub name: Option<String>,
    /// The invoice number and the payment reference: what the payer wrote on
    /// the transfer.
    pub references: Vec<String>,
}

/// A bank line scored against a document.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub score: f64,
    pub reasons: Vec<String>,
    /// Sure enough to link without asking: the exact amount, and the
    /// supplier's IBAN, name or the document's number as well.
    pub sure: bool,
}

/// The first and last day a payment of a document dated `date` may carry.
pub fn window(date: &str) -> Option<(String, String)> {
    if !is_iso_date(date) {
        return None;
    }
    Some((add_days(date, -DAYS_BEFORE)?, add_days(date, DAYS_AFTER)?))
}

fn text<'a>(line: &'a Value, key: &str) -> Option<&'a str> {
    line.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}

/// The day of a line's `date` (an ISO timestamp or a date).
fn day_of(line: &Value) -> Option<String> {
    let date = text(line, "date")?;
    let day: String = date.chars().take(10).collect();
    is_iso_date(&day).then_some(day)
}

/// Score `line` (a bank transaction row) against `facts`. `None` when it can't
/// have paid the document: money coming in, outside the date window, or too
/// little in common (under 0.3).
pub fn score_line(line: &Value, facts: &DocumentFacts) -> Option<Candidate> {
    let amount = parse_float(text(line, "amount").unwrap_or("0"));
    if amount >= 0.0 || amount.is_nan() {
        return None;
    }
    let paid = round_money(amount.abs());
    let mut score = 0.0;
    let mut reasons: Vec<String> = Vec::new();
    if let Some(date) = facts.date.as_deref()
        && let Some((from, to)) = window(date)
    {
        let day = day_of(line)?;
        if day < from || day > to {
            return None;
        }
        score += 0.05;
        reasons.push("inside the payment window".to_owned());
    }
    let mut exact = false;
    if let Some(expected) = facts.amount.filter(|a| *a > 0.0) {
        let gap = (round_money(expected) - paid).abs();
        if gap < 0.01 {
            exact = true;
            score += 0.5;
            reasons.push("exact amount match".to_owned());
        } else if gap / paid.max(0.01) < 0.02 {
            score += 0.2;
            reasons.push("close amount match".to_owned());
        }
    }
    let mut identified = false;
    if let (Some(a), Some(b)) = (
        text(line, "counterpartyIban").map(normalize_iban),
        facts.iban.as_deref().map(normalize_iban),
    ) && !b.is_empty()
        && a == b
    {
        identified = true;
        score += 0.3;
        reasons.push("counterparty IBAN matches the supplier".to_owned());
    }
    if let Some((boost, reason)) = name_confidence(name_similarity(
        text(line, "counterpartyName"),
        text(line, "description").or_else(|| text(line, "reference")),
        facts.name.as_deref(),
    )) {
        identified |= boost >= 0.3;
        score += boost;
        reasons.push(format!("{reason} the supplier"));
    }
    let said = [
        text(line, "reference"),
        text(line, "description"),
        text(line, "endToEndId"),
    ];
    if facts
        .references
        .iter()
        .filter(|r| r.trim().len() >= 3)
        .any(|r| said.iter().flatten().any(|s| s.contains(r.trim())))
    {
        identified = true;
        score += 0.3;
        reasons.push("document number in the description".to_owned());
    }
    let score = math_round(score.clamp(0.0, 1.0) * 100.0) / 100.0;
    (score >= 0.3).then_some(Candidate {
        score,
        reasons,
        sure: exact && identified,
    })
}

/// The one line that is sure, when exactly one of the scored lines is: the
/// others are not sure, so the person is asked instead of guessed for.
pub fn single_sure<T>(scored: &[(T, Candidate)]) -> Option<&T> {
    let mut sure = scored.iter().filter(|(_, candidate)| candidate.sure);
    let first = sure.next()?;
    sure.next().is_none().then_some(&first.0)
}

/// The exclusive unit price whose line, taxed at `ratio` (the line's total
/// over its price: `1.21` for 21% VAT), comes to `gross`; four decimals, as
/// lines are stored.
pub fn exclusive_unit_price(gross: f64, ratio: f64) -> f64 {
    if !ratio.is_finite() || ratio <= 0.0 {
        return math_round(gross * 10_000.0) / 10_000.0;
    }
    math_round(gross / ratio * 10_000.0) / 10_000.0
}

/// Days between two ISO dates (second minus first), `None` when either isn't.
pub fn days_between(a: &str, b: &str) -> Option<i64> {
    diff_days(b, a)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use serde_json::json;

    use super::*;

    fn line(date: &str, amount: &str) -> Value {
        json!({
            "id": "btx_1", "date": date, "amount": amount,
            "counterpartyName": "Bol.com B.V.", "counterpartyIban": "NL91 ABNA 0417 1643 00",
            "description": "Order 4412 Bol.com", "reference": null,
        })
    }

    fn facts() -> DocumentFacts {
        DocumentFacts {
            amount: Some(121.0),
            date: Some("2026-11-20".to_owned()),
            iban: Some("NL91ABNA0417164300".to_owned()),
            name: Some("Bol.com".to_owned()),
            references: vec!["INV-2026-77".to_owned()],
        }
    }

    #[test]
    fn the_window_is_three_days_before_and_thirty_after() {
        assert_eq!(
            window("2026-11-20"),
            Some(("2026-11-17".to_owned(), "2026-12-20".to_owned()))
        );
        assert_eq!(window("not a date"), None);
    }

    #[test]
    fn the_exact_amount_with_the_supplier_is_sure() {
        let candidate = score_line(&line("2026-11-21T00:00:00.000Z", "-121.00"), &facts()).unwrap();
        assert!(candidate.sure);
        assert!(candidate.score >= 0.8, "{}", candidate.score);
        assert!(candidate.reasons.iter().any(|r| r == "exact amount match"));
        assert!(candidate.reasons.iter().any(|r| r.contains("IBAN")));
    }

    #[test]
    fn only_the_amount_is_not_sure() {
        let mut stranger = line("2026-11-21", "-121.00");
        stranger["counterpartyName"] = json!("Someone Else");
        stranger["counterpartyIban"] = json!("DE89370400440532013000");
        stranger["description"] = json!("Payment");
        let candidate = score_line(&stranger, &facts()).unwrap();
        assert!(!candidate.sure);
        assert!(candidate.score >= 0.3);
    }

    #[test]
    fn the_document_number_makes_it_identified() {
        let mut by_number = line("2026-11-21", "-121.00");
        by_number["counterpartyName"] = json!("Unknown");
        by_number["counterpartyIban"] = json!(null);
        by_number["description"] = json!("Factuur INV-2026-77");
        let candidate = score_line(&by_number, &facts()).unwrap();
        assert!(candidate.sure);
        assert!(candidate.reasons.iter().any(|r| r.contains("number")));
    }

    #[test]
    fn money_in_and_dates_outside_the_window_are_not_candidates() {
        assert!(score_line(&line("2026-11-21", "121.00"), &facts()).is_none());
        // Four days before, and thirty-one days after.
        assert!(score_line(&line("2026-11-16", "-121.00"), &facts()).is_none());
        assert!(score_line(&line("2026-12-21", "-121.00"), &facts()).is_none());
        // The edges are in.
        assert!(score_line(&line("2026-11-17", "-121.00"), &facts()).is_some());
        assert!(score_line(&line("2026-12-20", "-121.00"), &facts()).is_some());
    }

    #[test]
    fn a_close_amount_scores_less_and_is_never_sure() {
        let candidate = score_line(&line("2026-11-21", "-120.50"), &facts()).unwrap();
        assert!(!candidate.sure);
        assert!(candidate.reasons.iter().any(|r| r == "close amount match"));
        let exact = score_line(&line("2026-11-21", "-121.00"), &facts()).unwrap();
        assert!(exact.score > candidate.score);
    }

    #[test]
    fn nothing_in_common_is_none() {
        let mut other = line("2026-11-21", "-9.99");
        other["counterpartyName"] = json!("Zzz");
        other["counterpartyIban"] = json!(null);
        other["description"] = json!("Unrelated");
        assert!(score_line(&other, &facts()).is_none());
    }

    #[test]
    fn auto_linking_needs_exactly_one_sure_line() {
        let sure = Candidate {
            score: 0.9,
            reasons: vec![],
            sure: true,
        };
        let unsure = Candidate {
            score: 0.4,
            reasons: vec![],
            sure: false,
        };
        assert_eq!(
            single_sure(&[("a", sure.clone()), ("b", unsure.clone())]),
            Some(&"a")
        );
        assert_eq!(single_sure(&[("a", sure.clone()), ("b", sure)]), None);
        assert_eq!(single_sure(&[("a", unsure)]), None);
        assert_eq!(single_sure::<&str>(&[]), None);
    }

    #[test]
    fn a_gross_amount_becomes_an_exclusive_unit_price() {
        assert!((exclusive_unit_price(121.0, 1.21) - 100.0).abs() < 1e-9);
        assert!((exclusive_unit_price(10.0, 1.21) - 8.2645).abs() < 1e-9);
        assert!((exclusive_unit_price(10.0, 1.0) - 10.0).abs() < 1e-9);
        assert!((exclusive_unit_price(10.0, 0.0) - 10.0).abs() < 1e-9);
    }
}
