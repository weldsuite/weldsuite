/**
 * WeldReach routing table. Master DB.
 *
 * Mailpool webhooks and forwarded replies arrive without any WeldSuite
 * context: a webhook carries only Mailpool ids, a forwarded reply only the
 * recipient address `<token>@reply.weldsuite.org`. This table maps those
 * external identifiers back to the workspace (and the tenant row) they belong
 * to, so reach-api can open the right tenant DB.
 *
 * It also drives the daily Mailpool slot reconciliation: the active
 * `mailpool_mailbox` rows per `mailbox_type` are what WeldSuite's Mailpool
 * account should be paying slots for. See docs/plans/weldreach.md.
 */

import { pgTable, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const REACH_ROUTE_KINDS = ['mailpool_domain', 'mailpool_mailbox', 'inbound_token'] as const;
export type ReachRouteKind = (typeof REACH_ROUTE_KINDS)[number];

export const REACH_ROUTE_STATUSES = ['active', 'deleted'] as const;
export type ReachRouteStatus = (typeof REACH_ROUTE_STATUSES)[number];

export const reachRoutes = pgTable(
  'reach_routes',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // rrt_
    kind: varchar('kind', { length: 30 }).$type<ReachRouteKind>().notNull(),
    /** Mailpool domain/mailbox id, or the inbound token (local part of the forward address). */
    externalId: varchar('external_id', { length: 100 }).notNull(),
    /** Master `workspaces.id`. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    /** Clerk org id of the workspace, to open its tenant DB. */
    clerkOrgId: varchar('clerk_org_id', { length: 255 }).notNull(),
    /** `reach_domains.id` / `reach_mailboxes.id` in the tenant DB. */
    tenantEntityId: varchar('tenant_entity_id', { length: 30 }).notNull(),
    /** Mailpool mailbox type (`google` | `shared`), for mailbox routes only. */
    mailboxType: varchar('mailbox_type', { length: 20 }),
    status: varchar('status', { length: 20 }).$type<ReachRouteStatus>().notNull().default('active'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reach_routes_kind_external_idx').on(table.kind, table.externalId),
    index('reach_routes_workspace_idx').on(table.workspaceId),
    index('reach_routes_kind_status_idx').on(table.kind, table.status),
  ],
);

export type ReachRoute = typeof reachRoutes.$inferSelect;
export type NewReachRoute = typeof reachRoutes.$inferInsert;
