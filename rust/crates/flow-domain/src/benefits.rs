//! Benefit rules (`@weldsuite/flow-domain/benefits`): numbering, progress
//! toward the target, the goal-card targets, and the shapes a benefit takes on
//! the wire and in entity events (design: weldflow-project-control.md; ADRs
//! FLOW-011 and FLOW-014). The metric catalogue is [`crate::benefit_metrics`].
//!
//! Every message returned here goes to the client as it is, so both backends
//! answer alike. Rows are read as `weldsuite_db::js_row` gives them:
//! camelCase keys, timestamps as ISO strings, `numeric` as text.

use std::borrow::Cow;

use serde_json::{Value, json};
use weldsuite_kit::validation::js_trim;

use crate::js::{math_round, utf16_len};
use crate::numbering::NumberSequence;

/// `BENEFIT_STATUSES`.
pub const BENEFIT_STATUSES: [&str; 5] = ["planned", "measuring", "at_risk", "realised", "closed"];

/// `BENEFIT_OPEN_STATUSES`: the statuses in which a benefit is still measured.
pub const BENEFIT_OPEN_STATUSES: [&str; 3] = ["planned", "measuring", "at_risk"];

/// `BENEFIT_MESSAGES`.
pub mod messages {
    pub const FUTURE_PERIOD: &str = "period cannot be in the future";
}

// ── Numbering ───────────────────────────────────────────────────────────────

/// `benefitSequence(projectId)`: scope `ben:<projectId>`, prefix `B-`.
pub fn benefit_sequence(project_id: &str) -> NumberSequence {
    NumberSequence {
        scope: Cow::Owned(format!("ben:{project_id}")),
        prefix: "B-",
    }
}

/// `benefitCode(number)`: `B-3`.
pub fn benefit_code(number: i64) -> String {
    format!("B-{number}")
}

// ── Status ──────────────────────────────────────────────────────────────────

/// `isOpenBenefitStatus(status)`.
pub fn is_open_benefit_status(status: &str) -> bool {
    BENEFIT_OPEN_STATUSES.contains(&status)
}

/// `benefitClosedAtFor(status, currentClosedAt, now)`: the time a benefit
/// first reached realised or closed (kept while it stays there), null once it
/// is open again. Times are ISO strings.
pub fn benefit_closed_at_for(
    status: &str,
    current_closed_at: Option<&str>,
    now_iso: &str,
) -> Option<String> {
    if is_open_benefit_status(status) {
        return None;
    }
    Some(current_closed_at.unwrap_or(now_iso).to_owned())
}

// ── Progress ────────────────────────────────────────────────────────────────

/// `num(value)`: a numeric column's text as a number, or `None`.
fn num(value: Option<&str>) -> Option<f64> {
    value
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|number| number.is_finite())
}

/// `benefitProgress(baseline, target, current)`: how far the current value has
/// moved from the baseline toward the target, as a whole percentage from 0 to
/// 100 (past the target is 100, away from it 0). `None` when it cannot be
/// told: a value is missing, or the target equals the baseline and the current
/// value is not on it.
pub fn benefit_progress(
    baseline: Option<&str>,
    target: Option<&str>,
    current: Option<&str>,
) -> Option<i64> {
    let from = num(baseline)?;
    let to = num(target)?;
    let now = num(current)?;
    #[allow(clippy::float_cmp)]
    if to == from {
        return (now == to).then_some(100);
    }
    let fraction = ((now - from) / (to - from)) * 100.0;
    #[allow(clippy::cast_possible_truncation)]
    Some(math_round(fraction.clamp(0.0, 100.0)) as i64)
}

/// `taskProgressPct(done, total)`: done tasks out of all, as a whole
/// percentage; `None` when there are none.
pub fn task_progress_pct(done: i64, total: i64) -> Option<i64> {
    if total == 0 {
        return None;
    }
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    Some(math_round((done as f64 / total as f64) * 100.0) as i64)
}

// ── Goal targets ────────────────────────────────────────────────────────────

/// A goal-card task filter (`goalTaskFilterSchema`): the tasks of the project
/// that match every field given. At least one field is set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GoalTaskFilter {
    pub deliverable_id: Option<String>,
    pub milestone_id: Option<String>,
    pub sprint_id: Option<String>,
    pub assignee_id: Option<String>,
    pub tag: Option<String>,
    pub task_type: Option<String>,
}

/// A target on a goal card (`goalTargetSchema`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalTarget {
    Benefit {
        benefit_id: String,
    },
    Task {
        label: String,
        filter: GoalTaskFilter,
    },
}

/// `z.string().min(1).max(255)` (an identifier), `trim` when asked.
fn string_of(value: &Value, trim: bool, max: usize) -> Option<String> {
    let text = value.as_str()?;
    let text = if trim { js_trim(text) } else { text };
    (utf16_len(text) >= 1 && utf16_len(text) <= max).then(|| text.to_owned())
}

fn read_filter(value: &Value) -> Option<GoalTaskFilter> {
    let fields = value.as_object()?;
    let mut filter = GoalTaskFilter::default();
    for (key, field) in fields {
        match key.as_str() {
            "deliverableId" => filter.deliverable_id = Some(string_of(field, false, 255)?),
            "milestoneId" => filter.milestone_id = Some(string_of(field, false, 255)?),
            "sprintId" => filter.sprint_id = Some(string_of(field, false, 255)?),
            "assigneeId" => filter.assignee_id = Some(string_of(field, false, 255)?),
            "tag" => filter.tag = Some(string_of(field, true, 100)?),
            "type" => filter.task_type = Some(string_of(field, true, 50)?),
            // `.strict()`.
            _ => return None,
        }
    }
    // `Object.keys(filter).length > 0`.
    (filter != GoalTaskFilter::default()).then_some(filter)
}

/// `goalTargetSchema.safeParse(raw)`: a benefit (`{ benefitId }`) or a task
/// filter with a label (`{ label, taskFilter }`), both strict.
pub fn read_goal_target(raw: &Value) -> Option<GoalTarget> {
    let fields = raw.as_object()?;
    if fields.len() == 1
        && let Some(benefit_id) = fields.get("benefitId")
    {
        return string_of(benefit_id, false, 255)
            .map(|benefit_id| GoalTarget::Benefit { benefit_id });
    }
    if fields.len() == 2
        && let (Some(label), Some(filter)) = (fields.get("label"), fields.get("taskFilter"))
    {
        return Some(GoalTarget::Task {
            label: string_of(label, true, 255)?,
            filter: read_filter(filter)?,
        });
    }
    None
}

/// `parseGoalTargets(card)`: the targets of a goal card (`card.targets`), read
/// leniently: a target that does not parse is skipped, and the index stays the
/// position in the card's list.
pub fn parse_goal_targets(card: &Value) -> Vec<(usize, GoalTarget)> {
    let Some(targets) = card.get("targets").and_then(Value::as_array) else {
        return Vec::new();
    };
    targets
        .iter()
        .enumerate()
        .filter_map(|(index, raw)| read_goal_target(raw).map(|target| (index, target)))
        .collect()
}

/// `goalCardId(card)`: the id of a goal card, or `None`.
pub fn goal_card_id(card: &Value) -> Option<String> {
    card.get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

fn text_field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// `benefitTargetProgress(index, benefitId, benefit)`: the progress of a
/// benefit target, from the benefit's latest measurement; `benefit` is the
/// presented benefit, `None` when it is gone.
pub fn benefit_target_progress(index: usize, benefit_id: &str, benefit: Option<&Value>) -> Value {
    let Some(benefit) = benefit else {
        return json!({
            "index": index, "kind": "benefit", "label": "", "benefitId": benefit_id,
            "code": null, "metric": null, "unit": null, "baselineValue": null,
            "currentValue": null, "targetValue": null, "status": null,
            "done": null, "total": null, "progressPct": null,
        });
    };
    let current = benefit
        .get("latest")
        .and_then(|latest| latest.get("value"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "index": index,
        "kind": "benefit",
        "label": text_field(benefit, "title"),
        "benefitId": benefit_id,
        "code": text_field(benefit, "code"),
        "metric": text_field(benefit, "metric"),
        "unit": text_field(benefit, "unit"),
        "baselineValue": text_field(benefit, "baselineValue"),
        "currentValue": current,
        "targetValue": text_field(benefit, "targetValue"),
        "status": text_field(benefit, "status"),
        "done": null,
        "total": null,
        "progressPct": text_field(benefit, "progressPct"),
    })
}

/// `taskTargetProgress(index, label, done, total)`: the progress of a task
/// target, the tasks that match its filter.
pub fn task_target_progress(index: usize, label: &str, done: i64, total: i64) -> Value {
    json!({
        "index": index,
        "kind": "task",
        "label": label,
        "benefitId": null,
        "code": null,
        "metric": null,
        "unit": null,
        "baselineValue": null,
        "currentValue": null,
        "targetValue": null,
        "status": null,
        "done": done,
        "total": total,
        "progressPct": task_progress_pct(done, total),
    })
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

/// `latestOf(rows)`: the newest measurement (by month) as the routes carry it.
pub fn latest_of(rows: &[Value]) -> Option<Value> {
    let period = |row: &Value| {
        row.get("period")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let mut best: Option<&Value> = None;
    for row in rows {
        if best.is_none_or(|current| period(row) > period(current)) {
            best = Some(row);
        }
    }
    best.map(|row| {
        json!({
            "period": text_field(row, "period"),
            "value": text_field(row, "value"),
            "measuredAt": text_field(row, "measuredAt"),
        })
    })
}

/// `presentBenefit(row, latest)`: a benefit as the routes answer it, with its
/// newest measurement.
pub fn present_benefit(row: &Value, latest: Option<&Value>) -> Value {
    let number = row
        .get("number")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let progress = benefit_progress(
        row.get("baselineValue").and_then(Value::as_str),
        row.get("targetValue").and_then(Value::as_str),
        latest
            .and_then(|latest| latest.get("value"))
            .and_then(Value::as_str),
    );
    json!({
        "id": text_field(row, "id"),
        "projectId": text_field(row, "projectId"),
        "number": text_field(row, "number"),
        "code": benefit_code(number),
        "title": text_field(row, "title"),
        "description": text_field(row, "description"),
        "ownerId": text_field(row, "ownerId"),
        "goalRef": text_field(row, "goalRef"),
        "metric": text_field(row, "metric"),
        "metricParams": row.get("metricParams").cloned().unwrap_or_else(|| json!({})),
        "unit": text_field(row, "unit"),
        "baselineValue": text_field(row, "baselineValue"),
        "targetValue": text_field(row, "targetValue"),
        "realiseBy": text_field(row, "realiseBy"),
        "status": text_field(row, "status"),
        "closedAt": text_field(row, "closedAt"),
        "createdBy": text_field(row, "createdBy"),
        "createdAt": text_field(row, "createdAt"),
        "updatedAt": text_field(row, "updatedAt"),
        "deletedAt": text_field(row, "deletedAt"),
        "latest": latest,
        "progressPct": progress,
    })
}

/// `presentMeasurement(row)`: one month of a benefit.
pub fn present_measurement(row: &Value) -> Value {
    json!({
        "id": text_field(row, "id"),
        "benefitId": text_field(row, "benefitId"),
        "projectId": text_field(row, "projectId"),
        "period": text_field(row, "period"),
        "value": text_field(row, "value"),
        "measuredAt": text_field(row, "measuredAt"),
        "measuredBy": text_field(row, "measuredBy"),
    })
}

/// `benefitEventData(row)`: ids and statuses, no free text beyond the title.
pub fn benefit_event_data(row: &Value) -> Value {
    let number = row
        .get("number")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    json!({
        "id": text_field(row, "id"),
        "projectId": text_field(row, "projectId"),
        "number": text_field(row, "number"),
        "code": benefit_code(number),
        "title": text_field(row, "title"),
        "status": text_field(row, "status"),
        "ownerId": text_field(row, "ownerId"),
        "metric": text_field(row, "metric"),
        "goalRef": text_field(row, "goalRef"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_benefits_b_n() {
        let sequence = benefit_sequence("prj_1");
        assert_eq!(sequence.scope, "ben:prj_1");
        assert_eq!(sequence.prefix, "B-");
        assert_eq!(benefit_code(3), "B-3");
    }

    #[test]
    fn stamps_closed_at_on_realised_and_closed_and_clears_it_when_open_again() {
        let now = "2026-11-03T10:00:00.000Z";
        let earlier = "2026-10-01T10:00:00.000Z";
        assert_eq!(
            benefit_closed_at_for("realised", None, now).as_deref(),
            Some(now)
        );
        assert_eq!(
            benefit_closed_at_for("closed", Some(earlier), now).as_deref(),
            Some(earlier)
        );
        assert_eq!(benefit_closed_at_for("measuring", Some(earlier), now), None);
        assert_eq!(benefit_closed_at_for("at_risk", None, now), None);
    }

    #[test]
    fn measures_progress_from_the_baseline_toward_the_target_clamped_to_0_to_100() {
        let p = |b, t, c| benefit_progress(b, t, c);
        assert_eq!(p(Some("1150"), Some("400"), Some("1090")), Some(8));
        assert_eq!(p(Some("35"), Some("70"), Some("36")), Some(3));
        assert_eq!(p(Some("35"), Some("70"), Some("70")), Some(100));
        assert_eq!(p(Some("35"), Some("70"), Some("90")), Some(100));
        assert_eq!(p(Some("35"), Some("70"), Some("20")), Some(0));
        assert_eq!(
            p(Some("38000.0000"), Some("0.0000"), Some("38000.0000")),
            Some(0)
        );
        assert_eq!(p(None, Some("70"), Some("36")), None);
        assert_eq!(p(Some("35"), None, Some("36")), None);
        assert_eq!(p(Some("35"), Some("70"), None), None);
        assert_eq!(p(Some("50"), Some("50"), Some("50")), Some(100));
        assert_eq!(p(Some("50"), Some("50"), Some("51")), None);
    }

    #[test]
    fn turns_done_tasks_into_a_whole_percentage_none_without_tasks() {
        assert_eq!(task_progress_pct(26, 46), Some(57));
        assert_eq!(task_progress_pct(0, 0), None);
    }

    #[test]
    fn reads_goal_targets_leniently_and_keeps_their_position() {
        let card = json!({
            "id": "goal_1",
            "targets": [
                { "benefitId": "ben_1" },
                { "nonsense": true },
                { "label": "Checkout tasks", "taskFilter": { "deliverableId": "del_4" } },
                { "label": "No filter", "taskFilter": {} },
                { "benefitId": "ben_2", "extra": 1 },
                { "label": "  Trimmed  ", "taskFilter": { "tag": " urgent ", "type": "bug" } },
            ],
        });
        assert_eq!(goal_card_id(&card).as_deref(), Some("goal_1"));
        assert_eq!(goal_card_id(&json!({})), None);
        assert_eq!(
            parse_goal_targets(&card),
            vec![
                (
                    0,
                    GoalTarget::Benefit {
                        benefit_id: "ben_1".into()
                    }
                ),
                (
                    2,
                    GoalTarget::Task {
                        label: "Checkout tasks".into(),
                        filter: GoalTaskFilter {
                            deliverable_id: Some("del_4".into()),
                            ..GoalTaskFilter::default()
                        },
                    }
                ),
                (
                    5,
                    GoalTarget::Task {
                        label: "Trimmed".into(),
                        filter: GoalTaskFilter {
                            tag: Some("urgent".into()),
                            task_type: Some("bug".into()),
                            ..GoalTaskFilter::default()
                        },
                    }
                ),
            ]
        );
        assert_eq!(parse_goal_targets(&json!({ "targets": "x" })).len(), 0);
        assert_eq!(parse_goal_targets(&Value::Null).len(), 0);
    }

    #[test]
    fn shows_a_target_whose_benefit_is_gone_with_no_progress() {
        let gone = benefit_target_progress(1, "ben_x", None);
        assert_eq!(gone["index"], 1);
        assert_eq!(gone["kind"], "benefit");
        assert_eq!(gone["benefitId"], "ben_x");
        assert_eq!(gone["progressPct"], Value::Null);
        assert_eq!(gone["label"], "");
    }

    #[test]
    fn presents_a_benefit_with_its_latest_value_and_progress() {
        let row = json!({
            "id": "ben_1", "projectId": "prj_1", "number": 1, "title": "Fewer tickets",
            "metric": "desk_tickets_by_tag", "metricParams": { "tag": "order status" },
            "baselineValue": "1150.0000", "targetValue": "400.0000", "status": "measuring",
        });
        let latest = latest_of(&[
            json!({ "period": "2026-09", "value": "1100.0000", "measuredAt": "2026-10-01T00:00:00.000Z" }),
            json!({ "period": "2026-10", "value": "1090.0000", "measuredAt": "2026-11-01T00:00:00.000Z" }),
        ]);
        let wire = present_benefit(&row, latest.as_ref());
        assert_eq!(wire["code"], "B-1");
        assert_eq!(wire["latest"]["period"], "2026-10");
        assert_eq!(wire["progressPct"], 8);
        assert_eq!(present_benefit(&row, None)["progressPct"], Value::Null);
        assert_eq!(benefit_event_data(&row)["code"], "B-1");
    }
}
