import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  numeric,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

interface PostalAddress {
  line1?: string;
  line2?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

interface Money {
  amount: number;
  currency: string;
}

/**
 * Parties — the slim counterparty wrapper layer.
 *
 * After the Companies + People refactor, a `parties` row is a thin wrapper
 * that says "this counterparty is either Acme Corp (a Company) or Jane Doe
 * (a Person)" and carries only the commercial fields shared by both kinds:
 * billing address, payment terms, ledger accounts, lifetime aggregates.
 *
 * Identity facts (name, email, phone, industry, title) live on `companies`
 * and `people`. Reads that need them join through `companyId` / `personId`.
 *
 * `kind` discriminates which identity table is wrapped:
 *   - kind='company' → companyId set, personId null
 *   - kind='person'  → personId set,  companyId null
 *
 * `role` (customer / supplier / both / none) is the accounting-side role
 * and is distinct from `kind`.
 */
export const parties = pgTable('parties', {
  // BaseEntity
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Optimistic-concurrency cursor.
  version: integer('version').notNull().default(1),

  // Human-readable code for import/export tracking.
  partyCode: varchar('party_code', { length: 50 }).unique(),

  /** Wrapper discriminator — which identity table this party wraps. */
  kind: varchar('kind', { length: 10 }), // 'company' | 'person'
  companyId: varchar('company_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),

  /**
   * Denormalised display name from the wrapped Company or Person — stamped
   * on every write by the service layer. Cached here so transactional reads
   * (invoice lists, order summaries, ticket inboxes) don't need to join the
   * identity tables just to render a name.
   */
  displayName: varchar('display_name', { length: 255 }),

  // Sales motion
  ownerId: varchar('owner_id', { length: 255 }),
  accountManagerId: varchar('account_manager_id', { length: 255 }),

  // Status (light lifecycle flag — distinct from companies/people.status)
  status: varchar('status', { length: 20 }).notNull().default('active'),

  // Relationship (parent/child for company hierarchies — multi-entity)
  parentPartyId: varchar('parent_party_id', { length: 30 }),
  isKeyAccount: boolean('is_key_account').default(false),

  // Commercial — counterparty billing/shipping fields
  billingAddress: jsonb('billing_address').$type<PostalAddress>(),
  shippingAddress: jsonb('shipping_address').$type<PostalAddress>(),

  // Financial / accounting
  creditLimit: jsonb('credit_limit').$type<Money>(), // Money
  paymentTerms: varchar('payment_terms', { length: 50 }),
  taxExempt: boolean('tax_exempt').default(false),
  currency: varchar('currency', { length: 3 }),
  iban: varchar('iban', { length: 34 }),
  bic: varchar('bic', { length: 11 }),
  defaultRevenueAccountId: varchar('default_revenue_account_id', { length: 30 }),
  defaultExpenseAccountId: varchar('default_expense_account_id', { length: 30 }),
  outstandingBalance: numeric('outstanding_balance', { precision: 18, scale: 2 }).default('0'),
  sepaMandate: jsonb('sepa_mandate').$type<{
    mandateId?: string;
    signatureDate?: string;
    type?: 'one-off' | 'recurring';
  }>(),

  // Important dates
  relationshipSince: timestamp('relationship_since'),
  churnedAt: timestamp('churned_at'),
  churnReason: varchar('churn_reason', { length: 500 }),
  contractRenewalDate: timestamp('contract_renewal_date'),

  // Activity aggregates
  totalOpportunities: integer('total_opportunities').default(0),
  wonOpportunities: integer('won_opportunities').default(0),
  totalRevenue: jsonb('total_revenue').$type<Money>(), // Money
  lifetimeValue: jsonb('lifetime_value').$type<Money>(), // Money
  averageDealSize: jsonb('average_deal_size').$type<Money>(), // Money
  totalOrders: integer('total_orders').default(0),
  totalSpent: jsonb('total_spent').$type<Money>(), // Money

  // Archive — soft state distinct from soft-delete.
  archivedAt: timestamp('archived_at'),

  /**
   * Accounting role — distinct from `kind` (which identity table is wrapped).
   * Values: 'customer', 'supplier', 'both', 'none'. Auto-promoted on first
   * bill (customer → both).
   */
  role: varchar('role', { length: 20 }).notNull().default('customer'),
}, (table) => [
  index('parties_party_code_idx').on(table.partyCode),
  index('parties_kind_idx').on(table.kind),
  index('parties_company_id_idx').on(table.companyId),
  index('parties_person_id_idx').on(table.personId),
  index('parties_display_name_idx').on(table.displayName),
  index('parties_status_idx').on(table.status),
  index('parties_owner_idx').on(table.ownerId),
  index('parties_role_idx').on(table.role),
]);

export type Party = typeof parties.$inferSelect;
export type NewParty = typeof parties.$inferInsert;
