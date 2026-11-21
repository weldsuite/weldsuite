/**
 * The recordings list keeps its filters in the URL. These helpers read the
 * search leniently (one bad field is dropped, not the whole filter), turn it
 * into the sessions spec, and count the filters that are on.
 */

import {
  recordingsSearchSchema,
  recordingsSearchToSpec,
  type PanelDateRange,
  type PanelSessionsSpec,
  type RecordingsSearch,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { browserTimezone } from './date-range';

/** Router `validateSearch`: whatever parses, and nothing for the rest. */
export function parseRecordingsSearch(raw: unknown): RecordingsSearch {
  const whole = recordingsSearchSchema.safeParse(raw);
  if (whole.success) return whole.data;
  if (typeof raw !== 'object' || raw === null) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = (recordingsSearchSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>)[key];
    const parsed = field?.safeParse(value);
    if (parsed?.success && parsed.data !== undefined) result[key] = parsed.data;
  }
  return result as RecordingsSearch;
}

/** The filters that are on, not counting the date range, the sort, the project or the open recording. */
const FILTER_KEYS = ['minDuration', 'maxDuration', 'pages', 'entryPage', 'exitPage', 'countries', 'devices', 'browsers', 'user', 'cohort', 'did', 'didNot', 'frustration', 'errors', 'favorites'] as const;

export function activeFilterCount(search: RecordingsSearch): number {
  return FILTER_KEYS.filter((key) => {
    const value = search[key];
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== false && value !== '';
  }).length;
}

/** The spec the list runs: the URL's filters, only sessions that have a recording, in the browser's timezone. */
export function recordingsSpec(search: RecordingsSearch, projectId: string, limit = 25): PanelSessionsSpec {
  return { ...recordingsSearchToSpec(search, projectId), hasRecording: true, timezone: browserTimezone(), limit };
}

export function searchRange(search: RecordingsSearch): PanelDateRange {
  return search.from && search.to ? { from: search.from, to: search.to } : { preset: search.range ?? '30d' };
}

/** A new search with the date range replaced. */
export function withRange(search: RecordingsSearch, range: PanelDateRange): RecordingsSearch {
  const rest = { ...search };
  delete rest.range;
  delete rest.from;
  delete rest.to;
  return 'preset' in range ? { ...rest, range: range.preset } : { ...rest, from: range.from, to: range.to };
}

/** A new search with empty values removed, so the URL stays short. */
export function cleanSearch(search: RecordingsSearch): RecordingsSearch {
  return Object.fromEntries(
    Object.entries(search).filter(([, value]) => value !== undefined && value !== '' && value !== false && !(Array.isArray(value) && value.length === 0)),
  ) as RecordingsSearch;
}
