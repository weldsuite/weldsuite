/**
 * The WeldMail "email read" push: payload shape, and who it goes to.
 *
 * It must reach exactly the devices that may hold the new-email banner (the
 * users who may open the mailbox) and carry each user's own inbox count as
 * the badge. Expo itself is mocked.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ExpoPushMessage } from '@weldsuite/notifications/push';

const sendExpoPush = vi.hoisted(() =>
  vi.fn(async (messages: ExpoPushMessage[]) => ({ tickets: messages.map(() => ({ status: 'ok' as const })), invalidTokens: [] as string[] })),
);
vi.mock('@weldsuite/notifications/push', () => ({ sendExpoPush }));

import { buildMailReadPushMessages, sendWorkspaceMailReadPush, EMAIL_READ_PUSH_TYPE } from './read-push';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import { PostgresWorkspaceMailStore } from './store/postgres';

const { deviceTokens, mailAccounts, mailMessages, workspaceMembers } = schema;

describe('buildMailReadPushMessages', () => {
  it('builds a silent, data-only push per device', () => {
    const [message, ...rest] = buildMailReadPushMessages(['ExponentPushToken[a]'], {
      emailIds: ['mmsg_1', 'mmsg_2'],
      inboxUnread: 3,
      tenantKind: 'workspace',
    });
    expect(rest).toHaveLength(0);
    expect(message).toEqual({
      to: 'ExponentPushToken[a]',
      _contentAvailable: true,
      priority: 'normal',
      badge: 3,
      data: { type: EMAIL_READ_PUSH_TYPE, emailIds: 'mmsg_1,mmsg_2', tenantKind: 'workspace', inboxUnread: '3' },
    });
    // Nothing for the OS to show.
    expect(message).not.toHaveProperty('title');
    expect(message).not.toHaveProperty('body');
    expect(message).not.toHaveProperty('sound');
  });

  it('splits a long id list so each payload stays small', () => {
    const emailIds = Array.from({ length: 100 }, (_, i) => `mmsg_${i}`);
    const messages = buildMailReadPushMessages(['t1', 't2'], { emailIds, tenantKind: 'personal' });
    expect(messages).toHaveLength(6); // 3 chunks × 2 devices
    const ids = messages.filter((m) => m.to === 't1').flatMap((m) => m.data!.emailIds!.split(','));
    expect(ids).toEqual(emailIds);
  });

  it('leaves the badge alone when the count is unknown, and sends nothing without ids', () => {
    const [message] = buildMailReadPushMessages(['t1'], { emailIds: ['mmsg_1'], tenantKind: 'workspace' });
    expect(message).not.toHaveProperty('badge');
    expect(message!.data).not.toHaveProperty('inboxUnread');
    expect(buildMailReadPushMessages(['t1'], { emailIds: ['', ''], tenantKind: 'workspace' })).toEqual([]);
  });
});

describe('sendWorkspaceMailReadPush', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 60_000);

  beforeEach(() => {
    sendExpoPush.mockClear();
  });

  async function seedAccount(access: { isShared: boolean; assignedUserIds?: string[] }): Promise<string> {
    const id = generateId('mail');
    await db.insert(mailAccounts).values({ id, name: 'Box', email: `${id}@test.dev`, ...access });
    return id;
  }

  async function seedUnread(accountId: string): Promise<string> {
    const id = generateId('mmsg');
    await db.insert(mailMessages).values({
      id,
      accountId,
      threadId: `thread_${id}`,
      messageId: `<${id}@test.dev>`,
      from: { email: 'sender@example.com' },
      to: [{ email: 'me@test.dev' }],
      subject: 'Hi',
      sentDate: new Date(),
      labels: ['INBOX'],
      isRead: false,
    });
    return id;
  }

  async function seedDevice(
    userId: string,
    opts: { role?: string; appCode?: string; inactive?: boolean; memberStatus?: string; removed?: boolean } = {},
  ) {
    const token = `ExponentPushToken[${generateId('tok')}]`;
    await db
      .insert(workspaceMembers)
      .values({
        id: generateId('wm'),
        userId,
        role: opts.role ?? 'MEMBER',
        status: opts.memberStatus ?? 'ACTIVE',
        deletedAt: opts.removed ? new Date() : null,
      })
      .onConflictDoNothing();
    await db.insert(deviceTokens).values({
      id: generateId('dtok'),
      userId,
      deviceId: generateId('dev'),
      platform: 'ios',
      token,
      appCode: opts.appCode ?? 'weldmail',
      isActive: opts.inactive ? new Date() : null,
    });
    return token;
  }

  function sentTokens(): string[] {
    return sendExpoPush.mock.calls.flatMap(([messages]) => messages.map((m) => m.to));
  }

  it('reaches only the assigned users of a private mailbox, on their WeldMail devices', async () => {
    const alice = generateId('user');
    const bob = generateId('user');
    const accountId = await seedAccount({ isShared: false, assignedUserIds: [alice] });
    const aliceToken = await seedDevice(alice);
    await seedDevice(alice, { appCode: 'weldchat' });
    await seedDevice(alice, { inactive: true });
    await seedDevice(bob, { role: 'ADMIN' }); // admin, but not assigned

    await sendWorkspaceMailReadPush(db, { accountId, emailIds: ['mmsg_x'] });

    expect(sentTokens()).toEqual([aliceToken]);
  });

  it('falls back to admins for a private mailbox nobody is assigned to', async () => {
    const admin = generateId('user');
    const member = generateId('user');
    const accountId = await seedAccount({ isShared: false, assignedUserIds: [] });
    const adminToken = await seedDevice(admin, { role: 'OWNER' });
    const memberToken = await seedDevice(member);

    await sendWorkspaceMailReadPush(db, { accountId, emailIds: ['mmsg_x'] });

    expect(sentTokens()).toContain(adminToken);
    expect(sentTokens()).not.toContain(memberToken);
  });

  it('skips removed and suspended members, whose tokens are never deactivated', async () => {
    const active = generateId('user');
    const removed = generateId('user');
    const suspended = generateId('user');
    const accountId = await seedAccount({ isShared: true });
    const activeToken = await seedDevice(active);
    const removedToken = await seedDevice(removed, { removed: true });
    const suspendedToken = await seedDevice(suspended, { memberStatus: 'SUSPENDED' });

    await sendWorkspaceMailReadPush(db, { accountId, emailIds: ['mmsg_x'] });

    expect(sentTokens()).toContain(activeToken);
    expect(sentTokens()).not.toContain(removedToken);
    expect(sentTokens()).not.toContain(suspendedToken);
  });

  it("sets each user's badge to the unread inbox count they can see", async () => {
    const user = generateId('user');
    const accountId = await seedAccount({ isShared: false, assignedUserIds: [user] });
    await seedUnread(accountId);
    await seedUnread(accountId);
    const token = await seedDevice(user);

    await sendWorkspaceMailReadPush(db, { accountId, emailIds: ['mmsg_x'] });

    const message = sendExpoPush.mock.calls[0]![0].find((m) => m.to === token);
    expect(message?.badge).toBe(2);
    expect(message?.data?.inboxUnread).toBe('2');
  });

  // design task D2: when a caller hands over its mailbox store, the badge
  // comes from `store.stats(...)` instead of the direct `mail_messages`
  // query — a `PostgresWorkspaceMailStore` wraps the exact same Postgres
  // query, so the count must agree.
  it("sets the badge from the store's stats fan-out when one is supplied", async () => {
    const user = generateId('user');
    const accountId = await seedAccount({ isShared: false, assignedUserIds: [user] });
    await seedUnread(accountId);
    const token = await seedDevice(user);
    const store = new PostgresWorkspaceMailStore(db, 'ws_test', 'org_test');

    await sendWorkspaceMailReadPush(db, { accountId, emailIds: ['mmsg_x'] }, { store });

    const message = sendExpoPush.mock.calls[0]![0].find((m) => m.to === token);
    expect(message?.badge).toBe(1);
    expect(message?.data?.inboxUnread).toBe('1');
  });

  it('deactivates a token Expo reports as gone', async () => {
    const user = generateId('user');
    const accountId = await seedAccount({ isShared: false, assignedUserIds: [user] });
    const token = await seedDevice(user);
    sendExpoPush.mockResolvedValueOnce({ tickets: [{ status: 'ok' }], invalidTokens: [token] });

    await sendWorkspaceMailReadPush(db, { accountId, emailIds: ['mmsg_x'] });

    const [row] = await db.select({ isActive: deviceTokens.isActive }).from(deviceTokens).where(eq(deviceTokens.token, token));
    expect(row?.isActive).toBeInstanceOf(Date);
  });

  it('sends nothing for an unknown mailbox or an empty id list', async () => {
    await sendWorkspaceMailReadPush(db, { accountId: 'mail_missing', emailIds: ['mmsg_x'] });
    const accountId = await seedAccount({ isShared: true });
    await sendWorkspaceMailReadPush(db, { accountId, emailIds: [] });
    expect(sendExpoPush).not.toHaveBeenCalled();
  });
});
