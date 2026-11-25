import { describe, expect, it } from 'vitest';
import {
  annualReportTotals,
  balanceDifference,
  changedLines,
  defaultAnnualReportYear,
  emptyLines,
  isAnnualReportEditable,
  isBalanced,
  isPreprodDelivery,
  type AnnualReportLines,
} from './annual-report-model';

function lines(extra: Partial<AnnualReportLines> = {}): AnnualReportLines {
  return { ...emptyLines(), ...extra };
}

describe('annualReportTotals', () => {
  it('adds the lines up the way the jaarrekening groups them', () => {
    const totals = annualReportTotals(
      lines({
        intangibleAssets: 100,
        tangibleAssets: 200,
        financialAssets: 50,
        inventories: 10,
        receivables: 20,
        securities: 5,
        cash: 15,
        shareCapital: 1,
        sharePremium: 2,
        revaluationReserve: 3,
        legalReserves: 4,
        statutoryReserves: 5,
        otherReserves: 6,
        resultForTheYear: 7,
        provisions: 30,
        longTermLiabilities: 40,
        currentLiabilities: 50,
      }),
    );
    expect(totals).toEqual({
      fixedAssets: 350,
      currentAssets: 50,
      assets: 400,
      equity: 28,
      provisions: 30,
      liabilities: 90,
      equityAndLiabilities: 148,
    });
  });

  it('keeps cents exact', () => {
    expect(annualReportTotals(lines({ cash: 0.1, receivables: 0.2 })).currentAssets).toBe(0.3);
  });
});

describe('balance', () => {
  it('balances when assets equal equity and liabilities', () => {
    const balanced = lines({ cash: 100, shareCapital: 60, currentLiabilities: 40 });
    expect(isBalanced(balanced)).toBe(true);
    expect(balanceDifference(balanced)).toBe(0);
  });

  it('reports the difference when it does not', () => {
    const off = lines({ cash: 100, shareCapital: 60 });
    expect(isBalanced(off)).toBe(false);
    expect(balanceDifference(off)).toBe(40);
  });
});

describe('changedLines', () => {
  it('sends only the lines that differ from the server', () => {
    const server = lines({ cash: 100 });
    expect(changedLines(server, lines({ cash: 100, receivables: 25.5 }))).toEqual({ receivables: 25.5 });
  });

  it('sends every line for a prior year that did not exist yet', () => {
    expect(Object.keys(changedLines(null, lines()))).toHaveLength(17);
  });
});

describe('editing and years', () => {
  it('locks reports that are sent, accepted or filed', () => {
    expect(isAnnualReportEditable('draft')).toBe(true);
    expect(isAnnualReportEditable('rejected')).toBe(true);
    for (const status of ['submitted', 'accepted', 'filed'] as const) {
      expect(isAnnualReportEditable(status)).toBe(false);
    }
  });

  it('proposes last year, or the other covered year when it is taken', () => {
    expect(defaultAnnualReportYear(new Date('2026-11-22'))).toBe(2025);
    expect(defaultAnnualReportYear(new Date('2026-11-22'), [2025])).toBe(2026);
    expect(defaultAnnualReportYear(new Date('2030-01-01'))).toBe(2026);
  });

  it('spots a delivery made in the test environment', () => {
    expect(isPreprodDelivery({ digipoortResponse: { environment: 'preprod' } })).toBe(true);
    expect(isPreprodDelivery({ digipoortResponse: { environment: 'production' } })).toBe(false);
    expect(isPreprodDelivery({ digipoortResponse: null })).toBe(false);
    expect(isPreprodDelivery(undefined)).toBe(false);
  });
});
