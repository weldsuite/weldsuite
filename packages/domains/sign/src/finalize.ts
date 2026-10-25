/**
 * Finishing a request once every signer has signed (ADR SIGN-003):
 *
 * 1. `buildFinalPdf`: every document with all values drawn in, in order, then
 *    the certificate of completion; stored in the private bucket with its
 *    SHA-256; the request marked completed.
 * 2. `notifyCompleted`: links limited to downloading for 30 days, fresh
 *    download links for signers and copy recipients, and the "everyone signed"
 *    email to all of them and to the sender.
 *
 * Both steps are idempotent, so the FinalizeEnvelope Workflow can retry them.
 */

import { PDFDocument } from 'pdf-lib';
import { and, asc, eq } from 'drizzle-orm';
import { schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { SIGN_DISCLOSURE_VERSION } from '@weldsuite/app-api-client/schemas/weldsign';
import type { SignEnvelope } from '@weldsuite/db/schema';
import type { SignEnv as Env } from './env';
import { recordSignEvent } from './events';
import { sha256Hex } from './hash';
import { createLink, limitLinksToDownload, signingLink, DOWNLOAD_WINDOW_DAYS } from './links';
import { envelopeAppUrl, sendCompleted, workspaceBrand, type CompletedMail } from './mail';
import { appendCertificate, drawFields, type CertificateRecipient } from './pdf-render';
import { loadImages, toRenderFields } from './signing';

const { signEnvelopes, signDocuments, signRecipients, signFields, signEvents } = schema;

export function finalKey(workspaceId: string, envelopeId: string): string {
  return `workspaces/${workspaceId}/weldsign/${envelopeId}/final.pdf`;
}

export interface FinalizeContext {
  env: Env;
  db: Database;
  bucket: R2Bucket;
  /** Clerk org id: storage prefix (as for uploads) and tenant. */
  clerkOrgId: string;
  /** Master DB handle when the caller has one (workspace name for the certificate). */
  master?: MasterDatabase;
}

/** Build and store the signed PDF; mark the request completed. Returns the final hash. */
export async function buildFinalPdf(ctx: FinalizeContext, envelopeId: string): Promise<{ sha256: string; key: string } | null> {
  const { db, bucket } = ctx;
  const [envelope] = await db.select().from(signEnvelopes).where(eq(signEnvelopes.id, envelopeId)).limit(1);
  if (!envelope) return null;
  if (envelope.status === 'completed' && envelope.finalStorageKey && envelope.finalSha256) {
    return { sha256: envelope.finalSha256, key: envelope.finalStorageKey };
  }
  if (envelope.status !== 'sent' && envelope.status !== 'in_progress') return null;

  const [documents, recipients, fields, events] = await Promise.all([
    db.select().from(signDocuments).where(eq(signDocuments.envelopeId, envelopeId)).orderBy(asc(signDocuments.position)),
    db.select().from(signRecipients).where(eq(signRecipients.envelopeId, envelopeId)).orderBy(asc(signRecipients.routingOrder), asc(signRecipients.createdAt)),
    db.select().from(signFields).where(eq(signFields.envelopeId, envelopeId)),
    db.select().from(signEvents).where(eq(signEvents.envelopeId, envelopeId)).orderBy(asc(signEvents.createdAt)),
  ]);
  if (recipients.some((r) => r.role === 'signer' && r.status !== 'signed')) return null;

  const images = await loadImages(bucket, fields);
  const out = await PDFDocument.create();
  out.setTitle(envelope.title);
  out.setProducer('WeldSign');
  for (const doc of documents) {
    const original = await bucket.get(doc.storageKey);
    if (!original) throw new Error(`Original of document ${doc.id} is missing`);
    const pdf = await PDFDocument.load(new Uint8Array(await original.arrayBuffer()), { ignoreEncryption: true, updateMetadata: false });
    await drawFields(pdf, toRenderFields(fields.filter((f) => f.documentId === doc.id), images));
    const pages = await out.copyPages(pdf, pdf.getPageIndices());
    for (const page of pages) out.addPage(page);
  }

  // The latest of each: after a corrected email, the new person consented and signed again.
  const eventAt = (recipientId: string, type: string) => events.filter((e) => e.recipientId === recipientId && e.type === type).at(-1);
  const certificateRecipients: CertificateRecipient[] = recipients.map((r) => ({
    name: r.name,
    email: r.email,
    role: r.role,
    authMode: r.authMode,
    signatureKind: (eventAt(r.id, 'signed')?.details?.signatureKind as string | undefined) ?? null,
    ip: r.signedIp,
    userAgent: r.signedUserAgent,
    sentAt: r.sentAt,
    openedAt: r.openedAt,
    consentedAt: eventAt(r.id, 'consented')?.createdAt ?? null,
    signedAt: r.signedAt,
  }));
  const completedAt = new Date();
  const { name: workspaceName } = await workspaceBrand({ env: ctx.env, db, clerkOrgId: ctx.clerkOrgId, master: ctx.master });
  await appendCertificate(out, {
    envelopeId,
    title: envelope.title,
    senderName: envelope.senderName,
    senderEmail: envelope.senderEmail,
    workspaceName,
    sentAt: envelope.sentAt,
    completedAt,
    documents: documents.map((d) => ({ name: d.name, pageCount: d.pageCount, sha256: d.sha256 })),
    recipients: certificateRecipients,
    disclosureVersion: SIGN_DISCLOSURE_VERSION,
  });

  const bytes = await out.save();
  const sha256 = await sha256Hex(bytes);
  const key = finalKey(ctx.clerkOrgId, envelopeId);
  await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { sha256 } });
  await db
    .update(signEnvelopes)
    .set({ status: 'completed', completedAt, finalSha256: sha256, finalStorageKey: key, updatedAt: completedAt })
    .where(and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.status, envelope.status)));
  await recordSignEvent(db, { envelopeId, type: 'completed', details: { finalSha256: sha256, sizeBytes: bytes.byteLength } });
  return { sha256, key };
}

/** Download links and the "everyone signed" email. */
export async function notifyCompleted(ctx: FinalizeContext, master: MasterDatabase, masterWorkspaceId: string, envelopeId: string): Promise<void> {
  const { db, bucket } = ctx;
  const [envelope] = await db.select().from(signEnvelopes).where(eq(signEnvelopes.id, envelopeId)).limit(1);
  if (!envelope || envelope.status !== 'completed' || !envelope.finalStorageKey) return;
  const [notified] = await db
    .select({ id: signEvents.id })
    .from(signEvents)
    .where(and(eq(signEvents.envelopeId, envelopeId), eq(signEvents.type, 'delivered')))
    .limit(1);
  if (notified) return;

  const completedAt = envelope.completedAt ?? new Date();
  await limitLinksToDownload(master, masterWorkspaceId, envelopeId, completedAt);
  const recipients = await db
    .select()
    .from(signRecipients)
    .where(eq(signRecipients.envelopeId, envelopeId))
    .orderBy(asc(signRecipients.routingOrder), asc(signRecipients.createdAt));
  const object = await bucket.get(envelope.finalStorageKey);
  if (!object) throw new Error(`Final PDF of ${envelopeId} is missing`);
  const pdf = new Uint8Array(await object.arrayBuffer());

  const until = new Date(completedAt.getTime() + DOWNLOAD_WINDOW_DAYS * 86_400_000);
  const mails: CompletedMail[] = [];
  for (const r of recipients) {
    if (!r.email) continue;
    const token = await createLink(master, {
      workspaceId: masterWorkspaceId,
      clerkOrgId: ctx.clerkOrgId,
      envelopeId,
      recipientId: r.id,
      expiresAt: until,
    });
    mails.push({ to: r.email, locale: r.locale, url: signingLink(ctx.env.SIGN_PORTAL_URL, token), forSender: false });
  }
  if (envelope.senderEmail && !recipients.some((r) => r.email === envelope.senderEmail)) {
    mails.push({ to: envelope.senderEmail, locale: 'en', url: envelopeAppUrl(ctx.env, ctx.clerkOrgId, envelopeId), forSender: true });
  }
  const signers = recipients.filter((r) => r.role === 'signer').map((r) => r.name || r.email || '');
  await sendCompleted({ env: ctx.env, db, clerkOrgId: ctx.clerkOrgId, envelope: envelope as SignEnvelope, master }, mails, signers, pdf);
  await recordSignEvent(db, { envelopeId, type: 'delivered', details: { recipients: mails.length } });
}
