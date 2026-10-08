import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', async () => {
  const { testFormat } = await import('../test-utils');
  return { useWeldbooksFormat: () => testFormat };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { VoidCheckDialog, buildVoidInput, type VoidableCheck } from './void-check-dialog';
import { installPointerPolyfills, renderWithProviders } from '../test-utils';

const check: VoidableCheck = { paymentId: 'pay_1001', checkNumber: '001001', payeeName: 'Acme Supplies', amount: '350.50' };

const voided = {
  voided: { paymentId: 'pay_1001', checkNumber: '001001', amount: '350.50', partyId: 'par_acme', runId: 'prn_1' },
  replacement: null,
  run: null,
};

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  api.post.mockResolvedValue({ data: voided });
});

function renderDialog(onOpenChange = vi.fn(), onVoided = vi.fn()) {
  renderWithProviders(<VoidCheckDialog check={check} onOpenChange={onOpenChange} onVoided={onVoided} />);
  return { onOpenChange, onVoided };
}

describe('buildVoidInput', () => {
  it('trims the reason and only sends a date with a reissue', () => {
    expect(buildVoidInput({ reason: '  Lost in the mail ', reissue: false, date: '2026-10-08' })).toEqual({
      reason: 'Lost in the mail',
      reissue: false,
    });
    expect(buildVoidInput({ reason: 'Misprint', reissue: true, date: '2026-10-09' })).toEqual({
      reason: 'Misprint',
      reissue: true,
      date: '2026-10-09',
    });
  });
});

describe('VoidCheckDialog', () => {
  it('names the check and what voiding does', async () => {
    renderDialog();
    expect(await screen.findByText('Void check 001001')).toBeInTheDocument();
    expect(screen.getByText('Check to Acme Supplies for $350.50.')).toBeInTheDocument();
    expect(screen.getByText(/ledger entry is reversed/)).toBeInTheDocument();
  });

  it('says the backup withholding is reversed with a check that carried some', async () => {
    renderWithProviders(<VoidCheckDialog check={{ ...check, amount: '2280.00', backupWithholdingAmount: '720.00' }} onOpenChange={vi.fn()} />);
    expect(await screen.findByText('Check to Acme Supplies for $2280.00.')).toBeInTheDocument();
    expect(screen.getByText(/backup withholding of \$720\.00 on this payment is reversed with it/)).toBeInTheDocument();
  });

  it('needs a reason and sends nothing without one', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole('button', { name: 'Void check' }));

    expect(await screen.findByText('Say why, in a few words. It is kept with the record.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Reason'), 'ab');
    await user.click(screen.getByRole('button', { name: 'Void check' }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('voids with the trimmed reason and no replacement', async () => {
    const user = userEvent.setup();
    const { onOpenChange, onVoided } = renderDialog();
    await user.type(await screen.findByLabelText('Reason'), '  Lost in the mail  ');
    await user.click(screen.getByRole('button', { name: 'Void check' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-runs/checks/pay_1001/void', { reason: 'Lost in the mail', reissue: false }));
    await waitFor(() => expect(onVoided).toHaveBeenCalledWith(voided));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith('Check voided.');
  });

  it('reissues under the next number on the date given', async () => {
    api.post.mockResolvedValue({
      data: { ...voided, replacement: { paymentId: 'pay_1002', checkNumber: '001002', amount: '350.50', checkStatus: 'to_print' } },
    });
    const user = userEvent.setup();
    renderDialog();
    await user.type(await screen.findByLabelText('Reason'), 'Misprinted');
    await user.click(screen.getByRole('checkbox', { name: 'Reissue a replacement check' }));

    const date = screen.getByLabelText('Date of the replacement check');
    expect(date).toHaveValue('2026-10-08');
    await user.clear(date);
    await user.type(date, '2026-10-12');
    await user.click(screen.getByRole('button', { name: 'Void and reissue' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/payment-runs/checks/pay_1001/void', {
        reason: 'Misprinted',
        reissue: true,
        date: '2026-10-12',
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Check voided. The replacement is check 001002.'));
  });

  it('asks for a real date when reissuing', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(await screen.findByLabelText('Reason'), 'Misprinted');
    await user.click(screen.getByRole('checkbox', { name: 'Reissue a replacement check' }));
    await user.clear(screen.getByLabelText('Date of the replacement check'));
    await user.click(screen.getByRole('button', { name: 'Void and reissue' }));

    expect(await screen.findByText('Enter a valid date.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('stays open and says what went wrong when the server refuses', async () => {
    const error = Object.assign(new Error('This check has cleared the bank: it can\'t be voided.'), {
      status: 409,
      code: 'CHECK_CLEARED',
      body: { error: { code: 'CHECK_CLEARED' } },
    });
    api.post.mockRejectedValue(error);
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.type(await screen.findByLabelText('Reason'), 'Cleared by mistake');
    await user.click(screen.getByRole('button', { name: 'Void check' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not void the check.', {
        description: "This check has cleared the bank: it can't be voided.",
      }),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
