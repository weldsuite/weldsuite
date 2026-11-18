import { getConsolidatedCategory } from './app-categories';

/**
 * Search matching for the App Store.
 *
 * Every word of the query has to appear somewhere in the app's fields (name,
 * code, description, category), case-insensitively. "crm sales" finds WeldCRM
 * through its name and its "Sales & Marketing" category; an empty query
 * matches everything.
 */
export function matchesAppQuery(
  query: string,
  fields: ReadonlyArray<string | null | undefined>,
): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The App Store's filter fields: install status and category group. */
export const APP_STATUS_FILTER = 'status';
export const APP_CATEGORY_FILTER = 'category';
export const APP_STATUS_INSTALLED = 'installed';
export const APP_STATUS_NOT_INSTALLED = 'not_installed';

/** One filter pill as `FilterPills` reports it. */
export interface AppStoreFilter {
  field: string;
  operator: string;
  value: string;
}

/** A pill that has its operator and value picked; half-built pills filter nothing. */
export function isCompleteFilter(filter: AppStoreFilter): boolean {
  return filter.operator !== '' && filter.value !== '';
}

/**
 * Whether an app passes every complete filter. `group` is the app's App Store
 * category group (Customers, Communication, …); "is not" inverts a filter.
 */
export function matchesAppFilters(
  filters: readonly AppStoreFilter[],
  app: { isInstalled: boolean; group: string },
): boolean {
  return filters.every((filter) => {
    if (!isCompleteFilter(filter)) return true;
    let hit: boolean;
    if (filter.field === APP_STATUS_FILTER) {
      hit = filter.value === APP_STATUS_INSTALLED ? app.isInstalled : !app.isInstalled;
    } else if (filter.field === APP_CATEGORY_FILTER) {
      hit = app.group === filter.value;
    } else {
      return true;
    }
    return filter.operator === 'is not' ? !hit : hit;
  });
}

/** Whether a WeldApp in the store passes the search text and the filters. */
export function userAppMatches(
  app: {
    name: string;
    code: string;
    description?: string | null;
    category?: string | null;
    isInstalled?: boolean;
    installed?: boolean;
  },
  query: string,
  filters: readonly AppStoreFilter[],
): boolean {
  return (
    matchesAppQuery(query, [app.name, app.code, app.description, app.category]) &&
    matchesAppFilters(filters, {
      isInstalled: !!(app.isInstalled ?? app.installed),
      group: getConsolidatedCategory(app.category ?? '', app.code),
    })
  );
}
