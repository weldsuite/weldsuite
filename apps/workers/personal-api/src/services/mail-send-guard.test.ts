/**
 * The outbound guard on personal WeldMail's send path.
 *
 * `sendAndPersist` / `replyAndPersist` / `forwardAndPersist` run against a
 * hand-made personal DB and fake bindings: a `SEND_EMAIL` that records or
 * refuses, and an `OUTBOUND_LEDGER` Durable Object whose `reserve` answers what
 * the test says. What must hold:
 *   - the guard is asked with the personal subject (account id + plan), source
 *     `personal`, and the right kind: `reply` only for a message someone sent
 *     to the mailbox, `forward` for forwards, `new_thread` otherwise (a client
 *     naming a message id in `inReplyTo` cannot claim `reply`);
 *   - a send that goes out is committed, one that did not is released;
 *   - a denial surfaces as a `PersonalMailSendError` with the same code and
 *     details, and nothing is transmitted or stored;
 *   - Cloudflare's own refusals keep their meaning, and a send that failed
 *     halfway counts only the recipients that got it;
 *   - the plan's own daily limit still holds, ahead of the guard.
 * docs/plans/weldmail-outbound-abuse.md.
 */

import { describe, expect, it } from 'vitest';
import type { OutboundDenialDetails } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { FREE_ENTITLEMENTS, PRO_ENTITLEMENTS } from '../lib/billing';
import type { PersonalDatabase } from '../db';
import type { Env } from '../types';
import { PersonalMailSendError, forwardAndPersist, replyAndPersist, sendAndPersist } from './mail-send';

const PERSONAL_ACCOUNT_ID = 'pa_test';
const ACCOUNT_ID = 'pma_test';
const SELF = 'me@weldmail.com';

type Row = Record<string, unknown>;

const accountRow: Row = {
  id: ACCOUNT_ID,
  personalAccountId: PERSONAL_ACCOUNT_ID,
  email: SELF,
  name: 'Me',
  displayName: null,
  sentToday: 0,
};

/** A stored message of this mailbox, as `requireMessage` returns it. */
function messageRow(fields: Row): Row {
  return {
    id: 'pmsg_original',
    personalAccountId: PERSONAL_ACCOUNT_ID,
    accountId: ACCOUNT_ID,
    messageId: '<original@example.com>',
    threadId: '<original@example.com>',
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: SELF }],
    cc: null,
    replyTo: null,
    subject: 'A question',
    textBody: 'The original text',
    htmlBody: null,
    references: null,
    sentDate: new Date('2026-10-01T10:00:00Z'),
    createdAt: new Date('2026-10-01T10:00:00Z'),
    source: 'inbound',
    ...fields,
  };
}

interface FakeDbOptions {
  /** Answers to `select()` calls with no column list (`requireMessage`, `requireAccount`), in call order. */
  rows?: Row[];
  /** What `inReplyTo` resolves to: a stored parent's `source`, or no stored parent. */
  parent?: { source: string | null } | null;
  /** Composed sends already counted today. */
  sentToday?: number;
}

/**
 * Just the Drizzle chains `mail-send.ts` uses. A chain is a thenable that
 * answers whatever the call site is known to want, whichever methods it
 * strings together.
 */
function fakeDb(options: FakeDbOptions = {}) {
  const rows = [...(options.rows ?? [accountRow])];
  const inserted: Row[] = [];

  const answer = (result: unknown[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
              Promise.resolve(result).then(resolve, reject);
          }
          return () => chain;
        },
      },
    );
    return chain;
  };

  const db = {
    select: (fields?: Row) => {
      if (!fields) return answer(rows.length ? [rows.shift()] : []);
      if ('count' in fields) return answer([{ count: options.sentToday ?? 0 }]);
      if ('source' in fields) return answer(options.parent ? [options.parent] : []);
      return answer([]);
    },
    insert: () => ({
      values: (values: Row) => {
        inserted.push(values);
        return answer([values]);
      },
    }),
    update: () => answer([]),
  };
  return { db: db as unknown as PersonalDatabase, inserted };
}

type StubCall = unknown[];

type LedgerDecision = {
  allow: boolean;
  mode: 'enforce' | 'shadow';
  reservationId: string | null;
  denial?: OutboundDenialDetails;
};

const ALLOW: LedgerDecision = { allow: true, mode: 'enforce', reservationId: 'res_1' };

function fakeLedger(decision: LedgerDecision) {
  const calls = { reserve: [] as StubCall[], commit: [] as StubCall[], release: [] as StubCall[] };
  const stub = {
    reserve: async (...args: StubCall) => {
      calls.reserve.push(args);
      return decision;
    },
    commit: async (...args: StubCall) => {
      calls.commit.push(args);
    },
    release: async (...args: StubCall) => {
      calls.release.push(args);
    },
  };
  const namespace = { idFromName: (name: string) => name, get: () => stub };
  return { namespace, calls };
}

function fakePlatform() {
  const trips: unknown[] = [];
  const stub = {
    trip: async (reason: unknown) => {
      trips.push(reason);
    },
  };
  const namespace = { idFromName: (name: string) => name, get: () => stub };
  return { namespace, trips };
}

/** A Cloudflare send error: an `Error` carrying the `E_*` code the binding sets. */
function cloudflareError(code: string): Error {
  return Object.assign(new Error(`Email send failed (${code})`), { code });
}

interface EnvOptions {
  ledger?: ReturnType<typeof fakeLedger>;
  platform?: ReturnType<typeof fakePlatform>;
  /** Called for every envelope; throw to refuse it. */
  onSend?: (msg: { from: string; to: string }) => void;
}

function fakeEnv(options: EnvOptions = {}) {
  const sent: { from: string; to: string }[] = [];
  const env = {
    SEND_EMAIL: {
      send: async (msg: { from: string; to: string }) => {
        options.onSend?.(msg);
        sent.push(msg);
      },
    },
    ...(options.ledger ? { OUTBOUND_LEDGER: options.ledger.namespace } : {}),
    ...(options.platform ? { OUTBOUND_PLATFORM: options.platform.namespace } : {}),
  } as unknown as Env;
  return { env, sent };
}

const compose = { accountId: ACCOUNT_ID, to: ['rcpt@example.com'], subject: 'Hello', textBody: 'Hi there' };

async function sendError(promise: Promise<unknown>): Promise<PersonalMailSendError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PersonalMailSendError) return err;
    throw err;
  }
  throw new Error('Expected the send to be refused');
}

describe('sendAndPersist with the outbound guard', () => {
  it('asks the guard with the personal subject, source personal and kind new_thread, then commits', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env, sent } = fakeEnv({ ledger });
    const { db, inserted } = fakeDb();

    const outcome = await sendAndPersist(env, db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, {
      ...compose,
      to: ['a@example.com', 'b@example.com'],
      cc: ['c@example.com'],
    });

    expect(sent.map((m) => m.to)).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(inserted).toHaveLength(1);
    expect(outcome.message).toBe(inserted[0]);

    expect(ledger.calls.reserve).toHaveLength(1);
    const [subject, request] = ledger.calls.reserve[0] as [
      { kind: string; personalAccountId: string; plan: string },
      { source: string; kind: string; sender: string; recipients: string[] },
    ];
    expect(subject).toEqual({ kind: 'personal', personalAccountId: PERSONAL_ACCOUNT_ID, plan: 'free' });
    expect(request).toMatchObject({
      source: 'personal',
      kind: 'new_thread',
      sender: SELF,
      recipients: ['a@example.com', 'b@example.com', 'c@example.com'],
    });
    expect(ledger.calls.commit.map((c) => c[0])).toEqual(['res_1']);
    expect(ledger.calls.release).toHaveLength(0);
  });

  it('passes the Pro plan on to the guard', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env } = fakeEnv({ ledger });
    await sendAndPersist(env, fakeDb().db, PERSONAL_ACCOUNT_ID, PRO_ENTITLEMENTS, compose);
    const [subject] = ledger.calls.reserve[0] as [{ plan: string }];
    expect(subject.plan).toBe('pro');
  });

  it('sends normally when no ledger is bound (the guard fails open)', async () => {
    const { env, sent } = fakeEnv();
    const { db, inserted } = fakeDb();
    await sendAndPersist(env, db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, compose);
    expect(sent).toHaveLength(1);
    expect(inserted).toHaveLength(1);
  });

  it('labels the unsubscribe source it is given', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env } = fakeEnv({ ledger });
    await sendAndPersist(env, fakeDb().db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, {
      ...compose,
      outbound: { source: 'subscription', kind: 'new_thread' },
    });
    expect(ledger.calls.reserve[0]![1]).toMatchObject({ source: 'subscription', kind: 'new_thread' });
  });
});

describe('the kind of a personal send', () => {
  const kindOf = async (input: Partial<typeof compose> & { inReplyTo?: string }, db = fakeDb()) => {
    const ledger = fakeLedger(ALLOW);
    await sendAndPersist(fakeEnv({ ledger }).env, db.db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, {
      ...compose,
      ...input,
    });
    return (ledger.calls.reserve[0]![1] as { kind: string }).kind;
  };

  it('is reply when inReplyTo is a message someone sent to this mailbox', async () => {
    expect(await kindOf({ inReplyTo: '<original@example.com>' }, fakeDb({ parent: { source: 'inbound' } }))).toBe('reply');
  });

  it('is new_thread for a follow-up on the mailbox\'s own sent mail', async () => {
    expect(await kindOf({ inReplyTo: '<sent@weldmail.com>' }, fakeDb({ parent: { source: 'composed' } }))).toBe('new_thread');
  });

  it('is new_thread when inReplyTo names a message the mailbox does not hold', async () => {
    expect(await kindOf({ inReplyTo: '<made-up@example.com>' }, fakeDb({ parent: null }))).toBe('new_thread');
  });

  it('replyAndPersist asks as reply when answering received mail', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env, sent } = fakeEnv({ ledger });
    // requireMessage, then requireAccount (replyAndPersist), then requireAccount again (sendAndPersist).
    const { db } = fakeDb({ rows: [messageRow({}), accountRow, accountRow], parent: { source: 'inbound' } });

    await replyAndPersist(env, db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, 'pmsg_original', { textBody: 'Thanks!' });

    expect(sent.map((m) => m.to)).toEqual(['sender@example.com']);
    expect(ledger.calls.reserve[0]![1]).toMatchObject({ source: 'personal', kind: 'reply', recipients: ['sender@example.com'] });
  });

  it('replyAndPersist on the mailbox\'s own sent message is a new conversation, not a reply', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env } = fakeEnv({ ledger });
    const sentCopy = messageRow({
      source: 'composed',
      from: { email: SELF },
      to: [{ email: 'rcpt@example.com' }],
    });
    const { db } = fakeDb({ rows: [sentCopy, accountRow, accountRow], parent: { source: 'composed' } });

    await replyAndPersist(env, db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, 'pmsg_original', { textBody: 'Bumping this' });

    expect(ledger.calls.reserve[0]![1]).toMatchObject({ kind: 'new_thread' });
  });

  it('forwardAndPersist asks as forward', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env } = fakeEnv({ ledger });
    const { db } = fakeDb({ rows: [messageRow({}), accountRow] });

    await forwardAndPersist(env, db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, 'pmsg_original', {
      to: ['friend@example.com'],
      textBody: 'FYI',
    });

    expect(ledger.calls.reserve[0]![1]).toMatchObject({ source: 'personal', kind: 'forward', recipients: ['friend@example.com'] });
  });
});

describe('guard denials', () => {
  const denial: OutboundDenialDetails = {
    code: 'SENDING_LIMITED',
    window: 'day',
    limit: 50,
    used: 50,
    retryAfter: '2026-10-14T00:00:00.000Z',
  };

  it('surfaces as a PersonalMailSendError with the same code and details, and nothing goes out', async () => {
    const ledger = fakeLedger({ allow: false, mode: 'enforce', reservationId: null, denial });
    const { env, sent } = fakeEnv({ ledger });
    const { db, inserted } = fakeDb();

    const err = await sendError(sendAndPersist(env, db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, compose));

    expect(err.code).toBe('SENDING_LIMITED');
    expect(err.details).toEqual(denial);
    expect(err.message.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(0);
    expect(inserted).toHaveLength(0);
    expect(ledger.calls.commit).toHaveLength(0);
  });

  it('the plan\'s own daily limit still holds, ahead of the guard', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env, sent } = fakeEnv({ ledger });
    const { db } = fakeDb({ sentToday: FREE_ENTITLEMENTS.dailySendLimit });

    const err = await sendError(sendAndPersist(env, db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, compose));

    expect(err.code).toBe('DAILY_LIMIT_REACHED');
    expect(ledger.calls.reserve).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe('Cloudflare refusals', () => {
  it('a Cloudflare rate limit is PROVIDER_RATE_LIMITED, and the reservation is released', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env } = fakeEnv({
      ledger,
      onSend: () => {
        throw cloudflareError('E_RATE_LIMIT_EXCEEDED');
      },
    });
    const { db, inserted } = fakeDb();

    const err = await sendError(sendAndPersist(env, db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, compose));

    expect(err.code).toBe('PROVIDER_RATE_LIMITED');
    expect(inserted).toHaveLength(0);
    expect(ledger.calls.release.map((c) => c[0])).toEqual(['res_1']);
    expect(ledger.calls.commit).toHaveLength(0);
  });

  it('the daily quota is PROVIDER_DAILY_LIMIT and trips the platform breaker', async () => {
    const platform = fakePlatform();
    const { env } = fakeEnv({
      platform,
      onSend: () => {
        throw cloudflareError('E_DAILY_LIMIT_EXCEEDED');
      },
    });

    const err = await sendError(sendAndPersist(env, fakeDb().db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, compose));

    expect(err.code).toBe('PROVIDER_DAILY_LIMIT');
    expect(platform.trips).toHaveLength(1);
  });

  it('a send that fails halfway says who got it, and the ledger counts only them', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env, sent } = fakeEnv({
      ledger,
      onSend: (msg) => {
        if (msg.to === 'second@example.com') throw cloudflareError('E_RATE_LIMIT_EXCEEDED');
      },
    });

    const err = await sendError(
      sendAndPersist(env, fakeDb().db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, {
        ...compose,
        to: ['first@example.com', 'second@example.com'],
      }),
    );

    expect(err.code).toBe('PARTIALLY_SENT');
    expect(err.details).toEqual({ sent: ['first@example.com'], failed: ['second@example.com'] });
    expect(sent.map((m) => m.to)).toEqual(['first@example.com']);
    expect(ledger.calls.commit).toEqual([['res_1', ['first@example.com']]]);
    expect(ledger.calls.release).toHaveLength(0);
  });

  it('any other transmit failure is DELIVERY_FAILED and releases the reservation', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env } = fakeEnv({
      ledger,
      onSend: () => {
        throw new Error('network down');
      },
    });

    const err = await sendError(sendAndPersist(env, fakeDb().db, PERSONAL_ACCOUNT_ID, FREE_ENTITLEMENTS, compose));

    expect(err.code).toBe('DELIVERY_FAILED');
    expect(ledger.calls.release.map((c) => c[0])).toEqual(['res_1']);
  });
});
