/**
 * Credits routes — /api/credits/* surface for the unified credits system.
 * Ported from apps/api-worker/src/routes/credits/index.ts.
 *
 * All credit data lives in the MASTER database, scoped by the internal
 * `workspaceId`. The `/api/*` middleware sets `c.get('workspaceId')` to the
 * Clerk org id, so each handler resolves the internal workspace id from the
 * master `workspaces` table first.
 *
 * Response shape preserved as `{ success, data }` to match the existing
 * api-worker contract its platform consumers still expect. No object-level
 * `requirePermission` on reads (mirrors the source) — Clerk auth + org
 * resolution is enforced by the shared `/api/*` middleware. The topup
 * checkout (`POST /checkout`) requires `billing:manage`.
 *
 * Nothing here writes the balance. Workspace members must never be able to
 * grant, refund or reallocate their own credits, and an OWNER holds
 * `billing:manage`, so that permission is no guard. Grants come only from
 * billing-worker: Stripe webhooks (plan allowance, topups) and the
 * admin-secret `/api/internal/admin` routes. Consumption happens in the
 * workers that run the metered service, through `@weldsuite/credits`.
 *
 * `POST /checkout` proxies to billing-worker (Stripe Checkout session +
 * webhook grant). App-api never mutates the prepaid balance on checkout —
 * that remains webhook-owned on billing-worker.
 *
 * No entity events: billing ledger writes live in master and are not fanned
 * out over the entity bus.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { LOW_BALANCE_THRESHOLD } from '@weldsuite/credits';
import type { PlanFeatures } from '@weldsuite/db/schema/plans';
import type { Env, Variables } from '../../types';
import { getMasterDb, masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { getOrCreateWorkspaceCredits, createCreditTopupCheckout } from '../../services/credits';
import { success, error as apiError } from '@weldsuite/worker-kit/response';
import { creditTopupCheckoutSchema } from '@weldsuite/app-api-client/schemas/credits';

const { creditTransactions, creditPackages, workspaces, plans } = masterSchema;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Resolve the internal workspace id from the Clerk org id stored in
 * `c.get('workspaceId')`. Credit data is keyed by the internal id, not the
 * Clerk org id.
 */
async function resolveWorkspaceId(masterDb: MasterDatabase, clerkOrgId: string): Promise<string | null> {
  const [row] = await masterDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, clerkOrgId))
    .limit(1);
  return row?.id ?? null;
}

function getDaysRemaining(periodEnd: Date): number {
  const now = new Date();
  const diff = periodEnd.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

const DEFAULT_CREDIT_RATES = {
  aiTokens: 1,
  parcelLabel: 10,
  meetingBotMinute: 2,
  callTranscriptionMinute: 2,
  voipCallMinute: 3,
  transcriptionProvider: 'assemblyai' as 'assemblyai' | 'openai',
  hunterEmailFinder: 2,
  hunterEmailVerifier: 1,
  hunterDomainSearch: 5,
};

// ============================================================================
// GET /balance
// ============================================================================

app.get('/balance', async (c) => {
  try {
    const masterDb = getMasterDb(c.env);
    const workspaceId = await resolveWorkspaceId(masterDb, c.get('workspaceId'));
    if (!workspaceId) return c.json({ error: 'org_required', message: 'Organization context required' }, 403);

    const credits = await getOrCreateWorkspaceCredits(masterDb, workspaceId);

    const daysRemaining = getDaysRemaining(new Date(credits.periodEnd));
    const usagePercentage =
      credits.monthlyAllocation > 0
        ? Math.round(
            ((credits.monthlyAllocation - credits.currentBalance + credits.rolledOverCredits) /
              credits.monthlyAllocation) *
              100,
          )
        : 0;

    return c.json({
      success: true,
      data: {
        currentBalance: credits.currentBalance,
        planCredits: credits.planCredits || 0,
        subscribedCredits: credits.subscribedCredits || 0,
        monthlyAllocation: credits.monthlyAllocation,
        rolledOverCredits: credits.rolledOverCredits,
        periodStart: credits.periodStart,
        periodEnd: credits.periodEnd,
        daysRemaining,
        usagePercentage: Math.max(0, Math.min(100, usagePercentage)),
        // Prepaid wallet semantics: "low" is an absolute threshold, not a
        // fraction of a monthly allocation (base-fee plans have allocation 0).
        isLow: credits.currentBalance < LOW_BALANCE_THRESHOLD,
        isExhausted: credits.currentBalance <= 0,
      },
    });
  } catch (err) {
    console.error('[app-api/credits] balance failed:', err);
    return c.json({ error: 'internal_error', message: 'Failed to fetch balance' }, 500);
  }
});

// ============================================================================
// GET /transactions
// ============================================================================

const transactionsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
  type: z.string().optional(),
  serviceType: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

app.get('/transactions', zValidator('query', transactionsQuerySchema), async (c) => {
  const { page, pageSize, type, serviceType, from, to } = c.req.valid('query');

  try {
    const masterDb = getMasterDb(c.env);
    const workspaceId = await resolveWorkspaceId(masterDb, c.get('workspaceId'));
    if (!workspaceId) return c.json({ error: 'org_required', message: 'Organization context required' }, 403);

    const conditions = [eq(creditTransactions.workspaceId, workspaceId)];
    if (type) conditions.push(eq(creditTransactions.type, type));
    if (serviceType) conditions.push(eq(creditTransactions.serviceType, serviceType));
    if (from) conditions.push(gte(creditTransactions.createdAt, new Date(from)));
    if (to) conditions.push(lte(creditTransactions.createdAt, new Date(to)));

    const countResult = await masterDb
      .select({ count: sql<number>`count(*)::int` })
      .from(creditTransactions)
      .where(and(...conditions));

    const totalCount = countResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / pageSize);
    const offset = (page - 1) * pageSize;

    const transactions = await masterDb
      .select()
      .from(creditTransactions)
      .where(and(...conditions))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(pageSize)
      .offset(offset);

    return c.json({
      success: true,
      data: transactions.map((t) => ({ ...t, createdAt: t.createdAt?.toISOString() })),
      pagination: { page, pageSize, totalCount, totalPages, hasMore: page < totalPages },
    });
  } catch (err) {
    console.error('[app-api/credits] transactions failed:', err);
    return c.json({ error: 'internal_error', message: 'Failed to fetch transactions' }, 500);
  }
});

// ============================================================================
// POST /check
// ============================================================================

const checkAvailabilitySchema = z.object({ amount: z.number().min(1) });

app.post('/check', zValidator('json', checkAvailabilitySchema), async (c) => {
  const { amount } = c.req.valid('json');

  try {
    const masterDb = getMasterDb(c.env);
    const workspaceId = await resolveWorkspaceId(masterDb, c.get('workspaceId'));
    if (!workspaceId) return c.json({ error: 'org_required', message: 'Organization context required' }, 403);

    const credits = await getOrCreateWorkspaceCredits(masterDb, workspaceId);
    const available = credits.currentBalance >= amount;
    const shortfall = available ? 0 : amount - credits.currentBalance;

    return c.json({
      success: true,
      data: {
        available,
        currentBalance: credits.currentBalance,
        required: amount,
        shortfall,
        message: available ? undefined : `Insufficient credits. You need ${shortfall} more credits.`,
      },
    });
  } catch (err) {
    console.error('[app-api/credits] check failed:', err);
    return c.json({ error: 'internal_error', message: 'Failed to check availability' }, 500);
  }
});

// ============================================================================
// GET /packages
// ============================================================================

app.get('/packages', async (c) => {
  try {
    const masterDb = getMasterDb(c.env);
    const packages = await masterDb
      .select()
      .from(creditPackages)
      .where(eq(creditPackages.isActive, 1))
      .orderBy(creditPackages.sortOrder);

    return c.json({
      success: true,
      data: packages.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        credits: p.credits,
        price: Number(p.price),
        currency: p.currency,
        stripePriceId: p.stripePriceId,
        isPopular: p.isPopular === 1,
      })),
    });
  } catch (err) {
    console.error('[app-api/credits] packages failed:', err);
    return c.json({ error: 'internal_error', message: 'Failed to fetch packages' }, 500);
  }
});

// ============================================================================
// GET /rates
// ============================================================================

app.get('/rates', async (c) => {
  try {
    const masterDb = getMasterDb(c.env);
    const workspaceId = await resolveWorkspaceId(masterDb, c.get('workspaceId'));
    if (!workspaceId) return c.json({ error: 'org_required', message: 'Organization context required' }, 403);

    const [workspace] = await masterDb
      .select({ planId: workspaces.planId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    let rates = DEFAULT_CREDIT_RATES;
    if (workspace?.planId) {
      const [plan] = await masterDb
        .select({ features: plans.features })
        .from(plans)
        .where(eq(plans.id, workspace.planId));

      const features = (plan?.features || {}) as PlanFeatures;
      if (features.creditRates) {
        rates = { ...DEFAULT_CREDIT_RATES, ...features.creditRates };
      }
    }

    return c.json({ success: true, data: rates });
  } catch (err) {
    console.error('[app-api/credits] rates failed:', err);
    return c.json({ success: true, data: DEFAULT_CREDIT_RATES });
  }
});

// ============================================================================
// GET /usage
// ============================================================================

app.get('/usage', async (c) => {
  try {
    const masterDb = getMasterDb(c.env);
    const workspaceId = await resolveWorkspaceId(masterDb, c.get('workspaceId'));
    if (!workspaceId) return c.json({ error: 'org_required', message: 'Organization context required' }, 403);

    const credits = await getOrCreateWorkspaceCredits(masterDb, workspaceId);

    const usageByService = await masterDb
      .select({
        serviceType: creditTransactions.serviceType,
        totalCredits: sql<number>`SUM(ABS(${creditTransactions.amount}))::int`,
        transactionCount: sql<number>`COUNT(*)::int`,
      })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.workspaceId, workspaceId),
          eq(creditTransactions.type, 'consumption'),
          gte(creditTransactions.createdAt, new Date(credits.periodStart)),
        ),
      )
      .groupBy(creditTransactions.serviceType);

    const usage: Record<string, { credits: number; count: number }> = {};
    let totalConsumed = 0;
    for (const row of usageByService) {
      if (row.serviceType) {
        usage[row.serviceType] = { credits: row.totalCredits || 0, count: row.transactionCount || 0 };
        totalConsumed += row.totalCredits || 0;
      }
    }

    return c.json({
      success: true,
      data: {
        periodStart: credits.periodStart,
        periodEnd: credits.periodEnd,
        totalAllocated: credits.monthlyAllocation + credits.rolledOverCredits,
        totalConsumed,
        totalRemaining: credits.currentBalance,
        byService: usage,
      },
    });
  } catch (err) {
    console.error('[app-api/credits] usage failed:', err);
    return c.json({ error: 'internal_error', message: 'Failed to fetch usage' }, 500);
  }
});

// ============================================================================
// GET /subscription
// ============================================================================

app.get('/subscription', async (c) => {
  try {
    const masterDb = getMasterDb(c.env);
    const workspaceId = await resolveWorkspaceId(masterDb, c.get('workspaceId'));
    if (!workspaceId) return c.json({ error: 'org_required', message: 'Organization context required' }, 403);

    const credits = await getOrCreateWorkspaceCredits(masterDb, workspaceId);

    return c.json({
      success: true,
      data: {
        planCredits: credits.planCredits || 0,
        subscribedCredits: credits.subscribedCredits || 0,
        totalMonthly: credits.monthlyAllocation,
        stripeItemId: credits.stripeCreditsItemId,
        stripePriceId: credits.stripeCreditsPriceId,
      },
    });
  } catch (err) {
    console.error('[app-api/credits] subscription fetch failed:', err);
    return c.json({ error: 'internal_error', message: 'Failed to fetch subscription credits' }, 500);
  }
});

// ============================================================================
// POST /checkout — Stripe Checkout for a prepaid credit package (proxied)
// ============================================================================

/**
 * Start a prepaid credit topup. Forwards to billing-worker, which creates the
 * Stripe Checkout session; credits are granted by the checkout.session.completed
 * webhook once payment succeeds.
 */
app.post(
  '/checkout',
  requirePermission('billing:manage'),
  zValidator('json', creditTopupCheckoutSchema),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return apiError.orgRequired(c);

    const body = c.req.valid('json');

    const result = await createCreditTopupCheckout({
      env: c.env,
      authorization: c.req.header('Authorization'),
      body,
    });

    if (!result.ok) {
      if (result.error.kind === 'bad_request') return apiError.badRequest(c, result.error.message);
      if (result.error.kind === 'not_found') return apiError.notFound(c, 'Credit package');
      console.error('[app-api/credits] checkout proxy failed:', result.error.message);
      return apiError.internal(c, result.error.message);
    }

    // Match /api/billing/checkout envelope so platform hooks can unwrap `{ data: { url } }`.
    return success(c, { url: result.url });
  },
);

export const creditsRoutes = app;
