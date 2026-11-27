import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PaymentBatch } from '@/lib/api/domains/weldbooks-receipts';

const env = vi.hoisted(() => ({
  available: true,
  permissions: new Set<string>(['banking:create', 'banking:manage']),
  bills: undefined as unknown,
  billsError: false,
  pending: new Map<string, { batchId: string; executionDate: string }>(),
  accounts: [] as unknown[],
  ibans: {} as Record<string, string | null>,
  batches: [] as unknown[],
  create: vi.fn(),
  createError: undefined as unknown,
  createResult: undefined as unknown,
  cancel: vi.fn(),
  download: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => env.permissions.has(permission) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: env.toastError } }));
vi.mock('@/components/object-panel', () => ({ useObjectPanelUrlSync: vi.fn() }));
vi.mock('@/components/edition-unavailable-page', () => ({ EditionUnavailablePage: () => <div data-testid="unavailable" /> }));
vi.mock('@/components/object-panel/record-link', () => ({
  RecordLink: ({ type, id, label }: { type: string; id: string; label: string }) => (
    <a href={`#${type}:${id}`} data-testid={`link-${type}-${id}`}>
      {label}
    </a>
  ),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: string | number) => `€${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-11-27',
  }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-accounting-queries')>()),
  useAccountingBankAccounts: () => ({ data: { data: env.accounts } }),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({
  accountingApi: {
    getCustomer: (id: string) => Promise.resolve({ data: { id, iban: env.ibans[id] ?? null } }),
  },
}));
vi.mock('./download-batch-file', () => ({ downloadBatchFile: (...args: unknown[]) => env.download(...args) }));
vi.mock('@/hooks/queries/use-weldbooks-receipts-queries', () => ({
  isSepaBatchesAvailable: () => env.available,
  usePayableEurBills: () => ({ data: env.billsError ? undefined : env.bills, isError: env.billsError, refetch: vi.fn() }),
  usePendingBillMap: () => env.pending,
  useCreatePaymentBatch: () => ({
    mutate: (vars: unknown, options: { onSuccess?: (batch: unknown) => void }) => {
      env.create(vars);
      if (!env.createError) options.onSuccess?.(env.createResult);
    },
    isPending: false,
    isError: Boolean(env.createError),
    error: env.createError ?? null,
  }),
  usePaymentBatches: () => ({ data: { data: env.batches }, isError: false, refetch: vi.fn() }),
  useCancelPaymentBatch: () => ({
    mutateAsync: async (id: string) => {
      env.cancel(id);
    },
    isPending: false,
  }),
}));

import { polyfillRadixSelect, renderWithProviders } from '../../invoices/components/test-utils';
import PayBillsPage, { payableAccounts } from './page';

function bill(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    billNumber: `INK-${id}`,
    contactId: `sup_${id}`,
    contactName: `Supplier ${id}`,
    dueDate: '2026-12-01',
    balanceDue: '100.00',
    currency: 'EUR',
    status: 'approved',
    externalReference: null,
    ...overrides,
  };
}

function batch(overrides: Partial<PaymentBatch> = {}): PaymentBatch {
  return {
    id: 'batch_1',
    status: 'exported',
    bankAccountId: 'ba_1',
    bankAccountName: 'ING Business',
    executionDate: '2026-12-01',
    totalAmount: '300.00',
    paymentCount: 2,
    billCount: 2,
    paidBillCount: 0,
    heldCount: 0,
    fileName: 'sepa-2026-12-01.xml',
    fileGeneratedAt: '2026-11-27T10:00:00Z',
    createdBy: 'usr_1',
    createdAt: '2026-11-27T10:00:00Z',
    bills: [
      { billId: 'b1', billNumber: 'INK-b1', externalReference: null, partyId: 'p1', contactName: 'Supplier b1', iban: 'NL91ABNA0417164300', amount: '100.00', remittance: 'INK-b1', billStatus: 'approved', balanceDue: '100.00', paid: false },
      { billId: 'b2', billNumber: 'INK-b2', externalReference: null, partyId: 'p2', contactName: 'Supplier b2', iban: 'NL20INGB0001234567', amount: '200.00', remittance: 'INK-b2', billStatus: 'paid', balanceDue: '0.00', paid: true },
    ],
    held: [],
    ...overrides,
  };
}

async function pickAccount(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox', { name: 'Pay from' }));
  await user.click(await screen.findByRole('option', { name: /ING Business/ }));
}

beforeEach(() => {
  polyfillRadixSelect();
  env.available = true;
  env.permissions = new Set(['banking:create', 'banking:manage']);
  env.bills = [bill('b1'), bill('b2', { balanceDue: '200.00', dueDate: '2026-12-05' }), bill('b3', { balanceDue: '50.50' })];
  env.billsError = false;
  env.pending = new Map();
  env.accounts = [
    { id: 'ba_1', name: 'ING Business', iban: 'NL91ABNA0417164300', currency: 'EUR', isActive: true },
    { id: 'ba_usd', name: 'Dollars', iban: 'NL00USD', currency: 'USD', isActive: true },
    { id: 'ba_cash', name: 'Cash', iban: null, currency: 'EUR', isActive: true },
  ];
  env.ibans = { sup_b1: 'NL91ABNA0417164300', sup_b2: 'NL20INGB0001234567', sup_b3: null };
  env.batches = [];
  env.createError = undefined;
  env.createResult = batch();
  for (const fn of [env.create, env.cancel, env.download, env.toastError]) fn.mockReset();
});

describe('payableAccounts', () => {
  it('offers active euro accounts that have an IBAN', () => {
    expect(
      payableAccounts([
        { id: 'a', iban: 'NL1', currency: 'EUR', isActive: true },
        { id: 'b', iban: 'NL2', currency: 'USD', isActive: true },
        { id: 'c', iban: null, currency: 'EUR', isActive: true },
        { id: 'd', iban: 'NL4', currency: 'EUR', isActive: false },
      ] as never[]).map((account) => account.id),
    ).toEqual(['a']);
  });
});

describe('Pay bills: choosing the bills', () => {
  it('lists the open euro bills with due date, supplier, a masked IBAN and the balance', async () => {
    renderWithProviders(<PayBillsPage />);

    const row = screen.getByTestId('pay-row-b1');
    expect(within(row).getByText('2026-12-01')).toBeInTheDocument();
    expect(within(row).getByTestId('link-weldbooks_contact-sup_b1')).toHaveTextContent('Supplier b1');
    expect(within(row).getByTestId('link-bill-b1')).toHaveTextContent('INK-b1');
    expect(within(row).getByText('€100.00')).toBeInTheDocument();
    // The account number is never shown whole.
    expect(await within(row).findByText('NL91 •••• 4300')).toBeInTheDocument();
    expect(screen.queryByText(/NL91ABNA0417164300/)).not.toBeInTheDocument();
    expect(await within(screen.getByTestId('pay-row-b3')).findByText('No IBAN')).toBeInTheDocument();
  });

  it('keeps a running total of the picked bills and counts them', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayBillsPage />);

    expect(screen.getByTestId('pay-total')).toHaveTextContent('0 bills selected');
    await user.click(screen.getByRole('checkbox', { name: 'Select bill INK-b1' }));
    expect(screen.getByTestId('pay-total')).toHaveTextContent('1 bill selected · Total to pay €100.00');
    await user.click(screen.getByRole('checkbox', { name: 'Select bill INK-b2' }));
    expect(screen.getByTestId('pay-total')).toHaveTextContent('2 bills selected · Total to pay €300.00');
    await user.click(screen.getByRole('checkbox', { name: 'Select bill INK-b1' }));
    expect(screen.getByTestId('pay-total')).toHaveTextContent('1 bill selected · Total to pay €200.00');
  });

  it('selects every bill from the header', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayBillsPage />);

    await user.click(screen.getByRole('checkbox', { name: 'Select all bills' }));
    expect(screen.getByTestId('pay-total')).toHaveTextContent('3 bills selected · Total to pay €350.50');
    await user.click(screen.getByRole('checkbox', { name: 'Select all bills' }));
    expect(screen.getByTestId('pay-total')).toHaveTextContent('0 bills selected');
  });

  it('marks a bill already in an exported file as pending and does not let it be picked again', async () => {
    const user = userEvent.setup();
    env.pending = new Map([['b1', { batchId: 'batch_0', executionDate: '2026-12-01' }]]);
    renderWithProviders(<PayBillsPage />);

    const row = screen.getByTestId('pay-row-b1');
    expect(within(row).getByText('Payment pending')).toBeInTheDocument();
    expect(within(row).getByRole('checkbox')).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select all bills' }));
    expect(screen.getByTestId('pay-total')).toHaveTextContent('2 bills selected · Total to pay €250.50');
  });

  it('offers the euro accounts with an IBAN, and the date defaults to today', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayBillsPage />);

    expect(screen.getByLabelText('Execution date')).toHaveValue('2026-11-27');
    await user.click(screen.getByRole('combobox', { name: 'Pay from' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['ING Business (NL91 •••• 4300)']);
  });

  it('shows an empty state, an error with retry, and no page for an edition without SEPA files', () => {
    env.bills = [];
    const { unmount } = renderWithProviders(<PayBillsPage />);
    expect(screen.getByText('No bills to pay')).toBeInTheDocument();
    unmount();

    env.billsError = true;
    const second = renderWithProviders(<PayBillsPage />);
    expect(screen.getByText('The bills could not be loaded.')).toBeInTheDocument();
    second.unmount();

    env.available = false;
    renderWithProviders(<PayBillsPage />);
    expect(screen.getByTestId('unavailable')).toBeInTheDocument();
  });
});

describe('Pay bills: making the file', () => {
  it('creates the batch with the picks, the account and the date, then offers the download with its explanation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayBillsPage />);

    expect(screen.getByTestId('batch-create')).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select bill INK-b1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select bill INK-b2' }));
    await pickAccount(user);
    await user.click(screen.getByTestId('batch-create'));

    expect(env.create).toHaveBeenCalledWith({ bankAccountId: 'ba_1', billIds: ['b1', 'b2'], executionDate: '2026-11-27' });
    const created = screen.getByTestId('batch-created');
    expect(created).toHaveTextContent('2 payments, €300.00 in total, to be executed on 2026-12-01.');
    expect(within(created).getByText('Upload this file in your bank’s business portal.')).toBeInTheDocument();

    await user.click(within(created).getByTestId('batch-download'));
    expect(env.download).toHaveBeenCalledWith(expect.objectContaining({ id: 'batch_1' }));
  });

  it('lists the suppliers that were held back, in plain words', async () => {
    const user = userEvent.setup();
    env.createResult = batch({
      heldCount: 2,
      held: [
        { partyId: 'p3', contactName: 'Supplier b3', code: 'NO_IBAN', message: 'Supplier has no IBAN' },
        { partyId: 'p4', contactName: 'Supplier b4', code: 'SOMETHING_NEW', message: 'Held for review by the bank' },
      ],
    });
    renderWithProviders(<PayBillsPage />);

    await user.click(screen.getByRole('checkbox', { name: 'Select bill INK-b1' }));
    await pickAccount(user);
    await user.click(screen.getByTestId('batch-create'));

    const held = screen.getByTestId('batch-held');
    expect(within(held).getByText('Left out of the file')).toBeInTheDocument();
    expect(held).toHaveTextContent('Supplier b3: The supplier has no IBAN. Add it to the contact.');
    expect(held).toHaveTextContent('Supplier b4: Held for review by the bank');
  });

  it.each([
    ['EXECUTION_DATE_PAST', 'The execution date is in the past. Choose today or later.'],
    ['NOT_EUR', 'SEPA payments are in euros. Choose a euro bank account.'],
    ['BILL_IN_OTHER_RUN', 'A selected bill is already in another payment run.'],
    ['ALL_HELD', 'Every bill was left out, so there is nothing to pay. See the reasons below.'],
    ['NEVER_SEEN', 'The SEPA file could not be created.'],
  ])('translates the refusal %s', async (code, text) => {
    const user = userEvent.setup();
    env.createError = Object.assign(new Error(`raw ${code}`), { code });
    renderWithProviders(<PayBillsPage />);

    await user.click(screen.getByRole('checkbox', { name: 'Select bill INK-b1' }));
    await pickAccount(user);
    await user.click(screen.getByTestId('batch-create'));

    expect(screen.getByTestId('batch-error')).toHaveTextContent(text);
    expect(screen.getByTestId('batch-error')).not.toHaveTextContent(code);
  });

  it('says when the file cannot be downloaded', async () => {
    const user = userEvent.setup();
    env.download.mockRejectedValue(new Error('boom'));
    renderWithProviders(<PayBillsPage />);

    await user.click(screen.getByRole('checkbox', { name: 'Select bill INK-b1' }));
    await pickAccount(user);
    await user.click(screen.getByTestId('batch-create'));
    await user.click(screen.getByTestId('batch-download'));

    await waitFor(() => expect(env.toastError).toHaveBeenCalledWith('The file could not be downloaded.'));
  });

  it('keeps creating and downloading to those who may', async () => {
    const user = userEvent.setup();
    env.permissions = new Set(['banking:create']);
    renderWithProviders(<PayBillsPage />);

    await user.click(screen.getByRole('checkbox', { name: 'Select bill INK-b1' }));
    await pickAccount(user);
    await user.click(screen.getByTestId('batch-create'));
    expect(screen.queryByTestId('batch-download')).not.toBeInTheDocument();
  });

  it('goes back to the selection after a file', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayBillsPage />);

    await user.click(screen.getByRole('checkbox', { name: 'Select bill INK-b1' }));
    await pickAccount(user);
    await user.click(screen.getByTestId('batch-create'));
    await user.click(screen.getByRole('button', { name: 'Pay more bills' }));

    expect(screen.queryByTestId('batch-created')).not.toBeInTheDocument();
    expect(screen.getByTestId('pay-total')).toHaveTextContent('0 bills selected');
  });
});

describe('Pay bills: the files made so far', () => {
  it('lists each file with its status, its bills as chips and what is paid', () => {
    env.batches = [
      batch(),
      batch({ id: 'batch_2', status: 'cancelled', fileName: 'sepa-old.xml', bills: [] }),
      batch({ id: 'batch_3', fileName: 'sepa-done.xml', paidBillCount: 2, bills: [] }),
    ];
    renderWithProviders(<PayBillsPage />);

    const first = screen.getByTestId('batch-batch_1');
    expect(within(first).getByText('sepa-2026-12-01.xml')).toBeInTheDocument();
    expect(within(first).getByText('Exported')).toBeInTheDocument();
    expect(first).toHaveTextContent('2 payments, €300.00');
    expect(first).toHaveTextContent('0 of 2 bills paid');
    expect(within(first).getByTestId('link-bill-b1')).toHaveTextContent('INK-b1');
    expect(within(first).getByTestId('link-bill-b2')).toBeInTheDocument();
    expect(within(screen.getByTestId('batch-batch_2')).getByText('Cancelled')).toBeInTheDocument();
    // Completed is worked out: every bill in the file is paid.
    expect(within(screen.getByTestId('batch-batch_3')).getByText('Completed')).toBeInTheDocument();
  });

  it('downloads a file again', async () => {
    const user = userEvent.setup();
    env.batches = [batch()];
    renderWithProviders(<PayBillsPage />);

    await user.click(screen.getByRole('button', { name: 'Download sepa-2026-12-01.xml' }));
    expect(env.download).toHaveBeenCalledWith(expect.objectContaining({ id: 'batch_1' }));
  });

  it('cancels an exported file after a confirmation', async () => {
    const user = userEvent.setup();
    env.batches = [batch()];
    renderWithProviders(<PayBillsPage />);

    await user.click(within(screen.getByTestId('batch-batch_1')).getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Cancel this SEPA file?')).toBeInTheDocument();
    expect(env.cancel).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel the file' }));
    await waitFor(() => expect(env.cancel).toHaveBeenCalledWith('batch_1'));
  });

  it('offers neither download nor cancel on a cancelled file, and nothing without the permissions', () => {
    env.batches = [batch({ status: 'cancelled' })];
    const { unmount } = renderWithProviders(<PayBillsPage />);
    const card = screen.getByTestId('batch-batch_1');
    expect(within(card).queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    unmount();

    env.batches = [batch()];
    env.permissions = new Set();
    renderWithProviders(<PayBillsPage />);
    const open = screen.getByTestId('batch-batch_1');
    expect(within(open).queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(within(open).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('says there are no files yet', () => {
    renderWithProviders(<PayBillsPage />);
    expect(screen.getByText('No SEPA files yet.')).toBeInTheDocument();
  });
});
