import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * person_companies — time-bounded employment / affiliation between a Person
 * and a Company. Replaces today's `contact_customers` + `contact_suppliers`
 * with a single junction table.
 *
 * Customer-side vs supplier-side is NOT modelled here — that distinction is
 * a property of the Company (and the Person), not of the relationship. The
 * `role` column captures the *functional* relationship (billing, technical,
 * decision_maker), not the commercial direction.
 *
 * Time-bounded by design: `endedAt` lets us preserve employment history when
 * someone changes jobs, instead of overwriting their current employer. Old
 * tickets / invoices / meetings that referenced the previous junction stay
 * historically accurate.
 */
export const personCompanies = pgTable('person_companies', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  personId: varchar('person_id', { length: 30 }).notNull(),
  companyId: varchar('company_id', { length: 30 }).notNull(),

  /**
   * Functional role at this company. Common values: 'billing', 'technical',
   * 'decision_maker', 'champion', 'budget_holder', 'executive'. Free-text so
   * tenants can extend.
   */
  role: varchar('role', { length: 50 }),
  isPrimary: boolean('is_primary').notNull().default(false),

  startedAt: timestamp('started_at'),
  endedAt: timestamp('ended_at'),
}, (table) => [
  index('person_companies_person_idx').on(table.personId),
  index('person_companies_company_idx').on(table.companyId),
  index('person_companies_primary_idx').on(table.isPrimary),
  // A person can have multiple stints at the same company (left, came back).
  // Disambiguate active vs historical rows by the start date.
  uniqueIndex('person_companies_unique_stint').on(
    table.personId,
    table.companyId,
    table.startedAt,
  ),
]);

export type PersonCompany = typeof personCompanies.$inferSelect;
export type NewPersonCompany = typeof personCompanies.$inferInsert;
