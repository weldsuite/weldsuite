import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
// One stable object: the real hook returns memoized functions, and the dialog resets its form when they change.
const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
  formatDate: (value: string) => value,
  today: () => '2026-10-08',
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { PaymentDialog, createPaymentSchema } from './payment-dialog';
import { installPointerPolyfills, makeReturn, renderWithProviders } from '../../shared/test-support';

const bank = {
  id: 'ba_1',
  name: 'Operating',
  iban: null,
  bankName: 'First Platypus Bank',
  currentBalance: '5000',
  currency: 'USD',
  ledgerAccountId: 'acc_bank',
  isDefault: true,
  isActive: true,
  accountNumberLast4: '4321',
};

const filedReturn = makeReturn({ status: 'filed', confirmationNumber: 'CONF-77', totalDue: 824.38 });

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  api.get.mockImplementation(async (path: string) => (path.startsWith('/bank-accounts') ? { data: [bank] } : { data: [] }));
  api.post.mockResolvedValue({ data: { ...filedReturn, status: 'paid', payment: { journalEntryId: 'je_1', totalDue: 824.38, difference: 0, lines: [] } } });
});

async function renderDialog(ret = filedReturn, onOpenChange = vi.fn(), onPaid = vi.fn()) {
  renderWithProviders(<PaymentDialog ret={ret} open onOpenChange={onOpenChange} onPaid={onPaid} />);
  // The default bank account is chosen once the list has loaded.
  await waitFor(() => expect(screen.getByTestId('payment-bank')).toHaveTextContent('Operating'));
  return { onOpenChange, onPaid };
}

describe('PaymentDialog', () => {
  it('starts from the total due, today and the confirmation number', async () => {
    await renderDialog();

    expect(screen.getByLabelText('Amount paid')).toHaveValue('824.38');
    expect(screen.getByLabelText('Payment date')).toHaveValue('2026-10-08');
    expect(screen.getByLabelText('Reference')).toHaveValue('CONF-77');
    expect(screen.getByText('Total due: $824.38')).toBeInTheDocument();
    expect(screen.queryByTestId('difference-section')).not.toBeInTheDocument();
  });

  it('posts the payment without a reason when the amount equals the total due', async () => {
    const { onOpenChange, onPaid } = await renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Record payment' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/tax-returns/txr_1/payment', {
      bankAccountId: 'ba_1',
      amount: 824.38,
      date: '2026-10-08',
      reference: 'CONF-77',
    });
    await waitFor(() => expect(onPaid).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith('Payment recorded');
  });

  it('requires a reason when the amount differs from the total due', async () => {
    await renderDialog();
    const user = userEvent.setup();

    const amount = screen.getByLabelText('Amount paid');
    await user.clear(amount);
    await user.type(amount, '800');

    // The reason field appears with the difference the payment books to rounding.
    expect(screen.getByTestId('difference-section')).toBeInTheDocument();
    expect(screen.getByText(/differs from the total due by \$24\.38/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(await screen.findByText('Explain the difference between the amount paid and the total due')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Reason for the difference'), 'Portal rounded the amount down');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/tax-returns/txr_1/payment', {
      bankAccountId: 'ba_1',
      amount: 800,
      date: '2026-10-08',
      reference: 'CONF-77',
      differenceReason: 'Portal rounded the amount down',
    });
  });

  it('does not accept a reason made of spaces', async () => {
    await renderDialog();
    const user = userEvent.setup();

    const amount = screen.getByLabelText('Amount paid');
    await user.clear(amount);
    await user.type(amount, '700');
    await user.type(screen.getByLabelText('Reason for the difference'), '   ');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));

    expect(await screen.findByText('Explain the difference between the amount paid and the total due')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('asks for the reason when the server says the amounts differ', async () => {
    api.post.mockRejectedValue(
      Object.assign(new Error('The amount paid (824.00) differs from the total due (824.38). Give a reason for the difference.'), {
        status: 400,
        code: 'BAD_REQUEST',
        body: { error: { code: 'BAD_REQUEST', message: 'differs', details: { totalDue: 824.38, amount: 824, difference: -0.38 } } },
      }),
    );
    await renderDialog();
    const user = userEvent.setup();

    // 824.381 rounds to the total due in cents, so the form lets it through; the server disagrees.
    await user.click(screen.getByRole('button', { name: 'Record payment' }));

    expect(await screen.findByText('Explain the difference between the amount paid and the total due')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('does not accept a negative payment for a return with tax due', async () => {
    await renderDialog();
    const user = userEvent.setup();

    const amount = screen.getByLabelText('Amount paid');
    await user.clear(amount);
    await user.type(amount, '-5');
    await user.type(screen.getByLabelText('Reason for the difference'), 'Refund');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));

    expect(await screen.findByText('The amount paid cannot be negative for a return with tax due')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('refunds a return with a credit as a negative amount', async () => {
    await renderDialog(makeReturn({ status: 'filed', totalDue: -50 }));
    const user = userEvent.setup();

    expect(screen.getByText(/shows a credit/)).toBeInTheDocument();
    const amount = screen.getByLabelText('Amount paid');
    await user.clear(amount);
    await user.type(amount, '50');
    await user.type(screen.getByLabelText('Reason for the difference'), 'x');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(await screen.findByText(/is refunded, not paid/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('createPaymentSchema', () => {
  const messages = {
    bankRequired: 'bank',
    amountRequired: 'amount',
    dateRequired: 'date',
    reasonRequired: 'reason',
    negativeNotAllowed: 'negative',
    positiveNotAllowed: 'positive',
  };
  const valid = { bankAccountId: 'ba_1', amount: '100.00', date: '2026-10-08' };

  it('passes an amount equal to the total due without a reason', () => {
    expect(createPaymentSchema(messages, 100).safeParse(valid).success).toBe(true);
  });

  it('fails a different amount without a reason, on the reason field', () => {
    const result = createPaymentSchema(messages, 100).safeParse({ ...valid, amount: '90' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]).toMatchObject({ path: ['differenceReason'], message: 'reason' });
  });

  it('passes a different amount with a reason', () => {
    expect(createPaymentSchema(messages, 100).safeParse({ ...valid, amount: '90', differenceReason: 'Early' }).success).toBe(true);
  });

  it('compares in cents', () => {
    expect(createPaymentSchema(messages, 0.3).safeParse({ ...valid, amount: String(0.1 + 0.2) }).success).toBe(true);
  });

  it('needs a bank account, an amount that is a number and a date', () => {
    const result = createPaymentSchema(messages, 100).safeParse({ bankAccountId: '', amount: 'abc', date: '' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.message).sort()).toEqual(['amount', 'bank', 'date']);
  });
});
