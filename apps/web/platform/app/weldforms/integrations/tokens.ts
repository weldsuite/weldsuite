/**
 * Recall tokens for integration templates: the engine's `{{field:ref}}` and
 * `{{hidden:name}}`, plus the integration-only `{{form:title}}`,
 * `{{response:number}}` and `{{response:url}}`.
 */

import { fieldsOf, type FormDefinition } from '@weldsuite/forms-engine';
import { INTEGRATION_EXTRA_TOKENS } from '@weldsuite/app-api-client/schemas/weldforms';

export type ExtraToken = (typeof INTEGRATION_EXTRA_TOKENS)[number];

export interface TokenOption {
  token: string;
  /** What the menu shows. */
  label: string;
}

export function wrapToken(inner: string): string {
  return `{{${inner}}}`;
}

/** One token per question (by its ref) and per hidden field, in form order. */
export function definitionTokens(definition: Pick<FormDefinition, 'blocks' | 'hidden'>): {
  questions: TokenOption[];
  hidden: TokenOption[];
} {
  return {
    questions: fieldsOf(definition).map((field) => ({ token: wrapToken(`field:${field.ref}`), label: field.title })),
    hidden: definition.hidden.map((h) => ({ token: wrapToken(`hidden:${h.name}`), label: h.name })),
  };
}

export function extraTokens(): ExtraToken[] {
  return [...INTEGRATION_EXTRA_TOKENS];
}

/** Puts `token` into `value` over the selection; the caret ends up after it. */
export function insertAtSelection(
  value: string,
  token: string,
  start: number | null,
  end: number | null,
): { value: string; caret: number } {
  const from = Math.min(start ?? value.length, end ?? value.length);
  const to = Math.max(start ?? value.length, end ?? value.length);
  const next = `${value.slice(0, from)}${token}${value.slice(to)}`;
  return { value: next, caret: from + token.length };
}
