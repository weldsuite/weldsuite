/**
 * Mailpool webhooks: signature verification, payload parsing and the effect of
 * each event on the tenant rows and on the mailbox's row in the warmup pool
 * (pglite tenant + master, fake Mailpool).
 */

import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { openWarmupCredentials } from '@weldsuite/reach-domain/warmup-pool';
import { openMailServerCredentials } from '@weldsuite/reach-domain/credentials';
import { createFakeMailpool, mailpoolMailbox } from '../lib/mailpool/testing';
import {
  WARMUP_TEST_KEY,
  resetReachMaster,
  resetReachTenant,
  seedMailbox,
  seedPoolMailbox,
  seedReachDomain,
} from '../lib/mailpool/testing-db';
import {
  handleMailpoolWebhook,
  parseMailpoolWebhook,
  verifyMailpoolSignature,
  type WebhookDeps,
} from './mailpool-webhooks';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEventRaw: vi.fn(async () => {}) };
});
import { publishEntityEventRaw } from '@weldsuite/entity-events';

const published = publishEntityEventRaw as unknown as ReturnType<typeof vi.fn>;
const ENCRYPTION_KEY = 'ef'.repeat(32);
const NOW = new Date('2026-10-12T12:00:00Z');

let db: Database;
let master: MasterDatabase;

const sign = (secret: string, payload: unknown) => createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  published.mockClear();
  await resetReachTenant(db);
  await resetReachMaster(master);
  await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_1', name: 'getacme.com', mailpoolDomainId: '5001' });
  await master.insert(masterSchema.reachRoutes).values({
    id: 'rrt_dom',
    kind: 'mailpool_domain',
    externalId: '5001',
    workspaceId: 'ws_acme',
    clerkOrgId: 'org_acme',
    tenantEntityId: 'rdom_1',
    status: 'active',
  });
});

/** A mailbox row plus its master route (what mailbox create leaves behind). */
async function liveMailbox(overrides: Record<string, unknown> = {}) {
  const row = await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', mailpoolMailboxId: '341', status: 'warming', ...overrides });
  await master.insert(masterSchema.reachRoutes).values({
    id: `rrt_${row.id}`,
    kind: 'mailpool_mailbox',
    externalId: row.mailpoolMailboxId!,
    workspaceId: 'ws_acme',
    clerkOrgId: 'org_acme',
    tenantEntityId: row.id,
    mailboxType: 'google',
    status: 'active',
  });
  return row;
}
const pool = async (id = 'rmbx_1') =>
  (await master.select().from(masterSchema.reachWarmupMailboxes).where(eq(masterSchema.reachWarmupMailboxes.tenantMailboxId, id)))[0];
const mailbox = async (id = 'rmbx_1') => (await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, id)))[0]!;
const domain = async () => (await db.select().from(schema.reachDomains).where(eq(schema.reachDomains.id, 'rdom_1')))[0]!;

function deps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    env: { DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY, WELDREACH_WARMUP_KEY: WARMUP_TEST_KEY },
    master,
    openTenant: async () => db,
    mailpool: createFakeMailpool(),
    now: () => NOW,
    ...overrides,
  };
}

const event = (name: string, data: Record<string, unknown>) => ({ event: name, data });

describe('verifyMailpoolSignature', () => {
  const secret = 'whsec_test_secret';
  const payload = { event: 'mailboxes.updated', data: { id: 341, status: 'inactive' } };

  it('accepts the HMAC-SHA256 of JSON.stringify(payload)', async () => {
    expect(await verifyMailpoolSignature(secret, sign(secret, payload), payload)).toBe(true);
    expect(await verifyMailpoolSignature(secret, sign(secret, payload).toUpperCase(), payload)).toBe(true);
    expect(await verifyMailpoolSignature(secret, `sha256=${sign(secret, payload)}`, payload)).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const signature = sign(secret, payload);
    expect(await verifyMailpoolSignature(secret, signature, { ...payload, data: { id: 341, status: 'active' } })).toBe(false);
    expect(await verifyMailpoolSignature(secret, signature, { ...payload, extra: true })).toBe(false);
  });

  it('rejects a signature made with another secret', async () => {
    expect(await verifyMailpoolSignature(secret, sign('other_secret', payload), payload)).toBe(false);
  });

  it('rejects missing, malformed, truncated and empty signatures', async () => {
    const good = sign(secret, payload);
    for (const bad of [undefined, null, '', 'not-hex', good.slice(0, -2), `${good}00`, 'zz'.repeat(32)]) {
      expect(await verifyMailpoolSignature(secret, bad, payload), String(bad)).toBe(false);
    }
  });

  it('refuses everything without a secret', async () => {
    expect(await verifyMailpoolSignature('', sign('', payload), payload)).toBe(false);
  });
});

describe('parseMailpoolWebhook', () => {
  it('reads the event and its object from the usual envelopes', () => {
    expect(parseMailpoolWebhook({ event: 'mailboxes.updated', data: { id: 1 } })).toEqual({ event: 'mailboxes.updated', data: { id: 1 } });
    expect(parseMailpoolWebhook({ type: 'domains.updated', payload: { id: 2 } })).toEqual({ event: 'domains.updated', data: { id: 2 } });
    expect(parseMailpoolWebhook({ event: 'mailboxes.deleted', id: 3, status: 'inactive' })).toEqual({
      event: 'mailboxes.deleted',
      data: { event: 'mailboxes.deleted', id: 3, status: 'inactive' },
    });
  });

  it('ignores bodies that are not an event', () => {
    expect(parseMailpoolWebhook(null)).toBeNull();
    expect(parseMailpoolWebhook([])).toBeNull();
    expect(parseMailpoolWebhook({ data: { id: 1 } })).toBeNull();
    expect(parseMailpoolWebhook({ event: '' })).toBeNull();
  });
});

describe('mailbox events', () => {
  it('marks a mailbox Mailpool disabled for spam as suspended, with the reason, pauses it in the warmup pool, and publishes it', async () => {
    await liveMailbox();
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_1', status: 'warming' });
    const outcome = await handleMailpoolWebhook(
      deps(),
      event('mailboxes.updated', { id: 341, status: 'inactive', error: { code: 401, message: 'Account disabled for sending spam.' } }),
    );

    expect(outcome).toEqual({ handled: true, changed: true });
    expect(await mailbox()).toMatchObject({
      status: 'suspended',
      pausedReason: 'Account disabled for sending spam.',
      lastError: 'Account disabled for sending spam.',
    });
    expect(await pool()).toMatchObject({ status: 'paused', pausedReason: 'mailbox_suspended' });
    expect(published).toHaveBeenCalledOnce();
    expect(published.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'org_acme',
      entityType: 'reach_mailbox',
      action: 'suspended',
      entityId: 'rmbx_1',
    });
    expect(JSON.stringify(published.mock.calls[0]![0])).not.toMatch(/smtpCredentials|imapCredentials/);
  });

  it('maps account-configuration errors to error rather than suspended, and the pool pauses too', async () => {
    await liveMailbox();
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_1', status: 'maintaining' });
    await handleMailpoolWebhook(deps(), event('mailboxes.updated', { id: '341', status: 'inactive', error: { code: 202, message: 'Admin password changed.' } }));
    expect(await mailbox()).toMatchObject({ status: 'error', lastError: 'Admin password changed.', pausedReason: null });
    expect(await pool()).toMatchObject({ status: 'paused', pausedReason: 'mailbox_suspended' });
  });

  it('pauses the pool before it touches the tenant, so a failed delivery is retried whole', async () => {
    await liveMailbox();
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_1', status: 'warming' });
    const failing = new Proxy(master, {
      get(target, prop, receiver) {
        if (prop === 'update') return () => { throw new Error('master down'); };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    await expect(
      handleMailpoolWebhook(deps({ master: failing }), event('mailboxes.updated', { id: 341, status: 'inactive', error: { code: 401, message: 'Spam.' } })),
    ).rejects.toThrow('master down');
    expect((await mailbox()).status).toBe('warming');

    // Mailpool retries the delivery, and now everything lands.
    await handleMailpoolWebhook(deps(), event('mailboxes.updated', { id: 341, status: 'inactive', error: { code: 401, message: 'Spam.' } }));
    expect((await mailbox()).status).toBe('suspended');
    expect((await pool())?.status).toBe('paused');
  });

  it('suspends an inactive mailbox that has no error details', async () => {
    await liveMailbox({ status: 'active' });
    await handleMailpoolWebhook(deps(), event('mailboxes.updated', { id: 341, status: 'inactive' }));
    expect(await mailbox()).toMatchObject({ status: 'suspended' });
  });

  it('is idempotent: the same news twice changes nothing the second time', async () => {
    await liveMailbox();
    const message = event('mailboxes.updated', { id: 341, status: 'inactive', error: { code: 401, message: 'Spam.' } });
    await handleMailpoolWebhook(deps(), message);
    published.mockClear();

    expect(await handleMailpoolWebhook(deps(), message)).toEqual({ handled: true, changed: false });
    expect(published).not.toHaveBeenCalled();
  });

  it('restores a suspended mailbox when Mailpool reports it active again (warming or active by the health gate), and resumes it in the pool', async () => {
    await liveMailbox({ status: 'suspended', pausedReason: 'Spam.', lastError: 'Spam.', warmupDay: 20, warmupInboxRate: 0.9 });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_1', status: 'paused', pausedReason: 'mailbox_suspended', startedAt: new Date('2026-09-01T00:00:00Z'), rampDay: 20 });
    await handleMailpoolWebhook(deps(), event('mailboxes.updated', { id: 341, status: 'active' }));
    expect(await mailbox()).toMatchObject({ status: 'active', pausedReason: null, lastError: null });
    expect(await pool()).toMatchObject({ status: 'maintaining', pausedReason: null });

    await db.update(schema.reachMailboxes).set({ status: 'error', warmupDay: 4 }).where(eq(schema.reachMailboxes.id, 'rmbx_1'));
    await handleMailpoolWebhook(deps(), event('mailboxes.updated', { id: 341, status: 'active' }));
    expect((await mailbox()).status).toBe('warming');
  });

  it('leaves a mailbox the warmup network took out of use (failed login) to the daily pass', async () => {
    await liveMailbox({ status: 'error', pausedReason: 'login_failed', lastError: 'The warmup network could not sign in to this mailbox.' });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_1', status: 'error', pausedReason: 'login_failed', lastLoginError: 'bad' });

    const outcome = await handleMailpoolWebhook(deps(), event('mailboxes.updated', { id: 341, status: 'active' }));

    expect(outcome).toEqual({ handled: true, changed: false });
    expect(await mailbox()).toMatchObject({ status: 'error', pausedReason: 'login_failed' });
    expect((await pool())?.status).toBe('error');
    expect(published).not.toHaveBeenCalled();
  });

  it('does not override a mailbox the user paused', async () => {
    await liveMailbox({ status: 'paused', pausedReason: 'user' });
    const outcome = await handleMailpoolWebhook(deps(), event('mailboxes.updated', { id: 341, status: 'active' }));
    expect(outcome).toEqual({ handled: true, changed: false });
    expect((await mailbox()).status).toBe('paused');
  });

  it('starts warming a mailbox that finished provisioning: stores its logins and enters the warmup pool', async () => {
    await liveMailbox({ status: 'provisioning', smtpCredentials: null, email: 'jane@getacme.com' });
    const remote = mailpoolMailbox({ email: 'jane@getacme.com', firstName: 'Jane', lastName: 'Doe', type: 'google' }, { id: '341' });

    await handleMailpoolWebhook(deps(), event('mailboxes.updated', remote as unknown as Record<string, unknown>));

    const row = await mailbox();
    expect(row).toMatchObject({ status: 'warming', warmupStatus: 'waiting' });
    expect(row.warmupStartedAt).toEqual(NOW);
    expect(await openMailServerCredentials({ DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY }, row.smtpCredentials)).toMatchObject({ password: 'smtp-secret-password' });

    const registered = (await pool())!;
    expect(registered).toMatchObject({
      status: 'waiting',
      workspaceId: 'ws_acme',
      clerkOrgId: 'org_acme',
      email: 'jane@getacme.com',
      domain: 'getacme.com',
      mailboxType: 'google',
    });
    expect(await openWarmupCredentials({ WELDREACH_WARMUP_KEY: WARMUP_TEST_KEY }, registered.imapCredentials)).toMatchObject({ host: 'imap.mailpool.test', password: 'imap-secret-password' });
    expect(published.mock.calls[0]![0]).toMatchObject({ action: 'updated' });
  });

  it('reads the logins from Mailpool when the payload leaves them out', async () => {
    await liveMailbox({ status: 'provisioning', smtpCredentials: null, email: 'jane@getacme.com' });
    const mailpool = createFakeMailpool();
    mailpool.getMailbox.mockResolvedValueOnce(mailpoolMailbox({ email: 'jane@getacme.com', firstName: 'Jane', lastName: 'Doe', type: 'google' }, { id: '341' }));

    await handleMailpoolWebhook(deps({ mailpool }), event('mailboxes.updated', { id: 341, status: 'active' }));

    expect(mailpool.getMailbox).toHaveBeenCalledWith(341);
    expect((await mailbox()).status).toBe('warming');
    expect((await pool())?.status).toBe('waiting');
  });

  it('keeps a mailbox in provisioning while no logins are available (payload without them, Mailpool cannot be asked), and says nothing', async () => {
    await liveMailbox({ status: 'provisioning', smtpCredentials: null });

    const outcome = await handleMailpoolWebhook(deps({ mailpool: null }), event('mailboxes.updated', { id: 341, status: 'active' }));

    expect(outcome).toEqual({ handled: true, changed: false });
    expect((await mailbox()).status).toBe('provisioning');
    expect(await pool()).toBeUndefined();
    expect(published).not.toHaveBeenCalled();
  });

  it('answers with an error, leaving the mailbox provisioning, when the warmup pool cannot be written (Mailpool retries)', async () => {
    await liveMailbox({ status: 'provisioning', smtpCredentials: null, email: 'jane@getacme.com' });
    const remote = mailpoolMailbox({ email: 'jane@getacme.com', firstName: 'Jane', lastName: 'Doe', type: 'google' }, { id: '341' });

    await expect(
      handleMailpoolWebhook(deps({ env: { DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY } }), event('mailboxes.updated', remote as unknown as Record<string, unknown>)),
    ).rejects.toThrow('WELDREACH_WARMUP_KEY');
    expect((await mailbox()).status).toBe('provisioning');
  });

  it('fills logins that were not ready at create time, in the pool too', async () => {
    await liveMailbox({ status: 'warming', smtpCredentials: null });
    const remote = mailpoolMailbox({ email: 'jane@getacme.com', firstName: 'Jane', lastName: 'Doe', type: 'google' }, { id: '341' });

    const outcome = await handleMailpoolWebhook(deps(), event('mailboxes.updated', remote as unknown as Record<string, unknown>));

    expect(outcome).toEqual({ handled: true, changed: true });
    expect((await mailbox()).smtpCredentials).not.toBeNull();
    expect((await mailbox()).status).toBe('warming');
    expect(await openWarmupCredentials({ WELDREACH_WARMUP_KEY: WARMUP_TEST_KEY }, (await pool())!.smtpCredentials)).toMatchObject({ password: 'smtp-secret-password' });
  });

  it('marks a mailbox deleted at Mailpool behind our back as error and pauses it in the pool (it is removed, and un-billed, through the normal delete)', async () => {
    await liveMailbox({ status: 'active' });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_1', status: 'maintaining' });
    const outcome = await handleMailpoolWebhook(deps(), event('mailboxes.deleted', { id: 341 }));

    expect(outcome).toEqual({ handled: true, changed: true });
    expect(await pool()).toMatchObject({ status: 'paused', pausedReason: 'mailbox_suspended' });
    expect(await mailbox()).toMatchObject({ status: 'error' });
    expect((await mailbox()).lastError).toContain('deleted at the mailbox provider');
    expect(published.mock.calls[0]![0]).toMatchObject({ action: 'suspended' });
  });

  it('ignores the echo of our own delete', async () => {
    await liveMailbox({ status: 'deleting' });
    expect(await handleMailpoolWebhook(deps(), event('mailboxes.deleted', { id: 341 }))).toEqual({ handled: false, reason: 'mailbox_gone' });
    await db.update(schema.reachMailboxes).set({ status: 'deleted' }).where(eq(schema.reachMailboxes.id, 'rmbx_1'));
    expect(await handleMailpoolWebhook(deps(), event('mailboxes.updated', { id: 341, status: 'inactive' }))).toEqual({ handled: false, reason: 'mailbox_gone' });
    expect((await mailbox()).status).toBe('deleted');
  });

  it('ignores ids it does not know, closed routes, payloads without an id, and events it does not use', async () => {
    await liveMailbox();
    expect(await handleMailpoolWebhook(deps(), event('mailboxes.updated', { id: 999, status: 'inactive' }))).toEqual({ handled: false, reason: 'unknown_id' });
    expect(await handleMailpoolWebhook(deps(), event('mailboxes.updated', { status: 'inactive' }))).toEqual({ handled: false, reason: 'no_id' });
    expect(await handleMailpoolWebhook(deps(), event('spam-checks.updated', { id: 341 }))).toEqual({ handled: false, reason: 'event_not_used' });
    expect(await handleMailpoolWebhook(deps(), event('inbox-placements.created', { id: 341 }))).toEqual({ handled: false, reason: 'event_not_used' });

    await master.update(masterSchema.reachRoutes).set({ status: 'deleted' }).where(eq(masterSchema.reachRoutes.id, 'rrt_rmbx_1'));
    expect(await handleMailpoolWebhook(deps(), event('mailboxes.updated', { id: 341, status: 'inactive' }))).toEqual({ handled: false, reason: 'unknown_id' });
    expect((await mailbox()).status).toBe('warming');
  });

  it('routes by the workspace the id belongs to (opens that tenant only)', async () => {
    await liveMailbox();
    const openTenant = vi.fn(async () => db);
    await handleMailpoolWebhook(deps({ openTenant }), event('mailboxes.updated', { id: 341, status: 'inactive' }));
    expect(openTenant).toHaveBeenCalledExactlyOnceWith('org_acme');
  });
});

describe('domain events', () => {
  it('records a disabled domain as error and parks its running mailboxes, in the pool too', async () => {
    await seedMailbox(db, { id: 'rmbx_a', domainId: 'rdom_1', status: 'active' });
    await seedMailbox(db, { id: 'rmbx_w', domainId: 'rdom_1', status: 'warming' });
    await seedMailbox(db, { id: 'rmbx_u', domainId: 'rdom_1', status: 'paused', pausedReason: 'user' });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_a', status: 'maintaining' });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_w', status: 'warming' });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_u', status: 'paused', pausedReason: 'paused_by_user' });

    const outcome = await handleMailpoolWebhook(
      deps(),
      event('domains.updated', { id: 5001, status: 'inactive', error: { code: 102, message: 'Disabled due to spam abuse.' } }),
    );

    expect(outcome).toEqual({ handled: true, changed: true });
    expect(await domain()).toMatchObject({ status: 'error', lastError: 'Disabled due to spam abuse.' });
    expect(await mailbox('rmbx_a')).toMatchObject({ status: 'paused', pausedReason: 'domain_error' });
    expect(await mailbox('rmbx_w')).toMatchObject({ status: 'paused', pausedReason: 'domain_error' });
    expect(await mailbox('rmbx_u')).toMatchObject({ status: 'paused', pausedReason: 'user' });
    expect(await pool('rmbx_a')).toMatchObject({ status: 'paused', pausedReason: 'domain_error' });
    expect(await pool('rmbx_w')).toMatchObject({ status: 'paused', pausedReason: 'domain_error' });
    expect(await pool('rmbx_u')).toMatchObject({ status: 'paused', pausedReason: 'paused_by_user' });
    const actions = published.mock.calls.map((c) => `${(c[0] as { entityType: string }).entityType}:${(c[0] as { action: string }).action}`);
    expect(actions).toEqual(['reach_domain:updated', 'reach_mailbox:updated', 'reach_mailbox:updated']);
  });

  it('brings back the mailboxes it parked when the domain is active again', async () => {
    await db.update(schema.reachDomains).set({ status: 'error', lastError: 'Disabled.' }).where(eq(schema.reachDomains.id, 'rdom_1'));
    await seedMailbox(db, { id: 'rmbx_a', domainId: 'rdom_1', status: 'paused', pausedReason: 'domain_error', warmupDay: 30, warmupInboxRate: 0.9 });
    await seedMailbox(db, { id: 'rmbx_u', domainId: 'rdom_1', status: 'paused', pausedReason: 'user' });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_a', status: 'paused', pausedReason: 'domain_error', startedAt: new Date('2026-09-01T00:00:00Z'), rampDay: 30 });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_u', status: 'paused', pausedReason: 'paused_by_user' });

    await handleMailpoolWebhook(deps(), event('domains.updated', { id: '5001', status: 'active' }));

    expect(await domain()).toMatchObject({ status: 'active', lastError: null });
    expect(await mailbox('rmbx_a')).toMatchObject({ status: 'active', pausedReason: null });
    expect(await pool('rmbx_a')).toMatchObject({ status: 'maintaining', pausedReason: null });
    expect((await mailbox('rmbx_u')).status).toBe('paused');
    expect(await pool('rmbx_u')).toMatchObject({ status: 'paused', pausedReason: 'paused_by_user' });
  });

  it('moves a connecting domain to active, and is a no-op when nothing changed', async () => {
    await db.update(schema.reachDomains).set({ status: 'connecting' }).where(eq(schema.reachDomains.id, 'rdom_1'));
    expect(await handleMailpoolWebhook(deps(), event('domains.registered', { id: 5001, status: 'active' }))).toEqual({ handled: true, changed: true });
    expect((await domain()).status).toBe('active');
    expect(await handleMailpoolWebhook(deps(), event('domains.updated', { id: 5001, status: 'active' }))).toEqual({ handled: true, changed: false });
  });

  it('leaves a domain that is being disconnected alone', async () => {
    await db.update(schema.reachDomains).set({ status: 'disconnecting' }).where(eq(schema.reachDomains.id, 'rdom_1'));
    expect(await handleMailpoolWebhook(deps(), event('domains.updated', { id: 5001, status: 'inactive' }))).toEqual({ handled: false, reason: 'domain_gone' });
    expect((await domain()).status).toBe('disconnecting');
  });

  it('ignores a domain id it has no route for', async () => {
    expect(await handleMailpoolWebhook(deps(), event('domains.updated', { id: 424242, status: 'inactive' }))).toEqual({ handled: false, reason: 'unknown_id' });
  });
});
