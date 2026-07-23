import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Companies — organisations we do business with (b2b counterparties, b2b
 * prospects, and any other commercial entity). One row per organisation.
 *
 * Identity layer: facts about *who* the company is — name, industry, VAT,
 * website, switchboard contact info, sales lifecycle. Commercial relationship
 * fields (billing address, payment terms, ledger accounts) live on the
 * wrapping `parties` row, not here.
 *
 * "Supplier" / "Lead" are boolean status flags on this row, not separate
 * entities. A company can be a supplier and a lead at the same time.
 */
export const companies = pgTable('companies', {
  // BaseEntity
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Optimistic-concurrency cursor — incremented atomically on every update.
  // Clients send `ifVersion` on write; mismatch returns 409.
  version: integer('version').notNull().default(1),

  // Identity
  name: varchar('name', { length: 255 }).notNull(),
  tradingName: varchar('trading_name', { length: 255 }),
  /**
   * Server-stamped on every write — canonical name for grids, exports, search,
   * and the wrapping `parties.displayName`. Renderers must read this column
   * unconditionally; never reconstruct from raw fields.
   */
  displayName: varchar('display_name', { length: 255 }).notNull(),

  // Legal / registration
  registrationNumber: varchar('registration_number', { length: 100 }),
  vatNumber: varchar('vat_number', { length: 50 }),

  // Profile
  industry: varchar('industry', { length: 100 }),
  employeeCount: varchar('employee_count', { length: 50 }),
  annualRevenue: jsonb('annual_revenue').$type<{ amount: number; currency: string }>(), // Money
  website: varchar('website', { length: 500 }),

  // Contact info
  email: varchar('email', { length: 255 }),
  alternateEmails: jsonb('alternate_emails').$type<string[]>(), // string[]
  phone: varchar('phone', { length: 50 }),
  mobile: varchar('mobile', { length: 50 }),
  fax: varchar('fax', { length: 50 }),

  // Addresses
  primaryAddress: jsonb('primary_address').$type<{
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  }>(),
  addresses: jsonb('addresses').$type<Array<{
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    type?: 'billing' | 'shipping' | 'both';
    isDefault?: boolean;
  }>>(), // CustomerAddress[]

  // Visual
  avatarUrl: varchar('avatar_url', { length: 1000 }),
  linkedinUrl: varchar('linkedin_url', { length: 500 }),
  twitterHandle: varchar('twitter_handle', { length: 100 }),
  facebookUrl: varchar('facebook_url', { length: 500 }),

  // Sales motion
  ownerId: varchar('owner_id', { length: 255 }),
  accountManagerId: varchar('account_manager_id', { length: 255 }),

  // CRM lifecycle / classification
  status: varchar('status', { length: 20 }).notNull().default('prospect'),
  lifecycleStage: varchar('lifecycle_stage', { length: 30 }),
  segment: varchar('segment', { length: 50 }),
  rating: varchar('rating', { length: 10 }),
  source: varchar('source', { length: 100 }),

  // Status flags — derivable but indexed for fast list filtering
  isSupplier: boolean('is_supplier').notNull().default(false),
  isLead: boolean('is_lead').notNull().default(false),
  isFavorite: boolean('is_favorite').notNull().default(false),

  // Scoring
  leadScore: integer('lead_score').default(0),
  npsScore: integer('nps_score'),
  satisfactionScore: integer('satisfaction_score'),

  // Activity dates
  firstContactDate: timestamp('first_contact_date'),
  lastContactDate: timestamp('last_contact_date'),
  nextFollowUpDate: timestamp('next_follow_up_date'),

  // Preferences
  preferredContactMethod: varchar('preferred_contact_method', { length: 20 }),
  preferredLanguage: varchar('preferred_language', { length: 10 }),
  timezone: varchar('timezone', { length: 50 }),

  // Marketing consent
  marketingConsent: boolean('marketing_consent').default(false),
  emailOptIn: boolean('email_opt_in').default(false),
  smsOptIn: boolean('sms_opt_in').default(false),
  doNotCall: boolean('do_not_call').default(false),

  // Tags / custom / notes
  tags: jsonb('tags').$type<string[]>(), // string[]
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),
  notes: text('notes'),
  internalNotes: text('internal_notes'),

  // Human-readable code for import/export tracking (unique within tenant)
  partyCode: varchar('party_code', { length: 50 }).unique(),

  // Archive — soft state distinct from soft-delete. Archived rows stay
  // visible in archive views but are filtered out of default listings.
  archivedAt: timestamp('archived_at'),
}, (table) => [
  index('companies_email_idx').on(table.email),
  index('companies_display_name_idx').on(table.displayName),
  index('companies_status_idx').on(table.status),
  index('companies_owner_idx').on(table.ownerId),
  index('companies_party_code_idx').on(table.partyCode),
  index('companies_deleted_at_idx').on(table.deletedAt),
  index('companies_is_supplier_idx').on(table.isSupplier),
  index('companies_is_lead_idx').on(table.isLead),
]);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
