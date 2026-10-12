/**
 * /api/reach/mailboxes over HTTP: permissions, the response shape (never the
 * logins), entity events, and the error mapping (402 without a payment method,
 * 502 for Mailpool, rollback).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { PaymentMethodRequiredError } from '../../lib/billing';
import { MailpoolError, MailpoolNotConfiguredError } from '../../lib/mailpool/errors';
import { createFakeBilling, createFakeMailpool, type FakeBilling, type FakeMailpool } from '../../lib/mailpool/testing';
import { resetReachMaster, resetReachTenant, seedMailbox, seedReachDomain } from '../../lib/mailpool/testing-db';
import { approvedAccess, withAppAccess } from '../../lib/mailpool/testing-routes';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});
import { publishEntityEvent } from '@weldsuite/entity-events';
const published = publishEntityEvent as unknown as ReturnType<typeof vi.fn>;

let masterDb: MasterDatabase;
vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  return { ...actual, getMasterDb: () => masterDb };
});

let mailpool: FakeMailpool;
let billing: FakeBilling;
let mailpoolFactory: () => FakeMailpool;
vi.mock('../../lib/mailpool/client', async () => {
  const actual = await vi.importActual<typeof import('../../lib/mailpool/client')>('../../lib/mailpool/client');
  return { ...actual, createMailpoolClient: () => mailpoolFactory() };
});
vi.mock('../../lib/billing', async () => {
  const actual = await vi.importActual<typeof import('../../lib/billing')>('../../lib/billing');
  return { ...actual, createReachBilling: () => billing };
});

// Imported AFTER the mocks above are registered.
const { default: mailboxRoutes } = await import('./index');

let db: Database;

const ALL = ['reach_mailboxes:read', 'reach_mailboxes:create', 'reach_mailboxes:update', 'reach_mailboxes:delete'];

function api(keys: string[] = ALL, access = approvedAccess()) {
  return createTestApp('/api/reach/mailboxes', withAppAccess(mailboxRoutes, access), {
    context: { permissions: permissions(...keys), tenantDb: db, workspaceId: 'org_acme' },
    env: { REACH_INBOUND_DOMAIN: 'reply-test.weldreach.com', DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32) } as never,
  }).request;
}
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const createBody = { domainId: 'rdom_1', localPart: 'Jane', firstName: 'Jane', lastName: 'Doe', type: 'google' };

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  published.mockClear();
  mailpool = createFakeMailpool();
  billing = createFakeBilling();
  mailpoolFactory = () => mailpool;
  await resetReachTenant(db);
  await resetReachMaster(masterDb);
  await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_1', name: 'getacme.com', mailpoolDomainId: '5001' });
});

describe('permissions', () => {
  it.each([
    ['GET /', 'GET', '', undefined, 'reach_mailboxes:read'],
    ['GET /:id', 'GET', '/rmbx_1', undefined, 'reach_mailboxes:read'],
    ['POST /', 'POST', '', createBody, 'reach_mailboxes:create'],
    ['PATCH /:id', 'PATCH', '/rmbx_1', { firstName: 'X' }, 'reach_mailboxes:update'],
    ['POST /:id/pause', 'POST', '/rmbx_1/pause', {}, 'reach_mailboxes:update'],
    ['POST /:id/resume', 'POST', '/rmbx_1/resume', {}, 'reach_mailboxes:update'],
    ['DELETE /:id', 'DELETE', '/rmbx_1', undefined, 'reach_mailboxes:delete'],
  ])('%s needs %s', async (_label, method, path, body, needed) => {
    const others = ALL.filter((k) => k !== needed);
    const res = await api(others)(`/api/reach/mailboxes${path}`, json(method, body));
    expect(res.status).toBe(403);
    expect(mailpool.createMailbox).not.toHaveBeenCalled();
    expect(billing.adjustInboxes).not.toHaveBeenCalled();
  });
});

describe('POST /', () => {
  it('creates the mailbox: 201, no logins in the response, an event without them', async () => {
    const res = await api()('/api/reach/mailboxes', json('POST', createBody));

    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toMatch(/secret|smtp|imap|inboundToken|forwardTo/i);
    const { data } = JSON.parse(text) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      id: expect.stringMatching(/^rmbx_/),
      domainId: 'rdom_1',
      domainName: 'getacme.com',
      email: 'jane@getacme.com',
      type: 'google',
      status: 'warming',
      dailyCap: 30,
      rampCurrent: 10,
      sentToday: 0,
    });

    expect(published).toHaveBeenCalledOnce();
    const event = published.mock.calls[0]![0] as { entityType: string; action: string; entityId: string; data: Record<string, unknown> };
    expect(event).toMatchObject({ entityType: 'reach_mailbox', action: 'created', entityId: data.id });
    expect(event.data).not.toHaveProperty('smtpCredentials');
    expect(event.data).not.toHaveProperty('imapCredentials');
    expect(event.data.email).toBe('jane@getacme.com');
  });

  it('uses the default daily cap from the workspace settings', async () => {
    await db.insert(schema.reachSettings).values({ id: 'rset_default', defaultMailboxDailyCap: 20 });
    const res = await api()('/api/reach/mailboxes', json('POST', createBody));
    expect(((await res.json()) as { data: { dailyCap: number } }).data.dailyCap).toBe(20);
  });

  it('answers 402 PAYMENT_METHOD_REQUIRED without calling Mailpool or publishing', async () => {
    billing.adjustInboxes.mockRejectedValueOnce(new PaymentMethodRequiredError());
    const res = await api()('/api/reach/mailboxes', json('POST', createBody));

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: 'PAYMENT_METHOD_REQUIRED' } });
    expect(mailpool.createMailbox).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
  });

  it('answers 403 once the staff-set mailbox limit is reached', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1' });
    const res = await api(ALL, approvedAccess({ limits: { maxMailboxes: 1 } }))('/api/reach/mailboxes', json('POST', createBody));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'MAILBOX_LIMIT_REACHED', details: { limit: 1, current: 1 } } });
  });

  it('maps a Mailpool failure to 502, rolls billing back and publishes nothing', async () => {
    mailpool.createMailbox.mockRejectedValueOnce(new MailpoolError({ method: 'POST', path: '/mailboxes', status: 422, body: { message: 'internal detail' } }));
    const res = await api()('/api/reach/mailboxes', json('POST', createBody));

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UPSTREAM_ERROR');
    expect(body.error.message).not.toContain('internal detail');
    expect(billing.adjustInboxes.mock.calls.map((c) => c[0])).toEqual([1, -1]);
    expect(published).not.toHaveBeenCalled();
    expect(await db.select().from(schema.reachMailboxes)).toHaveLength(0);
  });

  it('answers 503 when Mailpool is not configured', async () => {
    mailpoolFactory = () => {
      throw new MailpoolNotConfiguredError();
    };
    const res = await api()('/api/reach/mailboxes', json('POST', createBody));
    expect(res.status).toBe(503);
    expect(billing.adjustInboxes).not.toHaveBeenCalled();
  });

  it('answers 404 for a domain that is not in this workspace, and 400 for a bad body', async () => {
    expect((await api()('/api/reach/mailboxes', json('POST', { ...createBody, domainId: 'rdom_other' }))).status).toBe(404);
    expect((await api()('/api/reach/mailboxes', json('POST', { ...createBody, type: 'private' }))).status).toBe(400);
    expect((await api()('/api/reach/mailboxes', json('POST', { ...createBody, localPart: 'no spaces allowed' }))).status).toBe(400);
    expect(billing.adjustInboxes).not.toHaveBeenCalled();
  });

  it('answers 403 when the workspace row cannot be resolved', async () => {
    const res = await api(ALL, approvedAccess({ workspaceId: null }))('/api/reach/mailboxes', json('POST', createBody));
    expect(res.status).toBe(403);
  });
});

describe('reads', () => {
  it('lists mailboxes in the list envelope, filtered by domain and status', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active' });
    await seedMailbox(db, { id: 'rmbx_2', domainId: 'rdom_1', status: 'warming' });
    await seedMailbox(db, { id: 'rmbx_3', domainId: 'rdom_1', status: 'deleted', deletedAt: new Date() });

    const all = (await (await api(['reach_mailboxes:read'])('/api/reach/mailboxes')).json()) as { data: Array<{ id: string }>; pagination: { totalCount: number; hasMore: boolean } };
    expect(all.data.map((m) => m.id)).toEqual(['rmbx_1', 'rmbx_2']);
    expect(all.pagination).toMatchObject({ totalCount: 2, hasMore: false });

    const warming = (await (await api(['reach_mailboxes:read'])('/api/reach/mailboxes?status=warming')).json()) as { data: Array<{ id: string }> };
    expect(warming.data.map((m) => m.id)).toEqual(['rmbx_2']);
    expect((await api(['reach_mailboxes:read'])('/api/reach/mailboxes?status=bogus')).status).toBe(400);
  });

  it('gets one mailbox, and 404s for a deleted or unknown one', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1' });
    await seedMailbox(db, { id: 'rmbx_2', domainId: 'rdom_1', status: 'deleted', deletedAt: new Date() });

    const ok = await api(['reach_mailboxes:read'])('/api/reach/mailboxes/rmbx_1');
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toMatch(/smtp|imap|inboundToken/i);
    expect((await api(['reach_mailboxes:read'])('/api/reach/mailboxes/rmbx_2')).status).toBe(404);
    expect((await api(['reach_mailboxes:read'])('/api/reach/mailboxes/rmbx_none')).status).toBe(404);
  });
});

describe('writes on an existing mailbox', () => {
  beforeEach(async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', mailpoolMailboxId: '341' });
  });

  it('PATCH updates, rejects a daily cap above 50 and publishes reach_mailbox:updated', async () => {
    const ok = await api()('/api/reach/mailboxes/rmbx_1', json('PATCH', { firstName: 'Janet', dailyCap: 40 }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { firstName: string; dailyCap: number } }).data).toMatchObject({ firstName: 'Janet', dailyCap: 40 });
    expect(mailpool.updateMailbox).toHaveBeenCalledWith('341', { firstName: 'Janet' });
    expect(published.mock.calls[0]![0]).toMatchObject({ entityType: 'reach_mailbox', action: 'updated', entityId: 'rmbx_1' });

    expect((await api()('/api/reach/mailboxes/rmbx_1', json('PATCH', { dailyCap: 51 }))).status).toBe(400);
  });

  it('pause then resume, each publishing an update', async () => {
    const paused = await api()('/api/reach/mailboxes/rmbx_1/pause', json('POST', {}));
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { data: { status: string; pausedReason: string } }).data).toMatchObject({ status: 'paused', pausedReason: 'user' });

    const resumed = await api()('/api/reach/mailboxes/rmbx_1/resume', json('POST', {}));
    expect(((await resumed.json()) as { data: { status: string } }).data.status).toBe('warming'); // warmupDay 0

    expect(published.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual(['updated', 'updated']);
  });

  it('resume of a suspended mailbox is a 409', async () => {
    await db.update(schema.reachMailboxes).set({ status: 'suspended' }).where(eq(schema.reachMailboxes.id, 'rmbx_1'));
    const res = await api()('/api/reach/mailboxes/rmbx_1/resume', json('POST', {}));
    expect(res.status).toBe(409);
    expect(published).not.toHaveBeenCalled();
  });

  it('DELETE answers 204, releases the inbox, closes the routes and publishes reach_mailbox:deleted', async () => {
    await masterDb.insert(masterSchema.reachRoutes).values({
      id: 'rrt_1',
      kind: 'mailpool_mailbox',
      externalId: '341',
      workspaceId: 'ws_acme',
      clerkOrgId: 'org_acme',
      tenantEntityId: 'rmbx_1',
      mailboxType: 'google',
      status: 'active',
    });

    const res = await api()('/api/reach/mailboxes/rmbx_1', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(billing.adjustInboxes).toHaveBeenCalledWith(-1, 'rmbx_1');
    expect(mailpool.deleteMailbox).toHaveBeenCalledWith('341');
    const [route] = await masterDb.select().from(masterSchema.reachRoutes).where(eq(masterSchema.reachRoutes.id, 'rrt_1'));
    expect(route?.status).toBe('deleted');
    const event = published.mock.calls[0]![0] as { action: string; entityId: string; data: Record<string, unknown> };
    expect(event).toMatchObject({ action: 'deleted', entityId: 'rmbx_1' });
    expect(event.data).not.toHaveProperty('smtpCredentials');
  });

  it('DELETE leaves the mailbox in place and answers 502 when Mailpool fails', async () => {
    mailpool.deleteMailbox.mockRejectedValueOnce(new MailpoolError({ method: 'DELETE', path: '/mailboxes/341', status: 500 }));
    const res = await api()('/api/reach/mailboxes/rmbx_1', { method: 'DELETE' });

    expect(res.status).toBe(502);
    expect(published).not.toHaveBeenCalled();
    expect(billing.adjustInboxes).not.toHaveBeenCalled();
    const [row] = await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, 'rmbx_1'));
    expect(row?.status).toBe('active');
  });
});
