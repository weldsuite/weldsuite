/**
 * The signer's side: what a link opens, the view of the request, consent,
 * signing and declining. Every write is recorded in `sign_events` with the
 * signer's IP and browser (ADR SIGN-003).
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { SignEnvelope, SignField, SignRecipient } from '@weldsuite/db/schema';
import {
  SIGN_DISCLOSURE_VERSION,
  type SignPortalClosedReason,
  type SignPortalCompleteInput,
  type SignPortalEnvelope,
  type SignPortalSignature,
} from '@weldsuite/app-api-client/schemas/weldsign';
import { invalid, notFound, SignError } from './errors';
import { recordSignEvent } from './events';
import { flattenDocument, type RenderField } from './pdf-render';

const { signEnvelopes, signRecipients, signDocuments, signFields, signEvents } = schema;

export interface SignerMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface SignerRef {
  envelope: SignEnvelope;
  recipient: SignRecipient;
}

/** The envelope and recipient a link or session points at; drafts and deleted requests do not exist for signers. */
export async function loadSigner(db: Database, envelopeId: string, recipientId: string): Promise<SignerRef> {
  const [envelope] = await db.select().from(signEnvelopes).where(eq(signEnvelopes.id, envelopeId)).limit(1);
  if (!envelope || envelope.kind !== 'envelope' || envelope.status === 'draft' || envelope.deletedAt) throw notFound('Envelope', envelopeId);
  const [recipient] = await db
    .select()
    .from(signRecipients)
    .where(and(eq(signRecipients.id, recipientId), eq(signRecipients.envelopeId, envelopeId)))
    .limit(1);
  if (!recipient) throw notFound('Recipient', recipientId);
  return { envelope, recipient };
}

/** Why a request can no longer be acted on, or null while it is open (or completed). */
export function closedReason(envelope: SignEnvelope, now = new Date()): SignPortalClosedReason | null {
  if (envelope.status === 'voided') return 'voided';
  if (envelope.status === 'declined') return 'declined';
  if (envelope.status === 'expired') return 'expired';
  if (envelope.status !== 'completed' && envelope.expiresAt && envelope.expiresAt.getTime() < now.getTime()) return 'expired';
  return null;
}

export function portalMode(envelope: SignEnvelope, recipient: SignRecipient, now = new Date()): SignPortalEnvelope['mode'] {
  if (envelope.status === 'completed') return 'completed';
  if (closedReason(envelope, now)) return 'closed';
  if (recipient.role === 'signer' && (recipient.status === 'sent' || recipient.status === 'opened')) return 'sign';
  return 'waiting';
}

/** The first time a signer gets in: `opened`, and the request is in progress. */
export async function markOpened(db: Database, ref: SignerRef, meta: SignerMeta): Promise<void> {
  const { envelope, recipient } = ref;
  const now = new Date();
  if (recipient.status === 'sent') {
    await db.update(signRecipients).set({ status: 'opened', openedAt: now, updatedAt: now }).where(eq(signRecipients.id, recipient.id));
  }
  if (!recipient.openedAt) {
    await recordSignEvent(db, {
      envelopeId: envelope.id,
      recipientId: recipient.id,
      type: 'opened',
      actorName: recipient.name,
      actorEmail: recipient.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
  if (envelope.status === 'sent') {
    await db.update(signEnvelopes).set({ status: 'in_progress', updatedAt: now }).where(and(eq(signEnvelopes.id, envelope.id), eq(signEnvelopes.status, 'sent')));
  }
}

/** A code check on the evidence trail: which method, and whether it passed. */
export async function recordCodeCheck(db: Database, ref: SignerRef, ok: boolean, meta: SignerMeta): Promise<void> {
  await recordSignEvent(db, {
    envelopeId: ref.envelope.id,
    recipientId: ref.recipient.id,
    type: ok ? 'code_verified' : 'code_failed',
    actorName: ref.recipient.name,
    actorEmail: ref.recipient.email,
    ip: meta.ip,
    userAgent: meta.userAgent,
    details: { method: ref.recipient.authMode },
  });
}

/** A correction that changed the address: someone else now holds the request. */
function changedEmail(details: Record<string, unknown> | null): boolean {
  return !!details && details.from !== details.to;
}

/**
 * Whether this recipient agreed to sign electronically. A corrected email is
 * a different person, so only consent given after the last such correction
 * counts; fixing just the name changes nothing.
 */
async function hasConsented(db: Database, recipientId: string): Promise<boolean> {
  const steps = await db
    .select({ type: signEvents.type, details: signEvents.details })
    .from(signEvents)
    .where(and(eq(signEvents.recipientId, recipientId), inArray(signEvents.type, ['consented', 'recipient_corrected'])))
    .orderBy(desc(signEvents.createdAt), desc(signEvents.id));
  const last = steps.find((s) => s.type === 'consented' || changedEmail(s.details));
  return last?.type === 'consented';
}

export async function portalView(
  db: Database,
  ref: SignerRef,
  brand: SignPortalEnvelope['brand'],
): Promise<SignPortalEnvelope> {
  const { envelope, recipient } = ref;
  const [documents, fields, consented] = await Promise.all([
    db.select().from(signDocuments).where(eq(signDocuments.envelopeId, envelope.id)).orderBy(asc(signDocuments.position)),
    db.select().from(signFields).where(and(eq(signFields.envelopeId, envelope.id), eq(signFields.recipientId, recipient.id))),
    hasConsented(db, recipient.id),
  ]);
  return {
    envelopeId: envelope.id,
    title: envelope.title,
    message: envelope.message,
    status: envelope.status,
    senderName: envelope.senderName,
    senderEmail: envelope.senderEmail,
    brand,
    recipient: {
      id: recipient.id,
      name: recipient.name,
      email: recipient.email,
      role: recipient.role,
      status: recipient.status,
      locale: recipient.locale === 'nl' ? 'nl' : 'en',
      consented,
    },
    mode: portalMode(envelope, recipient),
    closedReason: closedReason(envelope),
    expiresAt: envelope.expiresAt?.toISOString() ?? null,
    disclosureVersion: SIGN_DISCLOSURE_VERSION,
    documents: documents.map((d) => ({ id: d.id, name: d.name, pageCount: d.pageCount, pageSizes: d.pageSizes })),
    fields: fields.map((f) => ({
      id: f.id,
      documentId: f.documentId,
      type: f.type,
      page: f.page,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      required: f.required,
      label: f.label,
      value: f.value,
    })),
  };
}

export async function recordConsent(db: Database, ref: SignerRef, disclosureVersion: string, meta: SignerMeta): Promise<void> {
  if (portalMode(ref.envelope, ref.recipient) !== 'sign') throw new SignError('conflict', 'This request cannot be signed now');
  if (await hasConsented(db, ref.recipient.id)) return;
  await recordSignEvent(db, {
    envelopeId: ref.envelope.id,
    recipientId: ref.recipient.id,
    type: 'consented',
    actorName: ref.recipient.name,
    actorEmail: ref.recipient.email,
    ip: meta.ip,
    userAgent: meta.userAgent,
    details: { disclosureVersion },
  });
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The PNG bytes of a data URL, checked to really be a PNG. */
export function pngBytes(signature: SignPortalSignature): Uint8Array {
  const base64 = signature.image.slice(signature.image.indexOf(',') + 1);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    throw invalid('The signature image could not be read');
  }
  if (bytes.byteLength < 33 || PNG_MAGIC.some((b, i) => bytes[i] !== b)) throw invalid('The signature must be a PNG image');
  return bytes;
}

/** "24 Oct 2026" / "24 okt 2026", in the signer's time zone. */
export function signedDate(locale: string, timeZone: string | null | undefined, now = new Date()): string {
  let zone = 'UTC';
  if (timeZone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone });
      zone = timeZone;
    } catch {
      // Unknown zone: UTC.
    }
  }
  return new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: zone }).format(now);
}

export function signatureKey(workspaceId: string, envelopeId: string, recipientId: string, kind: 'signature' | 'initials'): string {
  return `workspaces/${workspaceId}/weldsign/${envelopeId}/signatures/${recipientId}-${kind}.png`;
}

export function workingKey(originalKey: string): string {
  return originalKey.replace(/\.pdf$/, '.working.pdf');
}

type ResolvedField = { value: string | null; signatureKey: string | null };
type AdoptedKeys = { signature: string | null; initials: string | null };

function adoptedImage(f: SignField, keys: AdoptedKeys): ResolvedField {
  const key = f.type === 'signature' ? keys.signature : keys.initials;
  if (!key) throw invalid(f.type === 'signature' ? 'Adopt a signature first' : 'Adopt your initials first');
  return { value: null, signatureKey: key };
}

/** What the signer typed or ticked. */
function enteredValue(f: SignField, raw: string | undefined): ResolvedField {
  if (f.type === 'checkbox') {
    const checked = raw === 'true';
    if (f.required && !checked) throw invalid(`${f.label || 'A required checkbox'} must be checked`);
    return { value: checked ? 'true' : 'false', signatureKey: null };
  }
  const v = (raw ?? '').trim();
  if (f.required && !v) throw invalid(`${f.label || 'A required field'} is empty`);
  return { value: v || null, signatureKey: null };
}

function resolveField(f: SignField, recipient: SignRecipient, raw: string | undefined, keys: AdoptedKeys, date: string): ResolvedField {
  switch (f.type) {
    case 'signature':
    case 'initials':
      return adoptedImage(f, keys);
    case 'name':
      return { value: recipient.name ?? '', signatureKey: null };
    case 'email':
      return { value: recipient.email ?? '', signatureKey: null };
    case 'date_signed':
      return { value: date, signatureKey: null };
    default:
      return enteredValue(f, raw);
  }
}

/** Field values and signature keys for a signer's submission; throws on anything missing or out of place. */
export function resolveSubmission(
  fields: SignField[],
  recipient: SignRecipient,
  input: SignPortalCompleteInput,
  keys: AdoptedKeys,
): Map<string, ResolvedField> {
  const values = new Map(input.values.map((v) => [v.fieldId, v.value]));
  for (const id of values.keys()) {
    if (!fields.some((f) => f.id === id)) throw invalid(`Field ${id} is not one of yours`);
  }
  const date = signedDate(recipient.locale, input.timeZone);
  return new Map(fields.map((f) => [f.id, resolveField(f, recipient, values.get(f.id), keys, date)]));
}

export interface CompleteContext {
  db: Database;
  bucket: R2Bucket;
  workspaceId: string;
  meta: SignerMeta;
}

/**
 * Record a signer's signature: images to the private bucket, values on the
 * fields, the recipient signed, the evidence event, and fresh working copies
 * of their documents so the next signer sees what is already signed.
 */
export async function completeSigning(ctx: CompleteContext, ref: SignerRef, input: SignPortalCompleteInput): Promise<void> {
  const { db, bucket } = ctx;
  const { envelope, recipient } = ref;
  if (portalMode(envelope, recipient) !== 'sign') throw new SignError('conflict', 'This request cannot be signed now');
  if (!(await hasConsented(db, recipient.id))) throw new SignError('conflict', 'Agree to sign electronically first');

  const fields = await db.select().from(signFields).where(and(eq(signFields.envelopeId, envelope.id), eq(signFields.recipientId, recipient.id)));
  const needs = (type: 'signature' | 'initials') => fields.some((f) => f.type === type);
  const store = async (kind: 'signature' | 'initials', sig: SignPortalSignature | null | undefined): Promise<string | null> => {
    if (!needs(kind) || !sig) return null;
    const key = signatureKey(ctx.workspaceId, envelope.id, recipient.id, kind);
    await bucket.put(key, pngBytes(sig), { httpMetadata: { contentType: 'image/png' } });
    return key;
  };
  const keys = { signature: await store('signature', input.signature), initials: await store('initials', input.initials) };
  const resolved = resolveSubmission(fields, recipient, input, keys);

  // Claim the signature before writing anything: a double-submitted /complete (or
  // two tabs) races here, and only the one that flips the recipient goes on.
  const now = new Date();
  const claimed = await db
    .update(signRecipients)
    .set({ status: 'signed', signedAt: now, signedIp: ctx.meta.ip, signedUserAgent: ctx.meta.userAgent, updatedAt: now })
    .where(and(eq(signRecipients.id, recipient.id), inArray(signRecipients.status, ['sent', 'opened'])))
    .returning({ id: signRecipients.id });
  if (claimed.length === 0) throw new SignError('conflict', 'This request has already been signed');
  try {
    for (const [id, v] of resolved) {
      await db.update(signFields).set({ value: v.value, signatureKey: v.signatureKey, filledAt: now, updatedAt: now }).where(eq(signFields.id, id));
    }
  } catch (err) {
    // The values did not all land: give the turn back so the signer can submit again.
    await db
      .update(signRecipients)
      .set({ status: recipient.status, signedAt: null, signedIp: null, signedUserAgent: null, updatedAt: new Date() })
      .where(and(eq(signRecipients.id, recipient.id), eq(signRecipients.status, 'signed')));
    throw err;
  }
  await recordSignEvent(db, {
    envelopeId: envelope.id,
    recipientId: recipient.id,
    type: 'signed',
    actorName: recipient.name,
    actorEmail: recipient.email,
    ip: ctx.meta.ip,
    userAgent: ctx.meta.userAgent,
    details: {
      signatureKind: input.signature?.kind ?? null,
      initialsKind: input.initials?.kind ?? null,
      fields: fields.length,
    },
  });
  await db.update(signEnvelopes).set({ updatedAt: now }).where(eq(signEnvelopes.id, envelope.id));

  const touched = [...new Set(fields.map((f) => f.documentId))];
  await refreshWorkingCopies(db, bucket, envelope.id, touched);
}

/** Load the PNG of every signature key used by `fields`. */
export async function loadImages(bucket: R2Bucket, fields: Pick<SignField, 'signatureKey'>[]): Promise<Map<string, Uint8Array>> {
  const keys = [...new Set(fields.map((f) => f.signatureKey).filter((k): k is string => !!k))];
  const images = new Map<string, Uint8Array>();
  for (const key of keys) {
    const obj = await bucket.get(key);
    if (obj) images.set(key, new Uint8Array(await obj.arrayBuffer()));
  }
  return images;
}

export function toRenderFields(fields: SignField[], images: Map<string, Uint8Array>): RenderField[] {
  return fields
    .filter((f) => f.filledAt)
    .map((f) => ({
      page: f.page,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      type: f.type,
      value: f.value,
      image: f.signatureKey ? (images.get(f.signatureKey) ?? null) : null,
    }));
}

/** Rebuild the working copy of each document from its original and every value filled so far. */
export async function refreshWorkingCopies(db: Database, bucket: R2Bucket, envelopeId: string, documentIds: string[]): Promise<void> {
  if (documentIds.length === 0) return;
  const docs = await db.select().from(signDocuments).where(inArray(signDocuments.id, documentIds));
  const fields = await db.select().from(signFields).where(and(eq(signFields.envelopeId, envelopeId), inArray(signFields.documentId, documentIds)));
  const images = await loadImages(bucket, fields);
  for (const doc of docs) {
    const original = await bucket.get(doc.storageKey);
    if (!original) continue;
    const bytes = await flattenDocument(new Uint8Array(await original.arrayBuffer()), toRenderFields(fields.filter((f) => f.documentId === doc.id), images));
    await bucket.put(workingKey(doc.storageKey), bytes, { httpMetadata: { contentType: 'application/pdf' } });
  }
}

/** The PDF a signer sees: the working copy when earlier signers filled something, else the original. */
export async function signerDocument(db: Database, bucket: R2Bucket, envelopeId: string, documentId: string): Promise<R2ObjectBody> {
  const [doc] = await db
    .select()
    .from(signDocuments)
    .where(and(eq(signDocuments.id, documentId), eq(signDocuments.envelopeId, envelopeId)))
    .limit(1);
  if (!doc) throw notFound('Document', documentId);
  const working = await bucket.get(workingKey(doc.storageKey));
  if (working) return working;
  const original = await bucket.get(doc.storageKey);
  if (!original) throw notFound('Document file', documentId);
  return original;
}

/** A signer declines: the request is closed for everyone. */
export async function declineSigning(db: Database, ref: SignerRef, reason: string, meta: SignerMeta): Promise<void> {
  const { envelope, recipient } = ref;
  if (portalMode(envelope, recipient) !== 'sign') throw new SignError('conflict', 'This request cannot be declined now');
  const now = new Date();
  await db
    .update(signRecipients)
    .set({ status: 'declined', declinedAt: now, declineReason: reason, updatedAt: now })
    .where(eq(signRecipients.id, recipient.id));
  await db.update(signEnvelopes).set({ status: 'declined', updatedAt: now }).where(eq(signEnvelopes.id, envelope.id));
  await recordSignEvent(db, {
    envelopeId: envelope.id,
    recipientId: recipient.id,
    type: 'declined',
    actorName: recipient.name,
    actorEmail: recipient.email,
    ip: meta.ip,
    userAgent: meta.userAgent,
    details: { reason },
  });
}

