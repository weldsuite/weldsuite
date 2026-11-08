/**
 * Legal entities: the companies of a workspace, owned by the core platform
 * and shared by WeldBooks, WeldHR and later apps (ADR BOOKS-008,
 * docs/plans/legal-entities.md).
 *
 * The physical tables keep their old names (`entities`, `bank_accounts`) so
 * every `entity_id` in WeldBooks stays valid. Facts true for every app live
 * here; how one app works with the company is that app's extension table
 * (`accounting_entity_settings`, `hr_payroll_employers`, ...).
 *
 * Release 1 is additive: the columns that move to an extension or to
 * `legal_entity_registrations` stay on these tables, and every write is
 * mirrored to both until release 2 drops them. They are marked
 * `@deprecated` below.
 */

import { sql } from 'drizzle-orm';
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
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { StoredPostalAddress } from './accounting-address';

/** Address of a legal entity: the shared postal address plus the Dutch house number split the loonaangifte needs. */
export type LegalEntityAddress = StoredPostalAddress & {
  houseNumberAddition?: string;
};

export interface LegalEntityContact {
  email?: string;
  phone?: string;
  website?: string;
  contactPerson?: { firstName?: string; lastName?: string };
}

export const legalEntities = pgTable('entities', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  /** Display name. */
  name: varchar('name', { length: 255 }).notNull(),
  legalName: varchar('legal_name', { length: 255 }),
  /** Legal form, from the per-country catalog (NL bv, nv, eenmanszaak; US llc, c_corp, ...). */
  entityType: varchar('entity_type', { length: 20 }),
  /** Country of registration (ISO-2; `US-CA` style codes are not used here). */
  jurisdictionCode: varchar('jurisdiction_code', { length: 5 }).notNull(),
  baseCurrency: varchar('base_currency', { length: 3 }).notNull().default('EUR'),
  locale: varchar('locale', { length: 10 }).notNull().default('nl-NL'),
  timezone: varchar('timezone', { length: 50 }).default('Europe/Amsterdam'),

  /** @deprecated release 2: moved to `legal_entity_registrations`. Still written (mirror). */
  taxIdentifiers: jsonb('tax_identifiers').$type<{
    vatNumber?: string;
    registrationNumber?: string;
    einOrSsn?: string;
    other?: Record<string, string>;
  }>(),

  address: jsonb('address').$type<LegalEntityAddress>(),

  contact: jsonb('contact').$type<LegalEntityContact>(),

  /** @deprecated release 2: a core `bank_accounts` row, referenced by `accounting_entity_settings.invoice_bank_account_id`. */
  bankDetails: jsonb('bank_details').$type<{
    iban?: string;
    bic?: string;
    accountNumber?: string;
    routingNumber?: string;
    bankName?: string;
  }>(),

  /**
   * `logoUrl`, `primaryColor`, `accentColor` are core. The document texts
   * (`footerText`, `paymentInstructions`, `termsAndConditions`) are
   * @deprecated here: they moved to `accounting_entity_settings.document_texts`.
   */
  branding: jsonb('branding').$type<{
    logoUrl?: string;
    primaryColor?: string;
    accentColor?: string;
    footerText?: string;
    paymentInstructions?: string;
    termsAndConditions?: string;
  }>(),

  /** @deprecated release 2: moved to `accounting_entity_settings`. */
  jurisdictionSettings: jsonb('jurisdiction_settings').$type<Record<string, unknown>>(),

  fiscalYearStart: integer('fiscal_year_start').default(1),

  /**
   * @deprecated release 2: the lock dates moved to `accounting_entity_settings`.
   * Postings dated on or before a lock date are refused. sales = invoices and
   * credit notes; purchase = bills; tax = anything that carries tax (set when
   * a tax return is filed); period = everything. Each of these can be
   * bypassed by a logged `lock_date_exceptions` row. The hard lock has no
   * exceptions and can only move forward.
   */
  salesLockDate: date('sales_lock_date'),
  /** @deprecated release 2: moved to `accounting_entity_settings`. */
  purchaseLockDate: date('purchase_lock_date'),
  /** @deprecated release 2: moved to `accounting_entity_settings`. */
  taxLockDate: date('tax_lock_date'),
  /** @deprecated release 2: moved to `accounting_entity_settings`. */
  periodLockDate: date('period_lock_date'),
  /** @deprecated release 2: moved to `accounting_entity_settings`. */
  hardLockDate: date('hard_lock_date'),

  /** Doing-business-as (trading) name, printed with the legal name. */
  dba: varchar('dba', { length: 255 }),
  /**
   * How the IRS taxes the entity: sole_proprietor | disregarded | partnership |
   * s_corp | c_corp | exempt. Picks the income-tax line catalog (Schedule C,
   * 1065, 1120-S, 1120, 990).
   */
  taxClassification: varchar('tax_classification', { length: 20 }),
  /** @deprecated release 2: moved to `accounting_entity_settings`. Default report basis: accrual | cash. */
  accountingMethod: varchar('accounting_method', { length: 10 }),
  /** @deprecated release 2: moved to `accounting_entity_settings`. US sales tax engine: manual | stripe_tax | avalara. */
  salesTaxEngine: varchar('sales_tax_engine', { length: 30 }),
  /** @deprecated release 2: moved to `accounting_entity_settings`. */
  salesTaxEngineConfig: jsonb('sales_tax_engine_config').$type<Record<string, unknown>>(),
  /** @deprecated release 2: moved to `accounting_entity_settings`. AES-GCM blob, never returned. */
  salesTaxCredentialsEncrypted: text('sales_tax_credentials_encrypted'),
  /** @deprecated release 2: moved to `accounting_entity_settings`. Brazil: Focus NFe token, sealed. */
  fiscalCredentialsEncrypted: text('fiscal_credentials_encrypted'),
  /** @deprecated release 2: moved to `accounting_entity_settings`. AES-GCM blob of the owner's SSN. */
  ssnEncrypted: text('ssn_encrypted'),
  /** @deprecated release 2: moved to `accounting_entity_settings`. */
  ssnLast4: varchar('ssn_last4', { length: 4 }),
  /**
   * 52–53-week fiscal year: the year ends on the last (or nearest to the end
   * of the month) given weekday of `endMonth`. Null = month-based year from
   * `fiscalYearStart`.
   */
  fiscalYearConfig: jsonb('fiscal_year_config').$type<{
    type: 'fifty_two_fifty_three';
    endMonth: number;
    /** 0 = Sunday … 6 = Saturday */
    weekday: number;
    rule: 'last' | 'nearest';
  }>(),

  /** The workspace's default legal entity (Settings → Business edits it). At most one. */
  isDefault: boolean('is_default').default(false),
  /** False = archived: hidden from pickers, no new postings or pay runs. */
  isActive: boolean('is_active').default(true),

  /**
   * Per-entity access: when true only members listed in
   * `legal_entity_members` (plus owners and `legal_entities:manage`) see the
   * entity. False = everyone who has the app sees it with their workspace role.
   */
  accessRestricted: boolean('access_restricted').notNull().default(false),
}, (table) => [
  index('entities_jurisdiction_idx').on(table.jurisdictionCode),
  index('entities_is_default_idx').on(table.isDefault),
  index('entities_is_active_idx').on(table.isActive),
  uniqueIndex('entities_single_default_uidx')
    .on(table.isDefault)
    .where(sql`${table.isDefault} = true AND ${table.deletedAt} IS NULL`),
]);

/** @deprecated use `legalEntities`; kept so existing WeldBooks imports compile. */
export const entities = legalEntities;

export type LegalEntity = typeof legalEntities.$inferSelect;
export type NewLegalEntity = typeof legalEntities.$inferInsert;
/** @deprecated use `LegalEntity`. */
export type Entity = LegalEntity;
/** @deprecated use `NewLegalEntity`. */
export type NewEntity = NewLegalEntity;

/**
 * Every number an authority gave the company. Types in v1: vat,
 * company_registration (KvK, Companies House, CIN), rsin, ein, gstin, pan,
 * eori, nl_payroll_tax (loonheffingennummer, several per entity: L01, L02),
 * us_state_withholding, us_state_unemployment, other.
 */
export const legalEntityRegistrations = pgTable('legal_entity_registrations', {
  id: varchar('id', { length: 30 }).primaryKey(),
  entityId: varchar('entity_id', { length: 30 }).notNull(),
  type: varchar('type', { length: 40 }).notNull(),
  /** ISO-2 country of the authority. */
  country: varchar('country', { length: 2 }),
  /** US state or IN state code, for state-level registrations. */
  region: varchar('region', { length: 10 }),
  number: varchar('number', { length: 64 }).notNull(),
  /** Free label, e.g. "L01 DGA". */
  label: varchar('label', { length: 120 }),
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
  isPrimary: boolean('is_primary').notNull().default(false),
  verifiedAt: timestamp('verified_at'),
  /** Verification result, e.g. a VIES answer. */
  verification: jsonb('verification').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('legal_entity_registrations_entity_type_idx').on(table.entityId, table.type),
]);

export type LegalEntityRegistration = typeof legalEntityRegistrations.$inferSelect;
export type NewLegalEntityRegistration = typeof legalEntityRegistrations.$inferInsert;

/**
 * Per-entity access (docs/plans/legal-entities.md, "Per-entity access"). A row
 * makes the entity visible to the member when it is restricted, and lets the
 * member act with `role_id` instead of their workspace role inside it.
 */
export const legalEntityMembers = pgTable('legal_entity_members', {
  id: varchar('id', { length: 30 }).primaryKey(),
  entityId: varchar('entity_id', { length: 30 }).notNull(),
  /** Clerk user id, as on `workspace_members.user_id`. */
  userId: varchar('user_id', { length: 255 }).notNull(),
  /** A `roles` row (system Admin/Member/Viewer or custom; never Owner). Null = their workspace role. */
  roleId: varchar('role_id', { length: 30 }),
  grantedBy: varchar('granted_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('legal_entity_members_entity_user_uidx').on(table.entityId, table.userId),
  index('legal_entity_members_user_idx').on(table.userId),
]);

export type LegalEntityMember = typeof legalEntityMembers.$inferSelect;
export type NewLegalEntityMember = typeof legalEntityMembers.$inferInsert;

/**
 * Core bank accounts of a legal entity, shared by WeldBooks and WeldHR. The
 * WeldBooks columns (ledger link, balances, feeds, checks, import settings)
 * are @deprecated here: they moved to `accounting_bank_account_settings`
 * and are mirrored until release 2. A core account without that row is not
 * in WeldBooks (e.g. an HR-only salary account). Reveals of the full account
 * number are logged in `tax_id_reveals` (subject `bank_account`), the same
 * log WeldBooks already writes.
 */
export const bankAccounts = pgTable('bank_accounts', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  iban: varchar('iban', { length: 34 }),
  bic: varchar('bic', { length: 11 }),
  bankName: varchar('bank_name', { length: 255 }),
  accountHolderName: varchar('account_holder_name', { length: 255 }),
  currency: varchar('currency', { length: 3 }).default('EUR'),
  /** @deprecated release 2: WeldBooks, see `accounting_bank_account_settings`. */
  ledgerAccountId: varchar('ledger_account_id', { length: 30 }),
  /** @deprecated release 2: WeldBooks. */
  currentBalance: numeric('current_balance', { precision: 18, scale: 2 }).default('0'),
  isDefault: boolean('is_default').default(false),
  isActive: boolean('is_active').default(true),
  /** @deprecated release 2: WeldBooks. */
  lastImportDate: timestamp('last_import_date'),
  /** @deprecated release 2: WeldBooks. */
  lastImportBalance: numeric('last_import_balance', { precision: 18, scale: 2 }),
  /** @deprecated release 2: WeldBooks. */
  autoReconcile: boolean('auto_reconcile').default(true),
  /** @deprecated release 2: WeldBooks. */
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  /** checking | savings | credit_card | money_market | line_of_credit. Cards and lines of credit sit on a liability account. */
  accountType: varchar('account_type', { length: 20 }),
  /** US ABA routing number (checksum-validated). */
  routingNumber: varchar('routing_number', { length: 9 }),
  /** AES-GCM blob of the full account number; only the last four are shown. */
  accountNumberEncrypted: text('account_number_encrypted'),
  accountNumberLast4: varchar('account_number_last4', { length: 4 }),

  /** @deprecated release 2: WeldBooks. Bank feed link (`bank_connections`) and the provider's account id. */
  feedConnectionId: varchar('feed_connection_id', { length: 30 }),
  /** @deprecated release 2: WeldBooks. */
  feedProvider: varchar('feed_provider', { length: 30 }),
  /** @deprecated release 2: WeldBooks. */
  feedAccountId: varchar('feed_account_id', { length: 255 }),
  /** @deprecated release 2: WeldBooks. Institution + mask + subtype, so a relink or provider switch reattaches here. */
  feedAccountFingerprint: varchar('feed_account_fingerprint', { length: 255 }),
  /** @deprecated release 2: WeldBooks. Feed transactions before this date are skipped (the file import covers them). */
  feedSyncFrom: date('feed_sync_from'),
  /** @deprecated release 2: WeldBooks. Per-account feed status (Stripe FC tracks status per account). */
  feedStatus: varchar('feed_status', { length: 20 }),

  /** @deprecated release 2: WeldBooks. Checks: next check number, layout and MICR settings. */
  nextCheckNumber: integer('next_check_number'),
  /** @deprecated release 2: WeldBooks. */
  checkSettings: jsonb('check_settings').$type<Record<string, unknown>>(),
  /**
   * NACHA origination settings (immediate origin/destination, company id,
   * balanced file). Core: WeldBooks payment runs and WeldHR payroll both
   * build NACHA files from it (replaces HR's own `nachaCompanyId`).
   */
  achSettings: jsonb('ach_settings').$type<Record<string, unknown>>(),
  /** @deprecated release 2: WeldBooks. Positive Pay file format of the bank (generic_csv, bofa, chase, wells_fargo, ...). */
  positivePayFormat: varchar('positive_pay_format', { length: 30 }),
  /** @deprecated release 2: WeldBooks. Remembered CSV import format. */
  importSettings: jsonb('import_settings').$type<Record<string, unknown>>(),
}, (table) => [
  index('acct_bank_accounts_feed_connection_idx').on(table.feedConnectionId),
  index('acct_bank_accounts_entity_idx').on(table.entityId),
  index('acct_bank_accounts_iban_idx').on(table.iban),
  index('acct_bank_accounts_is_active_idx').on(table.isActive),
]);

export type BankAccount = typeof bankAccounts.$inferSelect;
export type NewBankAccount = typeof bankAccounts.$inferInsert;
