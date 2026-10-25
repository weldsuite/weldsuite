/**
 * The PDFs of an envelope. Originals go to the private bucket untouched
 * (ADR SIGN-004); the row keeps their page geometry and SHA-256, which the
 * certificate of completion quotes later.
 */

import { PDFDocument } from 'pdf-lib';
import { and, asc, count, eq, max } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { SignDocument, SignEnvelope, SignPageSize } from '@weldsuite/db/schema';
import { SIGN_LIMITS } from '@weldsuite/app-api-client/schemas/weldsign';
import { invalid, notFound } from './errors';
import { sha256Hex } from './hash';

const { signDocuments, signFields } = schema;

export interface PdfInfo {
  pageCount: number;
  pageSizes: SignPageSize[];
}

/**
 * Check that `bytes` is a PDF WeldSign can work with and read its pages.
 * Sizes are the crop box as a viewer displays it: width and height swap on a
 * page rotated by 90 or 270 degrees, the same frame pdf.js renders in.
 */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInfo> {
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw invalid('This file is not a readable PDF');
  }
  if (pdf.isEncrypted) throw invalid('Password-protected PDFs cannot be signed; remove the password first');
  const pages = pdf.getPages();
  if (pages.length === 0) throw invalid('This PDF has no pages');
  if (pages.length > SIGN_LIMITS.maxPages) throw invalid(`A PDF can have at most ${SIGN_LIMITS.maxPages} pages`);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    pageCount: pages.length,
    pageSizes: pages.map((page) => {
      const box = page.getCropBox();
      const rotation = (((page.getRotation().angle % 360) + 360) % 360) as number;
      const quarter = rotation === 90 || rotation === 270;
      return {
        width: round(quarter ? box.height : box.width),
        height: round(quarter ? box.width : box.height),
        ...(rotation ? { rotation } : {}),
      };
    }),
  };
}

export function documentKey(workspaceId: string, envelopeId: string, documentId: string): string {
  return `workspaces/${workspaceId}/weldsign/${envelopeId}/documents/${documentId}.pdf`;
}

/** A file name without any path, and with a `.pdf` extension. */
export function documentName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop()?.trim() || 'document.pdf';
  const name = base.length > 255 ? base.slice(base.length - 255) : base;
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

export async function listDocuments(db: Database, envelopeId: string): Promise<SignDocument[]> {
  return db.select().from(signDocuments).where(eq(signDocuments.envelopeId, envelopeId)).orderBy(asc(signDocuments.position));
}

export async function getDocument(db: Database, envelopeId: string, documentId: string): Promise<SignDocument> {
  const [row] = await db
    .select()
    .from(signDocuments)
    .where(and(eq(signDocuments.id, documentId), eq(signDocuments.envelopeId, envelopeId)))
    .limit(1);
  if (!row) throw notFound('Document', documentId);
  return row;
}

export interface AddDocumentInput {
  workspaceId: string;
  envelope: SignEnvelope;
  fileName: string;
  bytes: Uint8Array;
}

/** Validate, store and record a PDF. The R2 write happens before the row, so a row never points at nothing. */
export async function addDocument(db: Database, bucket: R2Bucket, input: AddDocumentInput): Promise<SignDocument> {
  const { envelope, bytes } = input;
  if (bytes.byteLength === 0) throw invalid('The file is empty');
  if (bytes.byteLength > SIGN_LIMITS.maxDocumentBytes) {
    throw invalid(`A PDF can be at most ${SIGN_LIMITS.maxDocumentBytes / (1024 * 1024)} MB`);
  }
  const [{ existing, last }] = await db
    .select({ existing: count(), last: max(signDocuments.position) })
    .from(signDocuments)
    .where(eq(signDocuments.envelopeId, envelope.id));
  if (Number(existing) >= SIGN_LIMITS.maxDocuments) {
    throw invalid(`An envelope can hold at most ${SIGN_LIMITS.maxDocuments} documents`);
  }

  const info = await inspectPdf(bytes);
  const id = generateId('sgd');
  const storageKey = documentKey(input.workspaceId, envelope.id, id);
  const sha256 = await sha256Hex(bytes);
  await bucket.put(storageKey, bytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { sha256 },
  });

  const position = last === null ? 0 : Number(last) + 1;
  const [row] = await db
    .insert(signDocuments)
    .values({
      id,
      envelopeId: envelope.id,
      name: documentName(input.fileName),
      position,
      storageKey,
      sizeBytes: bytes.byteLength,
      pageCount: info.pageCount,
      pageSizes: info.pageSizes,
      sha256,
    })
    .returning();
  return row!;
}

/** Remove a document and the fields placed on it. Returns its storage key. */
export async function removeDocument(db: Database, envelopeId: string, documentId: string): Promise<string> {
  const doc = await getDocument(db, envelopeId, documentId);
  await db.delete(signFields).where(eq(signFields.documentId, doc.id));
  await db.delete(signDocuments).where(eq(signDocuments.id, doc.id));
  // Close the gap so positions stay 0..n-1.
  const rest = await listDocuments(db, envelopeId);
  await Promise.all(
    rest.map((d, index) => (d.position === index ? null : db.update(signDocuments).set({ position: index }).where(eq(signDocuments.id, d.id)))),
  );
  return doc.storageKey;
}

/** Put the documents in the given order; the list must name every document exactly once. */
export async function reorderDocuments(db: Database, envelopeId: string, documentIds: string[]): Promise<SignDocument[]> {
  const docs = await listDocuments(db, envelopeId);
  const known = new Set(docs.map((d) => d.id));
  if (documentIds.length !== docs.length || new Set(documentIds).size !== documentIds.length || documentIds.some((id) => !known.has(id))) {
    throw invalid('documentIds must list every document of the envelope exactly once');
  }
  await Promise.all(documentIds.map((id, position) => db.update(signDocuments).set({ position }).where(eq(signDocuments.id, id))));
  return listDocuments(db, envelopeId);
}
