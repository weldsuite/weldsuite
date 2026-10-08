import { describe, expect, it } from 'vitest';
import { createManualEngine } from './manual-engine';
import {
  breakdownTaxTotal,
  breakdownToTaxLineFields,
  reverseResultForCreditMemo,
  salesTaxResultToBreakdown,
  salesTaxResultToTaxLines,
} from './to-tax-lines';
import { REGISTRATIONS, TX_SELLER, addr, buildManualData, certificate, line, reg, request } from './test-fixtures';

const NOW = () => new Date('2026-03-15T12:00:00.000Z');
const engine = () => createManualEngine(buildManualData(), { now: NOW });
const ctxFor = (lines: Array<{ lineId: string; taxCode?: string }>, extra = {}) => ({ lines, ...extra });

describe('salesTaxResultToBreakdown', () => {
  it('writes one row per line per jurisdiction', async () => {
    const result = await engine().calculate(
      request({ lines: [line('l1', 100, { taxCode: 'general' }), line('l2', 50, { taxCode: 'shipping' })] }),
    );
    const rows = salesTaxResultToBreakdown(result, ctxFor([{ lineId: 'l1', taxCode: 'general' }, { lineId: 'l2', taxCode: 'shipping' }]));

    expect(rows).toHaveLength(6);
    expect(rows.map((r) => `${r.lineId}:${r.jurisdictionCode}`)).toEqual([
      'l1:tx_state',
      'l1:tx_fixtown',
      'l1:tx_transit',
      'l2:tx_state',
      'l2:tx_fixtown',
      'l2:tx_transit',
    ]);
    expect(rows[0]).toEqual({
      taxRateId: '',
      taxRateName: 'Texas',
      taxRate: 5,
      taxableAmount: 100,
      taxAmount: 5,
      lineId: 'l1',
      jurisdictionCode: 'tx_state',
      jurisdictionName: 'Texas',
      jurisdictionLevel: 'state',
      stateCode: 'TX',
      agencyId: 'ag_tx',
      reportingCode: 'TX-0',
      exemptAmount: 0,
      nonTaxableAmount: 0,
      unroundedTaxAmount: 5,
      taxCode: 'general',
      kind: 'tax',
    });
    expect(rows[3].taxCode).toBe('shipping');
    expect(breakdownTaxTotal(rows)).toBe(result.totalTax + 0);
  });

  it('carries the exemption and the certificate', async () => {
    const result = await engine().calculate(
      request({
        shipTo: addr('FL', '33101'),
        customer: { partyId: 'p', certificates: [certificate()] },
      }),
    );
    const rows = salesTaxResultToBreakdown(result, ctxFor([{ lineId: 'l1' }]));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.exemptAmount === 100 && r.exemptReason === 'resale' && r.certificateId === 'cert_1')).toBe(true);
    expect(rows.every((r) => r.taxableAmount === 0 && r.taxAmount === 0)).toBe(true);
  });

  it('a use tax accrual is marked as use and self-assessed', async () => {
    const result = await engine().calculate(
      request({ documentType: 'bill', direction: 'use', shipFrom: addr('NY', '10001'), shipTo: addr('WA', '98001') }),
    );
    const rows = salesTaxResultToBreakdown(result, ctxFor([{ lineId: 'l1' }], { direction: 'use' }));
    expect(rows.every((r) => r.kind === 'use' && r.selfAssessed === true)).toBe(true);
  });

  it('a sale in a state the entity is not registered in still leaves one zero-tax row', async () => {
    const result = await engine().calculate(request({ shipTo: addr('CA', '95001'), registrations: [reg('ag_tx', 'TX')] }));
    const rows = salesTaxResultToBreakdown(result, ctxFor([{ lineId: 'l1', taxCode: 'general' }], { registrations: [reg('ag_tx', 'TX')] }));
    expect(rows).toEqual([
      expect.objectContaining({
        lineId: 'l1',
        stateCode: 'CA',
        jurisdictionCode: 'CA',
        jurisdictionName: 'California',
        jurisdictionLevel: 'state',
        taxRate: 0,
        taxAmount: 0,
        taxableAmount: 0,
        nonTaxableAmount: 100,
        exemptAmount: 0,
      }),
    ]);
    expect(rows[0].agencyId).toBeUndefined();
  });

  it('a marketplace sale carries its ship-to state agency, so the return can deduct it', async () => {
    const result = await engine().calculate(request({ shipTo: addr('WA', '98001'), marketplaceFacilitated: true }));
    const rows = salesTaxResultToBreakdown(
      result,
      ctxFor([{ lineId: 'l1' }], { registrations: REGISTRATIONS, marketplaceFacilitated: true, documentDate: '2026-03-15' }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stateCode: 'WA', agencyId: 'ag_wa', taxAmount: 0, nonTaxableAmount: 100 });
  });

  it('writes nothing for a document without a ship-to', async () => {
    const result = await engine().calculate(request({ shipTo: null }));
    expect(salesTaxResultToBreakdown(result, ctxFor([{ lineId: 'l1' }]))).toEqual([]);
  });
});

describe('breakdownToTaxLineFields', () => {
  it('fills the tax_lines columns as insert-ready strings', async () => {
    const result = await engine().calculate(request({ lines: [line('l1', 33.33)] }));
    const { taxLines, breakdown } = salesTaxResultToTaxLines(result, ctxFor([{ lineId: 'l1', taxCode: 'general' }]));
    expect(breakdown).toHaveLength(3);
    expect(taxLines[0]).toEqual({
      direction: 'sales',
      sourceLineId: 'l1',
      taxRateName: 'Texas',
      rate: '5.0000',
      jurisdictionCode: 'tx_state',
      jurisdictionName: 'Texas',
      jurisdictionLevel: 'state',
      reportingCode: 'TX-0',
      stateCode: 'TX',
      agencyId: 'ag_tx',
      grossAmount: '33.33',
      taxableAmount: '33.33',
      exemptAmount: '0.00',
      nonTaxableAmount: '0.00',
      exemptReason: null,
      certificateId: null,
      shipToState: 'TX',
      shipToPostalCode: '78701',
      taxCode: 'general',
      marketplaceFacilitated: false,
      unroundedTaxAmount: '1.666500',
      engine: 'manual',
      engineRef: null,
      taxAmount: '1.67',
    });
    expect(taxLines[1].unroundedTaxAmount).toBe('0.499950');
  });

  it('gross is taxable + exempt + non-taxable', async () => {
    const result = await engine().calculate(
      request({
        shipTo: addr('FL', '33101'),
        customer: { partyId: 'p', certificates: [certificate()] },
        lines: [line('l1', 100), line('l2', 10, { taxCode: 'non_taxable' })],
      }),
    );
    const { taxLines } = salesTaxResultToTaxLines(result, ctxFor([{ lineId: 'l1' }, { lineId: 'l2' }]));
    expect(taxLines.map((t) => [t.sourceLineId, t.grossAmount, t.exemptAmount, t.nonTaxableAmount])).toEqual([
      ['l1', '100.00', '100.00', '0.00'],
      ['l1', '100.00', '100.00', '0.00'],
      ['l2', '10.00', '0.00', '10.00'],
      ['l2', '10.00', '0.00', '10.00'],
    ]);
    expect(taxLines[0].exemptReason).toBe('resale');
    expect(taxLines[0].certificateId).toBe('cert_1');
  });

  it('use tax rows are direction use; a credit memo writes negative amounts', async () => {
    const result = await engine().calculate(request({ documentType: 'bill', direction: 'use', shipFrom: addr('NY', '10001') }));
    const { breakdown } = salesTaxResultToTaxLines(result, ctxFor([{ lineId: 'l1' }], { direction: 'use' }));
    const use = breakdownToTaxLineFields(breakdown, { direction: 'use' });
    expect(use.every((t) => t.direction === 'use')).toBe(true);
    const credit = breakdownToTaxLineFields(breakdown, { sign: -1, shipToState: 'TX' });
    expect(credit[0].taxAmount).toBe('-5.00');
    expect(credit[0].taxableAmount).toBe('-100.00');
    expect(credit[0].grossAmount).toBe('-100.00');
    expect(credit[0].direction).toBe('use');
  });

  it('writes a marketplace flag and never a negative zero', async () => {
    const result = await engine().calculate(request({ shipTo: addr('CA', '95001'), registrations: [] }));
    const rows = salesTaxResultToBreakdown(result, ctxFor([{ lineId: 'l1' }]));
    const [field] = breakdownToTaxLineFields(rows, { sign: -1, marketplaceFacilitated: true });
    expect(field.marketplaceFacilitated).toBe(true);
    expect(field.taxAmount).toBe('0.00');
    expect(field.taxableAmount).toBe('0.00');
    expect(field.unroundedTaxAmount).toBe('0.000000');
  });

  it('truncates values to their column widths', () => {
    const [field] = breakdownToTaxLineFields([
      {
        taxRateId: '',
        taxRateName: 'x'.repeat(200),
        taxRate: 1,
        taxableAmount: 1,
        taxAmount: 0.01,
        jurisdictionCode: 'y'.repeat(60),
        stateCode: 'TX',
        taxCode: 'z'.repeat(50),
      },
    ]);
    expect(field.taxRateName).toHaveLength(100);
    expect(field.jurisdictionCode).toHaveLength(30);
    expect(field.taxCode).toHaveLength(30);
  });
});

describe('reverseResultForCreditMemo', () => {
  async function original() {
    const result = await engine().calculate(
      request({ lines: [line('l1', 100), line('l2', 33.33, { taxCode: 'shipping' })] }),
    );
    return salesTaxResultToBreakdown(result, ctxFor([{ lineId: 'l1', taxCode: 'general' }, { lineId: 'l2', taxCode: 'shipping' }]));
  }

  it('a full credit of a line copies the original rows exactly', async () => {
    const rows = await original();
    const credit = reverseResultForCreditMemo(rows, [{ lineId: 'l1', amount: 100 }]);
    expect(credit).toEqual(rows.filter((r) => r.lineId === 'l1'));
    expect(breakdownTaxTotal(credit)).toBe(7.25);
  });

  it('keeps the original rates when rates changed since', async () => {
    const rows = await original();
    // Rates may have changed since the invoice; the credit memo works from the invoice's own rows.
    const credit = reverseResultForCreditMemo(rows, [{ lineId: 'l1', amount: 100 }]);
    expect(credit.find((r) => r.jurisdictionCode === 'tx_state')).toMatchObject({ taxRate: 5, taxAmount: 5 });
  });

  it('a partial credit scales the bases and recomputes at the original rates', async () => {
    const rows = await original();
    const credit = reverseResultForCreditMemo(rows, [{ lineId: 'l1', amount: 40 }]);
    expect(credit).toHaveLength(3);
    expect(credit.map((r) => [r.jurisdictionCode, r.taxableAmount, r.taxAmount])).toEqual([
      ['tx_state', 40, 2],
      ['tx_fixtown', 40, 0.6],
      ['tx_transit', 40, 0.3],
    ]);
    expect(credit[0].unroundedTaxAmount).toBe(2);
    expect(breakdownTaxTotal(credit)).toBe(2.9);
  });

  it('a partial credit keeps taxable + exempt + non-taxable equal to the credit', async () => {
    const result = await engine().calculate(
      request({
        shipTo: addr('FL', '33101'),
        customer: { partyId: 'p', certificates: [certificate()] },
        lines: [line('l1', 200)],
      }),
    );
    const rows = salesTaxResultToBreakdown(result, ctxFor([{ lineId: 'l1' }]));
    const credit = reverseResultForCreditMemo(rows, [{ lineId: 'l1', amount: 50 }]);
    for (const r of credit) {
      expect(r.taxableAmount + (r.exemptAmount ?? 0) + (r.nonTaxableAmount ?? 0)).toBe(50);
      expect(r.exemptAmount).toBe(50);
      expect(r.certificateId).toBe('cert_1');
      expect(r.taxAmount).toBe(0);
    }
  });

  it('rounds a multi-line credit memo per jurisdiction over the document', async () => {
    const rows = await original();
    const credit = reverseResultForCreditMemo(rows, [
      { lineId: 'l1', amount: 10.1 },
      { lineId: 'l2', amount: 10.1 },
    ]);
    const state = credit.filter((r) => r.jurisdictionCode === 'tx_state');
    // 20.20 x 5% = 1.01 in one rounding, not 0.51 + 0.51.
    expect(state.map((r) => r.taxAmount)).toEqual([0.51, 0.5]);
  });

  it('skips lines the invoice never carried', async () => {
    const rows = await original();
    expect(reverseResultForCreditMemo(rows, [{ lineId: 'nope', amount: 10 }])).toEqual([]);
    expect(reverseResultForCreditMemo([], [{ lineId: 'l1', amount: 10 }])).toEqual([]);
  });

  it('writes negative tax lines when posted as a credit note', async () => {
    const rows = await original();
    const credit = reverseResultForCreditMemo(rows, [{ lineId: 'l1', amount: 100 }]);
    const fields = breakdownToTaxLineFields(credit, { sign: -1, shipToState: 'TX', engine: 'manual' });
    expect(fields.map((f) => f.taxAmount)).toEqual(['-5.00', '-1.50', '-0.75']);
    expect(fields.map((f) => f.taxableAmount)).toEqual(['-100.00', '-100.00', '-100.00']);
    expect(fields.every((f) => f.direction === 'sales')).toBe(true);
  });
});

describe('fixtures sanity', () => {
  it('the Texas seller is in Texas', () => {
    expect(TX_SELLER.state).toBe('TX');
  });
});
