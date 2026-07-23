/**
 * Multi-channel notification orchestrator — inserts a `notifications` row,
 * then fans out to realtime-worker (in-app), Resend (email), and Expo
 * (push) based on the recipient's resolved channel preferences.
 *
 * Each channel branch is wrapped in try/catch: a channel-level failure
 * never breaks the others, and never bubbles back to the caller (callers
 * dispatch this via `c.executionCtx.waitUntil(...)`).
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import { getChannelPreferences } from './preferences';
import { publishInAppNotification } from './channels/in-app';
import { sendNotificationEmail } from './channels/email';
import { sendExpoPush, type ExpoPushMessage } from './channels/push';
import type { CreateNotificationParams, NotificationEnv } from './types';

function generateNotificationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `notif_${timestamp}${random}`;
}

/**
 * Which app(s) a notification category should push to. A module notification
 * targets the module's standalone app AND the unified weldsuite app, but NOT
 * other modules' apps — otherwise every device of every installed app gets
 * spammed (and each app's token belongs to a different EAS project). Falls back
 * to the unified app only.
 */
const CATEGORY_APP_CODES: Record<string, string[]> = {
  weldchat: ['weldchat', 'weldsuite'],
  welddesk: ['welddesk', 'weldsuite'],
  weldmail: ['weldmail', 'weldsuite'],
  weldcrm: ['weldcrm', 'weldsuite'],
  weldflow: ['weldflow', 'weldsuite'],
  weldmeet: ['weldmeet', 'weldsuite'],
  weldbooks: ['weldbooks', 'weldsuite'],
};

function appCodesForCategory(category: string): string[] {
  return CATEGORY_APP_CODES[category] ?? ['weldsuite'];
}

/**
 * Map a notification to the Android channel + priority it should ring on. Calls
 * route to the high-importance `incoming_call` channel; other WeldChat
 * notifications to `chat`. Channel ids must match those the client app creates;
 * we only emit them for categories whose channels we know (weldchat).
 */
function androidDelivery(
  category: string,
  notificationType: string,
): { channelId?: string; priority: 'default' | 'high' } {
  if (notificationType === 'chat_incoming_call' || notificationType === 'chat_missed_call') {
    return { channelId: 'incoming_call', priority: 'high' };
  }
  if (category === 'weldchat') {
    return { channelId: 'chat', priority: 'default' };
  }
  return { priority: 'default' };
}

/**
 * Create a notification and deliver it via every enabled channel.
 * Returns the notification id, or `null` when all channels were skipped
 * (DND / module preferences fully off).
 */
export async function createAndDeliverNotification<Env extends NotificationEnv>(
  params: CreateNotificationParams<Env>,
): Promise<string | null> {
  const {
    db,
    env,
    workspaceId,
    userId,
    title,
    body,
    category,
    notificationType,
    entityType,
    entityId,
    actionUrl,
    severity,
    actorType,
    actorId,
    emailTemplate,
    excludeChannels,
  } = params;

  const channels = await getChannelPreferences(db, userId, category);

  // Subtractive channel exclusions — a notification may opt OUT of a channel
  // (e.g. call rings never email) regardless of the user's preferences. This
  // can only turn a channel off, never on.
  if (excludeChannels?.length) {
    for (const channel of excludeChannels) {
      channels[channel] = false;
    }
  }

  if (!channels.inApp && !channels.email && !channels.push) {
    return null;
  }

  const id = generateNotificationId();
  const now = new Date();

  await db.insert(schema.notifications).values({
    id,
    userId,
    title,
    body,
    category,
    notificationType,
    entityType,
    entityId,
    actionUrl,
    severity,
    actorType: actorType ?? null,
    actorId: actorId ?? null,
    deliveredInApp: channels.inApp,
    deliveredEmail: channels.email,
    deliveredPush: channels.push,
    createdAt: now,
  });

  if (channels.inApp) {
    try {
      await publishInAppNotification({
        realtime: env.REALTIME,
        workspaceId,
        userId,
        notification: { id, title, body, category, actionUrl, entityType, entityId },
      });
    } catch (err) {
      console.error('[Notifications] In-app publish failed:', err);
    }
  }

  if (channels.email && env.RESEND_API_KEY) {
    try {
      const [member] = await db
        .select({ email: schema.workspaceMembers.email })
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.userId, userId))
        .limit(1);

      if (member?.email) {
        await sendNotificationEmail({
          apiKey: env.RESEND_API_KEY,
          to: member.email,
          subject: title,
          fallbackText: body,
          template: emailTemplate,
        });
      }
    } catch (err) {
      console.error('[Notifications] Email send failed:', err);
    }
  }

  if (channels.push) {
    try {
      // Scope to ACTIVE tokens (isActive IS NULL) for the app(s) this category
      // targets — never fan a module notification to every app the user has
      // installed (wrong EAS project + cross-app spam) or to deactivated tokens.
      const appCodes = appCodesForCategory(category);
      const tokens = await db
        .select({ token: schema.deviceTokens.token })
        .from(schema.deviceTokens)
        .where(
          and(
            eq(schema.deviceTokens.userId, userId),
            isNull(schema.deviceTokens.isActive),
            inArray(schema.deviceTokens.appCode, appCodes),
          ),
        );

      const activeTokens = tokens.filter((t: { token: string | null }) => t.token);

      if (activeTokens.length > 0) {
        const { channelId, priority } = androidDelivery(category, notificationType);
        const messages: ExpoPushMessage[] = activeTokens.map((t: { token: string }) => ({
          to: t.token,
          title,
          body,
          sound: 'default',
          ...(channelId ? { channelId } : {}),
          priority,
          data: { actionUrl, entityType, entityId, notificationType },
        }));
        await sendExpoPush(messages);
      }
    } catch (err) {
      console.error('[Notifications] Push send failed:', err);
    }
  }

  return id;
}
