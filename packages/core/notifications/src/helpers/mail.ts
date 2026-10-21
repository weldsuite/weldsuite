/**
 * New-email notification — fires when inbound mail lands in a workspace
 * mailbox a member can read, so it shows in the notification bell like every
 * other module.
 *
 * Email and push are always excluded here: mailing someone about a mail is
 * pointless, and the WeldMail app keeps its own richer push (sender, subject,
 * preview, account id for the deep link), sent by mail-inbound-worker after it
 * checks `getChannelPreferences(…, 'mail').push`.
 */

import { createAndDeliverNotification } from '../orchestrator';
import type { Database, NotificationEnv } from '../types';

interface NewEmailParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  /** Clerk org id of the workspace. */
  workspaceId: string;
  userId: string;
  accountId: string;
  messageId: string;
  fromName?: string | null;
  fromEmail: string;
  subject?: string | null;
  preview?: string | null;
}

export async function sendNewEmailNotification<Env extends NotificationEnv>(
  params: NewEmailParams<Env>,
): Promise<string | null> {
  const { db, env, workspaceId, userId, accountId, messageId, fromName, fromEmail, subject, preview } = params;
  const sender = fromName?.trim() || fromEmail;
  const body = (subject?.trim() || preview?.trim() || 'New email received').slice(0, 255);

  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId,
    title: `New email from ${sender}`.slice(0, 255),
    body,
    category: 'mail',
    notificationType: 'email_received',
    entityType: 'email',
    entityId: messageId,
    actionUrl: `/weldmail/${accountId}/inbox/${messageId}`,
    severity: 'info',
    actorType: 'system',
    actorId: null,
    excludeChannels: ['email', 'push'],
    data: { emailId: messageId, emailAccountId: accountId },
  });
}
