/**
 * Prompt/template resolver for enrichment actions.
 *
 * Replaces `{{token}}` references with the lead's base fields, any key from the
 * lead's raw `data` payload, or another column's `done` value (by case-
 * insensitive column name). Unknown tokens → empty string. Single pass, no
 * recursive cascade.
 */

import type { LeadRow } from './actions/types';

const BASE_FIELDS: (keyof LeadRow)[] = [
  'name',
  'email',
  'title',
  'companyName',
  'domain',
  'industry',
  'location',
  'country',
  'companySize',
  'linkedinUrl',
];

export function resolveTemplate(
  template: string,
  lead: LeadRow,
  siblingValues: Record<string, string>,
): string {
  const lookup = new Map<string, string>();
  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    lookup.set(key.toLowerCase(), String(value));
  };

  for (const field of BASE_FIELDS) put(field as string, lead[field]);

  const data = (lead.data as Record<string, unknown> | null) ?? {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') put(k, v);
  }

  // Sibling column values win over base fields when names collide.
  for (const [name, value] of Object.entries(siblingValues)) put(name, value);

  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, token: string) => {
    return lookup.get(String(token).toLowerCase()) ?? '';
  });
}
