import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/** Device management systems the asset register can import from. */
export const ASSET_SOURCE_TYPES = ['intune'] as const;
export type AssetSourceType = (typeof ASSET_SOURCE_TYPES)[number];

/**
 *   - `running`: an import is under way (it continues in steps, see `syncState`).
 *   - `ok`: the last import finished.
 *   - `failed`: the last import stopped on an error (`lastError`).
 */
export const ASSET_SOURCE_RUN_STATUSES = ['running', 'ok', 'failed'] as const;
export type AssetSourceRunStatus = (typeof ASSET_SOURCE_RUN_STATUSES)[number];

/** Microsoft Intune: the customer's own app registration in their Entra tenant. */
export interface IntuneAssetSourceConfig {
  /** Directory (tenant) id or a verified domain of the Entra tenant. */
  tenantId: string;
  /** Application (client) id of the app registration. */
  clientId: string;
}

export type AssetSourceConfig = IntuneAssetSourceConfig;

/** What one import did. */
export interface AssetSourceRunStats {
  /** Devices read from the source. */
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}

/**
 * An import that is under way. A run reads the source a page at a time and
 * stops after a bounded amount of work; the next step picks up at `nextLink`.
 */
export interface AssetSourceSyncState {
  startedAt: string;
  /**
   * The source's own link to the page being read; absent before the first
   * page. A page is read again when a step stopped inside it (`offset`).
   */
  nextLink?: string | null;
  /** Devices of that page already handled; absent means 0. */
  offset?: number;
  stats: AssetSourceRunStats;
  /** Who started it by hand (a user id); absent for a scheduled run. */
  startedById?: string | null;
}

export const ASSET_SOURCE_DEFAULT_INTERVAL_HOURS = 24;
export const ASSET_SOURCE_MIN_INTERVAL_HOURS = 1;
export const ASSET_SOURCE_MAX_INTERVAL_HOURS = 168;

/**
 * A device management system whose devices are imported into a custom
 * object as records: Microsoft Intune's managed devices into the asset
 * register (`object_slug` = `asset`).
 *
 * A device is matched to its record through `integration_entity_mappings`
 * (connection = this source, external type `intune_device`), so a later
 * import updates the same record instead of adding another, and a record a
 * person entered by hand is adopted when its serial number matches.
 *
 * `secretEncrypted` is the app registration's client secret (field-encrypted,
 * never returned by the API).
 *
 * `nextSyncAt` is the next scheduled import; the sweep finds due sources
 * through the due index (kind `asset_import`), so a workspace without a
 * source is never opened.
 */
export const assetSources = pgTable(
  'asset_sources',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    type: varchar('type', { length: 20 }).$type<AssetSourceType>().notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    /** The custom object the devices become records of. */
    objectSlug: varchar('object_slug', { length: 64 }).notNull().default('asset'),

    config: jsonb('config').$type<AssetSourceConfig>().notNull(),
    secretEncrypted: text('secret_encrypted'),

    /** Import on the schedule; a paused source still imports on request. */
    enabled: boolean('enabled').notNull().default(true),
    intervalHours: integer('interval_hours').notNull().default(ASSET_SOURCE_DEFAULT_INTERVAL_HOURS),
    nextSyncAt: timestamp('next_sync_at'),

    syncState: jsonb('sync_state').$type<AssetSourceSyncState | null>(),

    lastSyncAt: timestamp('last_sync_at'),
    lastStatus: varchar('last_status', { length: 10 }).$type<AssetSourceRunStatus>(),
    lastError: text('last_error'),
    lastStats: jsonb('last_stats').$type<AssetSourceRunStats | null>(),

    createdById: varchar('created_by_id', { length: 255 }),
  },
  (table) => [index('asset_sources_due_idx').on(table.enabled, table.nextSyncAt)],
);

export type AssetSource = typeof assetSources.$inferSelect;
export type NewAssetSource = typeof assetSources.$inferInsert;
