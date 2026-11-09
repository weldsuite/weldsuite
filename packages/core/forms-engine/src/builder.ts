/**
 * Builder helpers: ids, a blank form, new blocks with sensible defaults and
 * free refs.
 */

import {
  choiceSchema,
  endingSchema,
  fieldBlockSchema,
  formDefinitionSchema,
  groupBlockSchema,
  pageBreakBlockSchema,
  statementBlockSchema,
  type FieldBlockOf,
  type FieldType,
  type FormChoice,
  type FormDefinition,
  type FormEnding,
  type GroupBlock,
  type PageBreakBlock,
  type StatementBlock,
} from './definition';

/** `b` block, `e` ending, `c` choice, `r` matrix row, `k` matrix column, `j` jump / rule, `x` calculation. */
export type IdPrefix = 'b' | 'e' | 'c' | 'r' | 'k' | 'j' | 'x';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE36_LOWER = '0123456789abcdefghijklmnopqrstuvwxyz';

interface CryptoLike {
  getRandomValues(array: Uint8Array): Uint8Array;
}

function randomChars(alphabet: string, length: number): string {
  const crypto = (globalThis as unknown as { crypto?: CryptoLike }).crypto;
  if (!crypto) throw new Error('crypto.getRandomValues is not available');
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** `${prefix}_` + 8 random base62 characters, e.g. `b_x7Kp2QaZ`. */
export function newBlockId(prefix: IdPrefix): string {
  return `${prefix}_${randomChars(BASE62, 8)}`;
}

/** A new, empty form: default presentation, no welcome screen, no blocks, one "Thank you!" ending. */
export function createBlankDefinition(): FormDefinition {
  return formDefinitionSchema.parse({
    blocks: [],
    endings: [{ id: newBlockId('e'), ref: 'thank_you', title: 'Thank you!' }],
  });
}

export function createChoice(label: string): FormChoice {
  return choiceSchema.parse({ id: newBlockId('c'), label });
}

function defaultChoices(count: number): FormChoice[] {
  return Array.from({ length: count }, (_, i) => createChoice(`Option ${i + 1}`));
}

/** A ref for a block that has none yet: `<type>_` + 4 random characters. */
function randomRef(base: string): string {
  return `${base}_${randomChars(BASE36_LOWER, 4)}`;
}

export interface BlockInit {
  title?: string;
  ref?: string;
}

/**
 * A valid field of the given type with sensible defaults: three options for
 * choice fields and rankings, two rows by three columns for a matrix, a
 * five-star rating. Without `ref` it gets `<type>_xxxx`; use `uniqueRef(def,
 * title)` for a readable one.
 */
export function createField<T extends FieldType>(type: T, init: BlockInit = {}): FieldBlockOf<T> {
  let properties: Record<string, unknown> = {};
  switch (type) {
    case 'multiple_choice':
    case 'dropdown':
    case 'picture_choice':
    case 'ranking':
      properties = { choices: defaultChoices(3) };
      break;
    case 'matrix':
      properties = {
        rows: [1, 2].map((n) => ({ id: newBlockId('r'), label: `Row ${n}` })),
        columns: [1, 2, 3].map((n) => ({ id: newBlockId('k'), label: `Column ${n}` })),
      };
      break;
    case 'rating':
      properties = { steps: 5, shape: 'star' };
      break;
    default:
      break;
  }
  const field = fieldBlockSchema.parse({
    id: newBlockId('b'),
    ref: init.ref ?? randomRef(type),
    title: init.title ?? '',
    type,
    properties,
  });
  return field as FieldBlockOf<T>;
}

export function createStatement(init: BlockInit = {}): StatementBlock {
  return statementBlockSchema.parse({
    id: newBlockId('b'),
    ref: init.ref ?? randomRef('statement'),
    type: 'statement',
    title: init.title ?? '',
  });
}

export function createGroup(init: BlockInit = {}): GroupBlock {
  return groupBlockSchema.parse({
    id: newBlockId('b'),
    ref: init.ref ?? randomRef('group'),
    type: 'group',
    title: init.title ?? '',
    children: [],
  });
}

export function createPageBreak(init: BlockInit = {}): PageBreakBlock {
  return pageBreakBlockSchema.parse({
    id: newBlockId('b'),
    ref: init.ref ?? randomRef('page'),
    type: 'page_break',
    title: init.title ?? '',
  });
}

export function createEnding(init: BlockInit = {}): FormEnding {
  return endingSchema.parse({
    id: newBlockId('e'),
    ref: init.ref ?? randomRef('ending'),
    title: init.title ?? 'Thank you!',
  });
}

const REF_MAX = 64;

/** A text as a ref: lowercase ASCII letters, digits and underscores, starting with a letter, at most 64 long. */
export function slugifyRef(text: string): string {
  let slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (slug === '') slug = 'question';
  if (!/^[a-z]/.test(slug)) slug = `q_${slug}`;
  return slug.slice(0, REF_MAX).replace(/_+$/, '');
}

/**
 * A ref made from `base` (usually the title) that no block, group child or
 * ending uses yet: `company_size`, else `company_size_2`, `company_size_3`, …
 * `ignoreId` leaves one block's own ref out (when renaming it).
 */
export function uniqueRef(def: Pick<FormDefinition, 'blocks' | 'endings'>, base: string, ignoreId?: string): string {
  const taken = new Set<string>();
  for (const block of def.blocks) {
    if (block.id !== ignoreId) taken.add(block.ref);
    if (block.type === 'group') for (const child of block.children) if (child.id !== ignoreId) taken.add(child.ref);
  }
  for (const ending of def.endings) if (ending.id !== ignoreId) taken.add(ending.ref);

  const slug = slugifyRef(base);
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${slug.slice(0, REF_MAX - suffix.length).replace(/_+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

