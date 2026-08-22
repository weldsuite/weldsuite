import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const adPlatformEnum = pgEnum('ad_platform', ['facebook', 'google']);

export const adPlatformConnectionStatusEnum = pgEnum('ad_platform_connection_status', [
  'active',
  'error',
  'pending_reauth',
]);

export interface AdOAuthTokens {
  accessToken: string;
  tokenType?: string;
}

export interface AdCampaignMetrics {
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  reach?: string;
  dateStart?: string;
  dateEnd?: string;
}

export const adPlatformConnections = pgTable(
  'ad_platform_connections',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    platform: adPlatformEnum('platform').notNull(),
    status: adPlatformConnectionStatusEnum('status').notNull().default('active'),

    metaUserId: varchar('meta_user_id', { length: 255 }),
    metaUserName: varchar('meta_user_name', { length: 255 }),

    oauthTokens: jsonb('oauth_tokens').$type<AdOAuthTokens>(),
    tokenExpiresAt: timestamp('token_expires_at'),
    lastSyncAt: timestamp('last_sync_at'),
    lastError: text('last_error'),
  },
  (table) => [
    index('ad_platform_connections_platform_idx').on(table.platform),
    index('ad_platform_connections_status_idx').on(table.status),
  ],
);

export const adAccounts = pgTable(
  'ad_accounts',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    connectionId: varchar('connection_id', { length: 30 })
      .notNull()
      .references(() => adPlatformConnections.id, { onDelete: 'cascade' }),

    platformAccountId: varchar('platform_account_id', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    currency: varchar('currency', { length: 10 }),
    timezone: varchar('timezone', { length: 100 }),
    status: varchar('status', { length: 50 }),
    isSelected: boolean('is_selected').notNull().default(false),
  },
  (table) => [
    uniqueIndex('ad_accounts_connection_platform_account_idx').on(
      table.connectionId,
      table.platformAccountId,
    ),
    index('ad_accounts_connection_idx').on(table.connectionId),
    index('ad_accounts_is_selected_idx').on(table.isSelected),
  ],
);

export const adCampaigns = pgTable(
  'ad_campaigns',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    adAccountId: varchar('ad_account_id', { length: 30 })
      .notNull()
      .references(() => adAccounts.id, { onDelete: 'cascade' }),

    platformCampaignId: varchar('platform_campaign_id', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    status: varchar('status', { length: 50 }),
    objective: varchar('objective', { length: 100 }),
    dailyBudget: integer('daily_budget'),
    lifetimeBudget: integer('lifetime_budget'),
    currency: varchar('currency', { length: 10 }),
    metrics: jsonb('metrics').$type<AdCampaignMetrics>(),
    metricsSyncedAt: timestamp('metrics_synced_at'),
    contentHash: varchar('content_hash', { length: 64 }),
  },
  (table) => [
    uniqueIndex('ad_campaigns_account_platform_campaign_idx').on(
      table.adAccountId,
      table.platformCampaignId,
    ),
    index('ad_campaigns_ad_account_idx').on(table.adAccountId),
    index('ad_campaigns_status_idx').on(table.status),
  ],
);

export type AdPlatformConnection = typeof adPlatformConnections.$inferSelect;
export type NewAdPlatformConnection = typeof adPlatformConnections.$inferInsert;
export type AdAccount = typeof adAccounts.$inferSelect;
export type NewAdAccount = typeof adAccounts.$inferInsert;
export type AdCampaign = typeof adCampaigns.$inferSelect;
export type NewAdCampaign = typeof adCampaigns.$inferInsert;
