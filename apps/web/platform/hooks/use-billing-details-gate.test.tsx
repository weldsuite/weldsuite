/**
 * Billing details before a Mollie checkout: a refused plan checkout or credit
 * top-up opens the billing details dialog and runs again once it saves.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ApiError } from '@weldsuite/api-client';

const toast = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { isBillingDetailsRequired, useBillingDetailsGate } from './use-billing-details-gate';

const detailsRequired = () =>
  new ApiError('Add your billing details', 400, {
    error: { code: 'BILLING_DETAILS_REQUIRED', message: 'Add your billing details', details: { missing: ['country'] } },
  });

describe('isBillingDetailsRequired', () => {
  it('reads the code off the API error, nothing else', () => {
    expect(isBillingDetailsRequired(detailsRequired())).toBe(true);
    expect(isBillingDetailsRequired(new ApiError('nope', 409, { error: { code: 'PARTNER_TERRITORY' } }))).toBe(false);
    expect(isBillingDetailsRequired(new Error('BILLING_DETAILS_REQUIRED'))).toBe(false);
    expect(isBillingDetailsRequired(null)).toBe(false);
  });
});

describe('useBillingDetailsGate', () => {
  beforeEach(() => toast.info.mockClear());

  it('opens the dialog on a refusal and retries once the details are saved', () => {
    const { result } = renderHook(() => useBillingDetailsGate('Add your billing details first.'));
    const retry = vi.fn();
    expect(result.current.dialogProps.open).toBe(false);

    let intercepted = false;
    act(() => {
      intercepted = result.current.intercept(detailsRequired(), retry);
    });
    expect(intercepted).toBe(true);
    expect(toast.info).toHaveBeenCalledWith('Add your billing details first.');
    expect(result.current.dialogProps.open).toBe(true);
    expect(retry).not.toHaveBeenCalled();

    // The dialog saves, then closes itself.
    act(() => {
      result.current.dialogProps.onSaved();
      result.current.dialogProps.onOpenChange(false);
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.dialogProps.open).toBe(false);

    // Nothing is left to retry.
    act(() => result.current.dialogProps.onSaved());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('drops the refused action when the dialog is closed without saving', () => {
    const { result } = renderHook(() => useBillingDetailsGate('Add your billing details first.'));
    const retry = vi.fn();
    act(() => {
      result.current.intercept(detailsRequired(), retry);
    });
    act(() => result.current.dialogProps.onOpenChange(false));
    act(() => result.current.dialogProps.onSaved());
    expect(retry).not.toHaveBeenCalled();
  });

  it('leaves any other error to the caller', () => {
    const { result } = renderHook(() => useBillingDetailsGate('Add your billing details first.'));
    const retry = vi.fn();
    let intercepted = true;
    act(() => {
      intercepted = result.current.intercept(new Error('network down'), retry);
    });
    expect(intercepted).toBe(false);
    expect(toast.info).not.toHaveBeenCalled();
    expect(result.current.dialogProps.open).toBe(false);
  });
});
