import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Integration connection status
 */
export type IntegrationConnectionStatus = 'active' | 'inactive' | 'error' | 'syncing';

/**
 * Integration sync direction
 */
export type IntegrationDirection = 'inbound' | 'outbound' | 'bidirectional';

/**
 * Supported integration providers
 */
export type IntegrationProvider = 'attio' | 'hubspot' | 'salesforce' | 'pipedrive' | 'mcp_server' | 'google_calendar';

/**
 * OAuth tokens stored as encrypted JSONB
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
}

/**
 * Sync settings stored as JSONB
 */
export interface IntegrationSyncSettings {
  syncCompanies?: boolean;
  syncPeople?: boolean;
  syncLeads?: boolean;
  syncOpportunities?: boolean;
  syncActivities?: boolean;
  syncCalendarEvents?: boolean;
  syncIntervalHours?: number;
}

/**
 * Per-entity sync direction config stored as JSONB
 */
export type IntegrationEntityConfig = Record<string, 'inbound' | 'outbound' | 'bidirectional'>;

/**
 * Per-entity-type sync cursor stored as JSONB
 */
export type IntegrationSyncCursor = Record<string, string>;

/**
 * Conflict resolution strategy
 */
export type ConflictStrategy = 'last_write_wins' | 'external_wins' | 'internal_wins' | 'manual';

/**
 * MCP server connection settings (stored in the generic `settings` JSONB column).
 */
export interface McpServerSettings {
  transportType: 'streamable-http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  authType?: 'none' | 'bearer' | 'api_key' | 'header';
  headerName?: string;
  discoveredTools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  lastDiscoveredAt?: string;
}

/**
 * Generic integration connection table.
 * Supports any CRM/external provider (Attio, HubSpot, Salesforce, etc.)
 */
export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    // Provider
    provider: varchar('provider', { length: 30 }).notNull().$type<IntegrationProvider>(),
    name: varchar('name', { length: 255 }),
    status: varchar('status', { length: 20 }).notNull().default('inactive').$type<IntegrationConnectionStatus>(),
    direction: varchar('direction', { length: 15 }).notNull().default('inbound').$type<IntegrationDirection>(),

    // External account identifier (HubSpot portalId, Salesforce orgId, etc.)
    externalAccountId: varchar('external_account_id', { length: 255 }),

    // OAuth tokens (encrypted JSONB)
    oauthTokens: jsonb('oauth_tokens').$type<OAuthTokens>(),

    // Webhook registration
    webhookId: varchar('webhook_id', { length: 255 }),
    webhookSecret: text('webhook_secret'),

    // Generic settings (used for MCP servers and other provider-specific config)
    settings: jsonb('settings').$type<Record<string, unknown>>(),

    // Sync settings
    syncSettings: jsonb('sync_settings').$type<IntegrationSyncSettings>(),
    fieldMappings: jsonb('field_mappings').$type<Record<string, string>>(),

    // Entity-level sync configuration
    entityConfig: jsonb('entity_config').$type<IntegrationEntityConfig>(),
    syncCursor: jsonb('sync_cursor').$type<IntegrationSyncCursor>(),
    conflictStrategy: varchar('conflict_strategy', { length: 30 }).notNull().default('last_write_wins').$type<ConflictStrategy>(),

    // Sync state
    lastSyncAt: timestamp('last_sync_at'),
    lastSyncStatus: varchar('last_sync_status', { length: 20 }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at'),

    // Stats
    companiesSynced: integer('companies_synced').notNull().default(0),
    peopleSynced: integer('people_synced').notNull().default(0),
    tasksSynced: integer('tasks_synced').notNull().default(0),
    listsSynced: integer('lists_synced').notNull().default(0),
    leadsSynced: integer('leads_synced').notNull().default(0),
    opportunitiesSynced: integer('opportunities_synced').notNull().default(0),
    activitiesSynced: integer('activities_synced').notNull().default(0),

    // Audit
    connectedAt: timestamp('connected_at'),
    connectedBy: varchar('connected_by', { length: 255 }),

    // Trigger.dev schedule ID for periodic sync
    triggerScheduleId: varchar('trigger_schedule_id', { length: 255 }),
  },
  (table) => [
    index('integration_connections_provider_idx').on(table.provider),
    index('integration_connections_status_idx').on(table.status),
  ]
);

export type IntegrationConnection = typeof integrationConnections.$inferSelect;
export type NewIntegrationConnection = typeof integrationConnections.$inferInsert;
