/**
 * Workflow webhook routes — flat /api/workflow-webhooks/* surface.
 *
 * Permissions: tasks:read | tasks:create | tasks:update | tasks:delete.
 */

import { z } from 'zod';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const wh = schema.workflowWebhooks;
const wf = schema.workflows;
const wt = schema.workflowTriggers;
const we = schema.workflowExecutions;

function generateSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

const createWebhookSchema = z.object({
  workflowId: z.string(),
  triggerId: z.string().optional(),
  name: z.string().min(1).max(255).default('Webhook'),
  description: z.string().optional(),
  validateSignature: z.boolean().default(true),
  signatureHeader: z.string().default('x-webhook-signature'),
  allowedMethods: z.array(z.string()).default(['POST']),
  ipWhitelist: z.array(z.string()).optional(),
});

const updateWebhookSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  validateSignature: z.boolean().optional(),
  signatureHeader: z.string().optional(),
  allowedMethods: z.array(z.string()).optional(),
  ipWhitelist: z.array(z.string()).optional(),
  isEnabled: z.boolean().optional(),
});

app.get('/', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const filterConditions: any[] = [isNull(wh.deletedAt)];
  if (q.workflowId) filterConditions.push(eq(wh.workflowId, q.workflowId));
  if (q.isEnabled !== undefined) filterConditions.push(eq(wh.isEnabled, q.isEnabled === 'true'));

  const conditions = [...filterConditions];
  if (q.cursor) conditions.push(lt(wh.id, q.cursor));

  try {
    const [rows, countRes] = await Promise.all([
      db
        .select({ webhook: wh, workflowName: wf.name })
        .from(wh)
        .leftJoin(wf, eq(wh.workflowId, wf.id))
        .where(and(...conditions))
        .orderBy(desc(wh.createdAt), desc(wh.id))
        .limit(limit + 1),
      db.select({ count: sql<number>`count(*)::int` }).from(wh).where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    // Mask the inbound HMAC secret in reads — it's shown only on create/rotate.
    const data = sliced.map((r) => ({ ...r.webhook, secret: undefined, workflowName: r.workflowName }));
    const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, cursor));
  } catch (err) {
    console.error('[app-api/workflow-webhooks] list failed:', err);
    return error.internal(c, 'Failed to list workflow webhooks');
  }
});

app.get('/workflow/:workflowId', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const workflowId = c.req.param('workflowId');
  try {
    const [webhook] = await db
      .select()
      .from(wh)
      .where(and(eq(wh.workflowId, workflowId), isNull(wh.deletedAt)))
      .limit(1);
    if (!webhook) return success(c, null);

    const baseUrl = c.env.PUBLIC_APP_URL || 'http://localhost:3000';
    const externalUrl = webhook.externalUrl || `${baseUrl}${webhook.url}`;
    // Secret intentionally omitted — retrieve it via POST /rotate-secret. It is
    // an inbound HMAC signing secret; exposing it to any `tasks:read` holder lets
    // them forge signature-valid webhook payloads.
    return success(c, {
      id: webhook.id,
      url: webhook.url,
      externalUrl,
      hasSecret: !!webhook.secret,
      isEnabled: webhook.isEnabled,
    });
  } catch (err) {
    console.error('[app-api/workflow-webhooks] workflow failed:', err);
    return error.internal(c, 'Failed to fetch workflow webhook');
  }
});

app.get('/:id', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select({ webhook: wh, workflowName: wf.name })
      .from(wh)
      .leftJoin(wf, eq(wh.workflowId, wf.id))
      .where(and(eq(wh.id, id), isNull(wh.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Webhook', id);
    // Mask the inbound HMAC secret — shown only on create/rotate.
    return success(c, { ...row.webhook, secret: undefined, workflowName: row.workflowName });
  } catch (err) {
    console.error('[app-api/workflow-webhooks] get failed:', err);
    return error.internal(c, 'Failed to fetch webhook');
  }
});

app.get('/:id/events', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [webhook] = await db.select().from(wh).where(and(eq(wh.id, id), isNull(wh.deletedAt))).limit(1);
    if (!webhook) return error.notFound(c, 'Webhook', id);

    const executions = await db
      .select()
      .from(we)
      .where(and(eq(we.workflowId, webhook.workflowId), eq(we.triggerType, 'webhook')))
      .orderBy(desc(we.startedAt))
      .limit(50);

    const events = executions.map((e) => ({
      id: e.id,
      timestamp: e.startedAt,
      status: e.status,
      sourceIp: (e.triggerData as any)?.sourceIp,
    }));
    return success(c, events);
  } catch (err) {
    console.error('[app-api/workflow-webhooks] events failed:', err);
    return error.internal(c, 'Failed to fetch webhook events');
  }
});

async function verifyWorkflow(db: any, workflowId: string) {
  const [row] = await db.select().from(wf).where(and(eq(wf.id, workflowId), isNull(wf.deletedAt))).limit(1);
  return row ?? null;
}

app.post('/', requirePermission('tasks:create'), zValidator('json', createWebhookSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    if (!(await verifyWorkflow(db, data.workflowId))) return error.notFound(c, 'Workflow', data.workflowId);

    const id = generateId('wh');
    const secret = generateSecret();
    const url = `/api/workflows/webhook/${id}`;
    const now = new Date();
    await db.insert(wh).values({
      id,
      workflowId: data.workflowId,
      triggerId: data.triggerId ?? null,
      name: data.name,
      description: data.description ?? null,
      url,
      secret,
      validateSignature: data.validateSignature,
      signatureHeader: data.signatureHeader,
      allowedMethods: data.allowedMethods as any,
      ipWhitelist: (data.ipWhitelist ?? null) as any,
      isEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const [webhook] = await db.select().from(wh).where(eq(wh.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'workflow_webhook',
      entityId: id,
      action: 'created',
      data: { id, workflowId: data.workflowId },
    });
    return success(c, { ...webhook, webhookUrl: url }, 201);
  } catch (err) {
    console.error('[app-api/workflow-webhooks] create failed:', err);
    return error.internal(c, 'Failed to create webhook');
  }
});

app.post(
  '/create-trigger',
  requirePermission('tasks:create'),
  zValidator('json', z.object({ workflowId: z.string() })),
  async (c) => {
    const db = c.get('tenantDb');
    const { workflowId } = c.req.valid('json');
    try {
      if (!(await verifyWorkflow(db, workflowId))) return error.notFound(c, 'Workflow', workflowId);

      const triggerId = generateId('trg');
      const webhookId = generateId('wh');
      const secret = generateSecret();
      const url = `/api/workflows/webhook/${webhookId}`;
      const now = new Date();

      await db.insert(wt).values({
        id: triggerId,
        workflowId,
        name: 'Webhook Trigger',
        category: 'webhook',
        config: { method: 'POST', validateSignature: true } as any,
        isEnabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(wh).values({
        id: webhookId,
        workflowId,
        triggerId,
        name: 'Webhook',
        url,
        secret,
        validateSignature: true,
        signatureHeader: 'x-webhook-signature',
        allowedMethods: ['POST'] as any,
        isEnabled: true,
        createdAt: now,
        updatedAt: now,
      });

      const [trigger] = await db.select().from(wt).where(eq(wt.id, triggerId)).limit(1);
      publishEntityEvent({
        c,
        entityType: 'workflow_webhook',
        entityId: webhookId,
        action: 'created',
        data: { id: webhookId, workflowId, triggerId },
      });
      return success(c, { ...trigger, webhookId, webhookUrl: url, secret }, 201);
    } catch (err) {
      console.error('[app-api/workflow-webhooks] create-trigger failed:', err);
      return error.internal(c, 'Failed to create webhook trigger');
    }
  },
);

for (const method of ['put', 'patch'] as const) {
  app[method]('/:id', requirePermission('tasks:update'), zValidator('json', updateWebhookSchema), async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const [existing] = await db.select().from(wh).where(and(eq(wh.id, id), isNull(wh.deletedAt))).limit(1);
      if (!existing) return error.notFound(c, 'Webhook', id);

      const update: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of ['name', 'description', 'validateSignature', 'signatureHeader', 'allowedMethods', 'ipWhitelist', 'isEnabled'] as const) {
        if (data[k] !== undefined) update[k] = data[k];
      }
      await db.update(wh).set(update).where(eq(wh.id, id));
      const [webhook] = await db.select().from(wh).where(eq(wh.id, id)).limit(1);
      publishEntityEvent({
        c,
        entityType: 'workflow_webhook',
        entityId: id,
        action: 'updated',
        data: { id, workflowId: existing.workflowId },
      });
      // Mask the inbound HMAC secret — only create/rotate return it.
      return success(c, { ...webhook, secret: undefined });
    } catch (err) {
      console.error('[app-api/workflow-webhooks] update failed:', err);
      return error.internal(c, 'Failed to update webhook');
    }
  });
}

app.patch('/:id/rotate-secret', requirePermission('tasks:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(wh).where(and(eq(wh.id, id), isNull(wh.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Webhook', id);

    const newSecret = generateSecret();
    await db.update(wh).set({ secret: newSecret, updatedAt: new Date() }).where(eq(wh.id, id));
    const [webhook] = await db.select().from(wh).where(eq(wh.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'workflow_webhook',
      entityId: id,
      action: 'updated',
      data: { id, workflowId: existing.workflowId, secretRotated: true },
    });
    return success(c, webhook);
  } catch (err) {
    console.error('[app-api/workflow-webhooks] rotate-secret failed:', err);
    return error.internal(c, 'Failed to rotate webhook secret');
  }
});

app.delete('/:id', requirePermission('tasks:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(wh).where(and(eq(wh.id, id), isNull(wh.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Webhook', id);
    await db.update(wh).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(wh.id, id));
    publishEntityEvent({
      c,
      entityType: 'workflow_webhook',
      entityId: id,
      action: 'deleted',
      data: { id, workflowId: existing.workflowId },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/workflow-webhooks] delete failed:', err);
    return error.internal(c, 'Failed to delete webhook');
  }
});

export const workflowWebhooksRoutes = app;
