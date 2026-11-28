import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: unknown) => `€${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string) => value,
  }),
}));

import { PaymentRow, type PaymentRowData } from './payment-row';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

const payment = (overrides: Partial<PaymentRowData> = {}): PaymentRowData => ({
  id: 'pay_1',
  date: '2026-03-02',
  paymentMethod: 'bank_transfer',
  checkNumber: null,
  reference: 'REF-1',
  amount: '150.00',
  ...overrides,
});

describe('PaymentRow', () => {
  beforeEach(() => panelOpen.mockReset());

  it('shows a chip to the bank transaction that confirms the payment, instead of saying so in words', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentRow payment={payment({ bankTransactionId: 'bt_7' })} currency="EUR" />);

    expect(screen.queryByText('Matched to a bank transaction')).not.toBeInTheDocument();
    const chip = screen.getByRole('link', { name: 'Bank transaction' });
    expect(chip.getAttribute('href')).toContain('stack=bank_transaction%3Abt_7');
    await user.click(chip);
    expect(panelOpen).toHaveBeenCalledWith({ type: 'bank_transaction', id: 'bt_7', stack: true });
  });

  it('shows no chip for a payment no bank transaction confirms', () => {
    renderWithProviders(<PaymentRow payment={payment()} currency="EUR" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('REF-1')).toBeInTheDocument();
    expect(screen.getByText('€150.00')).toBeInTheDocument();
  });

  it('shows what a bill payment settled of the bill when it settled several', () => {
    renderWithProviders(<PaymentRow payment={payment({ amount: '500.00', allocatedAmount: '120.00' })} currency="EUR" />);
    expect(screen.getByText('€120.00')).toBeInTheDocument();
    expect(screen.queryByText('€500.00')).not.toBeInTheDocument();
  });

  it('does not open anything else when the chip is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentRow payment={payment({ bankTransactionId: 'bt_7' })} currency="EUR" />);
    await user.click(screen.getByRole('link', { name: 'Bank transaction' }));
    expect(panelOpen).toHaveBeenCalledTimes(1);
  });
});
