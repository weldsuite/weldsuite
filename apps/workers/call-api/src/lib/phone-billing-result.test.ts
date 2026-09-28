import { describe, expect, it } from 'vitest';
import {
  billingErrorMessage,
  readJsonObject,
  shouldStartPhoneCheckout,
} from './phone-billing-result';

describe('shouldStartPhoneCheckout', () => {
  it('starts checkout when billing asks for it', () => {
    expect(shouldStartPhoneCheckout({ requiresCheckout: true })).toBe(true);
  });

  it('does not checkout after a confirmed card-on-file charge', () => {
    expect(shouldStartPhoneCheckout({ success: true, subscriptionId: 'sub_1' })).toBe(false);
  });

  it('falls back to checkout when add-number returns an error object', () => {
    expect(shouldStartPhoneCheckout({ error: 'Missing stripePriceId' })).toBe(true);
    expect(shouldStartPhoneCheckout({ error: 'Internal Server Error' })).toBe(true);
  });
});

describe('billingErrorMessage', () => {
  it('prefers a string error from billing-worker', () => {
    expect(billingErrorMessage({ error: 'No organization selected' }, 'fallback')).toBe(
      'No organization selected',
    );
  });

  it('reads nested error.message', () => {
    expect(billingErrorMessage({ error: { message: 'card declined' } }, 'fallback')).toBe(
      'card declined',
    );
  });
});

describe('readJsonObject', () => {
  it('parses a JSON object', async () => {
    expect(await readJsonObject(new Response('{"success":true}'))).toEqual({ success: true });
  });

  it('does not throw on empty or non-JSON bodies', async () => {
    expect(await readJsonObject(new Response(''))).toEqual({});
    expect(await readJsonObject(new Response('<html>nope</html>'))).toEqual({
      error: '<html>nope</html>',
    });
  });
});
