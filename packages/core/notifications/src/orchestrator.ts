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
import { resolveEmailPresence } from './presence';
import { publishInAppNotification } from './channels/in-app';
import { sendNotificationEmail } from './channels/email';
import { sendExpoPush, type ExpoPushMessage } from './channels/push';
import type { CreateNotificationParams, NotificationEnv } from './types';

/**
 * How long an absent recipient has to come back before the email goes out.
 * Two minutes matches Slack's default: long enough to absorb a reload, a
 * dropped tunnel or a walk to the kettle, short enough that a genuinely-away
 * colleague still hears about a mention while it is worth hearing about.
 */
export const EMAIL_DEFER_MINUTES = 2;

function randomBase36(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

function generateNotificationId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBase36(8);
  return `notif_${timestamp}${random}`;
}

/**
 * Which app(s) a notification category should push to. A module notification
 * targets the module's standalone app AND the unified weldsuite app, but NOT
 * other modules' apps — otherwise every device of every installed app gets
 * spammed (and each app's token belongs to a different EAS project). Falls back
 * to the unified app only.
 *
 * Legacy DB categories (`projects` / `task` / `crm` / `mail` / `helpdesk`) map
 * onto the standalone module apps that register tokens under their appCode.
 */
const CATEGORY_APP_CODES: Record<string, string[]> = {
  weldchat: ['weldchat', 'weldsuite'],
  welddesk: ['welddesk', 'weldsuite'],
  helpdesk: ['welddesk', 'weldsuite'],
  weldmail: ['weldmail', 'weldsuite'],
  mail: ['weldmail', 'weldsuite'],
  weldcrm: ['weldcrm', 'weldsuite'],
  crm: ['weldcrm', 'weldsuite'],
  weldflow: ['weldflow', 'weldsuite'],
  projects: ['weldflow', 'weldsuite'],
  task: ['weldflow', 'weldsuite'],
  weldmeet: ['weldmeet', 'weldsuite'],
  weldbooks: ['weldbooks', 'weldsuite'],
  weldagent: ['weldagent', 'weldsuite'],
  weldcalendar: ['weldcalendar', 'weldsuite'],
};

export function appCodesForCategory(category: string): string[] {
  return CATEGORY_APP_CODES[category] ?? ['weldsuite'];
}

/**
 * Map a notification to the Android channel + priority it should ring on. Calls
 * route to the high-importance `incoming_call` channel; other WeldChat
 * notifications to `chat`. Channel ids must match those the client app creates.
 */
function androidDelivery(
  category: string,
  notificationType: string,
): { channelId?: string; priority: 'default' | 'high' } {
  if (notificationType === 'chat_incoming_call' || notificationType === 'chat_missed_call') {
    return { channelId: 'incoming_call', priority: 'high' };
  }
  if (category === 'weldchat') {
    // high + sound matches a working manual Expo push; default/normal can be
    // delayed or deprioritised on Android Doze.
    return { channelId: 'chat', priority: 'high' };
  }
  if (category === 'weldmail' || category === 'mail') {
    return { channelId: 'email', priority: 'high' };
  }
  if (category === 'weldflow' || category === 'projects' || category === 'task') {
    return { channelId: 'weldflow', priority: 'default' };
  }
  if (category === 'weldagent') {
    return { channelId: 'weldagent', priority: 'default' };
  }
  if (category === 'weldcalendar') {
    return { channelId: 'weldcalendar', priority: 'default' };
  }
  return { priority: 'default' };
}

/** Deliver the notification to the user's live in-app topic. Never throws. */
async function deliverInApp<Env extends NotificationEnv>(
  params: CreateNotificationParams<Env>,
  id: string,
  now: Date,
): Promise<void> {
  const { env, workspaceId, userId } = params;
  try {
    await publishInAppNotification({
      realtime: env.REALTIME,
      workspaceId,
      userId,
      notification: {
        id,
        title: params.title,
        body: params.body,
        category: params.category,
        notificationType: params.notificationType,
        actionUrl: params.actionUrl,
        entityType: params.entityType,
        entityId: params.entityId,
        // Platform realtime handler crashes without a parseable createdAt
        // (`new Date(undefined).toISOString()` → RangeError), which silently
        // dropped every live WeldChat (and other) in-app notification.
        createdAt: now.toISOString(),
        isRead: false,
        severity: params.severity,
        actorType: params.actorType ?? null,
        actorId: params.actorId ?? null,
      },
    });
  } catch (err) {
    console.error('[Notifications] In-app publish failed:', err);
  }
}

/**
 * Hand the email to the deferred-email workflow when the host worker binds
 * one: it waits out EMAIL_DEFER_MINUTES and re-checks that the recipient is
 * still away and the notification still unread, so a user who comes back and
 * reads it never gets the mail. Workers without the binding keep the original
 * immediate send — the presence gate already spared them the worst of it
 * (mailing someone who is online).
 */
async function sendOrDeferEmail<Env extends NotificationEnv>(
  params: CreateNotificationParams<Env>,
  id: string,
  now: Date,
  apiKey: string,
  to: string,
): Promise<void> {
  const { env, workspaceId, userId, title, body, emailTemplate } = params;
  if (env.DEFERRED_NOTIFICATION_EMAIL) {
    await env.DEFERRED_NOTIFICATION_EMAIL.create({
      // One instance per notification: idempotent under retries, and the
      // id is enough to find the instance again.
      id: `email-${id}`,
      params: {
        workspaceId,
        userId,
        notificationId: id,
        to,
        subject: title,
        fallbackText: body,
        sendAfter: new Date(now.getTime() + EMAIL_DEFER_MINUTES * 60_000).toISOString(),
        template: emailTemplate,
      },
    });
    return;
  }
  await sendNotificationEmail({
    apiKey,
    to,
    subject: title,
    fallbackText: body,
    template: emailTemplate,
  });
}

/** Email the recipient (immediately or deferred). Never throws. */
async function deliverEmail<Env extends NotificationEnv>(
  params: CreateNotificationParams<Env>,
  id: string,
  now: Date,
  apiKey: string,
): Promise<void> {
  try {
    const [member] = await params.db
      .select({ email: schema.workspaceMembers.email })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, params.userId))
      .limit(1);

    if (member?.email) {
      await sendOrDeferEmail(params, id, now, apiKey, member.email);
    }
  } catch (err) {
    console.error('[Notifications] Email send failed:', err);
  }
}

/**
 * Group active device tokens by appCode before calling Expo. Tokens from
 * different EAS projects (weldchat vs weldsuite vs weldmail …) in one request
 * get the whole batch rejected with HTTP 400.
 */
function groupTokensByAppCode(
  tokens: Array<{ token: string | null; appCode: string }>,
): Map<string, string[]> {
  const byAppCode = new Map<string, string[]>();
  for (const row of tokens) {
    if (!row.token) continue;
    const list = byAppCode.get(row.appCode) ?? [];
    list.push(row.token);
    byAppCode.set(row.appCode, list);
  }
  return byAppCode;
}

/**
 * Expo `data` must be string→string. Never put a conversation UUID in
 * `data.channelId` — on Android that key is the notification-channel id
 * and a UUID silently drops the banner (manual push with channelId
 * "chat" still works). Strip/rename defensively so helpers can't regress.
 */
function buildPushData<Env extends NotificationEnv>(
  params: CreateNotificationParams<Env>,
): Record<string, string> {
  const pushData: Record<string, string> = {
    actionUrl: params.actionUrl ?? '',
    entityType: params.entityType ?? '',
    entityId: params.entityId ?? '',
    notificationType: params.notificationType,
    ...(params.clerkOrgId ? { clerkOrgId: params.clerkOrgId } : {}),
  };
  for (const [key, value] of Object.entries(params.data ?? {})) {
    if (value == null) continue;
    const str = typeof value === 'string' ? value : String(value);
    if (key === 'channelId') {
      if (!pushData.chatChannelId) pushData.chatChannelId = str;
      continue;
    }
    pushData[key] = str;
  }
  return pushData;
}

/** Send one Expo batch per appCode; returns every token Expo rejected. */
async function sendPushBatches<Env extends NotificationEnv>(
  params: CreateNotificationParams<Env>,
  byAppCode: Map<string, string[]>,
): Promise<string[]> {
  const { userId, title, body, category, notificationType } = params;
  const { channelId, priority } = androidDelivery(category, notificationType);
  const pushData = buildPushData(params);

  const allInvalid: string[] = [];
  for (const [appCode, appTokens] of byAppCode) {
    const messages: ExpoPushMessage[] = appTokens.map((token) => ({
      to: token,
      title,
      body,
      sound: 'default',
      // Ensure the app icon badge updates on arrival (orchestrator never
      // sent a count before; clients reconcile the real unread total via
      // realtime / API).
      badge: 1,
      ...(channelId ? { channelId } : {}),
      priority,
      data: pushData,
    }));
    console.log(
      `[Notifications] Expo push attempt user=${userId} type=${notificationType} appCode=${appCode} tokens=${appTokens.length} androidChannel=${channelId ?? 'none'} dataKeys=${Object.keys(pushData).join(',')}`,
    );
    const { invalidTokens, tickets } = await sendExpoPush(messages);
    const ticketErrors = tickets.filter((t) => t.status === 'error');
    if (ticketErrors.length > 0) {
      console.error(
        '[Notifications] Expo push ticket errors:',
        ticketErrors.map((t) => ({ message: t.message, error: t.details?.error })),
      );
    }
    allInvalid.push(...invalidTokens.filter(Boolean));
  }
  return allInvalid;
}

/** Push to the user's active devices for this category's app(s). Never throws. */
async function deliverPush<Env extends NotificationEnv>(
  params: CreateNotificationParams<Env>,
): Promise<void> {
  const { db, userId, category } = params;
  try {
    // Scope to ACTIVE tokens (isActive IS NULL) for the app(s) this category
    // targets — never fan a module notification to every app the user has
    // installed (wrong EAS project + cross-app spam) or to deactivated tokens.
    const appCodes = appCodesForCategory(category);
    const tokens = await db
      .select({ token: schema.deviceTokens.token, appCode: schema.deviceTokens.appCode })
      .from(schema.deviceTokens)
      .where(
        and(
          eq(schema.deviceTokens.userId, userId),
          isNull(schema.deviceTokens.isActive),
          inArray(schema.deviceTokens.appCode, appCodes),
        ),
      );

    const byAppCode = groupTokensByAppCode(tokens);
    if (byAppCode.size === 0) {
      console.warn(
        `[Notifications] No active push tokens for user=${userId} category=${category} appCodes=${appCodes.join(',')}`,
      );
      return;
    }

    const allInvalid = await sendPushBatches(params, byAppCode);

    // Drop DeviceNotRegistered / non-Expo tokens so we stop retrying them.
    if (allInvalid.length > 0) {
      await db
        .update(schema.deviceTokens)
        .set({ isActive: new Date(), updatedAt: new Date() })
        .where(inArray(schema.deviceTokens.token, allInvalid));
    }
  } catch (err) {
    console.error('[Notifications] Push send failed:', err);
  }
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
    excludeChannels,
  } = params;

  const channels = await getChannelPreferences(db, userId, category);

  // Subtractive channel exclusions — a notification may opt OUT of a channel
  // (e.g. call rings never email) regardless of the user's preferences. This
  // can only turn a channel off, never on.
  for (const channel of excludeChannels ?? []) {
    channels[channel] = false;
  }

  // Presence gate for email only. A connected recipient does not need mail
  // about something already on their screen, so resolve this BEFORE the insert
  // — `deliveredEmail` on the row has to describe what actually happens, and
  // the deferred path decides that here rather than minutes later.
  const emailPresence = channels.email ? await resolveEmailPresence(db, userId) : 'suppress';
  const willEmail = channels.email && emailPresence === 'absent';

  if (!channels.inApp && !willEmail && !channels.push) {
    console.warn(
      `[Notifications] Skipped all channels for user=${userId} category=${category} type=${notificationType} (DND or prefs off)`,
    );
    return null;
  }

  if (!channels.push) {
    console.warn(
      `[Notifications] Push disabled by prefs for user=${userId} category=${category} type=${notificationType}`,
    );
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
    deliveredEmail: willEmail,
    deliveredPush: channels.push,
    createdAt: now,
  });

  if (channels.inApp) await deliverInApp(params, id, now);
  if (willEmail && env.RESEND_API_KEY) await deliverEmail(params, id, now, env.RESEND_API_KEY);
  if (channels.push) await deliverPush(params);

  return id;
}
