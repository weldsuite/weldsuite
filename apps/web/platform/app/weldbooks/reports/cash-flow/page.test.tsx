import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { CashFlowReport } from '@/lib/weldbooks/report-types';

const reportState = vi.hoisted(() => ({
  current: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve(),
  },
}));
const lastQuery = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useCashFlowReport: (query: unknown) => {
    lastQuery.current = query;
    return reportState.current;
  },
  useDimensionValues: () => ({ data: [] }),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: string | number | null | undefined) => {
      const n = Number(value ?? 0);
      return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
    },
    formatDate: (value: string | null | undefined) => String(value ?? ''),
    formatMonth: (value: string | null | undefined) => `Month ${String(value ?? '').slice(0, 7)}`,
    dateLocale: 'en-US',
  }),
}));

vi.mock('../components/use-report-export', () => ({
  useReportExport: () => ({ busy: null, exportCsv: vi.fn(), exportPdf: vi.fn() }),
}));

import CashFlowReportPage from './page';

const report: CashFlowReport = {
  period: { from: '2026-01-01', to: '2026-03-31' },
  monthly: [
    { month: '2026-01', inflows: '1000.00', outflows: '-400.00', net: '600.00' },
    { month: '2026-02', inflows: '500.00', outflows: '-900.00', net: '-400.00' },
  ],
  totals: { inflows: '1500.00', outflows: '-1300.00', net: '200.00' },
};

describe('CashFlowReportPage', () => {
  beforeEach(() => {
    reportState.current = { data: report, isLoading: false, isError: false, isFetching: false, refetch: () => Promise.resolve() };
  });

  it('lists the months of the report (monthly, not months) with a running balance', () => {
    render(<CashFlowReportPage />);

    const table = screen.getByRole('table', { name: 'Monthly Breakdown' });
    const rows = within(table).getAllByRole('row');
    // header + 2 months
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('Month 2026-01')).toBeInTheDocument();
    expect(within(rows[1]).getAllByText('$600.00')).toHaveLength(2); // net and running balance
    expect(within(rows[2]).getByText('Month 2026-02')).toBeInTheDocument();
    expect(within(rows[2]).getByText('-$900.00')).toBeInTheDocument();
    expect(within(rows[2]).getByText('-$400.00')).toBeInTheDocument();
    // 600 - 400 = 200 after February.
    expect(within(rows[2]).getByText('$200.00')).toBeInTheDocument();
  });

  it('shows the totals of the period', () => {
    render(<CashFlowReportPage />);
    expect(screen.getByText('Total Inflows')).toBeInTheDocument();
    expect(screen.getByText('$1500.00')).toBeInTheDocument();
    expect(screen.getByText('$200.00', { selector: 'p' })).toBeInTheDocument();
  });

  it('asks for the entity default period and leaves out the basis', () => {
    render(<CashFlowReportPage />);
    expect(lastQuery.current).toEqual({});
    expect(screen.queryByText('Accrual')).not.toBeInTheDocument();
  });

  it('shows the comparison period and the change against it', () => {
    reportState.current = {
      ...reportState.current,
      data: {
        ...report,
        comparison: {
          mode: 'prior_year',
          period: { from: '2025-01-01', to: '2025-03-31' },
          monthly: [{ month: '2025-01', inflows: '700.00', outflows: '-300.00', net: '400.00' }],
          totals: { inflows: '700.00', outflows: '-300.00', net: '400.00' },
          delta: {
            inflows: { amount: '800.00', percent: 114.3 },
            outflows: { amount: '-1000.00', percent: null },
            net: { amount: '-200.00', percent: -50 },
          },
        },
      } satisfies CashFlowReport,
    };
    render(<CashFlowReportPage />);

    expect(screen.getByText('Comparison period 2025-01-01 – 2025-03-31')).toBeInTheDocument();
    expect(screen.getByText('Comparison: $700.00 (+$800.00 (+114.3%))')).toBeInTheDocument();
    // A zero-based change has no percentage.
    expect(screen.getByText('Comparison: -$300.00 (-$1000.00)')).toBeInTheDocument();
  });

  it('shows a retryable error when the report cannot be loaded', () => {
    reportState.current = { ...reportState.current, data: undefined, isError: true };
    render(<CashFlowReportPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the report.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows a loader while the report loads', () => {
    reportState.current = { ...reportState.current, data: undefined, isLoading: true };
    render(<CashFlowReportPage />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
