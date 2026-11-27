/**
 * Record results for the Cmd/Ctrl+K palette: the groups `POST /api/search`
 * returns, trimmed to a few rows per record type and kept in the order the
 * API sends them (its canonical type order), plus how each row opens.
 */

import type { SearchResultGroup, SearchResultItem } from '@weldsuite/app-api-client/schemas/search';
import { hasEntitySheetRenderer } from '@/components/entity-sheet/registry-meta';
import type { EntitySheetType } from '@/components/entity-sheet/types';

export interface PaletteRecordGroup {
  type: SearchResultItem['type'];
  items: SearchResultItem[];
}

/** Rows shown per record type. */
export const RECORDS_PER_TYPE = 3;

/** The non-empty groups, each cut to `perType` rows. */
export function paletteRecordGroups(
  groups: readonly SearchResultGroup[] | undefined,
  perType = RECORDS_PER_TYPE,
): PaletteRecordGroup[] {
  const out: PaletteRecordGroup[] = [];
  const seen = new Set<string>();
  for (const group of groups ?? []) {
    if (seen.has(group.type)) continue;
    const items = group.items.slice(0, perType);
    if (items.length === 0) continue;
    seen.add(group.type);
    out.push({ type: group.type, items });
  }
  return out;
}

/**
 * Records that open as object panels over the current page; the page link
 * deep-links that panel. CRM companies and people come back under their legacy
 * search types (`customer`, `contact`). WeldBooks bank lines and contacts open
 * on the lists that show them (an inbox document opens its dialog on its page).
 */
const PANEL_TARGETS: Partial<Record<string, { type: string; page: string }>> = {
  customer: { type: 'company', page: '/weldcrm/companies' },
  contact: { type: 'person', page: '/weldcrm/people' },
  bank_transaction: { type: 'bank_transaction', page: '/weldbooks/banking/transactions' },
  accounting_contact: { type: 'weldbooks_contact', page: '/weldbooks/contacts' },
};

export type PaletteRecordTarget =
  | { kind: 'panel'; panel: { type: string; id: string }; href: string }
  | { kind: 'sheet'; type: EntitySheetType; id: string; href: string }
  | { kind: 'page'; href: string };

/**
 * Where a record opens: CRM companies, people, bank lines and WeldBooks contacts in their object panel,
 * types with an entity sheet in that sheet, everything else on its page.
 * `href` is always a page URL (for a new tab and for the recents list).
 */
export function paletteRecordTarget(item: Pick<SearchResultItem, 'id' | 'type' | 'url'>): PaletteRecordTarget {
  const panel = PANEL_TARGETS[item.type];
  if (panel) {
    return {
      kind: 'panel',
      panel: { type: panel.type, id: item.id },
      href: `${panel.page}?stack=${panel.type}:${encodeURIComponent(item.id)}`,
    };
  }
  if (hasEntitySheetRenderer(item.type)) {
    return { kind: 'sheet', type: item.type, id: item.id, href: item.url };
  }
  return { kind: 'page', href: item.url };
}
