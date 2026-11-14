//! A response as question/answer text for emails (`services/response-text.ts`):
//! in form order, through the engine's `display_answer`, without files and
//! signatures and, for a copy that leaves the workspace, without the fields
//! the author marked sensitive.

use serde_json::Value;
use weldsuite_emails::forms::QuestionAnswer;

use crate::engine::{FieldKind, FormDefinition, display_answer, fields_of};

/// `hasSensitiveFields(def)`.
pub(crate) fn has_sensitive_fields(definition: &FormDefinition) -> bool {
    fields_of(definition)
        .iter()
        .any(|field| field.sensitive == Some(true))
}

/// `answerPairs(def, answers, { skipSensitive })`.
pub(crate) fn answer_pairs(
    definition: &FormDefinition,
    answers: &Value,
    skip_sensitive: bool,
) -> Vec<QuestionAnswer> {
    let mut out = Vec::new();
    for field in fields_of(definition) {
        if matches!(
            field.kind,
            FieldKind::FileUpload(_) | FieldKind::Signature(_)
        ) {
            continue;
        }
        if skip_sensitive && field.sensitive == Some(true) {
            continue;
        }
        // `answers[field.id]`: an own property that is not `undefined`.
        let Some(value) = answers.as_object().and_then(|a| a.get(&field.id)) else {
            continue;
        };
        let answer = display_answer(field, Some(value));
        if !answer.is_empty() {
            let question = if field.title.is_empty() {
                field.r#ref.clone()
            } else {
                field.title.clone()
            };
            out.push(QuestionAnswer { question, answer });
        }
    }
    out
}
