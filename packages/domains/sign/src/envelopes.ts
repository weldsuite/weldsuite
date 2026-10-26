/**
 * Envelopes: the signing request and everything hanging off it. Pure
 * functions over the tenant DB; permission checks happen in the routes,
 * visibility (who may see which envelope) is decided here.
 */

import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type {
  SignDocument,
  SignEnvelope,
  SignEnvelopeSource,
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
import { latestFiling } from './filing';
import { toSourceDto } from './sources';

const { signEnvelopes, signDocuments, signRecipients, signFields, signEvents, workspaceMembers } = schema;

/** Who is asking, and whether they may see every envelope (`sign_envelopes:manage`). */
export interface SignViewer {
  userId: string;
  /** The member's email, lower-cased: they also see sent requests they are a recipient of. */
  email: string | null;
  manageAll: boolean;
}

/** The viewer sent this envelope or manages WeldSign: they may act on it and see its activity. */
export function isOwner(envelope: Pick<SignEnvelope, 'senderUserId'>, viewer: SignViewer): boolean {
  return viewer.manageAll || envelope.senderUserId === viewer.userId;
}

/** Still collecting signatures: sent or in progress, and not past its expiry. */
export function isOpenRequest(envelope: Pick<SignEnvelope, 'status' | 'expiresAt'>, now = new Date()): boolean {
  if (envelope.status !== 'sent' && envelope.status !== 'in_progress') return false;
  return !envelope.expiresAt || envelope.expiresAt.getTime() > now.getTime();
}

async function findEnvelope(db: Database, id: string): Promise<SignEnvelope | undefined> {
  const [row] = await db
    .select()
    .from(signEnvelopes)
    .where(and(eq(signEnvelopes.id, id), eq(signEnvelopes.kind, 'envelope'), isNull(signEnvelopes.deletedAt)))
    .limit(1);
  return row;
}

async function isRecipient(db: Database, envelopeId: string, email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: signRecipients.id })
    .from(signRecipients)
    .where(and(eq(signRecipients.envelopeId, envelopeId), eq(signRecipients.email, email)))
    .limit(1);
  return !!row;
}

/**
 * Load a live (not deleted) envelope the viewer may see, or throw
 * `not_found`: their own, any with `sign_envelopes:manage`, and a sent one
 * they are a recipient of (never someone else's draft). An envelope the
 * viewer may not see is reported as missing, never as forbidden.
 */
export async function loadEnvelope(db: Database, id: string, viewer: SignViewer): Promise<SignEnvelope> {
  const row = await findEnvelope(db, id);
  if (!row) throw notFound('Envelope', id);
  if (isOwner(row, viewer)) return row;
  if (row.status !== 'draft' && viewer.email && (await isRecipient(db, row.id, viewer.email))) return row;
  throw notFound('Envelope', id);
}

/** An envelope the viewer owns (sent it, or manages WeldSign), for anything that changes it. */
export async function loadOwnEnvelope(db: Database, id: string, viewer: SignViewer): Promise<SignEnvelope> {
  const row = await findEnvelope(db, id);
  if (!row || !isOwner(row, viewer)) throw notFound('Envelope', id);
  return row;
}

/** Same, and the envelope must still be a draft. */
export async function loadDraft(db: Database, id: string, viewer: SignViewer): Promise<SignEnvelope> {
  const row = await loadOwnEnvelope(db, id, viewer);
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
    roleName: row.roleName,
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
    declineReason: row.declineReason,
    lastRemindedAt: iso(row.lastRemindedAt),
    remindersSent: row.remindersSent,
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
    kind: row.kind,
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
  /** Only requests where the viewer is a signer whose turn it is (the "action required" folder). */
  awaitingViewer?: boolean;
  search?: string;
  limit: number;
  offset: number;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Envelopes with a recipient row for `email`, optionally narrowed (a signer whose turn it is). */
function envelopesOfRecipient(db: Database, email: string, turnOnly: boolean) {
  const where = turnOnly
    ? and(eq(signRecipients.email, email), eq(signRecipients.role, 'signer'), inArray(signRecipients.status, ['sent', 'opened']))
    : eq(signRecipients.email, email);
  return inArray(signEnvelopes.id, db.select({ id: signRecipients.envelopeId }).from(signRecipients).where(where));
}

/** What a viewer without `sign_envelopes:manage` sees: their own, and sent requests they are on. */
function visibleTo(db: Database, viewer: SignViewer): SQL {
  const own = eq(signEnvelopes.senderUserId, viewer.userId);
  if (!viewer.email) return own;
  return or(own, and(ne(signEnvelopes.status, 'draft'), envelopesOfRecipient(db, viewer.email, false)))!;
}

export async function listEnvelopes(
  db: Database,
  opts: ListEnvelopesOptions,
): Promise<{ rows: SignEnvelopeSummary[]; total: number }> {
  const conditions: SQL[] = [eq(signEnvelopes.kind, 'envelope'), isNull(signEnvelopes.deletedAt)];
  if (!opts.viewer.manageAll) conditions.push(visibleTo(db, opts.viewer));
  if (opts.awaitingViewer) {
    conditions.push(opts.viewer.email ? envelopesOfRecipient(db, opts.viewer.email, true) : sql`false`);
  }
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

/** What the caller holds, for the detail's `canEdit` / `canVoid` / `canRemind` flags. */
export interface DetailAccess {
  viewer: SignViewer;
  /** `sign_envelopes:update`, and not a read-only session. */
  update: boolean;
  /** `sign_envelopes:send` (remind, resend, correct an email too). */
  send: boolean;
  /** `sign_envelopes:void`. */
  void: boolean;
}

export async function getEnvelopeDetail(
  db: Database,
  envelope: SignEnvelope,
  access: DetailAccess,
): Promise<SignEnvelopeDetail> {
  const [documents, recipients, fields, source, filing] = await Promise.all([
    db.select().from(signDocuments).where(eq(signDocuments.envelopeId, envelope.id)).orderBy(asc(signDocuments.position)),
    db
      .select()
      .from(signRecipients)
      .where(eq(signRecipients.envelopeId, envelope.id))
      .orderBy(asc(signRecipients.routingOrder), asc(signRecipients.createdAt)),
    db.select().from(signFields).where(eq(signFields.envelopeId, envelope.id)).orderBy(asc(signFields.createdAt)),
    toSourceDto(db, envelope.source),
    envelope.status === 'completed' ? latestFiling(db, envelope.id) : Promise.resolve(null),
  ]);
  const owner = isOwner(envelope, access.viewer);
  const signers = recipients.filter((r) => r.role === 'signer');
  // Everyone signed: the signed PDF is on its way, there is nothing left to chase.
  const open = isOpenRequest(envelope) && !signers.every((r) => r.status === 'signed');
  const myTurn = access.viewer.email
    ? signers.find((r) => r.email === access.viewer.email && (r.status === 'sent' || r.status === 'opened'))
    : undefined;
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
    voidedReason: envelope.voidedReason,
    voidedAt: iso(envelope.voidedAt),
    source,
    fileBackFolderId: envelope.fileBackFolderId,
    filing,
    canEdit: owner && access.update && envelope.status === 'draft',
    isOwner: owner,
    canVoid: owner && access.void && open,
    canRemind: owner && access.send && open,
    mySignerId: open && myTurn ? myTurn.id : null,
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
  /** The Drive file or CRM record it starts from, already checked by the caller. */
  source?: SignEnvelopeSource | null;
  /** WeldDrive folder for the signed copy, already checked by the caller. */
  fileBackFolderId?: string | null;
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
      source: input.source ?? null,
      fileBackFolderId: input.fileBackFolderId ?? null,
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
      ...(input.fileBackFolderId !== undefined && { fileBackFolderId: input.fileBackFolderId }),
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
