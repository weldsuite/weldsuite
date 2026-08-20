import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '../test/pglite';
import { createTestApp, permissions } from '../test/harness';
import { sendcloudRoutes } from '../routes/sendcloud';
import { type Database } from '../db';
import { createSendcloudClient, SendcloudError } from './client';
import {
  applySendcloudPatches,
  getSendcloudSettings,
  mapSyncedMethods,
  mapSyncedSenders,
  saveSendcloudSettings,
  syncSendcloudCatalog,
} from './settings';
import { splitStreet, toCountryCode, toSendcloudToAddress } from './addresses';

let db: Database;
const workspaceId = 'org_test_default';

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('Sendcloud v3 client', () => {
  it('lists sender addresses and announces a shipment', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/addresses/sender-addresses')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 9,
                company_name: 'Acme',
                contact_name: 'Marie',
                email: 'marie@acme.test',
                address_line_1: 'Stadhuisplein',
                house_number: '10',
                postal_code: '5611 EM',
                city: 'Eindhoven',
                country: 'NL',
                is_default: true,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/shipments/announce')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'sc-1',
              carrier: { code: 'postnl', name: 'PostNL' },
              ship_with: { properties: { shipping_option_code: 'postnl:standard' } },
              errors: [],
              parcels: [
                {
                  id: 111,
                  tracking_number: '3SYZ',
                  tracking_url: 'https://tracking.example/3SYZ',
                  label_file: 'JVBERi0x',
                  status: { code: 'READY_TO_SEND' },
                  documents: [{ type: 'label', link: 'https://panel.sendcloud.sc/api/v3/parcels/111/documents/label' }],
                },
              ],
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('nope', { status: 404 });
    };

    const client = createSendcloudClient(
      { publicKey: 'pk', secretKey: 'sk' },
      { fetch: fetchImpl },
    );
    const senders = await client.listSenderAddresses();
    expect(senders[0]?.id).toBe(9);
    expect(senders[0]?.countryCode).toBe('NL');
    expect(calls[0]?.url).toBe(
      'https://panel.sendcloud.sc/api/v3/addresses/sender-addresses?page_size=100',
    );

    const announced = await client.announceShipment({
      senderAddressId: 9,
      toAddress: {
        name: 'Ada',
        address_line_1: 'Insulindelaan',
        house_number: '115',
        postal_code: '5642CV',
        city: 'Eindhoven',
        country_code: 'NL',
      },
      shippingOptionCode: 'postnl:standard',
      weightKg: 1.2,
      orderNumber: 'SO-1',
    });
    expect(announced.parcel?.trackingNumber).toBe('3SYZ');
    expect(announced.parcel?.labelPdfBase64).toBe('JVBERi0x');
    const announce = calls.find((call) => call.url.endsWith('/shipments/announce'));
    expect(announce?.url).toBe('https://panel.sendcloud.sc/api/v3/shipments/announce');
    const body = JSON.parse(String(announce?.init?.body));
    expect(body.from_address).toEqual({ sender_address_id: 9 });
    expect(body.ship_with).toEqual({
      type: 'shipping_option_code',
      properties: { shipping_option_code: 'postnl:standard' },
    });
    expect(body.parcels[0].weight).toEqual({ value: '1.2', unit: 'kg' });
    expect(body.label_details).toEqual({ mime_type: 'application/pdf', dpi: 72 });
  });

  it('maps 401 to UNAUTHORIZED', async () => {
    const client = createSendcloudClient(
      { publicKey: 'pk', secretKey: 'bad' },
      {
        fetch: async () =>
          new Response(JSON.stringify({ error: { message: 'Invalid credentials' } }), { status: 401 }),
      },
    );
    await expect(client.listSenderAddresses()).rejects.toBeInstanceOf(SendcloudError);
    await expect(client.listSenderAddresses()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('address helpers', () => {
  it('splits a Dutch street and maps country names', () => {
    expect(splitStreet('Insulindelaan 115')).toEqual({
      addressLine1: 'Insulindelaan',
      houseNumber: '115',
    });
    expect(toCountryCode('Netherlands')).toBe('NL');
    const to = toSendcloudToAddress({
      address: {
        name: 'Ada',
        line1: 'Keizersgracht 12',
        city: 'Amsterdam',
        postalCode: '1015CN',
        country: 'NL',
      },
    });
    expect(to.house_number).toBe('12');
    expect(to.country_code).toBe('NL');
  });
});

describe('catalog sync flags', () => {
  it('preserves enabled/default flags across a resync', () => {
    const senders = mapSyncedSenders(
      [
        { id: 1, companyName: 'A', countryCode: 'NL', isDefault: true },
        { id: 2, companyName: 'B', countryCode: 'BE' },
      ],
      [{ id: 1, name: 'A', enabled: false, isDefault: false }],
    );
    expect(senders.find((row) => row.id === 1)?.enabled).toBe(false);

    const methods = mapSyncedMethods(
      [
        {
          code: 'postnl:standard',
          name: 'PostNL Standard',
          servicePointRequired: false,
          isReturn: false,
        },
        {
          code: 'postnl:servicepoint',
          name: 'Service point',
          servicePointRequired: true,
          isReturn: false,
        },
      ],
      [{ code: 'postnl:standard', name: 'PostNL Standard', enabled: true, isDefault: true }],
    );
    expect(methods.map((row) => row.code)).toEqual(['postnl:standard']);
    expect(methods[0]?.enabled).toBe(true);
  });

  it('applies enable/default patches', () => {
    const next = applySendcloudPatches(
      {
        senders: [
          { id: 1, name: 'A', enabled: true, isDefault: true },
          { id: 2, name: 'B', enabled: false, isDefault: false },
        ],
        methods: [{ code: 'postnl:standard', name: 'Std', enabled: true, isDefault: true }],
      },
      { senders: [{ id: 2, enabled: true, isDefault: true }] },
    );
    expect(next.senders.find((row) => row.id === 2)?.isDefault).toBe(true);
    expect(next.senders.find((row) => row.id === 1)?.isDefault).toBe(false);
  });
});

describe('POST /api/sendcloud/connect', () => {
  it('stores the connection after a successful catalog sync', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/addresses/sender-addresses')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 1,
                company_name: 'Acme',
                country: 'NL',
                postal_code: '5611EM',
                city: 'Eindhoven',
                address_line_1: 'Stadhuisplein',
                house_number: '10',
                is_default: true,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/shipping-options')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                code: 'postnl:standard',
                product: { name: 'PostNL Standard' },
                carrier: { code: 'postnl', name: 'PostNL' },
                requirements: { is_service_point_required: false },
                functionalities: { returns: false },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('missing', { status: 404 });
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const { request } = createTestApp('/api/sendcloud', sendcloudRoutes, {
        context: {
          permissions: permissions('integrations:create', 'integrations:read'),
          tenantDb: db,
          workspaceId,
        },
      });
      const res = await request('/api/sendcloud/connect', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: 'pk_live', secretKey: 'sk_live' }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { connected: boolean; senders: Array<{ id: number }>; methods: Array<{ code: string }> } };
      expect(json.data.connected).toBe(true);
      expect(json.data.senders[0]?.id).toBe(1);
      expect(json.data.methods[0]?.code).toBe('postnl:standard');

      const stored = await getSendcloudSettings(db, workspaceId);
      expect(stored.publicKey).toBe('pk_live');
      expect(stored.secretKey).toBe('sk_live');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects invalid keys', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid credentials' } }), { status: 401 });
    try {
      const { request } = createTestApp('/api/sendcloud', sendcloudRoutes, {
        context: {
          permissions: permissions('integrations:create'),
          tenantDb: db,
          workspaceId,
        },
      });
      const res = await request('/api/sendcloud/connect', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: 'pk', secretKey: 'bad' }),
      });
      expect(res.status).toBe(401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('syncSendcloudCatalog', () => {
  it('keeps previously enabled methods when Sendcloud adds a new option', async () => {
    await saveSendcloudSettings(db, `${workspaceId}-sync`, {
      publicKey: 'pk',
      secretKey: 'sk',
      senders: [{ id: 1, name: 'A', countryCode: 'NL', enabled: true, isDefault: true }],
      methods: [{ code: 'postnl:standard', name: 'Std', enabled: true, isDefault: true }],
    });
    const stored = await getSendcloudSettings(db, `${workspaceId}-sync`);
    const next = await syncSendcloudCatalog(stored, {
      listSenderAddresses: async () => [{ id: 1, companyName: 'A', countryCode: 'NL', isDefault: true }],
      listShippingOptions: async () => [
        { code: 'postnl:standard', name: 'Std', servicePointRequired: false, isReturn: false },
        { code: 'postnl:small', name: 'Small', servicePointRequired: false, isReturn: false },
      ],
      announceShipment: async () => ({ id: 'x', errors: [], parcel: null }),
      getParcelDocument: async () => ({ bytes: new ArrayBuffer(0), contentType: 'application/pdf' }),
    });
    expect(next.methods.find((row) => row.code === 'postnl:standard')?.enabled).toBe(true);
    expect(next.methods.find((row) => row.code === 'postnl:small')?.enabled).toBe(false);
  });
});
