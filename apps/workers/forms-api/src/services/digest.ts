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

/** Digests due now; returns how many mails went out. */
export async function sendDueDigests(ctx: WorkspaceCtx, now = new Date()): Promise<number> {
  const withDaily = await ctx.db.select({ formId: formSubscriptions.formId }).from(formSubscriptions).where(eq(formSubscriptions.mode, 'daily')).groupBy(formSubscriptions.formId);
  let sent = 0;
  for (const { formId } of withDaily) {
    const [form] = await ctx.db.select().from(forms).where(eq(forms.id, formId)).limit(1);
    if (!form) continue;
    const members = await subscribersOf(ctx.db, form, 'daily');
    if (members.length === 0) continue;
    const marks = new Map(
      (await ctx.db.select({ userId: formSubscriptions.userId, at: formSubscriptions.lastDigestAt }).from(formSubscriptions).where(and(eq(formSubscriptions.formId, formId), eq(formSubscriptions.mode, 'daily')))).map((m) => [m.userId, m.at]),
    );
    const versions = new Map<string, FormDefinition>();

    for (const member of members) {
      const since = marks.get(member.userId) ?? new Date(now.getTime() - DAY_MS);
      const where = and(eq(formResponses.formId, formId), eq(formResponses.status, 'completed'), gt(formResponses.submittedAt, since), lte(formResponses.submittedAt, now));
      const [[count], rows] = await Promise.all([
        ctx.db.select({ n: sql<number>`count(*)::int` }).from(formResponses).where(where),
        ctx.db.select().from(formResponses).where(where).orderBy(desc(formResponses.submittedAt)).limit(LISTED),
      ]);
      const total = Number(count?.n ?? 0);
      if (total === 0) continue;

      const listed: Array<{ number: number | null; respondent: string | null; summary: string | null }> = [];
      for (const r of rows) {
        if (!versions.has(r.versionId)) {
          const [v] = await ctx.db.select({ definition: formVersions.definition }).from(formVersions).where(eq(formVersions.id, r.versionId)).limit(1);
          if (v) versions.set(r.versionId, formDefinitionSchema.parse(v.definition));
        }
        const def = versions.get(r.versionId);
        const first = def && !hasSensitiveFields(def) ? answerPairs(def, r.answers, { skipSensitive: false })[0] : undefined;
        listed.push({ number: r.number, respondent: r.respondentEmail, summary: first ? first.answer.slice(0, SUMMARY_CHARS) : null });
      }
      if (await sendDigestMail(ctx, form, member, { count: total, responses: listed })) {
        sent += 1;
        await ctx.db.update(formSubscriptions).set({ lastDigestAt: now, updatedAt: now }).where(and(eq(formSubscriptions.formId, formId), eq(formSubscriptions.userId, member.userId)));
      }
    }
  }
  return sent;
}
