/**
 * Custom field values (Settings > Custom fields) as text for display and
 * editing. A record carries them as `customFields: { [slug]: value }`; saving
 * sends the WHOLE map back, because the API replaces the stored set.
 */

import type { CustomFieldDefinition, CustomFieldValues } from '@/services/api';

export interface CustomFieldFormatOptions {
  locale: string;
  yes: string;
  no: string;
  memberName?: (userId: string) => string | undefined;
}

function optionLabel(def: CustomFieldDefinition, value: unknown): string {
  return def.options.find((option) => option.value === value)?.label ?? String(value);
}

/** A stored value as display text; '' when empty. */
export function formatCustomValue(def: CustomFieldDefinition, value: unknown, options: CustomFieldFormatOptions): string {
  if (value === null || value === undefined || value === '') return '';
  switch (def.fieldType) {
    case 'boolean':
      return value === true || value === 'true' ? options.yes : options.no;
    case 'single_select':
      return optionLabel(def, value);
    case 'multi_select':
      return Array.isArray(value) ? value.map((v) => optionLabel(def, v)).join(', ') : optionLabel(def, value);
    case 'date': {
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(options.locale);
    }
    case 'rating':
      return '★'.repeat(Math.max(0, Math.min(5, Number(value) || 0)));
    case 'currency':
      if (typeof value === 'object' && value !== null && 'amount' in value) {
        const money = value as { amount: unknown; currency?: unknown };
        return [money.amount, money.currency].filter((part) => part !== undefined && part !== null).join(' ');
      }
      return String(value);
    case 'user_ref':
      return options.memberName?.(String(value)) ?? String(value);
    default:
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
  }
}

/** Field types the app edits as a single line or block of text. */
export const TEXT_FIELD_TYPES = new Set(['text', 'textarea', 'url', 'email', 'phone', 'number', 'currency', 'date']);

/** Field types the app can't edit (files, links to other records): shown read-only. */
export const READ_ONLY_FIELD_TYPES = new Set(['file', 'entity_ref']);

/** The text a text-like field starts with in the form. */
export function customValueToInput(def: CustomFieldDefinition, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (def.fieldType === 'date') {
    const text = String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
  }
  if (def.fieldType === 'currency' && typeof value === 'object' && 'amount' in (value as object)) {
    return String((value as { amount: unknown }).amount ?? '');
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * Typed text back to a stored value: numbers for number / currency / rating,
 * null for empty. Returns `undefined` when the text isn't valid for the type.
 */
export function customInputToValue(def: CustomFieldDefinition, text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (def.fieldType === 'number' || def.fieldType === 'currency') {
    const parsed = Number(trimmed.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (def.fieldType === 'date') {
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) && !Number.isNaN(new Date(trimmed).getTime()) ? trimmed : undefined;
  }
  return trimmed;
}

/** The full map to save: every stored value, with this form's edits on top; empties removed. */
export function mergeCustomValues(stored: CustomFieldValues, edits: CustomFieldValues): CustomFieldValues {
  const merged: CustomFieldValues = { ...stored, ...edits };
  for (const key of Object.keys(merged)) {
    const value = merged[key];
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      delete merged[key];
    }
  }
  return merged;
}
