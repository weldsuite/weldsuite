/**
 * Internal service-to-service WeldConnect action routes —
 * `/api/internal/workflow-actions/*`.
 *
 * Moved here from app-api's internal router (routes/internal/index.ts) with
 * the rest of the connect module; @weldsuite/api-modules gives connect the
 * `/api/internal/workflow-actions` prefix (longest prefix wins over core's
 * `/api/internal`), so app-api's forwarder hands these calls to this worker.
 *
 * Caller: workflow-worker's create_customer action
 * (apps/workers/workflow-worker/src/engine/actions/customer.ts), over its
 * `CONNECT_INTERNAL` binding to the `ConnectInternal` entrypoint (no secret).
 *
 * The PUBLIC mount (registered BEFORE the global /api/* Clerk guard in
 * src/index.ts, reached through app-api's forwarder) stays until every caller
 * uses the entrypoint; it authenticates in-route with a shared-secret bearer:
 * `Authorization: Bearer <INTERNAL_API_SECRET>`, identical to app-api's
 * internal router.
 *
 * Response shapes intentionally preserve the LEGACY internal contract
 * ({ success, ... } / { success:false, error }) rather than the app-api
 * { data }/{ error } envelope. This is a machine contract, not a
 * platform-consumed route.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { createCustomerFromWorkflow } from '../../services/workflow-actions';

export const internalWorkflowActionsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Auth — requests through the `ConnectInternal` entrypoint (service binding
// only) are trusted by topology; the public mount keeps the shared
// INTERNAL_API_SECRET bearer on every route until all callers use the
// entrypoint (same check as app-api's routes/internal/index.ts).
// ---------------------------------------------------------------------------

internalWorkflowActionsRoutes.use('*', async (c, next) => {
  if (c.get('internalTrusted') === true) {
    await next();
    return;
  }

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
// POST /create-customer — WeldConnect `create_customer` step
// (apps/workers/workflow-worker/src/engine/actions/customer.ts). Creates a CRM
// company through the companies service and publishes `company:created` with
// the run's chain depth so workflows listening to it can't loop forever.
// ---------------------------------------------------------------------------

const optionalTrimmed = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined));

const createCustomerSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  chainDepth: z.number().int().min(0).default(0),
  skipIfEmailExists: z.boolean().default(true),
  customer: z.object({
    name: z.string().trim().min(1).max(255),
    email: optionalTrimmed(255).refine((v) => v === undefined || z.string().email().safeParse(v).success, {
      message: 'Invalid email address',
    }),
    phone: optionalTrimmed(50),
    website: optionalTrimmed(500),
    notes: optionalTrimmed(10000),
    status: optionalTrimmed(50),
  }),
});

internalWorkflowActionsRoutes.post(
  '/create-customer',
  zValidator('json', createCustomerSchema),
  async (c) => {
    const { workspaceId, userId, chainDepth, skipIfEmailExists, customer } = c.req.valid('json');
    try {
      const db = await getTenantDbForWorkspace(c.env, workspaceId);
      const { created, company } = await createCustomerFromWorkflow(db, {
        ...customer,
        userId,
        skipIfEmailExists,
      });

      if (created) {
        await publishEntityEventRaw({
          env: c.env,
          workspaceId,
          userId,
          entityType: 'company',
          action: 'created',
          entityId: company.id,
          data: {
            id: company.id,
            name: company.name,
            email: company.email,
            phone: company.phone,
            website: company.website,
            industry: company.industry,
            status: company.status,
          },
          workflowDepth: chainDepth,
        });
      }

      return c.json({
        success: true,
        created,
        customer: { id: company.id, name: company.name, email: company.email, status: company.status },
      });
    } catch (err) {
      console.error('[Internal] Workflow create-customer failed:', err);
      return c.json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  },
);
