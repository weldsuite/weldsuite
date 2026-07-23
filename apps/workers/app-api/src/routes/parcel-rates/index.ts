/**
 * Parcel rates routes — /api/parcel-rates/* surface for shipping rate
 * calculation and rate selection. All calculations are done against the
 * locally-stored `shippingPrices` and `carriers` tables; no external
 * carrier API calls are made here.
 *
 * These are action endpoints (POST /calculate, POST /select, GET /carriers),
 * not standard CRUD, so this route is listed in EXEMPT_ROUTES in
 * _event-coverage.test.ts. `POST /select` mutates a parcel row but is a
 * sub-action, not a resource lifecycle event.
 *
 * Permissions: orders:read (calculate + carrier list) | orders:update (select).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  calculateRatesSchema,
  selectRateSchema,
} from '@weldsuite/app-api-client/schemas/parcel-rates';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const { carriers, shippingPrices, parcels } = schema;

/**
 * POST /calculate — Calculate available shipping rates for a parcel.
 * Reads active carriers and shipping prices; applies weight, volumetric,
 * markup and fuel-surcharge logic from the stored price configuration.
 */
app.post('/calculate', requirePermission('orders:read'), zValidator('json', calculateRatesSchema), async (c) => {
  const request = c.req.valid('json');

  try {
    const db = c.get('tenantDb');

    const [activeCarriers, activePrices] = await Promise.all([
      db
        .select()
        .from(carriers)
        .where(and(eq(carriers.isActive, true), isNull(carriers.deletedAt))),
      db
        .select()
        .from(shippingPrices)
        .where(and(eq(shippingPrices.isActive, true), isNull(shippingPrices.deletedAt))),
    ]);

    const rates: Array<{
      id: string;
      carrier: string;
      service: string;
      amount: number;
      currency: string;
      estimatedDeliveryDays?: number;
    }> = [];

    const weight = request.parcel.weight.value;
    const dims = request.parcel.dimensions;
    const volumetricWeight = (dims.length * dims.width * dims.height) / 5000;
    const chargeableWeight = Math.max(weight, volumetricWeight);

    for (const price of activePrices) {
      const carrier = activeCarriers.find((car) => car.id === price.carrierId);
      if (!carrier) continue;

      let basePrice = 0;
      const flatRate = price.flatRate as { amount?: number; currency?: string } | null;
      if (flatRate?.amount) basePrice = flatRate.amount;

      const weightRanges = (price.weightRanges as Array<{
        minWeight: number;
        maxWeight: number;
        price: { amount: number; currency: string };
      }>) || [];

      for (const range of weightRanges) {
        if (chargeableWeight >= (range.minWeight || 0) && chargeableWeight <= (range.maxWeight || Infinity)) {
          basePrice = range.price?.amount || basePrice;
          break;
        }
      }

      let totalAmount = basePrice;
      if (price.percentageMarkup) totalAmount *= 1 + Number(price.percentageMarkup) / 100;

      const handlingFee = price.handlingFee as { amount?: number } | null;
      if (handlingFee?.amount) totalAmount += handlingFee.amount;

      if (price.fuelSurcharge) totalAmount *= 1 + Number(price.fuelSurcharge) / 100;

      rates.push({
        id: `${price.id}-${price.serviceType ?? 'standard'}`,
        carrier: carrier.name,
        service: price.serviceType ?? 'standard',
        amount: Math.round(totalAmount * 100) / 100,
        currency: price.currency ?? 'EUR',
      });
    }

    rates.sort((a, b) => a.amount - b.amount);

    return success(c, rates);
  } catch (err) {
    console.error('[app-api/parcel-rates] calculate failed:', err);
    return error.internal(c, 'Failed to calculate rates');
  }
});

/**
 * POST /select — Assign a selected rate to a parcel record.
 */
app.post('/select', requirePermission('orders:update'), zValidator('json', selectRateSchema), async (c) => {
  const { rateId, parcelId } = c.req.valid('json');

  try {
    const db = c.get('tenantDb');

    // Rate ID format: "<priceId>-<serviceType>"
    const dashIndex = rateId.indexOf('-');
    const priceId = dashIndex > -1 ? rateId.slice(0, dashIndex) : rateId;
    const serviceType = dashIndex > -1 ? rateId.slice(dashIndex + 1) : undefined;

    const [price] = await db
      .select()
      .from(shippingPrices)
      .where(and(eq(shippingPrices.id, priceId), isNull(shippingPrices.deletedAt)))
      .limit(1);

    if (!price) return error.notFound(c, 'Rate', rateId);

    let carrierName: string | undefined;
    if (price.carrierId) {
      const [carrierRow] = await db
        .select({ name: carriers.name })
        .from(carriers)
        .where(eq(carriers.id, price.carrierId))
        .limit(1);
      carrierName = carrierRow?.name;
    }

    const flatRate = price.flatRate as { amount?: number; currency?: string } | null;
    await db
      .update(parcels)
      .set({
        carrierId: price.carrierId ?? undefined,
        carrierName,
        serviceType: serviceType ?? price.serviceType ?? 'standard',
        shippingCost: flatRate
          ? { amount: flatRate.amount ?? 0, currency: flatRate.currency ?? 'EUR' }
          : undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(parcels.id, parcelId), isNull(parcels.deletedAt)));

    return success(c, { parcelId, rateId, carrier: carrierName, service: serviceType ?? price.serviceType });
  } catch (err) {
    console.error('[app-api/parcel-rates] select failed:', err);
    return error.internal(c, 'Failed to select rate');
  }
});

/**
 * GET /carriers — List active carriers eligible for rate calculation.
 */
app.get('/carriers', requirePermission('orders:read'), async (c) => {
  try {
    const db = c.get('tenantDb');

    const results = await db
      .select({
        id: carriers.id,
        name: carriers.name,
        code: carriers.code,
        logo: carriers.logo,
      })
      .from(carriers)
      .where(and(eq(carriers.isActive, true), isNull(carriers.deletedAt)));

    return success(c, results);
  } catch (err) {
    console.error('[app-api/parcel-rates] carriers list failed:', err);
    return error.internal(c, 'Failed to fetch carriers');
  }
});

export const parcelRatesRoutes = app;
