/**
 * Mailbox reads against pglite (tenant + master): the list and the DTO a
 * mailbox is shown as, the warmup numbers from the master pool, and what a
 * failing or missing pool does to them.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { hasLoginError, getMailboxDto, listMailboxes, warmupBlockerOf, type MailboxReadDeps } from './mailboxes';
import {
  poolStats,
  resetReachMaster,
  resetReachTenant,
  seedMailbox,
  seedPoolMailbox,
  seedReachDomain,
} from './testing/account';

const NOW = new Date('2026-10-12T10:00:00Z');

let db: Database;
let master: MasterDatabase;

const readDeps = (): MailboxReadDeps => ({ db, warmup: { clerkOrgId: 'org_acme', master: () => master } });

/** `master` with every `select` counted: the list must stay cheap. */
function countingMaster() {
  const counter = { selects: 0 };
  const proxy = new Proxy(master, {
    get(target, prop, receiver) {
      if (prop === 'select') counter.selects += 1;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { master: proxy, counter };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  await resetReachTenant(db);
  await resetReachMaster(master);
  await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_1', name: 'getacme.com', mailpoolDomainId: '5001' });
});

describe('listMailboxes', () => {
  it('lists existing mailboxes with domain name and sends since 00:00 UTC, filtered by domain and status', async () => {
    await seedReachDomain(db, { id: 'rdom_2', hostDomainId: 'dom_2', name: 'tryacme.com' });
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active' });
    await seedMailbox(db, { id: 'rmbx_2', domainId: 'rdom_2', status: 'warming' });
    await seedMailbox(db, { id: 'rmbx_3', domainId: 'rdom_1', status: 'deleted', deletedAt: NOW });

    const message = (id: string, sentAt: Date, status: 'sent' | 'failed' = 'sent', direction: 'out' | 'in' = 'out') => ({
      id,
      direction,
      mailboxId: 'rmbx_1',
      messageIdHeader: `<${id}@getacme.com>`,
      fromEmail: 'a@getacme.com',
      toEmail: 'b@x.com',
      status,
      sentAt,
    });
    await db.insert(schema.reachMessages).values([
      message('rmsg_1', new Date('2026-10-12T00:00:01Z')),
      message('rmsg_2', new Date('2026-10-12T09:30:00Z')),
      message('rmsg_old', new Date('2026-10-11T23:59:59Z')),
      message('rmsg_failed', new Date('2026-10-12T08:00:00Z'), 'failed'),
    ]);

    const all = await listMailboxes(readDeps(), {}, NOW);
    expect(all.map((m) => m.id)).toEqual(['rmbx_1', 'rmbx_2']);
    expect(all[0]).toMatchObject({ domainName: 'getacme.com', sentToday: 2, status: 'active' });
    expect(all[1]).toMatchObject({ domainName: 'tryacme.com', sentToday: 0 });
    expect(JSON.stringify(all)).not.toMatch(/smtp|imap|inboundToken/i);

    expect((await listMailboxes(readDeps(), { domainId: 'rdom_2' }, NOW)).map((m) => m.id)).toEqual(['rmbx_2']);
    expect((await listMailboxes(readDeps(), { status: 'warming' }, NOW)).map((m) => m.id)).toEqual(['rmbx_2']);
    expect((await listMailboxes(readDeps(), { status: 'deleted' }, NOW)).map((m) => m.id)).toEqual(['rmbx_3']);
  });
});

describe('mailbox DTO: warmup fields', () => {
  /** Mailboxes on three domains, so the pool is big enough unless a test says otherwise. */
  async function poolOfDomains(count: number) {
    for (let i = 0; i < count; i++) {
      await seedPoolMailbox(master, { tenantMailboxId: `rmbx_peer${i}`, clerkOrgId: 'org_peer', email: `p${i}@peer${i}.com`, status: 'warming' });
    }
  }

  it('shows the inbox rate from the tenant column and the 7-day numbers from the pool', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', warmupDay: 20, warmupStatus: 'maintaining', warmupInboxRate: 0.9123 });
    await seedPoolMailbox(master, {
      tenantMailboxId: 'rmbx_1',
      status: 'maintaining',
      rampDay: 20,
      stats: poolStats({ sent7d: 112, spamRescues7d: 4, inboxRate3d: 0.99 }),
    });

    const [dto] = await listMailboxes(readDeps(), {}, NOW);
    expect(dto).toMatchObject({
      warmupDay: 20,
      warmupStatus: 'maintaining',
      warmupInboxRate: 0.9123,
      warmupSent7d: 112,
      warmupSpamRescues7d: 4,
      warmupBlocker: null,
    });
    expect(await getMailboxDto(readDeps(), 'rmbx_1', NOW)).toMatchObject({ warmupInboxRate: 0.9123, warmupSent7d: 112, warmupSpamRescues7d: 4 });
  });

  it('shows zeros and no rate for a mailbox without a pool row or stats', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active' });
    await seedMailbox(db, { id: 'rmbx_2', domainId: 'rdom_1', status: 'active' });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_2', status: 'waiting', stats: null });

    for (const dto of await listMailboxes(readDeps(), {}, NOW)) {
      expect(dto).toMatchObject({ warmupInboxRate: null, warmupSent7d: 0, warmupSpamRescues7d: 0, warmupBlocker: null });
    }
  });

  it('blames the pool while it spans fewer than 3 domains', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'warming' });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_1', status: 'waiting' });
    await poolOfDomains(1); // getacme.com + peer0.com = 2 domains

    expect((await getMailboxDto(readDeps(), 'rmbx_1', NOW))?.warmupBlocker).toBe('pool_too_small');
    expect((await listMailboxes(readDeps(), {}, NOW))[0]?.warmupBlocker).toBe('pool_too_small');
  });

  it('names what a warming mailbox lacks once the pool is big enough, and clears when it is ready', async () => {
    await poolOfDomains(2); // + getacme.com = 3 domains
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'warming' });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_1', status: 'warming', rampDay: 5 });
    const blocker = async () => (await getMailboxDto(readDeps(), 'rmbx_1', NOW))?.warmupBlocker;
    const setPool = (patch: Partial<typeof masterSchema.reachWarmupMailboxes.$inferInsert>) =>
      master.update(masterSchema.reachWarmupMailboxes).set(patch).where(eq(masterSchema.reachWarmupMailboxes.tenantMailboxId, 'rmbx_1'));

    expect(await blocker()).toBe('too_early');
    await setPool({ rampDay: 14 });
    expect(await blocker()).toBe('not_enough_data');
    await setPool({ stats: poolStats({ inboxRate3d: 0.7 }) });
    expect(await blocker()).toBe('low_inbox_rate');
    await setPool({ stats: poolStats({ inboxRate3d: 0.9 }), lastLoginError: 'bad', lastLoginErrorAt: NOW });
    expect(await blocker()).toBe('login_error');
    await setPool({ lastLoginError: null, lastLoginErrorAt: null });
    expect(await blocker()).toBeNull();
  });

  it('reports a blocker only for a warming mailbox', async () => {
    await seedMailbox(db, { id: 'rmbx_a', domainId: 'rdom_1', status: 'active' });
    await seedMailbox(db, { id: 'rmbx_p', domainId: 'rdom_1', status: 'paused', pausedReason: 'user' });
    const dtos = await listMailboxes(readDeps(), {}, NOW);
    expect(dtos.map((d) => d.warmupBlocker)).toEqual([null, null]);
  });

  it('costs at most two master queries per request, and none for an empty list', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'warming' });
    await seedMailbox(db, { id: 'rmbx_2', domainId: 'rdom_1', status: 'warming' });
    await seedMailbox(db, { id: 'rmbx_3', domainId: 'rdom_1', status: 'active' });

    const listed = countingMaster();
    await listMailboxes({ db, warmup: { clerkOrgId: 'org_acme', master: () => listed.master } }, {}, NOW);
    expect(listed.counter.selects).toBe(2);

    const single = countingMaster();
    await getMailboxDto({ db, warmup: { clerkOrgId: 'org_acme', master: () => single.master } }, 'rmbx_1', NOW);
    expect(single.counter.selects).toBe(2);

    // Nothing warming: the pool-size query is skipped.
    const settled = countingMaster();
    await listMailboxes({ db, warmup: { clerkOrgId: 'org_acme', master: () => settled.master } }, { status: 'active' }, NOW);
    expect(settled.counter.selects).toBe(1);

    const empty = countingMaster();
    await listMailboxes({ db, warmup: { clerkOrgId: 'org_acme', master: () => empty.master } }, { domainId: 'rdom_none' }, NOW);
    expect(empty.counter.selects).toBe(0);
  });

  it('still lists the mailboxes when master cannot be read (warmup numbers are decoration)', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'warming', warmupInboxRate: 0.9 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dtos = await listMailboxes({ db, warmup: { clerkOrgId: 'org_acme', master: () => { throw new Error('master down'); } } }, {}, NOW);

    expect(dtos).toHaveLength(1);
    // The tenant columns still tell the gate's story; only the pool's own numbers and the pool size are missing.
    expect(dtos[0]).toMatchObject({ warmupInboxRate: 0.9, warmupSent7d: 0, warmupSpamRescues7d: 0, warmupBlocker: 'too_early' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never shows another workspace's pool rows", async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active' });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_1', clerkOrgId: 'org_other', email: 'x@other.com', stats: poolStats({ sent7d: 999 }) });

    expect((await getMailboxDto(readDeps(), 'rmbx_1', NOW))?.warmupSent7d).toBe(0);
  });
});

describe('warmup gate helpers', () => {
  it('treats a stored login error as current', () => {
    expect(hasLoginError({ lastLoginError: null })).toBe(false);
    expect(hasLoginError({ lastLoginError: '' })).toBe(false);
    expect(hasLoginError({ lastLoginError: 'Invalid credentials' })).toBe(true);
  });

  describe('warmupBlockerOf', () => {
    const warming = { status: 'warming' as const, warmupDay: 0, warmupInboxRate: null };
    const view = (overrides: Partial<Parameters<typeof poolView>[0]> = {}) => poolView(overrides);

    it('is null unless the mailbox is warming', () => {
      for (const status of ['active', 'paused', 'provisioning', 'error'] as const) {
        expect(warmupBlockerOf({ ...warming, status }, undefined, 0), status).toBeNull();
      }
    });

    it('names the pool first while it is too small, then what the mailbox itself lacks', () => {
      expect(warmupBlockerOf(warming, view(), 2)).toBe('pool_too_small');
      expect(warmupBlockerOf(warming, view(), 3)).toBe('too_early');
      expect(warmupBlockerOf(warming, view({ rampDay: 14 }), 3)).toBe('not_enough_data');
      expect(warmupBlockerOf(warming, view({ rampDay: 14, inboxRate3d: 0.6 }), 3)).toBe('low_inbox_rate');
      // Unknown pool size (master could not be read) never blames the pool.
      expect(warmupBlockerOf(warming, view(), null)).toBe('too_early');
    });

    it('is null for a mailbox that is ready, even while the pool is small (the next pass promotes it)', () => {
      expect(warmupBlockerOf(warming, view({ rampDay: 15, inboxRate3d: 0.92 }), 1)).toBeNull();
    });

    it('puts a login problem above a small pool', () => {
      expect(warmupBlockerOf(warming, view({ rampDay: 20, inboxRate3d: 0.9, lastLoginError: 'bad password' }), 1)).toBe('login_error');
    });

    it('falls back to the tenant columns for a mailbox that is not in the pool', () => {
      expect(warmupBlockerOf({ ...warming, warmupDay: 14, warmupInboxRate: 0.5 }, undefined, 5)).toBe('low_inbox_rate');
      expect(warmupBlockerOf({ ...warming, warmupDay: 14, warmupInboxRate: 0.9 }, undefined, 5)).toBeNull();
    });
  });
});

function poolView(overrides: { rampDay?: number; inboxRate3d?: number | null; lastLoginError?: string | null } = {}) {
  return {
    tenantMailboxId: 'rmbx_1',
    status: 'warming' as const,
    startedAt: new Date('2026-10-01T00:00:00Z'),
    rampDay: overrides.rampDay ?? 0,
    stats: poolStats({ inboxRate3d: overrides.inboxRate3d ?? null }),
    pausedReason: null,
    lastLoginError: overrides.lastLoginError ?? null,
    lastLoginErrorAt: overrides.lastLoginError ? NOW : null,
  };
}
