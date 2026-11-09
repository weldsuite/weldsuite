# @weldsuite/forms-engine

The WeldForms definition and its rules, in pure TypeScript (Zod only), shared by
the builder, the renderer (`@weldsuite/forms-renderer`), forms-api and, through
the fixtures, the Rust backend (`rust/modules/forms`). See
`docs/plans/weldforms.md` and ADR FORMS-003.

## Contract

| Export | What it does |
|---|---|
| `formDefinitionSchema`, `FormDefinition`, block/field/logic schemas | `./definition.ts`: the shape |
| `parseDefinition(input)` | Zod parse + `validateDefinition`; `{ ok: true, definition }` or `{ ok: false, issues }` |
| `validateDefinition(def)` | rules the schema can't express (unique ids and refs, forward-only jumps, operands that exist); `DefinitionIssue[]` |
| `fieldsOf(def)` | every field in order, group children included |
| `findBlock(def, id)` | a top-level block, a group child, or undefined |
| `findField`, `findFieldByRef`, `topLevelIndexOf`, `blockFields`, `isFieldBlock`, `choicesOf`, `partsOf` | more lookups (`./blocks.ts`) |
| `computePath(def, input)` | walks the blocks with the answers given: `{ path, endingId, variables }` |
| `nextStep(def, input, currentBlockId)` | conversational navigation: the next block id or `{ endingId }` |
| `firstStep(def, input)` | the first block id, or `{ endingId }` for a form without content blocks |
| `classicPages(def, path)` | the path's block ids split at page breaks (`string[][]`, empty pages left out) |
| `isAnswered(field, value)` | whether a value counts as an answer (`false` does; a value of the wrong shape does) |
| `validateAnswer(field, value)` | one field; `undefined` value = unanswered; `AnswerError` or null |
| `normalizeAnswer(field, value)`, `normalizeAnswers(def, answers)` | the normalised answer(s); unanswered and wrong shapes left out |
| `evaluateSubmission(def, input)` | what forms-api runs on submit: path, required checks on the path, normalised answers, variables, score, quiz, ending |
| `recall(text, def, ctx, { encode? })` | fills `{{field:ref}}`, `{{hidden:name}}`, `{{var:name}}`; `encode` URL-encodes each value (redirect URLs) |
| `displayAnswer(field, value)` | an answer as human text (exports, recall, emails, events) |
| `searchText(def, answers)` | lowercased text answers for `form_responses.search_text` |
| `newBlockId(prefix)`, `createBlankDefinition()`, `createField(type, init)`, `createStatement`, `createGroup`, `createPageBreak`, `createEnding`, `createChoice`, `uniqueRef(def, base, ignoreId?)`, `slugifyRef` | builder helpers |
| `STARTER_TEMPLATES` | the built-in template gallery (8 templates, English content, en/nl names) |

## Rules

The Rust module implements the same rules; the fixtures pin them down.

### Path

- Start at the first block; skip page breaks; push each content block on the
  path (its group children become visible with it). Leaving a block: every
  choice field in it (the block, or a group's children) adds the selected
  choices' scores to `score`; then its calculations run in order; then the
  first jump whose condition holds is taken, else `otherwise`, else the next
  block. A jump to an ending ends the walk. Running past the last block picks
  the ending from `endingRules` (first match whose ending exists), else
  `endings[0]`.
- Only the first `logic` entry of a block counts.
- **Jumps go forward.** A jump to the source block, an earlier one, a page
  break or an unknown block, or to an unknown ending, counts as "next block"
  (`validateDefinition` reports it).
- **Only valid answers on the path count.** Answers are normalised and checked
  first; an answer with an error is empty for the logic. Conditions and
  calculations read an answer only once its block is on the path.
- `score` is an implicit number variable starting at 0; it can't be declared.

### Answers

Normalising (`undefined`, `null` and a blank string are no answer, for every type):

| Type | Normalised |
|---|---|
| text, email, phone, date | trimmed string |
| website | trimmed; `https://` prefixed when there is no `scheme://` |
| number, rating, opinion scale, NPS | a finite number (strings are not converted) |
| yes/no, legal | boolean |
| choice fields | `{ choiceIds, other? }`: ids de-duplicated, `''` dropped, a literal `other` id dropped unless a choice has that id; `other` trimmed, left out when blank; nothing left = no answer |
| ranking | the array as given (no de-duplication) |
| matrix | the field's rows only, in definition order; column ids de-duplicated; empty rows dropped |
| file upload | items reduced to `{ fileId, name, size, type }`, de-duplicated by `fileId` |
| signature | one item |
| contact info, address | enabled parts only, in definition order; trimmed; blank parts dropped |

A value of the wrong shape is `invalid` (for a matrix row or a sub-field, with
that `part`). Checks, first error wins:

| Type | Errors |
|---|---|
| short/long text | `too_long` (length in code points over `maxLength`) |
| email | `invalid_email`: `^[^\s@]+@[^\s@]+\.[^\s@]+$`, at most 254 code points |
| phone | `invalid_phone`: `^\+?[0-9 ()-]+$` with 6 to 20 digits |
| website | `invalid_url`: `^https?://[^\s/?#:@.]+(\.[^\s/?#:@.]+)+(:\d{1,5})?([/?#]\S*)?$`, case-insensitive |
| number | `not_integer` (decimals 0) / `too_many_decimals`: with `s = n * 10^decimals`, `|s - round(s)| > max(1e-9, |s| * 1e-12)`; then `too_small`, `too_large` |
| rating, opinion scale, NPS | `invalid` unless an integer in 1..steps, start..end, 0..10 |
| date | `invalid_date` (not `YYYY-MM-DD` or not a real date, year 1 to 9999), `date_too_early`, `date_too_late` |
| choice fields | `invalid_choice` (unknown id, or Other text without `allowOther`; a dropdown has no Other); single select: `too_many_choices` over 1; multiple: `too_few_choices` / `too_many_choices` against min/max. Other counts as a selection |
| legal | `must_accept` when required and `false` |
| ranking | `invalid` unless a permutation of all choice ids |
| matrix | per row in definition order: missing row in a required matrix `required`, unknown column `invalid_choice`, several columns in a single-select row `too_many_choices`; `part` = row id |
| file upload | `too_many_files` |
| contact info, address | per enabled part in order: missing required part `required`; contact email `invalid_email`, contact phone `invalid_phone`; `part` = sub-field |

Unanswered + `required` = `required` (no part).

### Conditions

Operand values: numeric fields a number; yes/no and legal a boolean; choice
fields the selected ids plus `other` when there is an Other text; a ranking its
ids; a matrix with `rowId` that row's column ids (without: answered or not); a
contact/address `part` that part's text (without: answered or not); text
fields, dates and hidden values a trimmed string; variables their value (a
text variable `''` is empty); constants themselves (an array is a set of ids).

- **Empty values.** A condition on an empty value (left or right) is false
  for every operator except `is_empty` (and `is_answered` is false).
- Values of kinds that can't be compared make every operator false, `is_not`
  included.
- Text compares case-insensitively after trimming (`contains`, `starts_with`,
  … too); dates (`before`, `after`) compare as trimmed strings.
- Choice sets: `is` = any of, `is_not` = none of; with a string (one id) or an
  array; `any_of`, `all_of`, `none_of`. Ids compare exactly.
- Numbers: `is`, `is_not`, `greater_than`, `greater_or_equal`, `less_than`,
  `less_or_equal`; no conversion from text.

`validateDefinition` checks the operator against the operand kinds
(`operator_mismatch`): number ↔ number; boolean ↔ boolean (`is`, `is_not`);
text ↔ text (equality and the text operators); date ↔ date or text, a text
constant must be `YYYY-MM-DD` (equality, `before`, `after`); choice set ↔ text
or array (equality and the set operators); ranking, files, a matrix without
`rowId` and a composite without `part` only `is_answered` / `is_empty`.

### Definition checks

`validateDefinition`, one issue per occurrence: `duplicate_id` (top-level
blocks, group children and endings share one namespace; choice, row and column
ids are unique per field), `duplicate_ref` (blocks, children, endings),
`duplicate_hidden`, `duplicate_variable`, `reserved_variable` (declaring
`score`); per logic entry: `unknown_block` (not a top-level block),
`logic_on_page_break`, `duplicate_logic` (second entry for a valid block);
jump and `otherwise` targets: `unknown_block`, `unknown_ending`,
`backward_jump` (not after the source, or a page break); operands:
`unknown_field` (statements, groups and page breaks aren't fields),
`unknown_row` (missing row, or `rowId` on a non-matrix), `unknown_part`,
`unknown_hidden`, `unknown_variable`, `operand_after_source` (logic reads a
field whose top-level block comes after the source; ending rules may read any
field); `operator_mismatch` (see above; also a missing right operand);
calculations: `unknown_variable`, `variable_type` (a text variable takes only
`set` and `add`); fields: `selection_range` (min > max, min or max above the
number of options counting Other, or min > 1 on a single select),
`number_range`, `date_range`; `endingRules`: `unknown_ending`.

### Calculations

- Number variables: the operand as a number: numeric fields their number,
  yes/no and legal 1 or 0, choice fields the sum of the selected choices'
  scores, hidden values and texts when they hold a plain decimal
  (`^-?\d+(\.\d+)?$`), constants (booleans 1/0). Anything else, or an empty
  operand, skips the calculation. Dividing by zero, or a result that isn't
  finite, leaves the variable unchanged.
- Results are rounded to 10 decimals, half away from zero, `-0` as `0`
  (values of 1e15 and up are left as they are).
- Text variables: `set` replaces, `add` appends the operand as text (a
  field's `displayAnswer`, a number as JavaScript's `String(n)`, booleans
  `true`/`false`); other operations are skipped.

### Submission

`evaluateSubmission`: errors and answers of fields on the path only (answers
to statements, unknown ids and skipped blocks are dropped; answers with an
error too); `score` = `variables.score`; one quiz item per choice field on the
path with a scored or correct choice: `correct` = the selected set (Other
included) equals the set of `correct: true` choices, null when none is marked;
`points` = the selected choices' scores. `ok` = no errors.

### Display, recall and search

`displayAnswer`: choice labels in definition order joined with `, `, then the
Other text; yes/no `Yes`/`No`; legal `Accepted`/`Not accepted`; ranking
`1. A, 2. B`; matrix `Row: Col, Col; Row2: Col` in row order; file names
joined with `, `; contact info `First Last, email, phone, company`; address
parts joined with `, `; numbers as `String(n)`. Recall: unknown references
become `''`; `encode` uses `encodeURIComponent`. `searchText`: text-field
answers, contact/address parts and Other texts in field order, joined with
spaces, lowercased, cut at 10,000 code points.

## Fixtures

`fixtures/*.json`:

```
{ name, definition,
  cases: [{ name, answers, hidden?, expect: { ok, path, endingId, variables, errors, answers, score, quiz } }],
  recall?: [{ name, text, answers, hidden?, variables?, encode?, expect }],
  display?: [{ name, fieldId, value, expect }],
  searchText?: [{ name, answers, expect }] }
```

`expect` is the exact `evaluateSubmission` result (`computePath` must give the
same path, ending and variables). `fixtures/invalid/*.json`:
`{ name, definition, expectIssues: [code, …] }`; the issue codes compared as a
sorted list, one issue per occurrence (a duplicate is reported on every
occurrence after the first). Vitest runs them here; the Rust module's tests
run the same files, so both backends decide alike.
