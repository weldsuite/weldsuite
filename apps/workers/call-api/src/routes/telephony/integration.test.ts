/**
 * /api/telephony on pglite: the workspace's Telnyx numbers (display name,
 * default, removal, search, purchase, sync), Telnyx addresses, ordering
 * requirements and documents, and the price list. Telnyx is a fetch stub
 * answering by URL; the price list and the inbound registry live in a master
 * pglite, shared with the Rust server in conformance mode.
 *
 * `ENVIRONMENT: 'development'` points billing-worker at its local URL, which
 * refuses the connection (../../test/telnyx-stub.ts): buying a number then
 * fails as it does without billing-worker, which is what the Kubernetes
 * editions answer (billing is Global-only).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { json, stubTelnyx, telnyxError } from '../../test/telnyx-stub';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(holder.master) };
});

import { telephonyRoutes } from './index';

const BASE = '/api/telephony';
const TELNYX_ENV = { TELNYX_API_KEY: 'telnyx-key', TELNYX_CONNECTION_ID: 'conn-1' };

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const telnyx = stubTelnyx();

interface Options {
  configured?: boolean;
  grants?: string[];
  env?: Record<string, unknown>;
}

function send(method: string, path: string, body?: unknown, options: Options = {}) {
  const env = { ENVIRONMENT: 'development', ...(options.configured === false ? {} : TELNYX_ENV), ...options.env };
  const { request } = createTestApp(BASE, telephonyRoutes, {
    context: {
      tenantDb: db,
      masterDb: master,
      permissions: permissions(...(options.grants ?? ['telephony:read', 'telephony:manage'])),
    },
    env: env as never,
  });
  return request(`${BASE}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

async function seedNumber(id: string, phoneNumber: string, values: Partial<typeof schema.voipPhoneNumbers.$inferInsert> = {}) {
  await db.insert(schema.voipPhoneNumbers).values({
    id,
    provider: 'telnyx',
    phoneNumber,
    countryCode: 'NL',
    numberType: 'local',
    status: 'active',
    ...values,
  });
}

async function registry(phoneNumber: string) {
  const [row] = await master
    .select()
    .from(masterSchema.phoneNumberRegistry)
    .where(eq(masterSchema.phoneNumberRegistry.phoneNumber, phoneNumber));
  return row as { isActive: boolean; voipPhoneNumberId: string; clerkOrgId: string } | undefined;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master.insert(masterSchema.telephonyNumberPricing).values([
    { id: 'tnp_nl_local', countryCode: 'NL', numberType: 'local', monthlyPrice: '1.00', setupFee: '0.50', currency: 'EUR', stripePriceId: 'price_nl', markupPercent: '20.00' },
    { id: 'tnp_us_tf', countryCode: 'US', numberType: 'toll-free', monthlyPrice: '2.00', setupFee: '0', currency: 'USD', markupAmount: 150 },
    { id: 'tnp_default', countryCode: '*', numberType: '*', monthlyPrice: '0', setupFee: '0', markupAmount: 100 },
    { id: 'tnp_gb_old', countryCode: 'GB', numberType: 'local', monthlyPrice: '3.00', setupFee: '1.00', isActive: false },
  ]);
  await master.insert(masterSchema.telephonyServiceRates).values([
    { id: 'tsr_call', serviceType: 'voip_call_minute', creditsPerUnit: '2.50' },
    { id: 'tsr_old', serviceType: 'call_transcription_minute', creditsPerUnit: '9.00', isActive: false },
  ]);
}, 180_000);

afterAll(() => vi.unstubAllGlobals());

describe('configuration', () => {
  it('reports whether Telnyx is configured', async () => {
    expect(await (await send('GET', '/configured', undefined, { configured: false })).json()).toEqual({ data: { configured: false } });
    expect(await (await send('GET', '/configured')).json()).toEqual({ data: { configured: true } });
  });

  it('answers the static lists', async () => {
    expect(await (await send('GET', '/bundles')).json()).toEqual({ data: { bundles: [] } });
    expect(await (await send('GET', '/address-required/nl')).json()).toEqual({ data: { required: true, countryCode: 'nl' } });
    expect(await (await send('GET', '/address-required/US')).json()).toEqual({ data: { required: false, countryCode: 'US' } });
  });

  it('needs its permissions', async () => {
    expect((await send('GET', '/configured', undefined, { grants: ['telephony:manage'] })).status).toBe(403);
    expect((await send('POST', '/phone-numbers/sync', undefined, { grants: ['telephony:read'] })).status).toBe(403);
  });
});

describe('phone numbers', () => {
  it('updates the display name and the default flag', async () => {
    await seedNumber('vpn_tel_update', '+31201230001');
    expect((await send('PUT', '/phone-numbers/vpn_missing', { displayName: 'x' })).status).toBe(404);
    expect((await send('PUT', '/phone-numbers/vpn_tel_update', { isDefault: 'yes' })).status).toBe(400);
    const res = await send('PUT', '/phone-numbers/vpn_tel_update', { displayName: 'Sales', isDefault: true });
    expect(await res.json()).toEqual({ data: { success: true } });
    const cleared = await send('PUT', '/phone-numbers/vpn_tel_update', { displayName: null });
    expect(cleared.status).toBe(200);
  });

  it('moves the default to one number', async () => {
    await seedNumber('vpn_tel_default_a', '+31201230002', { isDefault: true });
    await seedNumber('vpn_tel_default_b', '+31201230003');
    expect((await send('POST', '/phone-numbers/vpn_missing/set-default')).status).toBe(404);
    expect(await (await send('POST', '/phone-numbers/vpn_tel_default_b/set-default')).json()).toEqual({ data: { success: true } });
    const rows = await db.select().from(schema.voipPhoneNumbers).where(eq(schema.voipPhoneNumbers.isDefault, true));
    expect(rows.map((r) => r.id)).toEqual(['vpn_tel_default_b']);
  });

  it('removes a number and takes it out of the inbound registry', async () => {
    await seedNumber('vpn_tel_delete', '+31201230004');
    await master.insert(masterSchema.phoneNumberRegistry).values({
      phoneNumber: '+31201230004',
      clerkOrgId: 'org_test_default',
      voipPhoneNumberId: 'vpn_tel_delete',
    });
    expect((await send('DELETE', '/phone-numbers/vpn_missing')).status).toBe(404);
    expect(await (await send('DELETE', '/phone-numbers/vpn_tel_delete')).json()).toEqual({ data: { success: true } });
    expect((await registry('+31201230004'))?.isActive).toBe(false);
    expect((await send('DELETE', '/phone-numbers/vpn_tel_delete')).status).toBe(404);
  });
});

describe('POST /phone-numbers/search', () => {
  it('validates, then needs Telnyx', async () => {
    expect((await send('POST', '/phone-numbers/search', { country: 'NLD' })).status).toBe(400);
    expect((await send('POST', '/phone-numbers/search', { country: 'NL', limit: 0 })).status).toBe(400);
    const off = await send('POST', '/phone-numbers/search', { country: 'NL' }, { configured: false });
    expect(off.status).toBe(400);
    expect(await off.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Phone service is not activated' } });
  });

  it('maps Telnyx results and prices them with the markup', async () => {
    telnyx.on('GET', '/available_phone_numbers', ({ url }) =>
      json({
        data: [
          {
            phone_number: '+31201230100',
            region_information: [
              { region_type: 'country_code', region_name: 'NL' },
              { region_type: 'rate_center', region_name: 'AMSTERDAM' },
            ],
            cost_information: { monthly_cost: '1.00', upfront_cost: '0.50', currency: 'EUR' },
            features: [{ name: 'voice' }, { name: 'sms' }],
            phone_number_type: url.searchParams.get('filter[phone_number_type]'),
          },
          { phone_number: '+4930123456', iso_country: 'de', cost_information: { monthly_cost: '2.00' } },
          { phone_number: '  ' },
          { phone_number: '+31201230101', capabilities: { voice: true } },
        ],
      }),
    );
    const res = await send('POST', '/phone-numbers/search', { country: 'NL', areaCode: '20', contains: '123', limit: '5' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { numbers: Array<Record<string, unknown>> } };
    expect(data.numbers).toHaveLength(3);
    expect(data.numbers[0]).toMatchObject({
      iso_country: 'NL',
      locality: 'AMSTERDAM',
      phone_number_type: 'local',
      cost_information: { currency: 'EUR', monthly_cost: '1.20', upfront_cost: '0.60' },
      capabilities: { voice: true, sms: true, mms: false },
    });
    // No DE row: the default markup (a flat 1.00).
    expect(data.numbers[1]).toMatchObject({ iso_country: 'DE', cost_information: { currency: 'USD', monthly_cost: '3.00', upfront_cost: '1.00' } });
    expect(data.numbers[2]).not.toHaveProperty('cost_information');

    const tollFree = await send('POST', '/phone-numbers/search', { country: 'US', type: 'toll-free' });
    expect(tollFree.status).toBe(200);
  });

  it('fails when Telnyx does', async () => {
    telnyx.on('GET', '/available_phone_numbers', () => telnyxError(500));
    const res = await send('POST', '/phone-numbers/search', { country: 'NL' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to search phone numbers' } });
  });
});

describe('POST /phone-numbers/provision', () => {
  it('validates, needs Telnyx, and an address where the country asks for one', async () => {
    expect((await send('POST', '/phone-numbers/provision', { phoneNumber: '', countryCode: 'N' })).status).toBe(400);
    expect((await send('POST', '/phone-numbers/provision', { phoneNumber: '+31201230200', countryCode: 'NL' }, { configured: false })).status).toBe(400);
    const res = await send('POST', '/phone-numbers/provision', { phoneNumber: '+31201230200', countryCode: 'nl' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'ADDRESS_REQUIRED', message: 'Phone numbers in nl require a verified address.', details: { requiresAddress: true } },
    });
  });

  it('needs a price', async () => {
    telnyx.on('GET', '/available_phone_numbers', { data: [{ phone_number: '+12025550100' }] });
    const res = await send('POST', '/phone-numbers/provision', { phoneNumber: '+12025550100', countryCode: 'US', numberType: 'mobile' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'No pricing configured for this phone number type' } });
  });

  it('fails without billing-worker once the number is priced', async () => {
    telnyx.on('GET', '/available_phone_numbers', ({ url }) =>
      json({
        data: [
          {
            phone_number: `+${url.searchParams.get('filter[phone_number][contains]')}`,
            cost_information: { monthly_cost: '1.10', upfront_cost: '0' },
          },
        ],
      }),
    );
    const res = await send('POST', '/phone-numbers/provision', {
      phoneNumber: '+31201230201',
      countryCode: 'NL',
      addressId: 'addr-1',
      displayName: 'New line',
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to provision phone number' } });
  });

  it('asks for an address when Telnyx says so', async () => {
    telnyx.on('GET', '/available_phone_numbers', () => telnyxError(422, 'A valid address is needed'));
    const res = await send('POST', '/phone-numbers/provision', { phoneNumber: '+4930123499', countryCode: 'DE', addressId: 'addr-1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'ADDRESS_REQUIRED', message: 'Address or regulatory document required', details: { requiresAddress: true } },
    });
  });
});

describe('POST /phone-numbers/sync', () => {
  it('needs Telnyx and counts nothing when the account has no numbers', async () => {
    expect((await send('POST', '/phone-numbers/sync', undefined, { configured: false })).status).toBe(400);
    telnyx.on('GET', '/phone_numbers', { data: [] });
    expect(await (await send('POST', '/phone-numbers/sync')).json()).toEqual({ data: { count: 0 } });
  });

  it('brings the account numbers in and registers them', async () => {
    await seedNumber('vpn_tel_sync_known', '+31201230300', { status: 'pending', providerPhoneNumberId: 'tx-known' });
    telnyx.on('GET', '/phone_numbers', ({ url }) =>
      json({
        data:
          url.searchParams.get('filter[connection_id]') === 'conn-1'
            ? [
                { id: 'tx-known', phone_number: '+31201230399', connection_id: 'conn-1' },
                { id: 'tx-us', phone_number: '+12025550111', connection_id: 'conn-1' },
                { id: 'tx-be', phone_number: '+3225550111' },
                { id: 'tx-bad' },
              ]
            : [],
      }),
    );
    const res = await send('POST', '/phone-numbers/sync');
    expect(await res.json()).toEqual({ data: { count: 3 } });
    const rows = await db.select().from(schema.voipPhoneNumbers);
    expect(rows.find((r) => r.id === 'vpn_tel_sync_known')).toMatchObject({ status: 'active', providerConnectionId: 'conn-1' });
    expect(rows.find((r) => r.phoneNumber === '+12025550111')).toMatchObject({ countryCode: 'US', providerPhoneNumberId: 'tx-us' });
    expect(rows.find((r) => r.phoneNumber === '+3225550111')).toMatchObject({ countryCode: 'INTL', providerConnectionId: null });
    expect(await registry('+12025550111')).toMatchObject({ isActive: true, clerkOrgId: 'org_test_default' });
    expect(await registry('+31201230399')).toMatchObject({ voipPhoneNumberId: 'vpn_tel_sync_known' });
  });
});

describe('addresses', () => {
  it('lists and creates Telnyx addresses', async () => {
    expect(await (await send('GET', '/addresses', undefined, { configured: false })).json()).toEqual({ data: { addresses: [] } });
    telnyx.on('GET', '/addresses', { data: [{ id: 'addr-1', locality: 'Amsterdam' }] });
    expect(await (await send('GET', '/addresses')).json()).toEqual({ data: { addresses: [{ id: 'addr-1', locality: 'Amsterdam' }] } });

    const address = {
      businessName: 'Acme',
      firstName: 'Ann',
      lastName: 'Lee',
      streetAddress: 'Main 1',
      locality: 'Amsterdam',
      postalCode: '1000AA',
      countryCode: 'NL',
    };
    expect((await send('POST', '/addresses', { ...address, countryCode: 'NLD' })).status).toBe(400);
    expect((await send('POST', '/addresses', address, { configured: false })).status).toBe(400);
    telnyx.on('POST', '/addresses', ({ body }) => json({ data: { id: 'addr-2', ...(body as object) } }));
    const created = await send('POST', '/addresses', address);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ data: { address: { id: 'addr-2', administrative_area: '', address_book: true } } });

    telnyx.on('GET', '/addresses', () => telnyxError(401, 'Bad key'));
    expect((await send('GET', '/addresses')).status).toBe(500);
  });
});

describe('ordering requirements', () => {
  const catalog = {
    data: [
      {
        record_type: 'requirement',
        requirement_types: [
          { id: 'rt-doc', type: 'document', name: 'Proof of address', example: 'A utility bill' },
          { id: 'rt-text', field_type: 'textual', title: 'Company number' },
        ],
      },
    ],
  };

  it('lists a country\x27s requirements, from the older endpoint when needed', async () => {
    expect(await (await send('GET', '/requirements?countryCode=NL', undefined, { configured: false })).json()).toEqual({ data: { requirements: [] } });
    expect((await send('GET', '/requirements')).status).toBe(400);
    telnyx.on('GET', '/requirements', catalog);
    const res = await send('GET', '/requirements?countryCode=nl&numberType=toll-free');
    expect(await res.json()).toEqual({
      data: {
        requirements: [
          { id: 'rt-doc', name: 'Proof of address', description: 'A utility bill', fieldType: 'document', example: 'A utility bill' },
          { id: 'rt-text', name: 'Company number', description: '', fieldType: 'textual' },
        ],
      },
    });
    telnyx.on('GET', '/requirements', () => telnyxError(404));
    telnyx.on('GET', '/phone_number_regulatory_requirements', { data: [{ id: 'rt-old', type: 'address' }] });
    expect(await (await send('GET', '/requirements?countryCode=BE')).json()).toEqual({
      data: { requirements: [{ id: 'rt-old', name: 'Requirement', description: '', fieldType: 'address' }] },
    });
    telnyx.off('GET', '/phone_number_regulatory_requirements');
    expect((await send('GET', '/requirements?countryCode=BE')).status).toBe(500);
    telnyx.on('GET', '/requirements', catalog);
  });

  it('reads what a paid order still owes', async () => {
    await seedNumber('vpn_tel_order', '+31201230400', { status: 'pending' });
    expect(await (await send('GET', '/phone-numbers/vpn_tel_order/regulatory-requirements', undefined, { configured: false })).json()).toEqual({
      data: { requirementsMet: true, requirements: [] },
    });
    expect((await send('GET', '/phone-numbers/vpn_missing/regulatory-requirements')).status).toBe(404);
    telnyx.on('GET', '/number_orders', { data: [] });
    expect(await (await send('GET', '/phone-numbers/vpn_tel_order/regulatory-requirements')).json()).toEqual({
      data: { requirementsMet: false, requirements: [] },
    });
    telnyx.on('GET', '/number_orders', ({ url }) =>
      json({
        data: url.searchParams.get('filter[phone_number]') === '+31201230400'
          ? [
              {
                id: 'ord-1',
                phone_numbers: [
                  {
                    id: 'line-1',
                    phone_number: '+31201230400',
                    requirements_met: false,
                    regulatory_requirements: [
                      { requirement_id: 'rt-doc', field_type: 'document', status: 'pending' },
                      { requirement_id: 'rt-unknown', field_value: 'x' },
                      { field_value: 'dropped' },
                    ],
                  },
                ],
              },
            ]
          : [],
      }),
    );
    const res = await send('GET', '/phone-numbers/vpn_tel_order/regulatory-requirements');
    expect(await res.json()).toEqual({
      data: {
        orderId: 'ord-1',
        phoneNumberOrderId: 'line-1',
        requirementsMet: false,
        requirements: [
          { id: 'rt-doc', name: 'Proof of address', description: 'A utility bill', fieldType: 'document', example: 'A utility bill', status: 'pending' },
          { id: 'rt-unknown', name: 'Requirement', description: '', fieldType: 'textual', fieldValue: 'x' },
        ],
      },
    });
  });

  it('submits the answers and activates the number once Telnyx has everything', async () => {
    const values = { values: [{ requirementId: 'rt-doc', fieldValue: 'doc-1' }] };
    expect((await send('POST', '/phone-numbers/vpn_tel_order/regulatory-requirements', { values: [] })).status).toBe(400);
    expect((await send('POST', '/phone-numbers/vpn_tel_order/regulatory-requirements', values, { configured: false })).status).toBe(400);
    expect((await send('POST', '/phone-numbers/vpn_missing/regulatory-requirements', values)).status).toBe(404);
    await seedNumber('vpn_tel_no_order', '+31201230401', { status: 'pending' });
    const none = await send('POST', '/phone-numbers/vpn_tel_no_order/regulatory-requirements', values);
    expect(await none.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'No Telnyx order found for this number' } });

    telnyx.on('PATCH', '/number_order_phone_numbers/line-1', ({ body }) =>
      json({ data: { id: 'line-1', requirements_met: (body as { regulatory_requirements: unknown[] }).regulatory_requirements.length === 1 } }),
    );
    const res = await send('POST', '/phone-numbers/vpn_tel_order/regulatory-requirements', values);
    expect(await res.json()).toEqual({ data: { requirementsMet: true } });
    const [row] = await db.select().from(schema.voipPhoneNumbers).where(eq(schema.voipPhoneNumbers.id, 'vpn_tel_order'));
    expect(row?.status).toBe('active');
    expect(await registry('+31201230400')).toMatchObject({ isActive: true });

    telnyx.on('PATCH', '/number_order_phone_numbers/line-1', () => telnyxError(422, 'Document rejected'));
    const refused = await send('POST', '/phone-numbers/vpn_tel_order/regulatory-requirements', values);
    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Telnyx API error: 422 - Document rejected' } });
  });
});

describe('POST /documents', () => {
  const upload = (file: File | string | null, options: Options = {}) => {
    const form = new FormData();
    if (typeof file === 'string') form.append('file', file);
    else if (file !== null) form.append('file', file);
    const env = { ENVIRONMENT: 'development', ...(options.configured === false ? {} : TELNYX_ENV) };
    const { request } = createTestApp(BASE, telephonyRoutes, {
      context: { tenantDb: db, masterDb: master, permissions: permissions('telephony:manage') },
      env: env as never,
    });
    return request(`${BASE}/documents`, { method: 'POST', body: form });
  };

  it('uploads a file to Telnyx', async () => {
    const pdf = new File(['%PDF-1.4 proof'], 'proof.pdf', { type: 'application/pdf' });
    expect((await upload(pdf, { configured: false })).status).toBe(400);
    const missing = await upload('not a file');
    expect(await missing.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'file is required' } });
    telnyx.on('POST', '/documents', { data: { id: 'doc-1' } });
    expect(await (await upload(pdf)).json()).toEqual({ data: { id: 'doc-1', filename: 'proof.pdf' } });
    telnyx.on('POST', '/documents', { data: {} });
    const noId = await upload(pdf);
    expect(noId.status).toBe(500);
    expect(await noId.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Telnyx did not return a document id' } });
  });
});

describe('the price list', () => {
  it('lists the active prices with their markup, without the default row', async () => {
    const res = await send('GET', '/pricing');
    expect(await res.json()).toEqual({
      data: {
        pricing: [
          { countryCode: 'NL', numberType: 'local', monthlyPrice: 1.2, setupFee: 0.6, currency: 'EUR', stripePriceId: 'price_nl' },
          { countryCode: 'US', numberType: 'toll-free', monthlyPrice: 3.5, setupFee: 1.5, currency: 'USD' },
        ],
      },
    });
  });

  it('reads the service rates', async () => {
    expect(await (await send('GET', '/service-rates')).json()).toEqual({
      data: { rates: { voipCallMinute: 2.5, callTranscriptionMinute: 2 } },
    });
  });
});
