/**
 * Route-level tests for the public webhook receiver
 * (POST /api/workflows/webhook/:webhookId): registry-based lookup (no
 * tenant-DB scan on a miss), raw-body HMAC verification, the body size cap,
 * and dispatch via `startRun` with the legacy `{ success, executionId }`
 * response shape.
 *
 * `getTenantDbForWorkspace` and the registry lookup are mocked — this
 * exercises the route's own logic against a real pglite tenant DB without a
 * Neon connection.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';

let db: Database;

vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  return { ...actual, getTenantDbForWorkspace: vi.fn(async () => db) };
});

const resolveWebhookWorkspace = vi.fn();
vi.mock('../../services/workflow-webhook-registry', () => ({
  resolveWebhookWorkspace: (...args: unknown[]) => resolveWebhookWorkspace(...args),
  registryDeps: vi.fn(() => ({})),
}));

const { publicWorkflowWebhookRoutes } = await import('./index');
const { getTenantDbForWorkspace } = await import('@weldsuite/worker-kit/db');
const { computeWebhookHmacHex } = await import('../../services/workflow-webhook-receiver');

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  resolveWebhookWorkspace.mockReset();
  (getTenantDbForWorkspace as any).mockClear();
});

let seq = 0;
const nextId = (prefix: string) => `${prefix}_t${++seq}`;

async function seedWorkflow(status = 'active') {
  const id = nextId('wf');
  await db.insert(schema.workflows).values({
    id,
    name: `Workflow ${id}`,
    status,
    version: 1,
    steps: [{ id: 's1', type: 'send_email' }] as never,
  });
  return id;
}

async function seedWebhook(workflowId: string, over: Partial<typeof schema.workflowWebhooks.$inferInsert> = {}) {
  const id = nextId('wh');
  await db.insert(schema.workflowWebhooks).values({
    id,
    workflowId,
    name: 'Webhook',
    url: `/api/workflows/webhook/${id}`,
    isEnabled: true,
    validateSignature: false,
    signatureHeader: 'x-webhook-signature',
    allowedMethods: ['POST'] as never,
    ...over,
  });
  return id;
}

function fakeEnv() {
  return {
    EXECUTE_WORKFLOW: { create: vi.fn(async () => ({ id: 'cf_instance_1' })) },
    WORKSPACE_CACHE: {} as unknown,
  } as any;
}

describe('POST /api/workflows/webhook/:webhookId', () => {
  it('404s an unknown id without touching any tenant DB (no fan-out scan)', async () => {
    resolveWebhookWorkspace.mockResolvedValue(null);
    const res = await publicWorkflowWebhookRoutes.request(
      '/wh_unknown',
      { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
      fakeEnv(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Webhook not found' });
    expect(getTenantDbForWorkspace).not.toHaveBeenCalled();
  });

  it('dispatches via startRun and returns the legacy { success, executionId } shape', async () => {
    const workflowId = await seedWorkflow();
    const webhookId = await seedWebhook(workflowId);
    resolveWebhookWorkspace.mockResolvedValue('org_1');

    const res = await publicWorkflowWebhookRoutes.request(
      `/${webhookId}`,
      {
        method: 'POST',
        body: JSON.stringify({ order: 42 }),
        headers: { 'content-type': 'application/json' },
      },
      fakeEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; executionId: string };
    expect(body.success).toBe(true);
    expect(body.executionId).toMatch(/^wex_/);

    const [run] = await db.select().from(schema.workflowExecutions).where(eq(schema.workflowExecutions.id, body.executionId));
    expect(run).toBeTruthy();
    expect(run.triggerType).toBe('webhook');
    expect((run.triggerData as any).body).toEqual({ order: 42 });
    expect((run.triggerData as any).webhookId).toBe(webhookId);
  });

  it('verifies the HMAC over the RAW body, not a re-serialized copy', async () => {
    const workflowId = await seedWorkflow();
    const secret = 'topsecret123';
    const webhookId = await seedWebhook(workflowId, { validateSignature: true, secret });
    resolveWebhookWorkspace.mockResolvedValue('org_1');

    // Deliberately unusual whitespace — re-serializing via JSON.stringify
    // (the old bug) would change these exact bytes and break the signature.
    const rawBody = '{"order"  :  42, "note":"hi"}';
    const signature = await computeWebhookHmacHex(secret, rawBody);

    const ok = await publicWorkflowWebhookRoutes.request(
      `/${webhookId}`,
      { method: 'POST', body: rawBody, headers: { 'x-webhook-signature': signature } },
      fakeEnv(),
    );
    expect(ok.status).toBe(200);

    const okWithPrefix = await publicWorkflowWebhookRoutes.request(
      `/${webhookId}`,
      { method: 'POST', body: rawBody, headers: { 'x-webhook-signature': `sha256=${signature}` } },
      fakeEnv(),
    );
    expect(okWithPrefix.status).toBe(200);

    const bad = await publicWorkflowWebhookRoutes.request(
      `/${webhookId}`,
      { method: 'POST', body: rawBody, headers: { 'x-webhook-signature': 'deadbeef' } },
      fakeEnv(),
    );
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: 'Invalid signature' });

    const missing = await publicWorkflowWebhookRoutes.request(
      `/${webhookId}`,
      { method: 'POST', body: rawBody },
      fakeEnv(),
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Missing signature' });
  });

  it('rejects a body over the size cap with 413', async () => {
    const workflowId = await seedWorkflow();
    const webhookId = await seedWebhook(workflowId);
    resolveWebhookWorkspace.mockResolvedValue('org_1');

    const big = 'x'.repeat(1_000_001);
    const res = await publicWorkflowWebhookRoutes.request(
      `/${webhookId}`,
      { method: 'POST', body: big, headers: { 'content-length': String(big.length) } },
      fakeEnv(),
    );
    expect(res.status).toBe(413);
  });

  it('404s a disabled webhook', async () => {
    const workflowId = await seedWorkflow();
    const webhookId = await seedWebhook(workflowId, { isEnabled: false });
    resolveWebhookWorkspace.mockResolvedValue('org_1');

    const res = await publicWorkflowWebhookRoutes.request(`/${webhookId}`, { method: 'POST', body: '{}' }, fakeEnv());
    expect(res.status).toBe(404);
  });

  it('404s when the workflow is not active', async () => {
    const workflowId = await seedWorkflow('draft');
    const webhookId = await seedWebhook(workflowId);
    resolveWebhookWorkspace.mockResolvedValue('org_1');

    const res = await publicWorkflowWebhookRoutes.request(`/${webhookId}`, { method: 'POST', body: '{}' }, fakeEnv());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Workflow not found or not active' });
  });
});
