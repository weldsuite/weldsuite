/**
 * WeldForms link registries and abuse reports. Master DB.
 *
 * A respondent opens `https://forms.weldsuite.org/f/<publicId>` (a published
 * form) or `/i/<token>` (a personal invitation) without any WeldSuite session
 * or workspace in the URL. These tables map the id or token to the workspace
 * and the tenant rows, so forms-api's public mount can open the right tenant
 * DB (ADR DATA-009, FORMS-002). Only the SHA-256 of an invitation token is
 * stored. The tenant rows stay the source of truth; these only route.
 *
 * `suspended_at` (staff, after an abuse report) and `held_at` (the publish
 * content screen) stop a public form at once, without touching the tenant.
 * See weldsuite-documentation/plans/weldforms.md.
 */

import { pgTable, varchar, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const formLinkRegistry = pgTable(
  'form_link_registry',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // fln_
    publicId: varchar('public_id', { length: 20 }).notNull(),
    /** Master `workspaces.id`. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    /** Clerk org id of the workspace, to open its tenant DB. */
    clerkOrgId: varchar('clerk_org_id', { length: 255 }).notNull(),
    /** `forms.id` in the tenant DB. */
    formId: varchar('form_id', { length: 30 }).notNull(),

    /** Staff suspended the form (abuse); respondents see "no longer available". */
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendedReason: text('suspended_reason'),
    /** The publish content screen held the form for staff review. */
    heldAt: timestamp('held_at', { withTimezone: true }),
    heldReason: text('held_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('form_link_registry_public_id_idx').on(table.publicId),
    index('form_link_registry_form_idx').on(table.workspaceId, table.formId),
  ],
);

export const formInvitationRegistry = pgTable(
  'form_invitation_registry',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // fir_
    /** SHA-256 (hex) of the invitation token. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    clerkOrgId: varchar('clerk_org_id', { length: 255 }).notNull(),
    formId: varchar('form_id', { length: 30 }).notNull(),
    invitationId: varchar('invitation_id', { length: 30 }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('form_invitation_registry_token_idx').on(table.tokenHash),
    index('form_invitation_registry_invitation_idx').on(table.workspaceId, table.invitationId),
  ],
);

export const FORM_ABUSE_REPORT_STATUSES = ['open', 'dismissed', 'actioned'] as const;
export type FormAbuseReportStatus = (typeof FORM_ABUSE_REPORT_STATUSES)[number];

export const formAbuseReports = pgTable(
  'form_abuse_reports',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // fab_
    publicId: varchar('public_id', { length: 20 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    formId: varchar('form_id', { length: 30 }).notNull(),
    /** `phishing`, `spam`, `illegal`, `other`. */
    reason: varchar('reason', { length: 30 }).notNull(),
    details: text('details'),
    reporterEmail: varchar('reporter_email', { length: 320 }),
    reporterIpHash: varchar('reporter_ip_hash', { length: 64 }),
    status: varchar('status', { length: 20 }).$type<FormAbuseReportStatus>().notNull().default('open'),
    resolvedBy: varchar('resolved_by', { length: 255 }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('form_abuse_reports_status_idx').on(table.status, table.createdAt),
    index('form_abuse_reports_public_id_idx').on(table.publicId),
  ],
);

export type FormLink = typeof formLinkRegistry.$inferSelect;
export type NewFormLink = typeof formLinkRegistry.$inferInsert;
export type FormInvitationLink = typeof formInvitationRegistry.$inferSelect;
export type FormAbuseReport = typeof formAbuseReports.$inferSelect;
