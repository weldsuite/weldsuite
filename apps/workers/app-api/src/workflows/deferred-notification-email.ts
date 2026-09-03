/**
 * DeferredNotificationEmailWorkflow — Cloudflare Workflow
 *
 * Holds a notification email back while the recipient might still come back,
 * the way Slack and Discord do. `createAndDeliverNotification` has already
 * established that the recipient was away when the notification fired; this
 * workflow sleeps for the defer window and then asks the two questions that
 * decide whether the mail is still worth sending:
 *
 *   1. Is the recipient still away? Someone who reconnected in the meantime is
 *      looking at the in-app notification, so mail would be noise.
 *   2. Is the notification still unread? Read on another device (mobile push,
 *      a second tab) counts as handled.
 *
 * Instance id is `email-<notificationId>`, so a retry of the dispatching
 * request cannot queue the same mail twice.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import {
  resolveEmailPresence,
  sendNotificationEmail,
  type DeferredEmailParams,
} from '@weldsuite/notifications';
import type { Env } from '../types';
import { getTenantDbForWorkspace, schema } from '../db';

export type DeferredNotificationEmailParams = DeferredEmailParams;

export class DeferredNotificationEmailWorkflow extends WorkflowEntrypoint<Env, DeferredNotificationEmailParams> {
  async run(event: WorkflowEvent<DeferredNotificationEmailParams>, step: WorkflowStep) {
    const { workspaceId, userId, notificationId, to, subject, fallbackText, sendAfter, template } =
      event.payload;

    await step.sleepUntil('wait-out-defer-window', new Date(sendAfter));

    await step.do('send-if-still-away', {
      retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const apiKey = this.env.RESEND_API_KEY;
      if (!apiKey) {
        console.log('[DeferredEmail] RESEND_API_KEY unset, skipping');
        return;
      }

      const db = await getTenantDbForWorkspace(this.env, workspaceId);

      // Read state first — it is the cheaper signal and the more decisive one.
      const [notification] = await db
        .select({ isRead: schema.notifications.isRead })
        .from(schema.notifications)
        .where(eq(schema.notifications.id, notificationId))
        .limit(1);

      if (!notification) {
        console.log(`[DeferredEmail] Notification ${notificationId} gone, skipping`);
        return;
      }

      if (notification.isRead) {
        console.log(`[DeferredEmail] Notification ${notificationId} already read, skipping`);
        await this.markNotEmailed(db, notificationId);
        return;
      }

      if ((await resolveEmailPresence(db, userId)) !== 'absent') {
        console.log(`[DeferredEmail] User ${userId} came back, skipping ${notificationId}`);
        await this.markNotEmailed(db, notificationId);
        return;
      }

      await sendNotificationEmail({ apiKey, to, subject, fallbackText, template });

      console.log(`[DeferredEmail] Sent ${notificationId} to a still-absent recipient`);
    });
  }

  /**
   * The row was written with `deliveredEmail: true` on the expectation that
   * this workflow would send. When it decides not to, correct the record so
   * the notification history does not claim an email the user never got.
   */
  private async markNotEmailed(
    db: Awaited<ReturnType<typeof getTenantDbForWorkspace>>,
    notificationId: string,
  ): Promise<void> {
    await db
      .update(schema.notifications)
      .set({ deliveredEmail: false })
      .where(eq(schema.notifications.id, notificationId));
  }
}
