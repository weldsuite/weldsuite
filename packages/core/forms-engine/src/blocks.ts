/**
 * Finding blocks and fields in a definition, and grouping field types by the
 * kind of answer they hold.
 */

import {
  CHOICE_FIELD_TYPES,
  FIELD_TYPES,
  FILE_FIELD_TYPES,
  type Block,
  type FieldBlock,
  type FieldBlockOf,
  type FieldType,
  type FormChoice,
  type FormDefinition,
} from './definition';

/** Free-text field types: the answer is a string. */
export const TEXT_FIELD_TYPES = ['short_text', 'long_text', 'email', 'phone', 'website'] as const;
/** Field types whose answer is a number. */
export const NUMERIC_FIELD_TYPES = ['number', 'rating', 'opinion_scale', 'nps'] as const;
/** Field types whose answer is a boolean. */
export const BOOLEAN_FIELD_TYPES = ['yes_no', 'legal'] as const;
/** Field types made of named sub-fields. */
export const COMPOSITE_FIELD_TYPES = ['contact_info', 'address'] as const;

/** Sub-fields of contact info, in display order. */
export const CONTACT_PARTS = ['firstName', 'lastName', 'email', 'phone', 'company'] as const;
/** Sub-fields of an address, in display order. */
export const ADDRESS_PARTS = ['line1', 'line2', 'city', 'state', 'postalCode', 'country'] as const;

export type ChoiceField = FieldBlockOf<(typeof CHOICE_FIELD_TYPES)[number]>;
export type TextField = FieldBlockOf<(typeof TEXT_FIELD_TYPES)[number]>;
export type NumericField = FieldBlockOf<(typeof NUMERIC_FIELD_TYPES)[number]>;
export type BooleanField = FieldBlockOf<(typeof BOOLEAN_FIELD_TYPES)[number]>;
export type CompositeField = FieldBlockOf<(typeof COMPOSITE_FIELD_TYPES)[number]>;
export type FileField = FieldBlockOf<(typeof FILE_FIELD_TYPES)[number]>;

const FIELD_TYPE_SET: ReadonlySet<string> = new Set<string>(FIELD_TYPES);
const CHOICE_SET: ReadonlySet<string> = new Set<string>(CHOICE_FIELD_TYPES);
const TEXT_SET: ReadonlySet<string> = new Set<string>(TEXT_FIELD_TYPES);
const NUMERIC_SET: ReadonlySet<string> = new Set<string>(NUMERIC_FIELD_TYPES);
const BOOLEAN_SET: ReadonlySet<string> = new Set<string>(BOOLEAN_FIELD_TYPES);
const COMPOSITE_SET: ReadonlySet<string> = new Set<string>(COMPOSITE_FIELD_TYPES);
const FILE_SET: ReadonlySet<string> = new Set<string>(FILE_FIELD_TYPES);

export function isFieldType(type: string): type is FieldType {
  return FIELD_TYPE_SET.has(type);
}

/** A question: anything but a statement, a group or a page break. */
export function isFieldBlock(block: Block): block is FieldBlock {
  return FIELD_TYPE_SET.has(block.type);
}

export function isChoiceField(field: FieldBlock): field is ChoiceField {
  return CHOICE_SET.has(field.type);
}

export function isTextField(field: FieldBlock): field is TextField {
  return TEXT_SET.has(field.type);
}

export function isNumericField(field: FieldBlock): field is NumericField {
  return NUMERIC_SET.has(field.type);
}

export function isBooleanField(field: FieldBlock): field is BooleanField {
  return BOOLEAN_SET.has(field.type);
}

export function isCompositeField(field: FieldBlock): field is CompositeField {
  return COMPOSITE_SET.has(field.type);
}

export function isFileField(field: FieldBlock): field is FileField {
  return FILE_SET.has(field.type);
}

/** The choices of a choice or ranking field; empty for any other type. */
export function choicesOf(field: FieldBlock): FormChoice[] {
  switch (field.type) {
    case 'multiple_choice':
    case 'dropdown':
    case 'picture_choice':
    case 'ranking':
      return field.properties.choices;
    default:
      return [];
  }
}

/** Whether a field can add to `score` or appear in quiz results: a choice field with a scored or correct choice. */
export function isScoredField(field: FieldBlock): field is ChoiceField {
  return isChoiceField(field) && field.properties.choices.some((c) => c.score !== undefined || c.correct !== undefined);
}

/** The sub-field names of a composite field, in display order, with their settings. */
export function partsOf(field: CompositeField): Array<{ part: string; enabled: boolean; required: boolean }> {
  if (field.type === 'contact_info') {
    const f = field.properties.fields;
    return CONTACT_PARTS.map((part) => ({ part, ...f[part] }));
  }
  const f = field.properties.fields;
  return ADDRESS_PARTS.map((part) => ({ part, ...f[part] }));
}

/** The fields inside one top-level block: the block itself, or a group's field children. */
export function blockFields(block: Block): FieldBlock[] {
  if (block.type === 'group') return block.children.filter((c): c is FieldBlock => isFieldBlock(c));
  return isFieldBlock(block) ? [block] : [];
}

/** Every field in order, group children included. */
export function fieldsOf(def: Pick<FormDefinition, 'blocks'>): FieldBlock[] {
  const out: FieldBlock[] = [];
  for (const block of def.blocks) out.push(...blockFields(block));
  return out;
}

/** A top-level block, a group child, or undefined. */
export function findBlock(def: Pick<FormDefinition, 'blocks'>, id: string): Block | undefined {
  for (const block of def.blocks) {
    if (block.id === id) return block;
    if (block.type === 'group') {
      const child = block.children.find((c) => c.id === id);
      if (child) return child;
    }
  }
  return undefined;
}

/** A field (top-level or group child) by id. */
export function findField(def: Pick<FormDefinition, 'blocks'>, id: string): FieldBlock | undefined {
  const block = findBlock(def, id);
  return block && isFieldBlock(block) ? block : undefined;
}

/** A field (top-level or group child) by ref. */
export function findFieldByRef(def: Pick<FormDefinition, 'blocks'>, ref: string): FieldBlock | undefined {
  return fieldsOf(def).find((f) => f.ref === ref);
}

/**
 * Index in `blocks` of the top-level block that is, or (for a group child)
 * contains, the given id; -1 when there is none.
 */
export function topLevelIndexOf(def: Pick<FormDefinition, 'blocks'>, id: string): number {
  return def.blocks.findIndex((b) => b.id === id || (b.type === 'group' && b.children.some((c) => c.id === id)));
}

/** The top-level block that is, or contains, the given id. */
export function topLevelBlockOf(def: Pick<FormDefinition, 'blocks'>, id: string): Block | undefined {
  const index = topLevelIndexOf(def, id);
  return index === -1 ? undefined : def.blocks[index];
}

/** Every ref in use: blocks, group children and endings. */
export function refsOf(def: Pick<FormDefinition, 'blocks' | 'endings'>): string[] {
  const refs: string[] = [];
  for (const block of def.blocks) {
    refs.push(block.ref);
    if (block.type === 'group') for (const child of block.children) refs.push(child.ref);
  }
  for (const ending of def.endings) refs.push(ending.ref);
  return refs;
}
