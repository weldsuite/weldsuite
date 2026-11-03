/**
 * Personal WeldMail's outbound routes end to end: `POST /api/mail/messages/send`,
 * `/:id/reply`, `/:id/forward` and `POST /api/mail/subscriptions/:id/unsubscribe`,
 * through the worker's `SEND_EMAIL` binding (a stub that takes or refuses each
 * envelope) and the outbound guard's ledgers (`OUTBOUND_LEDGER`,
 * `OUTBOUND_PLATFORM`; ledger key `personal:<accountId>`), with the SENT copy
 * in the personal database. Run on both backends by the `personal: mail`
 * conformance suite: the envelopes and the ledger calls are compared too.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import * as personalSchema from '@weldsuite/db/schema/personal';
import { createMasterPgliteDb, createPersonalPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb, conformanceTenantDb } from '@weldsuite/worker-kit/testing/conformance';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { authHeaders, createPersonalTestApp } from '../test/harness';
import { ACCOUNT, AT, OTHER_ACCOUNT, resetDatabases, seedBothAccounts } from '../test/seed';

const holder = vi.hoisted(() => ({ masterDb: null as unknown, personalDb: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.masterDb),
  getPersonalDb: () => conformanceTenantDb(holder.personalDb),
}));

// The outbound guard reads sender ownership from the master registry.
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.masterDb),
}));

type Db = Awaited<ReturnType<typeof createPersonalPgliteDb>>['db'];
let masterDb: Db;
let personalDb: Db;

const MINE = 'pma_pat';
const THEIRS = 'pma_olly';
const PRO = { fea: 'u:weldmail_pro' };

beforeAll(async () => {
  masterDb = (await createMasterPgliteDb()).db;
  personalDb = (await createPersonalPgliteDb()).db;
  holder.masterDb = masterDb;
  holder.personalDb = personalDb;
}, 60_000);

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await resetDatabases(masterDb, personalDb);
  await seedBothAccounts(masterDb);
  await personalDb.insert(personalSchema.personalMailAccounts).values([
    { id: MINE, personalAccountId: ACCOUNT, name: 'pat', email: 'pat@weldmail.com', displayName: 'Pat P', createdAt: AT, updatedAt: AT },
    { id: 'pma_plain', personalAccountId: ACCOUNT, name: 'plain', email: 'plain@weldmail.com', createdAt: AT, updatedAt: AT },
    { id: THEIRS, personalAccountId: OTHER_ACCOUNT, name: 'olly', email: 'olly@weldmail.com', createdAt: AT, updatedAt: AT },
  ]);
  const registry = (id: string, email: string, personalAccountId: string, accountId: string) => ({
    id,
    email,
    tenantKind: 'personal',
    personalAccountId,
    accountId,
    isActive: true,
    createdAt: AT,
    updatedAt: AT,
  });
  await masterDb.insert(masterSchema.mailAccountRegistry).values([
    registry('reg_pat', 'pat@weldmail.com', ACCOUNT, MINE),
    registry('reg_plain', 'plain@weldmail.com', ACCOUNT, 'pma_plain'),
    registry('reg_olly', 'olly@weldmail.com', OTHER_ACCOUNT, THEIRS),
  ]);
  await personalDb.insert(personalSchema.personalMailMessages).values([
    {
      id: 'pmsg_in',
      personalAccountId: ACCOUNT,
      accountId: MINE,
      messageId: '<question@example.com>',
      threadId: '<root@example.com>',
      from: { email: 'sam@example.com', name: 'Sam' },
      to: [{ email: 'pat@weldmail.com' }, { email: 'kim@example.com' }],
      cc: [{ email: 'PAT@weldmail.com' }, { email: 'lee@example.com' }],
      replyTo: null,
      subject: 'Lunch?',
      textBody: 'Shall we?',
      htmlBody: '<p>Shall <b>we</b>?</p>',
      references: ['<root@example.com>'],
      sentDate: new Date('2026-10-01T10:00:00.000Z'),
      labels: ['INBOX'],
      source: 'inbound',
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: 'pmsg_mine',
      personalAccountId: ACCOUNT,
      accountId: MINE,
      messageId: '<sent@weldmail.com>',
      threadId: '<sent@weldmail.com>',
      from: { email: 'pat@weldmail.com', name: 'Pat' },
      to: [{ email: 'jo@example.com' }],
      subject: 'Re: Plans',
      sentDate: new Date('2026-10-01T11:00:00.000Z'),
      labels: ['SENT'],
      source: 'composed',
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: 'pmsg_nobody',
      personalAccountId: ACCOUNT,
      accountId: MINE,
      messageId: '<nobody@example.com>',
      from: { email: 'pat@weldmail.com' },
      to: [],
      subject: null,
      sentDate: new Date('2026-10-01T12:00:00.000Z'),
      source: 'composed',
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: 'pmsg_theirs',
      personalAccountId: OTHER_ACCOUNT,
      accountId: THEIRS,
      messageId: '<theirs@example.com>',
      from: { email: 'x@example.com' },
      to: [{ email: 'olly@weldmail.com' }],
      sentDate: AT,
      source: 'inbound',
      createdAt: AT,
      updatedAt: AT,
    },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Ledger = ReturnType<typeof ledgerStub>;

/** An `OUTBOUND_LEDGER` namespace whose `reserve` answers `decision`, by method. */
function ledgerStub(decision: Record<string, unknown> = { allow: true, mode: 'enforce', reservationId: 'res_1' }) {
  const stub = {
    reserve: vi.fn(async () => decision),
    commit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  return { namespace: { idFromName: (name: string) => name, get: () => stub }, stub };
}

function platformStub() {
  const stub = { trip: vi.fn(async () => undefined), status: vi.fn(async () => ({ tripped: false })) };
  return { namespace: { idFromName: (name: string) => name, get: () => stub }, stub };
}

function app(options: { send?: ReturnType<typeof createSendEmailStub> | null; ledger?: Ledger; platform?: ReturnType<typeof platformStub> } = {}) {
  const send = options.send === undefined ? createSendEmailStub() : options.send;
  return createPersonalTestApp({
    masterDb,
    personalDb,
    env: {
      ...(send ? { SEND_EMAIL: send } : {}),
      ...(options.ledger ? { OUTBOUND_LEDGER: options.ledger.namespace } : {}),
      ...(options.platform ? { OUTBOUND_PLATFORM: options.platform.namespace } : {}),
    },
  });
}

function post(body: unknown, claims: Record<string, unknown> = {}): RequestInit {
  return { method: 'POST', headers: authHeaders(claims), body: JSON.stringify(body) };
}

type Sent = { data: Record<string, unknown> & { id: string; messageId: string; threadId: string } };

describe('POST /api/mail/messages/send', () => {
  it('sends and keeps the SENT copy, once per idempotency key', async () => {
    const send = createSendEmailStub();
    const ledger = ledgerStub();
    const target = app({ send, ledger });
    const body = {
      accountId: MINE,
      to: 'sam@example.com',
      cc: ['kim@example.com'],
      bcc: 'boss@example.com',
      subject: 'Hello',
      textBody: 'Hi Sam',
      htmlBody: '<p>Hi <script>alert(1)</script>Sam</p>',
      idempotencyKey: 'key-1',
    };
    const res = await target.request('/api/mail/messages/send', post(body));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as Sent;
    expect(data).toMatchObject({
      accountId: MINE,
      from: { email: 'pat@weldmail.com', name: 'Pat P' },
      to: [{ email: 'sam@example.com' }],
      cc: [{ email: 'kim@example.com' }],
      bcc: [{ email: 'boss@example.com' }],
      subject: 'Hello',
      preview: 'Hi Sam',
      labels: ['SENT'],
      sendStatus: 'sent',
      sendProvider: 'cloudflare',
      source: 'composed',
      isRead: true,
      isReply: false,
      idempotencyKey: 'key-1',
      pendingVerification: false,
    });
    expect(data.messageId).toMatch(/^<[0-9a-f]{32}@weldmail\.com>$/);
    expect(data.threadId).toBe(data.messageId);
    expect(String(data.htmlBody)).not.toContain('script');
    expect(send.sent.map((e) => e.to).sort()).toEqual(['boss@example.com', 'kim@example.com', 'sam@example.com']);
    expect(ledger.stub.reserve).toHaveBeenCalled();
    expect(ledger.stub.commit).toHaveBeenCalled();

    const [account] = await personalDb
      .select()
      .from(personalSchema.personalMailAccounts)
      .where(eq(personalSchema.personalMailAccounts.id, MINE));
    expect(account?.sentToday).toBe(1);

    // The same key again: the first copy, nothing sent.
    send.sent.length = 0;
    const again = await target.request('/api/mail/messages/send', post(body));
    expect(again.status).toBe(201);
    expect(((await again.json()) as Sent).data.id).toBe(data.id);
    expect(send.sent).toHaveLength(0);
  });

  it('threads a reply into its parent’s conversation', async () => {
    const target = app();
    const res = await target.request(
      '/api/mail/messages/send',
      post({ accountId: 'pma_plain', to: ['sam@example.com'], subject: 'Re: Lunch?', htmlBody: '<p>Yes</p>', inReplyTo: 'question@example.com', references: ['<root@example.com>'] }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as Sent;
    expect(data).toMatchObject({
      inReplyTo: '<question@example.com>',
      references: ['<root@example.com>'],
      isReply: true,
      preview: 'Yes',
      textBody: null,
      from: { email: 'plain@weldmail.com', name: 'plain' },
    });
    // No row of this mailbox matches, so the first ancestor roots it.
    expect(data.threadId).toBe('<question@example.com>');

    const own = await target.request(
      '/api/mail/messages/send',
      post({ accountId: MINE, to: 'sam@example.com', subject: 'Again', textBody: 'x', references: ['root@example.com'] }),
    );
    expect(((await own.json()) as Sent).data.threadId).toBe('<root@example.com>');

    const explicit = await target.request(
      '/api/mail/messages/send',
      post({ accountId: MINE, to: 'sam@example.com', subject: 'Explicit', textBody: 'x', threadId: 'thread-x' }),
    );
    expect(((await explicit.json()) as Sent).data.threadId).toBe('thread-x');
  });

  it('holds the plan’s daily limit', async () => {
    const today = new Date();
    await personalDb.insert(personalSchema.personalMailMessages).values(
      Array.from({ length: 50 }, (_, i) => ({
        id: `pmsg_day_${i}`,
        personalAccountId: ACCOUNT,
        accountId: MINE,
        messageId: `<day-${i}@weldmail.com>`,
        from: { email: 'pat@weldmail.com' },
        to: [{ email: 'x@example.com' }],
        sentDate: today,
        source: 'composed',
        createdAt: AT,
        updatedAt: AT,
      })),
    );
    const send = createSendEmailStub();
    const target = app({ send });
    const res = await target.request('/api/mail/messages/send', post({ accountId: MINE, to: 'sam@example.com', subject: 'One more' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: 'PLAN_LIMIT_REACHED',
        message: 'Daily send limit of 50 reached. Upgrade to Pro for a higher limit.',
        details: { plan: 'free', dailySendLimit: 50 },
      },
    });
    expect(send.sent).toHaveLength(0);

    // Pro has 500 a day.
    const pro = await target.request('/api/mail/messages/send', post({ accountId: MINE, to: 'sam@example.com', subject: 'Pro' }, PRO));
    expect(pro.status).toBe(201);
  });

  it('refuses another person’s mailbox and a bad body', async () => {
    const target = app();
    const theirs = await target.request('/api/mail/messages/send', post({ accountId: THEIRS, to: 'sam@example.com', subject: 'Hi' }));
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Mail account not found' } });

    const bad = await target.request(
      '/api/mail/messages/send',
      post({ accountId: MINE, to: [], cc: 'not-an-email', subject: 1, references: ['x'.repeat(501)] }),
    );
    expect(bad.status).toBe(400);

    // Neither a string nor a list: Zod's invalid_union, after the other fields' issues.
    for (const body of [
      { accountId: MINE, subject: 'x' },
      { accountId: '', to: 5, cc: null, bcc: ['nope'], subject: 'x' },
      { accountId: MINE, to: ['bad'], cc: [], bcc: 'nope', subject: 'x' },
    ]) {
      const res = await target.request('/api/mail/messages/send', post(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, error: { name: 'ZodError' } });
    }
  });

  it('answers 503 without the send binding', async () => {
    const target = app({ send: null });
    const res = await target.request('/api/mail/messages/send', post({ accountId: MINE, to: 'sam@example.com', subject: 'Hi', textBody: 'x' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'SEND_EMAIL binding missing — wrangler [[send_email]] not configured' },
    });
  });

  it('keeps Cloudflare’s refusals apart', async () => {
    const limited = await app({ send: createSendEmailStub({ 'sam@example.com': 'E_RATE_LIMIT_EXCEEDED' }) }).request(
      '/api/mail/messages/send',
      post({ accountId: MINE, to: 'sam@example.com', subject: 'Hi', textBody: 'x' }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(await limited.json()).toEqual({
      error: { code: 'PROVIDER_RATE_LIMITED', message: 'Outbound mail is being rate-limited. Try again in a minute.' },
    });

    const platform = platformStub();
    const quota = await app({ send: createSendEmailStub({ 'sam@example.com': 'E_DAILY_LIMIT_EXCEEDED' }), platform }).request(
      '/api/mail/messages/send',
      post({ accountId: MINE, to: 'sam@example.com', subject: 'Hi', textBody: 'x' }),
    );
    expect(quota.status).toBe(503);
    expect(await quota.json()).toEqual({
      error: { code: 'PROVIDER_DAILY_LIMIT', message: 'Outbound mail is unavailable for the rest of the day. Try again later.' },
    });
    expect(platform.stub.trip).toHaveBeenCalled();

    const partial = await app({ send: createSendEmailStub({ 'kim@example.com': null }) }).request(
      '/api/mail/messages/send',
      post({ accountId: MINE, to: ['sam@example.com', 'kim@example.com', 'lee@example.com'], subject: 'Hi', textBody: 'x' }),
    );
    expect(partial.status).toBe(502);
    expect(await partial.json()).toEqual({
      error: {
        code: 'PARTIALLY_SENT',
        message: 'Sent to 1 of 3 recipients.',
        details: { sent: ['sam@example.com'], failed: ['kim@example.com', 'lee@example.com'] },
      },
    });
  });

  it('passes on the guard’s refusal', async () => {
    const denial = { code: 'SENDING_LIMITED', window: 'day', limit: 50, used: 50, retryAfter: '2099-01-01T00:00:00.000Z' };
    const ledger = ledgerStub({ allow: false, mode: 'enforce', reservationId: null, denial });
    const send = createSendEmailStub();
    const res = await app({ send, ledger }).request(
      '/api/mail/messages/send',
      post({ accountId: MINE, to: 'sam@example.com', subject: 'Hi', textBody: 'x' }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(await res.json()).toMatchObject({ error: { code: 'SENDING_LIMITED', details: denial } });
    expect(send.sent).toHaveLength(0);
  });

  it('refuses a sender address that belongs to someone else', async () => {
    // A mailbox row whose address the registry gives to another person.
    await personalDb.insert(personalSchema.personalMailAccounts).values({
      id: 'pma_stolen',
      personalAccountId: ACCOUNT,
      name: 'stolen',
      email: 'taken@weldmail.com',
      createdAt: AT,
      updatedAt: AT,
    });
    await masterDb.insert(masterSchema.mailAccountRegistry).values({
      id: 'reg_taken',
      email: 'taken@weldmail.com',
      tenantKind: 'personal',
      personalAccountId: OTHER_ACCOUNT,
      accountId: THEIRS,
      isActive: true,
      createdAt: AT,
      updatedAt: AT,
    });
    const res = await app({ ledger: ledgerStub() }).request(
      '/api/mail/messages/send',
      post({ accountId: 'pma_stolen', to: 'sam@example.com', subject: 'Hi', textBody: 'x' }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'SENDER_NOT_OWNED' } });
  });
});

describe('POST /api/mail/messages/:id/reply and /forward', () => {
  it('replies to the sender, and to everyone with replyAll', async () => {
    const send = createSendEmailStub();
    const target = app({ send });
    const res = await target.request('/api/mail/messages/pmsg_in/reply', post({ textBody: 'Sure', idempotencyKey: 'r1' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as Sent;
    expect(data).toMatchObject({
      to: [{ email: 'sam@example.com' }],
      cc: null,
      subject: 'Re: Lunch?',
      inReplyTo: '<question@example.com>',
      references: ['<root@example.com>', '<question@example.com>'],
      threadId: '<root@example.com>',
      repliedTo: 'pmsg_in',
      isReply: true,
    });

    const all = await target.request('/api/mail/messages/pmsg_in/reply', post({ htmlBody: '<p>All</p>', replyAll: true }));
    expect(await all.json()).toMatchObject({
      data: { to: [{ email: 'sam@example.com' }, { email: 'kim@example.com' }], cc: [{ email: 'lee@example.com' }] },
    });

    // Replying to one's own sent mail goes to its recipients.
    const own = await target.request('/api/mail/messages/pmsg_mine/reply', post({ textBody: 'Bump' }));
    expect(await own.json()).toMatchObject({ data: { to: [{ email: 'jo@example.com' }], subject: 'Re: Plans' } });
  });

  it('refuses a reply with nobody to answer, or to another person’s message', async () => {
    const target = app();
    const nobody = await target.request('/api/mail/messages/pmsg_nobody/reply', post({ textBody: 'Hello?' }));
    expect(nobody.status).toBe(400);
    expect(await nobody.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'The original message has no address to reply to' },
    });
    const theirs = await target.request('/api/mail/messages/pmsg_theirs/reply', post({ textBody: 'x' }));
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Message not found' } });
    expect((await target.request('/api/mail/messages/pmsg_in/reply', post({ replyAll: 'yes' }))).status).toBe(400);
  });

  it('forwards with the original quoted', async () => {
    const send = createSendEmailStub();
    const res = await app({ send }).request(
      '/api/mail/messages/pmsg_in/forward',
      post({ to: ['jo@example.com'], cc: 'kim@example.com', textBody: 'FYI', htmlBody: '<p>FYI</p>' }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as Sent;
    expect(data).toMatchObject({
      subject: 'Fwd: Lunch?',
      to: [{ email: 'jo@example.com' }],
      cc: [{ email: 'kim@example.com' }],
      forwardedFrom: 'pmsg_in',
      inReplyTo: null,
      isReply: false,
    });
    expect(String(data.textBody)).toBe(
      'FYI\n\n---------- Forwarded message ----------\nFrom: Sam <sam@example.com>\nDate: Thu, 01 Oct 2026 10:00:00 GMT\nSubject: Lunch?\nTo: pat@weldmail.com, kim@example.com\n\nShall we?',
    );
    expect(String(data.htmlBody)).toContain('Forwarded message');

    // A forward of a message without a text part keeps the user's text alone.
    const bare = await app({ send }).request('/api/mail/messages/pmsg_mine/forward', post({ to: 'kim@example.com' }));
    expect(bare.status).toBe(201);
    expect(await bare.json()).toMatchObject({ data: { subject: 'Fwd: Re: Plans', textBody: null, htmlBody: null } });

    const theirs = await app().request('/api/mail/messages/pmsg_theirs/forward', post({ to: 'kim@example.com' }));
    expect(theirs.status).toBe(404);
    expect((await app().request('/api/mail/messages/pmsg_in/forward', post({ to: [] }))).status).toBe(400);
  });
});

describe('POST /api/mail/subscriptions/:id/unsubscribe', () => {
  async function seedSubscription(id: string, fields: Partial<typeof personalSchema.personalMailSubscriptions.$inferInsert>) {
    await personalDb.insert(personalSchema.personalMailSubscriptions).values({
      id,
      personalAccountId: ACCOUNT,
      accountId: MINE,
      senderEmail: `${id}@news.example`,
      senderName: 'News',
      senderDomain: 'news.example',
      messageCount: 3,
      firstReceivedAt: AT,
      lastReceivedAt: AT,
      createdAt: AT,
      updatedAt: AT,
      ...fields,
    });
  }

  function stubFetch(status: number) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new Response(url.includes('one-click') ? 'ok' : 'nope', { status: url.includes('one-click') ? status : 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('posts the one-click request', async () => {
    await seedSubscription('pmsub_click', { unsubscribeUrl: 'https://news.example/one-click', oneClick: true });
    const fetchMock = stubFetch(200);
    const res = await app().request('/api/mail/subscriptions/pmsub_click/unsubscribe', post({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { method: 'one_click', url: null, subscription: { id: 'pmsub_click', status: 'unsubscribed', unsubscribeMethod: 'one_click' } },
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('falls back to the unsubscribe mail, then to the link', async () => {
    await seedSubscription('pmsub_mail', {
      unsubscribeUrl: 'https://news.example/one-click',
      unsubscribeMailto: 'mailto:leave@news.example?subject=Remove%20me',
      oneClick: true,
    });
    stubFetch(500);
    const send = createSendEmailStub();
    const mailed = await app({ send }).request('/api/mail/subscriptions/pmsub_mail/unsubscribe', post({}));
    expect(mailed.status).toBe(200);
    expect(await mailed.json()).toMatchObject({ data: { method: 'mailto', url: null } });
    expect(send.sent.map((e) => e.to)).toEqual(['leave@news.example']);
    const [copy] = await personalDb
      .select()
      .from(personalSchema.personalMailMessages)
      .where(and(eq(personalSchema.personalMailMessages.accountId, MINE), eq(personalSchema.personalMailMessages.subject, 'Remove me')));
    expect(copy).toMatchObject({ textBody: 'unsubscribe', source: 'composed' });

    await seedSubscription('pmsub_link', { unsubscribeUrl: 'https://news.example/manage' });
    const link = await app().request('/api/mail/subscriptions/pmsub_link/unsubscribe', post({}));
    expect(await link.json()).toMatchObject({ data: { method: 'link', url: 'https://news.example/manage' } });
  });

  it('answers when nothing works', async () => {
    await seedSubscription('pmsub_none', {});
    const none = await app().request('/api/mail/subscriptions/pmsub_none/unsubscribe', post({}));
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'This sender offers no way to unsubscribe' } });

    await seedSubscription('pmsub_broken', { unsubscribeMailto: 'mailto:leave@news.example' });
    const broken = await app({ send: null }).request('/api/mail/subscriptions/pmsub_broken/unsubscribe', post({}));
    expect(broken.status).toBe(503);
    expect(await broken.json()).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Unsubscribe failed: SEND_EMAIL binding missing — wrangler [[send_email]] not configured',
      },
    });

    await seedSubscription('pmsub_theirs', { personalAccountId: OTHER_ACCOUNT, accountId: THEIRS, unsubscribeUrl: 'https://news.example/x' });
    const theirs = await app().request('/api/mail/subscriptions/pmsub_theirs/unsubscribe', post({}));
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Subscription with ID 'pmsub_theirs' not found" } });
  });
});
