/**
 * The respondent's side of a form: start a session (bot check, invitation,
 * verified email, resume, one per respondent), save progress, upload a file or
 * a signature. Submitting is `./submit.ts`.
 *
 * Nothing is written to the tenant database until there is something to keep:
 * the response row is created by the first saved progress, so a bounce leaves no
 * trace (docs/plans/weldforms.md, "Respondent sessions").
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { masterSchema, schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { collectAnswers, fieldsOf, isFileField } from '@weldsuite/forms-engine';
import { formDefinitionSchema, type FileAnswerItem } from '@weldsuite/forms-engine/definition';
import type { SaveProgressInput, StartSessionInput, StartSessionResult } from '@weldsuite/app-api-client/schemas/weldforms';
import { sha256Hex } from '../lib/crypto';
import type { FormCountersPort } from '../lib/counters';
import { FormsError, notFound } from '../lib/errors';
import type { Env } from '../types';
import { passesBotCheck } from './bot-check';
import type { WorkspaceCtx } from './context';
import type { PublicCacheEntry } from './public-cache';
import { closedError, loadVersion, stateOf, type LinkRow } from './public-form';
import {
  issueSession,
  keyedHash,
  readSeed,
  readSession,
  readVerification,
  saveSeed,
  type RespondentSession,
  type SessionSeed,
} from './sessions';
import { pendingKey } from './submit';

const { formResponses, formResponseFiles, formInvitations } = schema;
const { formInvitationRegistry } = masterSchema;

/** Sessions one IP may start per form per minute. */
export const SESSIONS_PER_IP_PER_MINUTE = 10;
export const UPLOADS_PER_SESSION_PER_MINUTE = 30;

type ResponseRow = typeof formResponses.$inferSelect;

export async function rateLimited(counters: FormCountersPort, scope: string, limit: number): Promise<void> {
  const check = await counters.rateLimit(scope, limit, 60);
  if (!check.allowed) throw new FormsError(429, 'RATE_LIMITED', 'Too many requests. Try again in a moment.', { retryAfterSeconds: check.retryAfterSeconds });
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

interface ResolvedInvitation {
  id: string;
  email: string;
  status: string;
}

/** The live invitation behind a personal link; 410 `INVITATION_REVOKED` when it was revoked, 404 when unknown. */
async function resolveInvitation(ctx: WorkspaceCtx, link: LinkRow, token: string): Promise<ResolvedInvitation> {
  const [entry] = await ctx.master
    .select()
    .from(formInvitationRegistry)
    .where(eq(formInvitationRegistry.tokenHash, await sha256Hex(token)))
    .limit(1);
  if (!entry || entry.workspaceId !== link.workspaceId || entry.formId !== link.formId) throw notFound('Invitation');
  if (entry.revokedAt) throw new FormsError(410, 'INVITATION_REVOKED', 'This invitation link is no longer valid.');
  const [row] = await ctx.db.select().from(formInvitations).where(eq(formInvitations.id, entry.invitationId)).limit(1);
  if (!row) throw notFound('Invitation');
  if (row.status === 'revoked' || row.revokedAt) throw new FormsError(410, 'INVITATION_REVOKED', 'This invitation link is no longer valid.');
  return { id: row.id, email: row.email, status: row.status };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface StartArgs {
  env: Env;
  link: LinkRow;
  entry: PublicCacheEntry;
  counters: FormCountersPort;
  input: StartSessionInput;
  ip: string | null;
  country: string | null;
  /** Opens the tenant DB of the link's workspace. */
  open: () => Promise<WorkspaceCtx>;
  now?: number;
}

export async function startSession(args: StartArgs): Promise<StartSessionResult> {
  const { env, link, entry, counters, input } = args;
  const now = args.now ?? Date.now();
  const settings = entry.settings;
  const state = stateOf(link, entry, new Date(now));
  if (settings.respondentMode === 'members') {
    throw new FormsError(403, 'MEMBERS_ONLY', 'This form is answered inside WeldSuite by workspace members.');
  }
  if (state !== 'open') throw closedError(state);

  const resumed = input.resume ? await readSession(env, input.resume, now) : null;
  const resume = resumed && resumed.form === link.formId && resumed.pub === link.publicId ? resumed : null;
  const ipHash = args.ip ? await keyedHash(env, 'ip', args.ip) : null;
  await rateLimited(counters, `sess:${ipHash ?? 'unknown'}`, SESSIONS_PER_IP_PER_MINUTE);

  const verifiedEmail = await readVerification(env, input.verification, link.formId, now);
  const ctx = await args.open();
  const invitation = input.invitationToken ? await resolveInvitation(ctx, link, input.invitationToken) : null;

  // A personal link, a verified email and an earlier session each prove more than a bot check would.
  if (!resume && !invitation && !verifiedEmail && !(await passesBotCheck(env, input.botToken, args.ip))) {
    throw new FormsError(403, 'BOT_CHECK_FAILED', 'The bot check failed. Reload the page and try again.');
  }

  let email: string | null = invitation?.email ?? resume?.email ?? verifiedEmail ?? null;
  if (settings.respondentMode === 'verified_email' && !email && !invitation) {
    throw new FormsError(401, 'VERIFICATION_REQUIRED', 'Verify your email address to open this form.');
  }
  email = email?.trim().toLowerCase() ?? null;
  const browserHash = input.browserKey ? await keyedHash(env, `browser:${link.formId}`, input.browserKey) : null;

  // The respondent's earlier response, if they have one.
  let existing: ResponseRow | undefined;
  if (resume) [existing] = await ctx.db.select().from(formResponses).where(and(eq(formResponses.id, resume.resp), eq(formResponses.formId, link.formId))).limit(1);
  if (!existing && invitation) {
    [existing] = await ctx.db.select().from(formResponses).where(and(eq(formResponses.formId, link.formId), eq(formResponses.invitationId, invitation.id))).orderBy(desc(formResponses.updatedAt)).limit(1);
  }
  if (!existing && settings.onePerRespondent) {
    if (email) {
      [existing] = await ctx.db.select().from(formResponses).where(and(eq(formResponses.formId, link.formId), eq(formResponses.respondentEmail, email))).orderBy(desc(formResponses.updatedAt)).limit(1);
    } else if (browserHash) {
      [existing] = await ctx.db.select().from(formResponses).where(and(eq(formResponses.formId, link.formId), eq(formResponses.respondentHash, browserHash))).orderBy(desc(formResponses.updatedAt)).limit(1);
    }
  }

  const allowedHidden = new Set((entry.definition?.hidden ?? []).map((h) => h.name));
  const hidden = Object.fromEntries(Object.entries(input.hidden ?? {}).filter(([name]) => allowedHidden.has(name)));

  const responseId = existing?.id ?? resume?.resp ?? generateId('frs');
  const versionId = existing?.versionId ?? resume?.ver ?? entry.versionId;
  if (!versionId) throw closedError('closed');

  if (!existing && !(resume && (await readSeed(env.WORKSPACE_CACHE, responseId)))) {
    const seed: SessionSeed = {
      hidden,
      metadata: { ...(input.metadata ?? {}), ...(args.country ? { country: args.country } : {}) },
      ipHash,
      browserHash,
      startedAt: now,
    };
    await saveSeed(env.WORKSPACE_CACHE, responseId, seed);
  }
  if (invitation?.status === 'sent') {
    await ctx.db
      .update(formInvitations)
      .set({ status: 'opened', openedAt: new Date(now), updatedAt: new Date(now) })
      .where(and(eq(formInvitations.id, invitation.id), eq(formInvitations.status, 'sent')));
  }

  const session: Omit<RespondentSession, 'exp'> = {
    org: link.clerkOrgId,
    ws: link.workspaceId,
    form: link.formId,
    pub: link.publicId,
    ver: versionId,
    resp: responseId,
    mode: settings.respondentMode,
    ...(email ? { email } : {}),
    ...(invitation ? { inv: invitation.id } : {}),
  };
  const { token, expiresAt } = await issueSession(env, session, now);

  const completed = existing?.status === 'completed' ? { editable: settings.allowEdit && Boolean(email || invitation) } : null;
  return {
    session: token,
    responseId,
    versionId,
    expiresAt: expiresAt.toISOString(),
    answers: existing && (existing.status === 'in_progress' ? settings.collectPartial : completed?.editable) ? existing.answers : {},
    hidden: existing?.hidden ?? hidden,
    lastBlockId: existing?.lastBlockId ?? null,
    respondentEmail: email,
    completed,
  };
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface ProgressArgs {
  env: Env;
  ctx: WorkspaceCtx;
  session: RespondentSession;
  entry: PublicCacheEntry;
  input: SaveProgressInput;
  now?: Date;
}

/**
 * Saves how far the respondent got, and their answers when the form collects
 * partial responses. Creates the response row on the first call. A completed
 * response is left alone (an edit only counts once it is submitted).
 */
export async function saveProgress(args: ProgressArgs): Promise<void> {
  const { env, ctx, session, entry, input } = args;
  const now = args.now ?? new Date();
  const [existing] = await ctx.db.select().from(formResponses).where(eq(formResponses.id, session.resp)).limit(1);
  if (existing?.status === 'completed') return;

  const version = await loadVersion(ctx, session.form, session.ver);
  const def = formDefinitionSchema.parse(version.definition);
  // Only valid answers are kept, and only for the fields of the version this session runs on.
  const valid = entry.settings.collectPartial && input.answers ? collectAnswers(def, input.answers as never).valid : null;
  const timings: Record<string, number> = { ...(existing?.metadata?.timings ?? {}) };
  for (const [blockId, ms] of Object.entries(input.timings ?? {})) timings[blockId] = (timings[blockId] ?? 0) + ms;

  if (!existing) {
    const seed = await readSeed(env.WORKSPACE_CACHE, session.resp);
    const [inserted] = await ctx.db
      .insert(formResponses)
      .values({
        id: session.resp,
        formId: session.form,
        versionId: session.ver,
        status: 'in_progress',
        answers: valid ?? {},
        hidden: seed?.hidden ?? {},
        respondentEmail: session.email ?? null,
        respondentHash: seed?.browserHash ?? null,
        invitationId: session.inv ?? null,
        lastBlockId: input.lastBlockId,
        answeredCount: valid ? Object.keys(valid).length : 0,
        metadata: { ...(seed?.metadata ?? {}), ...(Object.keys(timings).length ? { timings } : {}) },
        ipHash: seed?.ipHash ?? null,
        startedAt: seed ? new Date(seed.startedAt) : now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: formResponses.id })
      .returning({ id: formResponses.id });
    if (inserted) {
      await markInvitationStarted(ctx, session, now);
      return;
    }
  }
  await ctx.db
    .update(formResponses)
    .set({
      lastBlockId: input.lastBlockId,
      ...(valid ? { answers: valid, answeredCount: Object.keys(valid).length } : {}),
      metadata: sql`${formResponses.metadata} || ${JSON.stringify(Object.keys(timings).length ? { timings } : {})}::jsonb`,
      updatedAt: now,
    })
    .where(eq(formResponses.id, session.resp));
  await markInvitationStarted(ctx, session, now);
}

async function markInvitationStarted(ctx: WorkspaceCtx, session: RespondentSession, now: Date): Promise<void> {
  if (!session.inv) return;
  await ctx.db
    .update(formInvitations)
    .set({ status: 'started', startedAt: now, responseId: session.resp, updatedAt: now })
    .where(and(eq(formInvitations.id, session.inv), inArray(formInvitations.status, ['sent', 'opened'])));
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/rtf',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/plain',
  'text/csv',
]);

const MB = 1024 * 1024;
const SIGNATURE_MAX_BYTES = 2 * MB;

function accepted(accept: 'any' | 'images' | 'documents' | 'pdf', type: string): boolean {
  switch (accept) {
    case 'any':
      return true;
    case 'images':
      return type.startsWith('image/') && type !== 'image/svg+xml';
    case 'documents':
      return DOCUMENT_TYPES.has(type);
    case 'pdf':
      return type === 'application/pdf';
  }
}

export interface UploadArgs {
  env: Env;
  ctx: WorkspaceCtx;
  /** What an upload is bound to: the response, its form and the version it runs on (a respondent session, or the member's in-progress response). */
  session: Pick<RespondentSession, 'resp' | 'form' | 'ver'>;
  counters: FormCountersPort;
  blockId: string;
  file: File;
}

/**
 * Stores a file or a drawn signature for one field of the version the session
 * runs on: size, type and count limits come from the field (capped at 25 MB).
 * The object goes under `weldforms/pending/<responseId>/<fileId>` in the private
 * bucket and moves to the form's folder on submit; one never submitted expires
 * with the prefix's lifecycle rule. A new signature replaces the old one.
 */
export async function uploadFile(args: UploadArgs): Promise<FileAnswerItem> {
  const { env, ctx, session, file } = args;
  await rateLimited(args.counters, `up:${session.resp}`, UPLOADS_PER_SESSION_PER_MINUTE);
  const version = await loadVersion(ctx, session.form, session.ver);
  const field = fieldsOf(formDefinitionSchema.parse(version.definition)).find((f) => f.id === args.blockId);
  if (!field || !isFileField(field)) throw new FormsError(400, 'BAD_REQUEST', 'This field does not take files.');

  const isSignature = field.type === 'signature';
  const maxBytes = isSignature ? SIGNATURE_MAX_BYTES : Math.min(field.type === 'file_upload' ? field.properties.maxSizeMb : 25, 25) * MB;
  if (file.size === 0) throw new FormsError(400, 'BAD_REQUEST', 'The file is empty.');
  if (file.size > maxBytes) throw new FormsError(413, 'FILE_TOO_LARGE', `Files can be at most ${Math.round(maxBytes / MB)} MB.`, { maxBytes });
  const type = file.type || 'application/octet-stream';
  const allowed = isSignature ? type === 'image/png' : accepted(field.type === 'file_upload' ? field.properties.accept : 'any', type);
  if (!allowed) throw new FormsError(415, 'UNSUPPORTED_MEDIA_TYPE', 'This type of file is not accepted here.');

  const existing = await ctx.db
    .select()
    .from(formResponseFiles)
    .where(and(eq(formResponseFiles.responseId, session.resp), eq(formResponseFiles.blockId, field.id)));
  const maxFiles = field.type === 'file_upload' ? field.properties.maxFiles : 1;
  if (isSignature) {
    if (existing.length > 0) {
      await ctx.db.delete(formResponseFiles).where(inArray(formResponseFiles.id, existing.map((f) => f.id)));
      await env.PRIVATE_STORAGE.delete(existing.map((f) => f.storageKey));
    }
  } else if (existing.length >= maxFiles) {
    throw new FormsError(422, 'TOO_MANY_FILES', `At most ${maxFiles} file${maxFiles === 1 ? '' : 's'} can be added here.`, { max: maxFiles });
  }

  const id = generateId('ffl');
  const name = (file.name || (isSignature ? 'signature.png' : 'file')).replace(/[\u0000-\u001f/\\]+/g, '_').slice(0, 255);
  const storageKey = pendingKey(session.resp, id);
  await env.PRIVATE_STORAGE.put(storageKey, await file.arrayBuffer(), { httpMetadata: { contentType: type } });
  await ctx.db.insert(formResponseFiles).values({
    id,
    responseId: session.resp,
    formId: session.form,
    blockId: field.id,
    kind: isSignature ? 'signature' : 'upload',
    storageKey,
    name,
    contentType: type,
    sizeBytes: file.size,
  });
  return { fileId: id, name, size: file.size, type };
}
