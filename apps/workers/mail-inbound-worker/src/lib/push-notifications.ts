/**
 * Push Notification Service for Mail Inbound Worker
 *
 * Sends push notifications to mobile devices when new emails arrive.
 * Queries device tokens from the tenant DB and sends via Expo Push API.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getTenantDbForWorkspaceById, tenantSchema } from '../db';
import {
  sendExpoPush,
  EXPO_PROJECT_IDS,
  type ExpoPushMessage,
  type SendExpoPushResult,
} from './expo-push';
import type { Env } from '../index';
import type { EmailAddress } from './email-storage';

/**
 * Expo ticket/receipt error codes that indicate the token is permanently
 * invalid and should be deactivated so we stop attempting delivery.
 */
const PERMANENT_TOKEN_ERROR_CODES = new Set([
  'DeviceNotRegistered',
  'MismatchSenderId',
  'InvalidCredentials',
]);

/**
 * Error codes that are transient payload/rate issues — log but don't deactivate.
 */
const TRANSIENT_ERROR_CODES = new Set(['MessageTooBig', 'MessageRateExceeded']);

interface NewEmailPushParams {
  userId: string;
  workspaceId: string;
  messageId: string;
  accountId: string;
  from: EmailAddress;
  subject: string;
  preview: string;
}

/**
 * Send push notifications for a new email to all of a user's registered devices.
 */
export async function sendNewEmailPushNotification(
  env: Env,
  params: NewEmailPushParams,
): Promise<SendExpoPushResult | null> {
  const { userId, workspaceId, messageId, accountId, from, subject, preview } = params;

  try {
    const tenantDb = await getTenantDbForWorkspaceById(env, workspaceId);

    // Get active weldmail-app device tokens for this user.
    // isActive IS NULL means active; a non-null value is the deactivation timestamp.
    // Scope to appCode='weldmail' so the integrated weldsuite-app (which has its
    // own realtime notification path) doesn't double-notify.
    const activeTokens = await tenantDb
      .select({
        token: tenantSchema.deviceTokens.token,
        tokenType: tenantSchema.deviceTokens.tokenType,
      })
      .from(tenantSchema.deviceTokens)
      .where(
        and(
          eq(tenantSchema.deviceTokens.userId, userId),
          eq(tenantSchema.deviceTokens.appCode, 'weldmail'),
          isNull(tenantSchema.deviceTokens.isActive),
        ),
      );

    if (activeTokens.length === 0) {
      return null;
    }

    const senderName = from.name || from.email;
    const title = `New email from ${senderName}`;
    const body = subject || preview || 'New email received';

    const messages: ExpoPushMessage[] = activeTokens.map((t) => ({
      to: t.token,
      title,
      body,
      sound: 'default' as const,
      priority: 'high' as const,
      channelId: 'email',
      data: {
        type: 'new_email',
        emailId: messageId,
        emailAccountId: accountId,
      },
    }));

    // Use the WeldMail EAS project ID so Expo uses the correct FCM/APNs credentials.
    const result = await sendExpoPush(messages, {
      projectId: EXPO_PROJECT_IDS.weldmail,
    });

    if (result.tickets.length > 0) {
      const ok = result.tickets.filter((t) => t.status === 'ok').length;
      const err = result.tickets.filter((t) => t.status === 'error').length;
      console.log(`[PushNotify] Sent to ${ok} device(s) for user ${userId} (${err} failed)`);
    }

    // Log transient / payload errors without touching the token.
    for (const ticket of result.tickets) {
      if (ticket.status === 'error') {
        const code = ticket.details?.error ?? 'Unknown';
        if (TRANSIENT_ERROR_CODES.has(code)) {
          console.warn(`[PushNotify] Transient push error for user ${userId}: ${code} — ${ticket.message ?? ''}`);
        }
      }
    }

    // Collect tokens to deactivate: DeviceNotRegistered (already in invalidTokens)
    // plus any additional permanent-failure codes in the ticket list.
    const tokensToDeactivate = new Set<string>(result.invalidTokens);

    result.tickets.forEach((ticket, idx) => {
      if (ticket.status === 'error') {
        const code = ticket.details?.error ?? '';
        if (
          PERMANENT_TOKEN_ERROR_CODES.has(code) &&
          code !== 'DeviceNotRegistered' // already in invalidTokens
        ) {
          const token = messages[idx]?.to;
          if (token) tokensToDeactivate.add(token);
        }
      }
    });

    if (tokensToDeactivate.size > 0) {
      console.log(`[PushNotify] Deactivating ${tokensToDeactivate.size} invalid token(s)`);
      for (const invalidToken of tokensToDeactivate) {
        try {
          await tenantDb
            .update(tenantSchema.deviceTokens)
            .set({ isActive: new Date() })
            .where(eq(tenantSchema.deviceTokens.token, invalidToken));
        } catch (err) {
          console.error(`[PushNotify] Failed to deactivate token:`, err);
        }
      }
    }

    if (result.receiptIds.length > 0) {
      console.log(
        `[PushNotify] ${result.receiptIds.length} receipt ID(s) available for later polling via checkExpoPushReceipts()`,
      );
    }

    return result;
  } catch (error) {
    console.error(`[PushNotify] Failed to send push for user ${userId}:`, error);
    return null;
  }
}
