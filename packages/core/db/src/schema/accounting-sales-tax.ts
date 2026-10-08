import {
  pgTable,
  varchar,
  timestamp,
  date,
  integer,
  boolean,
  numeric,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * US sales tax agencies: one row per state (or self-administered local
 * agency, such as a Colorado home-rule city) the entity is registered with or
 * monitors. Registering creates a child liability account under Sales Tax
 * Payable, so the balance sheet shows what is owed per agency.
 */
export const salesTaxAgencies = pgTable('sales_tax_agencies', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  /** USPS state code (TX, WA, ...). */
  stateCode: varchar('state_code', { length: 2 }).notNull(),
  /** state | local */
  level: varchar('level', { length: 10 }).notNull().default('state'),
  /** For local agencies: the jurisdiction code (FIPS place code or the state's own). */
  localJurisdictionCode: varchar('local_jurisdiction_code', { length: 30 }),
  name: varchar('name', { length: 255 }).notNull(),
  registrationNumber: varchar('registration_number', { length: 100 }),
  registeredFrom: date('registered_from'),
  registeredUntil: date('registered_until'),
  /** registered | pending | monitoring | closed. Tax is only charged while registered. */
  status: varchar('status', { length: 15 }).notNull().default('registered'),
  /** monthly | quarterly | semiannual | annual */
  filingFrequency: varchar('filing_frequency', { length: 15 }).notNull().default('quarterly'),
  firstPeriodStart: date('first_period_start'),
  /** Day of the month after the period the return is due. */
  dueDay: integer('due_day').notNull().default(20),
  /** accrual | cash (only where the state allows cash-basis reporting). */
  reportingBasis: varchar('reporting_basis', { length: 10 }).notNull().default('accrual'),
  sstMember: boolean('sst_member').notNull().default(false),
  /** Child account of Sales Tax Payable for this agency. */
  liabilityAccountId: varchar('liability_account_id', { length: 30 }),
  /** Child account of Use Tax Payable for this agency. */
  useTaxAccountId: varchar('use_tax_account_id', { length: 30 }),
  portalUrl: varchar('portal_url', { length: 500 }),
  /** The matching registration at a provider engine (e.g. Stripe Tax registration id). */
  providerRegistrationRef: varchar('provider_registration_ref', { length: 255 }),
  notes: text('notes'),
}, (table) => [
  index('acct_st_agencies_entity_idx').on(table.entityId),
  index('acct_st_agencies_state_idx').on(table.entityId, table.stateCode),
  index('acct_st_agencies_status_idx').on(table.status),
]);

/**
 * Manual engine: a taxing jurisdiction (state, county, city or special
 * district) the user maintains, with dated rates in
 * `sales_tax_jurisdiction_rates`.
 */
export const salesTaxJurisdictions = pgTable('sales_tax_jurisdictions', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  agencyId: varchar('agency_id', { length: 30 }).notNull(),
  stateCode: varchar('state_code', { length: 2 }).notNull(),
  /** state | county | city | district */
  level: varchar('level', { length: 10 }).notNull(),
  /** FIPS / SST code where available. */
  code: varchar('code', { length: 30 }),
  name: varchar('name', { length: 255 }).notNull(),
  /** The location code the state's return asks for (e.g. Washington's location code). */
  reportingCode: varchar('reporting_code', { length: 30 }),
  isActive: boolean('is_active').notNull().default(true),
}, (table) => [
  index('acct_st_jurisdictions_entity_idx').on(table.entityId),
  index('acct_st_jurisdictions_agency_idx').on(table.agencyId),
]);

/** A jurisdiction's rate over a date range; picked by the document's tax point. */
export const salesTaxJurisdictionRates = pgTable('sales_tax_jurisdiction_rates', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  jurisdictionId: varchar('jurisdiction_id', { length: 30 }).notNull(),
  rate: numeric('rate', { precision: 7, scale: 4 }).notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
}, (table) => [
  index('acct_st_rates_jurisdiction_idx').on(table.jurisdictionId, table.effectiveFrom),
]);

/**
 * Manual engine: a set of jurisdictions that apply together, matched on the
 * ship-to ZIP code (or the entity's own location for origin-sourced sales).
 */
export const salesTaxZones = pgTable('sales_tax_zones', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  agencyId: varchar('agency_id', { length: 30 }).notNull(),
  stateCode: varchar('state_code', { length: 2 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  jurisdictionIds: jsonb('jurisdiction_ids').$type<string[]>().notNull(),
  /** Five-digit ZIPs and inclusive ranges this zone covers. */
  postalCodes: jsonb('postal_codes').$type<Array<string | { from: string; to: string }>>(),
  /** The zone for the entity's own location (origin-sourced sales). */
  isOrigin: boolean('is_origin').notNull().default(false),
  /** Lower wins when two zones cover the same ZIP. */
  priority: integer('priority').notNull().default(100),
}, (table) => [
  index('acct_st_zones_entity_idx').on(table.entityId),
  index('acct_st_zones_agency_idx').on(table.agencyId),
]);

/**
 * Manual engine: whether a WeldBooks tax code is taxable at an agency, from
 * when, on what share of the price and (optionally) at a different rate.
 * No rule = taxable at 100% (the general rule in every sales tax state).
 */
export const salesTaxTaxabilityRules = pgTable('sales_tax_taxability_rules', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  agencyId: varchar('agency_id', { length: 30 }).notNull(),
  taxCode: varchar('tax_code', { length: 30 }).notNull(),
  taxable: boolean('taxable').notNull().default(true),
  /** Share of the price that is taxable (Texas SaaS: 80). */
  taxablePercent: numeric('taxable_percent', { precision: 7, scale: 4 }).notNull().default('100'),
  /** any | business | personal */
  appliesToUse: varchar('applies_to_use', { length: 10 }).notNull().default('any'),
  /** Replaces the combined rate for this code (Maryland SaaS for business use: 3). */
  rateOverride: numeric('rate_override', { precision: 7, scale: 4 }),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  notes: text('notes'),
}, (table) => [
  index('acct_st_taxability_agency_idx').on(table.agencyId, table.taxCode),
]);

export type SalesTaxAgency = typeof salesTaxAgencies.$inferSelect;
export type NewSalesTaxAgency = typeof salesTaxAgencies.$inferInsert;
export type SalesTaxJurisdiction = typeof salesTaxJurisdictions.$inferSelect;
export type NewSalesTaxJurisdiction = typeof salesTaxJurisdictions.$inferInsert;
export type SalesTaxJurisdictionRate = typeof salesTaxJurisdictionRates.$inferSelect;
export type NewSalesTaxJurisdictionRate = typeof salesTaxJurisdictionRates.$inferInsert;
export type SalesTaxZone = typeof salesTaxZones.$inferSelect;
export type NewSalesTaxZone = typeof salesTaxZones.$inferInsert;
export type SalesTaxTaxabilityRule = typeof salesTaxTaxabilityRules.$inferSelect;
export type NewSalesTaxTaxabilityRule = typeof salesTaxTaxabilityRules.$inferInsert;
