import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import type { CandidateBankLine } from '@/lib/api/domains/weldbooks-banking';
import { usePaymentBankActions } from './payment-bank-actions';
import type { LinkableDocument } from './link-bank-line-dialog';

const env = vi.hoisted(() => ({
  match: vi.fn(),
  unreconcile: vi.fn(async () => ({})),
  voidPayment: vi.fn(async () => ({})),
  available: true,
  permissions: new Set(['banking:update', 'banking:delete']),
  lines: [] as CandidateBankLine[],
  queries: [] as unknown[],
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => env.available }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => env.permissions.has(permission) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `€${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value.slice(0, 10),
  }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => ({
    data: { data: [{ id: 'acc_discount', code: '8200', name: 'Payment discounts', type: 'expense', isActive: true }] },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankLinesForDocument: (query: unknown) => {
    env.queries.push(query);
    return { data: { lines: env.lines }, isLoading: false };
  },
  useMatchBankLineToDocuments: () => ({ mutate: env.match, isPending: false, error: null }),
  useUnreconcileBankLine: () => ({ mutateAsync: env.unreconcile, isPending: false }),
  useVoidPayment: () => ({ mutateAsync: env.voidPayment, isPending: false }),
}));

function line(id: string, amount: string, counterpartyName: string): CandidateBankLine {
  return {
    id,
    bankAccountId: 'bac_1',
    bankAccountName: 'Current account',
    currency: 'EUR',
    date: '2026-11-20T00:00:00.000Z',
    amount,
    description: 'INV-001',
    counterpartyName,
    counterpartyIban: null,
    reference: null,
    confidence: 0.8,
    reasons: [],
  };
}

const invoice: LinkableDocument = { kind: 'invoice', id: 'inv_1', openAmount: '100.00', currency: 'EUR' };

function Harness({ payments = [] }: Readonly<{ payments?: Array<{ id: string; bankTransactionId?: string | null }> }>) {
  const bank = usePaymentBankActions(invoice, true);
  return (
    <>
      {bank.linkButton}
      {payments.map((payment) => (
        <DropdownMenu key={payment.id}>
          <DropdownMenuTrigger>{`menu ${payment.id}`}</DropdownMenuTrigger>
          <DropdownMenuContent>{bank.menuFor(payment)}</DropdownMenuContent>
        </DropdownMenu>
      ))}
      {bank.dialogs}
    </>
  );
}

function renderHarness(payments?: Array<{ id: string; bankTransactionId?: string | null }>) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <Harness payments={payments} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('usePaymentBankActions', () => {
  beforeEach(() => {
    env.match.mockReset();
    env.unreconcile.mockClear();
    env.voidPayment.mockClear();
    env.available = true;
    env.permissions = new Set(['banking:update', 'banking:delete']);
    env.lines = [line('btx_1', '80.00', 'Acme Trading'), line('btx_2', '100.00', 'Acme Trading BV')];
    env.queries.length = 0;
  });

  it('links a transaction that pays the invoice in full', async () => {
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'Link bank transaction' }));
    expect(env.queries).toContainEqual({ invoiceId: 'inv_1', search: '' });
    await userEvent.click(screen.getByRole('radio', { name: /Acme Trading BV.*€100\.00/ }));
    expect(screen.getByRole('status')).toHaveTextContent('This transaction pays it in full.');
    await userEvent.click(screen.getByRole('button', { name: 'Link transaction' }));
    expect(env.match.mock.calls[0][0]).toEqual({
      lineId: 'btx_2',
      data: { documents: [{ type: 'invoice', id: 'inv_1', amount: '100.00' }] },
    });
  });

  it('leaves the rest open when the transaction is less, or books it to an account', async () => {
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'Link bank transaction' }));
    await userEvent.click(screen.getByRole('radio', { name: /€80\.00/ }));
    expect(screen.getByRole('radio', { name: 'Leave €20.00 open' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Link transaction' }));
    expect(env.match.mock.calls[0][0].data).toEqual({ documents: [{ type: 'invoice', id: 'inv_1', amount: '80.00' }] });

    await userEvent.click(screen.getByRole('radio', { name: 'Mark it paid and book €20.00 to an account' }));
    await userEvent.click(screen.getByRole('button', { name: 'Link transaction' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose the account for the difference.');
    expect(env.match).toHaveBeenCalledTimes(1);
  });

  it('undoes a bank match after asking', async () => {
    renderHarness([{ id: 'pay_1', bankTransactionId: 'btx_9' }]);
    await userEvent.click(screen.getByRole('button', { name: 'menu pay_1' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Undo bank match' }));
    expect(screen.getByRole('dialog', { name: 'Undo the bank match?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo bank match' }));
    expect(env.unreconcile).toHaveBeenCalledWith('btx_9');
    expect(env.toast.success).toHaveBeenCalledWith('Bank match undone');
  });

  it('deletes a payment no bank transaction confirms', async () => {
    renderHarness([{ id: 'pay_2', bankTransactionId: null }]);
    await userEvent.click(screen.getByRole('button', { name: 'menu pay_2' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete payment' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete payment' }));
    expect(env.voidPayment).toHaveBeenCalledWith('pay_2');
  });

  it('offers nothing where the edition does not have it, or without the permission', () => {
    env.available = false;
    const { unmount } = renderHarness();
    expect(screen.queryByRole('button', { name: 'Link bank transaction' })).not.toBeInTheDocument();
    unmount();
    env.available = true;
    env.permissions = new Set();
    renderHarness();
    expect(screen.queryByRole('button', { name: 'Link bank transaction' })).not.toBeInTheDocument();
  });
});
