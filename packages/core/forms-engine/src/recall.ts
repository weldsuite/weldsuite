/**
 * Recall: answers, hidden values and variables inside titles, descriptions,
 * endings, redirect URLs and emails.
 */

import { ownValue } from './answers';
import { findFieldByRef } from './blocks';
import type { FormDefinition } from './definition';
import { displayAnswer, formatNumber } from './display';
import type { RecallContext } from './types';

/** `{{field:ref}}`, `{{hidden:name}}`, `{{var:name}}`; spaces inside the braces are allowed. */
export const RECALL_RE = /\{\{\s*(field|hidden|var):([A-Za-z0-9_]+)\s*\}\}/g;

export interface RecallOptions {
  /** URL-encode each value (`encodeURIComponent`), for redirect URLs. */
  encode?: boolean;
}

/** The text of one recall token; an empty string when it refers to nothing. */
export function recallValue(kind: string, name: string, def: Pick<FormDefinition, 'blocks'>, ctx: RecallContext): string {
  if (kind === 'field') {
    const field = findFieldByRef(def, name);
    return field ? displayAnswer(field, ownValue(ctx.answers, field.id)) : '';
  }
  if (kind === 'hidden') {
    const v = ownValue(ctx.hidden, name);
    return typeof v === 'string' ? v : '';
  }
  const v = ownValue(ctx.variables, name);
  if (typeof v === 'number') return formatNumber(v);
  return typeof v === 'string' ? v : '';
}

/** Fills the recall tokens of a text; unknown references become an empty string. */
export function recall(text: string, def: Pick<FormDefinition, 'blocks'>, ctx: RecallContext, options: RecallOptions = {}): string {
  return text.replace(RECALL_RE, (_match, kind: string, name: string) => {
    const value = recallValue(kind, name, def, ctx);
    return options.encode ? encodeURIComponent(value) : value;
  });
}

/** The refs, hidden names and variable names a text recalls, in order of appearance. */
export function recallTokens(text: string): Array<{ kind: 'field' | 'hidden' | 'var'; name: string }> {
  const out: Array<{ kind: 'field' | 'hidden' | 'var'; name: string }> = [];
  for (const m of text.matchAll(RECALL_RE)) {
    const kind = m[1];
    const name = m[2];
    if ((kind === 'field' || kind === 'hidden' || kind === 'var') && name !== undefined) out.push({ kind, name });
  }
  return out;
}
