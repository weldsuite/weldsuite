/**
 * /api/porting on pglite: the portability check, a draft and its Telnyx
 * order, the details, the LOA template, the signed LOA and the bill copy (in
 * the `STORAGE` bucket, attached on Telnyx), the submission, a refresh and
 * cancelling. Telnyx is a fetch stub answering by URL; the price list lives
 * in a master pglite, and the bucket is an in-memory R2, both shared with the
 * Rust server in conformance mode.
 *
 * `ENVIRONMENT: 'development'` points billing-worker at its local URL, which
 * refuses the connection: a submission then stops where it does without
 * billing-worker, which is what the Kubernetes editions answer (billing is
 * Global-only).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { json, stubTelnyx, telnyxError } from '../../test/telnyx-stub';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(holder.master) };
});

import { portingRoutes } from './index';

const BASE = '/api/porting';
const ENV = { ENVIRONMENT: 'development', TELNYX_API_KEY: 'telnyx-key' };
const PDF = new TextEncoder().encode('%PDF-1.4 signed');

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const telnyx = stubTelnyx();
const storage = createMemoryR2();

interface Options {
  orgId?: string | null;
  clerkOrgId?: string | null;
  env?: Record<string, unknown>;
  grants?: string[];
}

function app(options: Options = {}) {
  return createTestApp(BASE, portingRoutes, {
    context: {
      tenantDb: db,
      masterDb: master,
      ...(options.orgId === undefined ? {} : { orgId: options.orgId }),
      ...(options.clerkOrgId === undefined ? {} : { clerkOrgId: options.clerkOrgId }),
      permissions: permissions(...(options.grants ?? ['telephony:manage'])),
    },
    env: { ...ENV, STORAGE: storage, ...options.env } as never,
  });
}

function send(method: string, path: string, body?: unknown, options: Options = {}) {
  return app(options).request(`${BASE}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

function upload(path: string, file: Blob | string | null, options: Options = {}) {
  const form = new FormData();
  if (typeof file === 'string') form.append('file', file);
  else if (file) form.append('file', file, 'document.pdf');
  return app(options).request(`${BASE}${path}`, { method: 'POST', body: form });
}

let seeded = 0;

async function seedOrder(id: string, values: Partial<typeof schema.voipPortingOrders.$inferInsert> = {}) {
  await db.insert(schema.voipPortingOrders).values({
    id,
    createdByUserId: 'user_test_default',
    phoneNumber: `+3120${5000000 + (seeded += 1)}`,
    countryCode: 'NL',
    numberType: 'local',
    status: 'awaiting_documents',
    telnyxPortingOrderId: `po-${id}`,
    ...values,
  });
}

async function order(id: string) {
  const [row] = await db.select().from(schema.voipPortingOrders).where(eq(schema.voipPortingOrders.id, id));
  return row;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master.insert(masterSchema.telephonyNumberPricing).values([
    { id: 'tnp_nl_local', countryCode: 'NL', numberType: 'local', monthlyPrice: '1.00', stripePriceId: 'price_nl' },
    { id: 'tnp_nl_mobile', countryCode: 'NL', numberType: 'mobile', monthlyPrice: '2.00' },
  ]);
  telnyx.on('POST', '/porting_orders', ({ body }) => {
    const phone = (body as { phone_numbers: string[] }).phone_numbers[0];
    if (phone === '+31209999999') return telnyxError(409, 'Number already in a port');
    return json({
      data: {
        id: `po-${phone}`,
        status: 'draft',
        sub_status: 'awaiting_loa',
        customer_reference: (body as { customer_reference: string }).customer_reference,
        phone_numbers: [{ phone_number: phone }],
      },
    });
  });
}, 180_000);

afterAll(() => vi.unstubAllGlobals());

describe('POST /preflight', () => {
  it('validates the number', async () => {
    expect((await send('POST', '/preflight', { phoneNumber: '0612345678', countryCode: 'NL' })).status).toBe(400);
    expect((await send('POST', '/preflight', { phoneNumber: '+316123', countryCode: 'NLD' })).status).toBe(400);
  });

  it('reports what Telnyx says', async () => {
    telnyx.on('POST', '/portability_checks', ({ body }) => {
      const [phone] = (body as { phone_numbers: string[] }).phone_numbers;
      if (phone === '+31201110000') return json({ data: [{ phone_number: phone, portable: true }] });
      if (phone === '+31201110001') return json({ data: [{ phone_number: phone, portable: false, not_portable_reason: 'Rate center' }] });
      if (phone === '+31201110002') return json({ data: [] });
      if (phone === '+31201110003') return telnyxError(401, 'Porting is not enabled');
      if (phone === '+31201110004') return json({ errors: [{ detail: 'Bad number', source: { pointer: '/phone_numbers' } }] }, 422);
      if (phone === '+31201110005') return telnyxError(429);
      if (phone === '+31201110006') return new Response('down', { status: 503 });
      return telnyxError(418, 'Teapot');
    });
    const check = async (phoneNumber: string) => {
      const res = await send('POST', '/preflight', { phoneNumber, countryCode: 'NL' });
      return { status: res.status, body: (await res.json()) as { data: Record<string, unknown> } };
    };
    expect(await check('+31201110000')).toEqual({
      status: 200,
      body: { data: { portable: true, reasons: [], raw: [{ phone_number: '+31201110000', portable: true }] } },
    });
    expect((await check('+31201110001')).body.data.reasons).toEqual(['+31201110001: Rate center']);
    expect((await check('+31201110002')).body.data).toEqual({
      portable: false,
      reasons: ['Telnyx returned no portability data for this number'],
      raw: [],
    });
    expect(await check('+31201110003')).toEqual({
      status: 400,
      body: { error: { code: 'BAD_REQUEST', message: 'Telnyx 401: Porting is not enabled' } },
    });
    expect(await check('+31201110004')).toEqual({
      status: 400,
      body: {
        error: {
          code: 'BAD_REQUEST',
          message: 'Telnyx 422: Bad number',
          details: [{ detail: 'Bad number', source: { pointer: '/phone_numbers' } }],
        },
      },
    });
    expect(await check('+31201110005')).toEqual({ status: 429, body: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } } });
    expect(await check('+31201110006')).toEqual({
      status: 503,
      body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Telnyx 503 on /portability_checks — no body — body: down' } },
    });
    expect(await check('+31201110007')).toEqual({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Telnyx 418: Teapot' } } });
  });

  it('needs the API key', async () => {
    const res = await send('POST', '/preflight', { phoneNumber: '+31201110000', countryCode: 'NL' }, { env: { TELNYX_API_KEY: undefined } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Telnyx API key is not configured on this worker' },
    });
  });
});

describe('POST / (draft)', () => {
  it('validates the body', async () => {
    expect((await send('POST', '', { phoneNumber: '+31201120000', countryCode: 'NL', numberType: 'toll_free' })).status).toBe(400);
  });

  it('creates a draft and its Telnyx order, once per number', async () => {
    const res = await send('POST', '', { phoneNumber: '+31201120001', countryCode: 'nl', numberType: 'mobile' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { order: Record<string, unknown> } };
    expect(data.order).toMatchObject({
      phoneNumber: '+31201120001',
      formattedNumber: '+31201120001',
      countryCode: 'NL',
      numberType: 'mobile',
      status: 'awaiting_documents',
      substatus: 'awaiting_loa',
      telnyxPortingOrderId: 'po-+31201120001',
      createdByUserId: 'user_test_default',
    });
    const again = await send('POST', '', { phoneNumber: '+31201120001', countryCode: 'NL' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: { code: 'CONFLICT', message: 'An in-flight port already exists for +31201120001' } });
  });

  it('marks the draft when Telnyx refuses it', async () => {
    const res = await send('POST', '', { phoneNumber: '+31209999999', formattedNumber: '020 999 9999', countryCode: 'NL' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'Telnyx 409: Number already in a port' } });
    const [draft] = await db.select().from(schema.voipPortingOrders).where(eq(schema.voipPortingOrders.phoneNumber, '+31209999999'));
    expect(draft).toMatchObject({ status: 'preflight_failed', lastErrorCode: 'conflict', lastErrorMessage: 'Telnyx 409: Number already in a port' });
    // A failed draft does not block a new one.
    expect((await send('POST', '', { phoneNumber: '+31209999999', countryCode: 'NL' })).status).toBe(409);
  });
});

describe('PATCH /:id', () => {
  it('refuses an empty change, unknown and locked orders', async () => {
    await seedOrder('vpo_patch_locked', { status: 'submitted' });
    await seedOrder('vpo_patch_no_tx', { status: 'draft', telnyxPortingOrderId: null });
    expect((await send('PATCH', '/vpo_patch_locked', {})).status).toBe(400);
    expect((await send('PATCH', '/vpo_patch_locked', { requestedFocAt: 'tomorrow' })).status).toBe(400);
    expect((await send('PATCH', '/vpo_missing', { authorizedName: 'Ann' })).status).toBe(404);
    const locked = await send('PATCH', '/vpo_patch_locked', { authorizedName: 'Ann' });
    expect(await locked.json()).toEqual({ error: { code: 'CONFLICT', message: 'Order is submitted — fields are locked after submission' } });
    const noTelnyx = await send('PATCH', '/vpo_patch_no_tx', { authorizedName: 'Ann' });
    expect(await noTelnyx.json()).toEqual({ error: { code: 'CONFLICT', message: 'Order has no Telnyx id — recreate the draft' } });
  });

  it('pushes the details to Telnyx, then stores them', async () => {
    await seedOrder('vpo_patch_ok', { status: 'draft', currentPin: '1234' });
    telnyx.on('PATCH', '/porting_orders/po-vpo_patch_ok', ({ body }) => json({ data: { id: 'po-vpo_patch_ok', status: 'draft', echo: body } }));
    const res = await send('PATCH', '/vpo_patch_ok', {
      authorizedName: 'Ann Lee',
      businessName: 'Acme',
      serviceAddress: { line1: 'Main 1', city: 'Amsterdam', region: 'NH', postalCode: '1000AA', country: 'NL' },
      currentCarrier: 'KPN',
      currentAccountNumber: 'ACC-1',
      currentPin: null,
      requestedFocAt: '2026-12-01T09:00:00Z',
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { order: Record<string, unknown> } };
    expect(data.order).toMatchObject({
      authorizedName: 'Ann Lee',
      businessName: 'Acme',
      serviceAddress: { line1: 'Main 1', city: 'Amsterdam', region: 'NH', postalCode: '1000AA', country: 'NL' },
      currentPin: null,
      requestedFocAt: '2026-12-01T09:00:00.000Z',
    });
  });

  it('maps a Telnyx refusal', async () => {
    await seedOrder('vpo_patch_refused', { status: 'awaiting_documents' });
    telnyx.on('PATCH', '/porting_orders/po-vpo_patch_refused', () => json({ errors: [{ title: 'Invalid FOC date' }] }, 422));
    const res = await send('PATCH', '/vpo_patch_refused', { requestedFocAt: '2026-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Telnyx 422: Invalid FOC date', details: [{ title: 'Invalid FOC date' }] },
    });
  });
});

describe('POST /:id/loa-template', () => {
  it('streams Telnyx\x27s LOA', async () => {
    await seedOrder('vpo_loa_template');
    await seedOrder('vpo_loa_template_no_tx', { telnyxPortingOrderId: null });
    expect((await send('POST', '/vpo_missing/loa-template')).status).toBe(404);
    expect((await send('POST', '/vpo_loa_template_no_tx/loa-template')).status).toBe(409);
    telnyx.on('GET', '/porting_orders/po-vpo_loa_template/loa_template', () =>
      new Response(PDF, { headers: { 'content-type': 'application/pdf' } }),
    );
    const res = await send('POST', '/vpo_loa_template/loa-template');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="loa-vpo_loa_template.pdf"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    telnyx.on('GET', '/porting_orders/po-vpo_loa_template/loa_template', () => telnyxError(404));
    const missing = await send('POST', '/vpo_loa_template/loa-template');
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Telnyx 404 on /porting_orders/po-vpo_loa_template/loa_template — no body — body: {}' },
    });
  });
});

describe('document uploads', () => {
  it('checks the order, the form and the PDF', async () => {
    await seedOrder('vpo_doc_checks');
    await seedOrder('vpo_doc_locked', { status: 'in_process' });
    await seedOrder('vpo_doc_no_tx', { telnyxPortingOrderId: null });
    const pdf = new Blob([PDF], { type: 'application/pdf' });
    expect((await upload('/vpo_doc_checks/loa', pdf, { clerkOrgId: null })).status).toBe(500);
    expect((await upload('/vpo_missing/loa', pdf)).status).toBe(404);
    expect(await (await upload('/vpo_doc_locked/bill-copy', pdf)).json()).toEqual({
      error: { code: 'CONFLICT', message: 'Order is in_process — documents are locked after submission' },
    });
    expect((await upload('/vpo_doc_no_tx/loa', pdf)).status).toBe(409);
    expect(await (await upload('/vpo_doc_checks/loa', 'text')).json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Missing "file" form field' },
    });
    expect(await (await upload('/vpo_doc_checks/loa', new Blob([]))).json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'File is empty' },
    });
    expect(await (await upload('/vpo_doc_checks/loa', new Blob(['hello']))).json()).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'File is not a valid PDF',
        details: { code: 'not_pdf', detail: 'File does not start with the PDF signature (%PDF)' },
      },
    });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF);
    const tooLarge = await upload('/vpo_doc_checks/loa', new Blob([big]));
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({
      error: {
        code: 'TOO_LARGE',
        message: 'File exceeds 10485760 bytes',
        details: { code: 'too_large', sizeBytes: 10485761, limitBytes: 10485760 },
      },
    });
    const noBucket = await upload('/vpo_doc_checks/loa', pdf, { env: { STORAGE: undefined } });
    expect(await noBucket.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to store document' } });
  });

  it('stores the signed LOA and the bill copy, and attaches them on Telnyx', async () => {
    await seedOrder('vpo_doc_ok');
    telnyx.on('POST', '/documents', { data: { id: 'doc-uploaded' } });
    telnyx.on('PATCH', '/porting_orders/po-vpo_doc_ok', ({ body }) => json({ data: { id: 'po-vpo_doc_ok', documents: (body as { documents: unknown }).documents } }));
    const loa = await upload('/vpo_doc_ok/loa', new Blob([PDF], { type: 'application/pdf' }));
    expect(await loa.json()).toEqual({ data: { storageKey: 'port-orders/org_test_default/vpo_doc_ok/loa.pdf' } });
    const bill = await upload('/vpo_doc_ok/bill-copy', new Blob([PDF], { type: 'application/pdf' }));
    expect(await bill.json()).toEqual({ data: { storageKey: 'port-orders/org_test_default/vpo_doc_ok/bill.pdf' } });
    const stored = await storage.get('port-orders/org_test_default/vpo_doc_ok/loa.pdf');
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PDF);
    expect(await order('vpo_doc_ok')).toMatchObject({
      loaStorageKey: 'port-orders/org_test_default/vpo_doc_ok/loa.pdf',
      billCopyStorageKey: 'port-orders/org_test_default/vpo_doc_ok/bill.pdf',
    });
  });

  it('keeps the stored file when Telnyx refuses it', async () => {
    await seedOrder('vpo_doc_refused');
    telnyx.on('POST', '/documents', () => telnyxError(422, 'Not a PDF Telnyx accepts'));
    const res = await upload('/vpo_doc_refused/loa', new Blob([PDF]));
    expect(res.status).toBe(400);
    expect(await storage.head('port-orders/org_test_default/vpo_doc_refused/loa.pdf')).not.toBeNull();
    expect((await order('vpo_doc_refused'))?.loaStorageKey).toBeNull();
  });
});

describe('POST /:id/submit', () => {
  const complete = {
    authorizedName: 'Ann',
    businessName: 'Acme',
    serviceAddress: { line1: 'Main 1', city: 'Amsterdam', region: 'NH', postalCode: '1000AA', country: 'NL' },
    currentCarrier: 'KPN',
    currentAccountNumber: 'ACC-1',
    loaStorageKey: 'port-orders/x/loa.pdf',
    billCopyStorageKey: 'port-orders/x/bill.pdf',
  };

  it('checks the workspace, the order and its documents', async () => {
    await seedOrder('vpo_submit_draft', { status: 'draft' });
    await seedOrder('vpo_submit_no_tx', { telnyxPortingOrderId: null });
    await seedOrder('vpo_submit_missing', { authorizedName: 'Ann', serviceAddress: complete.serviceAddress });
    expect((await send('POST', '/vpo_submit_draft/submit', undefined, { orgId: null })).status).toBe(400);
    expect((await send('POST', '/vpo_missing/submit')).status).toBe(404);
    expect(await (await send('POST', '/vpo_submit_draft/submit')).json()).toEqual({
      error: { code: 'CONFLICT', message: "Cannot submit from status 'draft'" },
    });
    expect((await send('POST', '/vpo_submit_no_tx/submit')).status).toBe(409);
    expect(await (await send('POST', '/vpo_submit_missing/submit')).json()).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Missing required fields/documents: businessName, currentCarrier, currentAccountNumber, loa, billCopy',
        details: { missing: ['businessName', 'currentCarrier', 'currentAccountNumber', 'loa', 'billCopy'] },
      },
    });
  });

  it('needs a price, then billing-worker', async () => {
    await seedOrder('vpo_submit_unpriced', { ...complete, countryCode: 'BE' });
    await seedOrder('vpo_submit_priced', { ...complete });
    const unpriced = await send('POST', '/vpo_submit_unpriced/submit');
    expect(unpriced.status).toBe(422);
    expect(await unpriced.json()).toEqual({
      error: { code: 'UNPROCESSABLE_ENTITY', message: 'No active pricing configured for BE/local — cannot bill, port refused' },
    });
    const priced = await send('POST', '/vpo_submit_priced/submit');
    expect(priced.status).toBe(503);
    expect(await priced.json()).toEqual({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Billing service is unavailable — try again' },
    });
  });
});

describe('reading, refreshing and cancelling', () => {
  it('lists and reads live orders', async () => {
    const listed = (await (await send('GET', '')).json()) as { data: { orders: Array<{ id: string }> } };
    expect(listed.data.orders.length).toBeGreaterThan(5);
    const one = await send('GET', '/vpo_doc_ok');
    expect(await one.json()).toMatchObject({ data: { order: { id: 'vpo_doc_ok' } } });
    expect((await send('GET', '/vpo_missing')).status).toBe(404);
  });

  it('refreshes from Telnyx', async () => {
    await seedOrder('vpo_refresh', { status: 'submitted' });
    await seedOrder('vpo_refresh_gone', { status: 'submitted' });
    await seedOrder('vpo_refresh_no_tx', { telnyxPortingOrderId: null });
    expect((await send('POST', '/vpo_missing/refresh')).status).toBe(404);
    expect((await send('POST', '/vpo_refresh_no_tx/refresh')).status).toBe(409);
    telnyx.on('GET', '/porting_orders/po-vpo_refresh', {
      data: { id: 'po-vpo_refresh', status: 'in-process', sub_status: 'foc_confirmed', actual_foc_date: '2026-11-20T10:00:00Z' },
    });
    const res = await send('POST', '/vpo_refresh/refresh');
    expect(await res.json()).toMatchObject({
      data: { order: { substatus: 'foc_confirmed', actualFocAt: '2026-11-20T10:00:00.000Z', status: 'submitted' } },
    });
    const gone = await send('POST', '/vpo_refresh_gone/refresh');
    expect(gone.status).toBe(400);
    expect(await order('vpo_refresh_gone')).toMatchObject({
      status: 'exception',
      lastErrorCode: 'telnyx_not_found',
      lastErrorMessage: 'Telnyx no longer recognizes this order',
    });
  });

  it('cancels a draft, on Telnyx and in the bucket too', async () => {
    await seedOrder('vpo_cancel', { status: 'draft' });
    await seedOrder('vpo_cancel_locked', { status: 'submitted' });
    await storage.put('port-orders/org_test_default/vpo_cancel/loa.pdf', PDF);
    expect((await send('DELETE', '/vpo_missing')).status).toBe(404);
    expect(await (await send('DELETE', '/vpo_cancel_locked')).json()).toEqual({
      error: {
        code: 'CONFLICT',
        message: 'Submitted ports cannot be cancelled via API — contact support to coordinate with the carrier',
      },
    });
    telnyx.on('DELETE', '/porting_orders/po-vpo_cancel', () => telnyxError(404));
    expect(await (await send('DELETE', '/vpo_cancel')).json()).toEqual({ data: { success: true } });
    expect(await storage.head('port-orders/org_test_default/vpo_cancel/loa.pdf')).toBeNull();
    expect(await order('vpo_cancel')).toMatchObject({ status: 'cancelled' });
    expect((await send('GET', '/vpo_cancel')).status).toBe(404);
  });
});
