/**
 * POST /api/workflows/webhook/:webhookId through the test app, with the
 * master registry on a pglite master database and the tenant on pglite (so
 * the conformance harness can run it against both backends): the registry
 * lookup, the webhook's rules (raw-body HMAC, allowed methods, size cap),
 * the workflow's status, the run it starts and the call counters.
 */

import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(holder.master),
    getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  };
});

import { publicWorkflowWebhookRoutes } from './index';

const BASE = '/api/workflows/webhook';
const ORG_ID = 'org_test_default';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

/** An `EXECUTE_WORKFLOW` answering by method: every run gets the same instance id. */
function runtime() {
  return {
    create: vi.fn(async (_init: { params: Record<string, unknown> }) => ({ id: 'cf_inst_hook' })),
    get: vi.fn(async (_id: string) => ({ terminate: async () => undefined })),
  };
}

function deliver(webhookId: string, init: RequestInit, env: Record<string, unknown> = { EXECUTE_WORKFLOW: runtime() }) {
  const { request } = createTestApp(BASE, publicWorkflowWebhookRoutes, {
    context: { tenantDb: db, masterDb: master, orgId: null },
    env: env as never,
  });
  return request(`${BASE}/${webhookId}`, { method: 'POST', ...init });
}

let seq = 0;

async function seedWorkflow(status = 'active') {
  const id = `wf_pw_${++seq}`;
  await db.insert(schema.workflows).values({
    id,
    name: `Workflow ${id}`,
    status,
    createdBy: 'user_owner',
    steps: [{ id: 's1', type: 'send_email' }] as never,
  });
  return id;
}

async function seedWebhook(workflowId: string, over: Partial<typeof schema.workflowWebhooks.$inferInsert> = {}) {
  const id = `wh_pw_${++seq}`;
  await db.insert(schema.workflowWebhooks).values({
    id,
    workflowId,
    triggerId: 'trg_pw',
    name: 'Webhook',
    url: `/api/workflows/webhook/${id}`,
    isEnabled: true,
    validateSignature: false,
    signatureHeader: 'x-webhook-signature',
    allowedMethods: ['POST'] as never,
    ...over,
  });
  await master.insert(masterSchema.workflowWebhookRegistry).values({ id, workspaceId: ORG_ID });
  return id;
}

async function stats(webhookId: string) {
  const [row] = await db.select().from(schema.workflowWebhooks).where(eq(schema.workflowWebhooks.id, webhookId));
  return row;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = db;
  await master.insert(masterSchema.workflowWebhookRegistry).values({
    id: 'wh_pw_removed',
    workspaceId: ORG_ID,
    deletedAt: new Date(),
  });
}, 180_000);

describe('POST /api/workflows/webhook/:webhookId', () => {
  it('404s an id the registry does not know, or knows as removed', async () => {
    for (const id of ['wh_pw_unknown', 'wh_pw_removed']) {
      const res = await deliver(id, { body: '{}', headers: { 'content-type': 'application/json' } });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Webhook not found' });
    }
  });

  it('starts a run with the request in its trigger data and counts the call', async () => {
    const webhookId = await seedWebhook(await seedWorkflow());
    const res = await deliver(`${webhookId}?source=shop`, {
      body: JSON.stringify({ order: 42 }),
      headers: { 'content-type': 'application/json', 'x-shop': 'acme' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; executionId: string };
    expect(body.success).toBe(true);
    const [run] = await db
      .select()
      .from(schema.workflowExecutions)
      .where(eq(schema.workflowExecutions.id, body.executionId));
    expect(run).toMatchObject({ triggerType: 'webhook', triggerId: 'trg_pw', triggeredBy: 'user_owner', cfWorkflowInstanceId: 'cf_inst_hook' });
    expect(run.triggerData).toMatchObject({
      webhookId,
      body: { order: 42 },
      query: { source: 'shop' },
      headers: { 'x-shop': 'acme' },
    });
    expect((await stats(webhookId)).totalCalls).toBe(1);
  });

  it('keeps a body that is not JSON as text', async () => {
    const webhookId = await seedWebhook(await seedWorkflow());
    const res = await deliver(webhookId, { body: 'plain words' });
    expect(res.status).toBe(200);
    const { executionId } = (await res.json()) as { executionId: string };
    const [run] = await db.select().from(schema.workflowExecutions).where(eq(schema.workflowExecutions.id, executionId));
    expect((run.triggerData as { body: unknown }).body).toBe('plain words');
  });

  it('checks the signature over the raw body', async () => {
    const secret = 'topsecret123';
    const webhookId = await seedWebhook(await seedWorkflow(), { validateSignature: true, secret });
    const raw = '{"order"  :  42, "note":"hi"}';
    const signature = createHmac('sha256', secret).update(raw).digest('hex');

    expect((await deliver(webhookId, { body: raw, headers: { 'x-webhook-signature': signature } })).status).toBe(200);
    expect((await deliver(webhookId, { body: raw, headers: { 'x-webhook-signature': `sha256=${signature}` } })).status).toBe(200);
    const bad = await deliver(webhookId, { body: raw, headers: { 'x-webhook-signature': 'deadbeef' } });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: 'Invalid signature' });
    const missing = await deliver(webhookId, { body: raw });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Missing signature' });
  });

  it('refuses a webhook that does not allow POST, a disabled one and an inactive workflow', async () => {
    const getOnly = await seedWebhook(await seedWorkflow(), { allowedMethods: ['GET'] as never });
    const notAllowed = await deliver(getOnly, { body: '{}' });
    expect(notAllowed.status).toBe(405);
    expect(await notAllowed.json()).toEqual({ error: 'Method not allowed' });

    const disabled = await seedWebhook(await seedWorkflow(), { isEnabled: false });
    expect(await (await deliver(disabled, { body: '{}' })).json()).toEqual({ error: 'Webhook not found or disabled' });

    const draft = await seedWebhook(await seedWorkflow('draft'));
    const inactive = await deliver(draft, { body: '{}' });
    expect(inactive.status).toBe(404);
    expect(await inactive.json()).toEqual({ error: 'Workflow not found or not active' });
    expect((await stats(draft)).totalCalls ?? 0).toBe(0);
  });

  it('refuses a body over the size cap', async () => {
    const webhookId = await seedWebhook(await seedWorkflow());
    const res = await deliver(webhookId, { body: 'x'.repeat(1_000_001) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Payload too large' });
  });

  it('counts an accepted call without a runtime as failed', async () => {
    const webhookId = await seedWebhook(await seedWorkflow());
    const res = await deliver(webhookId, { body: '{}' }, {});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Workflow runtime not available' });
    const row = await stats(webhookId);
    expect(row.totalCalls).toBe(1);
    expect(row.failedCalls).toBe(1);
  });
});
