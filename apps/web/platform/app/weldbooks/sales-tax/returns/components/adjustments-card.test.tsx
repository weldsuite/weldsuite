import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
  formatDate: (value: string) => `on ${value}`,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { AdjustmentsCard } from './adjustments-card';
import { installPointerPolyfills, makeReturn, renderWithProviders } from '../../shared/test-support';

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.patch.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  api.get.mockResolvedValue({ data: [] });
  api.patch.mockResolvedValue({ data: makeReturn() });
});

const user = () => userEvent.setup();

describe('AdjustmentsCard payload', () => {
  it('saves a new adjustment with its signed amount and note', async () => {
    renderWithProviders(<AdjustmentsCard ret={makeReturn()} canEdit />);
    const u = user();

    expect(screen.getByTestId('total-due')).toHaveTextContent('$824.38');
    expect(screen.queryByRole('button', { name: 'Save adjustments' })).not.toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Add adjustment' }));
    const row = screen.getByTestId('adjustment-row');
    await u.type(within(row).getByLabelText('Amount'), '25.5');
    await u.type(within(row).getByLabelText('Note'), 'Late filing penalty');

    // The total follows the row being edited.
    expect(screen.getByTestId('total-due')).toHaveTextContent('$849.88');

    await u.click(screen.getByRole('button', { name: 'Save adjustments' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith('/tax-returns/txr_1', {
      adjustments: [{ type: 'penalty', amount: 25.5, note: 'Late filing penalty' }],
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Adjustments saved'));
  });

  it('does not save a row without an amount', async () => {
    renderWithProviders(<AdjustmentsCard ret={makeReturn()} canEdit />);
    const u = user();

    await u.click(screen.getByRole('button', { name: 'Add adjustment' }));
    await u.type(within(screen.getByTestId('adjustment-row')).getByLabelText('Note'), 'Interest');
    await u.click(screen.getByRole('button', { name: 'Save adjustments' }));

    expect(await screen.findByText('Enter an amount')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('shows the proposed vendor discount as a proposal and keeps the auto flag until the user edits it', async () => {
    const ret = makeReturn({
      adjustments: [{ type: 'vendor_discount', amount: -8.04, note: 'Proposed vendor discount', auto: true }],
      totalDue: 816.34,
    });
    renderWithProviders(<AdjustmentsCard ret={ret} canEdit />);
    const u = user();

    const row = screen.getByTestId('adjustment-row');
    expect(within(row).getByText('Proposed')).toBeInTheDocument();
    expect(within(row).getByText(/only holds when the return is filed and paid by on 2026-10-25/)).toBeInTheDocument();
    expect(screen.getByTestId('total-due')).toHaveTextContent('$816.34');
    // Nothing to save while the proposal is untouched.
    expect(screen.queryByRole('button', { name: 'Save adjustments' })).not.toBeInTheDocument();

    const amount = within(row).getByLabelText('Amount');
    await u.clear(amount);
    await u.type(amount, '-5');
    expect(within(row).queryByText('Proposed')).not.toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Save adjustments' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    // An edited proposal is the user's own: no auto flag, so a recalculation leaves it alone.
    expect(api.patch).toHaveBeenCalledWith('/tax-returns/txr_1', {
      adjustments: [{ type: 'vendor_discount', amount: -5, note: 'Proposed vendor discount' }],
    });
  });

  it('removes an adjustment', async () => {
    const ret = makeReturn({ adjustments: [{ type: 'penalty', amount: 10 }], totalDue: 834.38 });
    renderWithProviders(<AdjustmentsCard ret={ret} canEdit />);
    const u = user();

    await u.click(screen.getByRole('button', { name: 'Remove adjustment' }));
    expect(screen.getByTestId('total-due')).toHaveTextContent('$824.38');
    await u.click(screen.getByRole('button', { name: 'Save adjustments' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/tax-returns/txr_1', { adjustments: [] }));
  });

  it('warns about an amount with the unusual sign without blocking it', async () => {
    renderWithProviders(<AdjustmentsCard ret={makeReturn()} canEdit />);
    const u = user();

    await u.click(screen.getByRole('button', { name: 'Add adjustment' }));
    await u.type(within(screen.getByTestId('adjustment-row')).getByLabelText('Amount'), '-10');
    expect(screen.getByText('Usually a positive amount')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save adjustments' })).toBeEnabled();
  });
});

describe('AdjustmentsCard when it cannot be edited', () => {
  it('lists the stored adjustments and locks them once the return is filed', () => {
    const ret = makeReturn({
      status: 'filed',
      adjustments: [
        { type: 'vendor_discount', amount: -8.04 },
        { type: 'penalty', amount: 12, note: 'Late' },
      ],
      totalDue: 828.34,
    });
    renderWithProviders(<AdjustmentsCard ret={ret} canEdit={false} />);

    expect(screen.queryByRole('button', { name: 'Add adjustment' })).not.toBeInTheDocument();
    expect(screen.getByText('Vendor discount')).toBeInTheDocument();
    expect(screen.getByText('Penalty')).toBeInTheDocument();
    expect(screen.getByText(/locked once a return is filed/)).toBeInTheDocument();
    expect(screen.getByTestId('total-due')).toHaveTextContent('$828.34');
  });

  it('tells a credit is refunded as a negative payment', () => {
    const summary = { ...makeReturn().summary!, salesTaxPayable: -50, useTaxPayable: 0 };
    renderWithProviders(<AdjustmentsCard ret={makeReturn({ summary, totalDue: -50 })} canEdit={false} />);
    expect(screen.getByText(/shows a credit/)).toBeInTheDocument();
  });
});
