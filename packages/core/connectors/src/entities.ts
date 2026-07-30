/**
 * The one entity vocabulary every connector speaks.
 *
 * Before this package there were two competing sets for the same concepts —
 * the CRM sync engine used `contact` / `customer`, the Attio-shaped provider
 * layer used `person` / `company` — and a record crossing between them had to
 * be translated for no reason.
 *
 * The union itself is declared in `@weldsuite/db/schema` and re-exported here.
 * The database column is what actually constrains the value, so a second
 * declaration in this package would be free to drift from it.
 *
 * Adding an entity is not enough on its own: the ingest layer needs a mapper
 * that knows which table it lands in, and `SYNCABLE_ENTITIES` below gates what
 * a driver is allowed to declare.
 */

import type { SyncEntityType } from '@weldsuite/db/schema';

export type { SyncEntityType };

export const SYNCABLE_ENTITIES: readonly SyncEntityType[] = [
  'contact',
  'customer',
  'lead',
  'opportunity',
  'activity',
  'pipeline',
  'calendar_event',
  'invoice',
  'purchase_invoice',
  'ledger_account',
  'tax_rate',
  'payment',
] as const;

export function isSyncEntityType(value: string): value is SyncEntityType {
  return (SYNCABLE_ENTITIES as readonly string[]).includes(value);
}

/** Broad grouping used for the connector catalog UI. */
export type ConnectorCategory = 'crm' | 'accounting' | 'support' | 'productivity' | 'calendar';

/**
 * A record as a driver hands it over, before any WeldSuite mapping.
 *
 * `updatedAt` is what the sync loop uses to advance a watermark, so a driver
 * must populate it from the provider's own modification timestamp rather than
 * from the wall clock — using `now` would advance the watermark past records
 * the provider has not delivered yet.
 */
export interface ExternalEntity {
  id: string;
  type: SyncEntityType;
  data: Record<string, unknown>;
  updatedAt: string;
  isDeleted?: boolean;
  raw: unknown;
}

export interface FetchPageResult {
  entities: ExternalEntity[];
  /** Opaque, provider-defined. Absent means this was the last page. */
  nextCursor?: string;
  hasMore: boolean;
}

export interface PushResult {
  externalId: string;
  success: boolean;
  error?: string;
}
