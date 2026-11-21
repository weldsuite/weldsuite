/**
 * Coming back to the billing page from Mollie: a plan-billing checkout
 * (`bpy_…`) is looked up and toasted by what it paid for, and a pay link's
 * `?pay=done|expired` is said and stripped. The billing queries refresh.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const toast = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
const get = vi.hoisted(() => vi.fn());
const invalidateQueries = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ get }) }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

import { useCreditCheckoutReturn, type BillingCheckoutReturnStrings } from './credit-checkout-return';

const credits = {
  purchaseSuccess: 'Credits added',
  purchaseCancelled: 'Purchase cancelled',
  purchasePending: 'Payment processing',
  purchaseNotCompleted: 'Payment not completed',
};

const billing: BillingCheckoutReturnStrings = {
  planPaid: 'Plan paid',
  changePaid: 'Change paid',
  mandatePaid: 'Payment method saved',
  payLinkPaid: 'Open charge paid',
  pending: 'Payment processing',
  cancelled: 'Checkout cancelled',
  notCompleted: 'Payment not completed',
  payLinkDone: 'Nothing left to pay',
  payLinkExpired: 'That payment link expired',
};

function returnTo(search: string) {
  window.history.replaceState({}, '', `/settings/billing${search}`);
}

describe('useCreditCheckoutReturn on the billing page (Mollie)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    returnTo('');
  });

  it.each([
    ['change', 'Change paid'],
    ['mandate', 'Payment method saved'],
    ['pay_link', 'Open charge paid'],
    ['checkout', 'Plan paid'],
    [null, 'Plan paid'],
  ])('says what a paid %s checkout bought, and refreshes billing', async (purpose, message) => {
    get.mockResolvedValue({ data: { id: 'bpy_1', status: 'paid', purpose } });
    returnTo('?tab=overview&checkout=bpy_1');
    renderHook(() => useCreditCheckoutReturn(credits, billing));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(message));
    expect(get).toHaveBeenCalledWith('/billing/checkout/bpy_1');
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['billing'] });
    // The checkout parameter is gone, the rest stays.
    expect(window.location.search).toBe('?tab=overview');
  });

  it.each([
    ['canceled', 'info', 'Checkout cancelled'],
    ['failed', 'error', 'Payment not completed'],
    ['expired', 'error', 'Payment not completed'],
    ['open', 'info', 'Payment processing'],
  ] as const)('a %s checkout gets its message', async (status, level, message) => {
    get.mockResolvedValue({ data: { id: 'bpy_1', status, purpose: 'checkout' } });
    returnTo('?checkout=bpy_1');
    renderHook(() => useCreditCheckoutReturn(credits, billing));
    await waitFor(() => expect(toast[level]).toHaveBeenCalledWith(message));
  });

  it('says the payment is being processed when the lookup fails', async () => {
    get.mockRejectedValue(new Error('offline'));
    returnTo('?checkout=bpy_1');
    renderHook(() => useCreditCheckoutReturn(credits, billing));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Payment processing'));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['billing'] });
  });

  it('leaves a bpy_ checkout alone without the billing strings (the credits page)', async () => {
    get.mockResolvedValue({ data: { id: 'bpy_1', status: 'paid' } });
    returnTo('?checkout=bpy_1');
    renderHook(() => useCreditCheckoutReturn(credits));
    // Looked up as a credit checkout instead.
    await waitFor(() => expect(get).toHaveBeenCalledWith('/credits/checkout/bpy_1'));
  });

  it('says where a pay link sent the browser back, strips it and refreshes', () => {
    returnTo('?tab=overview&pay=done');
    renderHook(() => useCreditCheckoutReturn(credits, billing));
    expect(toast.info).toHaveBeenCalledWith('Nothing left to pay');
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['billing'] });
    expect(window.location.search).toBe('?tab=overview');
    expect(get).not.toHaveBeenCalled();
  });

  it('says an expired pay link expired, and stays quiet without a message', () => {
    returnTo('?pay=expired');
    const { unmount } = renderHook(() => useCreditCheckoutReturn(credits, billing));
    expect(toast.info).toHaveBeenCalledWith('That payment link expired');
    expect(window.location.search).toBe('');
    unmount();

    vi.clearAllMocks();
    returnTo('?pay=expired');
    renderHook(() => useCreditCheckoutReturn(credits, { ...billing, payLinkExpired: undefined }));
    expect(toast.info).not.toHaveBeenCalled();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['billing'] });
  });

  it('ignores a page that was not returned to', () => {
    returnTo('?tab=invoices');
    renderHook(() => useCreditCheckoutReturn(credits, billing));
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?tab=invoices');
  });
});
