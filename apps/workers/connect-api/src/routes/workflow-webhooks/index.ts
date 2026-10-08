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
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { generateWebhookSecret } from '../../lib/webhook-secret';
import { publicApiBase } from '../../lib/public-api-base';
import { deregisterWebhookOwner, registerWebhookOwner, registryDeps } from '../../services/workflow-webhook-registry';
import { webhookTriggerIds } from '../../services/weldconnect-mvp';
import { parseLimit } from '../../lib/query-params';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const wh = schema.workflowWebhooks;
const wf = schema.workflows;
const wt = schema.workflowTriggers;
const we = schema.workflowExecutions;

const createWebhookSchema = z.object({
  workflowId: z.string(),
  triggerId: z.string().optional(),
  name: z.string().min(1).max(255).default('Webhook'),
  description: z.string().optional(),
  // Off by default — the unguessable URL is the credential; signing is an
  // opt-in a user enables from the editor (rotate-secret + reveal-once).
  validateSignature: z.boolean().default(false),
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

type WebhookRow = typeof wh.$inferSelect;

/**
 * True when the webhook belongs to a `webhook` trigger embedded in its
 * workflow — the rows services/workflow-webhook-sync.ts provisions on save
 * and retires when the trigger goes. Those are managed from the workflow
 * editor; deleting one here would only break the trigger until the next save
 * provisions a new URL.
 */
function isManagedWebhook(webhook: Pick<WebhookRow, 'triggerId'>, workflowTriggers: unknown): boolean {
  return !!webhook.triggerId && webhookTriggerIds(workflowTriggers).includes(webhook.triggerId);
}

/**
 * Read shape of a webhook: the row without its inbound HMAC secret (only
 * rotate-secret reveals that), plus the absolute receiver URL, the workflow's
 * name and status, and whether the workflow editor manages it.
 */
function toWebhookView(
  webhook: WebhookRow,
  workflow: { name: string | null; status: string | null; triggers: unknown },
  base: string,
) {
  const { secret, ...rest } = webhook;
  return {
    ...rest,
    externalUrl: webhook.externalUrl || `${base}${webhook.url}`,
    hasSecret: !!secret,
    workflowName: workflow.name,
    // The receiver only accepts calls while the workflow is `active`, so the
    // UI derives the webhook's effective status (Draft / Paused / Active) from this.
    workflowStatus: workflow.status,
    isManaged: isManagedWebhook(webhook, workflow.triggers),
  };
}

app.get('/', requirePermission('workflow-webhooks:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = parseLimit(q.limit, 25, 100);

  const filterConditions: any[] = [isNull(wh.deletedAt)];
  if (q.workflowId) filterConditions.push(eq(wh.workflowId, q.workflowId));
  if (q.isEnabled !== undefined) filterConditions.push(eq(wh.isEnabled, q.isEnabled === 'true'));

  const conditions = [...filterConditions];
  if (q.cursor) conditions.push(lt(wh.id, q.cursor));

  try {
    const [rows, countRes] = await Promise.all([
      db
        .select({ webhook: wh, workflowName: wf.name, workflowStatus: wf.status, workflowTriggers: wf.triggers })
        .from(wh)
        .leftJoin(wf, eq(wh.workflowId, wf.id))
        .where(and(...conditions))
        .orderBy(desc(wh.id))
        .limit(limit + 1),
      db.select({ count: sql<number>`count(*)::int` }).from(wh).where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const base = publicApiBase(c.env);
    const data = sliced.map((r) => toWebhookView(r.webhook, { name: r.workflowName, status: r.workflowStatus, triggers: r.workflowTriggers }, base));
    const cursor = hasMore && data.length > 0 ? data.at(-1)!.id : null;
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, cursor));
  } catch (err) {
    console.error('[app-api/workflow-webhooks] list failed:', err);
    return error.internal(c, 'Failed to list workflow webhooks');
  }
});

app.get('/workflow/:workflowId', requirePermission('workflow-webhooks:read'), async (c) => {
  const db = c.get('tenantDb');
  const workflowId = c.req.param('workflowId');
  try {
    const [rows, [workflow]] = await Promise.all([
      db
        .select()
        .from(wh)
        .where(and(eq(wh.workflowId, workflowId), isNull(wh.deletedAt)))
        .orderBy(desc(wh.id)),
      db.select({ triggers: wf.triggers }).from(wf).where(eq(wf.id, workflowId)).limit(1),
    ]);
    // A workflow can carry more than one row (an older hand-made webhook next
    // to the one its trigger provisioned): the editor's trigger panel must
    // show the provisioned one, so prefer it, then the newest.
    const webhook = rows.find((row) => isManagedWebhook(row, workflow?.triggers)) ?? rows[0];
    if (!webhook) return success(c, null);

    // The receiver (POST /api/workflows/webhook/:id) is mounted on THIS
    // worker, not the platform SPA — build the external URL from connect-api's
    // own public origin (see lib/public-api-base.ts), falling back to it only
    // when an older row has no `externalUrl` stored yet.
    const externalUrl = webhook.externalUrl || `${publicApiBase(c.env)}${webhook.url}`;
    // Secret intentionally omitted — retrieve it via POST /rotate-secret. It is
    // an inbound HMAC signing secret; exposing it to any `tasks:read` holder lets
    // them forge signature-valid webhook payloads.
    return success(c, {
      id: webhook.id,
      url: webhook.url,
      externalUrl,
      hasSecret: !!webhook.secret,
      validateSignature: webhook.validateSignature,
      isEnabled: webhook.isEnabled,
    });
  } catch (err) {
    console.error('[app-api/workflow-webhooks] workflow failed:', err);
    return error.internal(c, 'Failed to fetch workflow webhook');
  }
});

app.get('/:id', requirePermission('workflow-webhooks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select({ webhook: wh, workflowName: wf.name, workflowStatus: wf.status, workflowTriggers: wf.triggers })
      .from(wh)
      .leftJoin(wf, eq(wh.workflowId, wf.id))
      .where(and(eq(wh.id, id), isNull(wh.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Webhook', id);
    return success(
      c,
      toWebhookView(
        row.webhook,
        { name: row.workflowName, status: row.workflowStatus, triggers: row.workflowTriggers },
        publicApiBase(c.env),
      ),
    );
  } catch (err) {
    console.error('[app-api/workflow-webhooks] get failed:', err);
    return error.internal(c, 'Failed to fetch webhook');
  }
});

app.get('/:id/events', requirePermission('workflow-webhooks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [webhook] = await db.select().from(wh).where(and(eq(wh.id, id), isNull(wh.deletedAt))).limit(1);
    if (!webhook) return error.notFound(c, 'Webhook', id);

    // The runs this webhook started: the receiver stamps its id into the
    // trigger data, so a second webhook on the same workflow doesn't mix in.
    const executions = await db
      .select({
        id: we.id,
        startedAt: we.startedAt,
        status: we.status,
        errorMessage: sql<string | null>`${we.error}->>'message'`,
        sourceIp: sql<string | null>`${we.triggerData}->>'sourceIp'`,
      })
      .from(we)
      .where(
        and(
          eq(we.workflowId, webhook.workflowId),
          eq(we.triggerType, 'webhook'),
          sql`${we.triggerData}->>'webhookId' = ${webhook.id}`,
        ),
      )
      .orderBy(desc(we.startedAt))
      .limit(50);

    const events = executions.map((e) => ({
      id: e.id,
      executionId: e.id,
      timestamp: e.startedAt,
      status: e.status,
      error: e.errorMessage ?? null,
      sourceIp: e.sourceIp ?? undefined,
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

app.post('/', requirePermission('workflow-webhooks:create'), zValidator('json', createWebhookSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    if (!(await verifyWorkflow(db, data.workflowId))) return error.notFound(c, 'Workflow', data.workflowId);

    const id = generateId('wh');
    const secret = generateWebhookSecret();
    const url = `/api/workflows/webhook/${id}`;
    const externalUrl = `${publicApiBase(c.env)}${url}`;
    const now = new Date();
    await db.insert(wh).values({
      id,
      workflowId: data.workflowId,
      triggerId: data.triggerId ?? null,
      name: data.name,
      description: data.description ?? null,
      url,
      externalUrl,
      secret,
      validateSignature: data.validateSignature,
      signatureHeader: data.signatureHeader,
      allowedMethods: data.allowedMethods as any,
      ipWhitelist: (data.ipWhitelist ?? null) as any,
      isEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await registerWebhookOwner(registryDeps(c.env), id, c.get('workspaceId'));
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
  requirePermission('workflow-webhooks:create'),
  zValidator('json', z.object({ workflowId: z.string() })),
  async (c) => {
    const db = c.get('tenantDb');
    const { workflowId } = c.req.valid('json');
    try {
      if (!(await verifyWorkflow(db, workflowId))) return error.notFound(c, 'Workflow', workflowId);

      const triggerId = generateId('trg');
      const webhookId = generateId('wh');
      const secret = generateWebhookSecret();
      const url = `/api/workflows/webhook/${webhookId}`;
      const externalUrl = `${publicApiBase(c.env)}${url}`;
      const now = new Date();

      await db.insert(wt).values({
        id: triggerId,
        workflowId,
        name: 'Webhook Trigger',
        category: 'webhook',
        // Off by default — matches the workflow_webhooks row below; see
        // services/weldconnect-mvp.ts for the signing opt-in design.
        config: { method: 'POST', validateSignature: false } as any,
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
        externalUrl,
        secret,
        validateSignature: false,
        signatureHeader: 'x-webhook-signature',
        allowedMethods: ['POST'] as any,
        isEnabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await registerWebhookOwner(registryDeps(c.env), webhookId, c.get('workspaceId'));

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
  app[method]('/:id', requirePermission('workflow-webhooks:update'), zValidator('json', updateWebhookSchema), async (c) => {
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

const rotateSecretSchema = z.object({
  // When true, also turns on signature validation for this webhook — the
  // editor's "Require signature" control calls this in one step so the new
  // secret is revealed the same moment signing becomes active, instead of a
  // second PATCH racing it.
  enableSignature: z.boolean().optional(),
});

app.patch('/:id/rotate-secret', requirePermission('workflow-webhooks:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  // Body is optional — a plain `PATCH .../rotate-secret` with no payload just
  // rotates the secret and leaves validateSignature unchanged.
  const rawBody = await c.req.text();
  let bodyJson: unknown = {};
  if (rawBody) {
    try {
      bodyJson = JSON.parse(rawBody);
    } catch {
      return error.badRequest(c, 'Invalid request body');
    }
  }
  const parsed = rotateSecretSchema.safeParse(bodyJson);
  if (!parsed.success) return error.badRequest(c, 'Invalid request body');
  const body = parsed.data;
  try {
    const [existing] = await db.select().from(wh).where(and(eq(wh.id, id), isNull(wh.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Webhook', id);

    const newSecret = generateWebhookSecret();
    const update: Record<string, unknown> = { secret: newSecret, updatedAt: new Date() };
    if (body.enableSignature === true) update.validateSignature = true;
    await db.update(wh).set(update).where(eq(wh.id, id));
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

app.delete('/:id', requirePermission('workflow-webhooks:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select({ webhook: wh, workflowTriggers: wf.triggers })
      .from(wh)
      .leftJoin(wf, eq(wh.workflowId, wf.id))
      .where(and(eq(wh.id, id), isNull(wh.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Webhook', id);
    const existing = row.webhook;
    // The workflow's webhook trigger owns this row: saving the workflow would
    // provision a fresh URL anyway, so the trigger is what has to go.
    if (isManagedWebhook(existing, row.workflowTriggers)) {
      return error.conflict(c, "This webhook belongs to a workflow's webhook trigger. Remove the trigger in the workflow editor instead.", {
        reason: 'managed_by_trigger',
        workflowId: existing.workflowId,
      });
    }
    await db.update(wh).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(wh.id, id));
    await deregisterWebhookOwner(registryDeps(c.env), id);
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
