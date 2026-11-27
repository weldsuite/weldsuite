import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getDefaultStore } from 'jotai';
import type { BankCandidate, DocumentDuplicates, DocumentPrefill, InboxDocument } from '@/lib/api/domains/weldbooks-receipts';

const env = vi.hoisted(() => ({
  permissions: new Set<string>(['bills:create', 'bills:update', 'invoices:update', 'banking:read', 'banking:update', 'banking:create']),
  doc: undefined as unknown,
  docError: false,
  prefill: undefined as unknown,
  prefillError: false,
  candidates: [] as unknown[],
  duplicates: { bills: [], documents: [] } as unknown,
  defaults: undefined as unknown,
  next: [] as unknown[],
  push: vi.fn(),
  book: vi.fn(),
  bookResult: {} as unknown,
  bookError: undefined as Error | undefined,
  reject: vi.fn(),
  candidateArgs: [] as unknown[],
  createCustomer: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
  useRouter: () => ({ push: env.push }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `€${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-11-27',
  }),
}));
vi.mock('@/hooks/use-current-entity-currency', () => ({ useCurrentEntityCurrency: () => ({ entityCurrency: 'EUR' }) }));
vi.mock('@/components/accounting/source-document-viewer', () => ({
  SourceDocumentViewer: ({ fileKey }: { fileKey: string }) => <div data-testid="viewer">{fileKey}</div>,
}));
vi.mock('@/components/object-panel/record-link', () => ({
  RecordLink: ({ type, id, label, secondary }: { type: string; id: string; label: string; secondary?: string }) => (
    <a href={`#${type}:${id}`} data-testid={`link-${type}-${id}`}>
      {label}
      {secondary ? ` ${secondary}` : ''}
    </a>
  ),
}));
vi.mock('@/components/accounting/contact-picker', () => ({
  ContactPicker: ({ value, onChange }: { value: string; onChange: (id: string) => void }) => (
    <select aria-label="Supplier" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">none</option>
      <option value="sup_1">Paper Co</option>
      <option value="sup_2">Other BV</option>
    </select>
  ),
}));
vi.mock('@/components/weldflow/project-select', () => ({ ProjectSelect: () => <div data-testid="project-select" /> }));
vi.mock('@weldsuite/ui/components/autocomplete', () => ({
  Autocomplete: ({
    id,
    options = [],
    value,
    onValueChange,
    placeholder,
  }: {
    id?: string;
    options?: Array<{ value: string; label: string }>;
    value?: string;
    onValueChange?: (value: string) => void;
    placeholder?: string;
  }) => (
    <select id={id} value={value ?? ''} onChange={(event) => onValueChange?.(event.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('@/hooks/queries/use-accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-accounting-queries')>()),
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_office', code: '4300', name: 'Office supplies', type: 'expense', isActive: true },
        { id: 'acc_travel', code: '4400', name: 'Travel', type: 'expense', isActive: true },
      ],
    },
  }),
  useAccountingTaxRates: () => ({ data: { data: [{ id: 'tax_21', name: 'VAT 21%', rate: '21', isActive: true }] } }),
  useAccountingCustomer: (id: string) => ({ data: id ? { data: { id, name: id === 'sup_1' ? 'Paper Co' : 'Other BV' } } : undefined }),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({
  accountingApi: { createCustomer: (...args: unknown[]) => env.createCustomer(...args) },
}));
vi.mock('@/hooks/queries/use-weldbooks-receipts-queries', () => ({
  useInboxDocument: () => ({ data: env.docError ? undefined : env.doc, isError: env.docError, refetch: vi.fn() }),
  useDocumentPrefill: () => ({
    data: env.prefillError ? undefined : env.prefill,
    isPending: false,
    isError: env.prefillError,
  }),
  useDocumentDuplicates: () => ({ data: env.duplicates }),
  useBankCandidates: (id: string, overrides: unknown) => {
    env.candidateArgs.push(overrides);
    return { data: env.candidates, isFetching: false };
  },
  useBookingDefaults: () => ({ data: env.defaults }),
  useNextDocuments: () => ({ data: env.next }),
  useBookDocument: () => ({
    mutate: (vars: unknown, options: { onSuccess?: (result: unknown) => void }) => {
      env.book(vars);
      if (!env.bookError) options.onSuccess?.(env.bookResult);
    },
    isPending: false,
    isError: Boolean(env.bookError),
    error: env.bookError ?? null,
  }),
  useRejectDocument: () => ({
    mutateAsync: async (id: string) => {
      env.reject(id);
    },
    isPending: false,
  }),
}));

import { renderWithProviders } from '../../invoices/components/test-utils';
import { lastBookedAtom } from './booked-banner';
import { ReviewScreen } from './review-screen';

function doc(overrides: Partial<InboxDocument> = {}): InboxDocument {
  return {
    id: 'doc_1',
    type: 'invoice',
    fileName: 'paper-invoice.pdf',
    fileKey: 'weldbooks/documents/paper-invoice.pdf',
    source: 'email',
    status: 'processed',
    ocrResult: { vendor: { name: 'Paper Co', address: null, taxNumber: 'NL001', kvkNumber: null, iban: 'NL91ABNA0417164300', bic: null } },
    matchedContactId: 'sup_1',
    linkedEntityType: null,
    linkedEntityId: null,
    createdAt: '2026-11-20T10:00:00Z',
    mimeType: 'application/pdf',
    ...overrides,
  };
}

function prefill(overrides: Partial<DocumentPrefill> = {}): DocumentPrefill {
  return {
    sourceDocumentId: 'doc_1',
    kind: 'purchase_invoice',
    contactId: 'sup_1',
    contactName: 'Paper Co',
    invoiceNumber: 'INV-7',
    date: '2026-11-20',
    dueDate: '2026-12-20',
    currency: 'EUR',
    lines: [{ description: 'Copy paper', amount: 221, taxRate: 21, taxRateId: 'tax_21', accountId: 'acc_office', projectId: null }],
    subtotal: 182.64,
    taxTotal: 38.36,
    total: 221,
    paid: false,
    paymentMethod: null,
    paidWith: null,
    iban: null,
    paymentReference: null,
    confidence: { overall: 0.9 },
    defaults: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<BankCandidate> = {}): BankCandidate {
  return {
    id: 'btx_1',
    bankAccountId: 'ba_1',
    date: '2026-11-21',
    amount: '-221.00',
    counterpartyName: 'Paper Co',
    counterpartyIban: 'NL91ABNA0417164300',
    description: 'INV-7',
    reference: null,
    score: 0.95,
    reasons: ['exact amount match', 'counterparty IBAN matches the supplier'],
    sure: true,
    ...overrides,
  };
}

beforeEach(() => {
  env.permissions = new Set(['bills:create', 'bills:update', 'invoices:update', 'banking:read', 'banking:update', 'banking:create']);
  env.doc = doc();
  env.docError = false;
  env.prefill = prefill();
  env.prefillError = false;
  env.candidates = [candidate()];
  env.duplicates = { bills: [], documents: [] } satisfies DocumentDuplicates;
  env.defaults = undefined;
  env.next = [
    { id: 'doc_1', status: 'processed' },
    { id: 'doc_2', status: 'review' },
  ];
  env.bookResult = {
    bill: { id: 'bill_1', billNumber: 'INK-0007', status: 'paid' },
    payment: { id: 'pay_1' },
    bankTransactionId: 'btx_1',
    autoLinked: false,
  };
  env.bookError = undefined;
  env.candidateArgs = [];
  for (const fn of [env.push, env.book, env.reject, env.createCustomer]) fn.mockReset();
  getDefaultStore().set(lastBookedAtom, null);
});

describe('ReviewScreen', () => {
  it('shows the original beside a form that starts from the scan', () => {
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    expect(screen.getByTestId('viewer')).toHaveTextContent('weldbooks/documents/paper-invoice.pdf');
    expect(screen.getByTestId('review-title')).toHaveTextContent('paper-invoice.pdf');
    expect(screen.getByRole('combobox', { name: 'Supplier' })).toHaveValue('sup_1');
    expect(screen.getByLabelText('Invoice number')).toHaveValue('INV-7');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-11-20');
    expect(screen.getByLabelText('Due date')).toHaveValue('2026-12-20');
    const line = screen.getByTestId('review-line-1');
    expect(within(line).getByLabelText('Description')).toHaveValue('Copy paper');
    expect(within(line).getByLabelText('Amount, VAT included')).toHaveValue('221.00');
    expect(within(line).getByLabelText('Category')).toHaveValue('acc_office');
    expect(screen.getByTestId('known-supplier')).toHaveTextContent('Known supplier');
    // The lines agree with the document to the cent.
    expect(screen.getByTestId('lines-check')).toHaveTextContent('The lines add up to the document.');
  });

  it('says what the supplier usual category and VAT come from', () => {
    env.defaults = {
      contactId: 'sup_1',
      basedOnBills: 3,
      basedOnLines: 3,
      account: { accountId: 'acc_office', code: '4300', name: 'Office supplies', count: 3, source: 'history' },
      taxRate: { taxRateId: 'tax_21', name: 'VAT 21%', rate: '21', count: 3, source: 'history' },
      project: null,
      lastBill: null,
    };
    renderWithProviders(<ReviewScreen documentId="doc_1" />);
    expect(screen.getByTestId('booking-defaults-hint')).toHaveTextContent('Category and VAT as on Paper Co’s last 3 bills');
  });

  it('warns when the lines are off the document total', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReviewScreen documentId="doc_1" />);
    const amount = within(screen.getByTestId('review-line-1')).getByLabelText('Amount, VAT included');
    await user.clear(amount);
    await user.type(amount, '200');
    expect(screen.getByTestId('lines-check')).toHaveTextContent('The lines are €21.00 off the document total.');
  });

  it('offers the bank lines, preselects the sure one, then not paid yet, cash and paid privately', async () => {
    const user = userEvent.setup();
    env.candidates = [candidate(), candidate({ id: 'btx_2', sure: false, counterpartyName: 'Paper Co BV', reasons: ['close amount match'], amount: '-220.00' })];
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    const paid = screen.getByTestId('paid-with');
    const radios = within(paid).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    expect(within(paid).getByText('2026-11-21 · Paper Co')).toBeInTheDocument();
    expect(within(paid).getByText('Sure match')).toBeInTheDocument();
    expect(within(paid).getByText('Possible match')).toBeInTheDocument();
    expect(within(paid).getByText('exact amount · the supplier’s IBAN')).toBeInTheDocument();
    for (const label of ['Not paid yet', 'Cash', 'Paid privately']) expect(within(paid).getByText(label)).toBeInTheDocument();

    await user.click(within(paid).getByRole('radio', { name: /Cash/ }));
    expect(within(paid).getByRole('radio', { name: /Cash/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('asks for bank lines that follow the form', () => {
    renderWithProviders(<ReviewScreen documentId="doc_1" />);
    expect(env.candidateArgs.at(-1)).toEqual({ amount: '221.00', date: '2026-11-20', contactId: 'sup_1', invoiceNumber: 'INV-7' });
  });

  it('switches the kind: a credit note is only ever not paid yet', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    await user.click(screen.getByRole('radio', { name: 'Credit note' }));

    const paid = screen.getByTestId('paid-with');
    expect(within(paid).getAllByRole('radio')).toHaveLength(1);
    expect(within(paid).getByRole('radio', { name: /Not paid yet/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/A credit note lowers what you owe/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Receipt' }));
    expect(within(screen.getByTestId('paid-with')).getAllByRole('radio').length).toBeGreaterThan(1);
  });

  it('offers only what the permissions allow for paying', () => {
    env.permissions = new Set(['bills:create', 'bills:update', 'banking:read']);
    renderWithProviders(<ReviewScreen documentId="doc_1" />);
    const paid = screen.getByTestId('paid-with');
    expect(within(paid).getAllByRole('radio')).toHaveLength(1);
    expect(within(paid).queryByText('Cash')).not.toBeInTheDocument();
  });

  it('warns about a duplicate with chips to the bill and the document it found', () => {
    env.duplicates = {
      bills: [
        { id: 'bill_old', billNumber: 'INK-0001', type: 'bill', status: 'paid', externalReference: 'INV-7', contactId: 'sup_1', contactName: 'Paper Co', issueDate: '2026-10-01', total: '221.00', currency: 'EUR', reason: 'same supplier and invoice number' },
      ],
      documents: [
        { id: 'doc_old', fileName: 'copy.pdf', originalFileName: 'paper-invoice.pdf', status: 'linked', linkedEntityType: 'bill', linkedEntityId: 'bill_old', createdAt: '2026-10-01T10:00:00Z', reason: 'same file name and size' },
      ],
    } satisfies DocumentDuplicates;
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    const warning = screen.getByTestId('duplicate-warning');
    expect(within(warning).getByText('This may already be in your books')).toBeInTheDocument();
    expect(within(warning).getByTestId('link-bill-bill_old')).toHaveTextContent('Bill INK-0001');
    const documentChip = within(warning).getByRole('link', { name: /Document paper-invoice.pdf/ });
    expect(documentChip).toHaveAttribute('href', expect.stringContaining('/weldbooks/documents/doc_old/review'));
  });

  it('shows no duplicate warning when nothing was found', () => {
    renderWithProviders(<ReviewScreen documentId="doc_1" />);
    expect(screen.queryByTestId('duplicate-warning')).not.toBeInTheDocument();
  });

  it('books with Save and next and opens the next document, carrying the result over', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    await user.click(screen.getByRole('button', { name: /Save and next/ }));

    expect(env.book).toHaveBeenCalledWith({
      id: 'doc_1',
      input: {
        kind: 'purchase_invoice',
        contactId: 'sup_1',
        invoiceNumber: 'INV-7',
        date: '2026-11-20',
        dueDate: '2026-12-20',
        currency: 'EUR',
        lines: [{ description: 'Copy paper', accountId: 'acc_office', taxRateId: 'tax_21', amount: 221 }],
        paidWith: { type: 'bank_transaction', bankTransactionId: 'btx_1' },
      },
    });
    expect(env.push).toHaveBeenCalledWith('/weldbooks/documents/doc_2/review');
    expect(getDefaultStore().get(lastBookedAtom)).toMatchObject({ billId: 'bill_1', paymentId: 'pay_1', bankTransactionId: 'btx_1', paid: true });
  });

  it('shows the success line with chips to the bill, the payment and the bank line, and says when it linked itself', () => {
    getDefaultStore().set(lastBookedAtom, {
      kind: 'receipt',
      billId: 'bill_1',
      billNumber: 'INK-0007',
      paymentId: null,
      bankTransactionId: 'btx_1',
      paid: false,
      autoLinked: true,
    });
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    const banner = screen.getByTestId('booked-banner');
    expect(banner).toHaveTextContent('Booked as a receipt. It was linked to its bank line automatically.');
    expect(within(banner).getByTestId('link-bill-bill_1')).toHaveTextContent('Bill INK-0007');
    expect(within(banner).getByTestId('link-bank_transaction-btx_1')).toHaveTextContent('Bank line');
    expect(within(banner).queryByTestId('link-payment-pay_1')).not.toBeInTheDocument();
  });

  it('stays on the screen with the result when there is no next document', async () => {
    const user = userEvent.setup();
    env.next = [{ id: 'doc_1', status: 'processed' }];
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    await user.click(screen.getByRole('button', { name: /Save and next/ }));

    expect(env.push).not.toHaveBeenCalled();
    const finished = screen.getByTestId('review-finished');
    expect(finished).toHaveTextContent('No more documents to check.');
    expect(within(finished).getByTestId('link-bill-bill_1')).toBeInTheDocument();
    expect(within(finished).getByTestId('link-payment-pay_1')).toBeInTheDocument();
    expect(within(finished).getByRole('link', { name: 'Back to the inbox' })).toHaveAttribute('href', '/weldbooks/documents');
  });

  it('saves with Enter outside a field, and not from inside one', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    const number = screen.getByLabelText('Invoice number');
    await user.click(number);
    await user.keyboard('{Enter}');
    expect(env.book).not.toHaveBeenCalled();

    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('{Enter}');
    expect(env.book).toHaveBeenCalledTimes(1);
  });

  it('says what is missing and books nothing', async () => {
    const user = userEvent.setup();
    env.prefill = prefill({ contactId: null, contactName: null });
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    await user.click(screen.getByRole('button', { name: /Save and next/ }));

    expect(env.book).not.toHaveBeenCalled();
    expect(screen.getByTestId('review-problem')).toHaveTextContent('Choose a supplier.');
  });

  it('says why booking failed and stays', async () => {
    const user = userEvent.setup();
    env.bookError = new Error('The period is locked');
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    await user.click(screen.getByRole('button', { name: /Save and next/ }));

    expect(screen.getByTestId('review-error')).toHaveTextContent('The period is locked');
    expect(env.push).not.toHaveBeenCalled();
  });

  it('fills the lines from the supplier history when the person picks the supplier', async () => {
    const user = userEvent.setup();
    env.prefill = prefill({ contactId: null, contactName: null, lines: [{ description: 'Train', amount: 50, taxRate: null, taxRateId: null, accountId: null, projectId: null }] });
    env.defaults = {
      contactId: 'sup_2',
      basedOnBills: 2,
      basedOnLines: 2,
      account: { accountId: 'acc_travel', code: '4400', name: 'Travel', count: 2, source: 'history' },
      taxRate: null,
      project: null,
      lastBill: null,
    };
    renderWithProviders(<ReviewScreen documentId="doc_1" />);
    expect(within(screen.getByTestId('review-line-1')).getByLabelText('Category')).toHaveValue('acc_travel');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Supplier' }), 'sup_2');
    expect(within(screen.getByTestId('review-line-1')).getByLabelText('Category')).toHaveValue('acc_travel');
  });

  it('adds a supplier from the document inline and picks it', async () => {
    const user = userEvent.setup();
    env.prefill = prefill({ contactId: null, contactName: null });
    env.createCustomer.mockResolvedValue({ data: { id: 'sup_2' } });
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    await user.click(screen.getByRole('button', { name: 'New supplier from this document' }));
    const section = screen.getByTestId('new-supplier');
    expect(within(section).getByLabelText('Name')).toHaveValue('Paper Co');
    expect(within(section).getByLabelText('VAT number')).toHaveValue('NL001');
    expect(within(section).getByLabelText('IBAN')).toHaveValue('NL91ABNA0417164300');
    // No second dialog: the section sits in the form.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: 'Add supplier' }));

    await waitFor(() =>
      expect(env.createCustomer).toHaveBeenCalledWith({ name: 'Paper Co', role: 'supplier', vatNumber: 'NL001', iban: 'NL91ABNA0417164300' }),
    );
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Supplier' })).toHaveValue('sup_2'));
    expect(screen.queryByTestId('new-supplier')).not.toBeInTheDocument();
  });

  it('rejects through a confirmation and moves on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Reject this document?')).toBeInTheDocument();
    expect(env.reject).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(env.reject).toHaveBeenCalledWith('doc_1'));
    expect(env.push).toHaveBeenCalledWith('/weldbooks/documents/doc_2/review');
  });

  it('treats "Not for the books" as a rejection', async () => {
    const user = userEvent.setup();
    env.next = [{ id: 'doc_1', status: 'processed' }];
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    await user.click(screen.getByRole('radio', { name: 'Not for the books' }));
    const area = screen.getByTestId('review-not-for-books');
    expect(area).toHaveTextContent('It is rejected and stays out of your books.');
    expect(screen.queryByTestId('review-lines')).not.toBeInTheDocument();

    await user.click(within(area).getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(env.reject).toHaveBeenCalledWith('doc_1'));
    expect(env.push).toHaveBeenCalledWith('/weldbooks/documents');
  });

  it('says a document is booked already, with a chip to its bill, instead of a form', () => {
    env.doc = doc({ status: 'linked', linkedEntityType: 'bill', linkedEntityId: 'bill_9' });
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    expect(screen.getByTestId('review-already-booked')).toHaveTextContent('This document is already booked.');
    expect(screen.getByTestId('link-bill-bill_9')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save and next/ })).not.toBeInTheDocument();
  });

  it('starts empty and says so when the document could not be read', () => {
    env.prefill = undefined;
    env.prefillError = true;
    renderWithProviders(<ReviewScreen documentId="doc_1" />);

    expect(screen.getByText('The document could not be read. Fill in the details by hand.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Supplier' })).toHaveValue('');
  });

  it('cannot book without the permission to', () => {
    env.permissions = new Set(['banking:read']);
    renderWithProviders(<ReviewScreen documentId="doc_1" />);
    expect(screen.getByRole('button', { name: /Save and next/ })).toBeDisabled();
  });

  it('says when the document cannot be loaded', () => {
    env.docError = true;
    renderWithProviders(<ReviewScreen documentId="doc_1" />);
    expect(screen.getByText('This document could not be loaded.')).toBeInTheDocument();
  });
});
