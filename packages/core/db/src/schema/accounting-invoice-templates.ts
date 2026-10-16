import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Invoice templates: the free-form page layouts a workspace designs in the
 * WeldBooks invoice designer. A template belongs to one accounting entity;
 * at most one per entity is the default (a partial unique index backs the API's flip), and
 * an invoice picks one through `invoices.template_id`. An entity without a
 * default prints with the built-in layout.
 *
 * Hard-deleted: deleting a template nulls `invoices.template_id` on the
 * invoices that pointed at it.
 */
export const invoiceTemplates = pgTable('invoice_templates', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  /** Mirrors `document.paperSize` (a4 | letter) so lists need not read the document. */
  paperSize: varchar('paper_size', { length: 10 }).notNull().default('a4'),
  /**
   * The `InvoiceTemplateDocument` of `@weldsuite/books-domain/invoice-template/schema`
   * (versioned: `document.version`). Typed loosely here because books-domain
   * depends on this package; the books-api service casts at its boundary and the
   * route validates writes with `invoiceTemplateDocumentSchema`.
   */
  document: jsonb('document').notNull().$type<Record<string, unknown>>(),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('acct_invoice_templates_entity_idx').on(table.entityId),
  uniqueIndex('acct_invoice_templates_one_default_idx').on(table.entityId).where(sql`${table.isDefault}`),
]);
