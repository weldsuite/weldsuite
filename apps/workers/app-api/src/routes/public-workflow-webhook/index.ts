/**
 * Workflow-Trigger Webhook Receiver — PUBLIC route.
 *
 * POST /api/workflows/webhook/:webhookId
 *
 * Ported from apps/api-worker/src/routes/webhooks/workflow-receiver.ts
 * (legacy worker phase-out, W3). Mounted BEFORE clerkMiddleware — external
 * systems configured by users POST here and have no Clerk tokens. Security is
 * per-webhook: HMAC signature validation, IP whitelist, and HTTP method
 * allowlist, all preserved 1:1 from the api-worker implementation.
 *
 * Response shapes are the LEGACY shapes (`{ success, executionId }` /
 * `{ error: string }`) — external callers may parse them, so they are NOT
 * wrapped in the app-api `{ data } / { error: { code, ... } }` envelope.
 */

import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import type { Env, Variables } from '../../types';
import { getTenantDbForWorkspace, schema } from '../../db';
import {
  resolveWebhookWorkspace,
  computeWebhookHmacHex,
  updateWebhookStats,
} from '../../services/workflow-webhook-receiver';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /:webhookId — Receive an external webhook call and dispatch the
 * associated WeldConnect workflow via the EXECUTE_WORKFLOW CF Workflow binding.
 */
app.post('/:webhookId', async (c) => {
  const webhookId = c.req.param('webhookId');
  const sourceIp =
    c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '';

  // Parse request body (JSON preferred, raw text fallback)
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = await c.req.text();
  }

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const query: Record<string, string> = {};
  const url = new URL(c.req.url);
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  // Webhooks live in tenant DBs — resolve the owning workspace (KV-cached).
  const workspaceId = await resolveWebhookWorkspace(c.env, webhookId);
  if (!workspaceId) {
    return c.json({ error: 'Webhook not found' }, 404);
  }

  // Load webhook configuration
  const db = await getTenantDbForWorkspace(c.env, workspaceId);
  const [webhook] = await db
    .select()
    .from(schema.workflowWebhooks)
    .where(
      and(
        eq(schema.workflowWebhooks.id, webhookId),
        eq(schema.workflowWebhooks.isEnabled, true),
        isNull(schema.workflowWebhooks.deletedAt),
      ),
    )
    .limit(1);

  if (!webhook) {
    return c.json({ error: 'Webhook not found or disabled' }, 404);
  }

  // Validate signature if configured
  if (webhook.validateSignature && webhook.secret) {
    const signatureHeader = (webhook.signatureHeader || 'x-webhook-signature').toLowerCase();
    const providedSignature = headers[signatureHeader];

    if (!providedSignature) {
      await updateWebhookStats(db, webhookId, false, sourceIp);
      return c.json({ error: 'Missing signature' }, 401);
    }

    const expectedSignature = await computeWebhookHmacHex(
      webhook.secret,
      typeof body === 'string' ? body : JSON.stringify(body),
    );

    const isValid =
      providedSignature === expectedSignature ||
      providedSignature === `sha256=${expectedSignature}`;

    if (!isValid) {
      await updateWebhookStats(db, webhookId, false, sourceIp);
      return c.json({ error: 'Invalid signature' }, 401);
    }
  }

  // Check allowed methods
  const allowedMethods = webhook.allowedMethods as string[] | null;
  if (allowedMethods && allowedMethods.length > 0) {
    if (!allowedMethods.includes('POST')) {
      await updateWebhookStats(db, webhookId, false, sourceIp);
      return c.json({ error: 'Method not allowed' }, 405);
    }
  }

  // Check IP whitelist
  const ipWhitelist = webhook.ipWhitelist as string[] | null;
  if (ipWhitelist && ipWhitelist.length > 0 && sourceIp) {
    if (!ipWhitelist.includes(sourceIp)) {
      await updateWebhookStats(db, webhookId, false, sourceIp);
      return c.json({ error: 'IP not allowed' }, 403);
    }
  }

  // Verify workflow exists and is active
  const [workflow] = await db
    .select()
    .from(schema.workflows)
    .where(
      and(
        eq(schema.workflows.id, webhook.workflowId),
        eq(schema.workflows.status, 'active'),
        isNull(schema.workflows.deletedAt),
      ),
    )
    .limit(1);

  if (!workflow) {
    await updateWebhookStats(db, webhookId, false, sourceIp);
    return c.json({ error: 'Workflow not found or not active' }, 404);
  }

  // Dispatch workflow execution via CF Workflow
  const executeWorkflow = c.env.EXECUTE_WORKFLOW;
  if (!executeWorkflow) {
    await updateWebhookStats(db, webhookId, false, sourceIp);
    return c.json({ error: 'Workflow runtime not available' }, 503);
  }

  try {
    const instance = await executeWorkflow.create({
      params: {
        workspaceId,
        userId: workflow.createdBy || 'webhook',
        workflowId: webhook.workflowId,
        triggerId: webhook.triggerId || undefined,
        triggerType: 'webhook',
        triggerData: {
          webhookId: webhook.id,
          headers,
          body,
          query,
          sourceIp,
          receivedAt: new Date().toISOString(),
        },
        source: 'task',
      },
    });

    await updateWebhookStats(db, webhookId, true, sourceIp);

    return c.json({
      success: true,
      executionId: instance.id,
    });
  } catch (err) {
    console.error('[WebhookReceiver] Failed to dispatch workflow:', err);
    await updateWebhookStats(db, webhookId, false, sourceIp);
    return c.json({ error: 'Failed to trigger workflow' }, 500);
  }
});

export const publicWorkflowWebhookRoutes = app;
