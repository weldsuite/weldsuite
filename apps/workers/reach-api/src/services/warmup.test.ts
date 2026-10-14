/**
 * Warmup as the tenant sees it: the health gate and its blockers, and the
 * daily per-workspace pass that follows the master warmup pool (state
 * transitions, ramp, WeldHost lapse, next visit). Pglite tenant + pglite master.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { openWarmupCredentials } from '@weldsuite/reach-domain/warmup-pool';
import { openMailServerCredentials } from '@weldsuite/reach-domain/credentials';
import { MailpoolError } from '../lib/mailpool/errors';
import { createFakeMailpool, mailpoolMailbox } from '../lib/mailpool/testing';
import {
  WARMUP_TEST_KEY,
  poolStats,
  resetReachMaster,
  resetReachTenant,
  seedHostDomain,
  seedMailbox,
  seedPoolMailbox,
  seedReachDomain,
} from '../lib/mailpool/testing-db';
import { processWorkspaceWarmup, resumeStatusFor, type WarmupEvent } from './warmup';

const ENCRYPTION_KEY = 'cd'.repeat(32);
const ENV = { DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY, WELDREACH_WARMUP_KEY: WARMUP_TEST_KEY };
// Tuesday 2026-10-13, 03:15 UTC, as the daily cron sees it.
const NOW = new Date('2026-10-13T03:15:00Z');
const TOMORROW = new Date('2026-10-14T00:00:00Z');

let db: Database;
let master: MasterDatabase;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  await resetReachTenant(db);
  await resetReachMaster(master);
  await seedHostDomain(db, { id: 'dom_1', fullDomain: 'getacme.com' });
  await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_1', name: 'getacme.com' });
});

function setup() {
  const mailpool = createFakeMailpool();
  const publish = vi.fn(async (_event: WarmupEvent) => {});
  const run = (now = NOW) =>
    processWorkspaceWarmup({ db, master, mailpool, env: ENV, clerkOrgId: 'org_acme', masterWorkspaceId: 'ws_acme', now, publish });
  return { mailpool, publish, run };
}

async function mailbox(id: string) {
  const [row] = await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, id));
  return row!;
}

async function poolRowOf(tenantMailboxId: string) {
  const [row] = await master
    .select()
    .from(masterSchema.reachWarmupMailboxes)
    .where(eq(masterSchema.reachWarmupMailboxes.tenantMailboxId, tenantMailboxId));
  return row;
}

const poolFor = (tenantMailboxId: string, overrides: Partial<Parameters<typeof seedPoolMailbox>[1]> = {}) =>
  seedPoolMailbox(master, { tenantMailboxId, status: 'warming', ...overrides });

describe('warmup gate helpers', () => {
  it('resumes to active only while the mailbox still passes the health gate', () => {
    expect(resumeStatusFor({ warmupDay: 13, warmupInboxRate: 0.95 })).toBe('warming');
    expect(resumeStatusFor({ warmupDay: 14, warmupInboxRate: null })).toBe('warming');
    expect(resumeStatusFor({ warmupDay: 14, warmupInboxRate: 0.84 })).toBe('warming');
    expect(resumeStatusFor({ warmupDay: 14, warmupInboxRate: 0.85 })).toBe('active');
  });
});

describe('processWorkspaceWarmup', () => {
  describe('provisioning', () => {
    it('stores the logins, enters the warmup pool and warms once the mailbox is active at Mailpool', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'provisioning', mailpoolMailboxId: '341', email: 'jane@getacme.com' });
      const { mailpool, publish, run } = setup();
      mailpool.getMailbox.mockResolvedValueOnce(mailpoolMailbox({ email: 'jane@getacme.com', firstName: 'Jane', lastName: 'Doe', type: 'google' }, { id: '341' }));

      const next = await run();

      const row = await mailbox('rmbx_1');
      expect(row).toMatchObject({ status: 'warming', warmupStatus: 'waiting' });
      expect(row.warmupStartedAt).toEqual(NOW);
      expect(await openMailServerCredentials(ENV, row.smtpCredentials)).toMatchObject({ host: 'smtp.mailpool.test', port: 465 });

      const pool = (await poolRowOf('rmbx_1'))!;
      expect(pool).toMatchObject({
        status: 'waiting',
        workspaceId: 'ws_acme',
        clerkOrgId: 'org_acme',
        email: 'jane@getacme.com',
        domain: 'getacme.com',
        mailboxType: 'google',
        firstName: 'Jane',
        lastName: 'Doe',
      });
      // The pool holds its own sealed copy, opened with the warmup key.
      expect(pool.smtpCredentials).not.toContain('smtp-secret-password');
      expect(await openWarmupCredentials(ENV, pool.smtpCredentials)).toMatchObject({ host: 'smtp.mailpool.test', port: 465, password: 'smtp-secret-password' });
      expect(await openWarmupCredentials(ENV, pool.imapCredentials)).toMatchObject({ host: 'imap.mailpool.test', port: 993, password: 'imap-secret-password' });

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
      expect(await poolRowOf('rmbx_wait')).toBeUndefined();
    });

    it('waits as provisioning while Mailpool has no logins for the mailbox yet', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'provisioning', mailpoolMailboxId: '341', smtpCredentials: null, imapCredentials: null });
      const { mailpool, run } = setup();
      mailpool.getMailbox.mockResolvedValueOnce({ id: '341', type: 'google', email: 'jane@getacme.com', status: 'active' });

      expect(await run()).toEqual(TOMORROW);
      expect((await mailbox('rmbx_1')).status).toBe('provisioning');
      expect(await poolRowOf('rmbx_1')).toBeUndefined();
    });

    it('stays provisioning, and registers nothing, when the pool cannot be written (the pass tries again)', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'provisioning', mailpoolMailboxId: '341', email: 'jane@getacme.com' });
      const { mailpool } = setup();
      mailpool.getMailbox.mockResolvedValueOnce(mailpoolMailbox({ email: 'jane@getacme.com', firstName: 'Jane', lastName: 'Doe', type: 'google' }, { id: '341' }));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      // No warmup key on this deployment: sealing the logins fails.
      await processWorkspaceWarmup({
        db,
        master,
        mailpool,
        env: { DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY },
        clerkOrgId: 'org_acme',
        masterWorkspaceId: 'ws_acme',
        now: NOW,
      });

      expect((await mailbox('rmbx_1')).status).toBe('provisioning');
      expect(await poolRowOf('rmbx_1')).toBeUndefined();
      error.mockRestore();
    });

    it('waits without a Mailpool client (no API key) but still follows the pool for the rest', async () => {
      await seedMailbox(db, { id: 'rmbx_p', domainId: 'rdom_1', status: 'provisioning', mailpoolMailboxId: '1' });
      await seedMailbox(db, { id: 'rmbx_w', domainId: 'rdom_1', status: 'warming' });
      await poolFor('rmbx_w', { rampDay: 5 });

      const next = await processWorkspaceWarmup({
        db,
        master,
        mailpool: null,
        env: ENV,
        clerkOrgId: 'org_acme',
        masterWorkspaceId: 'ws_acme',
        now: NOW,
      });

      expect((await mailbox('rmbx_p')).status).toBe('provisioning');
      expect((await mailbox('rmbx_w')).warmupDay).toBe(5);
      expect(next).toEqual(TOMORROW);
    });
  });

  describe('warming: the health gate', () => {
    const warming = (overrides: Record<string, unknown> = {}) =>
      seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'warming', mailpoolMailboxId: '341', email: 'jane@getacme.com', dailyCap: 30, ...overrides });

    it('copies the pool state to the tenant: ramp day, pool status and 3-day inbox rate', async () => {
      await warming();
      await poolFor('rmbx_1', { rampDay: 6, stats: poolStats({ inboxRate3d: 0.912345 }) });
      const { publish, run } = setup();

      const next = await run();

      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'warming', warmupDay: 6, warmupStatus: 'warming', warmupInboxRate: 0.9123 });
      expect(publish).not.toHaveBeenCalled();
      expect(next).toEqual(TOMORROW);
    });

    it('keeps warming before 14 days of warmup, however good the placement', async () => {
      await warming();
      await poolFor('rmbx_1', { rampDay: 13, stats: poolStats({ inboxRate3d: 0.99 }) });
      const { run } = setup();

      await run();
      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'warming', warmupDay: 13 });
    });

    it('keeps warming at 14 days while there is not enough data for a rate', async () => {
      await warming();
      await poolFor('rmbx_1', { status: 'maintaining', rampDay: 14, stats: poolStats({ inboxRate3d: null }) });
      const { run } = setup();

      await run();
      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'warming', warmupDay: 14, warmupInboxRate: null, warmupStatus: 'maintaining' });
    });

    it('keeps warming at 14 days when inbox placement is below 85%', async () => {
      await warming();
      await poolFor('rmbx_1', { status: 'maintaining', rampDay: 20, stats: poolStats({ inboxRate3d: 0.84 }) });
      const { run } = setup();

      await run();
      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'warming', warmupDay: 20, warmupInboxRate: 0.84 });
    });

    it('goes active at 14 days with 85% placement, starting the ramp at 10 sends a day', async () => {
      await warming();
      await poolFor('rmbx_1', { status: 'maintaining', rampDay: 14, stats: poolStats({ inboxRate3d: 0.85 }) });
      const { publish, run } = setup();

      await run();

      const row = await mailbox('rmbx_1');
      expect(row).toMatchObject({ status: 'active', warmupDay: 14, warmupInboxRate: 0.85, rampCurrent: 10 });
      expect(row.rampUpdatedAt).toEqual(NOW);
      expect(publish).toHaveBeenCalledOnce();
      expect(publish.mock.calls[0]![0]).toMatchObject({ entityId: 'rmbx_1', action: 'updated' });
      // The event payload carries no sealed logins.
      expect(JSON.stringify(publish.mock.calls[0]![0])).not.toMatch(/smtpCredentials|imapCredentials/);
    });

    it('caps the first ramp at a low daily cap', async () => {
      await warming({ dailyCap: 6 });
      await poolFor('rmbx_1', { status: 'maintaining', rampDay: 14, stats: poolStats({ inboxRate3d: 0.9 }) });
      const { run } = setup();

      await run();
      expect((await mailbox('rmbx_1')).rampCurrent).toBe(6);
    });

    it('does not graduate a mailbox with a standing login error, even when the numbers are good', async () => {
      await warming();
      await poolFor('rmbx_1', {
        status: 'maintaining',
        rampDay: 20,
        stats: poolStats({ inboxRate3d: 0.95 }),
        lastLoginError: 'AUTHENTICATIONFAILED',
        lastLoginErrorAt: new Date('2026-10-12T10:00:00Z'),
      });
      const { run } = setup();

      await run();
      expect((await mailbox('rmbx_1')).status).toBe('warming');
    });

    it('leaves a mailbox that is missing from the pool warming, and tells the log', async () => {
      await warming();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { run } = setup();

      expect(await run()).toEqual(TOMORROW);
      expect((await mailbox('rmbx_1')).status).toBe('warming');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('rmbx_1 is not in the warmup pool'));
      warn.mockRestore();
    });

    it('carries on with the other mailboxes when one fails, and visits again tomorrow', async () => {
      await seedMailbox(db, { id: 'rmbx_bad', domainId: 'rdom_1', status: 'provisioning', mailpoolMailboxId: '1' });
      await warming({ id: 'rmbx_2', email: 'tom@getacme.com' });
      await poolFor('rmbx_2', { rampDay: 4 });
      const { mailpool, run } = setup();
      mailpool.getMailbox.mockRejectedValue(new MailpoolError({ method: 'GET', path: '/mailboxes/1', status: 502 }));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const next = await run();

      expect((await mailbox('rmbx_bad')).status).toBe('provisioning');
      expect((await mailbox('rmbx_2')).warmupDay).toBe(4);
      expect(next).toEqual(TOMORROW);
      error.mockRestore();
    });
  });

  describe('what the network reports', () => {
    it('turns a failed login into an error mailbox with a suspension event and a customer-safe message', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'warming' });
      await poolFor('rmbx_1', {
        status: 'error',
        pausedReason: 'login_failed',
        rampDay: 6,
        lastLoginError: 'a1 NO [AUTHENTICATIONFAILED] Invalid credentials for jane@getacme.com',
        lastLoginErrorAt: NOW,
      });
      const { publish, run } = setup();

      const next = await run();

      const row = await mailbox('rmbx_1');
      expect(row).toMatchObject({ status: 'error', pausedReason: 'login_failed', warmupStatus: 'error', warmupDay: 6 });
      expect(row.lastError).toBe('The warmup network could not sign in to this mailbox. Check the mailbox login at your provider.');
      expect(row.lastError).not.toContain('AUTHENTICATIONFAILED');
      expect(publish).toHaveBeenCalledOnce();
      expect(publish.mock.calls[0]![0]).toMatchObject({ entityId: 'rmbx_1', action: 'suspended' });
      // It comes back by itself once the login works, so the workspace is visited again.
      expect(next).toEqual(TOMORROW);
    });

    it('does the same for an active mailbox', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', rampCurrent: 30 });
      await poolFor('rmbx_1', { status: 'error', pausedReason: 'login_failed', lastLoginError: 'bad' });
      const { run } = setup();

      await run();
      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'error', pausedReason: 'login_failed' });
    });

    it('brings a login-failed mailbox back to warming when the network can sign in again, and the gate re-promotes it', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'error', pausedReason: 'login_failed', lastError: 'x', dailyCap: 30 });
      await poolFor('rmbx_1', { status: 'maintaining', rampDay: 22, stats: poolStats({ inboxRate3d: 0.93 }) });
      const { publish, run } = setup();

      await run();

      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'active', pausedReason: null, lastError: null, rampCurrent: 10 });
      expect(publish).toHaveBeenCalledTimes(2); // error -> warming -> active
    });

    it('keeps a login-failed mailbox in error while the pool still reports the failure', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'error', pausedReason: 'login_failed' });
      await poolFor('rmbx_1', { status: 'error', pausedReason: 'login_failed', lastLoginError: 'bad' });
      const { publish, run } = setup();

      await run();
      expect((await mailbox('rmbx_1')).status).toBe('error');
      expect(publish).not.toHaveBeenCalled();
    });

    it('leaves an error that came from Mailpool alone (its webhook clears those)', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'error', pausedReason: null, lastError: 'Mailpool: admin password changed.' });
      await poolFor('rmbx_1', { status: 'warming' });
      const { run } = setup();

      expect(await run()).toBeNull();
      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'error', lastError: 'Mailpool: admin password changed.' });
    });

    it.each(['warming', 'active'] as const)('pauses a %s mailbox when the network pauses it for low inbox placement', async (status) => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status, rampCurrent: 30 });
      await poolFor('rmbx_1', { status: 'paused', pausedReason: 'low_inbox_rate', rampDay: 25, stats: poolStats({ inboxRate3d: 0.6 }) });
      const { publish, run } = setup();

      const next = await run();

      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'paused', pausedReason: 'low_inbox_rate', warmupStatus: 'paused', warmupInboxRate: 0.6 });
      expect(publish.mock.calls[0]![0]).toMatchObject({ entityId: 'rmbx_1', action: 'updated' });
      expect(next).toEqual(TOMORROW);
    });

    it('resumes a placement pause to warming once the network runs the mailbox again, and the gate decides', async () => {
      await seedMailbox(db, { id: 'rmbx_ok', domainId: 'rdom_1', status: 'paused', pausedReason: 'low_inbox_rate' });
      await seedMailbox(db, { id: 'rmbx_low', domainId: 'rdom_1', status: 'paused', pausedReason: 'low_inbox_rate' });
      await poolFor('rmbx_ok', { status: 'maintaining', rampDay: 25, stats: poolStats({ inboxRate3d: 0.9 }) });
      await poolFor('rmbx_low', { status: 'warming', rampDay: 25, stats: poolStats({ inboxRate3d: 0.7 }) });
      const { run } = setup();

      await run();

      expect(await mailbox('rmbx_ok')).toMatchObject({ status: 'active', pausedReason: null });
      expect(await mailbox('rmbx_low')).toMatchObject({ status: 'warming', pausedReason: null });
    });

    it('keeps a placement pause while the network still holds the mailbox', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'paused', pausedReason: 'low_inbox_rate' });
      await poolFor('rmbx_1', { status: 'paused', pausedReason: 'low_inbox_rate' });
      const { run } = setup();

      expect(await run()).toEqual(TOMORROW);
      expect((await mailbox('rmbx_1')).status).toBe('paused');
    });

    it('does not touch a mailbox the network paused for another reason (an admin hold): it only mirrors the status', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'warming' });
      await poolFor('rmbx_1', { status: 'paused', pausedReason: 'admin_hold', rampDay: 3 });
      const { run } = setup();

      await run();
      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'warming', warmupStatus: 'paused', warmupDay: 3 });
    });
  });

  describe('ramp', () => {
    const active = async (overrides: Record<string, unknown> = {}) => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', dailyCap: 30, rampCurrent: 10, ...overrides });
      await poolFor('rmbx_1', { status: 'maintaining', rampDay: 20, stats: poolStats({ inboxRate3d: 0.9 }) });
    };

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

    it('keeps the warmup numbers of an active mailbox current while it ramps', async () => {
      await active({ rampUpdatedAt: new Date('2026-10-12T03:15:00Z'), warmupDay: 14, warmupInboxRate: 0.85 });
      await master
        .update(masterSchema.reachWarmupMailboxes)
        .set({ rampDay: 33, stats: poolStats({ inboxRate3d: 0.97 }) })
        .where(eq(masterSchema.reachWarmupMailboxes.tenantMailboxId, 'rmbx_1'));

      await setup().run();
      expect(await mailbox('rmbx_1')).toMatchObject({ warmupDay: 33, warmupInboxRate: 0.97, warmupStatus: 'maintaining', rampCurrent: 15 });
    });

    it('still ramps an active mailbox that is missing from the pool', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', dailyCap: 30, rampCurrent: 10, rampUpdatedAt: null });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await setup().run();
      expect((await mailbox('rmbx_1')).rampCurrent).toBe(15);
      warn.mockRestore();
    });
  });

  describe('WeldHost domain lapse', () => {
    it('pauses the mailboxes of a domain that is no longer active, in the pool too, and tells the platform', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', rampCurrent: 30 });
      await seedMailbox(db, { id: 'rmbx_2', domainId: 'rdom_1', status: 'warming' });
      await poolFor('rmbx_1', { status: 'maintaining' });
      await poolFor('rmbx_2');
      await db.update(schema.hostDomains).set({ status: 'expired' }).where(eq(schema.hostDomains.id, 'dom_1'));
      const { publish, run } = setup();

      const next = await run();

      expect(await mailbox('rmbx_1')).toMatchObject({ status: 'paused', pausedReason: 'domain_inactive' });
      expect(await mailbox('rmbx_2')).toMatchObject({ status: 'paused', pausedReason: 'domain_inactive' });
      expect(await poolRowOf('rmbx_1')).toMatchObject({ status: 'paused', pausedReason: 'domain_inactive' });
      expect(await poolRowOf('rmbx_2')).toMatchObject({ status: 'paused', pausedReason: 'domain_inactive' });
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

    it('resumes what it paused once the domain works again (pool too), but never a mailbox the user paused', async () => {
      await seedMailbox(db, { id: 'rmbx_lapsed', domainId: 'rdom_1', status: 'paused', pausedReason: 'domain_inactive', warmupDay: 20, warmupInboxRate: 0.9 });
      await seedMailbox(db, { id: 'rmbx_young', domainId: 'rdom_1', status: 'paused', pausedReason: 'domain_inactive', warmupDay: 3 });
      await seedMailbox(db, { id: 'rmbx_user', domainId: 'rdom_1', status: 'paused', pausedReason: 'user' });
      await poolFor('rmbx_lapsed', { status: 'paused', pausedReason: 'domain_inactive', startedAt: new Date('2026-09-20T00:00:00Z'), rampDay: 20 });
      await poolFor('rmbx_user', { status: 'paused', pausedReason: 'paused_by_user' });
      const { run } = setup();

      await run();

      expect(await mailbox('rmbx_lapsed')).toMatchObject({ status: 'active', pausedReason: null });
      expect(await poolRowOf('rmbx_lapsed')).toMatchObject({ status: 'maintaining', pausedReason: null });
      expect((await mailbox('rmbx_young')).status).toBe('warming');
      expect(await mailbox('rmbx_user')).toMatchObject({ status: 'paused', pausedReason: 'user' });
      expect(await poolRowOf('rmbx_user')).toMatchObject({ status: 'paused', pausedReason: 'paused_by_user' });
    });

    it('resumes to warming when the mailbox no longer passes the health gate', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'paused', pausedReason: 'domain_inactive', warmupDay: 20, warmupInboxRate: 0.6 });
      await setup().run();
      expect((await mailbox('rmbx_1')).status).toBe('warming');
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
      await poolFor('rmbx_1', { status: 'maintaining' });
      const expiry = new Date('2027-03-01T00:00:00Z');
      await db.update(schema.hostDomains).set({ expiresAt: expiry }).where(eq(schema.hostDomains.id, 'dom_1'));

      expect(await setup().run()).toEqual(expiry);
    });

    it('prefers tomorrow while anything still ramps', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', dailyCap: 30, rampCurrent: 15, rampUpdatedAt: NOW });
      await poolFor('rmbx_1', { status: 'maintaining' });
      await db.update(schema.hostDomains).set({ expiresAt: new Date('2027-03-01T00:00:00Z') }).where(eq(schema.hostDomains.id, 'dom_1'));

      expect(await setup().run()).toEqual(TOMORROW);
    });

    it('ignores a user-paused mailbox', async () => {
      await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'paused', pausedReason: 'user' });
      expect(await setup().run()).toBeNull();
    });
  });
});
