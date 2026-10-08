/**
 * US sales tax setup (pglite): agencies and their payable accounts, the manual
 * engine's jurisdictions, rates, zones and rules, exemption certificates, and
 * the calculation preview. docs/plans/weldbooks-us.md §3, §5, §6.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { US_STATES } from '@weldsuite/books-domain/jurisdictions/us/states';
import { accountingEntitiesRoutes } from './accounting-entities';
import { exemptionCertificatesRoutes } from './exemption-certificates';
import { salesTaxAgenciesRoutes } from './sales-tax-agencies';
import { salesTaxJurisdictionsRoutes } from './sales-tax-jurisdictions';
import { salesTaxRoutes } from './sales-tax';
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

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  api = apiFor(db, () => entityId);
  const created = await api('/api/accounting-entities', accountingEntitiesRoutes, '', {
    method: 'POST',
    body: {
      name: 'Setup LLC',
      jurisdictionCode: 'US',
      entityType: 'single_member_llc',
      address: { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' },
    },
  });
  entityId = created.data.id;
  await db.insert(schema.parties).values({ id: 'pty_cust', displayName: 'Customer', role: 'customer' });
}, 120_000);

describe('agencies', () => {
  let texas: string;

  it('fills in the state defaults, creates both payable accounts under their parents and seeds shipping rules', async () => {
    const res = await agencies('', { method: 'POST', body: { stateCode: 'tx', registeredFrom: '2026-01-01' } });
    expect(res.status).toBe(201);
    texas = res.data.id;
    expect(res.data).toMatchObject({
      stateCode: 'TX',
      level: 'state',
      name: 'Texas Comptroller of Public Accounts',
      status: 'registered',
      filingFrequency: 'quarterly',
      dueDay: 20,
      reportingBasis: 'accrual',
      accountsCreated: 2,
    });
    expect(res.data.rulesSeeded).toBeGreaterThan(0);
    expect(res.data.liabilityAccount).toMatchObject({ code: '2201', name: 'Sales Tax Payable – Texas Comptroller of Public Accounts' });
    expect(res.data.useTaxAccount).toMatchObject({ code: '2211' });
    const [parent] = await db.select().from(schema.accounts).where(eq(schema.accounts.code, '2200'));
    const [child] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, res.data.liabilityAccountId));
    expect(child).toMatchObject({ parentAccountId: parent.id, type: 'liability', normalSide: 'credit' });
    // The role lookup still finds the parent, not a child.
    expect((child.metadata as { systemRole?: string }).systemRole).toBeUndefined();
  });

  it('validates the state, the level and the reporting basis', async () => {
    expect((await agencies('', { method: 'POST', body: { stateCode: 'ZZ' } })).status).toBe(400);
    // Oregon has no sales tax at all.
    const oregon = await agencies('', { method: 'POST', body: { stateCode: 'OR' } });
    expect(oregon.status).toBe(400);
    expect(oregon.error?.message).toMatch(/no state or local sales tax/);
    // Texas has no self-administered local agencies; Colorado does.
    expect((await agencies('', { method: 'POST', body: { stateCode: 'TX', level: 'local', name: 'City', localJurisdictionCode: '1' } })).status).toBe(400);
    const local = await agencies('', { method: 'POST', body: { stateCode: 'CO', level: 'local', name: 'City of Aurora', localJurisdictionCode: '0804000' } });
    expect(local.status).toBe(201);
    expect(local.data).toMatchObject({ level: 'local', name: 'City of Aurora' });
    expect((await agencies('', { method: 'POST', body: { stateCode: 'CO', level: 'local', localJurisdictionCode: '1' } })).status).toBe(400);
    // Cash basis only where the state allows it.
    const noCash = US_STATES.find((s) => !s.cashBasisAllowed && s.hasStateSalesTax)!;
    const cash = await agencies('', { method: 'POST', body: { stateCode: noCash.code, reportingBasis: 'cash' } });
    expect(cash.status).toBe(400);
    // One state-level agency per state.
    expect((await agencies('', { method: 'POST', body: { stateCode: 'TX' } })).status).toBe(409);
  });

  it('lists by status and state, and a status change dates the registration', async () => {
    await agencies('', { method: 'POST', body: { stateCode: 'WA', status: 'monitoring' } });
    expect((await agencies('?status=monitoring')).data.map((a: { stateCode: string }) => a.stateCode)).toEqual(['WA']);
    expect((await agencies('?stateCode=tx')).data.map((a: { stateCode: string }) => a.stateCode)).toEqual(['TX']);

    const closed = await agencies(`/${texas}`, { method: 'PATCH', body: { status: 'closed' } });
    expect(closed.data).toMatchObject({ status: 'closed', registeredUntil: day(0) });
    const reopened = await agencies(`/${texas}`, { method: 'PATCH', body: { status: 'registered' } });
    expect(reopened.data).toMatchObject({ status: 'registered', registeredUntil: null });
  });

  it('deleting an agency that was never used removes it and its manual data; registering again reuses the accounts', async () => {
    const created = await agencies('', { method: 'POST', body: { stateCode: 'FL' } });
    const id = created.data.id;
    await jurisdictions('', { method: 'POST', body: { agencyId: id, level: 'state', name: 'Florida', rate: { rate: 6, effectiveFrom: '2000-01-01' } } });
    expect((await agencies(`/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await agencies(`/${id}`)).status).toBe(404);
    expect(await db.select().from(schema.salesTaxJurisdictions).where(eq(schema.salesTaxJurisdictions.agencyId, id)).then((r) => r.filter((j) => !j.deletedAt))).toHaveLength(0);

    const again = await agencies('', { method: 'POST', body: { stateCode: 'FL' } });
    expect(again.status).toBe(201);
    expect(again.data.accountsCreated).toBe(0);
    expect(again.data.liabilityAccountId).toBe(created.data.liabilityAccountId);
  });

  it('an agency that carries tax-ledger rows is closed, not deleted', async () => {
    const created = await agencies('', { method: 'POST', body: { stateCode: 'GA', registeredFrom: '2026-01-01' } });
    await db.insert(schema.taxLines).values({
      id: 'txl_used', entityId, sourceType: 'invoice', sourceId: 'inv_x', journalEntryId: 'je_x', taxDate: '2026-02-01', direction: 'sales',
      rate: '4.0000', taxableAmount: '100.00', taxAmount: '4.00', currency: 'USD', baseTaxableAmount: '100.00', baseTaxAmount: '4.00', agencyId: created.data.id,
    });
    const res = await agencies(`/${created.data.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ deleted: false, closed: true, status: 'closed' });
    expect((await agencies(`/${created.data.id}`)).data.hasTaxLines).toBe(true);
  });

  it('needs taxes permissions', async () => {
    expect((await agencies('', { perms: ['invoices:read'] })).status).toBe(403);
    expect((await agencies('', { method: 'POST', body: { stateCode: 'NY' }, perms: ['taxes:read'] })).status).toBe(403);
  });
});

describe('jurisdictions and rates', () => {
  let agencyId: string;
  let jurisdictionId: string;
  let otherAgencyId: string;

  beforeAll(async () => {
    agencyId = (await agencies('?stateCode=TX')).data[0].id;
    otherAgencyId = (await agencies('?stateCode=WA')).data[0].id;
  });

  it('adds a jurisdiction with its first rate and shows the rate in force', async () => {
    const res = await jurisdictions('', {
      method: 'POST',
      body: { agencyId, level: 'state', name: 'Texas', code: '48', rate: { rate: '6.25', effectiveFrom: '2000-01-01' } },
    });
    expect(res.status).toBe(201);
    jurisdictionId = res.data.id;
    expect(res.data).toMatchObject({ stateCode: 'TX', level: 'state', currentRate: 6.25 });
    expect((await jurisdictions('/does_not_exist')).status).toBe(404);
    expect((await jurisdictions('', { method: 'POST', body: { agencyId: 'nope', level: 'city', name: 'X' } })).status).toBe(404);
  });

  it('rates never overlap; closePrevious ends the open-ended one the day before', async () => {
    const overlapping = await jurisdictions(`/${jurisdictionId}/rates`, { method: 'POST', body: { rate: 7, effectiveFrom: '2026-01-01' } });
    expect(overlapping.status).toBe(409);

    const raised = await jurisdictions(`/${jurisdictionId}/rates`, { method: 'POST', body: { rate: 7, effectiveFrom: '2027-01-01', closePrevious: true } });
    expect(raised.status).toBe(201);
    const listed = await jurisdictions(`/${jurisdictionId}/rates`);
    expect(listed.data.map((r: { rate: string; effectiveFrom: string; effectiveTo: string | null }) => [Number(r.rate), r.effectiveFrom, r.effectiveTo])).toEqual([
      [7, '2027-01-01', null],
      [6.25, '2000-01-01', '2026-12-31'],
    ]);

    const [first] = listed.data.slice(-1);
    const stretched = await jurisdictions(`/${jurisdictionId}/rates/${first.id}`, { method: 'PATCH', body: { effectiveTo: '2027-06-30' } });
    expect(stretched.status).toBe(409);
    expect((await jurisdictions(`/${jurisdictionId}/rates`, { method: 'POST', body: { rate: 101, effectiveFrom: '2030-01-01' } })).status).toBe(400);
    expect((await jurisdictions(`/${jurisdictionId}/rates`, { method: 'POST', body: { rate: 5, effectiveFrom: '2030-02-01', effectiveTo: '2030-01-01' } })).status).toBe(400);
  });

  it('zones combine jurisdictions of their own agency, with valid ZIPs', async () => {
    const city = (await jurisdictions('', { method: 'POST', body: { agencyId, level: 'city', name: 'Austin', rate: { rate: 1, effectiveFrom: '2000-01-01' } } })).data.id;
    const foreign = (await jurisdictions('', { method: 'POST', body: { agencyId: otherAgencyId, level: 'state', name: 'Washington', rate: { rate: 6.5, effectiveFrom: '2000-01-01' } } })).data.id;

    const bad = await zones('', { method: 'POST', body: { agencyId, name: 'Bad', jurisdictionIds: [jurisdictionId, foreign], postalCodes: ['78701'] } });
    expect(bad.status).toBe(400);
    expect(bad.error?.message).toMatch(/own agency/);
    expect((await zones('', { method: 'POST', body: { agencyId, name: 'Bad', jurisdictionIds: [jurisdictionId], postalCodes: ['7870'] } })).status).toBe(400);
    expect((await zones('', { method: 'POST', body: { agencyId, name: 'Bad', jurisdictionIds: [jurisdictionId], postalCodes: [{ from: '78799', to: '78700' }] } })).status).toBe(400);
    expect((await zones('', { method: 'POST', body: { agencyId, name: 'Bad', jurisdictionIds: [] } })).status).toBe(400);

    const zone = await zones('', {
      method: 'POST',
      body: { agencyId, name: 'Austin', jurisdictionIds: [jurisdictionId, city], postalCodes: ['78701', { from: '78702', to: '78704' }], isOrigin: true },
    });
    expect(zone.status).toBe(201);
    expect(zone.data).toMatchObject({ stateCode: 'TX', isOrigin: true, priority: 100, combinedRate: 7.25 });
    expect(zone.data.jurisdictions.map((j: { name: string }) => j.name).sort()).toEqual(['Austin', 'Texas']);

    // A jurisdiction in use by a zone can't be deleted from under it.
    const blocked = await jurisdictions(`/${jurisdictionId}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect((await zones(`/${zone.data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await jurisdictions(`/${jurisdictionId}`, { method: 'DELETE' })).status).toBe(204);
  });
});

describe('taxability rules', () => {
  let agencyId: string;

  beforeAll(async () => {
    agencyId = (await agencies('?stateCode=TX')).data[0].id;
  });

  it('keeps one rule per agency, code and use at a time, with dates and a taxable share', async () => {
    const saas = await rules('', { method: 'POST', body: { agencyId, taxCode: 'saas', taxable: true, taxablePercent: 80, effectiveFrom: '2026-01-01' } });
    expect(saas.status).toBe(201);
    expect(saas.data).toMatchObject({ taxCode: 'saas', taxablePercent: '80.0000', appliesToUse: 'any', rateOverride: null });

    const clash = await rules('', { method: 'POST', body: { agencyId, taxCode: 'saas', taxable: false, effectiveFrom: '2026-06-01' } });
    expect(clash.status).toBe(409);
    // A rule for business use only sits next to the general one.
    const business = await rules('', { method: 'POST', body: { agencyId, taxCode: 'saas', taxable: true, appliesToUse: 'business', rateOverride: 3, effectiveFrom: '2026-01-01' } });
    expect(business.status).toBe(201);
    expect(business.data.rateOverride).toBe('3.0000');

    // End it, then the next period can start.
    expect((await rules(`/${saas.data.id}`, { method: 'PATCH', body: { effectiveTo: '2026-12-31' } })).status).toBe(200);
    expect((await rules('', { method: 'POST', body: { agencyId, taxCode: 'saas', taxable: false, effectiveFrom: '2027-01-01' } })).status).toBe(201);

    expect((await rules('', { method: 'POST', body: { agencyId, taxCode: 'made_up', taxable: true, effectiveFrom: '2026-01-01' } })).status).toBe(400);
    expect((await rules('', { method: 'POST', body: { agencyId, taxCode: 'saas', taxable: true, taxablePercent: 150, effectiveFrom: '2030-01-01' } })).status).toBe(400);
    expect((await rules(`?agencyId=${agencyId}&taxCode=saas`)).data).toHaveLength(3);
    expect((await rules(`/${saas.data.id}`, { method: 'DELETE' })).status).toBe(204);
  });
});

describe('exemption certificates', () => {
  it('validates the customer and states, and works the status out on every read', async () => {
    expect((await certificates('', { method: 'POST', body: { partyId: 'nobody', states: ['FL'], reason: 'resale' } })).status).toBe(400);
    expect((await certificates('', { method: 'POST', body: { partyId: 'pty_cust', states: ['ZZ'], reason: 'resale' } })).status).toBe(400);

    const valid = await certificates('', { method: 'POST', body: { partyId: 'pty_cust', states: ['FL'], reason: 'resale', certificateNumber: 'A-1', issuedOn: '2026-01-01', expiresOn: day(30) } });
    expect(valid.status).toBe(201);
    expect(valid.data).toMatchObject({ status: 'valid', daysUntilExpiry: 30, effectiveExpiresOn: day(30) });

    const lapsed = await certificates('', { method: 'POST', body: { partyId: 'pty_cust', states: ['FL'], reason: 'resale', issuedOn: '2020-01-01', expiresOn: '2020-12-31' } });
    expect(lapsed.data.status).toBe('expired');

    // No expiry date: Florida's annual resale certificate ends on 31 December of the year it was issued.
    const annual = await certificates('', { method: 'POST', body: { partyId: 'pty_cust', states: ['FL'], reason: 'resale', form: 'state_form', issuedOn: '2024-03-01' } });
    expect(annual.data).toMatchObject({ status: 'expired', effectiveExpiresOn: '2024-12-31' });

    const revoked = await certificates('', { method: 'POST', body: { partyId: 'pty_cust', states: ['TX'], reason: 'resale', status: 'revoked' } });
    expect(revoked.data.status).toBe('revoked');

    expect((await certificates('?partyId=pty_cust&status=expired')).data).toHaveLength(2);
    // The report of certificates running out within 60 days.
    const expiring = await certificates('?expiringWithinDays=60');
    expect(expiring.data.map((c: { id: string }) => c.id)).toEqual([valid.data.id]);

    // Re-dating a lapsed one makes it valid again.
    const renewed = await certificates(`/${lapsed.data.id}`, { method: 'PATCH', body: { expiresOn: day(200) } });
    expect(renewed.data.status).toBe('valid');
    expect((await certificates(`/${renewed.data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await certificates(`/${renewed.data.id}`)).status).toBe(404);
  });

  it('a blanket certificate has no single invoice', async () => {
    const res = await certificates('', { method: 'POST', body: { partyId: 'pty_cust', states: ['FL'], reason: 'resale', blanket: true, invoiceId: 'inv_whatever' } });
    expect(res.status).toBe(400);
  });
});

describe('calculation preview', () => {
  it('answers the totals the document will carry, per line and per jurisdiction, and saves nothing', async () => {
    const [agency] = await db.select().from(schema.salesTaxAgencies).where(eq(schema.salesTaxAgencies.stateCode, 'TX'));
    const state = await jurisdictions('', { method: 'POST', body: { agencyId: agency.id, level: 'state', name: 'Texas', rate: { rate: 6.25, effectiveFrom: '2000-01-01' } } });
    expect(state.status).toBe(201);
    const before = await db.select().from(schema.invoices);

    const res = await api('/api/sales-tax', salesTaxRoutes, '/calculate', {
      method: 'POST',
      body: {
        kind: 'invoice',
        contactId: 'pty_cust',
        issueDate: '2026-07-10',
        shippingAddress: { line1: '1 Main', city: 'Austin', state: 'TX', postalCode: '78701' },
        items: [
          { unitPrice: 100, quantity: 2, discountPercent: '10' },
          { unitPrice: '20', taxCode: 'non_taxable' },
        ],
      },
      perms: ['invoices:create'],
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ engine: 'manual', shipToState: 'TX', subtotal: '200.00', discountTotal: '20.00', taxTotal: '11.25', total: '211.25' });
    expect(res.data.lines).toEqual([
      expect.objectContaining({ index: 0, id: 'line_0', lineTotal: '180.00', taxAmount: '11.25', taxRate: '6.2500', taxCode: 'general' }),
      expect.objectContaining({ index: 1, id: 'line_1', lineTotal: '20.00', taxAmount: '0.00' }),
    ]);
    expect(res.data.jurisdictions).toEqual([expect.objectContaining({ jurisdictionName: 'Texas', level: 'state', rate: 6.25, taxableAmount: 180, taxAmount: 11.25 })]);
    expect(await db.select().from(schema.invoices)).toHaveLength(before.length);

    // A form with no permission to write invoices or bills can't use it.
    expect((await api('/api/sales-tax', salesTaxRoutes, '/calculate', { method: 'POST', body: { items: [{ unitPrice: 1 }] }, perms: ['leads:read'] })).status).toBe(403);
  });

  it('answers for a Dutch entity too, through the same path', async () => {
    let nlId: string | undefined;
    const nlApi = apiFor(db, () => nlId);
    const nl = await nlApi('/api/accounting-entities', accountingEntitiesRoutes, '', {
      method: 'POST',
      body: { name: 'Ledger BV', jurisdictionCode: 'NL', vatNumber: 'NL123456789B01', taxIdentifiers: { registrationNumber: '12345678' }, bankDetails: { iban: 'NL91ABNA0417164300' } },
    });
    nlId = nl.data.id;
    const [rate] = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, nlId!));
    const hoog = (await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, nlId!))).find((r) => r.name === 'BTW Hoog 21%') ?? rate;
    const res = await nlApi('/api/sales-tax', salesTaxRoutes, '/calculate', {
      method: 'POST',
      body: { kind: 'invoice', items: [{ unitPrice: '100', taxRateId: hoog.id }] },
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ engine: null, subtotal: '100.00', taxTotal: '21.00', total: '121.00' });
    expect(res.data.lines[0]).toMatchObject({ taxRateId: hoog.id, taxAmount: '21.00' });
  });
});
