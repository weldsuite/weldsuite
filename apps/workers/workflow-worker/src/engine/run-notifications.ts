/**
 * In-app notifications for finished runs, driven by the workflow's settings:
 * `notifyOnError` (default ON, the settings page shows it enabled until it is
 * turned off) and `notifyOnComplete` (default OFF).
 *
 * Writes the `notifications` row straight into the tenant database, the same
 * way the `send_notification` action does, and pushes it to the recipient's live
 * topic through the realtime binding the run already uses. Email and push are
 * not sent from here: that is `@weldsuite/notifications`, which needs the
 * `SEND_EMAIL` binding and a `PUBLIC_APP_URL` this worker does not have.
 */

import { schema } from '../db';
import { generateId } from '../lib/id';
import type { WorkflowDb } from './types';

/** Realtime publisher surface needed to deliver a notification live. */
export interface NotifyRealtimeLike {
  notify(workspaceId: string, userId: string, notification: unknown): Promise<unknown> | unknown;
}

export interface RunNotificationInput {
  db: WorkflowDb;
  rt: NotifyRealtimeLike | null;
  workspaceId: string;
  executionId: string;
  workflowName: string;
  /** The workflow row's `settings` (may be null/absent on old workflows). */
  settings: { notifyOnError?: boolean; notifyOnComplete?: boolean } | null | undefined;
  /** Workflow owner (`workflows.created_by`). */
  createdBy: string | null | undefined;
  /** Who/what started the run: a user id, or `system` for schedules. */
  triggeredBy: string | null | undefined;
  succeeded: boolean;
  errorMessage?: string;
}

/** Whether the workflow's settings ask for a notification for this outcome. */
export function wantsNotification(settings: RunNotificationInput['settings'], succeeded: boolean): boolean {
  return succeeded ? settings?.notifyOnComplete === true : settings?.notifyOnError !== false;
}

/** The workflow owner, falling back to whoever triggered the run (never the `system` pseudo-user). */
export function notificationRecipient(
  createdBy: string | null | undefined,
  triggeredBy: string | null | undefined,
): string | null {
  const owner = createdBy?.trim();
  if (owner) return owner;
  const trigger = triggeredBy?.trim();
  return trigger && trigger !== 'system' ? trigger : null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Create (and push) the notification when the settings and outcome call for it. Never throws. */
export async function notifyRunFinished(input: RunNotificationInput): Promise<string | null> {
  try {
    if (!wantsNotification(input.settings, input.succeeded)) return null;
    const userId = notificationRecipient(input.createdBy, input.triggeredBy);
    if (!userId) return null;

    const id = generateId('notif');
    const now = new Date();
    const name = truncate(input.workflowName || 'Workflow', 150);
    const title = input.succeeded ? `Workflow completed: ${name}` : `Workflow failed: ${name}`;
    const body = input.succeeded
      ? 'The run finished successfully.'
      : truncate(input.errorMessage || 'The run failed.', 500);
    const actionUrl = `/weldconnect/executions/${input.executionId}`;
    const notificationType = input.succeeded ? 'workflow_completed' : 'workflow_failed';
    const severity = input.succeeded ? 'success' : 'error';

    await input.db.insert(schema.notifications).values({
      id,
      userId,
      title,
      body,
      category: 'system',
      notificationType,
      entityType: 'workflow_execution',
      entityId: input.executionId,
      actionUrl,
      actorType: 'system',
      icon: 'workflow',
      severity,
      isRead: false,
      deliveredInApp: true,
      deliveredEmail: false,
      deliveredPush: false,
      createdAt: now,
    });

    try {
      await input.rt?.notify(input.workspaceId, userId, {
        id,
        title,
        body,
        category: 'system',
        notificationType,
        actionUrl,
        entityType: 'workflow_execution',
        entityId: input.executionId,
        createdAt: now.toISOString(),
        isRead: false,
        severity,
        actorType: 'system',
        actorId: null,
      });
    } catch (err) {
      // The row is saved; the bell shows it on the next load.
      console.warn('[RunNotifications] live publish failed:', err);
    }
    return id;
  } catch (err) {
    console.error('[RunNotifications] failed:', err);
    return null;
  }
}
