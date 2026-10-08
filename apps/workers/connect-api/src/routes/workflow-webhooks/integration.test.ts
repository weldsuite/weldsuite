/**
 * /api/workflow-webhooks as the WeldConnect › Webhooks pages read it, next to
 * the trigger-provisioned rows (services/workflow-webhook-sync.ts): reads never
 * carry the secret, say whether the workflow editor manages the row, and give
 * the absolute receiver URL; a managed row can't be deleted from here; the
 * editor's `/workflow/:id` lookup prefers the managed row; events are the runs
 * this webhook started.
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
const { workflowWebhooksRoutes } = await import('./index');

let db: Database;

const BASE = 'https://connect-api.example.test';

function app() {
  return createTestApp('/api/workflow-webhooks', workflowWebhooksRoutes, {
    context: {
      permissions: permissions('workflow-webhooks:read', 'workflow-webhooks:update', 'workflow-webhooks:delete'),
      tenantDb: db,
    },
    env: { CONNECT_API_URL: BASE } as never,
  }).request;
}

interface WebhookView {
  id: string;
  url: string;
  externalUrl: string;
  isManaged: boolean;
  hasSecret: boolean;
  workflowName: string | null;
  workflowStatus: string | null;
  secret?: string;
}

async function seedWebhook(id: string, workflowId: string, triggerId: string | null) {
  await db.insert(schema.workflowWebhooks).values({
    id,
    workflowId,
    triggerId,
    name: 'Webhook',
    url: `/api/workflows/webhook/${id}`,
    externalUrl: null,
    secret: 'whsec_test',
    isEnabled: true,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  await db.insert(schema.workflows).values({
    id: 'wf_hooks',
    name: 'Inbound orders',
    status: 'active',
    triggers: [{ id: 'trg_hook', type: 'webhook' }] as never,
  });
  // An older hand-made webhook, then the one the trigger provisioned.
  await seedWebhook('wh_0001_manual', 'wf_hooks', null);
  await seedWebhook('wh_0002_managed', 'wf_hooks', 'trg_hook');
  await db.insert(schema.workflowExecutions).values([
    {
      id: 'wex_hook_1',
      workflowId: 'wf_hooks',
      status: 'completed',
      triggerType: 'webhook',
      triggerData: { webhookId: 'wh_0002_managed', sourceIp: '203.0.113.9' },
      startedAt: new Date(Date.UTC(2026, 0, 2)),
    },
    {
      id: 'wex_hook_2',
      workflowId: 'wf_hooks',
      status: 'failed',
      triggerType: 'webhook',
      triggerData: { webhookId: 'wh_0001_manual' },
      error: { message: 'Step failed' },
      startedAt: new Date(Date.UTC(2026, 0, 3)),
    },
  ]);
}, 60_000);

describe('reads', () => {
  it('GET / lists without secrets, with isManaged, externalUrl and the workflow name', async () => {
    const res = await app()('/api/workflow-webhooks');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: WebhookView[] };
    const byId = new Map(data.map((w) => [w.id, w]));
    const managed = byId.get('wh_0002_managed');
    const manual = byId.get('wh_0001_manual');
    expect(managed?.isManaged).toBe(true);
    expect(manual?.isManaged).toBe(false);
    expect(managed?.externalUrl).toBe(`${BASE}/api/workflows/webhook/wh_0002_managed`);
    expect(managed?.workflowName).toBe('Inbound orders');
    expect(managed?.workflowStatus).toBe('active');
    expect(managed?.hasSecret).toBe(true);
    expect(data.every((w) => w.secret === undefined)).toBe(true);
  });

  it('GET /:id returns the same view', async () => {
    const res = await app()('/api/workflow-webhooks/wh_0002_managed');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: WebhookView };
    expect(data.isManaged).toBe(true);
    expect(data.secret).toBeUndefined();
  });

  it('GET / and GET /:id report the workflow status so a paused workflow is not shown as active', async () => {
    await db.insert(schema.workflows).values({ id: 'wf_paused', name: 'Paused flow', status: 'paused' });
    await seedWebhook('wh_0003_paused', 'wf_paused', null);
    const list = (await (await app()('/api/workflow-webhooks')).json()) as { data: WebhookView[] };
    expect(list.data.find((w) => w.id === 'wh_0003_paused')?.workflowStatus).toBe('paused');
    const one = (await (await app()('/api/workflow-webhooks/wh_0003_paused')).json()) as { data: WebhookView };
    expect(one.data.workflowStatus).toBe('paused');
    expect(one.data.workflowName).toBe('Paused flow');
  });

  it('GET /workflow/:id gives the editor the trigger-provisioned row', async () => {
    const res = await app()('/api/workflow-webhooks/workflow/wf_hooks');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(data.id).toBe('wh_0002_managed');
  });

  it('GET /:id/events lists only the runs this webhook started', async () => {
    const res = await app()('/api/workflow-webhooks/wh_0001_manual/events');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: Array<{ id: string; executionId: string; status: string; error: string | null }>;
    };
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: 'wex_hook_2', executionId: 'wex_hook_2', status: 'failed', error: 'Step failed' });
  });
});

describe('DELETE /:id', () => {
  it("refuses a webhook its workflow's trigger manages", async () => {
    const res = await app()('/api/workflow-webhooks/wh_0002_managed', { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe('managed_by_trigger');
    const [row] = await db.select().from(schema.workflowWebhooks).where(eq(schema.workflowWebhooks.id, 'wh_0002_managed'));
    expect(row.deletedAt).toBeNull();
  });

  it('deletes a hand-made webhook', async () => {
    const res = await app()('/api/workflow-webhooks/wh_0001_manual', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.workflowWebhooks).where(eq(schema.workflowWebhooks.id, 'wh_0001_manual'));
    expect(row.deletedAt).not.toBeNull();
  });
});
