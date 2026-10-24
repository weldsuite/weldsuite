/**
 * Envelopes: the signing request and everything hanging off it. Pure
 * functions over the tenant DB; permission checks happen in the routes,
 * visibility (who may see which envelope) is decided here.
 */

import { and, asc, count, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type {
  SignDocument,
  SignEnvelope,
  SignField,
  SignRecipient,
  SignEnvelopeStatus,
} from '@weldsuite/db/schema';
import type {
  SignDocumentDto,
  SignEnvelopeDetail,
  SignEnvelopeSummary,
  SignFieldDto,
  SignLocale,
  SignRecipientCounts,
  SignRecipientDto,
  UpdateSignEnvelopeInput,
} from '@weldsuite/app-api-client/schemas/weldsign';
import { notADraft, notFound } from './errors';
import { recordSignEvent } from './events';

const { signEnvelopes, signDocuments, signRecipients, signFields, signEvents, workspaceMembers } = schema;

/** Who is asking, and whether they may see every envelope (`sign_envelopes:manage`). */
export interface SignViewer {
  userId: string;
  manageAll: boolean;
}

/** An envelope the viewer may not see is reported as missing, never as forbidden. */
export function canSee(envelope: Pick<SignEnvelope, 'senderUserId'>, viewer: SignViewer): boolean {
  return viewer.manageAll || envelope.senderUserId === viewer.userId;
}

/** Load a live (not deleted) envelope the viewer may see, or throw `not_found`. */
export async function loadEnvelope(db: Database, id: string, viewer: SignViewer): Promise<SignEnvelope> {
  const [row] = await db
    .select()
    .from(signEnvelopes)
    .where(and(eq(signEnvelopes.id, id), eq(signEnvelopes.kind, 'envelope'), isNull(signEnvelopes.deletedAt)))
    .limit(1);
  if (!row || !canSee(row, viewer)) throw notFound('Envelope', id);
  return row;
}

/** Same, and the envelope must still be a draft. */
export async function loadDraft(db: Database, id: string, viewer: SignViewer): Promise<SignEnvelope> {
  const row = await loadEnvelope(db, id, viewer);
  if (row.status !== 'draft') throw notADraft();
  return row;
}

/** Bump `updated_at` after a change to anything hanging off the envelope. */
export async function touchEnvelope(db: Database, id: string): Promise<void> {
  await db.update(signEnvelopes).set({ updatedAt: new Date() }).where(eq(signEnvelopes.id, id));
}

/** Name and email of a member, for the sender columns and the evidence trail. */
export async function memberProfile(db: Database, userId: string): Promise<{ name: string | null; email: string | null }> {
  const [row] = await db
    .select({ name: workspaceMembers.name, email: workspaceMembers.email })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
    .limit(1);
  return { name: row?.name || row?.email || null, email: row?.email ?? null };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toDocumentDto(row: SignDocument): SignDocumentDto {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    sizeBytes: row.sizeBytes,
    pageCount: row.pageCount,
    pageSizes: row.pageSizes,
    sha256: row.sha256,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toRecipientDto(row: SignRecipient): SignRecipientDto {
  return {
    id: row.id,
    role: row.role,
    name: row.name,
    email: row.email,
    personId: row.personId,
    locale: row.locale as SignLocale,
    routingOrder: row.routingOrder,
    authMode: row.authMode,
    hasAccessCode: row.accessCodeHash !== null,
    status: row.status,
    sentAt: iso(row.sentAt),
    openedAt: iso(row.openedAt),
    signedAt: iso(row.signedAt),
    declinedAt: iso(row.declinedAt),
  };
}

export function toFieldDto(row: SignField): SignFieldDto {
  return {
    id: row.id,
    documentId: row.documentId,
    recipientId: row.recipientId,
    type: row.type,
    page: row.page,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    required: row.required,
    label: row.label,
  };
}

function recipientCounts(recipients: Pick<SignRecipient, 'role' | 'status'>[]): SignRecipientCounts {
  const signers = recipients.filter((r) => r.role === 'signer');
  return {
    signers: signers.length,
    signed: signers.filter((r) => r.status === 'signed').length,
    cc: recipients.length - signers.length,
  };
}

function recipientPreview(recipients: Pick<SignRecipient, 'name' | 'email' | 'routingOrder'>[]): string[] {
  return [...recipients]
    .sort((a, b) => a.routingOrder - b.routingOrder)
    .map((r) => r.name || r.email || '')
    .filter(Boolean)
    .slice(0, 3);
}

function toSummary(row: SignEnvelope, documentCount: number, recipients: SignRecipient[]): SignEnvelopeSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    senderUserId: row.senderUserId,
    senderName: row.senderName,
    documentCount,
    recipients: recipientCounts(recipients),
    recipientPreview: recipientPreview(recipients),
    sentAt: iso(row.sentAt),
    completedAt: iso(row.completedAt),
    expiresAt: iso(row.expiresAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListEnvelopesOptions {
  viewer: SignViewer;
  statuses?: readonly SignEnvelopeStatus[];
  search?: string;
  limit: number;
  offset: number;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function listEnvelopes(
  db: Database,
  opts: ListEnvelopesOptions,
): Promise<{ rows: SignEnvelopeSummary[]; total: number }> {
  const conditions: SQL[] = [eq(signEnvelopes.kind, 'envelope'), isNull(signEnvelopes.deletedAt)];
  if (!opts.viewer.manageAll) conditions.push(eq(signEnvelopes.senderUserId, opts.viewer.userId));
  if (opts.statuses?.length) conditions.push(inArray(signEnvelopes.status, [...opts.statuses]));
  if (opts.search) conditions.push(ilike(signEnvelopes.title, `%${escapeLike(opts.search)}%`));
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(signEnvelopes).where(where).orderBy(desc(signEnvelopes.updatedAt), desc(signEnvelopes.id)).limit(opts.limit).offset(opts.offset),
    db.select({ total: count() }).from(signEnvelopes).where(where),
  ]);
  if (rows.length === 0) return { rows: [], total: Number(total) };

  const ids = rows.map((r) => r.id);
  const [docCounts, recipients] = await Promise.all([
    db
      .select({ envelopeId: signDocuments.envelopeId, n: count() })
      .from(signDocuments)
      .where(inArray(signDocuments.envelopeId, ids))
      .groupBy(signDocuments.envelopeId),
    db.select().from(signRecipients).where(inArray(signRecipients.envelopeId, ids)),
  ]);
  const docsBy = new Map(docCounts.map((d) => [d.envelopeId, Number(d.n)]));
  return {
    rows: rows.map((row) =>
      toSummary(
        row,
        docsBy.get(row.id) ?? 0,
        recipients.filter((r) => r.envelopeId === row.id),
      ),
    ),
    total: Number(total),
  };
}

export async function getEnvelopeDetail(
  db: Database,
  envelope: SignEnvelope,
  canEdit: boolean,
): Promise<SignEnvelopeDetail> {
  const [documents, recipients, fields] = await Promise.all([
    db.select().from(signDocuments).where(eq(signDocuments.envelopeId, envelope.id)).orderBy(asc(signDocuments.position)),
    db
      .select()
      .from(signRecipients)
      .where(eq(signRecipients.envelopeId, envelope.id))
      .orderBy(asc(signRecipients.routingOrder), asc(signRecipients.createdAt)),
    db.select().from(signFields).where(eq(signFields.envelopeId, envelope.id)).orderBy(asc(signFields.createdAt)),
  ]);
  return {
    ...toSummary(envelope, documents.length, recipients),
    message: envelope.message,
    signingOrderEnabled: envelope.signingOrderEnabled,
    reminderAfterDays: envelope.reminderAfterDays,
    reminderEveryDays: envelope.reminderEveryDays,
    reminderMaxCount: envelope.reminderMaxCount,
    documents: documents.map(toDocumentDto),
    recipientList: recipients.map(toRecipientDto),
    fields: fields.map(toFieldDto),
    canEdit: canEdit && envelope.status === 'draft',
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateEnvelopeInput {
  title: string;
  message?: string | null;
  sender: { userId: string; name: string | null; email: string | null };
  /** Defaults from `sign_settings`, when the workspace has saved any. */
  defaults?: { expiryDays: number | null; reminderAfterDays: number | null; reminderEveryDays: number | null; reminderMaxCount: number | null };
}

export async function createEnvelope(db: Database, input: CreateEnvelopeInput): Promise<SignEnvelope> {
  const id = generateId('sgn');
  const d = input.defaults;
  const [row] = await db
    .insert(signEnvelopes)
    .values({
      id,
      kind: 'envelope',
      status: 'draft',
      title: input.title,
      message: input.message ?? null,
      senderUserId: input.sender.userId,
      senderName: input.sender.name,
      senderEmail: input.sender.email,
      // Expiry is set when the envelope is sent; a draft only carries the defaults.
      reminderAfterDays: d?.reminderAfterDays ?? null,
      reminderEveryDays: d?.reminderEveryDays ?? null,
      reminderMaxCount: d?.reminderMaxCount ?? null,
    })
    .returning();
  await recordSignEvent(db, {
    envelopeId: id,
    type: 'created',
    actorUserId: input.sender.userId,
    actorName: input.sender.name,
    actorEmail: input.sender.email,
  });
  return row!;
}

export async function updateEnvelope(db: Database, envelope: SignEnvelope, input: UpdateSignEnvelopeInput): Promise<SignEnvelope> {
  if (envelope.status !== 'draft') throw notADraft();
  const [row] = await db
    .update(signEnvelopes)
    .set({
      ...(input.title !== undefined && { title: input.title }),
      ...(input.message !== undefined && { message: input.message }),
      ...(input.signingOrderEnabled !== undefined && { signingOrderEnabled: input.signingOrderEnabled }),
      ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }),
      ...(input.reminderAfterDays !== undefined && { reminderAfterDays: input.reminderAfterDays }),
      ...(input.reminderEveryDays !== undefined && { reminderEveryDays: input.reminderEveryDays }),
      ...(input.reminderMaxCount !== undefined && { reminderMaxCount: input.reminderMaxCount }),
      updatedAt: new Date(),
    })
    .where(eq(signEnvelopes.id, envelope.id))
    .returning();
  return row!;
}

/**
 * Delete a draft and everything under it. A draft never reached anyone, so
 * its trail goes too. Returns the storage keys the caller removes from R2.
 */
export async function deleteDraft(db: Database, envelope: SignEnvelope): Promise<string[]> {
  if (envelope.status !== 'draft') throw notADraft();
  const docs = await db.select({ key: signDocuments.storageKey }).from(signDocuments).where(eq(signDocuments.envelopeId, envelope.id));
  const sigs = await db
    .select({ key: signFields.signatureKey })
    .from(signFields)
    .where(and(eq(signFields.envelopeId, envelope.id), sql`${signFields.signatureKey} is not null`));
  await db.delete(signFields).where(eq(signFields.envelopeId, envelope.id));
  await db.delete(signRecipients).where(eq(signRecipients.envelopeId, envelope.id));
  await db.delete(signDocuments).where(eq(signDocuments.envelopeId, envelope.id));
  await db.delete(signEvents).where(eq(signEvents.envelopeId, envelope.id));
  await db.delete(signEnvelopes).where(eq(signEnvelopes.id, envelope.id));
  return [...docs.map((d) => d.key), ...sigs.map((s) => s.key).filter((k): k is string => !!k)];
}
