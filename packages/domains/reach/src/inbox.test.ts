/**
 * The reply inbox the public API reads and answers through, against pglite:
 * threads and their unread count, one thread with reply text from the raw copy
 * in R2, and `sendReply` with its checks in order and the errors it maps to.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { reachMessages, reachSuppressions } from '@weldsuite/db/schema';
import { ReachDomainError } from './errors';
import {
  countUnreadThreads,
  getThread,
  listThreads,
  referenceChain,
  sendReply,
  type SendReplyDeps,
} from './inbox';
import type { OutboundDeps, SendFromMailboxInput, SendFromMailboxResult } from './outbound';
import { resetReach, seedMailbox, seedOutbound, seedProspect, TEST_ENCRYPTION_KEY } from './testing/reach';

let db: Database;

const approved = { status: 'approved' as const, billingStatus: 'active' as const, billingStatusAt: null };

/** The slice of R2 the inbox reads. */
function bucketWith(objects: Record<string, string>): { get: (key: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> } {
  return {
    get: async (key) => {
      const text = objects[key];
      return text === undefined ? null : { arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer };
    },
  };
}

async function refused(promise: Promise<unknown>): Promise<ReachDomainError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReachDomainError);
  return err as ReachDomainError;
}

/** One conversation: our email out, the prospect's reply in. */
async function conversation(overrides: { kind?: 'reply' | 'auto_reply'; fromEmail?: string; r2Key?: string | null; prospectId?: string | null } = {}) {
  const mailbox = await seedMailbox(db);
  const out = await seedOutbound(db, mailbox.id, {
    messageIdHeader: 'out-1@getacme.com',
    threadKey: 'out-1@getacme.com',
    toEmail: 'jane@acme.nl',
  });
  const [inbound] = await db
    .insert(reachMessages)
    .values({
      id: 'rmsg_in1',
      direction: 'in',
      mailboxId: mailbox.id,
      messageIdHeader: 'in-1@acme.nl',
      threadKey: 'out-1@getacme.com',
      inReplyTo: 'out-1@getacme.com',
      fromEmail: overrides.fromEmail ?? 'jane@acme.nl',
      toEmail: mailbox.email,
      subject: 'Re: Quick question',
      snippet: 'Sounds interesting',
      kind: overrides.kind ?? 'reply',
      receivedAt: new Date('2026-10-12T14:40:00Z'),
      r2Key: overrides.r2Key ?? null,
      prospectId: overrides.prospectId ?? null,
    })
    .returning();
  return { mailbox, out, inbound: inbound! };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
});

describe('reading', () => {
  it('lists the thread with its latest reply, counts it as unread and reads the reply text from R2', async () => {
    const prospect = await seedProspect(db, { email: 'jane@acme.nl' });
    const { inbound } = await conversation({ r2Key: 'reach/org/in-1.eml', prospectId: prospect.id });

    const page = await listThreads(db, { state: 'open' });
    expect(page).toMatchObject({ totalCount: 1, hasMore: false });
    expect(page.threads[0]).toMatchObject({
      threadKey: 'out-1@getacme.com',
      prospect: { email: 'jane@acme.nl' },
      lastInbound: { id: inbound.id, kind: 'reply', snippet: 'Sounds interesting' },
      messageCount: 2,
    });
    expect(await countUnreadThreads(db)).toBe(1);

    const raw = 'From: jane@acme.nl\r\nTo: sam@getacme.com\r\nSubject: Re: Quick question\r\nMessage-ID: <in-1@acme.nl>\r\n\r\nYes, send pricing.\r\n\r\nOn Mon, Oct 12, 2026 at 9:14 AM Sam <sam@getacme.com> wrote:\r\n> hi\r\n';
    const thread = await getThread(db, { STORAGE: bucketWith({ 'reach/org/in-1.eml': raw }) }, 'out-1@getacme.com');

    expect(thread?.messages.map((m) => [m.direction, m.bodyText])).toEqual([
      ['out', null],
      ['in', 'Yes, send pricing.'],
    ]);
  });

  it('falls back to the snippet without a bucket or an object, and answers null for a thread without a reply', async () => {
    await conversation({ r2Key: 'reach/org/gone.eml' });

    expect((await getThread(db, {}, 'out-1@getacme.com'))?.messages[1]?.bodyText).toBe('Sounds interesting');
    expect((await getThread(db, { STORAGE: bucketWith({}) }, 'out-1@getacme.com'))?.messages[1]?.bodyText).toBe('Sounds interesting');
    expect(await getThread(db, {}, 'no-such-thread')).toBeNull();
  });

  it('chains the Message-IDs of a thread for References, once each, capped', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ messageIdHeader: `m${i % 25}@x` })) as Array<{ messageIdHeader: string }>;
    const chain = referenceChain(rows as never);
    expect(chain).toHaveLength(20);
    expect(new Set(chain).size).toBe(20);
  });
});

describe('sendReply', () => {
  const sent: SendFromMailboxInput[] = [];

  function setup(overrides: Partial<SendReplyDeps> = {}) {
    sent.length = 0;
    const send = vi.fn(async (_deps: OutboundDeps, input: SendFromMailboxInput): Promise<SendFromMailboxResult> => {
      sent.push(input);
      const [message] = await db.select().from(reachMessages).where(eq(reachMessages.direction, 'out')).limit(1);
      return { ok: true, message: message! };
    });
    const deps: SendReplyDeps = {
      env: { DATABASE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
      db,
      access: approved,
      sendingEnabled: true,
      send,
      ...overrides,
    };
    return { deps, send };
  }

  const input = { threadKey: 'out-1@getacme.com', body: 'Happy to. Pricing is attached.', userId: 'user_1' };

  it('answers the sender of the latest reply, threaded under it, and marks the replies read', async () => {
    const { mailbox, inbound } = await conversation();
    const { deps, send } = setup();

    const message = await sendReply(deps, input);

    expect(message).toMatchObject({ direction: 'out', status: 'sent' });
    expect(send).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({
      mailboxId: mailbox.id,
      to: { email: 'jane@acme.nl' },
      subject: 'Re: Quick question',
      text: input.body,
      appendFooter: false,
      inReplyTo: 'in-1@acme.nl',
      threadKey: 'out-1@getacme.com',
      sentBy: 'user_1',
    });
    expect(sent[0]?.references).toEqual(['out-1@getacme.com', 'in-1@acme.nl']);
    const [row] = await db.select().from(reachMessages).where(eq(reachMessages.id, inbound.id));
    expect(row?.readAt).not.toBeNull();
  });

  it('refuses a workspace that may not send with a 403 naming why, before it looks at the kill switch', async () => {
    await conversation();
    const killSwitch = vi.fn(() => true);

    const suspended = setup({ access: { ...approved, status: 'suspended' }, sendingEnabled: killSwitch });
    expect(await refused(sendReply(suspended.deps, input))).toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      message: 'Sending is not available for this workspace (access_suspended)',
    });
    const cancelled = setup({ access: { ...approved, billingStatus: 'canceled' }, sendingEnabled: killSwitch });
    expect(await refused(sendReply(cancelled.deps, input))).toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('billing_canceled') });

    expect(killSwitch).not.toHaveBeenCalled();
    expect(suspended.send).not.toHaveBeenCalled();
  });

  it('refuses while the global kill switch is off (a value or a function) with a 503', async () => {
    await conversation();
    for (const sendingEnabled of [false, async () => false]) {
      const { deps, send } = setup({ sendingEnabled });
      expect(await refused(sendReply(deps, input))).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        status: 503,
        message: 'Sending is paused. Try again later.',
      });
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('answers 404 for an unknown thread, 409 NO_REPLY when only an auto-reply came in, 409 SUPPRESSED for a suppressed sender', async () => {
    const { deps } = setup();
    expect(await refused(sendReply(deps, { ...input, threadKey: 'ghost' }))).toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      message: "Thread with ID 'ghost' not found",
    });

    await conversation({ kind: 'auto_reply' });
    expect(await refused(sendReply(deps, input))).toMatchObject({ code: 'CONFLICT', status: 409, details: { reason: 'NO_REPLY' } });

    await db.update(reachMessages).set({ kind: 'reply' }).where(eq(reachMessages.id, 'rmsg_in1'));
    await db.insert(reachSuppressions).values({ id: 'rsup_1', value: 'jane@acme.nl', type: 'email', reason: 'manual' });
    expect(await refused(sendReply(deps, input))).toMatchObject({
      code: 'CONFLICT',
      status: 409,
      message: 'This address is on the suppression list; it cannot be emailed',
      details: { reason: 'SUPPRESSED' },
    });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('answers 502 UPSTREAM_ERROR with the reason when the email could not be sent, or the send threw', async () => {
    await conversation();
    const failed = setup({
      send: async () => ({ ok: false, message: null, permanent: true, recipientRejected: false, authFailed: false, error: 'mailbox_not_usable: paused' }),
    });
    expect(await refused(sendReply(failed.deps, input))).toMatchObject({
      code: 'UPSTREAM_ERROR',
      status: 502,
      message: 'mailbox_not_usable: paused',
    });

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const threw = setup({
      send: async () => {
        throw new Error('socket closed');
      },
    });
    expect(await refused(sendReply(threw.deps, input))).toMatchObject({
      code: 'UPSTREAM_ERROR',
      status: 502,
      message: 'The email could not be sent',
    });
    error.mockRestore();
  });
});
