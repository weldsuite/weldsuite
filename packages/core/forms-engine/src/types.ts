/**
 * Result types of the engine functions (see README.md for the contract).
 */

import type { Answers } from './definition';

export type VariableValues = Record<string, number | string>;

export interface EngineInput {
  answers: Answers;
  /** Hidden-field values by name; unknown names are ignored. */
  hidden?: Record<string, string>;
}

/** A problem with a definition, from `validateDefinition()`. */
export interface DefinitionIssue {
  code: DefinitionIssueCode;
  /** Human-readable, English; the builder maps `code` to a translated text. */
  message: string;
  /** JSON path into the definition, e.g. `blocks.3.properties.choices.1.id`. */
  path: string;
  blockId?: string;
}

export type DefinitionIssueCode =
  | 'schema'
  | 'duplicate_id'
  | 'duplicate_ref'
  | 'duplicate_hidden'
  | 'duplicate_variable'
  | 'reserved_variable'
  | 'unknown_block'
  | 'unknown_ending'
  | 'unknown_field'
  | 'unknown_row'
  | 'unknown_part'
  | 'unknown_hidden'
  | 'unknown_variable'
  | 'variable_type'
  | 'logic_on_page_break'
  | 'duplicate_logic'
  | 'backward_jump'
  | 'operand_after_source'
  | 'operator_mismatch'
  | 'selection_range'
  | 'number_range'
  | 'date_range';

export interface PathResult {
  /** Top-level block ids the respondent passes, in order (page breaks excluded). */
  path: string[];
  endingId: string;
  variables: VariableValues;
}

export type AnswerErrorCode =
  | 'required'
  | 'invalid'
  | 'invalid_email'
  | 'invalid_url'
  | 'invalid_phone'
  | 'invalid_date'
  | 'date_too_early'
  | 'date_too_late'
  | 'too_long'
  | 'too_small'
  | 'too_large'
  | 'not_integer'
  | 'too_many_decimals'
  | 'invalid_choice'
  | 'too_few_choices'
  | 'too_many_choices'
  | 'must_accept'
  | 'too_many_files';

export interface AnswerError {
  code: AnswerErrorCode;
  /** Sub-field (`email` of contact info, `postalCode` of address) or matrix row id. */
  part?: string;
}

export interface QuizItem {
  fieldId: string;
  /** null when the field has no correct choice marked. */
  correct: boolean | null;
  points: number;
}

export interface SubmissionResult {
  ok: boolean;
  /** By field id (group children included). */
  errors: Record<string, AnswerError>;
  /** Normalised answers of the fields on the path; everything else dropped. */
  answers: Answers;
  path: string[];
  endingId: string;
  variables: VariableValues;
  /** `variables.score`. */
  score: number;
  quiz: QuizItem[];
}

export interface RecallContext {
  answers: Answers;
  hidden?: Record<string, string>;
  variables?: VariableValues;
}
