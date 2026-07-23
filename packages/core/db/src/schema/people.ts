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
 * People — humans we do business with. Includes:
 *   - individual customers (formerly b2c parties)
 *   - employees / decision makers at companies (formerly `contacts`)
 *   - anonymous helpdesk visitors that resolved to a real identity later
 *
 * Identity layer: facts about *who* the person is — name, email, phone, job
 * title, marketing preferences. Their employment history at companies lives
 * in `person_companies` (time-bounded). Their commercial relationship
 * (billing address, payment terms) lives on the wrapping `parties` row when
 * they're a counterparty in their own right.
 *
 * GDPR-relevant fields (consent, opt-ins) live here — the person owns those,
 * not the commercial relationship.
 */
export const people = pgTable('people', {
  // BaseEntity
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  version: integer('version').notNull().default(1),

  // Identity
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  fullName: varchar('full_name', { length: 255 }),
  /**
   * Server-stamped on every write — canonical name for grids, exports, search,
   * and the wrapping `parties.displayName`. Renderers must read this column
   * unconditionally; never reconstruct from firstName/lastName.
   */
  displayName: varchar('display_name', { length: 255 }).notNull(),

  // Personal
  dateOfBirth: timestamp('date_of_birth'),
  gender: varchar('gender', { length: 20 }),

  // Professional (when employed at a company — junction provides the link)
  title: varchar('title', { length: 100 }),
  department: varchar('department', { length: 100 }),
  /**
   * Functional role in their primary employment (decision_maker, billing,
   * technical, etc.) — denormalised from the primary `person_companies` row
   * for list-view filtering. Authoritative value is on the junction.
   */
  role: varchar('role', { length: 30 }),

  // Contact info
  email: varchar('email', { length: 255 }),
  alternateEmails: jsonb('alternate_emails').$type<string[]>(), // string[]
  directPhone: varchar('direct_phone', { length: 50 }),
  mobilePhone: varchar('mobile_phone', { length: 50 }),
  extension: varchar('extension', { length: 20 }),

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
    type?: string;
    isDefault?: boolean;
  }>>(),

  // Visual
  avatarUrl: varchar('avatar_url', { length: 1000 }),
  linkedinUrl: varchar('linkedin_url', { length: 500 }),
  twitterHandle: varchar('twitter_handle', { length: 100 }),

  // Sales motion
  ownerId: varchar('owner_id', { length: 255 }),
  accountManagerId: varchar('account_manager_id', { length: 255 }),

  // CRM lifecycle
  status: varchar('status', { length: 20 }).notNull().default('active'),
  lifecycleStage: varchar('lifecycle_stage', { length: 30 }),
  rating: varchar('rating', { length: 10 }),
  source: varchar('source', { length: 100 }),

  // Status flags
  isSupplier: boolean('is_supplier').notNull().default(false),
  isLead: boolean('is_lead').notNull().default(false),
  isFavorite: boolean('is_favorite').notNull().default(false),

  /**
   * CRM membership. `true` for anyone created directly in the CRM (the column
   * default). Identities auto-created by the mail / helpdesk pipeline are
   * inserted with `false` — they exist only as mail contacts (avatars,
   * threading, recipient autocomplete) and stay out of the WeldCRM People grid
   * until a user clicks "Add to CRM" on the person panel, which flips this to
   * `true`. The CRM grid filters on this flag; mail surfaces ignore it.
   */
  inCrm: boolean('in_crm').notNull().default(true),

  // Influence flags (carried over from legacy contacts table)
  isDecisionMaker: boolean('is_decision_maker').default(false),
  isBillingContact: boolean('is_billing_contact').default(false),
  isTechnicalContact: boolean('is_technical_contact').default(false),
  influenceLevel: varchar('influence_level', { length: 10 }),

  // Scoring
  leadScore: integer('lead_score').default(0),
  npsScore: integer('nps_score'),
  satisfactionScore: integer('satisfaction_score'),

  // Activity dates
  firstContactDate: timestamp('first_contact_date'),
  lastContactDate: timestamp('last_contact_date'),
  lastContactedAt: timestamp('last_contacted_at'),
  nextFollowUpDate: timestamp('next_follow_up_date'),
  lastActivityType: varchar('last_activity_type', { length: 50 }),

  // Preferences
  preferredContactMethod: varchar('preferred_contact_method', { length: 20 }),
  preferredLanguage: varchar('preferred_language', { length: 10 }),
  bestTimeToContact: varchar('best_time_to_contact', { length: 100 }),

  // Marketing consent (GDPR-relevant — lives on identity, never on parties)
  marketingConsent: boolean('marketing_consent').default(false),
  emailOptIn: boolean('email_opt_in').default(false),
  smsOptIn: boolean('sms_opt_in').default(false),
  doNotCall: boolean('do_not_call').default(false),

  // Tags / custom / notes
  tags: jsonb('tags').$type<string[]>(),
  interests: jsonb('interests').$type<string[]>(),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),
  notes: text('notes'),
  internalNotes: text('internal_notes'),

  // Code
  partyCode: varchar('party_code', { length: 50 }).unique(),

  // Helpdesk widget — persistent anonymous visitor ID that later resolved to
  // this person. Unique when set so widget→person matching stays 1:1.
  visitorId: varchar('visitor_id', { length: 100 }).unique(),

  archivedAt: timestamp('archived_at'),
}, (table) => [
  index('people_email_idx').on(table.email),
  index('people_display_name_idx').on(table.displayName),
  index('people_status_idx').on(table.status),
  index('people_owner_idx').on(table.ownerId),
  index('people_party_code_idx').on(table.partyCode),
  index('people_deleted_at_idx').on(table.deletedAt),
  index('people_is_supplier_idx').on(table.isSupplier),
  index('people_is_lead_idx').on(table.isLead),
  index('people_in_crm_idx').on(table.inCrm),
  index('people_visitor_id_idx').on(table.visitorId),
]);

export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
