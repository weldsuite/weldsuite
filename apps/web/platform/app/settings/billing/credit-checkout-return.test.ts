import { describe, expect, it } from 'vitest';
import { checkoutToast, readCheckoutReturn, withoutCheckoutParams } from './credit-checkout-return';

describe('credit checkout return', () => {
  it("reads Stripe's success and cancel returns", () => {
    expect(readCheckoutReturn('?credits=success')).toEqual({ outcome: 'success', checkoutId: null });
    expect(readCheckoutReturn('?credits=cancelled')).toEqual({ outcome: 'cancelled', checkoutId: null });
    expect(readCheckoutReturn('')).toBeNull();
    expect(readCheckoutReturn('?tab=invoices')).toBeNull();
  });

  it("reads Mollie's return with the checkout to look up", () => {
    expect(readCheckoutReturn('?credits=success&checkout=ctp_abc')).toEqual({
      outcome: 'success',
      checkoutId: 'ctp_abc',
    });
    expect(readCheckoutReturn('?checkout=ctp_abc')).toEqual({ outcome: null, checkoutId: 'ctp_abc' });
  });

  it('strips only the checkout parameters', () => {
    expect(withoutCheckoutParams('?credits=success&checkout=ctp_abc')).toBe('');
    expect(withoutCheckoutParams('?tab=usage&credits=success&checkout=ctp_abc')).toBe('?tab=usage');
  });

  it("says what the checkout's state means for the balance", () => {
    expect(checkoutToast('paid')).toBe('success');
    expect(checkoutToast('canceled')).toBe('cancelled');
    expect(checkoutToast('expired')).toBe('failed');
    expect(checkoutToast('failed')).toBe('failed');
    // A Mollie success return is no proof of payment: open or unknown waits.
    expect(checkoutToast('pending')).toBe('pending');
    expect(checkoutToast('unknown')).toBe('pending');
    expect(checkoutToast(null)).toBe('pending');
  });
});
