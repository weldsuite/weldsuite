import { StorefrontError } from '@weldsuite/commerce-sdk';
import { describe, expect, it } from 'vitest';

import { readConfig } from './config';
import { describeError, discountReason, fieldErrors, GENERIC_ERROR, messageForCode } from './messages';
import { clearCartToken, getCartToken, getCheckoutState, safeStore, setCartToken, setCheckoutState, type KeyValueStore } from './storage';
import { orderPath, orderUrlTemplate, paymentReturnUrl, returnPath } from './urls';

describe('configuration', () => {
  const env = { VITE_WELDCOMMERCE_API_URL: 'https://api.example.com', VITE_WELDCOMMERCE_KEY: 'wcp_abc', VITE_SHOP_URL: 'https://shop.example.com/' };

  it('takes a publishable key and normalises the shop URL to its origin', () => {
    expect(readConfig(env)).toEqual({ config: { apiUrl: 'https://api.example.com', key: 'wcp_abc', shopUrl: 'https://shop.example.com', locale: 'en-IE' } });
  });

  it('refuses a private key, a non-key and missing settings', () => {
    expect(readConfig({ ...env, VITE_WELDCOMMERCE_KEY: 'wcs_secret' })).toEqual({ problem: 'PRIVATE_KEY' });
    expect(readConfig({ ...env, VITE_WELDCOMMERCE_KEY: 'abc' })).toEqual({ problem: 'NOT_A_KEY' });
    expect(readConfig({ ...env, VITE_SHOP_URL: 'not a url' })).toEqual({ problem: 'BAD_SHOP_URL' });
    expect(readConfig({})).toEqual({ problem: 'MISSING_API_URL' });
  });
});

describe('error mapping', () => {
  it('turns API codes into sentences, with a generic one for the rest', () => {
    expect(describeError(new StorefrontError({ status: 409, code: 'OUT_OF_STOCK', message: 'x' }))).toBe('Some items are no longer in stock. Check your cart.');
    expect(describeError(new StorefrontError({ status: 400, code: 'SOMETHING_NEW', message: 'x' }))).toBe(GENERIC_ERROR);
    expect(describeError(new Error('boom'))).toBe(GENERIC_ERROR);
    expect(messageForCode('PROVIDER_ERROR')).toBe('The payment could not be started. Try again.');
    expect(messageForCode(null)).toBe(GENERIC_ERROR);
  });

  it('explains why a discount code does not apply, and passes field errors on', () => {
    const discount = new StorefrontError({ status: 422, code: 'DISCOUNT_NOT_APPLICABLE', message: 'x', details: { reason: 'EXPIRED' } });
    expect(describeError(discount)).toBe('That discount code has expired.');
    expect(discountReason('UNKNOWN_REASON')).toBe('That discount code does not apply.');
    const validation = new StorefrontError({ status: 400, code: 'VALIDATION_ERROR', message: 'x', details: { fields: { email: 'Invalid' } } });
    expect(fieldErrors(validation)).toEqual({ email: 'Invalid' });
    expect(describeError(validation)).toBe('Check the highlighted fields.');
  });
});

function memoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value), removeItem: (key) => void values.delete(key) };
}

describe('cart token storage', () => {
  it('keeps, reads and forgets the cart token', () => {
    const store = memoryStore();
    setCartToken('wct_abcdefgh12', store);
    expect(getCartToken(store)).toBe('wct_abcdefgh12');
    clearCartToken(store);
    expect(getCartToken(store)).toBeUndefined();
  });

  it('ignores anything that is not a cart token', () => {
    const store = memoryStore();
    store.setItem('weldcommerce.cart', '<script>');
    expect(getCartToken(store)).toBeUndefined();
  });

  it('falls back to memory when storage throws', () => {
    const store = safeStore(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    setCartToken('wct_abcdefgh12', store);
    expect(getCartToken(store)).toBe('wct_abcdefgh12');
  });

  it('keeps the last checkout, and reads a damaged one as none', () => {
    const store = memoryStore();
    setCheckoutState({ orderId: 'ord_1', orderNumber: '1001', paymentMethod: 'mollie', paymentId: 'pay_1', orderToken: 'wot_1' }, store);
    expect(getCheckoutState(store)).toMatchObject({ orderId: 'ord_1', orderToken: 'wot_1' });
    store.setItem('weldcommerce.checkout', '{not json');
    expect(getCheckoutState(store)).toBeUndefined();
  });
});

describe('order and payment URLs', () => {
  it('builds the order link template with the API’s placeholders, https only', () => {
    expect(orderUrlTemplate('https://shop.example.com/')).toBe('https://shop.example.com/orders/{orderId}?token={token}');
    expect(orderUrlTemplate('http://localhost:3032')).toBeUndefined();
  });

  it('builds the payment return URL and the pages behind it', () => {
    expect(paymentReturnUrl('https://shop.example.com')).toBe('https://shop.example.com/checkout/return');
    expect(returnPath('ord 1', 'pay_1', 'PROVIDER_ERROR')).toBe('/checkout/return?order=ord+1&payment=pay_1&error=PROVIDER_ERROR');
    expect(orderPath('ord_1', 'wot/1')).toBe('/orders/ord_1?token=wot%2F1');
  });
});
