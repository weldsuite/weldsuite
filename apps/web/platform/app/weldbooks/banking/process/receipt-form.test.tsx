import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  receipts: true,
  ocr: true,
  documents: [] as unknown[],
  prefill: undefined as unknown,
  getPrefill: vi.fn(),
  book: vi.fn(),
  bookError: undefined as Error | undefined,
  attach: vi.fn(),
  upload: vi.fn(),
  createDocument: vi.fn(),
  processDocument: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@/lib/edition', () => ({ isFeatureAvailable: (feature: string) => (feature === 'books-ocr' ? env.ocr : env.receipts) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => ({ today: () => '2026-11-27' }) }));
vi.mock('@/hooks/use-file-upload', () => ({ useFileUpload: () => ({ uploadFile: (...args: unknown[]) => env.upload(...args) }) }));
vi.mock('@/lib/api/domains/weldbooks', () => ({
  accountingApi: {
    createDocument: (...args: unknown[]) => env.createDocument(...args),
    processDocument: (...args: unknown[]) => env.processDocument(...args),
  },
}));
vi.mock('@/lib/api/domains/weldbooks-receipts', () => ({
  receiptsApi: { getPrefill: (...args: unknown[]) => env.getPrefill(...args) },
}));
vi.mock('@/hooks/queries/use-weldbooks-receipts-queries', () => ({
  isReceiptsAvailable: () => env.receipts,
  useBookDocument: () => ({
    mutateAsync: async (vars: unknown) => {
      env.book(vars);
      if (env.bookError) throw env.bookError;
    },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-processing-queries', () => ({
  invalidateAfterProcessing: (...args: unknown[]) => env.invalidate(...args),
  useUnlinkedInboxDocuments: () => ({ data: env.documents, isLoading: false }),
  useAttachDocumentToBankLine: () => ({
    mutate: (vars: unknown, options: { onSuccess?: () => void }) => {
      env.attach(vars);
      options.onSuccess?.();
    },
    isPending: false,
    variables: undefined,
  }),
}));

import { renderWithProviders } from '../../invoices/components/test-utils';
import { ReceiptForm } from './receipt-form';

const prefill = {
  sourceDocumentId: 'doc_1',
  kind: 'receipt',
  contactId: 'sup_1',
  contactName: 'Paper Co',
  invoiceNumber: 'R-9',
  date: '2026-11-20',
  dueDate: null,
  currency: 'EUR',
  lines: [{ description: 'Copy paper', amount: 221, taxRate: 21, taxRateId: 'tax_21', accountId: 'acc_office', projectId: null }],
  subtotal: 182.64,
  taxTotal: 38.36,
  total: 221,
  paid: true,
  paymentMethod: 'card',
  paidWith: null,
  iban: null,
  paymentReference: null,
  confidence: null,
  defaults: null,
};

function renderForm(props: Partial<React.ComponentProps<typeof ReceiptForm>> = {}) {
  const onBooked = vi.fn();
  const onAttached = vi.fn();
  renderWithProviders(
    <ReceiptForm lineId="btx_1" lineDate="2026-11-22" onBookNow={vi.fn()} onClose={vi.fn()} onBooked={onBooked} onAttached={onAttached} {...props} />,
  );
  return { onBooked, onAttached };
}

beforeEach(() => {
  env.receipts = true;
  env.ocr = true;
  env.documents = [{ id: 'doc_1', fileName: 'paper.pdf' }];
  env.bookError = undefined;
  for (const fn of [env.getPrefill, env.book, env.attach, env.upload, env.createDocument, env.processDocument, env.invalidate]) fn.mockReset();
  env.getPrefill.mockResolvedValue({ data: prefill });
});

describe('Add a receipt where documents are booked', () => {
  it('books the picked document as a receipt paid with the bank line, in one step', async () => {
    const user = userEvent.setup();
    const { onBooked } = renderForm();

    expect(screen.getByText(/It is booked as a receipt and this line is done/)).toBeInTheDocument();
    await user.click(within(screen.getByTestId('receipt-documents')).getByRole('button', { name: 'Book as receipt: paper.pdf' }));

    await waitFor(() => expect(onBooked).toHaveBeenCalledWith('paper.pdf'));
    expect(env.getPrefill).toHaveBeenCalledWith('doc_1');
    expect(env.book).toHaveBeenCalledWith({
      id: 'doc_1',
      input: {
        kind: 'receipt',
        contactId: 'sup_1',
        invoiceNumber: 'R-9',
        date: '2026-11-20',
        currency: 'EUR',
        lines: [{ description: 'Copy paper', amount: 221, accountId: 'acc_office', taxRateId: 'tax_21' }],
        paidWith: { type: 'bank_transaction', bankTransactionId: 'btx_1' },
      },
    });
    expect(env.invalidate).toHaveBeenCalled();
    expect(env.attach).not.toHaveBeenCalled();
    // Done: no "book it to a category" step is left.
    expect(screen.getByTestId('receipt-attached')).toHaveTextContent('Receipt booked and linked to the line.');
    expect(screen.queryByTestId('receipt-book-now')).not.toBeInTheDocument();
  });

  it('uploads a file, reads it, and books it', async () => {
    const user = userEvent.setup();
    env.upload.mockResolvedValue({ fileName: 'bon.pdf', fileKey: 'weldbooks/documents/bon.pdf', mimeType: 'application/pdf', fileSize: 9 });
    env.createDocument.mockResolvedValue({ data: { id: 'doc_new' } });
    env.processDocument.mockResolvedValue({ data: {} });
    const { onBooked } = renderForm();

    await user.upload(screen.getByTestId('receipt-file-input'), new File(['%PDF'], 'bon.pdf', { type: 'application/pdf' }));

    await waitFor(() => expect(onBooked).toHaveBeenCalledWith('bon.pdf'));
    expect(env.processDocument).toHaveBeenCalledWith('doc_new');
    expect(env.getPrefill).toHaveBeenCalledWith('doc_new');
    expect(env.book).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc_new' }));
  });

  it('does not scan an upload where the edition reads no documents', async () => {
    const user = userEvent.setup();
    env.ocr = false;
    env.upload.mockResolvedValue({ fileName: 'bon.pdf', fileKey: 'k', mimeType: 'application/pdf', fileSize: 9 });
    env.createDocument.mockResolvedValue({ data: { id: 'doc_new' } });
    renderForm();

    await user.upload(screen.getByTestId('receipt-file-input'), new File(['%PDF'], 'bon.pdf', { type: 'application/pdf' }));

    await waitFor(() => expect(env.book).toHaveBeenCalled());
    expect(env.processDocument).not.toHaveBeenCalled();
  });

  it('sends the person to the inbox when no supplier was found, and books nothing', async () => {
    const user = userEvent.setup();
    env.getPrefill.mockResolvedValue({ data: { ...prefill, contactId: null } });
    const { onBooked } = renderForm();

    await user.click(screen.getByRole('button', { name: 'Book as receipt: paper.pdf' }));

    expect(await screen.findByTestId('receipt-error')).toHaveTextContent('No supplier was found on this document. Open it in the inbox to choose one.');
    expect(env.book).not.toHaveBeenCalled();
    expect(onBooked).not.toHaveBeenCalled();
  });

  it('says why booking failed and keeps the form', async () => {
    const user = userEvent.setup();
    env.bookError = new Error('The period is locked');
    const { onBooked } = renderForm();

    await user.click(screen.getByRole('button', { name: 'Book as receipt: paper.pdf' }));

    expect(await screen.findByTestId('receipt-error')).toHaveTextContent('The period is locked');
    expect(onBooked).not.toHaveBeenCalled();
    expect(screen.getByTestId('receipt-form')).toBeInTheDocument();
  });
});

describe('Add a receipt on Global', () => {
  beforeEach(() => {
    env.receipts = false;
  });

  it('only attaches the document and offers to book it to a category', async () => {
    const user = userEvent.setup();
    const { onAttached, onBooked } = renderForm();

    await user.click(screen.getByRole('button', { name: 'Attach paper.pdf' }));

    expect(env.attach).toHaveBeenCalledWith({ lineId: 'btx_1', documentId: 'doc_1' });
    expect(env.book).not.toHaveBeenCalled();
    expect(onAttached).toHaveBeenCalledWith('paper.pdf');
    expect(onBooked).not.toHaveBeenCalled();
    expect(screen.getByTestId('receipt-book-now')).toBeInTheDocument();
  });
});
