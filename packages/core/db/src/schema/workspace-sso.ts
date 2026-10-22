/**
 * Enterprise single sign-on per workspace. Master DB.
 *
 * A workspace signs its members in through its own identity provider (Okta,
 * Microsoft Entra ID, Google Workspace, any SAML 2.0 IdP) with a Clerk SAML
 * connection tied to the workspace's Clerk organization. One row per
 * workspace, created by whichever side touches it first: the workspace admin
 * in Settings (app-api `/api/sso`) or staff in the admin console
 * (billing-worker `/api/internal/admin/workspaces/:id/sso/*`).
 *
 * Three independent parts:
 *  - Domain: Clerk sends every user whose email matches the connection's
 *    domain to that IdP, so a workspace must prove it owns the domain (a DNS
 *    TXT record) before a connection can be created. A verified domain belongs
 *    to one workspace (the partial unique index below).
 *  - Connection: the Clerk SAML connection. `enabled` is what the workspace
 *    admin asked for; `clerkActive` is what was last written to Clerk. Clerk's
 *    `active` is `enabled && entitled`, kept in step by app-api, the
 *    billing-worker webhooks and its hourly sweep.
 *  - Add-on billing: SSO is included in plans with `features.sso`, else it is a
 *    flat monthly add-on on its own Stripe subscription (metadata.type
 *    `weldsuite_sso`), mirrored here by billing-worker's webhooks. Staff can
 *    set a per-workspace price (`price_override_cents`, 0 = free).
 *
 * `workspace_id` is the master `workspaces.id`, as in `workspace_app_access`.
 */

import { sql } from 'drizzle-orm';
import { pgTable, varchar, text, timestamp, boolean, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';

/** Clerk's SAML IdP slugs (`SamlIdpSlug`). */
export const SSO_PROVIDERS = ['saml_okta', 'saml_microsoft', 'saml_google', 'saml_custom'] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

/**
 * The add-on subscription's state, from Stripe's subscription status:
 * active|trialing -> active, past_due -> past_due (Stripe is retrying, SSO keeps
 * working), unpaid -> unpaid (retries are over, SSO is off until the open
 * invoice is paid, which brings the subscription back to active),
 * canceled|incomplete_expired -> canceled (final for that subscription).
 */
export const SSO_SUBSCRIPTION_STATUSES = ['none', 'active', 'past_due', 'unpaid', 'canceled'] as const;
export type SsoSubscriptionStatus = (typeof SSO_SUBSCRIPTION_STATUSES)[number];

export const workspaceSso = pgTable(
  'workspace_sso',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // wsso_
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    clerkOrgId: varchar('clerk_org_id', { length: 255 }).notNull(),

    // ── Domain ownership ───────────────────────────────────────────────
    /** Lowercase, no trailing dot. Users with an email at this domain sign in through the IdP. */
    domain: varchar('domain', { length: 253 }),
    /** Expected in the `_weldsuite-sso.<domain>` TXT record. New on every domain change. */
    domainVerificationToken: varchar('domain_verification_token', { length: 64 }),
    domainVerifiedAt: timestamp('domain_verified_at', { withTimezone: true }),

    // ── Clerk SAML connection ──────────────────────────────────────────
    clerkConnectionId: varchar('clerk_connection_id', { length: 64 }),
    provider: varchar('provider', { length: 30 }).$type<SsoProvider>(),
    /** The workspace admin switched SSO on. */
    enabled: boolean('enabled').notNull().default(false),
    /** What was last written to the Clerk connection's `active`. */
    clerkActive: boolean('clerk_active').notNull().default(false),
    /** Service provider details from Clerk, for the IdP setup. Fixed per connection. */
    acsUrl: text('acs_url'),
    spEntityId: text('sp_entity_id'),
    spMetadataUrl: text('sp_metadata_url'),
    /** Last change to the connection (domain, IdP, on/off), for support. */
    connectionUpdatedBy: varchar('connection_updated_by', { length: 255 }),
    connectionUpdatedAt: timestamp('connection_updated_at', { withTimezone: true }),

    // ── Add-on price set by staff ──────────────────────────────────────
    /** Monthly price in minor units. null = the list price; 0 = free. */
    priceOverrideCents: integer('price_override_cents'),
    /** `eur` or `usd`; set with a non-zero override. */
    priceOverrideCurrency: varchar('price_override_currency', { length: 3 }),
    priceOverrideSetBy: varchar('price_override_set_by', { length: 255 }),
    priceOverrideSetAt: timestamp('price_override_set_at', { withTimezone: true }),
    priceOverrideReason: text('price_override_reason'),

    // ── Add-on subscription (written by billing-worker webhooks) ───────
    stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
    subscriptionStatus: varchar('subscription_status', { length: 20 })
      .$type<SsoSubscriptionStatus>()
      .notNull()
      .default('none'),
    subscriptionStatusAt: timestamp('subscription_status_at', { withTimezone: true }),
    subscriptionCurrentPeriodEnd: timestamp('subscription_current_period_end', { withTimezone: true }),
    subscriptionCancelAtPeriodEnd: boolean('subscription_cancel_at_period_end').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('workspace_sso_workspace_idx').on(table.workspaceId),
    // A verified domain belongs to one workspace; unverified claims may overlap.
    uniqueIndex('workspace_sso_verified_domain_idx').on(table.domain).where(sql`${table.domainVerifiedAt} is not null`),
    index('workspace_sso_clerk_org_idx').on(table.clerkOrgId),
    index('workspace_sso_subscription_idx').on(table.stripeSubscriptionId),
  ],
);

export type WorkspaceSso = typeof workspaceSso.$inferSelect;
export type NewWorkspaceSso = typeof workspaceSso.$inferInsert;
