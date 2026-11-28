import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  push: vi.fn(),
  create: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  search: {} as Record<string, string>,
  document: undefined as unknown,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  getRouteApi: () => ({ useSearch: () => env.search }),
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('sonner', () => ({ toast: { success: env.toastSuccess, error: env.toastError } }));
vi.mock('@/hooks/use-current-entity-currency', () => ({ useCurrentEntityCurrency: () => ({ entityCurrency: 'EUR' }) }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useCreateBill: () => ({ mutate: env.create, isPending: false }),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({
  accountingApi: { getBillFromDocument: vi.fn().mockResolvedValue({ data: { currency: 'EUR', confidence: { overall: 0.9 } } }) },
}));
vi.mock('@/hooks/queries/use-weldbooks-receipts-queries', () => ({
  useInboxDocument: (id: string | undefined) => ({ data: id ? env.document : undefined }),
}));
vi.mock('@/components/accounting/source-document-viewer', () => ({
  SourceDocumentViewer: ({ fileKey }: { fileKey: string }) => <div data-testid="source-viewer">{fileKey}</div>,
}));
// The form has its own tests: here it only hands over a payload.
vi.mock('../components/bill-form', () => ({
  BillForm: ({ onSubmit }: { onSubmit: (payload: Record<string, unknown>) => void }) => (
    <button type="button" onClick={() => onSubmit({ contactId: 'sup_1', items: [] })}>
      submit-bill
    </button>
  ),
}));

import AddBillPage from './page';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

describe('AddBillPage', () => {
  beforeEach(() => {
    env.push.mockReset();
    env.create.mockReset();
    env.toastSuccess.mockReset();
    env.toastError.mockReset();
    env.search = {};
    env.document = undefined;
  });

  it('has a back arrow that is one link, and a title', () => {
    renderWithProviders(<AddBillPage />);
    const back = screen.getByRole('link', { name: 'Back to bills' });
    expect(back).toHaveAttribute('href', '/weldbooks/bills');
    expect(back.querySelector('button')).toBeNull();
    expect(screen.getByRole('heading', { name: 'New bill' })).toBeInTheDocument();
  });

  it('opens the new bill in its side panel on the bills list, with a toast', async () => {
    env.create.mockImplementation((_payload, options: { onSuccess: (res: unknown) => void }) =>
      options.onSuccess({ data: { id: 'bill_new' } }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AddBillPage />);

    await user.click(screen.getByRole('button', { name: 'submit-bill' }));

    await waitFor(() => expect(env.push).toHaveBeenCalledWith('/weldbooks/bills?stack=bill:bill_new'));
    expect(env.toastSuccess).toHaveBeenCalledWith('Bill created');
  });

  it('stays on the page and says why when the bill cannot be saved', async () => {
    env.create.mockImplementation((_payload, options: { onError: (err: unknown) => void }) =>
      options.onError(new Error('Period is locked')),
    );
    const user = userEvent.setup();
    renderWithProviders(<AddBillPage />);

    await user.click(screen.getByRole('button', { name: 'submit-bill' }));

    await waitFor(() => expect(env.toastError).toHaveBeenCalledWith('Failed to save bill', { description: 'Period is locked' }));
    expect(env.push).not.toHaveBeenCalled();
  });

  it('shows the original document beside the form when the bill starts from one', async () => {
    env.search = { fromDocument: 'doc_1' };
    env.document = { id: 'doc_1', fileKey: 'weldbooks/documents/a.pdf', fileName: 'a.pdf', mimeType: 'application/pdf' };
    renderWithProviders(<AddBillPage />);

    const beside = await screen.findByTestId('bill-source-document');
    expect(within(beside).getByTestId('source-viewer')).toHaveTextContent('weldbooks/documents/a.pdf');
    expect(screen.getByRole('button', { name: 'submit-bill' })).toBeInTheDocument();
  });

  it('shows no document when the bill does not start from one', () => {
    renderWithProviders(<AddBillPage />);
    expect(screen.queryByTestId('bill-source-document')).not.toBeInTheDocument();
  });
});
