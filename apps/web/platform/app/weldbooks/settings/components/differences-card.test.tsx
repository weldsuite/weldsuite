import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  canUpdate: true,
  settings: undefined as unknown,
  isLoading: false,
  isError: false,
  update: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.canUpdate }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_fees', code: '4560', name: 'Bank costs', type: 'expense', isActive: true },
        { id: 'acc_disc', code: '8100', name: 'Discounts given', type: 'revenue', isActive: true },
        { id: 'acc_round', code: '4990', name: 'Rounding differences', type: 'expense', isActive: true },
        { id: 'acc_cash', code: '1000', name: 'Cash', type: 'asset', isActive: true },
      ],
    },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-processing-queries', () => ({
  useDifferenceSettings: () => ({ data: env.settings, isLoading: env.isLoading, isError: env.isError }),
  useUpdateDifferenceSettings: () => ({ mutate: env.update, isPending: false }),
}));

import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/banking/components/test-utils';
import { DifferencesCard, normalizeCap } from './differences-card';

const defaults = {
  bankCostsAccountId: null,
  paymentDiscountAccountId: null,
  roundingAccountId: null,
  effectiveRoundingAccountId: 'acc_round',
  roundingCap: '1.00',
};

describe('normalizeCap', () => {
  it('writes an amount of zero or more as the API wants it', () => {
    expect(normalizeCap('1')).toBe('1.00');
    expect(normalizeCap('2,5')).toBe('2.50');
    expect(normalizeCap(' 0.05 ')).toBe('0.05');
    expect(normalizeCap('10.00')).toBe('10.00');
  });

  it('refuses anything else', () => {
    for (const bad of ['', 'abc', '-1', '1.234', '1,2,3']) expect(normalizeCap(bad)).toBeNull();
  });
});

describe('DifferencesCard', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.canUpdate = true;
    env.settings = defaults;
    env.isLoading = false;
    env.isError = false;
    env.update.mockReset();
    env.toast.success.mockReset();
    env.toast.error.mockReset();
  });

  it('explains the rounding limit in plain words and shows the current settings', () => {
    renderWithProviders(<DifferencesCard />);
    expect(screen.getByText('Payment differences')).toBeInTheDocument();
    expect(
      screen.getAllByText('Small differences up to this amount are booked automatically. Larger ones always ask.').length,
    ).toBeGreaterThan(0);
    expect(screen.getByLabelText('Rounding limit')).toHaveValue('1.00');
    // Rounding falls back to the chart's default account, named.
    expect(screen.getByRole('combobox', { name: 'Rounding account' })).toHaveTextContent('Default: 4990 — Rounding differences');
    expect(screen.getByRole('combobox', { name: 'Bank costs account' })).toHaveTextContent('Default account');
  });

  it('offers expense and revenue accounts only', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DifferencesCard />);
    await user.click(screen.getByRole('combobox', { name: 'Bank costs account' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['Default account', '4560 — Bank costs', '4990 — Rounding differences', '8100 — Discounts given']);
  });

  it('saves the three accounts and the limit', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DifferencesCard />);
    await user.click(screen.getByRole('combobox', { name: 'Bank costs account' }));
    await user.click(await screen.findByRole('option', { name: /Bank costs/ }));
    await user.click(screen.getByRole('combobox', { name: 'Payment discount account' }));
    await user.click(await screen.findByRole('option', { name: /Discounts given/ }));
    const cap = screen.getByLabelText('Rounding limit');
    await user.clear(cap);
    await user.type(cap, '2,5');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(env.update).toHaveBeenCalledWith(
      {
        bankCostsAccountId: 'acc_fees',
        paymentDiscountAccountId: 'acc_disc',
        roundingAccountId: null,
        roundingCap: '2.50',
      },
      expect.anything(),
    );
  });

  it('resets an account to the default by choosing "Default account"', async () => {
    const user = userEvent.setup();
    env.settings = { ...defaults, bankCostsAccountId: 'acc_fees' };
    renderWithProviders(<DifferencesCard />);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Bank costs account' })).toHaveTextContent('4560 — Bank costs'),
    );
    await user.click(screen.getByRole('combobox', { name: 'Bank costs account' }));
    await user.click(await screen.findByRole('option', { name: 'Default account' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(env.update.mock.calls[0]![0]).toMatchObject({ bankCostsAccountId: null });
  });

  it('will not save a limit that is not an amount', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DifferencesCard />);
    const cap = screen.getByLabelText('Rounding limit');
    await user.clear(cap);
    await user.type(cap, 'lots');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(env.update).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount of zero or more, such as 1.00');
    expect(cap).toHaveAttribute('aria-invalid', 'true');
  });

  it('is read-only without accounts:update', () => {
    env.canUpdate = false;
    renderWithProviders(<DifferencesCard />);
    expect(screen.getByLabelText('Rounding limit')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('says so when the settings cannot be loaded', () => {
    env.settings = undefined;
    env.isError = true;
    renderWithProviders(<DifferencesCard />);
    expect(screen.getByRole('alert')).toHaveTextContent('The payment difference settings could not be loaded.');
  });
});
