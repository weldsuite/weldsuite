/**
 * Rules a definition must follow that the Zod schema can't express.
 *
 * Issues are reported per occurrence: a duplicate is reported on the second
 * (and every later) occurrence, never on the first.
 */

import { ADDRESS_PARTS, CONTACT_PARTS, choicesOf, isFieldBlock } from './blocks';
import {
  formDefinitionSchema,
  type Condition,
  type ConditionGroup,
  type ConditionOperator,
  type FieldBlock,
  type FieldBlockOf,
  type FormDefinition,
  type LogicTarget,
  type Operand,
} from './definition';
import type { DefinitionIssue, DefinitionIssueCode } from './types';

export type ParseDefinitionResult = { ok: true; definition: FormDefinition } | { ok: false; issues: DefinitionIssue[] };

/** Zod parse, then `validateDefinition`. */
export function parseDefinition(input: unknown): ParseDefinitionResult {
  const parsed = formDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({ code: 'schema', message: issue.message, path: issue.path.join('.') })),
    };
  }
  const issues = validateDefinition(parsed.data);
  return issues.length === 0 ? { ok: true, definition: parsed.data } : { ok: false, issues };
}

/**
 * What a condition operand holds, for operator checks:
 * `set` = choice ids (choice fields, a matrix row), `list` = a constant array,
 * `opaque` = answered or not, nothing to compare.
 */
export type OperandKind = 'number' | 'boolean' | 'text' | 'date' | 'set' | 'list' | 'opaque';

const NUMBER_OPS = ['is', 'is_not', 'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal'] as const;
const TEXT_OPS = ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'ends_with'] as const;
const DATE_OPS = ['is', 'is_not', 'before', 'after'] as const;
const SET_OPS = ['is', 'is_not', 'any_of', 'all_of', 'none_of'] as const;

type OperatorRules = Partial<Record<ConditionOperator, readonly OperandKind[]>>;

function rules(operators: readonly ConditionOperator[], right: readonly OperandKind[]): OperatorRules {
  const out: OperatorRules = {};
  for (const op of operators) out[op] = right;
  return out;
}

/** For each left-hand kind: the operators it allows and the right-hand kinds they take. */
const OPERATOR_RULES: Record<OperandKind, OperatorRules> = {
  number: rules(NUMBER_OPS, ['number']),
  boolean: rules(['is', 'is_not'], ['boolean']),
  text: rules(TEXT_OPS, ['text']),
  date: rules(DATE_OPS, ['date', 'text']),
  set: rules(SET_OPS, ['text', 'list']),
  list: {},
  opaque: {},
};

const DATE_TEXT_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `left operator right` is a meaningful comparison. */
export function operatorAllowed(left: OperandKind, operator: ConditionOperator, right: OperandKind | null, rightOperand?: Operand): boolean {
  if (operator === 'is_answered' || operator === 'is_empty') return true;
  if (right === null) return false;
  const allowed = OPERATOR_RULES[left][operator];
  if (!allowed || !allowed.includes(right)) return false;
  // A date compares with a date constant only.
  if (left === 'date' && rightOperand?.type === 'constant') {
    return typeof rightOperand.value === 'string' && DATE_TEXT_RE.test(rightOperand.value.trim());
  }
  return true;
}

/** The kind of a field operand (with its `rowId` / `part`). */
export function fieldOperandKind(field: FieldBlock, operand: { rowId?: string; part?: string }): OperandKind {
  switch (field.type) {
    case 'number':
    case 'rating':
    case 'opinion_scale':
    case 'nps':
      return 'number';
    case 'yes_no':
    case 'legal':
      return 'boolean';
    case 'multiple_choice':
    case 'dropdown':
    case 'picture_choice':
      return 'set';
    case 'matrix':
      return operand.rowId !== undefined ? 'set' : 'opaque';
    case 'contact_info':
    case 'address':
      return operand.part !== undefined ? 'text' : 'opaque';
    case 'date':
      return 'date';
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'website':
      return 'text';
    case 'ranking':
    case 'file_upload':
    case 'signature':
      return 'opaque';
  }
}

type FieldOperand = Extract<Operand, { type: 'field' }>;

/** The parts a field operand may name: contact info and address parts; none for other fields. */
function partNames(field: FieldBlock): readonly string[] {
  if (field.type === 'contact_info') return CONTACT_PARTS;
  if (field.type === 'address') return ADDRESS_PARTS;
  return [];
}

function constantKind(value: Extract<Operand, { type: 'constant' }>['value']): OperandKind {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'text';
  return 'list';
}

export function validateDefinition(def: FormDefinition): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const add = (code: DefinitionIssueCode, message: string, path: string, blockId?: string) => {
    issues.push(blockId === undefined ? { code, message, path } : { code, message, path, blockId });
  };

  // --- ids and refs -------------------------------------------------------
  const ids = new Set<string>();
  const refs = new Set<string>();
  const checkIdAndRef = (item: { id: string; ref: string }, path: string) => {
    if (ids.has(item.id)) add('duplicate_id', `The id "${item.id}" is used more than once.`, `${path}.id`, item.id);
    else ids.add(item.id);
    if (refs.has(item.ref)) add('duplicate_ref', `The ref "${item.ref}" is used more than once.`, `${path}.ref`, item.id);
    else refs.add(item.ref);
  };

  /** Fields by id with the index of the top-level block that holds them. */
  const fields = new Map<string, { field: FieldBlock; index: number }>();
  const registerField = (field: FieldBlock, index: number) => {
    if (!fields.has(field.id)) fields.set(field.id, { field, index });
  };

  def.blocks.forEach((block, i) => {
    const path = `blocks.${i}`;
    checkIdAndRef(block, path);
    if (block.type === 'group') {
      block.children.forEach((child, j) => {
        const childPath = `${path}.children.${j}`;
        checkIdAndRef(child, childPath);
        if (isFieldBlock(child)) {
          registerField(child, i);
          checkField(child, childPath, add);
        }
      });
    } else if (isFieldBlock(block)) {
      registerField(block, i);
      checkField(block, path, add);
    }
  });
  def.endings.forEach((ending, i) => checkIdAndRef(ending, `endings.${i}`));

  // --- hidden fields and variables ----------------------------------------
  const hiddenNames = new Set<string>();
  def.hidden.forEach((h, i) => {
    if (hiddenNames.has(h.name)) add('duplicate_hidden', `The hidden field "${h.name}" is declared more than once.`, `hidden.${i}.name`);
    else hiddenNames.add(h.name);
  });

  const variableTypes = new Map<string, 'number' | 'text'>();
  def.variables.forEach((v, i) => {
    if (v.name === 'score') add('reserved_variable', 'The variable "score" always exists and cannot be declared.', `variables.${i}.name`);
    else if (variableTypes.has(v.name)) add('duplicate_variable', `The variable "${v.name}" is declared more than once.`, `variables.${i}.name`);
    else variableTypes.set(v.name, v.type);
  });
  const variableType = (name: string) => (name === 'score' ? 'number' : variableTypes.get(name));

  // --- logic --------------------------------------------------------------
  const blockIndex = new Map<string, number>();
  def.blocks.forEach((b, i) => {
    if (!blockIndex.has(b.id)) blockIndex.set(b.id, i);
  });
  const endingIds = new Set(def.endings.map((e) => e.id));

  /** Checks a field operand: the field, its row or part, and that it comes no later than the logic's block. */
  const checkFieldOperand = (operand: FieldOperand, path: string, source: number | null): OperandKind | null => {
    const entry = fields.get(operand.id);
    if (!entry) {
      add('unknown_field', `No field has the id "${operand.id}".`, `${path}.id`);
      return null;
    }
    const { field, index } = entry;
    if (operand.rowId !== undefined && (field.type !== 'matrix' || !field.properties.rows.some((r) => r.id === operand.rowId))) {
      add('unknown_row', `The field "${field.ref}" has no row "${operand.rowId}".`, `${path}.rowId`, field.id);
      return null;
    }
    if (operand.part !== undefined && !partNames(field).includes(operand.part)) {
      add('unknown_part', `The field "${field.ref}" has no part "${operand.part}".`, `${path}.part`, field.id);
      return null;
    }
    if (source !== null && index > source) {
      add('operand_after_source', `The field "${field.ref}" comes after the block this logic belongs to.`, path, field.id);
    }
    return fieldOperandKind(field, operand);
  };

  /** Checks an operand; returns its kind, or null when it refers to nothing. `source` = index of the logic's block. */
  const checkOperand = (operand: Operand, path: string, source: number | null): OperandKind | null => {
    switch (operand.type) {
      case 'field':
        return checkFieldOperand(operand, path, source);
      case 'hidden':
        if (!hiddenNames.has(operand.name)) {
          add('unknown_hidden', `No hidden field is named "${operand.name}".`, `${path}.name`);
          return null;
        }
        return 'text';
      case 'variable': {
        const type = variableType(operand.name);
        if (!type) {
          add('unknown_variable', `No variable is named "${operand.name}".`, `${path}.name`);
          return null;
        }
        return type;
      }
      case 'constant':
        return constantKind(operand.value);
    }
  };

  const checkCondition = (condition: Condition, path: string, source: number | null) => {
    const left = checkOperand(condition.left, `${path}.left`, source);
    if (condition.operator === 'is_answered' || condition.operator === 'is_empty') return;
    if (condition.right === undefined) {
      add('operator_mismatch', `"${condition.operator}" needs a value to compare with.`, path);
      return;
    }
    const right = checkOperand(condition.right, `${path}.right`, source);
    if (left === null || right === null) return;
    if (!operatorAllowed(left, condition.operator, right, condition.right)) {
      add('operator_mismatch', `"${condition.operator}" can't compare a ${left} with a ${right}.`, path);
    }
  };

  const checkGroup = (group: ConditionGroup, path: string, source: number | null) => {
    group.conditions.forEach((item, k) => {
      if ('op' in item) item.conditions.forEach((c, m) => checkCondition(c, `${path}.conditions.${k}.conditions.${m}`, source));
      else checkCondition(item, `${path}.conditions.${k}`, source);
    });
  };

  const checkTarget = (target: LogicTarget, path: string, source: number | null) => {
    if (target.type === 'ending') {
      if (!endingIds.has(target.id)) add('unknown_ending', `No ending has the id "${target.id}".`, `${path}.id`);
      return;
    }
    const index = blockIndex.get(target.id);
    if (index === undefined) {
      add('unknown_block', `No top-level block has the id "${target.id}".`, `${path}.id`);
      return;
    }
    if (def.blocks[index]?.type === 'page_break' || (source !== null && index <= source)) {
      add('backward_jump', 'A jump must go to a later question, statement or group.', path, target.id);
    }
  };

  const logicBlocks = new Set<string>();
  def.logic.forEach((logic, li) => {
    const path = `logic.${li}`;
    const index = blockIndex.get(logic.blockId);
    let source: number | null = null;
    if (index === undefined) {
      add('unknown_block', `No top-level block has the id "${logic.blockId}".`, `${path}.blockId`);
    } else if (def.blocks[index]?.type === 'page_break') {
      add('logic_on_page_break', 'A page break has no logic.', `${path}.blockId`, logic.blockId);
    } else {
      source = index;
      if (logicBlocks.has(logic.blockId)) add('duplicate_logic', 'This block already has logic.', `${path}.blockId`, logic.blockId);
      else logicBlocks.add(logic.blockId);
    }

    logic.calculations.forEach((calc, ci) => {
      const calcPath = `${path}.calculations.${ci}`;
      if (calc.when) checkGroup(calc.when, `${calcPath}.when`, source);
      const type = variableType(calc.variable);
      if (!type) add('unknown_variable', `No variable is named "${calc.variable}".`, `${calcPath}.variable`);
      else if (type === 'text' && calc.op !== 'set' && calc.op !== 'add') {
        add('variable_type', `A text variable can only be set or appended to, not "${calc.op}".`, `${calcPath}.op`);
      }
      checkOperand(calc.value, `${calcPath}.value`, source);
    });
    logic.jumps.forEach((jump, ji) => {
      checkGroup(jump.when, `${path}.jumps.${ji}.when`, source);
      checkTarget(jump.to, `${path}.jumps.${ji}.to`, source);
    });
    if (logic.otherwise) checkTarget(logic.otherwise, `${path}.otherwise`, source);
  });

  def.endingRules.forEach((rule, ri) => {
    checkGroup(rule.when, `endingRules.${ri}.when`, null);
    if (!endingIds.has(rule.endingId)) add('unknown_ending', `No ending has the id "${rule.endingId}".`, `endingRules.${ri}.endingId`);
  });

  return issues;
}

type AddIssue = (code: DefinitionIssueCode, message: string, path: string, blockId?: string) => void;

/** Whether a choice field's min and max selections fit each other and its options ("Other" included). */
function selectionRangeFits(field: FieldBlockOf<'multiple_choice' | 'picture_choice'>): boolean {
  const { minSelections: min, maxSelections: max, multiple, allowOther } = field.properties;
  const options = field.properties.choices.length + (allowOther ? 1 : 0);
  const wrong =
    (min !== undefined && max !== undefined && min > max) ||
    (min !== undefined && min > options) ||
    (max !== undefined && max > options) ||
    (!multiple && min !== undefined && min > 1);
  return !wrong;
}

/** Per-field rules: unique choice/row/column ids, selection, number and date ranges. */
function checkField(field: FieldBlock, path: string, add: AddIssue): void {
  const checkUnique = (items: Array<{ id: string }>, itemsPath: string) => {
    const seen = new Set<string>();
    items.forEach((item, k) => {
      if (seen.has(item.id)) add('duplicate_id', `The id "${item.id}" is used more than once in this field.`, `${itemsPath}.${k}.id`, field.id);
      else seen.add(item.id);
    });
  };
  const choices = choicesOf(field);
  if (choices.length > 0) checkUnique(choices, `${path}.properties.choices`);

  switch (field.type) {
    case 'matrix':
      checkUnique(field.properties.rows, `${path}.properties.rows`);
      checkUnique(field.properties.columns, `${path}.properties.columns`);
      break;
    case 'multiple_choice':
    case 'picture_choice':
      if (!selectionRangeFits(field)) {
        add('selection_range', 'The number of selections allowed does not fit the choices.', `${path}.properties`, field.id);
      }
      break;
    case 'number': {
      const { min, max } = field.properties;
      if (min !== undefined && max !== undefined && min > max) add('number_range', 'The minimum is above the maximum.', `${path}.properties`, field.id);
      break;
    }
    case 'date': {
      const { min, max } = field.properties;
      if (min !== undefined && max !== undefined && min > max) add('date_range', 'The earliest date is after the latest date.', `${path}.properties`, field.id);
      break;
    }
    default:
      break;
  }
}
