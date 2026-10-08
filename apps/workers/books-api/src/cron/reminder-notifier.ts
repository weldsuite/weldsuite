/**
 * Delivery of tax reminders: an in-app notification per member.
 *
 * It writes the same `notifications` row and publishes the same
 * `notification:created` event on the REALTIME service binding as the in-app
 * channel of `@weldsuite/notifications`. books-api does not depend on that
 * package yet (it needs the dependency and the `jsx` compiler option its email
 * templates require), so email and push are not sent from here. To get them,
 * add `@weldsuite/notifications` to books-api and replace `send` with
 * `createAndDeliverNotification` (category `weldbooks`, `actionUrl`,
 * `entityType`, `entityId` and `severity` map one to one); `runTaxReminders`
 * does not change.
 */

import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env } from '../types';
import type { ReminderNotice, ReminderNotifier } from './tax-reminders';

export const REMINDER_CATEGORY = 'weldbooks';

function notificationTypeOf(notice: ReminderNotice): string {
  switch (notice.data?.kind) {
    case 'sales_tax_due':
      return 'sales_tax_due';
    case 'certificate_expiring':
      return 'certificate_expiring';
    case 'nexus_exceeded':
      return 'nexus_exceeded';
    default:
      return 'tax_deadline';
  }
}

/** In-app notifications in the tenant DB, pushed live over the REALTIME binding (when bound). */
export function createInAppNotifier(db: Database, env: Pick<Env, 'REALTIME'>, workspaceId: string): ReminderNotifier {
  return {
    async send(userId, notice) {
      const id = generateId('notif');
      const now = new Date();
      const notificationType = notificationTypeOf(notice);
      await db.insert(schema.notifications).values({
        id,
        userId,
        title: notice.title.slice(0, 255),
        body: notice.body,
        category: REMINDER_CATEGORY,
        notificationType,
        entityType: notice.entityType.slice(0, 50),
        entityId: notice.entityId.slice(0, 30),
        actionUrl: notice.actionUrl,
        actorType: 'system',
        severity: notice.severity,
        data: notice.data ?? null,
        deliveredInApp: true,
        createdAt: now,
      });
      if (!env.REALTIME) return;
      try {
        const res = await env.REALTIME.fetch('https://internal/publish/workspace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            topic: `notification.${userId}`,
            event: 'created',
            userId: 'system',
            data: {
              id,
              title: notice.title,
              body: notice.body,
              category: REMINDER_CATEGORY,
              notificationType,
              actionUrl: notice.actionUrl,
              entityType: notice.entityType,
              entityId: notice.entityId,
              createdAt: now.toISOString(),
              isRead: false,
              severity: notice.severity,
              actorType: 'system',
              actorId: null,
              _access: { userIds: [userId] },
            },
          }),
        });
        if (!res.ok) console.warn(`[tax-reminders] realtime publish answered ${res.status}`);
      } catch (err) {
        // The row is saved: the member sees it on the next load.
        console.warn('[tax-reminders] realtime publish failed:', err instanceof Error ? err.message : err);
      }
    },
  };
}
