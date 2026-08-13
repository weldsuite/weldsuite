import { describe, expect, it } from 'vitest';
import { checkoutErrorMessage } from './domain-purchase-client';

describe('checkoutErrorMessage', () => {
  const fallback = 'Checkout failed';

  it('never surfaces the missing Stripe customer / billing-setup error', () => {
    expect(
      checkoutErrorMessage(
        new Error('Workspace has no Stripe customer — complete billing setup first'),
        fallback,
      ),
    ).toBe(fallback);
  });

  it('passes through other API errors', () => {
    expect(
      checkoutErrorMessage(
        new Error('Domain example.com is not available for registration'),
        fallback,
      ),
    ).toBe('Domain example.com is not available for registration');
  });

  it('uses the fallback when the error is not an Error', () => {
    expect(checkoutErrorMessage('nope', fallback)).toBe(fallback);
  });
});
