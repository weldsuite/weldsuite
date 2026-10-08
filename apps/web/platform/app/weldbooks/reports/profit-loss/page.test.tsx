import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ProfitLossReport, ReportColumn, ValueSet } from '@/lib/weldbooks/report-types';

const mocks = vi.hoisted(() => ({
  report: { data: undefined as unknown, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() },
  queries: [] as Array<Record<string, unknown>>,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    search,
    ...rest
  }: {
    children: React.ReactNode;
    to: string;
    search?: Record<string, string | undefined>;
  }) => (
    <a href={to} data-search={JSON.stringify(search ?? {})} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useProfitLossReport: (query: Record<string, unknown>) => {
    mocks.queries.push(query);
    return mocks.report;
  },
  useDimensionValues: () => ({ data: [] }),
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: string | number | null | undefined) => `$${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string | null | undefined) => String(value ?? ''),
    formatMonth: (value: string | null | undefined) => `M:${String(value ?? '').slice(0, 7)}`,
    dateLocale: 'en-US',
  }),
}));
vi.mock('../components/use-report-export', () => ({
  useReportExport: () => ({ busy: null, exportCsv: vi.fn(), exportPdf: vi.fn() }),
}));

import ProfitLossReportPage from './page';

const current: ReportColumn = { key: 'current', label: '', from: '2026-01-01', to: '2026-12-31' };

function set(values: Record<string, string>): ValueSet {
  return { values };
}

function totals(values: Record<string, string>): ProfitLossReport['totals'] {
  const s = set(values);
  return {
    income: s,
    costOfGoodsSold: set(Object.fromEntries(Object.keys(values).map((k) => [k, '0.00']))),
    grossProfit: s,
    expenses: set(Object.fromEntries(Object.keys(values).map((k) => [k, '0.00']))),
    netOperatingIncome: s,
    otherIncome: set(Object.fromEntries(Object.keys(values).map((k) => [k, '0.00']))),
    otherExpenses: set(Object.fromEntries(Object.keys(values).map((k) => [k, '0.00']))),
    netOtherIncome: set(Object.fromEntries(Object.keys(values).map((k) => [k, '0.00']))),
    totalRevenue: s,
    totalExpenses: set(Object.fromEntries(Object.keys(values).map((k) => [k, '0.00']))),
    netProfit: s,
  };
}

function report(columns: ReportColumn[], values: Record<string, string>): ProfitLossReport {
  return {
    basis: 'cash',
    period: { from: '2026-01-01', to: '2026-12-31' },
    columns,
    revenue: [
      {
        accountId: 'acc_sales',
        accountCode: '4000',
        accountName: 'Sales',
        accountType: 'revenue',
        accountSubtype: null,
        normalSide: 'credit',
        section: 'income',
        totalDebit: '0.00',
        totalCredit: '0.00',
        balance: '0.00',
        values,
      },
    ],
    expenses: [],
    totalRevenue: '0.00',
    totalExpenses: '0.00',
    netProfit: '0.00',
    totals: totals(values),
  };
}

describe('ProfitLossReportPage', () => {
  beforeEach(() => {
    mocks.queries = [];
    mocks.report = {
      data: report([current], { current: '1000.00' }),
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
  });

  it('asks for the entity defaults first and shows the period and basis it answered with', () => {
    render(<ProfitLossReportPage />);

    expect(mocks.queries.at(-1)).toEqual({});
    expect(screen.getByRole('heading', { level: 1, name: 'Profit & Loss' })).toBeInTheDocument();
    expect(screen.getByText('2026-01-01 – 2026-12-31 · Cash basis')).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toHaveValue('2026-01-01');
    expect(screen.getByRole('radio', { name: 'Cash' })).toBeChecked();
  });

  it('shows the sections and subtotals with a link from each account to its ledger', () => {
    render(<ProfitLossReportPage />);
    const table = screen.getByRole('table', { name: 'Profit & Loss' });

    expect(within(table).getByText('Income', { selector: 'td' })).toBeInTheDocument();
    expect(within(table).getByText('Total income')).toBeInTheDocument();
    expect(within(table).getByText('Net income')).toBeInTheDocument();
    const link = within(table).getByRole('link', { name: /Sales/ });
    expect(link).toHaveAttribute('href', '/weldbooks/reports/general-ledger');
    expect(JSON.parse(link.getAttribute('data-search') ?? '{}')).toEqual({
      accountId: 'acc_sales',
      from: '2026-01-01',
      to: '2026-12-31',
    });
  });

  it('shows the change columns of a comparison', () => {
    const prior: ReportColumn = { key: 'prior', label: '', from: '2025-01-01', to: '2025-12-31' };
    const data = report([current, prior], { current: '1000.00', prior: '800.00' });
    data.revenue[0].delta = { amount: '200.00', percent: 25 };
    mocks.report = { ...mocks.report, data };
    render(<ProfitLossReportPage />);

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Account', '2026-01-01 – 2026-12-31', '2025-01-01 – 2025-12-31', 'Change', 'Change %']);
    const sales = screen.getByRole('row', { name: /Sales/ });
    expect(within(sales).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      '4000Sales',
      '$1000.00',
      '$800.00',
      '+$200.00',
      '+25%',
    ]);
  });

  it('shows a column per month and a total', () => {
    const columns: ReportColumn[] = [
      { key: '2026-01', label: '', from: '2026-01-01', to: '2026-01-31' },
      { key: '2026-02', label: '', from: '2026-02-01', to: '2026-02-28' },
      { key: 'total', label: '', from: '2026-01-01', to: '2026-02-28' },
    ];
    mocks.report = {
      ...mocks.report,
      data: report(columns, { '2026-01': '600.00', '2026-02': '400.00', total: '1000.00' }),
    };
    render(<ProfitLossReportPage />);

    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Account',
      'M:2026-01',
      'M:2026-02',
      'Total',
    ]);
    // The month split is offered here, next to the comparison.
    expect(screen.getByRole('combobox', { name: 'Columns' })).toBeInTheDocument();
  });

  it('says when nothing was booked in the period', () => {
    const empty = report([current], { current: '0.00' });
    empty.revenue = [];
    mocks.report = { ...mocks.report, data: empty };
    render(<ProfitLossReportPage />);
    expect(screen.getByText('Nothing was booked in this period.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a retryable error', () => {
    mocks.report = { ...mocks.report, data: undefined, isError: true };
    render(<ProfitLossReportPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the report.');
  });
});
