import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MidQuarterReport, TaxDepreciationParams, TaxDepreciationReport } from '@/lib/api/domains/weldbooks-assets';

let jurisdiction = 'US';
let report: TaxDepreciationReport | undefined;
const reportParams: Array<{ params: TaxDepreciationParams | undefined; enabled: boolean | undefined }> = [];

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: jurisdiction, isResolved: true, isError: false }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-03-10',
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-assets-queries', () => ({
  useTaxDepreciationReport: (params: TaxDepreciationParams | undefined, options?: { enabled?: boolean }) => {
    reportParams.push({ params, enabled: options?.enabled });
    return { data: report, isLoading: false, isError: false, refetch: vi.fn() };
  },
}));

import TaxDepreciationPage from './page';
import { polyfillRadixSelect, renderWithProviders } from '../test-utils';

const midQuarter = (applies: boolean): MidQuarterReport => ({
  applies,
  totalBasis: 20000,
  lastQuarterBasis: applies ? 12000 : 2000,
  lastQuarterShare: applies ? 0.6 : 0.1,
  quarterBasis: applies ? [4000, 2000, 2000, 12000] : [10000, 5000, 3000, 2000],
  taxYear: 2026,
  start: '2026-01-01',
  end: '2026-12-31',
  threshold: 0.4,
  assets: [
    { assetId: 'fa_1', assetNumber: null, name: 'Forklift', placedInServiceDate: '2026-11-20', quarter: 4, basis: 12000, counted: true, excludedReason: null, convention: applies ? 'mid_quarter' : 'half_year' },
    { assetId: 'fa_2', assetNumber: null, name: 'Rental house', placedInServiceDate: '2026-03-01', quarter: 1, basis: 8000, counted: false, excludedReason: 'real_property', convention: 'mid_month' },
  ],
});

const taxReport = (applies = true): TaxDepreciationReport => ({
  taxYear: 2026,
  start: '2026-01-01',
  end: '2026-12-31',
  book: 'federal',
  stateCode: null,
  lines: [
    {
      assetId: 'fa_1',
      assetNumber: null,
      name: 'Forklift',
      assetClass: '7',
      acquisitionDate: '2026-11-20',
      placedInServiceDate: '2026-11-20',
      disposalDate: null,
      placedInServiceThisYear: true,
      cost: 12000,
      businessUsePercent: 100,
      method: 'macrs_gds',
      convention: applies ? 'mid_quarter' : 'half_year',
      recoveryYears: 7,
      depreciableBasis: 0,
      section179: 2500,
      bonus: 9500,
      macrs: 0,
      total: 12000,
      accumulated: 12000,
      listedProperty: false,
      issues: [],
    },
  ],
  form4562: {
    part1: { totalCostOfSection179Property: 12000, limit: 2_500_000, phaseOutThreshold: 4_000_000, reduction: 0, dollarLimit: 2_500_000, elected: 2500, deduction: 2500 },
    part2: { bonus: 9500 },
    part3: { priorYearAssets: 1800, currentYearAssets: [{ recoveryYears: 7, convention: 'mid_quarter', method: 'macrs_gds', count: 1, basis: 0, depreciation: 0 }], currentYearTotal: 0 },
    listedProperty: [{ assetId: 'fa_3', name: 'Pickup truck', businessUsePercent: 60, total: 5400 }],
    total: 13800,
  },
  midQuarter: midQuarter(applies),
});

describe('Tax depreciation page', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    jurisdiction = 'US';
    reportParams.length = 0;
    report = taxReport();
  });

  it('lays the year out in the parts of Form 4562', () => {
    renderWithProviders(<TaxDepreciationPage />);

    const part1 = screen.getByTestId('form-part1');
    expect(part1).toHaveTextContent('Part I — Section 179 election');
    expect(part1).toHaveTextContent('$12000.00');
    expect(part1).toHaveTextContent('$2500.00');
    expect(screen.getByTestId('form-part2')).toHaveTextContent('$9500.00');

    const part3 = screen.getByTestId('form-part3');
    expect(part3).toHaveTextContent('Assets placed in service in earlier years');
    expect(part3).toHaveTextContent('$1800.00');
    expect(part3).toHaveTextContent('7-year property');
    expect(part3).toHaveTextContent('Mid-quarter');

    expect(screen.getByTestId('form-listed')).toHaveTextContent('Pickup truck');
    expect(screen.getByText('Total depreciation').nextElementSibling).toHaveTextContent('$13800.00');
  });

  it('shows the mid-quarter test with its verdict, share and the assets it counted or left out', () => {
    renderWithProviders(<TaxDepreciationPage />);

    const card = screen.getByTestId('mid-quarter-card');
    expect(card).toHaveAttribute('data-applies', 'true');
    expect(within(card).getByTestId('mid-quarter-verdict')).toHaveTextContent('The mid-quarter convention applies');
    expect(card).toHaveTextContent('60.0%');
    expect(card).toHaveTextContent('40.0%');
    expect(card).toHaveTextContent('Quarter 4');
    expect(card).toHaveTextContent('$12000.00');
    expect(within(card).getByText('Left out: Real property')).toBeInTheDocument();
    expect(within(card).getAllByText('Counted')).not.toHaveLength(0);
  });

  it('says the half-year convention applies when the last quarter stays under 40%', () => {
    report = taxReport(false);
    renderWithProviders(<TaxDepreciationPage />);
    const card = screen.getByTestId('mid-quarter-card');
    expect(card).toHaveAttribute('data-applies', 'false');
    expect(within(card).getByTestId('mid-quarter-verdict')).toHaveTextContent('The half-year convention applies');
    expect(card).toHaveTextContent('10.0%');
  });

  it('asks for the federal book of the default year, and for a state before it shows a state book', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaxDepreciationPage />);
    expect(reportParams.at(-1)).toEqual({ params: { book: 'federal' }, enabled: true });

    await user.click(screen.getByRole('combobox', { name: 'Book' }));
    await user.click(await screen.findByRole('option', { name: 'State tax' }));
    // The picker's placeholder and the line explaining why there is no report yet.
    expect(await screen.findAllByText('Choose a state')).toHaveLength(2);
    expect(reportParams.at(-1)).toMatchObject({ params: { book: 'state' }, enabled: false });

    await user.click(screen.getByRole('combobox', { name: 'State' }));
    await user.click(await screen.findByRole('option', { name: 'CA — California' }));
    expect(reportParams.at(-1)).toEqual({ params: { book: 'state', stateCode: 'CA' }, enabled: true });
  });

  it('asks for another tax year', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaxDepreciationPage />);
    await user.click(screen.getByRole('combobox', { name: 'Tax year' }));
    await user.click(await screen.findByRole('option', { name: '2025' }));
    expect(reportParams.at(-1)).toMatchObject({ params: { taxYear: 2025, book: 'federal' } });
  });

  it('is for US entities only', () => {
    jurisdiction = 'NL';
    renderWithProviders(<TaxDepreciationPage />);
    expect(screen.getByText('This screen is for US accounting entities only.')).toBeInTheDocument();
    expect(screen.queryByTestId('form-part1')).not.toBeInTheDocument();
    expect(reportParams.every((call) => call.enabled === false)).toBe(true);
  });
});
