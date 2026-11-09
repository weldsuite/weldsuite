/**
 * Submitting a response: the one path both the public portal and the
 * members-only fill page take (docs/plans/weldforms.md, "Submitting and
 * ProcessResponse"). forms-api never trusts the browser's path: the engine
 * replays the logic over the submitted answers, drops answers to blocks that are
 * not on the path, checks the required fields that are, recomputes the variables
 * and the score and picks the ending.
 *
 *   1. checks (form still open, one per respondent, response limit)
 *   2. engine validation (422 VALIDATION_FAILED, `details.fields`)
 *   3. files: the answers may only reference this response's own uploads
 *   4. number from `forms.response_counter`, then one batch: the response is
 *      completed, files re-keyed, the invitation completed, the form's counters bumped
 *   5. entity events, ProcessResponse, public cache refresh
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { masterSchema, schema } from '@weldsuite/worker-kit/db';
import {
  displayAnswer,
  evaluateSubmission,
  fieldsOf,
  isFileField,
  recall,
  searchText,
  type AnswerError,
  type FileField,
} from '@weldsuite/forms-engine';
import { formDefinitionSchema, type Answers, type FileAnswerItem, type FormDefinition } from '@weldsuite/forms-engine/definition';
import type { SubmitSessionResult } from '@weldsuite/app-api-client/schemas/weldforms';
import { FormsError } from '../lib/errors';
import type { WorkspaceCtx } from './context';
import { closedError } from './public-form';
import { refreshPublicCache } from './public-cache';
import { startProcessing } from './process';
import { settingsOf, type FormRow } from './forms';
import type { SessionSeed } from './sessions';
import type { FormResponseEventData } from './events';

const { formResponses, formResponseFiles, forms, formInvitations } = schema;
const { formLinkRegistry } = masterSchema;

type ResponseRow = typeof formResponses.$inferSelect;
type VersionRow = typeof schema.formVersions.$inferSelect;
type FileRow = typeof formResponseFiles.$inferSelect;

export interface SubmitIdentity {
  /** Verified email (code or invitation) or the member's email. */
  email: string | null;
  /** Clerk user id on members-only forms that do not hide identities. */
  userId: string | null;
  /** Keyed hash enforcing one response per member (hidden identity) or per browser (anonymous). */
  hash: string | null;
  invitationId: string | null;
}

export interface SubmitArgs {
  ctx: WorkspaceCtx;
  form: FormRow;
  version: VersionRow;
  responseId: string;
  answers: Record<string, unknown>;
  hidden: Record<string, string>;
  timings?: Record<string, number>;
  identity: SubmitIdentity;
  /** What the session arrived with; null for the members-only page. */
  seed: Pick<SessionSeed, 'metadata' | 'ipHash' | 'startedAt'> | null;
  /** The actor on the entity events: `respondent`, or the member. */
  actor: string;
  waitUntil: (promise: Promise<unknown>) => void;
  now?: Date;
}

export const PENDING_PREFIX = 'weldforms/pending/';

export const pendingKey = (responseId: string, fileId: string) => `${PENDING_PREFIX}${responseId}/${fileId}`;

const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'file';

function finalKey(ctx: Pick<WorkspaceCtx, 'clerkOrgId'>, formId: string, responseId: string, file: { id: string; name: string }): string {
  return `workspaces/${ctx.clerkOrgId}/weldforms/${formId}/${responseId}/${file.id}-${safeName(file.name)}`;
}

/** Answers by field `ref` as display text, without files, signatures and fields the author marked sensitive. */
export function answersByRef(def: FormDefinition, answers: Answers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fieldsOf(def)) {
    if (field.sensitive === true || field.type === 'file_upload' || field.type === 'signature') continue;
    const value = answers[field.id];
    if (value === undefined) continue;
    const text = displayAnswer(field, value);
    if (text !== '') out[field.ref] = text;
  }
  return out;
}

/** The ending a respondent sees, with recall filled in. */
export function buildResult(def: FormDefinition, result: ReturnType<typeof evaluateSubmission>, responseId: string, number: number, hidden: Record<string, string>): SubmitSessionResult {
  const ending = def.endings.find((e) => e.id === result.endingId) ?? def.endings[0]!;
  const ctx = { answers: result.answers, hidden, variables: result.variables };
  return {
    responseId,
    number,
    ending: {
      id: ending.id,
      title: recall(ending.title, def, ctx),
      description: ending.description ? recall(ending.description, def, ctx) : null,
      redirectUrl: ending.redirectUrl ? recall(ending.redirectUrl, def, ctx, { encode: true }) : null,
      button: ending.button ? { text: ending.button.text, url: recall(ending.button.url, def, ctx, { encode: true }) } : null,
      showScore: ending.showScore,
      showAnswers: ending.showAnswers,
    },
    score: result.score,
    quiz: ending.showAnswers ? result.quiz.map((q) => ({ fieldId: q.fieldId, correct: q.correct, points: q.points })) : null,
  };
}

/** Throws unless the form takes this submission right now (published, not past its close date, not over its limit). */
export async function assertAcceptingSubmissions(ctx: Pick<WorkspaceCtx, 'master'>, form: FormRow, edited: boolean, now: Date): Promise<void> {
  const settings = settingsOf(form);
  if (form.publicId) {
    const [link] = await ctx.master.select().from(formLinkRegistry).where(eq(formLinkRegistry.publicId, form.publicId)).limit(1);
    if (link?.suspendedAt) throw closedError('suspended');
    if (link?.heldAt) throw closedError('held');
  }
  if (form.status !== 'published') throw closedError('closed');
  if (settings.closesAt && new Date(settings.closesAt) <= now) throw closedError('past_close_date');
  if (!edited && settings.responseLimit !== null && form.responseCount >= settings.responseLimit) throw closedError('limit_reached');
}

export async function submitResponse(args: SubmitArgs): Promise<{ result: SubmitSessionResult; edited: boolean; number: number }> {
  const { ctx, form, version, responseId, identity } = args;
  const now = args.now ?? new Date();
  const settings = settingsOf(form);
  const def = formDefinitionSchema.parse(version.definition);

  const [existing] = await ctx.db.select().from(formResponses).where(eq(formResponses.id, responseId)).limit(1);
  const edited = assertSubmittable(existing, form, identity);
  await assertAcceptingSubmissions(ctx, form, edited, now);
  if (!edited && settings.onePerRespondent) await assertFirstResponse(ctx, form.id, responseId, identity);

  // 2. The engine decides the path, the score and the ending.
  const hiddenNames = new Set(def.hidden.map((h) => h.name));
  const hidden = Object.fromEntries(Object.entries(args.hidden).filter(([name]) => hiddenNames.has(name)));
  const result = evaluateSubmission(def, { answers: args.answers as Answers, hidden });

  // 3. Files: an answer may only name this response's own uploads, for its own field.
  const files = await ctx.db.select().from(formResponseFiles).where(eq(formResponseFiles.responseId, responseId));
  const { answers, used } = checkedAnswers(def, result, files, form.id);

  // 4a. The files move from the pending prefix to the form's own folder before the rows say so.
  const bucket = ctx.env.PRIVATE_STORAGE;
  const moves = await moveUploads(ctx, def, files.filter((f) => used.has(f.id)), form.id, responseId);
  const unused = files.filter((f) => !used.has(f.id));

  // 4b. The number, then one batch.
  const number = existing?.number ?? (await nextResponseNumber(ctx, form.id));
  const invitedPersonId = await invitedPerson(ctx, identity.invitationId);
  const startedAt = existing?.startedAt ?? (args.seed ? new Date(args.seed.startedAt) : now);
  const update = completedColumns(args, existing, { def, result, answers, hidden, number, invitedPersonId, startedAt, now });
  const values = { id: responseId, ...update, startedAt };
  await atomically(ctx.db, (db) => [
    db.insert(formResponses).values(values).onConflictDoUpdate({ target: formResponses.id, set: update }),
    ...moves.map((m) => db.update(formResponseFiles).set({ storageKey: m.to }).where(eq(formResponseFiles.id, m.id))),
    ...(unused.length ? [db.delete(formResponseFiles).where(inArray(formResponseFiles.id, unused.map((f) => f.id)))] : []),
    ...(edited
      ? []
      : [db.update(forms).set({ responseCount: sql`${forms.responseCount} + 1`, lastResponseAt: now }).where(eq(forms.id, form.id))]),
    ...(identity.invitationId
      ? [
          db
            .update(formInvitations)
            .set({ status: 'completed', completedAt: now, responseId, nextReminderAt: null, updatedAt: now })
            .where(and(eq(formInvitations.id, identity.invitationId), ne(formInvitations.status, 'revoked'))),
        ]
      : []),
  ]);

  // Leftovers go after the commit; a failed delete only costs storage (the pending prefix expires on its own).
  const dead = [...moves.map((m) => m.from), ...unused.map((f) => f.storageKey)];
  if (dead.length) args.waitUntil(bucket.delete(dead).catch(() => undefined));

  // 5. Side effects.
  const eventData: FormResponseEventData = {
    id: responseId,
    formId: form.id,
    formTitle: form.title,
    number,
    respondentEmail: identity.email,
    respondentUserId: identity.userId,
    personId: values.personId,
    invitationId: values.invitationId,
    endingId: result.endingId,
    score: result.score,
    answers: answersByRef(def, answers),
    hidden,
    submittedAt: now.toISOString(),
  };
  await publishSubmitted(args, eventData, edited);
  try {
    await startProcessing(ctx.env, { clerkOrgId: ctx.clerkOrgId, workspaceId: ctx.workspaceId, formId: form.id, responseId, mode: edited ? 'update' : 'submit' }, args.waitUntil);
  } catch (err) {
    // The response is saved; its steps can be run again from the response (retry).
    console.error(`[forms-api] could not start processing ${responseId}:`, err);
  }
  // The form's own limit and the plan quota may have been crossed by this response.
  if (!edited) args.waitUntil(refreshFormCache(ctx, form.id));

  return { result: buildResult(def, result, responseId, number, hidden), edited, number };
}

/** Whether the submission edits a completed response: 404 for another form's response, 409 when it may not be edited. */
function assertSubmittable(existing: ResponseRow | undefined, form: FormRow, identity: SubmitIdentity): boolean {
  if (existing && existing.formId !== form.id) throw new FormsError(404, 'NOT_FOUND', 'Response not found');
  const edited = existing?.status === 'completed';
  if (edited && !(settingsOf(form).allowEdit && (identity.email || identity.invitationId))) {
    throw new FormsError(409, 'ALREADY_SUBMITTED', 'This form was already submitted.');
  }
  return edited;
}

/** The uploads a file answer names, as stored; null when one is not this response's own upload for this field. */
function resolveUploads(field: FileField, value: unknown, fileRows: ReadonlyMap<string, FileRow>, formId: string): FileAnswerItem[] | null {
  const items = (field.type === 'signature' ? [value] : value) as FileAnswerItem[];
  const resolved: FileAnswerItem[] = [];
  for (const item of items) {
    const row = fileRows.get(item.fileId);
    if (!row || row.blockId !== field.id || row.formId !== formId) return null;
    resolved.push({ fileId: row.id, name: row.name, size: row.sizeBytes, type: row.contentType });
  }
  return resolved;
}

/**
 * The engine's answers with each file answer resolved to its uploads, and the
 * ids of the uploads they use; 422 `VALIDATION_FAILED` with every field's error
 * when an answer is missing or not valid.
 */
function checkedAnswers(def: FormDefinition, result: ReturnType<typeof evaluateSubmission>, files: readonly FileRow[], formId: string): { answers: Answers; used: Set<string> } {
  const errors: Record<string, AnswerError> = { ...result.errors };
  const fileRows = new Map(files.map((f) => [f.id, f]));
  const answers: Answers = { ...result.answers };
  const used = new Set<string>();
  for (const field of fieldsOf(def).filter(isFileField)) {
    const value = result.answers[field.id];
    if (value === undefined) continue;
    const resolved = resolveUploads(field, value, fileRows, formId);
    if (!resolved) {
      errors[field.id] = { code: 'invalid' };
      continue;
    }
    for (const item of resolved) used.add(item.fileId);
    answers[field.id] = (field.type === 'signature' ? resolved[0] : resolved) as Answers[string];
  }
  if (Object.keys(errors).length > 0) {
    throw new FormsError(422, 'VALIDATION_FAILED', 'Some answers are missing or not valid.', { fields: errors });
  }
  return { answers, used };
}

/** Copies the used pending uploads to the form's own folder; 422 when one is gone. Returns the moves for the batch. */
async function moveUploads(
  ctx: WorkspaceCtx,
  def: FormDefinition,
  used: readonly FileRow[],
  formId: string,
  responseId: string,
): Promise<Array<{ id: string; from: string; to: string }>> {
  const bucket = ctx.env.PRIVATE_STORAGE;
  const moves: Array<{ id: string; from: string; to: string }> = [];
  for (const row of used) {
    if (!row.storageKey.startsWith(PENDING_PREFIX)) continue;
    const to = finalKey(ctx, formId, responseId, row);
    const object = await bucket.get(row.storageKey);
    if (!object) {
      const field = fieldsOf(def).find((f) => f.id === row.blockId);
      throw new FormsError(422, 'VALIDATION_FAILED', 'An uploaded file is no longer available. Upload it again.', { fields: { [field?.id ?? row.blockId]: { code: 'invalid' } } });
    }
    await bucket.put(to, object.body, { httpMetadata: { contentType: row.contentType } });
    moves.push({ id: row.id, from: row.storageKey, to });
  }
  return moves;
}

/** The form's next response number, from `forms.response_counter`. */
async function nextResponseNumber(ctx: Pick<WorkspaceCtx, 'db'>, formId: string): Promise<number> {
  const [counter] = await ctx.db
    .update(forms)
    .set({ responseCounter: sql`${forms.responseCounter} + 1` })
    .where(eq(forms.id, formId))
    .returning({ n: forms.responseCounter });
  return counter?.n ?? 1;
}

/** An invited CRM person: the response is theirs (the CRM Forms tab lists it by `personId`). */
async function invitedPerson(ctx: Pick<WorkspaceCtx, 'db'>, invitationId: string | null): Promise<string | null> {
  if (!invitationId) return null;
  const [invited] = await ctx.db.select({ personId: formInvitations.personId }).from(formInvitations).where(eq(formInvitations.id, invitationId)).limit(1);
  return invited?.personId ?? null;
}

/** The earlier metadata (or what the session arrived with) plus the time spent per block, added up. */
function mergedMetadata(existing: ResponseRow | undefined, seed: SubmitArgs['seed'], spent: SubmitArgs['timings']) {
  const base = existing?.metadata ?? { ...(seed?.metadata ?? {}) };
  const timings = { ...(existing?.metadata?.timings ?? {}) };
  for (const [blockId, ms] of Object.entries(spent ?? {})) timings[blockId] = (timings[blockId] ?? 0) + ms;
  return { ...base, ...(Object.keys(timings).length ? { timings } : {}) };
}

interface Completion {
  def: FormDefinition;
  result: ReturnType<typeof evaluateSubmission>;
  answers: Answers;
  hidden: Record<string, string>;
  number: number;
  invitedPersonId: string | null;
  startedAt: Date;
  now: Date;
}

/** The columns the completed response is written with, on insert and on update alike (all but `id` and `started_at`). */
function completedColumns(args: SubmitArgs, existing: ResponseRow | undefined, c: Completion) {
  const { form, version, identity, seed } = args;
  const { result, now } = c;
  return {
    formId: form.id,
    versionId: version.id,
    number: c.number,
    status: 'completed' as const,
    answers: c.answers as Record<string, unknown>,
    hidden: c.hidden,
    variables: result.variables,
    endingId: result.endingId,
    score: result.score,
    respondentEmail: identity.email,
    respondentUserId: identity.userId,
    respondentHash: identity.hash,
    invitationId: identity.invitationId ?? existing?.invitationId ?? null,
    personId: existing?.personId ?? c.invitedPersonId,
    lastBlockId: result.path[result.path.length - 1] ?? existing?.lastBlockId ?? null,
    answeredCount: Object.keys(result.answers).length,
    searchText: searchText(c.def, c.answers),
    metadata: mergedMetadata(existing, seed, args.timings),
    ipHash: existing?.ipHash ?? seed?.ipHash ?? null,
    submittedAt: now,
    durationMs: Math.max(0, now.getTime() - c.startedAt.getTime()),
    updatedAt: now,
  };
}

/** The entity events of a submission: the response, and the invitation it completes. */
async function publishSubmitted(args: SubmitArgs, eventData: FormResponseEventData, edited: boolean): Promise<void> {
  const { ctx, form, identity } = args;
  const workspaceId = ctx.clerkOrgId;
  await publishEntityEventRaw({
    env: ctx.env,
    workspaceId,
    userId: args.actor,
    entityType: 'form_response',
    action: edited ? 'updated' : 'submitted',
    entityId: eventData.id,
    data: eventData as unknown as Record<string, unknown>,
    source: 'api',
  });
  if (!identity.invitationId || edited) return;
  await publishEntityEventRaw({
    env: ctx.env,
    workspaceId,
    userId: args.actor,
    entityType: 'form_invitation',
    action: 'completed',
    entityId: identity.invitationId,
    data: { id: identity.invitationId, formId: form.id, ...(identity.email ? { email: identity.email } : {}) },
    source: 'api',
  });
  // The reminder sweep re-derives this workspace's next reminder: this person needs none now.
  args.waitUntil(markWorkspaceDue(ctx.env.SCHEDULE_INDEX, 'forms_reminders', ctx.clerkOrgId));
}

/** Refreshes the public cache entry from the form as it is now; a failure is only logged. */
function refreshFormCache(ctx: WorkspaceCtx, formId: string): Promise<void> {
  return (async () => {
    const [fresh] = await ctx.db.select().from(forms).where(eq(forms.id, formId)).limit(1);
    if (fresh) await refreshPublicCache(ctx, fresh);
  })().catch((err) => console.error('[forms-api] could not refresh the public cache:', err));
}

/** One response per person: another completed response of the same identity refuses this one (409 `ALREADY_SUBMITTED`). */
async function assertFirstResponse(ctx: Pick<WorkspaceCtx, 'db'>, formId: string, responseId: string, identity: SubmitIdentity): Promise<void> {
  const same = [
    identity.email ? eq(formResponses.respondentEmail, identity.email) : undefined,
    identity.userId ? eq(formResponses.respondentUserId, identity.userId) : undefined,
    identity.hash ? eq(formResponses.respondentHash, identity.hash) : undefined,
    identity.invitationId ? eq(formResponses.invitationId, identity.invitationId) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  if (same.length === 0) return;
  const anyOf = sql.join(same, sql` or `);
  const rows = await ctx.db
    .select({ id: formResponses.id })
    .from(formResponses)
    .where(and(eq(formResponses.formId, formId), eq(formResponses.status, 'completed'), ne(formResponses.id, responseId), sql`(${anyOf})`))
    .limit(1);
  if (rows.length > 0) throw new FormsError(409, 'ALREADY_SUBMITTED', 'You already submitted this form.');
}

export type { ResponseRow, VersionRow };
