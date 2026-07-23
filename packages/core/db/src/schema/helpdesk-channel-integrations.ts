import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Channel integration types
export type ChannelProvider =
  | 'discord'
  | 'slack'
  | 'teams'
  | 'facebook'
  | 'instagram'
  | 'twitter'
  | 'whatsapp'
  | 'telegram'
  | 'gmail'
  | 'outlook'
  | 'imap';

export type ChannelIntegrationStatus =
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'expired'
  | 'pending';

export interface AccountInfo {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  metadata?: Record<string, unknown>;
}

export const helpdeskChannelIntegrations = pgTable('helpdesk_channel_integrations', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Provider info
  provider: varchar('provider', { length: 30 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  name: varchar('name', { length: 255 }).notNull(),

  // Account info
  accountInfo: jsonb('account_info').$type<AccountInfo>(),

  // Configuration
  config: jsonb('config').$type<Record<string, unknown>>(),

  // Token management
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: timestamp('token_expires_at'),

  // Sync info
  lastSyncAt: timestamp('last_sync_at'),
  errorMessage: text('error_message'),
}, (table) => [
  index('helpdesk_channel_integrations_provider_idx').on(table.provider),
  index('helpdesk_channel_integrations_status_idx').on(table.status),
]);

export type HelpdeskChannelIntegration = typeof helpdeskChannelIntegrations.$inferSelect;
export type NewHelpdeskChannelIntegration = typeof helpdeskChannelIntegrations.$inferInsert;
