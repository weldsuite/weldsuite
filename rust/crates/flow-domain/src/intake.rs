//! Intake rules (`@weldsuite/flow-domain/intake`): project requests, the
//! scoring model and the wire shapes of requests and the workspace settings
//! (design: weldflow-delivery-and-portfolio.md, "Intake").
//!
//! Pure functions, no database and no clock. Every message returned here goes
//! to the client as it is, so both backends answer alike.
//!
//! ```text
//! score = Σ weight × rating ÷ 5        (0 to 100 with weights adding up to 100)
//! ```
//!
//! A criterion marked `inverse` (risk, effort) counts as `6 − rating`. A
//! request has a score only when every criterion of the model is rated.

use std::borrow::Cow;

use serde_json::{Map, Value, json};

use crate::capacity::{messages, parse_date, round2};
use crate::js::{number_value, numeric, to_fixed};
use crate::numbering::NumberSequence;

pub const SCORE_MIN: i64 = 1;
pub const SCORE_MAX: i64 = 5;

/// `INTAKE_MESSAGES`: the messages of every refusal.
pub mod intake_messages {
    pub const NOT_EDITABLE: &str = "Only a new or assessing request can be changed";
    pub const NOT_SCORABLE: &str = "Only a new or assessing request can be scored";
    pub const NOT_NEW: &str = "Only a new request can be submitted";
    pub const NO_BOARD: &str = "Add at least one member to the portfolio board first";
    pub const NOT_APPROVED: &str = "Only an approved request can be converted";
    pub const PROJECT_LINKED: &str = "This project is already linked to another request";
    pub const NOT_DELETABLE: &str = "A converted request cannot be deleted";
    pub const WEIGHTS_TOTAL: &str = "The weights must add up to 100";
    pub const DUPLICATE_CRITERIA: &str = "Every criterion needs its own key";
    pub const REQUEST_FORBIDDEN: &str = "You can only change your own requests";
    pub const SCORE_FORBIDDEN: &str = "Only the portfolio board can score requests";
    pub const CONVERT_FORBIDDEN: &str = "You do not have permission to link this project";
}

/// `unknownCriterionMessage(key)`.
pub fn unknown_criterion_message(key: &str) -> String {
    format!("Unknown scoring criterion: {key}")
}

// ── Numbering ───────────────────────────────────────────────────────────────

/// `REQUEST_SEQUENCE`: scope `req`, prefix `REQ-`.
pub const REQUEST_SEQUENCE: NumberSequence = NumberSequence {
    scope: Cow::Borrowed("req"),
    prefix: "REQ-",
};

/// `requestCode(number)`: `REQ-14`.
pub fn request_code(number: i64) -> String {
    format!("{}{number}", REQUEST_SEQUENCE.prefix)
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/// One criterion of the scoring model (`ScoringCriterionInput`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Criterion {
    pub key: String,
    pub label: String,
    pub weight: i64,
    pub inverse: bool,
}

impl Criterion {
    fn new(key: &str, label: &str, weight: i64, inverse: bool) -> Self {
        Self {
            key: key.to_owned(),
            label: label.to_owned(),
            weight,
            inverse,
        }
    }

    /// A criterion as the settings column stores it.
    pub fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            key: value.get("key")?.as_str()?.to_owned(),
            label: value.get("label")?.as_str()?.to_owned(),
            weight: value.get("weight")?.as_i64()?,
            inverse: value.get("inverse")?.as_bool()?,
        })
    }

    pub fn to_json(&self) -> Value {
        json!({
            "key": self.key,
            "label": self.label,
            "weight": self.weight,
            "inverse": self.inverse,
        })
    }
}

/// The model a workspace starts with (`DEFAULT_SCORING_MODEL`).
pub fn default_scoring_model() -> Vec<Criterion> {
    vec![
        Criterion::new("value", "Value", 35, false),
        Criterion::new("fit", "Strategic fit", 25, false),
        Criterion::new("urgency", "Urgency", 15, false),
        Criterion::new("risk", "Risk", 15, true),
        Criterion::new("effort", "Effort", 10, true),
    ]
}

/// A model as the settings column holds it, or the default one when it is not a list.
pub fn model_from_json(value: Option<&Value>) -> Vec<Criterion> {
    value
        .and_then(Value::as_array)
        .map_or_else(default_scoring_model, |items| {
            items.iter().filter_map(Criterion::from_json).collect()
        })
}

/// `scoringModelError(model)`: each key once, the weights adding up to 100.
pub fn scoring_model_error(model: &[Criterion]) -> Option<&'static str> {
    let mut keys: Vec<&str> = model.iter().map(|c| c.key.as_str()).collect();
    keys.sort_unstable();
    keys.dedup();
    if keys.len() != model.len() {
        return Some(intake_messages::DUPLICATE_CRITERIA);
    }
    let total: i64 = model.iter().map(|c| c.weight).sum();
    (total != 100).then_some(intake_messages::WEIGHTS_TOTAL)
}

/// `scoresError(model, scores)`: the first unknown key, by key.
pub fn scores_error(model: &[Criterion], scores: &Map<String, Value>) -> Option<String> {
    let mut unknown: Vec<&String> = scores
        .keys()
        .filter(|key| !model.iter().any(|c| &c.key == *key))
        .collect();
    unknown.sort();
    unknown.first().map(|key| unknown_criterion_message(key))
}

/// A rating of 1 to 5 as a whole number.
fn rating(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    #[allow(clippy::cast_possible_truncation)]
    let whole = number as i64;
    #[allow(clippy::cast_precision_loss)]
    let is_whole = (whole as f64 - number).abs() < f64::EPSILON;
    (is_whole && (SCORE_MIN..=SCORE_MAX).contains(&whole)).then_some(whole)
}

/// What a rating adds up as: the rating, or `6 − rating` for an inverse criterion.
fn counted(criterion: &Criterion, value: i64) -> i64 {
    if criterion.inverse {
        SCORE_MAX + SCORE_MIN - value
    } else {
        value
    }
}

/// `scoreRequest(model, scores)`: the weighted sum to two decimals, `None` until every criterion is rated.
pub fn score_request(model: &[Criterion], scores: &Map<String, Value>) -> Option<f64> {
    if model.is_empty() {
        return None;
    }
    let mut total: i64 = 0;
    for criterion in model {
        let value = rating(scores.get(&criterion.key))?;
        total += criterion.weight * counted(criterion, value);
    }
    #[allow(clippy::cast_precision_loss)]
    Some(round2(total as f64 / SCORE_MAX as f64))
}

/// `scoreBreakdown(model, scores)`: how the score adds up, criterion by criterion.
pub fn score_breakdown(model: &[Criterion], scores: &Map<String, Value>) -> Vec<Value> {
    model
        .iter()
        .map(|criterion| {
            let value = rating(scores.get(&criterion.key));
            #[allow(clippy::cast_precision_loss)]
            let points = value.map(|v| {
                round2((criterion.weight * counted(criterion, v)) as f64 / SCORE_MAX as f64)
            });
            json!({
                "key": criterion.key,
                "label": criterion.label,
                "weight": criterion.weight,
                "inverse": criterion.inverse,
                "value": value,
                "points": points.map_or(Value::Null, number_value),
            })
        })
        .collect()
}

// ── Request rules ───────────────────────────────────────────────────────────

/// `isOpenRequestStatus(status)`: a new or assessing request can still be edited and scored.
pub fn is_open_request_status(status: &str) -> bool {
    matches!(status, "new" | "assessing")
}

/// `desiredDatesError(start, end)`: each a real date when set, the end not before the start.
pub fn desired_dates_error(start: Option<&str>, end: Option<&str>) -> Option<&'static str> {
    let start = start.filter(|s| !s.is_empty());
    let end = end.filter(|s| !s.is_empty());
    let start_days = start.and_then(parse_date);
    let end_days = end.and_then(parse_date);
    if (start.is_some() && start_days.is_none()) || (end.is_some() && end_days.is_none()) {
        return Some(messages::INVALID_DATE);
    }
    match (start_days, end_days) {
        (Some(s), Some(e)) if e < s => Some(messages::PERIOD_ORDER),
        _ => None,
    }
}

/// `normalizeNeededSkills(skills)`: `{ skill }` or `{ skill, hoursPerWeek }`.
pub fn normalize_needed_skills(skills: &[Value]) -> Value {
    Value::Array(
        skills
            .iter()
            .map(|need| match need.get("hoursPerWeek") {
                Some(hours) if !hours.is_null() => {
                    json!({ "skill": need["skill"], "hoursPerWeek": number_value(hours.as_f64().unwrap_or_default()) })
                }
                _ => json!({ "skill": need["skill"] }),
            })
            .collect(),
    )
}

/// `amountText(value)`: two decimals, as the numeric column stores a money amount.
pub fn amount_text(value: Option<f64>) -> Option<String> {
    value.map(|v| to_fixed(v, 2))
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

fn field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// `presentProjectRequest(row)`: the row with its code, the score as a number
/// and timestamps as ISO strings (a row as `js_row` reads it).
pub fn present_project_request(row: &Value) -> Value {
    let number = row["number"].as_i64().unwrap_or_default();
    let score = match row.get("score") {
        Some(Value::Null) | None => Value::Null,
        Some(value) => number_value(numeric(value)),
    };
    json!({
        "id": field(row, "id"),
        "number": number,
        "code": request_code(number),
        "title": field(row, "title"),
        "requestedBy": field(row, "requestedBy"),
        "businessCase": field(row, "businessCase"),
        "estimatedCost": field(row, "estimatedCost"),
        "estimatedValue": field(row, "estimatedValue"),
        "scores": field(row, "scores"),
        "score": score,
        "neededSkills": field(row, "neededSkills"),
        "desiredStart": field(row, "desiredStart"),
        "desiredEnd": field(row, "desiredEnd"),
        "status": field(row, "status"),
        "submittedAt": field(row, "submittedAt"),
        "projectId": field(row, "projectId"),
        "createdBy": field(row, "createdBy"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `presentSettings(row)`: the workspace settings, or the defaults.
pub fn present_settings(row: Option<&Value>) -> Value {
    match row {
        Some(row) => json!({
            "id": field(row, "id"),
            "scoringModel": field(row, "scoringModel"),
            "portfolioBoardIds": field(row, "portfolioBoardIds"),
            "expenseApprovalLimit": field(row, "expenseApprovalLimit"),
            "updatedBy": field(row, "updatedBy"),
            "updatedAt": field(row, "updatedAt"),
        }),
        None => json!({
            "id": null,
            "scoringModel": default_scoring_model().iter().map(Criterion::to_json).collect::<Vec<_>>(),
            "portfolioBoardIds": [],
            "expenseApprovalLimit": null,
            "updatedBy": null,
            "updatedAt": null,
        }),
    }
}

/// The roadmap's order: by start, a project before a request that starts the
/// same day, then by id (`sortRoadmapItems`).
pub fn sort_roadmap_items(items: &mut [Value]) {
    let rank = |item: &Value| i32::from(item["type"] != json!("project"));
    items.sort_by(|a, b| {
        let key = |item: &Value| {
            (
                item["startsOn"].as_str().unwrap_or_default().to_owned(),
                rank(item),
                item["id"].as_str().unwrap_or_default().to_owned(),
            )
        };
        key(a).cmp(&key(b))
    });
}

/// `presentRequestApproval(row)`: one board member's answer.
pub fn present_request_approval(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "approverKind": field(row, "approverKind"),
        "approverId": field(row, "approverId"),
        "roleLabel": field(row, "roleLabel"),
        "step": field(row, "step"),
        "decision": field(row, "decision"),
        "note": field(row, "note"),
        "decidedAt": field(row, "decidedAt"),
        "decidedBy": field(row, "decidedBy"),
        "delegatedFrom": field(row, "delegatedFrom"),
        "createdAt": field(row, "createdAt"),
    })
}

/// `requestApprovalEventData(row)`: the `flow_approval` entity-event payload of a request's approval row.
pub fn request_approval_event_data(row: &Value) -> Value {
    let mut out = present_request_approval(row);
    if let Value::Object(fields) = &mut out {
        fields.insert("projectId".to_owned(), field(row, "projectId"));
        fields.insert("subjectType".to_owned(), field(row, "subjectType"));
        fields.insert("subjectId".to_owned(), field(row, "subjectId"));
        fields.insert("rule".to_owned(), field(row, "rule"));
        fields.insert("dueAt".to_owned(), field(row, "dueAt"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scores(value: &Value) -> Map<String, Value> {
        value.as_object().expect("an object").clone()
    }

    #[test]
    fn requests_are_numbered_once_per_workspace() {
        assert_eq!(REQUEST_SEQUENCE.scope, "req");
        assert_eq!(REQUEST_SEQUENCE.prefix, "REQ-");
        assert_eq!(request_code(14), "REQ-14");
    }

    #[test]
    fn the_default_model_adds_up_to_100() {
        let model = default_scoring_model();
        let weights: Vec<i64> = model.iter().map(|c| c.weight).collect();
        assert_eq!(weights, vec![35, 25, 15, 15, 10]);
        assert_eq!(scoring_model_error(&model), None);
        let two = [
            Criterion::new("a", "A", 60, false),
            Criterion::new("b", "B", 30, true),
        ];
        assert_eq!(
            scoring_model_error(&two),
            Some(intake_messages::WEIGHTS_TOTAL)
        );
        let twice = [
            Criterion::new("a", "A", 50, false),
            Criterion::new("a", "B", 50, true),
        ];
        assert_eq!(
            scoring_model_error(&twice),
            Some(intake_messages::DUPLICATE_CRITERIA)
        );
    }

    #[test]
    fn the_score_is_the_weighted_sum_with_risk_and_effort_inverted() {
        let model = default_scoring_model();
        let supplier =
            scores(&json!({ "value": 5, "fit": 5, "urgency": 4, "risk": 3, "effort": 4 }));
        assert_eq!(score_request(&model, &supplier), Some(85.0));
        let best = scores(&json!({ "value": 5, "fit": 5, "urgency": 5, "risk": 1, "effort": 1 }));
        assert_eq!(score_request(&model, &best), Some(100.0));
        let worst = scores(&json!({ "value": 1, "fit": 1, "urgency": 1, "risk": 5, "effort": 5 }));
        assert_eq!(score_request(&model, &worst), Some(20.0));
        assert_eq!(
            score_request(&model, &scores(&json!({ "value": 5, "fit": 5 }))),
            None
        );
        assert_eq!(score_request(&model, &scores(&json!({}))), None);
        let extra =
            scores(&json!({ "value": 5, "fit": 5, "urgency": 4, "risk": 3, "effort": 4, "x": 5 }));
        assert_eq!(score_request(&model, &extra), Some(85.0));
        let off = scores(&json!({ "value": 6, "fit": 5, "urgency": 4, "risk": 3, "effort": 4 }));
        assert_eq!(score_request(&model, &off), None);
        let fraction =
            scores(&json!({ "value": 2.5, "fit": 5, "urgency": 4, "risk": 3, "effort": 4 }));
        assert_eq!(score_request(&model, &fraction), None);
        assert_eq!(score_request(&[], &supplier), None);

        let odd = [
            Criterion::new("a", "A", 33, false),
            Criterion::new("b", "B", 67, false),
        ];
        assert_eq!(
            score_request(&odd, &scores(&json!({ "a": 2, "b": 4 }))),
            Some(66.8)
        );
        assert_eq!(
            score_request(&odd, &scores(&json!({ "a": 1, "b": 2 }))),
            Some(33.4)
        );
    }

    #[test]
    fn the_breakdown_shows_each_criterion() {
        let model = default_scoring_model();
        let lines = score_breakdown(
            &model,
            &scores(&json!({ "value": 5, "fit": 5, "urgency": 4, "risk": 3 })),
        );
        assert_eq!(
            lines[2],
            json!({ "key": "urgency", "label": "Urgency", "weight": 15, "inverse": false, "value": 4, "points": 12 })
        );
        assert_eq!(lines[3]["points"], json!(9));
        assert_eq!(lines[4]["value"], Value::Null);
        assert_eq!(lines[4]["points"], Value::Null);
    }

    #[test]
    fn the_first_unknown_criterion_is_named_by_key() {
        let model = default_scoring_model();
        assert_eq!(scores_error(&model, &scores(&json!({ "value": 5 }))), None);
        assert_eq!(
            scores_error(
                &model,
                &scores(&json!({ "zeta": 1, "alpha": 2, "value": 3 }))
            ),
            Some("Unknown scoring criterion: alpha".to_owned())
        );
    }

    #[test]
    fn desired_dates_are_real_and_in_order() {
        assert_eq!(desired_dates_error(None, None), None);
        assert_eq!(desired_dates_error(Some("2027-01-11"), None), None);
        assert_eq!(
            desired_dates_error(Some("2027-01-11"), Some("2027-03-31")),
            None
        );
        assert_eq!(
            desired_dates_error(Some("2027-03-31"), Some("2027-01-11")),
            Some(messages::PERIOD_ORDER)
        );
        assert_eq!(
            desired_dates_error(Some("2027-02-30"), None),
            Some(messages::INVALID_DATE)
        );
        assert_eq!(
            desired_dates_error(None, Some("2027-13-01")),
            Some(messages::INVALID_DATE)
        );
        assert!(is_open_request_status("new") && is_open_request_status("assessing"));
        assert!(!is_open_request_status("approved"));
    }

    #[test]
    fn needed_skills_and_amounts_are_stored_plainly() {
        let skills = [
            json!({ "skill": "Backend", "hoursPerWeek": 40 }),
            json!({ "skill": "PM" }),
        ];
        assert_eq!(
            normalize_needed_skills(&skills),
            json!([{ "skill": "Backend", "hoursPerWeek": 40 }, { "skill": "PM" }])
        );
        assert_eq!(amount_text(Some(140_000.0)).as_deref(), Some("140000.00"));
        assert_eq!(amount_text(Some(12.5)).as_deref(), Some("12.50"));
        assert_eq!(amount_text(None), None);
    }

    #[test]
    fn requests_and_settings_are_presented_as_the_routes_answer_them() {
        let row = json!({
            "id": "prq_1", "number": 14, "title": "Supplier portal", "requestedBy": "u1",
            "businessCase": null, "estimatedCost": "140000.00", "estimatedValue": null,
            "scores": { "value": 5 }, "score": "85.00", "neededSkills": [],
            "desiredStart": "2027-01-11", "desiredEnd": null, "status": "assessing",
            "submittedAt": "2026-11-03T10:00:00.000Z", "projectId": null, "createdBy": "u1",
            "createdAt": "2026-11-03T10:00:00.000Z", "updatedAt": "2026-11-03T10:00:00.000Z",
            "deletedAt": null,
        });
        let shown = present_project_request(&row);
        assert_eq!(shown["code"], json!("REQ-14"));
        assert_eq!(shown["score"], json!(85));
        assert_eq!(shown["estimatedCost"], json!("140000.00"));
        assert!(shown.get("deletedAt").is_none());
        let defaults = present_settings(None);
        assert_eq!(defaults["id"], Value::Null);
        assert_eq!(defaults["scoringModel"][0]["key"], json!("value"));
        assert_eq!(defaults["portfolioBoardIds"], json!([]));
    }

    #[test]
    fn the_roadmap_sorts_by_start_then_project_before_request() {
        let mut items = vec![
            json!({ "type": "request", "id": "a", "startsOn": "2026-12-01" }),
            json!({ "type": "project", "id": "z", "startsOn": "2026-12-01" }),
            json!({ "type": "project", "id": "b", "startsOn": "2026-10-15" }),
        ];
        sort_roadmap_items(&mut items);
        let ids: Vec<&str> = items
            .iter()
            .map(|i| i["id"].as_str().expect("id"))
            .collect();
        assert_eq!(ids, vec!["b", "z", "a"]);
    }
}
