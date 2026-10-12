/**
 * Warmup: health rules, finding the warmup inbox at Mailpool, and the daily
 * per-workspace pass (state transitions, ramp, WeldHost lapse, next visit).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { openMailServerCredentials } from '../lib/credentials';
import { MailpoolError } from '../lib/mailpool/errors';
import type { MailpoolWarmupInbox } from '../lib/mailpool/types';
import { createFakeMailpool, mailpoolMailbox, warmupDetail, warmupInbox } from '../lib/mailpool/testing';
import { resetReachTenant, seedHostDomain, seedMailbox, seedReachDomain } from '../lib/mailpool/testing-db';
import {
  cachedWarmupLookup,
  countWarmupDays,
  ensureWarmupRunning,
  isWarmupHealthy,
  processWorkspaceWarmup,
  resumeStatusFor,
  searchWarmupLookup,
  type WarmupLookup,
} from './warmup';

const ENCRYPTION_KEY = 'cd'.repeat(32);
// Tuesday 2026-10-13, 03:15 UTC, as the daily cron sees it.
const NOW = new Date('2026-10-13T03:15:00Z');
const TOMORROW = new Date('2026-10-14T00:00:00Z');

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  await resetReachTenant(db);
  await seedHostDomain(db, { id: 'dom_1', fullDomain: 'getacme.com' });
  await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_1', name: 'getacme.com' });
});

function lookupOf(...inboxes: MailpoolWarmupInbox[]): WarmupLookup {
  return { find: async (mailboxId) => inboxes.find((i) => i.mailboxId === mailboxId) ?? null };
}

function setup(inboxes: MailpoolWarmupInbox[] = []) {
  const mailpool = createFakeMailpool();
  const publish = vi.fn(async (_event: { entityId: string; data: Record<string, unknown> }) => {});
  const run = (now = NOW, lookup: WarmupLookup = lookupOf(...inboxes)) =>
    processWorkspaceWarmup({ db, mailpool, lookup, env: { DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY }, now, publish });
  return { mailpool, publish, run };
}

async function mailbox(id: string) {
  const [row] = await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, id));
  return row!;
}

describe('warmup counters', () => {
  it('counts only days Mailpool actually sent warmup mail', () => {
    const detail = warmupDetail(warmupInbox(1), 5);
    detail.counters['2026-09-20'] = { sent: 0, delivered: 0, replied: 0, landed_in_spam: 0, bounced: 0, lost: 0 };
    expect(countWarmupDays(detail)).toBe(5);
    expect(countWarmupDays({ counters: {} })).toBe(0);
  });

  it('is healthy only while Started and the last week stays clear of spam and bounces', () => {
    const inbox = warmupInbox(1);
    expect(isWarmupHealthy(warmupDetail(inbox, 14))).toBe(true);
    expect(isWarmupHealthy({ ...warmupDetail(inbox, 14), status: 'Paused' })).toBe(false);
    expect(isWarmupHealthy({ ...warmupDetail(inbox, 14), status: 'Pending' })).toBe(false);
    // 30% in spam: unhealthy. 20% exactly: still fine.
    expect(isWarmupHealthy(warmupDetail(inbox, 14, { sent: 10, landed_in_spam: 3 }))).toBe(false);
    expect(isWarmupHealthy(warmupDetail(inbox, 14, { sent: 10, landed_in_spam: 2 }))).toBe(true);
    expect(isWarmupHealthy(warmupDetail(inbox, 14, { sent: 10, bounced: 2 }))).toBe(false);
  });

  it('judges the last 7 days, so an old bad patch does not block a recovered mailbox', () => {
    const detail = warmupDetail(warmupInbox(1), 14, { sent: 10 });
    const dates = Object.keys(detail.counters).sort();
    for (const date of dates.slice(0, 7)) detail.counters[date]!.landed_in_spam = 10;
    expect(isWarmupHealthy(detail)).toBe(true);
  });

  it('does not judge a handful of mails', () => {
    expect(isWarmupHealthy(warmupDetail(warmupInbox(1), 1, { sent: 5, landed_in_spam: 5 }))).toBe(true);
  });

  it('resumes to active only after the warmup days', () => {
    expect(resumeStatusFor({ warmupDay: 13 })).toBe('warming');
    expect(resumeStatusFor({ warmupDay: 14 })).toBe('active');
  });
});

describe('finding the warmup inbox', () => {
  it('searches by email and matches the mailbox id (another mailbox with a similar address is not it)', async () => {
    const mailpool = createFakeMailpool();
    const mine = warmupInbox(341, { email: 'jane@getacme.com' });
    mailpool.listWarmup.mockResolvedValue({ data: [warmupInbox(999, { email: 'jane@getacme.com.au' }), mine], total: 2 });

    expect(await searchWarmupLookup(mailpool).find(341, 'jane@getacme.com')).toEqual(mine);
    expect(mailpool.listWarmup).toHaveBeenCalledWith({ search: 'jane@getacme.com', limit: 20, offset: 0 });
    expect(await searchWarmupLookup(mailpool).find(5, 'jane@getacme.com')).toBeNull();
  });

  it('loads the whole list once, page by page, for the sweep', async () => {
    const mailpool = createFakeMailpool();
    const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => warmupInbox(from + i));
    mailpool.listWarmup.mockResolvedValueOnce({ data: page(1, 100), total: 130 }).mockResolvedValueOnce({ data: page(101, 30), total: 130 });
    const lookup = cachedWarmupLookup(mailpool);

    expect((await lookup.find(5, 'x'))?.mailboxId).toBe(5);
    expect((await lookup.find(125, 'x'))?.mailboxId).toBe(125);
    expect(await lookup.find(500, 'x')).toBeNull();
    expect(mailpool.listWarmup).toHaveBeenCalledTimes(2);
    expect(mailpool.listWarmup.mock.calls[1]![0]).toMatchObject({ offset: 100 });
  });

  it('does not cache a failed load', async () => {
    const mailpool = createFakeMailpool();
    mailpool.listWarmup
      .mockRejectedValueOnce(new MailpoolError({ method: 'GET', path: '/warmup', status: 502 }))
      .mockResolvedValueOnce({ data: [warmupInbox(1)], total: 1 });
    const lookup = cachedWarmupLookup(mailpool);

    await expect(lookup.find(1, 'x')).rejects.toBeInstanceOf(MailpoolError);
    expect((await lookup.find(1, 'x'))?.mailboxId).toBe(1);
  });

  it('adds a mailbox that is not in warmup yet, and leaves a started one alone', async () => {
    const mailpool = createFakeMailpool();
    const target = { mailpoolMailboxId: '341', email: 'jane@getacme.com' };

    const added = await ensureWarmupRunning(mailpool, target, lookupOf());
    expect(mailpool.addToWarmup).toHaveBeenCalledExactlyOnceWith([341]);
    expect(added?.status).toBe('Pending');

    mailpool.addToWarmup.mockClear();
    const running = warmupInbox(341, { status: 'Started' });
    expect(await ensureWarmupRunning(mailpool, target, lookupOf(running))).toEqual(running);
    expect(mailpool.addToWarmup).not.toHaveBeenCalled();
    expect(mailpool.startWarmup).not.toHaveBeenCalled();
  });

  it('starts a paused or stopped warmup, and reports a mailbox Mailpool skipped as null', async () => {
    const mailpool = createFakeMailpool();
    const target = { mailpoolMailboxId: '341', email: 'jane@getacme.com' };

    for (const status of ['Paused', 'Stopped'] as const) {
      mailpool.startWarmup.mockClear();
      await ensureWarmupRunning(mailpool, target, lookupOf(warmupInbox(341, { status })));
      expect(mailpool.startWarmup).toHaveBeenCalledOnce();
    }

    mailpool.addToWarmup.mockResolvedValueOnce([]);
    expect(await ensureWarmupRunning(mailpool, target, lookupOf())).toBeNull();
  });
});

describe('processWorkspaceWarmup', () => {
  describe('provisioning', () => {
    it('stores the logins, starts warming and tells the platform once the mailbox is active at Mailpool', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'provisioning', mailpoolMailboxId: '341', email: 'jane@getacme.com' });
      const { mailpool, publish, run } = setup();
      mailpool.getMailbox.mockResolvedValueOnce(mailpoolMailbox({ email: 'jane@getacme.com', firstName: 'Jane', lastName: 'Doe', type: 'google' }, { id: '341' }));

      const next = await run();

      const row = await mailbox('rmbx_1');
      expect(row.status).toBe('warming');
      expect(row.warmupStartedAt).toEqual(NOW);
      expect(await openMailServerCredentials({ DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY }, row.smtpCredentials)).toMatchObject({ host: 'smtp.mailpool.test', port: 465 });
      expect(mailpool.addToWarmup).toHaveBeenCalledWith([341]);
      expect(publish).toHaveBeenCalledOnce();
      expect(next).toEqual(TOMORROW);
    });

    it('marks a mailbox Mailpool disabled as error, and leaves a pending one alone', async () => {
      await seedMailbox(db, { id: 'rmbx_bad', domainId: 'rdom_1', status: 'provisioning', mailpoolMailboxId: '1' });
      await seedMailbox(db, { id: 'rmbx_wait', domainId: 'rdom_1', status: 'provisioning', mailpoolMailboxId: '2' });
      const { mailpool, run } = setup();
      mailpool.getMailbox.mockImplementation(async (id: string | number) =>
        String(id) === '1'
          ? { id, type: 'google', email: 'a@b.com', status: 'inactive', error: { code: 201, message: 'Admin two-factor changed.' } }
          : { id, type: 'google', email: 'a@b.com', status: 'pending' },
      );

      await run();

      expect(await mailbox('rmbx_bad')).toMatchObject({ status: 'error', lastError: 'Admin two-factor changed.' });
      expect((await mailbox('rmbx_wait')).status).toBe('provisioning');
    });
  });

  describe('warming', () => {
    const warming = (overrides: Record<string, unknown> = {}) =>
      seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'warming', mailpoolMailboxId: '341', email: 'jane@getacme.com', dailyCap: 30, ...overrides });

    it('records the warmup day and keeps warming before the warmup days are done', async () => {
      await warming();
      const inbox = warmupInbox(341);
      const { mailpool, publish, run } = setup([inbox]);
      mailpool.getWarmup.mockResolvedValue(warmupDetail(inbox, 13));

      const next = await run();

      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'warming', warmupDay: 13, warmupStatus: 'Started' });
      expect(publish).not.toHaveBeenCalled();
      expect(next).toEqual(TOMORROW);
    });

    it('goes active at 14 warmup days when healthy, starting the ramp at 10 sends a day', async () => {
      await warming();
      const inbox = warmupInbox(341);
      const { mailpool, publish, run } = setup([inbox]);
      mailpool.getWarmup.mockResolvedValue(warmupDetail(inbox, 14));

      await run();

      const row = await mailbox('rmbx_1');
      expect(row).toMatchObject({ status: 'active', warmupDay: 14, rampCurrent: 10 });
      expect(row.rampUpdatedAt).toEqual(NOW);
      expect(publish).toHaveBeenCalledOnce();
      expect(publish.mock.calls[0]![0]).toMatchObject({ entityId: 'rmbx_1' });
      // The event payload carries no sealed logins.
      expect(JSON.stringify(publish.mock.calls[0]![0])).not.toMatch(/smtpCredentials|imapCredentials/);
    });

    it('stays warming at 14 days when the warmup is unhealthy', async () => {
      await warming();
      const inbox = warmupInbox(341);
      const { mailpool, run } = setup([inbox]);
      mailpool.getWarmup.mockResolvedValue(warmupDetail(inbox, 20, { sent: 10, landed_in_spam: 5 }));

      await run();
      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'warming', warmupDay: 20 });
    });

    it('caps the first ramp at a low daily cap', async () => {
      await warming({ dailyCap: 6 });
      const inbox = warmupInbox(341);
      const { mailpool, run } = setup([inbox]);
      mailpool.getWarmup.mockResolvedValue(warmupDetail(inbox, 14));

      await run();
      expect((await mailbox('rmbx_1')).rampCurrent).toBe(6);
    });

    it('re-adds a mailbox that is missing from Mailpool warmup', async () => {
      await warming();
      const { mailpool, run } = setup([]);

      await run();
      expect(mailpool.addToWarmup).toHaveBeenCalledExactlyOnceWith([341]);
    });

    it('restarts a paused warmup', async () => {
      await warming();
      const inbox = warmupInbox(341, { status: 'Paused' });
      const { mailpool, run } = setup([inbox]);
      mailpool.getWarmup.mockResolvedValue(warmupDetail({ ...inbox, status: 'Started' }, 3));

      await run();
      expect(mailpool.startWarmup).toHaveBeenCalledOnce();
      expect((await mailbox('rmbx_1')).warmupDay).toBe(3);
    });

    it('keeps the status of a warmup that is still connecting (Mailpool answers 400)', async () => {
      await warming();
      const inbox = warmupInbox(341, { status: 'Pending', warmboxId: null });
      const { mailpool, run } = setup([inbox]);
      mailpool.getWarmup.mockRejectedValue(new MailpoolError({ method: 'GET', path: '/warmup/7341', status: 400 }));

      await run();
      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'warming', warmupStatus: 'Pending', warmupDay: 0 });
    });

    it('carries on with the other mailboxes when one fails, and visits again tomorrow', async () => {
      await warming();
      await seedMailbox(db, { id: 'rmbx_2', domainId: 'rdom_1', status: 'warming', mailpoolMailboxId: '342', email: 'tom@getacme.com' });
      const a = warmupInbox(341);
      const b = warmupInbox(342);
      const { mailpool, run } = setup([a, b]);
      mailpool.getWarmup.mockImplementation(async (id: number) => {
        if (id === a.id) throw new MailpoolError({ method: 'GET', path: '/warmup/1', status: 502 });
        return warmupDetail(b, 4);
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const next = await run();

      expect((await mailbox('rmbx_1')).warmupDay).toBe(0);
      expect((await mailbox('rmbx_2')).warmupDay).toBe(4);
      expect(next).toEqual(TOMORROW);
      error.mockRestore();
    });
  });

  describe('ramp', () => {
    const active = (overrides: Record<string, unknown> = {}) =>
      seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', dailyCap: 30, rampCurrent: 10, ...overrides });

    it('grows the cap by 5 once a day up to the daily cap', async () => {
      await active({ rampUpdatedAt: new Date('2026-10-12T03:15:00Z') });
      const { run } = setup();

      await run(NOW);
      expect((await mailbox('rmbx_1')).rampCurrent).toBe(15);

      // Same day again: nothing.
      await run(new Date('2026-10-13T15:00:00Z'));
      expect((await mailbox('rmbx_1')).rampCurrent).toBe(15);

      for (const day of [14, 15, 16]) await run(new Date(Date.UTC(2026, 9, day, 3, 15)));
      expect((await mailbox('rmbx_1')).rampCurrent).toBe(30);

      // At the cap there is nothing left to track.
      expect(await run(new Date('2026-10-17T03:15:00Z'))).toBeNull();
    });

    it('never ramps beyond the cap and pulls a ramp down to a lowered cap', async () => {
      await active({ dailyCap: 12, rampCurrent: 10, rampUpdatedAt: null });
      const { run } = setup();
      await run();
      expect((await mailbox('rmbx_1')).rampCurrent).toBe(12);

      await db.update(schema.reachMailboxes).set({ dailyCap: 8 }).where(eq(schema.reachMailboxes.id, 'rmbx_1'));
      await run();
      expect((await mailbox('rmbx_1')).rampCurrent).toBe(8);
    });
  });

  describe('WeldHost domain lapse', () => {
    it('pauses the mailboxes of a domain that is no longer active, and tells the platform', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', rampCurrent: 30 });
      await seedMailbox(db, { id: 'rmbx_2', domainId: 'rdom_1', status: 'warming' });
      await db.update(schema.hostDomains).set({ status: 'expired' }).where(eq(schema.hostDomains.id, 'dom_1'));
      const { publish, run } = setup();

      const next = await run();

      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'paused', pausedReason: 'domain_inactive' });
      expect(await mailbox('rmbx_2')).toMatchObject({ status: 'paused', pausedReason: 'domain_inactive' });
      expect(publish).toHaveBeenCalledTimes(2);
      // Waiting for the domain to come back.
      expect(next).toEqual(TOMORROW);
    });

    it('also pauses when the expiry date has passed, or the domain is gone', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', rampCurrent: 30 });
      await db.update(schema.hostDomains).set({ expiresAt: new Date('2026-10-13T00:00:00Z') }).where(eq(schema.hostDomains.id, 'dom_1'));
      await setup().run();
      expect((await mailbox('rmbx_1')).status).toBe('paused');

      await db.update(schema.reachMailboxes).set({ status: 'active', pausedReason: null }).where(eq(schema.reachMailboxes.id, 'rmbx_1'));
      await db.update(schema.hostDomains).set({ expiresAt: null, deletedAt: NOW }).where(eq(schema.hostDomains.id, 'dom_1'));
      await setup().run();
      expect((await mailbox('rmbx_1')).status).toBe('paused');
    });

    it('resumes what it paused once the domain works again, but never a mailbox the user paused', async () => {
      await seedMailbox(db, { id: 'rmbx_lapsed', domainId: 'rdom_1', status: 'paused', pausedReason: 'domain_inactive', warmupDay: 20 });
      await seedMailbox(db, { id: 'rmbx_young', domainId: 'rdom_1', status: 'paused', pausedReason: 'domain_inactive', warmupDay: 3 });
      await seedMailbox(db, { id: 'rmbx_user', domainId: 'rdom_1', status: 'paused', pausedReason: 'user' });
      const { run } = setup();

      await run();

      expect((await mailbox('rmbx_lapsed')).status).toBe('active');
      expect(await mailbox('rmbx_lapsed')).toMatchObject({ pausedReason: null });
      expect((await mailbox('rmbx_young')).status).toBe('warming');
      expect(await mailbox('rmbx_user')).toMatchObject({ status: 'paused', pausedReason: 'user' });
    });

    it('keeps the mailboxes paused while the Mailpool domain itself is in error', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'paused', pausedReason: 'domain_inactive' });
      await db.update(schema.reachDomains).set({ status: 'error' }).where(eq(schema.reachDomains.id, 'rdom_1'));

      await setup().run();
      expect((await mailbox('rmbx_1')).status).toBe('paused');
    });
  });

  describe('when to come back', () => {
    it('is null for a workspace with nothing to track', async () => {
      expect(await setup().run()).toBeNull();

      await seedMailbox(db, { id: 'rmbx_del', domainId: 'rdom_1', status: 'deleted', deletedAt: NOW });
      expect(await setup().run()).toBeNull();
    });

    it('watches the earliest domain expiry once everything is fully ramped, so a lapse is noticed without a daily wake-up', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', dailyCap: 30, rampCurrent: 30 });
      const expiry = new Date('2027-03-01T00:00:00Z');
      await db.update(schema.hostDomains).set({ expiresAt: expiry }).where(eq(schema.hostDomains.id, 'dom_1'));

      expect(await setup().run()).toEqual(expiry);
    });

    it('prefers tomorrow while anything still ramps', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', dailyCap: 30, rampCurrent: 15, rampUpdatedAt: NOW });
      await db.update(schema.hostDomains).set({ expiresAt: new Date('2027-03-01T00:00:00Z') }).where(eq(schema.hostDomains.id, 'dom_1'));

      expect(await setup().run()).toEqual(TOMORROW);
    });

    it('ignores a user-paused mailbox', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'paused', pausedReason: 'user' });
      expect(await setup().run()).toBeNull();
    });
  });
});
