import {
  pgTable,
  varchar,
  timestamp,
  date,
  boolean,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * A customer's sales tax exemption certificate. A valid certificate covering
 * the ship-to state on the document date zeroes the tax; the sale still counts
 * as gross and exempt sales on the return.
 */
export const exemptionCertificates = pgTable('exemption_certificates', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  /** parties.id of the customer. */
  partyId: varchar('party_id', { length: 30 }).notNull(),
  /** USPS codes the certificate covers. */
  states: jsonb('states').$type<string[]>().notNull(),
  /** resale | nonprofit | government | manufacturing | agricultural | other */
  reason: varchar('reason', { length: 20 }).notNull(),
  certificateNumber: varchar('certificate_number', { length: 100 }),
  /** sst_f0003 | mtc_uniform | state_form | other */
  form: varchar('form', { length: 20 }).notNull().default('state_form'),
  issuedOn: date('issued_on'),
  /** Empty = the per-state rule decides (us/states.ts). */
  expiresOn: date('expires_on'),
  /** Covers every purchase, not just one invoice. */
  blanket: boolean('blanket').notNull().default(true),
  /** For a single-purchase certificate: the invoice it covers. */
  invoiceId: varchar('invoice_id', { length: 30 }),
  /** Scanned certificate (accounting documents). */
  documentId: varchar('document_id', { length: 30 }),
  /** valid | expired | pending | revoked */
  status: varchar('status', { length: 15 }).notNull().default('valid'),
  receivedOn: date('received_on'),
  notes: text('notes'),
}, (table) => [
  index('acct_exemption_certs_entity_idx').on(table.entityId),
  index('acct_exemption_certs_party_idx').on(table.partyId),
  index('acct_exemption_certs_status_idx').on(table.status),
]);

export type ExemptionCertificate = typeof exemptionCertificates.$inferSelect;
export type NewExemptionCertificate = typeof exemptionCertificates.$inferInsert;
