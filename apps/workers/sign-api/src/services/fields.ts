/**
 * Fields: boxes on a page that one signer fills in. The editor saves the whole
 * set at once, so the service replaces it, keeping the ids it was sent.
 */

import { asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { SignField } from '@weldsuite/db/schema';
import { fieldBelongsToSigner, fieldFitsPage, type SignFieldInput } from '@weldsuite/app-api-client/schemas/weldsign';
import { invalid } from './errors';
import { listDocuments } from './documents';
import { listRecipients } from './recipients';

const { signFields } = schema;

const ID_PATTERN = /^sgf_[A-Za-z0-9_-]+$/;

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

  // Keep ids the client sent (so selections survive a save), but never one
  // that could collide: only well-formed field ids, each once.
  const seen = new Set<string>();
  const rows = fields.map((field) => {
    const keep = field.id && ID_PATTERN.test(field.id) && !seen.has(field.id);
    const id = keep ? field.id! : generateId('sgf');
    seen.add(id);
    return {
      id,
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

  await db.delete(signFields).where(eq(signFields.envelopeId, envelopeId));
  if (rows.length) await db.insert(signFields).values(rows);
  return listFields(db, envelopeId);
}
