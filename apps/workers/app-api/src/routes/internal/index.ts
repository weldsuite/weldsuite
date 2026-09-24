/**
 * Internal service-to-service routes — successor to the legacy api-worker
 * `/api/internal/*` surface (apps/api-worker/src/routes/internal/index.ts;
 * W3 of the legacy-worker phase-out plan).
 *
 * PUBLIC mount (must be registered BEFORE the global /api/* Clerk guard in
 * src/index.ts) — auth is enforced in-route via a shared-secret bearer:
 * `Authorization: Bearer <INTERNAL_API_SECRET>`. Callers: workflow-worker's
 * send_email and create_customer actions
 * (apps/workers/workflow-worker/src/engine/actions/{communication,customer}.ts).
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

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import type { Env } from '../../types';
import { getTenantDbForWorkspace } from '../../db';
import {
  sendInternalEmail,
  sendInternalTransactionalEmail,
} from '../../services/internal-email';
import { createCustomerFromWorkflow } from '../../services/workflow-actions';

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
// POST /workflow-actions/create-customer — WeldConnect `create_customer` step
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

internalRoutes.post(
  '/workflow-actions/create-customer',
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

const fulfillPhoneNumberSchema = z.object({
  clerkOrgId: z.string().min(1),
  phoneNumber: z.string().min(1),
  countryCode: z.string().min(2).max(5),
  numberType: z.string().min(1),
  addressId: z.string().optional(),
  displayName: z.string().optional(),
  friendlyName: z.string().optional(),
  voipPhoneNumberId: z.string().optional(),
});

internalRoutes.post(
  '/telephony/fulfill-number',
  zValidator('json', fulfillPhoneNumberSchema),
  async (c) => {
    try {
      const { fulfillPaidPhoneNumber } = await import('../../services/phone-number-order');
      const result = await fulfillPaidPhoneNumber(c.env, c.req.valid('json'));
      return c.json({ success: true, ...result });
    } catch (err) {
      console.error('[Internal] Phone fulfill failed:', err);
      return c.json(
        { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
        500,
      );
    }
  },
);
