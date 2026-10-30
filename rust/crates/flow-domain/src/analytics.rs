//! Entity-event payloads analytics-worker enriches
//! (`@weldsuite/flow-domain/analytics-payload` and flow-api's
//! `lib/weldflow-analytics-payload.ts`): the `project_task` payload every
//! task-writing caller publishes (flow-api, connect-api's `create_task`
//! action), and the `project_time_entry` one.

use serde_json::{Map, Value, json};

use crate::js::{js_date_millis, math_round, number_value, numeric};

/// `isTaskOverdue(dueDate, status)` at `now_ms`: a due date before now on a
/// task that is neither done nor cancelled. An unparseable date is not
/// overdue.
pub fn is_task_overdue(due_date: Option<&Value>, status: Option<&str>, now_ms: i64) -> bool {
    let due = match due_date {
        Some(Value::String(text)) if !text.is_empty() => text,
        _ => return false,
    };
    if matches!(status, Some("done" | "cancelled")) {
        return false;
    }
    js_date_millis(due).is_some_and(|due| due < now_ms)
}

/// `merged.x != null ? Number(merged.x) : undefined`, kept when finite.
fn finite_number(merged: &Map<String, Value>, key: &str) -> Option<Value> {
    match merged.get(key) {
        None | Some(Value::Null) => None,
        Some(value) => {
            let number = match value {
                Value::String(text) => weldsuite_kit::validation::js_number(text),
                Value::Number(_) | Value::Bool(_) => numeric(value),
                _ => f64::NAN,
            };
            number.is_finite().then(|| number_value(number))
        }
    }
}

/// `{ ...task, ...overrides }`.
fn merge(task: &Value, overrides: &Value) -> Map<String, Value> {
    let mut merged = task.as_object().cloned().unwrap_or_default();
    if let Value::Object(overrides) = overrides {
        for (key, value) in overrides {
            merged.insert(key.clone(), value.clone());
        }
    }
    merged
}

/// `taskAnalyticsPayload(task, overrides)` at `now_ms`. Keys whose value
/// is `undefined` in TypeScript (a missing number) are left out.
pub fn task_analytics_payload(task: &Value, overrides: &Value, now_ms: i64) -> Value {
    let merged = merge(task, overrides);
    let or_null = |key: &str| match merged.get(key) {
        None => Value::Null,
        Some(value) => value.clone(),
    };
    let status = merged.get("status").and_then(Value::as_str);
    let mut payload = Map::new();
    payload.insert("id".to_owned(), or_null("id"));
    payload.insert("title".to_owned(), or_null("title"));
    payload.insert("number".to_owned(), or_null("number"));
    payload.insert("projectId".to_owned(), or_null("projectId"));
    payload.insert("status".to_owned(), or_null("status"));
    payload.insert("priority".to_owned(), or_null("priority"));
    payload.insert("type".to_owned(), or_null("type"));
    payload.insert("assigneeId".to_owned(), or_null("assigneeId"));
    for key in ["estimatedHours", "actualHours", "progress"] {
        if let Some(number) = finite_number(&merged, key) {
            payload.insert(key.to_owned(), number);
        }
    }
    payload.insert(
        "isOverdue".to_owned(),
        Value::Bool(is_task_overdue(merged.get("dueDate"), status, now_ms)),
    );
    Value::Object(payload)
}

/// `timeEntryAnalyticsPayload(input)`: minutes in, the duration in
/// seconds and hours (two decimals) out.
pub fn time_entry_analytics_payload(
    id: &str,
    project_id: Option<&str>,
    task_id: Option<&str>,
    user_id: &str,
    duration_minutes: f64,
    billable: Option<bool>,
) -> Value {
    let minutes = if duration_minutes.is_nan() {
        0.0
    } else {
        duration_minutes
    };
    json!({
        "id": id,
        "projectId": project_id,
        "taskId": task_id,
        "userId": user_id,
        "assigneeId": user_id,
        "duration": number_value(minutes),
        "durationSeconds": number_value(math_round(minutes * 60.0)),
        "actualHours": number_value(math_round(minutes / 60.0 * 100.0) / 100.0),
        "isBillable": billable != Some(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overdue_needs_an_open_task_due_before_now() {
        let now = 1_800_000_000_000;
        let past = json!("2020-01-01T00:00:00.000Z");
        assert!(is_task_overdue(Some(&past), Some("todo"), now));
        assert!(!is_task_overdue(Some(&past), Some("done"), now));
        assert!(!is_task_overdue(Some(&json!("not a date")), None, now));
        assert!(!is_task_overdue(None, None, now));
    }

    #[test]
    fn task_payload_reads_numbers_like_number() {
        let task =
            json!({ "id": "task_1", "title": "T", "estimatedHours": "2.50", "progress": "0" });
        let payload = task_analytics_payload(&task, &json!({ "status": "done" }), 0);
        assert_eq!(payload["estimatedHours"], json!(2.5));
        assert_eq!(payload["progress"], json!(0));
        assert!(payload.get("actualHours").is_none());
        assert_eq!(payload["status"], json!("done"));
        assert_eq!(payload["number"], Value::Null);
    }

    #[test]
    fn time_entry_payload_rounds_hours() {
        let payload = time_entry_analytics_payload("te_1", None, None, "u", 50.0, None);
        assert_eq!(payload["durationSeconds"], json!(3000));
        assert_eq!(payload["actualHours"], json!(0.83));
        assert_eq!(payload["isBillable"], json!(true));
    }
}
