import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  pgEnum,
  index,
  uniqueIndex,
  numeric,
  integer,
  smallint,
  jsonb,
} from 'drizzle-orm/pg-core';

// ============================================================================
// GLOBAL USERS TABLE
// ============================================================================

// Global users table - stores user profile data globally (not per-workspace)
export const users = pgTable('users', {
  // Clerk user ID as primary key
  id: varchar('id', { length: 255 }).primaryKey(),

  // Core fields (synced from Clerk)
  email: varchar('email', { length: 255 }).notNull(),
  firstName: varchar('first_name', { length: 255 }),
  lastName: varchar('last_name', { length: 255 }),
  imageUrl: varchar('image_url', { length: 500 }),

  // Extended profile fields (app-specific)
  phone: varchar('phone', { length: 50 }),
  nickname: varchar('nickname', { length: 255 }),
  jobTitle: varchar('job_title', { length: 255 }),
  bio: text('bio'),
  timezone: varchar('timezone', { length: 100 }).default('UTC'),

  // Status (for tracking Clerk deletion without losing data)
  isActive: boolean('is_active').notNull().default(true),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('users_email_idx').on(table.email),
  index('users_is_active_idx').on(table.isActive),
]);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
import { plans } from './plans';

// ============================================================================
// NEON DATABASE INFRASTRUCTURE
// ============================================================================

// Status enum for Neon shared projects
export const neonSharedProjectStatusEnum = pgEnum('neon_shared_project_status', ['active', 'full', 'disabled']);

// Neon Shared Projects - tracks shared Neon projects for free-tier users
// Each shared project can hold up to 500 databases (Neon limit)
export const neonSharedProjects = pgTable('neon_shared_projects', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Neon project identification
  neonProjectId: varchar('neon_project_id', { length: 100 }).notNull().unique(),
  neonProjectName: varchar('neon_project_name', { length: 255 }).notNull(),
  region: varchar('region', { length: 50 }).notNull().default('aws-eu-central-1'),

  // Branch info (Neon uses branches for database isolation)
  mainBranchId: varchar('main_branch_id', { length: 100 }),

  // Connection details
  connectionHost: varchar('connection_host', { length: 255 }),
  connectionPort: smallint('connection_port').default(5432),

  // Admin credentials (for creating new databases/roles)
  adminRole: varchar('admin_role', { length: 100 }),
  adminPasswordEncrypted: text('admin_password_encrypted'), // Encrypted with workspace secret

  // Capacity tracking
  databaseCount: smallint('database_count').notNull().default(0),
  maxDatabases: smallint('max_databases').notNull().default(500),

  // Status
  status: neonSharedProjectStatusEnum('status').notNull().default('active'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('neon_shared_projects_status_idx').on(table.status),
  index('neon_shared_projects_region_idx').on(table.region),
  index('neon_shared_projects_database_count_idx').on(table.databaseCount),
]);

export type NeonSharedProject = typeof neonSharedProjects.$inferSelect;
export type NewNeonSharedProject = typeof neonSharedProjects.$inferInsert;
export type NeonSharedProjectStatus = 'active' | 'full' | 'disabled';

// Tenant tier enum (kept for backward compatibility, will be derived from plan)
export const tenantTierEnum = pgEnum('tenant_tier', ['free', 'business', 'scale', 'enterprise']);

// Workspaces/Tenants table in master database
export const workspaces = pgTable('workspaces', {
  id: varchar('id', { length: 255 }).primaryKey(),

  // Clerk organization ID (used as workspace identifier)
  clerkOrgId: varchar('clerk_org_id', { length: 255 }).unique(),

  // Workspace info
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  imageUrl: varchar('image_url', { length: 500 }), // Org logo from Clerk

  // Subscription plan (foreign key to plans table)
  planId: varchar('plan_id', { length: 30 }).references(() => plans.id),

  // Neon database configuration
  neonProjectId: varchar('neon_project_id', { length: 100 }),
  neonDatabaseName: varchar('neon_database_name', { length: 100 }),
  // Legacy: references neonSharedProjects for workspaces created under old shared architecture.
  // New workspaces always have null. Only checked in deleteWorkspaceDatabase() for legacy cleanup.
  sharedProjectId: varchar('shared_project_id', { length: 30 }).references(() => neonSharedProjects.id),
  neonBranchId: varchar('neon_branch_id', { length: 100 }),
  neonRoleName: varchar('neon_role_name', { length: 100 }),
  neonRegion: varchar('neon_region', { length: 50 }),
  // Encrypted connection string (AES-256-GCM, avoids Neon API at runtime)
  databaseUrl: text('database_url'),
  // When the database was provisioned
  databaseProvisionedAt: timestamp('database_provisioned_at'),

  // Provisioning lifecycle: 'pending' → 'provisioning' → 'ready' | 'failed'.
  // `databaseProvisionedAt` stays the source of truth for "ready"; this column
  // lets the onboarding UI distinguish "still working" from "permanently failed"
  // so it can offer a retry instead of dropping the user into a half-built
  // workspace. `provisioningError` holds the last failure message for support.
  provisioningStatus: varchar('provisioning_status', { length: 20 }).notNull().default('pending'),
  provisioningError: text('provisioning_error'),

  // Elastic Email sub-account API key (per-workspace, for sending/domain management)
  elasticEmailApiKey: text('elastic_email_api_key'),

  // Stripe billing
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
  purchasedSeats: integer('purchased_seats').notNull().default(0),
  stripePhoneSubscriptionId: varchar('stripe_phone_subscription_id', { length: 255 }),
  // One shared subscription for all purchased agent packages. First purchase
  // creates the subscription; subsequent purchases add line items. Cancelling
  // the last item marks this null via the webhook.
  stripeAgentsSubscriptionId: varchar('stripe_agents_subscription_id', { length: 255 }),

  // Subscription state (source of truth — written by Stripe webhooks)
  subscriptionStatus: varchar('subscription_status', { length: 30 }), // active, trialing, past_due, canceled, etc.
  subscriptionCycle: varchar('subscription_cycle', { length: 10 }), // monthly or yearly
  subscriptionCurrentPeriodStart: timestamp('subscription_current_period_start'),
  subscriptionCurrentPeriodEnd: timestamp('subscription_current_period_end'),
  subscriptionCancelAtPeriodEnd: boolean('subscription_cancel_at_period_end').notNull().default(false),

  // Trial-expiry / no-free-plan enforcement.
  // `paidPlanRequired` marks a workspace as subject to the "add payment or be
  // deleted" policy — set true for new signups going forward; existing free/
  // trialing workspaces default false and are grandfathered (never force-locked).
  // When such a workspace's trial (or paid subscription) ends without an active
  // paid subscription, the Stripe webhook stamps `trialExpiredAt` (start of the
  // 30-day grace window) and `scheduledDeletionAt` (when the deletion sweep will
  // tear the workspace down). Adding a paid subscription clears both back to null.
  paidPlanRequired: boolean('paid_plan_required').notNull().default(false),
  trialExpiredAt: timestamp('trial_expired_at'),
  scheduledDeletionAt: timestamp('scheduled_deletion_at'),

  // Admin-initiated scheduled deletion (WeldSuite internal console). Reuses the
  // shared `scheduledDeletionAt` above as the teardown date, but — unlike the
  // trial-expiry policy which keeps the workspace usable during its grace
  // window — an admin deletion SUSPENDS the workspace immediately
  // (`isActive = false`) while retaining data + memberships so it can be
  // cancelled and fully restored before the sweep runs. A non-null
  // `deletionRequestedBy` marks the schedule as admin-initiated (vs the billing
  // webhook). `deletedAt` is stamped by the deletion sweep once teardown has
  // been triggered, and is the sweep's guard against re-processing (it replaces
  // the older `isActive = true` guard so suspended workspaces are still swept).
  deletionRequestedAt: timestamp('deletion_requested_at'),
  deletionRequestedBy: varchar('deletion_requested_by', { length: 255 }),
  deletionReason: text('deletion_reason'),
  deletedAt: timestamp('deleted_at'),

  // Status
  isActive: boolean('is_active').notNull().default(true),

  // Onboarding
  onboardingCompletedAt: timestamp('onboarding_completed_at'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('workspaces_plan_id_idx').on(table.planId),
  // Drives the scheduled-deletion cron sweep (find workspaces due for teardown).
  index('workspaces_scheduled_deletion_at_idx').on(table.scheduledDeletionAt),
]);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type TenantTier = 'free' | 'business' | 'scale' | 'enterprise';

// ============================================================================
// USER-WORKSPACE MEMBERSHIPS (Global tracking)
// ============================================================================

// Membership status enum
export const membershipStatusEnum = pgEnum('membership_status', ['ACTIVE', 'PENDING']);

// User-Workspace relationship table - tracks all memberships globally
export const userWorkspaces = pgTable('user_workspaces', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Foreign keys
  userId: varchar('user_id', { length: 255 }).notNull().references(() => users.id),
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().references(() => workspaces.id),

  // Clerk sync tracking
  clerkMembershipId: varchar('clerk_membership_id', { length: 255 }), // For matching webhook events

  // Role (cached from Clerk)
  role: varchar('role', { length: 50 }).notNull().default('org:member'), // org:admin or org:member

  // Status
  status: membershipStatusEnum('status').notNull().default('ACTIVE'),

  // Invitation tracking
  invitedBy: varchar('invited_by', { length: 255 }).references(() => users.id),
  invitedAt: timestamp('invited_at'),
  joinedAt: timestamp('joined_at'), // When invitation was accepted / membership activated

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  // Ensure one membership per user-workspace pair
  uniqueIndex('user_workspaces_user_workspace_idx').on(table.userId, table.workspaceId),
  index('user_workspaces_user_id_idx').on(table.userId),
  index('user_workspaces_workspace_id_idx').on(table.workspaceId),
  index('user_workspaces_status_idx').on(table.status),
  index('user_workspaces_clerk_membership_id_idx').on(table.clerkMembershipId),
]);

export type UserWorkspace = typeof userWorkspaces.$inferSelect;
export type NewUserWorkspace = typeof userWorkspaces.$inferInsert;

// ============================================================================
// WIDGET REGISTRY
// ============================================================================

// Widget Registry - maps widgetId to workspaceId for lookup
// This allows the widget to only need widgetId, and we can find the workspace
export const widgetRegistry = pgTable('widget_registry', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Unique widget identifier (matches widgetId in tenant's helpdesk_widget_settings)
  widgetId: varchar('widget_id', { length: 50 }).notNull().unique(),

  // Reference to workspace
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().references(() => workspaces.id),

  // Widget name (for admin reference)
  widgetName: varchar('widget_name', { length: 255 }),

  // Status - can be deactivated without deleting
  isActive: boolean('is_active').notNull().default(true),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('widget_registry_widget_id_idx').on(table.widgetId),
  index('widget_registry_workspace_id_idx').on(table.workspaceId),
  index('widget_registry_is_active_idx').on(table.isActive),
]);

export type WidgetRegistry = typeof widgetRegistry.$inferSelect;
export type NewWidgetRegistry = typeof widgetRegistry.$inferInsert;

// ============================================================================
// MAIL ACCOUNT REGISTRY
// ============================================================================

// Mail Account Registry - maps email addresses to workspaces for webhook routing
// When Mailcow sends a webhook with a recipient email, we look up this table
// to find the workspace, then query the tenant's database for account details
export const mailAccountRegistry = pgTable('mail_account_registry', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Email address (the key for webhook lookups)
  email: varchar('email', { length: 255 }).notNull().unique(),

  // Reference to workspace
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().references(() => workspaces.id),

  // Reference to mail account in tenant DB (for correlation)
  accountId: varchar('account_id', { length: 30 }).notNull(),

  // Status - can be deactivated without deleting
  isActive: boolean('is_active').notNull().default(true),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('mail_account_registry_email_idx').on(table.email),
  index('mail_account_registry_workspace_id_idx').on(table.workspaceId),
  index('mail_account_registry_account_id_idx').on(table.accountId),
  index('mail_account_registry_is_active_idx').on(table.isActive),
]);

export type MailAccountRegistry = typeof mailAccountRegistry.$inferSelect;
export type NewMailAccountRegistry = typeof mailAccountRegistry.$inferInsert;

// ============================================================================
// API KEY REGISTRY
// ============================================================================

// API Key Registry - maps key hashes to workspaces for external API auth
// Keys are stored in per-workspace databases, but the external API needs
// to look them up without knowing which workspace to query first.
export const apiKeyRegistry = pgTable('api_key_registry', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // SHA-256 hash of the full API key
  keyHash: varchar('key_hash', { length: 255 }).notNull(),

  // Type of key: 'personal' or 'workspace'
  keyType: varchar('key_type', { length: 20 }).notNull(),

  // Reference to workspace
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().references(() => workspaces.id),

  // ID of the key in the workspace's tenant database
  tenantKeyId: varchar('tenant_key_id', { length: 30 }).notNull(),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('api_key_registry_key_hash_idx').on(table.keyHash),
  index('api_key_registry_workspace_id_idx').on(table.workspaceId),
]);

export type ApiKeyRegistry = typeof apiKeyRegistry.$inferSelect;
export type NewApiKeyRegistry = typeof apiKeyRegistry.$inferInsert;

// Domain Pricing - centralized pricing for all TLDs
// Stored in master DB so all tenants share the same pricing
export const hostDomainPricing = pgTable('domain_pricing', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // TLD identification
  tld: varchar('tld', { length: 50 }).notNull().unique(), // e.g., "com", "nl", "io"
  category: varchar('category', { length: 100 }), // e.g., "popular", "country", "new", "premium"

  // Pricing (stored as decimal for precision)
  registrationPrice: numeric('registration_price', { precision: 10, scale: 2 }).notNull(),
  renewalPrice: numeric('renewal_price', { precision: 10, scale: 2 }).notNull(),
  transferPrice: numeric('transfer_price', { precision: 10, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('EUR'),

  // Minimum/maximum registration years
  minYears: integer('min_years').default(1),
  maxYears: integer('max_years').default(10),

  // Flags
  isActive: boolean('is_active').notNull().default(true),
  hasActivePromotion: boolean('has_active_promotion').default(false),
  isPopular: boolean('is_popular').default(false),
  isPremium: boolean('is_premium').default(false),
  supportsPrivacyProtection: boolean('supports_privacy_protection').default(true),
  supportsAutoRenew: boolean('supports_auto_renew').default(true),
  supportsTransfer: boolean('supports_transfer').default(true),

  // Promotion details
  promotionPrice: numeric('promotion_price', { precision: 10, scale: 2 }),
  promotionEndsAt: timestamp('promotion_ends_at'),

  // Registrar info
  registrar: varchar('registrar', { length: 100 }).default('cloudflare'),

  // Markup applied at Stripe checkout (one of these is used; the other is null)
  markupAmount: integer('markup_amount'), // flat markup in cents per registration
  markupPercent: numeric('markup_percent', { precision: 5, scale: 2 }), // percentage markup (e.g. "10.00" = 10%)

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('domain_pricing_tld_idx').on(table.tld),
  index('domain_pricing_category_idx').on(table.category),
  index('domain_pricing_is_active_idx').on(table.isActive),
  index('domain_pricing_is_popular_idx').on(table.isPopular),
]);

export type HostDomainPricing = typeof hostDomainPricing.$inferSelect;
export type NewHostDomainPricing = typeof hostDomainPricing.$inferInsert;

// ============================================================================
// PRE-PROVISIONED DATABASE POOL
// ============================================================================

// Status enum for database pool entries
export const databasePoolStatusEnum = pgEnum('database_pool_status', ['available', 'assigned', 'error']);

// Pre-provisioned, pre-migrated tenant databases ready for instant assignment
// to new workspaces. Two kinds of warm slot:
//   'dedicated' — a whole pre-created Neon project (paid tenants)
//   'shared'    — a database + role inside a shared Neon project shard (free tenants)
export const databasePool = pgTable('database_pool', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Slot kind: dedicated project vs database-in-shared-project
  kind: varchar('kind', { length: 20 }).notNull().default('dedicated'),

  // Neon project details (pre-created). For 'shared' slots neonProjectId is the
  // shard's project id and sharedProjectId references neon_shared_projects.id.
  neonProjectId: varchar('neon_project_id', { length: 100 }).notNull(),
  neonBranchId: varchar('neon_branch_id', { length: 100 }),
  connectionHost: varchar('connection_host', { length: 255 }),
  databaseName: varchar('database_name', { length: 100 }).notNull(),
  roleName: varchar('role_name', { length: 100 }).notNull(),
  databaseUrl: text('database_url').notNull(),

  // Shard reference for 'shared' slots (null for dedicated)
  sharedProjectId: varchar('shared_project_id', { length: 30 }),

  // Schema tracking
  schemaVersion: varchar('schema_version', { length: 50 }),

  // Region
  region: varchar('region', { length: 50 }).notNull().default('aws-eu-central-1'),

  // Pool status
  status: databasePoolStatusEnum('status').notNull().default('available'),

  // Assignment tracking
  assignedWorkspaceId: varchar('assigned_workspace_id', { length: 255 }),
  assignedAt: timestamp('assigned_at'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('database_pool_status_idx').on(table.status, table.region),
  index('database_pool_kind_status_idx').on(table.kind, table.status, table.region),
]);

export type DatabasePool = typeof databasePool.$inferSelect;
export type NewDatabasePool = typeof databasePool.$inferInsert;

// ============================================================================
// TELEPHONY PRICING
// ============================================================================

// Per-country phone number rental pricing (centralized in master DB)
export const telephonyNumberPricing = pgTable('telephony_number_pricing', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Country + type identification
  countryCode: varchar('country_code', { length: 5 }).notNull(), // e.g. "US", "NL"
  numberType: varchar('number_type', { length: 20 }).notNull(), // "local", "toll-free", "mobile"

  // Pricing
  monthlyPrice: numeric('monthly_price', { precision: 10, scale: 2 }).notNull(),
  setupFee: numeric('setup_fee', { precision: 10, scale: 2 }).notNull().default('0'),
  currency: varchar('currency', { length: 3 }).notNull().default('USD'),

  // Provider
  provider: varchar('provider', { length: 50 }).notNull().default('twilio'),

  // Stripe price ID for billing this number type
  stripePriceId: varchar('stripe_price_id', { length: 255 }),
  stripeProductId: varchar('stripe_product_id', { length: 255 }),

  // Status
  isActive: boolean('is_active').notNull().default(true),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('telephony_number_pricing_country_type_idx').on(table.countryCode, table.numberType),
  index('telephony_number_pricing_country_code_idx').on(table.countryCode),
  index('telephony_number_pricing_is_active_idx').on(table.isActive),
]);

export type TelephonyNumberPricing = typeof telephonyNumberPricing.$inferSelect;
export type NewTelephonyNumberPricing = typeof telephonyNumberPricing.$inferInsert;

// Credit rates for telephony services (centralized in master DB)
export const telephonyServiceRates = pgTable('telephony_service_rates', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Service identification
  serviceType: varchar('service_type', { length: 50 }).notNull().unique(), // e.g. "voip_call_minute", "call_transcription_minute"

  // Rate
  creditsPerUnit: numeric('credits_per_unit', { precision: 10, scale: 2 }).notNull(),

  // Metadata
  description: text('description'),
  unitLabel: varchar('unit_label', { length: 30 }), // e.g. "minute"

  // Status
  isActive: boolean('is_active').notNull().default(true),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type TelephonyServiceRate = typeof telephonyServiceRates.$inferSelect;
export type NewTelephonyServiceRate = typeof telephonyServiceRates.$inferInsert;

// ----------------------------------------------------------------------------
// Telnyx porting order index — webhook routing
// ----------------------------------------------------------------------------
// Telnyx porting webhooks (porting.order.status_changed) carry NO client_state,
// so the tenant webhook handler can't tell which workspace's tenant DB to
// update. We bridge that with a tiny index in the master DB: when we POST
// /porting_orders we insert (telnyxPortingOrderId, clerkOrgId, draftId),
// look it up on every webhook fire, and delete it once the order reaches
// a terminal state (completed / cancelled / exception that won't recover).
//
// We store clerkOrgId rather than workspaces.id because the existing tenant
// DB resolver (getTenantDbForWorkspace) is keyed by clerkOrgId — keeping
// the same convention avoids an extra lookup in the webhook hot path.
export const telnyxPortingOrderIndex = pgTable('telnyx_porting_order_index', {
  telnyxPortingOrderId: varchar('telnyx_porting_order_id', { length: 100 }).primaryKey(),
  clerkOrgId: varchar('clerk_org_id', { length: 255 }).notNull(),
  draftId: varchar('draft_id', { length: 30 }).notNull(), // voip_porting_orders.id in tenant DB
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('telnyx_porting_order_index_org_idx').on(table.clerkOrgId),
]);

export type TelnyxPortingOrderIndex = typeof telnyxPortingOrderIndex.$inferSelect;
export type NewTelnyxPortingOrderIndex = typeof telnyxPortingOrderIndex.$inferInsert;

// ============================================================================
// BILLING INVOICES
// ============================================================================

export const billingInvoices = pgTable('billing_invoices', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Workspace reference
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().references(() => workspaces.id),

  // Stripe identifiers
  stripeInvoiceId: varchar('stripe_invoice_id', { length: 255 }).notNull().unique(),
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),

  // Invoice details
  number: varchar('number', { length: 100 }),
  amountDue: integer('amount_due'), // in cents
  amountPaid: integer('amount_paid'), // in cents
  currency: varchar('currency', { length: 10 }),
  status: varchar('status', { length: 30 }), // draft, open, paid, uncollectible, void
  billingReason: varchar('billing_reason', { length: 50 }), // subscription_create, subscription_cycle, etc.

  // Period
  periodStart: timestamp('period_start'),
  periodEnd: timestamp('period_end'),

  // URLs
  pdfUrl: text('pdf_url'),
  hostedUrl: text('hosted_url'),

  // Tax data (populated from Stripe Tax)
  taxAmount: integer('tax_amount'), // Tax amount in smallest currency unit (cents)
  subtotalAmount: integer('subtotal_amount'), // Amount before tax in cents
  customerCountry: varchar('customer_country', { length: 2 }), // ISO country code
  customerTaxExempt: varchar('customer_tax_exempt', { length: 20 }), // 'exempt', 'none', 'reverse'

  // Payment
  paidAt: timestamp('paid_at'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('billing_invoices_workspace_id_idx').on(table.workspaceId),
  index('billing_invoices_stripe_customer_id_idx').on(table.stripeCustomerId),
  index('billing_invoices_status_idx').on(table.status),
  index('billing_invoices_created_at_idx').on(table.createdAt),
]);

export type BillingInvoiceRecord = typeof billingInvoices.$inferSelect;
export type NewBillingInvoiceRecord = typeof billingInvoices.$inferInsert;

// ============================================================================
// BILLING PAYMENTS
// ============================================================================

export const billingPayments = pgTable('billing_payments', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Workspace reference
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().references(() => workspaces.id),

  // Invoice reference (nullable — not all payments are invoice-linked)
  invoiceId: varchar('invoice_id', { length: 30 }).references(() => billingInvoices.id),

  // Stripe identifiers
  stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }).unique(),
  stripeChargeId: varchar('stripe_charge_id', { length: 255 }),

  // Amount
  amount: integer('amount').notNull(), // in cents
  currency: varchar('currency', { length: 10 }).notNull(),
  status: varchar('status', { length: 30 }).notNull(), // succeeded, failed, processing, requires_action, canceled

  // Payment method details
  paymentMethodType: varchar('payment_method_type', { length: 30 }), // card, bank_transfer, sepa_debit, etc.
  paymentMethodBrand: varchar('payment_method_brand', { length: 30 }), // visa, mastercard, etc.
  paymentMethodLast4: varchar('payment_method_last4', { length: 4 }),

  // Failure info (for failed payments)
  failureCode: varchar('failure_code', { length: 100 }),
  failureMessage: text('failure_message'),

  // Refund tracking
  refundedAmount: integer('refunded_amount').notNull().default(0), // in cents

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('billing_payments_workspace_id_idx').on(table.workspaceId),
  index('billing_payments_invoice_id_idx').on(table.invoiceId),
  index('billing_payments_status_idx').on(table.status),
  index('billing_payments_created_at_idx').on(table.createdAt),
]);

export type BillingPaymentRecord = typeof billingPayments.$inferSelect;
export type NewBillingPaymentRecord = typeof billingPayments.$inferInsert;

// ============================================================================
// WORKSPACE CREDITS
// ============================================================================

/**
 * Workspace Credits - tracks the unified credit balance for each workspace
 *
 * All consumable services (AI tokens, parcel labels, meeting bot minutes)
 * draw from this single credit balance.
 */
export const workspaceCredits = pgTable('workspace_credits', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Workspace reference
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().references(() => workspaces.id),

  // Current balance
  currentBalance: integer('current_balance').notNull().default(0),

  // Credit allocation breakdown (billed with subscription)
  planCredits: integer('plan_credits').notNull().default(0),
  subscribedCredits: integer('subscribed_credits').notNull().default(0),
  monthlyAllocation: integer('monthly_allocation').notNull().default(0),

  // Stripe subscription item for credits (for billing)
  stripeCreditsItemId: varchar('stripe_credits_item_id', { length: 255 }),
  stripeCreditsPriceId: varchar('stripe_credits_price_id', { length: 255 }),

  // Rollover tracking
  rolledOverCredits: integer('rolled_over_credits').notNull().default(0),
  rolloverCap: integer('rollover_cap'),

  // Period tracking (aligned with subscription billing cycle)
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  lastResetAt: timestamp('last_reset_at', { withTimezone: true }),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('workspace_credits_workspace_id_idx').on(table.workspaceId),
  index('workspace_credits_period_end_idx').on(table.periodEnd),
]);

export type WorkspaceCredits = typeof workspaceCredits.$inferSelect;
export type NewWorkspaceCredits = typeof workspaceCredits.$inferInsert;

// ============================================================================
// CREDIT TRANSACTIONS
// ============================================================================

/**
 * Credit transaction types
 */
export type CreditTransactionType =
  | 'monthly_allocation'
  | 'rollover'
  | 'purchase'
  | 'consumption'
  | 'refund'
  | 'expiry'
  | 'adjustment';

/**
 * Credit service types - what the credits are used for
 */
export type CreditServiceType =
  | 'ai_tokens'
  | 'parcel_label'
  | 'meeting_bot'
  | 'call_transcription'
  | 'sms'
  | 'voip_call'
  | 'data_enrichment'
  | 'social_post';

/**
 * Credit transaction metadata for different service types
 */
export interface CreditTransactionMetadata {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  // AI gateway routing (serviceType 'ai_tokens'). Typed hints only — the index
  // signature below already allowed these, so adding them needs NO migration.
  // They make the customer ledger reconcilable row-by-row against the ops
  // ledger (`ai_provider_usage`): same call, what they paid vs what we paid.
  /** cloudflare | vercel | neon — which gateway actually served the call. */
  gateway?: string;
  /** What WE paid the gateway, in integer nano-USD. 0 when service credit covered it. */
  providerCostNanoUsd?: number;
  /** `ai_provider_usage.id` for the matching ops-ledger row. */
  usageRowId?: string;
  carrier?: string;
  serviceType?: string;
  trackingNumber?: string;
  platform?: string;
  durationMinutes?: number;
  meetingUrl?: string;
  reason?: string;
  adminUserId?: string;
  adminNote?: string;
  [key: string]: unknown;
}

/**
 * Credit Transactions - tracks all credit movements
 */
export const creditTransactions = pgTable('credit_transactions', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Workspace reference
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().references(() => workspaces.id),

  // Transaction type
  type: varchar('type', { length: 30 }).notNull(),

  // Amount (positive for credits in, negative for credits out)
  amount: integer('amount').notNull(),
  balanceAfter: integer('balance_after').notNull(),

  // Service consumption details
  serviceType: varchar('service_type', { length: 30 }),
  referenceId: varchar('reference_id', { length: 30 }),
  referenceType: varchar('reference_type', { length: 50 }),

  // Idempotency — retries (webhook replays, queue redeliveries) with the same
  // key record exactly one ledger row / balance change. Nullable; NULLs don't
  // collide under the unique index.
  idempotencyKey: varchar('idempotency_key', { length: 255 }),

  // Purchase details (if type = 'purchase')
  stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
  stripeCheckoutSessionId: varchar('stripe_checkout_session_id', { length: 255 }),
  amountPaid: numeric('amount_paid', { precision: 10, scale: 2 }),
  currency: varchar('currency', { length: 3 }),

  // Description and metadata
  description: text('description'),
  metadata: jsonb('metadata').$type<CreditTransactionMetadata>(),

  // Who initiated the transaction
  userId: varchar('user_id', { length: 255 }),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('credit_transactions_workspace_id_idx').on(table.workspaceId),
  index('credit_transactions_type_idx').on(table.type),
  index('credit_transactions_service_type_idx').on(table.serviceType),
  index('credit_transactions_reference_idx').on(table.referenceType, table.referenceId),
  index('credit_transactions_created_at_idx').on(table.createdAt),
  index('credit_transactions_stripe_payment_idx').on(table.stripePaymentIntentId),
  uniqueIndex('credit_transactions_idempotency_key_idx').on(table.idempotencyKey),
]);

export type CreditTransaction = typeof creditTransactions.$inferSelect;
export type NewCreditTransaction = typeof creditTransactions.$inferInsert;

// ============================================================================
// CREDIT PACKAGES
// ============================================================================

/**
 * Credit packages available for purchase (global, no workspaceId)
 */
export const creditPackages = pgTable('credit_packages', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Package details
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  credits: integer('credits').notNull(),

  // Pricing
  price: numeric('price', { precision: 10, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('EUR'),

  // Stripe integration
  stripePriceId: varchar('stripe_price_id', { length: 255 }),
  stripeProductId: varchar('stripe_product_id', { length: 255 }),

  // Display options
  isPopular: integer('is_popular').default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: integer('is_active').notNull().default(1),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('credit_packages_active_idx').on(table.isActive),
  index('credit_packages_sort_idx').on(table.sortOrder),
]);

export type CreditPackage = typeof creditPackages.$inferSelect;
export type NewCreditPackage = typeof creditPackages.$inferInsert;

// ============================================================================
// WORKSPACE USAGE
// ============================================================================

/**
 * Workspace Usage Tracking
 *
 * Tracks monthly usage metrics per workspace for plan limit enforcement.
 */
export const workspaceUsage = pgTable('workspace_usage', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Workspace reference
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().references(() => workspaces.id),

  // Task execution tracking
  taskExecutionsThisMonth: integer('task_executions_this_month').notNull().default(0),
  taskExecutionsLastReset: timestamp('task_executions_last_reset', { withTimezone: true }).notNull().defaultNow(),

  // Email tracking
  emailsSentThisMonth: integer('emails_sent_this_month').notNull().default(0),
  emailsLastReset: timestamp('emails_last_reset', { withTimezone: true }).notNull().defaultNow(),

  // AI credits tracking
  aiCreditsUsedThisMonth: integer('ai_credits_used_this_month').notNull().default(0),
  aiCreditsLastReset: timestamp('ai_credits_last_reset', { withTimezone: true }).notNull().defaultNow(),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('workspace_usage_workspace_id_idx').on(table.workspaceId),
]);

export type WorkspaceUsage = typeof workspaceUsage.$inferSelect;
export type NewWorkspaceUsage = typeof workspaceUsage.$inferInsert;

// ============================================================================
// DIGEST SCHEDULES
// ============================================================================

/**
 * Digest schedule metadata stored in master DB so the hourly sweep
 * never needs to wake tenant databases just to check settings.
 */
export const digestSchedules = pgTable('digest_schedules', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Workspace reference
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().references(() => workspaces.id),

  // Schedule config (synced from tenant DB on settings save)
  enabled: boolean('enabled').notNull().default(true),
  sendHour: integer('send_hour').notNull().default(8), // 0-23 in workspace timezone
  timezone: text('timezone').notNull().default('UTC'),

  // Timestamps
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('digest_schedules_workspace_id_idx').on(table.workspaceId),
]);

export type DigestSchedule = typeof digestSchedules.$inferSelect;
export type NewDigestSchedule = typeof digestSchedules.$inferInsert;

// ============================================================================
// HELP CENTER DOMAIN REGISTRY
// ============================================================================

/**
 * Help Center Domain Registry - maps domains to workspaces for help center routing.
 * Follows the same pattern as widgetRegistry but for help center domains.
 * Subdomains (acme.welddesk.org) are auto-verified; custom domains require DNS verification.
 */
export const helpcenterDomainRegistry = pgTable('helpcenter_domain_registry', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Domain (subdomain or custom)
  domain: varchar('domain', { length: 255 }).notNull().unique(),
  domainType: varchar('domain_type', { length: 20 }).notNull(), // 'subdomain' | 'custom'

  // Reference to workspace
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().references(() => workspaces.id),

  // Verification
  isVerified: integer('is_verified').notNull().default(1),
  isActive: integer('is_active').notNull().default(1),
  verificationToken: varchar('verification_token', { length: 255 }),
  verifiedAt: timestamp('verified_at'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('helpcenter_domain_registry_domain_idx').on(table.domain),
  index('helpcenter_domain_registry_workspace_id_idx').on(table.workspaceId),
]);

export type HelpcenterDomainRegistry = typeof helpcenterDomainRegistry.$inferSelect;
export type NewHelpcenterDomainRegistry = typeof helpcenterDomainRegistry.$inferInsert;

// ============================================================================
// ADMIN CONSOLE ACCESS (allowlist)
// ============================================================================

// Roles for the internal admin console (apps/web/admin).
//  - superadmin: full access + can manage other admin members
//  - admin:      full operational access, cannot manage members
//  - viewer:     read-only access to every surface
export const adminRoleEnum = pgEnum('admin_role', ['superadmin', 'admin', 'viewer']);

// Admin Users - explicit allowlist of who may sign into the internal admin
// console. Access is gated on an ACTIVE row here (matched by email), plus an
// env-based bootstrap list so the very first superadmin can never be locked
// out. Without a matching entry, an authenticated Clerk user gets NO access.
export const adminUsers = pgTable('admin_users', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Clerk user id, populated on first successful sign-in (matched by email).
  // Null while an invitation is still outstanding.
  userId: varchar('user_id', { length: 255 }),

  // Email is the invite key — always stored lowercased.
  email: varchar('email', { length: 255 }).notNull().unique(),

  // Display name, filled from the Clerk profile when the admin first signs in.
  name: varchar('name', { length: 255 }),

  role: adminRoleEnum('role').notNull().default('admin'),

  // Access can be revoked without deleting the row (keeps the audit trail).
  isActive: boolean('is_active').notNull().default(true),

  // Invitation / activity tracking
  invitedBy: varchar('invited_by', { length: 255 }),
  invitedAt: timestamp('invited_at').notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('admin_users_email_idx').on(table.email),
  index('admin_users_user_id_idx').on(table.userId),
  index('admin_users_is_active_idx').on(table.isActive),
]);

export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;
export type AdminRole = 'superadmin' | 'admin' | 'viewer';
export const ADMIN_ROLES: readonly AdminRole[] = ['superadmin', 'admin', 'viewer'];

// Re-export admin-related schemas for master database
export { plans, type Plan, type NewPlan } from './plans';
// AI gateway ops ledger — what WE pay each gateway, vs credit_transactions
// (what the customer pays). Drives cost-aware routing; see the file header.
export {
  aiProviderUsage,
  aiGatewayCredits,
  nanoUsd,
  usdFromNano,
  type AiProviderUsage,
  type NewAiProviderUsage,
  type AiGatewayCredit,
  type NewAiGatewayCredit,
} from './ai-gateway-costs';
export { systemSettings, type SystemSetting, type NewSystemSetting, SETTING_CATEGORIES, type SettingCategory } from './system-settings';
export { enterpriseInquiries, inquiryStatusEnum, type EnterpriseInquiry, type NewEnterpriseInquiry } from './enterprise-inquiries';
export { featureRequests, featureTypeEnum, featureStatusEnum, type FeatureRequest, type NewFeatureRequest, type FeatureType, type FeatureStatus } from './feature-requests';
export { appCatalog, appScreenshots, APP_CATEGORIES, type AppCatalogEntry, type NewAppCatalogEntry, type AppScreenshot, type NewAppScreenshot, type AppCategory } from './app-catalog';
export {
  userApps,
  userAppVersions,
  userAppInstalls,
  userAppTokens,
  userAppOauthClients,
  appDeveloperAccounts,
  USER_APP_VISIBILITIES,
  USER_APP_REVIEW_STATUSES,
  USER_APP_PRICING_TYPES,
  USER_APP_VERSION_STATUSES,
  USER_APP_INSTALL_STATUSES,
  USER_APP_TOKEN_TYPES,
  type UserAppManifest,
  type UserApp,
  type NewUserApp,
  type UserAppVersion,
  type NewUserAppVersion,
  type UserAppInstall,
  type NewUserAppInstall,
  type UserAppToken,
  type NewUserAppToken,
  type UserAppOauthClient,
  type NewUserAppOauthClient,
  type AppDeveloperAccount,
  type NewAppDeveloperAccount,
  type UserAppVisibility,
  type UserAppReviewStatus,
  type UserAppPricingType,
  type UserAppVersionStatus,
  type UserAppInstallStatus,
  type UserAppTokenType,
} from './user-apps';
