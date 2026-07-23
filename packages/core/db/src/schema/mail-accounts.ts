import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// Email provider enum.
// NOTE: existing rows may reference historical provider values via the
// free-form varchar `sendProvider` / `receiveProvider` columns on
// mail_domains. Don't remove old values — the enum is purely additive.
export const mailProviderEnum = pgEnum('mail_provider', [
  'gmail',
  'outlook',
  'office365',
  'exchange',
  'imap',
  'yahoo',
  'mailcow',
  'resend',
  'smtp',
  'cloudflare',
  'custom',
]);

// Account status enum
export const mailAccountStatusEnum = pgEnum('mail_account_status', [
  'active',
  'inactive',
  'error',
  'suspended',
  'quota_exceeded',
]);

// Auth type enum
export const mailAuthTypeEnum = pgEnum('mail_auth_type', [
  'oauth2',
  'password',
  'api_key',
]);

// Sync status enum
export const mailSyncStatusEnum = pgEnum('mail_sync_status', [
  'idle',
  'syncing',
  'completed',
  'error',
  'paused',
]);

// Auto-reply settings interface (stored as JSONB)
export interface MailAutoReply {
  enabled: boolean;
  subject?: string;
  message?: string;
  startDate?: string;
  endDate?: string;
  excludeContacts?: boolean;
  onlyToContacts?: boolean;
}

// AI settings interface (stored as JSONB)
export interface MailAiSettings {
  customInstructions?: string;
  defaultTone?: 'professional' | 'friendly' | 'casual';
  defaultLength?: 'short' | 'medium' | 'long';
  modelPreference?: string;
}

// Provider config interface (stored as JSONB)
export interface MailProviderConfig {
  clientId?: string;
  tenantId?: string;
  scope?: string[];
  customDomain?: string;
  apiEndpoint?: string;
}

// Mail Accounts table
export const mailAccounts = pgTable('mail_accounts', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Account Information
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }),

  // Provider
  // Note: Default is 'imap' for schema compatibility. Set 'resend' programmatically when creating accounts.
  provider: mailProviderEnum('provider').notNull().default('imap'),
  providerConfig: jsonb('provider_config').$type<MailProviderConfig>(),
  // Send/Receive provider overrides (allows different providers for send vs receive)
  sendProvider: varchar('send_provider', { length: 50 }),
  receiveProvider: varchar('receive_provider', { length: 50 }),

  // Authentication (credentials should be encrypted at rest)
  authType: mailAuthTypeEnum('auth_type').notNull().default('password'),
  accessToken: text('access_token'), // Encrypted
  refreshToken: text('refresh_token'), // Encrypted
  apiKey: text('api_key'), // Encrypted
  passwordHash: text('password_hash'), // Hashed password for IMAP/SMTP

  // Server Settings (for IMAP/SMTP)
  imapHost: varchar('imap_host', { length: 255 }),
  imapPort: integer('imap_port'),
  imapSecure: boolean('imap_secure').default(true),
  smtpHost: varchar('smtp_host', { length: 255 }),
  smtpPort: integer('smtp_port'),
  smtpSecure: boolean('smtp_secure').default(true),

  // Sync Settings
  syncEnabled: boolean('sync_enabled').notNull().default(true),
  syncFrequency: integer('sync_frequency').default(5), // minutes
  lastSyncAt: timestamp('last_sync_at'),
  syncStatus: mailSyncStatusEnum('sync_status').default('idle'),
  syncError: text('sync_error'),

  // Settings
  signature: text('signature'),
  autoReply: jsonb('auto_reply').$type<MailAutoReply>(),
  aiSettings: jsonb('ai_settings').$type<MailAiSettings>(),
  forwardingEmail: varchar('forwarding_email', { length: 255 }),

  // Limits
  dailySendLimit: integer('daily_send_limit').default(500),
  sentToday: integer('sent_today').default(0),
  storageUsed: integer('storage_used').default(0), // bytes
  storageLimit: integer('storage_limit'), // bytes

  // Status
  status: mailAccountStatusEnum('status').notNull().default('active'),
  isDefault: boolean('is_default').default(false),
  isShared: boolean('is_shared').default(false),

  // Access control — which users can access this account (when not shared)
  assignedUserIds: jsonb('assigned_user_ids').$type<string[]>(),

  // External sync (Mailcow integration)
  externalAccountId: varchar('external_account_id', { length: 255 }), // Mailcow mailbox ID
  mailcowSyncedAt: timestamp('mailcow_synced_at'),

  // Metadata
  tags: jsonb('tags').$type<string[]>(),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('mail_accounts_email_idx').on(table.email),
  index('mail_accounts_status_idx').on(table.status),
  index('mail_accounts_is_default_idx').on(table.isDefault),
  index('mail_accounts_external_account_id_idx').on(table.externalAccountId),
]);

export type MailAccount = typeof mailAccounts.$inferSelect;
export type NewMailAccount = typeof mailAccounts.$inferInsert;
