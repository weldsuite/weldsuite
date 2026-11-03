/**
 * US sales tax setup, the routes the setup walkthrough doesn't reach
 * (pglite): listing and editing jurisdictions, zones and rules, PUT on every
 * object, removing a rate, the engine settings, and the provider checks
 * (registration check and address validation, against a stubbed Avalara).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from './accounting-entities';
import { exemptionCertificatesRoutes } from './exemption-certificates';
import { salesTaxRoutes } from './sales-tax';
import { salesTaxAgenciesRoutes } from './sales-tax-agencies';
import { salesTaxJurisdictionsRoutes } from './sales-tax-jurisdictions';
import { salesTaxRulesRoutes } from './sales-tax-rules';
import { salesTaxZonesRoutes } from './sales-tax-zones';
import { apiFor, type ApiOptions } from '../services/sales-tax/test-fixtures';

let db: Database;
let entityId: string;
let api: ReturnType<typeof apiFor>;

const agencies = (path = '', opts: ApiOptions = {}) => api('/api/sales-tax-agencies', salesTaxAgenciesRoutes, path, opts);
const jurisdictions = (path = '', opts: ApiOptions = {}) => api('/api/sales-tax-jurisdictions', salesTaxJurisdictionsRoutes, path, opts);
const zones = (path = '', opts: ApiOptions = {}) => api('/api/sales-tax-zones', salesTaxZonesRoutes, path, opts);
const rules = (path = '', opts: ApiOptions = {}) => api('/api/sales-tax-rules', salesTaxRulesRoutes, path, opts);
const certificates = (path = '', opts: ApiOptions = {}) => api('/api/exemption-certificates', exemptionCertificatesRoutes, path, opts);
const salesTax = (path = '', opts: ApiOptions = {}) => api('/api/sales-tax', salesTaxRoutes, path, opts);

const AVATAX = 'https://sandbox-rest.avatax.com';
const realFetch = globalThis.fetch;
// Avalara answers by URL and method (both backends call it).
const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(AVATAX)) return realFetch(input, init);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET' && url.startsWith(`${AVATAX}/api/v2/companies?`)) {
    return Response.json({ value: [{ id: 42, companyCode: 'WELD' }] });
  }
  if (method === 'GET' && url.startsWith(`${AVATAX}/api/v2/companies/42/nexus`)) {
    return Response.json({
      value: [
        { id: 7, country: 'US', region: 'TX', jurisTypeId: 'STA', nexusTypeId: 'SalesOrSellersUseTax' },
        { id: 8, country: 'US', region: 'CA', jurisTypeId: 'STA', nexusTypeId: 'SalesOrSellersUseTax', endDate: '2020-12-31' },
        { id: 9, country: 'US', region: 'NY', jurisTypeId: 'STA', nexusTypeId: 'SalesOrSellersUseTax' },
        { id: 10, country: 'CA', region: 'ON', jurisTypeId: 'STA', nexusTypeId: 'SalesOrSellersUseTax' },
      ],
    });
  }
  if (method === 'POST' && url === `${AVATAX}/api/v2/addresses/resolve`) {
    const body = JSON.parse(String(init?.body ?? '{}')) as { postalCode?: string };
    if (body.postalCode === '00000') {
      return Response.json({ messages: [{ summary: 'The address is not deliverable.', severity: 'Error' }] });
    }
    return Response.json({
      validatedAddresses: [{ line1: '1 Congress Ave', city: 'Austin', region: 'TX', postalCode: '78701-1234', country: 'US' }],
      messages: [{ summary: 'The address was corrected.', severity: 'Info' }],
    });
  }
  return Response.json({ error: { message: 'unexpected call' } }, { status: 404 });
});

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub);
  db = (await createPgliteDb()).db;
  api = apiFor(db, () => entityId);
  const created = await api('/api/accounting-entities', accountingEntitiesRoutes, '', {
    method: 'POST',
    body: {
      name: 'Setup Two LLC',
      jurisdictionCode: 'US',
      entityType: 'single_member_llc',
      address: { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' },
    },
  });
  entityId = created.data.id;
  await db.insert(schema.parties).values({ id: 'pty_crud', displayName: 'Customer', role: 'customer' });
}, 120_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('editing the manual engine data', () => {
  let agencyId: string;
  let stateId: string;
  let countyId: string;

  beforeAll(async () => {
    agencyId = (await agencies('', { method: 'POST', body: { stateCode: 'TX', registeredFrom: '2026-01-01' } })).data.id;
    stateId = (await jurisdictions('', { method: 'POST', body: { agencyId, level: 'state', name: 'Texas', code: '48', rate: { rate: 6.25, effectiveFrom: '2000-01-01' } } })).data.id;
    countyId = (await jurisdictions('', { method: 'POST', body: { agencyId, level: 'county', name: 'Travis County', rate: { rate: '0.5', effectiveFrom: '2000-01-01' } } })).data.id;
  });

  it('PUT changes an agency like PATCH does', async () => {
    const res = await agencies(`/${agencyId}`, { method: 'PUT', body: { filingFrequency: 'monthly', dueDay: 15, notes: '  Monthly from now on ' } });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ filingFrequency: 'monthly', dueDay: 15, notes: 'Monthly from now on' });
    expect((await agencies(`/${agencyId}`, { method: 'PUT', body: { dueDay: 40 } })).status).toBe(400);
  });

  it('lists jurisdictions with their rate in force, by agency, state and level', async () => {
    const all = await jurisdictions();
    expect(all.status).toBe(200);
    expect(all.data.map((j: { name: string; currentRate: number }) => [j.name, j.currentRate])).toEqual([
      ['Travis County', 0.5],
      ['Texas', 6.25],
    ]);
    expect((await jurisdictions(`?agencyId=${agencyId}&level=state`)).data.map((j: { id: string }) => j.id)).toEqual([stateId]);
    expect((await jurisdictions('?stateCode=tx&pageSize=1&page=2')).data).toHaveLength(1);
    expect((await jurisdictions('?stateCode=WA')).data).toEqual([]);
  });

  it('PATCH and PUT edit a jurisdiction; a rate can be removed', async () => {
    const patched = await jurisdictions(`/${countyId}`, { method: 'PATCH', body: { name: ' Travis ', reportingCode: '2227' } });
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({ name: 'Travis', reportingCode: '2227', currentRate: 0.5 });
    const put = await jurisdictions(`/${countyId}`, { method: 'PUT', body: { code: null, isActive: false } });
    expect(put.data).toMatchObject({ code: null, isActive: false });
    expect((await jurisdictions(`/${countyId}`, { method: 'PATCH', body: { level: 'region' } })).status).toBe(400);
    expect((await jurisdictions('/nope', { method: 'PATCH', body: { name: 'X' } })).status).toBe(404);

    const added = await jurisdictions(`/${countyId}/rates`, { method: 'POST', body: { rate: 1, effectiveFrom: '2030-01-01', closePrevious: true } });
    expect(added.status).toBe(201);
    expect((await jurisdictions(`/${countyId}/rates/${added.data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await jurisdictions(`/${countyId}/rates/${added.data.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await jurisdictions(`/${countyId}/rates/${added.data.id}`, { method: 'PATCH', body: { rate: 2 } })).status).toBe(404);
    const rates = await jurisdictions(`/${countyId}/rates`);
    expect(rates.data.map((r: { effectiveTo: string | null }) => r.effectiveTo)).toEqual(['2029-12-31']);
    const reopened = await jurisdictions(`/${countyId}/rates/${rates.data[0].id}`, { method: 'PATCH', body: { effectiveTo: null, rate: '0.75' } });
    expect(reopened.status).toBe(200);
    expect(reopened.data).toMatchObject({ rate: '0.7500', effectiveTo: null });
  });

  it('lists, reads and edits zones', async () => {
    const zone = await zones('', { method: 'POST', body: { agencyId, name: 'Austin', jurisdictionIds: [stateId, countyId, stateId], postalCodes: ['78701'], priority: 10 } });
    expect(zone.status).toBe(201);
    expect(zone.data.jurisdictionIds).toEqual([stateId, countyId]);
    await zones('', { method: 'POST', body: { agencyId, name: 'Rest of Texas', jurisdictionIds: [stateId], postalCodes: [{ from: '75000', to: '79999' }] } });

    const listed = await zones('?stateCode=tx');
    expect(listed.status).toBe(200);
    expect(listed.data.map((z: { name: string; combinedRate: number }) => [z.name, z.combinedRate])).toEqual([
      ['Austin', 7],
      ['Rest of Texas', 6.25],
    ]);
    expect((await zones(`?agencyId=${agencyId}&pageSize=1`)).pagination).toMatchObject({ totalCount: 2, hasMore: true });

    const one = await zones(`/${zone.data.id}`);
    expect(one.data.jurisdictions.map((j: { name: string }) => j.name)).toEqual(['Texas', 'Travis']);
    expect((await zones('/nope')).status).toBe(404);

    const patched = await zones(`/${zone.data.id}`, { method: 'PATCH', body: { name: 'Austin core', jurisdictionIds: [stateId], isOrigin: true } });
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({ name: 'Austin core', isOrigin: true, combinedRate: 6.25 });
    const put = await zones(`/${zone.data.id}`, { method: 'PUT', body: { postalCodes: ['78701', '78702'], priority: 5 } });
    expect(put.data).toMatchObject({ priority: 5, postalCodes: ['78701', '78702'] });
    expect((await zones(`/${zone.data.id}`, { method: 'PATCH', body: { postalCodes: [{ from: '78799', to: '78700' }] } })).status).toBe(400);
    expect((await zones(`/${zone.data.id}`, { method: 'PATCH', body: { jurisdictionIds: ['stj_missing'] } })).status).toBe(400);
    expect((await zones(`/${zone.data.id}`, { method: 'PATCH', body: { postalCodes: [{ from: '78700' }] } })).status).toBe(400);
  });

  it('reads and replaces a rule', async () => {
    const rule = await rules('', { method: 'POST', body: { agencyId, taxCode: 'clothing', taxable: true, taxablePercent: '50', effectiveFrom: '2026-01-01', notes: 'Half' } });
    expect(rule.status).toBe(201);
    const one = await rules(`/${rule.data.id}`);
    expect(one.status).toBe(200);
    expect(one.data).toMatchObject({ taxCode: 'clothing', taxablePercent: '50.0000', notes: 'Half' });
    expect((await rules('/nope')).status).toBe(404);
    const put = await rules(`/${rule.data.id}`, { method: 'PUT', body: { taxable: false, rateOverride: null, notes: null, appliesToUse: 'personal' } });
    expect(put.status).toBe(200);
    expect(put.data).toMatchObject({ taxable: false, appliesToUse: 'personal', notes: null });
    expect((await rules(`/${rule.data.id}`, { method: 'PUT', body: { effectiveTo: '2025-01-01' } })).status).toBe(400);
  });

  it('PUT replaces certificate fields', async () => {
    const cert = await certificates('', { method: 'POST', body: { partyId: 'pty_crud', states: ['TX'], reason: 'resale', certificateNumber: 'C-1' } });
    expect(cert.status).toBe(201);
    const put = await certificates(`/${cert.data.id}`, { method: 'PUT', body: { states: ['tx', 'ok'], certificateNumber: '  ', form: 'mtc_uniform' } });
    expect(put.status).toBe(200);
    expect(put.data).toMatchObject({ states: ['TX', 'OK'], certificateNumber: null, form: 'mtc_uniform', status: 'valid' });
    expect((await certificates(`/${cert.data.id}`, { method: 'PUT', body: { states: ['XX'] } })).status).toBe(400);
    expect((await certificates(`/${cert.data.id}`, { method: 'PUT', body: { invoiceId: 'inv_missing' } })).status).toBe(400);
  });
});

describe('engine settings and the provider checks', () => {
  it('reads the settings of a manual entity', async () => {
    const res = await salesTax('/settings');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ entityId, engine: 'manual', hasCredentials: false, registeredStates: ['TX'] });
    expect(res.data.config).toEqual({ companyCode: null, environment: 'production' });
    expect((await salesTax('/settings', { perms: ['invoices:read'] })).status).toBe(403);
  });

  it('the manual engine has no provider to check', async () => {
    const check = await salesTax('/registration-check', { method: 'POST' });
    expect(check.status).toBe(400);
    expect(check.error?.message).toMatch(/manual engine/);
    const address = await salesTax('/validate-address', { method: 'POST', body: { address: { line1: '1 Congress Ave', state: 'TX', postalCode: '78701' } } });
    expect(address.status).toBe(400);
  });

  it('refuses an engine without what it needs', async () => {
    expect((await salesTax('/settings', { method: 'PUT', body: { engine: 'avalara' } })).status).toBe(400);
    expect((await salesTax('/settings', { method: 'PUT', body: { engine: 'avalara', credentials: { accountId: '1100' } } })).status).toBe(400);
    expect((await salesTax('/settings', { method: 'PUT', body: { engine: 'manual', credentials: { apiKey: 'sk_test_12345678' } } })).status).toBe(400);
    expect((await salesTax('/settings', { method: 'PUT', body: { engine: 'stripe_tax', credentials: { apiKey: 'short' } } })).status).toBe(400);
    expect((await salesTax('/settings', { method: 'PUT', body: { engine: 'stripe_tax', credentials: { apiKey: 'sk_test_12345678', other: 1 } } })).status).toBe(400);
    const noCompany = await salesTax('/settings', { method: 'PUT', body: { engine: 'avalara', credentials: { accountId: '1100', licenseKey: 'LIC' } } });
    expect(noCompany.status).toBe(400);
    expect(noCompany.error?.message).toMatch(/company code/);
  });

  it('stores Avalara credentials sealed and checks the provider registrations against the agencies', async () => {
    const saved = await salesTax('/settings', {
      method: 'PUT',
      body: { engine: 'avalara', config: { companyCode: 'WELD', environment: 'sandbox' }, credentials: { accountId: '1100', licenseKey: 'LIC-1' } },
    });
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ engine: 'avalara', hasCredentials: true, config: { companyCode: 'WELD', environment: 'sandbox' } });

    await agencies('', { method: 'POST', body: { stateCode: 'WA', registeredFrom: '2026-01-01' } });
    const check = await salesTax('/registration-check', { method: 'POST' });
    expect(check.status).toBe(200);
    expect(check.data).toMatchObject({ engine: 'avalara', inSync: false });
    expect(check.data.matched.map((m: { stateCode: string }) => m.stateCode)).toEqual(['TX']);
    expect(check.data.missingInProvider.map((m: { stateCode: string }) => m.stateCode)).toEqual(['WA']);
    expect(check.data.missingInWeldBooks.map((m: { stateCode: string }) => m.stateCode)).toEqual(['NY']);
  });

  it('validates an address through Avalara', async () => {
    const ok = await salesTax('/validate-address', { method: 'POST', body: { address: { line1: '1 congress ave', city: 'austin', state: 'TX', postalCode: '78701' } } });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ engine: 'avalara', valid: true, normalized: { postalCode: '78701-1234' }, messages: ['The address was corrected.'] });
    const bad = await salesTax('/validate-address', { method: 'POST', body: { address: { line1: '1 Nowhere', state: 'TX', postalCode: '00000' } } });
    expect(bad.data).toMatchObject({ valid: false, messages: ['The address is not deliverable.'] });
    expect((await salesTax('/validate-address', { method: 'POST', body: { address: {} } })).status).toBe(400);
    expect((await salesTax('/validate-address', { method: 'POST', body: { address: { line1: 5 } } })).status).toBe(400);
  });

  it('removing the credentials goes back to the manual engine', async () => {
    const res = await salesTax('/settings', { method: 'PUT', body: { engine: 'manual', credentials: null } });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ engine: 'manual', hasCredentials: false, config: { companyCode: 'WELD' } });
  });
});
