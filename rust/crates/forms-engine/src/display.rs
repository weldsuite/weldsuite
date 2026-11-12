//! Answers as human text: exports, recall, notification emails, entity
//! events and the search column (`display.ts`).

use std::collections::HashSet;

use serde_json::{Map, Value};

use super::answers::{AnswerValue, PreparedAnswer, prepare_answer};
use super::blocks::fields_of;
use super::definition::{Field, FieldKind, FormDefinition};
use super::js::number_text;

/// Longest [`search_text`] result, in code points.
pub const SEARCH_TEXT_MAX: usize = 10_000;

/// A number as text: JavaScript's `String(n)`, with `-0` as `0`.
pub fn format_number(number: f64) -> String {
    number_text(number)
}

/// An answer as human text; empty when there is no (well-formed) answer.
pub fn display_answer(field: &Field, raw: Option<&Value>) -> String {
    match prepare_answer(field, raw) {
        PreparedAnswer::Value(answer) => display_value(field, &answer),
        PreparedAnswer::Empty | PreparedAnswer::Invalid(_) => String::new(),
    }
}

/// A normalised answer as human text.
pub fn display_value(field: &Field, answer: &AnswerValue) -> String {
    match (&field.kind, answer) {
        (FieldKind::YesNo(_), AnswerValue::Bool(flag)) => {
            if *flag { "Yes" } else { "No" }.to_owned()
        }
        (FieldKind::Legal(_), AnswerValue::Bool(flag)) => {
            if *flag { "Accepted" } else { "Not accepted" }.to_owned()
        }
        (_, AnswerValue::Text(text)) => text.clone(),
        (_, AnswerValue::Number(number)) => format_number(*number),
        (_, AnswerValue::Choice(choice)) => {
            let selected: HashSet<&str> = choice.choice_ids.iter().map(String::as_str).collect();
            let mut labels: Vec<&str> = field
                .choices()
                .iter()
                .filter(|c| selected.contains(c.id.as_str()))
                .map(|c| c.label.as_str())
                .collect();
            if let Some(other) = &choice.other {
                labels.push(other);
            }
            labels.join(", ")
        }
        (_, AnswerValue::Ranking(ids)) => {
            let choices = field.choices();
            ids.iter()
                .enumerate()
                .map(|(i, id)| {
                    // `new Map(choices.map(c => [c.id, c.label]))`: the last label of a repeated id.
                    let label = choices
                        .iter()
                        .rev()
                        .find(|c| c.id == *id)
                        .map_or(id.as_str(), |c| c.label.as_str());
                    format!("{}. {label}", i + 1)
                })
                .collect::<Vec<_>>()
                .join(", ")
        }
        (FieldKind::Matrix(props), AnswerValue::Matrix(_)) => {
            let mut parts = Vec::new();
            for row in &props.rows {
                let Some(columns) = answer.row(&row.id) else {
                    continue;
                };
                let selected: HashSet<&str> = columns.iter().map(String::as_str).collect();
                let labels: Vec<&str> = props
                    .columns
                    .iter()
                    .filter(|c| selected.contains(c.id.as_str()))
                    .map(|c| c.label.as_str())
                    .collect();
                parts.push(format!("{}: {}", row.label, labels.join(", ")));
            }
            parts.join("; ")
        }
        (_, AnswerValue::Files(items)) => items
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        (_, AnswerValue::File(item)) => item.name.clone(),
        (FieldKind::ContactInfo(_), AnswerValue::Parts(_)) => {
            let name = ["firstName", "lastName"]
                .iter()
                .filter_map(|part| answer.part(part))
                .collect::<Vec<_>>()
                .join(" ");
            std::iter::once(name.as_str())
                .chain(
                    ["email", "phone", "company"]
                        .iter()
                        .filter_map(|part| answer.part(part)),
                )
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        }
        (_, AnswerValue::Parts(_)) => field
            .parts()
            .iter()
            .filter_map(|part| answer.part(part.name))
            .collect::<Vec<_>>()
            .join(", "),
        // An answer of another field's shape never reaches here.
        _ => String::new(),
    }
}

/// Lowercased text of the free-text answers, contact and address parts and
/// Other texts, in field order, joined with spaces and cut at 10,000 code
/// points: `form_responses.search_text`.
pub fn search_text(def: &FormDefinition, answers: &Map<String, Value>) -> String {
    let mut parts: Vec<String> = Vec::new();
    for field in fields_of(def) {
        let PreparedAnswer::Value(answer) = prepare_answer(field, answers.get(&field.id)) else {
            continue;
        };
        match (&answer, field.kind.is_text(), field.kind.is_composite()) {
            (AnswerValue::Text(text), true, _) => parts.push(text.clone()),
            (AnswerValue::Parts(_), _, true) => {
                for part in field.parts() {
                    if let Some(value) = answer.part(part.name) {
                        parts.push(value.to_owned());
                    }
                }
            }
            (AnswerValue::Choice(choice), _, _) => {
                if let Some(other) = &choice.other {
                    parts.push(other.clone());
                }
            }
            _ => {}
        }
    }
    let text = parts.join(" ").to_lowercase();
    match text.char_indices().nth(SEARCH_TEXT_MAX) {
        Some((cut, _)) => text[..cut].to_owned(),
        None => text,
    }
}
