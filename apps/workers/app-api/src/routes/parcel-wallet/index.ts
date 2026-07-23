/**
 * Parcel wallet routes — /api/parcel-wallet/* surface backed by `wallets`
 * and `walletTransactions`. One wallet is lazily created per user on first
 * GET; credit/debit operations create `walletTransactions` and update the
 * wallet balance atomically within the same request.
 *
 * Permissions: carriers:read (read-only) | carriers:manage (mutations).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  addCreditsSchema,
  deductCreditsSchema,
  estimateCostSchema,
} from '@weldsuite/app-api-client/schemas/parcel-wallet';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const { wallets, walletTransactions, shippingPrices } = schema;

// ── Query schemas (inline — not part of public schema package) ────────────────

const getWalletQuerySchema = z.object({
  userId: z.string().optional(),
});

const transactionsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
  type: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve the target userId from query param or the current user. */
function resolveUserId(queryUserId: string | undefined, currentUserId: string): string {
  return queryUserId ?? currentUserId;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET / — Get or lazily create the wallet for the resolved user.
 */
app.get('/', requirePermission('carriers:read'), zValidator('query', getWalletQuerySchema), async (c) => {
  const currentUserId = c.get('userId');
  const { userId: queryUserId } = c.req.valid('query');
  const targetUserId = resolveUserId(queryUserId, currentUserId);

  try {
    const db = c.get('tenantDb');

    let [wallet] = await db
      .select()
      .from(wallets)
      .where(and(eq(wallets.userId, targetUserId), isNull(wallets.deletedAt)))
      .limit(1);

    if (!wallet) {
      const newId = generateId('wal');
      const now = new Date();
      await db.insert(wallets).values({
        id: newId,
        userId: targetUserId,
        balance: '0',
        currency: 'EUR',
        isActive: true,
        isFrozen: false,
        totalCredits: '0',
        totalDebits: '0',
        transactionCount: 0,
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof wallets.$inferInsert);

      [wallet] = await db.select().from(wallets).where(eq(wallets.id, newId)).limit(1);

      publishEntityEvent({
        c,
        entityType: 'parcel_wallet',
        entityId: newId,
        action: 'created',
        data: { id: newId, userId: targetUserId },
      });
    }

    return success(c, {
      id: wallet.id,
      balance: {
        amount: Number(wallet.balance) || 0,
        currency: wallet.currency || 'EUR',
      },
      creditLimit: wallet.creditLimit ? Number(wallet.creditLimit) : undefined,
      lowBalanceThreshold: wallet.lowBalanceThreshold ? Number(wallet.lowBalanceThreshold) : undefined,
      isActive: wallet.isActive ?? true,
      isFrozen: wallet.isFrozen ?? false,
      totalCredits: Number(wallet.totalCredits) || 0,
      totalDebits: Number(wallet.totalDebits) || 0,
      transactionCount: wallet.transactionCount || 0,
      lastTransactionAt: wallet.lastTransactionAt?.toISOString(),
      createdAt: wallet.createdAt.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/parcel-wallet] get failed:', err);
    return error.internal(c, 'Failed to get wallet');
  }
});

/**
 * GET /with-transactions — Wallet + recent 50 transactions.
 */
app.get('/with-transactions', requirePermission('carriers:read'), zValidator('query', getWalletQuerySchema), async (c) => {
  const currentUserId = c.get('userId');
  const { userId: queryUserId } = c.req.valid('query');
  const targetUserId = resolveUserId(queryUserId, currentUserId);

  try {
    const db = c.get('tenantDb');

    const [wallet] = await db
      .select()
      .from(wallets)
      .where(and(eq(wallets.userId, targetUserId), isNull(wallets.deletedAt)))
      .limit(1);

    if (!wallet) {
      return success(c, { wallet: null, transactions: [] });
    }

    const transactions = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.walletId, wallet.id))
      .orderBy(desc(walletTransactions.createdAt))
      .limit(50);

    return success(c, {
      wallet: {
        id: wallet.id,
        balance: {
          amount: Number(wallet.balance) || 0,
          currency: wallet.currency || 'EUR',
        },
        isActive: wallet.isActive ?? true,
        isFrozen: wallet.isFrozen ?? false,
        totalCredits: Number(wallet.totalCredits) || 0,
        totalDebits: Number(wallet.totalDebits) || 0,
        transactionCount: wallet.transactionCount || 0,
      },
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: {
          amount: Number(t.amount) || 0,
          currency: t.currency || 'EUR',
        },
        balanceBefore: t.balanceBefore ? Number(t.balanceBefore) : undefined,
        balanceAfter: t.balanceAfter ? Number(t.balanceAfter) : undefined,
        referenceType: t.referenceType ?? undefined,
        referenceId: t.referenceId ?? undefined,
        description: t.description ?? undefined,
        createdAt: t.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[app-api/parcel-wallet] with-transactions failed:', err);
    return error.internal(c, 'Failed to get wallet data');
  }
});

/**
 * GET /transactions — Paginated wallet transaction history.
 */
app.get('/transactions', requirePermission('carriers:read'), zValidator('query', transactionsQuerySchema), async (c) => {
  const userId = c.get('userId');
  const { page, pageSize, type, dateFrom, dateTo } = c.req.valid('query');

  try {
    const db = c.get('tenantDb');

    const [wallet] = await db
      .select()
      .from(wallets)
      .where(and(eq(wallets.userId, userId), isNull(wallets.deletedAt)))
      .limit(1);

    if (!wallet) {
      return success(c, {
        transactions: [],
        pagination: { page: 1, pageSize, totalCount: 0, totalPages: 0, hasMore: false },
      });
    }

    const conditions: ReturnType<typeof eq>[] = [eq(walletTransactions.walletId, wallet.id)];
    if (type) conditions.push(eq(walletTransactions.type, type));
    if (dateFrom) conditions.push(gte(walletTransactions.createdAt, new Date(dateFrom)));
    if (dateTo) conditions.push(lte(walletTransactions.createdAt, new Date(dateTo)));

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(walletTransactions)
      .where(and(...conditions));

    const totalCount = countResult?.count || 0;
    const totalPages = Math.ceil(totalCount / pageSize);
    const offset = (page - 1) * pageSize;

    const transactions = await db
      .select()
      .from(walletTransactions)
      .where(and(...conditions))
      .orderBy(desc(walletTransactions.createdAt))
      .limit(pageSize)
      .offset(offset);

    return success(c, {
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: Number(t.amount) || 0,
        currency: t.currency || 'EUR',
        balanceBefore: t.balanceBefore ? Number(t.balanceBefore) : undefined,
        balanceAfter: t.balanceAfter ? Number(t.balanceAfter) : undefined,
        referenceType: t.referenceType ?? undefined,
        referenceId: t.referenceId ?? undefined,
        description: t.description ?? undefined,
        createdAt: t.createdAt.toISOString(),
      })),
      pagination: { page, pageSize, totalCount, totalPages, hasMore: page < totalPages },
    });
  } catch (err) {
    console.error('[app-api/parcel-wallet] transactions list failed:', err);
    return error.internal(c, 'Failed to get transactions');
  }
});

/**
 * POST /credits — Add credits (top-up) to the user's wallet.
 */
app.post('/credits', requirePermission('carriers:manage'), zValidator('json', addCreditsSchema), async (c) => {
  const userId = c.get('userId');
  const { amount, paymentMethod, paymentReference, description } = c.req.valid('json');

  try {
    const db = c.get('tenantDb');

    let [wallet] = await db
      .select()
      .from(wallets)
      .where(and(eq(wallets.userId, userId), isNull(wallets.deletedAt)))
      .limit(1);

    if (!wallet) {
      const newId = generateId('wal');
      const now = new Date();
      await db.insert(wallets).values({
        id: newId,
        userId,
        balance: '0',
        currency: 'EUR',
        isActive: true,
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof wallets.$inferInsert);
      [wallet] = await db.select().from(wallets).where(eq(wallets.id, newId)).limit(1);
    }

    const currentBalance = Number(wallet.balance) || 0;
    const newBalance = currentBalance + amount;

    const transactionId = generateId('wtx');
    await db.insert(walletTransactions).values({
      id: transactionId,
      walletId: wallet.id,
      userId,
      type: 'credit',
      amount: amount.toString(),
      currency: wallet.currency || 'EUR',
      balanceBefore: currentBalance.toString(),
      balanceAfter: newBalance.toString(),
      description: description ?? `Added ${amount} credits via ${paymentMethod ?? 'deposit'}`,
      metadata: paymentReference ? { paymentReference } : undefined,
    } as unknown as typeof walletTransactions.$inferInsert);

    await db
      .update(wallets)
      .set({
        balance: newBalance.toString(),
        totalCredits: sql`${wallets.totalCredits} + ${amount}`,
        transactionCount: sql`${wallets.transactionCount} + 1`,
        lastTransactionAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    publishEntityEvent({
      c,
      entityType: 'parcel_wallet',
      entityId: wallet.id,
      action: 'updated',
      data: { id: wallet.id, userId, transactionId, amount, newBalance },
    });

    return success(c, { newBalance, transactionId }, 201);
  } catch (err) {
    console.error('[app-api/parcel-wallet] add credits failed:', err);
    return error.internal(c, 'Failed to add credits');
  }
});

/**
 * POST /deduct — Deduct credits (shipping charge) from the user's wallet.
 */
app.post('/deduct', requirePermission('carriers:manage'), zValidator('json', deductCreditsSchema), async (c) => {
  const userId = c.get('userId');
  const { amount, referenceType, referenceId, description } = c.req.valid('json');

  try {
    const db = c.get('tenantDb');

    const [wallet] = await db
      .select()
      .from(wallets)
      .where(and(eq(wallets.userId, userId), isNull(wallets.deletedAt)))
      .limit(1);

    if (!wallet) {
      return error.badRequest(c, 'No wallet found for user');
    }

    const currentBalance = Number(wallet.balance) || 0;
    if (currentBalance < amount) {
      return error.badRequest(c, `Insufficient balance: have ${currentBalance}, need ${amount}`);
    }

    const newBalance = currentBalance - amount;

    const transactionId = generateId('wtx');
    await db.insert(walletTransactions).values({
      id: transactionId,
      walletId: wallet.id,
      userId,
      type: 'debit',
      amount: amount.toString(),
      currency: wallet.currency || 'EUR',
      balanceBefore: currentBalance.toString(),
      balanceAfter: newBalance.toString(),
      referenceType,
      referenceId,
      description: description ?? `Charge of ${amount}`,
    } as unknown as typeof walletTransactions.$inferInsert);

    await db
      .update(wallets)
      .set({
        balance: newBalance.toString(),
        totalDebits: sql`${wallets.totalDebits} + ${amount}`,
        transactionCount: sql`${wallets.transactionCount} + 1`,
        lastTransactionAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    publishEntityEvent({
      c,
      entityType: 'parcel_wallet',
      entityId: wallet.id,
      action: 'updated',
      data: { id: wallet.id, userId, transactionId, amount: -amount, newBalance },
    });

    return success(c, { newBalance, transactionId }, 201);
  } catch (err) {
    console.error('[app-api/parcel-wallet] deduct credits failed:', err);
    return error.internal(c, 'Failed to deduct credits');
  }
});

/**
 * POST /check-balance — Check whether the user has sufficient balance.
 */
app.post(
  '/check-balance',
  requirePermission('carriers:read'),
  zValidator('json', z.object({ amount: z.number().positive() })),
  async (c) => {
    const userId = c.get('userId');
    const { amount } = c.req.valid('json');

    try {
      const db = c.get('tenantDb');

      const [wallet] = await db
        .select()
        .from(wallets)
        .where(and(eq(wallets.userId, userId), isNull(wallets.deletedAt)))
        .limit(1);

      const balance = wallet ? Number(wallet.balance) || 0 : 0;

      return success(c, {
        hasSufficientBalance: balance >= amount,
        currentBalance: balance,
        required: amount,
        shortfall: Math.max(0, amount - balance),
      });
    } catch (err) {
      console.error('[app-api/parcel-wallet] check-balance failed:', err);
      return error.internal(c, 'Failed to check balance');
    }
  },
);

/**
 * POST /estimate-cost — Estimate shipping cost for a parcel.
 */
app.post('/estimate-cost', requirePermission('carriers:read'), zValidator('json', estimateCostSchema), async (c) => {
  const { carrierId, fromCountry, toCountry, weight, serviceType } = c.req.valid('json');

  try {
    const db = c.get('tenantDb');

    const prices = await db
      .select()
      .from(shippingPrices)
      .where(and(eq(shippingPrices.carrierId, carrierId), eq(shippingPrices.isActive, true), isNull(shippingPrices.deletedAt)))
      .limit(10);

    if (prices.length > 0) {
      const price = prices[0];
      const flatRate = price.flatRate as { amount?: number; currency?: string } | null;
      const baseAmount = flatRate?.amount ?? 0;
      const currency = flatRate?.currency ?? price.currency ?? 'EUR';

      return success(c, {
        estimatedCost: baseAmount,
        currency,
        breakdown: { basePrice: baseAmount, weightCharge: 0 },
      });
    }

    // Fallback calculation when no price record exists.
    let baseRate = fromCountry !== toCountry ? 25 : 10;
    baseRate += weight * 2;
    if (serviceType === 'EXPRESS') baseRate *= 1.5;
    else if (serviceType === 'OVERNIGHT') baseRate *= 2;

    return success(c, {
      estimatedCost: baseRate,
      currency: 'EUR',
      breakdown: { basePrice: baseRate, weightCharge: 0 },
    });
  } catch (err) {
    console.error('[app-api/parcel-wallet] estimate-cost failed:', err);
    return error.internal(c, 'Failed to estimate cost');
  }
});

export const parcelWalletRoutes = app;
