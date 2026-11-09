/**
 * Answers as human text: exports, recall, notification emails, entity events
 * and the search column.
 */

import { CONTACT_PARTS, fieldsOf, isCompositeField, isTextField, partsOf } from './blocks';
import { ownValue, prepareAnswer } from './answers';
import type { ChoiceAnswer, FieldBlock, FileAnswerItem, FormDefinition } from './definition';

/** A number as text: JavaScript's `String(n)`, with `-0` as `0`. */
export function formatNumber(n: number): string {
  return Object.is(n, -0) ? '0' : String(n);
}

/** An answer as human text; an empty string when there is no (well-formed) answer. */
export function displayAnswer(field: FieldBlock, raw: unknown): string {
  const prepared = prepareAnswer(field, raw);
  if (prepared.kind !== 'value') return '';
  const answer = prepared.value;

  switch (field.type) {
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'website':
    case 'date':
      return answer as string;
    case 'number':
    case 'rating':
    case 'opinion_scale':
    case 'nps':
      return formatNumber(answer as number);
    case 'yes_no':
      return answer === true ? 'Yes' : 'No';
    case 'legal':
      return answer === true ? 'Accepted' : 'Not accepted';
    case 'multiple_choice':
    case 'dropdown':
    case 'picture_choice': {
      const a = answer as ChoiceAnswer;
      const selected = new Set(a.choiceIds);
      const labels = field.properties.choices.filter((c) => selected.has(c.id)).map((c) => c.label);
      if (a.other !== undefined) labels.push(a.other);
      return labels.join(', ');
    }
    case 'ranking': {
      const labels = new Map(field.properties.choices.map((c) => [c.id, c.label]));
      return (answer as string[]).map((id, i) => `${i + 1}. ${labels.get(id) ?? id}`).join(', ');
    }
    case 'matrix': {
      const a = answer as Record<string, string[]>;
      const parts: string[] = [];
      for (const row of field.properties.rows) {
        const cols = a[row.id];
        if (cols === undefined) continue;
        const selected = new Set(cols);
        const labels = field.properties.columns.filter((c) => selected.has(c.id)).map((c) => c.label);
        parts.push(`${row.label}: ${labels.join(', ')}`);
      }
      return parts.join('; ');
    }
    case 'file_upload':
      return (answer as FileAnswerItem[]).map((f) => f.name).join(', ');
    case 'signature':
      return (answer as FileAnswerItem).name;
    case 'contact_info': {
      const a = answer as Record<string, string>;
      const name = [a.firstName, a.lastName].filter((s): s is string => s !== undefined).join(' ');
      const rest = CONTACT_PARTS.slice(2).map((p) => a[p]);
      return [name, ...rest].filter((s): s is string => s !== undefined && s !== '').join(', ');
    }
    case 'address': {
      const a = answer as Record<string, string>;
      return partsOf(field)
        .map(({ part }) => a[part])
        .filter((s): s is string => s !== undefined)
        .join(', ');
    }
  }
}

/** Longest `searchText` result, in code points. */
export const SEARCH_TEXT_MAX = 10_000;

/**
 * Lowercased text of the free-text answers, contact and address parts and
 * "Other" texts, in field order, joined with spaces and cut at 10,000 code
 * points: `form_responses.search_text`.
 */
export function searchText(def: Pick<FormDefinition, 'blocks'>, answers: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of fieldsOf(def)) {
    const prepared = prepareAnswer(field, ownValue(answers, field.id));
    if (prepared.kind !== 'value') continue;
    const answer = prepared.value;
    if (isTextField(field)) {
      parts.push(answer as string);
    } else if (isCompositeField(field)) {
      const a = answer as Record<string, string>;
      for (const { part } of partsOf(field)) {
        const v = a[part];
        if (v !== undefined) parts.push(v);
      }
    } else if (field.type === 'multiple_choice' || field.type === 'picture_choice' || field.type === 'dropdown') {
      const other = (answer as ChoiceAnswer).other;
      if (other !== undefined) parts.push(other);
    }
  }
  const text = parts.join(' ').toLowerCase();
  const chars = Array.from(text);
  return chars.length > SEARCH_TEXT_MAX ? chars.slice(0, SEARCH_TEXT_MAX).join('') : text;
}
