import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CsvImportResult } from '@/lib/api/domains/weldbooks-assets';

const importCsv = vi.fn();
const permissions = new Set(['journal:create']);
let savedMapping: unknown = null;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-02-10',
  }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_bank', code: '1000', name: 'Checking', type: 'asset', isActive: true },
        { id: 'acc_clearing', code: '2100', name: 'Payroll clearing', type: 'liability', isActive: true },
        { id: 'acc_wages', code: '6000', name: 'Wages', type: 'expense', isActive: true },
      ],
    },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-assets-queries', () => ({
  useImportPayrollCsv: () => ({ mutateAsync: importCsv, isPending: false }),
  usePayrollCsvMapping: () => ({ data: savedMapping }),
  usePayrollCategories: () => ({ data: undefined }),
}));

import PayrollImportPage from './page';
import { polyfillRadixSelect, renderWithProviders } from '../../fixed-assets/test-utils';

const CSV = [
  'Pay Date,Gross Wages,Employee Taxes Withheld,Net Pay',
  '01/15/2026,"10,000.00","2,000.00","8,000.00"',
].join('\n');

const dryRun = (debit: number, credit: number): CsvImportResult => ({
  shape: 'summary',
  dryRun: true,
  imports: [
    {
      importId: null,
      payDate: '2026-01-15',
      journalEntryId: null,
      entryNumber: null,
      summary: { gross_wages: 10000, employee_taxes: 2000, net_pay: 8000 },
      totalDebit: debit,
      lines: [
        { accountId: 'acc_wages', debit, credit: 0, description: 'Payroll 2026-01-15: Gross wages' },
        { accountId: 'acc_bank', debit: 0, credit, description: 'Payroll 2026-01-15: Net pay' },
      ],
    },
  ],
  duplicates: [],
  failed: [],
});

async function reachAccounts(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByTestId('payroll-file'), new File([CSV], 'january.csv', { type: 'text/csv' }));
  expect(await screen.findByTestId('shape-continue')).toBeInTheDocument();
  await user.click(screen.getByTestId('shape-continue'));
  await user.click(await screen.findByTestId('columns-continue'));
}

async function chooseNetPayAccount(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('combobox', { name: 'Net pay (bank or payroll clearing)' }));
  await user.click(await screen.findByRole('option', { name: '1000 — Checking' }));
}

describe('Payroll CSV import wizard', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    importCsv.mockReset();
    permissions.clear();
    permissions.add('journal:create');
    savedMapping = null;
  });

  it('reads the file, guesses the shape and columns, and offers the first rows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportPage />);

    await user.upload(screen.getByTestId('payroll-file'), new File([CSV], 'january.csv', { type: 'text/csv' }));

    expect(await screen.findByTestId('file-summary')).toHaveTextContent('january.csv · 1 rows, 4 columns');
    expect(screen.getByRole('radio', { name: /One row per payroll/ })).toBeChecked();
    expect(screen.getByRole('columnheader', { name: 'Gross Wages' })).toBeInTheDocument();

    await user.click(screen.getByTestId('shape-continue'));
    expect(await screen.findByTestId('column-mapping')).toBeInTheDocument();
    expect(screen.getByTestId('column-grossWages')).toHaveTextContent('Gross Wages');
    expect(screen.getByTestId('column-employeeTaxes')).toHaveTextContent('Employee Taxes Withheld');
    expect(screen.getByTestId('column-netPay')).toHaveTextContent('Net Pay');
    expect(screen.getByTestId('column-ownersDraw')).toHaveTextContent('Not in the file');
  });

  it('will not continue until the required columns are chosen', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportPage />);
    await user.upload(screen.getByTestId('payroll-file'), new File(['Date,Memo\n2026-01-01,x'], 'odd.csv', { type: 'text/csv' }));
    await user.click(await screen.findByTestId('shape-continue'));

    expect(screen.getByTestId('columns-continue')).toBeDisabled();
    expect(screen.getByTestId('columns-missing')).toHaveTextContent('Choose a column for: Gross wages, Net pay.');
  });

  it('needs the net pay account before the entries can be checked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportPage />);
    await reachAccounts(user);

    expect(await screen.findByTestId('accounts-continue')).toBeDisabled();
    expect(screen.getByTestId('accounts-missing')).toBeInTheDocument();
    await chooseNetPayAccount(user);
    expect(screen.getByTestId('accounts-continue')).toBeEnabled();
  });

  it('sends the mapping it built for a dry run, and posts nothing', async () => {
    importCsv.mockResolvedValue(dryRun(10000, 10000));
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportPage />);
    await reachAccounts(user);
    await chooseNetPayAccount(user);
    await user.click(screen.getByTestId('accounts-continue'));

    await waitFor(() => expect(importCsv).toHaveBeenCalledTimes(1));
    expect(importCsv).toHaveBeenCalledWith({
      csv: CSV,
      mapping: {
        shape: 'summary',
        dateFormat: 'auto',
        columns: { payDate: 'Pay Date', grossWages: 'Gross Wages', employeeTaxes: 'Employee Taxes Withheld', netPay: 'Net Pay' },
        accounts: { net_pay: 'acc_bank' },
      },
      sourceFileName: 'january.csv',
      dryRun: true,
    });
  });

  it('blocks the import while the dry run does not balance', async () => {
    importCsv.mockResolvedValue(dryRun(10000, 9000));
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportPage />);
    await reachAccounts(user);
    await chooseNetPayAccount(user);
    await user.click(screen.getByTestId('accounts-continue'));

    const review = await screen.findByTestId('dry-run-review');
    expect(within(review).getByTestId('balance-badge')).toHaveTextContent('Does not balance');
    expect(within(review).getByTestId('dry-run-unbalanced')).toHaveTextContent('so the import is blocked');
    expect(within(review).getByTestId('import-payrolls')).toBeDisabled();
    expect(within(review).getByTestId('total-debit')).toHaveTextContent('$10000.00');
    expect(within(review).getByTestId('total-credit')).toHaveTextContent('$9000.00');
    // Only the dry run was sent.
    expect(importCsv).toHaveBeenCalledTimes(1);
  });

  it('imports once the dry run balances, and remembers the mapping', async () => {
    importCsv.mockResolvedValueOnce(dryRun(10000, 10000));
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportPage />);
    await reachAccounts(user);
    await chooseNetPayAccount(user);
    await user.click(screen.getByTestId('accounts-continue'));

    const importButton = await screen.findByTestId('import-payrolls');
    expect(screen.getByTestId('balance-badge')).toHaveTextContent('Balanced');
    expect(importButton).toBeEnabled();

    importCsv.mockResolvedValueOnce({ ...dryRun(10000, 10000), dryRun: false, duplicates: [], imports: [{ ...dryRun(10000, 10000).imports[0]!, importId: 'pri_1' }] });
    await user.click(importButton);

    await waitFor(() => expect(importCsv).toHaveBeenCalledTimes(2));
    expect(importCsv.mock.calls[1]?.[0]).toMatchObject({ dryRun: false, saveMapping: true, sourceFileName: 'january.csv' });
    expect(await screen.findByTestId('import-done')).toHaveTextContent('1 payrolls imported');
  });

  it('lists the problems of a rejected file by row and offers no import', async () => {
    importCsv.mockRejectedValue(
      Object.assign(new Error('The CSV has 1 problem'), {
        body: { error: { details: { problems: [{ row: 3, message: 'The payroll does not balance' }] } } },
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportPage />);
    await reachAccounts(user);
    await chooseNetPayAccount(user);
    await user.click(screen.getByTestId('accounts-continue'));

    const problems = await screen.findByTestId('dry-run-problems');
    expect(problems).toHaveTextContent('1 problems in the file');
    expect(problems).toHaveTextContent('Row 3: The payroll does not balance');
    expect(screen.getByTestId('import-payrolls')).toBeDisabled();
  });

  it('applies a saved mapping whose columns exist in the file', async () => {
    savedMapping = {
      shape: 'summary',
      dateFormat: 'mdy',
      columns: { payDate: 'Pay Date', grossWages: 'Gross Wages', netPay: 'Net Pay' },
      accounts: { net_pay: 'acc_bank' },
    };
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportPage />);
    await user.upload(screen.getByTestId('payroll-file'), new File([CSV], 'january.csv', { type: 'text/csv' }));

    expect(await screen.findByTestId('file-summary')).toHaveTextContent('your saved column mapping fits and was applied');
    await user.click(screen.getByTestId('shape-continue'));
    // The saved mapping has no employee taxes column: it is applied as it was saved.
    expect(await screen.findByTestId('column-employeeTaxes')).toHaveTextContent('Not in the file');
  });

  it('refuses an empty file', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportPage />);
    await user.upload(screen.getByTestId('payroll-file'), new File(['Pay Date,Net Pay\n'], 'empty.csv', { type: 'text/csv' }));
    expect(await screen.findByTestId('file-error')).toHaveTextContent('The file has no rows to import.');
  });

  it('is closed to someone without journal:create', () => {
    permissions.clear();
    renderWithProviders(<PayrollImportPage />);
    expect(screen.getByText('You do not have access to this screen.')).toBeInTheDocument();
  });
});
