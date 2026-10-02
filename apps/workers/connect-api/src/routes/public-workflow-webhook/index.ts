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
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import {
  resolveWebhookWorkspace,
  computeWebhookHmacHex,
  updateWebhookStats,
} from '../../services/workflow-webhook-receiver';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type WorkflowWebhookRow = typeof schema.workflowWebhooks.$inferSelect;

/** A request the webhook's security config refuses, with the legacy error body + status. */
type WebhookRejection = { error: string; status: 401 | 403 | 405 };

/** Parse request body (JSON preferred, raw text fallback). */
async function parseWebhookBody(req: { json: () => Promise<unknown>; text: () => Promise<string> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return await req.text();
  }
}

/** Validate the HMAC signature when the webhook is configured to require one. */
async function checkWebhookSignature(
  webhook: WorkflowWebhookRow,
  headers: Record<string, string>,
  body: unknown,
): Promise<WebhookRejection | null> {
  if (!webhook.validateSignature || !webhook.secret) return null;

  const signatureHeader = (webhook.signatureHeader || 'x-webhook-signature').toLowerCase();
  const providedSignature = headers[signatureHeader];
  if (!providedSignature) return { error: 'Missing signature', status: 401 };

  const expectedSignature = await computeWebhookHmacHex(
    webhook.secret,
    typeof body === 'string' ? body : JSON.stringify(body),
  );

  const isValid =
    providedSignature === expectedSignature ||
    providedSignature === `sha256=${expectedSignature}`;
  return isValid ? null : { error: 'Invalid signature', status: 401 };
}

/** Enforce the HTTP method allowlist and the IP whitelist. */
function checkWebhookMethodAndIp(
  webhook: WorkflowWebhookRow,
  sourceIp: string,
): WebhookRejection | null {
  const allowedMethods = webhook.allowedMethods as string[] | null;
  if (allowedMethods && allowedMethods.length > 0 && !allowedMethods.includes('POST')) {
    return { error: 'Method not allowed', status: 405 };
  }

  const ipWhitelist = webhook.ipWhitelist as string[] | null;
  if (ipWhitelist && ipWhitelist.length > 0 && sourceIp && !ipWhitelist.includes(sourceIp)) {
    return { error: 'IP not allowed', status: 403 };
  }
  return null;
}

/**
 * POST /:webhookId — Receive an external webhook call and dispatch the
 * associated WeldConnect workflow via the EXECUTE_WORKFLOW CF Workflow binding.
 */
app.post('/:webhookId', async (c) => {
  const webhookId = c.req.param('webhookId');
  const sourceIp =
    c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '';

  const body = await parseWebhookBody(c.req);

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

  // Validate signature (if configured), allowed methods and IP whitelist
  const rejection =
    (await checkWebhookSignature(webhook, headers, body)) ??
    checkWebhookMethodAndIp(webhook, sourceIp);
  if (rejection) {
    await updateWebhookStats(db, webhookId, false, sourceIp);
    return c.json({ error: rejection.error }, rejection.status);
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
        source: 'weldconnect',
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
