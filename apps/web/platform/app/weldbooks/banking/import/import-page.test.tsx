import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CsvFormat,
  CsvFormatProposal,
  ImportPreview,
  ImportPreviewInput,
  ImportStatementResult,
  UsBankAccount,
} from '@/lib/api/domains/weldbooks-banking';

const FILE_TEXT = [
  'Date,Description,Amount,Check #',
  '01/05/2026,Coffee,-4.50,',
  '01/06/2026,Refund,10.00,1042',
].join('\n');

const PROPOSAL: CsvFormatProposal = {
  format: {
    dateFormat: 'MDY',
    decimalSeparator: '.',
    thousandsSeparator: ',',
    negativeStyle: 'minus',
    columns: { date: 'Date', description: 'Description', amount: 'Amount', checkNumber: 'Check #' },
    hasHeader: true,
    skipRows: 0,
    delimiter: ',',
  },
  headers: ['Date', 'Description', 'Amount', 'Check #'],
  sampleRows: [],
  dateOrderAmbiguous: false,
  warnings: [],
};

const PARSED: ImportPreview = {
  format: 'csv',
  needsCsvFormat: false,
  proposal: PROPOSAL,
  currency: 'USD',
  dateRange: { from: '2026-01-05', to: '2026-01-06' },
  totalParsed: 2,
  duplicates: 0,
  problem: null,
  errors: [],
  sample: [
    { date: '2026-01-05', description: 'Coffee', amount: -4.5 },
    { date: '2026-01-06', description: 'Refund', amount: 10, checkNumber: '1042' },
  ],
};

const RESULT: ImportStatementResult = {
  batchId: 'bib_1',
  format: 'csv',
  totalParsed: 2,
  imported: 2,
  duplicates: 0,
  autoReconciled: 1,
  errors: [],
  dateRange: { from: '2026-01-05', to: '2026-01-06' },
  closingBalance: 5.5,
  currency: 'USD',
  csvFormatRemembered: true,
  warning: null,
};

const account = (overrides: Partial<UsBankAccount> = {}) =>
  ({ id: 'ba_1', name: 'Operating', iban: null, bankName: null, currentBalance: '0', currency: 'USD', isActive: true, accountType: 'checking', accountNumberLast4: '7890', ...overrides }) as UsBankAccount;

const state = {
  accounts: [account()],
  previewInputs: [] as Array<ImportPreviewInput | null>,
  preview: (input: ImportPreviewInput | null): ImportPreview | undefined => {
    if (!input) return undefined;
    return input.csvFormat ? PARSED : { format: 'csv', needsCsvFormat: true, proposal: PROPOSAL };
  },
};
const importMutate = vi.fn();
let importState: { isPending: boolean; isError: boolean; error: Error | null };
const permissions = new Set(['banking:create']);

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: 'US' }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
  }),
}));
vi.mock('@/lib/read-text-file', () => ({ readTextFile: () => Promise.resolve(FILE_TEXT) }));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankAccounts: () => ({ data: { data: state.accounts }, isLoading: false }),
  useBankImportPreview: (input: ImportPreviewInput | null) => {
    state.previewInputs.push(input);
    const data = state.preview(input);
    return { data, isPending: input !== null && !data, isFetching: false, isError: false, error: null, isPlaceholderData: false };
  },
  useImportBankStatement: () => ({ mutate: importMutate, reset: vi.fn(), ...importState }),
}));

import BankImportPage from './page';
import { polyfillRadixSelect, renderWithProviders } from '../components/test-utils';

const lastInput = () => state.previewInputs.filter((i): i is ImportPreviewInput => i !== null).at(-1);

async function pickAccountAndFile() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId('import-account'));
  await user.click(await screen.findByRole('option', { name: /Operating/ }));
  const file = new File([FILE_TEXT], 'chase.csv', { type: 'text/csv' });
  fireEvent.change(screen.getByTestId('bank-file-input'), { target: { files: [file] } });
  return user;
}

describe('Bank statement import page', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    state.accounts = [account()];
    state.previewInputs = [];
    state.preview = (input) => {
      if (!input) return undefined;
      return input.csvFormat ? PARSED : { format: 'csv', needsCsvFormat: true, proposal: PROPOSAL };
    };
    importMutate.mockReset();
    importState = { isPending: false, isError: false, error: null };
    permissions.clear();
    permissions.add('banking:create');
  });

  it('shows the CSV format editor, prefilled from the proposal, when the layout is unknown', async () => {
    renderWithProviders(<BankImportPage />);
    await pickAccountAndFile();

    expect(await screen.findByTestId('csv-format-editor')).toBeInTheDocument();
    await waitFor(() => expect(lastInput()?.csvFormat).toEqual(PROPOSAL.format));
    expect(screen.getByTestId('csv-date-order')).toHaveTextContent('Month / day / year');
    expect(screen.getByTestId('csv-column-amount')).toHaveTextContent('3. Amount');
    expect(screen.getByTestId('csv-column-checkNumber')).toHaveTextContent('4. Check #');
    // The preview of the file under that layout is shown.
    const preview = await screen.findByTestId('import-preview');
    expect(within(preview).getByText('Coffee')).toBeInTheDocument();
  });

  it('re-reads the file with the edited layout', async () => {
    renderWithProviders(<BankImportPage />);
    const user = await pickAccountAndFile();
    await screen.findByTestId('csv-format-editor');

    await user.click(screen.getByTestId('csv-negative-style'));
    await user.click(await screen.findByRole('option', { name: 'Parentheses ((123.45))' }));

    await waitFor(() => expect(lastInput()?.csvFormat?.negativeStyle).toBe('parentheses'));
    expect(lastInput()).toMatchObject({ bankAccountId: 'ba_1', fileName: 'chase.csv', content: FILE_TEXT });
  });

  it('imports with the confirmed layout and remembers it for the account', async () => {
    renderWithProviders(<BankImportPage />);
    const user = await pickAccountAndFile();
    await screen.findByTestId('import-preview');

    await user.click(screen.getByTestId('import-statement'));
    expect(importMutate).toHaveBeenCalledTimes(1);
    expect(importMutate.mock.calls[0][0]).toEqual({
      bankAccountId: 'ba_1',
      fileName: 'chase.csv',
      content: FILE_TEXT,
      csvFormat: PROPOSAL.format,
      rememberCsvFormat: true,
    });
  });

  it('does not remember the layout when asked not to', async () => {
    renderWithProviders(<BankImportPage />);
    const user = await pickAccountAndFile();
    await screen.findByTestId('import-preview');

    await user.click(screen.getByTestId('csv-remember'));
    await user.click(screen.getByTestId('import-statement'));
    expect(importMutate.mock.calls[0][0]).toMatchObject({ rememberCsvFormat: false });
  });

  it('holds the import until an ambiguous date order is confirmed', async () => {
    state.preview = (input) =>
      input ? (input.csvFormat ? PARSED : { format: 'csv', needsCsvFormat: true, proposal: { ...PROPOSAL, dateOrderAmbiguous: true, warnings: ['Every date could be month-first or day-first; confirm the order'] } }) : undefined;
    renderWithProviders(<BankImportPage />);
    const user = await pickAccountAndFile();
    await screen.findByTestId('import-preview');

    expect(screen.getByText('Check the date order')).toBeInTheDocument();
    expect(screen.getByTestId('import-statement')).toBeDisabled();
    await user.click(screen.getByTestId('csv-confirm-date-order'));
    expect(screen.getByTestId('import-statement')).toBeEnabled();
  });

  it('asks before importing a file that belongs to another account, then imports anyway', async () => {
    const problem = {
      code: 'ACCOUNT_MISMATCH' as const,
      message: 'server text',
      details: { fileAccountLast4: '1111', bankAccountLast4: '7890' },
    };
    state.preview = (input) => (input ? { ...PARSED, format: 'ofx', needsCsvFormat: false, proposal: undefined, problem, account: { accountNumberLast4: '1111' } } : undefined);
    renderWithProviders(<BankImportPage />);
    const user = await pickAccountAndFile();
    expect(await screen.findByTestId('import-problem')).toHaveTextContent('account ending 1111, but this bank account ends in 7890');

    await user.click(screen.getByTestId('import-statement'));
    expect(importMutate).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This file may belong to another account');

    await user.click(screen.getByRole('button', { name: 'Import anyway' }));
    expect(importMutate.mock.calls[0][0]).toEqual({
      bankAccountId: 'ba_1',
      fileName: 'chase.csv',
      content: FILE_TEXT,
      ignoreAccountMismatch: true,
    });
  });

  it('opens the same confirmation when the server answers 409 on import', async () => {
    state.preview = (input) => (input ? { ...PARSED, format: 'qbo', needsCsvFormat: false, proposal: undefined } : undefined);
    renderWithProviders(<BankImportPage />);
    const user = await pickAccountAndFile();
    await screen.findByTestId('import-preview');

    await user.click(screen.getByTestId('import-statement'));
    const options = importMutate.mock.calls[0][1] as { onError: (err: unknown) => void };
    const conflict = Object.assign(new Error('This file is in EUR'), {
      status: 409,
      code: 'CURRENCY_MISMATCH',
      body: { error: { code: 'CURRENCY_MISMATCH', details: { fileCurrency: 'EUR', bankAccountCurrency: 'USD' } } },
    });
    options.onError(conflict);

    expect(await screen.findByRole('dialog')).toHaveTextContent('This file is in EUR, but this bank account is in USD.');
  });

  it('shows what was imported, duplicates, auto-reconciled lines and read errors', async () => {
    renderWithProviders(<BankImportPage />);
    const user = await pickAccountAndFile();
    await screen.findByTestId('import-preview');
    await user.click(screen.getByTestId('import-statement'));

    const options = importMutate.mock.calls[0][1] as { onSuccess: (result: ImportStatementResult) => void };
    options.onSuccess({ ...RESULT, duplicates: 3, errors: [{ line: 7, message: 'Unreadable date "n/a"' }] });

    expect(await screen.findByTestId('import-result')).toBeInTheDocument();
    expect(screen.getByTestId('result-imported')).toHaveTextContent('2');
    expect(screen.getByTestId('result-duplicates')).toHaveTextContent('3');
    expect(screen.getByTestId('result-auto-reconciled')).toHaveTextContent('1');
    expect(screen.getByText('Line 7: Unreadable date "n/a"')).toBeInTheDocument();
    expect(screen.getByText(/CSV layout is saved/)).toBeInTheDocument();
  });

  it('does not offer an import without permission or without lines in the file', async () => {
    permissions.clear();
    renderWithProviders(<BankImportPage />);
    await pickAccountAndFile();
    await screen.findByTestId('import-preview');
    expect(screen.getByTestId('import-statement')).toBeDisabled();
    expect(screen.getByText('You need permission to import bank statements.')).toBeInTheDocument();
  });

  it('keeps the import disabled when the file holds no lines', async () => {
    state.preview = (input) => (input ? { ...PARSED, totalParsed: 0, sample: [] } : undefined);
    renderWithProviders(<BankImportPage />);
    await pickAccountAndFile();
    expect(await screen.findByTestId('import-nothing')).toBeInTheDocument();
    expect(screen.getByTestId('import-statement')).toBeDisabled();
  });

  it('reviews a remembered layout on request', async () => {
    const remembered: CsvFormat = { ...PROPOSAL.format, columns: { ...PROPOSAL.format.columns, description: 'Description' } };
    state.accounts = [account({ importSettings: { csv: remembered } })];
    state.preview = (input) => (input ? { ...PARSED, proposal: undefined } : undefined);
    renderWithProviders(<BankImportPage />);
    const user = await pickAccountAndFile();

    expect(await screen.findByText(/saved CSV layout/)).toBeInTheDocument();
    expect(screen.queryByTestId('csv-format-editor')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('review-csv-layout'));
    expect(await screen.findByTestId('csv-format-editor')).toBeInTheDocument();
    expect(screen.getByTestId('csv-column-description')).toHaveTextContent('2. Description');
  });
});
