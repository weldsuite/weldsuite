/**
 * Sales Tax Center end to end (pglite): periods and due dates, worksheet from
 * tax-ledger rows (several jurisdictions per line, an exempt resale with a
 * certificate, a marketplace sale, an exempt sale past its cure date, use
 * tax), vendor discount proposal, pre-file and liability checks, filing that
 * stamps the rows, changes to a filed period (carry forward, amend), payment
 * posting, and cash-basis reporting.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { taxReturnsRoutes } from './index';
import {
  addAgency,
  addPayment,
  callRoute,
  createUsFixture,
  postSale,
  postUseTax,
  texasRows,
  type UsFixture,
} from '../../services/sales-tax-returns/test-fixtures';
import { postJournalEntry } from '../../services/accounting-posting';

let db: Database;
let f: UsFixture;

const returns = (path: string, opts: Parameters<typeof callRoute>[4] = {}) =>
  callRoute(db, '/api/tax-returns', taxReturnsRoutes, `/api/tax-returns${path}`, { entityId: f.entityId, ...opts });

async function balance(accountId: string) {
  const rows = await db
    .select({ debit: schema.journalLines.debit, credit: schema.journalLines.credit })
    .from(schema.journalLines)
    .where(eq(schema.journalLines.accountId, accountId));
  return Math.round(rows.reduce((sum, r) => sum + Number(r.credit) - Number(r.debit), 0) * 100) / 100;
}

async function entryLines(journalEntryId: string) {
  const rows = await db
    .select({ code: schema.accounts.code, debit: schema.journalLines.debit, credit: schema.journalLines.credit })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(eq(schema.journalLines.journalEntryId, journalEntryId));
  return rows
    .map((r) => ({ code: r.code, debit: Number(r.debit), credit: Number(r.credit) }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.debit - b.debit);
}

async function stampedCount(returnId: string) {
  const rows = await db.select({ id: schema.taxLines.id }).from(schema.taxLines).where(eq(schema.taxLines.taxReturnId, returnId));
  return rows.length;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T15:00:00Z'));
  db = (await createPgliteDb()).db;
  f = await createUsFixture(db);

  await addAgency(f, { id: 'agy_tx', stateCode: 'TX', name: 'Texas Comptroller', firstPeriodStart: '2026-07-01' });
  // A monthly agency that has not filed for months.
  await addAgency(f, { id: 'agy_wa', stateCode: 'WA', name: 'Washington DOR', filingFrequency: 'monthly', firstPeriodStart: '2026-06-01', dueDay: 25 });

  await db.insert(schema.exemptionCertificates).values({
    id: 'cert_resale',
    entityId: f.entityId,
    partyId: 'pty_reseller',
    states: ['TX'],
    reason: 'resale',
    certificateNumber: 'R-123',
    form: 'state_form',
    issuedOn: '2026-01-02',
    expiresOn: null,
  });

  // --- Texas, third quarter 2026 -----------------------------------------
  await postSale(f, {
    id: 'inv_1', number: 'INV-1', date: '2026-07-10', agencyId: 'agy_tx', stateCode: 'TX',
    lines: [{ id: 'inv_1_l1', gross: 1000, taxable: 1000, rows: texasRows(1000) }],
  });
  await postSale(f, {
    id: 'inv_2', number: 'INV-2', date: '2026-08-15', agencyId: 'agy_tx', stateCode: 'TX', contactName: 'Reseller Co',
    lines: [{
      id: 'inv_2_l1', gross: 500, taxable: 0, exempt: 500, exemptReason: 'resale', certificateId: 'cert_resale',
      rows: texasRows(0),
    }],
  });
  await postSale(f, {
    id: 'inv_3', number: 'INV-3', date: '2026-09-01', agencyId: 'agy_tx', stateCode: 'TX', marketplace: true,
    lines: [{ id: 'inv_3_l1', gross: 300, taxable: 0, rows: [{ code: 'TX-STATE', name: 'Texas', level: 'state', rate: 6.25, tax: 0 }] }],
  });
  await postSale(f, {
    id: 'inv_4', number: 'INV-4', date: '2026-09-12', agencyId: 'agy_tx', stateCode: 'TX',
    lines: [{ id: 'inv_4_l1', gross: 200, taxable: 120, nonTaxable: 80, taxCode: 'shipping', rows: texasRows(120) }],
  });
  // Exempt as resale but no certificate on file, and its 90 days have run out: counted as taxable.
  await postSale(f, {
    id: 'inv_5', number: 'INV-5', date: '2026-07-05', agencyId: 'agy_tx', stateCode: 'TX', contactName: 'No Certificate Ltd',
    lines: [{ id: 'inv_5_l1', gross: 100, taxable: 0, exempt: 100, exemptReason: 'resale', rows: texasRows(0) }],
  });
  await postUseTax(f, {
    id: 'bill_1', number: 'BILL-1', date: '2026-09-10', agencyId: 'agy_tx', stateCode: 'TX', taxable: 200,
    rows: [{ code: 'TX-STATE', name: 'Texas', level: 'state', rate: 6.25, tax: 12.5 }],
  });
  // A credit memo in the next period.
  await postSale(f, {
    id: 'cm_1', number: 'CM-1', date: '2026-10-02', agencyId: 'agy_tx', stateCode: 'TX', creditNoteFor: 'inv_1',
    lines: [{ id: 'cm_1_l1', gross: 100, taxable: 100, rows: texasRows(100) }],
  });
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
});

describe('periods and due dates', () => {
  it('lists each agency\'s periods with due dates, return status and overdue flags', async () => {
    const res = await returns('/periods?from=2026-06-01&to=2026-09-30');
    expect(res.status).toBe(200);
    const agencies = res.data.agencies as Array<{ agencyId: string; periods: Array<Record<string, any>> }>;
    const tx = agencies.find((a) => a.agencyId === 'agy_tx')!;
    expect(tx.periods).toHaveLength(1);
    expect(tx.periods[0]).toMatchObject({
      periodStart: '2026-07-01',
      periodEnd: '2026-09-30',
      dueDate: '2026-10-20',
      key: 'sales_tax:agy_tx:2026-09-30',
      return: null,
      unfiled: true,
      overdue: false,
      state: 'due',
      daysUntilDue: 12,
    });

    const wa = agencies.find((a) => a.agencyId === 'agy_wa')!;
    expect(wa.periods.map((p) => p.periodEnd)).toEqual(['2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']);
    expect(wa.periods.map((p) => p.overdue)).toEqual([true, true, true, false]);
    // 25 July 2026 is a Saturday, so the June return is due on Monday.
    expect(wa.periods[0].dueDate).toBe('2026-07-27');
  });

  it('gives one line per registered agency with the next due period and an estimate', async () => {
    const res = await returns('/overview');
    expect(res.status).toBe(200);
    const agencies = res.data.agencies as Array<Record<string, any>>;
    const tx = agencies.find((a) => a.agencyId === 'agy_tx')!;
    expect(tx.nextPeriod).toMatchObject({ periodEnd: '2026-09-30', dueDate: '2026-10-20', overdue: false, returnId: null });
    // 92.40 sales tax + 8.25 on the uncertified exempt sale + 12.50 use tax
    expect(tx.nextPeriod.estimatedSalesTax).toBe(100.65);
    expect(tx.nextPeriod.estimatedUseTax).toBe(12.5);
    expect(tx.nextPeriod.estimatedTaxDue).toBe(113.15);
    expect(tx.lastFiled).toBeNull();

    const wa = agencies.find((a) => a.agencyId === 'agy_wa')!;
    expect(wa.overduePeriods).toBe(3);
    expect(wa.nextPeriod).toMatchObject({ periodEnd: '2026-06-30', overdue: true, estimatedTaxDue: 0 });
    expect(res.data.totals.overduePeriods).toBe(3);
  });
});

describe('sales tax return lifecycle (Texas, accrual)', () => {
  let txReturn: string;

  it('opens the next period of the agency, once', async () => {
    const created = await returns('', { method: 'POST', body: { agencyId: 'agy_tx' } });
    expect(created.status).toBe(201);
    txReturn = created.data.id;
    expect(created.data).toMatchObject({
      status: 'open',
      agencyId: 'agy_tx',
      stateCode: 'TX',
      periodStart: '2026-07-01',
      periodEnd: '2026-09-30',
      dueDate: '2026-10-20',
      reportingBasis: 'accrual',
      totalDue: 0,
    });

    const again = await returns('', { method: 'POST', body: { agencyId: 'agy_tx', periodStart: '2026-07-01', periodEnd: '2026-09-30' } });
    expect(again.status).toBe(409);
    const offGrid = await returns('', { method: 'POST', body: { agencyId: 'agy_tx', periodStart: '2026-07-01', periodEnd: '2026-08-31' } });
    expect(offGrid.status).toBe(400);
  });

  it('builds the worksheet from the tax ledger and proposes the vendor discount', async () => {
    const res = await returns(`/${txReturn}/calculate`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('calculated');

    const s = res.data.summary;
    expect(s).toMatchObject({
      reportingBasis: 'accrual',
      grossSales: 2100,
      totalDeductions: 880,
      taxableSales: 1220,
      salesTaxDue: 100.65,
      useTaxDue: 12.5,
      totalTaxDue: 113.15,
      salesTaxPayable: 100.65,
      useTaxPayable: 12.5,
      uncuredTaxPayable: 8.25,
    });
    expect(s.deductions).toMatchObject({ resale: 500, marketplace: 300, exempt_freight: 80, returns: 0 });
    expect(s.uncuredExempt).toEqual({ sales: 100, tax: 8.25, lines: 1 });
    expect(s.warnings.join(' ')).toContain('90-day cure');

    // tax by location: state, city and district rows add up to the sales tax
    const sales = (res.data.lines as Array<Record<string, any>>).filter((l) => l.kind === 'sales');
    const byCode = Object.fromEntries(sales.map((l) => [l.jurisdictionCode, l]));
    expect(byCode['TX-STATE']).toMatchObject({ rate: 6.25, reportingCode: 'TX', taxableSales: 1220, tax: 76.25 });
    expect(byCode['TX-CITY-AUSTIN'].tax).toBe(12.2);
    expect(byCode['TX-TRANSIT'].tax).toBe(12.2);
    expect(res.data.lines.filter((l: Record<string, any>) => l.kind === 'use')).toHaveLength(1);

    // 0.5% of the 92.40 collected; the discount only holds when filed on time
    expect(s.vendorDiscount).toMatchObject({ available: true, amount: 0.46, late: false, requiresTimelyFilingBy: '2026-10-20' });
    expect(res.data.adjustments).toEqual([
      expect.objectContaining({ type: 'vendor_discount', amount: -0.46, auto: true }),
    ]);
    expect(res.data.totalDue).toBe(112.69);
  });

  it('shows the documents behind the return with jurisdiction rows and certificates', async () => {
    const res = await returns(`/${txReturn}/documents`);
    expect(res.status).toBe(200);
    const docs = res.list;
    expect(docs.map((d) => d.document.number)).toEqual(['INV-5', 'INV-1', 'INV-2', 'INV-3', 'BILL-1', 'INV-4']);
    const inv1 = docs.find((d) => d.document.number === 'INV-1')!;
    expect(inv1).toMatchObject({ grossSales: 1000, taxableSales: 1000, tax: 82.5, useTax: 0 });
    expect(inv1.rows).toHaveLength(3);
    expect(inv1.rows.map((r: Record<string, any>) => r.jurisdictionName)).toEqual(['Texas', 'Austin', 'Capital Metro']);
    const inv2 = docs.find((d) => d.document.number === 'INV-2')!;
    expect(inv2).toMatchObject({ exemptSales: 500, tax: 0 });
    expect(inv2.certificates).toEqual([expect.objectContaining({ id: 'cert_resale', certificateNumber: 'R-123', reason: 'resale' })]);
    expect(docs.find((d) => d.document.number === 'BILL-1')).toMatchObject({ useTax: 12.5, tax: 0 });
  });

  it('edits adjustments (and drops back from review), exports the worksheet as CSV', async () => {
    const adjustments = [
      { type: 'vendor_discount', amount: -0.46, note: 'timely filing', auto: true },
      { type: 'rounding', amount: 0.02 },
    ];
    const patched = await returns(`/${txReturn}`, { method: 'PATCH', body: { adjustments, notes: 'Q3 2026' } });
    expect(patched.status).toBe(200);
    expect(patched.data.totalDue).toBe(112.71);

    expect((await returns(`/${txReturn}/review`, { method: 'POST' })).data.status).toBe('reviewed');
    const edited = await returns(`/${txReturn}`, { method: 'PATCH', body: { notes: 'reviewed by accountant' } });
    expect(edited.data.status).toBe('reviewed');
    const adjustedAgain = await returns(`/${txReturn}`, { method: 'PATCH', body: { adjustments } });
    expect(adjustedAgain.data.status).toBe('calculated');
    expect((await returns(`/${txReturn}/review`, { method: 'POST' })).data.status).toBe('reviewed');

    const csv = await returns(`/${txReturn}/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Sales tax return worksheet');
    expect(csv.text).toContain('Gross sales,2100.00');
    expect(csv.text).toContain('Less: Sales for resale,500.00');
    expect(csv.text).toContain('Taxable sales,1220.00');
    expect(csv.text).toContain('Sales tax due,100.65');
    expect(csv.text).toContain('counted as taxable",100.00');
    expect(csv.text).toContain('Vendor discount,-0.46,timely filing');
    expect(csv.text).toContain('Total due,112.71');
  });

  it('the liability check ties the payable accounts to the unfiled tax before filing', async () => {
    const res = await returns(`/${txReturn}/liability-check`);
    expect(res.status).toBe(200);
    // 82.50 + 9.90 sales tax + 12.50 use tax - 8.25 credit memo
    expect(res.data).toMatchObject({ glBalance: 96.65, unfiledTax: 96.65, filedUnpaidTax: 0, expectedBalance: 96.65, difference: 0, sharedAccount: false });
    expect(res.data.items).toEqual([]);
  });

  it('refuses to file an open or foreign return and stamps the counted rows when filing', async () => {
    const open = await returns('', { method: 'POST', body: { agencyId: 'agy_wa', periodStart: '2026-08-01', periodEnd: '2026-08-31' } });
    expect((await returns(`/${open.data.id}/file`, { method: 'POST', body: { confirmationNumber: 'X' } })).status).toBe(400);
    await returns(`/${open.data.id}`, { method: 'DELETE' });

    const noConfirmation = await returns(`/${txReturn}/file`, { method: 'POST', body: {} });
    expect(noConfirmation.status).toBe(400);

    const filed = await returns(`/${txReturn}/file`, { method: 'POST', body: { confirmationNumber: 'TX-0001' } });
    expect(filed.status).toBe(200);
    expect(filed.data).toMatchObject({ status: 'filed', confirmationNumber: 'TX-0001' });
    expect(filed.data.warnings).toEqual([]);

    // every Q3 row is stamped; the October credit memo is not
    const rows = await db.select().from(schema.taxLines).where(eq(schema.taxLines.agencyId, 'agy_tx'));
    const stamped = rows.filter((r) => r.taxReturnId === txReturn);
    const open2 = rows.filter((r) => r.taxReturnId === null);
    expect(stamped.length).toBe(rows.length - 3);
    expect(new Set(open2.map((r) => r.sourceId))).toEqual(new Set(['cm_1']));
    expect(await stampedCount(txReturn)).toBe(stamped.length);

    // the entity-wide tax lock date is not moved by a US agency return
    const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, f.entityId));
    expect(entity!.taxLockDate).toBeNull();

    const twice = await returns(`/${txReturn}/file`, { method: 'POST', body: { confirmationNumber: 'TX-0001' } });
    expect(twice.status).toBe(409);
    const edit = await returns(`/${txReturn}`, { method: 'PATCH', body: { adjustments: [] } });
    expect(edit.status).toBe(409);
    expect((await returns(`/${txReturn}`, { method: 'DELETE' })).status).toBe(409);
  });

  it('the filed return keeps its worksheet while the liability check sees it as owed', async () => {
    const res = await returns(`/${txReturn}/liability-check`);
    // filed but unpaid: 100.65 - 8.25 never collected + 12.50 use tax = 104.90; the credit memo is still unfiled
    expect(res.data).toMatchObject({ glBalance: 96.65, unfiledTax: -8.25, filedUnpaidTax: 104.9, expectedBalance: 96.65, difference: 0 });
    const csv = await returns(`/${txReturn}/export`);
    expect(csv.text).toContain('Gross sales,2100.00');
  });

  it('a back-dated credit memo and invoice posted after filing show up as exceptions, not as edits', async () => {
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z'));
    await postSale(f, {
      id: 'cm_2', number: 'CM-2', date: '2026-09-15', agencyId: 'agy_tx', stateCode: 'TX', creditNoteFor: 'inv_1',
      lines: [{ id: 'cm_2_l1', gross: 50, taxable: 50, rows: texasRows(50) }],
    });
    await postSale(f, {
      id: 'inv_8', number: 'INV-8', date: '2026-09-20', agencyId: 'agy_tx', stateCode: 'TX',
      lines: [{ id: 'inv_8_l1', gross: 100, taxable: 100, rows: texasRows(100) }],
    });

    const res = await returns(`/${txReturn}/exceptions`);
    expect(res.status).toBe(200);
    expect(res.data.applicable).toBe(true);
    const items = res.data.items as Array<Record<string, any>>;
    expect(items.map((i) => i.document.number).sort()).toEqual(['CM-2', 'INV-8']);
    expect(items.find((i) => i.document.number === 'CM-2')).toMatchObject({ taxAmount: -4.13, resolution: 'open' });
    expect(items.find((i) => i.document.number === 'INV-8')).toMatchObject({ taxAmount: 8.25, resolution: 'open' });
    expect(res.data.totals.open).toEqual({ documents: 2, taxAmount: 4.12 });

    // the filed return itself did not change
    const detail = await returns(`/${txReturn}`);
    expect(detail.data.summary.salesTaxDue).toBe(100.65);
    expect(detail.data.status).toBe('filed');
  });

  it('carries one exception forward into the next return', async () => {
    const cm2Rows = await db.select({ id: schema.taxLines.id }).from(schema.taxLines).where(eq(schema.taxLines.sourceId, 'cm_2'));
    const none = await returns(`/${txReturn}/carry-forward`, { method: 'POST', body: { taxLineIds: ['txl_unknown'] } });
    expect(none.status).toBe(400);

    const res = await returns(`/${txReturn}/carry-forward`, { method: 'POST', body: { taxLineIds: cm2Rows.map((r) => r.id) } });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ carriedRows: 3, taxAmount: -4.13, recalculate: [] });
    const after = await returns(`/${txReturn}/exceptions`);
    expect(after.data.totals.carried_forward).toEqual({ documents: 1, taxAmount: -4.13 });
    expect(after.data.totals.open).toEqual({ documents: 1, taxAmount: 8.25 });
  });

  let q4: string;

  it('the next return counts the carried-forward rows with the October credit memo', async () => {
    const created = await returns('', { method: 'POST', body: { agencyId: 'agy_tx' } });
    expect(created.data).toMatchObject({ periodStart: '2026-10-01', periodEnd: '2026-12-31', dueDate: '2027-01-20' });
    q4 = created.data.id;
    const res = await returns(`/${q4}/calculate`, { method: 'POST' });
    // credit memos are returns and allowances, 100 + 50; tax -8.25 - 4.13
    expect(res.data.summary).toMatchObject({ grossSales: 0, salesTaxDue: -12.38, totalTaxDue: -12.38, taxableSales: -150 });
    expect(res.data.summary.deductions.returns).toBe(150);
    expect(res.data.summary.carriedForward).toMatchObject({ rowCount: 3, taxAmount: -4.13 });
    expect(res.data.summary.warnings.join(' ')).toContain('credit');
    expect(res.data.summary.vendorDiscount.amount).toBe(0);
    expect(res.data.adjustments).toEqual([]);
  });

  it('records the payment: a balanced entry, the payable cleared, the difference needs a reason', async () => {
    const wrongBank = await returns(`/${txReturn}/payment`, { method: 'POST', body: { bankAccountId: 'bnk_unknown', amount: 112.71, date: '2026-10-09' } });
    expect(wrongBank.status).toBe(404);
    const mismatch = await returns(`/${txReturn}/payment`, {
      method: 'POST', body: { bankAccountId: f.bankAccountId, amount: 100, date: '2026-10-09' },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.error?.message).toContain('reason');
    expect(mismatch.error?.details).toMatchObject({ totalDue: 112.71, amount: 100 });

    const paid = await returns(`/${txReturn}/payment`, {
      method: 'POST', body: { bankAccountId: f.bankAccountId, amount: 112.71, date: '2026-10-09', reference: 'EFT 7781' },
    });
    expect(paid.status).toBe(200);
    expect(paid.data).toMatchObject({ status: 'paid', paymentAmount: 112.71 });
    const entryId = paid.data.payment.journalEntryId as string;
    const [row] = await db.select().from(schema.taxReturns).where(eq(schema.taxReturns.id, txReturn));
    expect(row).toMatchObject({ status: 'paid', paymentBankAccountId: f.bankAccountId, paymentJournalEntryId: entryId });

    const lines = await entryLines(entryId);
    // sales tax payable 92.40 + use tax payable 12.50 + tax expense 8.25 + rounding 0.02 = bank 112.71 + vendor discount 0.46
    expect(lines).toEqual([
      { code: '1000', debit: 0, credit: 112.71 },
      { code: '23TX', debit: 12.5, credit: 0 },
      { code: '22TX', debit: 92.4, credit: 0 },
      { code: '4110', debit: 0, credit: 0.46 },
      { code: '7040', debit: 8.25, credit: 0 },
      { code: '7110', debit: 0.02, credit: 0 },
    ].sort((a, b) => a.code.localeCompare(b.code) || a.debit - b.debit));
    const [entry] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, entryId));
    expect(entry).toMatchObject({ sourceType: 'tax_return', sourceId: txReturn, postingKey: `tax_return:${txReturn}:payment` });
    expect(Number(entry!.totalDebit)).toBe(Number(entry!.totalCredit));

    const twice = await returns(`/${txReturn}/payment`, {
      method: 'POST', body: { bankAccountId: f.bankAccountId, amount: 112.71, date: '2026-10-09' },
    });
    expect(twice.status).toBe(409);
  });

  it('after the payment the liability check is clean', async () => {
    const res = await returns(`/${txReturn}/liability-check`);
    // what is left on the payable: CM-1 and the two late documents are not on any return yet
    expect(res.data).toMatchObject({ filedUnpaidTax: 0, difference: 0 });
    expect(res.data.glBalance).toBe(res.data.expectedBalance);
    expect(res.data.items).toEqual([]);
  });

  it('amends the filed period: the exceptions move into a new return that pays the difference', async () => {
    const res = await returns(`/${txReturn}/amend`, { method: 'POST' });
    expect(res.status).toBe(201);
    const amendment = res.data;
    expect(amendment).toMatchObject({
      status: 'calculated',
      amendsReturnId: txReturn,
      periodStart: '2026-07-01',
      periodEnd: '2026-09-30',
      exceptionRows: 6,
    });
    // full-period figures, payable is the increase: +8.25 (INV-8) and -4.13 (CM-2) on 100.65
    expect(amendment.summary).toMatchObject({
      grossSales: 2200,
      salesTaxDue: 104.77,
      salesTaxPayable: 4.12,
      useTaxPayable: 0,
      previouslyReported: { returnId: txReturn, salesTaxDue: 100.65, useTaxDue: 12.5 },
    });
    expect(amendment.totalDue).toBe(4.12);
    expect(amendment.adjustments).toEqual([]);

    // a second amendment of the same return is refused
    expect((await returns(`/${txReturn}/amend`, { method: 'POST' })).status).toBe(409);

    // both exceptions are now resolved by the amendment, including the carried-forward credit memo
    const exceptions = await returns(`/${txReturn}/exceptions`);
    expect(exceptions.data.totals).toMatchObject({ open: { documents: 0 }, carried_forward: { documents: 0 }, amended: { documents: 2, taxAmount: 4.12 } });
    expect(exceptions.data.items.every((i: Record<string, any>) => i.amendedByReturnId === amendment.id)).toBe(true);

    // the next return no longer picks the credit memo up
    const q4calc = await returns(`/${q4}/calculate`, { method: 'POST' });
    expect(q4calc.data.summary.salesTaxDue).toBe(-8.25);
    expect(q4calc.data.summary.carriedForward).toBeUndefined();

    // file and pay the amendment: its rows are stamped with its own id, the original keeps its own
    const filed = await returns(`/${amendment.id}/file`, { method: 'POST', body: { confirmationNumber: 'TX-0001-A' } });
    expect(filed.status).toBe(200);
    expect(await stampedCount(amendment.id)).toBe(6);
    const paid = await returns(`/${amendment.id}/payment`, {
      method: 'POST', body: { bankAccountId: f.bankAccountId, amount: 4.12, date: '2026-10-09' },
    });
    expect(paid.status).toBe(200);
    expect(await entryLines(paid.data.payment.journalEntryId)).toEqual([
      { code: '1000', debit: 0, credit: 4.12 },
      { code: '22TX', debit: 4.12, credit: 0 },
    ]);

    const check = await returns(`/${amendment.id}/liability-check`);
    // only the October credit memo is left on the payable
    expect(check.data).toMatchObject({ glBalance: -8.25, unfiledTax: -8.25, filedUnpaidTax: 0, difference: 0 });
  });

  it('refuses to delete a filed return and to amend one that is not filed', async () => {
    expect((await returns(`/${q4}/amend`, { method: 'POST' })).status).toBe(400);
    const del = await returns(`/${q4}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    const list = await returns('?agencyId=agy_tx');
    expect(list.status).toBe(200);
    expect(list.list.map((r) => r.status).sort()).toEqual(['paid', 'paid']);
  });
});

describe('pre-file check', () => {
  it('finds income with no tax data, invoices with no state and direct entries on the payable', async () => {
    await postSale(f, {
      id: 'inv_wa1', number: 'INV-WA1', date: '2026-08-10', agencyId: 'agy_wa', stateCode: 'WA',
      lines: [{ id: 'inv_wa1_l1', gross: 400, taxable: 400, rows: [{ code: 'WA-STATE', name: 'Washington', level: 'state', rate: 6.5, tax: 26 }] }],
    });
    // shipped to Washington, posted without tax data
    await postSale(f, {
      id: 'inv_wa2', number: 'INV-WA2', date: '2026-08-12', agencyId: null, stateCode: 'WA', noTaxRows: true,
      lines: [{ id: 'inv_wa2_l1', gross: 250, taxable: 250, rows: [] }],
    });
    // no ship-to or bill-to state at all
    await postSale(f, {
      id: 'inv_nostate', number: 'INV-NS', date: '2026-08-14', agencyId: null, stateCode: 'WA', shipToState: '', noTaxRows: true,
      lines: [{ id: 'inv_ns_l1', gross: 90, taxable: 90, rows: [] }],
    });
    // a manual entry on the agency's payable
    const waAgency = (await db.select().from(schema.salesTaxAgencies).where(eq(schema.salesTaxAgencies.id, 'agy_wa')))[0]!;
    await postJournalEntry(db, {
      entityId: f.entityId, date: new Date('2026-08-20T00:00:00Z'), description: 'Manual accrual', sourceType: 'manual', lockKind: 'general',
      lines: [
        { accountId: f.accountId['1000'], debit: 75 },
        { accountId: waAgency.liabilityAccountId!, credit: 75 },
      ],
    });

    const created = await returns('', { method: 'POST', body: { agencyId: 'agy_wa', periodStart: '2026-08-01', periodEnd: '2026-08-31' } });
    expect(created.status).toBe(201);
    await returns(`/${created.data.id}/calculate`, { method: 'POST' });

    const res = await returns(`/${created.data.id}/pre-file-check`);
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(false);
    expect(res.data.comparison).toEqual({ returnNetSales: 400, incomeShippedToState: 650, difference: 250 });
    const byCode = Object.fromEntries((res.data.findings as Array<Record<string, any>>).map((x) => [x.code, x]));

    expect(byCode.net_sales_difference.documents).toEqual([
      expect.objectContaining({ documentId: 'inv_wa2', number: 'INV-WA2', amount: 250, returnAmount: 0 }),
    ]);
    expect(byCode.income_without_tax_data.documents.map((d: Record<string, any>) => d.documentId).sort()).toEqual(['inv_nostate', 'inv_wa2']);
    expect(byCode.missing_ship_to.documents).toEqual([expect.objectContaining({ documentId: 'inv_nostate', number: 'INV-NS' })]);
    expect(byCode.payable_direct_entries.documents).toEqual([expect.objectContaining({ amount: 75, reason: 'Manual accrual' })]);

    // the liability check names the same entry as the difference
    const liability = await returns(`/${created.data.id}/liability-check`);
    expect(liability.data.difference).toBe(75);
    expect(liability.data.items).toEqual([expect.objectContaining({ description: 'Manual accrual', glAmount: 75, expectedAmount: 0, difference: 75 })]);
  });
});

describe('cash-basis agency (Georgia)', () => {
  it('reports an invoice in the periods its payments are dated, in proportion', async () => {
    await addAgency(f, {
      id: 'agy_ga', stateCode: 'GA', name: 'Georgia DOR', filingFrequency: 'monthly', firstPeriodStart: '2026-08-01',
      dueDay: 20, reportingBasis: 'cash',
    });
    const ga = (n: number) => [{ code: 'GA-STATE', name: 'Georgia', level: 'state' as const, rate: 4, tax: n }];
    await postSale(f, {
      id: 'inv_g1', number: 'INV-G1', date: '2026-08-05', agencyId: 'agy_ga', stateCode: 'GA',
      lines: [{ id: 'inv_g1_l1', gross: 1000, taxable: 1000, rows: ga(40) }],
    });
    // never paid
    await postSale(f, {
      id: 'inv_g2', number: 'INV-G2', date: '2026-08-12', agencyId: 'agy_ga', stateCode: 'GA',
      lines: [{ id: 'inv_g2_l1', gross: 200, taxable: 200, rows: ga(8) }],
    });
    await addPayment(f, { id: 'pay_g1', invoiceId: 'inv_g1', amount: 520, date: '2026-08-20' });
    await addPayment(f, { id: 'pay_g2', invoiceId: 'inv_g1', amount: 520, date: '2026-09-10' });
    // a credit memo of the paid invoice counts, one of the unpaid invoice never does
    await postSale(f, {
      id: 'cm_g1', number: 'CM-G1', date: '2026-09-15', agencyId: 'agy_ga', stateCode: 'GA', creditNoteFor: 'inv_g1',
      lines: [{ id: 'cm_g1_l1', gross: 100, taxable: 100, rows: ga(4) }],
    });
    await postSale(f, {
      id: 'cm_g2', number: 'CM-G2', date: '2026-09-20', agencyId: 'agy_ga', stateCode: 'GA', creditNoteFor: 'inv_g2',
      lines: [{ id: 'cm_g2_l1', gross: 200, taxable: 200, rows: ga(8) }],
    });

    const aug = await returns('', { method: 'POST', body: { agencyId: 'agy_ga', periodStart: '2026-08-01', periodEnd: '2026-08-31' } });
    expect(aug.status).toBe(201);
    const augCalc = await returns(`/${aug.data.id}/calculate`, { method: 'POST' });
    expect(augCalc.data.summary).toMatchObject({ reportingBasis: 'cash', grossSales: 500, taxableSales: 500, salesTaxDue: 20 });
    expect(augCalc.data.summary.method).toContain('Cash basis');
    // The August return was due on 21 September: too late for the discount, which is not proposed.
    expect(augCalc.data.summary.vendorDiscount).toMatchObject({ available: true, late: true, amount: 0.6 });
    expect(augCalc.data.adjustments).toEqual([]);

    const augFile = await returns(`/${aug.data.id}/file`, { method: 'POST', body: { confirmationNumber: 'GA-AUG' } });
    expect(augFile.status).toBe(200);
    expect(augFile.data.warnings.map((w: Record<string, any>) => w.code)).toEqual(['late_filing']);
    // half paid: nothing is stamped, the invoice is still open for September
    expect(await stampedCount(aug.data.id)).toBe(0);

    const sep = await returns('', { method: 'POST', body: { agencyId: 'agy_ga', periodStart: '2026-09-01', periodEnd: '2026-09-30' } });
    const sepCalc = await returns(`/${sep.data.id}/calculate`, { method: 'POST' });
    expect(sepCalc.data.summary).toMatchObject({ grossSales: 500, salesTaxDue: 16, taxableSales: 400 });
    expect(sepCalc.data.summary.deductions.returns).toBe(100);
    // Georgia: 3% of the first $3,000 of tax, and September is not late
    expect(sepCalc.data.adjustments).toEqual([expect.objectContaining({ type: 'vendor_discount', amount: -0.48, auto: true })]);
    expect(sepCalc.data.totalDue).toBe(15.52);

    const sepFile = await returns(`/${sep.data.id}/file`, { method: 'POST', body: { confirmationNumber: 'GA-SEP' } });
    expect(sepFile.status).toBe(200);
    // fully paid by September: its rows and the credit memo are stamped; the unpaid invoice is not
    const rows = await db.select().from(schema.taxLines).where(and(eq(schema.taxLines.agencyId, 'agy_ga'), isNull(schema.taxLines.taxReturnId)));
    expect([...new Set(rows.map((r) => r.sourceId))].sort()).toEqual(['cm_g2', 'inv_g2']);

    // the filed return's documents are still the shares it counted
    const docs = await returns(`/${aug.data.id}/documents`);
    expect(docs.list).toHaveLength(1);
    expect(docs.list[0]).toMatchObject({ grossSales: 500, tax: 20 });
    expect(docs.list[0].rows[0].share).toBe(0.5);
  });
});
