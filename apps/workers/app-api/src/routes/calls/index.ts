/**
 * Call routes — flat /api/calls/* surface backed by `voipCalls`.
 *
 * Mirrors the legacy /crm/call-intelligence/calls behaviour: filters by
 * status, direction, contactId, customerId, userId, provider, search, and
 * date range. Cursor-paginated (newest first by `initiatedAt`).
 *
 * Permissions: activities:read | activities:create | activities:update | activities:delete.
 *   activities:scope:all elevates from own-only default (userId) to cross-owner access.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, like, lte, or, sql } from 'drizzle-orm';
import {
  ensurePermissionsResolved,
  requirePermission,
} from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  checkCredits,
  consumeCredits,
  grantCredits,
  resolveInternalWorkspaceId,
  SERVICE_CREDIT_RATES,
} from '@weldsuite/credits';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema, getMasterDb, type MasterDatabase } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.voipCalls;

/**
 * Resolve master DB + internal workspace id for credit metering. Null (with a
 * warning) when the master DB is unavailable — degraded/unmetered mode.
 */
async function resolveMetering(
  env: Env,
  orgId: string,
): Promise<{ masterDb: MasterDatabase; internalWsId: string } | null> {
  try {
    const masterDb = getMasterDb(env);
    const internalWsId = await resolveInternalWorkspaceId(masterDb, orgId);
    if (!internalWsId) {
      console.warn(`[app-api/calls] no master workspace for org ${orgId} — unmetered`);
      return null;
    }
    return { masterDb, internalWsId };
  } catch (err) {
    console.warn('[app-api/calls] credit metering unavailable:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const resolved = await ensurePermissionsResolved(c);
  const perms = resolved?.permissions ?? [];
  if (hasPermission(perms, 'activities:scope:all')) return undefined;
  return c.get('userId');
}

app.get('/', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  const scope = await scopeFor(c);

  const conditions: any[] = [];
  if (scope) conditions.push(eq(t.userId, scope));
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
  if (q.direction !== undefined && q.direction !== '') conditions.push(eq(t.direction, q.direction));
  if (q.customerId !== undefined && q.customerId !== '') conditions.push(eq(t.customerId, q.customerId));
  if (q.contactId !== undefined && q.contactId !== '') conditions.push(eq(t.contactId, q.contactId));
  if (q.userId !== undefined && q.userId !== '') conditions.push(eq(t.userId, q.userId));
  if (q.provider !== undefined && q.provider !== '') conditions.push(eq(t.provider, q.provider));
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(
      or(
        like(t.fromNumber, term),
        like(t.toNumber, term),
        like(t.fromNumberFormatted, term),
        like(t.toNumberFormatted, term),
        like(t.notes, term),
      )!,
    );
  }
  if (q.from) conditions.push(gte(t.initiatedAt, new Date(q.from)));
  if (q.to) conditions.push(lte(t.initiatedAt, new Date(q.to)));
  if (q.cursor) {
    const [cur] = await db
      .select({ initiatedAt: t.initiatedAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.initiatedAt) {
      conditions.push(
        sql`(${t.initiatedAt} < ${cur.initiatedAt} OR (${t.initiatedAt} = ${cur.initiatedAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }

  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.initiatedAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/calls] list failed:', err);
    return error.internal(c, 'Failed to list calls');
  }
});

app.get('/:id', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id)];
  if (scope) conditions.push(eq(t.userId, scope));
  try {
    const [row] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!row) return error.notFound(c, 'Call', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/calls] get failed:', err);
    return error.internal(c, 'Failed to fetch call');
  }
});

// ============================================================================
// Write surface — ported from the obsolete api-worker
// /crm/call-intelligence/calls routes, with prepaid credit metering.
// ============================================================================

const createCallSchema = z.object({
  direction: z.enum(['inbound', 'outbound']),
  fromNumber: z.string().min(1),
  toNumber: z.string().min(1),
  fromNumberFormatted: z.string().optional(),
  toNumberFormatted: z.string().optional(),
  customerId: z.string().optional(),
  contactId: z.string().optional(),
  opportunityId: z.string().optional(),
  isRecorded: z.boolean().optional(),
  notes: z.string().optional(),
  provider: z.string().optional(),
});

/**
 * POST / — create a call record. The dialer creates this row BEFORE dialing,
 * so the credit pre-flight here gates the call itself: an exhausted wallet
 * gets a 402 before any Telnyx spend happens.
 */
app.post('/', requirePermission('activities:create'), zValidator('json', createCallSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');

  const metering = await resolveMetering(c.env, c.get('workspaceId'));
  if (metering && data.direction === 'outbound') {
    const check = await checkCredits(
      metering.masterDb,
      metering.internalWsId,
      SERVICE_CREDIT_RATES.voipCallPerMinute,
    );
    if (!check.available) {
      return error.insufficientCredits(c, {
        currentBalance: check.currentBalance,
        required: check.required,
        shortfall: check.shortfall,
      });
    }
  }

  const id = generateId('vcall');
  const now = new Date();
  try {
    await db.insert(t).values({
      id,
      userId,
      provider: data.provider || 'telnyx',
      direction: data.direction,
      status: 'initiated',
      fromNumber: data.fromNumber,
      toNumber: data.toNumber,
      fromNumberFormatted: data.fromNumberFormatted,
      toNumberFormatted: data.toNumberFormatted,
      customerId: data.customerId,
      contactId: data.contactId,
      opportunityId: data.opportunityId,
      isRecorded: data.isRecorded ?? true,
      notes: data.notes,
      initiatedAt: now,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'call',
      entityId: id,
      action: 'created',
      data: { id, direction: data.direction, toNumber: data.toNumber, status: 'initiated' },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/calls] create failed:', err);
    return error.internal(c, 'Failed to create call');
  }
});

const updateCallSchema = z.object({
  status: z.string().optional(),
  answeredAt: z.string().nullable().optional(),
  endedAt: z.string().nullable().optional(),
  duration: z.number().int().min(0).optional(),
  customerId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  opportunityId: z.string().nullable().optional(),
  notes: z.string().optional(),
});

/**
 * PUT /:id — update a call. When the call ends (duration known), the prepaid
 * wallet is settled per started minute, idempotent on the call id so repeated
 * end-updates can't double-charge. If the balance drained mid-call the
 * settlement forces the wallet negative — visible debt beats hidden loss.
 */
app.put('/:id', requirePermission('activities:update'), zValidator('json', updateCallSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Call', id);

    const update: Record<string, any> = { updatedAt: new Date() };
    const dateFields = new Set(['answeredAt', 'endedAt']);
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      update[k] = dateFields.has(k) ? (v ? new Date(v as string) : null) : v;
    }

    // Settle credits once, when the call is finished and its duration is known.
    const durationSecs = (data.duration ?? existing.duration ?? 0) as number;
    const callEnded = Boolean(data.endedAt) || data.status === 'completed' || existing.endedAt !== null;
    if (callEnded && durationSecs > 0 && !existing.creditTransactionId) {
      const metering = await resolveMetering(c.env, c.get('workspaceId'));
      if (metering) {
        const cost = Math.ceil(durationSecs / 60) * SERVICE_CREDIT_RATES.voipCallPerMinute;
        try {
          const settle = await consumeCredits(metering.masterDb, {
            workspaceId: metering.internalWsId,
            amount: cost,
            serviceType: 'voip_call',
            idempotencyKey: `voip:${id}`,
            referenceId: id,
            referenceType: 'voip_call',
            description: `VoIP call (${Math.ceil(durationSecs / 60)} min)`,
            metadata: { callId: id, durationSecs, direction: existing.direction },
            userId,
          });
          if (settle.ok) {
            update.creditsConsumed = cost;
            update.creditTransactionId = settle.transactionId;
          } else {
            // Minutes were already spent — record the debt.
            const debit = await grantCredits(metering.masterDb, {
              workspaceId: metering.internalWsId,
              amount: -cost,
              type: 'adjustment',
              serviceType: 'voip_call',
              idempotencyKey: `voip:${id}`,
              referenceId: id,
              referenceType: 'voip_call',
              description: `VoIP call (${Math.ceil(durationSecs / 60)} min) — settled into negative balance`,
              metadata: { callId: id, durationSecs, forcedSettlement: true },
              userId,
            });
            update.creditsConsumed = cost;
            update.creditTransactionId = debit.transactionId;
          }
        } catch (settleErr) {
          console.error('[app-api/calls] credit settlement FAILED (untracked call!):', settleErr);
        }
      }
    }

    await db.update(t).set(update).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'call',
      entityId: id,
      action: 'updated',
      data: { id, status: (update.status as string | undefined) ?? existing.status },
    });
    return success(c, { id, ...data });
  } catch (err) {
    console.error('[app-api/calls] update failed:', err);
    return error.internal(c, 'Failed to update call');
  }
});

app.delete('/:id', requirePermission('activities:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select({ id: t.id }).from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Call', id);
    await db.delete(t).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'call',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/calls] delete failed:', err);
    return error.internal(c, 'Failed to delete call');
  }
});

export const callsRoutes = app;
