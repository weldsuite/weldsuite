/**
 * Links between WeldPanel pages. `/weldpanel/recordings` keeps its filters in
 * the URL (`recordingsSearchSchema`); this encodes a search the way TanStack
 * Router's default search serializer does, so the recordings route parses it
 * back: strings stay plain unless they would read as JSON, everything else is
 * JSON.
 */

import type { RecordingsSearch } from '@weldsuite/app-api-client/schemas/weldpanel-query';

function encodeSearchValue(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return JSON.stringify(value);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value);
}

function toHref(path: string, search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && value !== null) params.set(key, encodeSearchValue(value));
  }
  const query = params.toString();
  return query === '' ? path : `${path}?${query}`;
}

export function recordingsHref(search: RecordingsSearch): string {
  return toHref('/weldpanel/recordings', search);
}

export const REPORT_BUILDER_PATHS: Record<string, string> = {
  web: '/weldpanel',
  trends: '/weldpanel/insights',
  funnel: '/weldpanel/funnels',
  retention: '/weldpanel/retention',
  flows: '/weldpanel/flows',
};

/** Opens a saved report in its builder. */
export function reportBuilderHref(kind: string, reportId?: string): string {
  const path = REPORT_BUILDER_PATHS[kind] ?? '/weldpanel/insights';
  return reportId ? `${path}?report=${encodeURIComponent(reportId)}` : path;
}
