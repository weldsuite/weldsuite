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

export const crmLeads = pgTable('crm_leads', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Lead Information
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  fullName: varchar('full_name', { length: 255 }),
  companyName: varchar('company_name', { length: 255 }),
  title: varchar('title', { length: 100 }),

  // Contact
  email: varchar('email', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 50 }),
  mobile: varchar('mobile', { length: 50 }),
  website: varchar('website', { length: 500 }),

  // Address
  address: jsonb('address').$type<{
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  }>(), // Address type

  // Lead Details
  source: varchar('source', { length: 50 }).notNull().default('other'), // 'website' | 'email' | 'phone' | 'referral' | 'advertisement' | 'partner' | 'event' | 'social_media' | 'other'
  channel: varchar('channel', { length: 100 }),
  campaign: varchar('campaign', { length: 255 }),
  medium: varchar('medium', { length: 100 }),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('new'), // 'new' | 'contacted' | 'qualified' | 'unqualified' | 'converted' | 'lost'
  rating: varchar('rating', { length: 10 }), // 'hot' | 'warm' | 'cold'
  score: integer('score').default(0),

  // Assignment
  ownerId: varchar('owner_id', { length: 255 }), // Clerk user ID
  assignedAt: timestamp('assigned_at'),

  // Qualification
  isQualified: boolean('is_qualified').default(false),
  qualifiedAt: timestamp('qualified_at'),
  disqualifiedReason: varchar('disqualified_reason', { length: 500 }),

  // Interest
  productInterest: jsonb('product_interest').$type<string[]>(), // string[]
  budget: jsonb('budget').$type<{ amount: number; currency: string }>(), // Money type
  timeline: varchar('timeline', { length: 100 }),
  authority: boolean('authority'),
  need: text('need'),

  // Conversion
  convertedAt: timestamp('converted_at'),
  convertedToCustomerId: varchar('converted_to_customer_id', { length: 30 }),
  // Counterparty equivalent — populated by migration backfill.
  convertedToCounterpartyId: varchar('converted_to_counterparty_id', { length: 30 }),
  convertedToOpportunityId: varchar('converted_to_opportunity_id', { length: 30 }),

  // Activity
  firstResponseAt: timestamp('first_response_at'),
  lastActivityAt: timestamp('last_activity_at'),
  numberOfTouches: integer('number_of_touches').default(0),

  // Notes
  notes: text('notes'),
  nextAction: varchar('next_action', { length: 500 }),
}, (table) => [
  index('crm_leads_email_idx').on(table.email),
  index('crm_leads_status_idx').on(table.status),
  index('crm_leads_source_idx').on(table.source),
  index('crm_leads_owner_idx').on(table.ownerId),
  index('crm_leads_is_qualified_idx').on(table.isQualified),
]);

export type CrmLead = typeof crmLeads.$inferSelect;
export type NewCrmLead = typeof crmLeads.$inferInsert;
