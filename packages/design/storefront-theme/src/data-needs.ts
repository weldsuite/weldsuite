/**
 * What the sections of a page need loaded besides the page's own data, so
 * the renderer can fetch it all before drawing (sections never fetch).
 */

import { sectionDataKey } from './context';
import { sectionSettings } from './settings';
import type { ListName, SectionList } from './types';

export type SectionDataRequest =
  /** Products for one section: the newest, a category's, or chosen ones (ids or slugs). */
  | {
      key: string;
      kind: 'products';
      source: 'newest' | 'category' | 'products';
      category: string | null;
      products: string[];
      limit: number;
    }
  /** Products in the same category as the page's product. */
  | { key: string; kind: 'related'; limit: number };

export interface DataNeeds {
  sections: SectionDataRequest[];
  /** Some section shows categories: load the category tree. */
  categories: boolean;
}

/** The data the visible sections of `lists` need. */
export function sectionDataNeeds(lists: Array<{ list: ListName; sections: SectionList | undefined }>): DataNeeds {
  const needs: DataNeeds = { sections: [], categories: false };
  for (const { list, sections } of lists) {
    for (const section of sections ?? []) {
      if (section.hidden) continue;
      const settings = sectionSettings(section.type, section.settings);
      const key = sectionDataKey(list, section.id);
      if (section.type === 'featured-products') {
        needs.sections.push({
          key,
          kind: 'products',
          source: settings.choice('source', ['newest', 'category', 'products'] as const),
          category: settings.text('category') || null,
          products: settings.list('products').slice(0, 24),
          limit: settings.number('limit'),
        });
      } else if (section.type === 'related-products') {
        needs.sections.push({ key, kind: 'related', limit: settings.number('limit') });
      } else if (section.type === 'category-list') {
        needs.categories = true;
      }
    }
  }
  return needs;
}
