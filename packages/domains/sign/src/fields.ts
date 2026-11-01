/**
 * Fields: boxes on a page that one signer fills in. The editor saves the whole
 * set at once, so the service replaces it, keeping the ids of fields it
 * already had.
 */

import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { SignField } from '@weldsuite/db/schema';
import { fieldBelongsToSigner, fieldFitsPage, type SignFieldInput } from '@weldsuite/app-api-client/schemas/weldsign';
import { invalid } from './errors';
import { listDocuments } from './documents';
import { listRecipients } from './recipients';

const { signFields } = schema;

/** Check every field against the envelope's documents and recipients; returns the first problem, or null. */
export function fieldProblem(
  field: SignFieldInput,
  documents: Map<string, { pageCount: number; pageSizes: { width: number; height: number }[] }>,
  recipients: Map<string, { role: 'signer' | 'cc' }>,
): string | null {
  const doc = documents.get(field.documentId);
  if (!doc) return `Document ${field.documentId} is not part of this envelope`;
  const recipient = recipients.get(field.recipientId);
  if (!recipient) return `Recipient ${field.recipientId} is not part of this envelope`;
  if (!fieldBelongsToSigner(recipient.role)) return 'Copy recipients cannot have fields';
  if (field.page >= doc.pageCount) return `Page ${field.page + 1} does not exist in this document`;
  const size = doc.pageSizes[field.page];
  if (size && !fieldFitsPage(field, size)) return `A field on page ${field.page + 1} lies outside the page`;
  return null;
}

export async function listFields(db: Database, envelopeId: string): Promise<SignField[]> {
  return db.select().from(signFields).where(eq(signFields.envelopeId, envelopeId)).orderBy(asc(signFields.createdAt));
}

export async function replaceFields(db: Database, envelopeId: string, fields: SignFieldInput[]): Promise<SignField[]> {
  const [documents, recipients] = await Promise.all([listDocuments(db, envelopeId), listRecipients(db, envelopeId)]);
  const docMap = new Map(documents.map((d) => [d.id, d]));
  const recipientMap = new Map(recipients.map((r) => [r.id, r]));
  for (const field of fields) {
    const problem = fieldProblem(field, docMap, recipientMap);
    if (problem) throw invalid(problem);
  }

  // Keep an id the client sent only when it is already one of this envelope's
  // fields (once): ids are table-wide keys, so anything else gets a new one.
  const existing = new Set((await listFields(db, envelopeId)).map((f) => f.id));
  const seen = new Set<string>();
  // Fields are listed by `createdAt`. One statement would stamp them all
  // alike and leave their order to the table, so new ones are a millisecond
  // apart, in the order sent. A kept field keeps its own.
  const now = Date.now();
  const rows = fields.map((field, index) => {
    const keep = !!field.id && existing.has(field.id) && !seen.has(field.id);
    const id = keep ? field.id! : generateId('sgf');
    seen.add(id);
    return {
      id,
      createdAt: new Date(now + index),
      envelopeId,
      documentId: field.documentId,
      recipientId: field.recipientId,
      type: field.type,
      page: field.page,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
      required: field.required,
      label: field.label ?? null,
    };
  });

  // Upsert, then drop what is gone, rather than delete-all then insert: the
  // tenant driver runs these as separate statements, and a failed insert must
  // not leave the draft without any fields.
  if (rows.length) {
    await db
      .insert(signFields)
      .values(rows)
      .onConflictDoUpdate({
        target: signFields.id,
        set: {
          documentId: sql`excluded.document_id`,
          recipientId: sql`excluded.recipient_id`,
          type: sql`excluded.type`,
          page: sql`excluded.page`,
          x: sql`excluded.x`,
          y: sql`excluded.y`,
          width: sql`excluded.width`,
          height: sql`excluded.height`,
          required: sql`excluded.required`,
          label: sql`excluded.label`,
          updatedAt: new Date(),
        },
      });
  }
  const kept = rows.map((r) => r.id);
  await db
    .delete(signFields)
    .where(kept.length ? and(eq(signFields.envelopeId, envelopeId), notInArray(signFields.id, kept)) : eq(signFields.envelopeId, envelopeId));
  return listFields(db, envelopeId);
}
