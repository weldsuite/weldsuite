/**
 * "Email read" push for the WeldMail app.
 *
 * The new-email push (mail-inbound-worker) leaves a banner in the phone's
 * notification tray. Once that email is read, trashed or deleted anywhere else
 * (the web app, another phone), this push tells the app to take the banner out
 * and brings the app badge in line with the inbox.
 *
 * The push is data-only with `_contentAvailable`: iOS delivers it as a
 * headless background notification and Android as an FCM data message, so it
 * is never shown. The app's background task (weldmail-app
 * `utils/notification-tasks.ts`) dismisses the banners whose `emailId` is in
 * the list. The payload carries only message ids and a count, no mail content.
 *
 * Fire-and-forget: callers run it in `waitUntil`, and every failure is logged
 * and swallowed, so a read never fails because Expo is down.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as personalSchema from '@weldsuite/db/schema/personal';
import { sendExpoPush, type ExpoPushMessage, type SendExpoPushResult } from '@weldsuite/notifications/push';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { hasAccessToAccount, listAccessibleAccountIds } from './access';
import { getMessageStats } from './messages';
import type { WorkspaceMailStore } from './store/types';

/** `data.type` of the push; the app matches on it. */
export const EMAIL_READ_PUSH_TYPE = 'email_read';

/** App code the WeldMail app registers its tokens under. */
const WELDMAIL_APP_CODE = 'weldmail';

/**
 * Ids per push. A `generateId()` id is at most 30 chars, so 40 of them stay
 * well inside the 4 KB APNs payload limit; a bulk action of 100 becomes three
 * pushes per device.
 */
const IDS_PER_PUSH = 40;

type PersonalDatabase = NeonHttpDatabase<typeof personalSchema>;

export type MailTenantKind = 'workspace' | 'personal';

export interface MailReadPushContent {
  /** Messages that are no longer unread in the inbox. */
  emailIds: string[];
  /**
   * The recipient's unread inbox count after the change. Sets the iOS badge
   * even when the app is not woken, and the app stores it per tenancy so a
   * user with both a workspace and a personal inbox gets their sum.
   */
  inboxUnread?: number;
  tenantKind: MailTenantKind;
}

/** The silent pushes for one device. Exported for tests. */
export function buildMailReadPushMessages(
  tokens: string[],
  { emailIds, inboxUnread, tenantKind }: MailReadPushContent,
): ExpoPushMessage[] {
  const ids = [...new Set(emailIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_PUSH) chunks.push(ids.slice(i, i + IDS_PER_PUSH));

  const messages: ExpoPushMessage[] = [];
  for (const to of tokens) {
    for (const chunk of chunks) {
      messages.push({
        to,
        _contentAvailable: true,
        // iOS only delivers background pushes at priority 5; a high-priority
        // data message that shows nothing also gets Android apps deprioritised.
        priority: 'normal',
        ...(inboxUnread === undefined ? {} : { badge: inboxUnread }),
        data: {
          type: EMAIL_READ_PUSH_TYPE,
          emailIds: chunk.join(','),
          tenantKind,
          ...(inboxUnread === undefined ? {} : { inboxUnread: String(inboxUnread) }),
        },
      });
    }
  }
  return messages;
}

/** Unread messages in the inboxes `userId` may open: the workspace badge. */
export async function workspaceInboxUnread(db: Database, userId: string): Promise<number> {
  const accountIds = await listAccessibleAccountIds(db, userId);
  return (await getMessageStats(db, accountIds)).inboxUnread;
}

/**
 * {@link workspaceInboxUnread}, through the mailbox store's cross-mailbox
 * `stats()` fan-out (design docs/plans/weldmail-mailbox-store-design.md, task
 * D2: "`inboxUnread` 90 → F `stats(...).inboxUnread`") instead of a direct
 * `mail_messages` query — so in `object`/`object-only` mode the badge comes
 * from the object, not Postgres. `postgres`/`shadow` go through the exact
 * same `getMessageStats` call `workspaceInboxUnread` does (the store's own
 * `stats()` wraps it), so this is behaviourally identical there; the
 * difference only shows up once a mode's `WorkspaceMailStore` reads from the
 * object.
 */
async function workspaceInboxUnreadViaStore(store: WorkspaceMailStore, db: Database, userId: string): Promise<number> {
  const accountIds = await listAccessibleAccountIds(db, userId);
  return (await store.stats(accountIds)).inboxUnread;
}

/**
 * Unread messages in a personal account's inbox: the personal badge. Same
 * filter as personal-api `GET /mail-messages/unread-count`, which the app
 * reads when it opens.
 */
export async function personalInboxUnread(
  db: PersonalDatabase,
  personalAccountId: string,
): Promise<number> {
  const { personalMailMessages } = personalSchema;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(personalMailMessages)
    .where(
      and(
        eq(personalMailMessages.personalAccountId, personalAccountId),
        eq(personalMailMessages.isRead, false),
        eq(personalMailMessages.isTrash, false),
        isNull(personalMailMessages.deletedAt),
        sql`${personalMailMessages.labels} @> ${JSON.stringify(['INBOX'])}::jsonb`,
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * Active members among `userIds`, mapped to whether they are admin/owner (who
 * may open a private mailbox nobody is assigned to). Same filter as the
 * new-email push's member query: removing a member does not deactivate their
 * device tokens, so a removed or suspended member must be dropped here.
 */
async function activeMembers(db: Database, userIds: string[]): Promise<Map<string, boolean>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: schema.workspaceMembers.userId, role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        inArray(schema.workspaceMembers.userId, userIds),
        isNull(schema.workspaceMembers.deletedAt),
        eq(schema.workspaceMembers.status, 'ACTIVE'),
      ),
    );
  return new Map(rows.map((r) => [r.userId, ['OWNER', 'ADMIN'].includes(r.role?.toUpperCase() ?? '')]));
}

function groupTokensByUser(rows: { userId: string; token: string }[]): Map<string, string[]> {
  const byUser = new Map<string, string[]>();
  for (const { userId, token } of rows) {
    const tokens = byUser.get(userId) ?? [];
    tokens.push(token);
    byUser.set(userId, tokens);
  }
  return byUser;
}

/** Badge count, or undefined when it can't be read (the push still dismisses). */
async function safeCount(count: () => Promise<number>): Promise<number | undefined> {
  try {
    return await count();
  } catch (err) {
    console.error('[MailReadPush] Failed to count unread inbox messages:', err);
    return undefined;
  }
}

export interface MailReadPushDeps {
  /**
   * The caller's already-resolved mailbox store (design task D2), so the
   * per-user `inboxUnread` badge comes from `store.stats(accountIds)` instead
   * of a direct `mail_messages` query — see
   * {@link workspaceInboxUnreadViaStore}. Omitted (the default) falls back to
   * {@link workspaceInboxUnread}'s direct Postgres path, unchanged — every
   * existing caller that doesn't have a store handy (or is always `postgres`
   * mode) keeps working exactly as before.
   */
  store?: WorkspaceMailStore;
}

/**
 * Tell every WeldMail device that may show these messages that they are read.
 * Targets the users who may open the mailbox, the same set the new-email push
 * went to (mail-inbound-worker `selectNotifyMembers`).
 */
export async function sendWorkspaceMailReadPush(
  db: Database,
  params: { accountId: string; emailIds: string[] },
  deps: MailReadPushDeps = {},
): Promise<void> {
  if (params.emailIds.length === 0) return;
  try {
    const [account] = await db
      .select({ isShared: schema.mailAccounts.isShared, assignedUserIds: schema.mailAccounts.assignedUserIds })
      .from(schema.mailAccounts)
      .where(eq(schema.mailAccounts.id, params.accountId))
      .limit(1);
    if (!account) return;

    const tokenRows = await db
      .select({ userId: schema.deviceTokens.userId, token: schema.deviceTokens.token })
      .from(schema.deviceTokens)
      .where(and(eq(schema.deviceTokens.appCode, WELDMAIL_APP_CODE), isNull(schema.deviceTokens.isActive)));
    const byUser = groupTokensByUser(tokenRows);
    if (byUser.size === 0) return;

    const members = await activeMembers(db, [...byUser.keys()]);

    const messages: ExpoPushMessage[] = [];
    for (const [userId, tokens] of byUser) {
      const isAdmin = members.get(userId);
      if (isAdmin === undefined || !hasAccessToAccount(account, userId, isAdmin)) continue;
      const inboxUnread = await safeCount(() =>
        deps.store ? workspaceInboxUnreadViaStore(deps.store!, db, userId) : workspaceInboxUnread(db, userId),
      );
      messages.push(
        ...buildMailReadPushMessages(tokens, { emailIds: params.emailIds, inboxUnread, tenantKind: 'workspace' }),
      );
    }
    if (messages.length === 0) return;

    const result = await sendExpoPush(messages);
    await deactivateTokens(result, async (token) => {
      await db
        .update(schema.deviceTokens)
        .set({ isActive: new Date() })
        .where(eq(schema.deviceTokens.token, token));
    });
  } catch (err) {
    console.error(`[MailReadPush] Workspace push failed for account ${params.accountId}:`, err);
  }
}

/** Personal (consumer WeldMail) twin of {@link sendWorkspaceMailReadPush}. */
export async function sendPersonalMailReadPush(
  db: PersonalDatabase,
  params: { clerkUserId: string; personalAccountId: string; emailIds: string[] },
): Promise<void> {
  if (params.emailIds.length === 0) return;
  const { personalDeviceTokens } = personalSchema;
  try {
    const rows = await db
      .select({ token: personalDeviceTokens.token })
      .from(personalDeviceTokens)
      .where(
        and(
          eq(personalDeviceTokens.clerkUserId, params.clerkUserId),
          eq(personalDeviceTokens.appCode, WELDMAIL_APP_CODE),
          isNull(personalDeviceTokens.isActive),
        ),
      );
    if (rows.length === 0) return;

    const inboxUnread = await safeCount(() => personalInboxUnread(db, params.personalAccountId));
    const messages = buildMailReadPushMessages(
      rows.map((r) => r.token),
      { emailIds: params.emailIds, inboxUnread, tenantKind: 'personal' },
    );
    const result = await sendExpoPush(messages);
    await deactivateTokens(result, async (token) => {
      await db
        .update(personalDeviceTokens)
        .set({ isActive: new Date(), updatedAt: new Date() })
        .where(eq(personalDeviceTokens.token, token));
    });
  } catch (err) {
    console.error(`[MailReadPush] Personal push failed for ${params.clerkUserId}:`, err);
  }
}

/** Expo said the device is gone: stop pushing to it, like the new-email path does. */
async function deactivateTokens(
  result: SendExpoPushResult,
  deactivate: (token: string) => Promise<void>,
): Promise<void> {
  const tokens = [...new Set(result.invalidTokens.filter(Boolean))];
  await Promise.all(
    tokens.map((token) =>
      deactivate(token).catch((err) => console.error('[MailReadPush] Failed to deactivate token:', err)),
    ),
  );
}
