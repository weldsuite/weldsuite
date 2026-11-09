/**
 * The respondent's side of a form: start a session (bot check, invitation,
 * verified email, resume, one per respondent), save progress, upload a file or
 * a signature. Submitting is `./submit.ts`.
 *
 * Nothing is written to the tenant database until there is something to keep:
 * the response row is created by the first saved progress, so a bounce leaves no
 * trace (docs/plans/weldforms.md, "Respondent sessions").
 */

import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { masterSchema, schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { collectAnswers, fieldsOf, isFileField, type FileField } from '@weldsuite/forms-engine';
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

/** Who is starting: what proves it (an earlier session, a personal link, a verified email) and the tenant DB. */
interface Admitted {
  ctx: WorkspaceCtx;
  resume: RespondentSession | null;
  invitation: ResolvedInvitation | null;
  /** Lower-cased; null when nothing gave one. */
  email: string | null;
  ipHash: string | null;
}

/** 403 on a members-only form, the closed error unless the form is open. */
function assertOpenToRespondents(link: LinkRow, entry: PublicCacheEntry, now: number): void {
  const state = stateOf(link, entry, new Date(now));
  if (entry.settings.respondentMode === 'members') {
    throw new FormsError(403, 'MEMBERS_ONLY', 'This form is answered inside WeldSuite by workspace members.');
  }
  if (state !== 'open') throw closedError(state);
}

/** The earlier session being resumed, when it is one of this form's link. */
async function resumedSession(env: Env, link: LinkRow, token: string | undefined, now: number): Promise<RespondentSession | null> {
  const resumed = token ? await readSession(env, token, now) : null;
  return resumed && resumed.form === link.formId && resumed.pub === link.publicId ? resumed : null;
}

/** The respondent's email: from the invitation, the earlier session or the verification; 401 when the form needs a verified one. */
function respondentEmail(mode: string, invitation: ResolvedInvitation | null, resume: RespondentSession | null, verifiedEmail: string | null): string | null {
  const email = invitation?.email ?? resume?.email ?? verifiedEmail ?? null;
  if (mode === 'verified_email' && !email && !invitation) {
    throw new FormsError(401, 'VERIFICATION_REQUIRED', 'Verify your email address to open this form.');
  }
  return email?.trim().toLowerCase() ?? null;
}

/** The rate limit, the proof of who is starting (or the bot check) and the email they answer as. */
async function admit(args: StartArgs, now: number): Promise<Admitted> {
  const { env, link, counters, input } = args;
  const resume = await resumedSession(env, link, input.resume, now);
  const ipHash = args.ip ? await keyedHash(env, 'ip', args.ip) : null;
  await rateLimited(counters, `sess:${ipHash ?? 'unknown'}`, SESSIONS_PER_IP_PER_MINUTE);

  const verifiedEmail = await readVerification(env, input.verification, link.formId, now);
  const ctx = await args.open();
  const invitation = input.invitationToken ? await resolveInvitation(ctx, link, input.invitationToken) : null;

  // A personal link, a verified email and an earlier session each prove more than a bot check would.
  const proven = Boolean(resume || invitation || verifiedEmail);
  if (!proven && !(await passesBotCheck(env, input.botToken, args.ip))) {
    throw new FormsError(403, 'BOT_CHECK_FAILED', 'The bot check failed. Reload the page and try again.');
  }
  const email = respondentEmail(args.entry.settings.respondentMode, invitation, resume, verifiedEmail);
  return { ctx, resume, invitation, email, ipHash };
}

/** The newest response of the form matching `where`. */
async function newestResponse(ctx: WorkspaceCtx, formId: string, where: SQL): Promise<ResponseRow | undefined> {
  const [row] = await ctx.db.select().from(formResponses).where(and(eq(formResponses.formId, formId), where)).orderBy(desc(formResponses.updatedAt)).limit(1);
  return row;
}

/** The respondent's earlier response, if they have one: the resumed one, the invitation's, or (one per respondent) by email or browser. */
async function earlierResponse(
  ctx: WorkspaceCtx,
  formId: string,
  who: Pick<Admitted, 'resume' | 'invitation' | 'email'> & { browserHash: string | null; onePerRespondent: boolean },
): Promise<ResponseRow | undefined> {
  if (who.resume) {
    const [resumed] = await ctx.db.select().from(formResponses).where(and(eq(formResponses.id, who.resume.resp), eq(formResponses.formId, formId))).limit(1);
    if (resumed) return resumed;
  }
  if (who.invitation) {
    const invited = await newestResponse(ctx, formId, eq(formResponses.invitationId, who.invitation.id));
    if (invited) return invited;
  }
  if (!who.onePerRespondent) return undefined;
  if (who.email) return newestResponse(ctx, formId, eq(formResponses.respondentEmail, who.email));
  if (who.browserHash) return newestResponse(ctx, formId, eq(formResponses.respondentHash, who.browserHash));
  return undefined;
}

/** The hidden fields given at the start that the form declares. */
function declaredHidden(entry: PublicCacheEntry, given: StartSessionInput['hidden']): Record<string, string> {
  const allowed = new Set((entry.definition?.hidden ?? []).map((h) => h.name));
  return Object.fromEntries(Object.entries(given ?? {}).filter(([name]) => allowed.has(name)));
}

/** Keeps what the session arrived with until the first save writes the response, unless a resumed session already did. */
async function keepSeed(env: Env, responseId: string, resumed: boolean, seed: SessionSeed): Promise<void> {
  if (resumed && (await readSeed(env.WORKSPACE_CACHE, responseId))) return;
  await saveSeed(env.WORKSPACE_CACHE, responseId, seed);
}

async function markInvitationOpened(ctx: WorkspaceCtx, invitation: ResolvedInvitation | null, now: number): Promise<void> {
  if (invitation?.status !== 'sent') return;
  await ctx.db
    .update(formInvitations)
    .set({ status: 'opened', openedAt: new Date(now), updatedAt: new Date(now) })
    .where(and(eq(formInvitations.id, invitation.id), eq(formInvitations.status, 'sent')));
}

/** The answers handed back: partial ones when the form collects them, completed ones when they may be edited. */
function resumedAnswers(existing: ResponseRow | undefined, collectPartial: boolean, completed: { editable: boolean } | null): StartSessionResult['answers'] {
  if (!existing) return {};
  const keep = existing.status === 'in_progress' ? collectPartial : completed?.editable;
  return keep ? existing.answers : {};
}

export async function startSession(args: StartArgs): Promise<StartSessionResult> {
  const { env, link, entry, input } = args;
  const now = args.now ?? Date.now();
  const settings = entry.settings;
  assertOpenToRespondents(link, entry, now);

  const { ctx, resume, invitation, email, ipHash } = await admit(args, now);
  const browserHash = input.browserKey ? await keyedHash(env, `browser:${link.formId}`, input.browserKey) : null;
  const existing = await earlierResponse(ctx, link.formId, { resume, invitation, email, browserHash, onePerRespondent: settings.onePerRespondent });
  const hidden = declaredHidden(entry, input.hidden);

  const responseId = existing?.id ?? resume?.resp ?? generateId('frs');
  const versionId = existing?.versionId ?? resume?.ver ?? entry.versionId;
  if (!versionId) throw closedError('closed');

  if (!existing) {
    const metadata = { ...(input.metadata ?? {}), ...(args.country ? { country: args.country } : {}) };
    await keepSeed(env, responseId, resume !== null, { hidden, metadata, ipHash, browserHash, startedAt: now });
  }
  await markInvitationOpened(ctx, invitation, now);

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
    answers: resumedAnswers(existing, settings.collectPartial, completed),
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
/** The largest file the field takes: a signature 2 MB, an upload its own limit, never more than 25 MB. */
function maxBytesOf(field: FileField): number {
  if (field.type === 'signature') return SIGNATURE_MAX_BYTES;
  const limitMb = field.type === 'file_upload' ? field.properties.maxSizeMb : 25;
  return Math.min(limitMb, 25) * MB;
}

/** Whether the field takes a file of this type: a signature only PNG, an upload what it accepts. */
function typeAllowed(field: FileField, type: string): boolean {
  if (field.type === 'signature') return type === 'image/png';
  return accepted(field.type === 'file_upload' ? field.properties.accept : 'any', type);
}

/** Size and type checks of a file for the field: 400 empty, 413 too large, 415 not accepted. Returns the content type. */
function checkFile(field: FileField, file: File): string {
  const maxBytes = maxBytesOf(field);
  if (file.size === 0) throw new FormsError(400, 'BAD_REQUEST', 'The file is empty.');
  if (file.size > maxBytes) throw new FormsError(413, 'FILE_TOO_LARGE', `Files can be at most ${Math.round(maxBytes / MB)} MB.`, { maxBytes });
  const type = file.type || 'application/octet-stream';
  if (!typeAllowed(field, type)) throw new FormsError(415, 'UNSUPPORTED_MEDIA_TYPE', 'This type of file is not accepted here.');
  return type;
}

/** Room for one more file of the field: a new signature replaces the old one, an upload field holds at most `maxFiles` (422). */
async function makeRoom(env: Env, ctx: WorkspaceCtx, responseId: string, field: FileField): Promise<void> {
  const existing = await ctx.db
    .select()
    .from(formResponseFiles)
    .where(and(eq(formResponseFiles.responseId, responseId), eq(formResponseFiles.blockId, field.id)));
  if (field.type === 'signature') {
    if (existing.length === 0) return;
    await ctx.db.delete(formResponseFiles).where(inArray(formResponseFiles.id, existing.map((f) => f.id)));
    await env.PRIVATE_STORAGE.delete(existing.map((f) => f.storageKey));
    return;
  }
  const maxFiles = field.type === 'file_upload' ? field.properties.maxFiles : 1;
  if (existing.length >= maxFiles) {
    const plural = maxFiles === 1 ? '' : 's';
    throw new FormsError(422, 'TOO_MANY_FILES', `At most ${maxFiles} file${plural} can be added here.`, { max: maxFiles });
  }
}

export async function uploadFile(args: UploadArgs): Promise<FileAnswerItem> {
  const { env, ctx, session, file } = args;
  await rateLimited(args.counters, `up:${session.resp}`, UPLOADS_PER_SESSION_PER_MINUTE);
  const version = await loadVersion(ctx, session.form, session.ver);
  const field = fieldsOf(formDefinitionSchema.parse(version.definition)).find((f) => f.id === args.blockId);
  if (!field || !isFileField(field)) throw new FormsError(400, 'BAD_REQUEST', 'This field does not take files.');

  const isSignature = field.type === 'signature';
  const type = checkFile(field, file);
  await makeRoom(env, ctx, session.resp, field);

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
