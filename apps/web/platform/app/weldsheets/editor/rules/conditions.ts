import {
  delocalizeFormula,
  formatRange,
  localizeFormula,
  parseRange,
  type Condition,
  type ConditionType,
  type FormulaLocale,
  type Range,
} from '@weldsuite/sheets-engine';

/**
 * Conditions as the filter menu and the rule panels edit them: a type and up
 * to two text fields, typed in the viewer's locale (decimal comma, `;`).
 */
export interface ConditionDraft {
  type: ConditionType | 'none';
  value: string;
  value2: string;
}

export const CONDITION_TYPES: ConditionType[] = [
  'empty',
  'notEmpty',
  'textContains',
  'textNotContains',
  'textStartsWith',
  'textEndsWith',
  'textIs',
  'greater',
  'greaterOrEqual',
  'less',
  'lessOrEqual',
  'equal',
  'notEqual',
  'between',
  'notBetween',
  'formula',
];

/** How many text fields a condition type takes. */
export function fieldCount(type: ConditionDraft['type']): 0 | 1 | 2 {
  if (type === 'none' || type === 'empty' || type === 'notEmpty') return 0;
  return type === 'between' || type === 'notBetween' ? 2 : 1;
}

export const EMPTY_DRAFT: ConditionDraft = { type: 'none', value: '', value2: '' };

export function toDraft(c: Condition | undefined, locale: FormulaLocale): ConditionDraft {
  if (!c) return EMPTY_DRAFT;
  const num = (n: number) => (locale.decimal === ',' ? String(n).replace('.', ',') : String(n));
  switch (c.type) {
    case 'empty':
    case 'notEmpty':
      return { type: c.type, value: '', value2: '' };
    case 'between':
    case 'notBetween':
      return { type: c.type, value: num(c.min), value2: num(c.max) };
    case 'formula':
      return { type: c.type, value: `=${localizeFormula(c.formula, locale)}`, value2: '' };
    case 'greater':
    case 'greaterOrEqual':
    case 'less':
    case 'lessOrEqual':
    case 'equal':
    case 'notEqual':
      return { type: c.type, value: num(c.value), value2: '' };
    default:
      return { type: c.type, value: c.value, value2: '' };
  }
}

/** The condition a draft describes; undefined for none, null when a field does not parse. */
export function fromDraft(d: ConditionDraft, locale: FormulaLocale): Condition | undefined | null {
  const number = (text: string): number | null => {
    const n = Number((locale.decimal === ',' ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '')).trim());
    return text.trim() === '' || !Number.isFinite(n) ? null : n;
  };
  switch (d.type) {
    case 'none':
      return undefined;
    case 'empty':
    case 'notEmpty':
      return { type: d.type };
    case 'between':
    case 'notBetween': {
      const min = number(d.value);
      const max = number(d.value2);
      return min === null || max === null ? null : { type: d.type, min, max };
    }
    case 'formula': {
      const text = d.value.trim().replace(/^=/, '');
      return text ? { type: 'formula', formula: delocalizeFormula(text, locale) } : null;
    }
    case 'greater':
    case 'greaterOrEqual':
    case 'less':
    case 'lessOrEqual':
    case 'equal':
    case 'notEqual': {
      const value = number(d.value);
      return value === null ? null : { type: d.type, value };
    }
    default:
      return d.value === '' ? null : { type: d.type, value: d.value };
  }
}

/** "A1:B10, D2" → ranges; null when any part is not a range on this sheet. */
export function parseRanges(text: string): Range[] | null {
  const parts = text
    .split(/[,;]/)
    .map((p) => p.trim().replace(/\$/g, ''))
    .filter(Boolean);
  if (parts.length === 0) return null;
  const ranges = parts.map((p) => parseRange(p));
  return ranges.every((r): r is Range => r !== null) ? ranges : null;
}

export function rangesText(ranges: Range[]): string {
  return ranges.map(formatRange).join(', ');
}

/** The colours the colour pickers offer (Google Sheets' palette). */
export const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd',
  '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
];
