/**
 * What forms-api runs on submit: it never trusts the browser's path.
 */

import { collectAnswers } from './answers';
import { fieldsOf, isScoredField, type ChoiceField } from './blocks';
import { createEvalContext, selectedScore } from './conditions';
import type { Answers, ChoiceAnswer, FormDefinition } from './definition';
import { walk } from './path';
import type { AnswerError, EngineInput, QuizItem, SubmissionResult } from './types';

/** The selected ids of a choice answer, `other` included when "Other" has a text. */
function selectedIds(choice: ChoiceAnswer | undefined): Set<string> {
  if (!choice) return new Set();
  return new Set(choice.other === undefined ? choice.choiceIds : [...choice.choiceIds, 'other']);
}

/** A scored field's quiz item: right when exactly the correct choices are selected (null when none is marked correct). */
function quizItem(field: ChoiceField, choice: ChoiceAnswer | undefined): QuizItem {
  const selected = selectedIds(choice);
  const correctIds = field.properties.choices.filter((c) => c.correct === true).map((c) => c.id);
  const correct =
    correctIds.length === 0 ? null : selected.size === correctIds.length && correctIds.every((id) => selected.has(id));
  return { fieldId: field.id, correct, points: choice ? selectedScore(field, choice) : 0 };
}

/**
 * Normalises the answers, walks the path with the valid ones, and keeps the
 * errors and answers of the fields on the path only. An answer with an error
 * counts as unanswered for the logic and is left out of `answers`. Quiz items:
 * one per scored choice field on the path, in field order.
 */
export function evaluateSubmission(def: FormDefinition, input: EngineInput): SubmissionResult {
  const { valid, errors: allErrors } = collectAnswers(def, input.answers);
  const ctx = createEvalContext(def, valid, input.hidden);
  const { path, endingId, variables, visible } = walk(def, ctx);

  const errors: Record<string, AnswerError> = {};
  const answers: Answers = {};
  const quiz: QuizItem[] = [];
  for (const field of fieldsOf(def)) {
    if (!visible.has(field.id)) continue;
    const error = allErrors[field.id];
    if (error) errors[field.id] = error;
    const answer = valid[field.id];
    if (answer !== undefined) answers[field.id] = answer;

    if (isScoredField(field)) quiz.push(quizItem(field, answer as ChoiceAnswer | undefined));
  }

  const score = variables.score;
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    answers,
    path,
    endingId,
    variables,
    score: typeof score === 'number' ? score : 0,
    quiz,
  };
}
