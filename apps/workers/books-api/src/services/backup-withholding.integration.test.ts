/**
 * The 24% backup withholding decision the payments code takes before it posts a
 * payment to a vendor (pglite).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { computeBackupWithholding } from './backup-withholding';

let db: Database;
const ENTITY = 'ent_bw';

async function vendor(id: string, extra: Partial<typeof schema.parties.$inferInsert> = {}) {
  await db.insert(schema.parties).values({
    id,
    displayName: id,
    role: 'supplier',
    is1099Vendor: true,
    default1099Form: 'nec',
    default1099Box: 'nec_1',
    ...extra,
  });
  return id;
}

async function paid(partyId: string, date: string, amount: number, extra: Partial<typeof schema.payments.$inferInsert> = {}) {
  await db.insert(schema.payments).values({
    id: `pay_${Math.random().toString(36).slice(2, 12)}`,
    entityId: ENTITY,
    type: 'sent',
    amount: amount.toFixed(2),
    currency: 'USD',
    date: new Date(`${date}T00:00:00Z`),
    contactId: partyId,
    paymentMethod: 'check',
    ...extra,
  });
}

const withheld = (partyId: string, grossAmount: number, date = '2025-06-15', extra: Record<string, unknown> = {}) =>
  computeBackupWithholding(db, { entityId: ENTITY, partyId, grossAmount, date, ...extra });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

describe('computeBackupWithholding', () => {
  it('withholds 24% from a 1099 vendor without a TIN, in whole cents', async () => {
    const id = await vendor('pty_notin');
    expect(await withheld(id, 3000)).toEqual({ amount: 720, reason: 'no_tin', rate: 0.24, net: 2280 });
    // No default box, so no threshold to wait for: every dollar is withheld.
    const round = await vendor('pty_round', { default1099Form: null, default1099Box: null });
    expect((await withheld(round, 100.5)).amount).toBe(24.12);
    expect((await withheld(round, 33.33)).amount).toBe(8);
    expect((await withheld(round, 33.33)).net).toBe(25.33);
    // Under the $600 threshold of a box nothing is reportable yet.
    expect((await withheld(id, 100.5)).amount).toBe(0);
  });

  it('withholds from a vendor with a TIN after an IRS B notice, and not before', async () => {
    const clean = await vendor('pty_clean', { tinType: 'ein', tinLast4: '1234' });
    expect(await withheld(clean, 5000)).toMatchObject({ amount: 0, reason: null, net: 5000 });
    const flagged = await vendor('pty_flagged', { tinType: 'ein', tinLast4: '1234', backupWithholding: true });
    expect(await withheld(flagged, 1000)).toMatchObject({ amount: 240, reason: 'flagged' });
  });

  it('starts with the payment that reaches the threshold and covers all of it', async () => {
    const id = await vendor('pty_threshold');
    expect((await withheld(id, 500)).amount).toBe(0);
    await paid(id, '2025-02-01', 400);
    // $400 paid before: a $300 payment brings the year to $700, over $600.
    expect(await withheld(id, 300)).toMatchObject({ amount: 72, reason: 'no_tin' });
    expect((await withheld(id, 150)).amount).toBe(0);
    // Earlier years don't count, later payments in the year don't either.
    await paid(id, '2024-12-01', 5000);
    expect((await withheld(id, 150)).amount).toBe(0);
    await paid(id, '2025-09-01', 5000);
    expect((await withheld(id, 150, '2025-06-15')).amount).toBe(0);
    expect((await withheld(id, 150, '2025-10-15')).amount).toBe(36);
  });

  it('uses the threshold of the payment year, and ignores voided, card and payroll payments', async () => {
    const id = await vendor('pty_2026');
    expect((await withheld(id, 1500, '2026-03-01')).amount).toBe(0); // $2,000 from 2026
    expect((await withheld(id, 1500, '2025-03-01')).amount).toBe(360); // $600 in 2025
    await paid(id, '2026-01-10', 900, { deletedAt: new Date() });
    await paid(id, '2026-01-11', 900, { paymentMethod: 'credit_card' });
    await paid(id, '2026-01-12', 900, { paidThroughPayroll: true });
    expect((await withheld(id, 1500, '2026-03-01')).amount).toBe(0);
    await paid(id, '2026-01-13', 600);
    expect((await withheld(id, 1500, '2026-03-01')).amount).toBe(360);
  });

  it('leaves out exempt payees, corporations (except law firms), non-1099 vendors, cards and payroll', async () => {
    const exempt = await vendor('pty_exempt', { w9: { exemptPayeeCode: '5', federalTaxClassification: 'individual' } });
    expect((await withheld(exempt, 3000)).amount).toBe(0);

    const corporation = await vendor('pty_corp', { w9: { federalTaxClassification: 'c_corporation' } });
    expect((await withheld(corporation, 3000)).amount).toBe(0);
    const lawFirm = await vendor('pty_law', { w9: { federalTaxClassification: 'c_corporation', isAttorney: true } as never });
    expect((await withheld(lawFirm, 3000)).amount).toBe(720);

    const plain = await vendor('pty_plain', { is1099Vendor: false });
    expect((await withheld(plain, 3000)).amount).toBe(0);
    expect((await withheld('pty_missing', 3000)).amount).toBe(0);

    const id = await vendor('pty_methods');
    expect((await withheld(id, 3000, '2025-06-15', { paymentMethod: 'credit_card' })).amount).toBe(0);
    expect((await withheld(id, 3000, '2025-06-15', { paymentMethod: 'third_party_network' })).amount).toBe(0);
    expect((await withheld(id, 3000, '2025-06-15', { paidThroughPayroll: true })).amount).toBe(0);
    expect((await withheld(id, 3000, '2025-06-15', { fromCreditCardAccount: true })).amount).toBe(0);
    expect((await withheld(id, 3000, '2025-06-15', { paymentMethod: 'ach' })).amount).toBe(720);
  });

  it('skips vendors whose payments are left out of 1099 reporting, and zero amounts', async () => {
    const omit = await vendor('pty_omit', { default1099Box: 'omit', default1099Form: null });
    expect((await withheld(omit, 3000)).amount).toBe(0);
    const id = await vendor('pty_zero');
    expect(await withheld(id, 0)).toMatchObject({ amount: 0, reason: null, net: 0 });
    expect((await withheld(id, -5)).amount).toBe(0);
  });

  it('withholds from the first dollar when the vendor has no default box to take a threshold from', async () => {
    const id = await vendor('pty_nobox', { default1099Form: null, default1099Box: null });
    expect((await withheld(id, 100)).amount).toBe(24);
  });
});
