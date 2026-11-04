/**
 * /api/workflow-webhooks on pglite: creating a webhook (and a webhook
 * trigger), updating it and rotating its secret, with the master registry
 * on a pglite master database, and the refusals.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

let masterDb: MasterDatabase;
vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  return { ...actual, getMasterDb: () => conformanceMasterDb(masterDb) };
});

const { workflowWebhooksRoutes } = await import('./index');
const { workflowWebhookRegistry } = (await import('@weldsuite/worker-kit/db')).masterSchema;

let db: Database;

const ALL = ['workflow-webhooks:read', 'workflow-webhooks:create', 'workflow-webhooks:update', 'workflow-webhooks:delete'];

function app(granted: string[] = ALL) {
  return createTestApp('/api/workflow-webhooks', workflowWebhooksRoutes, {
    context: { permissions: permissions(...granted), tenantDb: db, masterDb: masterDb as never },
    env: { CONNECT_API_URL: 'https://hooks.example.test' } as never,
  }).request;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  await db.insert(schema.workflows).values({ id: 'wf_h_one', name: 'Hooked', status: 'active' });
}, 60_000);

describe('creating webhooks', () => {
  it('creates a webhook with its secret and registers it', async () => {
    const res = await app()(
      '/api/workflow-webhooks',
      send('POST', { workflowId: 'wf_h_one', description: 'Shop orders', ipWhitelist: ['10.0.0.1'] }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { id: string; name: string; secret: string; webhookUrl: string; externalUrl: string; allowedMethods: string[] };
    };
    expect(data).toMatchObject({ name: 'Webhook', allowedMethods: ['POST'] });
    expect(data.secret).toHaveLength(32);
    expect(data.webhookUrl).toBe(`/api/workflows/webhook/${data.id}`);
    expect(data.externalUrl).toBe(`https://hooks.example.test/api/workflows/webhook/${data.id}`);
    const [registered] = await masterDb.select().from(workflowWebhookRegistry).where(eq(workflowWebhookRegistry.id, data.id));
    expect(registered.deletedAt).toBeNull();
  });

  it('creates a webhook trigger with its webhook', async () => {
    const res = await app()('/api/workflow-webhooks/create-trigger', send('POST', { workflowId: 'wf_h_one' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; category: string; webhookId: string; secret: string } };
    expect(data.category).toBe('webhook');
    expect(data.secret).toHaveLength(32);
    const [hook] = await db.select().from(schema.workflowWebhooks).where(eq(schema.workflowWebhooks.id, data.webhookId));
    expect(hook.triggerId).toBe(data.id);
  });

  it('404s an unknown workflow and validates the body', async () => {
    const request = app();
    expect((await request('/api/workflow-webhooks', send('POST', { workflowId: 'wf_nope' }))).status).toBe(404);
    expect((await request('/api/workflow-webhooks/create-trigger', send('POST', { workflowId: 'wf_nope' }))).status).toBe(404);
    expect((await request('/api/workflow-webhooks', send('POST', { workflowId: 'wf_h_one', name: '' }))).status).toBe(400);
    expect((await request('/api/workflow-webhooks/create-trigger', send('POST', {}))).status).toBe(400);
  });
});

describe('changing webhooks', () => {
  async function seed(id: string) {
    await db.insert(schema.workflowWebhooks).values({
      id,
      workflowId: 'wf_h_one',
      name: 'Seeded',
      url: `/api/workflows/webhook/${id}`,
      secret: 'whsec_seed',
      validateSignature: false,
      isEnabled: true,
    });
  }

  it('updates a webhook without revealing its secret', async () => {
    await seed('wh_h_upd');
    const request = app();
    const patched = await request('/api/workflow-webhooks/wh_h_upd', send('PATCH', { name: 'Renamed', isEnabled: false }));
    expect(patched.status).toBe(200);
    const { data } = (await patched.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ name: 'Renamed', isEnabled: false });
    expect(data).not.toHaveProperty('secret');
    const put = await request('/api/workflow-webhooks/wh_h_upd', send('PUT', { allowedMethods: ['POST', 'PUT'] }));
    expect(put.status).toBe(200);
  });

  it('rotates the secret, optionally turning signing on', async () => {
    await seed('wh_h_rot');
    const request = app();
    const plain = await request('/api/workflow-webhooks/wh_h_rot/rotate-secret', { method: 'PATCH' });
    expect(plain.status).toBe(200);
    const rotated = (await plain.json()) as { data: { secret: string; validateSignature: boolean } };
    expect(rotated.data.secret).not.toBe('whsec_seed');
    expect(rotated.data.validateSignature).toBe(false);
    const signing = await request('/api/workflow-webhooks/wh_h_rot/rotate-secret', send('PATCH', { enableSignature: true }));
    expect(((await signing.json()) as { data: { validateSignature: boolean } }).data.validateSignature).toBe(true);
  });

  it('refuses a malformed rotate body, an unknown webhook, and a caller without permission', async () => {
    await seed('wh_h_bad');
    const request = app();
    const malformed = await request('/api/workflow-webhooks/wh_h_bad/rotate-secret', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(malformed.status).toBe(400);
    expect((await request('/api/workflow-webhooks/wh_h_bad/rotate-secret', send('PATCH', { enableSignature: 'yes' }))).status).toBe(
      400,
    );
    expect((await request('/api/workflow-webhooks/wh_nope/rotate-secret', { method: 'PATCH' })).status).toBe(404);
    expect((await request('/api/workflow-webhooks/wh_nope', send('PATCH', { name: 'x' }))).status).toBe(404);
    expect((await request('/api/workflow-webhooks/wh_nope', { method: 'DELETE' })).status).toBe(404);
    expect((await request('/api/workflow-webhooks/wh_nope/events')).status).toBe(404);
    expect((await app(['workflow-webhooks:read'])('/api/workflow-webhooks/wh_h_bad/rotate-secret', { method: 'PATCH' })).status).toBe(
      403,
    );
  });
});
