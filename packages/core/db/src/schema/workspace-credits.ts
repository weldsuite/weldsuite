import {
  pgTable,
  varchar,
  timestamp,
  integer,
  index,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Workspace Credits - tracks the unified credit balance for each workspace
 *
 * All consumable services (AI tokens, parcel labels, meeting bot minutes)
 * draw from this single credit balance.
 *
 * Credits are part of the subscription billing:
 * - planCredits: Base credits included in the plan
 * - subscribedCredits: Additional credits the user purchased as part of their subscription
 * - monthlyAllocation = planCredits + subscribedCredits (calculated)
 */
export const workspaceCredits = pgTable('workspace_credits', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Current balance
  currentBalance: integer('current_balance').notNull().default(0),

  // Credit allocation breakdown (billed with subscription)
  planCredits: integer('plan_credits').notNull().default(0),          // Base credits from plan
  subscribedCredits: integer('subscribed_credits').notNull().default(0), // Additional credits purchased
  monthlyAllocation: integer('monthly_allocation').notNull().default(0), // Total = planCredits + subscribedCredits

  // Stripe subscription item for credits (for billing)
  stripeCreditsItemId: varchar('stripe_credits_item_id', { length: 255 }),
  stripeCreditsPriceId: varchar('stripe_credits_price_id', { length: 255 }),

  // Rollover tracking
  rolledOverCredits: integer('rolled_over_credits').notNull().default(0),
  rolloverCap: integer('rollover_cap'), // null = use plan default (2x monthly)

  // Period tracking (aligned with subscription billing cycle)
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  lastResetAt: timestamp('last_reset_at', { withTimezone: true }),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('workspace_credits_period_end_idx').on(table.periodEnd),
]);

export type WorkspaceCredits = typeof workspaceCredits.$inferSelect;
export type NewWorkspaceCredits = typeof workspaceCredits.$inferInsert;
