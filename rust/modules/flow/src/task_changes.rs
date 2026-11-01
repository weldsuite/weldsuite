//! The field-level diff of a task update (`lib/task-changes.ts`), published
//! with the `updated` event so the History tab can say what changed.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::js::{Js, stringify};
use crate::task_enrich::assignee_ids_of;

/// Columns worth an audit line, in display order.
const TRACKED_FIELDS: [&str; 16] = [
    "title",
    "description",
    "status",
    "priority",
    "type",
    "dueDate",
    "startDate",
    "labels",
    "tags",
    "repeat",
    "parentTaskId",
    "sprintId",
    "milestoneId",
    "storyPoints",
    "estimatedHours",
    "isBillable",
];

const MAX_TEXT_LENGTH: usize = 120;

/// An update's columns as JavaScript holds them: `None` is `undefined`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Update(pub(crate) Vec<(String, Js)>);

impl Update {
    pub(crate) fn get(&self, key: &str) -> Option<&Js> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// `update[key] = value`, keeping the key's first position.
    pub(crate) fn set(&mut self, key: &str, value: Js) {
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key.to_owned(), value)),
        }
    }

    pub(crate) fn remove(&mut self, key: &str) {
        self.0.retain(|(k, _)| k != key);
    }

    /// The `serde_json` object (for the SQL's jsonb parameter).
    pub(crate) fn to_value(&self) -> Value {
        Value::Object(
            self.0
                .iter()
                .map(|(k, v)| (k.clone(), crate::js::whole_numbers(&v.to_value())))
                .collect::<Map<String, Value>>(),
        )
    }
}

/// `asNumber`: `numeric` columns come back as "2.00" while a PATCH sends "2".
fn as_number(value: &Js) -> Js {
    match value {
        Js::Null => Js::Null,
        Js::String(text) if text.is_empty() => Js::Null,
        Js::String(text) => {
            let n = weldsuite_kit::validation::js_number(text);
            if n.is_nan() {
                value.clone()
            } else {
                Js::Number(n)
            }
        }
        Js::Bool(flag) => Js::Number(f64::from(u8::from(*flag))),
        // Arrays and objects stay as they are (`Number([])` would be 0).
        Js::Number(_) | Js::Array(_) | Js::Object(_) => value.clone(),
    }
}

fn normalise(field: &str, value: Option<&Js>) -> Js {
    let Some(value) = value else {
        return Js::Null;
    };
    if field == "estimatedHours" {
        return as_number(value);
    }
    value.clone()
}

/// Descriptions are rich text: a short plain-text excerpt.
fn excerpt(value: &Js) -> Js {
    let Js::String(text) = value else {
        return value.clone();
    };
    let mut stripped = String::with_capacity(text.len());
    let mut in_tag = false;
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !in_tag && c == '<' && chars[i + 1..].contains(&'>') {
            in_tag = true;
            stripped.push(' ');
        } else if in_tag && c == '>' {
            in_tag = false;
        } else if !in_tag {
            stripped.push(c);
        }
        i += 1;
    }
    let collapsed = stripped
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if weldsuite_flow_domain::js::utf16_len(&collapsed) > MAX_TEXT_LENGTH {
        Js::String(format!(
            "{}...",
            weldsuite_flow_domain::js::slice_utf16(&collapsed, MAX_TEXT_LENGTH)
        ))
    } else {
        Js::String(collapsed)
    }
}

/// A row's value as JavaScript reads it: jsonb objects in jsonb's order.
pub(crate) fn row_js(row: &Value, key: &str) -> Option<Js> {
    row.get(key).map(Js::from_jsonb)
}

fn ids_label(ids: &[String], names: &HashMap<String, String>) -> Value {
    if ids.is_empty() {
        return Value::Null;
    }
    Value::String(
        ids.iter()
            .map(|id| names.get(id).cloned().unwrap_or_else(|| id.clone()))
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// `{ ...existing, ...update }` as far as the assignee columns go.
fn merged_assignees(existing: &Value, update: &Update) -> Value {
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    for key in ["assigneeIds", "assigneeId"] {
        if let Some(value) = update.get(key) {
            merged.insert(key.to_owned(), value.to_value());
        }
    }
    Value::Object(merged)
}

/// `assigneeIdsInvolved(existing, update)`.
pub(crate) fn assignee_ids_involved(existing: &Value, update: &Update) -> Vec<String> {
    if update.get("assigneeIds").is_none() && update.get("assigneeId").is_none() {
        return Vec::new();
    }
    let mut ids = assignee_ids_of(existing);
    for id in assignee_ids_of(&merged_assignees(existing, update)) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// `buildTaskChanges(existing, update, names)`: `None` when nothing tracked
/// changed.
pub(crate) fn build_task_changes(
    existing: &Value,
    update: &Update,
    names: &HashMap<String, String>,
) -> Option<Map<String, Value>> {
    let mut changes = Map::new();
    for field in TRACKED_FIELDS {
        let Some(next) = update.get(field) else {
            continue;
        };
        let before = normalise(field, row_js(existing, field).as_ref());
        let after = normalise(field, Some(next));
        if stringify(&before) != stringify(&after) {
            let (old, new) = if field == "description" {
                (excerpt(&before), excerpt(&after))
            } else {
                (before, after)
            };
            changes.insert(
                field.to_owned(),
                json!({ "old": old.to_value(), "new": new.to_value() }),
            );
        }
    }
    if update.get("assigneeIds").is_some() || update.get("assigneeId").is_some() {
        let old_ids = assignee_ids_of(existing);
        let new_ids = assignee_ids_of(&merged_assignees(existing, update));
        if old_ids.join(",") != new_ids.join(",") {
            changes.insert(
                "assigneeName".to_owned(),
                json!({ "old": ids_label(&old_ids, names), "new": ids_label(&new_ids, names) }),
            );
        }
    }
    if !changes.contains_key("status")
        && let Some(stage) = update.get("stageId")
    {
        let current = existing.get("stageId").cloned().unwrap_or(Value::Null);
        let next = stage.to_value();
        if next != current {
            changes.insert("stageId".to_owned(), json!({ "old": current, "new": next }));
        }
    }
    (!changes.is_empty()).then_some(changes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptions_shrink_to_plain_text() {
        let long = format!("<p>{}</p>", "word ".repeat(40));
        let Js::String(text) = excerpt(&Js::String(long)) else {
            panic!("text");
        };
        assert!(text.ends_with("..."));
        assert_eq!(
            excerpt(&Js::String("<b>Hi</b>  there".to_owned())),
            Js::String("Hi there".to_owned())
        );
    }

    #[test]
    fn numeric_strings_compare_as_numbers() {
        let existing = json!({ "estimatedHours": "2.00", "status": "todo", "stageId": "s1" });
        let mut update = Update::default();
        update.set("estimatedHours", Js::String("2".to_owned()));
        update.set("stageId", Js::String("s2".to_owned()));
        let changes = build_task_changes(&existing, &update, &HashMap::new()).expect("changes");
        assert!(!changes.contains_key("estimatedHours"));
        assert_eq!(changes["stageId"], json!({ "old": "s1", "new": "s2" }));
    }
}
