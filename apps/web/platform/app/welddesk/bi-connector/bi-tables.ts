import { publicEnv } from '@/lib/runtime-config';

/**
 * The tables the OData feed serves, in the order of its service document
 * (apps/workers/external-api/src/routes/v1/odata/catalog.ts). The one-line
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

/** The feed URL: the public API's address (as the API keys page shows it) plus the feed path. */
export function feedUrl(): string {
  const base = (publicEnv('VITE_EXTERNAL_API_URL') ?? DEFAULT_API_URL).replace(/\/+$/, '');
  return `${base}${ODATA_FEED_PATH}`;
}
