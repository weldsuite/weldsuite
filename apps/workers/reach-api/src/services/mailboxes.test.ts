/**
 * Mailbox lifecycle against pglite (tenant + master), a fake Mailpool, fake
 * billing and an in-memory D1 due index. The order of the paid steps and the
 * rollback on failure are the point of the create tests.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { WELDREACH_DEFAULT_LIMITS, type CreateReachMailboxInput } from '@weldsuite/app-api-client/schemas/reach';
import { PaymentMethodRequiredError, ReachBillingError } from '../lib/billing';
import { openMailServerCredentials } from '../lib/credentials';
import { MailpoolError } from '../lib/mailpool/errors';
import { createFakeBilling, createFakeMailpool, mailpoolMailbox, warmupInbox } from '../lib/mailpool/testing';
import { resetReachMaster, resetReachTenant, seedMailbox, seedReachDomain } from '../lib/mailpool/testing-db';
import {
  createMailbox,
  deleteMailbox,
  getMailboxDto,
  listMailboxes,
  pauseMailbox,
  resumeMailbox,
  updateMailbox,
  withoutCredentials,
  type MailboxDeps,
} from './mailboxes';
import { ReachServiceError } from './reach-errors';

const ENCRYPTION_KEY = 'ab'.repeat(32);
const NOW = new Date('2026-10-12T10:00:00Z');
const DUE_INDEX_MIGRATION = readFileSync(
  resolve(__dirname, '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
  'utf8',
);

let db: Database;
let master: MasterDatabase;

function setup(overrides: { mailpool?: Parameters<typeof createFakeMailpool>[0]; billing?: Parameters<typeof createFakeBilling>[0] } = {}) {
  const mailpool = createFakeMailpool(overrides.mailpool);
  const billing = createFakeBilling(overrides.billing);
  const d1 = createSqliteD1(DUE_INDEX_MIGRATION);
  const deps: MailboxDeps = {
    env: {
      DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY,
      REACH_INBOUND_DOMAIN: 'reply-test.weldsuite.org',
      SCHEDULE_INDEX: d1,
    },
    db,
    master,
    mailpool,
    billing,
    clerkOrgId: 'org_acme',
    masterWorkspaceId: 'ws_acme',
    userId: 'user_1',
    now: () => NOW,
  };
  return { deps, mailpool, billing, d1 };
}

const options = { limits: WELDREACH_DEFAULT_LIMITS, defaultDailyCap: 30 };
const input = (overrides: Partial<CreateReachMailboxInput> = {}): CreateReachMailboxInput => ({
  domainId: 'rdom_1',
  localPart: 'jane',
  firstName: 'Jane',
  lastName: 'Doe',
  type: 'google',
  ...overrides,
});

async function mailboxCount(): Promise<number> {
  return (await db.select().from(schema.reachMailboxes)).length;
}
async function routeRows() {
  return master.select().from(masterSchema.reachRoutes);
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

describe('createMailbox', () => {
  it('bills first, then takes a slot, then creates at Mailpool with the forward address', async () => {
    const { deps, mailpool, billing } = setup();
    const row = await createMailbox(deps, input(), options);

    const billed = billing.adjustInboxes.mock.invocationCallOrder[0]!;
    const slotted = mailpool.getSlots.mock.invocationCallOrder[0]!;
    const created = mailpool.createMailbox.mock.invocationCallOrder[0]!;
    expect(billed).toBeLessThan(slotted);
    expect(slotted).toBeLessThan(created);
    expect(billing.adjustInboxes).toHaveBeenCalledExactlyOnceWith(1, row.id);

    const sent = mailpool.createMailbox.mock.calls[0]![0] as { email: string; forwardTo: string; type: string };
    expect(sent.email).toBe('jane@getacme.com');
    expect(sent.type).toBe('google');
    expect(sent.forwardTo).toBe(`${row.inboundToken}@reply-test.weldsuite.org`);
    expect(row.inboundToken).toMatch(/^[a-z]{24}$/);
  });

  it('refuses a new mailbox while a cancelled subscription still has mailboxes, before billing', async () => {
    const { deps, billing, mailpool } = setup();
    await createMailbox(deps, input(), options);

    const attempt = createMailbox(deps, input({ localPart: 'john' }), { ...options, billingStatus: 'canceled' });
    await expect(attempt).rejects.toMatchObject({ status: 402, code: 'BILLING_CANCELED' });
    expect(billing.adjustInboxes).toHaveBeenCalledTimes(1);
    expect(mailpool.createMailbox).toHaveBeenCalledTimes(1);
  });

  it('allows the first mailbox after a cancelled subscription (nothing left unbilled)', async () => {
    const { deps } = setup();
    const row = await createMailbox(deps, input(), { ...options, billingStatus: 'canceled' });
    expect(row.status).toBe('warming');
  });

  it('stores the mailbox warming, with sealed logins, ramp start and the default cap', async () => {
    const { deps } = setup();
    const row = await createMailbox(deps, input({ signature: 'Best,\nJane' }), { ...options, defaultDailyCap: 25 });

    expect(row).toMatchObject({
      id: expect.stringMatching(/^rmbx_/),
      domainId: 'rdom_1',
      email: 'jane@getacme.com',
      status: 'warming',
      type: 'google',
      signature: 'Best,\nJane',
      dailyCap: 25,
      rampCurrent: 10,
      warmupDay: 0,
      createdBy: 'user_1',
    });
    expect(row.warmupStartedAt).toEqual(NOW);
    expect(row.mailpoolMailboxId).toMatch(/^\d+$/);

    // The password never sits in the row in the clear, and opens with the key.
    expect(row.smtpCredentials).not.toContain('smtp-secret-password');
    expect(row.imapCredentials).not.toContain('imap-secret-password');
    expect(await openMailServerCredentials({ DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY }, row.smtpCredentials)).toEqual({
      host: 'smtp.mailpool.test',
      port: 465,
      tls: true,
      username: 'jane@getacme.com',
      password: 'smtp-secret-password',
    });
  });

  it('writes the master routes for webhooks and inbound mail', async () => {
    const { deps } = setup();
    const row = await createMailbox(deps, input({ type: 'shared' }), options);

    const routes = await routeRows();
    expect(routes).toHaveLength(2);
    const mailbox = routes.find((r) => r.kind === 'mailpool_mailbox');
    const inbound = routes.find((r) => r.kind === 'inbound_token');
    expect(mailbox).toMatchObject({
      externalId: row.mailpoolMailboxId,
      workspaceId: 'ws_acme',
      clerkOrgId: 'org_acme',
      tenantEntityId: row.id,
      mailboxType: 'shared',
      status: 'active',
    });
    expect(inbound).toMatchObject({ externalId: row.inboundToken, workspaceId: 'ws_acme', tenantEntityId: row.id, status: 'active' });
  });

  it('adds the mailbox to Mailpool warmup and schedules the daily check for tomorrow', async () => {
    const { deps, mailpool, d1 } = setup();
    const row = await createMailbox(deps, input(), options);

    expect(mailpool.addToWarmup).toHaveBeenCalledExactlyOnceWith([Number(row.mailpoolMailboxId)]);
    expect(row.warmupStatus).toBe('Pending');

    const due = await d1
      .prepare("SELECT next_due_at FROM workspace_due_index WHERE kind = 'reach_warmup' AND workspace_id = ?")
      .bind('org_acme')
      .first<number>('next_due_at');
    expect(due).toBe(Date.UTC(2026, 9, 13));
  });

  it('never exposes the logins in the API shape', async () => {
    const { deps } = setup();
    const row = await createMailbox(deps, input(), options);

    expect(withoutCredentials(row)).not.toHaveProperty('smtpCredentials');
    expect(withoutCredentials(row)).not.toHaveProperty('imapCredentials');
    const dto = await getMailboxDto(db, row.id, NOW);
    expect(dto).toMatchObject({ email: 'jane@getacme.com', domainName: 'getacme.com', status: 'warming', sentToday: 0 });
    const text = JSON.stringify(dto);
    expect(text).not.toContain('secret');
    expect(dto).not.toHaveProperty('smtpCredentials');
    expect(dto).not.toHaveProperty('inboundToken');
  });

  it('adds a Mailpool slot first when the account is full for that type', async () => {
    const { deps, mailpool } = setup({
      mailpool: { getSlots: async () => ({ mailboxes: { google: 5 }, slots: { google: 5 } }) },
    });
    await createMailbox(deps, input(), options);

    expect(mailpool.increaseSlots).toHaveBeenCalledExactlyOnceWith('google', 1);
    expect(mailpool.increaseSlots.mock.invocationCallOrder[0]!).toBeLessThan(mailpool.createMailbox.mock.invocationCallOrder[0]!);
  });

  it('does not touch slots for a type Mailpool reports none for (shared)', async () => {
    const { deps, mailpool } = setup();
    await createMailbox(deps, input({ type: 'shared' }), options);
    expect(mailpool.increaseSlots).not.toHaveBeenCalled();
  });

  it('keeps a mailbox Mailpool is still creating in provisioning, without warmup', async () => {
    const { deps, mailpool } = setup({
      mailpool: { createMailbox: async (i: Parameters<typeof mailpoolMailbox>[0]) => mailpoolMailbox(i, { status: 'pending', smtpHost: undefined, smtpPassword: undefined }) },
    });
    const row = await createMailbox(deps, input(), options);

    expect(row.status).toBe('provisioning');
    expect(row.smtpCredentials).toBeNull();
    expect(row.warmupStartedAt).toBeNull();
    expect(mailpool.addToWarmup).not.toHaveBeenCalled();
  });

  it('keeps the mailbox when only the warmup start fails (the daily pass retries it)', async () => {
    const { deps, billing } = setup({ mailpool: { addToWarmup: async () => { throw new MailpoolError({ method: 'POST', path: '/warmup', status: 502 }); } } });
    const row = await createMailbox(deps, input(), options);

    expect(row.status).toBe('warming');
    expect(await mailboxCount()).toBe(1);
    expect(billing.adjustInboxes).toHaveBeenCalledTimes(1);
  });

  describe('refusals before anything is paid', () => {
    it('answers 402 PAYMENT_METHOD_REQUIRED and calls Mailpool never', async () => {
      const { deps, mailpool } = setup({ billing: { adjustInboxes: async () => { throw new PaymentMethodRequiredError(); } } });

      await expect(createMailbox(deps, input(), options)).rejects.toBeInstanceOf(PaymentMethodRequiredError);
      expect(mailpool.getSlots).not.toHaveBeenCalled();
      expect(mailpool.createMailbox).not.toHaveBeenCalled();
      expect(await mailboxCount()).toBe(0);
      expect(await routeRows()).toHaveLength(0);
    });

    it('stops at the staff-set mailbox limit', async () => {
      await seedMailbox(db, { id: 'rmbx_a', domainId: 'rdom_1' });
      await seedMailbox(db, { id: 'rmbx_b', domainId: 'rdom_1' });
      await seedMailbox(db, { id: 'rmbx_gone', domainId: 'rdom_1', status: 'deleted', deletedAt: NOW });
      const { deps, billing } = setup();

      const err = (await createMailbox(deps, input(), { ...options, limits: { ...WELDREACH_DEFAULT_LIMITS, maxMailboxes: 2 } }).catch((e: unknown) => e)) as ReachServiceError;
      expect(err.code).toBe('MAILBOX_LIMIT_REACHED');
      expect(err.status).toBe(403);
      expect(billing.adjustInboxes).not.toHaveBeenCalled();

      // Deleted mailboxes do not count: one more fits under a limit of 3.
      await expect(createMailbox(deps, input(), { ...options, limits: { ...WELDREACH_DEFAULT_LIMITS, maxMailboxes: 3 } })).resolves.toBeTruthy();
    });

    it('needs an active domain of this workspace', async () => {
      const { deps, billing } = setup();
      await expect(createMailbox(deps, input({ domainId: 'rdom_missing' }), options)).rejects.toMatchObject({ code: 'DOMAIN_NOT_FOUND', status: 404 });

      await db.update(schema.reachDomains).set({ status: 'connecting' }).where(eq(schema.reachDomains.id, 'rdom_1'));
      await expect(createMailbox(deps, input(), options)).rejects.toMatchObject({ code: 'DOMAIN_NOT_ACTIVE', status: 409 });
      expect(billing.adjustInboxes).not.toHaveBeenCalled();
    });

    it('refuses an address that exists, deleted or not', async () => {
      await seedMailbox(db, { id: 'rmbx_old', domainId: 'rdom_1', email: 'jane@getacme.com', status: 'deleted', deletedAt: NOW });
      const { deps, billing } = setup();

      await expect(createMailbox(deps, input(), options)).rejects.toMatchObject({ code: 'MAILBOX_EXISTS', status: 409 });
      expect(billing.adjustInboxes).not.toHaveBeenCalled();
    });

    it('needs the inbound domain configured', async () => {
      const { deps } = setup();
      deps.env.REACH_INBOUND_DOMAIN = undefined;
      await expect(createMailbox(deps, input(), options)).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('rollback', () => {
    it('gives the inbox back when the slot check fails', async () => {
      const { deps, billing, mailpool } = setup({ mailpool: { getSlots: async () => { throw new MailpoolError({ method: 'GET', path: '/subscriptions/slots', status: 502 }); } } });

      await expect(createMailbox(deps, input(), options)).rejects.toBeInstanceOf(MailpoolError);
      expect(billing.adjustInboxes.mock.calls.map((c) => c[0])).toEqual([1, -1]);
      expect(mailpool.createMailbox).not.toHaveBeenCalled();
      expect(await mailboxCount()).toBe(0);
    });

    it('gives the inbox back and stores nothing when Mailpool refuses to create', async () => {
      const { deps, billing, mailpool } = setup({
        mailpool: { createMailbox: async () => { throw new MailpoolError({ method: 'POST', path: '/mailboxes', status: 422, body: { message: 'domain not ready' } }); } },
      });

      await expect(createMailbox(deps, input(), options)).rejects.toBeInstanceOf(MailpoolError);

      expect(billing.adjustInboxes.mock.calls.map((c) => c[0])).toEqual([1, -1]);
      expect(billing.adjustInboxes.mock.calls[1]![1]).toBe(billing.adjustInboxes.mock.calls[0]![1]);
      expect(await mailboxCount()).toBe(0);
      expect(await routeRows()).toHaveLength(0);
      expect(mailpool.deleteMailbox).not.toHaveBeenCalled();
    });

    it('deletes the Mailpool mailbox, the row and the routes when our own bookkeeping fails after creating', async () => {
      const { deps, billing, mailpool } = setup();
      const failing = new Proxy(master, {
        get(target, prop, receiver) {
          if (prop === 'insert') return () => { throw new Error('master down'); };
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });

      await expect(createMailbox({ ...deps, master: failing }, input(), options)).rejects.toThrow('master down');

      const createdId = (await mailpool.createMailbox.mock.results[0]!.value as { id: string }).id;
      expect(mailpool.deleteMailbox).toHaveBeenCalledExactlyOnceWith(createdId);
      expect(await mailboxCount()).toBe(0);
      expect(billing.adjustInboxes.mock.calls.map((c) => c[0])).toEqual([1, -1]);
    });

    it('treats a create that failed ambiguously but exists at Mailpool as created', async () => {
      const stray = mailpoolMailbox({ email: 'jane@getacme.com', firstName: 'Jane', lastName: 'Doe', type: 'google' });
      const { deps, billing } = setup({
        mailpool: {
          createMailbox: async () => { throw new MailpoolError({ method: 'POST', path: '/mailboxes', status: 500 }); },
          listMailboxes: async () => ({ data: [stray], total: 1 }),
        },
      });

      const row = await createMailbox(deps, input(), options);
      expect(row.mailpoolMailboxId).toBe(String(stray.id));
      expect(billing.adjustInboxes).toHaveBeenCalledTimes(1);
    });

    it('retries the release a few times; a billing outage cannot hide the original error', async () => {
      let calls = 0;
      const { deps } = setup({
        mailpool: { createMailbox: async () => { throw new MailpoolError({ method: 'POST', path: '/mailboxes', status: 422 }); } },
        billing: {
          adjustInboxes: async (delta: number) => {
            calls += 1;
            if (delta === -1 && calls < 3) throw new ReachBillingError(502, null, 'billing-worker unreachable');
            return { quantity: 0 };
          },
        },
      });

      await expect(createMailbox(deps, input(), options)).rejects.toMatchObject({ status: 422 });
      expect(calls).toBe(3); // +1, then -1 failed once and succeeded on the retry
    });
  });
});

describe('updateMailbox', () => {
  it('sends only what changed to Mailpool, then stores it', async () => {
    const { deps, mailpool } = setup();
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', mailpoolMailboxId: '321', firstName: 'Jane', lastName: 'Doe' });

    const row = await updateMailbox(deps, 'rmbx_1', { firstName: 'Janet', lastName: 'Doe', signature: 'Cheers' });

    expect(mailpool.updateMailbox).toHaveBeenCalledExactlyOnceWith('321', { firstName: 'Janet', signature: 'Cheers' });
    expect(row).toMatchObject({ firstName: 'Janet', lastName: 'Doe', signature: 'Cheers' });
  });

  it('keeps the old values when Mailpool refuses', async () => {
    const { deps } = setup({ mailpool: { updateMailbox: async () => { throw new MailpoolError({ method: 'PUT', path: '/mailboxes/1', status: 502 }); } } });
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', firstName: 'Jane' });

    await expect(updateMailbox(deps, 'rmbx_1', { firstName: 'Janet' })).rejects.toBeInstanceOf(MailpoolError);
    const [row] = await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, 'rmbx_1'));
    expect(row?.firstName).toBe('Jane');
  });

  it('changes the daily cap locally and lowers the ramp with it', async () => {
    const { deps, mailpool } = setup();
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', dailyCap: 40, rampCurrent: 35 });

    const row = await updateMailbox(deps, 'rmbx_1', { dailyCap: 20 });
    expect(row).toMatchObject({ dailyCap: 20, rampCurrent: 20 });
    expect(mailpool.updateMailbox).not.toHaveBeenCalled();
  });

  it('can clear the signature', async () => {
    const { deps, mailpool } = setup();
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', mailpoolMailboxId: '5', signature: 'Old' });

    const row = await updateMailbox(deps, 'rmbx_1', { signature: null });
    expect(row.signature).toBeNull();
    expect(mailpool.updateMailbox).toHaveBeenCalledWith('5', { signature: '' });
  });

  it('answers 404 for a deleted or unknown mailbox', async () => {
    const { deps } = setup();
    await seedMailbox(db, { id: 'rmbx_d', domainId: 'rdom_1', status: 'deleted', deletedAt: NOW });
    await expect(updateMailbox(deps, 'rmbx_d', { firstName: 'X' })).rejects.toMatchObject({ status: 404 });
    await expect(updateMailbox(deps, 'rmbx_none', { firstName: 'X' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('pause and resume', () => {
  it('pauses a warming or active mailbox and records why', async () => {
    await seedMailbox(db, { id: 'rmbx_w', domainId: 'rdom_1', status: 'warming' });
    await seedMailbox(db, { id: 'rmbx_a', domainId: 'rdom_1', status: 'active' });

    expect(await pauseMailbox(db, 'rmbx_w', NOW)).toMatchObject({ status: 'paused', pausedReason: 'user' });
    expect(await pauseMailbox(db, 'rmbx_a', NOW)).toMatchObject({ status: 'paused', pausedReason: 'user' });
    // Pausing twice is fine.
    expect(await pauseMailbox(db, 'rmbx_a', NOW)).toMatchObject({ status: 'paused' });
  });

  it.each(['suspended', 'error', 'provisioning', 'deleting'] as const)('cannot pause a %s mailbox', async (status) => {
    await seedMailbox(db, { id: 'rmbx_x', domainId: 'rdom_1', status });
    await expect(pauseMailbox(db, 'rmbx_x', NOW)).rejects.toMatchObject({ status: 409, code: 'MAILBOX_NOT_PAUSABLE' });
  });

  it('resumes to warming while the warmup is not done, to active once it is', async () => {
    await seedMailbox(db, { id: 'rmbx_young', domainId: 'rdom_1', status: 'paused', warmupDay: 6 });
    await seedMailbox(db, { id: 'rmbx_old', domainId: 'rdom_1', status: 'paused', warmupDay: 14, pausedReason: 'user' });

    expect(await resumeMailbox(db, 'rmbx_young', NOW)).toMatchObject({ status: 'warming', pausedReason: null });
    expect(await resumeMailbox(db, 'rmbx_old', NOW)).toMatchObject({ status: 'active', pausedReason: null });
  });

  it('cannot resume a mailbox that Mailpool suspended, or one whose domain is not active', async () => {
    await seedMailbox(db, { id: 'rmbx_s', domainId: 'rdom_1', status: 'suspended' });
    await expect(resumeMailbox(db, 'rmbx_s', NOW)).rejects.toMatchObject({ status: 409, code: 'MAILBOX_NOT_RESUMABLE' });

    await seedMailbox(db, { id: 'rmbx_p', domainId: 'rdom_1', status: 'paused' });
    await db.update(schema.reachDomains).set({ status: 'error' }).where(eq(schema.reachDomains.id, 'rdom_1'));
    await expect(resumeMailbox(db, 'rmbx_p', NOW)).rejects.toMatchObject({ status: 409, code: 'DOMAIN_NOT_ACTIVE' });
  });
});

describe('deleteMailbox', () => {
  async function seedLive() {
    const { deps, mailpool, billing } = setup();
    const row = await createMailbox(deps, input(), options);
    mailpool.deleteMailbox.mockClear();
    billing.adjustInboxes.mockClear();
    return { deps, mailpool, billing, row };
  }

  it('deletes at Mailpool, releases the inbox, closes the routes and wipes the logins', async () => {
    const { deps, mailpool, billing, row } = await seedLive();

    const deleted = await deleteMailbox(deps, row.id);

    expect(mailpool.deleteMailbox).toHaveBeenCalledExactlyOnceWith(row.mailpoolMailboxId);
    expect(billing.adjustInboxes).toHaveBeenCalledExactlyOnceWith(-1, row.id);
    expect(deleted).toMatchObject({ status: 'deleted', smtpCredentials: null, imapCredentials: null });
    expect(deleted.deletedAt).toEqual(NOW);

    const routes = await routeRows();
    expect(routes).toHaveLength(2);
    expect(routes.every((r) => r.status === 'deleted')).toBe(true);

    expect(await getMailboxDto(db, row.id)).toBeNull();
    expect(await listMailboxes(db)).toHaveLength(0);
  });

  it('takes the mailbox out of campaigns and frees its in-flight enrollments', async () => {
    const { deps, row } = await seedLive();
    await db.insert(schema.reachCampaignMailboxes).values([
      { id: 'rcmb_1', campaignId: 'rcmp_1', mailboxId: row.id },
      { id: 'rcmb_2', campaignId: 'rcmp_1', mailboxId: 'rmbx_other' },
    ]);
    const enrollment = (id: string, status: 'queued' | 'active' | 'paused' | 'completed' | 'replied', mailboxId: string) => ({
      id,
      campaignId: 'rcmp_1',
      prospectId: `rpro_${id}`,
      mailboxId,
      status,
    });
    await db.insert(schema.reachEnrollments).values([
      enrollment('renr_q', 'queued', row.id),
      enrollment('renr_a', 'active', row.id),
      enrollment('renr_p', 'paused', row.id),
      enrollment('renr_c', 'completed', row.id),
      enrollment('renr_r', 'replied', row.id),
      enrollment('renr_o', 'active', 'rmbx_other'),
    ]);

    await deleteMailbox(deps, row.id);

    const members = await db.select().from(schema.reachCampaignMailboxes);
    expect(members.map((m) => m.mailboxId)).toEqual(['rmbx_other']);
    const byId = new Map((await db.select().from(schema.reachEnrollments)).map((e) => [e.id, e.mailboxId]));
    expect(byId.get('renr_q')).toBeNull();
    expect(byId.get('renr_a')).toBeNull();
    expect(byId.get('renr_p')).toBeNull();
    // Finished conversations keep their sender for the history; other mailboxes are untouched.
    expect(byId.get('renr_c')).toBe(row.id);
    expect(byId.get('renr_r')).toBe(row.id);
    expect(byId.get('renr_o')).toBe('rmbx_other');
  });

  it('takes the mailbox out of Mailpool warmup first', async () => {
    const { deps, mailpool, row } = await seedLive();
    const inbox = warmupInbox(Number(row.mailpoolMailboxId), { email: row.email });
    mailpool.listWarmup.mockResolvedValueOnce({ data: [inbox], total: 1 });

    await deleteMailbox(deps, row.id);
    expect(mailpool.removeFromWarmup).toHaveBeenCalledExactlyOnceWith(inbox.id);
    expect(mailpool.removeFromWarmup.mock.invocationCallOrder[0]!).toBeLessThan(mailpool.deleteMailbox.mock.invocationCallOrder[0]!);
  });

  it('treats a mailbox Mailpool no longer knows as already deleted', async () => {
    const { deps, mailpool, billing, row } = await seedLive();
    mailpool.deleteMailbox.mockRejectedValueOnce(new MailpoolError({ method: 'DELETE', path: '/mailboxes/1', status: 404 }));

    const deleted = await deleteMailbox(deps, row.id);
    expect(deleted.status).toBe('deleted');
    expect(billing.adjustInboxes).toHaveBeenCalledWith(-1, row.id);
  });

  it('keeps the mailbox and the billing when Mailpool fails', async () => {
    const { deps, mailpool, billing, row } = await seedLive();
    mailpool.deleteMailbox.mockRejectedValueOnce(new MailpoolError({ method: 'DELETE', path: '/mailboxes/1', status: 502 }));

    await expect(deleteMailbox(deps, row.id)).rejects.toBeInstanceOf(MailpoolError);

    const [stored] = await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, row.id));
    expect(stored?.status).toBe('warming'); // back to what it was
    expect(stored?.smtpCredentials).not.toBeNull();
    expect(billing.adjustInboxes).not.toHaveBeenCalled();
    expect((await routeRows()).every((r) => r.status === 'active')).toBe(true);
  });

  it('gives the inbox back last, after the mailbox is already gone from our side', async () => {
    const { deps, billing, row } = await seedLive();
    let statusWhenBilled: string | undefined;
    billing.adjustInboxes.mockImplementationOnce(async () => {
      const [current] = await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, row.id));
      statusWhenBilled = current?.status;
      return { quantity: 0 };
    });

    await deleteMailbox(deps, row.id);
    expect(statusWhenBilled).toBe('deleted');
  });

  it('can be run again after it stopped half way, and still takes the inbox off Stripe exactly once', async () => {
    const { deps, mailpool, billing, row } = await seedLive();
    const failing = new Proxy(master, {
      get(target, prop, receiver) {
        if (prop === 'update') return () => { throw new Error('master down'); };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    await expect(deleteMailbox({ ...deps, master: failing }, row.id)).rejects.toThrow('master down');
    const [stuck] = await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, row.id));
    expect(stuck?.status).toBe('deleting');
    expect(billing.adjustInboxes).not.toHaveBeenCalled();

    // Second try: Mailpool no longer knows it (the first try deleted it), which counts as done.
    mailpool.deleteMailbox.mockRejectedValueOnce(new MailpoolError({ method: 'DELETE', path: '/mailboxes/1', status: 404 }));
    const deleted = await deleteMailbox(deps, row.id);

    expect(deleted.status).toBe('deleted');
    expect(billing.adjustInboxes).toHaveBeenCalledExactlyOnceWith(-1, row.id);
    expect((await routeRows()).every((r) => r.status === 'deleted')).toBe(true);
  });

  it('is a 404 the second time', async () => {
    const { deps, row } = await seedLive();
    await deleteMailbox(deps, row.id);
    await expect(deleteMailbox(deps, row.id)).rejects.toMatchObject({ status: 404 });
  });
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

    const all = await listMailboxes(db, {}, NOW);
    expect(all.map((m) => m.id)).toEqual(['rmbx_1', 'rmbx_2']);
    expect(all[0]).toMatchObject({ domainName: 'getacme.com', sentToday: 2, status: 'active' });
    expect(all[1]).toMatchObject({ domainName: 'tryacme.com', sentToday: 0 });
    expect(JSON.stringify(all)).not.toMatch(/smtp|imap|inboundToken/i);

    expect((await listMailboxes(db, { domainId: 'rdom_2' }, NOW)).map((m) => m.id)).toEqual(['rmbx_2']);
    expect((await listMailboxes(db, { status: 'warming' }, NOW)).map((m) => m.id)).toEqual(['rmbx_2']);
    expect((await listMailboxes(db, { status: 'deleted' }, NOW)).map((m) => m.id)).toEqual(['rmbx_3']);
  });
});

