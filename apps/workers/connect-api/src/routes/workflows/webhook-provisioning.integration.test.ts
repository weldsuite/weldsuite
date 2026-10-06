/**
 * End-to-end test for webhook-trigger provisioning through the real
 * /api/workflows routes: saving a workflow whose triggers include a `webhook`
 * trigger must provision a `workflow_webhooks` row (and register it in the
 * master registry) without any extra call, and removing the trigger (or
 * deleting the workflow) must retire it. See services/workflow-webhook-sync.ts.
 *
 * `getMasterDb` is mocked to the pglite-backed master DB — the registry lives
 * cross-tenant, and the test harness's fake `DATABASE_URL_MASTER` is not a
 * real connection string.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

let masterDb: MasterDatabase;
vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  return { ...actual, getMasterDb: () => masterDb };
});

// Imported AFTER the mocks above are registered.
const { workflowsRoutes } = await import('./index');
const { workflowWebhookRegistry } = (await import('@weldsuite/worker-kit/db')).masterSchema;

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
}, 60_000);

function app() {
  return createTestApp('/api/workflows', workflowsRoutes, {
    context: { permissions: permissions('workflows:create', 'workflows:update', 'workflows:delete'), tenantDb: db },
  }).request;
}

async function registryRow(id: string) {
  const [row] = await masterDb.select().from(workflowWebhookRegistry).where(eq(workflowWebhookRegistry.id, id));
  return row;
}

describe('webhook trigger provisioning (end to end through /api/workflows)', () => {
  it('POST / with a webhook trigger provisions + registers a workflow_webhooks row', async () => {
    const request = app();
    const res = await request('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Order webhook',
        triggers: [{ id: 'trg-1', type: 'webhook', name: 'Order received' }],
        steps: [{ id: 'step-1', type: 'http_request', config: { url: 'https://example.test/x' } }],
      }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };

    const [webhook] = await db
      .select()
      .from(schema.workflowWebhooks)
      .where(eq(schema.workflowWebhooks.workflowId, data.id));
    expect(webhook).toBeTruthy();
    expect(webhook.triggerId).toBe('trg-1');
    expect(webhook.isEnabled).toBe(true);

    const registered = await registryRow(webhook.id);
    expect(registered).toBeTruthy();
    expect(registered.deletedAt).toBeNull();
  });

  it('removing the webhook trigger on update retires the row and deregisters it', async () => {
    const request = app();
    const createRes = await request('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'To be de-webhooked',
        triggers: [{ id: 'trg-2', type: 'webhook' }],
      }),
    });
    const { data } = (await createRes.json()) as { data: { id: string } };
    const [webhook] = await db
      .select()
      .from(schema.workflowWebhooks)
      .where(eq(schema.workflowWebhooks.workflowId, data.id));

    await request(`/api/workflows/${data.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggers: [] }),
    });

    const [afterUpdate] = await db
      .select()
      .from(schema.workflowWebhooks)
      .where(eq(schema.workflowWebhooks.id, webhook.id));
    expect(afterUpdate.deletedAt).not.toBeNull();
    expect((await registryRow(webhook.id)).deletedAt).not.toBeNull();
  });

  it('deleting the workflow retires its webhook row and deregisters it', async () => {
    const request = app();
    const createRes = await request('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'To be deleted', triggers: [{ id: 'trg-3', type: 'webhook' }] }),
    });
    const { data } = (await createRes.json()) as { data: { id: string } };
    const [webhook] = await db
      .select()
      .from(schema.workflowWebhooks)
      .where(eq(schema.workflowWebhooks.workflowId, data.id));

    const del = await request(`/api/workflows/${data.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    const [afterDelete] = await db
      .select()
      .from(schema.workflowWebhooks)
      .where(eq(schema.workflowWebhooks.id, webhook.id));
    expect(afterDelete.deletedAt).not.toBeNull();
    expect((await registryRow(webhook.id)).deletedAt).not.toBeNull();
  });

  it('a workflow without a webhook trigger never touches the registry', async () => {
    const request = app();
    const res = await request('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No webhook here' }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const rows = await db.select().from(schema.workflowWebhooks).where(eq(schema.workflowWebhooks.workflowId, data.id));
    expect(rows).toHaveLength(0);
  });
});
