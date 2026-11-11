//! The forms engine: `@weldsuite/forms-engine` (`packages/core/forms-engine`)
//! in Rust. The README there states the rules; the TypeScript source decides
//! where it is silent; the shared fixtures (`fixtures/*.json`, run by
//! `tests/fixtures.rs` and by Vitest) hold both to the same answers.
//!
//! | TypeScript | Rust |
//! |---|---|
//! | `formDefinitionSchema.safeParse` | [`FormDefinition::parse`] (serde reads it the same way) |
//! | `parseDefinition` | [`parse_definition`] |
//! | `validateDefinition` | [`validate_definition`] |
//! | `computePath`, `nextStep`, `firstStep`, `classicPages` | [`compute_path`], [`next_step`], [`first_step`], [`classic_pages`] |
//! | `evaluateSubmission` | [`evaluate_submission`] |
//! | `validateAnswer`, `normalizeAnswer(s)`, `isAnswered` | [`validate_answer`], [`normalize_answer`], [`normalize_answers`], [`is_answered`] |
//! | `recall(text, def, ctx, { encode })` | [`recall`] |
//! | `displayAnswer`, `searchText` | [`display_answer`], [`search_text`] |
//! | `fieldsOf`, `findBlock`, `findField`, `findFieldByRef` | [`fields_of`], [`find_block`], [`find_field`], [`find_field_by_ref`] |
//!
//! Not ported: the builder helpers (`createField`, `uniqueRef`, …), which only
//! the builder uses. The starter templates are exported, not retyped
//! (`catalogs/forms-templates.json`, `weldsuite_forms::starter_templates`).

pub mod answers;
pub mod blocks;
pub mod conditions;
pub mod definition;
pub mod display;
pub mod js;
pub mod path;
pub mod recall;
pub mod schema;
pub mod submission;
pub mod validate;

pub use answers::{
    AnswerError, AnswerErrorCode, AnswerValue, Answers, ChoiceAnswer, CollectedAnswers,
    PreparedAnswer, collect_answers, is_answered, normalize_answer, normalize_answers,
    prepare_answer, validate_answer,
};
pub use blocks::{
    ADDRESS_PARTS, BlockRef, CONTACT_PARTS, Part, block_fields, fields_of, find_block, find_field,
    find_field_by_ref, refs_of, top_level_block_of, top_level_index_of,
};
pub use conditions::{VarValue, VariableValues};
pub use definition::{
    Block, DEFINITION_SCHEMA_VERSION, Field, FieldKind, FileAnswerItem, FormDefinition,
    FormThemeTokens, GroupChild,
};
pub use display::{SEARCH_TEXT_MAX, display_answer, display_value, format_number, search_text};
pub use path::{EngineInput, PathResult, Step, classic_pages, compute_path, first_step, next_step};
pub use recall::{RecallContext, RecallKind, recall, recall_tokens, recall_value};
pub use schema::{PathSegment, SchemaIssue};
pub use submission::{QuizItem, SubmissionResult, evaluate_submission};
pub use validate::{DefinitionIssue, IssueCode, parse_definition, validate_definition};
