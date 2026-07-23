import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// Integration Status Types
export type IntegrationStatus = 'connected' | 'disconnected' | 'error' | 'authenticating' | 'pending';

// Integration Types
export type IntegrationType =
  | 'email' | 'gmail' | 'slack' | 'teams' | 'discord'
  | 'google_sheets' | 'google_drive' | 'google_calendar'
  | 'notion' | 'airtable' | 'asana' | 'trello' | 'jira' | 'github'
  | 'stripe' | 'shopify' | 'woocommerce'
  | 'openai' | 'anthropic'
  | 'twilio' | 'sendgrid' | 'elasticemail'
  | 'http' | 'webhook'
  | 'custom';

export const workflowIntegrations = pgTable('workflow_integrations', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Integration Info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  type: varchar('type', { length: 50 }).notNull(), // email | slack | notion | custom | etc
  category: varchar('category', { length: 50 }), // communication | productivity | crm | commerce | ai | custom

  // Status
  status: varchar('status', { length: 20 }).notNull().default('disconnected'), // connected | disconnected | error | authenticating | pending

  // Credentials (encrypted)
  credentialsId: varchar('credentials_id', { length: 30 }), // Reference to secure credential storage
  credentials: jsonb('credentials').$type<Record<string, unknown>>(), // Encrypted credentials

  // OAuth
  isOAuth: boolean('is_oauth').notNull().default(false),
  oauthProvider: varchar('oauth_provider', { length: 50 }),
  oauthScopes: jsonb('oauth_scopes').$type<string[]>(),
  oauthTokens: jsonb('oauth_tokens').$type<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
  }>(), // Encrypted

  // Connection Details
  connectedAt: timestamp('connected_at'),
  connectedBy: varchar('connected_by', { length: 255 }),
  lastSyncAt: timestamp('last_sync_at'),
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at'),

  // Settings
  settings: jsonb('settings').$type<Record<string, unknown>>(),

  // Metadata for UI
  icon: varchar('icon', { length: 255 }),
  website: varchar('website', { length: 500 }),
  documentation: varchar('documentation', { length: 500 }),
  tags: jsonb('tags').$type<string[]>(),
}, (table) => [
  index('workflow_integrations_type_idx').on(table.type),
  index('workflow_integrations_status_idx').on(table.status),
  index('workflow_integrations_category_idx').on(table.category),
]);

export type WorkflowIntegration = typeof workflowIntegrations.$inferSelect;
export type NewWorkflowIntegration = typeof workflowIntegrations.$inferInsert;
