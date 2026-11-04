//! Decision log rules (`@weldsuite/flow-domain/decisions`): numbering, the
//! fields a decision may carry in each status, deciding, superseding, what an
//! approval does to a decision and the shapes a decision takes on the wire and
//! in entity events (design: weldflow-project-control.md; ADRs FLOW-011 and
//! FLOW-016).
//!
//! Every message returned here goes to the client as it is, so both backends
//! answer alike. Rows are read as `weldsuite_db::js_row` gives them:
//! camelCase keys, timestamps as ISO strings.

use std::borrow::Cow;

use serde_json::{Value, json};

use crate::js::millis_of;
use crate::numbering::NumberSequence;

/// `DECISION_STATUSES`.
pub const DECISION_STATUSES: [&str; 3] = ["proposed", "decided", "superseded"];

/// `DECISION_MESSAGES`.
pub mod messages {
    pub const ONE_CHOSEN: &str = "Only one option can be chosen";
    pub const CHOOSE_TAKEN: &str = "Choose the option that was taken";
    pub const NO_SUCH_OPTION: &str = "The chosen option does not exist";
    pub const PROPOSED_ONLY: &str = "deciderId and decisionDueAt only apply to a proposed decision";
    pub const DECIDED_ONLY: &str = "decidedBy and decidedAt only apply to a decided decision";
    pub const ALREADY_DECIDED: &str = "This decision has already been decided";
    pub const SUPERSEDED_NOT_DECIDABLE: &str = "A superseded decision cannot be decided";
    pub const NOT_DECIDER_OR_MANAGER: &str =
        "Only the project manager or the named decider can record a decision";
    pub const DECIDED_EDIT: &str =
        "A decided or superseded decision can only change its title, context and consequences";
    pub const NOT_DECIDED: &str = "Only a decided decision can be superseded";
    pub const ALREADY_SUPERSEDED: &str = "This decision has already been superseded";
    pub const SELF_SUPERSEDE: &str = "A decision cannot replace itself";
    pub const OTHER_PROJECT: &str = "The replacing decision must be in the same project";
    pub const SUPERSEDER_SUPERSEDED: &str = "A superseded decision cannot replace another";
}

// ── Numbering ───────────────────────────────────────────────────────────────

/// `decisionSequence(projectId)`: scope `dec:<projectId>`, prefix `DEC-`.
pub fn decision_sequence(project_id: &str) -> NumberSequence {
    NumberSequence {
        scope: Cow::Owned(format!("dec:{project_id}")),
        prefix: "DEC-",
    }
}

/// `decisionCode(number)`: `DEC-7`.
pub fn decision_code(number: i64) -> String {
    format!("DEC-{number}")
}

// ── Options ─────────────────────────────────────────────────────────────────

/// One option as it is stored: every field present (`StoredDecisionOption`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionOption {
    pub title: String,
    pub note: Option<String>,
    pub chosen: bool,
}

impl DecisionOption {
    /// The stored JSON of the option.
    pub fn to_json(&self) -> Value {
        json!({ "title": self.title, "note": self.note, "chosen": self.chosen })
    }
}

/// `normalizeOptions(options)`: a missing note is null and a missing `chosen`
/// is false (`chosen === true`). Reads a request body's options and the stored
/// ones alike.
pub fn normalize_options(options: &[Value]) -> Vec<DecisionOption> {
    options
        .iter()
        .map(|option| DecisionOption {
            title: option
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            note: option
                .get("note")
                .and_then(Value::as_str)
                .map(str::to_owned),
            chosen: option.get("chosen") == Some(&Value::Bool(true)),
        })
        .collect()
}

/// `chooseOption(options, index)`: the same options with exactly the one at
/// `index` chosen.
pub fn choose_option(options: &[DecisionOption], index: usize) -> Vec<DecisionOption> {
    options
        .iter()
        .enumerate()
        .map(|(position, option)| DecisionOption {
            chosen: position == index,
            ..option.clone()
        })
        .collect()
}

/// `optionsError(options)`: more than one option marked chosen.
pub fn options_error(options: &[DecisionOption]) -> Option<&'static str> {
    (options.iter().filter(|option| option.chosen).count() > 1).then_some(messages::ONE_CHOSEN)
}

/// `hasChosenOption(options)`.
pub fn has_chosen_option(options: &[DecisionOption]) -> bool {
    options.iter().any(|option| option.chosen)
}

// ── Create and edit ─────────────────────────────────────────────────────────

/// What a new decision's body says beyond its options (`decisionCreateError`'s
/// input): empty and absent are the same.
#[derive(Debug, Clone, Copy, Default)]
pub struct CreateFields<'a> {
    pub decider_id: Option<&'a str>,
    pub decision_due_at: Option<&'a str>,
    pub decided_by: Option<&'a str>,
    pub decided_at: Option<&'a str>,
}

/// `decisionCreateError(...)`: the cross-field rules of a new decision.
pub fn decision_create_error(
    status: &str,
    options: &[DecisionOption],
    fields: CreateFields<'_>,
) -> Option<&'static str> {
    if let Some(message) = options_error(options) {
        return Some(message);
    }
    let set = |value: Option<&str>| value.is_some_and(|text| !text.is_empty());
    if status == "decided" {
        if set(fields.decider_id) || set(fields.decision_due_at) {
            return Some(messages::PROPOSED_ONLY);
        }
        if !options.is_empty() && !has_chosen_option(options) {
            return Some(messages::CHOOSE_TAKEN);
        }
        return None;
    }
    if set(fields.decided_by) || set(fields.decided_at) {
        return Some(messages::DECIDED_ONLY);
    }
    None
}

/// `decisionEditLockedError(status, body)`: the refusal (409) of an edit that
/// changes more than a decided decision allows; each flag says the key is in
/// the body (`!== undefined`, so a `null` counts).
pub fn decision_edit_locked_error(
    status: &str,
    has_options: bool,
    has_decider_id: bool,
    has_decision_due_at: bool,
) -> Option<&'static str> {
    if status == "proposed" {
        return None;
    }
    (has_options || has_decider_id || has_decision_due_at).then_some(messages::DECIDED_EDIT)
}

/// `needsRerouting(...)`: whether editing a proposed decision asks for its
/// approval again: the decider or the due date changed, or the decider
/// already declined. Dates are epoch milliseconds.
pub fn needs_rerouting(
    existing_decider_id: Option<&str>,
    next_decider_id: Option<&str>,
    existing_due_ms: Option<i64>,
    next_due_ms: Option<i64>,
    any_rejected: bool,
) -> bool {
    existing_decider_id != next_decider_id || existing_due_ms != next_due_ms || any_rejected
}

// ── Deciding and superseding ────────────────────────────────────────────────

/// `decideStateError(status)`: the refusal (409) of deciding a decision that
/// is not proposed.
pub fn decide_state_error(status: &str) -> Option<&'static str> {
    match status {
        "decided" => Some(messages::ALREADY_DECIDED),
        "superseded" => Some(messages::SUPERSEDED_NOT_DECIDABLE),
        _ => None,
    }
}

/// `decideInputError(options, chosenIndex)`: with options the one taken has to
/// be named (or already marked), and has to exist.
pub fn decide_input_error(
    options: &[DecisionOption],
    chosen_index: Option<usize>,
) -> Option<&'static str> {
    if let Some(index) = chosen_index
        && index >= options.len()
    {
        return Some(messages::NO_SUCH_OPTION);
    }
    if !options.is_empty() && chosen_index.is_none() && !has_chosen_option(options) {
        return Some(messages::CHOOSE_TAKEN);
    }
    None
}

/// `optionsAfterDecide(options, chosenIndex)`: the named option chosen, else
/// as they were.
pub fn options_after_decide(
    options: &[DecisionOption],
    chosen_index: Option<usize>,
) -> Vec<DecisionOption> {
    match chosen_index {
        Some(index) => choose_option(options, index),
        None => options.to_vec(),
    }
}

/// `mayRecordDecision`: the project manager, or the named decider.
pub const fn may_record_decision(is_manager: bool, is_named_decider: bool) -> bool {
    is_manager || is_named_decider
}

/// `supersedeSourceError(status)`: the refusal (409) of superseding a decision
/// that is not decided.
pub fn supersede_source_error(status: &str) -> Option<&'static str> {
    match status {
        "superseded" => Some(messages::ALREADY_SUPERSEDED),
        "decided" => None,
        _ => Some(messages::NOT_DECIDED),
    }
}

/// `supersedeTargetError(source, target)`: the refusal of the replacing
/// decision, as `(status, message)`.
pub fn supersede_target_error(
    source_id: &str,
    source_project_id: &str,
    target_id: &str,
    target_project_id: &str,
    target_status: &str,
) -> Option<(u16, &'static str)> {
    if source_id == target_id {
        return Some((400, messages::SELF_SUPERSEDE));
    }
    if source_project_id != target_project_id {
        return Some((400, messages::OTHER_PROJECT));
    }
    if target_status == "superseded" {
        return Some((409, messages::SUPERSEDER_SUPERSEDED));
    }
    None
}

/// What a settled approval does to a decision: it becomes decided, by the
/// member who answered, as of `now`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionResolution {
    pub decided_by: Option<String>,
    pub decided_at_ms: i64,
}

/// `decisionResolution(outcome, actorId, fallbackDeciderId, now)`: approved
/// decides it (by the one who answered, else the named decider); rejected
/// leaves it proposed (`None`), with the note on the approval row.
pub fn decision_resolution(
    approved: bool,
    actor_id: Option<&str>,
    fallback_decider_id: Option<&str>,
    now_ms: i64,
) -> Option<DecisionResolution> {
    approved.then(|| DecisionResolution {
        decided_by: actor_id.or(fallback_decider_id).map(str::to_owned),
        decided_at_ms: now_ms,
    })
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

fn field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

fn number_of(row: &Value) -> i64 {
    row.get("number")
        .and_then(Value::as_i64)
        .unwrap_or_default()
}

/// `presentDecision(row)`.
pub fn present_decision(row: &Value) -> Value {
    let stored: Vec<Value> = row
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let options: Vec<Value> = normalize_options(&stored)
        .iter()
        .map(DecisionOption::to_json)
        .collect();
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "number": field(row, "number"),
        "code": decision_code(number_of(row)),
        "title": field(row, "title"),
        "status": field(row, "status"),
        "context": field(row, "context"),
        "options": options,
        "consequences": row.get("consequences").cloned().unwrap_or_else(|| json!([])),
        "deciderId": field(row, "deciderId"),
        "decidedBy": field(row, "decidedBy"),
        "decidedAt": field(row, "decidedAt"),
        "decisionDueAt": field(row, "decisionDueAt"),
        "supersededById": field(row, "supersededById"),
        "createdBy": field(row, "createdBy"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
        "deletedAt": field(row, "deletedAt"),
    })
}

/// `presentDecisionApproval(row)`: one approver's answer on a proposed decision.
pub fn present_decision_approval(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "approverId": field(row, "approverId"),
        "decision": field(row, "decision"),
        "note": field(row, "note"),
        "dueAt": field(row, "dueAt"),
        "decidedAt": field(row, "decidedAt"),
        "delegatedFrom": field(row, "delegatedFrom"),
    })
}

/// `decisionEventData(row)`: ids and statuses, no free text beyond the title.
pub fn decision_event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "number": field(row, "number"),
        "code": decision_code(number_of(row)),
        "title": field(row, "title"),
        "status": field(row, "status"),
        "deciderId": field(row, "deciderId"),
        "decidedBy": field(row, "decidedBy"),
        "supersededById": field(row, "supersededById"),
    })
}

/// The milliseconds of an ISO timestamp a row holds (`Date#getTime()`).
pub fn due_millis(iso: Option<&str>) -> Option<i64> {
    iso.and_then(millis_of)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> Vec<DecisionOption> {
        normalize_options(&[
            json!({ "title": "A" }),
            json!({ "title": "B", "note": "cheaper", "chosen": true }),
            json!({ "title": "C" }),
        ])
    }

    fn open_options() -> Vec<DecisionOption> {
        normalize_options(&[json!({ "title": "A" }), json!({ "title": "B" })])
    }

    #[test]
    fn numbers_a_project_decisions_dec_n() {
        let sequence = decision_sequence("prj_1");
        assert_eq!(sequence.scope, "dec:prj_1");
        assert_eq!(sequence.prefix, "DEC-");
        assert_eq!(decision_code(7), "DEC-7");
    }

    #[test]
    fn stores_every_option_field_and_chooses_exactly_one() {
        let options = options();
        assert_eq!(
            options
                .iter()
                .map(DecisionOption::to_json)
                .collect::<Vec<_>>(),
            vec![
                json!({ "title": "A", "note": null, "chosen": false }),
                json!({ "title": "B", "note": "cheaper", "chosen": true }),
                json!({ "title": "C", "note": null, "chosen": false }),
            ]
        );
        let chosen =
            |options: &[DecisionOption]| options.iter().map(|o| o.chosen).collect::<Vec<_>>();
        assert_eq!(chosen(&choose_option(&options, 2)), [false, false, true]);
        assert_eq!(options_after_decide(&options, None), options);
        assert_eq!(
            chosen(&options_after_decide(&options, Some(0))),
            [true, false, false]
        );
    }

    #[test]
    fn keeps_the_fields_of_a_new_decision_to_its_status() {
        let base = CreateFields::default();
        let with = |f: CreateFields<'static>| f;
        assert_eq!(
            decision_create_error(
                "proposed",
                &[],
                with(CreateFields {
                    decider_id: Some("u1"),
                    ..base
                })
            ),
            None
        );
        assert_eq!(
            decision_create_error(
                "proposed",
                &[],
                with(CreateFields {
                    decided_by: Some("u1"),
                    ..base
                })
            ),
            Some(messages::DECIDED_ONLY)
        );
        assert_eq!(
            decision_create_error(
                "decided",
                &[],
                with(CreateFields {
                    decider_id: Some("u1"),
                    ..base
                })
            ),
            Some(messages::PROPOSED_ONLY)
        );
        assert_eq!(
            decision_create_error(
                "decided",
                &[],
                with(CreateFields {
                    decision_due_at: Some("2026-12-01T00:00:00Z"),
                    ..base
                })
            ),
            Some(messages::PROPOSED_ONLY)
        );
        let one = normalize_options(&[json!({ "title": "A" })]);
        assert_eq!(
            decision_create_error("decided", &one, base),
            Some(messages::CHOOSE_TAKEN)
        );
        assert_eq!(decision_create_error("decided", &options(), base), None);
        let two = normalize_options(&[
            json!({ "title": "A", "chosen": true }),
            json!({ "title": "B", "chosen": true }),
        ]);
        assert_eq!(
            decision_create_error("proposed", &two, base),
            Some(messages::ONE_CHOSEN)
        );
    }

    #[test]
    fn locks_a_decided_decision_to_title_context_and_consequences() {
        assert_eq!(
            decision_edit_locked_error("proposed", true, false, false),
            None
        );
        assert_eq!(
            decision_edit_locked_error("decided", true, false, false),
            Some(messages::DECIDED_EDIT)
        );
        assert_eq!(
            decision_edit_locked_error("superseded", false, true, false),
            Some(messages::DECIDED_EDIT)
        );
        assert_eq!(
            decision_edit_locked_error("decided", false, false, false),
            None
        );
    }

    #[test]
    fn asks_again_when_the_decider_or_the_date_changed_or_the_proposal_was_declined() {
        let due = Some(1_796_083_200_000);
        assert!(!needs_rerouting(Some("u1"), Some("u1"), due, due, false));
        assert!(needs_rerouting(Some("u1"), Some("u2"), due, due, false));
        assert!(needs_rerouting(Some("u1"), Some("u1"), due, None, false));
        assert!(needs_rerouting(Some("u1"), Some("u1"), due, due, true));
        assert!(needs_rerouting(None, Some("u1"), None, None, false));
        assert!(!needs_rerouting(None, None, None, None, false));
    }

    #[test]
    fn decides_only_a_proposed_decision_and_names_the_option_taken() {
        assert_eq!(decide_state_error("proposed"), None);
        assert_eq!(
            decide_state_error("decided"),
            Some(messages::ALREADY_DECIDED)
        );
        assert_eq!(
            decide_state_error("superseded"),
            Some(messages::SUPERSEDED_NOT_DECIDABLE)
        );
        let open = open_options();
        assert_eq!(
            decide_input_error(&open, None),
            Some(messages::CHOOSE_TAKEN)
        );
        assert_eq!(decide_input_error(&open, Some(1)), None);
        assert_eq!(
            decide_input_error(&open, Some(2)),
            Some(messages::NO_SUCH_OPTION)
        );
        assert_eq!(decide_input_error(&options(), None), None);
        assert_eq!(decide_input_error(&[], None), None);
    }

    #[test]
    fn supersedes_a_decided_decision_by_another_live_one_of_the_same_project() {
        assert_eq!(supersede_source_error("decided"), None);
        assert_eq!(
            supersede_source_error("proposed"),
            Some(messages::NOT_DECIDED)
        );
        assert_eq!(
            supersede_source_error("superseded"),
            Some(messages::ALREADY_SUPERSEDED)
        );
        assert_eq!(
            supersede_target_error("dec_1", "p1", "dec_2", "p1", "decided"),
            None
        );
        assert_eq!(
            supersede_target_error("dec_1", "p1", "dec_1", "p1", "decided"),
            Some((400, messages::SELF_SUPERSEDE))
        );
        assert_eq!(
            supersede_target_error("dec_1", "p1", "dec_2", "p2", "decided"),
            Some((400, messages::OTHER_PROJECT))
        );
        assert_eq!(
            supersede_target_error("dec_1", "p1", "dec_2", "p1", "superseded"),
            Some((409, messages::SUPERSEDER_SUPERSEDED))
        );
    }

    #[test]
    fn only_an_approval_decides_by_whoever_answered() {
        assert_eq!(
            decision_resolution(true, Some("u2"), Some("u1"), 5),
            Some(DecisionResolution {
                decided_by: Some("u2".into()),
                decided_at_ms: 5
            })
        );
        assert_eq!(
            decision_resolution(true, None, Some("u1"), 5),
            Some(DecisionResolution {
                decided_by: Some("u1".into()),
                decided_at_ms: 5
            })
        );
        assert_eq!(decision_resolution(false, Some("u1"), Some("u1"), 5), None);
    }

    #[test]
    fn presents_a_decision_with_its_code_and_normalised_options() {
        let row = json!({
            "id": "dec_1", "projectId": "prj_1", "number": 7, "title": "T",
            "status": "decided", "context": null,
            "options": [{ "title": "A", "chosen": true }],
            "consequences": ["x"], "deciderId": null, "decidedBy": "u1",
            "decidedAt": "2026-10-28T09:00:00.000Z", "decisionDueAt": null,
            "supersededById": null, "createdBy": "u1",
            "createdAt": "2026-10-01T00:00:00.000Z", "updatedAt": "2026-10-01T00:00:00.000Z",
            "deletedAt": null,
        });
        let wire = present_decision(&row);
        assert_eq!(wire["code"], "DEC-7");
        assert_eq!(
            wire["options"],
            json!([{ "title": "A", "note": null, "chosen": true }])
        );
        assert_eq!(decision_event_data(&row)["code"], "DEC-7");
        assert_eq!(decision_event_data(&row)["supersededById"], Value::Null);
    }
}
