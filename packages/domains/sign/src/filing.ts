/**
 * Filing back: once a request is completed, a copy of the signed PDF goes to
 * WeldDrive and, for a request started from a CRM record, onto that record
 * with a note activity. Run as the last step of the FinalizeEnvelope
 * Workflow; idempotent through the `filed` evidence event.
 *
 * - WeldDrive: the folder chosen for the request (`file_back_folder_id`, set
 *   by the sender or, for a request started from a Drive file, that file's
 *   folder), else the sender's own `WeldSign/<year>`: restricted folders the
 *   sender owns, created on first use, so one member's signed contracts never
 *   show up in another's Drive.
 * - CRM: a copy as a file of the company or person (`files.entity_type`, the
 *   record's Files tab; an opportunity's goes on its company) and a completed
 *   note activity. Shared code: `@weldsuite/core-domain` (files, folders) and
 *   `@weldsuite/crm-domain` (activities).
 *
 * Each copy is its own R2 object, so deleting it in Drive or on the record
 * never touches WeldSign's signed PDF, or the other copy.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { createFile } from '@weldsuite/core-domain/files';
import { ensureOwnedFolder } from '@weldsuite/core-domain/folders';
import { createActivity } from '@weldsuite/crm-domain/activities';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { SignEnvelope } from '@weldsuite/db/schema';
import type { SignFilingDto } from '@weldsuite/app-api-client/schemas/weldsign';
import type { SignEnv as Env } from './env';
import { recordSignEvent } from './events';
import { sourceName } from './sources';

const { signEnvelopes, signEvents, signRecipients, folders, files, crmOpportunities, crmActivities } = schema;

/** The default folder in the sender's Drive; a subfolder per year sits under it. */
export const DEFAULT_FOLDER_NAME = 'WeldSign';

export interface FilingContext {
  env: Env;
  db: Database;
  bucket: R2Bucket;
  /** Clerk org id: storage keys and entity events. */
  clerkOrgId: string;
}

/** Where the signed copy went, from the latest `filed` event; null until it is filed. */
export async function latestFiling(db: Database, envelopeId: string): Promise<SignFilingDto | null> {
  const [row] = await db
    .select({ details: signEvents.details, createdAt: signEvents.createdAt })
    .from(signEvents)
    .where(and(eq(signEvents.envelopeId, envelopeId), eq(signEvents.type, 'filed')))
    .orderBy(desc(signEvents.createdAt))
    .limit(1);
  if (!row) return null;
  const d = (row.details ?? {}) as Partial<Record<keyof SignFilingDto, string | null>>;
  return {
    driveFileId: d.driveFileId ?? null,
    driveFolderId: d.driveFolderId ?? null,
    recordFileId: d.recordFileId ?? null,
    recordType: d.recordType === 'company' || d.recordType === 'person' ? d.recordType : null,
    recordId: d.recordId ?? null,
    activityId: d.activityId ?? null,
    filedAt: row.createdAt.toISOString(),
  };
}

function signedFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Signed document';
  return `${base} (signed).pdf`;
}

/** The folder for the Drive copy: the chosen one while it exists, else the sender's `WeldSign/<year>`. */
async function driveFolderFor(ctx: FilingContext, envelope: SignEnvelope, year: number): Promise<string> {
  if (envelope.fileBackFolderId) {
    const [chosen] = await ctx.db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, envelope.fileBackFolderId), isNull(folders.deletedAt)))
      .limit(1);
    if (chosen) return chosen.id;
  }
  const owner = envelope.senderUserId;
  const root = await ensureOwnedFolder(ctx.db, { name: DEFAULT_FOLDER_NAME, parentId: null, ownerId: owner, generalAccess: 'restricted', metadata: { weldsign: true } });
  const yearFolder = await ensureOwnedFolder(ctx.db, { name: String(year), parentId: root.folder.id, ownerId: owner, generalAccess: 'restricted', metadata: { weldsign: true } });
  for (const { folder, created } of [root, yearFolder]) {
    if (created) await publish(ctx, 'folder', folder.id, { id: folder.id, name: folder.name, parentId: folder.parentId });
  }
  return yearFolder.folder.id;
}

/** The CRM record that gets a copy: a company or person, or an opportunity's company. */
async function recordFor(db: Database, envelope: SignEnvelope): Promise<{ type: 'company' | 'person'; id: string; opportunityId: string | null } | null> {
  const source = envelope.source;
  if (!source) return null;
  if (source.entityType === 'company' || source.entityType === 'person') {
    return (await sourceName(db, source)) ? { type: source.entityType, id: source.entityId, opportunityId: null } : null;
  }
  if (source.entityType !== 'opportunity') return null;
  const [opp] = await db
    .select({ customerId: crmOpportunities.customerId })
    .from(crmOpportunities)
    .where(and(eq(crmOpportunities.id, source.entityId), isNull(crmOpportunities.deletedAt)))
    .limit(1);
  return opp ? { type: 'company', id: opp.customerId, opportunityId: source.entityId } : null;
}

async function publish(ctx: FilingContext, entityType: 'file' | 'folder' | 'activity', entityId: string, data: Record<string, unknown>): Promise<void> {
  await publishEntityEventRaw({
    env: ctx.env,
    workspaceId: ctx.clerkOrgId,
    userId: 'system',
    entityType,
    action: 'created',
    entityId,
    data: data as never,
  });
}

/** Which copy a `files` row is (`metadata.weldsign.copy`). */
type CopyKind = 'drive' | 'record';

/** A copy an earlier, interrupted run already made: a retry reuses it instead of making another. */
async function existingCopy(db: Database, envelopeId: string, copy: CopyKind) {
  const [row] = await db
    .select()
    .from(files)
    .where(
      and(
        isNull(files.deletedAt),
        sql`${files.metadata}->'weldsign'->>'envelopeId' = ${envelopeId}`,
        sql`${files.metadata}->'weldsign'->>'copy' = ${copy}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The note an earlier run already logged: it lists the record copy among its attachments. */
async function existingNote(db: Database, recordFileId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: crmActivities.id })
    .from(crmActivities)
    .where(sql`${crmActivities.attachments} @> ${JSON.stringify([recordFileId])}::jsonb`)
    .limit(1);
  return row?.id ?? null;
}

/** Store one copy of the PDF under its own key and record it as a `files` row. */
async function storeCopy(
  ctx: FilingContext,
  envelope: SignEnvelope,
  pdf: Uint8Array,
  copy: CopyKind,
  place: { folderId: string | null; entityType?: 'company' | 'person'; entityId?: string },
) {
  const key = `workspaces/${ctx.clerkOrgId}/weldsign/${envelope.id}/copies/${crypto.randomUUID()}.pdf`;
  await ctx.bucket.put(key, pdf, { httpMetadata: { contentType: 'application/pdf' } });
  const name = signedFileName(envelope.title);
  const file = await createFile(ctx.db, {
    fileName: name,
    originalName: name,
    mimeType: 'application/pdf',
    fileSize: pdf.byteLength,
    storagePath: key,
    fileKey: key,
    bucket: 'private',
    folderId: place.folderId,
    entityType: place.entityType,
    entityId: place.entityId ?? null,
    uploadedById: envelope.senderUserId,
    metadata: { weldsign: { envelopeId: envelope.id, copy, sha256: envelope.finalSha256 } },
  });
  await publish(ctx, 'file', file.id, {
    id: file.id,
    name: file.fileName,
    folderId: file.folderId,
    fileType: file.fileType,
    fileSize: file.fileSize,
    mimeType: file.mimeType,
  });
  return file;
}

async function signerNames(db: Database, envelopeId: string): Promise<string[]> {
  const rows = await db
    .select({ name: signRecipients.name, email: signRecipients.email, role: signRecipients.role })
    .from(signRecipients)
    .where(eq(signRecipients.envelopeId, envelopeId));
  return rows.filter((r) => r.role === 'signer').map((r) => r.name || r.email || '').filter(Boolean);
}

/** `crm_activities.related_to` in the CRM's own words. */
function relatedToOf(record: { type: 'company' | 'person'; opportunityId: string | null }): string {
  if (record.opportunityId) return 'opportunity';
  return record.type === 'company' ? 'customer' : 'contact';
}

/** The note on the CRM record: what was signed, by whom and when. */
async function logActivity(
  ctx: FilingContext,
  envelope: SignEnvelope,
  record: { type: 'company' | 'person'; id: string; opportunityId: string | null },
  recordFileId: string,
  now: Date,
): Promise<string> {
  const names = await signerNames(ctx.db, envelope.id);
  const relatedName = (await sourceName(ctx.db, envelope.source!)) ?? undefined;
  const { id, eventData } = await createActivity(
    ctx.db,
    {
      type: 'note',
      subject: `Signed: ${envelope.title}`.slice(0, 255),
      description: `Signed by ${names.join(', ')} on ${now.toISOString().slice(0, 10)} with WeldSign. The signed PDF is in the files of this record.`,
      relatedTo: relatedToOf(record),
      relatedToId: record.opportunityId ?? record.id,
      relatedToName: relatedName,
      customerId: record.type === 'company' ? record.id : undefined,
      personId: record.type === 'person' ? record.id : undefined,
      opportunityId: record.opportunityId ?? undefined,
      status: 'completed',
      // The signed copy on the record; also how a retry recognises this note.
      attachments: [recordFileId],
    },
    envelope.senderUserId,
  );
  await publish(ctx, 'activity', id, eventData as unknown as Record<string, unknown>);
  return id;
}

/**
 * File a completed request's signed PDF. Returns where it went; null when the
 * request is not completed yet. Each part is made once: a run that stopped
 * half way (the Workflow retries the step) reuses the copies and the note it
 * already made, and once the `filed` event exists nothing runs again.
 */
export async function fileSignedPdf(ctx: FilingContext, envelopeId: string, now = new Date()): Promise<SignFilingDto | null> {
  const [envelope] = await ctx.db.select().from(signEnvelopes).where(eq(signEnvelopes.id, envelopeId)).limit(1);
  if (!envelope || envelope.status !== 'completed' || !envelope.finalStorageKey) return null;
  const done = await latestFiling(ctx.db, envelopeId);
  if (done) return done;

  let pdf: Uint8Array | null = null;
  const signedPdf = async () => {
    if (pdf) return pdf;
    const object = await ctx.bucket.get(envelope.finalStorageKey!);
    if (!object) throw new Error(`The signed PDF of ${envelopeId} is missing`);
    pdf = new Uint8Array(await object.arrayBuffer());
    return pdf;
  };

  let driveFile = await existingCopy(ctx.db, envelopeId, 'drive');
  if (!driveFile) {
    const folderId = await driveFolderFor(ctx, envelope, (envelope.completedAt ?? now).getUTCFullYear());
    driveFile = await storeCopy(ctx, envelope, await signedPdf(), 'drive', { folderId });
  }

  const record = await recordFor(ctx.db, envelope);
  let recordFileId: string | null = null;
  let activityId: string | null = null;
  if (record) {
    const recordFile =
      (await existingCopy(ctx.db, envelopeId, 'record')) ??
      (await storeCopy(ctx, envelope, await signedPdf(), 'record', { folderId: null, entityType: record.type, entityId: record.id }));
    recordFileId = recordFile.id;
    activityId = (await existingNote(ctx.db, recordFile.id)) ?? (await logActivity(ctx, envelope, record, recordFile.id, now));
  }

  const details = {
    driveFileId: driveFile.id,
    driveFolderId: driveFile.folderId,
    recordFileId,
    recordType: record?.type ?? null,
    recordId: record?.id ?? null,
    activityId,
  };
  await recordSignEvent(ctx.db, { envelopeId, type: 'filed', details });
  return latestFiling(ctx.db, envelopeId);
}
