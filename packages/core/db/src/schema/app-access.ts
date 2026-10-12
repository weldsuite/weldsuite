/**
 * Per-workspace access to apps that are on request only. Master DB.
 *
 * An app in `app_catalog` with `requires_approval = true` (WeldReach first)
 * cannot be installed until WeldSuite staff approve the workspace. The
 * workspace owner/admin files a request from the app store (`app-api`), staff
 * approve, reject or suspend it in the admin console, and module workers check
 * the status on every request (`appAccessGate` in `@weldsuite/worker-kit`).
 *
 * One row per (workspace, app). `workspace_id` is the master `workspaces.id`,
 * as in `workspace_licences`. See docs/plans/weldreach.md.
 */

import { pgTable, varchar, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const APP_ACCESS_STATUSES = ['requested', 'approved', 'rejected', 'suspended', 'revoked'] as const;
export type AppAccessStatus = (typeof APP_ACCESS_STATUSES)[number];

export const APP_ACCESS_BILLING_STATUSES = ['none', 'active', 'past_due', 'canceled'] as const;
export type AppAccessBillingStatus = (typeof APP_ACCESS_BILLING_STATUSES)[number];

/** What the workspace told us when it asked for access. Validated with Zod in app-api. */
export interface AppAccessRequestDetails {
  companyName: string;
  website: string;
  contactName: string;
  contactEmail: string;
  useCase: string;
  expectedDailySends: number;
  /** ISO 3166-1 alpha-2 codes. */
  targetCountries: string[];
  listSource: 'own_customers' | 'own_research' | 'bought_list' | 'other';
  listSourceDetails?: string;
  /** Version of the terms text the requester ticked, e.g. "weldreach-2026-10". */
  termsVersion: string;
  /** Keys of the individual terms that were ticked. */
  termsAccepted: string[];
  termsAcceptedAt: string;
  termsAcceptedBy: string;
}

/**
 * Limits staff set on approval and can change at any time. App-specific; for
 * WeldReach see `weldReachLimitsSchema` / `resolveWeldReachLimits` in
 * `@weldsuite/app-api-client/schemas/reach`.
 */
export type AppAccessLimits = Record<string, unknown>;

export const workspaceAppAccess = pgTable(
  'workspace_app_access',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // waa_
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    appCode: varchar('app_code', { length: 50 }).notNull(),

    status: varchar('status', { length: 20 }).$type<AppAccessStatus>().notNull().default('requested'),
    request: jsonb('request').$type<AppAccessRequestDetails>(),
    limits: jsonb('limits').$type<AppAccessLimits>().notNull().default({}),

    requestedBy: varchar('requested_by', { length: 255 }),
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    reviewedBy: varchar('reviewed_by', { length: 255 }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** Internal staff notes; never shown to the workspace. */
    reviewNotes: text('review_notes'),
    /** Shown to the workspace when the request is rejected. */
    rejectionReason: text('rejection_reason'),
    /** Shown to the workspace while access is suspended. */
    suspendedReason: text('suspended_reason'),

    /**
     * The app's own Stripe subscription (WeldReach: $5 per inbox, quantity =
     * inboxes), written by billing-worker. `billing_status` follows Stripe's
     * subscription status so the module can pause work after a failed payment
     * without calling Stripe.
     */
    stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
    billingStatus: varchar('billing_status', { length: 20 }).$type<AppAccessBillingStatus>().notNull().default('none'),
    billingStatusAt: timestamp('billing_status_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('workspace_app_access_workspace_app_idx').on(table.workspaceId, table.appCode),
    index('workspace_app_access_app_status_idx').on(table.appCode, table.status),
  ],
);

export type WorkspaceAppAccess = typeof workspaceAppAccess.$inferSelect;
export type NewWorkspaceAppAccess = typeof workspaceAppAccess.$inferInsert;
