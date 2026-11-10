//! What forms-api runs on submit: it never trusts the browser's path
//! (`submission.ts`).

use std::collections::{BTreeMap, HashSet};

use serde::Serialize;

use super::answers::{AnswerError, AnswerValue, Answers, ChoiceAnswer, collect_answers};
use super::blocks::fields_of;
use super::conditions::{VariableValues, create_eval_context, selected_score};
use super::definition::FormDefinition;
use super::js::ser_num;
use super::path::{EngineInput, walk};

/// One scored choice field on the path.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizItem {
    pub field_id: String,
    /// `None` (`null`) when the field has no correct choice marked.
    pub correct: Option<bool>,
    #[serde(serialize_with = "ser_num")]
    pub points: f64,
}

/// `evaluateSubmission`'s result.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionResult {
    pub ok: bool,
    /// By field id (group children included).
    pub errors: BTreeMap<String, AnswerError>,
    /// Normalised answers of the fields on the path; everything else dropped.
    pub answers: Answers,
    pub path: Vec<String>,
    pub ending_id: String,
    pub variables: VariableValues,
    /// `variables.score`.
    #[serde(serialize_with = "ser_num")]
    pub score: f64,
    pub quiz: Vec<QuizItem>,
}

/// Normalises the answers, walks the path with the valid ones, and keeps the
/// errors and answers of the fields on the path only. An answer with an
/// error counts as unanswered for the logic and is left out of `answers`.
/// Quiz items: one per scored choice field on the path, in field order.
pub fn evaluate_submission(def: &FormDefinition, input: EngineInput<'_>) -> SubmissionResult {
    let collected = collect_answers(def, input.answers);
    let ctx = create_eval_context(def, &collected.valid, input.hidden);
    let walked = walk(def, ctx);

    let mut errors = BTreeMap::new();
    let mut answers = Answers::new();
    let mut quiz = Vec::new();
    for field in fields_of(def) {
        if !walked.visible.contains(field.id.as_str()) {
            continue;
        }
        if let Some(error) = collected.errors.get(&field.id) {
            errors.insert(field.id.clone(), error.clone());
        }
        let answer = collected.valid.get(&field.id);
        if let Some(answer) = answer {
            answers.insert(field.id.clone(), answer.clone());
        }

        if field.is_scored() {
            let choice = answer.and_then(AnswerValue::as_choice);
            let selected: HashSet<String> = choice
                .map(ChoiceAnswer::selected_with_other)
                .unwrap_or_default()
                .into_iter()
                .collect();
            let correct_ids: Vec<&str> = field
                .choices()
                .iter()
                .filter(|c| c.correct == Some(true))
                .map(|c| c.id.as_str())
                .collect();
            let correct = (!correct_ids.is_empty()).then(|| {
                selected.len() == correct_ids.len()
                    && correct_ids.iter().all(|id| selected.contains(*id))
            });
            quiz.push(QuizItem {
                field_id: field.id.clone(),
                correct,
                points: choice.map_or(0.0, |c| selected_score(field, c)),
            });
        }
    }

    let path = walked.path;
    SubmissionResult {
        ok: errors.is_empty(),
        errors,
        answers,
        score: path.variables.score(),
        path: path.path,
        ending_id: path.ending_id,
        variables: path.variables,
        quiz,
    }
}
