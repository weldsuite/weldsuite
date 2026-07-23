import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  numeric,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
// ============================================================================
// WELDAPPS — USER-CREATED APPS (MASTER DATABASE)
//
// User-created apps are authored per workspace, hosted by WeldSuite (static
// bundles in R2, rendered in a sandboxed iframe), and distributed through the
// app store: `private` apps are installable only in the authoring workspace,
// `public` apps are listed globally after manual review.
//
// These tables live in the MASTER database because public apps must be
// discoverable and installable across workspaces, and because external-api
// authenticates app tokens (wsat_) without knowing the tenant up front —
// the same reason api_key_registry is master-side.
// ============================================================================

/** Manifest describing a user-created app (weldapp.json produced by the weld CLI). */
export interface UserAppManifest {
  /** Globally unique app code (lowercase, kebab-case). Sidenav routes to /apps/{code}. */
  code: string;
  name: string;
  description?: string;
  /** Lucide icon name or emoji shown in the sidenav / app store. */
  icon?: string;
  category?: string;
  version: string;
  /** Bundle entry file, relative to the uploaded bundle root. */
  entrypoint?: string;
  /** external-api scopes the app requests (`resource:action`, wildcards allowed). */
  scopes?: string[];
  /** Storage collections the app uses (generic jsonb records, tenant DB). */
  collections?: { name: string; description?: string }[];
  /** Tools exposed to WeldAgent / the MCP server, gated by install scopes. */
  agentTools?: {
    name: string;
    description: string;
    /** JSON Schema for the tool input. */
    parameters?: Record<string, unknown>;
    action: {
      type:
        | 'storage.list'
        | 'storage.create'
        | 'storage.update'
        | 'storage.delete'
        | 'api.request';
      collection?: string;
      method?: string;
      path?: string;
    };
  }[];
  pricing?: {
    type: 'free' | 'subscription';
    monthlyPrice?: number;
    currency?: string;
  };
  /** Reserved — v1 apps render on the web platform only. */
  mobile?: boolean;
}

export const USER_APP_VISIBILITIES = ['private', 'public'] as const;
export type UserAppVisibility = (typeof USER_APP_VISIBILITIES)[number];

export const USER_APP_REVIEW_STATUSES = ['draft', 'submitted', 'approved', 'rejected'] as const;
export type UserAppReviewStatus = (typeof USER_APP_REVIEW_STATUSES)[number];

export const USER_APP_PRICING_TYPES = ['free', 'subscription'] as const;
export type UserAppPricingType = (typeof USER_APP_PRICING_TYPES)[number];

// User-created apps registry
export const userApps = pgTable('user_apps', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Identification (code shares the sidenav/app-store namespace with first-party apps)
  code: varchar('code', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  icon: varchar('icon', { length: 50 }).notNull().default('Puzzle'),
  category: varchar('category', { length: 50 }).notNull().default('Productivity'),

  // Authorship (workspaces.id in master — no FK to avoid an import cycle with master.ts)
  ownerWorkspaceId: varchar('owner_workspace_id', { length: 255 }).notNull(),
  createdBy: varchar('created_by', { length: 255 }).notNull(),

  // Distribution: private = authoring workspace only, public = global store (reviewed)
  visibility: varchar('visibility', { length: 20 }).notNull().default('private'),
  reviewStatus: varchar('review_status', { length: 20 }).notNull().default('draft'),
  reviewNotes: text('review_notes'),
  reviewedBy: varchar('reviewed_by', { length: 255 }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

  // Live version (auto-updates roll out to all installs; new scopes gate on re-consent)
  currentVersionId: varchar('current_version_id', { length: 30 }),
  manifest: jsonb('manifest').$type<UserAppManifest>(),
  requestedScopes: jsonb('requested_scopes').$type<string[]>().default([]),

  // Pricing (subscriptions billed via billing-worker; payouts via Stripe Connect)
  pricingType: varchar('pricing_type', { length: 20 }).notNull().default('free'),
  priceMonthly: numeric('price_monthly', { precision: 10, scale: 2 }),
  currency: varchar('currency', { length: 3 }).notNull().default('EUR'),
  platformFeePercent: integer('platform_fee_percent').notNull().default(15),
  stripeProductId: varchar('stripe_product_id', { length: 255 }),
  stripePriceId: varchar('stripe_price_id', { length: 255 }),

  // Stats
  installCount: integer('install_count').notNull().default(0),

  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('user_apps_owner_workspace_id_idx').on(table.ownerWorkspaceId),
  index('user_apps_visibility_idx').on(table.visibility),
  index('user_apps_review_status_idx').on(table.reviewStatus),
]);

export type UserApp = typeof userApps.$inferSelect;
export type NewUserApp = typeof userApps.$inferInsert;

export const USER_APP_VERSION_STATUSES = ['draft', 'published', 'superseded', 'rejected'] as const;
export type UserAppVersionStatus = (typeof USER_APP_VERSION_STATUSES)[number];

// Uploaded bundle versions (R2-hosted static assets)
export const userAppVersions = pgTable('user_app_versions', {
  id: varchar('id', { length: 30 }).primaryKey(),

  appId: varchar('app_id', { length: 30 })
    .notNull()
    .references(() => userApps.id, { onDelete: 'cascade' }),

  version: varchar('version', { length: 20 }).notNull(),
  manifest: jsonb('manifest').$type<UserAppManifest>(),
  requestedScopes: jsonb('requested_scopes').$type<string[]>().default([]),

  // Bundle storage (R2). bundleKey is the object prefix; files live under it.
  bundleKey: varchar('bundle_key', { length: 500 }).notNull(),
  entrypoint: varchar('entrypoint', { length: 255 }).notNull().default('index.html'),
  bundleSize: integer('bundle_size').notNull().default(0),
  fileCount: integer('file_count').notNull().default(0),

  status: varchar('status', { length: 20 }).notNull().default('draft'),
  changelog: text('changelog'),

  createdBy: varchar('created_by', { length: 255 }).notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('user_app_versions_app_version_idx').on(table.appId, table.version),
  index('user_app_versions_app_id_idx').on(table.appId),
]);

export type UserAppVersion = typeof userAppVersions.$inferSelect;
export type NewUserAppVersion = typeof userAppVersions.$inferInsert;

export const USER_APP_INSTALL_STATUSES = ['active', 'revoked'] as const;
export type UserAppInstallStatus = (typeof USER_APP_INSTALL_STATUSES)[number];

// Workspace install grants — the OAuth consent record (Slack-bot style):
// an admin approves the manifest scopes once at install; the grant is
// revoked (and its tokens with it) on uninstall. Master-side so external-api
// can authorize app tokens without a tenant round-trip.
export const userAppInstalls = pgTable('user_app_installs', {
  id: varchar('id', { length: 30 }).primaryKey(),

  appId: varchar('app_id', { length: 30 })
    .notNull()
    .references(() => userApps.id, { onDelete: 'cascade' }),
  workspaceId: varchar('workspace_id', { length: 255 }).notNull(),

  status: varchar('status', { length: 20 }).notNull().default('active'),

  // Scopes the admin consented to. When an update requests NEW scopes they
  // land in pendingScopes until re-consent moves them into grantedScopes.
  grantedScopes: jsonb('granted_scopes').$type<string[]>().default([]),
  pendingScopes: jsonb('pending_scopes').$type<string[]>(),

  installedBy: varchar('installed_by', { length: 255 }).notNull(),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),

  // Paid apps: per-workspace subscription reference (billing-worker / Stripe)
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
  subscriptionStatus: varchar('subscription_status', { length: 30 }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('user_app_installs_app_workspace_idx').on(table.appId, table.workspaceId),
  index('user_app_installs_workspace_id_idx').on(table.workspaceId),
  index('user_app_installs_app_id_idx').on(table.appId),
]);

export type UserAppInstall = typeof userAppInstalls.$inferSelect;
export type NewUserAppInstall = typeof userAppInstalls.$inferInsert;

export const USER_APP_TOKEN_TYPES = ['install', 'session'] as const;
export type UserAppTokenType = (typeof USER_APP_TOKEN_TYPES)[number];

// App tokens (prefix wsat_) — external-api auth, mirrors api_key_registry:
// SHA-256 hash lookup in master, scopes copied from the install grant.
// `install` tokens are long-lived workspace grants (minted at install,
// revoked at uninstall); `session` tokens are short-lived, minted for the
// iframe bridge on each app launch.
export const userAppTokens = pgTable('user_app_tokens', {
  id: varchar('id', { length: 30 }).primaryKey(),

  installId: varchar('install_id', { length: 30 })
    .notNull()
    .references(() => userAppInstalls.id, { onDelete: 'cascade' }),
  appId: varchar('app_id', { length: 30 }).notNull(),
  workspaceId: varchar('workspace_id', { length: 255 }).notNull(),

  tokenHash: varchar('token_hash', { length: 255 }).notNull(),
  tokenPrefix: varchar('token_prefix', { length: 20 }).notNull(),
  tokenType: varchar('token_type', { length: 20 }).notNull().default('install'),

  scopes: jsonb('scopes').$type<string[]>().default([]),

  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('user_app_tokens_token_hash_idx').on(table.tokenHash),
  index('user_app_tokens_install_id_idx').on(table.installId),
  index('user_app_tokens_workspace_id_idx').on(table.workspaceId),
]);

export type UserAppToken = typeof userAppTokens.$inferSelect;
export type NewUserAppToken = typeof userAppTokens.$inferInsert;

// OAuth 2.0 clients — one per app, used by the token endpoint
// (grant_type=client_credentials) so an app's own backend/agents can mint
// wsat_ tokens for workspaces that installed it.
export const userAppOauthClients = pgTable('user_app_oauth_clients', {
  id: varchar('id', { length: 30 }).primaryKey(),

  appId: varchar('app_id', { length: 30 })
    .notNull()
    .unique()
    .references(() => userApps.id, { onDelete: 'cascade' }),

  clientId: varchar('client_id', { length: 64 }).notNull().unique(),
  clientSecretHash: varchar('client_secret_hash', { length: 255 }).notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().default([]),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('user_app_oauth_clients_app_id_idx').on(table.appId),
]);

export type UserAppOauthClient = typeof userAppOauthClients.$inferSelect;
export type NewUserAppOauthClient = typeof userAppOauthClients.$inferInsert;

// Developer payout accounts (Stripe Connect) — one per authoring workspace.
export const appDeveloperAccounts = pgTable('app_developer_accounts', {
  id: varchar('id', { length: 30 }).primaryKey(),

  workspaceId: varchar('workspace_id', { length: 255 }).notNull().unique(),

  stripeConnectAccountId: varchar('stripe_connect_account_id', { length: 255 }),
  payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AppDeveloperAccount = typeof appDeveloperAccounts.$inferSelect;
export type NewAppDeveloperAccount = typeof appDeveloperAccounts.$inferInsert;
