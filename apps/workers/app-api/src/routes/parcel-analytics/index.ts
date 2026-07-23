/**
 * Parcel analytics routes — /api/parcel-analytics/* read-only aggregates over
 * `parcels`, `shipments`, and `returns`. Ported from
 * apps/api-worker/src/routes/parcel/analytics.ts.
 *
 * No mutations → no entity events → registered in EXEMPT_ROUTES in
 * _event-coverage.test.ts (read-only aggregates only).
 *
 * Permissions: orders:read (all endpoints).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const { parcels, shipments, returns } = schema;

const analyticsFiltersSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  carrierId: z.string().optional(),
});

const carrierPerformanceSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

/**
 * GET / — Overview analytics: parcel status breakdown, carrier split,
 * shipment/return counts, and a 7-day timeline stub.
 */
app.get('/', requirePermission('orders:read'), zValidator('query', analyticsFiltersSchema), async (c) => {
  const { dateFrom, dateTo, carrierId } = c.req.valid('query');

  try {
    const db = c.get('tenantDb');

    const now = new Date();
    const from = dateFrom ? new Date(dateFrom) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const to = dateTo ? new Date(dateTo) : now;

    const parcelConditions: ReturnType<typeof eq>[] = [
      isNull(parcels.deletedAt),
      gte(parcels.createdAt, from),
      lte(parcels.createdAt, to),
    ];
    if (carrierId) parcelConditions.push(eq(parcels.carrierId, carrierId));

    const [parcelStats, shipmentCount, returnsCount, carrierStats] = await Promise.all([
      db
        .select({ status: parcels.status, count: sql<number>`count(*)::int` })
        .from(parcels)
        .where(and(...parcelConditions))
        .groupBy(parcels.status),

      db
        .select({ count: sql<number>`count(*)::int` })
        .from(shipments)
        .where(and(isNull(shipments.deletedAt), gte(shipments.createdAt, from), lte(shipments.createdAt, to))),

      db
        .select({ count: sql<number>`count(*)::int` })
        .from(returns)
        .where(and(isNull(returns.deletedAt), gte(returns.createdAt, from), lte(returns.createdAt, to))),

      db
        .select({
          carrierId: parcels.carrierId,
          carrierName: parcels.carrierName,
          count: sql<number>`count(*)::int`,
          deliveredCount: sql<number>`count(*) filter (where status = 'delivered')::int`,
        })
        .from(parcels)
        .where(and(...parcelConditions))
        .groupBy(parcels.carrierId, parcels.carrierName),
    ]);

    const statusCounts: Record<string, number> = {};
    let totalParcels = 0;
    for (const s of parcelStats) {
      statusCounts[s.status ?? 'unknown'] = s.count;
      totalParcels += s.count;
    }

    const timeline: Array<{ date: string; parcelsCreated: number; parcelsDelivered: number; totalCost: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      timeline.push({ date: d.toISOString().split('T')[0], parcelsCreated: 0, parcelsDelivered: 0, totalCost: 0 });
    }

    return success(c, {
      overview: {
        totalParcels,
        totalShipments: shipmentCount[0]?.count ?? 0,
        totalDelivered: statusCounts['delivered'] ?? 0,
        totalInTransit: (statusCounts['in_transit'] ?? 0) + (statusCounts['shipped'] ?? 0),
        totalPending: (statusCounts['pending'] ?? 0) + (statusCounts['draft'] ?? 0),
        totalReturns: returnsCount[0]?.count ?? 0,
        averageDeliveryTime: 0,
      },
      costs: { totalShippingCost: 0, averageShippingCost: 0, currency: 'EUR' },
      carriers: carrierStats.map((row) => ({
        carrierId: row.carrierId ?? 'unknown',
        carrierName: row.carrierName ?? 'Unknown',
        parcelCount: row.count,
        deliveredCount: row.deliveredCount,
        averageDeliveryTime: 0,
      })),
      timeline,
    });
  } catch (err) {
    console.error('[app-api/parcel-analytics] overview failed:', err);
    return error.internal(c, 'Failed to fetch analytics');
  }
});

/**
 * GET /carrier/:carrierId — Delivery rate and failure count for a single carrier.
 */
app.get('/carrier/:carrierId', requirePermission('orders:read'), zValidator('query', carrierPerformanceSchema), async (c) => {
  const carrierId = c.req.param('carrierId');
  const { dateFrom, dateTo } = c.req.valid('query');

  try {
    const db = c.get('tenantDb');

    const now = new Date();
    const from = dateFrom ? new Date(dateFrom) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const to = dateTo ? new Date(dateTo) : now;

    const [stats] = await db
      .select({
        total: sql<number>`count(*)::int`,
        delivered: sql<number>`count(*) filter (where status = 'delivered')::int`,
        failed: sql<number>`count(*) filter (where status = 'exception' or status = 'failed')::int`,
      })
      .from(parcels)
      .where(
        and(
          eq(parcels.carrierId, carrierId),
          isNull(parcels.deletedAt),
          gte(parcels.createdAt, from),
          lte(parcels.createdAt, to),
        ),
      );

    const result = stats ?? { total: 0, delivered: 0, failed: 0 };
    const deliveryRate = result.total > 0 ? (result.delivered / result.total) * 100 : 0;

    return success(c, {
      carrierId,
      totalParcels: result.total,
      deliveredCount: result.delivered,
      failedCount: result.failed,
      deliveryRate: Math.round(deliveryRate * 10) / 10,
      averageDeliveryTime: 0,
      totalCost: 0,
    });
  } catch (err) {
    console.error('[app-api/parcel-analytics] carrier performance failed:', err);
    return error.internal(c, 'Failed to fetch carrier performance');
  }
});

export const parcelAnalyticsRoutes = app;
