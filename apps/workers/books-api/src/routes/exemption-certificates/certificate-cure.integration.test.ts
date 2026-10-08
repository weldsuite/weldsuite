/**
 * A certificate recorded after an exempt sale cures it when it arrives within
 * the 90 days the Streamlined Sales Tax rules allow: the sale's tax-ledger
 * rows get the certificate and leave the missing-certificates report. Later
 * certificates, other customers, other states and filed rows are untouched.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { exemptionCertificatesRoutes } from './index';
import { salesTaxRoutes } from '../sales-tax';
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

const certificates = (path: string, opts: Parameters<typeof callRoute>[4] = {}) =>
  callRoute(db, '/api/exemption-certificates', exemptionCertificatesRoutes, `/api/exemption-certificates${path}`, { entityId: f.entityId, ...opts });

const missing = () =>
  callRoute(db, '/api/sales-tax', salesTaxRoutes, '/api/sales-tax/reports/certificates/missing', { entityId: f.entityId });

async function certificateOf(invoiceId: string) {
  const rows = await db
    .select({ certificateId: schema.taxLines.certificateId })
    .from(schema.taxLines)
    .where(and(eq(schema.taxLines.sourceId, invoiceId), eq(schema.taxLines.entityId, f.entityId)));
  return [...new Set(rows.map((r) => r.certificateId))];
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T15:00:00Z'));
  db = (await createPgliteDb()).db;
  f = await createUsFixture(db);
  await addAgency(f, { id: 'agy_tx', stateCode: 'TX', name: 'Texas Comptroller', firstPeriodStart: '2026-01-01', registeredFrom: '2026-01-01' });
  await db.insert(schema.parties).values([
    { id: 'pty_reseller', displayName: 'Reseller Co', role: 'customer' },
    { id: 'pty_other', displayName: 'Other Co', role: 'customer' },
  ]);

  const exempt = (id: string, date: string, contactId: string, stateCode = 'TX') =>
    postSale(f, {
      id, number: id.toUpperCase(), date, agencyId: stateCode === 'TX' ? 'agy_tx' : null, stateCode, contactId,
      lines: [{ id: `${id}_l1`, gross: 400, taxable: 0, exempt: 400, exemptReason: 'resale', rows: texasRows(0) }],
    });
  await exempt('inv_recent', '2026-09-01', 'pty_reseller'); // 37 days before the certificate
  await exempt('inv_old', '2026-05-01', 'pty_reseller'); // more than 90 days before it
  await exempt('inv_ok_state', '2026-09-10', 'pty_reseller', 'OK'); // a state the certificate doesn't cover
  await exempt('inv_other', '2026-09-05', 'pty_other'); // another customer
  await exempt('inv_filed', '2026-08-20', 'pty_reseller');
  await db.update(schema.taxLines).set({ taxReturnId: 'txr_filed' }).where(eq(schema.taxLines.sourceId, 'inv_filed'));
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
});

describe('a certificate that arrives after the sale', () => {
  it('lists the uncured sales first', async () => {
    const res = await missing();
    expect(res.status).toBe(200);
    const numbers = (res.data.certificates as Array<{ documentNumber: string }>).map((m) => m.documentNumber);
    expect(numbers).toEqual(expect.arrayContaining(['INV_RECENT', 'INV_OLD', 'INV_OTHER']));
  });

  it('cures only the covered, unfiled sales within the 90 days', async () => {
    const res = await certificates('', {
      method: 'POST',
      body: { partyId: 'pty_reseller', states: ['TX'], reason: 'resale', certificateNumber: 'TX-77', receivedOn: '2026-10-08' },
    });
    expect(res.status).toBe(201);
    expect(res.data.linkedSales).toBe(1);
    const id = res.data.id as string;

    expect(await certificateOf('inv_recent')).toEqual([id]);
    expect(await certificateOf('inv_old')).toEqual([null]);
    expect(await certificateOf('inv_ok_state')).toEqual([null]);
    expect(await certificateOf('inv_other')).toEqual([null]);
    expect(await certificateOf('inv_filed')).toEqual([null]);

    const after = await missing();
    const numbers = (after.data.certificates as Array<{ documentNumber: string }>).map((m) => m.documentNumber);
    expect(numbers).not.toContain('INV_RECENT');
    expect(numbers).toContain('INV_OLD');
  });

  it('does not cure with a revoked certificate', async () => {
    const res = await certificates('', {
      method: 'POST',
      body: { partyId: 'pty_other', states: ['TX'], reason: 'resale', status: 'revoked', receivedOn: '2026-10-08' },
    });
    expect(res.status).toBe(201);
    expect(res.data.linkedSales).toBe(0);
    expect(await certificateOf('inv_other')).toEqual([null]);

    // Marking it valid later cures the sale.
    const fixed = await certificates(`/${res.data.id as string}`, { method: 'PATCH', body: { status: 'valid' } });
    expect(fixed.status).toBe(200);
    expect(fixed.data.linkedSales).toBe(1);
    expect(await certificateOf('inv_other')).toEqual([res.data.id]);
  });
});
