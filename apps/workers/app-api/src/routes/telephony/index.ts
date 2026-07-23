/**
 * Telephony routes — Telnyx phone number operations: search, provision,
 * sync, address management, and pricing lookups.
 *
 * Ported from apps/api-worker/src/routes/settings/telephony.ts (W3 legacy
 * phase-out). Legacy mount was /api/settings/telephony/*; here the surface
 * is /api/telephony/* with identical subpaths.
 *
 * Permissions: `telephony:read` (reads) | `telephony:manage` (mutations).
 * Entity events: `voip_phone_number: created | updated | deleted`.
 *
 * Response envelope is app-api's `{ data }` (legacy api-worker wrapped the
 * same payloads as `{ success: true, data }` — see W3 report for the full
 * delta list the W5 platform cutover must adapt).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull, asc } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Variables } from '../../types';
import { schema, getMasterDb, masterSchema } from '../../db';
import { generateId } from '../../lib/id';
import { success, error } from '../../lib/response';
import {
  isTelnyxConfigured,
  telnyxRequest,
  COUNTRIES_REQUIRING_ADDRESS,
  billingWorkerUrl,
  type TelnyxEnv,
} from '../../lib/telnyx';

const READ_TELEPHONY = 'telephony:read';
const MANAGE_TELEPHONY = 'telephony:manage';

// ============================================================================
// Schemas
// ============================================================================

const searchSchema = z.object({
  country: z.string().min(2).max(2),
  areaCode: z.string().optional(),
  contains: z.string().optional(),
  type: z.enum(['local', 'toll-free', 'mobile']).default('local'),
  limit: z.coerce.number().min(1).max(50).default(20),
});

const provisionSchema = z.object({
  phoneNumber: z.string().min(1),
  friendlyName: z.string().optional(),
  displayName: z.string().optional(),
  countryCode: z.string().min(2).max(2),
  numberType: z.enum(['local', 'toll-free', 'mobile']).default('local'),
  addressId: z.string().optional(),
});

const updatePhoneNumberSchema = z.object({
  displayName: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
});

const createAddressSchema = z.object({
  businessName: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  streetAddress: z.string().min(1),
  extendedAddress: z.string().optional(),
  locality: z.string().min(1),
  administrativeArea: z.string().default(''),
  postalCode: z.string().min(1),
  countryCode: z.string().min(2).max(2),
});

// ============================================================================
// Routes
// ============================================================================

const app = new Hono<{ Bindings: TelnyxEnv; Variables: Variables }>();

// ---------- Configuration check ----------

app.get('/configured', requirePermission(READ_TELEPHONY), async (c) => {
  return success(c, { configured: isTelnyxConfigured(c.env) });
});

// ---------- Phone number CRUD ----------

/**
 * PUT /telephony/phone-numbers/:id — Update phone number (display name)
 */
app.put('/phone-numbers/:id', requirePermission(MANAGE_TELEPHONY), zValidator('json', updatePhoneNumberSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const { voipPhoneNumbers } = schema;

    const existing = await db
      .select()
      .from(voipPhoneNumbers)
      .where(and(eq(voipPhoneNumbers.id, id), isNull(voipPhoneNumbers.deletedAt)))
      .limit(1);

    if (existing.length === 0) return error.notFound(c, 'Phone number', id);

    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (data.displayName !== undefined) updateData.displayName = data.displayName;
    if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;

    await db.update(voipPhoneNumbers).set(updateData).where(eq(voipPhoneNumbers.id, id));

    publishEntityEvent({
      c,
      entityType: 'voip_phone_number',
      action: 'updated',
      entityId: id,
      data: { id, phoneNumber: existing[0].phoneNumber, status: existing[0].status },
    });

    return success(c, { success: true });
  } catch (err) {
    console.error('[Telephony] Failed to update phone number:', err);
    return error.internal(c, 'Failed to update phone number');
  }
});

/**
 * DELETE /telephony/phone-numbers/:id — Delete phone number + remove billing
 */
app.delete('/phone-numbers/:id', requirePermission(MANAGE_TELEPHONY), async (c) => {
  const id = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const { voipPhoneNumbers } = schema;

    const existing = await db
      .select()
      .from(voipPhoneNumbers)
      .where(and(eq(voipPhoneNumbers.id, id), isNull(voipPhoneNumbers.deletedAt)))
      .limit(1);

    if (existing.length === 0) return error.notFound(c, 'Phone number', id);

    const phone = existing[0];

    // Remove billing if pricing info available
    if (phone.countryCode && phone.numberType) {
      try {
        const masterDb = getMasterDb(c.env);
        const [pricing] = await masterDb
          .select()
          .from(masterSchema.telephonyNumberPricing)
          .where(
            and(
              eq(masterSchema.telephonyNumberPricing.countryCode, phone.countryCode.toUpperCase()),
              eq(masterSchema.telephonyNumberPricing.numberType, phone.numberType.toLowerCase()),
              eq(masterSchema.telephonyNumberPricing.isActive, true),
            ),
          );

        if (pricing?.stripePriceId) {
          const authHeader = c.req.header('Authorization');
          const billingUrl = billingWorkerUrl(c.env);

          await fetch(`${billingUrl}/api/billing/phone/remove-number`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(authHeader ? { Authorization: authHeader } : {}),
            },
            body: JSON.stringify({ stripePriceId: pricing.stripePriceId }),
          }).catch((billingErr) => {
            console.error('[Telephony] Failed to remove phone billing (continuing):', billingErr);
          });
        }
      } catch {
        // Continue — billing can be reconciled later
      }
    }

    // Soft delete
    await db
      .update(voipPhoneNumbers)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(voipPhoneNumbers.id, id));

    publishEntityEvent({
      c,
      entityType: 'voip_phone_number',
      action: 'deleted',
      entityId: id,
      data: { id, phoneNumber: phone.phoneNumber, status: phone.status },
    });

    return success(c, { success: true });
  } catch (err) {
    console.error('[Telephony] Failed to delete phone number:', err);
    return error.internal(c, 'Failed to delete phone number');
  }
});

/**
 * POST /telephony/phone-numbers/:id/set-default — Set phone number as default
 */
app.post('/phone-numbers/:id/set-default', requirePermission(MANAGE_TELEPHONY), async (c) => {
  const id = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const { voipPhoneNumbers } = schema;

    const existing = await db
      .select()
      .from(voipPhoneNumbers)
      .where(and(eq(voipPhoneNumbers.id, id), isNull(voipPhoneNumbers.deletedAt)))
      .limit(1);

    if (existing.length === 0) return error.notFound(c, 'Phone number', id);

    // Unset all other defaults
    const allNumbers = await db
      .select()
      .from(voipPhoneNumbers)
      .where(and(eq(voipPhoneNumbers.isDefault, true), isNull(voipPhoneNumbers.deletedAt)));

    for (const num of allNumbers) {
      if (num.id !== id) {
        await db.update(voipPhoneNumbers).set({ isDefault: false, updatedAt: new Date() }).where(eq(voipPhoneNumbers.id, num.id));
      }
    }

    await db.update(voipPhoneNumbers).set({ isDefault: true, updatedAt: new Date() }).where(eq(voipPhoneNumbers.id, id));

    publishEntityEvent({
      c,
      entityType: 'voip_phone_number',
      action: 'updated',
      entityId: id,
      data: { id, phoneNumber: existing[0].phoneNumber, status: existing[0].status },
    });

    return success(c, { success: true });
  } catch (err) {
    console.error('[Telephony] Failed to set default phone number:', err);
    return error.internal(c, 'Failed to set default phone number');
  }
});

// ---------- Search & provision ----------

/**
 * POST /telephony/phone-numbers/search — Search available numbers via Telnyx
 */
app.post('/phone-numbers/search', requirePermission(MANAGE_TELEPHONY), zValidator('json', searchSchema), async (c) => {
  if (!isTelnyxConfigured(c.env)) {
    return error.badRequest(c, 'Phone service is not activated');
  }

  const { country, areaCode, contains, type, limit } = c.req.valid('json');

  try {
    const params = new URLSearchParams();
    params.set('filter[country_code]', country);
    params.set('filter[limit]', String(limit));
    params.set('filter[features][]', 'voice');

    // Map type to Telnyx phone_number_type
    if (type === 'toll-free') {
      params.set('filter[phone_number_type]', 'toll_free');
    } else if (type === 'mobile') {
      params.set('filter[phone_number_type]', 'mobile');
    } else {
      params.set('filter[phone_number_type]', 'local');
    }

    if (areaCode) params.set('filter[national_destination_code]', areaCode);
    if (contains) params.set('filter[phone_number][contains]', contains);

    const resp = await telnyxRequest<{ data: any[] }>(
      c.env,
      `/available_phone_numbers?${params.toString()}`,
    );

    return success(c, { numbers: resp.data || [] });
  } catch (err) {
    console.error('[Telephony] Failed to search phone numbers:', err);
    return error.internal(c, 'Failed to search phone numbers');
  }
});

/**
 * POST /telephony/phone-numbers/provision — Provision (order) a phone number
 *
 * Success is `{ data: { success: true, provisioningStatus: 'pending' } }`.
 * When the workspace has no payment method the response is
 * `{ data: { requiresCheckout: true, checkoutUrl } }` (HTTP 200) — the actual
 * number purchase happens post-checkout via the billing worker.
 */
app.post('/phone-numbers/provision', requirePermission(MANAGE_TELEPHONY), zValidator('json', provisionSchema), async (c) => {
  if (!isTelnyxConfigured(c.env)) {
    return error.badRequest(c, 'Phone service is not activated');
  }

  const data = c.req.valid('json');

  try {
    // Check address requirement
    if (COUNTRIES_REQUIRING_ADDRESS.includes(data.countryCode) && !data.addressId) {
      return c.json({
        error: {
          code: 'ADDRESS_REQUIRED',
          message: `Phone numbers in ${data.countryCode} require a verified address.`,
          details: { requiresAddress: true },
        },
      }, 400);
    }

    // Look up Stripe pricing from master DB
    const masterDb = getMasterDb(c.env);
    const [pricing] = await masterDb
      .select()
      .from(masterSchema.telephonyNumberPricing)
      .where(
        and(
          eq(masterSchema.telephonyNumberPricing.countryCode, data.countryCode.toUpperCase()),
          eq(masterSchema.telephonyNumberPricing.numberType, data.numberType.toLowerCase()),
          eq(masterSchema.telephonyNumberPricing.isActive, true),
        ),
      );

    if (!pricing?.stripePriceId) {
      return error.badRequest(c, 'No pricing configured for this phone number type');
    }

    // Forward to billing worker
    const authHeader = c.req.header('Authorization');
    const billingUrl = billingWorkerUrl(c.env);

    const billingResp = await fetch(`${billingUrl}/api/billing/phone/add-number`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        stripePriceId: pricing.stripePriceId,
        countryCode: data.countryCode,
        numberType: data.numberType,
        phoneNumber: data.phoneNumber,
        friendlyName: data.friendlyName,
        displayName: data.displayName,
        addressId: data.addressId,
      }),
    });

    const billingResult = await billingResp.json() as Record<string, any>;

    if (billingResult.requiresCheckout) {
      const checkoutResp = await fetch(`${billingUrl}/api/billing/phone/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          stripePriceId: pricing.stripePriceId,
          phoneNumber: data.phoneNumber,
          countryCode: data.countryCode,
          numberType: data.numberType,
          friendlyName: data.friendlyName,
          displayName: data.displayName,
          addressId: data.addressId,
        }),
      });
      const checkoutResult = await checkoutResp.json() as Record<string, any>;
      return success(c, { requiresCheckout: true, checkoutUrl: checkoutResult.url });
    }

    if (!billingResult.success) {
      return error.badRequest(c, 'Payment was not confirmed. Please try again.');
    }

    return success(c, { success: true, provisioningStatus: 'pending' as const });
  } catch (err) {
    console.error('[Telephony] Failed to provision phone number:', err);
    const rawMsg = err instanceof Error ? err.message : '';
    if (rawMsg.includes('address') || rawMsg.includes('regulatory')) {
      return c.json({
        error: {
          code: 'ADDRESS_REQUIRED',
          message: 'Address or regulatory document required',
          details: { requiresAddress: true },
        },
      }, 400);
    }
    return error.internal(c, 'Failed to provision phone number');
  }
});

// ---------- Sync ----------

/**
 * POST /telephony/phone-numbers/sync — Sync phone numbers from Telnyx
 */
app.post('/phone-numbers/sync', requirePermission(MANAGE_TELEPHONY), async (c) => {
  if (!isTelnyxConfigured(c.env)) {
    return error.badRequest(c, 'Phone service is not activated');
  }

  try {
    const db = c.get('tenantDb');
    const { voipPhoneNumbers } = schema;

    const connectionId = c.env.TELNYX_CONNECTION_ID;
    const params = new URLSearchParams();
    params.set('page[size]', '250');
    params.set('filter[status]', 'active');
    if (connectionId) {
      params.set('filter[connection_id]', connectionId);
    }

    const providerNumbers = await telnyxRequest<{ data: any[] }>(
      c.env,
      `/phone_numbers?${params.toString()}`,
    );
    const telnyxNumbers = providerNumbers.data || [];

    if (telnyxNumbers.length === 0) {
      return success(c, { count: 0 });
    }

    const existing = await db
      .select()
      .from(voipPhoneNumbers)
      .where(isNull(voipPhoneNumbers.deletedAt));

    let synced = 0;
    for (const number of telnyxNumbers) {
      try {
        const existingNumber = existing.find(
          (p: any) => p.providerPhoneNumberId === number.id || p.phoneNumber === number.phone_number,
        );

        if (existingNumber) {
          await db.update(voipPhoneNumbers).set({
            status: 'active',
            providerPhoneNumberId: number.id,
            providerConnectionId: number.connection_id,
            updatedAt: new Date(),
          }).where(eq(voipPhoneNumbers.id, existingNumber.id));
        } else {
          const newId = generateId('vpn');
          await db.insert(voipPhoneNumbers).values({
            id: newId,
            provider: 'telnyx',
            phoneNumber: number.phone_number,
            formattedNumber: number.phone_number,
            countryCode: number.phone_number.startsWith('+1') ? 'US' : 'INTL',
            numberType: 'local',
            status: 'active',
            providerPhoneNumberId: number.id,
            providerConnectionId: number.connection_id,
            isDefault: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          publishEntityEvent({
            c,
            entityType: 'voip_phone_number',
            action: 'created',
            entityId: newId,
            data: { id: newId, phoneNumber: number.phone_number, status: 'active' },
          });
        }
        synced++;
      } catch (e) {
        console.error(`[Telephony] Failed to sync number ${number.phone_number}:`, e);
      }
    }

    return success(c, { count: synced });
  } catch (err) {
    console.error('[Telephony] Failed to sync phone numbers:', err);
    return error.internal(c, 'Failed to refresh phone numbers');
  }
});

// ---------- Addresses ----------

/**
 * GET /telephony/addresses — List Telnyx addresses
 */
app.get('/addresses', requirePermission(READ_TELEPHONY), async (c) => {
  if (!isTelnyxConfigured(c.env)) {
    return success(c, { addresses: [] });
  }

  try {
    const resp = await telnyxRequest<{ data: any[] }>(c.env, '/addresses');
    return success(c, { addresses: resp.data || [] });
  } catch (err) {
    console.error('[Telephony] Failed to list addresses:', err);
    return error.internal(c, 'Failed to list addresses');
  }
});

/**
 * POST /telephony/addresses — Create a Telnyx address
 */
app.post('/addresses', requirePermission(MANAGE_TELEPHONY), zValidator('json', createAddressSchema), async (c) => {
  if (!isTelnyxConfigured(c.env)) {
    return error.badRequest(c, 'Phone service is not activated');
  }

  const data = c.req.valid('json');

  try {
    const address = await telnyxRequest<{ data: any }>(c.env, '/addresses', {
      method: 'POST',
      body: JSON.stringify({
        business_name: data.businessName,
        first_name: data.firstName,
        last_name: data.lastName,
        street_address: data.streetAddress,
        extended_address: data.extendedAddress,
        locality: data.locality,
        administrative_area: data.administrativeArea,
        postal_code: data.postalCode,
        country_code: data.countryCode,
        address_book: true,
      }),
    });

    return success(c, { address: address.data }, 201);
  } catch (err) {
    console.error('[Telephony] Failed to create address:', err);
    return error.internal(c, 'Failed to create address');
  }
});

// ---------- Bundles (legacy endpoint, returns empty) ----------

/**
 * GET /telephony/bundles — Telnyx does not use bundles; returns empty array for frontend compat
 */
app.get('/bundles', requirePermission(READ_TELEPHONY), async (c) => {
  return success(c, { bundles: [] });
});

// ---------- Regulatory Requirements ----------

/**
 * GET /telephony/requirements — List regulatory requirements for a country
 */
app.get('/requirements', requirePermission(READ_TELEPHONY), async (c) => {
  if (!isTelnyxConfigured(c.env)) {
    return success(c, { requirements: [] });
  }

  const countryCode = c.req.query('countryCode');
  if (!countryCode) {
    return error.badRequest(c, 'countryCode query parameter is required');
  }

  try {
    const params = new URLSearchParams();
    params.set('filter[country_code]', countryCode);

    const resp = await telnyxRequest<{ data: any[] }>(
      c.env,
      `/phone_number_regulatory_requirements?${params.toString()}`,
    );
    return success(c, { requirements: resp.data || [] });
  } catch (err) {
    console.error('[Telephony] Failed to list requirements:', err);
    return error.internal(c, 'Failed to list requirements');
  }
});

// ---------- Pricing ----------

/**
 * GET /telephony/pricing — Get all active phone number pricing from master DB
 *
 * Legacy returned `{ success: true, pricing }` at the top level; here the
 * array lives at `data.pricing`.
 */
app.get('/pricing', requirePermission(READ_TELEPHONY), async (c) => {
  try {
    const masterDb = getMasterDb(c.env);
    const rows = await masterDb
      .select()
      .from(masterSchema.telephonyNumberPricing)
      .where(eq(masterSchema.telephonyNumberPricing.isActive, true))
      .orderBy(asc(masterSchema.telephonyNumberPricing.countryCode), asc(masterSchema.telephonyNumberPricing.numberType));

    const pricing = rows.map((r) => ({
      countryCode: r.countryCode,
      numberType: r.numberType,
      monthlyPrice: Number(r.monthlyPrice),
      currency: r.currency,
      stripePriceId: r.stripePriceId ?? undefined,
    }));

    return success(c, { pricing });
  } catch (err) {
    console.error('[Telephony] Failed to fetch pricing:', err);
    return error.internal(c, 'Failed to fetch pricing');
  }
});

/**
 * GET /telephony/service-rates — Get all active telephony service rates from master DB
 *
 * Legacy returned `{ success: true, rates }` at the top level; here the map
 * lives at `data.rates`.
 */
app.get('/service-rates', requirePermission(READ_TELEPHONY), async (c) => {
  try {
    const masterDb = getMasterDb(c.env);
    const rows = await masterDb
      .select()
      .from(masterSchema.telephonyServiceRates)
      .where(eq(masterSchema.telephonyServiceRates.isActive, true));

    const rateMap = new Map(rows.map(r => [r.serviceType, Number(r.creditsPerUnit)]));

    return success(c, {
      rates: {
        voipCallMinute: rateMap.get('voip_call_minute') ?? 3,
        callTranscriptionMinute: rateMap.get('call_transcription_minute') ?? 2,
      },
    });
  } catch (err) {
    console.error('[Telephony] Failed to fetch service rates:', err);
    return error.internal(c, 'Failed to fetch service rates');
  }
});

/**
 * GET /telephony/address-required/:countryCode — Check if country requires address
 */
app.get('/address-required/:countryCode', requirePermission(READ_TELEPHONY), (c) => {
  const countryCode = c.req.param('countryCode');
  return success(c, {
    required: COUNTRIES_REQUIRING_ADDRESS.includes(countryCode.toUpperCase()),
    countryCode,
  });
});

export { app as telephonyRoutes };
