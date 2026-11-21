/**
 * The daily digest: for each daily subscriber of each form, the completed
 * responses since their last digest (`form_subscriptions.last_digest_at`), in
 * one mail. Run by the `forms_digest` sweep around 08:00 UTC; a form with
 * sensitive fields lists who answered but never what.
 */

import { and, desc, eq, gt, lte, sql } from 'drizzle-orm';
import { formDefinitionSchema, type FormDefinition } from '@weldsuite/forms-engine/definition';
import { schema } from '@weldsuite/worker-kit/db';
import type { WorkspaceCtx } from './context';
import { sendDigestMail } from './mail';
import { subscribersOf } from './notify';
import { answerPairs, hasSensitiveFields } from './response-text';

const { forms, formVersions, formResponses, formSubscriptions } = schema;

const DAY_MS = 24 * 60 * 60 * 1000;
const LISTED = 10;
const SUMMARY_CHARS = 80;

type FormRow = typeof forms.$inferSelect;
type ResponseRow = typeof formResponses.$inferSelect;
type Member = Awaited<ReturnType<typeof subscribersOf>>[number];
type ListedResponse = { number: number | null; respondent: string | null; summary: string | null };

/** Digests due now; returns how many mails went out. */
export async function sendDueDigests(ctx: WorkspaceCtx, now = new Date()): Promise<number> {
  const withDaily = await ctx.db.select({ formId: formSubscriptions.formId }).from(formSubscriptions).where(eq(formSubscriptions.mode, 'daily')).groupBy(formSubscriptions.formId);
  let sent = 0;
  for (const { formId } of withDaily) sent += await sendFormDigests(ctx, formId, now);
  return sent;
}

/** The digests of one form, one per daily subscriber with something new; returns how many went out. */
async function sendFormDigests(ctx: WorkspaceCtx, formId: string, now: Date): Promise<number> {
  const [form] = await ctx.db.select().from(forms).where(eq(forms.id, formId)).limit(1);
  if (!form) return 0;
  const members = await subscribersOf(ctx.db, ctx.env, form, 'daily');
  if (members.length === 0) return 0;
  const marks = new Map(
    (await ctx.db.select({ userId: formSubscriptions.userId, at: formSubscriptions.lastDigestAt }).from(formSubscriptions).where(and(eq(formSubscriptions.formId, formId), eq(formSubscriptions.mode, 'daily')))).map((m) => [m.userId, m.at]),
  );
  const versions = new Map<string, FormDefinition>();

  let sent = 0;
  for (const member of members) {
    const since = marks.get(member.userId) ?? new Date(now.getTime() - DAY_MS);
    if (await sendMemberDigest(ctx, form, member, { since, now, versions })) sent += 1;
  }
  return sent;
}

/** One member's digest of the responses completed after `since`; true when it went out. */
async function sendMemberDigest(
  ctx: WorkspaceCtx,
  form: FormRow,
  member: Member,
  opts: { since: Date; now: Date; versions: Map<string, FormDefinition> },
): Promise<boolean> {
  const { since, now } = opts;
  const where = and(eq(formResponses.formId, form.id), eq(formResponses.status, 'completed'), gt(formResponses.submittedAt, since), lte(formResponses.submittedAt, now));
  const [[count], rows] = await Promise.all([
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(formResponses).where(where),
    ctx.db.select().from(formResponses).where(where).orderBy(desc(formResponses.submittedAt)).limit(LISTED),
  ]);
  const total = Number(count?.n ?? 0);
  if (total === 0) return false;

  const listed: ListedResponse[] = [];
  for (const r of rows) listed.push(listedResponse(r, await definitionOf(ctx, r.versionId, opts.versions)));
  if (!(await sendDigestMail(ctx, form, member, { count: total, responses: listed }))) return false;
  await ctx.db.update(formSubscriptions).set({ lastDigestAt: now, updatedAt: now }).where(and(eq(formSubscriptions.formId, form.id), eq(formSubscriptions.userId, member.userId)));
  return true;
}

/** A version's definition, read once per digest run. */
async function definitionOf(ctx: WorkspaceCtx, versionId: string, versions: Map<string, FormDefinition>): Promise<FormDefinition | undefined> {
  if (!versions.has(versionId)) {
    const [v] = await ctx.db.select({ definition: formVersions.definition }).from(formVersions).where(eq(formVersions.id, versionId)).limit(1);
    if (v) versions.set(versionId, formDefinitionSchema.parse(v.definition));
  }
  return versions.get(versionId);
}

/** A response as the digest lists it: its first answer, unless the form has sensitive fields. */
function listedResponse(r: ResponseRow, def: FormDefinition | undefined): ListedResponse {
  const first = def && !hasSensitiveFields(def) ? answerPairs(def, r.answers, { skipSensitive: false })[0] : undefined;
  return { number: r.number, respondent: r.respondentEmail, summary: first ? first.answer.slice(0, SUMMARY_CHARS) : null };
}
