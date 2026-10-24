/**
 * WeldSign signing-link registry. Master DB.
 *
 * A signer opens `https://sign.weldsuite.org/r/<token>` without any WeldSuite
 * session or workspace in the URL. This table maps the token to the workspace
 * and the tenant rows it belongs to, so sign-api's public portal mount can open
 * the right tenant DB. Only the SHA-256 of the token is stored.
 *
 * The tenant `sign_recipients` row stays the source of truth; this table only
 * routes. Voiding, expiry, a corrected recipient email and completion set
 * `revoked_at`, which stops the link at once. See docs/plans/weldsign.md.
 */

import { pgTable, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const signLinkRegistry = pgTable(
  'sign_link_registry',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // sgl_
    /** SHA-256 (hex) of the link token. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** Master `workspaces.id`. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    /** Clerk org id of the workspace, to open its tenant DB. */
    clerkOrgId: varchar('clerk_org_id', { length: 255 }).notNull(),
    /** `sign_envelopes.id` / `sign_recipients.id` in the tenant DB. */
    envelopeId: varchar('envelope_id', { length: 30 }).notNull(),
    recipientId: varchar('recipient_id', { length: 30 }).notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sign_link_registry_token_idx').on(table.tokenHash),
    /** Revoke every link of an envelope (void, expiry, completion). */
    index('sign_link_registry_envelope_idx').on(table.workspaceId, table.envelopeId),
  ],
);

export type SignLink = typeof signLinkRegistry.$inferSelect;
export type NewSignLink = typeof signLinkRegistry.$inferInsert;
