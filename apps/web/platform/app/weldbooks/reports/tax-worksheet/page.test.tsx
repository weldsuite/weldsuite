import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaxWorksheet } from '@/lib/weldbooks/report-types';

const state = vi.hoisted(() => ({
  jurisdiction: { code: 'US' as string | null },
  report: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve(),
  },
  calls: [] as Array<{ query: unknown; options: unknown }>,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params, ...rest }: { children: React.ReactNode; to: string; params?: Record<string, string> }) => (
    <a href={params ? to.replace('$id', params.id) : to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useTaxWorksheetReport: (query: unknown, options: unknown) => {
    state.calls.push({ query, options });
    return state.report;
  },
  useDimensionValues: () => ({ data: [] }),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({
    code: state.jurisdiction.code,
    entity: { id: 'ent_us', fiscalYearStart: 1, fiscalYearConfig: null },
    isResolved: true,
  }),
}));

vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: string | number | null | undefined) => {
      const n = Number(value ?? 0);
      return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
    },
    formatDate: (value: string | null | undefined) => String(value ?? ''),
    formatMonth: (value: string | null | undefined) => String(value ?? ''),
    dateLocale: 'en-US',
  }),
}));

vi.mock('../components/use-report-export', () => ({
  useReportExport: () => ({ busy: null, exportCsv: vi.fn(), exportPdf: vi.fn() }),
}));

import TaxWorksheetPage from './page';

const worksheet: TaxWorksheet = {
  form: 'f1120s',
  formLabel: 'Form 1120-S',
  taxYear: 2026,
  basis: 'accrual',
  period: { from: '2026-01-01', to: '2026-12-31' },
  entity: { id: 'ent_us', name: 'Acme', legalName: 'Acme LLC', entityType: 'single_member_llc', taxClassification: 's_corp' },
  sections: [
    {
      key: 'income',
      label: 'Income',
      total: '1000.00',
      lines: [
        {
          code: 'f1120s.1a',
          line: '1a',
          label: 'Gross receipts or sales',
          section: 'income',
          side: 'credit',
          amount: '1000.00',
          accounts: [{ accountId: 'acc_sales', code: '4000', name: 'Sales', type: 'revenue', amount: '1000.00' }],
        },
      ],
    },
    {
      key: 'deduction',
      label: 'Deductions',
      total: '400.00',
      lines: [
        {
          code: 'f1120s.meals',
          line: '19',
          label: 'Other deductions: meals',
          section: 'deduction',
          side: 'debit',
          amount: '400.00',
          deductiblePercent: 50,
          deductibleAmount: '200.00',
          nonDeductibleAmount: '200.00',
          nonDeductibleLine: 'Sch K 16c',
          accounts: [{ accountId: 'acc_meals', code: '6200', name: 'Meals', type: 'expense', amount: '400.00' }],
        },
      ],
    },
    {
      key: 'balance_sheet',
      label: 'Balance sheet (Schedule L)',
      total: null,
      lines: [
        {
          code: 'f1120s.L1',
          line: 'L1',
          label: 'Cash',
          section: 'balance_sheet',
          side: 'debit',
          amount: '900.00',
          beginningAmount: '500.00',
          accounts: [],
        },
      ],
    },
  ],
  unmapped: [
    { accountId: 'acc_misc', code: '6900', name: 'Miscellaneous', type: 'expense', taxLine: null, reason: 'none', amount: '50.00' },
    { accountId: 'acc_old', code: '6910', name: 'Old rent', type: 'expense', taxLine: 'sch_c.20b', reason: 'other_form', amount: '25.00' },
  ],
  summary: {
    netIncomePerBooks: '525.00',
    totalIncome: '1000.00',
    totalOtherIncome: '0.00',
    totalCostOfGoodsSold: '0.00',
    totalDeductions: '400.00',
    netIncomeFromLines: '600.00',
    notDeductibleTotal: '200.00',
    unmappedNetIncome: '-75.00',
    reconciles: true,
  },
};

describe('TaxWorksheetPage', () => {
  beforeEach(() => {
    state.jurisdiction.code = 'US';
    state.calls = [];
    state.report = { data: worksheet, isLoading: false, isError: false, isFetching: false, refetch: () => Promise.resolve() };
  });

  it('groups the lines by section with the section totals', () => {
    render(<TaxWorksheetPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Tax return worksheet' })).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Income' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Deductions' })).toBeInTheDocument();
    expect(screen.getByText('Gross receipts or sales')).toBeInTheDocument();
    // The section total sits next to its heading; a section that mixes assets and liabilities has none.
    expect(screen.getByText('$1000.00', { selector: 'span.font-semibold' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Balance sheet (Schedule L)' })).toBeInTheDocument();
  });

  it('shows the accounts behind a line once it is expanded, linked to the account', async () => {
    const user = userEvent.setup();
    render(<TaxWorksheetPage />);

    expect(screen.queryByRole('link', { name: /Sales/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Gross receipts or sales/ }));

    const link = screen.getByRole('link', { name: /Sales/ });
    expect(link).toHaveAttribute('href', '/weldbooks/accounts/acc_sales');
    expect(screen.getByRole('button', { name: /Gross receipts or sales/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('explains the deductible share of a partly deductible line', () => {
    render(<TaxWorksheetPage />);
    expect(
      screen.getByText('50% deductible: $200.00 deductible, $200.00 not. The rest goes on line Sch K 16c.'),
    ).toBeInTheDocument();
  });

  it('shows the beginning of year amount of a balance sheet line', () => {
    render(<TaxWorksheetPage />);
    expect(screen.getByText('Beginning of year: $500.00')).toBeInTheDocument();
  });

  it('calls out unmapped accounts with a link to the mapping view', () => {
    render(<TaxWorksheetPage />);
    const callout = screen.getByRole('region', { name: /Accounts without a line on this return \(2\)/ });
    expect(within(callout).getByText('Miscellaneous')).toBeInTheDocument();
    expect(within(callout).getByText('No tax line')).toBeInTheDocument();
    expect(within(callout).getByText('Line of another return')).toBeInTheDocument();
    expect(within(callout).getByRole('link', { name: 'Map accounts' })).toHaveAttribute('href', '/weldbooks/accounts/tax-lines');
    expect(callout).toHaveTextContent('Form 1120-S');
  });

  it('leaves the callout out when every account is mapped', () => {
    state.report = { ...state.report, data: { ...worksheet, unmapped: [] } };
    render(<TaxWorksheetPage />);
    expect(screen.queryByText(/Accounts without a line on this return/)).not.toBeInTheDocument();
  });

  it('shows whether the worksheet reconciles with the books', () => {
    const { unmount } = render(<TaxWorksheetPage />);
    expect(screen.getByText('Reconciles')).toBeInTheDocument();
    unmount();

    state.report = { ...state.report, data: { ...worksheet, summary: { ...worksheet.summary, reconciles: false } } };
    render(<TaxWorksheetPage />);
    expect(screen.getByText('Does not reconcile')).toBeInTheDocument();
    expect(screen.getByText('Net income per books')).toBeInTheDocument();
  });

  it('asks for accounts without activity only when told to', async () => {
    const user = userEvent.setup();
    render(<TaxWorksheetPage />);
    expect(state.calls.at(-1)?.query).toEqual({});

    await user.click(screen.getByRole('checkbox', { name: 'Include accounts with no activity' }));
    expect(state.calls.at(-1)?.query).toEqual({ includeZero: true });
  });

  it('is for US entities only', () => {
    state.jurisdiction.code = 'NL';
    state.report = { ...state.report, data: undefined };
    render(<TaxWorksheetPage />);

    expect(screen.getByText('The tax return worksheet is available for US entities.')).toBeInTheDocument();
    expect(state.calls.every((call) => (call.options as { enabled?: boolean }).enabled === false)).toBe(true);
  });

  it('shows a retryable error when the worksheet cannot be loaded', () => {
    state.report = { ...state.report, data: undefined, isError: true };
    render(<TaxWorksheetPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the report.');
  });
});
