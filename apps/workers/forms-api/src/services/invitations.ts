/**
 * Invitations: a personal link per person (members, CRM people, a CRM list,
 * pasted addresses), their status, reminders by hand and automatic, and revoke
 * (weldsuite-documentation/plans/weldforms.md, "Invitations and reminders").
 *
 * A link is `<portal>/i/<publicId>.<token>`; the token is 32 random bytes and
 * only its SHA-256 is kept, in the master `form_invitation_registry` (which the
 * respondent session reads). A reminder mints a fresh token, since the first one
 * cannot be recovered from its hash; every token of an invitation stays valid
 * until it is revoked or completed. The outbound guard checks a whole batch
 * before anything is written; a refusal sends nothing.
 *
 * Each invitation's reminder schedule (`afterDays`, `everyDays`, `maxCount`) is
 * fixed when it is sent, from the request or the workspace defaults, and kept
 * on its row (`reminder_*` columns; `maxCount` 0 = no automatic reminders).
 */

import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { masterSchema, schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { isValidEmail } from '@weldsuite/forms-engine';
import { formDefinitionSchema } from '@weldsuite/forms-engine/definition';
import {
  FORM_LIMITS,
  type CreateFormInvitationsInput,
  type CreateFormInvitationsResult,
  type FormInvitation,
  type FormInvitationStats,
  type InvitationReminders,
  type ListFormInvitationsQuery,
  type RemindFormInvitationsResult,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { sha256Hex } from '../lib/crypto';
import { FormsError, notFound } from '../lib/errors';
import type { WorkspaceCtx } from './context';
import { settingsOf, type FormRow } from './forms';
import { memberRef } from './members';
import { invitationUrl, reserveOutboundMail, sendInvitationMails, settleOutboundMail, type InviteMail } from './mail';
import { loadUsage, overQuota } from './usage';

const { formInvitations, formResponses, formSettings, formVersions, forms, workspaceMembers, people, lists, listMembers } = schema;
const { formInvitationRegistry } = masterSchema;

type InvitationRow = typeof formInvitations.$inferSelect;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Live statuses: the person has not completed and the link was not revoked. */
const LIVE = ['sent', 'opened', 'started'] as const;
/** After the guard refuses a reminder, or its mail could not be sent, the sweep tries again later. */
const REFUSED_RETRY_MS = 6 * HOUR_MS;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toInvitationDto(row: InvitationRow): FormInvitation {
  return {
    id: row.id,
    formId: row.formId,
    email: row.email,
    name: row.name,
    personId: row.personId,
    userId: row.userId,
    locale: row.locale as FormInvitation['locale'],
    status: row.status,
    remindersSent: row.remindersSent,
    responseId: row.responseId,
    sentAt: iso(row.sentAt),
    openedAt: iso(row.openedAt),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    lastRemindedAt: iso(row.lastRemindedAt),
    nextReminderAt: iso(row.nextReminderAt),
    revokedAt: iso(row.revokedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** 32 random bytes as 64 hex characters: what goes in the link. */
export function newInvitationToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function registerToken(ctx: Pick<WorkspaceCtx, 'master' | 'workspaceId' | 'clerkOrgId'>, formId: string, invitationId: string, token: string): Promise<void> {
  await ctx.master.insert(formInvitationRegistry).values({
    id: generateId('fir'),
    tokenHash: await sha256Hex(token),
    workspaceId: ctx.workspaceId,
    clerkOrgId: ctx.clerkOrgId,
    formId,
    invitationId,
  });
}

/** Takes tokens out of the registry again: their links were never sent. */
async function forgetTokens(ctx: Pick<WorkspaceCtx, 'master' | 'workspaceId'>, tokens: readonly string[]): Promise<void> {
  if (tokens.length === 0) return;
  const hashes = await Promise.all(tokens.map((t) => sha256Hex(t)));
  await ctx.master.delete(formInvitationRegistry).where(and(eq(formInvitationRegistry.workspaceId, ctx.workspaceId), inArray(formInvitationRegistry.tokenHash, hashes)));
}

// ---------------------------------------------------------------------------
// Reminder schedule
// ---------------------------------------------------------------------------

export interface ReminderPlan {
  afterDays: number;
  everyDays: number;
  maxCount: number;
}

/** The workspace defaults, or null when it has no automatic reminders. */
export async function workspaceReminderPlan(ctx: Pick<WorkspaceCtx, 'db'>): Promise<ReminderPlan | null> {
  const [row] = await ctx.db.select().from(formSettings).limit(1);
  if (!row?.reminderAfterDays || row.reminderMaxCount <= 0) return null;
  return { afterDays: row.reminderAfterDays, everyDays: row.reminderEveryDays ?? row.reminderAfterDays, maxCount: row.reminderMaxCount };
}

const fromInput = (r: InvitationReminders): ReminderPlan | null => (r.maxCount > 0 ? { afterDays: r.afterDays, everyDays: r.everyDays, maxCount: r.maxCount } : null);

/** The schedule an invitation was sent with; null when it gets no automatic reminders. */
function planOf(row: { reminderAfterDays: number | null; reminderEveryDays: number | null; reminderMaxCount: number }): ReminderPlan | null {
  if (row.reminderMaxCount <= 0 || !row.reminderAfterDays) return null;
  return { afterDays: row.reminderAfterDays, everyDays: row.reminderEveryDays ?? row.reminderAfterDays, maxCount: row.reminderMaxCount };
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

interface Candidate {
  email: string;
  name: string | null;
  personId: string | null;
  userId: string | null;
}

type Skip = CreateFormInvitationsResult['skipped'][number];
type Recipients = CreateFormInvitationsInput['recipients'];
type CrmPerson = { id: string; email: string | null; name: string };

/** Workspace members by user id; one without an email address is skipped. */
async function memberRecipients(ctx: Pick<WorkspaceCtx, 'db'>, userIds: string[], candidates: Candidate[], skipped: Skip[]): Promise<void> {
  const rows = await ctx.db
    .select({ userId: workspaceMembers.userId, email: workspaceMembers.email, name: workspaceMembers.name })
    .from(workspaceMembers)
    .where(and(inArray(workspaceMembers.userId, userIds), isNull(workspaceMembers.deletedAt)));
  const byId = new Map(rows.map((r) => [r.userId, r]));
  for (const id of userIds) {
    const row = byId.get(id);
    if (row?.email) candidates.push({ email: row.email, name: row.name ?? null, personId: null, userId: id });
    else skipped.push({ email: id, reason: 'no_email' });
  }
}

/** The people of a static CRM list of people; 404 for an unknown list, 422 for any other kind. */
async function listRecipients(ctx: Pick<WorkspaceCtx, 'db'>, listId: string): Promise<CrmPerson[]> {
  const [list] = await ctx.db.select().from(lists).where(and(eq(lists.id, listId), isNull(lists.deletedAt))).limit(1);
  if (!list) throw notFound('List');
  if (list.kind !== 'person') throw new FormsError(422, 'LIST_NOT_PEOPLE', 'Pick a list of people.');
  if (list.type !== 'static') throw new FormsError(422, 'LIST_NOT_STATIC', 'Smart lists cannot be used here yet. Pick a list you fill by hand.');
  return ctx.db
    .select({ id: people.id, email: people.email, name: people.displayName })
    .from(listMembers)
    .innerJoin(people, eq(people.id, listMembers.entityId))
    .where(and(eq(listMembers.listId, list.id), isNull(people.deletedAt)));
}

/** CRM people by id, added to `found`; an unknown id is skipped. */
async function peopleRecipients(ctx: Pick<WorkspaceCtx, 'db'>, personIds: string[], found: CrmPerson[], skipped: Skip[]): Promise<void> {
  const rows = await ctx.db
    .select({ id: people.id, email: people.email, name: people.displayName })
    .from(people)
    .where(and(inArray(people.id, personIds), isNull(people.deletedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of personIds) {
    const row = byId.get(id);
    if (row) found.push(row);
    else skipped.push({ email: id, reason: 'no_email' });
  }
}

async function resolveRecipients(ctx: Pick<WorkspaceCtx, 'db'>, recipients: Recipients): Promise<{ candidates: Candidate[]; skipped: Skip[] }> {
  const candidates: Candidate[] = [];
  const skipped: Skip[] = [];

  for (const e of recipients.emails ?? []) candidates.push({ email: e.email, name: e.name ?? null, personId: null, userId: null });
  if (recipients.userIds?.length) await memberRecipients(ctx, recipients.userIds, candidates, skipped);

  const personIds = [...(recipients.personIds ?? [])];
  const crmPeople = recipients.listId ? await listRecipients(ctx, recipients.listId) : [];
  if (personIds.length) await peopleRecipients(ctx, personIds, crmPeople, skipped);
  for (const p of crmPeople) {
    if (p.email) candidates.push({ email: p.email, name: p.name || null, personId: p.id, userId: null });
    else skipped.push({ email: p.name || p.id, reason: 'no_email' });
  }
  return { candidates, skipped };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreatedInvitations {
  result: CreateFormInvitationsResult;
  created: InvitationRow[];
  /** Earliest automatic reminder, to mark the workspace due. */
  nextReminderAt: Date | null;
}

/** 409 unless the form is published (it needs a public link) and open. */
function assertInvitable(form: FormRow, now: Date): void {
  const settings = settingsOf(form);
  if (form.status !== 'published' || !form.publicId) throw new FormsError(409, 'FORM_NOT_LIVE', 'Publish the form before inviting people.');
  if (settings.closesAt && new Date(settings.closesAt) <= now) throw new FormsError(409, 'FORM_CLOSED', 'The form is past its close date.');
}

export async function createInvitations(
  ctx: WorkspaceCtx,
  form: FormRow,
  userId: string,
  input: CreateFormInvitationsInput,
  now = new Date(),
): Promise<CreatedInvitations> {
  assertInvitable(form, now);
  if (overQuota(await loadUsage(ctx, now))) throw new FormsError(409, 'OVER_QUOTA', 'This workspace used its monthly response quota, so the form is not accepting responses.');

  const { candidates, skipped } = await resolveRecipients(ctx, input.recipients);
  if (candidates.length + skipped.length > FORM_LIMITS.maxInvitationsPerBatch) {
    throw new FormsError(422, 'TOO_MANY_RECIPIENTS', `At most ${FORM_LIMITS.maxInvitationsPerBatch} people can be invited at once.`);
  }

  const known = await invitedEmails(ctx, form.id);
  const answered = settingsOf(form).onePerRespondent ? await respondedEmails(ctx, form.id) : new Set<string>();
  const fresh = freshCandidates(candidates, known, answered, skipped);
  if (fresh.length === 0) return { result: { created: 0, skipped }, created: [], nextReminderAt: null };

  const language = await formLanguage(ctx, form);
  const locale = input.locale ?? language;

  // The guard decides on the whole batch before anything is written.
  const reservation = await reserveOutboundMail(ctx.env, ctx.db, ctx.clerkOrgId, {
    to: fresh.map((c) => c.email),
    names: fresh.map((c) => c.name ?? '').filter(Boolean),
    subjectLine: input.subject ?? form.title,
    text: input.message ?? null,
  });
  if (reservation === 'refused') {
    throw new FormsError(422, 'EMAIL_REFUSED', 'Your workspace cannot send these emails right now. Nothing was sent.');
  }

  const plan = await chosenPlan(ctx, input.reminders);
  const rows = fresh.map((c) => ({
    id: generateId('fin'),
    formId: form.id,
    email: c.email,
    name: c.name,
    personId: c.personId,
    userId: c.userId,
    locale,
    status: 'sent' as const,
    subject: input.subject ?? null,
    message: input.message ?? null,
    reminderAfterDays: plan?.afterDays ?? null,
    reminderEveryDays: plan?.everyDays ?? null,
    reminderMaxCount: plan?.maxCount ?? 0,
    invitedByUserId: userId,
  }));
  const tokens = new Map(rows.map((r) => [r.id, newInvitationToken()]));
  await atomically(ctx.db, (db) => [db.insert(formInvitations).values(rows)]);
  for (const r of rows) await registerToken(ctx, form.id, r.id, tokens.get(r.id)!);

  const mail = await sendInvitationMails(
    { ...ctx, form, definition: null, senderEmail: (await memberRef(ctx.db, userId)).email, closesAt: settingsOf(form).closesAt },
    rows.map((r): InviteMail => ({ email: r.email, name: r.name, locale: r.locale, url: invitationUrl(ctx.env, form.publicId!, tokens.get(r.id)!), subject: r.subject, message: r.message })),
    { reservation },
  );
  const sentTo = new Set(mail === 'refused' ? [] : mail.map((e) => e.toLowerCase()));

  const next = plan ? new Date(now.getTime() + plan.afterDays * DAY_MS) : null;
  const created = await keepSent(ctx, rows, sentTo, { sentAt: now, next }, skipped);
  return { result: { created: created.length, skipped }, created, nextReminderAt: created.length ? next : null };
}

/** The addresses already invited to the form (revoked invitations aside), lower-cased, with their status. */
async function invitedEmails(ctx: Pick<WorkspaceCtx, 'db'>, formId: string): Promise<Map<string, InvitationRow['status']>> {
  const existing = await ctx.db
    .select({ email: formInvitations.email, status: formInvitations.status })
    .from(formInvitations)
    .where(and(eq(formInvitations.formId, formId), sql`${formInvitations.status} <> 'revoked'`));
  return new Map(existing.map((e) => [e.email.toLowerCase(), e.status]));
}

/** The addresses that completed the form, lower-cased. */
async function respondedEmails(ctx: Pick<WorkspaceCtx, 'db'>, formId: string): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ email: formResponses.respondentEmail })
    .from(formResponses)
    .where(and(eq(formResponses.formId, formId), eq(formResponses.status, 'completed')));
  return new Set(rows.map((r) => r.email?.toLowerCase()).filter((e): e is string => Boolean(e)));
}

/** The candidates to invite now, each address once; the others go to `skipped` with the reason. */
function freshCandidates(candidates: readonly Candidate[], known: ReadonlyMap<string, string>, answered: ReadonlySet<string>, skipped: Skip[]): Candidate[] {
  const fresh: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const email = c.email.trim().toLowerCase();
    if (!isValidEmail(email)) skipped.push({ email: c.email, reason: 'invalid' });
    else if (known.get(email) === 'completed' || answered.has(email)) skipped.push({ email, reason: 'already_responded' });
    else if (known.has(email) || seen.has(email)) skipped.push({ email, reason: 'duplicate' });
    else {
      seen.add(email);
      fresh.push({ ...c, email });
    }
  }
  return fresh;
}

/** The language of the published version, which the invitation mails default to. */
async function formLanguage(ctx: Pick<WorkspaceCtx, 'db'>, form: FormRow): Promise<string> {
  const definition = form.publishedVersionId
    ? await ctx.db.select({ definition: formVersions.definition }).from(formVersions).where(eq(formVersions.id, form.publishedVersionId)).limit(1)
    : [];
  return definition[0] ? formDefinitionSchema.parse(definition[0].definition).presentation.language : 'en';
}

/** The reminder schedule of a new batch: the request's, none (`null`), or the workspace defaults (not given). */
async function chosenPlan(ctx: Pick<WorkspaceCtx, 'db'>, reminders: CreateFormInvitationsInput['reminders']): Promise<ReminderPlan | null> {
  if (reminders === undefined) return workspaceReminderPlan(ctx);
  if (reminders === null) return null;
  return fromInput(reminders);
}

/**
 * Marks the invitations whose mail went out as sent and removes the others:
 * the person is not invited, so no half-made invitation is left. Returns the
 * sent ones, oldest first.
 */
async function keepSent(
  ctx: WorkspaceCtx,
  rows: ReadonlyArray<{ id: string; email: string }>,
  sentTo: ReadonlySet<string>,
  opts: { sentAt: Date; next: Date | null },
  skipped: Skip[],
): Promise<InvitationRow[]> {
  const { sentAt, next } = opts;
  const ok = rows.filter((r) => sentTo.has(r.email));
  const failed = rows.filter((r) => !sentTo.has(r.email));
  if (ok.length > 0) {
    await ctx.db.update(formInvitations).set({ sentAt, nextReminderAt: next, updatedAt: sentAt }).where(inArray(formInvitations.id, ok.map((r) => r.id)));
  }
  if (failed.length > 0) {
    await ctx.db.delete(formInvitations).where(inArray(formInvitations.id, failed.map((r) => r.id)));
    await ctx.master.delete(formInvitationRegistry).where(and(eq(formInvitationRegistry.workspaceId, ctx.workspaceId), inArray(formInvitationRegistry.invitationId, failed.map((r) => r.id))));
    for (const r of failed) skipped.push({ email: r.email, reason: 'invalid' });
  }
  if (ok.length === 0) return [];
  return ctx.db.select().from(formInvitations).where(inArray(formInvitations.id, ok.map((r) => r.id))).orderBy(asc(formInvitations.createdAt));
}

// ---------------------------------------------------------------------------
// List, stats
// ---------------------------------------------------------------------------

/** `%`, `_` and `\` taken literally in a LIKE pattern. */
const escapeLike = (text: string) => text.replace(/[%_\\]/g, (m) => `\\${m}`);
const likePattern = (text: string) => `%${escapeLike(text)}%`;

export async function listInvitations(
  ctx: Pick<WorkspaceCtx, 'db'>,
  formId: string,
  query: ListFormInvitationsQuery,
): Promise<{ rows: FormInvitation[]; total: number; next: string | null }> {
  const conditions: SQL[] = [eq(formInvitations.formId, formId)];
  if (query.status) conditions.push(eq(formInvitations.status, query.status));
  if (query.q?.trim()) conditions.push(or(sql`${formInvitations.email} ilike ${likePattern(query.q.trim())}`, sql`${formInvitations.name} ilike ${likePattern(query.q.trim())}`)!);
  const where = and(...conditions);
  const limit = query.limit ?? 50;
  const offset = query.cursor ? Math.max(0, Number(query.cursor) || 0) : 0;
  const [rows, [count]] = await Promise.all([
    ctx.db.select().from(formInvitations).where(where).orderBy(desc(formInvitations.createdAt), desc(formInvitations.id)).limit(limit).offset(offset),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(formInvitations).where(where),
  ]);
  const total = Number(count?.n ?? 0);
  const next = offset + rows.length;
  return { rows: rows.map(toInvitationDto), total, next: next < total ? String(next) : null };
}

export async function invitationStats(ctx: Pick<WorkspaceCtx, 'db'>, formId: string): Promise<FormInvitationStats> {
  const rows = await ctx.db
    .select({ status: formInvitations.status, n: sql<number>`count(*)::int` })
    .from(formInvitations)
    .where(eq(formInvitations.formId, formId))
    .groupBy(formInvitations.status);
  const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
  const stats = { sent: by.get('sent') ?? 0, opened: by.get('opened') ?? 0, started: by.get('started') ?? 0, completed: by.get('completed') ?? 0, revoked: by.get('revoked') ?? 0 };
  return { total: stats.sent + stats.opened + stats.started + stats.completed + stats.revoked, ...stats };
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export interface RemindOutcome {
  reminded: InvitationRow[];
  skipped: number;
  /** Earliest next automatic reminder among those reminded. */
  nextReminderAt: Date | null;
}

/**
 * Sends reminders to the given invitations of one form: a fresh link each, the
 * guard checked on the batch, the counters and the next reminder updated.
 * `replyTo`: the member who asked, or each invitation's inviter (the sweep).
 */
async function remindBatch(
  ctx: WorkspaceCtx,
  form: FormRow,
  rows: InvitationRow[],
  opts: { replyToUserId: string | null; now: Date; defaults: ReminderPlan | null },
): Promise<{ outcome: RemindOutcome; refused: boolean }> {
  if (rows.length === 0) return { outcome: { reminded: [], skipped: 0, nextReminderAt: null }, refused: false };
  const settings = settingsOf(form);
  const reservation = await reserveOutboundMail(ctx.env, ctx.db, ctx.clerkOrgId, { to: rows.map((r) => r.email), names: rows.map((r) => r.name ?? '').filter(Boolean), subjectLine: form.title });
  if (reservation === 'refused') return { outcome: { reminded: [], skipped: rows.length, nextReminderAt: null }, refused: true };

  const tokens = new Map(rows.map((r) => [r.id, newInvitationToken()]));
  for (const r of rows) await registerToken(ctx, form.id, r.id, tokens.get(r.id)!);

  const sentTo = new Set<string>();
  for (const [sender, group] of groupBySender(rows, opts.replyToUserId)) {
    const mail = await sendInvitationMails(
      { ...ctx, form, definition: null, senderEmail: (await memberRef(ctx.db, sender)).email, closesAt: settings.closesAt },
      group.map((r): InviteMail => ({ email: r.email, name: r.name, locale: r.locale, url: invitationUrl(ctx.env, form.publicId!, tokens.get(r.id)!), subject: r.subject, message: r.message })),
      { reminder: true, reservation: null },
    );
    if (mail !== 'refused') for (const e of mail) sentTo.add(e.toLowerCase());
  }
  // `reservation: null` above: the batch was reserved once, here, and is settled once.
  const sent = rows.filter((r) => sentTo.has(r.email.toLowerCase()));
  await settleOutboundMail(ctx.env, ctx.db, reservation, sent.map((r) => r.email), rows.length);
  // A link whose mail did not go out is not kept: nobody has it, and a retry mints its own.
  const unsent = rows.filter((r) => !sentTo.has(r.email.toLowerCase()));
  await forgetTokens(ctx, unsent.map((r) => tokens.get(r.id)!));

  const nextAny = await recordReminders(ctx, sent, opts.now);
  const updated = sent.length ? await ctx.db.select().from(formInvitations).where(inArray(formInvitations.id, sent.map((r) => r.id))) : [];
  return { outcome: { reminded: updated, skipped: rows.length - sent.length, nextReminderAt: nextAny }, refused: false };
}

/** The invitations by who the mail is from: one mail call per sender, so Reply-To is the person who invited. */
function groupBySender(rows: readonly InvitationRow[], replyToUserId: string | null): Map<string, InvitationRow[]> {
  const groups = new Map<string, InvitationRow[]>();
  for (const r of rows) {
    const key = replyToUserId ?? r.invitedByUserId;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return groups;
}

/** Counts the reminder on each invitation and schedules its next one; returns the earliest next reminder. */
async function recordReminders(ctx: Pick<WorkspaceCtx, 'db'>, sent: readonly InvitationRow[], now: Date): Promise<Date | null> {
  let nextAny: Date | null = null;
  for (const r of sent) {
    const plan = planOf(r);
    const count = r.remindersSent + 1;
    const next = plan && count < plan.maxCount ? new Date(now.getTime() + plan.everyDays * DAY_MS) : null;
    await ctx.db.update(formInvitations).set({ remindersSent: count, lastRemindedAt: now, nextReminderAt: next, updatedAt: now }).where(eq(formInvitations.id, r.id));
    if (next && (!nextAny || next < nextAny)) nextAny = next;
  }
  return nextAny;
}

/**
 * "Remind everyone who has not answered" (or the given invitations). Anyone
 * emailed in the last hour is skipped. 409 when the form no longer takes responses.
 */
export async function remindInvitations(
  ctx: WorkspaceCtx,
  form: FormRow,
  userId: string,
  invitationIds: string[] | undefined,
  now = new Date(),
): Promise<RemindOutcome & { result: RemindFormInvitationsResult }> {
  assertInvitable(form, now);
  const where = and(eq(formInvitations.formId, form.id), inArray(formInvitations.status, [...LIVE]), invitationIds?.length ? inArray(formInvitations.id, invitationIds) : undefined);
  const rows = await ctx.db.select().from(formInvitations).where(where).orderBy(asc(formInvitations.createdAt));
  const cutoff = now.getTime() - HOUR_MS;
  const due = rows.filter((r) => (r.lastRemindedAt ?? r.sentAt ?? r.createdAt).getTime() <= cutoff);
  const defaults = await workspaceReminderPlan(ctx);
  const { outcome, refused } = await remindBatch(ctx, form, due, { replyToUserId: userId, now, defaults });
  if (refused) throw new FormsError(422, 'EMAIL_REFUSED', 'Your workspace cannot send these emails right now. Nothing was sent.');
  const skipped = rows.length - outcome.reminded.length;
  return { ...outcome, skipped, result: { reminded: outcome.reminded.length, skipped } };
}

/** Closes the invitation: every link of it stops working. 409 when the person already completed. */
export async function revokeInvitation(ctx: WorkspaceCtx, formId: string, invitationId: string, now = new Date()): Promise<InvitationRow> {
  const [row] = await ctx.db.select().from(formInvitations).where(and(eq(formInvitations.id, invitationId), eq(formInvitations.formId, formId))).limit(1);
  if (!row) throw notFound('Invitation');
  if (row.status === 'completed') throw new FormsError(409, 'ALREADY_COMPLETED', 'This person already completed the form.');
  if (row.status === 'revoked') return row;
  const [updated] = await ctx.db
    .update(formInvitations)
    .set({ status: 'revoked', revokedAt: now, nextReminderAt: null, updatedAt: now })
    .where(eq(formInvitations.id, row.id))
    .returning();
  await ctx.master
    .update(formInvitationRegistry)
    .set({ revokedAt: now })
    .where(and(eq(formInvitationRegistry.workspaceId, ctx.workspaceId), eq(formInvitationRegistry.invitationId, row.id), isNull(formInvitationRegistry.revokedAt)));
  return updated!;
}

// ---------------------------------------------------------------------------
// The sweep: automatic reminders
// ---------------------------------------------------------------------------

export interface SweepResult {
  reminded: InvitationRow[];
  /** When this workspace next has a reminder due, or null. */
  next: Date | null;
}

/** Whether a form still takes responses (published, before its close date). */
const takesResponses = (form: FormRow, now: Date) => {
  const settings = settingsOf(form);
  return form.status === 'published' && Boolean(form.publicId) && !(settings.closesAt && new Date(settings.closesAt) <= now);
};

/**
 * Sends the reminders that are due in this workspace and tells when the next
 * one is. Never after the form's close date or once the person completed
 * (those invitations lose their `next_reminder_at`).
 */
export async function sendDueReminders(ctx: WorkspaceCtx, now = new Date()): Promise<SweepResult> {
  const due = await ctx.db
    .select()
    .from(formInvitations)
    .where(and(inArray(formInvitations.status, [...LIVE]), lte(formInvitations.nextReminderAt, now)))
    .orderBy(asc(formInvitations.nextReminderAt));
  const defaults = await workspaceReminderPlan(ctx);
  const reminded: InvitationRow[] = [];

  const byForm = new Map<string, InvitationRow[]>();
  for (const r of due) byForm.set(r.formId, [...(byForm.get(r.formId) ?? []), r]);
  for (const [formId, rows] of byForm) {
    const [form] = await ctx.db.select().from(forms).where(eq(forms.id, formId)).limit(1);
    if (!form || !takesResponses(form, now)) {
      await ctx.db.update(formInvitations).set({ nextReminderAt: null, updatedAt: now }).where(inArray(formInvitations.id, rows.map((r) => r.id)));
      continue;
    }
    const { outcome } = await remindBatch(ctx, form, rows, { replyToUserId: null, now, defaults });
    reminded.push(...outcome.reminded);
    // Refused by the guard or not sent (the provider said no, or no transport): tried
    // again later, not on every tick, and with nothing kept from this attempt.
    const done = new Set(outcome.reminded.map((r) => r.id));
    const unsent = rows.filter((r) => !done.has(r.id));
    if (unsent.length > 0) {
      await ctx.db.update(formInvitations).set({ nextReminderAt: new Date(now.getTime() + REFUSED_RETRY_MS), updatedAt: now }).where(inArray(formInvitations.id, unsent.map((r) => r.id)));
    }
  }

  const [upcoming] = await ctx.db
    .select({ at: sql<Date | null>`min(${formInvitations.nextReminderAt})` })
    .from(formInvitations)
    .where(and(inArray(formInvitations.status, [...LIVE]), sql`${formInvitations.nextReminderAt} is not null`));
  return { reminded, next: upcoming?.at ? new Date(upcoming.at) : null };
}
