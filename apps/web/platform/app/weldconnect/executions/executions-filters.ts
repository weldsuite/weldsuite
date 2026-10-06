import type { ActiveFilter } from '@/components/entity-list';
import type { ExecutionListFilters } from '@/hooks/queries/use-automation-queries';

/** Filters the API understands, and so the ones mirrored in the URL (`?status=failed&workflowId=wf_...`). */
export const URL_FILTER_FIELDS = ['status', 'workflowId', 'triggerType'] as const;
export type UrlFilterField = (typeof URL_FILTER_FIELDS)[number];

export type UrlFilterValues = Partial<Record<UrlFilterField, string | null | undefined>>;

const isUrlField = (field: string): field is UrlFilterField =>
  (URL_FILTER_FIELDS as readonly string[]).includes(field);

const isAppliedFilter = (filter: ActiveFilter) =>
  isUrlField(filter.field) && filter.operator === 'is' && filter.value !== '';

/** `pending` is the legacy spelling of `queued`. */
function normalizeValue(field: UrlFilterField, value: string): string {
  return field === 'status' && value === 'pending' ? 'queued' : value;
}

/** Active-filter pills for the filters currently in the URL. */
export function filtersFromUrl(values: UrlFilterValues): ActiveFilter[] {
  const filters: ActiveFilter[] = [];
  for (const field of URL_FILTER_FIELDS) {
    const value = values[field];
    if (value) {
      filters.push({ id: `url-${field}`, field, operator: 'is', value: normalizeValue(field, value) });
    }
  }
  return filters;
}

/**
 * The URL changed from outside (a dashboard tile, the editor's link): take its
 * filters, but keep the pills the URL cannot express (half-built ones, "is not").
 */
export function mergeUrlFilters(current: ActiveFilter[], fromUrl: ActiveFilter[]): ActiveFilter[] {
  return [...current.filter((filter) => !isAppliedFilter(filter)), ...fromUrl];
}

// A run sits on `queued` for the moment between being started and its first
// step; the dashboard counts those as running, so the "running" filter has to
// return them too or its tile shows more runs than the list it links to.
const RUNNING_STATUSES = 'running,queued';

/** Server-side filters: only complete "is" pills reach the API (the last one per field wins). */
export function apiFiltersFromPills(filters: ActiveFilter[]): ExecutionListFilters {
  const result: ExecutionListFilters = {};
  for (const filter of filters) {
    if (isAppliedFilter(filter) && isUrlField(filter.field)) {
      result[filter.field] = filter.value;
    }
  }
  return result;
}

/** What is sent to the API for a set of pills (the URL keeps the plain pill values). */
export function apiQueryFromPills(filters: ActiveFilter[]): ExecutionListFilters {
  const result = apiFiltersFromPills(filters);
  return result.status === 'running' ? { ...result, status: RUNNING_STATUSES } : result;
}

/** The URL for a set of pills: `/weldconnect/executions?status=failed`. */
export function executionsHref(filters: ActiveFilter[]): string {
  const params = new URLSearchParams();
  for (const [field, value] of Object.entries(apiFiltersFromPills(filters))) {
    if (value) params.set(field, value);
  }
  const query = params.toString();
  return query ? `/weldconnect/executions?${query}` : '/weldconnect/executions';
}

/** Stable string for the filter part of the URL, to tell "URL changed" from "we just wrote it". */
export function urlFilterKey(values: UrlFilterValues): string {
  return URL_FILTER_FIELDS.map((field) => values[field] ?? '').join('|');
}
