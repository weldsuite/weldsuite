import { describe, expect, it } from 'vitest';
import type { Entity } from '@weldsuite/db/schema';
import { createManualEngine } from '../../sales-tax/manual-engine';
import {
  breakdownToTaxLineFields,
  reverseResultForCreditMemo,
  salesTaxResultToBreakdown,
  type SalesTaxLineFields,
} from '../../sales-tax/to-tax-lines';
import {
  addr,
  buildManualData,
  certificate,
  line,
  request,
} from '../../sales-tax/test-fixtures';
import type { TaxReturnLine } from '../types';
import {
  buildUsSalesTaxReturn,
  buildUsSalesTaxWorksheet,
  type SalesTaxWorksheetLine,
  type SalesTaxWorksheetOptions,
} from './sales-tax-return';

const NOW = () => new Date('2026-03-15T12:00:00.000Z');

/** A tax_lines row as the return builder reads it. */
function ledger(
  fields: SalesTaxLineFields[],
  meta: { sourceType: string; sourceId: string; taxDate: string; sign?: 1 | -1 },
): SalesTaxWorksheetLine[] {
  return fields.map((f) => ({
    taxRateId: '',
    taxCategoryCode: '',
    taxableAmount: Number(f.taxableAmount),
    taxAmount: Number(f.taxAmount),
    direction: f.direction === 'use' ? 'purchase' : 'sales',
    kind: f.direction === 'use' ? 'use' : 'sales',
    agencyId: f.agencyId,
    stateCode: f.stateCode,
    jurisdictionCode: f.jurisdictionCode,
    jurisdictionName: f.jurisdictionName,
    jurisdictionLevel: f.jurisdictionLevel,
    reportingCode: f.reportingCode,
    rate: Number(f.rate),
    grossAmount: Number(f.grossAmount),
    exemptAmount: Number(f.exemptAmount),
    nonTaxableAmount: Number(f.nonTaxableAmount),
    exemptReason: f.exemptReason,
    certificateId: f.certificateId,
    taxCode: f.taxCode,
    shipToState: f.shipToState,
    marketplaceFacilitated: f.marketplaceFacilitated ?? false,
    sourceType: meta.sourceType,
    sourceId: meta.sourceId,
    sourceLineId: f.sourceLineId,
    taxDate: meta.taxDate,
  }));
}

async function invoiceRows(
  sourceId: string,
  taxDate: string,
  extra: Parameters<typeof request>[0] = {},
): Promise<SalesTaxWorksheetLine[]> {
  const req = request({ documentId: sourceId, documentDate: taxDate, ...extra });
  const result = await createManualEngine(buildManualData(), { now: NOW }).calculate(req);
  const breakdown = salesTaxResultToBreakdown(result, {
    lines: req.lines.map((l) => ({ lineId: l.lineId, taxCode: l.taxCode })),
    registrations: req.registrations,
    marketplaceFacilitated: req.marketplaceFacilitated,
    documentDate: taxDate,
  });
  return ledger(
    breakdownToTaxLineFields(breakdown, {
      shipToState: result.shipToState,
      shipToPostalCode: result.shipToPostalCode,
      engine: result.engine,
      marketplaceFacilitated: req.marketplaceFacilitated,
    }),
    { sourceType: 'invoice', sourceId, taxDate },
  );
}

const options = (extra: Partial<SalesTaxWorksheetOptions> = {}): SalesTaxWorksheetOptions => ({
  agencyId: 'ag_tx',
  stateCode: 'TX',
  periodStart: '2026-01-01',
  periodEnd: '2026-03-31',
  reportingBasis: 'accrual',
  ...extra,
});

describe('buildUsSalesTaxWorksheet', () => {
  it('counts a line once however many jurisdictions it was taxed by', async () => {
    const rows = await invoiceRows('inv_1', '2026-02-10', { lines: [line('l1', 100)] });
    expect(rows).toHaveLength(3);
    const ws = buildUsSalesTaxWorksheet(rows, options());
    expect(ws.grossSales).toBe(100);
    expect(ws.totalDeductions).toBe(0);
    expect(ws.taxableSales).toBe(100);
    expect(ws.salesTaxDue).toBe(7.25);
    expect(ws.totalTaxDue).toBe(7.25);
    expect(ws.documentCount).toBe(1);
  });

  it('breaks the tax out by reporting location', async () => {
    const rows = await invoiceRows('inv_1', '2026-02-10', { lines: [line('l1', 100), line('l2', 200)] });
    const ws = buildUsSalesTaxWorksheet(rows, options());
    expect(ws.byLocation).toEqual([
      { jurisdictionCode: 'tx_state', jurisdictionName: 'Texas', level: 'state', reportingCode: 'TX-0', rate: 5, taxableSales: 300, tax: 15 },
      { jurisdictionCode: 'tx_fixtown', jurisdictionName: 'Fixtown', level: 'city', reportingCode: 'TX-1', rate: 1.5, taxableSales: 300, tax: 4.5 },
      { jurisdictionCode: 'tx_transit', jurisdictionName: 'Fixtown Transit', level: 'district', reportingCode: 'TX-2', rate: 0.75, taxableSales: 300, tax: 2.25 },
    ]);
    expect(ws.salesTaxDue).toBe(21.75);
    expect(ws.grossSales).toBe(300);
  });

  it('4. an exempt resale is gross sales and a resale deduction (Florida worksheet)', async () => {
    const rows = await invoiceRows('inv_fl', '2026-02-10', {
      shipTo: addr('FL', '33101'),
      customer: { partyId: 'p', certificates: [certificate()] },
      lines: [line('l1', 200)],
    });
    const ws = buildUsSalesTaxWorksheet(rows, options({ agencyId: 'ag_fl', stateCode: 'FL' }));
    expect(ws.grossSales).toBe(200);
    expect(ws.deductions.resale).toBe(200);
    expect(ws.taxableSales).toBe(0);
    expect(ws.salesTaxDue).toBe(0);
    expect(ws.byLocation).toEqual([]);
  });

  it('shows each exemption reason as its own deduction', async () => {
    const reasons = ['nonprofit', 'government', 'manufacturing', 'agricultural', 'other'] as const;
    const rows: SalesTaxWorksheetLine[] = [];
    for (const [i, reason] of reasons.entries()) {
      rows.push(
        ...(await invoiceRows(`inv_${reason}`, '2026-02-10', {
          shipTo: addr('FL', '33101'),
          customer: { partyId: 'p', certificates: [certificate({ reason })] },
          lines: [line('l1', 10 * (i + 1))],
        })),
      );
    }
    const ws = buildUsSalesTaxWorksheet(rows, options({ agencyId: 'ag_fl', stateCode: 'FL' }));
    expect(ws.deductions).toMatchObject({ nonprofit: 10, government: 20, manufacturing: 30, agricultural: 40, other_exempt: 50 });
    expect(ws.grossSales).toBe(150);
    expect(ws.taxableSales).toBe(0);
  });

  it('6. shipping that is not taxable is an exempt freight deduction, other lines non-taxable', async () => {
    const data = buildManualData([
      { agencyId: 'ag_wa', taxCode: 'shipping', taxable: false, taxablePercent: 100, appliesToUse: 'any', rateOverride: null, effectiveFrom: '2020-01-01', effectiveTo: null },
    ]);
    const req = request({
      shipTo: addr('WA', '98001'),
      lines: [line('goods', 100), line('ship', 20, { taxCode: 'shipping' }), line('misc', 5, { taxCode: 'non_taxable' })],
    });
    const result = await createManualEngine(data, { now: NOW }).calculate(req);
    const breakdown = salesTaxResultToBreakdown(result, {
      lines: req.lines.map((l) => ({ lineId: l.lineId, taxCode: l.taxCode })),
    });
    const rows = ledger(breakdownToTaxLineFields(breakdown), { sourceType: 'invoice', sourceId: 'inv_ship', taxDate: '2026-02-10' });
    const ws = buildUsSalesTaxWorksheet(rows, options({ agencyId: 'ag_wa', stateCode: 'WA' }));
    expect(ws.grossSales).toBe(125);
    expect(ws.deductions.exempt_freight).toBe(20);
    expect(ws.deductions.non_taxable).toBe(5);
    expect(ws.taxableSales).toBe(100);
    expect(ws.salesTaxDue).toBe(9);
  });

  it('a marketplace-facilitated sale is gross sales and a marketplace deduction', async () => {
    const rows = await invoiceRows('inv_mkt', '2026-02-10', {
      shipTo: addr('TX', '78701'),
      marketplaceFacilitated: true,
      lines: [line('l1', 80)],
    });
    const ws = buildUsSalesTaxWorksheet(rows, options());
    expect(ws.grossSales).toBe(80);
    expect(ws.deductions.marketplace).toBe(80);
    expect(ws.taxableSales).toBe(0);
    expect(ws.salesTaxDue).toBe(0);
  });

  it('7. a credit memo in the next period is negative and the next return nets it', async () => {
    const invoice = await invoiceRows('inv_1', '2026-03-20', { lines: [line('l1', 100)] });

    // The credit memo is booked in April, from the invoice's own breakdown.
    const req = request({ lines: [line('l1', 100)] });
    const result = await createManualEngine(buildManualData(), { now: NOW }).calculate(req);
    const original = salesTaxResultToBreakdown(result, { lines: [{ lineId: 'l1', taxCode: 'general' }] });
    const credit = reverseResultForCreditMemo(original, [{ lineId: 'l1', amount: 40 }]);
    const creditRows = ledger(
      breakdownToTaxLineFields(credit, { sign: -1, shipToState: 'TX', shipToPostalCode: '78701' }),
      { sourceType: 'credit_note', sourceId: 'cm_1', taxDate: '2026-04-10' },
    );
    expect(creditRows.every((r) => r.taxAmount <= 0 && r.taxableAmount <= 0)).toBe(true);

    const q1 = buildUsSalesTaxWorksheet([...invoice, ...creditRows], options());
    expect(q1.grossSales).toBe(100);
    expect(q1.salesTaxDue).toBe(7.25);

    const q2 = buildUsSalesTaxWorksheet([...invoice, ...creditRows], {
      ...options(),
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
    });
    expect(q2.grossSales).toBe(0);
    expect(q2.deductions.returns).toBe(40);
    expect(q2.taxableSales).toBe(-40);
    expect(q2.salesTaxDue).toBe(-2.9);
    expect(q2.totalTaxDue).toBe(-2.9);
    expect(q2.byLocation.map((l) => [l.jurisdictionName, l.taxableSales, l.tax])).toEqual([
      ['Texas', -40, -2],
      ['Fixtown', -40, -0.6],
      ['Fixtown Transit', -40, -0.3],
    ]);

    // Filed together the two periods net to the sale that stayed.
    const year = buildUsSalesTaxWorksheet([...invoice, ...creditRows], { ...options(), periodEnd: '2026-06-30' });
    expect(year.grossSales).toBe(100);
    expect(year.deductions.returns).toBe(40);
    expect(year.taxableSales).toBe(60);
    expect(year.salesTaxDue).toBe(4.35);
  });

  it('a credit memo in the same period reduces taxable sales through returns', async () => {
    const invoice = await invoiceRows('inv_1', '2026-02-20', { lines: [line('l1', 100)] });
    const req = request({ lines: [line('l1', 100)] });
    const original = salesTaxResultToBreakdown(
      await createManualEngine(buildManualData(), { now: NOW }).calculate(req),
      { lines: [{ lineId: 'l1' }] },
    );
    const credit = ledger(
      breakdownToTaxLineFields(reverseResultForCreditMemo(original, [{ lineId: 'l1', amount: 100 }]), { sign: -1, shipToState: 'TX' }),
      { sourceType: 'credit_note', sourceId: 'cm_1', taxDate: '2026-03-01' },
    );
    const ws = buildUsSalesTaxWorksheet([...invoice, ...credit], options());
    expect(ws.grossSales).toBe(100);
    expect(ws.deductions.returns).toBe(100);
    expect(ws.taxableSales).toBe(0);
    expect(ws.salesTaxDue).toBe(0);
    expect(ws.documentCount).toBe(2);
  });

  it('a credit memo of an exempt sale nets against the resale deduction, not against taxable sales', async () => {
    const exempt = await invoiceRows('inv_fl', '2026-02-10', {
      shipTo: addr('FL', '33101'),
      customer: { partyId: 'p', certificates: [certificate()] },
      lines: [line('l1', 200)],
    });
    const orig = exempt.map((r) => ({
      taxRateId: '',
      taxRateName: r.jurisdictionName ?? '',
      taxRate: r.rate ?? 0,
      taxableAmount: r.taxableAmount,
      taxAmount: r.taxAmount,
      lineId: 'l1',
      jurisdictionCode: r.jurisdictionCode ?? undefined,
      jurisdictionName: r.jurisdictionName ?? undefined,
      jurisdictionLevel: 'state' as const,
      stateCode: 'FL',
      agencyId: r.agencyId ?? undefined,
      exemptAmount: r.exemptAmount,
      nonTaxableAmount: r.nonTaxableAmount,
      exemptReason: r.exemptReason ?? undefined,
      certificateId: r.certificateId ?? undefined,
    }));
    const credit = ledger(
      breakdownToTaxLineFields(reverseResultForCreditMemo(orig, [{ lineId: 'l1', amount: 200 }]), { sign: -1, shipToState: 'FL' }),
      { sourceType: 'credit_note', sourceId: 'cm_fl', taxDate: '2026-04-05' },
    );
    const opts = options({ agencyId: 'ag_fl', stateCode: 'FL', periodStart: '2026-04-01', periodEnd: '2026-06-30' });
    const ws = buildUsSalesTaxWorksheet([...exempt, ...credit], opts);
    expect(ws.grossSales).toBe(0);
    expect(ws.deductions.resale).toBe(-200);
    expect(ws.deductions.returns).toBe(200);
    expect(ws.taxableSales).toBe(0);
  });

  it('a bad-debt write-off takes the taxable sale back out', () => {
    const base: SalesTaxWorksheetLine = {
      taxRateId: '',
      taxCategoryCode: '',
      taxableAmount: 100,
      taxAmount: 7.25,
      agencyId: 'ag_tx',
      jurisdictionCode: 'tx_state',
      jurisdictionLevel: 'state',
      rate: 7.25,
      grossAmount: 100,
      exemptAmount: 0,
      nonTaxableAmount: 0,
      sourceType: 'invoice',
      sourceId: 'inv_1',
      sourceLineId: 'l1',
      taxDate: '2026-01-15',
    };
    const writeOff: SalesTaxWorksheetLine = {
      ...base,
      taxableAmount: -100,
      taxAmount: -7.25,
      grossAmount: -100,
      sourceType: 'write_off',
      sourceId: 'inv_1',
      taxDate: '2026-05-15',
    };
    const ws = buildUsSalesTaxWorksheet([base, writeOff], { ...options(), periodStart: '2026-04-01', periodEnd: '2026-06-30' });
    expect(ws.deductions.bad_debts).toBe(100);
    expect(ws.salesTaxDue).toBe(-7.25);
    expect(ws.taxableSales).toBe(-100);
  });

  it('use tax is its own line and never part of gross sales', async () => {
    const req = request({
      documentType: 'bill',
      direction: 'use',
      shipFrom: addr('NY', '10001'),
      shipTo: addr('WA', '98001'),
      lines: [line('b1', 200)],
    });
    const result = await createManualEngine(buildManualData(), { now: NOW }).calculate(req);
    const breakdown = salesTaxResultToBreakdown(result, { lines: [{ lineId: 'b1' }], direction: 'use' });
    const use = ledger(breakdownToTaxLineFields(breakdown, { direction: 'use' }), { sourceType: 'bill', sourceId: 'bill_1', taxDate: '2026-02-12' });
    const sale = await invoiceRows('inv_wa', '2026-02-10', { shipTo: addr('WA', '98001'), lines: [line('l1', 100)] });
    const ws = buildUsSalesTaxWorksheet([...use, ...sale], options({ agencyId: 'ag_wa', stateCode: 'WA' }));
    expect(ws.grossSales).toBe(100);
    expect(ws.salesTaxDue).toBe(9);
    expect(ws.useTaxDue).toBe(18);
    expect(ws.totalTaxDue).toBe(27);
    expect(ws.useTaxByLocation.map((l) => [l.jurisdictionName, l.tax])).toEqual([
      ['Washington', 12],
      ['Alpha', 4],
      ['Regional Transit', 2],
    ]);
    expect(ws.documentCount).toBe(1);
  });

  it('leaves out other agencies, other periods and sales tax paid on purchases', async () => {
    const tx = await invoiceRows('inv_tx', '2026-02-10', { lines: [line('l1', 100)] });
    const wa = await invoiceRows('inv_wa', '2026-02-10', { shipTo: addr('WA', '98001'), lines: [line('l1', 100)] });
    const late = await invoiceRows('inv_late', '2026-04-02', { lines: [line('l1', 100)] });
    const paid: SalesTaxWorksheetLine = { ...tx[0], direction: 'purchase', kind: undefined, sourceId: 'bill_paid', sourceLineId: 'x' };
    const ws = buildUsSalesTaxWorksheet([...tx, ...wa, ...late, paid], options());
    expect(ws.grossSales).toBe(100);
    expect(ws.salesTaxDue).toBe(7.25);
    expect(ws.documentCount).toBe(1);
  });

  it('includes both ends of the period', async () => {
    const first = await invoiceRows('a', '2026-01-01', { documentDate: '2026-01-01', lines: [line('l1', 10)] });
    const last = await invoiceRows('b', '2026-03-31', { documentDate: '2026-03-31', lines: [line('l1', 10)] });
    const before = await invoiceRows('c', '2025-12-31', { documentDate: '2025-12-31', lines: [line('l1', 10)] });
    const ws = buildUsSalesTaxWorksheet([...first, ...last, ...before], options());
    expect(ws.grossSales).toBe(20);
    expect(ws.documentCount).toBe(2);
  });

  it('counts an exempt sale with no certificate as taxable once its 90 days are over', () => {
    const base: SalesTaxWorksheetLine = {
      taxRateId: '',
      taxCategoryCode: '',
      taxableAmount: 0,
      taxAmount: 0,
      agencyId: 'ag_tx',
      jurisdictionCode: 'tx_state',
      jurisdictionName: 'Texas',
      jurisdictionLevel: 'state',
      rate: 5,
      grossAmount: 100,
      exemptAmount: 100,
      nonTaxableAmount: 0,
      exemptReason: 'resale',
      certificateId: null,
      sourceType: 'invoice',
      sourceId: 'inv_pending',
      sourceLineId: 'l1',
      taxDate: '2026-01-10',
    };
    const city: SalesTaxWorksheetLine = { ...base, jurisdictionCode: 'tx_city', jurisdictionName: 'Fixtown', jurisdictionLevel: 'city', rate: 1.5 };
    const rows = [base, city];

    const within = buildUsSalesTaxWorksheet(rows, options({ asOf: '2026-04-10' }));
    expect(within.deductions.resale).toBe(100);
    expect(within.taxableSales).toBe(0);
    expect(within.uncuredExempt.lines).toBe(0);

    const past = buildUsSalesTaxWorksheet(rows, options({ asOf: '2026-04-11' }));
    expect(past.deductions.resale).toBe(0);
    expect(past.taxableSales).toBe(100);
    expect(past.uncuredExempt).toEqual({ sales: 100, tax: 6.5, lines: 1 });
    expect(past.salesTaxDue).toBe(6.5);
    expect(past.byLocation.map((l) => [l.jurisdictionName, l.taxableSales, l.tax])).toEqual([
      ['Texas', 100, 5],
      ['Fixtown', 100, 1.5],
    ]);

    // Never applied without a date to measure from; a certificate on file also stops it.
    expect(buildUsSalesTaxWorksheet(rows, options()).taxableSales).toBe(0);
    const withCert = rows.map((r) => ({ ...r, certificateId: 'cert_1' }));
    expect(buildUsSalesTaxWorksheet(withCert, options({ asOf: '2027-01-01' })).taxableSales).toBe(0);
  });

  it('gives an empty worksheet for no rows', () => {
    const ws = buildUsSalesTaxWorksheet([], options());
    expect(ws).toMatchObject({ grossSales: 0, taxableSales: 0, salesTaxDue: 0, useTaxDue: 0, totalTaxDue: 0, documentCount: 0, byLocation: [] });
    expect(Object.values(ws.deductions).every((v) => v === 0)).toBe(true);
  });

  it('adds money in whole cents', () => {
    const row = (id: string): SalesTaxWorksheetLine => ({
      taxRateId: '',
      taxCategoryCode: '',
      taxableAmount: 0.1,
      taxAmount: 0.01,
      agencyId: 'ag_tx',
      jurisdictionCode: 'tx_state',
      jurisdictionLevel: 'state',
      rate: 10,
      grossAmount: 0.1,
      exemptAmount: 0,
      nonTaxableAmount: 0,
      sourceType: 'invoice',
      sourceId: id,
      sourceLineId: 'l1',
      taxDate: '2026-02-01',
    });
    const ws = buildUsSalesTaxWorksheet([row('a'), row('b'), row('c')], options());
    expect(ws.grossSales).toBe(0.3);
    expect(ws.salesTaxDue).toBe(0.03);
  });
});

describe('buildUsSalesTaxReturn', () => {
  const entity = { id: 'ent_test', name: 'Fixture, Inc.', accountingMethod: 'accrual' } as unknown as Entity;

  it('writes a CSV worksheet named after the state and period', async () => {
    const rows = await invoiceRows('inv_1', '2026-02-10', { lines: [line('l1', 100), line('ship', 20, { taxCode: 'shipping' })] });
    const artifact = await buildUsSalesTaxReturn(entity, '2026-01-01', '2026-03-31', rows as TaxReturnLine[]);

    expect(artifact.filename).toBe('sales-tax-tx-2026-01-01-2026-03-31.csv');
    expect(artifact.mimeType).toBe('text/csv');
    expect(artifact.summary).toMatchObject({
      grossSales: 120,
      totalDeductions: 0,
      taxableSales: 120,
      salesTaxDue: 8.7,
      useTaxDue: 0,
      totalTaxDue: 8.7,
      documentCount: 1,
    });

    const lines = artifact.content.split('\n');
    expect(lines[0]).toBe('Sales tax return worksheet');
    expect(lines).toContain('Entity,"Fixture, Inc."');
    expect(lines).toContain('Gross sales,120.00');
    expect(lines).toContain('Taxable sales,120.00');
    expect(lines).toContain('Sales tax due,8.70');
    expect(lines).toContain('Total tax due,8.70');
    expect(lines).toContain('Location code,Location,Level,Reporting code,Rate (%),Taxable sales,Tax');
    expect(lines).toContain('tx_state,Texas,state,TX-0,5,120.00,6.00');
    expect(lines).toContain('tx_transit,Fixtown Transit,district,TX-2,0.75,120.00,0.90');
  });

  it('lists deductions that are not zero', async () => {
    const rows = await invoiceRows('inv_fl', '2026-02-10', {
      shipTo: addr('FL', '33101'),
      customer: { partyId: 'p', certificates: [certificate()] },
      lines: [line('l1', 200)],
    });
    const artifact = await buildUsSalesTaxReturn(entity, '2026-01-01', '2026-03-31', rows as TaxReturnLine[]);
    expect(artifact.filename).toBe('sales-tax-fl-2026-01-01-2026-03-31.csv');
    expect(artifact.content).toContain('Less: Sales for resale,200.00');
    expect(artifact.content).not.toContain('Less: Returns');
    expect(artifact.summary.deduction_resale).toBe(200);
    expect(artifact.summary.taxableSales).toBe(0);
  });

  it('gives each agency its own section when rows span several', async () => {
    const tx = await invoiceRows('inv_tx', '2026-02-10', { lines: [line('l1', 100)] });
    const wa = await invoiceRows('inv_wa', '2026-02-10', { shipTo: addr('WA', '98001'), lines: [line('l1', 100)] });
    const artifact = await buildUsSalesTaxReturn(entity, '2026-01-01', '2026-03-31', [...tx, ...wa] as TaxReturnLine[]);
    expect(artifact.filename).toBe('sales-tax-all-2026-01-01-2026-03-31.csv');
    expect(artifact.content.match(/Sales tax return worksheet/g)).toHaveLength(2);
    expect(artifact.summary.grossSales).toBe(200);
    expect(artifact.summary.salesTaxDue).toBe(16.25);
    expect(artifact.summary.documentCount).toBe(2);
  });

  it('reports the entity accounting method as the reporting basis', async () => {
    const cash = { ...entity, accountingMethod: 'cash' } as unknown as Entity;
    const rows = await invoiceRows('inv_1', '2026-02-10', {});
    const artifact = await buildUsSalesTaxReturn(cash, '2026-01-01', '2026-03-31', rows as TaxReturnLine[]);
    expect(artifact.content).toContain('Reporting basis,cash');
  });

  it('produces a worksheet for a period with no rows', async () => {
    const artifact = await buildUsSalesTaxReturn(entity, '2026-01-01', '2026-03-31', []);
    expect(artifact.filename).toBe('sales-tax-all-2026-01-01-2026-03-31.csv');
    expect(artifact.summary.totalTaxDue).toBe(0);
  });
});
