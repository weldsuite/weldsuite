import {
  pgTable,
  varchar,
  text,
  timestamp,
  pgEnum,
  index,
} from 'drizzle-orm/pg-core';

// Inquiry status enum
export const inquiryStatusEnum = pgEnum('inquiry_status', ['new', 'contacted', 'in_progress', 'closed', 'converted']);

// Enterprise Inquiries table - stored in master database
export const enterpriseInquiries = pgTable('enterprise_inquiries', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Company info
  companyName: varchar('company_name', { length: 255 }).notNull(),
  teamSize: varchar('team_size', { length: 50 }).notNull(),

  // Contact info
  contactName: varchar('contact_name', { length: 255 }).notNull(),
  contactEmail: varchar('contact_email', { length: 255 }).notNull(),
  contactPhone: varchar('contact_phone', { length: 50 }),

  // Inquiry details
  useCase: text('use_case'),

  // Status tracking
  status: inquiryStatusEnum('status').notNull().default('new'),
  notes: text('notes'),
  assignedTo: varchar('assigned_to', { length: 255 }),

  // Source tracking
  source: varchar('source', { length: 100 }).default('pricing_dialog'),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  contactedAt: timestamp('contacted_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (table) => [
  index('enterprise_inquiries_status_idx').on(table.status),
  index('enterprise_inquiries_email_idx').on(table.contactEmail),
  index('enterprise_inquiries_created_idx').on(table.createdAt),
]);

export type EnterpriseInquiry = typeof enterpriseInquiries.$inferSelect;
export type NewEnterpriseInquiry = typeof enterpriseInquiries.$inferInsert;
