import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Account, TaxLineCatalog } from '@/lib/api/domains/weldbooks';

const mocks = vi.hoisted(() => ({
  jurisdiction: { code: 'US' as string | null },
  catalog: { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() },
  accounts: { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() },
  updateAccount: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  canUpdate: true,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params, ...rest }: { children: React.ReactNode; to: string; params?: Record<string, string> }) => (
    <a href={params ? to.replace('$id', params.id) : to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => mocks.canUpdate }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useTaxLineCatalog: () => mocks.catalog,
  useAccountingAccounts: () => mocks.accounts,
  useUpdateAccount: () => ({ mutateAsync: mocks.updateAccount, isPending: false }),
  useApplyTaxLines: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({
    code: mocks.jurisdiction.code,
    entity: { id: 'ent_us' },
    isResolved: true,
  }),
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});
vi.mock('@/app/weldbooks/entities/components/remap-tax-lines-dialog', () => ({
  RemapTaxLinesDialog: ({ open, formLabel }: { open: boolean; formLabel?: string | null }) =>
    open ? <div data-testid="remap-dialog">{formLabel}</div> : null,
}));

import TaxLineMappingPage from './page';

const catalog: TaxLineCatalog = {
  form: 'f1120s',
  formLabel: 'Form 1120-S',
  taxYear: 2026,
  sections: [
    { key: 'income', label: 'Income' },
    { key: 'deduction', label: 'Deductions' },
  ],
  lines: [
    { code: 'f1120s.1a', form: 'f1120s', line: '1a', label: 'Gross receipts or sales', section: 'income' },
    { code: 'f1120s.16', form: 'f1120s', line: '16', label: 'Advertising', section: 'deduction' },
    { code: 'f1120s.17', form: 'f1120s', line: '17', label: 'Pension', section: 'deduction' },
  ],
};

function account(id: string, code: string, name: string, type: string, taxLine: string | null, extra: Partial<Account> = {}): Account {
  return {
    id,
    code,
    name,
    type,
    taxLine,
    description: null,
    subtype: null,
    parentAccountId: null,
    currency: 'USD',
    isActive: true,
    isSystemAccount: false,
    openingBalance: '0',
    currentBalance: '0',
    normalSide: type === 'revenue' ? 'credit' : 'debit',
    ...extra,
  };
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

describe('TaxLineMappingPage', () => {
  beforeEach(() => {
    mocks.jurisdiction.code = 'US';
    mocks.canUpdate = true;
    mocks.catalog = { data: catalog, isLoading: false, isError: false, refetch: vi.fn() };
    mocks.accounts = {
      data: {
        data: [
          account('acc_sales', '4000', 'Sales', 'revenue', 'f1120s.1a'),
          account('acc_ads', '6100', 'Advertising', 'expense', 'f1120s.16'),
          account('acc_misc', '6900', 'Miscellaneous', 'expense', null),
          account('acc_old', '6910', 'Old rent', 'expense', 'sch_c.20b'),
          account('acc_bank', '1000', 'Bank', 'asset', null),
          account('acc_closed', '6999', 'Closed', 'expense', null, { isActive: false }),
        ],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    mocks.updateAccount.mockReset().mockResolvedValue({ data: {} });
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });

  it('describes the return and the tax year', () => {
    render(<TaxLineMappingPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Tax line mapping' })).toBeInTheDocument();
    expect(screen.getByText(/Form 1120-S for tax year 2026/)).toBeInTheDocument();
  });

  it('lists the income and expense accounts without a line, or on a line of another return', () => {
    render(<TaxLineMappingPage />);
    const card = screen.getByText('Accounts without a tax line').closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).getByText('Miscellaneous')).toBeInTheDocument();
    expect(within(card).getByText('Old rent')).toBeInTheDocument();
    // A balance sheet account and an inactive account are not asked about.
    expect(within(card).queryByText('Bank')).not.toBeInTheDocument();
    expect(within(card).queryByText('Closed')).not.toBeInTheDocument();
  });

  it('groups accounts under the line they report on and hides lines without accounts', () => {
    render(<TaxLineMappingPage />);
    expect(screen.getByRole('heading', { name: '1a · Gross receipts or sales' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '16 · Advertising' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '17 · Pension' })).not.toBeInTheDocument();
  });

  it('shows lines without accounts on request', async () => {
    const user = userEvent.setup();
    render(<TaxLineMappingPage />);
    await user.click(screen.getByRole('checkbox', { name: 'Show lines without accounts' }));
    expect(screen.getByRole('heading', { name: '17 · Pension' })).toBeInTheDocument();
    expect(screen.getByText('No accounts on this line')).toBeInTheDocument();
  });

  it('reassigns an account to another line', async () => {
    const user = userEvent.setup();
    render(<TaxLineMappingPage />);

    await user.click(screen.getByRole('combobox', { name: 'Change tax line: 6900 Miscellaneous' }));
    await user.click(await screen.findByRole('option', { name: '17 · Pension' }));

    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledWith({ id: 'acc_misc', data: { taxLine: 'f1120s.17' } }));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Tax line updated');
  });

  it('clears the line of an account', async () => {
    const user = userEvent.setup();
    render(<TaxLineMappingPage />);

    await user.click(screen.getByRole('combobox', { name: 'Change tax line: 6100 Advertising' }));
    await user.click(await screen.findByRole('option', { name: 'No tax line' }));

    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledWith({ id: 'acc_ads', data: { taxLine: null } }));
  });

  it('reports a failed change', async () => {
    const user = userEvent.setup();
    mocks.updateAccount.mockRejectedValue(new Error("'f1120s.17' is not a line of Form 1120-S"));
    render(<TaxLineMappingPage />);
    await user.click(screen.getByRole('combobox', { name: 'Change tax line: 6900 Miscellaneous' }));
    await user.click(await screen.findByRole('option', { name: '17 · Pension' }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Could not update the tax line', {
        description: "'f1120s.17' is not a line of Form 1120-S",
      }),
    );
  });

  it('is read-only without permission to update accounts', () => {
    mocks.canUpdate = false;
    render(<TaxLineMappingPage />);
    expect(screen.getByRole('combobox', { name: 'Change tax line: 6900 Miscellaneous' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Apply default mapping' })).not.toBeInTheDocument();
    expect(screen.getByText(/you need permission to update accounts to change it/)).toBeInTheDocument();
  });

  it('opens the default mapping dialog for the current return', async () => {
    const user = userEvent.setup();
    render(<TaxLineMappingPage />);
    await user.click(screen.getByRole('button', { name: 'Apply default mapping' }));
    expect(screen.getByTestId('remap-dialog')).toHaveTextContent('Form 1120-S');
  });

  it('says so when every account has a line', () => {
    mocks.accounts = {
      ...mocks.accounts,
      data: { data: [account('acc_sales', '4000', 'Sales', 'revenue', 'f1120s.1a')] },
    };
    render(<TaxLineMappingPage />);
    expect(screen.getByText('Every income and expense account has a tax line.')).toBeInTheDocument();
  });

  it('is for US entities only', () => {
    mocks.jurisdiction.code = 'NL';
    render(<TaxLineMappingPage />);
    expect(screen.getByText('Tax lines are available for US entities only.')).toBeInTheDocument();
  });

  it('shows a retryable error', async () => {
    const user = userEvent.setup();
    mocks.catalog = { ...mocks.catalog, data: undefined, isError: true };
    render(<TaxLineMappingPage />);
    expect(screen.getByText('Could not load the tax line mapping.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.catalog.refetch).toHaveBeenCalled();
  });
});
