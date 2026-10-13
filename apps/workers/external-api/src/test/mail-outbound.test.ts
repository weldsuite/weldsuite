/**
 * Outbound mail guard on the public API's send routes.
 *
 * The routes run the real send path (`@weldsuite/mail-domain/send`) against
 * fake bindings: a `SEND_EMAIL` that records or refuses, and an
 * `OUTBOUND_LEDGER` Durable Object whose `reserve` answers what the test says.
 * What must hold:
 *   - every send is labelled source `api` and reaches the ledger, and a send
 *     that goes out is committed (a refused one is released);
 *   - each guard denial maps to the status in `outboundDenialStatus`, with
 *     `Retry-After` whenever `details.retryAfter` says a retry can succeed;
 *   - a sender owned by another workspace is a 403 that does not say whose;
 *   - Cloudflare's own refusals become 429 (+ `Retry-After: 60`), 503 and 502
 *     (a partial send, with who got it and who did not);
 *   - nothing is transmitted when the guard refuses.
 * docs/plans/weldmail-outbound-abuse.md.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import { schema, type Database } from '../db';
import type { ApiKeySession, Env } from '../types';
import { OUTBOUND_DENIAL_CODES, type OutboundDenialDetails } from '@weldsuite/app-api-client/schemas/outbound-mail';
import type { SenderOwnership } from '@weldsuite/mail-domain/outbound';

const ORG_ID = 'org_outbound_test';
const WORKSPACE_ID = 'ws_outbound_test';

const { mailAccounts, mailMessages, mailDomains } = schema;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;
const ids = { account: 'mail_o_team', inbound: 'msg_o_inbound' };

function workspaceKey(): ApiKeySession {
  return {
    keyId: 'key_outbound_test',
    keyType: 'workspace',
    workspaceId: WORKSPACE_ID,
    userId: null,
    scopes: ['*', 'mail_messages:send'],
    tier: 'enterprise',
    hasApiAccess: true,
    databaseUrl: null,
    clerkOrgId: ORG_ID,
    licensedApps: null,
  };
}

type LedgerDecision = {
  allow: boolean;
  mode: 'enforce' | 'shadow';
  reservationId: string | null;
  denial?: OutboundDenialDetails;
  /** Shadow mode: what enforcement would have refused. */
  shadowDenial?: OutboundDenialDetails;
};

type StubCall = unknown[];

/** An `OutboundLedger` namespace whose stub records calls and answers `reserve` with `decision`. */
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
  const namespace = { idFromName: (name: string) => name, get: () => stub } as unknown as NonNullable<Env['OUTBOUND_LEDGER']>;
  return { namespace, calls };
}

const ALLOW: LedgerDecision = { allow: true, mode: 'enforce', reservationId: 'res_1' };

function deny(details: OutboundDenialDetails): LedgerDecision {
  return { allow: false, mode: 'enforce', reservationId: null, denial: details };
}

/** An `OutboundPlatformBudget` namespace that records `trip`. */
function fakePlatform() {
  const trips: unknown[] = [];
  const stub = {
    trip: async (reason: unknown) => {
      trips.push(reason);
    },
  };
  const namespace = { idFromName: (name: string) => name, get: () => stub } as unknown as NonNullable<Env['OUTBOUND_PLATFORM']>;
  return { namespace, trips };
}

/** A Cloudflare send error: an `Error` carrying the `E_*` code the binding sets. */
function cloudflareError(code: string): Error {
  return Object.assign(new Error(`Email send failed (${code})`), { code });
}

interface SendEnvOptions {
  ledger?: NonNullable<Env['OUTBOUND_LEDGER']>;
  platform?: NonNullable<Env['OUTBOUND_PLATFORM']>;
  /** Called for every envelope; throw to refuse it. */
  onSend?: (msg: { from: string; to: string }) => void;
  /** Ownership answers for the guard's KV cache (`outbound:own:*`). */
  ownership?: SenderOwnership;
}

function sendEnv(options: SendEnvOptions = {}) {
  const sent: { from: string; to: string }[] = [];
  const env: Partial<Env> = {
    SEND_EMAIL: {
      send: async (msg: { from: string; to: string }) => {
        options.onSend?.(msg);
        sent.push(msg);
      },
    } as unknown as SendEmail,
    // Every recipient domain resolves (cached MX hit); ownership answers come from the same cache.
    WORKSPACE_CACHE: {
      get: async (key: string) => (key.startsWith('outbound:own:') ? (options.ownership ?? null) : '1'),
      put: async () => undefined,
    } as unknown as KVNamespace,
    ...(options.ledger ? { OUTBOUND_LEDGER: options.ledger } : {}),
    ...(options.platform ? { OUTBOUND_PLATFORM: options.platform } : {}),
    // The ownership check only runs when the master DB is configured; with a
    // cached answer it never connects.
    ...(options.ownership ? { DATABASE_URL_MASTER: 'postgres://unused.invalid/master' } : {}),
  };
  return { env, sent };
}

function request(env: Partial<Env>) {
  return createExternalTestApp({ session: workspaceKey(), tenantDb: db, env }).request;
}

function post(path: string, body: unknown, env: Partial<Env>) {
  return request(env)(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

const compose = (env: Partial<Env>, to = ['rcpt@example.com']) =>
  post(`/v1/mail-accounts/${ids.account}/send`, { to, subject: 'Hello', body: 'Hi there' }, env);

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db
    .insert(mailDomains)
    .values({ id: 'mdom_o_verified', domainName: 'outbound-test.dev', dnsStatus: 'verified' })
    .onConflictDoNothing();
  await db.insert(mailAccounts).values({
    id: ids.account,
    name: 'team@outbound-test.dev',
    email: 'team@outbound-test.dev',
    isShared: true,
    dailySendLimit: 500,
    accessToken: 'secret-access',
    refreshToken: 'secret-refresh',
    apiKey: 'secret-key',
    passwordHash: 'secret-hash',
  });
  await db.insert(mailMessages).values({
    id: ids.inbound,
    accountId: ids.account,
    messageId: `<${ids.inbound}@example.com>`,
    from: { email: 'customer@example.com', name: 'Customer' },
    to: [{ email: 'team@outbound-test.dev' }],
    subject: 'A question',
    textBody: 'A question body',
    labels: ['INBOX'],
    sentDate: new Date(),
  });
}, 60_000);

// ---------------------------------------------------------------------------

describe('the guard on a public API send', () => {
  it('labels the send as source api, reserves its recipients and commits after it goes out', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env, sent } = sendEnv({ ledger: ledger.namespace });

    const res = await compose(env, ['a@example.com', 'b@example.com']);
    expect(res.status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(['a@example.com', 'b@example.com']);

    expect(ledger.calls.reserve).toHaveLength(1);
    const [subject, reserved] = ledger.calls.reserve[0] as [
      { kind: string; workspaceId: string; clerkOrgId: string },
      { source: string; kind: string; sender: string; recipients: string[] },
    ];
    // The key's master workspace id is passed along, so no lookup is needed.
    expect(subject).toMatchObject({ kind: 'workspace', workspaceId: WORKSPACE_ID, clerkOrgId: ORG_ID });
    expect(reserved).toMatchObject({
      source: 'api',
      kind: 'new_thread',
      sender: 'team@outbound-test.dev',
      recipients: ['a@example.com', 'b@example.com'],
    });
    expect(ledger.calls.commit.map((c) => c[0])).toEqual(['res_1']);
    expect(ledger.calls.release).toHaveLength(0);
  });

  it('labels a reply to a received message as kind reply, still source api', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env } = sendEnv({ ledger: ledger.namespace });

    const res = await post(`/v1/mail-messages/${ids.inbound}/reply`, { body: 'Thanks!' }, env);
    expect(res.status).toBe(200);
    const reserved = ledger.calls.reserve[0]![1] as { source: string; kind: string; recipients: string[] };
    expect(reserved).toMatchObject({ source: 'api', kind: 'reply', recipients: ['customer@example.com'] });
  });

  it('sends normally when no ledger is bound (the guard fails open)', async () => {
    const { env, sent } = sendEnv();
    const res = await compose(env);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('releases the reservation when Cloudflare refused everything', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env } = sendEnv({
      ledger: ledger.namespace,
      onSend: () => {
        throw cloudflareError('E_RATE_LIMIT_EXCEEDED');
      },
    });
    expect((await compose(env)).status).toBe(429);
    expect(ledger.calls.release.map((c) => c[0])).toEqual(['res_1']);
    expect(ledger.calls.commit).toHaveLength(0);
  });
});

describe('guard denials', () => {
  const inFiveMinutes = () => new Date(Date.now() + 5 * 60_000).toISOString();

  const cases: Array<{ name: string; details: () => OutboundDenialDetails; status: number; retryAfter: boolean }> = [
    {
      name: 'SENDING_LIMITED',
      details: () => ({ code: 'SENDING_LIMITED', window: 'day', limit: 150, used: 150, retryAfter: inFiveMinutes() }),
      status: 429,
      retryAfter: true,
    },
    {
      name: 'FIRST_CONTACT_LIMITED',
      details: () => ({
        code: 'FIRST_CONTACT_LIMITED',
        window: 'day',
        limit: 50,
        used: 50,
        retryAfter: inFiveMinutes(),
        suggestWeldReach: true,
      }),
      status: 429,
      retryAfter: true,
    },
    {
      name: 'PLATFORM_LIMITED',
      details: () => ({ code: 'PLATFORM_LIMITED', retryAfter: inFiveMinutes() }),
      status: 429,
      retryAfter: true,
    },
    {
      name: 'SENDING_ON_HOLD',
      details: () => ({ code: 'SENDING_ON_HOLD', reason: 'under_review' }),
      status: 403,
      retryAfter: false,
    },
    {
      name: 'SENDING_SUSPENDED',
      details: () => ({ code: 'SENDING_SUSPENDED', reason: 'staff_suspension' }),
      status: 403,
      retryAfter: false,
    },
    {
      name: 'TOO_MANY_RECIPIENTS',
      details: () => ({ code: 'TOO_MANY_RECIPIENTS', window: 'message', limit: 20, used: 30 }),
      status: 422,
      retryAfter: false,
    },
    {
      name: 'RECIPIENT_SUPPRESSED',
      details: () => ({ code: 'RECIPIENT_SUPPRESSED', recipients: ['rcpt@example.com'] }),
      status: 422,
      retryAfter: false,
    },
  ];

  it.each(cases)('$name answers $status', async ({ name, details, status, retryAfter }) => {
    const expected = details();
    const ledger = fakeLedger(deny(expected));
    const { env, sent } = sendEnv({ ledger: ledger.namespace });

    const res = await compose(env);
    expect(res.status).toBe(status);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe(name);
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(body.error.details).toMatchObject(expected as Record<string, unknown>);

    if (retryAfter) {
      const seconds = Number(res.headers.get('Retry-After'));
      expect(seconds).toBeGreaterThan(290);
      expect(seconds).toBeLessThanOrEqual(301);
    } else {
      expect(res.headers.get('Retry-After')).toBeNull();
    }
    // Nothing went out and nothing is left reserved.
    expect(sent).toHaveLength(0);
    expect(ledger.calls.commit).toHaveLength(0);
  });

  it('covers every denial code the guard can raise', () => {
    // The table above plus SENDER_NOT_OWNED (its own test below) is the whole set:
    // a new code added to the contract needs a mapping test here.
    expect([...cases.map((c) => c.name), 'SENDER_NOT_OWNED'].sort()).toEqual([...OUTBOUND_DENIAL_CODES].sort());
  });

  it('refuses a sender another workspace owns with 403, and does not say whose it is', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env, sent } = sendEnv({ ledger: ledger.namespace, ownership: 'other' });

    const res = await compose(env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('SENDER_NOT_OWNED');
    expect(body.error.details).toBeUndefined();
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(sent).toHaveLength(0);
    // Refused before the ledger was asked.
    expect(ledger.calls.reserve).toHaveLength(0);
  });

  it('sends when the sender is owned', async () => {
    const { env, sent } = sendEnv({ ledger: fakeLedger(ALLOW).namespace, ownership: 'owned' });
    expect((await compose(env)).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('a denial in shadow mode does not block the send', async () => {
    const ledger = fakeLedger({
      allow: true,
      mode: 'shadow',
      reservationId: 'res_shadow',
      shadowDenial: { code: 'SENDING_LIMITED', window: 'day', limit: 150, used: 150 },
    });
    const { env, sent } = sendEnv({ ledger: ledger.namespace });
    expect((await compose(env)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(ledger.calls.commit.map((c) => c[0])).toEqual(['res_shadow']);
  });
});

describe('Cloudflare refusals', () => {
  it('a Cloudflare rate limit is 429 with Retry-After: 60', async () => {
    const { env } = sendEnv({
      onSend: () => {
        throw cloudflareError('E_RATE_LIMIT_EXCEEDED');
      },
    });
    const res = await compose(env);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(((await res.json()) as ErrorBody).error.code).toBe('PROVIDER_RATE_LIMITED');
  });

  it('the daily quota is 503, and trips the platform breaker', async () => {
    const platform = fakePlatform();
    const { env } = sendEnv({
      platform: platform.namespace,
      onSend: () => {
        throw cloudflareError('E_DAILY_LIMIT_EXCEEDED');
      },
    });
    const res = await compose(env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorBody).error.code).toBe('PROVIDER_DAILY_LIMIT');
    expect(platform.trips).toHaveLength(1);
  });

  it('a send that fails halfway is 502 with who got it and who did not', async () => {
    const ledger = fakeLedger(ALLOW);
    const { env, sent } = sendEnv({
      ledger: ledger.namespace,
      onSend: (msg) => {
        if (msg.to === 'second@example.com') throw cloudflareError('E_RATE_LIMIT_EXCEEDED');
      },
    });
    const res = await compose(env, ['first@example.com', 'second@example.com']);
    expect(res.status).toBe(502);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('PARTIALLY_SENT');
    expect(body.error.details).toMatchObject({ sent: ['first@example.com'], failed: ['second@example.com'] });
    expect(sent.map((m) => m.to)).toEqual(['first@example.com']);
    // The ledger counts only the recipient that got it.
    expect(ledger.calls.commit).toHaveLength(1);
    expect(ledger.calls.commit[0]).toEqual(['res_1', ['first@example.com']]);
  });
});
