/**
 * The popup's Sort and Filter, as pure functions over the logins the worker
 * returned; nothing here asks the server anything. Filters are the platform's
 * filter pills (`{ field, operator, value }`), matched by the platform
 * WeldPass list's own rules (`filterItems` in weldpass-items), so a vault
 * filter means the same in both places.
 */

import type { WeldPassItem } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { filterItems, type FilterPill } from '@weldsuite/app-api-client/schemas/weldpass-items';

export { VAULT_FILTER } from '@weldsuite/app-api-client/schemas/weldpass-items';

/** "2FA code is Yes / No". */
export const TOTP_FILTER = 'totp';
export const TOTP_YES = 'yes';
export const TOTP_NO = 'no';

export type SortField = 'name' | 'updated';
export type SortDirection = 'asc' | 'desc';
export interface LoginSort {
  field: SortField;
  direction: SortDirection;
}

export const SORT_FIELDS: readonly SortField[] = ['name', 'updated'];

/** A pill counts once both its operator and its value are chosen. */
function isComplete(pill: FilterPill): boolean {
  return pill.operator !== '' && pill.value !== '';
}

/** Whether any pill narrows the list (a half-built one doesn't yet). */
export function isFiltered(pills: readonly FilterPill[]): boolean {
  return pills.some(isComplete);
}

function totpAccepts(pills: readonly FilterPill[], item: WeldPassItem): boolean {
  return pills
    .filter((pill) => pill.field === TOTP_FILTER && isComplete(pill))
    .every((pill) => {
      const matches = item.hasTotp === (pill.value === TOTP_YES);
      return pill.operator === 'is not' ? !matches : matches;
    });
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function byName(a: WeldPassItem, b: WeldPassItem): number {
  return collator.compare(a.title, b.title) || collator.compare(a.subtitle ?? '', b.subtitle ?? '');
}

function byUpdated(a: WeldPassItem, b: WeldPassItem): number {
  return (Date.parse(a.updatedAt) || 0) - (Date.parse(b.updatedAt) || 0) || byName(a, b);
}

/**
 * The logins the pills let through, in `sort` order. Without a sort they are
 * by name, as on the platform's Passwords page. Never mutates `items`.
 */
export function applyListView(
  items: readonly WeldPassItem[],
  pills: readonly FilterPill[],
  sort: LoginSort | null,
): WeldPassItem[] {
  const kept = filterItems(items, { pills }).filter((item) => totpAccepts(pills, item));
  if (!sort) return kept;
  const compare = sort.field === 'name' ? byName : byUpdated;
  const sign = sort.direction === 'asc' ? 1 : -1;
  return kept.sort((a, b) => sign * compare(a, b));
}
