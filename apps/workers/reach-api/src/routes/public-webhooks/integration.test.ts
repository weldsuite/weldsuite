/**
 * POST /public/reach/webhooks/mailpool: the HMAC gate and what a verified
 * delivery does. Unauthenticated route, so the signature is the only door.
 */

import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { resetReachMaster, resetReachTenant, seedMailbox, seedReachDomain } from '../../lib/mailpool/testing-db';
import type { Env, Variables } from '../../types';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEventRaw: vi.fn(actual.publishEntityEventRaw) };
});

let masterDb: MasterDatabase;
vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  const { conformanceMasterDb } = await vi.importActual<typeof import('@weldsuite/worker-kit/testing/conformance')>(
    '@weldsuite/worker-kit/testing/conformance',
  );
  return { ...actual, getMasterDb: () => conformanceMasterDb(masterDb as never) };
});

let tenantDb: Database;
const openTenantDb = vi.fn(async () => {
  const { conformanceTenantDb } = await vi.importActual<typeof import('@weldsuite/worker-kit/testing/conformance')>(
    '@weldsuite/worker-kit/testing/conformance',
  );
  return conformanceTenantDb(tenantDb);
});
vi.mock('../../lib/tenant', () => ({ openTenantDb: (...args: unknown[]) => (openTenantDb as (...a: unknown[]) => unknown)(...args) }));

// Imported AFTER the mocks above are registered.
const { default: webhookRoutes } = await import('./index');

const SECRET = 'whsec_route_test';
const sign = (secret: string, payload: unknown) => createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');


function post(body: string, headers: Record<string, string> = {}, env: Partial<Env> = { MAILPOOL_WEBHOOK_SECRET: SECRET }) {
  // The harness's app, so conformance mode runs the delivery on both backends.
  return createTestApp<Env, Variables>('/public/reach/webhooks', webhookRoutes, {
    context: { tenantDb, masterDb: masterDb as unknown as Database, workspaceId: 'ws_acme', clerkOrgId: 'org_acme' },
    env: { ENVIRONMENT: 'test', ...env } as never,
  }).request('/public/reach/webhooks/mailpool', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
}

const payload = { event: 'mailboxes.updated', data: { id: 341, status: 'inactive', error: { code: 401, message: 'Account disabled for spam.' } } };

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  openTenantDb.mockClear();
  await resetReachTenant(tenantDb);
  await resetReachMaster(masterDb);
  await seedReachDomain(tenantDb, { id: 'rdom_1', hostDomainId: 'dom_1', name: 'getacme.com' });
  await seedMailbox(tenantDb, { id: 'rmbx_1', domainId: 'rdom_1', mailpoolMailboxId: '341', status: 'warming' });
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
});

const mailboxStatus = async () => (await tenantDb.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, 'rmbx_1')))[0]!.status;

describe('signature gate', () => {
  it('answers 401 for a tampered body and changes nothing', async () => {
    const tampered = { ...payload, data: { ...payload.data, id: 342 } };
    const res = await post(JSON.stringify(tampered), { 'X-Signature': sign(SECRET, payload) });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(openTenantDb).not.toHaveBeenCalled();
    expect(await mailboxStatus()).toBe('warming');
  });

  it('answers 401 for a signature made with another secret', async () => {
    const res = await post(JSON.stringify(payload), { 'X-Signature': sign('wrong_secret', payload) });
    expect(res.status).toBe(401);
    expect(await mailboxStatus()).toBe('warming');
  });

  it('answers 401 without a signature or with a malformed one', async () => {
    expect((await post(JSON.stringify(payload))).status).toBe(401);
    expect((await post(JSON.stringify(payload), { 'X-Signature': 'not-hex' })).status).toBe(401);
    expect(openTenantDb).not.toHaveBeenCalled();
  });

  it('answers 503 when no secret is configured, rather than accepting anything', async () => {
    const res = await post(JSON.stringify(payload), { 'X-Signature': sign('', payload) }, {});
    expect(res.status).toBe(503);
    expect(await mailboxStatus()).toBe('warming');
  });

  it('answers 400 for a body that is not JSON (it cannot be verified)', async () => {
    const res = await post('{not json', { 'X-Signature': 'abcd' });
    expect(res.status).toBe(400);
  });
});

describe('verified deliveries', () => {
  it('verifies against the parsed body, so pretty-printed bodies work', async () => {
    const res = await post(JSON.stringify(payload, null, 2), { 'X-Signature': sign(SECRET, payload) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { handled: true, changed: true } });
    expect(await mailboxStatus()).toBe('suspended');
    expect(openTenantDb).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'org_acme');
  });

  it('acknowledges unknown ids and events with 200 so Mailpool does not retry them', async () => {
    const unknownId = { event: 'mailboxes.updated', data: { id: 999, status: 'inactive' } };
    const res = await post(JSON.stringify(unknownId), { 'X-Signature': sign(SECRET, unknownId) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { handled: false, reason: 'unknown_id' } });

    const otherEvent = { event: 'spam-checks.updated', data: { id: 1 } };
    const res2 = await post(JSON.stringify(otherEvent), { 'X-Signature': sign(SECRET, otherEvent) });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ data: { handled: false, reason: 'event_not_used' } });

    const noEvent = { hello: 'world' };
    const res3 = await post(JSON.stringify(noEvent), { 'X-Signature': sign(SECRET, noEvent) });
    expect(res3.status).toBe(200);
    expect(await mailboxStatus()).toBe('warming');
  });

  // Fails the tenant lookup through a module mock: TypeScript only.
  it.skipIf(conformanceTarget())('answers 5xx when our own database fails, so Mailpool retries', async () => {
    openTenantDb.mockRejectedValueOnce(new Error('neon down'));
    const failing = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(JSON.stringify(payload), { 'X-Signature': sign(SECRET, payload) });
    expect(res.status).toBe(500);
    failing.mockRestore();
  });
});
