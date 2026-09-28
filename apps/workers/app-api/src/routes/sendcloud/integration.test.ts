/**
 * PUT /api/sendcloud/connect: the route half of the Sendcloud client tests
 * (the client, settings and address helpers are tested in @weldsuite/sendcloud).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '../../test/pglite';
import { createTestApp, permissions } from '../../test/harness';
import { type Database } from '../../db';
import { getSendcloudSettings } from '../../services/sendcloud/settings';
import { sendcloudRoutes } from './index';

let db: Database;
const workspaceId = 'org_test_default';

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

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
