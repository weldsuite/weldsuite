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
// RESELLER LICENSING — PARTNER-MANAGED WORKSPACES (MASTER DATABASE)
//
// A partner (reseller) creates workspaces for its own customers, licenses each
// one (apps, monthly credits, seats) and bills its customers itself at a price
// it records here. WeldSuite bills the partner monthly:
//
//   due = max(resale × revenue_share, floor) + extra credits granted
//   floor = base_minimum + max(0, licensed_credits − included_credits) × credit_floor_price
//
// Plan: docs/plans/reseller-licensing.md. Master DB because the partner portal
// reads across many workspaces and the licence joins the cached workspace
// context every API worker already loads.
//
// Money columns are `numeric` in the contract currency (USD), never floats.
// ============================================================================

export const PARTNER_STATUSES = ['active', 'past_due', 'suspended'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export const PARTNER_MEMBER_ROLES = ['owner', 'admin', 'billing', 'viewer'] as const;
export type PartnerMemberRole = (typeof PARTNER_MEMBER_ROLES)[number];

export const WORKSPACE_LICENCE_STATUSES = ['active', 'suspended', 'ended'] as const;
export type WorkspaceLicenceStatus = (typeof WORKSPACE_LICENCE_STATUSES)[number];

export const PARTNER_STATEMENT_STATUSES = ['draft', 'final', 'invoiced', 'paid', 'void'] as const;
export type PartnerStatementStatus = (typeof PARTNER_STATEMENT_STATUSES)[number];

export const PARTNER_REQUEST_STATUSES = ['new', 'contacted', 'provisioned', 'declined'] as const;
export type PartnerRequestStatus = (typeof PARTNER_REQUEST_STATUSES)[number];

/** What the partner charges its customer for one workspace, per month. */
export type ResalePricing =
  | { model: 'flat'; amount: string }
  | { model: 'per_seat'; amount: string; minSeats?: number };

// ---------------------------------------------------------------------------
// Partners
// ---------------------------------------------------------------------------

export const partners = pgTable('partners', {
  id: varchar('id', { length: 30 }).primaryKey(), // ptr_
  name: varchar('name', { length: 255 }).notNull(),
  legalName: varchar('legal_name', { length: 255 }),
  country: varchar('country', { length: 2 }),
  taxId: varchar('tax_id', { length: 100 }),

  billingEmail: varchar('billing_email', { length: 255 }).notNull(),
  /** Shown to the partner's customers ("managed by", territory screen). */
  supportEmail: varchar('support_email', { length: 255 }),
  supportUrl: varchar('support_url', { length: 500 }),
  websiteUrl: varchar('website_url', { length: 500 }),
  logoUrl: varchar('logo_url', { length: 500 }),

  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),

  /** Payment standing; `suspended` makes every partner workspace read-only. */
  status: varchar('status', { length: 20 }).$type<PartnerStatus>().notNull().default('active'),
  statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
  /** Staff override: the dunning clock does not advance before this. */
  dunningPausedUntil: timestamp('dunning_paused_until', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('partners_status_idx').on(table.status),
]);

export type Partner = typeof partners.$inferSelect;
export type NewPartner = typeof partners.$inferInsert;

/**
 * Portal users. Invited by email; `userId` (Clerk user id) is filled in when
 * the invitee first opens the portal signed in with that email.
 */
export const partnerMembers = pgTable('partner_members', {
  id: varchar('id', { length: 30 }).primaryKey(), // ptm_
  partnerId: varchar('partner_id', { length: 30 }).notNull().references(() => partners.id, { onDelete: 'cascade' }),
  userId: varchar('user_id', { length: 255 }),
  email: varchar('email', { length: 255 }).notNull(),
  role: varchar('role', { length: 20 }).$type<PartnerMemberRole>().notNull().default('viewer'),
  invitedBy: varchar('invited_by', { length: 255 }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('partner_members_partner_email_uidx').on(table.partnerId, table.email),
  index('partner_members_user_idx').on(table.userId),
  index('partner_members_email_idx').on(table.email),
]);

export type PartnerMember = typeof partnerMembers.$inferSelect;
export type NewPartnerMember = typeof partnerMembers.$inferInsert;

/** Commercial terms, effective-dated: a change is a new row, never an edit. */
export const partnerContracts = pgTable('partner_contracts', {
  id: varchar('id', { length: 30 }).primaryKey(), // ptc_
  partnerId: varchar('partner_id', { length: 30 }).notNull().references(() => partners.id, { onDelete: 'cascade' }),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  effectiveTo: timestamp('effective_to', { withTimezone: true }),

  currency: varchar('currency', { length: 3 }).notNull().default('USD'),
  /** WeldSuite's share of the resale price, in basis points (7500 = 75%). */
  revenueShareBps: integer('revenue_share_bps').notNull().default(7500),
  /** Per workspace per month. */
  baseMinimum: numeric('base_minimum', { precision: 12, scale: 2 }).notNull().default('0'),
  /** Monthly credits covered by the base minimum. */
  includedCredits: integer('included_credits').notNull().default(0),
  /** Floor price per licensed credit above `includedCredits`. */
  creditFloorPrice: numeric('credit_floor_price', { precision: 12, scale: 6 }).notNull().default('0'),
  /** Price per credit for extra credits a partner grants mid-month. */
  extraCreditPrice: numeric('extra_credit_price', { precision: 12, scale: 6 }).notNull().default('0'),
  /** `plans.id` values a licence may use for feature limits. */
  allowedFeaturePlanIds: jsonb('allowed_feature_plan_ids').$type<string[]>().notNull().default([]),

  paymentTermsDays: integer('payment_terms_days').notNull().default(30),
  pastDueAfterDays: integer('past_due_after_days').notNull().default(14),
  readOnlyAfterDays: integer('read_only_after_days').notNull().default(30),

  notes: text('notes'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('partner_contracts_partner_idx').on(table.partnerId, table.effectiveFrom),
]);

export type PartnerContract = typeof partnerContracts.$inferSelect;
export type NewPartnerContract = typeof partnerContracts.$inferInsert;

/**
 * Countries a partner serves. The country is the primary key, so one country
 * can never belong to two partners. Workspace creation from these countries is
 * pointed to the partner, and direct checkout is closed for them.
 */
export const partnerTerritories = pgTable('partner_territories', {
  countryCode: varchar('country_code', { length: 2 }).primaryKey(),
  partnerId: varchar('partner_id', { length: 30 }).notNull().references(() => partners.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('partner_territories_partner_idx').on(table.partnerId),
]);

export type PartnerTerritory = typeof partnerTerritories.$inferSelect;
export type NewPartnerTerritory = typeof partnerTerritories.$inferInsert;

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

/** Reusable licence template a partner defines ("Service desk: WeldDesk + WeldCRM"). */
export const partnerLicencePackages = pgTable('partner_licence_packages', {
  id: varchar('id', { length: 30 }).primaryKey(), // plp_
  partnerId: varchar('partner_id', { length: 30 }).notNull().references(() => partners.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  allowedApps: jsonb('allowed_apps').$type<string[]>().notNull().default([]),
  monthlyCredits: integer('monthly_credits').notNull().default(0),
  maxSeats: integer('max_seats'),
  featurePlanId: varchar('feature_plan_id', { length: 30 }),
  storageGb: integer('storage_gb'),
  defaultResalePricing: jsonb('default_resale_pricing').$type<ResalePricing>().notNull(),
  isArchived: boolean('is_archived').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('partner_licence_packages_partner_idx').on(table.partnerId),
]);

export type PartnerLicencePackage = typeof partnerLicencePackages.$inferSelect;
export type NewPartnerLicencePackage = typeof partnerLicencePackages.$inferInsert;

/** What one managed workspace may use and what the partner charges for it. */
export const workspaceLicences = pgTable('workspace_licences', {
  id: varchar('id', { length: 30 }).primaryKey(), // wsl_
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().unique(),
  partnerId: varchar('partner_id', { length: 30 }).notNull().references(() => partners.id),
  packageId: varchar('package_id', { length: 30 }),

  /** App codes (PERMISSION_APPS codes). Enforced by the API licence gate. */
  allowedApps: jsonb('allowed_apps').$type<string[]>().notNull().default([]),
  monthlyCredits: integer('monthly_credits').notNull().default(0),
  /** Unused credits kept at a reset, capped at this. 0 = no rollover. */
  creditRolloverCap: integer('credit_rollover_cap').notNull().default(0),
  /** Seat cap; null = unlimited (and, on per-seat pricing, every seat billed). */
  maxSeats: integer('max_seats'),
  /** `plans.id` supplying feature limits; copied onto `workspaces.plan_id`. */
  featurePlanId: varchar('feature_plan_id', { length: 30 }),
  /** Recorded now, not enforced yet. */
  storageGb: integer('storage_gb'),
  resalePricing: jsonb('resale_pricing').$type<ResalePricing>().notNull(),

  status: varchar('status', { length: 20 }).$type<WorkspaceLicenceStatus>().notNull().default('active'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp('ends_at', { withTimezone: true }),

  updatedBy: varchar('updated_by', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('workspace_licences_partner_idx').on(table.partnerId),
]);

export type WorkspaceLicence = typeof workspaceLicences.$inferSelect;
export type NewWorkspaceLicence = typeof workspaceLicences.$inferInsert;

/** The licence fields a statement needs to price one day. */
export interface WorkspaceLicenceSnapshot {
  status: WorkspaceLicenceStatus;
  allowedApps: string[];
  monthlyCredits: number;
  creditRolloverCap: number;
  maxSeats: number | null;
  featurePlanId: string | null;
  storageGb: number | null;
  resalePricing: ResalePricing;
  packageId: string | null;
}

/**
 * Append-only history: a full snapshot after every change. Statements prorate
 * by day from this table, and it is the audit trail for recorded prices.
 */
export const workspaceLicenceChanges = pgTable('workspace_licence_changes', {
  id: varchar('id', { length: 30 }).primaryKey(), // wlc_
  workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
  partnerId: varchar('partner_id', { length: 30 }).notNull(),
  snapshot: jsonb('snapshot').$type<WorkspaceLicenceSnapshot>().notNull(),
  changedBy: varchar('changed_by', { length: 255 }),
  /** `partner` (portal), `admin` (WeldSuite staff) or `system` (sweeps). */
  changedByType: varchar('changed_by_type', { length: 20 }).notNull(),
  reason: text('reason'),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('workspace_licence_changes_ws_idx').on(table.workspaceId, table.changedAt),
  index('workspace_licence_changes_partner_idx').on(table.partnerId, table.changedAt),
]);

export type WorkspaceLicenceChange = typeof workspaceLicenceChanges.$inferSelect;
export type NewWorkspaceLicenceChange = typeof workspaceLicenceChanges.$inferInsert;

/** Daily active-member count; the monthly peak is the billable seat count. */
export const workspaceSeatSnapshots = pgTable('workspace_seat_snapshots', {
  id: varchar('id', { length: 30 }).primaryKey(), // wss_
  workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
  /** `YYYY-MM-DD` (UTC). */
  date: varchar('date', { length: 10 }).notNull(),
  activeMembers: integer('active_members').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('workspace_seat_snapshots_ws_date_uidx').on(table.workspaceId, table.date),
]);

export type WorkspaceSeatSnapshot = typeof workspaceSeatSnapshots.$inferSelect;
export type NewWorkspaceSeatSnapshot = typeof workspaceSeatSnapshots.$inferInsert;

/** Extra credits a partner granted mid-month; billed on that month's statement. */
export const partnerCreditGrants = pgTable('partner_credit_grants', {
  id: varchar('id', { length: 30 }).primaryKey(), // pcg_
  partnerId: varchar('partner_id', { length: 30 }).notNull().references(() => partners.id),
  workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
  credits: integer('credits').notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 6 }).notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  creditTransactionId: varchar('credit_transaction_id', { length: 30 }),
  grantedBy: varchar('granted_by', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('partner_credit_grants_partner_idx').on(table.partnerId, table.createdAt),
]);

export type PartnerCreditGrant = typeof partnerCreditGrants.$inferSelect;
export type NewPartnerCreditGrant = typeof partnerCreditGrants.$inferInsert;

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * What a partner owes for one calendar month (UTC). Also tracks the Stripe
 * invoice sent for it: partner invoices are not in `billing_invoices`, which
 * is keyed by workspace.
 */
export const partnerStatements = pgTable('partner_statements', {
  id: varchar('id', { length: 30 }).primaryKey(), // pst_
  partnerId: varchar('partner_id', { length: 30 }).notNull().references(() => partners.id),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  status: varchar('status', { length: 20 }).$type<PartnerStatementStatus>().notNull().default('draft'),

  totalResale: numeric('total_resale', { precision: 12, scale: 2 }).notNull().default('0'),
  totalDue: numeric('total_due', { precision: 12, scale: 2 }).notNull().default('0'),
  totalMargin: numeric('total_margin', { precision: 12, scale: 2 }).notNull().default('0'),

  stripeInvoiceId: varchar('stripe_invoice_id', { length: 255 }).unique(),
  stripeInvoiceUrl: text('stripe_invoice_url'),
  stripeInvoicePdf: text('stripe_invoice_pdf'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),

  /** The contract terms the statement was priced with. */
  contractSnapshot: jsonb('contract_snapshot').$type<Record<string, unknown>>().notNull(),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('partner_statements_partner_period_uidx').on(table.partnerId, table.periodStart),
  index('partner_statements_status_idx').on(table.status),
]);

export type PartnerStatement = typeof partnerStatements.$inferSelect;
export type NewPartnerStatement = typeof partnerStatements.$inferInsert;

export const partnerStatementLines = pgTable('partner_statement_lines', {
  id: varchar('id', { length: 30 }).primaryKey(), // psl_
  statementId: varchar('statement_id', { length: 30 }).notNull().references(() => partnerStatements.id, { onDelete: 'cascade' }),
  workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
  workspaceName: varchar('workspace_name', { length: 255 }).notNull(),
  daysActive: integer('days_active').notNull(),
  daysInPeriod: integer('days_in_period').notNull(),
  seatsBilled: integer('seats_billed').notNull().default(0),
  resale: numeric('resale', { precision: 12, scale: 2 }).notNull(),
  shareAmount: numeric('share_amount', { precision: 12, scale: 2 }).notNull(),
  floorAmount: numeric('floor_amount', { precision: 12, scale: 2 }).notNull(),
  creditFloorAmount: numeric('credit_floor_amount', { precision: 12, scale: 2 }).notNull(),
  extraCreditsAmount: numeric('extra_credits_amount', { precision: 12, scale: 2 }).notNull().default('0'),
  due: numeric('due', { precision: 12, scale: 2 }).notNull(),
  margin: numeric('margin', { precision: 12, scale: 2 }).notNull(),
  /** Per-segment breakdown (licence in force, days, amounts). */
  breakdown: jsonb('breakdown').$type<Record<string, unknown>[]>().notNull().default([]),
}, (table) => [
  index('partner_statement_lines_statement_idx').on(table.statementId),
]);

export type PartnerStatementLine = typeof partnerStatementLines.$inferSelect;
export type NewPartnerStatementLine = typeof partnerStatementLines.$inferInsert;

// ---------------------------------------------------------------------------
// Territory requests
// ---------------------------------------------------------------------------

/** A workspace request from someone signing up in a partner's territory. */
export const partnerWorkspaceRequests = pgTable('partner_workspace_requests', {
  id: varchar('id', { length: 30 }).primaryKey(), // pwr_
  partnerId: varchar('partner_id', { length: 30 }).notNull().references(() => partners.id, { onDelete: 'cascade' }),
  requesterUserId: varchar('requester_user_id', { length: 255 }),
  requesterEmail: varchar('requester_email', { length: 255 }).notNull(),
  requesterName: varchar('requester_name', { length: 255 }),
  companyName: varchar('company_name', { length: 255 }).notNull(),
  countryCode: varchar('country_code', { length: 2 }).notNull(),
  selectedApps: jsonb('selected_apps').$type<string[]>().notNull().default([]),
  message: text('message'),
  status: varchar('status', { length: 20 }).$type<PartnerRequestStatus>().notNull().default('new'),
  workspaceId: varchar('workspace_id', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('partner_workspace_requests_partner_idx').on(table.partnerId, table.status),
]);

export type PartnerWorkspaceRequest = typeof partnerWorkspaceRequests.$inferSelect;
export type NewPartnerWorkspaceRequest = typeof partnerWorkspaceRequests.$inferInsert;
