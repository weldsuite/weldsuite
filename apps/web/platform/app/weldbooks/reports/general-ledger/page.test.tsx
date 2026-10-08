import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GeneralLedgerReport } from '@/lib/weldbooks/report-types';

const mocks = vi.hoisted(() => ({
  search: {} as { accountId?: string; from?: string; to?: string },
  report: { data: undefined as unknown, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() },
  queries: [] as Array<Record<string, unknown>>,
  exportQueries: [] as Array<Record<string, unknown>>,
}));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mocks.search,
  Link: ({ children, to, params, ...rest }: { children: React.ReactNode; to: string; params?: Record<string, string> }) => (
    <a href={params ? to.replace('$id', params.id) : to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_bank', code: '1000', name: 'Bank' },
        { id: 'acc_sales', code: '4000', name: 'Sales' },
      ],
    },
  }),
  useGeneralLedgerReport: (query: Record<string, unknown>) => {
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
    formatMoney: (value: string | number | null | undefined) => {
      const n = Number(value ?? 0);
      return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
    },
    formatDate: (value: string | null | undefined) => String(value ?? '').slice(0, 10),
    formatMonth: (value: string | null | undefined) => String(value ?? ''),
    dateLocale: 'en-US',
  }),
}));
vi.mock('../components/use-report-export', () => ({
  useReportExport: (_name: string, query: Record<string, unknown>) => {
    mocks.exportQueries.push(query);
    return { busy: null, exportCsv: vi.fn(), exportPdf: vi.fn() };
  },
}));

import GeneralLedgerReportPage from './page';

const report: GeneralLedgerReport = {
  basis: 'accrual',
  account: { id: 'acc_bank', code: '1000', name: 'Bank', normalSide: 'debit' },
  period: { from: '2026-01-01', to: '2026-12-31' },
  openingBalance: '100.00',
  closingBalance: '-20.00',
  totalDebit: '300.00',
  totalCredit: '420.00',
  lines: [
    {
      id: 'line_1',
      journalEntryId: 'je_1',
      entryNumber: 'JE-0001',
      entryDate: '2026-02-03T00:00:00.000Z',
      entryStatus: 'posted',
      description: 'Customer payment',
      sourceType: 'payment',
      contactId: null,
      paymentId: null,
      debit: '300.00',
      credit: '0.00',
      runningBalance: '400.00',
    },
    {
      id: 'line_2',
      journalEntryId: null,
      entryNumber: null,
      entryDate: '2026-03-04T00:00:00.000Z',
      entryStatus: 'posted',
      description: null,
      sourceType: null,
      contactId: null,
      paymentId: null,
      debit: '0.00',
      credit: '420.00',
      runningBalance: '-20.00',
    },
  ],
  pagination: { page: 1, pageSize: 50, totalCount: 120, totalPages: 3, hasMore: true },
};

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

describe('GeneralLedgerReportPage', () => {
  beforeEach(() => {
    mocks.search = { accountId: 'acc_bank' };
    mocks.report = { data: report, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
    mocks.queries = [];
    mocks.exportQueries = [];
  });

  it('opens the ledger of the account of a deep link from another report', () => {
    mocks.search = { accountId: 'acc_bank', from: '2026-02-01', to: '2026-03-31' };
    render(<GeneralLedgerReportPage />);

    expect(mocks.queries.at(-1)).toEqual({ from: '2026-02-01', to: '2026-03-31', accountId: 'acc_bank', page: 1, pageSize: 50 });
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveTextContent('1000 — Bank');
    expect(screen.getByLabelText('From')).toHaveValue('2026-02-01');
    expect(screen.getByLabelText('To')).toHaveValue('2026-03-31');
  });

  it('shows the opening balance, the lines with their running balance and the closing balance', () => {
    render(<GeneralLedgerReportPage />);

    const table = screen.getByRole('table', { name: 'Transactions' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Opening Balance', '$100.00']);

    const first = within(rows[2]).getAllByRole('cell').map((c) => c.textContent);
    expect(first).toEqual(['2026-02-03', 'JE-0001', 'Customer payment', '$300.00', '-', '$400.00']);
    expect(within(rows[2]).getByRole('link', { name: 'JE-0001' })).toHaveAttribute('href', '/weldbooks/journal/je_1');

    const second = within(rows[3]).getAllByRole('cell').map((c) => c.textContent);
    expect(second).toEqual(['2026-03-04', '-', '-', '-', '$420.00', '-$20.00']);

    const last = within(rows[rows.length - 1]).getAllByRole('cell').map((c) => c.textContent);
    expect(last).toEqual(['Closing Balance', '$300.00', '$420.00', '-$20.00']);
  });

  it('pages through the lines', async () => {
    const user = userEvent.setup();
    render(<GeneralLedgerReportPage />);

    expect(screen.getByText('Page 1 of 3 (120 lines)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(mocks.queries.at(-1)).toMatchObject({ page: 2 });
  });

  it('goes back to the first page when the period changes, and exports without a page', async () => {
    const user = userEvent.setup();
    render(<GeneralLedgerReportPage />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(mocks.queries.at(-1)).toMatchObject({ page: 2 });

    const from = screen.getByLabelText('From');
    await user.clear(from);
    await user.type(from, '2026-03-01');
    expect(mocks.queries.at(-1)).toMatchObject({ page: 1 });
    expect(mocks.exportQueries.at(-1)).not.toHaveProperty('page');
    expect(mocks.exportQueries.at(-1)).toMatchObject({ accountId: 'acc_bank' });
  });

  it('asks for an account first and does not ask the server without one', () => {
    mocks.search = {};
    mocks.report = { ...mocks.report, data: undefined };
    render(<GeneralLedgerReportPage />);
    expect(screen.getByText('Select an account to see its ledger.')).toBeInTheDocument();
    expect(mocks.queries.at(-1)).toMatchObject({ accountId: '' });
  });

  it('shows a retryable error', () => {
    mocks.report = { ...mocks.report, data: undefined, isError: true };
    render(<GeneralLedgerReportPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the report.');
  });

  it('says when the period has no transactions', () => {
    mocks.report = {
      ...mocks.report,
      data: { ...report, lines: [], pagination: { page: 1, pageSize: 50, totalCount: 0, totalPages: 0, hasMore: false } },
    };
    render(<GeneralLedgerReportPage />);
    expect(screen.getByText('No transactions found for this period.')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 1 (0 lines)')).toBeInTheDocument();
  });
});
