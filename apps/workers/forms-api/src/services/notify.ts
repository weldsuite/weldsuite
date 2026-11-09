/**
 * Telling members about responses: instant subscribers get a platform
 * notification (with the `forms.response` email through the notifications
 * orchestrator, which gates it on presence and the member's preferences,
 * EVT-008); daily subscribers get the digest (`./digest.ts`). The owner is
 * subscribed on create.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { createAndDeliverNotification } from '@weldsuite/notifications';
import type { NotificationEnv, Database as NotificationDb } from '@weldsuite/notifications/types';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { FormDefinition } from '@weldsuite/forms-engine/definition';
import type { Env } from '../types';
import { resultsUrl, type MemberRecipient } from './mail';
import { answerPairs, hasSensitiveFields } from './response-text';

const { formSubscriptions, formAccess, workspaceMembers } = schema;

type FormRow = typeof schema.forms.$inferSelect;
type ResponseRow = typeof schema.formResponses.$inferSelect;

/** Members following the form in `mode`; on a restricted form only those who may still see it (owner, access list). */
export async function subscribersOf(db: Database, form: FormRow, mode: 'instant' | 'daily'): Promise<MemberRecipient[]> {
  const subs = await db.select({ userId: formSubscriptions.userId }).from(formSubscriptions).where(and(eq(formSubscriptions.formId, form.id), eq(formSubscriptions.mode, mode)));
  let userIds = subs.map((s) => s.userId);
  if (userIds.length > 0 && form.access === 'restricted') {
    const allowed = new Set([form.ownerUserId, ...(await db.select({ userId: formAccess.userId }).from(formAccess).where(eq(formAccess.formId, form.id))).map((a) => a.userId)]);
    userIds = userIds.filter((id) => allowed.has(id));
  }
  if (userIds.length === 0) return [];
  const members = await db
    .select({ userId: workspaceMembers.userId, email: workspaceMembers.email, name: workspaceMembers.name })
    .from(workspaceMembers)
    .where(and(inArray(workspaceMembers.userId, userIds), isNull(workspaceMembers.deletedAt)));
  return members.filter((m): m is { userId: string; email: string; name: string | null } => Boolean(m.email)).map((m) => ({ userId: m.userId, email: m.email, name: m.name }));
}

/** The next 08:00 UTC after `now`: when the daily digest goes out. */
export function nextDigestAt(now: Date): Date {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0));
  return at.getTime() > now.getTime() ? at : new Date(at.getTime() + 24 * 60 * 60 * 1000);
}

export interface NotifyContext {
  env: Env;
  db: Database;
  clerkOrgId: string;
  form: FormRow;
  response: ResponseRow;
  definition: FormDefinition;
}

/** One platform notification per instant subscriber, and the digest marked due when anyone follows daily. */
export async function notifySubscribers(ctx: NotifyContext, now = new Date()): Promise<{ notified: number; digestDue: boolean }> {
  const { env, form, response, definition } = ctx;
  const [instant, daily] = await Promise.all([subscribersOf(ctx.db, form, 'instant'), subscribersOf(ctx.db, form, 'daily')]);

  const respondent = response.respondentEmail ?? null;
  const answers = hasSensitiveFields(definition) ? null : answerPairs(definition, response.answers, { skipSensitive: false });
  const actionUrl = `/weldforms/${form.id}/results?tab=responses&response=${response.id}`;
  const notificationEnv = { ...env, PUBLIC_APP_URL: env.PLATFORM_URL } as unknown as NotificationEnv;
  let notified = 0;
  for (const member of instant) {
    try {
      const id = await createAndDeliverNotification({
        db: ctx.db as unknown as NotificationDb,
        env: notificationEnv,
        workspaceId: ctx.clerkOrgId,
        clerkOrgId: ctx.clerkOrgId,
        userId: member.userId,
        title: `New response to "${form.title}"`,
        body: respondent ? `From ${respondent}` : 'Someone answered your form.',
        category: 'weldforms',
        notificationType: 'form_response',
        entityType: 'form_response',
        entityId: response.id,
        actionUrl,
        severity: 'info',
        actorType: 'system',
        email: {
          template: 'forms.response',
          props: { title: form.title, number: response.number, respondent, answers, url: resultsUrl(env, ctx.clerkOrgId, form.id, `tab=responses&response=${response.id}`) },
        },
        data: { formId: form.id, responseId: response.id },
      });
      if (id) notified += 1;
    } catch (err) {
      console.error(`[forms-api/notify] notifying ${member.userId} failed:`, err);
    }
  }

  if (daily.length > 0) await markWorkspaceDue(env.SCHEDULE_INDEX, 'forms_digest', ctx.clerkOrgId, nextDigestAt(now));
  return { notified, digestDue: daily.length > 0 };
}
