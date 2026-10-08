/**
 * The yearly 1099 computation through the real loader (pglite): plan scenario 8.
 * One vendor paid by check and by credit card in the same year counts only the
 * check; a vendor below the threshold is left out; a corporation is left out
 * unless it is a law firm; the same payments are checked against $600 for 2025
 * and $2,000 for 2026.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { buildSummary, compute1099ForEntity, summarize1099, vendorDrillDown, backupWithholdingFor945 } from './summary';
import { seedEntityAndVendors, seedPaymentHistory, type Fixture } from './test-fixtures';

let db: Database;
let fx: Fixture;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  fx = await seedEntityAndVendors(db);
  await seedPaymentHistory(fx);
}, 180_000);

function row(summary: Awaited<ReturnType<typeof summarize1099>>, key: string) {
  return summary.vendors.find((v) => v.partyId === fx.parties[key]);
}

describe('tax year 2025 ($600 threshold)', () => {
  it('counts only the check when a vendor was paid by check and by credit card', async () => {
    const summary = await summarize1099(db, fx.entityId, 2025);
    const alpha = row(summary, 'alpha')!;
    expect(alpha.status).toBe('included');
    expect(alpha.boxes).toEqual({ nec_1: 4000 });
    // The card payment goes to the processor's 1099-K, the travel line is omitted by its account,
    // the deleted check and the voided check never happened.
    expect(alpha.excluded.cardOrNetwork).toBe(3000);
    expect(alpha.excluded.omittedBox).toBe(1000);
    expect(alpha.paymentCount).toBe(1);
    expect(alpha.reasons.join(' ')).toContain('1099-K');
    expect(alpha.tinMasked).toBe('***-**-7891');
    expect(JSON.stringify(summary)).not.toContain('234567891');
  });

  it('reports vendors over $600 and leaves out corporations unless they are law firms', async () => {
    const summary = await summarize1099(db, fx.entityId, 2025);
    expect(row(summary, 'bravo')).toMatchObject({ status: 'included', boxes: { nec_1: 1500 } });
    expect(row(summary, 'charlie')).toMatchObject({ status: 'excluded_corporation', isCorporation: true, boxes: {} });
    expect(row(summary, 'delta')).toMatchObject({ status: 'included', isCorporation: true, isAttorney: true, boxes: { nec_1: 8000 } });
    expect(row(summary, 'echo')).toMatchObject({ status: 'included', forms: ['misc'], boxes: { misc_1: 24000 } });
  });

  it('reads bank lines categorized straight to a vendor, and skips card accounts, card methods and payroll', async () => {
    const summary = await summarize1099(db, fx.entityId, 2025);
    expect(row(summary, 'hotel')).toMatchObject({ status: 'included', boxes: { nec_1: 700 }, bankTransactionCount: 1, paymentCount: 0 });
    const india = row(summary, 'india')!;
    expect(india.status).toBe('below_threshold');
    expect(india.boxes).toEqual({});
    expect(india.excluded).toEqual({ cardOrNetwork: 5000, creditCardAccount: 1900, payroll: 2000, omittedBox: 0 });
  });

  it('flags vendors that need a TIN, with the backup withholding shown in box 4', async () => {
    const summary = await summarize1099(db, fx.entityId, 2025);
    const golf = row(summary, 'golf')!;
    expect(golf.status).toBe('needs_tin');
    expect(golf.boxes).toEqual({ nec_1: 3000, nec_4: 720 });
    expect(golf.hasTin).toBe(false);
    expect(summary.warnings.join('\n')).toContain('Golf No TIN needs a TIN');
  });

  it('points out an unflagged vendor paid over the threshold', async () => {
    const summary = await summarize1099(db, fx.entityId, 2025);
    const foxtrot = row(summary, 'foxtrot')!;
    expect(foxtrot).toMatchObject({ status: 'not_1099_vendor', aboveThreshold: true });
    expect(summary.warnings.join('\n')).toContain('Foxtrot Unflagged was paid $4,000.00');
  });

  it('summarizes the year', async () => {
    const summary = await summarize1099(db, fx.entityId, 2025);
    expect(summary.summary).toMatchObject({ included: 5, excluded_corporation: 1, needs_tin: 1, not_1099_vendor: 1 });
    expect(summary.thresholds).toMatchObject({ published: true, general: 600, royalty: 10, fixed600: 600 });
    expect(summary.totals).toEqual({ nec: 4000 + 1500 + 8000 + 700 + 3000, misc: 24000, withheld: 720 });
    expect(summary.deadlines.nec.recipient).toBe('2026-02-02');
  });
});

describe('tax year 2026 ($2,000 threshold)', () => {
  it('checks the same kind of payments against $2,000', async () => {
    const summary = await summarize1099(db, fx.entityId, 2026);
    expect(summary.thresholds).toMatchObject({ published: true, general: 2000 });
    // Bravo's $1,500 was reported for 2025 and is below the new threshold.
    expect(row(summary, 'bravo')).toMatchObject({ status: 'below_threshold', boxes: {} });
    expect(row(summary, 'bravo')!.reasons.join(' ')).toContain('$2,000.00 threshold for 2026');
    // $1,999.99 is below, exactly $2,000 is reported ("$2,000 or more").
    expect(row(summary, 'delta')).toMatchObject({ status: 'below_threshold' });
    expect(row(summary, 'hotel')).toMatchObject({ status: 'included', boxes: { nec_1: 2000 } });
    expect(row(summary, 'alpha')).toMatchObject({ status: 'included', boxes: { nec_1: 2500 } });
    // Nothing from 2025 leaks into 2026.
    expect(row(summary, 'echo')).toBeUndefined();
    expect(row(summary, 'golf')).toBeUndefined();
  });

  it('carries the amounts forward for a year the IRS has not indexed yet', async () => {
    const summary = await summarize1099(db, fx.entityId, 2027);
    expect(summary.thresholds.published).toBe(false);
    expect(summary.thresholds.general).toBe(2000);
    expect(summary.vendors).toEqual([]);
  });
});

describe('drill-down and Form 945', () => {
  it('shows the documents behind a vendor total', async () => {
    const detail = await vendorDrillDown(db, fx.entityId, 2025, fx.parties.alpha!);
    expect(detail).not.toBeNull();
    expect(detail!.contributions).toHaveLength(1);
    expect(detail!.contributions[0]).toMatchObject({
      box: 'nec_1',
      amount: 4000,
      boxSource: 'account',
      payment: { date: '2025-03-15', method: 'check', checkNumber: '1001', amount: 5000 },
      bill: { number: 'ALPHA-1', issueDate: '2025-03-01' },
      billLine: { description: 'Design work', account: { code: '6030' } },
    });
    const reasons = detail!.exclusions.map((e) => e.reason).sort();
    expect(reasons).toEqual(['card_or_network_method', 'omitted_box']);
    expect(detail!.exclusions.find((e) => e.reason === 'omitted_box')?.billLine).toMatchObject({ description: 'Reimbursed travel' });

    const hotel = await vendorDrillDown(db, fx.entityId, 2025, fx.parties.hotel!);
    expect(hotel!.contributions[0]).toMatchObject({ box: 'nec_1', amount: 700, boxSource: 'account', bankTransaction: { amount: 700, description: 'Cash app payment' } });

    expect(await vendorDrillDown(db, fx.entityId, 2025, 'pty_missing')).toBeNull();
  });

  it('computes Form 945 from the withheld amounts', async () => {
    const result = await backupWithholdingFor945(db, fx.entityId, 2025);
    expect(result.backupWithholding).toBe(720);
    expect(result.totalTaxes).toBe(720);
    expect(result.months[9]).toMatchObject({ month: 10, amount: 720 });
    expect(result.byVendor).toEqual([expect.objectContaining({ partyId: fx.parties.golf, amount: 720, name: 'Golf No TIN' })]);
    expect(result.dueDate).toBe('2026-02-02');
    const none = await backupWithholdingFor945(db, fx.entityId, 2026);
    expect(none.backupWithholding).toBe(0);
  });

  it('limits the loader to the vendors asked for', async () => {
    const computed = await compute1099ForEntity(db, fx.entityId, 2025, { partyIds: [fx.parties.bravo!] });
    expect(computed.result.vendors.map((v) => v.partyId)).toEqual([fx.parties.bravo]);
    expect(buildSummary(computed).vendors).toHaveLength(1);
  });
});
