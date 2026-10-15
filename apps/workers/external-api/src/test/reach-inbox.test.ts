/**
 * WeldReach on the public API: the reply inbox and answering a reply, against
 * pglite.
 *
 * A reply goes out over SMTP under the workspace's name, so these tests run the
 * real send path (the domain's `sendReply` and `sendFromMailbox`, the real
 * credential opener, the real SMTP client) against a scripted fake server
 * installed behind `cloudflare:sockets`, and check every refusal in the order the
 * app has: 403 (approval, billing) -> 503 (kill switch) -> 404 -> 409 -> 502.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { reachMessages } from '@weldsuite/db/schema';
import { resetReach, seedMailbox, seedOutbound, seedProspect } from '@weldsuite/reach-domain/testing/reach';
import { FakeSmtpServer, type ScriptStep } from '@weldsuite/smtp/testing/fake-server';
import { createPgliteDb } from './pglite';
import { useSocketFactory } from './cloudflare-sockets-stub';
import type { Database } from '../db';
import { approvedAccess, reachTestApp } from './reach-support';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
});

afterEach(() => {
  useSocketFactory(null);
});

afterAll(() => {
  useSocketFactory(null);
});

interface Data<T> {
  data: T;
}
interface Paged<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
  meta: { unreadCount: number };
}
interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
interface Thread {
  threadKey: string;
  prospect: { email: string } | null;
  mailbox: { id: string; email: string };
  lastInbound: { id: string; kind: string; label: string | null; readAt: string | null };
  messageCount: number;
}
interface Message {
  id: string;
  direction: string;
  status: string | null;
  fromEmail: string;
  toEmail: string;
  subject: string | null;
  bodyText: string | null;
  threadKey: string | null;
  sentAt: string | null;
}

const THREAD = 'out-1@getacme.com';
const RAW_REPLY =
  'From: jane@acme.nl\r\nTo: sam@getacme.com\r\nSubject: Re: Quick question\r\nMessage-ID: <in-1@acme.nl>\r\n\r\nYes, send pricing.\r\n\r\nOn Mon, Oct 12, 2026 at 9:14 AM Sam <sam@getacme.com> wrote:\r\n> hi\r\n';

/** One conversation: our email out, the prospect's reply in. */
async function conversation(
  options: {
    threadKey?: string;
    kind?: 'reply' | 'auto_reply' | 'bounce';
    fromEmail?: string;
    r2Key?: string | null;
    readAt?: Date | null;
    mailbox?: Partial<Parameters<typeof seedMailbox>[1]>;
    label?: 'interested' | null;
    receivedAt?: Date;
  } = {},
) {
  const threadKey = options.threadKey ?? THREAD;
  const mailbox = await seedMailbox(db, options.mailbox);
  const prospect = await seedProspect(db, { email: options.fromEmail ?? 'jane@acme.nl' });
  await seedOutbound(db, mailbox.id, {
    messageIdHeader: threadKey,
    threadKey,
    toEmail: prospect.email,
    prospectId: prospect.id,
    subject: 'Quick question',
    bodyText: 'Hi Jane, a quick question.',
  });
  const [inbound] = await db
    .insert(reachMessages)
    .values({
      id: `rmsg_in_${threadKey.split('@')[0]}`,
      direction: 'in',
      mailboxId: mailbox.id,
      prospectId: prospect.id,
      messageIdHeader: `in-${threadKey}`,
      threadKey,
      inReplyTo: threadKey,
      fromEmail: prospect.email,
      toEmail: mailbox.email,
      subject: 'Re: Quick question',
      snippet: 'Sounds interesting',
      kind: options.kind ?? 'reply',
      label: options.label ?? null,
      receivedAt: options.receivedAt ?? new Date('2026-10-12T14:40:00Z'),
      readAt: options.readAt ?? null,
      r2Key: options.r2Key ?? null,
    })
    .returning();
  return { mailbox, prospect, inbound: inbound! };
}

/** A fake submission server that accepts one email. */
function acceptingServer(mailboxEmail: string, to = 'jane@acme.nl') {
  const script: ScriptStep[] = [
    { expect: /^EHLO /, reply: ['250-mail.example.test at your service', '250-AUTH LOGIN PLAIN', '250 ENHANCEDSTATUSCODES'] },
    { expect: /^AUTH PLAIN /, reply: '235 2.7.0 Accepted' },
    { expect: `MAIL FROM:<${mailboxEmail}>`, reply: '250 2.1.0 OK' },
    { expect: `RCPT TO:<${to}>`, reply: '250 2.1.5 OK' },
    { expect: 'DATA', reply: '354 Go ahead', data: { reply: '250 2.0.0 OK 1700000000 abc - gsmtp' } },
  ];
  const server = new FakeSmtpServer({ script });
  useSocketFactory(server.connect);
  return server;
}

/** A server that must not be reached: a refusal that comes before the send never connects. */
function silentServer() {
  const server = new FakeSmtpServer({ script: [] });
  useSocketFactory(server.connect);
  return server;
}

const outbound = async () => db.select().from(reachMessages).where(eq(reachMessages.direction, 'out'));

describe('GET /v1/reach/threads', () => {
  it('lists the threads with their latest reply and the inbox-wide unread count in meta', async () => {
    const prospect = await conversation({ r2Key: 'reach/org/in-1.eml' });
    await conversation({ threadKey: 'out-2@getacme.com', fromEmail: 'joe@acme.nl', readAt: new Date('2026-10-12T15:00:00Z'), receivedAt: new Date('2026-10-12T15:00:00Z') });
    const app = reachTestApp({ db });

    const res = await app.get<Paged<Thread>>('/v1/reach/threads');
    expect(res.status).toBe(200);
    expect(res.body.data.map((t) => t.threadKey)).toEqual(['out-2@getacme.com', THREAD]);
    expect(res.body.data[1]).toMatchObject({
      prospect: { email: 'jane@acme.nl' },
      mailbox: { id: prospect.mailbox.id },
      lastInbound: { kind: 'reply', readAt: null },
      messageCount: 2,
    });
    expect(res.body.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });
    expect(res.body.meta).toEqual({ unreadCount: 1 });
  });

  it('filters by state, label and kind, and the unread count ignores the filters', async () => {
    await conversation({ label: 'interested' });
    await conversation({ threadKey: 'out-2@getacme.com', fromEmail: 'joe@acme.nl', kind: 'auto_reply', readAt: new Date() });
    const app = reachTestApp({ db });

    const unread = await app.get<Paged<Thread>>('/v1/reach/threads?state=unread');
    expect(unread.body.data.map((t) => t.threadKey)).toEqual([THREAD]);
    expect(unread.body.meta.unreadCount).toBe(1);

    const labelled = await app.get<Paged<Thread>>('/v1/reach/threads?state=all&label=interested');
    expect(labelled.body.data.map((t) => t.threadKey)).toEqual([THREAD]);

    const auto = await app.get<Paged<Thread>>('/v1/reach/threads?state=all&kind=auto_reply');
    expect(auto.body.data.map((t) => t.threadKey)).toEqual(['out-2@getacme.com']);
    expect(auto.body.meta.unreadCount).toBe(1);
  });

  it('pages with the cursor', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await conversation({ threadKey: `out-${i}@getacme.com`, fromEmail: `lead${i}@acme.nl`, receivedAt: new Date(`2026-10-12T1${i}:00:00Z`) });
    }
    const app = reachTestApp({ db });

    const first = await app.get<Paged<Thread>>('/v1/reach/threads?limit=2');
    expect(first.body.data).toHaveLength(2);
    expect(first.body.pagination).toMatchObject({ totalCount: 3, hasMore: true });
    const second = await app.get<Paged<Thread>>(`/v1/reach/threads?limit=2&cursor=${encodeURIComponent(first.body.pagination.cursor!)}`);
    expect(second.body.data.map((t) => t.threadKey)).toEqual(['out-1@getacme.com']);
    expect(second.body.pagination).toMatchObject({ hasMore: false, cursor: null });
  });

  it('answers a bad filter with 400 in the documented envelope', async () => {
    const app = reachTestApp({ db });
    for (const query of ['state=bogus', 'label=bogus', 'kind=bogus', 'limit=101', 'limit=0']) {
      const res = await app.get<ErrorBody>(`/v1/reach/threads?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'Validation failed' });
    }
  });
});

describe('GET /v1/reach/threads/:threadKey', () => {
  it('answers every message, with the reply text read from the raw copy in R2', async () => {
    await conversation({ r2Key: 'reach/org/in-1.eml' });
    const app = reachTestApp({ db, storage: { 'reach/org/in-1.eml': RAW_REPLY } });

    const res = await app.get<Data<{ threadKey: string; summary: Thread; messages: Message[] }>>(`/v1/reach/threads/${encodeURIComponent(THREAD)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.threadKey).toBe(THREAD);
    expect(res.body.data.summary).toMatchObject({ threadKey: THREAD, messageCount: 2 });
    expect(res.body.data.messages.map((m) => [m.direction, m.bodyText])).toEqual([
      ['out', 'Hi Jane, a quick question.'],
      ['in', 'Yes, send pricing.'],
    ]);
  });

  it('falls back to the snippet when the raw copy is gone', async () => {
    await conversation({ r2Key: 'reach/org/gone.eml' });
    const app = reachTestApp({ db });
    const res = await app.get<Data<{ messages: Message[] }>>(`/v1/reach/threads/${encodeURIComponent(THREAD)}`);
    expect(res.body.data.messages[1]?.bodyText).toBe('Sounds interesting');
  });

  it('answers 404 for an unknown key and for a thread nobody has replied to', async () => {
    const mailbox = await seedMailbox(db);
    await seedOutbound(db, mailbox.id, { messageIdHeader: 'lonely@getacme.com', threadKey: 'lonely@getacme.com' });
    const app = reachTestApp({ db });

    for (const key of ['nope@getacme.com', 'lonely@getacme.com']) {
      const res = await app.get<ErrorBody>(`/v1/reach/threads/${encodeURIComponent(key)}`);
      expect(res.status, key).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('takes the key whether or not the @ is encoded', async () => {
    await conversation();
    const app = reachTestApp({ db });
    expect((await app.get(`/v1/reach/threads/${THREAD}`)).status).toBe(200);
    expect((await app.get(`/v1/reach/threads/${encodeURIComponent(THREAD)}`)).status).toBe(200);
  });
});

describe('POST /v1/reach/threads/:threadKey/reply', () => {
  /** A key that holds the named-only reply scope (`*` never does), plus what the tests read and set up with. */
  const replyApp = (options: Partial<Parameters<typeof reachTestApp>[0]> = {}) =>
    reachTestApp({ db, scopes: ['reach_inbox:read', 'reach_inbox:reply', 'reach_settings:write'], ...options });

  const reply = (app: ReturnType<typeof reachTestApp>, body: unknown = { body: 'Hi Jane,\n\nThursday works. Does 10:00 suit you?\n\nSam' }, key = THREAD) =>
    app.send<Data<Message> & ErrorBody>('POST', `/v1/reach/threads/${encodeURIComponent(key)}/reply`, body);

  it('answers 201 with the sent message, threaded under the reply, and marks the thread read', async () => {
    const { mailbox, inbound } = await conversation();
    const server = acceptingServer(mailbox.email);
    const app = replyApp();

    const res = await reply(app);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      direction: 'out',
      status: 'sent',
      mailboxId: mailbox.id,
      fromEmail: mailbox.email,
      toEmail: 'jane@acme.nl',
      subject: 'Re: Quick question',
      bodyText: 'Hi Jane,\n\nThursday works. Does 10:00 suit you?\n\nSam',
      threadKey: THREAD,
    });
    expect(res.body.data.sentAt).not.toBeNull();

    // The real SMTP conversation: authenticated, one recipient, one message, threaded, without the campaign footer.
    expect(server.errors).toEqual([]);
    expect(server.unconsumed).toEqual([]);
    expect(server.connects[0]?.address).toMatchObject({ port: 465 });
    const raw = server.bodies[0] ?? '';
    expect(raw).toContain('Subject: Re: Quick question');
    expect(raw).toContain('In-Reply-To: <in-out-1@getacme.com>');
    expect(raw).toContain('Thursday works.');
    expect(raw).not.toMatch(/weldsuite/i);

    const [stored] = await outbound().then((rows) => rows.filter((r) => r.sentBy));
    expect(stored).toMatchObject({ status: 'sent', sentBy: 'user_reach_test' });
    const [read] = await db.select({ readAt: reachMessages.readAt }).from(reachMessages).where(eq(reachMessages.id, inbound.id));
    expect(read?.readAt).not.toBeNull();
    // The unread count drops to zero.
    expect((await app.get<Paged<Thread>>('/v1/reach/threads')).body.meta.unreadCount).toBe(0);
    // No mailbox login anywhere in the response; a reply publishes no entity event, as in the app.
    expect(JSON.stringify(res.body)).not.toMatch(/smtp|password|credential/i);
    expect(app.events).toHaveLength(0);
  });

  it('sends from a warming or paused mailbox: the prospect wrote to that address first', async () => {
    for (const status of ['warming', 'paused'] as const) {
      await resetReach(db);
      const { mailbox } = await conversation({ mailbox: { status } });
      acceptingServer(mailbox.email);
      const res = await reply(replyApp());
      expect(res.status, status).toBe(201);
    }
  });

  describe('refuses, in the order of the app', () => {
    it('403 FORBIDDEN when the workspace may not send: subscription canceled', async () => {
      const { mailbox } = await conversation();
      const server = silentServer();
      const app = replyApp({ access: approvedAccess({ billingStatus: 'canceled' }) });

      const res = await reply(app);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN' });
      expect(res.body.error.message).toContain('billing_canceled');
      expect(server.connects).toHaveLength(0);
      expect((await outbound()).filter((r) => r.sentBy)).toHaveLength(0);
      expect(mailbox.id).toBeTruthy();
    });

    it('403 FORBIDDEN once a past-due subscription is past its 7 days of grace, and sends inside them', async () => {
      const { mailbox } = await conversation();
      const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

      const late = await reply(replyApp({ access: approvedAccess({ billingStatus: 'past_due', billingStatusAt: daysAgo(8) }) }));
      expect(late.status).toBe(403);
      expect(late.body.error.message).toContain('billing_past_due');

      acceptingServer(mailbox.email);
      const grace = await reply(replyApp({ access: approvedAccess({ billingStatus: 'past_due', billingStatusAt: daysAgo(3) }) }));
      expect(grace.status).toBe(201);
    });

    it('503 SERVICE_UNAVAILABLE while the global weldreach-sending switch is off', async () => {
      await conversation();
      const server = silentServer();
      const res = await reply(replyApp({ sendingEnabled: false }));

      expect(res.status).toBe(503);
      expect(res.body.error).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Sending is paused. Try again later.' });
      expect(server.connects).toHaveLength(0);
    });

    it('checks billing before the switch, and the switch before the thread', async () => {
      const both = await reply(replyApp({ sendingEnabled: false, access: approvedAccess({ billingStatus: 'canceled' }) }), { body: 'Hello' }, 'nope@getacme.com');
      expect(both.status).toBe(403);

      const switchFirst = await reply(replyApp({ sendingEnabled: false }), { body: 'Hello' }, 'nope@getacme.com');
      expect(switchFirst.status).toBe(503);
    });

    it('404 NOT_FOUND for a thread nobody has replied to, or that does not exist', async () => {
      const mailbox = await seedMailbox(db);
      await seedOutbound(db, mailbox.id, { messageIdHeader: 'lonely@getacme.com', threadKey: 'lonely@getacme.com' });
      const server = silentServer();
      const app = replyApp();

      for (const key of ['nope@getacme.com', 'lonely@getacme.com']) {
        const res = await reply(app, { body: 'Hello' }, key);
        expect(res.status, key).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect(server.connects).toHaveLength(0);
    });

    it('409 CONFLICT with details.reason NO_REPLY when the thread holds only bounces and auto-replies', async () => {
      await conversation({ kind: 'bounce' });
      const server = silentServer();
      const res = await reply(replyApp());

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'NO_REPLY' } });
      expect(server.connects).toHaveLength(0);
    });

    it('409 CONFLICT with details.reason SUPPRESSED when the address is on the suppression list', async () => {
      await conversation();
      const server = silentServer();
      const app = replyApp();
      expect((await app.send('POST', '/v1/reach/suppressions', { values: ['jane@acme.nl'] })).status).toBe(201);

      const res = await reply(app);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'SUPPRESSED' } });
      expect(server.connects).toHaveLength(0);
    });

    it('502 UPSTREAM_ERROR when the mailbox cannot send, without connecting anywhere', async () => {
      await conversation({ mailbox: { status: 'suspended' } });
      const server = silentServer();
      const res = await reply(replyApp());

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ERROR');
      expect(res.body.error.message).toContain('mailbox_not_usable');
      expect(server.connects).toHaveLength(0);
    });

    it('502 UPSTREAM_ERROR when the mail server does not accept the email, leaving the thread unread', async () => {
      const { mailbox, inbound } = await conversation();
      const server = new FakeSmtpServer({
        script: [
          { expect: /^EHLO /, reply: ['250-mail.example.test', '250 AUTH PLAIN'] },
          { expect: /^AUTH PLAIN /, reply: '235 2.7.0 Accepted' },
          { expect: `MAIL FROM:<${mailbox.email}>`, reply: '250 OK' },
          { expect: 'RCPT TO:<jane@acme.nl>', reply: '550 5.1.1 No such user' },
        ],
      });
      useSocketFactory(server.connect);

      const res = await reply(replyApp());
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ERROR');
      const [failed] = (await outbound()).filter((r) => r.sentBy);
      expect(failed?.status).toBe('failed');
      const [row] = await db.select({ readAt: reachMessages.readAt }).from(reachMessages).where(eq(reachMessages.id, inbound.id));
      expect(row?.readAt).toBeNull();
    });

    it('502 UPSTREAM_ERROR, not a crash, when the connection cannot be made', async () => {
      await conversation();
      // No socket factory installed: connecting throws, and the send is reported as failed.
      const res = await reply(replyApp());
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ERROR');
    });

    it('502 UPSTREAM_ERROR when the mailbox login cannot be opened (a different encryption key)', async () => {
      await conversation();
      const server = silentServer();
      const wrongKey = replyApp({ env: { DATABASE_ENCRYPTION_KEY: 'f'.repeat(64), DATABASE_ENCRYPTION_KEY_V2: undefined } });
      const res = await reply(wrongKey);
      expect(res.status).toBe(502);
      expect(res.body.error.message).toContain('credentials_unavailable');
      expect(server.connects).toHaveLength(0);
    });

    it('400 BAD_REQUEST in the documented envelope for a body that is empty, missing or too long', async () => {
      await conversation();
      const app = replyApp();
      for (const body of [{ body: '' }, { body: '   ' }, {}, { body: 'x'.repeat(20_001) }]) {
        const res = await reply(app, body);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'Validation failed' });
      }
      expect((await outbound()).filter((r) => r.sentBy)).toHaveLength(0);
    });
  });
});
