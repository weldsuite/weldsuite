/**
 * Sales tax reports and the nexus monitor (pglite): liability tied to the
 * ledger, sales by state / customer / jurisdiction, exceptions, expiring and
 * missing certificates, provider reconciliation, and a state crossing 100% of
 * its threshold next to one at 85%.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { salesTaxRoutes } from './index';
import {
  addAgency,
  callRoute,
  createUsFixture,
  postSale,
  texasRows,
  type UsFixture,
} from '../../services/sales-tax-returns/test-fixtures';

let db: Database;
let f: UsFixture;

const api = (path: string, opts: Parameters<typeof callRoute>[4] = {}) =>
  callRoute(db, '/api/sales-tax', salesTaxRoutes, `/api/sales-tax${path}`, { entityId: f.entityId, ...opts });

const zero = (code: string, name: string) => [{ code, name, level: 'state' as const, rate: 0, tax: 0 }];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T15:00:00Z'));
  db = (await createPgliteDb()).db;
  f = await createUsFixture(db);
  await addAgency(f, { id: 'agy_tx', stateCode: 'TX', name: 'Texas Comptroller', firstPeriodStart: '2026-01-01', registeredFrom: '2026-01-01' });

  await db.insert(schema.parties).values([
    { id: 'pty_a', displayName: 'Acme Reseller', role: 'customer' },
    { id: 'pty_b', displayName: 'Bright Retail', role: 'customer' },
    { id: 'pty_c', displayName: 'Charity Corp', role: 'customer' },
    { id: 'pty_d', displayName: 'Marketplace Buyer', role: 'customer' },
  ]);
  await db.insert(schema.exemptionCertificates).values({
    id: 'cert_ok', entityId: f.entityId, partyId: 'pty_b', states: ['TX'], reason: 'resale', certificateNumber: 'R-1',
    form: 'state_form', issuedOn: '2026-01-05', expiresOn: null,
  });

  await postSale(f, {
    id: 'inv_a', number: 'INV-A', date: '2026-07-10', agencyId: 'agy_tx', stateCode: 'TX', contactId: 'pty_a', contactName: 'Acme Reseller',
    lines: [{ id: 'inv_a_l1', gross: 1000, taxable: 1000, rows: texasRows(1000) }],
  });
  await postSale(f, {
    id: 'inv_b', number: 'INV-B', date: '2026-08-15', agencyId: 'agy_tx', stateCode: 'TX', contactId: 'pty_b', contactName: 'Bright Retail',
    lines: [{ id: 'inv_b_l1', gross: 500, taxable: 0, exempt: 500, exemptReason: 'resale', certificateId: 'cert_ok', rows: texasRows(0) }],
  });
  // exempt, no certificate, the 90 days are over
  await postSale(f, {
    id: 'inv_c', number: 'INV-C', date: '2026-07-05', agencyId: 'agy_tx', stateCode: 'TX', contactId: 'pty_c', contactName: 'Charity Corp',
    lines: [{ id: 'inv_c_l1', gross: 100, taxable: 0, exempt: 100, exemptReason: 'resale', rows: texasRows(0) }],
  });
  // exempt, no certificate, still within the 90 days
  await postSale(f, {
    id: 'inv_d', number: 'INV-D', date: '2026-09-20', agencyId: 'agy_tx', stateCode: 'TX', contactId: 'pty_c', contactName: 'Charity Corp',
    lines: [{ id: 'inv_d_l1', gross: 200, taxable: 0, exempt: 200, exemptReason: 'nonprofit', rows: texasRows(0) }],
  });
  // taxable, registered state, no tax and no exemption
  await postSale(f, {
    id: 'inv_e', number: 'INV-E', date: '2026-09-02', agencyId: 'agy_tx', stateCode: 'TX', contactId: 'pty_a', contactName: 'Acme Reseller',
    lines: [{ id: 'inv_e_l1', gross: 150, taxable: 150, rows: zero('TX-STATE', 'Texas') }],
  });
  // tax charged in a state with no registration
  await postSale(f, {
    id: 'inv_nv', number: 'INV-NV', date: '2026-08-01', agencyId: null, stateCode: 'NV', contactId: 'pty_d', contactName: 'Marketplace Buyer',
    lines: [{ id: 'inv_nv_l1', gross: 73, taxable: 73, rows: [{ code: 'NV-STATE', name: 'Nevada', level: 'state', rate: 6.85, tax: 5 }] }],
  });
  await postSale(f, {
    id: 'inv_mkt', number: 'INV-MKT', date: '2026-09-05', agencyId: 'agy_tx', stateCode: 'TX', marketplace: true, contactId: 'pty_d', contactName: 'Marketplace Buyer',
    lines: [{ id: 'inv_mkt_l1', gross: 300, taxable: 0, rows: zero('TX-STATE', 'Texas') }],
  });
  await postSale(f, {
    id: 'inv_noship', number: 'INV-NOSHIP', date: '2026-09-06', agencyId: null, stateCode: 'TX', shipToState: '', noTaxRows: true,
    lines: [{ id: 'inv_noship_l1', gross: 90, taxable: 90, rows: [] }],
  });
  await postSale(f, {
    id: 'inv_ovr', number: 'INV-OVR', date: '2026-09-07', agencyId: 'agy_tx', stateCode: 'TX', contactId: 'pty_a', contactName: 'Acme Reseller',
    lines: [{
      id: 'inv_ovr_l1', gross: 100, taxable: 100, override: { amount: 3, reason: 'Farm exemption proof pending' },
      rows: [{ code: 'TX-STATE', name: 'Texas', level: 'state', rate: 6.25, tax: 3 }],
    }],
  });
  await postSale(f, {
    id: 'inv_warn', number: 'INV-WARN', date: '2026-09-08', agencyId: 'agy_tx', stateCode: 'TX', contactId: 'pty_a', contactName: 'Acme Reseller',
    lines: [{ id: 'inv_warn_l1', gross: 50, taxable: 50, rows: texasRows(50) }],
  });
  await db
    .update(schema.invoices)
    .set({ taxWarnings: ['Avalara commit failed: timeout', 'Address could not be validated'] })
    .where(eq(schema.invoices.id, 'inv_warn'));

  // --- nexus: Washington past its threshold, California at 85% ---------------
  const wa = ['2026-02-10', '2026-04-15', '2026-06-20', '2026-08-20', '2026-09-25'];
  for (const [i, date] of wa.entries()) {
    await postSale(f, {
      id: `inv_wa${i}`, number: `INV-WA${i}`, date, agencyId: null, stateCode: 'WA', contactId: 'pty_d',
      lines: [{ id: `inv_wa${i}_l1`, gross: 20_000, taxable: 20_000, rows: zero('WA-STATE', 'Washington') }],
    });
  }
  await postSale(f, {
    id: 'inv_ca', number: 'INV-CA', date: '2026-05-05', agencyId: null, stateCode: 'CA', contactId: 'pty_d',
    lines: [{ id: 'inv_ca_l1', gross: 425_000, taxable: 425_000, rows: zero('CA-STATE', 'California') }],
  });
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
});

describe('liability report', () => {
  it('ties each agency to the general ledger and breaks it down by jurisdiction', async () => {
    const res = await api('/reports/liability?asOf=2026-10-08');
    expect(res.status).toBe(200);
    const tx = (res.data.agencies as Array<Record<string, any>>).find((a) => a.agencyId === 'agy_tx')!;
    // 82.50 + 3.00 (override) + 4.13
    expect(tx).toMatchObject({ collected: 89.63, filed: 0, paid: 0, outstanding: 89.63, glBalance: 89.63, difference: 0 });
    const byCode = Object.fromEntries((tx.jurisdictions as Array<Record<string, any>>).map((j) => [j.jurisdictionCode, j]));
    expect(byCode['TX-STATE']).toMatchObject({ collected: 68.63, outstanding: 68.63, level: 'state' });
    expect(byCode['TX-CITY-AUSTIN'].collected).toBe(10.5);
    expect(byCode['TX-TRANSIT'].collected).toBe(10.5);
    expect(res.data.totals).toMatchObject({ collected: 89.63, glBalance: 89.63, difference: 0 });
  });

  it('shows a difference when the ledger moved without tax data, and an earlier date shows less', async () => {
    const early = await api('/reports/liability?asOf=2026-07-31');
    const tx = (early.data.agencies as Array<Record<string, any>>)[0]!;
    expect(tx).toMatchObject({ collected: 82.5, glBalance: 82.5, difference: 0 });
  });
});

describe('sales summary', () => {
  it('groups by ship-to state with exempt sales by reason', async () => {
    const res = await api('/reports/sales-summary?from=2026-07-01&to=2026-09-30&groupBy=state');
    expect(res.status).toBe(200);
    const rows = Object.fromEntries((res.data.rows as Array<Record<string, any>>).map((r) => [r.key, r]));
    expect(rows.TX).toMatchObject({
      grossSales: 2400, taxableSales: 1300, exemptSales: 800, nonTaxableSales: 0, marketplaceSales: 300, tax: 89.63,
      exemptByReason: { resale: 600, nonprofit: 200 },
    });
    expect(rows.NV).toMatchObject({ grossSales: 73, tax: 5 });
    // two Washington sales of 20,000 fall in the quarter as well
    expect(res.data.totals).toMatchObject({ grossSales: 2473 + 40_000, tax: 94.63 });
    expect(rows.WA).toMatchObject({ grossSales: 40_000, tax: 0 });
  });

  it('groups by customer and by jurisdiction', async () => {
    const customers = await api('/reports/sales-summary?from=2026-07-01&to=2026-09-30&groupBy=customer');
    const byName = Object.fromEntries((customers.data.rows as Array<Record<string, any>>).map((r) => [r.label, r]));
    // INV-A 1000, INV-E 150, INV-OVR 100, INV-WARN 50
    expect(byName['Acme Reseller']).toMatchObject({ grossSales: 1300, tax: 89.63, documents: 4 });
    expect(byName['Charity Corp']).toMatchObject({ grossSales: 300, exemptSales: 300, tax: 0 });
    expect(byName['Bright Retail']).toMatchObject({ grossSales: 500, exemptSales: 500 });

    const jurisdictions = await api('/reports/sales-summary?from=2026-07-01&to=2026-09-30&groupBy=jurisdiction');
    const byCode = Object.fromEntries((jurisdictions.data.rows as Array<Record<string, any>>).map((r) => [r.key, r]));
    expect(byCode['TX-STATE']).toMatchObject({ tax: 68.63, level: 'state', grossSales: 2400 });
    expect(byCode['TX-CITY-AUSTIN']).toMatchObject({ tax: 10.5, grossSales: 1850 });
    expect(byCode['NV-STATE']).toMatchObject({ tax: 5, grossSales: 73 });

    expect((await api('/reports/sales-summary?groupBy=planet')).status).toBe(400);
  });
});

describe('exceptions', () => {
  it('lists the documents that need a look, with their reasons', async () => {
    const res = await api('/reports/exceptions?from=2026-07-01&to=2026-10-08');
    expect(res.status).toBe(200);
    expect(res.data.counts).toEqual({
      no_ship_to_state: 1,
      tax_in_unregistered_state: 1,
      taxable_without_tax: 1,
      marketplace_sale: 1,
      tax_override: 1,
      provider_commit_failure: 1,
      tax_warning: 1,
    });
    const byKind = Object.fromEntries((res.data.exceptions as Array<Record<string, any>>).map((e) => [e.kind, e]));
    expect(byKind.no_ship_to_state).toMatchObject({ documentNumber: 'INV-NOSHIP', severity: 'error' });
    expect(byKind.tax_in_unregistered_state).toMatchObject({ documentNumber: 'INV-NV', stateCode: 'NV', taxAmount: 5 });
    expect(byKind.taxable_without_tax).toMatchObject({ documentNumber: 'INV-E', stateCode: 'TX', amount: 150 });
    expect(byKind.marketplace_sale).toMatchObject({ documentNumber: 'INV-MKT', amount: 300, severity: 'info' });
    expect(byKind.tax_override.message).toContain('Farm exemption proof pending');
    expect(byKind.provider_commit_failure).toMatchObject({ documentNumber: 'INV-WARN', message: 'Avalara commit failed: timeout' });
  });
});

describe('exemption certificates', () => {
  it('lists the exempt sales that still have no certificate, with the 90-day cure deadline', async () => {
    const res = await api('/reports/certificates/missing');
    expect(res.status).toBe(200);
    expect(res.data.certificates).toEqual([
      expect.objectContaining({ documentNumber: 'INV-C', saleDate: '2026-07-05', cureDeadline: '2026-10-03', pastDeadline: true, daysLeft: -5, exemptSales: 100, stateCode: 'TX', customerName: 'Charity Corp' }),
      expect.objectContaining({ documentNumber: 'INV-D', saleDate: '2026-09-20', cureDeadline: '2026-12-19', pastDeadline: false, exemptSales: 200, exemptReason: 'nonprofit' }),
    ]);
    expect(res.data.totals).toEqual({ documents: 2, exemptSales: 300, pastDeadline: 1 });
  });

  it('lists the certificates expiring within the window, the state rule applied when there is no date', async () => {
    await db.insert(schema.exemptionCertificates).values([
      // Florida's annual resale certificate ends on 31 December of the year it was issued
      { id: 'cert_fl', entityId: f.entityId, partyId: 'pty_a', states: ['FL'], reason: 'resale', certificateNumber: 'FL-9', form: 'state_form', issuedOn: '2026-01-05' },
      { id: 'cert_soon', entityId: f.entityId, partyId: 'pty_c', states: ['TX'], reason: 'nonprofit', certificateNumber: 'NP-2', form: 'state_form', expiresOn: '2026-10-25' },
      { id: 'cert_lapsed', entityId: f.entityId, partyId: 'pty_d', states: ['TX'], reason: 'resale', certificateNumber: 'OLD-1', form: 'state_form', expiresOn: '2026-09-01' },
      { id: 'cert_later', entityId: f.entityId, partyId: 'pty_d', states: ['TX'], reason: 'resale', certificateNumber: 'LATER', form: 'state_form', expiresOn: '2027-06-01' },
    ]);
    const res = await api('/reports/certificates/expiring?days=60');
    expect(res.status).toBe(200);
    expect(res.data.certificates.map((c: Record<string, any>) => [c.certificateNumber, c.expiresOn, c.daysLeft, c.expired])).toEqual([
      ['OLD-1', '2026-09-01', -37, true],
      ['NP-2', '2026-10-25', 17, false],
    ]);
    expect(res.data.certificates[1]).toMatchObject({ customerName: 'Charity Corp', states: ['TX'], reason: 'nonprofit' });

    const wide = await api('/reports/certificates/expiring?days=90');
    expect(wide.data.certificates.map((c: Record<string, any>) => c.certificateNumber)).toEqual(['OLD-1', 'NP-2', 'FL-9']);
    expect(wide.data.certificates[2]).toMatchObject({ expiresOn: '2026-12-31', daysLeft: 84, customerName: 'Acme Reseller' });
  });
});

describe('provider reconciliation', () => {
  it('has nothing to reconcile on the manual engine', async () => {
    const res = await api('/reports/provider-reconciliation?from=2026-09-01&to=2026-09-30');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ engine: 'manual', applicable: false, documents: [] });
  });

  it('reports missing commits, failed commits and ledger differences for Avalara', async () => {
    await db.update(schema.entities).set({ salesTaxEngine: 'avalara' }).where(eq(schema.entities.id, f.entityId));
    const committed = new Date('2026-09-02T10:00:00Z');
    // INV-E: committed, ledger matches (no tax)
    await db.update(schema.invoices).set({ taxEngine: 'avalara', taxEngineRef: 'AVA-E', taxCommittedAt: committed }).where(eq(schema.invoices.id, 'inv_e'));
    // INV-OVR: committed with a provider tax that differs from the ledger
    await db
      .update(schema.invoices)
      .set({
        taxEngine: 'avalara', taxEngineRef: 'AVA-OVR', taxCommittedAt: committed, taxTotal: '6.25',
        taxBreakdown: [{ taxRateId: 'r', taxRateName: 'Texas', taxRate: 6.25, taxableAmount: 100, taxAmount: 6.25 }],
      })
      .where(eq(schema.invoices.id, 'inv_ovr'));
    // INV-WARN: the commit failed
    await db.update(schema.invoices).set({ taxEngine: 'avalara' }).where(eq(schema.invoices.id, 'inv_warn'));
    // INV-MKT: never committed (INV-A and the rest are outside the window)

    const res = await api('/reports/provider-reconciliation?from=2026-09-01&to=2026-09-30');
    expect(res.status).toBe(200);
    expect(res.data.applicable).toBe(true);
    expect(res.data.notes[0]).toContain('no transaction listing');
    const byNumber = Object.fromEntries((res.data.documents as Array<Record<string, any>>).map((d) => [d.documentNumber, d]));
    expect(Object.keys(byNumber).sort()).toEqual(['INV-D', 'INV-MKT', 'INV-NOSHIP', 'INV-OVR', 'INV-WA4', 'INV-WARN']);
    expect(byNumber['INV-OVR']).toMatchObject({ status: 'ledger_mismatch', providerTax: 6.25, ledgerTax: 3, difference: -3.25, severity: 'error' });
    expect(byNumber['INV-WARN']).toMatchObject({ status: 'commit_failed', message: 'Avalara commit failed: timeout' });
    expect(byNumber['INV-MKT']).toMatchObject({ status: 'missing_commit', engineRef: null, severity: 'error' });

    const month = (res.data.periods as Array<Record<string, any>>)[0]!;
    expect(month).toMatchObject({ period: '2026-09', committed: 2 });
    expect(month.uncommitted).toBeGreaterThan(0);
    expect(month.documents).toBe(7);
    expect(month.problems).toBe(6);

    const all = await api('/reports/provider-reconciliation?from=2026-09-01&to=2026-09-30&all=1');
    expect(all.data.documents.find((d: Record<string, any>) => d.documentNumber === 'INV-E')).toMatchObject({ status: 'ok', engineRef: 'AVA-E' });
  });
});

describe('nexus monitor', () => {
  it('measures every state against its own rule', async () => {
    const res = await api('/nexus');
    expect(res.status).toBe(200);
    const rows = Object.fromEntries((res.data.rows as Array<Record<string, any>>).map((r) => [r.stateCode, r]));
    // no sales tax, nothing to monitor
    expect(rows.DE).toBeUndefined();
    expect(res.data.rows.length).toBeGreaterThan(40);

    // Washington: five 20,000 sales reach the 100,000 threshold on the fifth
    expect(rows.WA).toMatchObject({
      status: 'exceeded', alert: 'register', registered: false, salesTotal: 100_000, thresholdSales: 100_000,
      percentOfThreshold: 100, exceededOn: '2026-09-25', collectFrom: '2026-09-26', agencyId: null, base: 'gross',
    });
    // California: 425,000 of 500,000
    expect(rows.CA).toMatchObject({ status: 'approaching', alert: 'watch', percentOfThreshold: 85, salesTotal: 425_000, registered: false });
    // Texas: registered, far below its 500,000
    expect(rows.TX).toMatchObject({ status: 'below', registered: true, agencyId: 'agy_tx', alert: 'ok' });
    expect(rows.TX.percentOfThreshold).toBeLessThan(1);
    // nearest to its threshold first
    expect(res.data.rows[0].stateCode).toBe('WA');
    expect(res.data.rows[1].stateCode).toBe('CA');
    expect(res.data.summary).toMatchObject({ exceededUnregistered: 1, approaching: 1 });
  });

  it('opens one state with the months of sales behind the measurement', async () => {
    const res = await api('/nexus/wa');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ stateCode: 'WA', status: 'exceeded', rule: { salesThreshold: 100_000, base: 'gross' } });
    const months = Object.fromEntries((res.data.monthly as Array<Record<string, any>>).map((m) => [m.month, m]));
    expect(months['2026-02']).toMatchObject({ sales: 20_000, transactions: 1 });
    expect(months['2026-03']).toMatchObject({ sales: 0, transactions: 0 });
    expect(months['2026-09']).toMatchObject({ sales: 20_000, transactions: 1 });
    expect((await api('/nexus/DE')).status).toBe(404);
    expect((await api('/nexus?asOf=soon')).status).toBe(400);
  });

  it('an earlier date sees the state below its threshold', async () => {
    const res = await api('/nexus?asOf=2026-06-30');
    const wa = (res.data.rows as Array<Record<string, any>>).find((r) => r.stateCode === 'WA')!;
    expect(wa).toMatchObject({ status: 'below', salesTotal: 60_000, percentOfThreshold: 60 });
  });
});

describe('permissions', () => {
  it('needs taxes:read for every report', async () => {
    for (const path of ['/reports/liability', '/reports/sales-summary', '/reports/exceptions', '/reports/certificates/expiring', '/reports/certificates/missing', '/reports/provider-reconciliation', '/nexus', '/nexus/WA']) {
      const res = await api(path, { perms: ['invoices:read'] });
      expect(res.status, path).toBe(403);
    }
  });
});
