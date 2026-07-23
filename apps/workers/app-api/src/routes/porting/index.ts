/**
 * Phone Number Porting routes — port a number FROM another carrier INTO the
 * platform's Telnyx account. After completion, ported numbers behave like
 * any other platform-managed number (same Stripe billing path, same Call
 * Control App, same WebRTC inbound notification flow).
 *
 * Ported from apps/api-worker/src/routes/settings/porting.ts (W3 legacy
 * phase-out). Legacy mount was /api/settings/telephony/port-orders/*; here
 * the surface is /api/porting/* with identical subpaths.
 *
 * Permissions: `telephony:manage` on every route (matches legacy).
 * Entity events: `voip_porting_order: created | updated | deleted`.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Variables } from '../../types';
import { schema, getMasterDb, masterSchema } from '../../db';
import { generateId } from '../../lib/id';
import { success, error } from '../../lib/response';
import { billingWorkerUrl, type TelnyxEnv } from '../../lib/telnyx';
import {
  preflightCheck,
  createPortingOrder,
  updatePortingOrder,
  fetchLoaTemplate,
  attachOrderDocument,
  submitPortingOrder,
  getPortingOrder,
  deletePortingOrder,
  TelnyxPortingError,
} from '../../lib/telnyx-porting';
import {
  uploadPortDoc,
  PortDocError,
  deletePortDocs,
  type PortDocType,
} from '../../lib/r2-port-docs';

// ============================================================================
// Local error helpers — statuses app-api's shared response lib doesn't cover
// (kept file-local to avoid touching the shared lib mid-phase-out).
// ============================================================================

const rateLimited = (c: Context) =>
  c.json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, 429);

const unavailable = (c: Context, message = 'Service temporarily unavailable') =>
  c.json({ error: { code: 'SERVICE_UNAVAILABLE', message } }, 503);

const unprocessable = (c: Context, message: string, details?: unknown) =>
  c.json({ error: { code: 'UNPROCESSABLE_ENTITY', message, details } }, 422);

// ============================================================================
// Schemas
// ============================================================================

const phoneNumberSchema = z
  .string()
  .min(8)
  .max(20)
  .regex(/^\+[0-9]+$/, 'Phone number must be E.164 (start with + followed by digits)');

const preflightSchema = z.object({
  phoneNumber: phoneNumberSchema,
  countryCode: z.string().length(2),
});

const createSchema = z.object({
  phoneNumber: phoneNumberSchema,
  formattedNumber: z.string().optional(),
  countryCode: z.string().length(2),
  // v1 deliberately excludes 'toll_free' — RespOrg port flow is different.
  numberType: z.enum(['local', 'mobile']).default('local'),
});

const serviceAddressSchema = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  region: z.string().min(1).max(100),
  postalCode: z.string().min(1).max(20),
  country: z.string().length(2),
});

const patchSchema = z
  .object({
    authorizedName: z.string().min(1).max(200).optional(),
    businessName: z.string().min(1).max(200).optional(),
    serviceAddress: serviceAddressSchema.optional(),
    currentCarrier: z.string().min(1).max(100).optional(),
    currentAccountNumber: z.string().min(1).max(100).optional(),
    currentPin: z.string().max(50).nullable().optional(),
    requestedFocAt: z.string().datetime().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

// ============================================================================
// Helpers
// ============================================================================

/** Map a TelnyxPortingError code to one of our HTTP responses. */
function respondTelnyx(c: Context, err: TelnyxPortingError, fallback = 'Telnyx request failed') {
  // Always log the underlying Telnyx error so wrangler tail / dev console
  // shows the real cause — the user-facing message is intentionally short.
  console.error('[Porting] Telnyx error:', {
    code: err.code,
    httpStatus: err.httpStatus,
    message: err.message,
    telnyxErrors: err.telnyxErrors,
  });

  switch (err.code) {
    case 'unauthorized':
    case 'forbidden':
      return error.badRequest(
        c,
        // Surface the actual Telnyx message — it's almost always a clear
        // "your account isn't enabled for porting" / "API key lacks scope"
        // and the user can act on it (vs a generic auth-failed string).
        err.message || 'Telnyx authentication failed',
      );
    case 'not_found':
      // 404 here usually means either the wrong endpoint path OR porting
      // isn't available on the workspace's Telnyx account. Surface the
      // raw message + status so the user sees which one.
      return error.badRequest(
        c,
        err.message || 'Telnyx returned 404 — endpoint not available for this account',
      );
    case 'conflict':
      return error.conflict(c, err.message);
    case 'validation_failed':
      return error.badRequest(c, err.message, err.telnyxErrors);
    case 'rate_limited':
      return rateLimited(c);
    case 'telnyx_unavailable':
      return unavailable(c, err.message || 'Telnyx is temporarily unavailable');
    default:
      return error.internal(c, err.message || fallback);
  }
}

/**
 * Refuse edits to fields that Telnyx locks once the order has been submitted.
 * Mirrors Telnyx's own validation but lets us return a friendlier 409 before
 * making the round-trip.
 */
function isEditable(status: string | null): boolean {
  return status === 'draft' || status === 'preflight_failed' || status === 'awaiting_documents';
}

function isCancellable(status: string | null): boolean {
  return isEditable(status);
}

const PORTING_PERMISSION = 'telephony:manage';

type PortingContext = Context<{ Bindings: TelnyxEnv; Variables: Variables }>;

function publishPortingEvent(
  c: PortingContext,
  action: 'created' | 'updated' | 'deleted',
  order: { id: string; phoneNumber?: string | null; status?: string | null },
) {
  publishEntityEvent({
    c,
    entityType: 'voip_porting_order',
    action,
    entityId: order.id,
    data: { id: order.id, phoneNumber: order.phoneNumber ?? null, status: order.status ?? null },
  });
}

// ============================================================================
// Routes
// ============================================================================

const app = new Hono<{ Bindings: TelnyxEnv; Variables: Variables }>();

// ---------- Preflight ----------

app.post(
  '/preflight',
  requirePermission(PORTING_PERMISSION),
  zValidator('json', preflightSchema),
  async (c) => {
    const { phoneNumber } = c.req.valid('json');

    try {
      const result = await preflightCheck(c.env, [phoneNumber]);
      return success(c, result);
    } catch (err) {
      if (err instanceof TelnyxPortingError) return respondTelnyx(c, err, 'Preflight check failed');
      console.error('[Porting] Preflight unexpected:', err);
      return error.internal(c, 'Preflight check failed');
    }
  },
);

// ---------- Create draft ----------

app.post(
  '/',
  requirePermission(PORTING_PERMISSION),
  zValidator('json', createSchema),
  async (c) => {
    const userId = c.get('userId');

    const { phoneNumber, formattedNumber, countryCode, numberType } = c.req.valid('json');
    const db = c.get('tenantDb');

    // Defensive duplicate check before hitting Telnyx — the unique partial
    // index will also catch this, but we want a friendlier error.
    const [existing] = await db
      .select({ id: schema.voipPortingOrders.id, status: schema.voipPortingOrders.status })
      .from(schema.voipPortingOrders)
      .where(
        and(
          eq(schema.voipPortingOrders.phoneNumber, phoneNumber),
          isNull(schema.voipPortingOrders.deletedAt),
        ),
      )
      .limit(1);

    if (existing && !['cancelled', 'exception', 'preflight_failed', 'completed'].includes(existing.status)) {
      return error.conflict(c, `An in-flight port already exists for ${phoneNumber}`);
    }

    const id = generateId('vpo');

    // Persist a draft first so we have a stable customer_reference for
    // Telnyx — that way we can match the Telnyx order back to us via
    // webhook customer_reference even if our POST response is lost.
    try {
      await db.insert(schema.voipPortingOrders).values({
        id,
        createdByUserId: userId,
        phoneNumber,
        formattedNumber: formattedNumber ?? phoneNumber,
        countryCode: countryCode.toUpperCase(),
        numberType,
        status: 'draft',
      });
    } catch (err) {
      console.error('[Porting] Failed to insert draft:', err);
      return error.internal(c, 'Failed to create port order');
    }

    let telnyxOrderId: string;
    try {
      const order = await createPortingOrder(c.env, {
        phoneNumbers: [phoneNumber],
        customerReference: id,
      });
      telnyxOrderId = order.id;

      await db
        .update(schema.voipPortingOrders)
        .set({
          telnyxPortingOrderId: telnyxOrderId,
          status: 'awaiting_documents',
          substatus: order.substatus ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.voipPortingOrders.id, id));
    } catch (err) {
      // Roll the draft back so the unique index doesn't block retries.
      await db
        .update(schema.voipPortingOrders)
        .set({
          status: 'preflight_failed',
          lastErrorCode: err instanceof TelnyxPortingError ? err.code : 'unknown',
          lastErrorMessage: err instanceof Error ? err.message : 'Unknown error',
          updatedAt: new Date(),
        })
        .where(eq(schema.voipPortingOrders.id, id));

      if (err instanceof TelnyxPortingError) return respondTelnyx(c, err, 'Failed to create Telnyx porting order');
      console.error('[Porting] createPortingOrder unexpected:', err);
      return error.internal(c, 'Failed to create Telnyx porting order');
    }

    const [draft] = await db
      .select()
      .from(schema.voipPortingOrders)
      .where(eq(schema.voipPortingOrders.id, id))
      .limit(1);

    publishPortingEvent(c, 'created', { id, phoneNumber, status: draft?.status });

    return success(c, { order: draft }, 201);
  },
);

// ---------- Patch details ----------

app.patch(
  '/:id',
  requirePermission(PORTING_PERMISSION),
  zValidator('json', patchSchema),
  async (c) => {
    const id = c.req.param('id');
    const data = c.req.valid('json');
    const db = c.get('tenantDb');

    const [draft] = await db
      .select()
      .from(schema.voipPortingOrders)
      .where(and(eq(schema.voipPortingOrders.id, id), isNull(schema.voipPortingOrders.deletedAt)))
      .limit(1);

    if (!draft) return error.notFound(c, 'Porting order', id);
    if (!isEditable(draft.status)) {
      return error.conflict(c, `Order is ${draft.status} — fields are locked after submission`);
    }
    if (!draft.telnyxPortingOrderId) {
      return error.conflict(c, 'Order has no Telnyx id — recreate the draft');
    }

    // Push to Telnyx FIRST. If their API rejects the change we don't want
    // a divergent local copy.
    try {
      await updatePortingOrder(c.env, draft.telnyxPortingOrderId, {
        ...data,
        currentPin: data.currentPin ?? undefined,
        requestedFocDate: data.requestedFocAt
          ? data.requestedFocAt.slice(0, 10) // YYYY-MM-DD
          : undefined,
      });
    } catch (err) {
      if (err instanceof TelnyxPortingError) return respondTelnyx(c, err, 'Telnyx rejected the update');
      console.error('[Porting] updatePortingOrder unexpected:', err);
      return error.internal(c, 'Failed to update Telnyx order');
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (data.authorizedName !== undefined) update.authorizedName = data.authorizedName;
    if (data.businessName !== undefined) update.businessName = data.businessName;
    if (data.serviceAddress !== undefined) update.serviceAddress = data.serviceAddress;
    if (data.currentCarrier !== undefined) update.currentCarrier = data.currentCarrier;
    if (data.currentAccountNumber !== undefined) update.currentAccountNumber = data.currentAccountNumber;
    if (data.currentPin !== undefined) update.currentPin = data.currentPin;
    if (data.requestedFocAt !== undefined) update.requestedFocAt = new Date(data.requestedFocAt);

    await db.update(schema.voipPortingOrders).set(update).where(eq(schema.voipPortingOrders.id, id));

    const [refreshed] = await db
      .select()
      .from(schema.voipPortingOrders)
      .where(eq(schema.voipPortingOrders.id, id))
      .limit(1);

    publishPortingEvent(c, 'updated', { id, phoneNumber: draft.phoneNumber, status: refreshed?.status });

    return success(c, { order: refreshed });
  },
);

// ---------- LOA template download ----------

app.post('/:id/loa-template', requirePermission(PORTING_PERMISSION), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');

  const [draft] = await db
    .select()
    .from(schema.voipPortingOrders)
    .where(and(eq(schema.voipPortingOrders.id, id), isNull(schema.voipPortingOrders.deletedAt)))
    .limit(1);
  if (!draft) return error.notFound(c, 'Porting order', id);
  if (!draft.telnyxPortingOrderId) return error.conflict(c, 'Order has no Telnyx id yet');

  try {
    const pdf = await fetchLoaTemplate(c.env, draft.telnyxPortingOrderId);
    return new Response(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="loa-${draft.id}.pdf"`,
      },
    });
  } catch (err) {
    if (err instanceof TelnyxPortingError) return respondTelnyx(c, err, 'Failed to fetch LOA template');
    console.error('[Porting] fetchLoaTemplate unexpected:', err);
    return error.internal(c, 'Failed to fetch LOA template');
  }
});

// ---------- Document upload (LOA + bill copy share the same handler) ----------

async function handleDocumentUpload(c: PortingContext, type: PortDocType) {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.internal(c, 'Workspace context missing');

  const id = c.req.param('id');
  const db = c.get('tenantDb');

  const [draft] = await db
    .select()
    .from(schema.voipPortingOrders)
    .where(and(eq(schema.voipPortingOrders.id, id), isNull(schema.voipPortingOrders.deletedAt)))
    .limit(1);
  if (!draft) return error.notFound(c, 'Porting order', id);
  if (!isEditable(draft.status)) {
    return error.conflict(c, `Order is ${draft.status} — documents are locked after submission`);
  }
  if (!draft.telnyxPortingOrderId) return error.conflict(c, 'Order has no Telnyx id yet');

  const form = await c.req.formData().catch(() => null);
  // workers-types may narrow FormData.get() to `string | null`; widen so the
  // runtime File check compiles under either lib.
  const file = form?.get('file') as unknown;
  if (!file || !(file instanceof File)) return error.badRequest(c, 'Missing "file" form field');

  let key: string;
  let pdfBytes: ArrayBuffer;
  try {
    const result = await uploadPortDoc(c.env, {
      workspaceId,
      portingOrderId: id,
      type,
      file,
    });
    key = result.key;
    pdfBytes = await file.arrayBuffer();
  } catch (err) {
    if (err instanceof PortDocError) {
      const d = err.detail;
      if (d.code === 'too_large') {
        return c.json(
          { error: { code: 'TOO_LARGE', message: `File exceeds ${d.limitBytes} bytes`, details: d } },
          413,
        );
      }
      if (d.code === 'not_pdf') return error.badRequest(c, 'File is not a valid PDF', d);
      if (d.code === 'empty') return error.badRequest(c, 'File is empty');
    }
    console.error('[Porting] uploadPortDoc failed:', err);
    return error.internal(c, 'Failed to store document');
  }

  // Push to Telnyx. If this fails we keep the R2 file so the user can
  // retry without re-uploading; we surface the error so the UI can show
  // a "Try again" button rather than wiping their work.
  try {
    await attachOrderDocument(c.env, {
      telnyxOrderId: draft.telnyxPortingOrderId,
      pdfBytes,
      filename: type === 'loa' ? 'signed-loa.pdf' : 'current-bill.pdf',
      documentType: type === 'loa' ? 'loa' : 'invoice',
    });
  } catch (err) {
    if (err instanceof TelnyxPortingError) {
      return respondTelnyx(c, err, 'Telnyx rejected the document upload');
    }
    console.error('[Porting] attachOrderDocument unexpected:', err);
    return error.internal(c, 'Failed to attach document to Telnyx order');
  }

  const updateField = type === 'loa' ? { loaStorageKey: key } : { billCopyStorageKey: key };
  await db
    .update(schema.voipPortingOrders)
    .set({ ...updateField, updatedAt: new Date() })
    .where(eq(schema.voipPortingOrders.id, id));

  publishPortingEvent(c, 'updated', { id, phoneNumber: draft.phoneNumber, status: draft.status });

  return success(c, { storageKey: key });
}

app.post('/:id/loa', requirePermission(PORTING_PERMISSION), (c) =>
  handleDocumentUpload(c, 'loa'),
);
app.post('/:id/bill-copy', requirePermission(PORTING_PERMISSION), (c) =>
  handleDocumentUpload(c, 'bill'),
);

// ---------- Submit ----------

app.post('/:id/submit', requirePermission(PORTING_PERMISSION), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const id = c.req.param('id');
  const db = c.get('tenantDb');

  const [draft] = await db
    .select()
    .from(schema.voipPortingOrders)
    .where(and(eq(schema.voipPortingOrders.id, id), isNull(schema.voipPortingOrders.deletedAt)))
    .limit(1);
  if (!draft) return error.notFound(c, 'Porting order', id);
  if (draft.status !== 'awaiting_documents') {
    return error.conflict(c, `Cannot submit from status '${draft.status}'`);
  }
  if (!draft.telnyxPortingOrderId) return error.conflict(c, 'Order has no Telnyx id yet');

  // Required-field gate.
  const missing: string[] = [];
  if (!draft.authorizedName) missing.push('authorizedName');
  if (!draft.businessName) missing.push('businessName');
  if (!draft.serviceAddress) missing.push('serviceAddress');
  if (!draft.currentCarrier) missing.push('currentCarrier');
  if (!draft.currentAccountNumber) missing.push('currentAccountNumber');
  if (!draft.loaStorageKey) missing.push('loa');
  if (!draft.billCopyStorageKey) missing.push('billCopy');
  if (missing.length > 0) {
    return error.badRequest(c, `Missing required fields/documents: ${missing.join(', ')}`, { missing });
  }

  // Pricing lookup — refuse if we don't know how to bill this number.
  const masterDb = getMasterDb(c.env);
  const [pricing] = await masterDb
    .select()
    .from(masterSchema.telephonyNumberPricing)
    .where(
      and(
        eq(masterSchema.telephonyNumberPricing.countryCode, (draft.countryCode ?? '').toUpperCase()),
        eq(masterSchema.telephonyNumberPricing.numberType, (draft.numberType ?? '').toLowerCase()),
        eq(masterSchema.telephonyNumberPricing.isActive, true),
      ),
    )
    .limit(1);

  if (!pricing?.stripePriceId) {
    return unprocessable(
      c,
      `No active pricing configured for ${draft.countryCode}/${draft.numberType} — cannot bill, port refused`,
    );
  }

  // Charge / verify subscription via billing-worker. Mirrors the new-purchase
  // flow in routes/telephony (provision endpoint).
  const authHeader = c.req.header('Authorization');
  const billingUrl = billingWorkerUrl(c.env);

  let billingResult: Record<string, any>;
  try {
    const billingResp = await fetch(`${billingUrl}/api/billing/phone/add-number`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        stripePriceId: pricing.stripePriceId,
        countryCode: draft.countryCode,
        numberType: draft.numberType,
        phoneNumber: draft.phoneNumber,
        displayName: draft.businessName,
      }),
    });
    billingResult = (await billingResp.json()) as Record<string, any>;
  } catch (err) {
    console.error('[Porting] Billing call failed:', err);
    return unavailable(c, 'Billing service is unavailable — try again');
  }

  if (billingResult.requiresCheckout) {
    // User has no payment method — they need to go through Stripe checkout
    // first. Mirror the existing flow's behaviour and surface the URL.
    try {
      const checkoutResp = await fetch(`${billingUrl}/api/billing/phone/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          stripePriceId: pricing.stripePriceId,
          phoneNumber: draft.phoneNumber,
          countryCode: draft.countryCode,
          numberType: draft.numberType,
          displayName: draft.businessName,
        }),
      });
      const checkout = (await checkoutResp.json()) as Record<string, any>;
      return success(c, { requiresCheckout: true, checkoutUrl: checkout.url });
    } catch {
      return unavailable(c, 'Could not start checkout — try again');
    }
  }

  if (!billingResult.success && !billingResult.subscriptionId) {
    return error.badRequest(c, billingResult.error || 'Billing setup failed');
  }

  // Submit to Telnyx. If this fails after billing succeeded, we don't
  // automatically refund — admin reconciles. (Same edge case the new-
  // purchase flow has lived with.)
  try {
    const submitted = await submitPortingOrder(c.env, draft.telnyxPortingOrderId);

    // Master-DB index — webhooks will look this up.
    await masterDb
      .insert(masterSchema.telnyxPortingOrderIndex)
      .values({
        telnyxPortingOrderId: draft.telnyxPortingOrderId,
        clerkOrgId: orgId,
        draftId: draft.id,
      })
      .onConflictDoNothing();

    await db
      .update(schema.voipPortingOrders)
      .set({
        status: 'submitted',
        substatus: submitted.substatus ?? null,
        stripePriceId: pricing.stripePriceId,
        billingActivated: true,
        billingError: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.voipPortingOrders.id, id));
  } catch (err) {
    if (err instanceof TelnyxPortingError) {
      // Persist so the UI can surface the rejection without re-fetching.
      await db
        .update(schema.voipPortingOrders)
        .set({
          billingActivated: true, // billing went through
          stripePriceId: pricing.stripePriceId,
          lastErrorCode: err.code,
          lastErrorMessage: err.message,
          updatedAt: new Date(),
        })
        .where(eq(schema.voipPortingOrders.id, id));
      return respondTelnyx(c, err, 'Telnyx rejected the submission');
    }
    console.error('[Porting] submitPortingOrder unexpected:', err);
    return error.internal(c, 'Failed to submit port order');
  }

  const [refreshed] = await db
    .select()
    .from(schema.voipPortingOrders)
    .where(eq(schema.voipPortingOrders.id, id))
    .limit(1);

  publishPortingEvent(c, 'updated', { id, phoneNumber: draft.phoneNumber, status: refreshed?.status });

  return success(c, { order: refreshed });
});

// ---------- List ----------

app.get('/', requirePermission(PORTING_PERMISSION), async (c) => {
  const db = c.get('tenantDb');
  const orders = await db
    .select()
    .from(schema.voipPortingOrders)
    .where(isNull(schema.voipPortingOrders.deletedAt))
    .orderBy(desc(schema.voipPortingOrders.createdAt))
    .limit(100);

  return success(c, { orders });
});

// ---------- Get one ----------

app.get('/:id', requirePermission(PORTING_PERMISSION), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');

  const [order] = await db
    .select()
    .from(schema.voipPortingOrders)
    .where(and(eq(schema.voipPortingOrders.id, id), isNull(schema.voipPortingOrders.deletedAt)))
    .limit(1);
  if (!order) return error.notFound(c, 'Porting order', id);
  return success(c, { order });
});

// ---------- Refresh from Telnyx ----------

app.post('/:id/refresh', requirePermission(PORTING_PERMISSION), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');

  const [draft] = await db
    .select()
    .from(schema.voipPortingOrders)
    .where(and(eq(schema.voipPortingOrders.id, id), isNull(schema.voipPortingOrders.deletedAt)))
    .limit(1);
  if (!draft) return error.notFound(c, 'Porting order', id);
  if (!draft.telnyxPortingOrderId) return error.conflict(c, 'Order has no Telnyx id yet');

  try {
    const remote = await getPortingOrder(c.env, draft.telnyxPortingOrderId);
    await db
      .update(schema.voipPortingOrders)
      .set({
        substatus: remote.substatus ?? null,
        actualFocAt: remote.actualFocDate ? new Date(remote.actualFocDate) : draft.actualFocAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.voipPortingOrders.id, id));
  } catch (err) {
    if (err instanceof TelnyxPortingError) {
      if (err.code === 'not_found') {
        // Telnyx no longer knows about this order — mark as exception so
        // the user sees something rather than a stuck status.
        await db
          .update(schema.voipPortingOrders)
          .set({
            status: 'exception',
            lastErrorCode: 'telnyx_not_found',
            lastErrorMessage: 'Telnyx no longer recognizes this order',
            updatedAt: new Date(),
          })
          .where(eq(schema.voipPortingOrders.id, id));
      }
      return respondTelnyx(c, err, 'Refresh failed');
    }
    console.error('[Porting] refresh unexpected:', err);
    return error.internal(c, 'Refresh failed');
  }

  const [refreshed] = await db
    .select()
    .from(schema.voipPortingOrders)
    .where(eq(schema.voipPortingOrders.id, id))
    .limit(1);
  return success(c, { order: refreshed });
});

// ---------- Cancel ----------

app.delete('/:id', requirePermission(PORTING_PERMISSION), async (c) => {
  const workspaceId = c.get('workspaceId');

  const id = c.req.param('id');
  const db = c.get('tenantDb');

  const [draft] = await db
    .select()
    .from(schema.voipPortingOrders)
    .where(and(eq(schema.voipPortingOrders.id, id), isNull(schema.voipPortingOrders.deletedAt)))
    .limit(1);
  if (!draft) return error.notFound(c, 'Porting order', id);

  if (!isCancellable(draft.status)) {
    return error.conflict(
      c,
      'Submitted ports cannot be cancelled via API — contact support to coordinate with the carrier',
    );
  }

  // Best-effort delete on Telnyx. Even if it 404s we proceed — the local
  // row is the source of truth for "what the user can see".
  if (draft.telnyxPortingOrderId) {
    try {
      await deletePortingOrder(c.env, draft.telnyxPortingOrderId);
    } catch (err) {
      console.warn('[Porting] Telnyx delete failed (continuing):', err);
    }
  }

  if (workspaceId) {
    await deletePortDocs(c.env, workspaceId, draft.id);
  }

  await db
    .update(schema.voipPortingOrders)
    .set({
      status: 'cancelled',
      deletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.voipPortingOrders.id, id));

  publishPortingEvent(c, 'deleted', { id, phoneNumber: draft.phoneNumber, status: 'cancelled' });

  return success(c, { success: true });
});

export { app as portingRoutes };
