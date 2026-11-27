import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Account } from '@/lib/api/domains/weldbooks';
import type { OpenDocument } from '@/lib/api/domains/weldbooks-banking';
import { MatchDocumentsPanel } from './match-documents-panel';
import { polyfillRadixSelect, renderWithProviders } from './test-utils';

const env = vi.hoisted(() => ({
  mutate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  documents: [] as OpenDocument[],
  searches: [] as string[],
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `€${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value.slice(0, 10),
    currency: 'EUR',
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useOpenDocumentsForLine: (_lineId: string | null, search: string) => {
    env.searches.push(search);
    return {
      data: search ? env.documents.filter((d) => d.number?.includes(search)) : env.documents,
      isLoading: false,
    };
  },
  useMatchBankLineToDocuments: () => ({ mutate: env.mutate, isPending: false, error: null }),
}));

function doc(id: string, number: string, openAmount: string): OpenDocument {
  return {
    type: 'invoice',
    id,
    number,
    contactId: 'acn_1',
    contactName: 'Acme Trading',
    issueDate: '2026-11-01T00:00:00.000Z',
    dueDate: '2026-12-01T00:00:00.000Z',
    currency: 'EUR',
    total: openAmount,
    openAmount,
    status: 'sent',
    confidence: 0.5,
    reasons: [],
  };
}

const accounts = [
  { id: 'acc_costs', code: '4610', name: 'Bank costs', type: 'expense', isActive: true },
  { id: 'acc_bank', code: '1100', name: 'Bank', type: 'asset', isActive: true },
] as unknown as Account[];

function renderPanel(lineAmount = '149.50', onMatched = vi.fn()) {
  renderWithProviders(
    <MatchDocumentsPanel
      lineId="btx_1"
      lineAmount={lineAmount}
      currency="EUR"
      ledgerAccounts={accounts}
      readOnly={false}
      onMatched={onMatched}
    />,
  );
  return onMatched;
}

describe('MatchDocumentsPanel', () => {
  beforeEach(() => {
    env.mutate.mockReset();
    env.searches.length = 0;
    env.documents = [doc('inv_1', 'INV-001', '100.00'), doc('inv_2', 'INV-002', '50.00')];
    polyfillRadixSelect();
  });

  it('lists the open invoices for money coming in and searches them', async () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: 'Match to invoices' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search open documents' }), '002');
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(1));
    expect(env.searches).toContain('002');
  });

  it('fills what is left of the transaction and matches several invoices as one payment', async () => {
    const onMatched = renderPanel();
    const [first, second] = screen.getAllByRole('checkbox');
    await userEvent.click(first);
    await userEvent.click(second);
    expect(screen.getByRole('textbox', { name: 'Amount for INV-001' })).toHaveValue('100.00');
    expect(screen.getByRole('textbox', { name: 'Amount for INV-002' })).toHaveValue('49.50');
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Match selected \(2\)/ }));
    expect(env.mutate).toHaveBeenCalledWith(
      {
        lineId: 'btx_1',
        data: {
          documents: [
            { type: 'invoice', id: 'inv_1', amount: '100.00' },
            { type: 'invoice', id: 'inv_2', amount: '49.50' },
          ],
        },
      },
      expect.anything(),
    );
    const result = { id: 'btx_1', status: 'reconciled', paymentId: 'pay_1', journalEntryId: null, roundingDifference: { accountId: 'acc_r', amount: '0.50' } };
    env.mutate.mock.calls[0][1].onSuccess({ data: result });
    // The server's answer is passed on: it names the rounding it booked on its own.
    expect(onMatched).toHaveBeenCalledWith(result);
  });

  it('books a shortfall to the account picked, and asks for one first', async () => {
    renderPanel();
    const [first, second] = screen.getAllByRole('checkbox');
    await userEvent.click(first);
    await userEvent.click(second);
    const amount = screen.getByRole('textbox', { name: 'Amount for INV-002' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '50.00');
    expect(screen.getByRole('group', { name: 'The documents are €0.50 more than the transaction' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'Book €0.50 to an account' }));
    await userEvent.click(screen.getByRole('button', { name: /Match selected/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose the account for the difference.');
    expect(env.mutate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('combobox', { name: 'Account for the difference' }));
    await userEvent.click(await screen.findByRole('option', { name: '4610 — Bank costs' }));
    await userEvent.click(screen.getByRole('button', { name: /Match selected/ }));
    expect(env.mutate.mock.calls[0][0]).toEqual({
      lineId: 'btx_1',
      data: {
        documents: [
          { type: 'invoice', id: 'inv_1', amount: '100.00' },
          { type: 'invoice', id: 'inv_2', amount: '50.00' },
        ],
        differenceAccountId: 'acc_costs',
        differenceDescription: 'Payment difference',
      },
    });
  });

  it('leaves the last invoice partly open by default when the invoices take more', async () => {
    renderPanel('120.00');
    const [first, second] = screen.getAllByRole('checkbox');
    await userEvent.click(first);
    await userEvent.click(second);
    const amount = screen.getByRole('textbox', { name: 'Amount for INV-002' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '50');
    expect(screen.getByRole('radio', { name: 'INV-002 stays open for €30.00' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /Match selected/ }));
    expect(env.mutate.mock.calls[0][0].data).toEqual({
      documents: [
        { type: 'invoice', id: 'inv_1', amount: '100.00' },
        { type: 'invoice', id: 'inv_2', amount: '20.00' },
      ],
    });
  });

  it('refuses an amount above what the invoice still has open', async () => {
    renderPanel();
    await userEvent.click(screen.getAllByRole('checkbox')[1]);
    const amount = screen.getByRole('textbox', { name: 'Amount for INV-002' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '60');
    await userEvent.click(screen.getByRole('button', { name: /Match selected/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('The amount for INV-002 is more than it still has open.');
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(env.mutate).not.toHaveBeenCalled();
  });

  it('offers bills and credit notes for money going out', () => {
    env.documents = [{ ...doc('bil_1', 'B-1', '80.00'), type: 'bill' }];
    renderPanel('-80.00');
    expect(screen.getByRole('heading', { name: 'Match to bills or credit notes' })).toBeInTheDocument();
    expect(screen.getByText('Bill')).toBeInTheDocument();
  });
});
