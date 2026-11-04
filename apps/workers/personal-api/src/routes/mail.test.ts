/**
 * Personal WeldMail's mailbox routes: `/api/mail/accounts`,
 * `/api/mail/labels`, `/api/mail/drafts`, `/api/mail/messages` (reads, the
 * unread badge, attachments and flag changes with the "email read" push)
 * and `/api/mail/subscriptions` (list and scan), on pglite. Run on both
 * backends by the `personal: mail` conformance suite. The free
 * `@weldmail.com` address routes (`/api/mail/weldmail`) run on TypeScript
 * alone: Global's (ADR MAIL-010).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import * as personalSchema from '@weldsuite/db/schema/personal';
import { createMasterPgliteDb, createPersonalPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb, conformanceTenantDb } from '@weldsuite/worker-kit/testing/conformance';
import { authHeaders, createPersonalTestApp } from '../test/harness';
import { ACCOUNT, AT, OTHER_ACCOUNT, USER, resetDatabases, seedBothAccounts, seedPersonalAccount } from '../test/seed';

const holder = vi.hoisted(() => ({ masterDb: null as unknown, personalDb: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.masterDb),
  getPersonalDb: () => conformanceTenantDb(holder.personalDb),
}));

type Db = Awaited<ReturnType<typeof createPersonalPgliteDb>>['db'];
let masterDb: Db;
let personalDb: Db;

const MINE = 'pma_pat';
const THEIRS = 'pma_olly';

beforeAll(async () => {
  masterDb = (await createMasterPgliteDb()).db;
  personalDb = (await createPersonalPgliteDb()).db;
  holder.masterDb = masterDb;
  holder.personalDb = personalDb;
}, 60_000);

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await resetDatabases(masterDb, personalDb);
  await seedBothAccounts(masterDb);
  await personalDb.insert(personalSchema.personalMailAccounts).values([
    { id: MINE, personalAccountId: ACCOUNT, name: 'pat', email: 'pat@weldmail.com', displayName: 'Pat', isDefault: true, createdAt: AT, updatedAt: AT },
    { id: 'pma_old', personalAccountId: ACCOUNT, name: 'old', email: 'old@weldmail.com', createdAt: new Date('2026-09-01T09:00:00.000Z'), updatedAt: AT },
    { id: 'pma_gone', personalAccountId: ACCOUNT, name: 'gone', email: 'gone@weldmail.com', createdAt: AT, updatedAt: AT, deletedAt: AT },
    { id: THEIRS, personalAccountId: OTHER_ACCOUNT, name: 'olly', email: 'olly@weldmail.com', createdAt: AT, updatedAt: AT },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function app() {
  return createPersonalTestApp({ masterDb, personalDb });
}

function message(id: string, fields: Partial<typeof personalSchema.personalMailMessages.$inferInsert>) {
  return {
    id,
    personalAccountId: ACCOUNT,
    accountId: MINE,
    messageId: `<${id}@example.com>`,
    threadId: `<${id}@example.com>`,
    from: { email: 'friend@example.com', name: 'Friend' },
    to: [{ email: 'pat@weldmail.com' }],
    subject: id,
    sentDate: AT,
    labels: ['INBOX'],
    source: 'inbound',
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  };
}

async function seedMessages() {
  await personalDb.insert(personalSchema.personalMailMessages).values([
    message('pmsg_1', {
      subject: 'Weekly 50% off',
      preview: 'Deals inside',
      from: { email: 'news@shop.example', name: 'Shop News' },
      sentDate: new Date('2026-10-01T10:00:00.000Z'),
    }),
    message('pmsg_2', { subject: 'Re: Lunch', threadId: 't2', isRead: true, sentDate: new Date('2026-10-01T10:05:00.000Z') }),
    message('pmsg_3', {
      subject: 'Lunch deal',
      threadId: 't2',
      labels: ['INBOX', 'PROMOTIONS'],
      sentDate: new Date('2026-10-01T10:10:00.000Z'),
    }),
    message('pmsg_4', {
      subject: 'Re: Lunch',
      threadId: 't2',
      isRead: true,
      labels: ['SENT'],
      source: 'composed',
      from: { email: 'pat@weldmail.com', name: 'Pat' },
      sentDate: new Date('2026-10-01T10:15:00.000Z'),
    }),
    message('pmsg_trash', { isTrash: true, labels: ['TRASH'], sentDate: new Date('2026-10-01T09:00:00.000Z') }),
    message('pmsg_old', { accountId: 'pma_old', sentDate: new Date('2026-09-30T09:00:00.000Z') }),
    message('pmsg_gone', { deletedAt: AT }),
    message('pmsg_theirs', { personalAccountId: OTHER_ACCOUNT, accountId: THEIRS }),
  ]);
}

describe('/api/mail/accounts', () => {
  it('lists the mailboxes newest first and reads one', async () => {
    const target = app();
    const res = await target.request('/api/mail/accounts', { headers: authHeaders() });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((a) => a.id)).toEqual([MINE, 'pma_old']);

    const one = await target.request(`/api/mail/accounts/${MINE}`, { headers: authHeaders() });
    expect(await one.json()).toMatchObject({ data: { id: MINE, email: 'pat@weldmail.com', provider: 'weldmail', sentToday: 0 } });

    const theirs = await target.request(`/api/mail/accounts/${THEIRS}`, { headers: authHeaders() });
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Mail account with ID '${THEIRS}' not found` } });
  });
});

describe('/api/mail/labels', () => {
  it('lists a mailbox’s labels by position, then name', async () => {
    const label = (id: string, name: string, position: number | null, fields = {}) => ({
      id,
      personalAccountId: ACCOUNT,
      accountId: MINE,
      name,
      position,
      createdAt: AT,
      updatedAt: AT,
      ...fields,
    });
    await personalDb.insert(personalSchema.personalMailLabels).values([
      label('plbl_sent', 'Sent', 1, { slug: 'SENT', isSystem: true }),
      label('plbl_inbox', 'Inbox', 0, { slug: 'INBOX', isSystem: true }),
      label('plbl_b', 'Bills', 5),
      label('plbl_a', 'Archive me', 5),
      label('plbl_gone', 'Gone', 2, { deletedAt: AT }),
      label('plbl_other_box', 'Old box', 0, { accountId: 'pma_old' }),
    ]);
    const target = app();
    const res = await target.request(`/api/mail/labels?accountId=${MINE}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((l) => l.id)).toEqual(['plbl_inbox', 'plbl_sent', 'plbl_a', 'plbl_b']);

    const theirs = await target.request(`/api/mail/labels?accountId=${THEIRS}`, { headers: authHeaders() });
    expect(theirs.status).toBe(404);
    expect((await target.request('/api/mail/labels', { headers: authHeaders() })).status).toBe(400);
  });
});

describe('/api/mail/drafts', () => {
  async function seedDrafts() {
    const draft = (id: string, updatedAt: string, fields = {}) => ({
      id,
      personalAccountId: ACCOUNT,
      accountId: MINE,
      subject: id,
      createdAt: AT,
      updatedAt: new Date(updatedAt),
      ...fields,
    });
    await personalDb.insert(personalSchema.personalMailDrafts).values([
      draft('pdr_a', '2026-10-02T09:00:00.000Z'),
      draft('pdr_b', '2026-10-03T09:00:00.000Z', { to: ['sam@example.com'] }),
      draft('pdr_c', '2026-10-04T09:00:00.000Z', { accountId: 'pma_old' }),
      draft('pdr_gone', '2026-10-05T09:00:00.000Z', { deletedAt: AT }),
      draft('pdr_theirs', '2026-10-05T09:00:00.000Z', { personalAccountId: OTHER_ACCOUNT, accountId: THEIRS }),
    ]);
  }

  it('lists drafts by last change, per mailbox, with a cursor', async () => {
    await seedDrafts();
    const target = app();
    const all = await target.request('/api/mail/drafts', { headers: authHeaders() });
    const body = (await all.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(body.data.map((d) => d.id)).toEqual(['pdr_c', 'pdr_b', 'pdr_a']);
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });

    const mine = await target.request(`/api/mail/drafts?accountId=${MINE}&limit=1`, { headers: authHeaders() });
    const page = (await mine.json()) as { data: Array<{ id: string }>; pagination: { cursor: string } };
    expect(page.data.map((d) => d.id)).toEqual(['pdr_b']);
    expect(page.pagination).toEqual({ totalCount: 2, hasMore: true, cursor: 'pdr_b' });
    const next = await target.request(`/api/mail/drafts?accountId=${MINE}&limit=1&cursor=pdr_b`, { headers: authHeaders() });
    expect(await next.json()).toMatchObject({ data: [{ id: 'pdr_a' }], pagination: { totalCount: 2, hasMore: false } });

    expect((await target.request(`/api/mail/drafts?accountId=${THEIRS}`, { headers: authHeaders() })).status).toBe(404);
    expect((await target.request('/api/mail/drafts?limit=abc', { headers: authHeaders() })).status).toBe(400);
  });

  it('creates, updates and deletes a draft', async () => {
    const target = app();
    const created = await target.request('/api/mail/drafts', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ accountId: MINE, subject: 'Plans', to: ['sam@example.com'], body: 'Hi', attachmentIds: ['att_1'] }),
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: Record<string, unknown> & { id: string } };
    expect(data).toMatchObject({
      accountId: MINE,
      subject: 'Plans',
      to: ['sam@example.com'],
      cc: null,
      importance: 'normal',
      hasAttachments: true,
      attachmentCount: 1,
      isReply: false,
      isForward: false,
    });

    const patched = await target.request(`/api/mail/drafts/${data.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ subject: 'New plans', attachmentIds: [], importance: 'high', isReply: true }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      data: { id: data.id, subject: 'New plans', attachmentIds: [], hasAttachments: false, attachmentCount: 0, importance: 'high', isReply: true, body: 'Hi' },
    });

    const removed = await target.request(`/api/mail/drafts/${data.id}`, { method: 'DELETE', headers: authHeaders() });
    expect(removed.status).toBe(204);
    for (const [method, body] of [
      ['PATCH', JSON.stringify({ subject: 'x' })],
      ['DELETE', undefined],
    ] as const) {
      const res = await target.request(`/api/mail/drafts/${data.id}`, { method, headers: authHeaders(), body });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Draft with ID '${data.id}' not found` } });
    }
  });

  it('refuses a draft in another person’s mailbox, or a bad body', async () => {
    const target = app();
    const theirs = await target.request('/api/mail/drafts', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ accountId: THEIRS }),
    });
    expect(theirs.status).toBe(404);
    const bad = await target.request('/api/mail/drafts', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ accountId: MINE, to: 'sam@example.com', importance: 'urgent' }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('/api/mail/messages', () => {
  beforeEach(async () => {
    await seedMessages();
    await personalDb.insert(personalSchema.personalMailAttachments).values([
      { id: 'pmatt_2', personalAccountId: ACCOUNT, messageId: 'pmsg_1', fileName: 'b.pdf', size: 20, createdAt: new Date('2026-10-01T10:00:02.000Z'), updatedAt: AT },
      { id: 'pmatt_1', personalAccountId: ACCOUNT, messageId: 'pmsg_1', fileName: 'a.png', contentType: 'image/png', size: 10, createdAt: new Date('2026-10-01T10:00:01.000Z'), updatedAt: AT },
      { id: 'pmatt_gone', personalAccountId: ACCOUNT, messageId: 'pmsg_1', fileName: 'c.txt', createdAt: AT, updatedAt: AT, deletedAt: AT },
    ]);
  });

  it('lists messages newest first, with the filters', async () => {
    const target = app();
    const all = await target.request('/api/mail/messages', { headers: authHeaders() });
    const body = (await all.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(body.data.map((m) => m.id)).toEqual(['pmsg_4', 'pmsg_3', 'pmsg_2', 'pmsg_1', 'pmsg_trash', 'pmsg_old']);
    expect(body.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });

    for (const [query, ids] of [
      [`accountId=${MINE}&label=PROMOTIONS`, ['pmsg_3']],
      ['threadId=t2', ['pmsg_2', 'pmsg_3', 'pmsg_4']],
      ['unreadOnly=true', ['pmsg_3', 'pmsg_1', 'pmsg_trash', 'pmsg_old']],
      // `z.coerce.boolean()`: any non-empty value is true.
      ['unreadOnly=false', ['pmsg_3', 'pmsg_1', 'pmsg_trash', 'pmsg_old']],
      ['search=50%25', ['pmsg_1']],
      ['search=shop', ['pmsg_1']],
      ['search=%20%20lunch%20', ['pmsg_4', 'pmsg_3', 'pmsg_2']],
      ['search=deals', ['pmsg_1']],
      ['search=a_b', []],
    ] as const) {
      const res = await target.request(`/api/mail/messages?${query}`, { headers: authHeaders() });
      expect(res.status, query).toBe(200);
      expect(((await res.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id), query).toEqual(ids);
    }
  });

  it('pages both ways with a cursor', async () => {
    const target = app();
    const first = await target.request('/api/mail/messages?limit=2', { headers: authHeaders() });
    expect(await first.json()).toMatchObject({
      data: [{ id: 'pmsg_4' }, { id: 'pmsg_3' }],
      pagination: { totalCount: 6, hasMore: true, cursor: 'pmsg_3' },
    });
    const next = await target.request('/api/mail/messages?limit=2&cursor=pmsg_3', { headers: authHeaders() });
    expect(((await next.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(['pmsg_2', 'pmsg_1']);

    const thread = await target.request('/api/mail/messages?threadId=t2&limit=1&cursor=pmsg_2', { headers: authHeaders() });
    expect(((await thread.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(['pmsg_3']);

    expect((await target.request('/api/mail/messages?limit=0', { headers: authHeaders() })).status).toBe(400);
    expect((await target.request(`/api/mail/messages?search=${'x'.repeat(201)}`, { headers: authHeaders() })).status).toBe(400);
  });

  it('counts the unread inbox per mailbox', async () => {
    const res = await app().request('/api/mail/messages/unread-count', { headers: authHeaders() });
    expect(await res.json()).toEqual({ data: { total: 3, byAccount: { [MINE]: 2, pma_old: 1 } } });
  });

  it('reads one message and its attachments', async () => {
    const target = app();
    const one = await target.request('/api/mail/messages/pmsg_1', { headers: authHeaders() });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ data: { id: 'pmsg_1', subject: 'Weekly 50% off', from: { email: 'news@shop.example' } } });

    const attachments = await target.request('/api/mail/messages/pmsg_1/attachments', { headers: authHeaders() });
    expect(((await attachments.json()) as { data: Array<{ id: string }> }).data.map((a) => a.id)).toEqual(['pmatt_1', 'pmatt_2']);

    for (const path of ['/api/mail/messages/pmsg_theirs', '/api/mail/messages/pmsg_gone']) {
      const res = await target.request(path, { headers: authHeaders() });
      expect(res.status).toBe(404);
    }
    const theirs = await target.request('/api/mail/messages/pmsg_theirs/attachments', { headers: authHeaders() });
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Message not found' } });
  });

  describe('PATCH /:id', () => {
    it('refuses an empty change and another person’s message', async () => {
      const target = app();
      const empty = await target.request('/api/mail/messages/pmsg_1', { method: 'PATCH', headers: authHeaders(), body: '{}' });
      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'No fields to update' } });
      const theirs = await target.request('/api/mail/messages/pmsg_theirs', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ isStarred: true }),
      });
      expect(theirs.status).toBe(404);
      const bad = await target.request('/api/mail/messages/pmsg_1', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ isRead: 'yes' }),
      });
      expect(bad.status).toBe(400);
    });

    it('moves labels with the spam flag and an explicit label list', async () => {
      const target = app();
      const patch = async (id: string, body: unknown) => {
        const res = await target.request(`/api/mail/messages/${id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        return ((await res.json()) as { data: { labels: string[]; isSpam: boolean; isStarred: boolean } }).data;
      };
      expect(await patch('pmsg_3', { isSpam: true })).toMatchObject({ isSpam: true, labels: ['PROMOTIONS', 'SPAM'] });
      expect(await patch('pmsg_3', { isSpam: false })).toMatchObject({ isSpam: false, labels: ['PROMOTIONS', 'INBOX'] });
      expect(await patch('pmsg_trash', { isSpam: false })).toMatchObject({ labels: ['TRASH'] });
      expect(await patch('pmsg_4', { labels: ['INBOX', 'PROMOTIONS', 'Work'], isSpam: false })).toMatchObject({
        labels: ['INBOX', 'Work'],
        isSpam: false,
      });
      expect(await patch('pmsg_3', { labels: ['INBOX', 'PROMOTIONS'] })).toMatchObject({ labels: ['INBOX', 'PROMOTIONS'] });
      expect(await patch('pmsg_2', { isStarred: true })).toMatchObject({ isStarred: true, labels: ['INBOX'] });
    });

    it('tells the WeldMail devices a message was read', async () => {
      await personalDb.insert(personalSchema.personalDeviceTokens).values([
        { id: 'pdt_phone', personalAccountId: ACCOUNT, clerkUserId: USER, deviceId: 'phone', platform: 'ios', token: 'ExponentPushToken[phone]', appCode: 'weldmail', createdAt: AT, updatedAt: AT },
        { id: 'pdt_old', personalAccountId: ACCOUNT, clerkUserId: USER, deviceId: 'old', platform: 'android', token: 'ExponentPushToken[old]', appCode: 'weldmail', createdAt: AT, updatedAt: AT },
        { id: 'pdt_off', personalAccountId: ACCOUNT, clerkUserId: USER, deviceId: 'off', platform: 'ios', token: 'ExponentPushToken[off]', appCode: 'weldmail', isActive: AT, createdAt: AT, updatedAt: AT },
        { id: 'pdt_cal', personalAccountId: ACCOUNT, clerkUserId: USER, deviceId: 'cal', platform: 'ios', token: 'ExponentPushToken[cal]', appCode: 'weldcalendar', createdAt: AT, updatedAt: AT },
      ]);
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === 'https://exp.host/--/api/v2/push/send') {
          const messages = JSON.parse(String(init?.body)) as Array<{ to: string }>;
          return new Response(
            JSON.stringify({
              data: messages.map((m) =>
                m.to === 'ExponentPushToken[old]'
                  ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
                  : { status: 'ok', id: 'ticket' },
              ),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await app().request('/api/mail/messages/pmsg_1', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ isRead: true }),
      });
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalled();
      const [, init] = fetchMock.mock.calls.at(-1)!;
      expect(JSON.parse(String(init?.body))).toEqual([
        expect.objectContaining({ to: 'ExponentPushToken[phone]', badge: 2, data: { type: 'email_read', emailIds: 'pmsg_1', tenantKind: 'personal', inboxUnread: '2' } }),
        expect.objectContaining({ to: 'ExponentPushToken[old]' }),
      ]);
      const [old] = await personalDb
        .select()
        .from(personalSchema.personalDeviceTokens)
        .where(eq(personalSchema.personalDeviceTokens.id, 'pdt_old'));
      expect(old?.isActive).toBeInstanceOf(Date);

      // Starring leaves the banner alone: no push.
      fetchMock.mockClear();
      await app().request('/api/mail/messages/pmsg_2', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ isStarred: true }),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('/api/mail/subscriptions', () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const RAW = (headers: string) => `${headers}\r\nSubject: hi\r\n\r\nBody text`;

  it('lists a mailbox’s subscriptions, newest first', async () => {
    const sub = (id: string, sender: string, last: string, fields = {}) => ({
      id,
      personalAccountId: ACCOUNT,
      accountId: MINE,
      senderEmail: sender,
      lastReceivedAt: new Date(last),
      firstReceivedAt: AT,
      createdAt: AT,
      updatedAt: AT,
      ...fields,
    });
    await personalDb.insert(personalSchema.personalMailSubscriptions).values([
      sub('pmsub_a', 'a@news.example', '2026-10-02T09:00:00.000Z'),
      sub('pmsub_b', 'b@news.example', '2026-10-03T09:00:00.000Z', { status: 'unsubscribed', unsubscribeMethod: 'link' }),
      sub('pmsub_old', 'c@news.example', '2026-10-04T09:00:00.000Z', { accountId: 'pma_old' }),
    ]);
    const target = app();
    const all = await target.request(`/api/mail/subscriptions?accountId=${MINE}`, { headers: authHeaders() });
    expect(((await all.json()) as { data: Array<{ id: string }> }).data.map((s) => s.id)).toEqual(['pmsub_b', 'pmsub_a']);
    const active = await target.request(`/api/mail/subscriptions?accountId=${MINE}&status=active`, { headers: authHeaders() });
    expect(((await active.json()) as { data: Array<{ id: string }> }).data.map((s) => s.id)).toEqual(['pmsub_a']);

    const theirs = await target.request(`/api/mail/subscriptions?accountId=${THEIRS}`, { headers: authHeaders() });
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Mail account with ID '${THEIRS}' not found` } });
    expect((await target.request(`/api/mail/subscriptions?accountId=${MINE}&status=gone`, { headers: authHeaders() })).status).toBe(400);
  });

  it('finds subscriptions in the stored mail, twice without doubling', async () => {
    await personalDb.insert(personalSchema.personalMailMessages).values([
      message('pmsg_n1', {
        from: { email: 'News@Shop.example', name: 'Shop' },
        subject: 'Newest deals',
        sentDate: daysAgo(1),
        receivedDate: daysAgo(1),
        rawMessage: RAW(
          'From: News <news@shop.example>\r\nList-Unsubscribe: <mailto:leave@shop.example?subject=bye>,\r\n <https://shop.example/u/1>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nList-Id: Shop <deals.shop.example>',
        ),
      }),
      message('pmsg_n2', {
        from: { email: 'news@shop.example', name: 'Shop' },
        subject: 'Older deals',
        sentDate: daysAgo(3),
        rawMessage: RAW('List-Unsubscribe: <https://shop.example/u/old>'),
      }),
      message('pmsg_n3', {
        from: { email: 'blog@writer.example' },
        sentDate: daysAgo(2),
        rawMessage: RAW('List-Unsubscribe: mailto:stop@writer.example'),
      }),
      message('pmsg_plain', { from: { email: 'friend@example.com' }, sentDate: daysAgo(1), rawMessage: RAW('From: friend@example.com') }),
      message('pmsg_spam', { isSpam: true, sentDate: daysAgo(1), rawMessage: RAW('List-Unsubscribe: <https://spam.example/u>') }),
      message('pmsg_ancient', { sentDate: daysAgo(400), rawMessage: RAW('List-Unsubscribe: <https://old.example/u>') }),
      message('pmsg_no_raw', { sentDate: daysAgo(1) }),
      message('pmsg_sent', { source: 'composed', sentDate: daysAgo(1), rawMessage: RAW('List-Unsubscribe: <https://me.example/u>') }),
    ]);
    const target = app();
    const scan = async () => {
      const res = await target.request('/api/mail/subscriptions/scan', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ accountId: MINE }),
      });
      expect(res.status).toBe(200);
      return res.json();
    };
    expect(await scan()).toEqual({ data: { scanned: 4, subscriptions: 2 } });
    expect(await scan()).toEqual({ data: { scanned: 4, subscriptions: 2 } });

    const rows = await personalDb
      .select()
      .from(personalSchema.personalMailSubscriptions)
      .where(eq(personalSchema.personalMailSubscriptions.accountId, MINE));
    const shop = rows.find((r: { senderEmail: string }) => r.senderEmail === 'news@shop.example');
    expect(shop).toMatchObject({
      senderName: 'Shop',
      senderDomain: 'shop.example',
      listId: 'deals.shop.example',
      unsubscribeUrl: 'https://shop.example/u/1',
      unsubscribeMailto: 'mailto:leave@shop.example?subject=bye',
      oneClick: true,
      messageCount: 2,
      lastSubject: 'Newest deals',
      status: 'active',
    });
    expect(rows).toHaveLength(2);

    const theirs = await target.request('/api/mail/subscriptions/scan', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ accountId: THEIRS }),
    });
    expect(theirs.status).toBe(404);
    expect(
      (await target.request('/api/mail/subscriptions/scan', { method: 'POST', headers: authHeaders(), body: '{}' })).status,
    ).toBe(400);
  });
});

describe('/api/mail/weldmail (TypeScript only)', () => {
  it('checks and reserves a free address', async () => {
    const target = app();
    expect(await (await target.request('/api/mail/weldmail/domain', { headers: authHeaders() })).json()).toEqual({
      data: { domain: 'weldmail.com' },
    });
    const reserved = await target.request('/api/mail/weldmail/check', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ address: 'admin' }),
    });
    expect(await reserved.json()).toEqual({ data: { available: false, reason: 'reserved' } });
    const free = await target.request('/api/mail/weldmail/check', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ address: 'Pat.Free' }),
    });
    expect(await free.json()).toEqual({ data: { available: true, email: 'pat.free@weldmail.com', domain: 'weldmail.com' } });

    // The free plan has one address, and this account has two already.
    const limited = await target.request('/api/mail/weldmail/reserve', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ address: 'pat.free' }),
    });
    expect(limited.status).toBe(403);
  });

  it('reserves an address with its system labels and registry row', async () => {
    await resetDatabases(masterDb, personalDb);
    await seedPersonalAccount(masterDb);
    const res = await app().request('/api/mail/weldmail/reserve', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ address: 'pat.new', displayName: 'Pat New' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ data: { email: 'pat.new@weldmail.com', displayName: 'Pat New', isDefault: true } });
    expect(await personalDb.select().from(personalSchema.personalMailLabels)).toHaveLength(7);
    const registry = await masterDb.select().from(masterSchema.mailAccountRegistry);
    expect(registry).toMatchObject([{ email: 'pat.new@weldmail.com', tenantKind: 'personal', personalAccountId: ACCOUNT }]);
  });
});
