import { describe, expect, it } from 'vitest';
import {
  APPROVAL_STATUSES,
  addressLines,
  approvalReasonText,
  approvalStatusLabel,
  approvalStatusTone,
  apiErrorInfo,
  fulfillmentStatusTone,
  hasErrorCode,
  isAddressBlank,
  nextOrderStatus,
  orderErrorMessage,
  orderStatusLabel,
  orderStatusTone,
  paymentStatusLabel,
  paymentStatusTone,
  sourceLabel,
} from './orders';

describe('status helpers', () => {
  it('gives each status a tone and a label in words', () => {
    expect(orderStatusTone('cancelled')).toBe('danger');
    expect(orderStatusTone('completed')).toBe('success');
    expect(paymentStatusTone('paid')).toBe('success');
    expect(fulfillmentStatusTone('unfulfilled')).toBe('warning');
    expect(orderStatusLabel('processing')).toBe('Processing');
    expect(paymentStatusLabel('pending')).toBe('Unpaid');
  });

  it('shows a status or source this version does not know as stored', () => {
    expect(paymentStatusLabel('chargeback' as never)).toBe('chargeback');
    expect(sourceLabel('woocommerce')).toBe('WooCommerce');
    expect(sourceLabel('my_channel')).toBe('my channel');
  });

  it('steps forward through the statuses and stops at the end', () => {
    expect(nextOrderStatus('pending')).toBe('confirmed');
    expect(nextOrderStatus('confirmed')).toBe('processing');
    expect(nextOrderStatus('processing')).toBe('completed');
    expect(nextOrderStatus('completed')).toBeNull();
    expect(nextOrderStatus('cancelled')).toBeNull();
  });
});

describe('addresses', () => {
  it('reads blank and missing addresses as blank', () => {
    expect(isAddressBlank(null)).toBe(true);
    expect(isAddressBlank({ name: '  ', city: '' })).toBe(true);
    expect(isAddressBlank({ city: 'Utrecht' })).toBe(false);
  });

  it('lays an address out as the lines of a postal label', () => {
    expect(
      addressLines({ name: 'Grace Hopper', company: 'Acme', line1: 'Dam 1', line2: '', postalCode: '1012 JS', city: 'Amsterdam', country: 'NL' }),
    ).toEqual(['Grace Hopper', 'Acme', 'Dam 1', '1012 JS Amsterdam', 'NL']);
    expect(addressLines(null)).toEqual([]);
  });
});

describe('API errors', () => {
  const conflict = { status: 409, body: { error: { code: 'CODE_TAKEN', message: 'taken', details: { field: 'code' } } } };

  it('reads the status, code, message and details from the error body', () => {
    expect(apiErrorInfo(conflict)).toEqual({ status: 409, code: 'CODE_TAKEN', message: 'taken', details: { field: 'code' } });
    expect(hasErrorCode(conflict, 'CODE_TAKEN')).toBe(true);
    expect(hasErrorCode(conflict, 'OTHER')).toBe(false);
  });

  it('copes with errors that carry no body', () => {
    expect(apiErrorInfo(new Error('boom'))).toEqual({ status: undefined });
    expect(apiErrorInfo('nope')).toEqual({});
    expect(apiErrorInfo(null)).toEqual({});
  });

  it('words the order 409s, and falls back to the server message, the error and then the fallback', () => {
    const code = (value: string) => ({ status: 409, body: { error: { code: value, message: 'raw' } } });
    expect(orderErrorMessage(code('ORDER_NOT_EDITABLE'), 'x')).toBe('This order can no longer be changed.');
    expect(orderErrorMessage(code('ORDER_NOT_CANCELLABLE'), 'x')).toContain('can no longer be cancelled');
    expect(orderErrorMessage(code('ALREADY_PAID'), 'x')).toBe('This order is already paid.');
    expect(orderErrorMessage(code('DISCOUNT_NOT_APPLICABLE'), 'x')).toContain('discount code');
    expect(orderErrorMessage(code('SOMETHING_ELSE'), 'x')).toBe('raw');
    expect(orderErrorMessage(new Error('network down'), 'x')).toBe('network down');
    expect(orderErrorMessage({}, 'fallback')).toBe('fallback');
  });
});

describe('approval helpers', () => {
  it('offers every approval state to filter on, in the order of urgency', () => {
    expect(APPROVAL_STATUSES).toEqual(['pending', 'approved', 'rejected', 'not_required']);
  });

  it('gives each approval state a tone and a label in words', () => {
    expect(approvalStatusTone('pending')).toBe('warning');
    expect(approvalStatusTone('approved')).toBe('success');
    expect(approvalStatusTone('rejected')).toBe('danger');
    expect(approvalStatusTone('not_required')).toBe('neutral');
    expect(approvalStatusLabel('pending')).toBe('Awaiting approval');
  });

  it('says why an order waits, in words, and falls back for a reason it does not know', () => {
    expect(approvalReasonText('buyer_limit')).toContain('spend limit');
    expect(approvalReasonText('company_threshold')).toContain('approval threshold');
    expect(approvalReasonText('something_new')).toBe('This order needs approval.');
    expect(approvalReasonText(null)).toBe('This order needs approval.');
  });

  it('says NOT_PENDING in words', () => {
    const err = { status: 409, body: { error: { code: 'NOT_PENDING', message: 'raw' } } };
    expect(orderErrorMessage(err, 'x')).toContain('no longer waiting for approval');
  });
});
