import { describe, expect, it } from 'vitest';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';
import {
  canCreatePaymentLink,
  canRefund,
  connectionStatusLabel,
  fromCents,
  httpsUrl,
  orderInvoiceError,
  outstandingAmount,
  paymentErrorMessage,
  paymentLabel,
  paymentMethodName,
  paymentTone,
  refundLabel,
  refundTone,
  refundableAmount,
  toCents,
} from './payments';

const err = (status: number, code: string, message = 'server words', details?: Record<string, unknown>) => ({
  status,
  body: { error: { code, message, details } },
});

describe('cents', () => {
  it('reads decimal strings exactly', () => {
    expect(toCents('12.5')).toBe(1250);
    expect(toCents('12.50')).toBe(1250);
    expect(toCents('0.07')).toBe(7);
    expect(toCents('19')).toBe(1900);
  });

  it('refuses what is not a plain amount', () => {
    for (const bad of ['', 'abc', '-5.00', '1,50', '1.234', null, undefined]) expect(toCents(bad)).toBeNaN();
  });

  it('writes cents back with two decimals', () => {
    expect(fromCents(1250)).toBe('12.50');
    expect(fromCents(7)).toBe('0.07');
    expect(fromCents(0)).toBe('0.00');
  });
});

describe('amounts of an order', () => {
  it('works out what can still be refunded', () => {
    expect(refundableAmount({ amountPaid: '100.00', amountRefunded: '30.50' })).toBe('69.50');
    expect(refundableAmount({ amountPaid: '100.00', amountRefunded: '100.00' })).toBe('0.00');
    expect(refundableAmount({ amountPaid: '10.00', amountRefunded: '12.00' })).toBe('0.00');
    expect(refundableAmount({} as never)).toBe('0.00');
  });

  it('works out what the customer still owes', () => {
    expect(outstandingAmount({ total: '125.00', amountPaid: '0.00' })).toBe('125.00');
    expect(outstandingAmount({ total: '125.00', amountPaid: '25.00' })).toBe('100.00');
    expect(outstandingAmount({ total: '125.00', amountPaid: '200.00' })).toBe('0.00');
  });

  it('allows a refund only while money is left', () => {
    expect(canRefund({ amountPaid: '10.00', amountRefunded: '0.00' })).toBe(true);
    expect(canRefund({ amountPaid: '10.00', amountRefunded: '10.00' })).toBe(false);
    expect(canRefund({ amountPaid: '0.00', amountRefunded: '0.00' })).toBe(false);
  });

  it('allows a payment link for an unpaid or failed order that is not cancelled', () => {
    expect(canCreatePaymentLink({ status: 'confirmed', paymentStatus: 'pending' })).toBe(true);
    expect(canCreatePaymentLink({ status: 'confirmed', paymentStatus: 'failed' })).toBe(true);
    expect(canCreatePaymentLink({ status: 'confirmed', paymentStatus: 'paid' })).toBe(false);
    expect(canCreatePaymentLink({ status: 'confirmed', paymentStatus: 'on_invoice' })).toBe(false);
    expect(canCreatePaymentLink({ status: 'cancelled', paymentStatus: 'pending' })).toBe(false);
  });
});

describe('orderInvoiceError', () => {
  it('reads metadata.invoiceError', () => {
    expect(orderInvoiceError({ metadata: { invoiceError: ' No entity ' } })).toBe('No entity');
  });

  it('is null without one, and words one that is not a string', () => {
    expect(orderInvoiceError({} as Pick<Order, 'metadata'>)).toBeNull();
    expect(orderInvoiceError({ metadata: null })).toBeNull();
    expect(orderInvoiceError({ metadata: { invoiceError: '' } })).toBeNull();
    expect(orderInvoiceError({ metadata: { invoiceError: { code: 1 } } })).toBe('The invoice failed for an unknown reason.');
  });
});

describe('httpsUrl', () => {
  it('lets https through and nothing else', () => {
    expect(httpsUrl('https://www.mollie.com/checkout/x')).toBe('https://www.mollie.com/checkout/x');
    expect(httpsUrl('http://www.mollie.com')).toBeNull();
    expect(httpsUrl('javascript:alert(1)')).toBeNull();
    expect(httpsUrl('not a url')).toBeNull();
    expect(httpsUrl(null)).toBeNull();
  });
});

describe('labels and tones', () => {
  it('words statuses and methods, and keeps an unknown one as stored', () => {
    expect(connectionStatusLabel('needs_reauth')).toBe('Reconnect needed');
    expect(paymentLabel('expired')).toBe('Expired');
    expect(refundLabel('processing')).toBe('Processing');
    expect(paymentMethodName('ideal')).toBe('iDEAL');
    expect(paymentMethodName('some_new_method')).toBe('some new method');
    expect(paymentMethodName(null)).toBeNull();
  });

  it('colours the outcome', () => {
    expect(paymentTone('paid')).toBe('success');
    expect(paymentTone('failed')).toBe('danger');
    expect(refundTone('refunded')).toBe('success');
    expect(refundTone('failed')).toBe('danger');
  });
});

describe('paymentErrorMessage', () => {
  it.each([
    ['PAYMENT_PROVIDER_NOT_CONNECTED', 'Mollie is not connected. Connect it in Settings, under Apps, WeldCommerce, Payments.'],
    ['NOTHING_TO_REFUND', 'There is nothing left to refund on this order.'],
    ['ORDER_NOT_PAYABLE', 'This order cannot be paid online: it is cancelled or on invoice.'],
    ['MOLLIE_CONNECT_NOT_CONFIGURED', 'Connecting with Mollie is not set up on this installation. Use an API key instead.'],
    ['MOLLIE_KEY_INVALID', 'Mollie did not accept this API key. Check that you copied the whole key.'],
    ['TESTMODE_FIXED', 'The test mode of an API key follows the key.'],
  ])('words %s', (code, text) => {
    expect(paymentErrorMessage(err(409, code), 'fallback')).toBe(text);
  });

  it('says what is left when a refund is too large', () => {
    const text = paymentErrorMessage(err(409, 'REFUND_TOO_LARGE', 'x', { refundable: '12.00' }), 'fallback', 'EUR');
    expect(text).toMatch(/You can refund at most .*12\.00/);
    expect(paymentErrorMessage(err(409, 'REFUND_TOO_LARGE'), 'fallback')).toBe('That is more than can still be refunded.');
  });

  it('passes on what Mollie said when it refuses', () => {
    expect(paymentErrorMessage(err(502, 'PROVIDER_ERROR', 'The payment is already refunded'), 'fallback')).toBe(
      'Mollie refused this: The payment is already refunded',
    );
  });

  it('leaves other errors to the order messages', () => {
    expect(paymentErrorMessage(err(409, 'ALREADY_PAID'), 'fallback')).toBe('This order is already paid.');
    expect(paymentErrorMessage(new Error('boom'), 'fallback')).toBe('boom');
    expect(paymentErrorMessage({}, 'fallback')).toBe('fallback');
  });
});
