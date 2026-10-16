/**
 * Invoice templates: the stored page layouts of the WeldBooks invoice designer.
 *
 * Pure functions over the tenant DB (no Hono context). The invariants live here:
 *
 *   - at most one default template per accounting entity: making a template the
 *     default unsets the others of its entity in the same atomic write, and the
 *     first template of an entity becomes the default on its own;
 *   - `paper_size` mirrors `document.paperSize`;
 *   - deleting a template clears `invoices.template_id` where it pointed at it;
 *     deleting the default promotes nothing (no default = the built-in layout).
 */

import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { generateId } from '@weldsuite/worker-kit/id';
import type {
  CreateInvoiceTemplateInput,
  InvoiceTemplate,
  InvoiceTemplateDocument,
  UpdateInvoiceTemplateInput,
} from '@weldsuite/books-domain/invoice-template/schema';

const t = schema.invoiceTemplates;

export type InvoiceTemplateRow = typeof t.$inferSelect;

/** The `document` column is typed loosely in @weldsuite/db (books-domain depends on it); writes are validated by the route. */
function documentOf(row: InvoiceTemplateRow): InvoiceTemplateDocument {
  return row.document as unknown as InvoiceTemplateDocument;
}

/** A stored row as the API returns it. */
export function toInvoiceTemplate(row: InvoiceTemplateRow): InvoiceTemplate {
  return {
    id: row.id,
    entityId: row.entityId,
    name: row.name,
    isDefault: row.isDefault,
    document: documentOf(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function findInvoiceTemplate(db: Database, id: string): Promise<InvoiceTemplateRow | null> {
  const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  return row ?? null;
}

/** The templates of an entity: the default first, then by name. */
export async function listInvoiceTemplates(db: Database, entityId: string): Promise<InvoiceTemplateRow[]> {
  return db.select().from(t).where(eq(t.entityId, entityId)).orderBy(desc(t.isDefault), asc(t.name), asc(t.id));
}

/** Unsets the default flag of the entity's other templates (a statement for `atomically`). */
function unsetOtherDefaults(h: Database, entityId: string, keepId: string) {
  return h
    .update(t)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(t.entityId, entityId), eq(t.isDefault, true), ne(t.id, keepId)));
}

export interface CreateInvoiceTemplateArgs extends CreateInvoiceTemplateInput {
  createdBy?: string | null;
}

/** Creates a template. The entity's first one becomes its default whatever `isDefault` says. */
export async function createInvoiceTemplate(db: Database, input: CreateInvoiceTemplateArgs): Promise<InvoiceTemplateRow> {
  const [existing] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(t)
    .where(eq(t.entityId, input.entityId));
  const isDefault = input.isDefault === true || Number(existing?.count ?? 0) === 0;

  const now = new Date();
  const row: InvoiceTemplateRow = {
    id: generateId('itpl'),
    createdAt: now,
    updatedAt: now,
    entityId: input.entityId,
    name: input.name,
    isDefault,
    paperSize: input.document.paperSize,
    document: input.document as unknown as Record<string, unknown>,
    createdBy: input.createdBy ?? null,
  };

  await atomically(db, (h) => [
    ...(isDefault ? [unsetOtherDefaults(h, input.entityId, row.id)] : []),
    h.insert(t).values(row),
  ]);
  return row;
}

/** Updates a template; `null` when it does not exist. Setting `isDefault` unsets the entity's other default. */
export async function updateInvoiceTemplate(
  db: Database,
  id: string,
  input: UpdateInvoiceTemplateInput,
): Promise<InvoiceTemplateRow | null> {
  const existing = await findInvoiceTemplate(db, id);
  if (!existing) return null;

  const patch: Partial<typeof t.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.isDefault !== undefined) patch.isDefault = input.isDefault;
  if (input.document !== undefined) {
    patch.document = input.document as unknown as Record<string, unknown>;
    patch.paperSize = input.document.paperSize;
  }

  await atomically(db, (h) => [
    ...(input.isDefault === true ? [unsetOtherDefaults(h, existing.entityId, id)] : []),
    h.update(t).set(patch).where(eq(t.id, id)),
  ]);
  return findInvoiceTemplate(db, id);
}

/** Deletes a template and detaches it from the invoices that used it; `null` when it does not exist. */
export async function deleteInvoiceTemplate(db: Database, id: string): Promise<InvoiceTemplateRow | null> {
  const existing = await findInvoiceTemplate(db, id);
  if (!existing) return null;

  await atomically(db, (h) => [
    h.update(schema.invoices).set({ templateId: null }).where(eq(schema.invoices.templateId, id)),
    h.delete(t).where(eq(t.id, id)),
  ]);
  return existing;
}

/** A copy named "<name> (copy)", never the default; `null` when the source does not exist. */
export async function duplicateInvoiceTemplate(
  db: Database,
  id: string,
  createdBy?: string | null,
): Promise<InvoiceTemplateRow | null> {
  const source = await findInvoiceTemplate(db, id);
  if (!source) return null;

  const suffix = ' (copy)';
  const now = new Date();
  const row: InvoiceTemplateRow = {
    id: generateId('itpl'),
    createdAt: now,
    updatedAt: now,
    entityId: source.entityId,
    name: `${source.name.slice(0, 120 - suffix.length)}${suffix}`,
    isDefault: false,
    paperSize: source.paperSize,
    document: structuredClone(source.document),
    createdBy: createdBy ?? null,
  };
  await db.insert(t).values(row);
  return row;
}

/** Whether the template exists and belongs to this entity (an invoice may only pick its own entity's templates). */
export async function templateBelongsToEntity(db: Database, templateId: string, entityId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, templateId), eq(t.entityId, entityId)))
    .limit(1);
  return Boolean(row);
}

/**
 * The template an invoice prints with: the invoice's own when set and still
 * there, else the entity's default, else null (the built-in layout).
 */
export async function resolveInvoiceTemplate(
  db: Database,
  args: { templateId?: string | null; entityId: string },
): Promise<InvoiceTemplateDocument | null> {
  if (args.templateId) {
    const own = await findInvoiceTemplate(db, args.templateId);
    // A template of another entity is ignored, like a missing one.
    if (own && own.entityId === args.entityId) return documentOf(own);
  }
  const [fallback] = await db
    .select()
    .from(t)
    .where(and(eq(t.entityId, args.entityId), eq(t.isDefault, true)))
    .limit(1);
  return fallback ? documentOf(fallback) : null;
}
