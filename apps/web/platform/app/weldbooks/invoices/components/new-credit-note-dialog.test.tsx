import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  listInvoices: vi.fn(),
  createCreditMemo: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('@/lib/api/domains/weldbooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/domains/weldbooks')>()),
  accountingApi: { listInvoices: env.listInvoices },
}));
vi.mock('@/hooks/queries/use-weldbooks-tax-preview', () => ({
  useCreateCreditMemo: () => ({
    mutate: (id: string, options: { onSuccess: (res: unknown) => void; onError: (error: unknown) => void }) => env.createCreditMemo(id, options),
    isPending: false,
  }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (value: unknown) => `€${value}` }),
}));

import { canBeCredited, NewCreditNoteDialog } from './new-credit-note-dialog';
import { polyfillRadixSelect, renderWithProviders } from './test-utils';

const invoice = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 'invoice',
  status: 'sent',
  invoiceNumber: `F-${id}`,
  contactName: 'Acme',
  total: '121.00',
  currency: 'EUR',
  ...overrides,
});

describe('NewCreditNoteDialog', () => {
  beforeEach(() => {
    polyfillRadixSelect();
    env.listInvoices.mockReset();
    env.createCreditMemo.mockReset();
    env.push.mockReset();
    env.toast.success.mockReset();
    env.toast.error.mockReset();
    env.listInvoices.mockResolvedValue({
      data: [invoice('1'), invoice('2', { status: 'draft' }), invoice('3', { status: 'cancelled' }), invoice('4', { type: 'credit_note' }), invoice('5', { status: 'paid' })],
    });
  });

  it('only credits an invoice that was issued and not cancelled, never a credit note', () => {
    expect(canBeCredited({ type: 'invoice', status: 'sent' })).toBe(true);
    expect(canBeCredited({ type: 'invoice', status: 'paid' })).toBe(true);
    expect(canBeCredited({ type: 'invoice', status: 'draft' })).toBe(false);
    expect(canBeCredited({ type: 'invoice', status: 'cancelled' })).toBe(false);
    expect(canBeCredited({ type: 'credit_note', status: 'sent' })).toBe(false);
  });

  it('asks for the invoice to credit and does not create anything until one is chosen', () => {
    renderWithProviders(<NewCreditNoteDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'New credit note' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create credit note' })).toBeDisabled();
  });

  it('lists the invoices that can be credited, searching the server for invoices only', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewCreditNoteDialog open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('combobox', { name: 'Invoice to credit' }));
    const list = await screen.findByRole('listbox');
    expect(await within(list).findByText('F-1')).toBeInTheDocument();
    expect(within(list).getByText('F-5')).toBeInTheDocument();
    expect(within(list).queryByText('F-2')).not.toBeInTheDocument();
    expect(within(list).queryByText('F-3')).not.toBeInTheDocument();
    expect(within(list).queryByText('F-4')).not.toBeInTheDocument();
    expect(env.listInvoices).toHaveBeenCalledWith({ type: 'invoice', search: undefined, pageSize: 25 });
  });

  it('makes the draft credit note of the chosen invoice and opens it in the editor', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    env.createCreditMemo.mockImplementation((_id: string, options: { onSuccess: (res: unknown) => void }) =>
      options.onSuccess({ data: { id: 'cn_1', invoiceNumber: 'CN-1' } }),
    );
    renderWithProviders(<NewCreditNoteDialog open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('combobox', { name: 'Invoice to credit' }));
    await user.click(await screen.findByText('F-1'));
    await user.click(screen.getByRole('button', { name: 'Create credit note' }));
    await waitFor(() => expect(env.createCreditMemo).toHaveBeenCalledWith('1', expect.any(Object)));
    expect(env.push).toHaveBeenCalledWith('/weldbooks/invoices/cn_1/edit');
    expect(env.toast.success).toHaveBeenCalledWith('Draft credit note CN-1 created');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
