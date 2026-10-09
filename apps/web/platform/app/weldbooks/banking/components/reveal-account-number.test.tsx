import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const permissions = new Set(['tax_ids:reveal']);
const revealApi = vi.fn();

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('@/lib/api/domains/weldbooks-banking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/domains/weldbooks-banking')>()),
  bankingApi: { revealAccountNumber: (...args: unknown[]) => revealApi(...args) },
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: {} }));

import { REVEAL_SECONDS, RevealAccountNumber } from './reveal-account-number';
import { renderWithProviders } from './test-utils';

describe('RevealAccountNumber', () => {
  beforeEach(() => {
    revealApi.mockReset();
    revealApi.mockResolvedValue({ data: { accountNumber: '001234567890', routingNumber: '021000021', accountNumberLast4: '7890' } });
    permissions.clear();
    permissions.add('tax_ids:reveal');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows only the last four digits until asked', () => {
    renderWithProviders(<RevealAccountNumber bankAccountId="ba_1" last4="7890" />);
    expect(screen.getByTestId('account-number-value')).toHaveTextContent('•••• 7890');
    expect(revealApi).not.toHaveBeenCalled();
  });

  it('reveals the number on click and hides it again on demand', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RevealAccountNumber bankAccountId="ba_1" last4="7890" />);

    await user.click(screen.getByRole('button', { name: /Reveal/ }));
    await waitFor(() => expect(screen.getByTestId('account-number-value')).toHaveTextContent('001234567890'));
    expect(revealApi).toHaveBeenCalledWith('ba_1', undefined);
    expect(screen.getByText(`Hides in ${REVEAL_SECONDS}s`)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Hide/ }));
    expect(screen.getByTestId('account-number-value')).toHaveTextContent('•••• 7890');
    expect(screen.queryByText('001234567890')).not.toBeInTheDocument();
  });

  it('hides the number by itself after 30 seconds', async () => {
    renderWithProviders(<RevealAccountNumber bankAccountId="ba_1" last4="7890" />);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await act(async () => {
      screen.getByRole('button', { name: /Reveal/ }).click();
    });
    await waitFor(() => expect(screen.getByTestId('account-number-value')).toHaveTextContent('001234567890'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync((REVEAL_SECONDS - 1) * 1000);
    });
    expect(screen.getByTestId('account-number-value')).toHaveTextContent('001234567890');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByTestId('account-number-value')).toHaveTextContent('•••• 7890');
  });

  it('offers no reveal without the tax_ids:reveal permission', () => {
    permissions.clear();
    renderWithProviders(<RevealAccountNumber bankAccountId="ba_1" last4="7890" />);
    expect(screen.queryByRole('button', { name: /Reveal/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('account-number-value')).toHaveTextContent('•••• 7890');
  });

  it('reports a failed reveal and keeps the number hidden', async () => {
    revealApi.mockRejectedValue(new Error('Forbidden'));
    const user = userEvent.setup();
    renderWithProviders(<RevealAccountNumber bankAccountId="ba_1" last4="7890" />);

    await user.click(screen.getByRole('button', { name: /Reveal/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden');
    expect(screen.getByTestId('account-number-value')).toHaveTextContent('•••• 7890');
  });
});
