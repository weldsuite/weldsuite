//! Accepting a risk (`@weldsuite/flow-domain/acceptance`, FLOW-016): a risk
//! with strategy `accept` and a score of 9 or more needs the sponsor's yes.

use serde_json::{Value, json};

use crate::approvals::{ApprovalRow, ApprovalRowInput};
use crate::risk::{risk_band, risk_score};

pub const RISK_ACCEPTANCE_SCORE: i64 = 9;
pub const ACCEPTANCE_DUE_DAYS: i64 = 5;

pub mod messages {
    pub const ONLY_RISKS: &str = "Only a risk can be accepted";
    pub const NEEDS_ACCEPT_STRATEGY: &str =
        "Set the strategy to accept before asking for acceptance";
    pub const BELOW_THRESHOLD: &str =
        "Only a risk scoring 9 or more needs the sponsor to accept it";
    pub const CLOSED: &str = "This item is already closed";
    pub const ALREADY_REQUESTED: &str = "Acceptance has already been requested for this risk";
    pub const NO_SPONSOR: &str =
        "This project has no sponsor or project manager to accept the risk";
}

/// A refusal: status (400 or 409) and message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcceptanceRefusal {
    pub status: u16,
    pub message: &'static str,
}

/// `acceptanceError(item)` on a risk row as `js_row` reads it: the kind, the
/// strategy, the score, then whether it is open.
pub fn acceptance_error(item: &Value) -> Option<AcceptanceRefusal> {
    let refuse = |status, message| Some(AcceptanceRefusal { status, message });
    if item["kind"] != "risk" {
        return refuse(400, messages::ONLY_RISKS);
    }
    if item["strategy"] != "accept" {
        return refuse(400, messages::NEEDS_ACCEPT_STRATEGY);
    }
    let score = match (item["probability"].as_i64(), item["impact"].as_i64()) {
        (Some(p), Some(i)) => risk_score(p, i).unwrap_or(0),
        _ => 0,
    };
    if score < RISK_ACCEPTANCE_SCORE {
        return refuse(400, messages::BELOW_THRESHOLD);
    }
    if !item["closedAt"].is_null() {
        return refuse(409, messages::CLOSED);
    }
    None
}

/// `acceptanceApproverRow`.
pub fn acceptance_approver_row(
    sponsor_id: &str,
    probability: i64,
    impact: i64,
    note: Option<&str>,
    due_ms: i64,
) -> ApprovalRowInput {
    let score = risk_score(probability, impact).unwrap_or(0);
    let mut params = json!({
        "score": score,
        "band": risk_band(score).map(crate::risk::RiskBand::as_str),
        "strategy": "accept",
    });
    if let (Some(note), Value::Object(map)) = (note, &mut params) {
        map.insert("note".to_owned(), json!(note));
    }
    ApprovalRowInput::member(sponsor_id, "risk_acceptance")
        .with_role_label("Sponsor")
        .with_rule("risk_acceptance", &params)
        .with_due_at(Some(due_ms))
}

/// `acceptanceAssessmentNote(rows)`.
pub fn acceptance_assessment_note(rows: &[ApprovalRow]) -> String {
    let answer = rows
        .iter()
        .find(|r| r.decision == "approved" || r.decision == "approved_with_conditions");
    let text = answer
        .and_then(|r| r.note.as_deref())
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let conditional = answer.is_some_and(|r| r.decision == "approved_with_conditions");
    format!(
        "Accepted by the sponsor{}{}",
        if conditional { " with conditions" } else { "" },
        text.map(|t| format!(": {t}")).unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn risk(strategy: &str, p: i64, i: i64, closed: bool) -> Value {
        json!({"kind":"risk","strategy":strategy,"probability":p,"impact":i,
            "closedAt": if closed { json!("2026-11-01T00:00:00.000Z") } else { Value::Null }})
    }

    #[test]
    fn a_risk_that_accepts_and_scores_enough_goes_to_the_sponsor() {
        assert_eq!(acceptance_error(&risk("accept", 3, 3, false)), None);
        assert_eq!(acceptance_error(&risk("accept", 5, 5, false)), None);
    }

    #[test]
    fn checks_run_in_a_fixed_order() {
        let issue = json!({"kind":"issue","strategy":null});
        assert_eq!(
            acceptance_error(&issue).map(|r| r.message),
            Some(messages::ONLY_RISKS)
        );
        assert_eq!(
            acceptance_error(&risk("mitigate", 1, 1, false)).map(|r| r.message),
            Some(messages::NEEDS_ACCEPT_STRATEGY)
        );
        assert_eq!(
            acceptance_error(&risk("accept", 2, 4, true)).map(|r| r.message),
            Some(messages::BELOW_THRESHOLD)
        );
        assert_eq!(
            acceptance_error(&risk("accept", 3, 3, true)),
            Some(AcceptanceRefusal {
                status: 409,
                message: messages::CLOSED
            })
        );
    }

    #[test]
    fn the_row_names_the_score_band_and_reason() {
        let row = acceptance_approver_row("u1", 4, 4, Some("Cheaper"), 5);
        assert_eq!(row.role_label.as_deref(), Some("Sponsor"));
        assert_eq!(
            row.rule,
            json!({"code":"risk_acceptance","params":{"score":16,"band":"high","strategy":"accept","note":"Cheaper"}})
        );
        let plain = acceptance_approver_row("u1", 3, 3, None, 5);
        assert_eq!(
            plain.rule["params"],
            json!({"score":9,"band":"medium","strategy":"accept"})
        );
    }

    #[test]
    fn the_note_names_the_sponsor_and_their_words() {
        let row = |d: &str, n: Option<&str>| ApprovalRow {
            decision: d.to_owned(),
            note: n.map(str::to_owned),
            ..ApprovalRow::default()
        };
        assert_eq!(
            acceptance_assessment_note(&[row("approved", None)]),
            "Accepted by the sponsor"
        );
        assert_eq!(
            acceptance_assessment_note(&[row("approved", Some(" Fine "))]),
            "Accepted by the sponsor: Fine"
        );
        assert_eq!(
            acceptance_assessment_note(&[row("approved_with_conditions", Some("March"))]),
            "Accepted by the sponsor with conditions: March"
        );
    }
}
