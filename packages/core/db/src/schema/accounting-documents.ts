import {
  pgTable,
  varchar,
  timestamp,
  integer,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export interface OcrResult {
  vendor?: {
    name?: string;
    address?: string;
    taxNumber?: string;
    kvkNumber?: string;
    iban?: string;
    bic?: string;
  };
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  currency?: string;
  lineItems?: Array<{
    description?: string;
    quantity?: number;
    unitPrice?: number;
    taxRate?: number;
    total?: number;
  }>;
  subtotal?: number;
  taxBreakdown?: Array<{
    rate?: number;
    taxableAmount?: number;
    taxAmount?: number;
  }>;
  totalTax?: number;
  total?: number;
  paymentReference?: string;
  iban?: string;
  confidence?: {
    overall?: number;
    fields?: Record<string, number>;
  };
  rawText?: string;
}

export const documents = pgTable('documents', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }),
  type: varchar('type', { length: 20 }).default('purchase_invoice').notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  originalFileName: varchar('original_file_name', { length: 255 }),
  fileKey: varchar('file_key', { length: 500 }).notNull(),
  fileSize: integer('file_size'),
  mimeType: varchar('mime_type', { length: 100 }),
  thumbnailKey: varchar('thumbnail_key', { length: 500 }),
  pageCount: integer('page_count'),

  source: varchar('source', { length: 10 }).default('upload').notNull(),
  status: varchar('status', { length: 15 }).default('pending').notNull(),

  ocrResult: jsonb('ocr_result').$type<OcrResult>(),
  ocrProcessedAt: timestamp('ocr_processed_at'),
  ocrModel: varchar('ocr_model', { length: 50 }),

  matchedContactId: varchar('matched_contact_id', { length: 30 }),
  // New — populated by migration backfill when matchedContactId resolves to
  // a Person whose primary employment Party is a Company.
  matchedCounterpartyId: varchar('matched_counterparty_id', { length: 30 }),
  linkedEntityType: varchar('linked_entity_type', { length: 20 }),
  linkedEntityId: varchar('linked_entity_id', { length: 30 }),

  emailMessageId: varchar('email_message_id', { length: 30 }),
  emailFrom: varchar('email_from', { length: 255 }),
  emailSubject: varchar('email_subject', { length: 500 }),

  notes: text('notes'),
  tags: jsonb('tags').$type<string[]>(),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('acct_documents_entity_idx').on(table.entityId),
  index('acct_documents_status_idx').on(table.status),
  index('acct_documents_type_idx').on(table.type),
  index('acct_documents_source_idx').on(table.source),
  index('acct_documents_linked_entity_idx').on(table.linkedEntityType, table.linkedEntityId),
  index('acct_documents_matched_contact_idx').on(table.matchedContactId),
  index('acct_documents_matched_counterparty_idx').on(table.matchedCounterpartyId),
]);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
