/**
 * Internal service-to-service routes — successor to the legacy api-worker
 * `/api/internal/*` surface (apps/api-worker/src/routes/internal/index.ts;
 * W3 of the legacy-worker phase-out plan).
 *
 * PUBLIC mount (must be registered BEFORE the global /api/* Clerk guard in
 * src/index.ts) — auth is enforced in-route via a shared-secret bearer:
 * `Authorization: Bearer <INTERNAL_API_SECRET>`. Callers: workflow-worker's
 * send_email action (apps/workers/workflow-worker/src/engine/actions/communication.ts).
 * The caller's INTERNAL_API_SECRET must match this worker's (ops contract).
 *
 * Deliberately NOT ported from the legacy surface: the workspace-database
 * delete endpoint and the AI endpoints (both dead — zero callers).
 *
 * Response shapes intentionally preserve the LEGACY contract
 * ({ success, messageId } / { success:false, error }) rather than the app-api
 * { data }/{ error } envelope — workflow-worker (and previously Trigger.dev
 * tasks) parse `result.messageId` off the top level. This is a machine
 * contract, not a platform-consumed route.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import type { Env } from '../../types';
import {
  sendInternalEmail,
  sendInternalTransactionalEmail,
} from '../../services/internal-email';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '../../db';
import {
  publishPost,
  PostPeerNotConfiguredError,
  SocialPublishConflictError,
  SocialInsufficientCreditsError,
} from '../../services/social-publishing';

export const internalRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Auth — shared INTERNAL_API_SECRET bearer on every route. (The legacy
// api-worker m2mAuth also accepted Clerk M2M tokens; that fallback had no
// remaining callers and is intentionally dropped here.)
// ---------------------------------------------------------------------------

internalRoutes.use('*', async (c, next) => {
  const secret = c.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error('[Internal API] INTERNAL_API_SECRET is not configured');
    return c.json({ error: 'Internal auth not configured' }, 503);
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  if (authHeader.slice(7) !== secret) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});

// ---------------------------------------------------------------------------
// POST /send-email — regular outbound email (workflow send_email action).
// Payload contract identical to the legacy api-worker endpoint.
// ---------------------------------------------------------------------------

const internalSendEmailSchema = z.object({
  from: z.string().min(1),
  to: z.array(z.string()).min(1),
  subject: z.string().min(1),
  html: z.string().optional(),
  text: z.string().optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  // Accepted for contract compatibility with legacy callers; unused (the
  // send path is workspace-agnostic — the caller resolves the from-account).
  workspaceId: z.string().optional(),
});

internalRoutes.post('/send-email', zValidator('json', internalSendEmailSchema), async (c) => {
  const data = c.req.valid('json');

  try {
    const result = await sendInternalEmail(c.env, {
      from: data.from,
      to: data.to,
      subject: data.subject,
      html: data.html,
      text: data.text,
      cc: data.cc,
      bcc: data.bcc,
      headers: data.headers,
    });

    return c.json({ success: true, messageId: result.messageId });
  } catch (err) {
    console.error('[Internal] Send email failed:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /send-transactional-email — Resend (from @mail.weldsuite.org), with
// fallback to the regular send path when RESEND_API_KEY is unset.
// ---------------------------------------------------------------------------

const internalTransactionalEmailSchema = z.object({
  from: z.string().min(1),
  to: z.array(z.string()).min(1),
  subject: z.string().min(1),
  html: z.string().optional(),
  text: z.string().optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  headers: z.record(z.string()).optional(),
});

internalRoutes.post(
  '/send-transactional-email',
  zValidator('json', internalTransactionalEmailSchema),
  async (c) => {
    const data = c.req.valid('json');

    try {
      const result = await sendInternalTransactionalEmail(c.env, {
        from: data.from,
        to: data.to,
        subject: data.subject,
        html: data.html,
        text: data.text,
        cc: data.cc,
        bcc: data.bcc,
        headers: data.headers,
      });

      return c.json({ success: true, messageId: result.messageId });
    } catch (err) {
      console.error('[Internal] Send transactional email failed:', err);
      return c.json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /social-posts/publish  +  /social-posts/schedule
//
// Why these live here rather than being reimplemented in external-api /
// mcp-server: `publishPost` writes a KV mapping (`pp:post:<id>` on
// WORKSPACE_CACHE) that the PostPeer delivery webhook — which lands on THIS
// worker at /public/social/postpeer/webhook — reads to resolve the tenant.
// A copy of the publish logic running in another worker would write that
// mapping into a different KV namespace, and every delivery webhook would then
// fail to reconcile, leaving posts stuck in `publishing` forever. Keeping the
// PostPeer call, the credit metering and the KV write in one worker removes
// that whole failure mode, and POSTPEER_API_KEY stays on a single worker.
//
// Unlike the email routes above, these use the app-api `{ data }` / `{ error }`
// envelope rather than the legacy `{ success }` shape — the callers forward the
// response straight through to their own v1 clients.
// ---------------------------------------------------------------------------

const internalSocialPublishSchema = z.object({
  /** Master `workspaces.id` — the internal id, NOT the Clerk org id. */
  workspaceId: z.string().min(1),
  postId: z.string().min(1),
  /** Actor for the entity event; falls back to the workspace id. */
  actorUserId: z.string().optional(),
});

const internalSocialScheduleSchema = internalSocialPublishSchema.extend({
  scheduledAt: z.string().datetime({ offset: true }),
  timezone: z.string().max(50).optional(),
});

type InternalPublishBody = z.infer<typeof internalSocialPublishSchema>;

/**
 * Shared body for both endpoints: resolve the Clerk org id (which is what
 * `publishPost` keys the tenant DB, credit metering and the webhook KV map on)
 * from the internal workspace id the caller holds, then publish or schedule.
 */
async function handleInternalPublish(
  c: Context<{ Bindings: Env }>,
  body: InternalPublishBody,
  options: { now: true } | { now: false; scheduledAt: string; timezone?: string },
) {
  const masterDb = getMasterDb(c.env);
  const [workspace] = await masterDb
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.id, body.workspaceId))
    .limit(1);

  const orgId = workspace?.clerkOrgId;
  if (!orgId) {
    return c.json(
      {
        error: {
          code: 'WORKSPACE_NOT_FOUND',
          message: `No Clerk organization for workspace ${body.workspaceId}`,
        },
      },
      404,
    );
  }

  const db = await getTenantDbForWorkspace(c.env, orgId);

  try {
    const result = await publishPost(db, c.env, orgId, body.postId, options);

    // Emitted here rather than in the caller so a post published through the
    // public API reaches the same audit / workflow / analytics / realtime sinks
    // as one published from the platform UI, with the same workspace key
    // (the Clerk org id) that platform-originated events carry.
    c.executionCtx.waitUntil(
      publishEntityEventRaw({
        env: c.env,
        db,
        workspaceId: orgId,
        userId: body.actorUserId ?? body.workspaceId,
        entityType: 'social_post',
        action: options.now ? (result.status === 'failed' ? 'failed' : 'published') : 'scheduled',
        entityId: body.postId,
        data: {
          id: body.postId,
          status: result.status,
          postpeerPostId: result.postpeerPostId,
          ...(options.now ? {} : { scheduledAt: options.scheduledAt }),
        },
        source: 'api',
      }),
    );

    return c.json({ data: result });
  } catch (err) {
    if (err instanceof PostPeerNotConfiguredError) {
      return c.json(
        { error: { code: 'SOCIAL_PUBLISHING_NOT_CONFIGURED', message: 'Social publishing is not configured' } },
        503,
      );
    }
    if (err instanceof SocialPublishConflictError) {
      return c.json({ error: { code: 'CONFLICT', message: err.message } }, 409);
    }
    if (err instanceof SocialInsufficientCreditsError) {
      return c.json(
        {
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: err.message,
            details: {
              currentBalance: err.currentBalance,
              required: err.required,
              shortfall: err.required - err.currentBalance,
            },
          },
        },
        402,
      );
    }
    const message = err instanceof Error ? err.message : 'Failed to publish post';
    console.error('[Internal] Social publish failed:', err);
    // Missing post / no connected accounts are caller errors, not 500s.
    const isCallerError =
      message.startsWith('Social post not found') ||
      message === 'Post has no target accounts' ||
      message === 'No PostPeer-connected accounts among the post targets';
    return c.json(
      { error: { code: isCallerError ? 'BAD_REQUEST' : 'INTERNAL_ERROR', message } },
      isCallerError ? 400 : 500,
    );
  }
}

internalRoutes.post('/social-posts/publish', zValidator('json', internalSocialPublishSchema), async (c) =>
  handleInternalPublish(c, c.req.valid('json'), { now: true }),
);

internalRoutes.post('/social-posts/schedule', zValidator('json', internalSocialScheduleSchema), async (c) => {
  const body = c.req.valid('json');
  return handleInternalPublish(c, body, {
    now: false,
    scheduledAt: body.scheduledAt,
    timezone: body.timezone,
  });
});
