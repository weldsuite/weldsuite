/**
 * pglite-backed tests for the outbound guard: the inbound-correspondent
 * trigger from the tenant migration, first-contact detection, complaint
 * suppressions, the ledger round trip (a fake Durable Object namespace over
 * LedgerCore) and how sendAndPersist surfaces a denial.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));
// No network MX lookups in tests: every recipient domain resolves.
vi.mock('../recipient-validation', () => ({
  validateRecipients: async () => ({ ok: true, invalidFormat: [], unreachableDomains: [] }),
}));

import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createSqliteDurableObjectState, fireAlarm } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { OUTBOUND_DEFAULT_LIMITS } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { addSuppression, findKnownCorrespondents } from './correspondents';
import { OutboundDeniedError, checkOutbound, commitOutbound, guardedSend, type OutboundGuardEnv } from './guard';
import { LedgerCore, type LedgerPolicy, type LedgerStore, type LedgerSubject, type ReserveRequest } from './ledger-core';
import { markSentCopy, parseSendingEvent } from './delivery-events';
import { MailSendError, sendAndPersist, type MailSendEnv } from '../send';
import { MailIndex, type MailIndexEnv } from '../mail-index/mail-index';

const { mailAccounts, mailMessages, mailCorrespondents } = schema;

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function memoryStore(): LedgerStore {
  const data = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => data.get(k) as T | undefined,
    put: async (entries) => {
      for (const [k, v] of Object.entries(entries)) data.set(k, v);
    },
    delete: async (keys) => keys.length,
    list: async <T,>({ prefix }: { prefix: string }) =>
      new Map([...data].filter(([k]) => k.startsWith(prefix))) as Map<string, T>,
  };
}

/** A fake OUTBOUND_LEDGER namespace: one LedgerCore per name, with a fixed policy. */
function fakeLedgers(policy: LedgerPolicy) {
  const cores = new Map<string, LedgerCore>();
  const calls: Array<{ method: string; request?: ReserveRequest }> = [];
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      let core = cores.get(name);
      if (!core) {
        core = new LedgerCore(memoryStore());
        cores.set(name, core);
      }
      const c = core;
      return {
        reserve: async (_subject: LedgerSubject, request: ReserveRequest) => {
          calls.push({ method: 'reserve', request });
          return c.reserve({ policy, platformTripped: false }, request);
        },
        commit: async (id: string, sent?: string[]) => {
          calls.push({ method: 'commit' });
          c.commit(policy, id, sent);
        },
        release: async (id: string) => {
          calls.push({ method: 'release' });
          c.release(id);
        },
      };
    },
  };
  return { ns: ns as unknown as NonNullable<OutboundGuardEnv['OUTBOUND_LEDGER']>, calls, cores };
}

function policy(overrides: Partial<LedgerPolicy> = {}): LedgerPolicy {
  return {
    mode: 'enforce',
    trustLevel: 'standard',
    state: 'active',
    stateReason: null,
    stateSetBy: null,
    stateSetAt: null,
    allowRepliesWhenSuspended: false,
    limits: { ...OUTBOUND_DEFAULT_LIMITS.standard },
    ...overrides,
  };
}

const subject = { kind: 'workspace' as const, clerkOrgId: 'org_test', workspaceId: 'ws_test' };

async function seedInbound(from: string) {
  const accountId = generateId('mail');
  await db.insert(mailAccounts).values({ id: accountId, name: 'In', email: `in-${accountId}@acme.com`, isShared: true });
  await db.insert(mailMessages).values({
    id: generateId('msg'),
    accountId,
    messageId: `<${generateId('m')}@x>`,
    from: { email: from },
    to: [{ email: `in-${accountId}@acme.com` }],
    sentDate: new Date(),
    source: 'inbound',
  });
}

describe('mail_correspondents trigger (tenant migration)', () => {
  it('records whoever writes in, case-insensitively', async () => {
    await seedInbound('Anna@Customer.COM');
    await seedInbound('anna@customer.com');
    const [row] = await db.select().from(mailCorrespondents).where(eq(mailCorrespondents.email, 'anna@customer.com'));
    expect(row?.inboundCount).toBe(2);
    expect(row?.firstInboundAt).toBeInstanceOf(Date);
  });

  it('ignores SENT copies', async () => {
    const accountId = generateId('mail');
    await db.insert(mailAccounts).values({ id: accountId, name: 'Out', email: 'out@acme.com', isShared: true });
    await db.insert(mailMessages).values({
      id: generateId('msg'),
      accountId,
      messageId: `<${generateId('m')}@x>`,
      from: { email: 'out@acme.com' },
      to: [{ email: 'stranger@else.com' }],
      sentDate: new Date(),
      source: 'sent',
    });
    expect((await findKnownCorrespondents(db, ['out@acme.com', 'stranger@else.com'])).size).toBe(0);
  });

  it('marks a first contact who wrote back later', async () => {
    const { ns } = fakeLedgers(policy());
    const env: OutboundGuardEnv = { OUTBOUND_LEDGER: ns };
    const reservation = await checkOutbound(env, db, {
      subject,
      source: 'compose',
      kind: 'new_thread',
      from: 'tom@acme.com',
      to: ['bram@prospect.com'],
    });
    expect(reservation.firstContact).toEqual(['bram@prospect.com']);
    await commitOutbound(env, db, reservation);
    await new Promise((r) => setTimeout(r, 5));
    await seedInbound('bram@prospect.com');
    const [row] = await db.select().from(mailCorrespondents).where(eq(mailCorrespondents.email, 'bram@prospect.com'));
    expect(row?.repliedAfterFirstContact).toBe(true);
    expect(row?.outboundCount).toBe(1);
  });
});

describe('checkOutbound', () => {
  it('tells first contacts from people who wrote in', async () => {
    await seedInbound('known@client.com');
    const { ns, calls } = fakeLedgers(policy());
    const reservation = await checkOutbound({ OUTBOUND_LEDGER: ns }, db, {
      subject,
      source: 'compose',
      kind: 'new_thread',
      from: 'Tom <Tom@Acme.com>',
      to: ['Known@client.com', 'new@prospect.io'],
      cc: ['new@prospect.io'],
    });
    expect(reservation.sender).toBe('tom@acme.com');
    expect(reservation.recipients).toEqual(['known@client.com', 'new@prospect.io']);
    expect(reservation.firstContact).toEqual(['new@prospect.io']);
    expect(calls[0]?.request?.firstContact).toEqual(['new@prospect.io']);
  });

  it('refuses a recipient who complained, in every mode', async () => {
    await addSuppression(db, { email: 'angry@x.com', reason: 'complaint', source: 'cloudflare_event' });
    const { ns } = fakeLedgers(policy({ mode: 'shadow' }));
    await expect(
      checkOutbound({ OUTBOUND_LEDGER: ns }, db, { subject, source: 'compose', kind: 'new_thread', from: 'tom@acme.com', to: ['angry@x.com'] }),
    ).rejects.toMatchObject({ code: 'RECIPIENT_SUPPRESSED', details: { recipients: ['angry@x.com'] } });
  });

  it('does not downgrade a complaint to a bounce', async () => {
    await addSuppression(db, { email: 'angry@x.com', reason: 'hard_bounce', source: 'cloudflare_event' });
    const { ns } = fakeLedgers(policy());
    await expect(
      checkOutbound({ OUTBOUND_LEDGER: ns }, db, { subject, source: 'compose', kind: 'new_thread', from: 'tom@acme.com', to: ['angry@x.com'] }),
    ).rejects.toBeInstanceOf(OutboundDeniedError);
  });

  it('fingerprints new conversations but not replies', async () => {
    const { ns, calls } = fakeLedgers(policy());
    const text =
      'Hi there, I came across your company and wanted to ask whether you would be open to a short call next week about growing your pipeline.';
    await checkOutbound({ OUTBOUND_LEDGER: ns }, db, { subject, source: 'api', kind: 'new_thread', from: 'tom@acme.com', to: ['p@q.com'], text, subjectLine: 'Quick question' });
    await checkOutbound({ OUTBOUND_LEDGER: ns }, db, { subject, source: 'reply', kind: 'reply', from: 'tom@acme.com', to: ['p@q.com'], text });
    expect(calls[0]?.request?.template?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(calls[0]?.request?.contentScore).toBeGreaterThan(0);
    expect(calls[1]?.request?.template).toBeNull();
  });

  it('fails open without a ledger binding', async () => {
    const reservation = await checkOutbound({}, db, { subject, source: 'compose', kind: 'new_thread', from: 'tom@acme.com', to: ['a@b.com'] });
    expect(reservation.mode).toBe('unavailable');
  });

  it('fails open when the ledger throws', async () => {
    const broken = { idFromName: (n: string) => n, get: () => ({ reserve: async () => { throw new Error('down'); } }) };
    const reservation = await checkOutbound(
      { OUTBOUND_LEDGER: broken as unknown as NonNullable<OutboundGuardEnv['OUTBOUND_LEDGER']> },
      db,
      { subject, source: 'compose', kind: 'new_thread', from: 'tom@acme.com', to: ['a@b.com'] },
    );
    expect(reservation.mode).toBe('unavailable');
  });

  it('releases the reservation when the send throws, commits partial sends', async () => {
    const { ns, calls } = fakeLedgers(policy());
    const env = { OUTBOUND_LEDGER: ns };
    const input = { subject, source: 'workflow' as const, kind: 'new_thread' as const, from: 'tom@acme.com', to: ['a@b.com', 'c@d.com'] };
    await expect(guardedSend(env, db, input, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(calls.map((c) => c.method)).toEqual(['reserve', 'release']);
    const partial = Object.assign(new Error('half'), { sentRecipients: ['a@b.com'] });
    await expect(guardedSend(env, db, input, async () => { throw partial; })).rejects.toThrow('half');
    expect(calls.map((c) => c.method).slice(2)).toEqual(['reserve', 'commit']);
  });
});

describe('sendAndPersist with the guard', () => {
  it('turns a denial into a MailSendError with the same code and sends nothing', async () => {
    const accountId = generateId('mail');
    await db.insert(mailAccounts).values({ id: accountId, name: 'Sales', email: 'sales@acme.com', isShared: true });
    const { ns } = fakeLedgers(policy({ state: 'hold' }));
    const send = vi.fn();
    const env = { OUTBOUND_LEDGER: ns, SEND_EMAIL: { send } } as unknown as MailSendEnv;
    const err = await sendAndPersist(env, db, 'org_test', 'user_test', accountId, {
      to: ['someone@new.com'],
      subject: 'Hello',
      body: 'Hello there',
    }, { outbound: { workspaceId: 'ws_test' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect(err).toMatchObject({ code: 'SENDING_ON_HOLD' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('delivery events', () => {
  it('parses Cloudflare Email Sending events', () => {
    const event = parseSendingEvent({
      type: 'cf.email.sending.message.bounced',
      payload: { sender: 'Tom@Acme.com', recipient: 'gone@x.com', bounce: { type: 'hard' }, delivery: { status: 'bounced', smtpResponse: '550 5.1.1 no such user' } },
      metadata: { eventTimestamp: '2026-10-13T10:00:00.000Z' },
    });
    expect(event).toEqual({
      type: 'hard_bounce',
      sender: 'tom@acme.com',
      recipient: 'gone@x.com',
      at: new Date('2026-10-13T10:00:00.000Z'),
      detail: '550 5.1.1 no such user',
    });
    expect(parseSendingEvent({ type: 'cf.r2.bucket.created' })).toBeNull();
    expect(parseSendingEvent({ type: 'cf.email.sending.message.bounced', payload: { sender: 'a@b.c', recipient: 'x@y.z', bounce: { type: 'soft' } } })?.type).toBe('soft_bounce');
  });

  it('marks the latest SENT copy and never downgrades a complaint', async () => {
    const accountId = generateId('mail');
    await db.insert(mailAccounts).values({ id: accountId, name: 'Out', email: 'events@acme.com', isShared: true });
    const id = generateId('msg');
    const sentAt = new Date('2026-10-13T09:00:00.000Z');
    await db.insert(mailMessages).values({
      id,
      accountId,
      messageId: `<${id}@x>`,
      from: { email: 'events@acme.com' },
      to: [{ email: 'Reader@Example.com' }],
      sentDate: sentAt,
      source: 'sent',
    });
    const base = { sender: 'events@acme.com', recipient: 'reader@example.com', at: new Date('2026-10-13T09:05:00.000Z'), detail: null };
    expect(await markSentCopy(db, accountId, { ...base, type: 'complained' })).toBe(true);
    expect(await markSentCopy(db, accountId, { ...base, type: 'delivered' })).toBe(false);
    const [row] = await db.select({ status: mailMessages.deliveryStatus }).from(mailMessages).where(eq(mailMessages.id, id));
    expect(row?.status).toBe('complained');
  });
});

describe('MailIndex integration (design decision 1: its own EU object, not ledger tables)', () => {
  /** A real `MailIndex` over the node:sqlite fakes, wrapped in a namespace shaped like `env.MAIL_INDEX`. */
  function fakeMailIndex(env: Partial<MailIndexEnv> = {}) {
    const state = createSqliteDurableObjectState();
    const index = new MailIndex(state, {
      DATABASE_URL_MASTER: 'postgres://unused',
      WORKSPACE_CACHE: {} as KVNamespace,
      NEON_API_KEY: 'unused',
      ...env,
    });
    const ns = { idFromName: (name: string) => name, get: () => index, jurisdiction: () => ns };
    return { ns: ns as unknown as NonNullable<OutboundGuardEnv['MAIL_INDEX']>, state, index };
  }

  it('trusts MailIndex.firstContacts when seeded and the caller says object-only, bypassing Postgres entirely', async () => {
    const { ns: ledgerNs } = fakeLedgers(policy());
    const { ns: indexNs, index, state } = fakeMailIndex({ correspondentsReader: async () => ({ rows: [], nextCursor: null }) });
    await index.ensureCorrespondentsSeeded('ws_test', 'test');
    await fireAlarm(state, index); // empty page -> seeded immediately
    await index.recordMailAddresses('ws_test', [
      { messageId: 'm1', accountId: 'acc1', from: 'index-only@client.com', addresses: ['index-only@client.com'], at: Date.now() },
    ]);

    const env: OutboundGuardEnv = { OUTBOUND_LEDGER: ledgerNs, MAIL_INDEX: indexNs };
    const reservation = await checkOutbound(env, db, {
      subject,
      source: 'compose',
      kind: 'new_thread',
      from: 'tom@acme.com',
      to: ['index-only@client.com'],
      mailStoreMode: 'object-only',
    });

    // Postgres never heard of this address; only the index knows it, and the
    // guard trusts the index's answer because it is authoritative.
    expect((await findKnownCorrespondents(db, ['index-only@client.com'])).size).toBe(0);
    expect(reservation.firstContact).toEqual([]);
  });

  it('ignores an unseeded or non-object-only index and falls back to Postgres, unchanged', async () => {
    const { ns: ledgerNs } = fakeLedgers(policy());
    const { ns: indexNs, index } = fakeMailIndex();
    await index.recordMailAddresses('ws_test', [
      { messageId: 'm1', accountId: 'acc1', from: 'index-only-2@client.com', addresses: ['index-only-2@client.com'], at: Date.now() },
    ]);

    const env: OutboundGuardEnv = { OUTBOUND_LEDGER: ledgerNs, MAIL_INDEX: indexNs };
    // No `mailStoreMode`: defaults to not-authoritative, so the index's
    // (correct) answer must be ignored in favour of Postgres (which has never
    // heard of this address).
    const reservation = await checkOutbound(env, db, {
      subject,
      source: 'compose',
      kind: 'new_thread',
      from: 'tom@acme.com',
      to: ['index-only-2@client.com'],
    });
    expect(reservation.firstContact).toEqual(['index-only-2@client.com']);
  });

  it('falls back to Postgres when the index throws', async () => {
    await seedInbound('known-via-pg-fallback@client.com');
    const { ns: ledgerNs } = fakeLedgers(policy());
    const brokenNs = {
      jurisdiction: () => brokenNs,
      idFromName: (n: string) => n,
      get: () => ({
        firstContacts: async () => {
          throw new Error('mail index unavailable');
        },
      }),
    };
    const env: OutboundGuardEnv = {
      OUTBOUND_LEDGER: ledgerNs,
      MAIL_INDEX: brokenNs as unknown as NonNullable<OutboundGuardEnv['MAIL_INDEX']>,
    };
    const reservation = await checkOutbound(env, db, {
      subject,
      source: 'compose',
      kind: 'new_thread',
      from: 'tom@acme.com',
      to: ['known-via-pg-fallback@client.com'],
      mailStoreMode: 'object-only',
    });
    expect(reservation.firstContact).toEqual([]); // known via the Postgres fallback
  });

  it('commitOutbound records the send in MailIndex when available, alongside Postgres', async () => {
    const { ns: ledgerNs } = fakeLedgers(policy());
    const { ns: indexNs, index } = fakeMailIndex();
    const recordSpy = vi.spyOn(index, 'recordOutbound');
    const env: OutboundGuardEnv = { OUTBOUND_LEDGER: ledgerNs, MAIL_INDEX: indexNs };
    const reservation = await checkOutbound(env, db, {
      subject,
      source: 'compose',
      kind: 'new_thread',
      from: 'tom@acme.com',
      to: ['new-recipient@client.com'],
    });
    await commitOutbound(env, db, reservation);
    expect(recordSpy).toHaveBeenCalledWith('ws_test', ['new-recipient@client.com'], expect.any(Number));
    // Postgres still gets its own record too (unchanged behaviour).
    expect((await findKnownCorrespondents(db, ['new-recipient@client.com'])).size).toBe(0); // outbound alone isn't "known"
  });

  it('never touches MailIndex when the binding is absent', async () => {
    const { ns: ledgerNs } = fakeLedgers(policy());
    const env: OutboundGuardEnv = { OUTBOUND_LEDGER: ledgerNs };
    const reservation = await checkOutbound(env, db, {
      subject,
      source: 'compose',
      kind: 'new_thread',
      from: 'tom@acme.com',
      to: ['no-index-bound@client.com'],
      mailStoreMode: 'object-only',
    });
    expect(reservation.firstContact).toEqual(['no-index-bound@client.com']);
    await expect(commitOutbound(env, db, reservation)).resolves.toBeUndefined();
  });
});
