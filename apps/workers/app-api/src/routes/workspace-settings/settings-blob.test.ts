/**
 * pglite-backed test for PUT /api/workspace-settings (the settings blob).
 *
 * The request schema is strict: the Billing dialog once posted
 * `{ settings: { business } }`, got a 200 and stored nothing. Unknown keys are
 * a 400 now, the flat business fields are stored, and a VAT number has to fit
 * the workspace's country.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

// The Stripe / master-DB mirror is best-effort and talks to the network; it is
// not what these tests are about.
vi.mock('../../services/workspace-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/workspace-settings')>();
  return { ...actual, syncBillingMirror: vi.fn(async () => {}) };
});

import { workspaceSettingsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function put(body: unknown, perms = permissions('general:update', 'general:read')) {
  const { request } = createTestApp('/api/workspace-settings', workspaceSettingsRoutes, {
    context: { tenantDb: db, permissions: perms },
    // Well-formed so `getMasterDb()` builds a client; the mirror is mocked, nothing connects.
    env: { DATABASE_URL_MASTER: 'postgresql://user:pass@master.test/db' },
  });
  return request('/api/workspace-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function read(): Promise<Record<string, unknown> | null> {
  const { request } = createTestApp('/api/workspace-settings', workspaceSettingsRoutes, {
    context: { tenantDb: db, permissions: permissions('general:read') },
  });
  const res = await request('/api/workspace-settings');
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> | null }).data;
}

const billingDetails = {
  email: 'billing@acme.nl',
  legalName: 'Acme B.V.',
  addressLine1: 'Keizersgracht 100',
  addressLine2: null,
  country: 'NL',
  city: 'Amsterdam',
  postalCode: '1015 AA',
  state: null,
  vatNumber: 'NL123456789B01',
};

describe('PUT /api/workspace-settings', () => {
  it('rejects the old nested billing payload with 400 and stores nothing', async () => {
    const res = await put({ settings: { business: { ...billingDetails, legalName: 'Nested Ltd' } } });
    expect(res.status).toBe(400);
    expect(await read()).toBeNull();
  });

  it.each([
    ['name', { name: 'Acme' }],
    ['locale', { locale: 'nl' }],
    ['logo', { logo: 'https://x.test/logo.png' }],
    ['an unknown key', { legalName: 'Acme B.V.', favouriteColour: 'blue' }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
  });

  it('stores the flat billing details the Billing dialog sends', async () => {
    const res = await put(billingDetails);
    expect([200, 201]).toContain(res.status);
    expect(await read()).toMatchObject({
      email: 'billing@acme.nl',
      legalName: 'Acme B.V.',
      addressLine1: 'Keizersgracht 100',
      country: 'NL',
      city: 'Amsterdam',
      postalCode: '1015 AA',
      vatNumber: 'NL123456789B01',
    });
  });

  it('rejects a VAT number that does not fit the country', async () => {
    const res = await put({ country: 'NL', vatNumber: 'NOT A VAT!!' });
    expect(res.status).toBe(400);
    expect((await read())?.vatNumber).toBe('NL123456789B01');
  });

  it('rejects an invalid email address', async () => {
    const res = await put({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('accepts clearing the VAT number', async () => {
    const res = await put({ country: 'NL', vatNumber: null });
    expect(res.status).toBe(200);
    expect((await read())?.vatNumber).toBeNull();
  });

  it('accepts a lenient tax ID for a country without a VAT pattern', async () => {
    const res = await put({ country: 'US', vatNumber: '12-3456789' });
    expect(res.status).toBe(200);
  });

  it('still needs general:update', async () => {
    const res = await put({ legalName: 'Acme B.V.' }, permissions('general:read'));
    expect(res.status).toBe(403);
  });
});
