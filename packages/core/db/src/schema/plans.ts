import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  numeric,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// Credit rates for different services (credits per unit)
export interface CreditRates {
  aiTokens: number;         // Credits per 1000 tokens (default: 1)
  parcelLabel: number;      // Credits per label
  meetingBotMinute: number; // Credits per minute
}

// Plan features interface for type-safe feature access
export interface PlanFeatures {
  // Mail limits (null = unlimited)
  maxDomains?: number | null;
  maxEmailAccounts?: number | null;
  emailsPerMonth?: number;

  // WeldMail (shared domain) limits
  weldMailEnabled?: boolean;
  maxWeldMailAddresses?: number | null; // null = unlimited

  // Custom domain limits
  customEmailDomain?: boolean; // Whether custom domains are allowed
  maxCustomDomains?: number | null; // null = unlimited

  // AI limits (deprecated - use monthlyCredits instead)
  aiCreditsPerMonth?: number;

  // Unified credits system
  monthlyCredits?: number;
  creditRates?: CreditRates;

  // Task execution limits
  taskExecutions?: number;

  // Boolean features
  removeBranding?: boolean;
  prioritySupport?: boolean;

  // Enterprise features
  sso?: boolean;
  customIntegrations?: boolean;

  // CRM features
  callRecordings?: boolean;

  // Allow additional dynamic features
  [key: string]: boolean | number | string | null | undefined | CreditRates;
}

// Plans table - subscription plans in master database
export const plans = pgTable('plans', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Plan identification
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  description: text('description'),

  // Pricing (stored as decimal for precision)
  priceMonthly: numeric('price_monthly', { precision: 18, scale: 2 }).notNull().default('0'),
  priceYearly: numeric('price_yearly', { precision: 18, scale: 2 }).notNull().default('0'),
  currency: varchar('currency', { length: 3 }).notNull().default('EUR'),

  // Per-user pricing
  pricePerUser: numeric('price_per_user', { precision: 10, scale: 2 }),
  includedUsers: integer('included_users').default(1),

  // Unified credits system
  monthlyCredits: integer('monthly_credits').default(0),
  creditsRolloverCap: integer('credits_rollover_cap'), // null = 2x monthly

  // Features and limits (flexible JSONB for feature flags)
  features: jsonb('features').$type<PlanFeatures>().default({}),

  // Hard limits
  maxUsers: integer('max_users'),
  maxProjects: integer('max_projects'),
  maxCustomDomains: integer('max_custom_domains'), // null = unlimited, 0 = disabled

  // Branding
  removeBranding: boolean('remove_branding').notNull().default(false),

  // Status and ordering
  isActive: boolean('is_active').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  hasApiAccess: boolean('has_api_access').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),

  // Display options
  badge: varchar('badge', { length: 50 }), // e.g., "Popular", "Best Value"
  color: varchar('color', { length: 20 }), // For UI theming

  // Stripe product/price IDs for billing integration
  stripeProductId: varchar('stripe_product_id', { length: 255 }),
  stripePriceIdMonthly: varchar('stripe_price_id_monthly', { length: 255 }),
  stripePriceIdYearly: varchar('stripe_price_id_yearly', { length: 255 }),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('plans_slug_idx').on(table.slug),
  index('plans_is_active_idx').on(table.isActive),
  index('plans_sort_order_idx').on(table.sortOrder),
]);

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
