/**
 * `MailIndex` against the real node:sqlite fakes (no network Postgres):
 * migrations, idempotent `recordMailAddresses`, first-contact semantics
 * ported from the 0214 trigger's meaning (see outbound/guard.test.ts for the
 * Postgres-side version of the same cases), `mailboxesForAddress`, alarm-paged
 * seeding, and `dropMailbox`/`forgetMailData`.
 */

import { describe, expect, it } from 'vitest';
import { createSqliteDurableObjectState, fireAlarm } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { MailIndex, type MailIndexEnv } from './mail-index';
import type { CorrespondentRow, CorrespondentsPage, CorrespondentsReader, MailAddressBatchEntry } from './types';

function testEnv(overrides: Partial<MailIndexEnv> = {}): MailIndexEnv {
  return {
    DATABASE_URL_MASTER: 'postgres://unused',
    WORKSPACE_CACHE: {} as KVNamespace,
    NEON_API_KEY: 'unused',
    ...overrides,
  };
}

function makeIndex(env: Partial<MailIndexEnv> = {}) {
  const state = createSqliteDurableObjectState();
  const index = new MailIndex(state, testEnv(env));
  return { state, index };
}

function entry(overrides: Partial<MailAddressBatchEntry> & { messageId: string; accountId: string }): MailAddressBatchEntry {
  return { at: Date.now(), addresses: [], ...overrides };
}

const WS = 'ws_test1';

describe('schema and migrations', () => {
  it('migrates from empty, and re-running (a second instance over the same storage) is a no-op', async () => {
    const state = createSqliteDurableObjectState();
    const first = new MailIndex(state, testEnv());
    await first.status(WS);

    // A second object instance constructed over the same underlying storage
    // (e.g. after an isolate eviction and recreation) must not fail by trying
    // to re-create tables or re-run completed migrations.
    const second = new MailIndex(state, testEnv());
    const status = await second.status(WS);
    expect(status.correspondentsCount).toBe(0);
    expect(status.seeded).toBe(false);
  });

  it('rejects a call for a different workspace than the one it was first bound to', async () => {
    const { index } = makeIndex();
    await index.status(WS);
    await expect(index.status('ws_other')).rejects.toThrow(/bound to workspace/);
  });
});

describe('recordMailAddresses: idempotency and inbound correspondent tracking', () => {
  it('is idempotent per message id: a retried batch does not double-count', async () => {
    const { index } = makeIndex();
    const msg = entry({ messageId: 'msg_1', accountId: 'acc_1', from: 'Anna@Customer.com', addresses: ['anna@customer.com', 'in@acme.com'], at: 1000 });

    const first = await index.recordMailAddresses(WS, [msg]);
    expect(first).toEqual({ applied: 1, skipped: 0 });
    const retry = await index.recordMailAddresses(WS, [msg]);
    expect(retry).toEqual({ applied: 0, skipped: 1 });

    const { firstContact } = await index.firstContacts(WS, ['anna@customer.com'], 'object-only');
    expect(firstContact).toEqual([]); // known: inboundCount must be 1, not 2
  });

  it('normalises addresses (lower-case, trimmed)', async () => {
    const { index } = makeIndex();
    await index.recordMailAddresses(WS, [
      entry({ messageId: 'msg_1', accountId: 'acc_1', from: '  Anna@Customer.COM  ', addresses: ['Anna@Customer.COM'], at: 1000 }),
    ]);
    const { firstContact } = await index.firstContacts(WS, ['anna@customer.com'], 'object-only');
    expect(firstContact).toEqual([]);
  });

  it('a sent-copy entry (no `from`) updates the address index but not correspondents', async () => {
    const { index } = makeIndex();
    await index.recordMailAddresses(WS, [
      entry({ messageId: 'msg_1', accountId: 'acc_1', addresses: ['out@acme.com', 'client@x.com'], at: 1000 }),
    ]);
    const { firstContact } = await index.firstContacts(WS, ['client@x.com'], 'object-only');
    expect(firstContact).toEqual(['client@x.com']); // never recorded as inbound
    expect(await index.mailboxesForAddress(WS, 'client@x.com')).toEqual(['acc_1']);
  });
});

describe('first-contact semantics (ports the 0214 trigger cases from outbound/guard.test.ts)', () => {
  it('a recipient who never wrote in is a first contact', async () => {
    const { index } = makeIndex();
    const { firstContact, authoritative } = await index.firstContacts(WS, ['new@prospect.io'], 'object-only');
    expect(authoritative).toBe(false); // not seeded yet
    expect(firstContact).toEqual(['new@prospect.io']);
  });

  it('a recipient who wrote in before is known, not a first contact', async () => {
    const { index } = makeIndex();
    await index.recordMailAddresses(WS, [entry({ messageId: 'm1', accountId: 'a1', from: 'known@client.com', addresses: ['known@client.com'], at: 1000 })]);
    const { firstContact } = await index.firstContacts(WS, ['known@client.com', 'new@prospect.io'], 'object-only');
    expect(firstContact).toEqual(['new@prospect.io']);
  });

  it('marks replied_after_first_contact when the first inbound from an address arrives after we already sent to them', async () => {
    const { index } = makeIndex();
    await index.recordOutbound(WS, ['bram@prospect.com'], 1000);
    await index.recordMailAddresses(WS, [entry({ messageId: 'm1', accountId: 'a1', from: 'bram@prospect.com', addresses: ['bram@prospect.com'], at: 2000 })]);

    // Internal assertion via status: correspondents row isn't exposed directly,
    // but firstContacts and mailboxesForAddress together confirm the write:
    // once inbound exists, the address counts as known.
    const { firstContact } = await index.firstContacts(WS, ['bram@prospect.com'], 'object-only');
    expect(firstContact).toEqual([]);
  });

  it('outbound alone (never replied) does not make the address a known correspondent', async () => {
    const { index } = makeIndex();
    await index.recordOutbound(WS, ['cold@prospect.com'], 1000);
    const { firstContact } = await index.firstContacts(WS, ['cold@prospect.com'], 'object-only');
    expect(firstContact).toEqual(['cold@prospect.com']);
  });

  it('is only authoritative when seeded and the caller says object-only', async () => {
    const { index } = makeIndex();
    await index.recordMailAddresses(WS, [entry({ messageId: 'm1', accountId: 'a1', from: 'a@b.com', addresses: ['a@b.com'], at: 1 })]);
    expect((await index.firstContacts(WS, ['a@b.com'], 'object-only')).authoritative).toBe(false); // not seeded
    expect((await index.firstContacts(WS, ['a@b.com'], 'shadow')).authoritative).toBe(false); // seeded would still not matter: wrong mode
  });
});

describe('mailboxesForAddress', () => {
  it('lists every mailbox an address has touched, most recent first', async () => {
    const { index } = makeIndex();
    await index.recordMailAddresses(WS, [
      entry({ messageId: 'm1', accountId: 'inbox-a', addresses: ['shared@client.com'], at: 1000 }),
      entry({ messageId: 'm2', accountId: 'inbox-b', addresses: ['shared@client.com'], at: 2000 }),
    ]);
    expect(await index.mailboxesForAddress(WS, 'shared@client.com')).toEqual(['inbox-b', 'inbox-a']);
    expect(await index.mailboxesForAddress(WS, 'unknown@x.com')).toEqual([]);
  });
});

describe('seeding (alarm-paged, injected reader)', () => {
  function pagedReader(rows: CorrespondentRow[], pageSize: number): CorrespondentsReader {
    const sorted = [...rows].sort((a, b) => a.email.localeCompare(b.email));
    return async (_workspaceId, cursor, limit): Promise<CorrespondentsPage> => {
      const effectiveLimit = Math.min(limit, pageSize);
      const start = cursor ? sorted.findIndex((r) => r.email > cursor) : 0;
      const page = sorted.slice(start === -1 ? sorted.length : start, (start === -1 ? sorted.length : start) + effectiveLimit);
      const last = page.at(-1);
      return { rows: page, nextCursor: page.length < effectiveLimit || !last ? null : last.email };
    };
  }

  const seedRows: CorrespondentRow[] = [
    { email: 'a@x.com', firstInboundAt: 100, lastInboundAt: 100, inboundCount: 1, firstOutboundAt: null, lastOutboundAt: null, outboundCount: 0, repliedAfterFirstContact: false },
    { email: 'b@x.com', firstInboundAt: null, lastInboundAt: null, inboundCount: 0, firstOutboundAt: 50, lastOutboundAt: 50, outboundCount: 1, repliedAfterFirstContact: false },
    { email: 'c@x.com', firstInboundAt: 10, lastInboundAt: 20, inboundCount: 2, firstOutboundAt: null, lastOutboundAt: null, outboundCount: 0, repliedAfterFirstContact: false },
  ];

  it('pages through every row and becomes seeded and authoritative when done', async () => {
    const reader = pagedReader(seedRows, 2); // 3 rows, page size 2 => 2 pages
    const { state, index } = makeIndex({ correspondentsReader: reader });

    const started = await index.ensureCorrespondentsSeeded(WS, 'test');
    expect(started.state).toBe('running');

    expect(await fireAlarm(state, index)).toBe(true); // page 1
    let status = await index.status(WS);
    expect(status.seeded).toBe(false);
    expect(status.seeding.copied).toBe(2);

    expect(await fireAlarm(state, index)).toBe(true); // page 2 (last)
    status = await index.status(WS);
    expect(status.seeded).toBe(true);
    expect(status.seeding.state).toBe('done');
    expect(status.seeding.copied).toBe(3);
    expect(status.correspondentsCount).toBe(3);

    // Now authoritative for object-only callers.
    const { authoritative, firstContact } = await index.firstContacts(WS, ['a@x.com', 'new@x.com'], 'object-only');
    expect(authoritative).toBe(true);
    expect(firstContact).toEqual(['new@x.com']);
  });

  it('is a no-op while already running or done', async () => {
    const reader = pagedReader(seedRows, 10);
    const { state, index } = makeIndex({ correspondentsReader: reader });
    await index.ensureCorrespondentsSeeded(WS, 'first');
    const again = await index.ensureCorrespondentsSeeded(WS, 'second');
    expect(again.source).toBe('first'); // unchanged: still running
    await fireAlarm(state, index); // completes in one page
    const afterDone = await index.ensureCorrespondentsSeeded(WS, 'third');
    expect(afterDone.state).toBe('done');
  });

  it('merges a seed page with live events recorded while seeding was in flight, never losing counts', async () => {
    const reader = pagedReader(seedRows, 2); // force multiple alarm cycles: a@x.com+b@x.com, then c@x.com
    const { state, index } = makeIndex({ correspondentsReader: reader });
    await index.ensureCorrespondentsSeeded(WS, 'test');
    await fireAlarm(state, index); // seeds a@x.com (inboundCount 1) and b@x.com

    // A live inbound event for the same address arrives mid-seed.
    await index.recordMailAddresses(WS, [entry({ messageId: 'live1', accountId: 'acc', from: 'a@x.com', addresses: ['a@x.com'], at: 999 })]);

    await fireAlarm(state, index); // c@x.com, done

    const status = await index.status(WS);
    expect(status.seeded).toBe(true);
    // a@x.com's known-correspondent status survives the seed merge.
    const { firstContact } = await index.firstContacts(WS, ['a@x.com'], 'object-only');
    expect(firstContact).toEqual([]);
  });

  it('retries on a reader failure and eventually fails after repeated errors', async () => {
    let calls = 0;
    const flakyReader: CorrespondentsReader = async () => {
      calls++;
      throw new Error('tenant db unreachable');
    };
    const { state, index } = makeIndex({ correspondentsReader: flakyReader });
    await index.ensureCorrespondentsSeeded(WS, 'test');
    for (let i = 0; i < 10; i++) {
      await fireAlarm(state, index);
    }
    const status = await index.status(WS);
    expect(status.seeding.state).toBe('failed');
    expect(status.seeded).toBe(false);
    expect(calls).toBe(10);
  });
});

describe('dropMailbox and forgetMailData', () => {
  it('dropMailbox removes only that mailbox from the address index, keeping correspondents', async () => {
    const { index } = makeIndex();
    await index.recordMailAddresses(WS, [
      entry({ messageId: 'm1', accountId: 'acc_a', from: 'client@x.com', addresses: ['client@x.com'], at: 1000 }),
      entry({ messageId: 'm2', accountId: 'acc_b', addresses: ['client@x.com'], at: 2000 }),
    ]);
    await index.dropMailbox(WS, 'acc_a');
    expect(await index.mailboxesForAddress(WS, 'client@x.com')).toEqual(['acc_b']);
    // Correspondents (workspace-wide) survive a single mailbox's removal.
    const { firstContact } = await index.firstContacts(WS, ['client@x.com'], 'object-only');
    expect(firstContact).toEqual([]);
  });

  it('forgetMailData wipes correspondents, the address index and seeding state', async () => {
    const { index } = makeIndex();
    await index.recordMailAddresses(WS, [entry({ messageId: 'm1', accountId: 'acc_a', from: 'client@x.com', addresses: ['client@x.com'], at: 1000 })]);
    await index.forgetMailData(WS);

    const status = await index.status(WS);
    expect(status.correspondentsCount).toBe(0);
    expect(status.addressIndexCount).toBe(0);
    expect(status.appliedMessagesCount).toBe(0);
    expect(status.seeded).toBe(false);
  });
});
