/**
 * /api/reach/inbox against pglite: threads (filters, state, cursor), the
 * thread view with reply text from R2, answering through `sendFromMailbox`,
 * labelling, read / handled, and the hand-off to the CRM.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';
import {
  reachCampaigns,
  reachEnrollments,
  reachMessages,
  reachProspects,
  reachSuppressions,
  type ReachCampaign,
  type ReachEnrollment,
  type ReachMailbox,
  type ReachMessage,
  type ReachProspect,
} from '@weldsuite/db/schema';
import type { ReachMessage as ReachMessageDto, ReachThread, ReachThreadSummary } from '@weldsuite/app-api-client/schemas/reach';
import type { Env, Variables } from '../../types';
import { FakeR2Bucket, resetTables, seedCampaign, seedEnrollment, seedInbound, seedMailbox, seedOutbound, seedProspect } from '../../email/test-support';
import { loadFixture } from '../../email/__fixtures__/load';
import inboxRoutes from './index';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent), publishEntityEventRaw: vi.fn() };
});
import { publishEntityEvent } from '@weldsuite/entity-events';
const publish = vi.mocked(publishEntityEvent);

const send = vi.hoisted(() => ({ sendFromMailbox: vi.fn() }));
vi.mock('@weldsuite/reach-domain/outbound', () => send);

const BASE = '/api/reach/inbox';
const ALL = ['reach_inbox:read', 'reach_inbox:update', 'reach_inbox:reply'];

const approved: AppAccess = { workspaceId: 'ws_1', status: 'approved', limits: {}, billingStatus: 'none', billingStatusAt: null };

let db: Database;
let bucket: FakeR2Bucket;
let access: AppAccess;
let sendingFlag: boolean;

function app(perms: string[] = ALL) {
  // The access gate runs in front of /api/reach/*; the harness has no gate, so the test hands in what it sets.
  return createTestApp<Env, Variables>(BASE, inboxRoutes, {
    context: {
      appAccess: access,
      permissions: permissions(...perms),
      tenantDb: db,
      flags: { isOn: async () => sendingFlag } as never,
    },
    env: { STORAGE: bucket.asBucket() } as unknown as Partial<Env>,
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface Fixture {
  mbx1: ReachMailbox;
  mbx2: ReachMailbox;
  c1: ReachCampaign;
  c2: ReachCampaign;
  jane: ReachProspect;
  pieter: ReachProspect;
  tom: ReachProspect;
  janeEnrollment: ReachEnrollment;
  messages: Record<string, ReachMessage>;
}

const at = (hhmm: string) => new Date(`2026-10-12T${hhmm}:00Z`);

/**
 * Five threads, newest first: E (unmatched, 14:00), D (two replies, latest 13:00),
 * C (auto-reply, 12:00, system-handled), B (handled, 11:00), A (10:00).
 */
async function seedInbox(): Promise<Fixture> {
  const mbx1 = await seedMailbox(db);
  const mbx2 = await seedMailbox(db, { email: 'kim@getacme.com', firstName: 'Kim', inboundToken: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  const c1 = await seedCampaign(db, { name: 'Logistics Q4' });
  const c2 = await seedCampaign(db, { name: 'Warehouses' });
  const jane = await seedProspect(db, { email: 'jane@acme.nl', firstName: 'Jane', lastName: 'Doe', companyName: 'Acme BV' });
  const pieter = await seedProspect(db, { email: 'pieter@acme.nl', firstName: 'Pieter' });
  const tom = await seedProspect(db, { email: 'tom@redwood.eu', firstName: 'Tom', lastName: 'Smit' });
  const janeEnrollment = await seedEnrollment(db, { campaignId: c1.id, prospectId: jane.id, mailboxId: mbx1.id, status: 'replied' });
  const tomEnrollment = await seedEnrollment(db, { campaignId: c2.id, prospectId: tom.id, mailboxId: mbx2.id, status: 'replied' });

  const messages: Record<string, ReachMessage> = {};
  messages.outA = await seedOutbound(db, { messageIdHeader: 'out-a@getacme.com', mailboxId: mbx1.id, campaignId: c1.id, enrollmentId: janeEnrollment.id, prospectId: jane.id, sentAt: at('07:00') });
  messages.a = await seedInbound(db, {
    messageIdHeader: 'in-a@mail.example', threadKey: 'out-a@getacme.com', mailboxId: mbx1.id, campaignId: c1.id,
    enrollmentId: janeEnrollment.id, prospectId: jane.id, receivedAt: at('10:00'), label: 'interested', labelSource: 'ai',
    r2Key: 'reach/org/in-a.eml',
  });
  messages.outB = await seedOutbound(db, { messageIdHeader: 'out-b@getacme.com', mailboxId: mbx1.id, campaignId: c1.id, prospectId: pieter.id, sentAt: at('07:01') });
  messages.b = await seedInbound(db, {
    messageIdHeader: 'in-b@mail.example', threadKey: 'out-b@getacme.com', mailboxId: mbx1.id, campaignId: c1.id, prospectId: pieter.id,
    fromEmail: 'pieter@acme.nl', receivedAt: at('11:00'), label: 'not_interested', labelSource: 'ai', readAt: at('11:30'), handledAt: at('11:30'), handledBy: 'user_1',
  });
  messages.c = await seedInbound(db, {
    messageIdHeader: 'in-c@mail.example', threadKey: 'out-c@getacme.com', mailboxId: mbx2.id, campaignId: c2.id, kind: 'auto_reply',
    receivedAt: at('12:00'), readAt: at('12:00'), handledAt: at('12:00'), handledBy: 'system', snippet: 'Out of office',
  });
  messages.outD = await seedOutbound(db, { messageIdHeader: 'out-d@getacme.com', mailboxId: mbx2.id, campaignId: c2.id, enrollmentId: tomEnrollment.id, prospectId: tom.id, sentAt: at('07:02') });
  messages.d1 = await seedInbound(db, {
    messageIdHeader: 'in-d1@mail.example', threadKey: 'out-d@getacme.com', mailboxId: mbx2.id, campaignId: c2.id, enrollmentId: tomEnrollment.id,
    prospectId: tom.id, fromEmail: 'tom@redwood.eu', receivedAt: at('08:00'), snippet: 'First answer',
  });
  messages.d2 = await seedInbound(db, {
    messageIdHeader: 'in-d2@mail.example', threadKey: 'out-d@getacme.com', mailboxId: mbx2.id, campaignId: c2.id, enrollmentId: tomEnrollment.id,
    prospectId: tom.id, fromEmail: 'tom@redwood.eu', receivedAt: at('13:00'), snippet: 'Second answer', r2Key: 'reach/org/in-d2.eml',
  });
  messages.e = await seedInbound(db, {
    messageIdHeader: 'in-e@mail.example', threadKey: 'in-e@mail.example', mailboxId: mbx1.id, fromEmail: 'stranger@unknown.example',
    receivedAt: at('14:00'), snippet: 'Who is this?',
  });
  return { mbx1, mbx2, c1, c2, jane, pieter, tom, janeEnrollment, messages };
}

let fx: Fixture;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
  bucket = new FakeR2Bucket();
  access = approved;
  sendingFlag = true;
  publish.mockClear();
  send.sendFromMailbox.mockReset();
  fx = await seedInbox();
});

describe('GET / (threads)', () => {
  it('lists open threads, newest reply first, with prospect, campaign and mailbox', async () => {
    const res = await app().request(BASE);
    expect(res.status).toBe(200);
    const body = await json<{ data: ReachThreadSummary[]; pagination: Record<string, unknown> }>(res);
    expect(body.data.map((t) => t.threadKey)).toEqual(['in-e@mail.example', 'out-d@getacme.com', 'out-a@getacme.com']);
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });

    const a = body.data[2]!;
    expect(a.prospect).toEqual({ id: fx.jane.id, email: 'jane@acme.nl', firstName: 'Jane', lastName: 'Doe', companyName: 'Acme BV', personId: null });
    expect(a.campaign).toEqual({ id: fx.c1.id, name: 'Logistics Q4' });
    expect(a.mailbox).toEqual({ id: fx.mbx1.id, email: 'sam@getacme.com' });
    expect(a.lastInbound).toMatchObject({ id: fx.messages.a!.id, kind: 'reply', label: 'interested', readAt: null, handledAt: null });
    expect(a.messageCount).toBe(2);

    const d = body.data[1]!;
    // The thread is summarised by its latest reply and counts every message in it.
    expect(d.lastInbound.id).toBe(fx.messages.d2!.id);
    expect(d.messageCount).toBe(3);

    const e = body.data[0]!;
    expect(e.prospect).toBeNull();
    expect(e.campaign).toBeNull();
  });

  it('state=all also shows handled and system-handled threads', async () => {
    const res = await app().request(`${BASE}?state=all`);
    const body = await json<{ data: Array<{ threadKey: string }> }>(res);
    expect(body.data.map((t) => t.threadKey)).toEqual([
      'in-e@mail.example', 'out-d@getacme.com', 'out-c@getacme.com', 'out-b@getacme.com', 'out-a@getacme.com',
    ]);
  });

  it('state=handled', async () => {
    const body = await json<{ data: Array<{ threadKey: string }> }>(await app().request(`${BASE}?state=handled`));
    expect(body.data.map((t) => t.threadKey)).toEqual(['out-c@getacme.com', 'out-b@getacme.com']);
  });

  it('state=unread judges the latest reply of each thread', async () => {
    const body = await json<{ data: Array<{ threadKey: string }> }>(await app().request(`${BASE}?state=unread`));
    expect(body.data.map((t) => t.threadKey)).toEqual(['in-e@mail.example', 'out-d@getacme.com', 'out-a@getacme.com']);
  });

  it('filters by label, kind, campaign and mailbox', async () => {
    const keys = async (query: string) =>
      (await json<{ data: Array<{ threadKey: string }> }>(await app().request(`${BASE}?state=all&${query}`))).data.map((t) => t.threadKey);
    expect(await keys('label=interested')).toEqual(['out-a@getacme.com']);
    expect(await keys('kind=auto_reply')).toEqual(['out-c@getacme.com']);
    expect(await keys(`campaignId=${fx.c2.id}`)).toEqual(['out-d@getacme.com', 'out-c@getacme.com']);
    expect(await keys(`mailboxId=${fx.mbx2.id}`)).toEqual(['out-d@getacme.com', 'out-c@getacme.com']);
    expect(await keys(`mailboxId=${fx.mbx1.id}&label=not_interested`)).toEqual(['out-b@getacme.com']);
  });

  it('pages with a cursor', async () => {
    const first = await json<{ data: Array<{ threadKey: string }>; pagination: { totalCount: number; hasMore: boolean; cursor: string } }>(
      await app().request(`${BASE}?state=all&limit=2`),
    );
    expect(first.data.map((t) => t.threadKey)).toEqual(['in-e@mail.example', 'out-d@getacme.com']);
    expect(first.pagination).toMatchObject({ totalCount: 5, hasMore: true });
    expect(first.pagination.cursor).toBeTruthy();

    const second = await json<{ data: Array<{ threadKey: string }>; pagination: { hasMore: boolean; cursor: string } }>(
      await app().request(`${BASE}?state=all&limit=2&cursor=${encodeURIComponent(first.pagination.cursor)}`),
    );
    expect(second.data.map((t) => t.threadKey)).toEqual(['out-c@getacme.com', 'out-b@getacme.com']);
    expect(second.pagination.hasMore).toBe(true);

    const third = await json<{ data: Array<{ threadKey: string }>; pagination: { hasMore: boolean; cursor: string | null } }>(
      await app().request(`${BASE}?state=all&limit=2&cursor=${encodeURIComponent(second.pagination.cursor)}`),
    );
    expect(third.data.map((t) => t.threadKey)).toEqual(['out-a@getacme.com']);
    expect(third.pagination).toMatchObject({ hasMore: false, cursor: null });
  });

  it('breaks ties on the reply time by message id', async () => {
    await seedInbound(db, { messageIdHeader: 'in-t1@x', threadKey: 'tie-1', mailboxId: fx.mbx1.id, receivedAt: at('15:00') });
    await seedInbound(db, { messageIdHeader: 'in-t2@x', threadKey: 'tie-2', mailboxId: fx.mbx1.id, receivedAt: at('15:00') });
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 3; page++) {
      const body = await json<{ data: Array<{ threadKey: string }>; pagination: { hasMore: boolean; cursor: string | null } }>(
        await app().request(`${BASE}?limit=1${cursor}`),
      );
      seen.push(...body.data.map((t) => t.threadKey));
      if (!body.pagination.hasMore) break;
      cursor = `&cursor=${encodeURIComponent(body.pagination.cursor!)}`;
    }
    expect(seen.slice(0, 2).sort()).toEqual(['tie-1', 'tie-2']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects an unknown filter value', async () => {
    expect((await app().request(`${BASE}?state=weird`)).status).toBe(400);
  });
});

describe('GET /unread-count', () => {
  it('counts threads whose latest reply is unread', async () => {
    const res = await app().request(`${BASE}/unread-count`);
    expect(await json<{ data: { count: number } }>(res)).toEqual({ data: { count: 3 } });
  });

  it('drops when a thread is read', async () => {
    await app().request(`${BASE}/messages/${fx.messages.d2!.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ read: true }) });
    expect((await json<{ data: { count: number } }>(await app().request(`${BASE}/unread-count`))).data.count).toBe(2);
  });
});

describe('GET /threads/:threadKey', () => {
  it('returns the messages oldest first, with reply text from R2 and snippets as the fallback', async () => {
    await bucket.put('reach/org/in-d2.eml', loadFixture('gmail-reply.eml'));
    const res = await app().request(`${BASE}/threads/${encodeURIComponent('out-d@getacme.com')}`);
    expect(res.status).toBe(200);
    const { data } = await json<{ data: ReachThread }>(res);
    expect(data.threadKey).toBe('out-d@getacme.com');
    expect(data.summary.lastInbound.id).toBe(fx.messages.d2!.id);
    expect(data.messages.map((m) => m.id)).toEqual([fx.messages.outD!.id, fx.messages.d1!.id, fx.messages.d2!.id]);
    expect(data.messages[0]).toMatchObject({ direction: 'out', bodyText: 'Hi, quick question.', status: 'sent' });
    // No stored copy: the snippet stands in.
    expect(data.messages[1]!.bodyText).toBe('First answer');
    // The raw copy is parsed, and the quoted history is cut.
    expect(data.messages[2]!.bodyText).toBe('Hi Sam,\n\nThis looks interesting. Can you send me a few more details and pricing?\n\nThanks,\nJane');
  });

  it('falls back to the snippet when the object is gone from R2', async () => {
    const { data } = await json<{ data: { messages: Array<{ id: string; bodyText: string }> } }>(
      await app().request(`${BASE}/threads/${encodeURIComponent('out-d@getacme.com')}`),
    );
    expect(data.messages.find((m) => m.id === fx.messages.d2!.id)!.bodyText).toBe('Second answer');
  });

  it('marks nothing as read', async () => {
    await app().request(`${BASE}/threads/${encodeURIComponent('out-d@getacme.com')}`);
    const [row] = await db.select().from(reachMessages).where(eq(reachMessages.id, fx.messages.d2!.id));
    expect(row!.readAt).toBeNull();
  });

  it('404s for an unknown thread and for a thread with no reply', async () => {
    expect((await app().request(`${BASE}/threads/nope`)).status).toBe(404);
    expect((await app().request(`${BASE}/threads/${encodeURIComponent('out-a@getacme.com')}`)).status).toBe(200);
    await seedOutbound(db, { messageIdHeader: 'out-lonely@getacme.com', mailboxId: fx.mbx1.id });
    expect((await app().request(`${BASE}/threads/${encodeURIComponent('out-lonely@getacme.com')}`)).status).toBe(404);
  });
});

describe('POST /threads/:threadKey/reply', () => {
  const post = (threadKey: string, body: unknown = { body: 'Thanks Tom, Tuesday works.' }, perms?: string[]) =>
    app(perms).request(`${BASE}/threads/${encodeURIComponent(threadKey)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    send.sendFromMailbox.mockImplementation(async (_deps: unknown, input: { mailboxId: string; to: { email: string }; subject: string; text: string; threadKey: string }) => ({
      ok: true,
      message: await seedOutbound(db, {
        messageIdHeader: 'out-reply-1@getacme.com',
        mailboxId: input.mailboxId,
        threadKey: input.threadKey,
        toEmail: input.to.email,
        subject: input.subject,
        bodyText: input.text,
        sentBy: 'user_test_default',
      }),
    }));
  });

  // A stand-in for `sendFromMailbox` (a module mock): TypeScript only.
  it.skipIf(conformanceTarget())('sends from the mailbox that got the reply, threaded under it', async () => {
    const res = await post('out-d@getacme.com');
    expect(res.status).toBe(201);
    const { data } = await json<{ data: ReachMessageDto }>(res);
    expect(data).toMatchObject({ direction: 'out', status: 'sent', toEmail: 'tom@redwood.eu', bodyText: 'Thanks Tom, Tuesday works.', threadKey: 'out-d@getacme.com' });

    expect(send.sendFromMailbox).toHaveBeenCalledTimes(1);
    const [deps, input] = send.sendFromMailbox.mock.calls[0]!;
    expect(deps.db).toBe(db);
    expect(input).toEqual({
      mailboxId: fx.mbx2.id,
      to: { email: 'tom@redwood.eu', name: 'Tom Smit' },
      subject: 'Re: Quick question about Acme logistics',
      text: 'Thanks Tom, Tuesday works.',
      appendFooter: false,
      inReplyTo: 'in-d2@mail.example',
      references: ['out-d@getacme.com', 'in-d1@mail.example', 'in-d2@mail.example'],
      threadKey: 'out-d@getacme.com',
      campaignId: fx.c2.id,
      enrollmentId: expect.any(String),
      prospectId: fx.tom.id,
      sentBy: 'user_test_default',
    });
  });

  it('marks the thread’s replies read', async () => {
    await post('out-d@getacme.com');
    const rows = await db.select().from(reachMessages).where(eq(reachMessages.threadKey, 'out-d@getacme.com'));
    for (const row of rows.filter((r) => r.direction === 'in')) expect(row.readAt).not.toBeNull();
  });

  // A stand-in for `sendFromMailbox` (a module mock): TypeScript only.
  it.skipIf(conformanceTarget())('answers the sender of the latest reply, which may not be the prospect', async () => {
    await seedInbound(db, {
      messageIdHeader: 'in-d3@colleague.example', threadKey: 'out-d@getacme.com', mailboxId: fx.mbx2.id, prospectId: fx.tom.id,
      fromEmail: 'eva@redwood.eu', receivedAt: at('16:00'),
    });
    await post('out-d@getacme.com');
    const input = send.sendFromMailbox.mock.calls[0]![1];
    expect(input.to).toEqual({ email: 'eva@redwood.eu', name: undefined });
    expect(input.inReplyTo).toBe('in-d3@colleague.example');
  });

  // A stand-in for `sendFromMailbox` (a module mock): TypeScript only.
  it.skipIf(conformanceTarget())('answers 502 with the reason when the email could not be sent', async () => {
    send.sendFromMailbox.mockResolvedValue({ ok: false, message: null, permanent: true, recipientRejected: false, authFailed: true, error: 'auth: 535 authentication failed' });
    const res = await post('out-d@getacme.com');
    expect(res.status).toBe(502);
    expect((await json<{ error: { code: string; message: string } }>(res)).error).toEqual({ code: 'UPSTREAM_ERROR', message: 'auth: 535 authentication failed' });
    // Nothing is marked read for an answer that was not sent.
    const [row] = await db.select().from(reachMessages).where(eq(reachMessages.id, fx.messages.d2!.id));
    expect(row!.readAt).toBeNull();
  });

  // A stand-in for `sendFromMailbox` (a module mock): TypeScript only.
  it.skipIf(conformanceTarget())('answers 502 when sending throws', async () => {
    send.sendFromMailbox.mockRejectedValue(new Error('sockets unavailable'));
    expect((await post('out-d@getacme.com')).status).toBe(502);
  });

  it('refuses to email an address on the suppression list', async () => {
    await db.insert(reachSuppressions).values({ id: 'rsup_1', value: 'tom@redwood.eu', type: 'email', reason: 'unsubscribed' });
    const res = await post('out-d@getacme.com');
    expect(res.status).toBe(409);
    expect(send.sendFromMailbox).not.toHaveBeenCalled();
  });

  it('refuses a thread with nothing to answer', async () => {
    const res = await post('out-c@getacme.com');
    expect(res.status).toBe(409);
    expect(send.sendFromMailbox).not.toHaveBeenCalled();
  });

  it('404s for an unknown thread', async () => {
    expect((await post('nope')).status).toBe(404);
  });

  it('rejects an empty body', async () => {
    expect((await post('out-d@getacme.com', { body: '   ' })).status).toBe(400);
  });

  it('refuses when the workspace may not send (suspended, or billing past its grace)', async () => {
    access = { ...approved, status: 'suspended' };
    expect((await post('out-d@getacme.com')).status).toBe(403);
    access = { ...approved, billingStatus: 'past_due', billingStatusAt: '2026-01-01T00:00:00.000Z' };
    expect((await post('out-d@getacme.com')).status).toBe(403);
    expect(send.sendFromMailbox).not.toHaveBeenCalled();
  });

  it('honours the global kill switch', async () => {
    sendingFlag = false;
    expect((await post('out-d@getacme.com')).status).toBe(503);
    expect(send.sendFromMailbox).not.toHaveBeenCalled();
  });
});

describe('PATCH /messages/:id', () => {
  const patch = (id: string, body: unknown, perms?: string[]) =>
    app(perms).request(`${BASE}/messages/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  async function stored(id: string) {
    const [row] = await db.select().from(reachMessages).where(eq(reachMessages.id, id));
    return row!;
  }

  it('a person’s label is final and announced as classified', async () => {
    const res = await patch(fx.messages.d2!.id, { label: 'meeting_request' });
    expect(res.status).toBe(200);
    expect((await json<{ data: Record<string, unknown> }>(res)).data).toMatchObject({ label: 'meeting_request', labelSource: 'user' });
    expect(await stored(fx.messages.d2!.id)).toMatchObject({ label: 'meeting_request', labelSource: 'user' });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({ entityType: 'reach_reply', action: 'classified', entityId: fx.messages.d2!.id });
    expect(publish.mock.calls[0]![0].data).toMatchObject({ label: 'meeting_request', labelSource: 'user' });
    const [after] = await db.select({ stats: reachCampaigns.stats }).from(reachCampaigns).where(eq(reachCampaigns.id, fx.c2.id));
    expect(after!.stats.interested).toBe(1);
  });

  it('moving a label out of interested takes it back off the counter', async () => {
    await patch(fx.messages.d2!.id, { label: 'interested' });
    await patch(fx.messages.d2!.id, { label: 'not_now' });
    const [after] = await db.select({ stats: reachCampaigns.stats }).from(reachCampaigns).where(eq(reachCampaigns.id, fx.c2.id));
    expect(after!.stats.interested).toBe(0);
    expect(publish.mock.calls[1]![0].changes).toEqual({ label: { old: 'interested', new: 'not_now' } });
  });

  it('"unsubscribe" suppresses the address and ends the sequence', async () => {
    const res = await patch(fx.messages.a!.id, { label: 'unsubscribe' });
    expect(res.status).toBe(200);
    const [suppression] = await db.select().from(reachSuppressions).where(eq(reachSuppressions.value, 'jane@acme.nl'));
    expect(suppression).toMatchObject({ reason: 'unsubscribed', source: fx.messages.a!.id });
    const [enrollment] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, fx.janeEnrollment.id));
    expect(enrollment!.status).toBe('unsubscribed');
    const [prospect] = await db.select().from(reachProspects).where(eq(reachProspects.id, fx.jane.id));
    expect(prospect!.validation).toBe('suppressed');
  });

  it('marking a reply read also marks the earlier replies of the thread', async () => {
    await patch(fx.messages.d2!.id, { read: true });
    expect((await stored(fx.messages.d2!.id)).readAt).not.toBeNull();
    expect((await stored(fx.messages.d1!.id)).readAt).not.toBeNull();
    // Other threads are untouched.
    expect((await stored(fx.messages.a!.id)).readAt).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('marking unread only touches that message', async () => {
    await patch(fx.messages.d2!.id, { read: true });
    await patch(fx.messages.d2!.id, { read: false });
    expect((await stored(fx.messages.d2!.id)).readAt).toBeNull();
    expect((await stored(fx.messages.d1!.id)).readAt).not.toBeNull();
  });

  it('handled records who handled it, and implies read; unhandling reopens the thread', async () => {
    const res = await patch(fx.messages.a!.id, { handled: true });
    const { data } = await json<{ data: Record<string, unknown> }>(res);
    expect(data.handledAt).toEqual(expect.any(String));
    expect(await stored(fx.messages.a!.id)).toMatchObject({ handledBy: 'user_test_default' });
    expect((await stored(fx.messages.a!.id)).readAt).not.toBeNull();
    const open = await json<{ data: Array<{ threadKey: string }> }>(await app().request(BASE));
    expect(open.data.map((t) => t.threadKey)).not.toContain('out-a@getacme.com');

    await patch(fx.messages.a!.id, { handled: false });
    expect(await stored(fx.messages.a!.id)).toMatchObject({ handledAt: null, handledBy: null });
    const reopened = await json<{ data: Array<{ threadKey: string }> }>(await app().request(BASE));
    expect(reopened.data.map((t) => t.threadKey)).toContain('out-a@getacme.com');
  });

  it('a new reply reopens a handled thread', async () => {
    await patch(fx.messages.a!.id, { handled: true });
    await seedInbound(db, { messageIdHeader: 'in-a2@mail.example', threadKey: 'out-a@getacme.com', mailboxId: fx.mbx1.id, prospectId: fx.jane.id, receivedAt: at('17:00') });
    const open = await json<{ data: Array<{ threadKey: string }> }>(await app().request(BASE));
    expect(open.data[0]!.threadKey).toBe('out-a@getacme.com');
  });

  it('404s for an unknown message and for an outbound one', async () => {
    expect((await patch('rmsg_missing', { read: true })).status).toBe(404);
    expect((await patch(fx.messages.outA!.id, { read: true })).status).toBe(404);
  });

  it('rejects an unknown label', async () => {
    expect((await patch(fx.messages.a!.id, { label: 'spicy' })).status).toBe(400);
  });
});

describe('POST /threads/:threadKey/add-to-crm', () => {
  const post = (threadKey: string, body: unknown = {}, perms?: string[]) =>
    app(perms).request(`${BASE}/threads/${encodeURIComponent(threadKey)}/add-to-crm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('creates the person and company and links the prospect', async () => {
    const res = await post('out-a@getacme.com');
    expect(res.status).toBe(200);
    const { data } = await json<{ data: { personId: string; opportunityId: string | null } }>(res);
    expect(data.opportunityId).toBeNull();

    const [person] = await db.select().from(schema.people).where(eq(schema.people.id, data.personId));
    expect(person).toMatchObject({ email: 'jane@acme.nl', firstName: 'Jane', lastName: 'Doe', inCrm: true });
    const [company] = await db.select().from(schema.companies);
    expect(company).toMatchObject({ name: 'Acme BV', website: 'https://acme.nl' });
    const [prospect] = await db.select().from(reachProspects).where(eq(reachProspects.id, fx.jane.id));
    expect(prospect!.personId).toBe(data.personId);

    const events = publish.mock.calls.map((call) => `${call[0].entityType}:${call[0].action}`);
    expect(events).toEqual(expect.arrayContaining(['person:created', 'company:created']));
  });

  it('is idempotent', async () => {
    const first = await json<{ data: { personId: string } }>(await post('out-a@getacme.com'));
    const second = await json<{ data: { personId: string } }>(await post('out-a@getacme.com'));
    expect(second.data.personId).toBe(first.data.personId);
    expect(await db.select().from(schema.people)).toHaveLength(1);
    expect(await db.select().from(schema.companies)).toHaveLength(1);
  });

  it('opens an opportunity in the chosen pipeline stage', async () => {
    await db.insert(schema.crmPipelineStages).values({ id: 'pls_qualified', name: 'Qualified', position: 1, pipeline: 'default' });
    const res = await post('out-a@getacme.com', { opportunity: { pipelineId: 'default', stageId: 'pls_qualified', name: 'Acme logistics deal' } });
    expect(res.status).toBe(200);
    const { data } = await json<{ data: { personId: string; opportunityId: string } }>(res);
    const [opportunity] = await db.select().from(schema.crmOpportunities).where(eq(schema.crmOpportunities.id, data.opportunityId));
    const [company] = await db.select().from(schema.companies);
    expect(opportunity).toMatchObject({ name: 'Acme logistics deal', customerId: company!.id, primaryContactId: data.personId, stageId: 'pls_qualified', pipeline: 'default' });
    expect(publish.mock.calls.some((c) => c[0].entityType === 'opportunity' && c[0].action === 'created')).toBe(true);
  });

  it('rejects an unknown stage or one from another pipeline before creating anything', async () => {
    await db.insert(schema.crmPipelineStages).values({ id: 'pls_other', name: 'Other', position: 1, pipeline: 'enterprise' });
    expect((await post('out-a@getacme.com', { opportunity: { pipelineId: 'default', stageId: 'pls_missing' } })).status).toBe(400);
    expect((await post('out-a@getacme.com', { opportunity: { pipelineId: 'default', stageId: 'pls_other' } })).status).toBe(400);
    expect(await db.select().from(schema.people)).toHaveLength(0);
  });

  it('works for a sender that matched no prospect', async () => {
    const res = await post('in-e@mail.example');
    expect(res.status).toBe(200);
    const [person] = await db.select().from(schema.people);
    expect(person).toMatchObject({ email: 'stranger@unknown.example', inCrm: true });
    // A free-mail or unknown domain without a company name still gets a company from its domain.
    expect(await db.select().from(schema.companies)).toHaveLength(1);
  });

  it('404s for an unknown thread', async () => {
    expect((await post('nope')).status).toBe(404);
  });
});

describe('permissions', () => {
  const cases: Array<[string, string, string, string, unknown?]> = [
    ['GET /', 'GET', BASE, 'reach_inbox:read'],
    ['GET /unread-count', 'GET', `${BASE}/unread-count`, 'reach_inbox:read'],
    ['GET /threads/:key', 'GET', `${BASE}/threads/out-a%40getacme.com`, 'reach_inbox:read'],
    ['POST reply', 'POST', `${BASE}/threads/out-a%40getacme.com/reply`, 'reach_inbox:reply', { body: 'hi' }],
    ['PATCH message', 'PATCH', `${BASE}/messages/rmsg_x`, 'reach_inbox:update', { read: true }],
    ['POST add-to-crm', 'POST', `${BASE}/threads/out-a%40getacme.com/add-to-crm`, 'reach_inbox:update', {}],
  ];

  it.each(cases)('%s answers 403 without %s', async (_label, method, url, _perm, body) => {
    const res = await app([]).request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(res.status).toBe(403);
  });

  it.each(cases)('%s is not opened by the other inbox permissions', async (_label, method, url, perm, body) => {
    const others = ALL.filter((p) => p !== perm);
    const res = await app(others).request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(res.status).toBe(403);
  });
});
