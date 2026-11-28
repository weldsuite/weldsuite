import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { EmailHistoryEntry } from '@/lib/api/domains/weldbooks-sales';
import {
  KNOWN_METHODS,
  canPayOnline,
  isPaymentProviderAccount,
  lastOnlinePayment,
  lastReversal,
  methodLabel,
  methodList,
  parseMollieReturn,
  safeAuthorizeUrl,
  withoutMollieReturn,
} from './online-payments';

const names = en.weldbooksPayments.methodNames as Record<string, string>;
const entry = (type: EmailHistoryEntry['type'], hour: number, extra: Partial<EmailHistoryEntry> = {}): EmailHistoryEntry => ({
  type,
  at: `2026-11-0${hour}T10:00:00.000Z`,
  ...extra,
});

describe('method names', () => {
  it('translates the Mollie ids and falls back to Mollie\'s own description, then the id', () => {
    expect(methodLabel('ideal', names)).toBe('iDEAL');
    expect(methodLabel('creditcard', names)).toBe('Card');
    expect(methodLabel('newmethod', names, 'New method')).toBe('New method');
    expect(methodLabel('newmethod', names)).toBe('newmethod');
  });

  it('has an English and a Dutch name for every known id', () => {
    for (const id of KNOWN_METHODS) {
      expect(en.weldbooksPayments.methodNames).toHaveProperty(id);
      expect(nl.weldbooksPayments.methodNames).toHaveProperty(id);
    }
  });

  it('lists them with "and" before the last', () => {
    expect(methodList(['ideal'], names, 'and')).toBe('iDEAL');
    expect(methodList(['ideal', 'bancontact', 'creditcard'], names, 'and')).toBe('iDEAL, Bancontact and Card');
  });
});

describe('canPayOnline', () => {
  it('needs an active connection with at least one method', () => {
    expect(canPayOnline({ status: 'active', methods: ['ideal'] })).toBe(true);
    expect(canPayOnline({ status: 'active', methods: [] })).toBe(false);
    expect(canPayOnline({ status: 'needs_reauth', methods: ['ideal'] })).toBe(false);
    expect(canPayOnline(null)).toBe(false);
  });
});

describe('the last online payment', () => {
  it('reads the last status, else the start, else nothing', () => {
    expect(lastOnlinePayment([])).toBeNull();
    expect(lastOnlinePayment([entry('sent', 1)])).toBeNull();
    expect(lastOnlinePayment([entry('payment_started', 2, { amount: '10.00' })])).toMatchObject({ status: 'started', method: null });
    expect(
      lastOnlinePayment([
        entry('payment_started', 2),
        entry('payment_status', 3, { status: 'failed', method: 'ideal' }),
        entry('payment_started', 4),
        entry('payment_status', 5, { status: 'paid', method: 'bancontact' }),
      ]),
    ).toEqual({ status: 'paid', method: 'bancontact', at: '2026-11-05T10:00:00.000Z' });
  });

  it('reads the last refund or chargeback', () => {
    expect(lastReversal([entry('payment_status', 2, { status: 'paid' })])).toBeNull();
    expect(lastReversal([entry('payment_reversed', 3, { kind: 'refund', amount: '5.00' }), entry('payment_reversed', 4, { kind: 'chargeback', amount: '20.00' })])).toEqual({
      kind: 'chargeback',
      amount: '20.00',
      at: '2026-11-04T10:00:00.000Z',
    });
  });
});

describe('the return from Mollie Connect', () => {
  it('reads connected and error with a reason, and nothing else', () => {
    expect(parseMollieReturn('?tab=weldbooks&mollie=connected')).toEqual({ result: 'connected' });
    expect(parseMollieReturn('?mollie=error&reason=access_denied')).toEqual({ result: 'error', reason: 'access_denied' });
    expect(parseMollieReturn('?mollie=error')).toEqual({ result: 'error', reason: null });
    expect(parseMollieReturn('?tab=weldbooks')).toBeNull();
    expect(parseMollieReturn('?mollie=other')).toBeNull();
  });

  it('clears the params and keeps the rest of the address', () => {
    expect(withoutMollieReturn('/w/acme/settings/entities/e1/edit', '?tab=weldbooks&mollie=error&reason=x', '#top')).toBe(
      '/w/acme/settings/entities/e1/edit?tab=weldbooks#top',
    );
    expect(withoutMollieReturn('/settings', '?mollie=connected')).toBe('/settings');
  });
});

describe('the Mollie address', () => {
  it('accepts a plain https address only', () => {
    expect(safeAuthorizeUrl('https://my.mollie.com/oauth2/authorize?client_id=1')).toBe('https://my.mollie.com/oauth2/authorize?client_id=1');
    expect(safeAuthorizeUrl('http://my.mollie.com/oauth2/authorize')).toBeNull();
    expect(safeAuthorizeUrl('javascript:alert(1)')).toBeNull();
    expect(safeAuthorizeUrl('/relative')).toBeNull();
    expect(safeAuthorizeUrl(null)).toBeNull();
  });
});

describe('the payment provider money account', () => {
  it('is told by its account type', () => {
    expect(isPaymentProviderAccount({ accountType: 'payment_provider' })).toBe(true);
    expect(isPaymentProviderAccount({ accountType: 'checking' })).toBe(false);
    expect(isPaymentProviderAccount({})).toBe(false);
    expect(isPaymentProviderAccount(undefined)).toBe(false);
  });
});
