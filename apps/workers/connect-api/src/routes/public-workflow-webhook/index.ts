/**
 * Workflow-Trigger Webhook Receiver — PUBLIC route.
 *
 * POST /api/workflows/webhook/:webhookId
 *
 * Originally ported from apps/api-worker/src/routes/webhooks/workflow-receiver.ts
 * (legacy worker phase-out, W3). Mounted BEFORE clerkMiddleware — external
 * systems configured by users POST here and have no Clerk tokens. Security is
 * per-webhook: HMAC signature validation (over the raw body, off by default —
 * see services/weldconnect-mvp.ts docs), IP whitelist, and HTTP method
 * allowlist.
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
  computeWebhookHmacHex,
  constantTimeEqual,
  updateWebhookStats,
} from '../../services/workflow-webhook-receiver';
import { registryDeps, resolveWebhookWorkspace } from '../../services/workflow-webhook-registry';
import { startRun } from '../../services/workflow-executions';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type WorkflowWebhookRow = typeof schema.workflowWebhooks.$inferSelect;

/** A request the webhook's security config refuses, with the legacy error body + status. */
type WebhookRejection = { error: string; status: 401 | 403 | 405 | 413 };

/** Inbound bodies over this size are rejected before they're buffered or hashed. */
const MAX_BODY_BYTES = 1_000_000; // 1 MB

/** JSON-parse the raw body for `trigger.body`; the raw text when it isn't JSON. */
function parseWebhookBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Validate the HMAC signature (over the RAW body) when the webhook requires one. */
async function checkWebhookSignature(
  webhook: WorkflowWebhookRow,
  headers: Record<string, string>,
  rawBody: string,
): Promise<WebhookRejection | null> {
  if (!webhook.validateSignature || !webhook.secret) return null;

  const signatureHeader = (webhook.signatureHeader || 'x-webhook-signature').toLowerCase();
  const providedSignature = headers[signatureHeader];
  if (!providedSignature) return { error: 'Missing signature', status: 401 };

  const expectedSignature = await computeWebhookHmacHex(webhook.secret, rawBody);

  const isValid =
    constantTimeEqual(providedSignature, expectedSignature) ||
    constantTimeEqual(providedSignature, `sha256=${expectedSignature}`);
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

  // Reject oversized bodies before buffering them. The Content-Length header
  // is a fast path (absent/lying senders still hit the actual-size check
  // below, after a bounded read).
  const contentLength = Number(c.req.header('content-length') ?? '0');
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: 'Payload too large' }, 413);
  }

  // Read the body ONCE, as raw text — this is the exact byte string the
  // sender signed. Re-serializing a parsed JSON object (the previous
  // behaviour) reformats whitespace/key order and makes every real signature
  // fail to verify.
  const rawBody = await c.req.text();
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return c.json({ error: 'Payload too large' }, 413);
  }
  const body = parseWebhookBody(rawBody);

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const query: Record<string, string> = {};
  const url = new URL(c.req.url);
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  // Webhooks live in tenant DBs — resolve the owning workspace via the
  // master registry (KV-cached; never a tenant-DB scan — see
  // services/workflow-webhook-registry.ts).
  const workspaceId = await resolveWebhookWorkspace(registryDeps(c.env), webhookId);
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
    (await checkWebhookSignature(webhook, headers, rawBody)) ??
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
    // startRun pre-creates the `workflow_executions` row (a real `wex_` id)
    // before starting the CF Workflow instance, same as a manual trigger or a
    // retry — the legacy response below still reports it as `executionId`.
    const { executionId } = await startRun(db, executeWorkflow, {
      workspaceId,
      userId: workflow.createdBy || 'webhook',
      workflow,
      triggerType: 'webhook',
      triggerId: webhook.triggerId,
      triggerData: {
        webhookId: webhook.id,
        headers,
        body,
        query,
        sourceIp,
        receivedAt: new Date().toISOString(),
      },
    });

    await updateWebhookStats(db, webhookId, true, sourceIp);

    return c.json({
      success: true,
      executionId,
    });
  } catch (err) {
    console.error('[WebhookReceiver] Failed to dispatch workflow:', err);
    await updateWebhookStats(db, webhookId, false, sourceIp);
    return c.json({ error: 'Failed to trigger workflow' }, 500);
  }
});

export const publicWorkflowWebhookRoutes = app;
