import { publicEnv } from '@/lib/runtime-config';

/**
 * The tables the OData feed serves, in the order of its service document
 * (packages/domains/desk/src/odata-catalog.ts). The one-line
 * descriptions are translations: `t.deskBi.tables.items`.
 */
export const BI_TABLES = [
  'Conversations',
  'Messages',
  'SlaClocks',
  'Calls',
  'Teams',
  'TicketTypes',
  'Agents',
  'Problems',
  'CatalogItems',
  'Articles',
] as const;

export type BiTable = (typeof BI_TABLES)[number];

/** The path of the feed on the public API. */
export const ODATA_FEED_PATH = '/v1/odata';

const DEFAULT_API_URL = 'https://api.weldsuite.org';

/** The address without the slashes it ends on. */
function withoutTrailingSlashes(address: string): string {
  let end = address.length;
  while (end > 0 && address[end - 1] === '/') end--;
  return address.slice(0, end);
}

/** The feed URL: the public API's address (as the API keys page shows it) plus the feed path. */
export function feedUrl(): string {
  const base = withoutTrailingSlashes(publicEnv('VITE_EXTERNAL_API_URL') ?? DEFAULT_API_URL);
  return `${base}${ODATA_FEED_PATH}`;
}
