import { pgTable, varchar, timestamp, date, numeric, text, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Electronic fiscal documents (Brazil): the NF-e (goods) or NFS-e (services)
 * authorised by SEFAZ or the municipality for an invoice or credit note,
 * issued through a provider (Focus NFe). One row per attempt: a rejected
 * document stays for the record and a new attempt gets a new row and a new
 * provider reference.
 */
export const fiscalDocuments = pgTable('fiscal_documents', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  /** invoice | credit_note */
  sourceType: varchar('source_type', { length: 20 }).notNull(),
  sourceId: varchar('source_id', { length: 30 }).notNull(),
  /** nfe | nfse | nfsen (NFS-e padrão nacional) */
  kind: varchar('kind', { length: 10 }).notNull(),
  /** focus_nfe */
  provider: varchar('provider', { length: 20 }).notNull(),
  /** The reference sent to the provider; unique per provider account. */
  providerRef: varchar('provider_ref', { length: 60 }).notNull(),
  /** homologacao | producao */
  environment: varchar('environment', { length: 12 }).notNull(),
  /** processing | authorized | rejected | cancelled | error */
  status: varchar('status', { length: 20 }).notNull().default('processing'),
  statusMessage: text('status_message'),

  number: varchar('number', { length: 20 }),
  series: varchar('series', { length: 5 }),
  /** NF-e access key (44 characters). */
  accessKey: varchar('access_key', { length: 44 }),
  /** NFS-e verification code. */
  verificationCode: varchar('verification_code', { length: 60 }),
  protocol: varchar('protocol', { length: 60 }),
  authorizedAt: timestamp('authorized_at'),
  cancelledAt: timestamp('cancelled_at'),
  cancelReason: text('cancel_reason'),

  /** Provider-hosted links to the XML and the DANFE / NFS-e PDF. */
  xmlUrl: text('xml_url'),
  pdfUrl: text('pdf_url'),
  /** Public link to the NFS-e on the municipal / national portal. */
  publicUrl: text('public_url'),

  requestPayload: jsonb('request_payload').$type<Record<string, unknown>>(),
  responsePayload: jsonb('response_payload').$type<Record<string, unknown>>(),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('fiscal_documents_entity_idx').on(table.entityId),
  index('fiscal_documents_source_idx').on(table.sourceType, table.sourceId),
  uniqueIndex('fiscal_documents_provider_ref_idx').on(table.provider, table.providerRef),
  index('fiscal_documents_access_key_idx').on(table.accessKey),
]);

/**
 * NF-e issued *to* the entity (purchases), fetched from the provider by CNPJ
 * or uploaded as XML. Each can be turned into a bill.
 */
export const receivedFiscalDocuments = pgTable('received_fiscal_documents', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  /** nfe | nfse */
  kind: varchar('kind', { length: 10 }).notNull().default('nfe'),
  accessKey: varchar('access_key', { length: 44 }).notNull(),
  issuerTaxId: varchar('issuer_tax_id', { length: 14 }),
  issuerName: varchar('issuer_name', { length: 255 }),
  number: varchar('number', { length: 20 }),
  series: varchar('series', { length: 5 }),
  issueDate: date('issue_date'),
  total: numeric('total', { precision: 18, scale: 2 }),
  /** new | imported | ignored */
  status: varchar('status', { length: 15 }).notNull().default('new'),
  /** Manifestação do destinatário sent: ciencia | confirmacao | desconhecimento | nao_realizada */
  manifestation: varchar('manifestation', { length: 20 }),
  /** upload | focus_nfe */
  source: varchar('source', { length: 20 }).notNull(),
  xml: text('xml'),
  /** The parsed document (issuer, items, taxes, payments). */
  parsed: jsonb('parsed').$type<Record<string, unknown>>(),
  billId: varchar('bill_id', { length: 30 }),
}, (table) => [
  uniqueIndex('received_fiscal_documents_key_idx').on(table.entityId, table.accessKey),
  index('received_fiscal_documents_status_idx').on(table.entityId, table.status),
]);

export type FiscalDocument = typeof fiscalDocuments.$inferSelect;
export type NewFiscalDocument = typeof fiscalDocuments.$inferInsert;
export type ReceivedFiscalDocument = typeof receivedFiscalDocuments.$inferSelect;
export type NewReceivedFiscalDocument = typeof receivedFiscalDocuments.$inferInsert;
