/**
 * Admin billing API — /api/internal/admin/*
 *
 * Called server-to-server by the internal admin console (apps/web/admin) so
 * WeldSuite staff can manage a customer's billing without opening Stripe:
 * change plan/seats/cycle, cancel or reactivate, extend a trial, apply a
 * discount, grant or end a comp plan, adjust credits, refund a payment, void
 * an invoice, and edit the plan catalog (synced to Stripe).
 *
 * Auth: shared secret + acting admin identity (middleware/admin-auth.ts).
 * Every write needs a `reason` and an `x-request-id` (one per form submit; it
 * becomes the Stripe idempotency key) and is recorded in admin_audit_events,
 * successful or not.
 *
 * Responses: `{ data }` on success, `{ error: { code, message } }` otherwise.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getMasterDb } from '../lib/db';
import { adminAuth } from '../middleware/admin-auth';
import { recordAdminAudit } from '../lib/admin-audit';
import { REQUEST_ID, errorMessage, errorResponse, parseBody, type AdminEnv, type AdminCtx } from './admin-http';
import { adminPartnerRoutes } from './admin-partners';
import {
  AdminBillingError,
  type AdminContext,
  adjustCredits,
  applyDiscount,
  cancelSubscription,
  changeSubscription,
  endComp,
  getStripeSnapshot,
  grantComp,
  previewSubscriptionChange,
  reactivateSubscription,
  refundPayment,
  removeDiscount,
  setTrialEnd,
  voidInvoice,
} from '../services/admin-billing';
import { createPlan, resyncPlan, updatePlan } from '../services/admin-plans';
import type { AdminAuditTargetType } from '@weldsuite/db/schema/master';

export { stripeFailure } from './admin-http';

export const adminRoutes = new Hono<AdminEnv>();
adminRoutes.use('*', adminAuth());

// Reseller partners: /api/internal/admin/partners/*
adminRoutes.route('/partners', adminPartnerRoutes);

// ============================================================================
// Request schemas (Zod v3)
// ============================================================================

const reason = z.string().trim().min(3, 'Give a reason of at least 3 characters').max(500);
const id = z.string().trim().min(1).max(255);
const isoDate = z.string().datetime({ offset: true });
const money = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Use an amount like 12 or 12.50');
const optionalInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable();

const subscriptionChangeSchema = z.object({
  planId: id,
  cycle: z.enum(['monthly', 'yearly']),
  seats: z.number().int().min(1).max(100_000),
  proration: z.enum(['always_invoice', 'create_prorations', 'none']).default('always_invoice'),
  collectionMethod: z.enum(['charge_automatically', 'send_invoice']).optional(),
  daysUntilDue: z.number().int().min(1).max(90).optional(),
});

const schemas = {
  preview: subscriptionChangeSchema,
  change: subscriptionChangeSchema.extend({ reason }),
  cancel: z.object({ mode: z.enum(['period_end', 'immediately']), reason }),
  simple: z.object({ reason }),
  trial: z.object({ trialEnd: isoDate, reason }),
  discount: z
    .object({
      percentOff: z.number().min(0.01).max(100).optional(),
      amountOffCents: z.number().int().min(1).max(100_000_000).optional(),
      duration: z.enum(['once', 'repeating', 'forever']),
      durationInMonths: z.number().int().min(1).max(36).optional(),
      reason,
    })
    .refine((v) => (v.percentOff === undefined) !== (v.amountOffCents === undefined), {
      message: 'Give either a percentage or a fixed amount off',
    })
    .refine((v) => v.duration !== 'repeating' || v.durationInMonths !== undefined, {
      message: 'A repeating discount needs a number of months',
    }),
  comp: z.object({
    planId: id,
    seats: z.number().int().min(0).max(100_000),
    endsAt: isoDate.nullable(),
    cancelStripeSubscription: z.boolean(),
    reason,
  }),
  credits: z.object({
    amount: z
      .number()
      .int()
      .min(-10_000_000)
      .max(10_000_000)
      .refine((n) => n !== 0, 'Amount cannot be zero'),
    reason,
  }),
  refund: z.object({ amountCents: z.number().int().min(1).optional(), reason }),
};

const planFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullable(),
  priceMonthly: money,
  priceYearly: money,
  currency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/),
  pricePerUser: money.nullable(),
  includedUsers: optionalInt(0, 100_000),
  monthlyCredits: z.number().int().min(0).max(100_000_000),
  creditsRolloverCap: optionalInt(0, 1_000_000_000),
  maxUsers: optionalInt(0, 100_000),
  maxProjects: optionalInt(0, 1_000_000),
  maxCustomDomains: optionalInt(0, 100_000),
  removeBranding: z.boolean(),
  hasApiAccess: z.boolean(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  sortOrder: z.number().int().min(-10_000).max(10_000),
  badge: z.string().trim().max(50).nullable(),
  color: z.string().trim().max(20).nullable(),
  // PlanFeatures: flat flags/limits, plus the nested creditRates object.
  features: z.record(
    z.union([
      z.object({ aiTokens: z.number(), parcelLabel: z.number(), meetingBotMinute: z.number() }),
      z.string().max(500),
      z.number(),
      z.boolean(),
      z.null(),
    ]),
  ),
};

const planCreateSchema = z.object({
  ...planFields,
  slug: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and dashes'),
  reason,
});
const planUpdateSchema = z.object(planFields).partial().extend({ reason });

// ============================================================================
// Helpers
// ============================================================================

interface ActionSpec<B> {
  action: string;
  targetType: AdminAuditTargetType;
  /** Resolved after the body is parsed (plans get their id from the result). */
  target: (body: B) => { targetId: string; workspaceId: string | null };
  /** Request fields worth keeping in the audit row (never secrets). */
  details?: (body: B) => Record<string, unknown>;
}

/**
 * Parse, run, audit, respond. Each write goes through here so no change can
 * skip the audit trail, and a failed attempt is recorded as well.
 */
async function runAction<T extends z.ZodTypeAny, R>(
  c: AdminCtx,
  schema: T,
  spec: ActionSpec<z.infer<T>>,
  run: (ctx: AdminContext, body: z.infer<T>) => Promise<R>,
  auditTargetOf?: (result: R) => string,
) {
  const masterDb = getMasterDb(c.env);
  const actor = c.get('adminActor');
  const requestId = c.req.header('x-request-id') ?? '';

  let body: z.infer<T>;
  try {
    if (!REQUEST_ID.test(requestId)) {
      throw new AdminBillingError('BAD_REQUEST', 'x-request-id must be 8-100 letters, digits, - or _');
    }
    body = await parseBody(c, schema);
  } catch (err) {
    return errorResponse(c, err);
  }

  const { targetId, workspaceId } = spec.target(body);
  const audit = {
    actor,
    workspaceId,
    targetType: spec.targetType,
    action: spec.action,
    reason: (body as { reason: string }).reason,
  };
  const requestDetails = { requestId, ...(spec.details?.(body) ?? {}) };

  try {
    const result = await run({ env: c.env, masterDb, actor, requestId, reason: audit.reason }, body);
    await recordAdminAudit(masterDb, {
      ...audit,
      targetId: auditTargetOf ? auditTargetOf(result) : targetId,
      outcome: 'success',
      details: { ...requestDetails, result: result as unknown as Record<string, unknown> },
    });
    return c.json({ data: result });
  } catch (err) {
    await recordAdminAudit(masterDb, {
      ...audit,
      targetId,
      outcome: 'failure',
      details: requestDetails,
      error: errorMessage(err),
    });
    return errorResponse(c, err);
  }
}

const onWorkspace = (c: AdminCtx) => {
  const workspaceId = c.req.param('workspaceId')!;
  return () => ({ targetId: workspaceId, workspaceId });
};

// ============================================================================
// Reads
// ============================================================================

adminRoutes.get('/workspaces/:workspaceId/stripe', async (c) => {
  try {
    return c.json({ data: await getStripeSnapshot(c.env, getMasterDb(c.env), c.req.param('workspaceId')) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

adminRoutes.post('/workspaces/:workspaceId/subscription/preview', async (c) => {
  try {
    const body = await parseBody(c, schemas.preview);
    const preview = await previewSubscriptionChange(
      { env: c.env, masterDb: getMasterDb(c.env) },
      c.req.param('workspaceId'),
      body,
    );
    return c.json({ data: preview });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ============================================================================
// Workspace billing writes
// ============================================================================

adminRoutes.post('/workspaces/:workspaceId/subscription', (c) =>
  runAction(
    c,
    schemas.change,
    {
      action: 'subscription.change',
      targetType: 'workspace',
      target: onWorkspace(c),
      details: ({ reason: _r, ...input }) => input,
    },
    (ctx, { reason: _r, ...input }) => changeSubscription(ctx, c.req.param('workspaceId'), input),
  ),
);

adminRoutes.post('/workspaces/:workspaceId/subscription/cancel', (c) =>
  runAction(
    c,
    schemas.cancel,
    {
      action: 'subscription.cancel',
      targetType: 'workspace',
      target: onWorkspace(c),
      details: (b) => ({ mode: b.mode }),
    },
    (ctx, body) => cancelSubscription(ctx, c.req.param('workspaceId'), body.mode),
  ),
);

adminRoutes.post('/workspaces/:workspaceId/subscription/reactivate', (c) =>
  runAction(c, schemas.simple, { action: 'subscription.reactivate', targetType: 'workspace', target: onWorkspace(c) }, (ctx) =>
    reactivateSubscription(ctx, c.req.param('workspaceId')),
  ),
);

adminRoutes.post('/workspaces/:workspaceId/subscription/trial', (c) =>
  runAction(
    c,
    schemas.trial,
    {
      action: 'subscription.trial',
      targetType: 'workspace',
      target: onWorkspace(c),
      details: (b) => ({ trialEnd: b.trialEnd }),
    },
    (ctx, body) => setTrialEnd(ctx, c.req.param('workspaceId'), new Date(body.trialEnd)),
  ),
);

adminRoutes.post('/workspaces/:workspaceId/subscription/discount', (c) =>
  runAction(
    c,
    schemas.discount,
    {
      action: 'discount.apply',
      targetType: 'workspace',
      target: onWorkspace(c),
      details: ({ reason: _r, ...input }) => input,
    },
    (ctx, { reason: _r, ...input }) => applyDiscount(ctx, c.req.param('workspaceId'), input),
  ),
);

adminRoutes.post('/workspaces/:workspaceId/subscription/discount/remove', (c) =>
  runAction(c, schemas.simple, { action: 'discount.remove', targetType: 'workspace', target: onWorkspace(c) }, (ctx) =>
    removeDiscount(ctx, c.req.param('workspaceId')),
  ),
);

adminRoutes.post('/workspaces/:workspaceId/comp', (c) =>
  runAction(
    c,
    schemas.comp,
    {
      action: 'comp.grant',
      targetType: 'workspace',
      target: onWorkspace(c),
      details: ({ reason: _r, ...input }) => input,
    },
    (ctx, body) =>
      grantComp(ctx, c.req.param('workspaceId'), {
        planId: body.planId,
        seats: body.seats,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        cancelStripeSubscription: body.cancelStripeSubscription,
      }),
  ),
);

adminRoutes.post('/workspaces/:workspaceId/comp/end', (c) =>
  runAction(c, schemas.simple, { action: 'comp.end', targetType: 'workspace', target: onWorkspace(c) }, (ctx) =>
    endComp(ctx, c.req.param('workspaceId')),
  ),
);

adminRoutes.post('/workspaces/:workspaceId/credits', (c) =>
  runAction(
    c,
    schemas.credits,
    {
      action: 'credits.adjust',
      targetType: 'workspace',
      target: onWorkspace(c),
      details: (b) => ({ amount: b.amount }),
    },
    (ctx, body) => adjustCredits(ctx, c.req.param('workspaceId'), body.amount),
  ),
);

adminRoutes.post('/workspaces/:workspaceId/payments/:paymentId/refund', (c) =>
  runAction(
    c,
    schemas.refund,
    {
      action: 'payment.refund',
      targetType: 'workspace',
      target: onWorkspace(c),
      details: (b) => ({ paymentId: c.req.param('paymentId'), amountCents: b.amountCents ?? 'full' }),
    },
    (ctx, body) => refundPayment(ctx, c.req.param('workspaceId'), c.req.param('paymentId'), body.amountCents),
  ),
);

adminRoutes.post('/workspaces/:workspaceId/invoices/:invoiceId/void', (c) =>
  runAction(
    c,
    schemas.simple,
    {
      action: 'invoice.void',
      targetType: 'workspace',
      target: onWorkspace(c),
      details: () => ({ invoiceId: c.req.param('invoiceId') }),
    },
    (ctx) => voidInvoice(ctx, c.req.param('workspaceId'), c.req.param('invoiceId')),
  ),
);

// ============================================================================
// Plan catalog
// ============================================================================

adminRoutes.post('/plans', (c) =>
  runAction(
    c,
    planCreateSchema,
    {
      action: 'plan.create',
      targetType: 'plan',
      target: (b) => ({ targetId: b.slug, workspaceId: null }),
      details: ({ reason: _r, ...input }) => ({ input }),
    },
    (ctx, { reason: _r, ...input }) => createPlan(ctx.env, ctx.masterDb, input),
    (result) => result.plan.id,
  ),
);

adminRoutes.patch('/plans/:planId', (c) =>
  runAction(
    c,
    planUpdateSchema,
    {
      action: 'plan.update',
      targetType: 'plan',
      target: () => ({ targetId: c.req.param('planId'), workspaceId: null }),
      details: ({ reason: _r, ...patch }) => ({ patch }),
    },
    (ctx, { reason: _r, ...patch }) => updatePlan(ctx.env, ctx.masterDb, c.req.param('planId'), patch),
  ),
);

adminRoutes.post('/plans/:planId/sync', (c) =>
  runAction(
    c,
    schemas.simple,
    { action: 'plan.sync', targetType: 'plan', target: () => ({ targetId: c.req.param('planId'), workspaceId: null }) },
    (ctx) => resyncPlan(ctx.env, ctx.masterDb, c.req.param('planId')),
  ),
);
